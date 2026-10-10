[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$evidence=Join-Path $repository 'log/stage7-e2/sources512-independent-review-001'
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repository 'tools/data-qualification/physical-sources512/run.ps1'),[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count -ne 0){throw '独立审核无法解析候选'}
function Original-Function([string]$Name) {
    $nodes=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $Name},$true))
    if($nodes.Count -ne 1){throw '独立审核函数不唯一'}
    return $nodes[0].Extent.Text
}
Invoke-Expression (Original-Function 'Check-Time')
Invoke-Expression (Original-Function 'Bind-File')
Invoke-Expression (Original-Function 'Assert-JournalProof')
$outer=@($ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})
if($outer.Count -ne 1){throw '独立审核主块不唯一'}
$statements=@($outer[0].Body.Statements)
$start=-1;$finish=-1
for($i=0;$i -lt $statements.Count;$i++) {
    if($statements[$i].Extent.Text.StartsWith('$result.job=')){$start=$i}
    if($statements[$i].Extent.Text -ceq '$physical=@()'){$finish=$i}
}
if($start -lt 0 -or $finish -le $start){throw '独立审核真实门片段不闭合'}
$gate=($statements[$start..($finish-1)] | ForEach-Object {$_.Extent.Text}) -join "`n"
[IO.File]::WriteAllText((Join-Path $evidence 'actual-wrapper-gate.ps1'),$gate)
# Compile a pure oracle boundary; no Win32 declarations or actual processes.
Add-Type -TypeDefinition @'
namespace AIbrowse.FullTransfer {
 public static class FixedTransferJob {
  public static object Next;
  public static object Execute(string mode,string node,string entry,string scope,string directory,string run,int work){return Next;}
  public static void ValidateLimits(string mode,uint flags,uint processes,ulong process,ulong job){
   if(mode!="import"||flags!=0x2308||processes!=1||process!=2147483648UL||job!=2147483648UL)throw new System.InvalidOperationException();
  }
 }
}
'@
function Read-JsonHeld([string]$Path){$script:proofReads++;return $script:proof}
function Hash-HeldPath([string]$Path){return ('a'*64)}
$scope=$evidence;$ScopeId='physical-sources512-'+('b'*32);$node='unused';$remaining=1000
$workMs=120000;$disk=@{AllocationUnit=4096};$required=2298478592
$build=@{sourceProof='source';node=@{version='v24.18.0'}}
$outcomes=[Collections.Generic.List[object]]::new()
$cases=@('control','unsuccessful','job-unknown','ownership-retained','nonzero','limits-unverified','exit-failure','work-failure','no-sample','wrong-native-limit','proof-build-mismatch','proof-product-pass','proof-electron-pass','wrong-member','late','exact-deadline','journal-missing','journal-extra','journal-string-boolean','journal-string-number','journal-budget-old','journal-over-budget','journal-inconsistent-count','journal-unobserved-peak','journal-terminal-present','journal-continuous-claim','journal-zero-control','journal-limit-control')
foreach($case in $cases) {
    $script:proofReads=0
    $clock=@{Elapsed=@{TotalMilliseconds=119999}}
    $job=[pscustomobject]@{Succeeded=$true;ActualZero=$true;OwnershipRetained=$false;ExitCode=0;LimitsVerified=$true;ExitFailure=$null;Failure=$null;Samples=1;LimitFlags=0x2308;ProcessLimit=1;ProcessCommitLimit=2147483648;JobCommitLimit=2147483648}
    $script:proof=[pscustomobject]@{version=1;scopeId=$ScopeId;kind='sources512-node-construction';completed=$true;productE2Pass=$false;electronQualified=$false;sourceProof='source';buildProofSha256=('a'*64);nodeVersion='v24.18.0';allocationUnit='4096';requiredFreeBytes=[string]$required;files=@(@{member='sources.db'},@{member='sources-backup.db'});journal=('{"budgetBytes":134217728,"maxObservedBytes":512,"observations":4,"journalObservations":2,"finalAbsent":true,"continuousPeakVerified":false}'|ConvertFrom-Json)}
    switch($case) {
        'unsuccessful' {$job.Succeeded=$false}
        'job-unknown' {$job.ActualZero=$false}
        'ownership-retained' {$job.OwnershipRetained=$true}
        'nonzero' {$job.ExitCode=92}
        'limits-unverified' {$job.LimitsVerified=$false}
        'exit-failure' {$job.ExitFailure='exit-unknown'}
        'work-failure' {$job.Failure='deadline'}
        'no-sample' {$job.Samples=0}
        'wrong-native-limit' {$job.ProcessLimit=24}
        'proof-build-mismatch' {$script:proof.buildProofSha256=('c'*64)}
        'proof-product-pass' {$script:proof.productE2Pass=$true}
        'proof-electron-pass' {$script:proof.electronQualified=$true}
        'wrong-member' {$script:proof.files[1].member='other.db'}
        'late' {$clock.Elapsed.TotalMilliseconds=120001}
        'exact-deadline' {$clock.Elapsed.TotalMilliseconds=120000}
        'journal-missing' {$script:proof.PSObject.Properties.Remove('journal')}
        'journal-extra' {$script:proof.journal|Add-Member -NotePropertyName extra -NotePropertyValue $true}
        'journal-string-boolean' {$script:proof.journal.finalAbsent='true'}
        'journal-string-number' {$script:proof.journal.maxObservedBytes='512'}
        'journal-budget-old' {$script:proof.journal.budgetBytes=0}
        'journal-over-budget' {$script:proof.journal.maxObservedBytes=134217729}
        'journal-inconsistent-count' {$script:proof.journal.journalObservations=4}
        'journal-unobserved-peak' {$script:proof.journal.journalObservations=0}
        'journal-terminal-present' {$script:proof.journal.finalAbsent=$false}
        'journal-continuous-claim' {$script:proof.journal.continuousPeakVerified=$true}
        'journal-zero-control' {$script:proof.journal.journalObservations=0;$script:proof.journal.maxObservedBytes=0}
        'journal-limit-control' {$script:proof.journal.maxObservedBytes=134217728}
    }
    [AIbrowse.FullTransfer.FixedTransferJob]::Next=$job
    $result=[ordered]@{job=$null;completed=$false}
    $accepted=$false
    try {Invoke-Expression $gate;$accepted=$true}catch{}
    $outcomes.Add([pscustomobject]@{name=$case;accepted=$accepted;proofReads=$script:proofReads;actualJob=$false})
    if($accepted -ne ($case -in @('control','journal-zero-control','journal-limit-control'))){throw ('实际wrapper门错误接受或拒绝：'+$case)}
    if($accepted -and $result.journal -ne $script:proof.journal){throw '实际wrapper未保留journal证明'}
    if($case -in @('unsuccessful','job-unknown','ownership-retained','nonzero','limits-unverified','exit-failure','work-failure','no-sample','wrong-native-limit','late','exact-deadline') -and $script:proofReads -ne 0){throw 'Job或期限失败后仍读取成功proof'}
}
# Type substitutions exercise the actual parsed proof guard, without filesystem IO.
foreach($property in @('budgetBytes','maxObservedBytes','observations','journalObservations')) {
    foreach($value in @($null,$true,'1',[double]1.5,[double]::NaN,[double]::PositiveInfinity,[long]9007199254740992,-1,@(1),[pscustomobject]@{value=1})) {
        $journal='{"budgetBytes":134217728,"maxObservedBytes":512,"observations":4,"journalObservations":2,"finalAbsent":true,"continuousPeakVerified":false}'|ConvertFrom-Json
        $journal.$property=$value
        $accepted=$false
        try {Assert-JournalProof $journal;$accepted=$true}catch{}
        if($accepted){throw ('证明错误接受非闭合数字：'+$property)}
        $outcomes.Add([pscustomobject]@{name=('journal-type-'+$property);accepted=$false;proofReads=0;actualJob=$false})
    }
}
# Exercise the actual binding function with a substituted read result.
function Read-BoundFile([string]$Path,[long]$Maximum,[bool]$KeepOpen,[bool]$KeepBytes){return @{hash=('d'*64);stream=$null}}
function Capture-HeldFact($Stream,[string]$Hash){return @{hash=$Hash}}
$heldFacts=[Collections.Generic.List[object]]::new()
$rejected=$false
try{$null=Bind-File 'unused-current-run.ps1' 8388608 ('e'*64)}catch{$rejected=$true}
if(-not $rejected -or $heldFacts.Count -ne 0){throw '当前源码不同仍被绑定'}
$outcomes.Add([pscustomobject]@{name='changed-current-source';accepted=$false;proofReads=0;actualJob=$false})
# Exercise the actual Sources-specific source and artifact admission block.
$sourceStart=-1;$sourceEnd=-1
for($i=0;$i -lt $statements.Count;$i++) {
    if($statements[$i].Extent.Text.StartsWith('$build=Read-JsonHeld')){$sourceStart=$i}
    if($statements[$i].Extent.Text.StartsWith('$node=(Get-Command')){$sourceEnd=$i}
}
if($sourceStart -lt 0 -or $sourceEnd -le $sourceStart){throw '来源判定片段缺失'}
$sourceGate=($statements[$sourceStart..($sourceEnd-1)]|ForEach-Object {$_.Extent.Text}) -join "`n"
$requiredAssignment=@($statements|Where-Object {$_.Extent.Text.StartsWith('$requiredSources=')})
if($requiredAssignment.Count -ne 1){throw '必要来源不唯一'}
Invoke-Expression $requiredAssignment[0].Extent.Text
$requiredNames=@($requiredSources)
function Bind-File([string]$Path,[long]$Maximum,[string]$ExpectedHash,[bool]$Small=$false){return @{length=128}}
$sourceCases=@('control','kind','scope','runtime','source-proof','artifact-extra','artifact-size','artifact-missing','path-parent','path-ads','path-backslash','path-absolute','path-unapproved')+@($requiredNames|ForEach-Object {'missing:'+$_})
foreach($case in $sourceCases) {
    $entries=[ordered]@{}
    foreach($name in $requiredNames){$entries[$name]='a'*64}
    $script:proof=[pscustomobject]@{version=1;scopeId=$ScopeId;kind='sources512-node-construction';productE2Pass=$false;electronQualified=$false;runtimeId='runtime-9399eea0c11d4e6f9cde46ae2369376b';sourceProof='f07a1a59ef5639d10c17eae1a80e6f7709d681623230c64d7bd54f4b089077e5';sources=[pscustomobject]$entries;artifacts=[pscustomobject]@{'allocation.cs'=@{bytes=128;sha256='a'*64};'FixedTransferJob.cs'=@{bytes=128;sha256='a'*64};'generate.cjs'=@{bytes=128;sha256='a'*64}}}
    switch($case) {
        'kind' {$script:proof.kind='research64-node-construction'}
        'scope' {$script:proof.scopeId='physical-sources512-'+('c'*32)}
        'runtime' {$script:proof.runtimeId='other'}
        'source-proof' {$script:proof.sourceProof='b'*64}
        'artifact-extra' {$script:proof.artifacts|Add-Member -NotePropertyName extra -NotePropertyValue @{bytes=128;sha256='a'*64}}
        'artifact-size' {$script:proof.artifacts.'generate.cjs'.bytes=127}
        'artifact-missing' {$script:proof.artifacts.PSObject.Properties.Remove('allocation.cs')}
        'path-parent' {$script:proof.sources|Add-Member -NotePropertyName 'src/../outside.ts' -NotePropertyValue ('a'*64)}
        'path-ads' {$script:proof.sources|Add-Member -NotePropertyName 'src/item:stream' -NotePropertyValue ('a'*64)}
        'path-backslash' {$script:proof.sources|Add-Member -NotePropertyName 'src/item\child' -NotePropertyValue ('a'*64)}
        'path-absolute' {$script:proof.sources|Add-Member -NotePropertyName 'C:/outside.ts' -NotePropertyValue ('a'*64)}
        'path-unapproved' {$script:proof.sources|Add-Member -NotePropertyName 'log/outside.ts' -NotePropertyValue ('a'*64)}
    }
    if($case.StartsWith('missing:')){$script:proof.sources.PSObject.Properties.Remove($case.Substring(8))}
    $accepted=$false
    try{Invoke-Expression $sourceGate;$accepted=$true}catch{}
    if($accepted -ne ($case -eq 'control')){throw ('来源判定错误：'+$case)}
    $outcomes.Add([pscustomobject]@{name=('source-'+$case);accepted=$accepted;proofReads=$script:proofReads;actualJob=$false})
}
$outcomes|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $evidence 'wrapper-gates-001.json')
@{passed=$outcomes.Count;actualJob=$false;actualCapacity=$false;productE2Pass=$false}|ConvertTo-Json
