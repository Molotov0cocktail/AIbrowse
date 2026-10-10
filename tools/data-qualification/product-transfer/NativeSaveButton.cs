using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

internal interface IAIbrowseButtonAccessible : IDisposable
{
    SaveButtonMetadata Read();
    void Act();
}
internal interface IAIbrowseSaveButtonPort : IDisposable
{
    long ElapsedMilliseconds { get; }
    bool IdentityMatches();
    IAIbrowseButtonAccessible OpenAccessible();
}
internal sealed class SaveButtonMetadata
{
    internal int HResult, Role, State;
    internal string Name, DefaultAction;
}
public sealed class AIbrowseSaveButtonProof
{
    public int version { get { return 1; } }
    public string mechanism { get { return "MSAA CHILDID_SELF"; } }
    public int controlId { get; internal set; }
    public string nameClass { get; internal set; }
    public int hresult { get { return 0; } }
    public int role { get { return 43; } }
    public bool available { get { return true; } }
    public bool visible { get { return true; } }
    public bool defaultActionPresent { get { return true; } }
    public bool nativeIdentityVerified { get { return true; } }
}

// Synchronous COM may block. The external helper and Job bound termination.
public sealed class AIbrowseNativeSaveButton : IDisposable
{
    private readonly IAIbrowseSaveButtonPort port;
    private readonly int controlId;
    private readonly string expectedName;
    private bool disposed, attempted;
    public AIbrowseNativeSaveButton(uint processId, string createdFileTime, string executable,
        IntPtr main, IntPtr dialog, IntPtr button, int controlId, string expectedName, Stopwatch clock)
        : this(new Win32SaveButtonPort(processId, createdFileTime, executable, main, dialog, button, controlId, clock), controlId, expectedName) { }
    internal AIbrowseNativeSaveButton(IAIbrowseSaveButtonPort port, int controlId, string expectedName)
    {
        this.port = port; this.controlId = controlId; this.expectedName = expectedName;
        try {
            string[] allowed = controlId == 1 ? new[] { "保存", "保存(S)", "保存(&S)", "Save", "&Save" }
                : controlId == 2 ? new[] { "取消", "Cancel" } : new string[0];
            if (Array.IndexOf(allowed, expectedName) < 0) throw new InvalidOperationException("按钮名称不在固定集合");
            Validate();
        } catch { Dispose(); throw; }
    }
    private void CheckTime()
    {
        long elapsed = port.ElapsedMilliseconds;
        if (disposed || elapsed < 0 || elapsed >= 30000) throw new InvalidOperationException("按钮动作超过原期限或已释放");
    }
    public void Validate()
    {
        CheckTime();
        if (!port.IdentityMatches()) throw new InvalidOperationException("按钮原生身份变化");
        CheckTime();
    }
    private AIbrowseSaveButtonProof Read(IAIbrowseButtonAccessible accessible)
    {
        Validate();
        SaveButtonMetadata value = accessible.Read();
        Validate();
        if (value == null || value.HResult != 0 || value.Role != 43 ||
            (value.State & (1 | 0x8000 | 0x10000)) != 0 ||
            !String.Equals(value.Name, expectedName, StringComparison.Ordinal) ||
            String.IsNullOrEmpty(value.DefaultAction))
            throw new InvalidOperationException("按钮MSAA语义资格不符");
        return new AIbrowseSaveButtonProof { controlId = controlId, nameClass = controlId == 1 ? "save" : "cancel" };
    }
    public AIbrowseSaveButtonProof Inspect()
    {
        Validate();
        using (IAIbrowseButtonAccessible accessible = port.OpenAccessible()) { return Read(accessible); }
    }
    public AIbrowseSaveButtonProof Act()
    {
        if (attempted) throw new InvalidOperationException("按钮动作不允许重发");
        attempted = true;
        Validate();
        using (IAIbrowseButtonAccessible accessible = port.OpenAccessible()) {
            Read(accessible);
            AIbrowseSaveButtonProof proof = Read(accessible);
            Validate();
            // Identity and semantic checks are adjacent to the action, not atomic.
            accessible.Act();
            CheckTime();
            return proof;
        }
    }
    public void Dispose() { if (disposed) return; disposed = true; port.Dispose(); }
}

// Retain one OBJID_CLIENT / IAccessible object for reads and CHILDID_SELF action.
internal sealed class SaveButtonAccessible : IAIbrowseButtonAccessible
{
    private object accessible;
    private readonly int hresult;
    internal SaveButtonAccessible(IntPtr window)
    {
        Guid iid = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
        IntPtr pointer;
        hresult = AccessibleObjectFromWindow(window, 0xFFFFFFFC, ref iid, out pointer);
        try {
            if (hresult != 0 || pointer == IntPtr.Zero) throw new InvalidOperationException("MSAA未返回S_OK动作对象");
            accessible = Marshal.GetObjectForIUnknown(pointer);
        } finally { if (pointer != IntPtr.Zero) Marshal.Release(pointer); }
    }
    private object Get(string property)
    {
        return accessible.GetType().InvokeMember(property, BindingFlags.GetProperty, null,
            accessible, new object[] { 0 }, CultureInfo.InvariantCulture);
    }
    public SaveButtonMetadata Read()
    {
        object name = Get("accName"), role = Get("accRole"), state = Get("accState"),
            defaultAction = Get("accDefaultAction");
        // MSAA role/state must marshal as VT_I4 and text as BSTR. Coercion can
        // turn null, booleans or malformed values into an enabled button.
        if (!(name is string) || !(role is int) || !(state is int) || !(defaultAction is string))
            throw new InvalidOperationException("按钮MSAA输出类型无效");
        return new SaveButtonMetadata {
            HResult = hresult,
            Name = (string)name,
            Role = (int)role,
            State = (int)state,
            DefaultAction = (string)defaultAction
        };
    }
    public void Act()
    {
        accessible.GetType().InvokeMember("accDoDefaultAction", BindingFlags.InvokeMethod, null,
            accessible, new object[] { 0 }, CultureInfo.InvariantCulture);
    }
    public void Dispose()
    {
        if (accessible == null) return;
        try { if (Marshal.IsComObject(accessible)) Marshal.FinalReleaseComObject(accessible); }
        finally { accessible = null; }
    }
    [DllImport("oleacc.dll")]
    private static extern int AccessibleObjectFromWindow(IntPtr window, uint objectId, ref Guid interfaceId, out IntPtr accessible);
}

internal sealed class Win32SaveButtonPort : IAIbrowseSaveButtonPort
{
    private readonly int controlId;
    private readonly uint processId;
    private readonly long created;
    private readonly string executable;
    private readonly IntPtr main, dialog, edit;
    private readonly Stopwatch clock;
    private readonly SafeProcessHandle process;
    private bool disposed;

    public Win32SaveButtonPort(uint processId, string createdFileTime, string executable,
        IntPtr main, IntPtr dialog, IntPtr edit, int controlId, Stopwatch clock)
    {
        if (IntPtr.Size != 8 || processId == 0 || processId == GetCurrentProcessId() || clock == null ||
            !long.TryParse(createdFileTime, NumberStyles.None, CultureInfo.InvariantCulture, out created) || created <= 0 ||
            string.IsNullOrEmpty(executable) || !Path.IsPathFullyQualified(executable) ||
            InvalidWindow(main) || InvalidWindow(dialog) || InvalidWindow(edit) || main == dialog || edit == dialog || edit == main)
            throw new InvalidOperationException("按钮原生控件初始化身份无效");
        if (controlId != 1 && controlId != 2) throw new InvalidOperationException("按钮控制ID无效");
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
