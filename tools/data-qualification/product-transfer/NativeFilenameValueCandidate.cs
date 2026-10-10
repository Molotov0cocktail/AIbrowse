using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

// The fixture's timestamp is the only action clock, including inside native calls.
public sealed class AIbrowseFilenameDeadline
{
    private readonly long startedTick;
    public AIbrowseFilenameDeadline(long startedTick, long frequency)
    {
        if (frequency != Stopwatch.Frequency || startedTick <= 0 || startedTick > Stopwatch.GetTimestamp())
            throw new InvalidOperationException("原生对话框时钟身份无效");
        this.startedTick = startedTick;
        Check();
    }
    public long ElapsedMilliseconds
    {
        get
        {
            long ticks = Stopwatch.GetTimestamp() - startedTick;
            if (ticks < 0) throw new InvalidOperationException("原生对话框时钟倒退");
            return (long)((decimal)ticks * 1000 / Stopwatch.Frequency);
        }
    }
    public void Check()
    {
        if (ElapsedMilliseconds >= 30000) throw new InvalidOperationException("原生对话框原期限已过");
    }
}

// Adapters replace only the elapsed-time port; audited native identity code is reused.
public static class AIbrowseFilenamePorts
{
    public static AIbrowseNativeSaveControl Control(uint pid, string created, string image,
        IntPtr owner, IntPtr dialog, IntPtr edit, AIbrowseFilenameDeadline deadline)
    {
        deadline.Check();
        return new AIbrowseNativeSaveControl(new FilenameDeadlineControlPort(
            new Win32SaveControlPort(pid, created, image, owner, dialog, edit, Stopwatch.StartNew()), deadline));
    }
    public static AIbrowseNativeSaveButton Button(uint pid, string created, string image,
        IntPtr owner, IntPtr dialog, IntPtr button, string name, AIbrowseFilenameDeadline deadline)
    {
        deadline.Check();
        return new AIbrowseNativeSaveButton(new FilenameDeadlineButtonPort(
            new Win32SaveButtonPort(pid, created, image, owner, dialog, button, 1, Stopwatch.StartNew()), deadline), 1, name);
    }
    public static AIbrowseNativeFilenameValue Value(uint pid, string created, string image,
        IntPtr owner, IntPtr dialog, IntPtr edit, AIbrowseFilenameDeadline deadline)
    {
        deadline.Check();
        return new AIbrowseNativeFilenameValue(new FilenameDeadlineValuePort(
            new FilenameValuePort(pid, created, image, owner, dialog, edit, deadline), deadline));
    }
}
internal sealed class FilenameDeadlineControlPort : IAIbrowseSaveControlPort
{
    private readonly IAIbrowseSaveControlPort inner;
    private readonly AIbrowseFilenameDeadline deadline;
    internal FilenameDeadlineControlPort(IAIbrowseSaveControlPort inner, AIbrowseFilenameDeadline deadline)
    { this.inner = inner; this.deadline = deadline; }
    public long ElapsedMilliseconds { get { return deadline.ElapsedMilliseconds; } }
    public bool IdentityMatches() { deadline.Check(); bool result = inner.IdentityMatches(); deadline.Check(); return result; }
    public ulong ReadLength(uint timeout) { deadline.Check(); ulong result = inner.ReadLength(timeout); deadline.Check(); return result; }
    public string ReadText(uint timeout) { deadline.Check(); string result = inner.ReadText(timeout); deadline.Check(); return result; }
    public bool WriteTarget(string target, uint timeout) { deadline.Check(); bool result = inner.WriteTarget(target, timeout); deadline.Check(); return result; }
    public void Dispose() { inner.Dispose(); }
}
internal sealed class FilenameDeadlineButtonPort : IAIbrowseSaveButtonPort
{
    private readonly IAIbrowseSaveButtonPort inner;
    private readonly AIbrowseFilenameDeadline deadline;
    internal FilenameDeadlineButtonPort(IAIbrowseSaveButtonPort inner, AIbrowseFilenameDeadline deadline)
    { this.inner = inner; this.deadline = deadline; }
    public long ElapsedMilliseconds { get { return deadline.ElapsedMilliseconds; } }
    public bool IdentityMatches() { deadline.Check(); bool result = inner.IdentityMatches(); deadline.Check(); return result; }
    public IAIbrowseButtonAccessible OpenAccessible()
    {
        deadline.Check();
        IAIbrowseButtonAccessible accessible = inner.OpenAccessible();
        try { deadline.Check(); return new FilenameDeadlineButtonAccessible(accessible, deadline); }
        catch { accessible.Dispose(); throw; }
    }
    public void Dispose() { inner.Dispose(); }
}
internal sealed class FilenameDeadlineButtonAccessible : IAIbrowseButtonAccessible
{
    private readonly IAIbrowseButtonAccessible inner;
    private readonly AIbrowseFilenameDeadline deadline;
    internal FilenameDeadlineButtonAccessible(IAIbrowseButtonAccessible inner, AIbrowseFilenameDeadline deadline)
    { this.inner = inner; this.deadline = deadline; }
    public SaveButtonMetadata Read() { deadline.Check(); SaveButtonMetadata result = inner.Read(); deadline.Check(); return result; }
    public void Act() { deadline.Check(); inner.Act(); deadline.Check(); }
    public void Dispose() { inner.Dispose(); }
}

internal sealed class FilenameValueMetadata
{
    internal object Name, Value, Role, State;
    internal int HResult;
    internal bool ExactWindow;
}
internal interface IFilenameValueAccessible : IDisposable
{
    FilenameValueMetadata Read();
    int Put(string target);
}
internal interface IFilenameValuePort : IDisposable
{
    long Elapsed { get; }
    void Validate();
    string ReadNative();
    IFilenameValueAccessible Open();
}
internal sealed class FilenameDeadlineValuePort : IFilenameValuePort
{
    private readonly IFilenameValuePort inner;
    private readonly AIbrowseFilenameDeadline deadline;
    internal FilenameDeadlineValuePort(IFilenameValuePort inner, AIbrowseFilenameDeadline deadline)
    { this.inner = inner; this.deadline = deadline; }
    public long Elapsed { get { return deadline.ElapsedMilliseconds; } }
    public void Validate() { deadline.Check(); inner.Validate(); deadline.Check(); }
    public string ReadNative() { deadline.Check(); string result = inner.ReadNative(); deadline.Check(); return result; }
    public IFilenameValueAccessible Open()
    {
        deadline.Check();
        IFilenameValueAccessible accessible = inner.Open();
        try { deadline.Check(); return accessible; }
        catch { accessible.Dispose(); throw; }
    }
    public void Dispose() { inner.Dispose(); }
}

// Only one value operation on the already qualified native Edit is exposed.
public sealed class FilenameValueQualificationException : Exception
{
    internal FilenameValueQualificationException() : base("文件名MSAA严格资格不符") { }
}
public sealed class AIbrowseNativeFilenameValue : IDisposable
{
    private readonly IFilenameValuePort port;
    private bool attempted, disposed;
    internal AIbrowseNativeFilenameValue(IFilenameValuePort port) { this.port = port; }

    private void Check()
    {
        if (disposed || port.Elapsed < 0 || port.Elapsed >= 30000) throw new InvalidOperationException("文件名值操作超过原期限或已释放");
        port.Validate();
        if (port.Elapsed < 0 || port.Elapsed >= 30000) throw new InvalidOperationException("文件名值身份读取迟到");
    }
    internal static void ValidateMetadata(FilenameValueMetadata value, string expected)
    {
        string[] names = { "文件名", "文件名:", "文件名(N):", "文件名(&N):", "File name:", "File &name:" };
        if (value == null || value.HResult != 0 || !value.ExactWindow ||
            !(value.Name is string) || !(value.Value is string) || !(value.Role is int) || !(value.State is int) ||
            (int)value.Role != 42 || (int)value.State < 0 ||
            ((int)value.State & (1 | 0x40 | 0x8000 | 0x10000 | 0x20000000)) != 0 ||
            Array.IndexOf(names, (string)value.Name) < 0 ||
            !String.Equals((string)value.Value, expected, StringComparison.Ordinal) ||
            expected == null || expected.Length > 4096 || expected.IndexOf('\0') >= 0)
            throw new FilenameValueQualificationException();
    }
    private void Read(IFilenameValueAccessible accessible, string expected)
    {
        Check();
        FilenameValueMetadata value = accessible.Read();
        Check();
        ValidateMetadata(value, expected);
    }
    public bool Inspect(string initial)
    {
        Check();
        using (IFilenameValueAccessible accessible = port.Open())
        {
            Read(accessible, initial);
            if (!String.Equals(port.ReadNative(), initial, StringComparison.Ordinal))
                throw new InvalidOperationException("文件名初始值读取不一致");
            Check();
            return true;
        }
    }
    public void WriteTarget(string target, string initial)
    {
        if (attempted) throw new InvalidOperationException("文件名值操作不允许重发");
        attempted = true;
        if (String.IsNullOrEmpty(target) || target.Length > 4096 || target.IndexOf('\0') >= 0 ||
            !Path.IsPathFullyQualified(target) || Path.GetExtension(target) != ".aibak" || File.Exists(target) || Directory.Exists(target))
            throw new InvalidOperationException("文件名值目标无效");
        Check();
        using (IFilenameValueAccessible accessible = port.Open())
        {
            Read(accessible, initial);
            Read(accessible, initial);
            if (!String.Equals(port.ReadNative(), initial, StringComparison.Ordinal))
                throw new InvalidOperationException("文件名值写入前改变");
            Check();
            int result = accessible.Put(target);
            Check();
            if (result != 0) throw new InvalidOperationException("文件名值写入未返回S_OK");
            Read(accessible, target);
            if (!String.Equals(port.ReadNative(), target, StringComparison.Ordinal))
                throw new InvalidOperationException("文件名值写后读回不符");
            Check();
        }
    }
    public void Dispose() { if (disposed) return; disposed = true; port.Dispose(); }
}

internal sealed class FilenameValuePort : IFilenameValuePort
{
    private readonly AIbrowseNativeSaveControl control;
    private readonly IntPtr edit;
    private readonly AIbrowseFilenameDeadline deadline;
    internal FilenameValuePort(uint processId, string created, string executable, IntPtr main, IntPtr dialog, IntPtr edit, AIbrowseFilenameDeadline deadline)
    {
        control = AIbrowseFilenamePorts.Control(processId, created, executable, main, dialog, edit, deadline);
        this.edit = edit; this.deadline = deadline;
    }
    public long Elapsed { get { return deadline.ElapsedMilliseconds; } }
    public void Validate() { control.Validate(); }
    public string ReadNative() { return control.ReadText(); }
    public IFilenameValueAccessible Open() { return new FilenameValueAccessible(edit, deadline); }
    public void Dispose() { control.Dispose(); }
}

// InterfaceIsDual supplies IUnknown and IDispatch slots. PreserveSig keeps S_FALSE distinct.
[ComImport, Guid("618736e0-3c3d-11cf-810c-00aa00389b71"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
internal interface IFilenameAccessible
{
    [PreserveSig] int get_accParent([MarshalAs(UnmanagedType.IDispatch)] out object parent);
    [PreserveSig] int get_accChildCount(out int count);
    [PreserveSig] int get_accChild([MarshalAs(UnmanagedType.Struct)] object child, [MarshalAs(UnmanagedType.IDispatch)] out object value);
    [PreserveSig] int get_accName([MarshalAs(UnmanagedType.Struct)] object child, [MarshalAs(UnmanagedType.BStr)] out string value);
    [PreserveSig] int get_accValue([MarshalAs(UnmanagedType.Struct)] object child, [MarshalAs(UnmanagedType.BStr)] out string value);
    [PreserveSig] int get_accDescription([MarshalAs(UnmanagedType.Struct)] object child, [MarshalAs(UnmanagedType.BStr)] out string value);
    [PreserveSig] int get_accRole([MarshalAs(UnmanagedType.Struct)] object child, [MarshalAs(UnmanagedType.Struct)] out object value);
    [PreserveSig] int get_accState([MarshalAs(UnmanagedType.Struct)] object child, [MarshalAs(UnmanagedType.Struct)] out object value);
    [PreserveSig] int get_accHelp([MarshalAs(UnmanagedType.Struct)] object child, [MarshalAs(UnmanagedType.BStr)] out string value);
    [PreserveSig] int get_accHelpTopic([MarshalAs(UnmanagedType.BStr)] out string help, [MarshalAs(UnmanagedType.Struct)] object child, out int topic);
    [PreserveSig] int get_accKeyboardShortcut([MarshalAs(UnmanagedType.Struct)] object child, [MarshalAs(UnmanagedType.BStr)] out string value);
    [PreserveSig] int get_accFocus([MarshalAs(UnmanagedType.Struct)] out object value);
    [PreserveSig] int get_accSelection([MarshalAs(UnmanagedType.Struct)] out object value);
    [PreserveSig] int get_accDefaultAction([MarshalAs(UnmanagedType.Struct)] object child, [MarshalAs(UnmanagedType.BStr)] out string value);
    [PreserveSig] int accSelect(int flags, [MarshalAs(UnmanagedType.Struct)] object child);
    [PreserveSig] int accLocation(out int left, out int top, out int width, out int height, [MarshalAs(UnmanagedType.Struct)] object child);
    [PreserveSig] int accNavigate(int direction, [MarshalAs(UnmanagedType.Struct)] object start, [MarshalAs(UnmanagedType.Struct)] out object value);
    [PreserveSig] int accHitTest(int x, int y, [MarshalAs(UnmanagedType.Struct)] out object value);
    [PreserveSig] int accDoDefaultAction([MarshalAs(UnmanagedType.Struct)] object child);
    [PreserveSig] int put_accName([MarshalAs(UnmanagedType.Struct)] object child, [MarshalAs(UnmanagedType.BStr)] string value);
    [PreserveSig] int put_accValue([MarshalAs(UnmanagedType.Struct)] object child, [MarshalAs(UnmanagedType.BStr)] string value);
}

internal sealed class FilenameValueAccessible : IFilenameValueAccessible
{
    private IFilenameAccessible accessible;
    private readonly IntPtr edit;
    private readonly AIbrowseFilenameDeadline deadline;
    internal FilenameValueAccessible(IntPtr edit, AIbrowseFilenameDeadline deadline)
    {
        this.edit = edit; this.deadline = deadline;
        Guid iid = typeof(IFilenameAccessible).GUID;
        IntPtr pointer = IntPtr.Zero;
        try
        {
            deadline.Check();
            int result = AccessibleObjectFromWindow(edit, 0xfffffffc, ref iid, out pointer);
            deadline.Check();
            if (result != 0 || pointer == IntPtr.Zero) throw new InvalidOperationException("文件名MSAA对象获取失败");
            accessible = (IFilenameAccessible)Marshal.GetObjectForIUnknown(pointer);
            deadline.Check();
        }
        catch { Dispose(); throw; }
        finally { if (pointer != IntPtr.Zero) Marshal.Release(pointer); }
    }
    private void Success(int result)
    {
        deadline.Check();
        if (result != 0) throw new InvalidOperationException("文件名MSAA读取未返回S_OK");
    }
    public FilenameValueMetadata Read()
    {
        if (accessible == null) throw new InvalidOperationException("文件名MSAA对象已释放");
        string name, value; object role, state; IntPtr window;
        deadline.Check();
        Success(WindowFromAccessibleObject(accessible, out window));
        Success(accessible.get_accName(0, out name));
        Success(accessible.get_accValue(0, out value));
        Success(accessible.get_accRole(0, out role));
        Success(accessible.get_accState(0, out state));
        return new FilenameValueMetadata { HResult = 0, ExactWindow = window == edit, Name = name, Value = value, Role = role, State = state };
    }
    public int Put(string target)
    {
        if (accessible == null) throw new InvalidOperationException("文件名MSAA对象已释放");
        deadline.Check();
        int result = accessible.put_accValue(0, target);
        deadline.Check();
        return result;
    }
    public void Dispose()
    {
        if (accessible == null) return;
        try { if (Marshal.IsComObject(accessible)) Marshal.FinalReleaseComObject(accessible); }
        finally { accessible = null; }
    }
    [DllImport("oleacc.dll")] private static extern int AccessibleObjectFromWindow(IntPtr window, uint objectId, ref Guid iid, out IntPtr result);
    [DllImport("oleacc.dll")] private static extern int WindowFromAccessibleObject([MarshalAs(UnmanagedType.Interface)] IFilenameAccessible value, out IntPtr window);
}
