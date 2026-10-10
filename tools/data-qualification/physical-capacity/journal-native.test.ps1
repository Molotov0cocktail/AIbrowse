[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'run.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw 'wrapper解析失败'}
$functions=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Assert-JournalProof'},$true))
if($functions.Count -ne 1){throw '证明判定不唯一'}
Invoke-Expression $functions[0].Extent.Text
$count=0
foreach($case in @('control','empty-observation-control','budget','over','negative','fraction','numeric-string','missing','extra','no-observations','count','empty-peak','not-absent','claim-peak','string-boolean')) {
    $proof='{"budgetBytes":134217728,"maxObservedBytes":512,"observations":3,"journalObservations":1,"finalAbsent":true,"continuousPeakVerified":false}'|ConvertFrom-Json
    switch($case) {
        'empty-observation-control' {$proof.maxObservedBytes=0;$proof.journalObservations=0}
        'budget' {$proof.budgetBytes=512}
        'over' {$proof.maxObservedBytes=134217729}
        'negative' {$proof.maxObservedBytes=-1}
        'fraction' {$proof.maxObservedBytes=0.5}
        'numeric-string' {$proof.observations='3'}
        'missing' {$proof.PSObject.Properties.Remove('maxObservedBytes')}
        'extra' {$proof|Add-Member -NotePropertyName unknown -NotePropertyValue 1}
        'no-observations' {$proof.observations=1}
        'count' {$proof.journalObservations=3}
        'empty-peak' {$proof.journalObservations=0}
        'not-absent' {$proof.finalAbsent=$false}
        'claim-peak' {$proof.continuousPeakVerified=$true}
        'string-boolean' {$proof.finalAbsent='true'}
    }
    $accepted=$false
    try {Assert-JournalProof $proof;$accepted=$true}catch{}
    if($accepted -ne ($case -in @('control','empty-observation-control'))){throw ('journal实际判定与oracle不符：'+$case)}
    $count++
}
# The only substituted native primitive is pure allocation rounding.
Add-Type -TypeDefinition @'
namespace AIbrowse.FullTransfer {
 public static class FixedTransferJob {
  public static long Allocation(long bytes,long unit){return ((bytes+unit-1)/unit)*unit;}
 }
}
'@
$formulas=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$required'},$true))
if($formulas.Count -ne 1){throw '空间公式不唯一'}
foreach($unit in @(4096,65535)) {
    $disk=@{AllocationUnit=$unit}
    Invoke-Expression $formulas[0].Extent.Text
    $expected=2*[long]([Math]::Ceiling(67108864/$unit)*$unit)+[long]([Math]::Ceiling(134217728/$unit)*$unit)+[long]([Math]::Ceiling(16777216/$unit)*$unit)+1073741824
    if($required -ne $expected){throw '实际原生空间公式不符'}
    $count++
}
@{passed=$count;actualJob=$false;actualCapacity=$false}|ConvertTo-Json
