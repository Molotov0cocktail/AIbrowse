[CmdletBinding()]
param([Parameter(Mandatory)][string]$Evidence)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(Test-Path -LiteralPath $Evidence){throw '原件已存在'}
[void][IO.Directory]::CreateDirectory($Evidence)
$Evidence=[IO.Path]::GetFullPath($Evidence)
$source=@'
using System;
using System.Diagnostics;
using System.Threading;
using System.Collections.Generic;
public sealed class DeadlineCheck { public string name; public bool pass; }
internal sealed class ClockControl : IAIbrowseSaveControlPort {
    internal string text="AIbrowse-backup";
    internal int writes, reads, identities, delayIdentity;
    public long ElapsedMilliseconds { get { return 0; } }
    public bool IdentityMatches() { if(++identities==delayIdentity)Thread.Sleep(90);return true; }
    public ulong ReadLength(uint timeout){return (ulong)text.Length;}
    public string ReadText(uint timeout){reads++;return text;}
    public bool WriteTarget(string value,uint timeout){writes++;text=value;return true;}
    public void Dispose(){}
}
internal sealed class ClockButton : IAIbrowseSaveButtonPort, IAIbrowseButtonAccessible {
    internal int reads, actions; internal bool delay;
    public long ElapsedMilliseconds { get { return 0; } }
    public bool IdentityMatches(){return true;}
    public IAIbrowseButtonAccessible OpenAccessible(){return this;}
    public SaveButtonMetadata Read(){if(++reads==1&&delay)Thread.Sleep(90);return new SaveButtonMetadata{HResult=0,Role=43,State=0,Name="保存",DefaultAction="按下"};}
    public void Act(){actions++;}
    public void Dispose(){}
}
internal sealed class ClockValue : IFilenameValuePort, IFilenameValueAccessible {
    internal int reads,puts; internal bool delay; private string text="AIbrowse-backup";
    public long Elapsed { get { return 0; } }
    public void Validate(){}
    public string ReadNative(){return text;}
    public IFilenameValueAccessible Open(){return this;}
    public FilenameValueMetadata Read(){if(++reads==1&&delay)Thread.Sleep(90);return new FilenameValueMetadata{HResult=0,ExactWindow=true,Name="文件名",Value=text,Role=42,State=0};}
    public int Put(string value){puts++;text=value;return 0;}
    public void Dispose(){}
}
public static class FilenameDeadlineRepairTests {
    private static List<DeadlineCheck> checks=new List<DeadlineCheck>();
    private static void Test(string name,Func<bool> action){bool pass=false;try{pass=action();}catch{}checks.Add(new DeadlineCheck{name=name,pass=pass});}
    private static bool Reject(Action action){try{action();return false;}catch{return true;}}
    private static AIbrowseFilenameDeadline Clock(int age){return new AIbrowseFilenameDeadline(Stopwatch.GetTimestamp()-Stopwatch.Frequency*age/1000,Stopwatch.Frequency);}
    public static DeadlineCheck[] Run(string target){
        Test("原始tick拒绝零",()=>Reject(()=>new AIbrowseFilenameDeadline(0,Stopwatch.Frequency)));
        Test("原始tick拒绝未来",()=>Reject(()=>new AIbrowseFilenameDeadline(Stopwatch.GetTimestamp()+Stopwatch.Frequency,Stopwatch.Frequency)));
        Test("频率不一致拒绝",()=>Reject(()=>new AIbrowseFilenameDeadline(Stopwatch.GetTimestamp(),Stopwatch.Frequency+1)));
        Test("已经迟到拒绝",()=>Reject(()=>Clock(30001)));
        Test("原时钟不重置",()=>{var clock=Clock(29000);return clock.ElapsedMilliseconds>=29000&&clock.ElapsedMilliseconds<30000;});
        Test("WM身份读取跨期限不写入",()=>{var port=new ClockControl{delayIdentity=2};using(var value=new AIbrowseNativeSaveControl(new FilenameDeadlineControlPort(port,Clock(29950)))){return Reject(()=>value.WriteTarget(target))&&port.writes==0;}});
        Test("MSAA值读取跨期限不写入",()=>{var port=new ClockValue{delay=true};using(var value=new AIbrowseNativeFilenameValue(new FilenameDeadlineValuePort(port,Clock(29950)))){return Reject(()=>value.WriteTarget(target,"AIbrowse-backup"))&&port.puts==0;}});
        Test("MSAA按钮读取跨期限不保存",()=>{var port=new ClockButton{delay=true};using(var value=new AIbrowseNativeSaveButton(new FilenameDeadlineButtonPort(port,Clock(29950)),1,"保存")){return Reject(()=>value.Act())&&port.actions==0;}});
        Test("WM新鲜控制可写",()=>{var port=new ClockControl();using(var value=new AIbrowseNativeSaveControl(new FilenameDeadlineControlPort(port,Clock(0)))){value.WriteTarget(target);return port.writes==1;}});
        Test("MSAA新鲜值可写",()=>{var port=new ClockValue();using(var value=new AIbrowseNativeFilenameValue(new FilenameDeadlineValuePort(port,Clock(0)))){value.WriteTarget(target,"AIbrowse-backup");return port.puts==1;}});
        Test("MSAA新鲜按钮可保存一次",()=>{var port=new ClockButton();using(var value=new AIbrowseNativeSaveButton(new FilenameDeadlineButtonPort(port,Clock(0)),1,"保存")){value.Act();return Reject(()=>value.Act())&&port.actions==1;}});
        Test("按钮可访问对象迟到也关闭",()=>{var port=new ClockButton();var clock=Clock(29950);using(var value=new FilenameDeadlineButtonAccessible(port,clock)){Thread.Sleep(90);return Reject(()=>value.Act())&&port.actions==0;}});
        return checks.ToArray();
    }
}
'@
$test=Join-Path $Evidence 'deadline-tests.cs';[IO.File]::WriteAllText($test,$source)
Add-Type -Path @((Join-Path $PSScriptRoot 'NativeSaveControl.cs'),(Join-Path $PSScriptRoot 'NativeSaveButton.cs'),(Join-Path $PSScriptRoot 'NativeFilenameValueCandidate.cs'),$test)
$results=@([FilenameDeadlineRepairTests]::Run((Join-Path $Evidence 'never-created.aibak')))
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'run-native-filename-commit-qualification.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw '运行源码解析失败'}
foreach($method in @('Control','Value','Button')){
    $calls=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Expression.Extent.Text -ceq '[AIbrowseFilenamePorts]' -and $node.Member.Value -ceq $method},$true))
    $results+=[pscustomobject]@{name="实际helper接原期限$method";pass=$calls.Count -eq 1 -and $calls[0].Arguments[-1].Extent.Text -ceq '$deadline'}
}
$calls=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Expression.Extent.Text -ceq '[AIbrowseFilenameDeadline]'},$true))
$results+=[pscustomobject]@{name='实际helper使用握手原tick和频率';pass=$calls.Count -eq 1 -and $calls[0].Arguments[0].Extent.Text -ceq '$uiStartedTick' -and $calls[0].Arguments[1].Extent.Text -ceq '[long]$identity.frequency'}
$fixture=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'NativeFilenameDialogFixture.cs'))
$start=$fixture.IndexOf('    public static class ReceiptGate',[StringComparison]::Ordinal)
$end=$fixture.IndexOf('    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',[StringComparison]::Ordinal)
if($start -lt 0 -or $end -le $start){throw '实际解析器边界失配'}
$parserSource='using System; using System.Collections.Generic; using System.IO; using System.Text; using System.Text.RegularExpressions; using System.Web.Script.Serialization; namespace AIbrowse.FilenameQualification {'+$fixture.Substring($start,$end-$start)+'}'
$parserTests=@'
using System;
using System.IO;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using AIbrowse.FilenameQualification;
public static class ParserRepairTests {
    public static int Main(string[] args){
        string[] bodies={
            "{\"version\":1,\"value\":\"safe\"}",
            "{\"version\":-1,\"value\":\"escaped \\\"value\\\":1 \\u4f60 \\\\ /\"}",
            "{\"version\":1,\"version\":2,\"value\":\"safe\"}",
            "{\"version\":1,\"\\u0076ersion\":2,\"value\":\"safe\"}",
            "{\"\\u0076ersion\":2,\"version\":1,\"value\":\"safe\"}",
            "{\"version\":1,\"value\":\"safe\",\"\\u0076alue\":\"overwritten\"}",
            "{\"version\":1,\"value\":\"safe\",\"unknown\":1}",
            "{\"version\":1,\"value\":{\"child\":1}}",
            "{\"version\":1,\"value\":null}",
            "{\"version\":1.2,\"value\":\"safe\"}",
            "{\"version\":1,\"value\":\"safe\",}",
            "{\"version\":1,\"value\":\"safe\"}{}",
            "{\"version\":01,\"value\":\"safe\"}",
            "{\"version\":9223372036854775808,\"value\":\"safe\"}",
            "{\"version\":1,\"value\":\"\\q\"}",
            "{\"version\":1,\"value\":\"raw\nline\"}",
            "{\"version\":1,\"value\":[]}",
            "{\"version\":1}"
        };
        var results=new List<object>();
        for(int index=0;index<bodies.Length;index++){
            string path=Path.Combine(args[0],"parser-"+index+".json");File.WriteAllText(path,bodies[index]);
            bool rejected=false;try{FlatJson.Read(path,"version","value");}catch{rejected=true;}
            results.Add(new{name="C#完整词法反例"+index,pass=rejected==(index>=2)});
        }
        File.WriteAllText(Path.Combine(args[0],"parser-results.json"),new JavaScriptSerializer().Serialize(results));return 0;
    }
}
'@
$parserPath=Join-Path $Evidence 'actual-parser.cs';$parserTestPath=Join-Path $Evidence 'parser-tests.cs'
[IO.File]::WriteAllText($parserPath,$parserSource);[IO.File]::WriteAllText($parserTestPath,$parserTests)
$program=Join-Path $Evidence 'parser-tests.exe'
& (Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe') /nologo /target:exe /platform:x64 /r:System.Web.Extensions.dll "/out:$program" $parserPath $parserTestPath *> (Join-Path $Evidence 'parser-compile.txt')
if($LASTEXITCODE -ne 0){throw '解析器纯测试编译失败'}
& $program $Evidence
if($LASTEXITCODE -ne 0){throw '解析器纯测试运行失败'}
$results+=@(Get-Content -LiteralPath (Join-Path $Evidence 'parser-results.json') -Raw|ConvertFrom-Json)
$output=[ordered]@{version=1;actualUi=$false;actualCom=$false;actualJob=$false;passed=@($results|Where-Object pass).Count;failed=@($results|Where-Object {-not $_.pass}).Count;checks=$results}
[IO.File]::WriteAllText((Join-Path $Evidence 'results.json'),($output|ConvertTo-Json -Depth 5))
$output|ConvertTo-Json -Depth 5
if($output.failed -gt 0){exit 1}
