using System;
using System.Collections.Generic;

// Test objects implement the exact getters consumed by the real PS context
// validator. They create no AutomationElement or native window.
public sealed class RestoreContextNode
{
    public string Text, Class = "Button";
    public int Pid = 42, Handle = 11;
    public bool Enabled = true, Offscreen;
    public RestoreContextNode get_Current() { return this; }
    public string get_Name() { return Text; }
    public string get_ClassName() { return Class; }
    public int get_ProcessId() { return Pid; }
    public int get_NativeWindowHandle() { return Handle; }
    public bool get_IsEnabled() { return Enabled; }
    public bool get_IsOffscreen() { return Offscreen; }
}

public static class RestoreConfirmationPureTests
{
    private sealed class Port : IAIbrowseSaveButtonPort
    {
        internal long Time;
        internal int Calls, Reads, Releases, Contexts;
        internal bool Identity = true, ActThrows, ReleaseThrows, LateRead, LateAct, LateRelease, ContextThrows;
        internal SaveButtonMetadata Value = new SaveButtonMetadata {
            HResult = 0, Role = 43, State = 0, Name = "恢复并重新启动", DefaultAction = "推"
        };
        public long ElapsedMilliseconds { get { return Time; } }
        public bool IdentityMatches() { return Identity; }
        public IAIbrowseButtonAccessible OpenAccessible() { return new Accessible(this); }
        public void Dispose() { }
        internal void Context() { Contexts++; if (ContextThrows) throw new InvalidOperationException("固定反例"); }
        private sealed class Accessible : IAIbrowseButtonAccessible
        {
            private readonly Port port;
            internal Accessible(Port port) { this.port = port; }
            public SaveButtonMetadata Read() { port.Reads++; if (port.LateRead) port.Time = 30000; return port.Value; }
            public void Act() { port.Calls++; if (port.LateAct) port.Time = 30000; if (port.ActThrows) throw new InvalidOperationException("固定反例"); }
            public void Dispose() { port.Releases++; if (port.LateRelease) port.Time = 30000; if (port.ReleaseThrows) throw new InvalidOperationException("固定反例"); }
        }
    }
    private static void Reject(Action action)
    {
        bool rejected = false;
        try { action(); } catch { rejected = true; }
        if (!rejected) throw new InvalidOperationException("反例未拒绝");
    }
    private static void Require(bool value) { if (!value) throw new InvalidOperationException("固定断言失败"); }
    public static string[] Run()
    {
        var completed = new List<string>();
        Action<string, Action> check = (name, action) => { action(); completed.Add(name); };
        foreach (string purpose in new[] { "restore", "partial" }) {
            foreach (bool approve in new[] { true, false }) {
                check(purpose + (approve ? "批准一次" : "取消一次"), () => {
                    var port = new Port(); port.Value.Name = approve ? "恢复并重新启动" : "取消";
                    using (var action = new AIbrowseRestoreConfirmation(port, purpose, approve, 1000, port.Context)) {
                        var proof = action.Act();
                        Require(proof.purpose == purpose && proof.result == (approve ? "approved" : "cancelled") && proof.released);
                        Require(port.Calls == 1 && port.Reads == 2 && port.Releases == 1 && port.Contexts >= 4);
                        Reject(() => action.Act()); Require(port.Calls == 1);
                    }
                });
            }
        }
        check("未知目的先拒绝", () => { var port = new Port(); Reject(() => new AIbrowseRestoreConfirmation(port, "other", true, 1000, port.Context)); Require(port.Calls == 0); });
        check("更短余额到期零动作", () => { var port = new Port(); using (var action = new AIbrowseRestoreConfirmation(port, "restore", true, 1000, port.Context, 1)) { port.Time = 1; Reject(() => action.Act()); Require(port.Calls == 0); } });
        foreach (int id in new[] { -1, 0, 65536 }) {
            check("越界控件ID" + id, () => { var port = new Port(); Reject(() => new AIbrowseRestoreConfirmation(port, "restore", true, id, port.Context)); });
        }
        check("正文检查失败零动作", () => { var port = new Port(); using (var action = new AIbrowseRestoreConfirmation(port, "restore", true, 1000, port.Context)) { port.ContextThrows = true; Reject(() => action.Act()); Require(port.Calls == 0); } });
        check("原生身份漂移零动作", () => { var port = new Port(); using (var action = new AIbrowseRestoreConfirmation(port, "restore", true, 1000, port.Context)) { port.Identity = false; Reject(() => action.Act()); Require(port.Calls == 0); } });
        foreach (int mutation in new[] { 0, 1, 2, 3, 4, 5, 6, 7 }) {
            check("MSAA错误字段" + mutation, () => {
                var port = new Port();
                using (var action = new AIbrowseRestoreConfirmation(port, "restore", true, 1000, port.Context)) {
                    if (mutation == 0) port.Value.HResult = 1;
                    if (mutation == 1) port.Value.Role = 9;
                    if (mutation == 2) port.Value.State = 1;
                    if (mutation == 3) port.Value.State = 0x8000;
                    if (mutation == 4) port.Value.State = 0x10000;
                    if (mutation == 5) port.Value.State = -1;
                    if (mutation == 6) port.Value.Name = "取消";
                    if (mutation == 7) port.Value.DefaultAction = "";
                    Reject(() => action.Act()); Require(port.Calls == 0 && port.Releases == 1);
                }
            });
        }
        foreach (string late in new[] { "before", "read", "action", "release" }) {
            check("原期限迟到" + late, () => {
                var port = new Port();
                using (var action = new AIbrowseRestoreConfirmation(port, "restore", true, 1000, port.Context)) {
                    if (late == "before") port.Time = 30000;
                    if (late == "read") port.LateRead = true;
                    if (late == "action") port.LateAct = true;
                    if (late == "release") port.LateRelease = true;
                    Reject(() => action.Act());
                    Require(port.Calls == ((late == "action" || late == "release") ? 1 : 0));
                    Reject(() => action.Act()); Require(port.Calls <= 1);
                }
            });
        }
        foreach (bool release in new[] { true, false }) {
            check(release ? "释放失败无成功" : "COM失败无重发", () => {
                var port = new Port { ReleaseThrows = release, ActThrows = !release };
                using (var action = new AIbrowseRestoreConfirmation(port, "restore", true, 1000, port.Context)) {
                    Reject(() => action.Act()); Require(port.Calls == 1 && port.Releases == 1);
                    Reject(() => action.Act()); Require(port.Calls == 1);
                }
            });
        }
        return completed.ToArray();
    }
}
