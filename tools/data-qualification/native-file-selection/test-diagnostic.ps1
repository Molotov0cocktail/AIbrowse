[CmdletBinding()]
param([Parameter(Mandatory)][string]$Evidence)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(Test-Path -LiteralPath $Evidence){throw '诊断测试原件已存在'}
[void][IO.Directory]::CreateDirectory($Evidence)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'run.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw '实际入口语法无效'}
foreach($function in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){
    if($function.Parent -is [Management.Automation.Language.NamedBlockAst]){. ([scriptblock]::Create($function.Extent.Text))}
}
$results=[Collections.Generic.List[object]]::new()
function Check([string]$Name,[scriptblock]$Action){try{& $Action;$results.Add(@{name=$Name;pass=$true})}catch{$results.Add(@{name=$Name;pass=$false})}}
function Candidate {return [pscustomobject]@{NativeWindowHandle=101;ProcessId=42;IsEnabled=$true;IsOffscreen=$false;Name='Open'}}
function Observe-Rejection([int]$Hosts,[int]$Accepted,[object[]]$Candidates){
    $observation=@{failure='none';actions=0}
    try{Reject-SelectionBinding $Hosts $Accepted $Candidates 42 @('Open');$observation.actions++}
    catch{$observation.failure=Get-SelectionFailure $_.Exception}
    return $observation
}
$cases=@(
    @{name='host零';hosts=0;accepted=0;count=1;field='';value=$null;failure='host-count'},
    @{name='host重复';hosts=2;accepted=0;count=1;field='';value=$null;failure='host-count'},
    @{name='按钮不存在';hosts=1;accepted=0;count=0;field='';value=$null;failure='button-count'},
    @{name='结构候选重复';hosts=1;accepted=0;count=2;field='IsEnabled';value=$false;failure='button-count'},
    @{name='合格候选重复';hosts=1;accepted=2;count=2;field='';value=$null;failure='button-count'},
    @{name='单候选句柄空';hosts=1;accepted=0;count=1;field='NativeWindowHandle';value=0;failure='button-handle'},
    @{name='单候选PID不符';hosts=1;accepted=0;count=1;field='ProcessId';value=43;failure='button-pid'},
    @{name='单候选disabled';hosts=1;accepted=0;count=1;field='IsEnabled';value=$false;failure='button-disabled'},
    @{name='单候选offscreen';hosts=1;accepted=0;count=1;field='IsOffscreen';value=$true;failure='button-offscreen'},
    @{name='单候选未知名称不回显';hosts=1;accepted=0;count=1;field='Name';value='private-path-secret';failure='button-name'},
    @{name='拒绝后状态已变化仍不授权';hosts=1;accepted=0;count=1;field='';value=$null;failure='button-count'}
)
foreach($case in $cases){Check $case.name {
    $candidates=@(for($i=0;$i -lt $case.count;$i++){$candidate=Candidate;if($case.field){$candidate.($case.field)=$case.value};$candidate})
    $actual=Observe-Rejection $case.hosts $case.accepted $candidates
    if($actual.actions -ne 0 -or $actual.failure -cne $case.failure){throw '拒绝分类或零动作不符'}
}}
Check '诊断不拒绝原本唯一合格按钮' {
    $actual=Observe-Rejection 1 1 @((Candidate),(Candidate))
    if($actual.actions -ne 1 -or $actual.failure -cne 'none'){throw '诊断改变原资格'}
}
Check '缺字段异常闭合且零动作' {
    $actual=Observe-Rejection 1 0 @([pscustomobject]@{Name='private-path-secret'})
    if($actual.actions -ne 0 -or $actual.failure -cne 'helper-unexpected'){throw '未知异常泄漏或授权'}
}
Check '树512边界与513拒绝' {
    Assert-SelectionTreeRoom 511
    $actual='none';try{Assert-SelectionTreeRoom 512}catch{$actual=Get-SelectionFailure $_.Exception}
    if($actual -cne 'tree-limit'){throw '树上限分类不符'}
}
Check '未知异常正文不进入回执' {
    if((Get-SelectionFailure ([InvalidOperationException]::new('private-path-secret'))) -cne 'helper-unexpected'){throw '异常正文泄漏'}
}
Check '伪造分类不在白名单拒绝' {
    $errorObject=[InvalidOperationException]::new('private-path-secret');$errorObject.Data['AIbrowse.SelectionFailure']='private-path-secret'
    if((Get-SelectionFailure $errorObject) -cne 'helper-unexpected'){throw '分类未闭合'}
}
Check '包装异常保持固定分类' {
    try{Throw-SelectionFailure 'button-disabled'}catch{$errorObject=[InvalidOperationException]::new('private-path-secret',$_.Exception)}
    if((Get-SelectionFailure $errorObject) -cne 'button-disabled'){throw '包装丢失分类'}
}
Check '原期限超时分类且不续动作' {
    $clock=[pscustomobject]@{ElapsedMilliseconds=30000};$uiStartedTick=$null;$actions=0;$actual='none'
    try{Check-Time 30000;$actions++}catch{$actual=Get-SelectionFailure $_.Exception}
    if($actions -ne 0 -or $actual -cne 'helper-deadline'){throw '超时分类或零动作不符'}
}
Check '共享时钟超时分类' {
    $clock=[pscustomobject]@{ElapsedMilliseconds=0};$uiStartedTick=[Diagnostics.Stopwatch]::GetTimestamp()-31*[Diagnostics.Stopwatch]::Frequency;$actual='none'
    try{Check-Time 30000}catch{$actual=Get-SelectionFailure $_.Exception}
    if($actual -cne 'helper-deadline'){throw '共享时钟分类不符'}
}
Check '实际绑定在原拒绝条件中调用诊断' {
    $binding=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-Binding'},$true)
    if($binding.Count -ne 1){throw '绑定函数不唯一'}
    $guards=$binding[0].FindAll({param($node)$node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.StartsWith('if ($hosts.Count -ne 1 -or $saves.Count -ne 1)')},$true)
    if($guards.Count -ne 1 -or $guards[0].Extent.Text -cnotmatch 'Reject-SelectionBinding'){throw '诊断脱离原拒绝路径'}
    if($binding[0].Extent.Text -cnotmatch 'Assert-SelectionTreeRoom \$records.Count'){throw '树上限未接线'}
}
# These in-memory stand-ins exercise the actual binding function without UIA/COM.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
namespace Windows.Automation {
    public sealed class State {
        public int ProcessId = 42, NativeWindowHandle = 101;
        public string Name = "", ClassName = "", AutomationId = "";
        public bool IsEnabled = true, IsOffscreen = false;
    }
    public sealed class AutomationElement {
        public static AutomationElement Root;
        public State Current = new State();
        public List<AutomationElement> Children = new List<AutomationElement>();
        public AutomationElement Parent;
        public bool ThrowOnRead;
        public static AutomationElement FromHandle(IntPtr ignored) { return Root; }
        public void Add(AutomationElement child) { child.Parent = this; Children.Add(child); }
    }
    public sealed class TreeWalker {
        public static readonly TreeWalker ControlViewWalker = new TreeWalker();
        public AutomationElement GetFirstChild(AutomationElement node) {
            if(node.ThrowOnRead) throw new InvalidOperationException("synthetic-private-value");
            return node.Children.Count == 0 ? null : node.Children[0];
        }
        public AutomationElement GetNextSibling(AutomationElement node) {
            if(node.Parent == null) return null;
            int next = node.Parent.Children.IndexOf(node) + 1;
            return next >= node.Parent.Children.Count ? null : node.Parent.Children[next];
        }
    }
}
'@
$bindingAst=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-Binding'},$true)[0]
. ([scriptblock]::Create($bindingAst.Extent.Text))
function Check-Identity {Check-Time 30000}
function Make-BindingTree {
    $root=[Windows.Automation.AutomationElement]::new();$root.Current.Name='打开本地数据备份';$root.Current.ClassName='#32770'
    $hostNode=[Windows.Automation.AutomationElement]::new();$hostNode.Current.AutomationId='FileNameControlHost';$root.Add($hostNode)
    $editNode=[Windows.Automation.AutomationElement]::new();$editNode.Current.AutomationId='1001';$editNode.Current.ClassName='Edit';$hostNode.Add($editNode)
    $buttonNode=[Windows.Automation.AutomationElement]::new();$buttonNode.Current.AutomationId='1';$buttonNode.Current.ClassName='Button';$buttonNode.Current.Name='Open';$root.Add($buttonNode)
    [Windows.Automation.AutomationElement]::Root=$root
    return @{root=$root;host=$hostNode;edit=$editNode;button=$buttonNode}
}
function Observe-Binding([scriptblock]$Configure) {
    $clock=[Diagnostics.Stopwatch]::StartNew();$uiStartedTick=$null
    $productPid=[uint32]42;$dialog=[IntPtr]1;$title='打开本地数据备份';$buttonNames=@('Open')
    $tree=Make-BindingTree;& $Configure $tree
    $actual=@{failure='none';actions=0}
    try{$null=Get-Binding;$actual.actions++}catch{$actual.failure=Get-SelectionFailure $_.Exception}
    return $actual
}
$bindingCases=@(
    @{name='原绑定disabled零动作';configure={param($tree)$tree.button.Current.IsEnabled=$false};failure='button-disabled'},
    @{name='原绑定未知名称零动作';configure={param($tree)$tree.button.Current.Name='synthetic-private-value'};failure='button-name'},
    @{name='原绑定异PID零动作';configure={param($tree)$tree.button.Current.ProcessId=43};failure='button-pid'},
    @{name='原绑定隐身零动作';configure={param($tree)$tree.button.Current.IsOffscreen=$true};failure='button-offscreen'},
    @{name='原绑定空句柄零动作';configure={param($tree)$tree.button.Current.NativeWindowHandle=0};failure='button-handle'},
    @{name='原绑定缺host零动作';configure={param($tree)$tree.host.Current.AutomationId='other'};failure='host-count'},
    @{name='原绑定缺Edit零动作';configure={param($tree)$tree.edit.Current.AutomationId='other'};failure='edit-count'},
    @{name='原绑定Edit不可用零动作';configure={param($tree)$tree.edit.Current.IsEnabled=$false};failure='edit-state'},
    @{name='原绑定UIA异常不输出正文';configure={param($tree)$tree.root.ThrowOnRead=$true};failure='helper-unexpected'},
    @{name='原绑定513节点拒绝';configure={param($tree)for($i=0;$i -lt 509;$i++){$tree.root.Add([Windows.Automation.AutomationElement]::new())}};failure='tree-limit'}
)
foreach($bindingCase in $bindingCases){Check $bindingCase.name {
    $actual=Observe-Binding $bindingCase.configure
    if($actual.actions -ne 0 -or $actual.failure -cne $bindingCase.failure){throw '实际绑定分类或零动作不符'}
}}
Check '原绑定512节点允许' {
    $actual=Observe-Binding {param($tree)for($i=0;$i -lt 508;$i++){$tree.root.Add([Windows.Automation.AutomationElement]::new())}}
    if($actual.actions -ne 1 -or $actual.failure -cne 'none'){throw '实际绑定512上限被降低'}
}
Check '原绑定有disabled旁支时唯一合格仍允许' {
    $actual=Observe-Binding {param($tree)$extra=[Windows.Automation.AutomationElement]::new();$extra.Current.AutomationId='1';$extra.Current.ClassName='Button';$extra.Current.IsEnabled=$false;$tree.root.Add($extra)}
    if($actual.actions -ne 1 -or $actual.failure -cne 'none'){throw '结构诊断扩大拒绝'}
}
$results|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $Evidence 'results.json') -Encoding utf8
$failed=@($results|Where-Object {-not $_.pass})
[pscustomobject]@{passed=$results.Count-$failed.Count;failed=$failed.Count;actualUi=$false;actualJob=$false}
if($failed.Count){$failed|ForEach-Object {$_.name};exit 1}
