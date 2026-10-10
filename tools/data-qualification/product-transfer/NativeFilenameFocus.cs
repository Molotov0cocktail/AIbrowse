using System;
using System.Runtime.InteropServices;

internal interface IFilenameFocusPort
{
    bool Matches(IntPtr expected);
}
internal interface IFilenameFocusDiagnosticPort
{
    FilenameFocusObservation Inspect(IntPtr expected);
}
public sealed class FilenameFocusObservation
{
    public bool Matched { get; private set; }
    public bool FocusRead { get; private set; }
    public string Judgment { get; private set; }
    public string Focus { get; private set; }
    internal FilenameFocusObservation(string judgment, string focus, bool read)
    { Matched=judgment=="matched"; Judgment=judgment; Focus=focus; FocusRead=read; }
}

// No global input, attachment or foreground activation is exposed by this port.
public sealed class AIbrowseNativeFilenameFocus
{
    private readonly IFilenameFocusPort port;
    private readonly AIbrowseFilenameDeadline deadline;
    private readonly IntPtr edit, save;
    private bool editAccepted, saveAccepted, editAttempted, saveAttempted;
    public AIbrowseNativeFilenameFocus(uint pid, IntPtr dialog, IntPtr edit, IntPtr save,
        AIbrowseFilenameDeadline deadline) : this(new FilenameFocusPort(pid, dialog, edit, save), edit, save, deadline) { }
    internal AIbrowseNativeFilenameFocus(IFilenameFocusPort port, IntPtr edit, IntPtr save,
        AIbrowseFilenameDeadline deadline)
    {
        if (port == null || deadline == null || edit == IntPtr.Zero || save == IntPtr.Zero || edit == save)
            throw new InvalidOperationException("焦点资格初始化无效");
        this.port = port; this.edit = edit; this.save = save; this.deadline = deadline;
        deadline.Check();
    }
    private void Check(IntPtr expected)
    {
        deadline.Check();
        if (!port.Matches(expected)) throw new InvalidOperationException("原生焦点窗口身份失配");
        deadline.Check();
    }
    public void AcceptEdit()
    {
        if (editAttempted || saveAttempted) throw new InvalidOperationException("文件名焦点资格不允许重发");
        editAttempted = true;
        Check(edit); editAccepted = true;
    }
    public void AssertEdit()
    {
        if (!editAccepted || saveAccepted) throw new InvalidOperationException("文件名焦点次序无效");
        Check(edit);
    }
    public void AcceptSave()
    {
        if (!editAccepted || saveAttempted) throw new InvalidOperationException("保存焦点次序无效");
        saveAttempted = true;
        Check(save); saveAccepted = true;
    }
    public void AssertSave()
    {
        if (!saveAccepted) throw new InvalidOperationException("保存焦点尚未确认");
        Check(save);
    }
    public FilenameFocusObservation InspectEditDiagnostic()
    {
        if (editAttempted || saveAttempted) throw new InvalidOperationException("诊断焦点读取不允许重发");
        editAttempted=true; deadline.Check();
        var diagnostic=port as IFilenameFocusDiagnosticPort;
        if(diagnostic==null)throw new InvalidOperationException("诊断焦点端口不可用");
        var result=diagnostic.Inspect(edit);
        deadline.Check();
        return result;
    }
    public static string ClassifyException(Exception error)
    {
        // Unwrap only known invocation wrappers. Never return arbitrary type names,
        // exception messages, COM text, stack traces or inner exception objects.
        for(int i=0;i<4 && error!=null;i++) {
            string type=error.GetType().FullName;
            if(type=="System.Management.Automation.MethodInvocationException" || type=="System.Reflection.TargetInvocationException") { error=error.InnerException; continue; }
            if(type=="System.Windows.Automation.ElementNotAvailableException")return "element-unavailable";
            if(type=="System.Windows.Automation.ElementNotEnabledException")return "element-disabled";
            if(type=="System.InvalidOperationException")return "invalid-operation";
            if(type=="System.Runtime.InteropServices.COMException")return "com";
            if(type=="System.TimeoutException")return "timeout";
            if(type=="System.UnauthorizedAccessException")return "access-denied";
            if(type=="System.ArgumentException")return "argument";
            return "other";
        }
        return "other";
    }
}

internal sealed class FilenameFocusPort : IFilenameFocusPort, IFilenameFocusDiagnosticPort
{
    private readonly uint pid;
    private readonly IntPtr dialog, edit, save;
    internal FilenameFocusPort(uint pid, IntPtr dialog, IntPtr edit, IntPtr save)
    { this.pid = pid; this.dialog = dialog; this.edit = edit; this.save = save; }
    public bool Matches(IntPtr expected)
    { return Inspect(expected).Matched; }
    private static FilenameFocusObservation Missing(string judgment)
    { return new FilenameFocusObservation(judgment,"none",false); }
    public FilenameFocusObservation Inspect(IntPtr expected)
    {
        if(pid==0 || dialog==IntPtr.Zero || (expected!=edit && expected!=save))return Missing("target-invalid");
        if(!IsWindow(expected))return Missing("window-missing");
        if(!IsWindowVisible(expected))return Missing("window-hidden");
        if(!IsWindowEnabled(expected))return Missing("window-disabled");
        if(GetAncestor(expected,2)!=dialog)return Missing("root-mismatch");
        uint owner, dialogOwner;
        uint thread = GetWindowThreadProcessId(expected, out owner);
        uint dialogThread = GetWindowThreadProcessId(dialog, out dialogOwner);
        if(thread==0 || thread!=dialogThread)return Missing("thread-mismatch");
        if(owner!=pid || dialogOwner!=pid)return Missing("owner-mismatch");
        var info = new GuiThreadInfo { Size = (uint)Marshal.SizeOf(typeof(GuiThreadInfo)) };
        if(info.Size!=72)return Missing("layout-unsupported");
        if(!GetGUIThreadInfo(thread,ref info))return Missing("gui-query-failed");
        return Project(info.Active,info.Focus,expected,dialog,edit,save);
    }
    internal static FilenameFocusObservation Project(IntPtr active,IntPtr focused,IntPtr expected,IntPtr dialog,IntPtr edit,IntPtr save)
    {
        string focus=focused==IntPtr.Zero?"none":focused==edit?"edit":focused==save?"save":focused==dialog?"dialog":"other";
        return new FilenameFocusObservation(active!=dialog?"active-mismatch":focused!=expected?"focus-mismatch":"matched",focus,true);
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct GuiThreadInfo
    {
        internal uint Size, Flags;
        internal IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        internal int Left, Top, Right, Bottom;
    }
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
}
