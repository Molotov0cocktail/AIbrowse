[CmdletBinding()]
param([Parameter(Mandatory)][string]$Evidence)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(Test-Path -LiteralPath $Evidence){throw '诊断反例原件已存在'}
[void][IO.Directory]::CreateDirectory($Evidence)
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'run-native-filename-commit-qualification.ps1'))
$start=$source.IndexOf('        $report.focusActions=1',[StringComparison]::Ordinal)
$end=$source.IndexOf('    finally {',$start,[StringComparison]::Ordinal)
if($start -lt 0 -or $end -le $start){throw '实际helper动作边界缺失'}
$action=[scriptblock]::Create('try {'+$source.Substring($start,$end-$start))
$checks=[Collections.Generic.List[object]]::new()
function Run-Action([string]$Fault){
    $script:editCalls=0;$script:saveFocusCalls=0;$script:writeCalls=0;$script:saveCalls=0;$script:inspections=0;$script:rechecks=0
    $script:fault=$Fault;$script:text='AIbrowse-backup';$Purpose='focus-diagnostic';$scope='D:\synthetic-never-created'
    $report=[ordered]@{ok=$false;phase='preflight';exceptionType='none';nativeFocus='not-read';focus='none';focusRead=$false;focusActions=0;editFocusVerified=$false;saveFocusVerified=$false;writes=0;saveActions=0;msaaQualified=$false;editTarget=$false;failure='helper-failed'}
    $edit=[pscustomobject]@{};$save=[pscustomobject]@{}
    $edit|Add-Member ScriptMethod SetFocus {$script:editCalls++;if($script:fault -ceq 'call'){throw [InvalidOperationException]::new('不可输出正文')}}
    $save|Add-Member ScriptMethod SetFocus {$script:saveFocusCalls++}
    $binding=@{edit=$edit;save=$save}
    $native=[pscustomobject]@{};$native|Add-Member ScriptMethod ReadText {return $script:text}
    $button=[pscustomobject]@{};$button|Add-Member ScriptMethod Inspect {return $true};$button|Add-Member ScriptMethod Act {$script:saveCalls++;return $true}
    $value=[pscustomobject]@{};$value|Add-Member ScriptMethod Inspect {param($initial)$script:inspections++;return $true}
    $value|Add-Member ScriptMethod WriteTarget {param($target,$initial)$script:writeCalls++;$script:text=$target}
    $focus=[pscustomobject]@{}
    foreach($name in @('AcceptEdit','AssertEdit','AcceptSave','AssertSave')){$focus|Add-Member ScriptMethod $name {if($script:fault -ceq 'native'){throw [InvalidOperationException]::new('不可输出正文')}}}
    $focus|Add-Member ScriptMethod InspectEditDiagnostic {
        if($script:fault -ceq 'native'){throw [InvalidOperationException]::new('不可输出正文')}
        if($script:fault -ceq 'late'){throw [TimeoutException]::new('不可输出正文')}
        return [pscustomobject]@{Matched=($script:fault -cne 'mismatch');Judgment=$(if($script:fault -ceq 'mismatch'){'focus-mismatch'}else{'matched'});Focus='edit';FocusRead=$true}
    }
    function Recheck {$script:rechecks++;if($script:fault -ceq 'recheck'){throw [InvalidOperationException]::new('不可输出正文')}}
    function Check-Time {param($Limit)}
    function Get-ChildItem {param($LiteralPath,[switch]$Force)return @()}
    & $action
    $expectedPhase=switch($Fault){call{'edit-focus-call'}recheck{'edit-focus-recheck'}native{'edit-focus-native'}late{'edit-focus-native'}default{'diagnostic-complete'}}
    $ok=$script:editCalls -eq 1 -and $script:saveFocusCalls -eq 0 -and $script:writeCalls -eq 0 -and $script:saveCalls -eq 0 -and $script:inspections -eq 0 -and
        $report.writes -eq 0 -and $report.saveActions -eq 0 -and -not $report.ok -and $report.phase -ceq $expectedPhase
    return [pscustomobject]@{name="实际helper片段-$Fault";pass=$ok;edit=$script:editCalls;saveFocus=$script:saveFocusCalls;writes=$script:writeCalls;save=$script:saveCalls;phase=$report.phase}
}
# The original candidate has no diagnostic classifier. Load its real types when
# the repaired entry uses them; this compiles only and invokes no native port.
if($source.Contains('[AIbrowseNativeFilenameFocus]::ClassifyException')){
    $pure=@'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
internal sealed class DiagnosticFake : IFilenameFocusPort, IFilenameFocusDiagnosticPort {
    internal int Calls;internal bool Late;
    public bool Matches(IntPtr expected){throw new Exception("不应走资格读");}
    public FilenameFocusObservation Inspect(IntPtr expected){Calls++;if(Late)Thread.Sleep(150);return FilenameFocusPort.Project(new IntPtr(1),new IntPtr(2),new IntPtr(2),new IntPtr(1),new IntPtr(2),new IntPtr(3));}
}
internal sealed class PrivateException : Exception {public override string Message{get{throw new Exception("不允许读取正文");}}}
public static class FocusDiagnosticPure {
    public static object[] Run(){
        var checks=new List<object>();
        foreach(long focus in new long[]{0,1,2,3,99}){
            var p=FilenameFocusPort.Project(new IntPtr(1),new IntPtr(focus),new IntPtr(2),new IntPtr(1),new IntPtr(2),new IntPtr(3));
            string expected=focus==0?"none":focus==1?"dialog":focus==2?"edit":focus==3?"save":"other";
            checks.Add(new{name="焦点闭合投影"+focus,pass=p.Focus==expected&&p.FocusRead&&p.Matched==(focus==2)&&p.Judgment==(focus==2?"matched":"focus-mismatch")});
        }
        var inactive=FilenameFocusPort.Project(new IntPtr(99),new IntPtr(2),new IntPtr(2),new IntPtr(1),new IntPtr(2),new IntPtr(3));
        checks.Add(new{name="活动窗口失配与Edit焦点分开",pass=inactive.Judgment=="active-mismatch"&&inactive.Focus=="edit"&&!inactive.Matched});
        var errors=new Exception[]{new InvalidOperationException("私有正文"),new TimeoutException("私有正文"),new COMException("私有正文"),new PrivateException(),new TargetInvocationException(new InvalidOperationException("私有正文"))};
        var classes=new[]{"invalid-operation","timeout","com","other","invalid-operation"};
        for(int i=0;i<errors.Length;i++)checks.Add(new{name="异常类型闭合"+i,pass=AIbrowseNativeFilenameFocus.ClassifyException(errors[i])==classes[i]});
        foreach(bool late in new[]{false,true}){
            var fake=new DiagnosticFake{Late=late};
            var clock=new AIbrowseFilenameDeadline(Stopwatch.GetTimestamp()-Stopwatch.Frequency*(late?29900:0)/1000,Stopwatch.Frequency);
            var diagnostic=new AIbrowseNativeFilenameFocus(fake,new IntPtr(2),new IntPtr(3),clock);
            bool rejected=false;try{diagnostic.InspectEditDiagnostic();}catch{rejected=true;}
            bool retry=false;try{diagnostic.InspectEditDiagnostic();}catch{retry=true;}
            checks.Add(new{name="原期限与读取不重试"+late,pass=rejected==late&&retry&&fake.Calls==1});
        }
        return checks.ToArray();
    }
}
'@
    $purePath=Join-Path $Evidence 'diagnostic-pure.cs';[IO.File]::WriteAllText($purePath,$pure)
    Add-Type -Path @((Join-Path $PSScriptRoot 'NativeSaveControl.cs'),(Join-Path $PSScriptRoot 'NativeSaveButton.cs'),(Join-Path $PSScriptRoot 'NativeFilenameValueCandidate.cs'),(Join-Path $PSScriptRoot 'NativeFilenameFocus.cs'),$purePath)
    foreach($check in [FocusDiagnosticPure]::Run()){$checks.Add($check)}
}
foreach($fault in @('fresh','call','recheck','native','late','mismatch')){$checks.Add((Run-Action $fault))}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw 'helper解析失败'}
$purposeFunction=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-Purpose'},$true)
if($null -ne $purposeFunction){
    . ([scriptblock]::Create($purposeFunction.Extent.Text))
    foreach($pair in @(@('qualification','qualification'),@('focus-diagnostic','focus-diagnostic'),@('qualification','focus-diagnostic'),@('focus-diagnostic','qualification'),@('unknown','unknown'))){
        $reject=$false;try{Assert-Purpose $pair[0] $pair[1]}catch{$reject=$true}
        $checks.Add([pscustomobject]@{name="目的绑定-$($pair -join '-')";pass=$reject -eq ($pair[0] -cne $pair[1] -or $pair[0] -ceq 'unknown')})
    }
}else{$checks.Add([pscustomobject]@{name='目的绑定缺失';pass=$false})}
$result=[ordered]@{version=1;actualUi=$false;actualCom=$false;actualJob=$false;passed=@($checks|Where-Object pass).Count;failed=@($checks|Where-Object {-not $_.pass}).Count;checks=@($checks)}
$json=$result|ConvertTo-Json -Depth 6
[IO.File]::WriteAllText((Join-Path $Evidence 'results.json'),$json)
$json
if($result.failed -gt 0){exit 1}
