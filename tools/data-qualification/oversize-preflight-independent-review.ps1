[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$evidence=Join-Path $repository 'log/stage7-e2/oversize-preflight-independent-review-001'
[IO.Directory]::CreateDirectory($evidence)|Out-Null
$run=Join-Path $evidence ('pure-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($run)|Out-Null
$candidate=Join-Path $PSScriptRoot 'oversize-preflight/run.ps1'
$source=[IO.File]::ReadAllText($candidate)
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count -ne 0){throw '候选语法失败'}
$body=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})
if($body.Count -ne 1){throw '候选主try不唯一'}
$body=$body[0];$statements=@($body.Body.Statements)
function Code-Between([string]$Start,[string]$End) {
    $last=@($statements|Where-Object {$_.Extent.Text.StartsWith($End)})
    if($last.Count -ne 1){throw '结束语句边界不唯一'}
    $first=@($statements|Where-Object {$_.Extent.Text.StartsWith($Start) -and $_.Extent.StartOffset -lt $last[0].Extent.StartOffset})
    if($first.Count -ne 1){throw '开始语句边界不唯一'}
    return $source.Substring($first[0].Extent.StartOffset,$last[0].Extent.StartOffset-$first[0].Extent.StartOffset)
}
$cases=[Collections.Generic.List[object]]::new()
function Record([string]$Name,[bool]$ExpectedRejected,[bool]$Rejected,$Details) {
    $cases.Add([pscustomobject]@{name=$Name;expectedRejected=$ExpectedRejected;rejected=$Rejected;pass=($ExpectedRejected -eq $Rejected);details=$Details})
}
$ScopeId='oversize-preflight-a57f580c38de497dbcfd6c48c3242afc';$phase='claim'
$initial=@($ast.EndBlock.Statements|Where-Object {$_.Extent.Text.StartsWith('$result=[ordered]')})
if($initial.Count -ne 1){throw '候选初始化不唯一'}
$rejected=$false;$errorId=$null;$errorText=$null
try {. ([ScriptBlock]::Create($initial[0].Extent.Text))}catch{$rejected=$true;$errorId=$_.FullyQualifiedErrorId;$errorText=$_.Exception.Message}
Record '真实wrapper结果初始化必须成功' $false $rejected @{errorId=$errorId;error=$errorText}

# Execute candidate functions on a tiny sparse input using both real native helpers.
Add-Type -Path @((Join-Path $PSScriptRoot 'full-transfer/FixedTransferJob.cs'),(Join-Path $PSScriptRoot 'oversize-preflight/SparseFile.cs'))
foreach($name in @('Check-Time','Assert-Parents','Write-NewJson','Read-Bound','Header-Hash','Hold-Sparse','Assert-Facts','Assert-Closure','Scope-Allocation')) {
    $definition=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq $name})
    if($definition.Count -ne 1){throw '候选函数不唯一'}
    . ([ScriptBlock]::Create($definition[0].Extent.Text))
}
$nativeLoaded=$true;$directories=@{};$clock=[Diagnostics.Stopwatch]::StartNew();$workMs=120000
$locks=[Collections.Generic.List[IO.FileStream]]::new();$facts=[Collections.Generic.List[object]]::new()
$scope=Join-Path $run 'native-small'
[IO.Directory]::CreateDirectory($scope)|Out-Null
$path=Join-Path $scope 'small-sparse.bin'
$created=[AIbrowse.OversizePreflight.SparseFile]::Create($path,1048577,[Text.Encoding]::ASCII.GetBytes('independent-small-header'))
Record '原生小稀疏控制' $false (-not ($created.Sparse -and $created.Length -eq 1048577 -and $created.AllocatedBytes -le 1048576)) @{length=$created.Length;allocated=$created.AllocatedBytes}
$rejected=$false;$errorId=$null;$errorText=$null
try {[void](Hold-Sparse $path $created)}catch{$rejected=$true;$errorId=$_.FullyQualifiedErrorId;$errorText=$_.Exception.Message}
Record '真实Hold-Sparse必须接纳自有小稀疏文件' $false $rejected @{errorId=$errorId;error=$errorText}
foreach($stream in $locks){$stream.Dispose()}
$locks.Clear();$facts.Clear()
$rejected=$false;$allocated=$null;$errorId=$null;$errorText=$null
try {$allocated=Scope-Allocation}catch{$rejected=$true;$errorId=$_.FullyQualifiedErrorId;$errorText=$_.Exception.Message}
Record '真实Scope-Allocation必须成功累计小文件' $false $rejected @{observed=$allocated;expected=$created.AllocatedBytes;errorId=$errorId;error=$errorText}

# Run the original claim prefix and catch, with a missing small build proof only.
$ScopeId='oversize-preflight-a57f580c38de497dbcfd6c48c3242afc'
$proofPath=Join-Path $repository ('log/stage7-e2/'+$ScopeId+'/build-proof.json')
$originalProof=[IO.File]::ReadAllText($proofPath)
$scope=Join-Path $run 'early-claim'
[IO.Directory]::CreateDirectory($scope)|Out-Null
$nativeLoaded=$false;$directories=@{};$phase='claim';$completed=$false
$result=[ordered]@{completed=$false;phase='claim';error=$null}
$prefix=Code-Between 'Assert-Parents $scope' '$phase=''binding'''
$prefixFailed=$false
try {. ([ScriptBlock]::Create($prefix))}catch{
    $prefixFailed=$true
    . ([ScriptBlock]::Create($body.CatchClauses[0].Body.Extent.Text.TrimStart('{').TrimEnd('}')))
}
$priorReceipt=Test-Path -LiteralPath (Join-Path $scope 'preflight-result.json')
$claimedBefore=Test-Path -LiteralPath (Join-Path $scope 'preflight-intent.json')
[IO.File]::WriteAllText((Join-Path $scope 'build-proof.json'),$originalProof,[Text.UTF8Encoding]::new($false))
$retryRejected=$false
try {. ([ScriptBlock]::Create($prefix))}catch{$retryRejected=$true}
Record '构建证明读取失败后必须消耗scope' $true $retryRejected @{firstFailed=$prefixFailed;priorReceipt=$priorReceipt;claimedAfterFailure=$claimedBefore;claimOnRetry=(Test-Path -LiteralPath (Join-Path $scope 'preflight-intent.json'))}
foreach($stream in $locks){$stream.Dispose()}
$locks.Clear();$facts.Clear()

# Execute the candidate source/artifact admission predicates with only bounded IO substituted.
# The substitution supplies current fixture facts; no native Execute or large EOF is reached.
$proofChecks=Code-Between '$required=' '$node='
function Read-Bound([string]$Path,[long]$Maximum,[bool]$Bytes=$false) {
    $script:bindings.Add($Path)
    if($Path.StartsWith($scope)) {
        $member=[IO.Path]::GetFileName($Path)
        return [pscustomobject]@{length=$build.artifacts.$member.bytes;hash=$build.artifacts.$member.sha256}
    }
    $member=$Path.Substring($repository.Length+1).Replace('\','/')
    return [pscustomobject]@{length=1;hash=$build.sources.$member}
}
$mutations=@(
    @{name='完整来源与制品控制';reject=$false;mutate={}},
    @{name='遗漏容器解析生产来源';reject=$true;mutate={$build.sources.PSObject.Properties.Remove('src/main/storage/backup-container.ts')}},
    @{name='遗漏路径身份生产来源';reject=$true;mutate={$build.sources.PSObject.Properties.Remove('src/main/storage/dataset-layout.ts')}},
    @{name='遗漏有界JSON生产来源';reject=$true;mutate={$build.sources.PSObject.Properties.Remove('src/main/storage/bounded-json.ts')}},
    @{name='遗漏会话投影生产来源';reject=$true;mutate={$build.sources.PSObject.Properties.Remove('src/main/ai/conversation-transfer.ts')}},
    @{name='遗漏必需wrapper来源控制';reject=$true;mutate={$build.sources.PSObject.Properties.Remove('tools/data-qualification/oversize-preflight/run.ps1')}},
    @{name='SparseFile制品未绑定同源字节';reject=$true;mutate={$build.artifacts.'SparseFile.cs'.sha256='b'*64}},
    @{name='缺worker制品控制';reject=$true;mutate={$build.artifacts.PSObject.Properties.Remove('worker.cjs')}},
    @{name='来源路径穿越控制';reject=$true;mutate={$build.sources|Add-Member -NotePropertyName 'src/../../escape.ts' -NotePropertyValue ('a'*64)}}
)
foreach($mutation in $mutations){
    $build=$originalProof|ConvertFrom-Json
    $bindings=[Collections.Generic.List[string]]::new()
    & $mutation.mutate
    $rejected=$false
    try {& ([ScriptBlock]::Create($proofChecks))}catch{$rejected=$true}
    Record $mutation.name $mutation.reject $rejected @{bindings=$bindings.Count}
}
$report=[ordered]@{
    version=1
    candidateSha256=(Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    buildProofSha256=(Get-FileHash -LiteralPath $proofPath -Algorithm SHA256).Hash.ToLowerInvariant()
    jobInvoked=$false
    actualLargeEofCreated=$false
    largeInputRead=$false
    smallEof=1048577
    cases=$cases.ToArray()
    total=$cases.Count
    passed=@($cases|Where-Object {$_.pass}).Count
    failed=@($cases|Where-Object {-not $_.pass}).Count
}
$json=$report|ConvertTo-Json -Depth 10
[IO.File]::WriteAllText((Join-Path $run 'counterexamples.json'),$json,[Text.UTF8Encoding]::new($false))
$json
if($report.failed -gt 0){exit 1}
