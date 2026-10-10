[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$evidence = Join-Path $repository 'log/stage7-e2/physical-full-transfer-independent-repair-001'
$candidate = Join-Path $PSScriptRoot 'physical-full-transfer/run.ps1'
$text = [IO.File]::ReadAllText($candidate)
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw '候选语法失败' }
$body = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })
if ($body.Count -ne 1) { throw '候选主try不唯一' }
$body = $body[0]
$statements = @($body.Body.Statements)
$cases = [Collections.Generic.List[object]]::new()
function Record([string]$Name, [bool]$ExpectedRejected, [bool]$Rejected, $Details) {
    $cases.Add([pscustomobject]@{name=$Name;expectedRejected=$ExpectedRejected;rejected=$Rejected;pass=($ExpectedRejected -eq $Rejected);details=$Details})
}
function Code-Between([string]$Start, [string]$End) {
    $last = @($statements | Where-Object {$_.Extent.Text.StartsWith($End)})
    if ($last.Count -ne 1) { throw '原结束语句边界不唯一' }
    $first = @($statements | Where-Object {$_.Extent.Text.StartsWith($Start) -and $_.Extent.StartOffset -lt $last[0].Extent.StartOffset})
    if ($first.Count -ne 1) { throw '原开始语句边界不唯一' }
    return $text.Substring($first[0].Extent.StartOffset,$last[0].Extent.StartOffset-$first[0].Extent.StartOffset)
}

# Execute the original proof predicates with IO binding replaced by a recorder.
# No candidate wrapper, native Execute, import, or transfer is invoked.
$proofPath = Join-Path $repository 'log/stage7-e2/physical-full-transfer-d4c9d36de2b34b02b16c6dca36126d12/build-proof.json'
$originalProof = [IO.File]::ReadAllText($proofPath)
$ScopeId = 'physical-full-transfer-d4c9d36de2b34b02b16c6dca36126d12'
$scope = Join-Path $evidence 'proof-only'
$proofChecks = Code-Between 'if($build.version' '$node='
function Bind-File([string]$Path,[long]$Maximum,[string]$ExpectedHash,[bool]$Small=$false) {
    $script:bindings.Add($Path)
    if($Path.StartsWith($scope)) {
        $member=$Path.Substring($scope.Length+1).Replace('\','/')
        return [pscustomobject]@{length=$build.artifacts.$member.bytes}
    }
    return [pscustomobject]@{length=0}
}
$mutations = @(
    @{name='完整证明控制';reject=$false;mutate={}},
    @{name='遗漏生产worker来源';reject=$true;mutate={$build.sources.PSObject.Properties.Remove('src/main/storage/transfer-worker.ts')}},
    @{name='遗漏wrapper来源';reject=$true;mutate={$build.sources.PSObject.Properties.Remove('tools/data-qualification/physical-full-transfer/run.ps1')}},
    @{name='清空bundle闭包';reject=$true;mutate={$build.bundleInputs=@()}},
    @{name='bundle声明不存在于sources的成员';reject=$true;mutate={$build.bundleInputs[2]+=@('src/main/storage/unbound-review-only.ts')}},
    @{name='遗漏映射控制';reject=$true;mutate={$build.mappings=@($build.mappings|Select-Object -Skip 1)}},
    @{name='重复映射控制';reject=$true;mutate={$build.mappings+=@($build.mappings[0])}},
    @{name='混入旧输入控制';reject=$true;mutate={$build.bundleInputs[0]+=@('tools/data-qualification/full-transfer/input.ts')}},
    @{name='缺制品控制';reject=$true;mutate={$build.artifacts.PSObject.Properties.Remove('allocation.cs')}},
    @{name='来源路径穿越控制';reject=$true;mutate={$build.sources|Add-Member -NotePropertyName 'src/../../outside.ts' -NotePropertyValue ('a'*64)}}
    @{name='交换bundle入口';reject=$true;mutate={$temp=$build.bundleInputs[0];$build.bundleInputs[0]=$build.bundleInputs[1];$build.bundleInputs[1]=$temp}},
    @{name='同长度重复bundle成员';reject=$true;mutate={$build.bundleInputs[2][1]=$build.bundleInputs[2][0]}},
    @{name='额外未构建source';reject=$true;mutate={$build.sources|Add-Member -NotePropertyName 'src/main/extra-review-only.ts' -NotePropertyValue ('a'*64)}}
)
foreach($mutation in $mutations) {
    $build=$originalProof|ConvertFrom-Json
    $bindings=[Collections.Generic.List[string]]::new()
    & $mutation.mutate
    $rejected=$false
    try { & ([ScriptBlock]::Create($proofChecks)) } catch {$rejected=$true}
    Record $mutation.name $mutation.reject $rejected @{bindings=$bindings.Count}
}
foreach($sourceName in ($originalProof|ConvertFrom-Json).sources.PSObject.Properties.Name) {
    $build=$originalProof|ConvertFrom-Json
    $build.sources.PSObject.Properties.Remove($sourceName)
    $bindings=[Collections.Generic.List[string]]::new()
    $rejected=$false
    try { & ([ScriptBlock]::Create($proofChecks)) } catch {$rejected=$true}
    Record ('逐来源遗漏：'+$sourceName) $true $rejected $null
}

# Load only the original small-file/claim functions, with native facts substituted.
foreach($name in @('Check-Time','Assert-Parents','Read-BoundFile','Write-Receipt')) {
    $function=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq $name})
    if($function.Count -ne 1){throw '候选函数不唯一'}
    . ([ScriptBlock]::Create($function[0].Extent.Text))
}
$nativeLoaded=$false
$boundDirectories=@{}
$Mode='import'
$workMs=120000
$clock=[Diagnostics.Stopwatch]::StartNew()
$locks=[Collections.Generic.List[IO.FileStream]]::new()
$heldFacts=[Collections.Generic.List[object]]::new()
$saved=$null
$scope=Join-Path $evidence ('preflight-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($scope)|Out-Null
$preflight=Code-Between 'Assert-Parents $scope' '$assemblyPath='
$preflightFailed=$false
try { & ([ScriptBlock]::Create($preflight)) } catch {$preflightFailed=$true}
$guard=@($statements|Where-Object {$_.Extent.Text.StartsWith('if(Test-Path -LiteralPath (Join-Path $scope "$Mode-intent.json"))')})
if($guard.Count -ne 1){throw 'once门不唯一'}
$reuseRejected=$false
try { & ([ScriptBlock]::Create($guard[0].Extent.Text)) } catch {$reuseRejected=$true}
Record '预检失败后同scope必须拒绝复用' $true $reuseRejected @{preflightFailed=$preflightFailed;intentExists=(Test-Path -LiteralPath (Join-Path $scope 'import-intent.json'))}
$claimBefore=[IO.File]::ReadAllBytes((Join-Path $scope 'import-intent.json'))
$concurrentClaimRejected=$false
try {Write-Receipt (Join-Path $scope 'import-intent.json') @{version=1;scopeId=$ScopeId;mode='import'}} catch {$concurrentClaimRejected=$true}
$claimAfter=[IO.File]::ReadAllBytes((Join-Path $scope 'import-intent.json'))
Record '并发CreateNew拒绝且原claim不变' $true ($concurrentClaimRejected -and [Convert]::ToHexString($claimBefore) -ceq [Convert]::ToHexString($claimAfter)) $null
$reuseRejected=$false
try { & ([ScriptBlock]::Create($guard[0].Extent.Text)) } catch {$reuseRejected=$true}
Record '已有intent控制' $true $reuseRejected $null

$start=@($statements|Where-Object {$_.Extent.Text.StartsWith('$result.completed=$true')})[0].Extent.StartOffset
$last=$statements[-1].Extent.EndOffset
$tail=$text.Substring($start,$last-$start)
$finish='try {'+[Environment]::NewLine+$tail+[Environment]::NewLine+'} '+$body.CatchClauses[0].Extent.Text+' finally '+$body.Finally.Extent.Text
$importGate=$body.FindAll({param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.StartsWith('if($importResult.completed')},$true)
if($importGate.Count -ne 1){throw '后继导入结果门不唯一'}
function Capture-HeldFact([IO.FileStream]$Stream,[string]$Hash='') {return [pscustomobject]@{stream=$Stream;hash=$Hash}}
function Assert-Held {
    if($script:lateMode -eq 'assert'){throw '独立注入：最终身份复核失败'}
    if($script:lateMode -eq 'deadline'){$script:workMs=0}
}
function Restore-Environment([hashtable]$Saved){if($script:lateMode -eq 'restore-environment'){throw '独立注入：环境恢复失败'}}
$receiptFunction=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq 'Write-Receipt'})[0]
$receiptFunctionSource=$receiptFunction.Extent.Text
$move='[IO.File]::Move($writePath,$Path,$false)'
if(($receiptFunctionSource.Split($move)).Count -ne 2){throw '原发布调用不唯一'}
# Preserve the original native Move while advancing only the test clock during its boundary.
$timedReceipt=$receiptFunctionSource.Replace($move,'if($script:lateMode -eq ''move-deadline''){$script:clock.Elapsed.TotalMilliseconds=$script:workMs+1}; '+$move)
. ([ScriptBlock]::Create($timedReceipt))
foreach($lateMode in @('control','assert','deadline','restore-environment','close-failure','pending-collision','move-deadline')) {
    $scope=Join-Path $evidence ('terminal-'+$lateMode+'-'+[Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($scope)|Out-Null
    $clock=[pscustomobject]@{Elapsed=[pscustomobject]@{TotalMilliseconds=1}}
    $workMs=120000
    $locks=[Collections.Generic.List[object]]::new()
    $heldFacts=[Collections.Generic.List[object]]::new()
    $resourcesClosed=$false
    $terminalCommitted=$false
    $saved=if($lateMode -eq 'restore-environment'){@{review='synthetic'}}else{$null}
    if($lateMode -eq 'close-failure'){
        $failingHandle=[pscustomobject]@{}
        $failingHandle|Add-Member -MemberType ScriptMethod -Name Dispose -Value {throw '独立注入：句柄关闭失败'}
        $locks.Add($failingHandle)
    }
    if($lateMode -eq 'pending-collision'){[IO.File]::WriteAllText((Join-Path $scope 'import-result.json.pending'),'保留的先前临时回执')}
    $result=[ordered]@{completed=$false;durationMs=0;error=$null;job=@{Succeeded=$true;ActualZero=$true;OwnershipRetained=$false}}
    $escaped=$false
    try {. ([ScriptBlock]::Create($finish))}catch{$escaped=$true}
    $importResult=[IO.File]::ReadAllText((Join-Path $scope 'import-result.json'))|ConvertFrom-Json
    $rejected=$false
    try { & ([ScriptBlock]::Create($importGate[0].Extent.Text)) } catch {$rejected=$true}
    Record ('落盘后收尾-'+$lateMode) ($lateMode -ne 'control') $rejected @{terminalCompleted=$result.completed;receiptCompleted=$importResult.completed;finalElapsedMs=$clock.Elapsed.TotalMilliseconds;workMs=$workMs;terminalCommitted=$terminalCommitted;escaped=$escaped}
}
$report=[ordered]@{
    version=1
    candidateSha256=(Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    originalProofSha256=(Get-FileHash -LiteralPath $proofPath -Algorithm SHA256).Hash.ToLowerInvariant()
    jobInvoked=$false
    largeInputRead=$false
    cases=$cases.ToArray()
    total=$cases.Count
    passed=@($cases|Where-Object {$_.pass}).Count
    failed=@($cases|Where-Object {-not $_.pass}).Count
}
$json=$report|ConvertTo-Json -Depth 10
[IO.File]::WriteAllText((Join-Path $evidence 'wrapper-counterexamples.json'),$json,[Text.UTF8Encoding]::new($false))
$json
if($report.failed -gt 0){exit 1}
