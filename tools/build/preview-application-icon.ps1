[CmdletBinding()]
param([Parameter(Mandatory)][string]$EvidenceDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Drawing
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$destination = [IO.Path]::GetFullPath((Join-Path $repository $EvidenceDirectory))
$logRoot = Join-Path $repository 'log'
if (-not $destination.StartsWith($logRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '预览仅写项目 log 目录' }
if (Test-Path -LiteralPath $destination) { throw '预览目录已存在，保留原件' }
for ($part = [IO.Path]::GetDirectoryName($destination); $part; $part = [IO.Path]::GetDirectoryName($part)) {
    if ((Test-Path -LiteralPath $part) -and ((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '预览路径不能包含链接' }
}
[void][IO.Directory]::CreateDirectory($destination)
$source = Join-Path $repository 'resources/aibrowse.ico'
$bytes = [IO.File]::ReadAllBytes($source)
if ($bytes.Length -lt 6 -or [BitConverter]::ToUInt16($bytes, 2) -ne 1) { throw '不是有效 ICO' }
$count = [BitConverter]::ToUInt16($bytes, 4)
if ($count -ne 8) { throw '预期八档图标帧' }
$canvas = [Drawing.Bitmap]::new(1200, 520)
$canvas.SetResolution(96, 96)
$graphics = [Drawing.Graphics]::FromImage($canvas)
$font = [Drawing.Font]::new('Segoe UI', 11)
$light = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#F3F4F6'))
$dark = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#111827'))
$facts = @()
try {
    $graphics.FillRectangle($light, 0, 0, 1200, 260)
    $graphics.FillRectangle($dark, 0, 260, 1200, 260)
    for ($index = 0; $index -lt $count; $index++) {
        $entry = 6 + 16 * $index
        $size = if ($bytes[$entry] -eq 0) { 256 } else { [int]$bytes[$entry] }
        $length = [BitConverter]::ToUInt32($bytes, $entry + 8)
        $offset = [BitConverter]::ToUInt32($bytes, $entry + 12)
        if ([uint64]$offset + $length -gt $bytes.Length) { throw '图标帧越界' }
        $frame = [byte[]]::new($length)
        [Array]::Copy($bytes, $offset, $frame, 0, $length)
        [IO.File]::WriteAllBytes((Join-Path $destination "$size.png"), $frame)
        $stream = [IO.MemoryStream]::new($frame, $false)
        $bitmap = [Drawing.Bitmap]::new($stream)
        try {
            if ($bitmap.Width -ne $size -or $bitmap.Height -ne $size) { throw '帧尺寸与目录不一致' }
            $column = if ($index -eq 7) { 914 } else { 12 + 126 * $index }
            $top = if ($size -eq 256) { 4 } else { 76 }
            foreach ($row in @(0, 260)) {
                $graphics.DrawImageUnscaled($bitmap, $column, ($row + $top))
                $brush = if ($row -eq 0) { $dark } else { $light }
                if ($size -lt 256) { $graphics.DrawString("$size px", $font, $brush, [single]$column, [single]($row + 32)) }
            }
            $facts += [pscustomobject]@{ size = $size; bytes = $length; sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($frame)).ToLowerInvariant() }
        } finally { $bitmap.Dispose(); $stream.Dispose() }
    }
    $canvas.Save((Join-Path $destination 'size-preview.png'), [Drawing.Imaging.ImageFormat]::Png)
    [pscustomobject]@{ source = 'resources/aibrowse.ico'; sourceSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant(); pixelScale = 1; frames = $facts } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $destination 'frames.json')
} finally { $graphics.Dispose(); $canvas.Dispose(); $font.Dispose(); $light.Dispose(); $dark.Dispose() }
$destination
