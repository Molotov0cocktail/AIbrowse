[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Drawing
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$directory = Join-Path $repository 'resources'
if (-not (Test-Path -LiteralPath $directory)) { [void][IO.Directory]::CreateDirectory($directory) }
if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '图标目录不能是链接' }
$output = Join-Path $directory 'aibrowse.ico'
if (Test-Path -LiteralPath $output) { throw '图标已存在，保留原件；需要更新时显式更改源码资产' }
$frames = [Collections.Generic.List[byte[]]]::new()
foreach ($size in @(16, 32, 48, 64, 128, 256)) {
    $bitmap = [Drawing.Bitmap]::new($size, $size)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $stream = [IO.MemoryStream]::new()
    try {
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.Clear([Drawing.Color]::Transparent)
        $background = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(255, 26, 46, 78))
        $accent = [Drawing.Pen]::new([Drawing.Color]::FromArgb(255, 94, 234, 212), [single]($size * 0.075))
        $light = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(255, 238, 246, 255))
        try {
            $graphics.FillEllipse($background, [single]($size * 0.02), [single]($size * 0.02), [single]($size * 0.96), [single]($size * 0.96))
            $graphics.DrawEllipse($accent, [single]($size * 0.20), [single]($size * 0.18), [single]($size * 0.46), [single]($size * 0.46))
            $accent.StartCap = [Drawing.Drawing2D.LineCap]::Round
            $accent.EndCap = [Drawing.Drawing2D.LineCap]::Round
            $graphics.DrawLine($accent, [single]($size * 0.61), [single]($size * 0.61), [single]($size * 0.79), [single]($size * 0.79))
            $points = [Drawing.PointF[]]@(
                [Drawing.PointF]::new([single]($size * 0.43), [single]($size * 0.27)),
                [Drawing.PointF]::new([single]($size * 0.47), [single]($size * 0.37)),
                [Drawing.PointF]::new([single]($size * 0.57), [single]($size * 0.41)),
                [Drawing.PointF]::new([single]($size * 0.47), [single]($size * 0.45)),
                [Drawing.PointF]::new([single]($size * 0.43), [single]($size * 0.55)),
                [Drawing.PointF]::new([single]($size * 0.39), [single]($size * 0.45)),
                [Drawing.PointF]::new([single]($size * 0.29), [single]($size * 0.41)),
                [Drawing.PointF]::new([single]($size * 0.39), [single]($size * 0.37))
            )
            $graphics.FillPolygon($light, $points)
        } finally { $background.Dispose(); $accent.Dispose(); $light.Dispose() }
        $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
        $frames.Add($stream.ToArray())
    } finally { $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose() }
}
$file = [IO.File]::Open($output, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$writer = [IO.BinaryWriter]::new($file)
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
    $offset = [uint32](6 + 16 * $frames.Count)
    $sizes = @(16, 32, 48, 64, 128, 256)
    for ($index = 0; $index -lt $frames.Count; $index++) {
        $encodedSize = [byte]$(if ($sizes[$index] -eq 256) { 0 } else { $sizes[$index] })
        $writer.Write($encodedSize); $writer.Write($encodedSize)
        $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$frames[$index].Length); $writer.Write($offset)
        $offset += [uint32]$frames[$index].Length
    }
    foreach ($frame in $frames) { $writer.Write($frame) }
    $writer.Flush(); $file.Flush($true)
} finally { $writer.Dispose(); $file.Dispose() }
Get-FileHash -LiteralPath $output -Algorithm SHA256 | Select-Object Hash
