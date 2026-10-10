[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$evidence = Join-Path $repository 'log/stage7-e2/physical-full-transfer-independent-review-001'
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
$proofPath = Join-Path $repository 'log/stage7-e2/physical-full-transfer-51616c6a6882462e97e1f7c82834e224/build-proof.json'
$originalProof = [IO.File]::ReadAllText($proofPath)
$ScopeId = 'physical-full-transfer-51616c6a6882462e97e1f7c82834e224'
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
)
foreach($mutation in $mutations) {
    $build=$originalProof|ConvertFrom-Json
    $bindings=[Collections.Generic.List[string]]::new()
    & $mutation.mutate
    $rejected=$false
    try { & ([ScriptBlock]::Create($proofChecks)) } catch {$rejected=$true}
    Record $mutation.name $mutation.reject $rejected @{bindings=$bindings.Count}
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
$preflight=Code-Between 'Assert-Parents $scope' '$intent='
$preflightFailed=$false
try { & ([ScriptBlock]::Create($preflight)) } catch {$preflightFailed=$true}
$guard=@($statements|Where-Object {$_.Extent.Text.StartsWith('if(Test-Path -LiteralPath (Join-Path $scope "$Mode-intent.json"))')})
if($guard.Count -ne 1){throw 'once门不唯一'}
$reuseRejected=$false
try { & ([ScriptBlock]::Create($guard[0].Extent.Text)) } catch {$reuseRejected=$true}
Record '预检失败后同scope必须拒绝复用' $true $reuseRejected @{preflightFailed=$preflightFailed;intentExists=(Test-Path -LiteralPath (Join-Path $scope 'import-intent.json'))}
[IO.File]::WriteAllText((Join-Path $scope 'import-intent.json'),'{}')
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
foreach($lateMode in @('control','assert','deadline')) {
    $scope=Join-Path $evidence ('terminal-'+$lateMode+'-'+[Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($scope)|Out-Null
    $clock=[Diagnostics.Stopwatch]::StartNew()
    $workMs=120000
    $locks=[Collections.Generic.List[IO.FileStream]]::new()
    $heldFacts=[Collections.Generic.List[object]]::new()
    $result=[ordered]@{completed=$false;durationMs=0;error=$null;job=@{Succeeded=$true;ActualZero=$true;OwnershipRetained=$false}}
    . ([ScriptBlock]::Create($finish))
    $importResult=[IO.File]::ReadAllText((Join-Path $scope 'import-result.json'))|ConvertFrom-Json
    $rejected=$false
    try { & ([ScriptBlock]::Create($importGate[0].Extent.Text)) } catch {$rejected=$true}
    Record ('落盘后收尾-'+$lateMode) ($lateMode -ne 'control') $rejected @{terminalCompleted=$result.completed;receiptCompleted=$importResult.completed}
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
