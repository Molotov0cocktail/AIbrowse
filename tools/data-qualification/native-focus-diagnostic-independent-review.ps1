[CmdletBinding()]
param([Parameter(Mandatory)][string]$Evidence)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(Test-Path -LiteralPath $Evidence){throw '独审原件目录已存在'}
[void][IO.Directory]::CreateDirectory($Evidence)
$Evidence=[IO.Path]::GetFullPath($Evidence)
$candidate=Join-Path $PSScriptRoot 'product-transfer'
$native=[IO.File]::ReadAllText((Join-Path $candidate 'NativeFilenameFocus.cs'))
$replacements=[ordered]@{
    'IsWindow'='private static bool IsWindow(IntPtr window) {return DiagnosticNativeFake.Mode!="gone";}'
    'IsWindowVisible'='private static bool IsWindowVisible(IntPtr window) {return DiagnosticNativeFake.Mode!="hidden";}'
    'IsWindowEnabled'='private static bool IsWindowEnabled(IntPtr window) {return DiagnosticNativeFake.Mode!="disabled";}'
    'GetAncestor'='private static IntPtr GetAncestor(IntPtr window,uint flags) {if(flags!=2)throw new Exception("祖先种类失配");return new IntPtr(DiagnosticNativeFake.Mode=="ancestor"?99:10);}'
    'GetWindowThreadProcessId'='private static uint GetWindowThreadProcessId(IntPtr window,out uint pid) {bool dialog=window.ToInt64()==10;pid=(DiagnosticNativeFake.Mode==(dialog?"dialog-pid":"control-pid"))?999u:100u;if(DiagnosticNativeFake.Mode=="thread-zero")return 0;return DiagnosticNativeFake.Mode=="thread-mismatch"&&dialog?78u:77u;}'
    'GetGUIThreadInfo'='private static bool GetGUIThreadInfo(uint thread,ref GuiThreadInfo info) {DiagnosticNativeFake.Calls++;DiagnosticNativeFake.Thread=thread;DiagnosticNativeFake.Size=info.Size;if(DiagnosticNativeFake.Mode=="late")System.Threading.Thread.Sleep(200);if(DiagnosticNativeFake.Mode=="throw")throw new COMException("PRIVATE_CANARY_DO_NOT_EMIT");info.Active=new IntPtr(DiagnosticNativeFake.Mode=="active"?99:10);info.Focus=new IntPtr(DiagnosticNativeFake.Selected);return DiagnosticNativeFake.Mode!="gui-false";}'
}
foreach($entry in $replacements.GetEnumerator()) {
    $pattern='\[DllImport\([^\]]+\)\]\s*private static extern [^;]+\b'+$entry.Key+'\([^;]+;'
    if([regex]::Matches($native,$pattern).Count -ne 1){throw '原生替身边界不唯一'}
    $native=[regex]::Replace($native,$pattern,$entry.Value)
}
if($native.Contains('[DllImport')){throw '焦点测试仍含原生API'}
$nativePath=Join-Path $Evidence 'actual-focus-with-native-ports.cs';[IO.File]::WriteAllText($nativePath,$native)
$source=@'
using System;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class DiagnosticNativeFake {
    public static string Mode="fresh",UiMode="fresh";
    public static long Selected=11;
    public static uint Thread,Size;
    public static int Calls,EditCalls,SaveCalls,OtherCalls;
    public static void Reset(string mode){Mode=mode;UiMode="fresh";Selected=11;Thread=Size=0;Calls=EditCalls=SaveCalls=OtherCalls=0;}
}
public sealed class SecretException : Exception { public override string Message {get{throw new Exception("消息不可读取");}} }
public static class DiagnosticIndependent {
    private static List<object> results=new List<object>();
    private static bool Reject(Action action){try{action();return false;}catch{return true;}}
    private static void Test(string name,Func<bool> run){bool pass=false;try{pass=run();}catch{}results.Add(new{name=name,pass=pass});}
    public static AIbrowseFilenameDeadline Clock(int age=0){return new AIbrowseFilenameDeadline(Stopwatch.GetTimestamp()-Stopwatch.Frequency*age/1000,Stopwatch.Frequency);}
    private static AIbrowseNativeFilenameFocus Make(AIbrowseFilenameDeadline clock=null){return new AIbrowseNativeFilenameFocus(100,new IntPtr(10),new IntPtr(11),new IntPtr(12),clock??Clock());}
    public static object[] Run(){
        string[,] pairs={{"fresh","matched"},{"gone","window-missing"},{"hidden","window-hidden"},{"disabled","window-disabled"},{"ancestor","root-mismatch"},{"dialog-pid","owner-mismatch"},{"control-pid","owner-mismatch"},{"thread-zero","thread-mismatch"},{"thread-mismatch","thread-mismatch"},{"active","active-mismatch"},{"gui-false","gui-query-failed"}};
        for(int i=0;i<pairs.GetLength(0);i++){string mode=pairs[i,0],judgment=pairs[i,1];
            Test("实际诊断端口分类 "+mode,()=>{DiagnosticNativeFake.Reset(mode);var result=Make().InspectEditDiagnostic();bool read=mode=="fresh"||mode=="active",query=read||mode=="gui-false";return result.Judgment==judgment&&result.FocusRead==read&&result.Focus==(read?"edit":"none")&&result.Matched==(mode=="fresh")&&DiagnosticNativeFake.Calls==(query?1:0)&&(!query||(DiagnosticNativeFake.Thread==77&&DiagnosticNativeFake.Size==72));});
        }
        Test("无效目标不调用GUI线程API",()=>{DiagnosticNativeFake.Reset("fresh");return new FilenameFocusPort(0,new IntPtr(10),new IntPtr(11),new IntPtr(12)).Inspect(new IntPtr(11)).Judgment=="target-invalid"&&DiagnosticNativeFake.Calls==0;});
        long[] selected={0,11,12,10,991337};string[] projections={"none","edit","save","dialog","other"};
        for(int i=0;i<selected.Length;i++){long handle=selected[i];string expected=projections[i];Test("实际焦点有限投影 "+expected,()=>{DiagnosticNativeFake.Reset("fresh");DiagnosticNativeFake.Selected=handle;var result=Make().InspectEditDiagnostic();return result.Focus==expected&&result.FocusRead&&result.Matched==(handle==11)&&result.Judgment==(handle==11?"matched":"focus-mismatch");});}
        Test("诊断API返回越过原期拒绝",()=>{DiagnosticNativeFake.Reset("late");return Reject(()=>Make(Clock(29900)).InspectEditDiagnostic())&&DiagnosticNativeFake.Calls==1;});
        Test("诊断成功或失败均不可重读及转保存",()=>{foreach(string mode in new[]{"fresh","active","throw"}){DiagnosticNativeFake.Reset(mode);var focus=Make();try{focus.InspectEditDiagnostic();}catch{}if(!Reject(()=>focus.InspectEditDiagnostic())||!Reject(focus.AcceptEdit)||!Reject(focus.AcceptSave)||DiagnosticNativeFake.Calls!=1)return false;}return true;});
        Test("已超原期不进入原生查询",()=>{DiagnosticNativeFake.Reset("fresh");return Reject(()=>Make(Clock(30100)).InspectEditDiagnostic())&&DiagnosticNativeFake.Calls==0;});
        Test("异常固定类别及正文不可读",()=>{Exception[] errors={new SecretException(),new InvalidOperationException("PRIVATE_CANARY_DO_NOT_EMIT"),new COMException("PRIVATE_CANARY_DO_NOT_EMIT"),new TimeoutException(),new UnauthorizedAccessException(),new ArgumentException(),null};string[] expected={"other","invalid-operation","com","timeout","access-denied","argument","other"};for(int i=0;i<errors.Length;i++)if(AIbrowseNativeFilenameFocus.ClassifyException(errors[i])!=expected[i])return false;return true;});
        Test("已知包装解包及深度上限",()=>{Exception error=new COMException("PRIVATE_CANARY_DO_NOT_EMIT");for(int i=0;i<3;i++)error=new TargetInvocationException(error);if(AIbrowseNativeFilenameFocus.ClassifyException(error)!="com")return false;return AIbrowseNativeFilenameFocus.ClassifyException(new TargetInvocationException(error))=="other";});
        return results.ToArray();
    }
}
'@
$test=Join-Path $Evidence 'diagnostic-tests.cs';[IO.File]::WriteAllText($test,$source)
Add-Type -Path @((Join-Path $candidate 'NativeSaveControl.cs'),(Join-Path $candidate 'NativeSaveButton.cs'),(Join-Path $candidate 'NativeFilenameValueCandidate.cs'),$nativePath,$test)
$checks=@([DiagnosticIndependent]::Run())
$runner=[IO.File]::ReadAllText((Join-Path $candidate 'run-native-filename-commit-qualification.ps1'))
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($runner,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw '实际helper解析失败'}
$start=$runner.IndexOf('        $focus=[AIbrowseNativeFilenameFocus]::new',[StringComparison]::Ordinal)
$end=$runner.IndexOf('    finally {',$start,[StringComparison]::Ordinal)
if($start -lt 0 -or $end -le $start){throw '实际helper动作片段不唯一'}
$fragment='try {'+[Environment]::NewLine+$runner.Substring($start,$end-$start)
[IO.File]::WriteAllText((Join-Path $Evidence 'actual-helper-fragment.ps1'),$fragment)
$reportNode=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -ceq '$report'},$true))[0]
$reportText=$reportNode.Right.Extent.Text
function Recheck { if([DiagnosticNativeFake]::UiMode -eq 'recheck-throws'){throw [InvalidOperationException]::new('PRIVATE_CANARY_DO_NOT_EMIT')}; $deadline.Check() }
function Check-Time {param([long]$Limit) $deadline.Check() }
$scope=Join-Path $Evidence 'synthetic-scope'
[void][IO.Directory]::CreateDirectory((Join-Path $scope 'default'))
[void][IO.Directory]::CreateDirectory((Join-Path $scope 'published'))
$productPid=100; $dialog=[IntPtr]10; $saveHandle=[IntPtr]12
$edit=[pscustomobject]@{};$edit|Add-Member ScriptMethod SetFocus { [DiagnosticNativeFake]::EditCalls++;if([DiagnosticNativeFake]::UiMode -eq 'edit-throws'){throw [InvalidOperationException]::new('PRIVATE_CANARY_DO_NOT_EMIT')};if([DiagnosticNativeFake]::UiMode -eq 'edit-late'){Start-Sleep -Milliseconds 200} }
$save=[pscustomobject]@{};$save|Add-Member ScriptMethod SetFocus { [DiagnosticNativeFake]::SaveCalls++;throw '禁止第二次焦点' }
$binding=@{handle=[IntPtr]11;edit=$edit;save=$save}
$native=[pscustomobject]@{};$native|Add-Member ScriptMethod ReadText { [DiagnosticNativeFake]::OtherCalls++;throw '禁止文本读取' }
$value=[pscustomobject]@{};$value|Add-Member ScriptMethod Inspect {param($initial) [DiagnosticNativeFake]::OtherCalls++;throw '禁止MSAA读取'}
$value|Add-Member ScriptMethod WriteTarget {param($target,$initial) [DiagnosticNativeFake]::OtherCalls++;throw '禁止写入' }
$button=[pscustomobject]@{};$button|Add-Member ScriptMethod Inspect { [DiagnosticNativeFake]::OtherCalls++;throw '禁止按钮MSAA读取' }
$button|Add-Member ScriptMethod Act { [DiagnosticNativeFake]::OtherCalls++;throw '禁止保存' }
$Purpose='focus-diagnostic';$Case='candidate'
foreach($mode in @('fresh','edit-throws','recheck-throws','native-throws','edit-late','native-late','already-expired','focus-other','active','hidden','gui-false')) {
    [DiagnosticNativeFake]::Reset('fresh');[DiagnosticNativeFake]::UiMode=$mode
    if($mode -eq 'native-throws'){[DiagnosticNativeFake]::Mode='throw'}
    if($mode -eq 'native-late'){[DiagnosticNativeFake]::Mode='late'}
    if($mode -in @('active','hidden','gui-false')){[DiagnosticNativeFake]::Mode=$mode}
    if($mode -eq 'focus-other'){[DiagnosticNativeFake]::Selected=991337}
    $deadline=[DiagnosticIndependent]::Clock($(if($mode -in @('edit-late','native-late','already-expired')){29900}else{0}))
    if($mode -eq 'already-expired'){Start-Sleep -Milliseconds 200}
    $report= & ([scriptblock]::Create($reportText))
    . ([scriptblock]::Create($fragment))
    $expectedPhase=switch($mode){'edit-throws'{'edit-focus-call'} 'recheck-throws'{'edit-focus-recheck'} 'edit-late'{'edit-focus-recheck'} 'native-throws'{'edit-focus-native'} 'native-late'{'edit-focus-native'} 'already-expired'{'preflight'} default{'diagnostic-complete'}}
    $expectedNative=switch($mode){'fresh'{'matched'} 'focus-other'{'focus-mismatch'} 'active'{'active-mismatch'} 'hidden'{'window-hidden'} 'gui-false'{'gui-query-failed'} default{'not-read'}}
    $expectedFocus=switch($mode){'fresh'{'edit'} 'focus-other'{'other'} 'active'{'edit'} default{'none'}}
    $actual=$report|ConvertTo-Json -Compress
    $checks+=[pscustomobject]@{name="实际helper诊断分支 $mode";pass=([DiagnosticNativeFake]::EditCalls -eq $(if($mode -eq 'already-expired'){0}else{1}) -and [DiagnosticNativeFake]::SaveCalls -eq 0 -and [DiagnosticNativeFake]::OtherCalls -eq 0 -and -not $report.ok -and -not $report.msaaQualified -and $report.writes -eq 0 -and $report.saveActions -eq 0 -and -not $report.saveFocusVerified -and $report.phase -ceq $expectedPhase -and $report.nativeFocus -ceq $expectedNative -and $report.focus -ceq $expectedFocus -and $report.focusRead -eq ($mode -in @('fresh','focus-other','active')) -and $report.editFocusVerified -eq ($mode -eq 'fresh') -and -not $actual.Contains('PRIVATE_CANARY_DO_NOT_EMIT') -and -not $actual.Contains('991337'));editCalls=[DiagnosticNativeFake]::EditCalls;saveCalls=[DiagnosticNativeFake]::SaveCalls;otherCalls=[DiagnosticNativeFake]::OtherCalls;receipt=$report}
}
$purposeNode=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-Purpose'},$true))
if($purposeNode.Count -ne 1){throw '目的函数不唯一'}
. ([scriptblock]::Create($purposeNode[0].Extent.Text))
$purposePass=$true
foreach($pair in @(@('focus-diagnostic','focus-diagnostic',$true),@('qualification','focus-diagnostic',$false),@('focus-diagnostic','qualification',$false),@('focus-diagnostic','Focus-diagnostic',$false),@('focus-diagnostic',1,$false),@('unknown','unknown',$false))) {
    $accepted=$true;try{Assert-Purpose $pair[0] $pair[1]}catch{$accepted=$false};if($accepted -ne $pair[2]){$purposePass=$false}
}
$checks+=[pscustomobject]@{name='实际目的函数闭合及精确匹配';pass=$purposePass}
$diagnosticIf=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Clauses[0].Item1.Extent.Text -ceq '$Purpose -ceq ''focus-diagnostic'''},$true))
$diagBody=$diagnosticIf[0].Clauses[0].Item2.Extent.Text
$checks+=[pscustomobject]@{name='诊断语法分支无法进入资格动作';pass=$diagnosticIf.Count -eq 1 -and -not [regex]::IsMatch($diagBody,'SetFocus|WriteTarget|\.Inspect\(|\.Act\(') -and $diagnosticIf[0].ElseClause.Extent.Text.Contains('$binding.save.SetFocus()') -and $runner.Contains('if ($Purpose -ceq ''qualification'') { $value = [AIbrowseFilenamePorts]::Value(')}
$runStart=$runner.IndexOf('        if ([string]::IsNullOrEmpty($ScopeId))');$run=$runner.Substring($runStart)
$helper=$runner.Substring($runner.IndexOf("if (`$Mode -ceq 'Helper')"),$runStart-$runner.IndexOf("if (`$Mode -ceq 'Helper')"))
$checks+=[pscustomobject]@{name='Run和Helper目的错配在加载与Job之前拒绝';pass=$run.IndexOf('Assert-Purpose $Purpose $build.purpose') -lt $run.IndexOf('[void][Reflection.Assembly]::LoadFrom') -and $helper.IndexOf('Assert-Purpose $Purpose $runtime.purpose') -lt $helper.IndexOf('[void][Reflection.Assembly]::LoadFrom') -and $runner.Contains('$qualified=$Purpose -ceq ''qualification'' -and')}
$fixture=[IO.File]::ReadAllText((Join-Path $candidate 'NativeFilenameDialogFixture.cs'))
$checks+=[pscustomobject]@{name='固定单case及目的贯穿回执';pass=[regex]::Matches($fixture,'Case\(scope, "candidate", pwsh, purpose\)').Count -eq 1 -and $fixture.Contains('" -Purpose " + purpose') -and $fixture.Contains('if(purpose!="qualification" && purpose!="focus-diagnostic")return 2;') -and $fixture.Contains('{"purpose",purpose}') -and [regex]::Matches($runner,'purpose=\$Purpose').Count -eq 5 -and $runner.Contains('Assert-Purpose $Purpose $campaign.purpose')}
$checks+=[pscustomobject]@{name='新增源无全局输入或原始错误投影';pass= -not [regex]::IsMatch($runner+[IO.File]::ReadAllText((Join-Path $candidate 'NativeFilenameFocus.cs')),'AttachThreadInput|SetForegroundWindow|SendKeys|SendInput|Clipboard|WM_COMMAND|error\.Message|error\.StackTrace|report\.[^=]+\s*=\s*\$_')}
$out=[ordered]@{version=1;actualUi=$false;actualCom=$false;actualJob=$false;passed=@($checks|Where-Object pass).Count;failed=@($checks|Where-Object {-not $_.pass}).Count;checks=$checks}
[IO.File]::WriteAllText((Join-Path $Evidence 'results.json'),($out|ConvertTo-Json -Depth 9))
$out|ConvertTo-Json -Depth 9
if($out.failed -gt 0){exit 1}
