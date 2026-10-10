using System;
using System.Diagnostics;
using System.IO;

// The product Open dialog may start with an empty filename. The message pair and
// native identity checks are the same as the qualified, non-empty fixture path.
public sealed class AIbrowseProductFileSelection : IDisposable
{
    private readonly ISelectionEditPort port;
    private readonly bool open;
    private bool attempted, disposed;
    public int Selections { get; private set; }
    public int Replacements { get; private set; }

    internal AIbrowseProductFileSelection(ISelectionEditPort port, bool open)
    { this.port = port; this.open = open; }

    public AIbrowseProductFileSelection(uint pid, string created, string image,
        IntPtr owner, IntPtr dialog, IntPtr edit, AIbrowseSelectionDeadline deadline, bool open)
        : this(new SelectionEditPort(pid, created, image, owner, dialog, edit, deadline), open) { }

    private uint Timeout()
    {
        long elapsed = port.Elapsed;
        if (disposed || elapsed < 0 || elapsed >= 30000)
            throw new InvalidOperationException("产品文件选择期限已过或已释放");
        return (uint)Math.Min(1000, 30000 - elapsed);
    }
    public void Validate() { Timeout(); port.Validate(); Timeout(); }
    public string ReadText()
    {
        Validate(); string value = port.Read(); Validate();
        if (value == null || value.Length > 4096 || value.IndexOf('\0') >= 0)
            throw new InvalidOperationException("产品文件名读取无效");
        return value;
    }
    public void ReplaceOnce(string target, string initial)
    {
        if (attempted) throw new InvalidOperationException("产品文件选择不允许重发");
        attempted = true;
        if (String.IsNullOrEmpty(target) || target.Length > 4096 || target.IndexOf('\0') >= 0 ||
            !Path.IsPathFullyQualified(target) || Path.GetExtension(target) != ".aibak" ||
            initial == null || initial.Length > 4096 || initial.IndexOf('\0') >= 0 ||
            (!open && initial != "AIbrowse-backup.aibak" && initial != "AIbrowse-backup"))
            throw new InvalidOperationException("产品文件选择目标或初值无效");
        if (ReadText() != initial || ReadText() != initial)
            throw new InvalidOperationException("产品文件选择初值变化");
        Validate(); uint selectTimeout = Timeout(); Selections++; port.SelectAll(selectTimeout); Validate();
        uint replaceTimeout = Timeout(); Replacements++; port.Replace(target, replaceTimeout); Validate();
        if (ReadText() != target || ReadText() != target)
            throw new InvalidOperationException("产品文件选择目标完整双读失配");
    }
    public void Dispose() { if (disposed) return; disposed = true; port.Dispose(); }
}

// Cancel uses control ID 2 while preserving the same original caller deadline.
public sealed class AIbrowseProductFileCancel : IDisposable
{
    private readonly AIbrowseNativeSaveButton button;
    public AIbrowseProductFileCancel(uint pid, string created, string image,
        IntPtr owner, IntPtr dialog, IntPtr control, string name, AIbrowseSelectionDeadline deadline)
    {
        var port = new SelectionButtonClock(
            new Win32SaveButtonPort(pid, created, image, owner, dialog, control, 2, Stopwatch.StartNew()), deadline);
        button = new AIbrowseNativeSaveButton(port, 2, name);
    }
    public void Inspect() { button.Inspect(); }
    public void Act() { button.Act(); }
    public void Dispose() { button.Dispose(); }
}
