using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class AIbrowseProductWindow
{
    public delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr window, StringBuilder className, int maximum);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")]
    public static extern bool IsChild(IntPtr parent, IntPtr child);

    public static IntPtr[] OwnedTopLevelWindows(IntPtr owner, int maximum)
    {
        if (owner == IntPtr.Zero || maximum < 1 || maximum > 32)
            throw new ArgumentOutOfRangeException(nameof(maximum));
        var handles = new List<IntPtr>();
        if (!EnumWindows((window, _) => {
            if (handles.Count < maximum && window != owner && GetWindow(window, 4) == owner)
                handles.Add(window);
            return true;
        }, IntPtr.Zero))
        {
            int error = Marshal.GetLastWin32Error();
            throw new System.ComponentModel.Win32Exception(error, "无法枚举产品owned top-level窗口");
        }
        return handles.ToArray();
    }
}
