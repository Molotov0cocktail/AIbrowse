using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed class RestoreConfirmationProof
{
    public int version { get { return 1; } }
    public string purpose { get; internal set; }
    public string result { get; internal set; }
    public string mechanism { get { return "MSAA CHILDID_SELF"; } }
    public int controlId { get; internal set; }
    public int actionCount { get { return 1; } }
    public bool released { get { return true; } }
}

// A narrow policy for the two fixed product dialogs. Context is re-read by
// the bounded UI adapter; no supplied UI text becomes an action selector.
public sealed class AIbrowseRestoreConfirmation : IDisposable
{
    private readonly IAIbrowseSaveButtonPort port;
    private readonly Action validateContext;
    private readonly string purpose, expectedName;
    private readonly bool approve;
    private readonly int controlId;
    private readonly int budgetMs;
    private bool attempted, disposed;
    public int ActionCount { get; private set; }
    public static int ControlId(IntPtr button) { return GetDlgCtrlID(button); }
    [DllImport("user32.dll")]
    private static extern int GetDlgCtrlID(IntPtr button);
    public static string Message(string purpose)
    {
        if (purpose == "restore") return "恢复将替换当前信源、研究、监控数据和已保存会话，并关闭当前标签页后重新启动。是否继续？";
        if (purpose == "partial") return "本地数据服务未完整启动。是否关闭当前标签页并重新启动到恢复界面？重新启动后需要再次选择备份并确认恢复；原件和失败现场将保留。";
        throw new InvalidOperationException("恢复确认目的不在固定集合");
    }
    internal AIbrowseRestoreConfirmation(IAIbrowseSaveButtonPort port, string purpose, bool approve, int controlId, Action validateContext, int budgetMs = 30000)
    {
        this.port = port; this.purpose = purpose; this.approve = approve;
        this.controlId = controlId; this.validateContext = validateContext;
        this.budgetMs = budgetMs;
        expectedName = approve ? "恢复并重新启动" : "取消";
        try {
            Message(purpose);
            if (port == null || validateContext == null || controlId <= 0 || controlId > 65535 || budgetMs <= 0 || budgetMs > 30000)
                throw new InvalidOperationException("恢复确认绑定不完整");
            Validate();
        } catch { Dispose(); throw; }
    }
    public AIbrowseRestoreConfirmation(uint pid, string created, string image,
        IntPtr owner, IntPtr dialog, IntPtr button, int controlId, string purpose,
        bool approve, Stopwatch clock, Action validateContext, int budgetMs)
        : this(new Win32RestoreConfirmationPort(pid, created, image, owner, dialog, button, controlId, clock),
            purpose, approve, controlId, validateContext, budgetMs) { }
    private void Time()
    {
        if (disposed || port.ElapsedMilliseconds < 0 || port.ElapsedMilliseconds >= budgetMs)
            throw new InvalidOperationException("恢复确认超过原期限或已释放");
    }
    public void Validate()
    {
        Time();
        if (!port.IdentityMatches()) throw new InvalidOperationException("恢复确认原生身份变化");
        Time(); validateContext(); Time();
        if (!port.IdentityMatches()) throw new InvalidOperationException("恢复确认原生身份变化");
        Time();
    }
    private void Read(IAIbrowseButtonAccessible accessible)
    {
        Validate();
        SaveButtonMetadata value = accessible.Read();
        Validate();
        if (value == null || value.HResult != 0 || value.Role != 43 || value.State < 0 ||
            (value.State & (1 | 0x8000 | 0x10000)) != 0 || value.Name != expectedName ||
            String.IsNullOrEmpty(value.DefaultAction))
            throw new InvalidOperationException("恢复确认MSAA资格不符");
    }
    public RestoreConfirmationProof Act()
    {
        if (attempted) throw new InvalidOperationException("恢复确认不可重发");
        attempted = true;
        Validate();
        using (IAIbrowseButtonAccessible accessible = port.OpenAccessible()) {
            Read(accessible); Read(accessible); Validate();
            ActionCount++; accessible.Act(); Time();
        }
        // The old window may disappear after approval. Release and the original
        // deadline still gate the receipt; the observer alone accepts a successor.
        Time();
        return new RestoreConfirmationProof {
            purpose = purpose, result = approve ? "approved" : "cancelled", controlId = controlId
        };
    }
    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        if (port != null) port.Dispose();
    }
}
internal sealed class Win32RestoreConfirmationPort : IAIbrowseSaveButtonPort
{
    private readonly int controlId;
    private readonly uint processId;
    private readonly long created;
    private readonly string executable;
    private readonly IntPtr main, dialog, edit;
    private readonly Stopwatch clock;
    private readonly SafeProcessHandle process;
    private bool disposed;

    public Win32RestoreConfirmationPort(uint processId, string createdFileTime, string executable,
        IntPtr main, IntPtr dialog, IntPtr edit, int controlId, Stopwatch clock)
    {
        if (IntPtr.Size != 8 || processId == 0 || processId == GetCurrentProcessId() || clock == null ||
            !long.TryParse(createdFileTime, NumberStyles.None, CultureInfo.InvariantCulture, out created) || created <= 0 ||
            string.IsNullOrEmpty(executable) || !Path.IsPathFullyQualified(executable) ||
            InvalidWindow(main) || InvalidWindow(dialog) || InvalidWindow(edit) || main == dialog || edit == dialog || edit == main)
            throw new InvalidOperationException("按钮原生控件初始化身份无效");
        if (controlId <= 0 || controlId > 65535) throw new InvalidOperationException("按钮控制ID无效");
        this.controlId = controlId;
        this.processId = processId; this.executable = executable;
        this.main = main; this.dialog = dialog; this.edit = edit; this.clock = clock;
        process = OpenProcess(0x00100000 | 0x1000, false, processId);
        if (process.IsInvalid) { process.Dispose(); throw new InvalidOperationException("无法持有产品进程身份"); }
    }

    public long ElapsedMilliseconds { get { return clock.ElapsedMilliseconds; } }

    private static bool InvalidWindow(IntPtr window)
    {
        return window == IntPtr.Zero || window == new IntPtr(-1) || window == new IntPtr(0xffff);
    }

    private bool WindowProcessMatches(IntPtr window)
    {
        uint owner;
        uint thread = GetWindowThreadProcessId(window, out owner);
        return IsWindow(window) && thread != 0 && thread != GetCurrentThreadId() && owner == processId;
    }

    private static bool ClassMatches(IntPtr window, string expected)
    {
        var name = new StringBuilder(256);
        int length = GetClassNameW(window, name, name.Capacity);
        return length > 0 && length < name.Capacity - 1 && string.Equals(name.ToString(), expected, StringComparison.Ordinal);
    }

    public bool IdentityMatches()
    {
        if (disposed || process.IsClosed || process.IsInvalid || WaitForSingleObject(process, 0) != 258 ||
            GetProcessId(process) != processId) return false;
        long creation, exit, kernel, user;
        if (!GetProcessTimes(process, out creation, out exit, out kernel, out user) || creation != created) return false;
        var path = new StringBuilder(32768);
        uint size = (uint)path.Capacity;
        if (!QueryFullProcessImageNameW(process, 0, path, ref size) ||
            !string.Equals(path.ToString(), executable, StringComparison.OrdinalIgnoreCase)) return false;
        if (!WindowProcessMatches(main) || !WindowProcessMatches(dialog) || !WindowProcessMatches(edit) ||
            GetWindow(dialog, 4) != main || !ClassMatches(dialog, "#32770") || !ClassMatches(edit, "Button") ||
            GetDlgCtrlID(edit) != controlId || GetAncestor(edit, 2) != dialog || !IsChild(dialog, edit) ||
            !IsWindowEnabled(edit) || !IsWindowVisible(edit)) return false;
        long style = GetWindowLongPtrW(edit, -16).ToInt64();
        // A child style also rejects a failed zero-valued GWL_STYLE query.
        return (style & 0x40000000L) != 0;
    }

    public IAIbrowseButtonAccessible OpenAccessible() { return new SaveButtonAccessible(edit); }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        process.Dispose();
    }

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll")]
    private static extern uint GetProcessId(SafeProcessHandle process);
    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(SafeProcessHandle process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool QueryFullProcessImageNameW(SafeProcessHandle process, uint flags, StringBuilder path, ref uint size);
    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint id);
    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetClassNameW(IntPtr window, StringBuilder name, int maximum);
    [DllImport("user32.dll")]
    private static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern IntPtr GetWindowLongPtrW(IntPtr window, int index);
    [DllImport("user32.dll")]
    private static extern bool IsChild(IntPtr parent, IntPtr child);
}
