using System;
using System.Collections.Generic;
using AIbrowse.SelectionQualification;

internal sealed class OpenStructureTestPort : IOpenStructurePort
{
    internal sealed class Node { internal IntPtr Parent; internal List<IntPtr> Children=new List<IntPtr>(); internal OpenStructureNode Value=new OpenStructureNode {ClassName="Static"}; }
    internal Dictionary<IntPtr,Node> Nodes=new Dictionary<IntPtr,Node>();
    internal int Checks, ExpireAt=int.MaxValue;
    internal bool Drift, Cycle, BrokenParent;
    internal OpenStructureTestPort() { Nodes.Add(Dialog,new Node {Value=new OpenStructureNode {ClassName="#32770"}}); }
    public IntPtr Dialog {get{return new IntPtr(1);}}
    internal IntPtr Add(IntPtr parent,string type="Static",int id=0) {IntPtr key=new IntPtr(Nodes.Count+1);Nodes.Add(key,new Node {Parent=parent,Value=new OpenStructureNode {ClassName=type,ControlId=id,Enabled=true,Visible=true}});Nodes[parent].Children.Add(key);return key;}
    public void Check(){if(++Checks>=ExpireAt || Drift)throw new InvalidOperationException("synthetic-private-state");}
    public OpenStructureNode Read(IntPtr window){Check();return Nodes[window].Value;}
    public IntPtr Child(IntPtr window){Check();return Nodes[window].Children.Count==0?IntPtr.Zero:Nodes[window].Children[0];}
    public IntPtr Next(IntPtr window){Check();if(Cycle)return window;var siblings=Nodes[Nodes[window].Parent].Children;int index=siblings.IndexOf(window)+1;return index==siblings.Count?IntPtr.Zero:siblings[index];}
    public IntPtr Parent(IntPtr window){Check();return BrokenParent?IntPtr.Zero:Nodes[window].Parent;}
    public void Dispose(){}
}
public sealed class OpenStructureTestResult {public string Name;public bool Pass;}
public static class OpenStructurePureTests
{
    private static List<OpenStructureTestResult> results;
    private static void Require(bool value){if(!value)throw new InvalidOperationException("纯观察断言失败");}
    private static void Reject(Action action){bool rejected=false;try{action();}catch{rejected=true;}Require(rejected);}
    private static void Test(string name,Action action){bool pass=true;try{action();}catch{pass=false;}results.Add(new OpenStructureTestResult{Name=name,Pass=pass});}
    private static Dictionary<string,object> Tool(){return new Dictionary<string,object>{{"version",1},{"purpose","open-structure-observation"},{"scenario","open"},{"ok",true},{"editTarget",false},{"buttonQualified",false},{"writes",0},{"saveActions",0},{"selections",0},{"replacements",0},{"phase","observed"},{"failure","none"},{"elapsedMs",100}};}
    private static Dictionary<string,object> Fixture(){return new Dictionary<string,object>{{"version",1},{"scenario","open"},{"ok",false},{"cancelled",true},{"unadvised",true},{"released",true},{"events",0},{"showResult",unchecked((int)0x800704c7)},{"textClass","unavailable"},{"eventClass","unavailable"},{"finalClass","unavailable"},{"failure","cancel-or-deadline"},{"options",0x2001840},{"elapsedMs",200}};}
    public static OpenStructureTestResult[] Run()
    {
        results=new List<OpenStructureTestResult>();
        Test("原生512节点允许",delegate{var p=new OpenStructureTestPort();for(int i=0;i<511;i++)p.Add(p.Dialog);Require((int)AIbrowseOpenStructure.Observe(p)["nativeNodes"]==512);});
        Test("原生513节点拒绝",delegate{var p=new OpenStructureTestPort();for(int i=0;i<512;i++)p.Add(p.Dialog);Reject(delegate{AIbrowseOpenStructure.Observe(p);});});
        Test("候选16允许",delegate{var p=new OpenStructureTestPort();for(int i=0;i<16;i++)p.Add(p.Dialog,"Edit",1001);Require(((Dictionary<string,object>[])AIbrowseOpenStructure.Observe(p)["candidates"]).Length==16);});
        Test("候选17拒绝",delegate{var p=new OpenStructureTestPort();for(int i=0;i<17;i++)p.Add(p.Dialog,"Edit",1001);Reject(delegate{AIbrowseOpenStructure.Observe(p);});});
        Test("父链8允许",delegate{var p=new OpenStructureTestPort();IntPtr parent=p.Dialog;for(int i=0;i<7;i++)parent=p.Add(parent);p.Add(parent,"Edit",1001);var rows=(Dictionary<string,object>[])AIbrowseOpenStructure.Observe(p)["candidates"];Require(((Dictionary<string,object>[])rows[0]["parents"]).Length==8);});
        Test("父链9拒绝",delegate{var p=new OpenStructureTestPort();IntPtr parent=p.Dialog;for(int i=0;i<8;i++)parent=p.Add(parent);p.Add(parent,"Edit",1001);Reject(delegate{AIbrowseOpenStructure.Observe(p);});});
        Test("同级循环拒绝",delegate{var p=new OpenStructureTestPort();p.Add(p.Dialog);p.Cycle=true;Reject(delegate{AIbrowseOpenStructure.Observe(p);});});
        Test("父链脱离拒绝",delegate{var p=new OpenStructureTestPort();p.Add(p.Dialog,"Edit",1001);p.BrokenParent=true;Reject(delegate{AIbrowseOpenStructure.Observe(p);});});
        Test("身份漂移拒绝",delegate{var p=new OpenStructureTestPort();p.Drift=true;Reject(delegate{AIbrowseOpenStructure.Observe(p);});});
        Test("逐步超时拒绝",delegate{var baseline=new OpenStructureTestPort();baseline.Add(baseline.Dialog,"Edit",1001);AIbrowseOpenStructure.Observe(baseline);for(int stop=1;stop<=baseline.Checks;stop++){var p=new OpenStructureTestPort();p.Add(p.Dialog,"Edit",1001);p.ExpireAt=stop;Reject(delegate{AIbrowseOpenStructure.Observe(p);});}});
        Test("未知class不能成为候选",delegate{var p=new OpenStructureTestPort();p.Add(p.Dialog,"synthetic-private-class",1001);Require(((Dictionary<string,object>[])AIbrowseOpenStructure.Observe(p)["candidates"]).Length==0);Require(AIbrowseOpenStructure.ClassifyClass("synthetic-private-class")=="other");});
        Test("未知ID不回显",delegate{Require(AIbrowseOpenStructure.ClassifyId(54321)=="other");});
        Test("窄已知ID分类",delegate{Require(AIbrowseOpenStructure.ClassifyId(1001)=="id-1001"&&AIbrowseOpenStructure.ClassifyId(1148)=="id-1148"&&AIbrowseOpenStructure.ClassifyId(1149)=="id-1149");});
        Test("不可用隐藏只观察不授权",delegate{var p=new OpenStructureTestPort();var key=p.Add(p.Dialog,"Edit",1001);p.Nodes[key].Value.Enabled=false;p.Nodes[key].Value.Visible=false;var row=((Dictionary<string,object>[])AIbrowseOpenStructure.Observe(p)["candidates"])[0];Require(!(bool)row["enabled"]&&!(bool)row["visible"]&&!row.ContainsKey("value")&&!row.ContainsKey("name")&&!row.ContainsKey("handle"));});
        Test("观察只调一次Open",delegate{var order=new List<string>();ObservationOrder.Run(delegate(string value){order.Add(value);},delegate{order.Add("check");});Require(String.Join(",",order)=="check,open,check");});
        Test("观察失败不续场",delegate{int called=0;Reject(delegate{ObservationOrder.Run(delegate(string value){called++;throw new InvalidOperationException();},delegate{});});Require(called==1);});
        Test("完整取消与释放才能观察成功",delegate{ObservationReceiptGate.Validate(Tool(),Fixture());});
        foreach(string field in new[]{"purpose","scenario","ok","editTarget","buttonQualified","writes","saveActions","selections","replacements","phase","failure","elapsedMs"}){
            string key=field;Test("helper反例-"+key,delegate{var t=Tool();if(t[key] is bool)t[key]=!(bool)t[key];else if(t[key] is int)t[key]=key=="elapsedMs"?30000:1;else t[key]="other";Reject(delegate{ObservationReceiptGate.Validate(t,Fixture());});});
        }
        foreach(string field in new[]{"scenario","ok","cancelled","unadvised","released","events","showResult","textClass","eventClass","finalClass","failure","options","elapsedMs"}){
            string key=field;Test("fixture反例-"+key,delegate{var f=Fixture();if(f[key] is bool)f[key]=!(bool)f[key];else if(f[key] is int)f[key]=key=="elapsedMs"?30000:key=="events"?1:0;else f[key]="other";Reject(delegate{ObservationReceiptGate.Validate(Tool(),f);});});
        }
        Test("观察不授选择通过",delegate{Reject(delegate{ReceiptGate.Validate(Tool(),Fixture(),"open");});});
        return results.ToArray();
    }
}
