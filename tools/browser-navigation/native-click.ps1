param(
  [Parameter(Mandatory)][long]$TargetWindow,
  [Parameter(Mandatory)][int]$TargetProcess,
  [Parameter(Mandatory)][int]$ScreenX,
  [Parameter(Mandatory)][int]$ScreenY
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class BrowserNavigationInput {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  public static void Click(long handle, int process, int x, int y) {
    SetProcessDPIAware();
    var window = new IntPtr(handle);
    uint actual;
    GetWindowThreadProcessId(window, out actual);
    if (actual != (uint)process || GetForegroundWindow() != window)
      throw new InvalidOperationException("验证窗口未在前台，拒绝鼠标输入");
    if (!SetCursorPos(x, y)) throw new InvalidOperationException("鼠标定位失败");
    Thread.Sleep(100);
    if (GetForegroundWindow() != window || GetAncestor(WindowFromPoint(new Point {X=x,Y=y}), 2) != window)
      throw new InvalidOperationException("鼠标目标不属于验证窗口");
    mouse_event(2,0,0,0,UIntPtr.Zero);
    Thread.Sleep(40);
    mouse_event(4,0,0,0,UIntPtr.Zero);
  }
}
'@
[BrowserNavigationInput]::Click($TargetWindow, $TargetProcess, $ScreenX, $ScreenY)
