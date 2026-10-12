param([long]$TargetWindow, [int]$TargetProcess, [int]$X, [int]$Y, [int]$EndX = -1, [int]$EndY = -1)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BrowserWindowInput {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@
[void][BrowserWindowInput]::SetProcessDPIAware()
$target = [IntPtr]::new($TargetWindow)
[uint32]$actualProcess = 0
[void][BrowserWindowInput]::GetWindowThreadProcessId($target, [ref]$actualProcess)
if ($actualProcess -eq $TargetProcess) { [void][BrowserWindowInput]::SetForegroundWindow($target) }
Start-Sleep -Milliseconds 100
if ($actualProcess -ne $TargetProcess -or [BrowserWindowInput]::GetForegroundWindow() -ne $target) { throw '验证窗口不在前台，未发送输入' }
if (-not [BrowserWindowInput]::SetCursorPos($X, $Y)) { throw '鼠标定位失败' }
Start-Sleep -Milliseconds 100
$point = [BrowserWindowInput+Point]::new()
$point.X = $X
$point.Y = $Y
if ([BrowserWindowInput]::GetAncestor([BrowserWindowInput]::WindowFromPoint($point), 2) -ne $target) { throw '鼠标目标不是验证窗口，未发送输入' }
[BrowserWindowInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 100
if ($EndX -ge 0 -and $EndY -ge 0) {
  for ($i = 1; $i -le 10; $i++) {
    [void][BrowserWindowInput]::SetCursorPos([int]($X + ($EndX - $X) * $i / 10), [int]($Y + ($EndY - $Y) * $i / 10))
    Start-Sleep -Milliseconds 20
  }
}
[BrowserWindowInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
