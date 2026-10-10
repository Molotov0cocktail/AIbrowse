using System;
using System.Collections.Generic;
using System.Diagnostics;
using AIbrowse.SelectionQualification;

internal sealed class EditTestPort : ISelectionEditPort
{
    internal string Text = "AIbrowse-backup", Fault = "";
    internal long Time;
    internal int Selected, Replaced, Reads, Validations, Disposed;
    internal List<uint> Timeouts = new List<uint>();
    public long Elapsed { get { return Time; } }
    public void Validate() { Validations++; if (Fault == "readonly" || Fault == "handle-drift" && Selected > 0) throw new InvalidOperationException(); }
    public string Read() { Reads++; if (Fault == "read-late") Time = 30000; return Text; }
    public void SelectAll(uint timeout) { Selected++; Timeouts.Add(timeout); if (Fault == "select-timeout") throw new InvalidOperationException(); if (Fault == "select-late") Time = 30000; if (Fault == "remaining") Time = 29995; }
    public void Replace(string target, uint timeout) { Replaced++; Timeouts.Add(timeout); Text = Fault == "partial" ? Text + target : target; if (Fault == "replace-late") Time = 30000; if (Fault == "replace-timeout") throw new InvalidOperationException(); }
    public void Dispose() { Disposed++; }
}
internal sealed class NativeReadTestPort : IAIbrowseSaveControlPort
{
    internal string Text = "AIbrowse-backup";
    internal bool Identity = true;
    internal List<uint> Timeouts = new List<uint>();
    public long ElapsedMilliseconds { get { return 0; } }
    public bool IdentityMatches() { return Identity; }
    public ulong ReadLength(uint timeout) { Timeouts.Add(timeout); return (ulong)Text.Length; }
    public string ReadText(uint timeout) { Timeouts.Add(timeout); return Text; }
    public bool WriteTarget(string text, uint timeout) { Text = text; return true; }
    public void Dispose() { }
}
internal sealed class MessageTestPort : ISelectionMessages
{
    internal NativeReadTestPort Read;
    internal bool Success = true;
    internal int Selections, Replacements;
    public bool Select(IntPtr edit, uint message, UIntPtr wp, IntPtr lp, uint flags, uint timeout)
    { Selections++; SelectionPureTests.Require(edit.ToInt64() == 123 && message == 0xb1 && wp == UIntPtr.Zero && lp.ToInt64() == -1 && flags == 0x23 && timeout > 0 && timeout <= 1000); return Success; }
    public bool Replace(IntPtr edit, uint message, UIntPtr wp, string value, uint flags, uint timeout)
    { Replacements++; SelectionPureTests.Require(Selections == 1 && edit.ToInt64() == 123 && message == 0xc2 && wp == UIntPtr.Zero && flags == 0x23 && timeout > 0 && timeout <= 1000); Read.Text = value; return Success; }
}
internal sealed class ButtonTestPort : IAIbrowseSaveButtonPort, IAIbrowseButtonAccessible
{
    internal string Name = "打开", Action = "按下";
    internal int Role = 43, State, Actions, Releases;
    internal long Time;
    public long ElapsedMilliseconds { get { return Time; } }
    public bool IdentityMatches() { return true; }
    public IAIbrowseButtonAccessible OpenAccessible() { return this; }
    public SaveButtonMetadata Read() { return new SaveButtonMetadata { HResult = 0, Name = Name, DefaultAction = Action, Role = Role, State = State }; }
    public void Act() { Actions++; }
    public void Dispose() { Releases++; }
}
public sealed class SelectionTestResult { public string Name; public bool Pass; }
public static class SelectionPureTests
{
    private static readonly string Target = @"C:\AIbrowse-fixed\product-backup.aibak";
    private static readonly List<SelectionTestResult> results = new List<SelectionTestResult>();
    public static void Require(bool value) { if (!value) throw new InvalidOperationException("测试断言失败"); }
    private static void Reject(Action action) { bool rejected = false; try { action(); } catch { rejected = true; } Require(rejected); }
    private static void Test(string name, Action action) { try { action(); results.Add(new SelectionTestResult { Name = name, Pass = true }); } catch { results.Add(new SelectionTestResult { Name = name, Pass = false }); } }
    private static Dictionary<string, object> Tool(string scenario)
    { return new Dictionary<string, object> { {"version",1},{"scenario",scenario},{"purpose","selection-qualification"},{"ok",true},{"editTarget",true},{"writes",1},{"saveActions",1},{"selections",1},{"replacements",1},{"elapsedMs",100},{"buttonQualified",true},{"failure","none"} }; }
    private static Dictionary<string, object> Fixture(string scenario)
    { return new Dictionary<string, object> { {"version",1},{"scenario",scenario},{"ok",true},{"elapsedMs",100},{"events",1},{"showResult",0},{"unadvised",true},{"released",true},{"cancelled",false},{"options",scenario=="open"?0x2001840:0x2010040},{"eventClass","exact-target"},{"finalClass","exact-target"},{"textClass","exact-target"},{"failure","none"} }; }
    public static SelectionTestResult[] RunRepair()
    {
        results.Clear();
        Test("O1严格非空本地化动作",delegate{var p=new ButtonTestPort{Action="推"};using(var b=new AIbrowseSelectionButton(p,"打开",true)){b.Inspect();b.Act();Require(p.Actions==1);Reject(delegate{b.Act();});Require(p.Actions==1);}});
        foreach(string fault in new[]{"role","state","empty","null","name","time"})
        {
            string f=fault;
            Test("O1边界保持-"+f,delegate{var p=new ButtonTestPort();if(f=="role")p.Role=42;if(f=="state")p.State=1;if(f=="empty")p.Action="";if(f=="null")p.Action=null;if(f=="name")p.Name="保存";if(f=="time")p.Time=30000;Reject(delegate{using(var b=new AIbrowseSelectionButton(p,"打开",true))b.Act();});Require(p.Actions==0);});
        }
        Test("O1保存白名单不扩大",delegate{Reject(delegate{new AIbrowseNativeSaveButton(new ButtonTestPort(),1,"打开");});});
        return results.ToArray();
    }
    public static SelectionTestResult[] Run()
    {
        results.Clear();
        Test("旧文本写入成功不能授最终路径", delegate { var p=new NativeReadTestPort(); using(var old=new AIbrowseNativeSaveControl(p)){old.WriteTarget(Target); Require(old.ReadText()==Target);} var f=Fixture("save"); f["eventClass"]="exact-default"; f["finalClass"]="exact-default"; Reject(delegate{ReceiptGate.Validate(Tool("save"),f,"save");}); });
        Test("两条真实端口消息参数及顺序", delegate { var p=new NativeReadTestPort(); var deadline=new AIbrowseSelectionDeadline(Stopwatch.GetTimestamp(),Stopwatch.Frequency); var messages=new MessageTestPort{Read=p}; using(var edit=new AIbrowseSelectionEdit(new SelectionEditPort(new AIbrowseNativeSaveControl(new SelectionControlClock(p,deadline)),deadline,new IntPtr(123),messages))){edit.ReplaceOnce(Target,p.Text); Require(messages.Selections==1&&messages.Replacements==1&&p.Text==Target); Reject(delegate{edit.ReplaceOnce(Target,"AIbrowse-backup");});} });
        Test("真实消息发送失败零第二条", delegate { var p=new NativeReadTestPort(); var d=new AIbrowseSelectionDeadline(Stopwatch.GetTimestamp(),Stopwatch.Frequency); var m=new MessageTestPort{Read=p,Success=false}; using(var e=new AIbrowseSelectionEdit(new SelectionEditPort(new AIbrowseNativeSaveControl(new SelectionControlClock(p,d)),d,new IntPtr(123),m))){Reject(delegate{e.ReplaceOnce(Target,p.Text);}); Require(m.Selections==1&&m.Replacements==0);} });
        foreach(string fault in new[]{"readonly","handle-drift","select-timeout","select-late","read-late","replace-late","replace-timeout","partial"})
        { string captured=fault; Test("编辑拒绝-"+fault,delegate{var p=new EditTestPort{Fault=captured}; using(var e=new AIbrowseSelectionEdit(p)){Reject(delegate{e.ReplaceOnce(Target,"AIbrowse-backup");}); int first=p.Selected, second=p.Replaced; Reject(delegate{e.ReplaceOnce(Target,"AIbrowse-backup");}); Require(p.Selected==first&&p.Replaced==second); if(captured=="readonly"||captured=="read-late")Require(first==0&&second==0); if(captured=="handle-drift"||captured.StartsWith("select-"))Require(first==1&&second==0);}}); }
        Test("剩余5毫秒不重置期限",delegate{var p=new EditTestPort{Fault="remaining",Time=29990}; using(var e=new AIbrowseSelectionEdit(p)){e.ReplaceOnce(Target,p.Text); Require(p.Timeouts.Count==2&&p.Timeouts[0]==10&&p.Timeouts[1]==5);}});
        Test("既有原期限进入时已过零消息",delegate{var p=new EditTestPort{Time=30000}; using(var e=new AIbrowseSelectionEdit(p)){Reject(delegate{e.ReplaceOnce(Target,p.Text);});Require(p.Selected==0&&p.Replaced==0);}});
        Test("原生读取端口绑定最初时间",delegate{var p=new NativeReadTestPort();var d=new AIbrowseSelectionDeadline(Stopwatch.GetTimestamp()-Stopwatch.Frequency*29-Stopwatch.Frequency/2,Stopwatch.Frequency);using(var c=new AIbrowseNativeSaveControl(new SelectionControlClock(p,d))){c.ReadText(); foreach(uint t in p.Timeouts)Require(t>0&&t<=500);}});
        Test("错误时钟频率拒绝",delegate{Reject(delegate{new AIbrowseSelectionDeadline(Stopwatch.GetTimestamp(),1);});});
        Test("编辑释放幂等",delegate{var p=new EditTestPort();var e=new AIbrowseSelectionEdit(p);e.Dispose();e.Dispose();Reject(delegate{e.ReplaceOnce(Target,p.Text);});Require(p.Disposed==1);});
        Test("打开按钮严格一次",delegate{var p=new ButtonTestPort();using(var b=new AIbrowseSelectionButton(p,"打开",true)){b.Inspect();b.Act();Reject(delegate{b.Act();});Require(p.Actions==1);}});
        foreach(string fault in new[]{"role","state","action","name","time"}) {string f=fault;Test("打开按钮拒绝-"+f,delegate{var p=new ButtonTestPort();if(f=="role")p.Role=42;if(f=="state")p.State=1;if(f=="action")p.Action="";if(f=="name")p.Name="保存";if(f=="time")p.Time=30000;Reject(delegate{using(var b=new AIbrowseSelectionButton(p,"打开",true))b.Act();});Require(p.Actions==0);});}
        Test("打开按钮接受严格非空本地化动作",delegate{var p=new ButtonTestPort{Action="推"};using(var b=new AIbrowseSelectionButton(p,"打开",true)){b.Inspect();b.Act();Require(p.Actions==1);}});
        Test("打开按钮拒绝空动作",delegate{var p=new ButtonTestPort{Action=null};using(var b=new AIbrowseSelectionButton(p,"打开",true)){Reject(delegate{b.Act();});Require(p.Actions==0);}});
        Test("保存白名单不接受打开",delegate{Reject(delegate{new AIbrowseNativeSaveButton(new ButtonTestPort(),1,"打开");});});
        Test("打开白名单不接受保存",delegate{Reject(delegate{new AIbrowseSelectionButton(new ButtonTestPort(),"保存",true);});});
        foreach(string scenario in new[]{"save","open"}) {string s=scenario;Test("合法回执-"+s,delegate{ReceiptGate.Validate(Tool(s),Fixture(s),s);});
            foreach(string field in new[]{"events","released","unadvised","showResult","options","finalClass","eventClass","elapsedMs"}) {string key=field;Test("回执拒绝-"+s+"-"+key,delegate{var f=Fixture(s);if(key=="released"||key=="unadvised")f[key]=false;else if(key=="finalClass"||key=="eventClass")f[key]="exact-default";else f[key]=key=="elapsedMs"?30000:key=="events"?2:key=="showResult"?1:0;Reject(delegate{ReceiptGate.Validate(Tool(s),f,s);});});}}
        Test("选择账本文本正确默认路径拒绝",delegate{var l=new ChoiceLedger(1,Target,@"C:\default\AIbrowse-backup.aibak");l.BeginEvent(1,1);Require(!l.Observe(1,2,Target,@"C:\default\AIbrowse-backup.aibak"));Reject(delegate{l.Complete(1,3,0,@"C:\default\AIbrowse-backup.aibak");});});
        Test("选择账本线程漂移",delegate{var l=new ChoiceLedger(1,Target,"default");Reject(delegate{l.BeginEvent(2,1);});});
        Test("选择账本重复事件",delegate{var l=new ChoiceLedger(1,Target,"default");l.BeginEvent(1,1);l.Observe(1,2,Target,Target);Reject(delegate{l.BeginEvent(1,3);});});
        Test("选择账本后置路径改变",delegate{var l=new ChoiceLedger(1,Target,"default");l.BeginEvent(1,1);l.Observe(1,2,Target,Target);Reject(delegate{l.Complete(1,3,0,"other");});});
        Test("完整收尾先保存后打开",delegate{string order="";CampaignOrder.Run(delegate(string s){order+=s+";";},delegate{order+="verify;";});Require(order=="verify;save;verify;open;verify;");});
        Test("保存失败零打开",delegate{int cases=0;Reject(delegate{CampaignOrder.Run(delegate(string s){cases++;throw new InvalidOperationException();},delegate{});});Require(cases==1);});
        Test("保存后输入校验失败零打开",delegate{int cases=0,checks=0;Reject(delegate{CampaignOrder.Run(delegate(string s){cases++;},delegate{if(++checks==2)throw new InvalidOperationException();});});Require(cases==1);});
        Test("STA释放失败拒绝",delegate{var l=new DialogLifetime(1);l.Registered(1,0,3);Reject(delegate{l.Finish(1,delegate(uint c){return 0;},delegate{throw new InvalidOperationException();});});Require(l.Unadvised&&!l.Released);});
        Test("STA注销失败仍释放",delegate{var l=new DialogLifetime(1);l.Registered(1,0,3);int releases=0;Reject(delegate{l.Finish(1,delegate(uint c){return 1;},delegate{releases++;});});Require(!l.Unadvised&&l.Released&&releases==1);});
        Test("STA错误线程零释放",delegate{var l=new DialogLifetime(1);l.Registered(1,0,3);int releases=0;Reject(delegate{l.Finish(2,delegate(uint c){return 0;},delegate{releases++;});});Require(releases==0);});
        return results.ToArray();
    }
}
