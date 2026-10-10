using System;
using System.Collections.Generic;
using System.Diagnostics;

internal sealed class ReviewEditPort : ISelectionEditPort
{
    public long Elapsed { get; set; }
    internal int Selects, Replaces, Reads, Closed;
    internal string Text="AIbrowse-backup", Fault="";
    internal List<uint> Limits=new List<uint>();
    public void Validate() { if(Fault=="identity-after-selection"&&Selects==1)throw new Exception(); }
    public string Read() { Reads++; if(Fault=="read-expiry"&&Reads==2)Elapsed=30000; return Text; }
    public void SelectAll(uint limit) { Selects++; Limits.Add(limit); if(Fault=="select-failure")throw new Exception(); if(Fault=="select-expiry")Elapsed=30000; if(Fault=="last-ms")Elapsed=29999; }
    public void Replace(string text,uint limit) { Replaces++; Limits.Add(limit); Text=Fault=="partial"?text+"x":text; if(Fault=="replace-failure")throw new Exception(); if(Fault=="replace-expiry")Elapsed=30000; }
    public void Dispose() { Closed++; }
}
internal sealed class ReviewButtonPort : IAIbrowseSaveButtonPort, IAIbrowseButtonAccessible
{
    internal long Time;
    internal int Reads, Actions;
    internal string Fault="", Action="Click";
    public long ElapsedMilliseconds { get { return Time; } }
    public bool IdentityMatches() { return !(Fault=="identity"&&Reads>0); }
    public IAIbrowseButtonAccessible OpenAccessible() { if(Fault=="open-expiry")Time=30000;return this; }
    public SaveButtonMetadata Read() { Reads++; if(Fault=="read-expiry")Time=30000; return new SaveButtonMetadata { HResult=0, Role=Fault=="role"?42:43, State=Fault=="hidden"?0x10000:0, Name=Fault=="name"?"保存":"打开", DefaultAction=Action }; }
    public void Act() { Actions++;if(Fault=="act-expiry")Time=30000; }
    public void Dispose() { }
}
public sealed class ReviewResult { public string name; public bool pass; }
public static class HelperReview
{
    private static readonly List<ReviewResult> Results=new List<ReviewResult>();
    private static void Require(bool value) { if(!value)throw new Exception("独立断言失败"); }
    private static void Reject(Action action) { bool denied=false;try{action();}catch{denied=true;}Require(denied); }
    private static void Test(string name,Action action) { bool pass=true;try{action();}catch{pass=false;}Results.Add(new ReviewResult{name=name,pass=pass}); }
    public static ReviewResult[] Run()
    {
        string target=@"C:\owned\target.aibak";
        foreach(string problem in new[]{"select-failure","select-expiry","identity-after-selection","read-expiry","partial","replace-failure","replace-expiry"})
        { string fault=problem;Test("编辑失败不续发-"+fault,delegate { var p=new ReviewEditPort{Fault=fault};using(var e=new AIbrowseSelectionEdit(p)){Reject(delegate{e.ReplaceOnce(target,"AIbrowse-backup");});int a=p.Selects,b=p.Replaces;Reject(delegate{e.ReplaceOnce(target,"AIbrowse-backup");});Require(p.Selects==a&&p.Replaces==b);if(fault=="read-expiry")Require(a==0&&b==0);else if(fault.StartsWith("select-")||fault=="identity-after-selection")Require(a==1&&b==0);} }); }
        Test("最后1毫秒保留原期限",delegate {var p=new ReviewEditPort{Elapsed=29998,Fault="last-ms"};using(var e=new AIbrowseSelectionEdit(p)){e.ReplaceOnce(target,p.Text);Require(p.Limits[0]==2&&p.Limits[1]==1);} });
        Test("错误初值零消息且消耗尝试",delegate {var p=new ReviewEditPort();using(var e=new AIbrowseSelectionEdit(p)){Reject(delegate{e.ReplaceOnce(target,"wrong");});Reject(delegate{e.ReplaceOnce(target,p.Text);});Require(p.Selects==0&&p.Replaces==0);} });
        Test("销毁后零消息",delegate{var p=new ReviewEditPort();var e=new AIbrowseSelectionEdit(p);e.Dispose();e.Dispose();Reject(delegate{e.ReplaceOnce(target,p.Text);});Require(p.Closed==1&&p.Selects==0&&p.Replaces==0);});
        foreach(string problem in new[]{"identity","open-expiry","read-expiry","role","hidden","name","act-expiry"})
        {string fault=problem;Test("Open按钮反例-"+fault,delegate{var p=new ReviewButtonPort{Fault=fault};Reject(delegate{using(var b=new AIbrowseSelectionButton(p,"打开",true)){b.Act();}});Require(p.Actions==(fault=="act-expiry"?1:0));});}
        Test("Open正常严格一次动作",delegate{var p=new ReviewButtonPort();using(var b=new AIbrowseSelectionButton(p,"打开",true)){b.Act();Reject(delegate{b.Act();});Require(p.Actions==1);}});
        Test("本地化推动作按严格非空语义执行一次",delegate{var p=new ReviewButtonPort{Action="推"};using(var b=new AIbrowseSelectionButton(p,"打开",true)){b.Act();Reject(delegate{b.Act();});}Require(p.Actions==1);});
        Test("错误原时钟频率拒绝",delegate{Reject(delegate{new AIbrowseSelectionDeadline(Stopwatch.GetTimestamp(),Stopwatch.Frequency+1);});});
        Test("未来原时钟拒绝",delegate{Reject(delegate{new AIbrowseSelectionDeadline(Stopwatch.GetTimestamp()+Stopwatch.Frequency*60,Stopwatch.Frequency);});});
        return Results.ToArray();
    }
    public static ReviewResult[] RunRepair()
    {
        Results.Clear();
        foreach(string value in new[]{"推","Press","本地化默认动作"})
        {string action=value;Test("非空本地化动作一次-"+action,delegate{var p=new ReviewButtonPort{Action=action};using(var b=new AIbrowseSelectionButton(p,"打开",true)){b.Act();Reject(delegate{b.Act();});}Require(p.Actions==1);});}
        foreach(string value in new string[]{null,""})
        {string action=value;Test("空动作零执行-"+(value==null?"null":"empty"),delegate{var p=new ReviewButtonPort{Action=action};Reject(delegate{using(var b=new AIbrowseSelectionButton(p,"打开",true))b.Act();});Require(p.Actions==0);});}
        foreach(string problem in new[]{"identity","open-expiry","read-expiry","role","hidden","name"})
        {string fault=problem;Test("本地化不放宽原安全门-"+fault,delegate{var p=new ReviewButtonPort{Action="推",Fault=fault};Reject(delegate{using(var b=new AIbrowseSelectionButton(p,"打开",true))b.Act();});Require(p.Actions==0);});}
        Test("原Save不接受Open名称",delegate{Reject(delegate{using(var b=new AIbrowseNativeSaveButton(new ReviewButtonPort{Action="推"},1,"打开"))b.Act();});});
        Test("Open仍拒绝Save名称",delegate{Reject(delegate{using(var b=new AIbrowseSelectionButton(new ReviewButtonPort{Action="推"},"保存",true))b.Act();});});
        return Results.ToArray();
    }
}
