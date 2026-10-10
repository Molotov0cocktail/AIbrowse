[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$evidence=Join-Path $repository 'log/stage7-e2/oversize-preflight-independent-review-001'
$run=Join-Path $evidence ('terminal-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($run)|Out-Null
$candidate=Join-Path $PSScriptRoot 'oversize-preflight/run.ps1'
$source=[IO.File]::ReadAllText($candidate)
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count -ne 0){throw '候选语法失败'}
$body=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})
if($body.Count -ne 1){throw '候选主try不唯一'}
$body=$body[0];$statements=@($body.Body.Statements)
$start=@($statements|Where-Object {$_.Extent.Text -ceq '$result.completed=$false'})
if($start.Count -ne 1){throw '候选尾部入口不唯一'}
$tail=$source.Substring($start[0].Extent.StartOffset,$statements[-1].Extent.EndOffset-$start[0].Extent.StartOffset)
if($tail.Contains('::Execute(') -or $tail.Contains('SparseFile]::Create')){throw '尾部存在实际执行动作'}
$finish='try {'+[Environment]::NewLine+$tail+[Environment]::NewLine+'} '+$body.CatchClauses[0].Extent.Text+' finally '+$body.Finally.Extent.Text
Add-Type -Path (Join-Path $PSScriptRoot 'full-transfer/FixedTransferJob.cs')
foreach($name in @('Check-Time','Assert-Parents','Write-NewJson','Read-Bound','Assert-Closure')) {
    $definition=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq $name})
    if($definition.Count -ne 1){throw '候选函数不唯一'}
    . ([ScriptBlock]::Create($definition[0].Extent.Text))
}
# Only the late failure oracles are injected; actual receipt IO, closure, and finally run unchanged.
function Scope-Allocation {
    if($script:mode -eq 'late-allocation'){return 16777217L}
    return 4096L
}
function Assert-Facts {
    if($script:mode -eq 'late-identity'){throw '独立反例：末尾身份漂移'}
    if($script:mode -eq 'late-deadline'){$script:workMs=0}
}
$cases=[Collections.Generic.List[object]]::new()
foreach($mode in @('normal','late-identity','late-deadline','late-allocation')) {
    $ScopeId='oversize-preflight-'+('b'*32)
    $scope=Join-Path $run $mode
    [IO.Directory]::CreateDirectory($scope)|Out-Null
    $nativeLoaded=$true;$directories=@{};$clock=[Diagnostics.Stopwatch]::StartNew();$workMs=120000
    $locks=[Collections.Generic.List[IO.FileStream]]::new();$facts=[Collections.Generic.List[object]]::new()
    $saved=$null;$phase='receipt';$completed=$false;$job=$null;$beforeResult=@()
    # The separate review preserves the candidate initialization failure (actualRun=true).
    # Supply its intended object only to reach and test the unchanged terminal statements.
    $result=[ordered]@{version=1;scopeId=$ScopeId;kind='oversize-preflight-wrapper';completed=$false;phase=$phase;durationMs=0;job=$null;toolAllocatedBytes='pending-wrapper-exit';requiresWrapperExit=$true;productE2Pass=$false;capacityQualified=$false;enospcQualified=$false;actualRun=$true;error=$null}
    . ([ScriptBlock]::Create($finish))
    $receipt=[IO.File]::ReadAllText((Join-Path $scope 'preflight-result.json'))|ConvertFrom-Json
    $expected=($mode -eq 'normal')
    $cases.Add([pscustomobject]@{
        mode=$mode
        pass=($completed -eq $expected -and $result.completed -eq $expected -and $receipt.completed -eq $false -and $receipt.phase -ceq 'pending-wrapper-exit' -and $receipt.requiresWrapperExit -eq $true)
        wrapperCompleted=$completed
        resultCompleted=$result.completed
        receiptCompleted=$receipt.completed
        receiptPhase=$receipt.phase
        requiresWrapperExit=$receipt.requiresWrapperExit
    })
}
$report=[ordered]@{version=1;candidateSha256=(Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant();jobInvoked=$false;actualLargeEofCreated=$false;actualWrapperRun=$false;initializationSubstituted=$true;cases=$cases.ToArray();total=$cases.Count;passed=@($cases|Where-Object {$_.pass}).Count;failed=@($cases|Where-Object {-not $_.pass}).Count}
$json=$report|ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path $run 'terminal.json'),$json,[Text.UTF8Encoding]::new($false))
$json
if($report.failed -gt 0){exit 1}
