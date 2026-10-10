using System;
using System.Collections.Generic;

internal sealed class ProductSelectionFake : ISelectionEditPort
{
    public long Clock;
    public bool Identity = true, Partial, ThrowSelect, ThrowReplace, Closed;
    public long ReadAdvance, SelectAdvance, ReplaceAdvance;
    public string Text = "";
    public int Selected, Replaced;
    public uint SelectTimeout, ReplaceTimeout;
    public long Elapsed { get { return Clock; } }
    public void Validate() { if (!Identity || Closed) throw new InvalidOperationException(); }
    public string Read() { Clock += ReadAdvance; return Text; }
    public void SelectAll(uint timeout)
    {
        Selected++; SelectTimeout = timeout; Clock += SelectAdvance;
        if (ThrowSelect) throw new InvalidOperationException();
    }
    public void Replace(string target, uint timeout)
    {
        Replaced++; ReplaceTimeout = timeout; Clock += ReplaceAdvance;
        if (ThrowReplace) throw new InvalidOperationException();
        Text = Partial ? target + "残留" : target;
    }
    public void Dispose() { Closed = true; }
}

public static class ProductFileSelectionPureTests
{
    private const string Target = @"D:\AIbrowse\log\固定\product-A.aibak";
    private static bool Reject(Action action) { try { action(); return false; } catch { return true; } }
    public static string[] Run()
    {
        var results = new List<string>();
        Action<string, bool> check = (name, ok) => { if (!ok) throw new InvalidOperationException(name); results.Add(name); };
        var old = new ProductSelectionFake();
        using (var previous = new AIbrowseSelectionEdit(old))
            check("旧非空夹具路径拒绝空Open初值，形成可甄别对照", Reject(() => previous.ReplaceOnce(Target, "")) && old.Selected == 0);
        foreach (string initial in new[] { "", "AIbrowse-backup.aibak", "固定旧初值" })
        {
            var port = new ProductSelectionFake { Text = initial };
            using (var edit = new AIbrowseProductFileSelection(port, true))
            {
                edit.ReplaceOnce(Target, initial);
                check("Open有界稳定初值一次选择替换", port.Selected == 1 && port.Replaced == 1 && port.Text == Target);
                check("Open动作不重发", Reject(() => edit.ReplaceOnce(Target, Target)) && port.Selected == 1);
            }
            check("Open端口释放", port.Closed);
        }
        foreach (string initial in new[] { "AIbrowse-backup.aibak", "AIbrowse-backup" })
        {
            var port = new ProductSelectionFake { Text = initial };
            using (var edit = new AIbrowseProductFileSelection(port, false)) edit.ReplaceOnce(Target, initial);
            check("Save原默认名及stem保持", port.Selected == 1 && port.Replaced == 1);
        }
        foreach (string initial in new[] { "", "任意", "错误\0初值" })
        {
            var port = new ProductSelectionFake { Text = initial };
            using (var edit = new AIbrowseProductFileSelection(port, false))
                check("Save越界初值零动作", Reject(() => edit.ReplaceOnce(Target, initial)) && port.Selected == 0);
        }
        foreach (string target in new[] { "", "relative.aibak", @"D:\fixed.txt", "D:\\fixed\0.aibak", new string('x', 4097) })
        {
            var port = new ProductSelectionFake();
            using (var edit = new AIbrowseProductFileSelection(port, true))
                check("目标越界零动作", Reject(() => edit.ReplaceOnce(target, "")) && port.Selected == 0);
        }
        Action<string, ProductSelectionFake, int, int> failure = (name, port, selections, replacements) => {
            using (var edit = new AIbrowseProductFileSelection(port, true))
            {
                check(name, Reject(() => edit.ReplaceOnce(Target, "")) && port.Selected == selections && port.Replaced == replacements);
                check("失败已消费且不重发", Reject(() => edit.ReplaceOnce(Target, "")) && port.Selected == selections && port.Replaced == replacements);
            }
        };
        failure("身份错误零动作", new ProductSelectionFake { Identity = false }, 0, 0);
        failure("开始前超时零动作", new ProductSelectionFake { Clock = 30000 }, 0, 0);
        failure("初值读取跨期零动作", new ProductSelectionFake { ReadAdvance = 30000 }, 0, 0);
        failure("初值不一致零动作", new ProductSelectionFake { Text = "changed" }, 0, 0);
        failure("选择异常不替换", new ProductSelectionFake { ThrowSelect = true }, 1, 0);
        failure("选择后跨期不替换", new ProductSelectionFake { SelectAdvance = 30000 }, 1, 0);
        failure("替换异常不重发", new ProductSelectionFake { ThrowReplace = true }, 1, 1);
        failure("替换后跨期拒绝", new ProductSelectionFake { ReplaceAdvance = 30000 }, 1, 1);
        failure("部分替换拒绝", new ProductSelectionFake { Partial = true }, 1, 1);
        var shortPort = new ProductSelectionFake { Clock = 29750 };
        using (var edit = new AIbrowseProductFileSelection(shortPort, true)) edit.ReplaceOnce(Target, "");
        check("消息超时取原剩额", shortPort.SelectTimeout == 250 && shortPort.ReplaceTimeout == 250);
        var closedPort = new ProductSelectionFake();
        var closed = new AIbrowseProductFileSelection(closedPort, true); closed.Dispose(); closed.Dispose();
        check("释放后无动作且幂等", Reject(() => closed.ReplaceOnce(Target, "")) && closedPort.Selected == 0 && closedPort.Closed);
        return results.ToArray();
    }
}
