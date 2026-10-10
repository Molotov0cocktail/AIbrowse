param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$StartTicks,
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ImageSha256,
    [Parameter(Mandatory = $true)][long]$WindowHandle,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
namespace AIbrowseWindowProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  public static class Native {
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  }
}
'@

if (-not [IO.Path]::IsPathRooted($ImagePath) -or -not [IO.Path]::IsPathRooted($OutputDirectory)) {
    throw '映像和输出目录必须是绝对路径'
}
$expectedImage = [IO.Path]::GetFullPath($ImagePath)
$output = [IO.Path]::GetFullPath($OutputDirectory)
$handle = [IntPtr]$WindowHandle
function Assert-Identity {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    if ($process.StartTime.ToUniversalTime().Ticks -ne $StartTicks) { throw '进程创建身份不匹配' }
    if (-not [string]::Equals([IO.Path]::GetFullPath($process.Path), $expectedImage, [StringComparison]::OrdinalIgnoreCase)) { throw '进程映像不匹配' }
    if ((Get-FileHash -LiteralPath $expectedImage -Algorithm SHA256).Hash -cne $ImageSha256.ToUpperInvariant()) { throw '进程映像摘要不匹配' }
    if ($process.MainWindowHandle -ne $handle -or -not [AIbrowseWindowProbe.Native]::IsWindow($handle)) { throw '主窗口身份不匹配' }
    [uint32]$ownerPid = 0
    [void][AIbrowseWindowProbe.Native]::GetWindowThreadProcessId($handle, [ref]$ownerPid)
    if ($ownerPid -ne $ProcessId -or [AIbrowseWindowProbe.Native]::GetAncestor($handle, 2) -ne $handle) { throw '窗口不属于目标应用根窗口' }
}
function Limit-Text([object]$value, [int]$limit) {
    if ($null -eq $value) { return '' }
    $text = [string]$value
    if ($text.Length -gt $limit) { return $text.Substring(0, $limit) }
    return $text
}
function Check-Deadline([Diagnostics.Stopwatch]$clock) {
    if ($clock.ElapsedMilliseconds -ge 15000) { throw 'UIA观察超过15秒预算' }
}

if (Test-Path -LiteralPath $output) { throw '输出目录必须是新目录' }
[IO.Directory]::CreateDirectory($output) | Out-Null
Assert-Identity
$clock = [Diagnostics.Stopwatch]::StartNew()
$root = [Windows.Automation.AutomationElement]::FromHandle($handle)
if ($root.Current.NativeWindowHandle -ne $WindowHandle -or $root.Current.ProcessId -ne $ProcessId) { throw 'UIA根窗口身份不匹配' }
$walker = [Windows.Automation.TreeWalker]::ControlViewWalker
$queue = New-Object 'Collections.Generic.Queue[Windows.Automation.AutomationElement]'
$queue.Enqueue($root)
$nodes = New-Object Collections.Generic.List[object]
while ($queue.Count -gt 0 -and $nodes.Count -lt 512) {
    Check-Deadline $clock
    $element = $queue.Dequeue()
    try {
        $current = $element.Current
        $type = Limit-Text $current.ControlType.ProgrammaticName 80
        $value = $null
        if ($type -eq 'ControlType.Document' -or $type -eq 'ControlType.Edit') {
            $pattern = $null
            if ($element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
                $value = Limit-Text ([Windows.Automation.ValuePattern]$pattern).Current.Value 2048
            }
        }
        $nodes.Add([ordered]@{
            index = $nodes.Count; processId = $current.ProcessId; nativeHandle = $current.NativeWindowHandle
            controlType = $type; name = Limit-Text $current.Name 512; automationId = Limit-Text $current.AutomationId 256
            className = Limit-Text $current.ClassName 256; value = $value
        })
        $child = $walker.GetFirstChild($element)
        while ($null -ne $child -and ($queue.Count + $nodes.Count) -lt 512) {
            Check-Deadline $clock
            $queue.Enqueue($child)
            $child = $walker.GetNextSibling($child)
        }
    } catch [Windows.Automation.ElementNotAvailableException] { }
}
Check-Deadline $clock
Assert-Identity
$rect = New-Object AIbrowseWindowProbe.Rect
if (-not [AIbrowseWindowProbe.Native]::GetWindowRect($handle, [ref]$rect)) { throw '无法读取应用窗口边界' }
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -lt 1 -or $height -lt 1 -or $width -gt 16384 -or $height -gt 16384 -or ([long]$width * $height) -gt 50000000) { throw '应用窗口截图尺寸超出预算' }
$pngPath = Join-Path $output 'window.png'
$bitmap = New-Object Drawing.Bitmap $width, $height, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
try {
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $dc = $graphics.GetHdc()
        try { if (-not [AIbrowseWindowProbe.Native]::PrintWindow($handle, $dc, 2)) { throw '应用窗口截图失败' } }
        finally { $graphics.ReleaseHdc($dc) }
    } finally { $graphics.Dispose() }
    $stream = New-Object IO.FileStream $pngPath, ([IO.FileMode]::CreateNew), ([IO.FileAccess]::Write), ([IO.FileShare]::None)
    try { $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png) } finally { $stream.Dispose() }
} finally { $bitmap.Dispose() }
Assert-Identity
$documents = @($nodes | Where-Object { $_.controlType -eq 'ControlType.Document' })
$report = [ordered]@{
    schema = 1; utc = [DateTime]::UtcNow.ToString('o'); processId = $ProcessId; startTicks = $StartTicks
    imagePath = $expectedImage; imageSha256 = $ImageSha256.ToLowerInvariant(); windowHandle = $WindowHandle
    windowRect = [ordered]@{ left = $rect.Left; top = $rect.Top; width = $width; height = $height }
    limits = [ordered]@{ nodes = 512; milliseconds = 15000; valueChars = 2048 }
    elapsedMs = $clock.ElapsedMilliseconds; nodeCount = $nodes.Count; truncated = ($queue.Count -gt 0)
    documents = $documents; nodes = $nodes; screenshot = 'window.png'; readOnly = $true
}
$jsonPath = Join-Path $output 'report.json'
$json = ($report | ConvertTo-Json -Depth 8) + "`r`n"
$writer = New-Object IO.StreamWriter((New-Object IO.FileStream $jsonPath, ([IO.FileMode]::CreateNew), ([IO.FileAccess]::Write), ([IO.FileShare]::None)), (New-Object Text.UTF8Encoding($false)))
try { $writer.Write($json) } finally { $writer.Dispose() }
[Console]::Out.WriteLine(($report | Select-Object processId, windowHandle, nodeCount, elapsedMs, truncated, screenshot | ConvertTo-Json -Compress))
