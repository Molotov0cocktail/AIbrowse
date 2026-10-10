[CmdletBinding()]
param([Parameter(Mandatory)][string]$Evidence)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
if(Test-Path -LiteralPath $Evidence){throw '观察测试原件已存在'}
[void][IO.Directory]::CreateDirectory($Evidence)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'run.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw '入口语法错误'}
foreach($function in $ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){
    if($function.Parent -is [Management.Automation.Language.NamedBlockAst]){. ([scriptblock]::Create($function.Extent.Text))}
}
$results=[Collections.Generic.List[object]]::new()
function Check([string]$Name,[scriptblock]$Action){try{& $Action;$results.Add(@{name=$Name;pass=$true})}catch{$results.Add(@{name=$Name;pass=$false})}}
Check '新观察目的可精确绑定' {Assert-Purpose 'open-structure-observation' 'open-structure-observation'}
Check '新目的不得混入原选择资格' {$rejected=$false;try{Assert-Purpose 'selection-qualification' 'open-structure-observation'}catch{$rejected=$true};if(-not $rejected){throw '目的被混用'}}
Check '原目的保持' {Assert-Purpose 'selection-qualification' 'selection-qualification'}
$fixture=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'NativeSelectionFixture.cs'))
$start=$fixture.IndexOf('    public sealed class ChoiceLedger',[StringComparison]::Ordinal)
$end=$fixture.IndexOf('    internal static class FlatJson',[StringComparison]::Ordinal)
$orderStart=$fixture.IndexOf('    public static class CampaignOrder',[StringComparison]::Ordinal)
$orderEnd=$fixture.IndexOf('    public sealed class OpenInputLease',[StringComparison]::Ordinal)
if($start -lt 0 -or $end -le $start -or $orderStart -lt 0 -or $orderEnd -le $orderStart){throw '实际纯代码边界失配'}
$pure='using System;using System.Collections.Generic;namespace AIbrowse.SelectionQualification {'+$fixture.Substring($start,$end-$start)+$fixture.Substring($orderStart,$orderEnd-$orderStart)+'}'
$purePath=Join-Path $Evidence 'fixture-pure.cs';[IO.File]::WriteAllText($purePath,$pure,[Text.UTF8Encoding]::new($false))
$upstream=Join-Path $PSScriptRoot '../product-transfer'
Add-Type -Path @((Join-Path $upstream 'NativeSaveControl.cs'),(Join-Path $upstream 'NativeSaveButton.cs'),(Join-Path $PSScriptRoot 'NativeSelectionEdit.cs'),$purePath,(Join-Path $PSScriptRoot 'OpenStructurePureTests.cs'))
foreach($result in [OpenStructurePureTests]::Run()){$results.Add(@{name=$result.Name;pass=$result.Pass})}
$routes=@($ast.FindAll({param($node)
    $node -is [Management.Automation.Language.IfStatementAst] -and
    $node.Clauses[0].Item1.Extent.Text -ceq '$Purpose -ceq ''open-structure-observation''' -and
    $null -ne $node.Clauses[0].Item2.Find({param($part)$part -is [Management.Automation.Language.CommandAst] -and $part.GetCommandName() -ceq 'Observe-OpenStructure'},$false)
},$true))
if($routes.Count -ne 1){throw '真实观察路由不唯一'}
$route=[scriptblock]::Create($routes[0].Extent.Text)
Check '真实helper观察路由不进入选择代码' {
    $Purpose='open-structure-observation';$trace=@{observations=0;bindings=0}
    $report=@{ok=$false;phase='preflight';failure='helper-failed';writes=0;saveActions=0;selections=0;replacements=0}
    function Observe-OpenStructure {$trace.observations++}
    function Get-Binding {$trace.bindings++;throw '观察不应进入绑定'}
    . $route
    if($trace.observations -ne 1 -or $trace.bindings -ne 0 -or -not $report.ok -or $report.phase -cne 'observed' -or
       $report.writes -ne 0 -or $report.saveActions -ne 0 -or $report.selections -ne 0 -or $report.replacements -ne 0){throw '观察授选择动作'}
}
Check '真实helper观察异常不转选择不重试' {
    $Purpose='open-structure-observation';$trace=@{observations=0;bindings=0}
    $report=@{ok=$false;phase='preflight';failure='helper-failed'}
    function Observe-OpenStructure {$trace.observations++;throw '固定异常'}
    function Get-Binding {$trace.bindings++;throw '观察不应进入绑定'}
    $rejected=$false;try{. $route}catch{$rejected=$true}
    if(-not $rejected -or $trace.observations -ne 1 -or $trace.bindings -ne 0 -or $report.ok){throw '失败观察转动作'}
}
$results|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $Evidence 'results.json') -Encoding utf8
$failed=@($results|Where-Object {-not $_.pass})
[pscustomobject]@{passed=$results.Count-$failed.Count;failed=$failed.Count;actualUi=$false;actualJob=$false}
if($failed.Count){exit 1}
