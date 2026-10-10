[CmdletBinding()]
param([Parameter(Mandatory)][string]$Evidence)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if (Test-Path -LiteralPath $Evidence) { throw '独立审核原件目录已存在' }
[void][IO.Directory]::CreateDirectory($Evidence)
$Evidence=[IO.Path]::GetFullPath($Evidence)
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$candidate=Join-Path $PSScriptRoot 'product-transfer'
$fixture=[IO.File]::ReadAllText((Join-Path $candidate 'NativeFilenameDialogFixture.cs'))
$start=$fixture.IndexOf('    public static class ReceiptGate',[StringComparison]::Ordinal)
$end=$fixture.IndexOf('    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',[StringComparison]::Ordinal)
if($start -lt 0 -or $end -le $start) { throw '实际解析器提取边界不唯一' }
$flat='using System; using System.Collections.Generic; using System.IO; using System.Text; using System.Text.RegularExpressions; using System.Web.Script.Serialization; namespace AIbrowse.FilenameQualification {'+$fixture.Substring($start,$end-$start)+'}'
$flatPath=Join-Path $Evidence 'actual-flat-json.cs'
[IO.File]::WriteAllText($flatPath,$flat)
$flatTests=@'
using System;
using System.IO;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using AIbrowse.FilenameQualification;
public static class FlatJsonIndependent {
    public static int Main(string[] args) {
        var results=new List<object>();
        string[] bodies={
            "{\"version\":1,\"value\":\"safe\"}",
            "{\"version\":1,\"version\":2,\"value\":\"safe\"}",
            "{\"version\":1,\"\\u0076ersion\":2,\"value\":\"safe\"}",
            "{\"\\u0076ersion\":2,\"version\":1,\"value\":\"safe\"}",
            "{\"version\":1,\"value\":\"safe\",\"\\u0076alue\":\"replaced\"}",
            "{\"version\":1,\"value\":\"safe\",\"unknown\":1}",
            "{\"version\":1,\"value\":{\"child\":1}}",
            "{\"version\":1,\"value\":null}",
            "{\"version\":1.2,\"value\":\"safe\"}",
            "{\"version\":1,\"value\":\"escaped \\\"version\\\":2 \\u4f60 \\\\ /\"}",
            "{\"version\":1,\"value\":true}",
            "{\"version\":-9223372036854775808,\"value\":\"safe\"}",
            " \r\n{ \"value\" : \"safe\" , \"version\" : 1 } \t",
            "{\"version\":1e0,\"value\":\"safe\"}",
            "{\"version\":+1,\"value\":\"safe\"}",
            "{\"version\":1,\"value\":\"safe\",}",
            "{\"version\":1,\"value\":\"safe\"}{}",
            "{\"version\":1,\"value\":\"\\q\"}",
            "{\"version\":1,\"value\":\"raw\nline\"}",
            "{\"version\":01,\"value\":\"safe\"}",
            "{\"version\":9223372036854775808,\"value\":\"safe\"}",
            "{\"version\":1,\"value\":[]}",
            "{\"version\":1}"
        };
        for(int index=0;index<bodies.Length;index++) {
            string file=Path.Combine(args[0],"flat-input-"+index+".json");
            File.WriteAllText(file,bodies[index]);
            bool rejected=false;object version=null, value=null;
            try { var parsed=FlatJson.Read(file,"version","value");version=parsed["version"];value=parsed["value"]; } catch { rejected=true; }
            bool expectedRejected=!(index==0 || (index>=9&&index<=12));
            results.Add(new {name="flat-case-"+index, expectedRejected=expectedRejected, rejected=rejected, version=version, value=value, pass=rejected==expectedRejected});
        }
        File.WriteAllText(Path.Combine(args[0],"flat-results.json"),new JavaScriptSerializer().Serialize(results));
        return 0;
    }
}
'@
$testPath=Join-Path $Evidence 'flat-tests.cs'; [IO.File]::WriteAllText($testPath,$flatTests)
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$program=Join-Path $Evidence 'flat-tests.exe'
& $compiler /nologo /target:exe /platform:x64 /r:System.Web.Extensions.dll "/out:$program" $flatPath $testPath *> (Join-Path $Evidence 'compile.txt')
if($LASTEXITCODE -ne 0) { throw '独立纯解析器编译失败' }
& $program $Evidence
if($LASTEXITCODE -ne 0) { throw '独立纯解析器失败' }
$ports=@'
using System;
using System.Diagnostics;
using System.Threading;
using System.Collections.Generic;
public sealed class DeadlineEvidence {
    public string name;
    public bool pass;
}
internal static class FactoryProbe {
    internal static string Fault,Text;
    internal static int Ports,PortDisposed,ObjectOpened,ObjectDisposed,Reads,Writes,Identities;
    internal static void Reset(string fault) {Fault=fault;Text="AIbrowse-backup";Ports=PortDisposed=ObjectOpened=ObjectDisposed=Reads=Writes=Identities=0;}
    private static void Identity(uint pid,string created,string image,IntPtr owner,IntPtr dialog,IntPtr window) {
        if(pid!=101||created!="1000"||image!=@"D:\synthetic\fixture.exe"||owner.ToInt64()!=10||dialog.ToInt64()!=11||window.ToInt64()!=12)throw new Exception("工厂原生参数失配");
    }
    internal static IAIbrowseSaveControlPort Control(uint pid,string created,string image,IntPtr owner,IntPtr dialog,IntPtr edit,Stopwatch local) {
        Identity(pid,created,image,owner,dialog,edit);if(local.ElapsedMilliseconds>=1000)throw new Exception("不是旧内层时钟");Ports++;return new IndependentControlPort();
    }
    internal static IAIbrowseSaveButtonPort Button(uint pid,string created,string image,IntPtr owner,IntPtr dialog,IntPtr button,int id,Stopwatch local) {
        Identity(pid,created,image,owner,dialog,button);if(id!=1||local.ElapsedMilliseconds>=1000)throw new Exception("按钮参数失配");Ports++;return new IndependentButtonPort();
    }
    internal static IFilenameValueAccessible ValueObject(IntPtr edit,AIbrowseFilenameDeadline deadline) {
        if(edit.ToInt64()!=12||deadline==null)throw new Exception("值对象参数失配");ObjectOpened++;
        if(Fault=="open-late")Thread.Sleep(200);
        return new IndependentValueObject();
    }
}
internal sealed class IndependentControlPort : IAIbrowseSaveControlPort {
    public long ElapsedMilliseconds {get{return 0;}}
    public bool IdentityMatches() {
        FactoryProbe.Identities++;
        if(FactoryProbe.Fault=="identity-late"&&FactoryProbe.Identities==2)Thread.Sleep(200);
        return FactoryProbe.Fault!="identity-fail";
    }
    public ulong ReadLength(uint timeout) {return (ulong)FactoryProbe.Text.Length;}
    public string ReadText(uint timeout) {return FactoryProbe.Text;}
    public bool WriteTarget(string target,uint timeout) {FactoryProbe.Writes++;FactoryProbe.Text=target;return true;}
    public void Dispose() {FactoryProbe.PortDisposed++;}
}
internal sealed class IndependentValueObject : IFilenameValueAccessible {
    public FilenameValueMetadata Read() {
        if(++FactoryProbe.Reads==1&&FactoryProbe.Fault=="read-late")Thread.Sleep(200);
        return new FilenameValueMetadata{Name="文件名",Value=FactoryProbe.Text,Role=42,State=0,HResult=0,ExactWindow=true};
    }
    public int Put(string target) {FactoryProbe.Writes++;FactoryProbe.Text=target;return 0;}
    public void Dispose() {FactoryProbe.ObjectDisposed++;}
}
internal sealed class IndependentButtonPort : IAIbrowseSaveButtonPort, IAIbrowseButtonAccessible {
    public long ElapsedMilliseconds {get{return 0;}}
    public bool IdentityMatches() {return true;}
    public IAIbrowseButtonAccessible OpenAccessible() {FactoryProbe.ObjectOpened++;if(FactoryProbe.Fault=="open-late")Thread.Sleep(200);return new IndependentButtonObject();}
    public SaveButtonMetadata Read() {throw new Exception("端口不是对象");}
    public void Act() {throw new Exception("端口不是对象");}
    public void Dispose() {FactoryProbe.PortDisposed++;}
}
internal sealed class IndependentButtonObject : IAIbrowseButtonAccessible {
    public SaveButtonMetadata Read() {if(++FactoryProbe.Reads==1&&FactoryProbe.Fault=="read-late")Thread.Sleep(200);return new SaveButtonMetadata{HResult=0,Role=43,State=0,Name="保存",DefaultAction="按下"};}
    public void Act() {FactoryProbe.Writes++;}
    public void Dispose() {FactoryProbe.ObjectDisposed++;}
}
public static class NativeDeadlineIndependent {
    private static List<DeadlineEvidence> results=new List<DeadlineEvidence>();
    private static void Test(string name,Func<bool> action) {bool pass=false;try{pass=action();}catch{}results.Add(new DeadlineEvidence{name=name,pass=pass});}
    private static bool Reject(Action action) {try{action();return false;}catch{return true;}}
    private static AIbrowseFilenameDeadline Clock(int age) {return new AIbrowseFilenameDeadline(Stopwatch.GetTimestamp()-Stopwatch.Frequency*age/1000,Stopwatch.Frequency);}
    private static AIbrowseNativeSaveControl Control(AIbrowseFilenameDeadline clock) {return AIbrowseFilenamePorts.Control(101,"1000",@"D:\synthetic\fixture.exe",new IntPtr(10),new IntPtr(11),new IntPtr(12),clock);}
    private static AIbrowseNativeSaveButton Button(AIbrowseFilenameDeadline clock) {return AIbrowseFilenamePorts.Button(101,"1000",@"D:\synthetic\fixture.exe",new IntPtr(10),new IntPtr(11),new IntPtr(12),"保存",clock);}
    private static AIbrowseNativeFilenameValue Value(AIbrowseFilenameDeadline clock) {return AIbrowseFilenamePorts.Value(101,"1000",@"D:\synthetic\fixture.exe",new IntPtr(10),new IntPtr(11),new IntPtr(12),clock);}
    public static DeadlineEvidence[] Run(string target) {
        foreach(string which in new[]{"value","button"}) {string kind=which;
            foreach(string fault in new[]{"read-late","open-late","fresh"}) {string scenario=fault;
                Test("实际工厂/适配/释放"+kind+scenario,()=>{
                    FactoryProbe.Reset(scenario);var clock=Clock(scenario=="fresh"?0:29900);bool rejected;
                    if(kind=="value") {using(var tool=Value(clock)){rejected=Reject(()=>tool.WriteTarget(target,"AIbrowse-backup"));}}
                    else {using(var tool=Button(clock)){rejected=Reject(()=>tool.Act());}}
                    return rejected==(scenario!="fresh")&&FactoryProbe.Writes==(scenario=="fresh"?1:0)&&FactoryProbe.Ports==1&&FactoryProbe.PortDisposed==1&&FactoryProbe.ObjectOpened==1&&FactoryProbe.ObjectDisposed==1;
                });
            }
        }
        foreach(string fault in new[]{"identity-late","fresh"}) {string scenario=fault;
            Test("实际WM工厂/适配"+scenario,()=>{FactoryProbe.Reset(scenario);var clock=Clock(scenario=="fresh"?0:29900);bool rejected;using(var tool=Control(clock)){rejected=Reject(()=>tool.WriteTarget(target));}return rejected==(scenario!="fresh")&&FactoryProbe.Writes==(scenario=="fresh"?1:0)&&FactoryProbe.PortDisposed==1;});
        }
        Test("构造身份失败仍释放",()=>{FactoryProbe.Reset("identity-fail");return Reject(()=>Control(Clock(0)))&&FactoryProbe.Ports==1&&FactoryProbe.PortDisposed==1;});
        Test("工厂拒绝已迟到且不打开端口",()=>{FactoryProbe.Reset("fresh");var clock=Clock(29900);Thread.Sleep(200);return Reject(()=>Control(clock))&&Reject(()=>Value(clock))&&Reject(()=>Button(clock))&&FactoryProbe.Ports==0;});
        Test("未来起点拒绝",()=>Reject(()=>new AIbrowseFilenameDeadline(Stopwatch.GetTimestamp()+Stopwatch.Frequency,Stopwatch.Frequency)));
        Test("起点零拒绝",()=>Reject(()=>new AIbrowseFilenameDeadline(0,Stopwatch.Frequency)));
        Test("跨进程频率失配拒绝",()=>Reject(()=>new AIbrowseFilenameDeadline(Stopwatch.GetTimestamp(),Stopwatch.Frequency+1)));
        Test("原时钟保留起点",()=>{var clock=Clock(29000);return clock.ElapsedMilliseconds>=29000&&clock.ElapsedMilliseconds<30000;});
        return results.ToArray();
    }
}
'@
$portsPath=Join-Path $Evidence 'deadline-tests.cs'; [IO.File]::WriteAllText($portsPath,$ports)
$valueSource=[IO.File]::ReadAllText((Join-Path $candidate 'NativeFilenameValueCandidate.cs'))
$substitutions=[ordered]@{
    'new Win32SaveControlPort(pid, created, image, owner, dialog, edit, Stopwatch.StartNew())'='FactoryProbe.Control(pid, created, image, owner, dialog, edit, Stopwatch.StartNew())'
    'new Win32SaveButtonPort(pid, created, image, owner, dialog, button, 1, Stopwatch.StartNew())'='FactoryProbe.Button(pid, created, image, owner, dialog, button, 1, Stopwatch.StartNew())'
    'new FilenameValueAccessible(edit, deadline)'='FactoryProbe.ValueObject(edit, deadline)'
}
foreach($entry in $substitutions.GetEnumerator()) {
    if([regex]::Matches($valueSource,[regex]::Escape($entry.Key)).Count -ne 1) { throw '独立原生边界替换不唯一' }
    $valueSource=$valueSource.Replace($entry.Key,$entry.Value)
}
$valuePath=Join-Path $Evidence 'actual-value-factories.cs'; [IO.File]::WriteAllText($valuePath,$valueSource)
Add-Type -Path @((Join-Path $candidate 'NativeSaveControl.cs'),(Join-Path $candidate 'NativeSaveButton.cs'),$valuePath,$portsPath)
$deadline=[NativeDeadlineIndependent]::Run((Join-Path $Evidence 'never-created.aibak'))
$flatResults=Get-Content -LiteralPath (Join-Path $Evidence 'flat-results.json') -Raw | ConvertFrom-Json
$freeze=Get-Content -LiteralPath (Join-Path $repository 'log/stage7-e2/native-filename-commit-repair-001/freeze.json') -Raw | ConvertFrom-Json
$bindings=@($freeze.files | ForEach-Object { $actual=(Get-FileHash -LiteralPath (Join-Path $repository $_.path) -Algorithm SHA256).Hash.ToLowerInvariant(); [pscustomobject]@{path=$_.path;sha256=$actual;matches=$actual -ceq $_.sha256} })
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $candidate 'run-native-filename-commit-qualification.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0) {throw '实际helper解析失败'}
$wiring=@()
foreach($method in @('Control','Button','Value')) {
    $calls=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Expression.Extent.Text -ceq '[AIbrowseFilenamePorts]' -and $node.Member.Value -ceq $method},$true))
    $wiring+=[pscustomobject]@{name="helper实际工厂接线$method";pass=$calls.Count -eq 1 -and $calls[0].Arguments[-1].Extent.Text -ceq '$deadline'}
}
$legacy=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Expression.Extent.Text -cin @('[AIbrowseNativeSaveControl]','[AIbrowseNativeSaveButton]','[AIbrowseNativeFilenameValue]') -and $node.Member.Value -ceq 'new'},$true))
$wiring+=[pscustomobject]@{name='helper无旧独立时钟构造入口';pass=$legacy.Count -eq 0}
$calls=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Expression.Extent.Text -ceq '[AIbrowseFilenameDeadline]'},$true))
$wiring+=[pscustomobject]@{name='helper握手原时钟唯一实例';pass=$calls.Count -eq 1 -and $calls[0].Arguments[0].Extent.Text -ceq '$uiStartedTick' -and $calls[0].Arguments[1].Extent.Text -ceq '[long]$identity.frequency'}
$results=@($flatResults)+@($deadline)+$wiring
$output=[ordered]@{version=1;actualUi=$false;actualCom=$false;actualJob=$false;sourceBindings=$bindings;passed=@($results | Where-Object pass).Count;failed=@($results | Where-Object { -not $_.pass }).Count;checks=$results}
[IO.File]::WriteAllText((Join-Path $Evidence 'results.json'),($output|ConvertTo-Json -Depth 8))
$output|ConvertTo-Json -Depth 8
if($output.failed -gt 0) { exit 1 }
