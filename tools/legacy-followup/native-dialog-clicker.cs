using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace AIbrowse.ShutdownFollowup
{
    // Test-only native button selection, scoped to the exact launched process.
    public static class NativeDialogClicker
    {
        private delegate bool EnumCallback(IntPtr window, IntPtr data);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, IntPtr data);
        [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr data);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr window, StringBuilder text, int count);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassNameW(IntPtr window, StringBuilder text, int count);
        [DllImport("user32.dll")] private static extern bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
        public static Task Start(uint processId, string directory)
        {
            return Task.Run(() => {
                var timer = Stopwatch.StartNew();
                int selected = 0;
                while (selected < 2 && timer.ElapsedMilliseconds < 30000)
                {
                    var request = Path.Combine(directory, "dialog-request-" + selected + ".txt");
                    if (!File.Exists(request)) { Thread.Sleep(20); continue; }
                    string expected = selected == 0 ? "继续等待" : "停止快照并退出";
                    IntPtr button = IntPtr.Zero;
                    EnumWindows((window, unused) => {
                        uint owner; GetWindowThreadProcessId(window, out owner);
                        var title = new StringBuilder(256); GetWindowTextW(window, title, title.Capacity);
                        if (owner != processId || title.ToString() != "退出 AIbrowse") return true;
                        EnumChildWindows(window, (child, ignored) => {
                            var label = new StringBuilder(256); GetWindowTextW(child, label, label.Capacity);
                            var kind = new StringBuilder(64); GetClassNameW(child, kind, kind.Capacity);
                            if (kind.ToString() == "Button" && label.ToString().Replace("&", "") == expected) button = child;
                            return true;
                        }, IntPtr.Zero);
                        return true;
                    }, IntPtr.Zero);
                    if (button != IntPtr.Zero)
                    {
                        if (!PostMessageW(button, 0x00F5, IntPtr.Zero, IntPtr.Zero)) throw new InvalidOperationException("原生测试按钮选择失败");
                        File.WriteAllText(Path.Combine(directory, "dialog-selected-" + selected + ".txt"), "合成原生按钮选择：" + expected);
                        selected++;
                    }
                    Thread.Sleep(20);
                }
                if (selected != 2) throw new InvalidOperationException("原生测试按钮定位超时");
            });
        }
    }
}
