[CmdletBinding()]
param([Parameter(Mandatory)][string]$Evidence)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if (Test-Path -LiteralPath $Evidence) { throw '测试原件已存在，拒绝覆盖' }
[void][IO.Directory]::CreateDirectory($Evidence)
$fixture=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'NativeFilenameDialogFixture.cs'))
$start=$fixture.IndexOf('    public sealed class ChoiceLedger',[StringComparison]::Ordinal)
$end=$fixture.IndexOf('    internal static class FlatJson',[StringComparison]::Ordinal)
if ($start -lt 0 -or $end -le $start) { throw '纯状态机边界缺失' }
$pure='using System; using System.Collections.Generic; namespace AIbrowse.FilenameQualification {'+$fixture.Substring($start,$end-$start)+'}'
$interfaceStart=$fixture.IndexOf('    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',[StringComparison]::Ordinal)
$interfaceEnd=$fixture.IndexOf('    public sealed class ScopeLease',[StringComparison]::Ordinal)
if ($interfaceStart -lt 0 -or $interfaceEnd -le $interfaceStart) { throw 'COM接口定义边界缺失' }
$interfaces='using System; using System.Runtime.InteropServices; namespace AIbrowse.FilenameQualification {'+$fixture.Substring($interfaceStart,$interfaceEnd-$interfaceStart)+'}'
$ports=@'
using System;
using System.Collections.Generic;
using AIbrowse.FilenameQualification;
public sealed class FilenameTestOutcome { public string Name; public bool Pass; }
internal sealed class ValueFake : IFilenameValuePort, IFilenameValueAccessible {
    internal string Text="AIbrowse-backup", Fault="";
    internal long Time;
    internal int Puts, Reads, Validations, Releases, Drift;
    public long Elapsed {get{return Time;}}
    public void Validate(){Validations++;if(Validations==Drift)throw new InvalidOperationException("身份变化");}
    public string ReadNative(){return Fault=="native-drift"?"other":Text;}
    public IFilenameValueAccessible Open(){return this;}
    public FilenameValueMetadata Read(){
        Reads++;
        if(Fault=="read-late")Time=30000;
        if(Fault=="read-throw")throw new InvalidOperationException("不可泄漏正文");
        var value=new FilenameValueMetadata {HResult=0,ExactWindow=true,Name="文件名(N):",Value=Fault=="value-drift"?"other":Text,Role=42,State=0};
        if(Reads==2){if(Fault=="second-role")value.Role=43;if(Fault=="second-state")value.State=0x40;if(Fault=="second-name")value.Name="other";if(Fault=="second-value")value.Value="other";}
        return value;
    }
    public int Put(string target){Puts++;Text=target;if(Fault=="put-late")Time=30000;if(Fault=="put-throw")throw new InvalidOperationException("不可泄漏正文");return Fault=="put-false"?1:Fault=="put-fail"?-1:0;}
    public void Dispose(){Releases++;}
}
internal sealed class OldTextFake : IAIbrowseSaveControlPort {
    internal string Text="AIbrowse-backup";
    public long ElapsedMilliseconds {get{return 1;}}
    public bool IdentityMatches(){return true;}
    public ulong ReadLength(uint timeout){return (ulong)Text.Length;}
    public string ReadText(uint timeout){return Text;}
    public bool WriteTarget(string target,uint timeout){Text=target;return true;}
    public void Dispose(){}
}
public static class FilenamePureTests {
    private static readonly List<FilenameTestOutcome> checks=new List<FilenameTestOutcome>();
    private static readonly string Target=@"D:\filename-pure-never-created-32aec96fa3fd4b7fad4c15312affb872\product-backup.aibak";
    private static readonly string Initial=@"D:\filename-pure-never-created-32aec96fa3fd4b7fad4c15312affb872\AIbrowse-backup.aibak";
    private static void Test(string name,Func<bool> run){bool ok=false;try{ok=run();}catch{}checks.Add(new FilenameTestOutcome{Name=name,Pass=ok});}
    private static bool Reject(Action action){try{action();return false;}catch{return true;}}
    private static ChoiceLedger Ledger(){return new ChoiceLedger(1,Target,Initial);}
    private static FilenameValueMetadata Metadata(){return new FilenameValueMetadata{HResult=0,ExactWindow=true,Name="文件名(N):",Value="AIbrowse-backup",Role=42,State=0};}
    private static Dictionary<string,object> Tool(){return new Dictionary<string,object>{{"version",1},{"scenario","reference"},{"purpose","qualification"},{"ok",true},{"editTarget",true},{"msaaQualified",true},{"writes",1},{"saveActions",1},{"focusActions",2},{"editFocusVerified",true},{"saveFocusVerified",true},{"elapsedMs",1},{"failure","none"}};}
    private static Dictionary<string,object> Result(){return new Dictionary<string,object>{{"version",1},{"scenario","reference"},{"ok",true},{"events",1},{"textClass","exact-target"},{"eventClass","exact-default"},{"finalClass","exact-default"},{"showResult",0},{"options",0x2010040},{"unadvised",true},{"released",true},{"cancelled",false},{"elapsedMs",1},{"failure","none"}};}
    public static FilenameTestOutcome[] Run(string occupied){
        Test("已存在目标在值写前拒绝",()=>{var port=new ValueFake();using(var value=new AIbrowseNativeFilenameValue(port)){return Reject(()=>value.WriteTarget(occupied,"AIbrowse-backup"))&&port.Puts==0;}});
        foreach(string fault in new[]{"second-role","second-state","second-name","second-value"}){string mode=fault;Test("第二读取资格漂移"+fault,()=>{var port=new ValueFake{Fault=mode};using(var value=new AIbrowseNativeFilenameValue(port)){return Reject(()=>value.WriteTarget(Target,"AIbrowse-backup"))&&port.Reads==2&&port.Puts==0;}});}
        Test("严格第一场回执允许第二场判断",()=>{ReceiptGate.Validate(Tool(),Result(),"reference");return true;});
        Test("诊断目的不能成为资格",()=>{var t=Tool();t["purpose"]="focus-diagnostic";return Reject(()=>ReceiptGate.Validate(t,Result(),"reference"));});
        foreach(int invalid in new[]{-1,0,1,3}){int count=invalid;Test("焦点动作数严格为二"+count,()=>{var t=Tool();t["focusActions"]=count;return Reject(()=>ReceiptGate.Validate(t,Result(),"reference"));});}
        foreach(string key in new[]{"editFocusVerified","saveFocusVerified"}){string field=key;Test("焦点回执必须核实"+key,()=>{var t=Tool();t[field]=false;return Reject(()=>ReceiptGate.Validate(t,Result(),"reference"));});}
        foreach(bool tool in new[]{true,false}){bool side=tool;var sample=side?Tool():Result();foreach(string key in new List<string>(sample.Keys)){string field=key;Test("回执拒绝缺字段"+side+field,()=>{var t=Tool();var r=Result();(side?t:r).Remove(field);return Reject(()=>ReceiptGate.Validate(t,r,"reference"));});Test("回执拒绝伪造类型"+side+field,()=>{var t=Tool();var r=Result();(side?t:r)[field]=new object();return Reject(()=>ReceiptGate.Validate(t,r,"reference"));});}}
        foreach(string key in new[]{"ok","editTarget"}){string field=key;Test("工具失败不进入第二场"+key,()=>{var t=Tool();t[field]=false;return Reject(()=>ReceiptGate.Validate(t,Result(),"reference"));});}
        foreach(string key in new[]{"ok","unadvised","released"}){string field=key;Test("夹具失败不进入第二场"+key,()=>{var r=Result();r[field]=false;return Reject(()=>ReceiptGate.Validate(Tool(),r,"reference"));});}
        foreach(int invalid in new[]{0,2}){int count=invalid;foreach(string key in new[]{"writes","saveActions"}){string field=key;Test("拒绝动作计数"+key+count,()=>{var t=Tool();t[field]=count;return Reject(()=>ReceiptGate.Validate(t,Result(),"reference"));});}Test("拒绝回调计数"+count,()=>{var r=Result();r["events"]=count;return Reject(()=>ReceiptGate.Validate(Tool(),r,"reference"));});}
        foreach(int late in new[]{-1,30000,30001}){int time=late;Test("工具回执期限"+time,()=>{var t=Tool();t["elapsedMs"]=time;return Reject(()=>ReceiptGate.Validate(t,Result(),"reference"));});Test("夹具回执期限"+time,()=>{var r=Result();r["elapsedMs"]=time;return Reject(()=>ReceiptGate.Validate(Tool(),r,"reference"));});}
        Test("第二场伪造资格拒绝",()=>{var t=Tool();var r=Result();t["scenario"]=r["scenario"]="candidate";t["msaaQualified"]=false;return Reject(()=>ReceiptGate.Validate(t,r,"candidate"));});
        Test("回执Show失败拒绝",()=>{var r=Result();r["showResult"]=1;return Reject(()=>ReceiptGate.Validate(Tool(),r,"reference"));});
        Test("回执取消拒绝",()=>{var r=Result();r["cancelled"]=true;return Reject(()=>ReceiptGate.Validate(Tool(),r,"reference"));});
        Test("回执选项缺失拒绝",()=>{var r=Result();r["options"]=0x2000040;return Reject(()=>ReceiptGate.Validate(Tool(),r,"reference"));});
        Test("回执双GetResult不一致拒绝",()=>{var r=Result();r["eventClass"]="exact-target";return Reject(()=>ReceiptGate.Validate(Tool(),r,"reference"));});
        Test("旧文本工具可成功但最终选择仍为默认",()=>{using(var old=new AIbrowseNativeSaveControl(new OldTextFake())){old.WriteTarget(Target);if(old.ReadText()!=Target)return false;}var l=Ledger();l.BeginEvent(1,1);if(!l.Observe(1,2,Target,Initial))return false;l.Complete(1,3,0,Initial);return l.Completed&&l.FinalClass=="exact-default"&&ChoiceLedger.Decide(true,true,true,l.FinalClass)=="run-candidate";});
        Test("原生终态目标成功仅判旧路线未复现",()=>{var l=Ledger();l.BeginEvent(1,1);l.Observe(1,2,Target,Target);l.Complete(1,3,0,Target);return ChoiceLedger.Decide(true,true,l.Completed,l.FinalClass)=="not-reproduced";});
        Test("没有事件拒绝终态",()=>Reject(()=>Ledger().Complete(1,3,0,Target)));
        Test("缺少Begin事件拒绝观察",()=>Reject(()=>Ledger().Observe(1,3,Target,Target)));
        Test("重复事件拒绝",()=>{var l=Ledger();l.BeginEvent(1,1);l.Observe(1,2,Target,Target);return Reject(()=>l.BeginEvent(1,3));});
        Test("事件重入拒绝",()=>{var l=Ledger();l.BeginEvent(1,1);return Reject(()=>l.BeginEvent(1,2));});
        foreach(int hr in new[]{1,-1,unchecked((int)0x800704c7)}){int value=hr;Test("Show非S_OK拒绝"+hr,()=>{var l=Ledger();l.BeginEvent(1,1);l.Observe(1,2,Target,Target);return Reject(()=>l.Complete(1,3,value,Target));});}
        foreach(string selected in new[]{Initial,"other",null}){string value=selected;Test("终态与事件失配拒绝"+(selected??"null"),()=>{var l=Ledger();l.BeginEvent(1,1);l.Observe(1,2,Target,Target);return Reject(()=>l.Complete(1,3,0,value));});}
        foreach(string selected in new[]{"other",null}){string value=selected;Test("未知选择阻止接受"+(selected??"null"),()=>{var l=Ledger();l.BeginEvent(1,1);return !l.Observe(1,2,Target,value)&&Reject(()=>l.Complete(1,3,0,value));});}
        Test("重复Complete拒绝",()=>{var l=Ledger();l.BeginEvent(1,1);l.Observe(1,2,Target,Target);l.Complete(1,3,0,Target);return Reject(()=>l.Complete(1,4,0,Target));});
        foreach(long time in new long[]{-1,30000,30001}){long value=time;Test("事件期限"+time,()=>Reject(()=>Ledger().BeginEvent(1,value)));Test("读取期限"+time,()=>{var l=Ledger();l.BeginEvent(1,1);return Reject(()=>l.Observe(1,value,Target,Target));});Test("完成期限"+time,()=>{var l=Ledger();l.BeginEvent(1,1);l.Observe(1,2,Target,Target);return Reject(()=>l.Complete(1,value,0,Target));});}
        Test("错误STA拒绝事件",()=>Reject(()=>Ledger().BeginEvent(2,1)));
        Test("错误STA拒绝观察",()=>{var l=Ledger();l.BeginEvent(1,1);return Reject(()=>l.Observe(2,2,Target,Target));});
        Test("错误STA拒绝完成",()=>{var l=Ledger();l.BeginEvent(1,1);l.Observe(1,2,Target,Target);return Reject(()=>l.Complete(2,3,0,Target));});
        Test("缺MSAA资格停止第二场",()=>ChoiceLedger.Decide(true,false,true,"exact-default")=="msaa-unavailable");
        Test("没有原生目标停止第二场",()=>ChoiceLedger.Decide(false,true,true,"exact-default")=="failed");
        Test("没有完整夹具停止第二场",()=>ChoiceLedger.Decide(true,true,false,"exact-default")=="failed");
        Test("未知选择停止第二场",()=>ChoiceLedger.Decide(true,true,true,"other")=="failed");
        foreach(string kind in new[]{"advise-fail","unadvise-false","unadvise-throw","release-throw","normal"}){string mode=kind;Test("COM生命周期"+kind,()=>{var l=new DialogLifetime(1);int un=0,rel=0;if(mode=="advise-fail"){if(!Reject(()=>l.Registered(1,1,8)))return false;}else l.Registered(1,0,8);bool failed=Reject(()=>l.Finish(1,c=>{un++;if(c!=8)throw new Exception();if(mode=="unadvise-throw")throw new Exception();return mode=="unadvise-false"?1:0;},()=>{rel++;if(mode=="release-throw")throw new Exception();}));l.Finish(1,c=>{un++;return 0;},()=>{rel++;});return rel==1&&un==(mode=="advise-fail"?0:1)&&failed==(mode=="unadvise-false"||mode=="unadvise-throw"||mode=="release-throw");});}
        Test("错误线程禁止注销或释放",()=>{var l=new DialogLifetime(1);l.Registered(1,0,9);int calls=0;return Reject(()=>l.Finish(2,c=>{calls++;return 0;},()=>{calls++;}))&&calls==0;});
        Test("重复注册拒绝",()=>{var l=new DialogLifetime(1);l.Registered(1,0,0);return Reject(()=>l.Registered(1,0,1));});
        foreach(bool throws in new[]{false,true}){bool fail=throws;Test("Close只尝试一次"+throws,()=>{var l=new DialogLifetime(1);int calls=0;Reject(()=>l.CloseOnce(1,()=>{calls++;if(fail)throw new Exception();return 1;}));l.CloseOnce(1,()=>{calls++;return 0;});return calls==1;});}
        Test("释放后事件拒绝",()=>{var l=new DialogLifetime(1);l.Finish(1,c=>0,()=>{});return Reject(()=>l.AssertThread(1));});
        Test("正确MSAA元数据",()=>{AIbrowseNativeFilenameValue.ValidateMetadata(Metadata(),"AIbrowse-backup");return true;});
        foreach(object value in new object[]{null,true,"42",42.0,43,0}){object bad=value;Test("拒绝role类型值"+(value??"null"),()=>{var m=Metadata();m.Role=bad;return Reject(()=>AIbrowseNativeFilenameValue.ValidateMetadata(m,"AIbrowse-backup"));});}
        foreach(object value in new object[]{null,false,"0",0.0,-1,1,0x40,0x8000,0x10000,0x20000000}){object bad=value;Test("拒绝state类型值"+(value??"null"),()=>{var m=Metadata();m.State=bad;return Reject(()=>AIbrowseNativeFilenameValue.ValidateMetadata(m,"AIbrowse-backup"));});}
        foreach(object value in new object[]{null,true,1,"文件名 ","File Name:","OTHER_PRIVATE_NAME"}){object bad=value;Test("拒绝name类型值"+(value??"null"),()=>{var m=Metadata();m.Name=bad;return Reject(()=>AIbrowseNativeFilenameValue.ValidateMetadata(m,"AIbrowse-backup"));});}
        foreach(object value in new object[]{null,true,1,"other","AIbrowse-backup\0"}){object bad=value;Test("拒绝value类型值"+(value??"null"),()=>{var m=Metadata();m.Value=bad;return Reject(()=>AIbrowseNativeFilenameValue.ValidateMetadata(m,"AIbrowse-backup"));});}
        Test("拒绝MSAA父窗口映射",()=>{var m=Metadata();m.ExactWindow=false;return Reject(()=>AIbrowseNativeFilenameValue.ValidateMetadata(m,"AIbrowse-backup"));});
        Test("拒绝MSAA非S_OK",()=>{var m=Metadata();m.HResult=1;return Reject(()=>AIbrowseNativeFilenameValue.ValidateMetadata(m,"AIbrowse-backup"));});
        Test("合法put单次及双读取",()=>{var port=new ValueFake();using(var value=new AIbrowseNativeFilenameValue(port)){value.WriteTarget(Target,"AIbrowse-backup");if(!Reject(()=>value.WriteTarget(Target,"AIbrowse-backup")))return false;}return port.Puts==1&&port.Reads==3&&port.Releases==2;});
        foreach(string fault in new[]{"native-drift","value-drift","read-late","read-throw","put-late","put-throw","put-false","put-fail"}){string mode=fault;Test("值调用失败不重发"+fault,()=>{var port=new ValueFake{Fault=mode};using(var value=new AIbrowseNativeFilenameValue(port)){if(!Reject(()=>value.WriteTarget(Target,"AIbrowse-backup")))return false;int prior=port.Puts;if(!Reject(()=>value.WriteTarget(Target,"AIbrowse-backup")))return false;return port.Puts==prior&&prior==(mode.StartsWith("put-")?1:0);}});}
        var countPort=new ValueFake();using(var countValue=new AIbrowseNativeFilenameValue(countPort)){countValue.WriteTarget(Target,"AIbrowse-backup");}
        for(int at=1;at<=countPort.Validations;at++){int point=at;Test("逐次身份漂移"+at,()=>{var port=new ValueFake{Drift=point};using(var value=new AIbrowseNativeFilenameValue(port)){bool failed=Reject(()=>value.WriteTarget(Target,"AIbrowse-backup"));return failed&&port.Puts<=1;}});}
        Test("已释放值端口拒绝",()=>{var port=new ValueFake();var value=new AIbrowseNativeFilenameValue(port);value.Dispose();return Reject(()=>value.Inspect("AIbrowse-backup"))&&port.Reads==0;});
        foreach(string bad in new[]{"relative.aibak",@"D:\bad.txt","",Target+"\0"}){string path=bad;Test("非法值目标拒绝"+bad,()=>{var port=new ValueFake();using(var value=new AIbrowseNativeFilenameValue(port)){return Reject(()=>value.WriteTarget(path,"AIbrowse-backup"))&&port.Puts==0;}});}
        Test("IAccessible完整21方法及PreserveSig",()=>{var methods=typeof(IFilenameAccessible).GetMethods();if(methods.Length!=21)return false;foreach(var method in methods)if((method.MethodImplementationFlags&System.Reflection.MethodImplAttributes.PreserveSig)==0)return false;return typeof(IFilenameAccessible).GUID.ToString()=="618736e0-3c3d-11cf-810c-00aa00389b71";});
        Test("IFileDialog完整24方法及PreserveSig",()=>{var methods=typeof(IFileDialog).GetMethods();if(methods.Length!=24)return false;foreach(var method in methods)if((method.MethodImplementationFlags&System.Reflection.MethodImplAttributes.PreserveSig)==0)return false;return typeof(IFileDialog).GUID.ToString()=="42f85136-db7e-439c-85f1-e4075d135fc8"&&methods[0].Name=="Show"&&methods[17].Name=="GetResult"&&methods[23].Name=="SetFilter";});
        Test("事件sink7槽及HRESULT保持",()=>{var methods=typeof(IFileDialogEvents).GetMethods();if(methods.Length!=7)return false;foreach(var method in methods)if((method.MethodImplementationFlags&System.Reflection.MethodImplAttributes.PreserveSig)==0)return false;return typeof(IFileDialogEvents).GUID.ToString()=="973510db-7d7f-452b-8975-74a85828d354"&&methods[0].Name=="OnFileOk"&&methods[6].Name=="OnOverwrite";});
        return checks.ToArray();
    }
}
'@
$parts=@(
    [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'NativeSaveControl.cs')),
    [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'NativeSaveButton.cs')),
    [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'NativeFilenameValueCandidate.cs')),
    $pure,$interfaces,$ports
)
$paths=@(); $index=0
foreach($part in $parts) { $path=Join-Path $Evidence "pure-$index.cs"; [IO.File]::WriteAllText($path,$part); $paths+= $path; $index++ }
Add-Type -Path $paths
$occupied=Join-Path $Evidence 'occupied.aibak'
[IO.File]::WriteAllText($occupied,'synthetic-pure-test')
$results=[FilenamePureTests]::Run([IO.Path]::GetFullPath($occupied))
$tokens=$null; $parseErrors=$null
$runnerAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'run-native-filename-commit-qualification.ps1'),[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count -ne 0) { throw '运行脚本解析失败' }
foreach($name in @('Check-Time','Check-Parents','Hold-File','Write-New','Read-ClosedJson','Check-JsonObject','Is-Integer','Hash-Again')) {
    $definition=$runnerAst.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true)
    if($definition.Count -ne 1) { throw '实际纯端口函数边界失配' }
    . ([scriptblock]::Create($definition[0].Extent.Text))
}
$clock=[Diagnostics.Stopwatch]::StartNew(); $uiStartedTick=$null
$locks=[Collections.Generic.List[IO.FileStream]]::new()
$psChecks=[Collections.Generic.List[object]]::new()
function Test-Port([string]$Name,[scriptblock]$Body) {
    $passed=$false; try { $passed=[bool](& $Body) } catch { }
    $psChecks.Add([pscustomobject]@{ Name=$Name; Pass=$passed })
}
function Reject-Port([scriptblock]$Body) { try { & $Body; return $false } catch { return $true } }
try {
    $jsonCases=@(
        @{name='正确闭合JSON'; text='{"version":1,"sources":{"x":"hash"}}'; valid=$true},
        @{name='根重复键拒绝'; text='{"version":1,"version":1,"sources":{"x":"hash"}}'; valid=$false},
        @{name='嵌套重复键拒绝'; text='{"version":1,"sources":{"x":"a","x":"b"}}'; valid=$false},
        @{name='转义重复键拒绝'; text='{"version":1,"sources":{"x":"a","\u0078":"b"}}'; valid=$false},
        @{name='数组拒绝'; text='{"version":1,"sources":[]}'; valid=$false},
        @{name='null拒绝'; text='{"version":1,"sources":null}'; valid=$false},
        @{name='浮点拒绝'; text='{"version":1.2,"sources":{}}'; valid=$false},
        @{name='大整数拒绝'; text='{"version":9223372036854775808,"sources":{}}'; valid=$false},
        @{name='深对象拒绝'; text='{"version":1,"sources":{"a":{"b":{}}}}'; valid=$false},
        @{name='额外根字段拒绝'; text='{"version":1,"sources":{},"other":1}'; valid=$false},
        @{name='缺少根字段拒绝'; text='{"version":1}'; valid=$false}
    )
    $index=0
    foreach($case in $jsonCases) {
        $path=Join-Path $Evidence "json-$index.json"; [IO.File]::WriteAllText($path,$case.text); $index++
        Test-Port $case.name { $rejected=Reject-Port { [void](Read-ClosedJson $path @('version','sources')) }; return $rejected -eq (-not $case.valid) }
    }
    Test-Port '来源保持可通过' { $memory=[IO.MemoryStream]::new([byte[]](1,2,3)); try { $hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($memory)).ToLowerInvariant(); Hash-Again @{stream=$memory;hash=$hash}; return $true } finally { $memory.Dispose() } }
    Test-Port '来源漂移拒绝' { $memory=[IO.MemoryStream]::new([byte[]](1,2,3)); try { $hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($memory)).ToLowerInvariant(); $memory.Position=0; $memory.WriteByte(4); return Reject-Port { Hash-Again @{stream=$memory;hash=$hash} } } finally { $memory.Dispose() } }
    Test-Port '回执CreateNew拒绝覆盖' { $path=Join-Path $Evidence 'create-once.json'; Write-New $path @{version=1}; return Reject-Port { Write-New $path @{version=2} } }
    Test-Port '回执64KiB上限' { return Reject-Port { Write-New (Join-Path $Evidence 'too-big.json') @{value=('x'*65536)} } }
    foreach($value in @($true,'1',1.0)) { Test-Port ('非整数字段'+$value.GetType().Name) { return -not (Is-Integer $value) } }
    Test-Port '合法整数字段' { return (Is-Integer 1) -and (Is-Integer 1L) }
    Test-Port '原期限迟到' { return Reject-Port { Check-Time 0 } }
    $uiStartedTick=[Diagnostics.Stopwatch]::GetTimestamp()-([Diagnostics.Stopwatch]::Frequency*31)
    Test-Port '共享UI期限迟到' { return Reject-Port { Check-Time 30000 } }
    $uiStartedTick=[Diagnostics.Stopwatch]::GetTimestamp()+([Diagnostics.Stopwatch]::Frequency*31)
    Test-Port '共享UI时钟未来拒绝' { return Reject-Port { Check-Time 30000 } }
    $uiStartedTick=$null
    $script:fakeItems=0
    function Get-Item { param($LiteralPath,[switch]$Force) $script:fakeItems++; return [pscustomobject]@{ PSIsContainer=$true; Attributes=[IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint } }
    Test-Port '目录链接在开文件前拒绝' { $rejected=Reject-Port { Check-Parents 'D:\synthetic-scope' }; return $rejected -and $script:fakeItems -eq 1 }
    Remove-Item Function:Get-Item
} finally { foreach($stream in $locks) { $stream.Dispose() } }
$results=@($results)+@($psChecks)
$failures=@($results | Where-Object { -not $_.Pass })
$output=[ordered]@{ version=1; actualUi=$false; actualCom=$false; actualJob=$false; passed=$results.Count-$failures.Count; failed=$failures.Count; checks=$results }
[IO.File]::WriteAllText((Join-Path $Evidence 'results.json'),($output | ConvertTo-Json -Depth 5))
[pscustomobject]$output | Select-Object passed,failed,actualUi,actualCom,actualJob
if($failures.Count -gt 0) { $failures | Select-Object Name,Pass; exit 1 }
