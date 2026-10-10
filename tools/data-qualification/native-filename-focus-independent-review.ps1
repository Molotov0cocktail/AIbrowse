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
    'IsWindow'='private static bool IsWindow(IntPtr window) {return FocusNativeFake.Mode!="gone";}'
    'IsWindowVisible'='private static bool IsWindowVisible(IntPtr window) {return FocusNativeFake.Mode!="hidden";}'
    'IsWindowEnabled'='private static bool IsWindowEnabled(IntPtr window) {return FocusNativeFake.Mode!="disabled";}'
    'GetAncestor'='private static IntPtr GetAncestor(IntPtr window,uint flags) {if(flags!=2)throw new Exception("祖先种类失配");return new IntPtr(FocusNativeFake.Mode=="ancestor"?99:10);}'
    'GetWindowThreadProcessId'='private static uint GetWindowThreadProcessId(IntPtr window,out uint pid) {bool dialog=window.ToInt64()==10;pid=(FocusNativeFake.Mode==(dialog?"dialog-pid":"control-pid"))?999u:100u;if(FocusNativeFake.Mode=="thread-zero")return 0;return FocusNativeFake.Mode=="thread-mismatch"&&dialog?78u:77u;}'
    'GetGUIThreadInfo'='private static bool GetGUIThreadInfo(uint thread,ref GuiThreadInfo info) {FocusNativeFake.Calls++;FocusNativeFake.Thread=thread;FocusNativeFake.Size=info.Size;if(FocusNativeFake.Mode=="late")System.Threading.Thread.Sleep(200);if(FocusNativeFake.Mode=="throw")throw new Exception("合成错误");info.Active=new IntPtr(FocusNativeFake.Mode=="active"?99:10);info.Focus=new IntPtr(FocusNativeFake.Mode=="focus"?99:FocusNativeFake.Selected);return FocusNativeFake.Mode!="gui-false";}'
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
public static class FocusNativeFake {
    public static string Mode="fresh",Text="AIbrowse-backup",UiMode="fresh";
    public static long Selected=11;
    public static uint Thread,Size;
    public static int Calls,FocusActions,Writes,Saves;
    public static void Reset(string mode){Mode=mode;Text="AIbrowse-backup";UiMode="fresh";Selected=11;Thread=Size=0;Calls=FocusActions=Writes=Saves=0;}
}
public static class FocusIndependent {
    private static List<object> results=new List<object>();
    private static bool Reject(Action action){try{action();return false;}catch{return true;}}
    private static void Test(string name,Func<bool> run){bool pass=false;try{pass=run();}catch{}results.Add(new{name=name,pass=pass});}
    public static AIbrowseFilenameDeadline Clock(int age=0){return new AIbrowseFilenameDeadline(Stopwatch.GetTimestamp()-Stopwatch.Frequency*age/1000,Stopwatch.Frequency);}
    private static AIbrowseNativeFilenameFocus Make(AIbrowseFilenameDeadline clock=null){return new AIbrowseNativeFilenameFocus(100,new IntPtr(10),new IntPtr(11),new IntPtr(12),clock??Clock());}
    public static object[] Run(){
        foreach(string mode in new[]{"fresh","gone","hidden","disabled","ancestor","dialog-pid","control-pid","thread-zero","thread-mismatch","active","focus","gui-false","throw"}){string test=mode;
            Test("实际原生端口"+test,()=>{FocusNativeFake.Reset(test);bool rejected=Reject(Make().AcceptEdit);bool query=test=="fresh"||test=="active"||test=="focus"||test=="gui-false"||test=="throw";return rejected==(test!="fresh")&&FocusNativeFake.Calls==(query?1:0)&&(!query||(FocusNativeFake.Thread==77&&FocusNativeFake.Size==72));});
        }
        Test("GUITHREADINFO x64大小和字段偏移",()=>{var type=typeof(FilenameFocusPort).GetNestedType("GuiThreadInfo",BindingFlags.NonPublic);return Marshal.SizeOf(type)==72&&Marshal.OffsetOf(type,"Active").ToInt64()==8&&Marshal.OffsetOf(type,"Focus").ToInt64()==16&&Marshal.OffsetOf(type,"Left").ToInt64()==56&&Marshal.OffsetOf(type,"Bottom").ToInt64()==68;});
        Test("原期限跨API返回后拒绝",()=>{FocusNativeFake.Reset("late");return Reject(Make(Clock(29900)).AcceptEdit)&&FocusNativeFake.Calls==1;});
        Test("失败尝试不可重新接受",()=>{FocusNativeFake.Reset("focus");var focus=Make();bool rejected=Reject(focus.AcceptEdit);FocusNativeFake.Mode="fresh";return rejected&&Reject(focus.AcceptEdit)&&FocusNativeFake.Calls==1;});
        Test("完整两焦点次序",()=>{FocusNativeFake.Reset("fresh");var focus=Make();focus.AcceptEdit();focus.AssertEdit();FocusNativeFake.Selected=12;focus.AcceptSave();focus.AssertSave();return FocusNativeFake.Calls==4&&Reject(focus.AcceptSave)&&Reject(focus.AcceptEdit);});
        Test("保存先于编辑拒绝",()=>{FocusNativeFake.Reset("fresh");return Reject(Make().AcceptSave)&&FocusNativeFake.Calls==0;});
        Test("edit漂移拒绝",()=>{FocusNativeFake.Reset("fresh");var focus=Make();focus.AcceptEdit();FocusNativeFake.Selected=99;return Reject(focus.AssertEdit);});
        Test("save漂移拒绝",()=>{FocusNativeFake.Reset("fresh");var focus=Make();focus.AcceptEdit();FocusNativeFake.Selected=12;focus.AcceptSave();FocusNativeFake.Selected=99;return Reject(focus.AssertSave);});
        return results.ToArray();
    }
}
'@
$test=Join-Path $Evidence 'focus-tests.cs';[IO.File]::WriteAllText($test,$source)
Add-Type -Path @((Join-Path $candidate 'NativeSaveControl.cs'),(Join-Path $candidate 'NativeSaveButton.cs'),(Join-Path $candidate 'NativeFilenameValueCandidate.cs'),$nativePath,$test)
$checks=@([FocusIndependent]::Run())
$runner=[IO.File]::ReadAllText((Join-Path $candidate 'run-native-filename-commit-qualification.ps1'))
$start=$runner.IndexOf('$focus=[AIbrowseNativeFilenameFocus]::new',[StringComparison]::Ordinal)
$end=$runner.IndexOf('    } catch { $report.ok=$false }',$start,[StringComparison]::Ordinal)
if($start -lt 0 -or $end -le $start){throw '实际helper动作片段不唯一'}
$fragment=$runner.Substring($start,$end-$start)
[IO.File]::WriteAllText((Join-Path $Evidence 'actual-helper-fragment.ps1'),$fragment)
function Recheck { $deadline.Check() }
function Check-Time {param([long]$Limit) $deadline.Check() }
$scope=Join-Path $Evidence 'synthetic-scope'
[void][IO.Directory]::CreateDirectory((Join-Path $scope 'default'))
[void][IO.Directory]::CreateDirectory((Join-Path $scope 'published'))
$productPid=100; $dialog=[IntPtr]10; $saveHandle=[IntPtr]12
$edit=[pscustomobject]@{kind='edit'}
$edit|Add-Member ScriptMethod SetFocus { [FocusNativeFake]::FocusActions++;if([FocusNativeFake]::UiMode -eq 'edit-throws'){throw '合成焦点不支持'};if([FocusNativeFake]::UiMode -ne 'edit-noop'){[FocusNativeFake]::Selected=11};if([FocusNativeFake]::UiMode -eq 'edit-late'){Start-Sleep -Milliseconds 200} }
$save=[pscustomobject]@{kind='save'}
$save|Add-Member ScriptMethod SetFocus { [FocusNativeFake]::FocusActions++;if([FocusNativeFake]::UiMode -eq 'save-throws'){throw '合成焦点不支持'};if([FocusNativeFake]::UiMode -ne 'save-noop'){[FocusNativeFake]::Selected=12};if([FocusNativeFake]::UiMode -eq 'text-on-blur'){[FocusNativeFake]::Text='AIbrowse-backup'} }
$binding=@{handle=[IntPtr]11;edit=$edit;save=$save}
$native=[pscustomobject]@{};$native|Add-Member ScriptMethod ReadText {return [FocusNativeFake]::Text}
$value=[pscustomobject]@{};$value|Add-Member ScriptMethod Inspect {param($initial) return $true}
$value|Add-Member ScriptMethod WriteTarget {param($target,$initial) if([FocusNativeFake]::Selected -ne 11){throw '合成写入焦点不符'};[FocusNativeFake]::Writes++;[FocusNativeFake]::Text=$target;if([FocusNativeFake]::UiMode -eq 'write-drift'){[FocusNativeFake]::Selected=99} }
$button=[pscustomobject]@{};$button|Add-Member ScriptMethod Inspect {return $true}
$button|Add-Member ScriptMethod Act {if([FocusNativeFake]::Selected -ne 12){throw '合成保存焦点不符'};[FocusNativeFake]::Saves++}
foreach($mode in @('fresh','edit-throws','edit-noop','save-throws','save-noop','text-on-blur','write-drift','edit-late')) {
    [FocusNativeFake]::Reset('fresh');[FocusNativeFake]::UiMode=$mode
    if($mode -eq 'edit-noop'){[FocusNativeFake]::Selected=99}
    $deadline=[FocusIndependent]::Clock($(if($mode -eq 'edit-late'){29900}else{0}))
    $report=@{focusActions=0;editFocusVerified=$false;saveFocusVerified=$false;ok=$false}
    $rejected=$false
    try {. ([scriptblock]::Create($fragment))} catch {$rejected=$true}
    $expectedFocus=if($mode -in @('fresh','save-throws','save-noop','text-on-blur')){2}else{1}
    $expectedWrites=if($mode -in @('fresh','save-throws','save-noop','text-on-blur','write-drift')){1}else{0}
    $checks+=[pscustomobject]@{name="实际helper片段$mode";pass=$rejected -eq ($mode -ne 'fresh') -and [FocusNativeFake]::FocusActions -eq $expectedFocus -and [FocusNativeFake]::Writes -eq $expectedWrites -and [FocusNativeFake]::Saves -eq $(if($mode -eq 'fresh'){1}else{0});focusActions=[FocusNativeFake]::FocusActions;writes=[FocusNativeFake]::Writes;saves=[FocusNativeFake]::Saves}
}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($runner,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw '实际helper解析失败'}
$calls=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Member.Value -ceq 'SetFocus'},$true))
$checks+=[pscustomobject]@{name='实际脚本只有两个精确SetFocus';pass=$calls.Count -eq 2 -and $calls[0].Expression.Extent.Text -ceq '$binding.edit' -and $calls[1].Expression.Extent.Text -ceq '$binding.save'}
$fixture=[IO.File]::ReadAllText((Join-Path $candidate 'NativeFilenameDialogFixture.cs'))
$campaignStart=$fixture.IndexOf('private static int Campaign(',[StringComparison]::Ordinal)
$campaignEnd=$fixture.IndexOf('[STAThread]',$campaignStart,[StringComparison]::Ordinal)
$campaign=$fixture.Substring($campaignStart,$campaignEnd-$campaignStart)
$checks+=[pscustomobject]@{name='固定单candidate调用';pass=[regex]::Matches($campaign,'Case\(scope,').Count -eq 1 -and $campaign.Contains('Case(scope, "candidate", pwsh)') -and -not $campaign.Contains('"reference"')}
$checks+=[pscustomobject]@{name='无全局输入和焦点回退';pass= -not [regex]::IsMatch($runner+[IO.File]::ReadAllText((Join-Path $candidate 'NativeFilenameFocus.cs')),'AttachThreadInput|SetForegroundWindow|SendKeys|SendInput|Clipboard|WM_COMMAND')}
$out=[ordered]@{version=1;actualUi=$false;actualCom=$false;actualJob=$false;passed=@($checks|Where-Object pass).Count;failed=@($checks|Where-Object {-not $_.pass}).Count;checks=$checks}
[IO.File]::WriteAllText((Join-Path $Evidence 'results.json'),($out|ConvertTo-Json -Depth 7))
$out|ConvertTo-Json -Depth 7
if($out.failed -gt 0){exit 1}
