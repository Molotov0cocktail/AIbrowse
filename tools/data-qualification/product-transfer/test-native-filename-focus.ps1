[CmdletBinding()]
param([Parameter(Mandatory)][string]$Evidence)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(Test-Path -LiteralPath $Evidence){throw '原件已存在'}
[void][IO.Directory]::CreateDirectory($Evidence)
$source=@'
using System;
using System.Diagnostics;
using System.Threading;
using System.Collections.Generic;
internal sealed class FocusFake : IFilenameFocusPort {
    internal IntPtr focus=new IntPtr(101);internal int reads;internal bool delay,raises;
    public bool Matches(IntPtr expected){reads++;if(delay)Thread.Sleep(150);if(raises)throw new Exception("固定错误");return expected==focus;}
}
public static class FocusTests {
    private static List<object> checks=new List<object>();
    private static void Test(string name,Func<bool> run){bool ok=false;try{ok=run();}catch{}checks.Add(new {name=name,pass=ok});}
    private static bool Reject(Action run){try{run();return false;}catch{return true;}}
    private static AIbrowseFilenameDeadline Clock(int age=0){return new AIbrowseFilenameDeadline(Stopwatch.GetTimestamp()-Stopwatch.Frequency*age/1000,Stopwatch.Frequency);}
    private static AIbrowseNativeFilenameFocus Make(FocusFake port,AIbrowseFilenameDeadline clock=null){return new AIbrowseNativeFilenameFocus(port,new IntPtr(101),new IntPtr(102),clock??Clock());}
    public static object[] Run(){
        Test("两个固定焦点按序完成",()=>{var port=new FocusFake();var focus=Make(port);focus.AcceptEdit();focus.AssertEdit();port.focus=new IntPtr(102);focus.AcceptSave();focus.AssertSave();return port.reads==4;});
        Test("错误Edit焦点拒绝并不重试",()=>{var port=new FocusFake{focus=new IntPtr(103)};var focus=Make(port);bool no=Reject(focus.AcceptEdit);port.focus=new IntPtr(101);return no&&Reject(focus.AcceptEdit)&&port.reads==1;});
        Test("先保存焦点拒绝",()=>{var port=new FocusFake();var focus=Make(port);return Reject(focus.AcceptSave)&&port.reads==0;});
        Test("未准入Edit拒绝复核",()=>{var focus=Make(new FocusFake());return Reject(focus.AssertEdit);});
        Test("未准入Save拒绝复核",()=>{var focus=Make(new FocusFake());return Reject(focus.AssertSave);});
        Test("Edit重发拒绝",()=>{var port=new FocusFake();var focus=Make(port);focus.AcceptEdit();return Reject(focus.AcceptEdit)&&port.reads==1;});
        Test("Save重发拒绝",()=>{var port=new FocusFake();var focus=Make(port);focus.AcceptEdit();port.focus=new IntPtr(102);focus.AcceptSave();return Reject(focus.AcceptSave)&&port.reads==2;});
        Test("已转移后不能返Edit",()=>{var port=new FocusFake();var focus=Make(port);focus.AcceptEdit();port.focus=new IntPtr(102);focus.AcceptSave();port.focus=new IntPtr(101);return Reject(focus.AssertEdit);});
        Test("Edit中途漂移拒绝",()=>{var port=new FocusFake();var focus=Make(port);focus.AcceptEdit();port.focus=new IntPtr(103);return Reject(focus.AssertEdit);});
        Test("Save中途漂移拒绝",()=>{var port=new FocusFake();var focus=Make(port);focus.AcceptEdit();port.focus=new IntPtr(102);focus.AcceptSave();port.focus=new IntPtr(103);return Reject(focus.AssertSave);});
        Test("API抛错拒绝",()=>{var port=new FocusFake{raises=true};return Reject(Make(port).AcceptEdit);});
        Test("读取跨原期限拒绝",()=>{var port=new FocusFake{delay=true};var focus=Make(port,Clock(29900));return Reject(focus.AcceptEdit);});
        Test("零句柄拒绝",()=>Reject(()=>new AIbrowseNativeFilenameFocus(new FocusFake(),IntPtr.Zero,new IntPtr(102),Clock())));
        Test("同句柄拒绝",()=>Reject(()=>new AIbrowseNativeFilenameFocus(new FocusFake(),new IntPtr(101),new IntPtr(101),Clock())));
        return checks.ToArray();
    }
}
'@
$test=Join-Path $Evidence 'focus-tests.cs';[IO.File]::WriteAllText($test,$source)
Add-Type -Path @((Join-Path $PSScriptRoot 'NativeSaveControl.cs'),(Join-Path $PSScriptRoot 'NativeSaveButton.cs'),(Join-Path $PSScriptRoot 'NativeFilenameValueCandidate.cs'),(Join-Path $PSScriptRoot 'NativeFilenameFocus.cs'),$test)
$checks=@([FocusTests]::Run())
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'run-native-filename-commit-qualification.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw '运行脚本解析失败'}
$calls=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Member.Value -ceq 'SetFocus'},$true))
$checks+=[pscustomobject]@{name='只有精确Edit与Save两个焦点动作';pass=$calls.Count -eq 2 -and $calls[0].Expression.Extent.Text -ceq '$binding.edit' -and $calls[1].Expression.Extent.Text -ceq '$binding.save'}
$helper=$ast.Extent.Text
$write=$helper.IndexOf('$value.WriteTarget($target,$initial)',[StringComparison]::Ordinal)
$save=$helper.IndexOf('[void]$button.Act()',[StringComparison]::Ordinal)
$checks+=[pscustomobject]@{name='写入在两焦点之间且保存居后';pass=$calls.Count -eq 2 -and $calls[0].Extent.StartOffset -lt $write -and $write -lt $calls[1].Extent.StartOffset -and $calls[1].Extent.StartOffset -lt $save}
$fixture=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'NativeFilenameDialogFixture.cs'))
$start=$fixture.IndexOf('private static int Campaign(',[StringComparison]::Ordinal)
$end=$fixture.IndexOf('[STAThread]',$start,[StringComparison]::Ordinal)
$campaign=$fixture.Substring($start,$end-$start)
$checks+=[pscustomobject]@{name='只执行一个新候选不重复旧对照';pass=([regex]::Matches($campaign,'Case\(scope,')).Count -eq 1 -and $campaign.Contains('Case(scope, "candidate", pwsh, purpose)') -and -not $campaign.Contains('"reference"')}
$output=[ordered]@{version=1;actualUi=$false;actualCom=$false;actualJob=$false;passed=@($checks|Where-Object pass).Count;failed=@($checks|Where-Object {-not $_.pass}).Count;checks=$checks}
[IO.File]::WriteAllText((Join-Path $Evidence 'results.json'),($output|ConvertTo-Json -Depth 5))
$output|ConvertTo-Json -Depth 5
if($output.failed -gt 0){exit 1}
