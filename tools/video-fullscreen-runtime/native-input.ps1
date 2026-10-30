param(
  [Parameter(Mandatory)][long]$TargetWindow,
  [Parameter(Mandatory)][int]$TargetProcess,
  [int]$ScreenX,
  [int]$ScreenY,
  [ValidateSet('Click', 'F', 'Escape')][string]$Action = 'Click'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class FullscreenInput {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  public static void Send(long handle, int process, int x, int y, string action) {
    SetProcessDPIAware();
    var window = new IntPtr(handle);
    uint actual;
    GetWindowThreadProcessId(window, out actual);
    if (actual != (uint)process) throw new InvalidOperationException("窗口进程绑定不符");
    if (GetForegroundWindow() != window) { SetForegroundWindow(window); Thread.Sleep(150); }
    if (GetForegroundWindow() != window) throw new InvalidOperationException("验证窗口未在前台，拒绝输入；目标=" + window + "，实际前台=" + GetForegroundWindow());
    if (action == "Click") {
      if (!SetCursorPos(x, y)) throw new InvalidOperationException("鼠标定位失败");
      Thread.Sleep(100);
      if (GetForegroundWindow() != window || GetAncestor(WindowFromPoint(new Point {X=x,Y=y}), 2) != window)
        throw new InvalidOperationException("鼠标目标不属于验证窗口");
      mouse_event(2,0,0,0,UIntPtr.Zero);
      Thread.Sleep(40);
      mouse_event(4,0,0,0,UIntPtr.Zero);
    } else {
      byte key = action == "F" ? (byte)0x46 : (byte)0x1B;
      keybd_event(key,0,0,UIntPtr.Zero);
      Thread.Sleep(40);
      keybd_event(key,0,2,UIntPtr.Zero);
    }
  }
}
'@
[FullscreenInput]::Send($TargetWindow, $TargetProcess, $ScreenX, $ScreenY, $Action)
