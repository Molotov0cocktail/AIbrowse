using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

internal interface IAIbrowseSaveControlPort : IDisposable
{
    long ElapsedMilliseconds { get; }
    bool IdentityMatches();
    ulong ReadLength(uint timeout);
    string ReadText(uint timeout);
    bool WriteTarget(string target, uint timeout);
}

// This tool owns one exact product process and one fixed filename Edit control.
// The injected port is internal and is used only by the pure qualification tests.
public sealed class AIbrowseNativeSaveControl : IDisposable
{
    private const int MaximumText = 4096;
    private readonly IAIbrowseSaveControlPort port;
    private bool disposed;

    public AIbrowseNativeSaveControl(uint processId, string createdFileTime, string executable,
        IntPtr main, IntPtr dialog, IntPtr edit, Stopwatch clock)
        : this(new Win32SaveControlPort(processId, createdFileTime, executable, main, dialog, edit, clock)) { }

    internal AIbrowseNativeSaveControl(IAIbrowseSaveControlPort port)
    {
        this.port = port;
        try { Validate(); }
        catch { port.Dispose(); disposed = true; throw; }
    }

    private uint Timeout()
    {
        long remaining = 30000 - port.ElapsedMilliseconds;
        if (disposed || remaining <= 0 || remaining > 30000)
            throw new InvalidOperationException("文件名原生操作超过原期限或已释放");
        return (uint)Math.Min(1000L, remaining);
    }

    public void Validate()
    {
        Timeout();
        if (!port.IdentityMatches()) throw new InvalidOperationException("文件名原生控件资格变化");
        Timeout();
    }

    public string ReadText()
    {
        Validate();
        ulong before = port.ReadLength(Timeout());
        Validate();
        if (before > MaximumText) throw new InvalidOperationException("文件名原生文本超限");
        string value = port.ReadText(Timeout());
        Validate();
        ulong after = port.ReadLength(Timeout());
        Validate();
        // WM_GETTEXTLENGTH can overestimate when ANSI and Unicode are mixed.
        if (before != after || value == null || value.Length > MaximumText ||
            (ulong)value.Length > before || value.IndexOf('\0') >= 0)
            throw new InvalidOperationException("文件名原生文本长度变化或不完整");
        return value;
    }

    public void WriteTarget(string target)
    {
        if (string.IsNullOrEmpty(target) || target.Length > MaximumText || target.IndexOf('\0') >= 0 ||
            !Path.IsPathFullyQualified(target) || !string.Equals(Path.GetExtension(target), ".aibak", StringComparison.Ordinal) ||
            File.Exists(target) || Directory.Exists(target))
            throw new InvalidOperationException("备份目标必须为不存在且有界的绝对aibak路径");
        Validate();
        bool accepted = port.WriteTarget(target, Timeout());
        Validate();
        if (!accepted) throw new InvalidOperationException("原生文件名写入失败");
        if (!string.Equals(ReadText(), target, StringComparison.Ordinal))
            throw new InvalidOperationException("原生文件名写后读回不匹配");
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        port.Dispose();
    }
}

internal sealed class Win32SaveControlPort : IAIbrowseSaveControlPort
{
    private const uint MessageFlags = 0x0001 | 0x0002 | 0x0020;
    private readonly uint processId;
    private readonly long created;
    private readonly string executable;
    private readonly IntPtr main, dialog, edit;
    private readonly Stopwatch clock;
    private readonly SafeProcessHandle process;
    private bool disposed;

    public Win32SaveControlPort(uint processId, string createdFileTime, string executable,
        IntPtr main, IntPtr dialog, IntPtr edit, Stopwatch clock)
    {
        if (IntPtr.Size != 8 || processId == 0 || processId == GetCurrentProcessId() || clock == null ||
            !long.TryParse(createdFileTime, NumberStyles.None, CultureInfo.InvariantCulture, out created) || created <= 0 ||
            string.IsNullOrEmpty(executable) || !Path.IsPathFullyQualified(executable) ||
            InvalidWindow(main) || InvalidWindow(dialog) || InvalidWindow(edit) || main == dialog || edit == dialog || edit == main)
            throw new InvalidOperationException("文件名原生控件初始化身份无效");
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
            GetWindow(dialog, 4) != main || !ClassMatches(dialog, "#32770") || !ClassMatches(edit, "Edit") ||
            GetDlgCtrlID(edit) != 1001 || GetAncestor(edit, 2) != dialog ||
            !IsWindowEnabled(edit) || !IsWindowVisible(edit)) return false;
        long style = GetWindowLongPtrW(edit, -16).ToInt64();
        // A child style also rejects a failed zero-valued GWL_STYLE query.
        return (style & 0x40000000L) != 0 && (style & 0x0800L) == 0;
    }

    private static void Sent(IntPtr result)
    {
        if (result == IntPtr.Zero) throw new InvalidOperationException("文件名固定原生消息失败或超时，停止且不重发");
    }

    public ulong ReadLength(uint timeout)
    {
        UIntPtr result;
        Sent(SendMessageTimeoutW(edit, 0x000e, UIntPtr.Zero, IntPtr.Zero, MessageFlags, timeout, out result));
        return result.ToUInt64();
    }

    public string ReadText(uint timeout)
    {
        var buffer = new StringBuilder(4097);
        UIntPtr result;
        Sent(SendMessageTimeoutTextW(edit, 0x000d, new UIntPtr(4097), buffer, MessageFlags, timeout, out result));
        string value = buffer.ToString();
        if (result.ToUInt64() > 4096 || result.ToUInt64() != (ulong)value.Length)
            throw new InvalidOperationException("文件名原生文本回执长度不符");
        return value;
    }

    public bool WriteTarget(string target, uint timeout)
    {
        UIntPtr result;
        Sent(SendMessageTimeoutSetW(edit, 0x000c, UIntPtr.Zero, target, MessageFlags, timeout, out result));
        return result.ToUInt64() != 0;
    }

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
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr SendMessageTimeoutTextW(IntPtr window, uint message, UIntPtr wParam, StringBuilder value, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr SendMessageTimeoutSetW(IntPtr window, uint message, UIntPtr wParam, string value, uint flags, uint timeout, out UIntPtr result);
}
