using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using AIbrowse.SelectionQualification;

public static class FixtureReview
{
    private static readonly List<object> Results = new List<object>();
    private static string root;
    private static void Require(bool value) { if (!value) throw new Exception("独立断言失败"); }
    private static void Reject(Action action) { bool rejected=false; try { action(); } catch { rejected=true; } Require(rejected); }
    private static void Test(string name, Action action) { bool pass=true; try { action(); } catch { pass=false; } Results.Add(new { name=name, pass=pass }); }
    private static ChoiceLedger Ready() { var l=new ChoiceLedger(1,"target","default"); l.BeginEvent(1,1); Require(l.Observe(1,2,"text-only","target")); return l; }
    public static int Main(string[] args)
    {
        root=args[0];
        Test("完整双选择允许GetFileName仅作对照",delegate { var l=Ready(); l.Complete(1,3,0,"target"); Require(l.Completed); });
        Test("无事件禁止最终选择",delegate { Reject(delegate { new ChoiceLedger(1,"target","default").Complete(1,3,0,"target"); }); });
        Test("重入事件禁止",delegate { var l=new ChoiceLedger(1,"target","default"); l.BeginEvent(1,1); Reject(delegate { l.BeginEvent(1,2); }); });
        Test("取消Show不能授成功",delegate { Reject(delegate { Ready().Complete(1,3,unchecked((int)0x800704c7),"target"); }); });
        Test("完成后重复完成禁止",delegate { var l=Ready(); l.Complete(1,3,0,"target"); Reject(delegate { l.Complete(1,4,0,"target"); }); });
        Test("事件期限边界拒绝",delegate { var l=new ChoiceLedger(1,"target","default"); Reject(delegate { l.BeginEvent(1,30000); }); });
        Test("最终期限边界拒绝",delegate { Reject(delegate { Ready().Complete(1,30000,0,"target"); }); });
        Test("最终线程变化拒绝",delegate { Reject(delegate { Ready().Complete(2,3,0,"target"); }); });
        Test("文本target不能覆盖其它Shell对象",delegate { var l=new ChoiceLedger(1,"target","default"); l.BeginEvent(1,1); Require(!l.Observe(1,2,"target","other")); Reject(delegate { l.Complete(1,3,0,"target"); }); });
        Test("Advise失败仍释放且不可授Unadvise",delegate { var l=new DialogLifetime(1); Reject(delegate { l.Registered(1,1,9); }); int released=0; l.Finish(1,delegate(uint c){throw new Exception();},delegate{released++;}); Require(!l.Unadvised&&l.Released&&released==1); });
        Test("取消失败不允许重发",delegate { var l=new DialogLifetime(1); int calls=0; Reject(delegate { l.CloseOnce(1,delegate { calls++; return 1; }); }); l.CloseOnce(1,delegate { calls++; return 0; }); Require(calls==1); });
        Test("注销抛错仍恰好释放一次",delegate { var l=new DialogLifetime(1); l.Registered(1,0,17); int released=0; Reject(delegate { l.Finish(1,delegate(uint c){Require(c==17);throw new Exception();},delegate{released++;}); }); l.Finish(1,delegate(uint c){return 0;},delegate{released++;}); Require(!l.Unadvised&&l.Released&&released==1); });
        Test("release抛错不授释放",delegate { var l=new DialogLifetime(1); l.Registered(1,0,7); Reject(delegate { l.Finish(1,delegate(uint c){return 0;},delegate{throw new Exception();}); }); Require(l.Unadvised&&!l.Released); });
        Test("Save退出或回执失败零Open",delegate { int count=0; Reject(delegate { CampaignOrder.Run(delegate(string s){Require(s=="save");count++;throw new Exception();},delegate{}); }); Require(count==1); });
        Test("Save后复验失败零Open",delegate { int calls=0, verify=0; Reject(delegate { CampaignOrder.Run(delegate(string s){calls++;},delegate{if(++verify==2)throw new Exception();}); }); Require(calls==1); });
        Test("Open完成后最后验证不可省略",delegate { int calls=0,verify=0; Reject(delegate { CampaignOrder.Run(delegate(string s){calls++;},delegate{if(++verify==3)throw new Exception();}); }); Require(calls==2&&verify==3); });
        foreach(string body in new[]{"{\"\\u0076ersion\":1}","{\"version\":1,\"\\u0076ersion\":2}","{\"version\":1}x","{\"version\":1,}","{\"version\":1.0}","{\"version\":null}"})
        { string content=body; Test("CSharp严格JSON拒绝-"+Results.Count,delegate { string path=Path.Combine(root,"json-"+Results.Count+".json"); File.WriteAllText(path,content); Reject(delegate { FlatJson.Read(path,"version"); }); }); }
        Test("CSharp正常整数JSON通过",delegate { string p=Path.Combine(root,"valid.json"); File.WriteAllText(p,"{\"version\":1}"); Require(FlatJson.Number(FlatJson.Read(p,"version"),"version")==1); });
        Test("Open小文件持有阻止覆盖移动",delegate { string p=Path.Combine(root,"control.aibak"); File.WriteAllBytes(p,OpenInputLease.Content); using(var lease=new OpenInputLease(p)){ lease.Verify(); Reject(delegate{File.WriteAllBytes(p,OpenInputLease.Content);}); Reject(delegate{File.Move(p,p+".moved");}); lease.Verify(); } });
        Test("Open同长度错误内容拒绝",delegate { string p=Path.Combine(root,"wrong.aibak"); byte[] c=OpenInputLease.Content; c[0]^=1; File.WriteAllBytes(p,c); Reject(delegate{using(var l=new OpenInputLease(p)){};}); });
        Test("单回执超过64KiB拒绝",delegate { string d=Path.Combine(root,"native-file-selection-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(d);File.WriteAllBytes(Path.Combine(d,"large.json"),new byte[65537]);Reject(delegate{EvidenceBudget.Check(d);}); });
        Test("回执条数超过64拒绝",delegate { string d=Path.Combine(root,"native-file-selection-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(d);for(int i=0;i<65;i++)File.WriteAllText(Path.Combine(d,i+".json"),"1");Reject(delegate{EvidenceBudget.Check(d);}); });
        Test("未知子目录拒绝",delegate { string d=Path.Combine(root,"native-file-selection-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(Path.Combine(d,"unknown"));Reject(delegate{EvidenceBudget.Check(d);}); });
        Test("保存目标有任何文件即拒绝",delegate { string d=Path.Combine(root,"no-data");foreach(string name in new[]{"default","published","open-default","open-input"})Directory.CreateDirectory(Path.Combine(d,name));File.WriteAllBytes(Path.Combine(d,"open-input","product-backup.aibak"),OpenInputLease.Content);FilenameFixtureProgram.NoData(d);File.WriteAllText(Path.Combine(d,"published","unexpected.aibak"),"1");Reject(delegate{FilenameFixtureProgram.NoData(d);}); });
        string output=new JavaScriptSerializer().Serialize(Results); File.WriteAllText(Path.Combine(root,"fixture-results.json"),output);
        Console.WriteLine(output); return 0;
    }
}
