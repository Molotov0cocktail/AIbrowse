using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public sealed class AIbrowseSelectionDeadline
{
    private readonly long started;
    public AIbrowseSelectionDeadline(long started, long frequency)
    {
        if (frequency != Stopwatch.Frequency || started <= 0 || started > Stopwatch.GetTimestamp())
            throw new InvalidOperationException("原生选择时钟身份无效");
        this.started = started; Check();
    }
    public long Elapsed { get { return (long)((decimal)(Stopwatch.GetTimestamp() - started) * 1000 / Stopwatch.Frequency); } }
    public void Check() { if (Elapsed < 0 || Elapsed >= 30000) throw new InvalidOperationException("原生选择原期限已过"); }
}

internal interface ISelectionEditPort : IDisposable
{
    long Elapsed { get; }
    void Validate();
    string Read();
    void SelectAll(uint timeout);
    void Replace(string target, uint timeout);
}

// Every action uses the fixture clock. A failed attempt is permanently consumed.
public sealed class AIbrowseSelectionEdit : IDisposable
{
    private readonly ISelectionEditPort port;
    private bool attempted, disposed;
    public int Selections { get; private set; }
    public int Replacements { get; private set; }
    internal AIbrowseSelectionEdit(ISelectionEditPort port) { this.port = port; }
    public AIbrowseSelectionEdit(uint pid, string created, string image, IntPtr owner, IntPtr dialog, IntPtr edit, AIbrowseSelectionDeadline deadline)
        : this(new SelectionEditPort(pid, created, image, owner, dialog, edit, deadline)) { }
    private uint Timeout()
    {
        long elapsed = port.Elapsed;
        if (disposed || elapsed < 0 || elapsed >= 30000) throw new InvalidOperationException("选择编辑超过原期限或已释放");
        return (uint)Math.Min(1000, 30000 - elapsed);
    }
    public void Validate() { Timeout(); port.Validate(); Timeout(); }
    public string ReadText() { Validate(); string text = port.Read(); Validate(); return text; }
    public void ReplaceOnce(string target, string initial)
    {
        if (attempted) throw new InvalidOperationException("选择编辑不允许重发");
        attempted = true;
        if (String.IsNullOrEmpty(target) || target.Length > 4096 || target.IndexOf('\0') >= 0 ||
            !Path.IsPathFullyQualified(target) || Path.GetExtension(target) != ".aibak" ||
            String.IsNullOrEmpty(initial) || initial.Length > 4096 || initial.IndexOf('\0') >= 0)
            throw new InvalidOperationException("选择编辑路径或初值无效");
        if (ReadText() != initial || ReadText() != initial) throw new InvalidOperationException("选择编辑初值变化");
        Validate(); uint selectionTimeout = Timeout(); Selections++; port.SelectAll(selectionTimeout); Validate();
        uint replacementTimeout = Timeout(); Replacements++; port.Replace(target, replacementTimeout); Validate();
        if (ReadText() != target || ReadText() != target) throw new InvalidOperationException("选择编辑完整双读不符");
    }
    public void Dispose() { if (disposed) return; disposed = true; port.Dispose(); }
}

internal sealed class SelectionControlClock : IAIbrowseSaveControlPort
{
    private readonly IAIbrowseSaveControlPort inner;
    private readonly AIbrowseSelectionDeadline deadline;
    internal SelectionControlClock(IAIbrowseSaveControlPort inner, AIbrowseSelectionDeadline deadline) { this.inner = inner; this.deadline = deadline; }
    public long ElapsedMilliseconds { get { return deadline.Elapsed; } }
    public bool IdentityMatches() { deadline.Check(); bool result = inner.IdentityMatches(); deadline.Check(); return result; }
    public ulong ReadLength(uint timeout) { deadline.Check(); ulong result = inner.ReadLength(timeout); deadline.Check(); return result; }
    public string ReadText(uint timeout) { deadline.Check(); string result = inner.ReadText(timeout); deadline.Check(); return result; }
    public bool WriteTarget(string text, uint timeout) { throw new InvalidOperationException("该路径禁止旧写入原语"); }
    public void Dispose() { inner.Dispose(); }
}
internal sealed class SelectionEditPort : ISelectionEditPort
{
    private readonly AIbrowseNativeSaveControl control;
    private readonly AIbrowseSelectionDeadline deadline;
    private readonly IntPtr edit;
    private readonly ISelectionMessages messages;
    internal SelectionEditPort(uint pid, string created, string image, IntPtr owner, IntPtr dialog, IntPtr edit, AIbrowseSelectionDeadline deadline)
    {
        this.deadline = deadline; this.edit = edit; this.messages = new SelectionMessages();
        control = new AIbrowseNativeSaveControl(new SelectionControlClock(new Win32SaveControlPort(pid, created, image, owner, dialog, edit, Stopwatch.StartNew()), deadline));
    }
    internal SelectionEditPort(AIbrowseNativeSaveControl control, AIbrowseSelectionDeadline deadline, IntPtr edit, ISelectionMessages messages)
    { this.control = control; this.deadline = deadline; this.edit = edit; this.messages = messages; }
    public long Elapsed { get { return deadline.Elapsed; } }
    public void Validate() { deadline.Check(); control.Validate(); deadline.Check(); }
    public string Read() { return control.ReadText(); }
    // The API return only proves message delivery. lpdwResult is not a business result.
    public void SelectAll(uint timeout)
    {
        if (!messages.Select(edit, 0x00b1, UIntPtr.Zero, new IntPtr(-1), 0x23, timeout))
            throw new InvalidOperationException("选择消息失败或超时");
    }
    public void Replace(string target, uint timeout)
    {
        if (!messages.Replace(edit, 0x00c2, UIntPtr.Zero, target, 0x23, timeout))
            throw new InvalidOperationException("替换消息失败或超时");
    }
    public void Dispose() { control.Dispose(); }
}
internal interface ISelectionMessages
{
    bool Select(IntPtr edit, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout);
    bool Replace(IntPtr edit, uint message, UIntPtr wParam, string text, uint flags, uint timeout);
}
internal sealed class SelectionMessages : ISelectionMessages
{
    public bool Select(IntPtr edit, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout)
    { UIntPtr ignored; return SendMessageTimeoutW(edit, message, wParam, lParam, flags, timeout, out ignored) != IntPtr.Zero; }
    public bool Replace(IntPtr edit, uint message, UIntPtr wParam, string text, uint flags, uint timeout)
    { UIntPtr ignored; return SendMessageTimeoutTextW(edit, message, wParam, text, flags, timeout, out ignored) != IntPtr.Zero; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr SendMessageTimeoutTextW(IntPtr window, uint message, UIntPtr wParam, string value, uint flags, uint timeout, out UIntPtr result);
}

internal sealed class SelectionButtonClock : IAIbrowseSaveButtonPort
{
    private readonly IAIbrowseSaveButtonPort inner;
    private readonly AIbrowseSelectionDeadline deadline;
    internal SelectionButtonClock(IAIbrowseSaveButtonPort inner, AIbrowseSelectionDeadline deadline) { this.inner = inner; this.deadline = deadline; }
    public long ElapsedMilliseconds { get { return deadline.Elapsed; } }
    public bool IdentityMatches() { deadline.Check(); bool value = inner.IdentityMatches(); deadline.Check(); return value; }
    public IAIbrowseButtonAccessible OpenAccessible()
    {
        deadline.Check(); IAIbrowseButtonAccessible value = inner.OpenAccessible();
        try { deadline.Check(); return value; } catch { value.Dispose(); throw; }
    }
    public void Dispose() { inner.Dispose(); }
}

// Open has a separate closed policy; the audited Save policy remains unchanged.
public sealed class AIbrowseSelectionButton : IDisposable
{
    private readonly IAIbrowseSaveButtonPort port;
    private readonly AIbrowseNativeSaveButton save;
    private readonly string name;
    private bool attempted, disposed;
    public static bool IsOpenName(string value) { return Array.IndexOf(new[] { "打开", "打开(O)", "打开(&O)", "Open", "&Open" }, value) >= 0; }
    internal AIbrowseSelectionButton(IAIbrowseSaveButtonPort port, string name, bool open)
    {
        this.port = port; this.name = name;
        try { if (open) { if (!IsOpenName(name)) throw new InvalidOperationException("打开按钮名称不符"); Validate(); }
            else save = new AIbrowseNativeSaveButton(port, 1, name);
        } catch { port.Dispose(); throw; }
    }
    public AIbrowseSelectionButton(uint pid, string created, string image, IntPtr owner, IntPtr dialog, IntPtr button, string name, bool open, AIbrowseSelectionDeadline deadline)
        : this(new SelectionButtonClock(new Win32SaveButtonPort(pid, created, image, owner, dialog, button, 1, Stopwatch.StartNew()), deadline), name, open) { }
    private void Time() { if (disposed || port.ElapsedMilliseconds < 0 || port.ElapsedMilliseconds >= 30000) throw new InvalidOperationException("按钮期限已过"); }
    public void Validate() { Time(); if (!port.IdentityMatches()) throw new InvalidOperationException("按钮身份变化"); Time(); }
    private void Read(IAIbrowseButtonAccessible accessible)
    {
        Validate(); SaveButtonMetadata value = accessible.Read(); Validate();
        if (value == null || value.HResult != 0 || value.Role != 43 || value.State < 0 ||
            (value.State & (1 | 0x8000 | 0x10000)) != 0 || value.Name != name ||
            String.IsNullOrEmpty(value.DefaultAction))
            throw new InvalidOperationException("打开按钮MSAA资格不符");
    }
    public void Inspect() { if (save != null) { save.Inspect(); return; } Validate(); using (var value = port.OpenAccessible()) { Read(value); } }
    public void Act()
    {
        if (attempted) throw new InvalidOperationException("按钮不允许重发"); attempted = true;
        if (save != null) { save.Act(); return; }
        Validate(); using (var value = port.OpenAccessible()) { Read(value); Read(value); Validate(); value.Act(); Time(); }
    }
    public void Dispose() { if (disposed) return; disposed = true; if (save != null) save.Dispose(); else port.Dispose(); }
}

internal sealed class OpenStructureNode
{
    internal string ClassName;
    internal int ControlId;
    internal bool Enabled, Visible;
}
internal interface IOpenStructurePort : IDisposable
{
    IntPtr Dialog { get; }
    void Check();
    OpenStructureNode Read(IntPtr window);
    IntPtr Child(IntPtr window);
    IntPtr Next(IntPtr window);
    IntPtr Parent(IntPtr window);
}

// This projection has no edit, selection, focus, or button action capability.
public static class AIbrowseOpenStructure
{
    internal static string ClassifyClass(string value)
    {
        switch (value) {
            case "#32770": return "dialog";
            case "Edit": return "edit";
            case "ComboBox": return "combo-box";
            case "ComboBoxEx32": return "combo-box-ex32";
            case "DirectUIHWND": return "direct-ui";
            case "DUIViewWndClassName": return "dui-view";
            case "FileNameControlHost": return "file-name-control-host";
            default: return "other";
        }
    }
    internal static string ClassifyId(int value)
    {
        switch (value) { case 1001: return "id-1001"; case 1148: return "id-1148"; case 1149: return "id-1149"; default: return "other"; }
    }
    private static Dictionary<string,object> Project(OpenStructureNode node, bool root)
    {
        return new Dictionary<string,object> {
            {"windowClass",ClassifyClass(node.ClassName)}, {"controlId",ClassifyId(node.ControlId)},
            {"enabled",node.Enabled}, {"visible",node.Visible}, {"sameProcess",true},
            {"isChildDialog",!root}, {"rootIsDialog",true}
        };
    }
    internal static Dictionary<string,object> Observe(IOpenStructurePort port)
    {
        port.Check();
        var records = new List<IntPtr> { port.Dialog };
        var seen = new HashSet<IntPtr> { port.Dialog };
        var candidates = new List<Dictionary<string,object>>();
        for (int i = 0; i < records.Count; i++) {
            port.Check(); IntPtr child = port.Child(records[i]); port.Check();
            while (child != IntPtr.Zero) {
                port.Check();
                if (records.Count >= 512 || !seen.Add(child)) throw new InvalidOperationException("原生观察树超限或重复");
                records.Add(child);
                OpenStructureNode node = port.Read(child); port.Check();
                string kind = ClassifyClass(node.ClassName);
                if (kind == "edit" || kind == "combo-box" || kind == "combo-box-ex32") {
                    if (candidates.Count >= 16) throw new InvalidOperationException("原生观察候选超限");
                    var chain = new List<Dictionary<string,object>>();
                    var parents = new HashSet<IntPtr> { child };
                    IntPtr parent = port.Parent(child); port.Check();
                    while (parent != port.Dialog) {
                        if (parent == IntPtr.Zero || chain.Count >= 7 || !parents.Add(parent))
                            throw new InvalidOperationException("原生观察父链失配或超限");
                        port.Check(); chain.Add(Project(port.Read(parent),false)); port.Check();
                        parent = port.Parent(parent); port.Check();
                    }
                    port.Check(); chain.Add(Project(port.Read(port.Dialog),true)); port.Check();
                    var projection = Project(node,false); projection.Add("parents",chain.ToArray());
                    candidates.Add(projection);
                }
                child = port.Next(child); port.Check();
            }
        }
        port.Check();
        return new Dictionary<string,object> { {"nativeNodes",records.Count}, {"candidates",candidates.ToArray()} };
    }
    public static Dictionary<string,object> Observe(uint pid,string created,string image,IntPtr owner,IntPtr dialog,AIbrowseSelectionDeadline deadline)
    {
        using (var port = new Win32OpenStructurePort(pid,created,image,owner,dialog,deadline)) return Observe(port);
    }
}

internal sealed class Win32OpenStructurePort : IOpenStructurePort
{
    private readonly uint pid;
    private readonly long created;
    private readonly string image;
    private readonly IntPtr owner, dialog;
    private readonly AIbrowseSelectionDeadline deadline;
    private readonly Process process;
    public IntPtr Dialog { get { return dialog; } }
    internal Win32OpenStructurePort(uint pid,string created,string image,IntPtr owner,IntPtr dialog,AIbrowseSelectionDeadline deadline)
    {
        this.pid=pid; this.created=long.Parse(created); this.image=image; this.owner=owner; this.dialog=dialog; this.deadline=deadline;
        process=Process.GetProcessById((int)pid);
        try { IntPtr held=process.Handle; Check(); } catch { process.Dispose(); throw; }
    }
    public void Check()
    {
        deadline.Check();
        if (process.HasExited || process.StartTime.ToUniversalTime().ToFileTimeUtc()!=created ||
            !String.Equals(process.MainModule.FileName,image,StringComparison.OrdinalIgnoreCase) ||
            owner==IntPtr.Zero || dialog==IntPtr.Zero || owner==dialog || !SameProcess(owner) || !SameProcess(dialog) ||
            GetWindow(dialog,4)!=owner || Class(dialog)!="#32770") throw new InvalidOperationException("原生观察精确身份失配");
        deadline.Check();
    }
    private bool SameProcess(IntPtr window) { uint actual; return IsWindow(window) && GetWindowThreadProcessId(window,out actual)!=0 && actual==pid; }
    private static string Class(IntPtr window)
    {
        var value=new StringBuilder(256); int length=GetClassNameW(window,value,value.Capacity);
        if (length<=0 || length>=255) throw new InvalidOperationException("原生观察类型读取失败");
        return value.ToString();
    }
    private void Validate(IntPtr window)
    {
        Check();
        if (!SameProcess(window) || (window!=dialog && (!IsChild(dialog,window) || GetAncestor(window,2)!=dialog)))
            throw new InvalidOperationException("原生观察节点脱离固定对话框");
        deadline.Check();
    }
    public OpenStructureNode Read(IntPtr window)
    {
        Validate(window);
        var result=new OpenStructureNode {ClassName=Class(window),ControlId=GetDlgCtrlID(window),Enabled=IsWindowEnabled(window),Visible=IsWindowVisible(window)};
        Validate(window);return result;
    }
    public IntPtr Child(IntPtr window) { Validate(window);IntPtr value=GetWindow(window,5);Validate(window);return value; }
    public IntPtr Next(IntPtr window) { Validate(window);IntPtr value=GetWindow(window,2);Validate(window);return value; }
    public IntPtr Parent(IntPtr window) { Validate(window);IntPtr value=GetParent(window);Validate(window);return value; }
    public void Dispose() {process.Dispose();}
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window,uint kind);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window,uint kind);
    [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent,IntPtr child);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] private static extern int GetClassNameW(IntPtr window,StringBuilder name,int count);
}
