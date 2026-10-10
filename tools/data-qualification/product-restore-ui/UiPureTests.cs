// In-memory UIA read boundary for the actual PowerShell selection predicates.
public sealed class RestoreUiPureNode
{
    public string Name = "打开", Id = "1", Class = "Button";
    public int Pid = 42, Handle = 20;
    public bool Enabled = true, Offscreen;
    public RestoreUiPureNode First, Next;
    public RestoreUiPureNode get_Current() { return this; }
    public string get_Name() { return Name; }
    public string get_AutomationId() { return Id; }
    public string get_ClassName() { return Class; }
    public int get_ProcessId() { return Pid; }
    public int get_NativeWindowHandle() { return Handle; }
    public bool get_IsEnabled() { return Enabled; }
    public bool get_IsOffscreen() { return Offscreen; }
}

public sealed class RestoreUiPureWalker
{
    public RestoreUiPureNode GetFirstChild(RestoreUiPureNode node) { return node.First; }
    public RestoreUiPureNode GetNextSibling(RestoreUiPureNode node) { return node.Next; }
}
