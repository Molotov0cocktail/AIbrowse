[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Drawing

function Need([bool]$Value, [string]$Message) {
    if (-not $Value) { throw $Message }
}

function Reject([string]$Name, [scriptblock]$Action) {
    try { & $Action } catch { return }
    throw "反例未拒绝：$Name"
}

function Save-FixturePng([string]$Path, [int]$Width, [int]$Height, [bool]$Transparent, [Drawing.Color]$Color, [single]$Dpi = 96) {
    $bitmap = [Drawing.Bitmap]::new($Width, $Height, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bitmap.SetResolution($Dpi, $Dpi)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $brush = [Drawing.SolidBrush]::new($Color)
    try {
        $graphics.PageUnit = [Drawing.GraphicsUnit]::Pixel
        $graphics.Clear($(if ($Transparent) { [Drawing.Color]::Transparent } else { [Drawing.Color]::White }))
        $graphics.FillRectangle($brush, [Math]::Floor($Width / 4), [Math]::Floor($Height / 4), [Math]::Floor($Width / 2), [Math]::Floor($Height / 2))
        $bitmap.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $brush.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
    }
}

function Read-PngResolution([byte[]]$Bytes) {
    $offset = 8
    while ($offset + 12 -le $Bytes.Length) {
        $length = [Net.IPAddress]::NetworkToHostOrder([BitConverter]::ToInt32($Bytes, $offset))
        if ($length -lt 0 -or $offset + 12 + $length -gt $Bytes.Length) { throw 'PNG chunk边界无效' }
        $type = [Text.Encoding]::ASCII.GetString($Bytes, $offset + 4, 4)
        if ($type -ceq 'pHYs') {
            if ($length -ne 9) { throw 'PNG pHYs长度无效' }
            $x = [Net.IPAddress]::NetworkToHostOrder([BitConverter]::ToInt32($Bytes, $offset + 8))
            $y = [Net.IPAddress]::NetworkToHostOrder([BitConverter]::ToInt32($Bytes, $offset + 12))
            return [pscustomobject]@{ X = $x; Y = $y; Unit = $Bytes[$offset + 16] }
        }
        $offset += 12 + $length
    }
    throw 'PNG缺少pHYs'
}

$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$local = Join-Path $repository '.local-dev'
if (-not (Test-Path -LiteralPath $local -PathType Container)) { [void][IO.Directory]::CreateDirectory($local) }
$root = Join-Path $local ('application-icon-test-' + [Guid]::NewGuid().ToString('N'))
$build = Join-Path $root 'tools/build'
$resources = Join-Path $root 'resources'
[void][IO.Directory]::CreateDirectory($build)
[void][IO.Directory]::CreateDirectory($resources)
$tool = Join-Path $build 'application-icon.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'application-icon.ps1') -Destination $tool
$source = Join-Path $resources 'aibrowse-icon.png'
$output = Join-Path $resources 'aibrowse.ico'

try {
    Reject '缺少 PNG 母版' { & $tool }
    [IO.File]::WriteAllText($source, 'not a png')
    Reject '失效 PNG 母版' { & $tool }

    Save-FixturePng $source 256 128 $true ([Drawing.Color]::FromArgb(255, 20, 80, 160))
    Reject '非正方形 PNG 母版' { & $tool }
    Save-FixturePng $source 256 256 $false ([Drawing.Color]::FromArgb(255, 20, 80, 160))
    Reject '没有透明像素的 PNG 母版' { & $tool }

    Save-FixturePng $source 256 256 $true ([Drawing.Color]::FromArgb(255, 20, 80, 160))
    Reject '无旧 ICO 时误用替换模式' { & $tool -Replace }
    & $tool | Out-Null
    Need (Test-Path -LiteralPath $output -PathType Leaf) '首次生成未创建 ICO'
    $firstHash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash
    & $tool -Check | Out-Null
    Need ((Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash -ceq $firstHash) '-Check 修改了 ICO'
    Reject '默认意外覆盖' { & $tool }
    Reject '冲突模式' { & $tool -Check -Replace }

    [IO.File]::AppendAllText($output, 'tamper')
    Reject '被追加数据的 ICO' { & $tool -Check }
    & $tool -Replace | Out-Null
    Need ((Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash -ceq $firstHash) '-Replace 未恢复确定性结果'

    Save-FixturePng $source 256 256 $true ([Drawing.Color]::FromArgb(255, 180, 60, 40))
    Reject '母版变化后旧 ICO' { & $tool -Check }
    & $tool -Replace | Out-Null
    $secondHash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash
    Need ($secondHash -cne $firstHash) '母版变化后 ICO 摘要未变化'
    & $tool -Check | Out-Null

    Save-FixturePng $source 256 256 $true ([Drawing.Color]::FromArgb(255, 180, 60, 40)) 144
    & $tool -Replace | Out-Null
    Need ((Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash -ceq $secondHash) '母版DPI改变了派生ICO字节'

    $bytes = [IO.File]::ReadAllBytes($output)
    Need ([BitConverter]::ToUInt16($bytes, 4) -eq 8) 'ICO 帧数不是 8'
    $actualSizes = for ($index = 0; $index -lt 8; $index++) {
        $value = [int]$bytes[6 + 16 * $index]
        if ($value -eq 0) { 256 } else { $value }
    }
    Need (($actualSizes -join ',') -ceq '16,20,24,32,48,64,128,256') 'ICO 帧尺寸集合错误'
    for ($index = 0; $index -lt 8; $index++) {
        $entry = 6 + 16 * $index
        $length = [BitConverter]::ToUInt32($bytes, $entry + 8)
        $offset = [BitConverter]::ToUInt32($bytes, $entry + 12)
        $frame = [byte[]]::new($length)
        [Array]::Copy($bytes, $offset, $frame, 0, $length)
        $resolution = Read-PngResolution $frame
        Need ($resolution.X -eq 3779 -and $resolution.Y -eq 3779 -and $resolution.Unit -eq 1) 'ICO帧pHYs不是固定96 DPI'
    }
    [pscustomobject]@{ Passed = $true; Checks = 23; OutputSha256 = $secondHash }
} finally {
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
