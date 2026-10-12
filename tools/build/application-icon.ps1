[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$Replace
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($Check -and $Replace) { throw '-Check 与 -Replace 不能同时使用' }
Add-Type -AssemblyName System.Drawing

$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$directory = Join-Path $repository 'resources'
$source = Join-Path $directory 'aibrowse-icon.png'
$output = Join-Path $directory 'aibrowse.ico'
$sizes = @(16, 20, 24, 32, 48, 64, 128, 256)

function Require-OrdinaryFile([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label 不存在" }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$Label 不能是链接" }
}

function Test-Alpha([Drawing.Bitmap]$Bitmap, [string]$Label) {
    $hasTransparent = $false
    $hasVisible = $false
    for ($y = 0; $y -lt $Bitmap.Height -and -not ($hasTransparent -and $hasVisible); $y++) {
        for ($x = 0; $x -lt $Bitmap.Width -and -not ($hasTransparent -and $hasVisible); $x++) {
            $alpha = $Bitmap.GetPixel($x, $y).A
            if ($alpha -lt 255) { $hasTransparent = $true }
            if ($alpha -gt 0) { $hasVisible = $true }
        }
    }
    if (-not $hasTransparent -or -not $hasVisible) { throw "$Label 必须同时包含透明与可见像素" }
}

function Read-SourceBitmap([string]$Path) {
    Require-OrdinaryFile $Path 'PNG 母版'
    $bytes = [IO.File]::ReadAllBytes($Path)
    $signature = [byte[]](137, 80, 78, 71, 13, 10, 26, 10)
    if ($bytes.Length -lt $signature.Length) { throw 'PNG 母版格式无效' }
    for ($index = 0; $index -lt $signature.Length; $index++) {
        if ($bytes[$index] -ne $signature[$index]) { throw 'PNG 母版格式无效' }
    }
    $stream = [IO.MemoryStream]::new($bytes, $false)
    try {
        $image = [Drawing.Image]::FromStream($stream, $true, $true)
        try {
            if ($image.RawFormat.Guid -ne [Drawing.Imaging.ImageFormat]::Png.Guid) { throw '母版必须是 PNG' }
            if ($image.Width -ne $image.Height -or $image.Width -lt 256) {
                throw 'PNG 母版必须是至少 256×256 的正方形'
            }
            $bitmap = [Drawing.Bitmap]::new($image.Width, $image.Height, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
            $bitmap.SetResolution(96, 96)
            $graphics = [Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
                $destination = [Drawing.Rectangle]::new(0, 0, $image.Width, $image.Height)
                $graphics.DrawImage($image, $destination, 0, 0, $image.Width, $image.Height, [Drawing.GraphicsUnit]::Pixel)
            } finally { $graphics.Dispose() }
        } finally { $image.Dispose() }
    } finally { $stream.Dispose() }
    try {
        Test-Alpha $bitmap 'PNG 母版'
        return $bitmap
    } catch {
        $bitmap.Dispose()
        throw
    }
}

function Convert-ToPngFrame([Drawing.Bitmap]$Source, [int]$Size) {
    $bitmap = [Drawing.Bitmap]::new($Size, $Size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bitmap.SetResolution(96, 96)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $stream = [IO.MemoryStream]::new()
    try {
        $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.Clear([Drawing.Color]::Transparent)
        $destination = [Drawing.Rectangle]::new(0, 0, $Size, $Size)
        $graphics.DrawImage($Source, $destination, 0, 0, $Source.Width, $Source.Height, [Drawing.GraphicsUnit]::Pixel)
        Test-Alpha $bitmap "${Size}×${Size} 图标帧"
        $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
        return $stream.ToArray()
    } finally {
        $stream.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function New-IcoBytes([Drawing.Bitmap]$Source, [int[]]$Sizes) {
    $frames = [Collections.Generic.List[byte[]]]::new()
    foreach ($size in $Sizes) { $frames.Add((Convert-ToPngFrame $Source $size)) }
    $stream = [IO.MemoryStream]::new()
    $writer = [IO.BinaryWriter]::new($stream)
    try {
        $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
        $offset = [uint32](6 + 16 * $frames.Count)
        for ($index = 0; $index -lt $frames.Count; $index++) {
            $encoded = [byte]$(if ($Sizes[$index] -eq 256) { 0 } else { $Sizes[$index] })
            $writer.Write($encoded); $writer.Write($encoded)
            $writer.Write([byte]0); $writer.Write([byte]0)
            $writer.Write([uint16]1); $writer.Write([uint16]32)
            $writer.Write([uint32]$frames[$index].Length); $writer.Write($offset)
            $offset += [uint32]$frames[$index].Length
        }
        foreach ($frame in $frames) { $writer.Write($frame) }
        $writer.Flush()
        return $stream.ToArray()
    } finally { $writer.Dispose(); $stream.Dispose() }
}

function Test-IcoBytes([byte[]]$Bytes, [int[]]$Sizes) {
    if ($Bytes.Length -lt (6 + 16 * $Sizes.Count)) { throw 'ICO 结构过短' }
    if ([BitConverter]::ToUInt16($Bytes, 0) -ne 0 -or [BitConverter]::ToUInt16($Bytes, 2) -ne 1) { throw 'ICO 文件头无效' }
    if ([BitConverter]::ToUInt16($Bytes, 4) -ne $Sizes.Count) { throw 'ICO 帧数量无效' }
    $expectedOffset = [uint32](6 + 16 * $Sizes.Count)
    for ($index = 0; $index -lt $Sizes.Count; $index++) {
        $entry = 6 + 16 * $index
        $encoded = if ($Sizes[$index] -eq 256) { 0 } else { $Sizes[$index] }
        if ($Bytes[$entry] -ne $encoded -or $Bytes[$entry + 1] -ne $encoded) { throw 'ICO 帧尺寸目录无效' }
        if ($Bytes[$entry + 2] -ne 0 -or $Bytes[$entry + 3] -ne 0) { throw 'ICO 调色板或保留字段无效' }
        if ([BitConverter]::ToUInt16($Bytes, $entry + 4) -ne 1 -or [BitConverter]::ToUInt16($Bytes, $entry + 6) -ne 32) { throw 'ICO 帧色深无效' }
        $length = [BitConverter]::ToUInt32($Bytes, $entry + 8)
        $offset = [BitConverter]::ToUInt32($Bytes, $entry + 12)
        if ($length -eq 0 -or $offset -ne $expectedOffset -or [uint64]$offset + $length -gt $Bytes.Length) { throw 'ICO 帧边界无效' }
        $frame = [byte[]]::new($length)
        [Array]::Copy($Bytes, $offset, $frame, 0, $length)
        $frameStream = [IO.MemoryStream]::new($frame, $false)
        try {
            $image = [Drawing.Image]::FromStream($frameStream, $true, $true)
            try {
                if ($image.RawFormat.Guid -ne [Drawing.Imaging.ImageFormat]::Png.Guid -or $image.Width -ne $Sizes[$index] -or $image.Height -ne $Sizes[$index]) { throw 'ICO 内嵌 PNG 帧无效' }
                $bitmap = [Drawing.Bitmap]::new($image)
                try { Test-Alpha $bitmap "ICO $($Sizes[$index])×$($Sizes[$index]) 帧" } finally { $bitmap.Dispose() }
            } finally { $image.Dispose() }
        } finally { $frameStream.Dispose() }
        $expectedOffset += $length
    }
    if ($expectedOffset -ne $Bytes.Length) { throw 'ICO 含目录外附加数据' }
}

function Test-EqualBytes([byte[]]$Left, [byte[]]$Right) {
    if ($Left.Length -ne $Right.Length) { return $false }
    for ($index = 0; $index -lt $Left.Length; $index++) {
        if ($Left[$index] -ne $Right[$index]) { return $false }
    }
    return $true
}

if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw 'resources 目录不存在' }
if ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '图标目录不能是链接' }

$sourceBitmap = Read-SourceBitmap $source
try { $generated = New-IcoBytes $sourceBitmap $sizes } finally { $sourceBitmap.Dispose() }
Test-IcoBytes $generated $sizes

if ($Check) {
    Require-OrdinaryFile $output 'ICO 输出'
    $existing = [IO.File]::ReadAllBytes($output)
    Test-IcoBytes $existing $sizes
    if (-not (Test-EqualBytes $existing $generated)) { throw '现有 ICO 与 PNG 母版的确定性重建结果不一致' }
    [pscustomobject]@{ Mode = 'Check'; SourceSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash; OutputSha256 = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash; Sizes = $sizes -join ',' }
    return
}

if (Test-Path -LiteralPath $output) {
    Require-OrdinaryFile $output 'ICO 输出'
    if (-not $Replace) { throw 'ICO 已存在；更新受控派生资产必须显式使用 -Replace' }
} elseif ($Replace) { throw '-Replace 只允许替换已存在的 ICO' }

$temporary = Join-Path $directory ('.aibrowse.ico.' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
    $file = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $file.Write($generated, 0, $generated.Length); $file.Flush($true) } finally { $file.Dispose() }
    Test-IcoBytes ([IO.File]::ReadAllBytes($temporary)) $sizes
    if (Test-Path -LiteralPath $output) { [IO.File]::Move($temporary, $output, $true) } else { [IO.File]::Move($temporary, $output) }
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}

[pscustomobject]@{ Mode = $(if ($Replace) { 'Replace' } else { 'Create' }); SourceSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash; OutputSha256 = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash; Sizes = $sizes -join ',' }
