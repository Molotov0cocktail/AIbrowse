[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^full-conversations-[a-f0-9]{32}$')][string]$ScopeId,
    [Parameter(Mandatory)][ValidatePattern('^runtime-[a-f0-9]{32}$')][string]$RuntimeId
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7 -or -not [Environment]::Is64BitProcess) { throw '需要现有64位PowerShell7。' }
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$scope = Join-Path $repository "log\stage7-e2\$ScopeId"
$origin = Join-Path $repository "log\stage7-e2\$RuntimeId"
$workMs = 150000
$diskLimit = [int64](3202MB + 256KB)
$locks = [Collections.Generic.List[IO.FileStream]]::new()
$heldFacts = [Collections.Generic.List[object]]::new()

function Assert-Parents([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($true) {
        $item = Get-Item -LiteralPath $current -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '受控目录含链接或无效。' }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) { break }
        $current = $parent
    }
}
function Read-BoundFile([string]$Path, [long]$Maximum, [bool]$KeepOpen, [bool]$KeepBytes = $true) {
    Assert-Parents ([IO.Path]::GetDirectoryName($Path))
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt $Maximum) { throw '固定文件无效或过大。' }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $owned = $false
    try {
        if ($stream.Length -ne $item.Length) { throw '文件长度改变。' }
        $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant()
        $stream.Position = 0
        $bytes = [byte[]]::new(0)
        if ($KeepBytes) { $bytes = [byte[]]::new([int]$stream.Length); $stream.ReadExactly($bytes) }
        if ($KeepOpen) { $locks.Add($stream); $owned = $true }
        [pscustomobject]@{ hash = $hash; bytes = $bytes; length = $stream.Length; stream = $stream }
    } finally { if (-not $owned) { $stream.Dispose() } }
}
function Write-Receipt([string]$Path, $Value, [switch]$Hold) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 12))
    if ($bytes.Length -gt 65536) { throw '固定回执过大。' }
    $access = if ($Hold) { [IO.FileAccess]::ReadWrite } else { [IO.FileAccess]::Write }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, $access, [IO.FileShare]::Read)
    $owned = $false
    try {
        $stream.Write($bytes); $stream.Flush($true)
        if ($Hold) {
            $locks.Add($stream); $owned = $true
            [pscustomobject]@{ stream=$stream; length=$bytes.Length; hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() }
        }
    } finally { if (-not $owned) { $stream.Dispose() } }
}
function Capture-HeldFact([IO.FileStream]$Stream, [string]$Hash = '') {
    [pscustomobject]@{ stream=$Stream; fact=[AIbrowse.FullConversations.FixedPrepareJob]::InspectFile($Stream); hash=$Hash }
}
function Assert-HeldHashes($Bindings) {
    foreach ($binding in $Bindings) {
        if ($binding.hash -ceq '') { continue }
        if ($binding.hash -cnotmatch '^[a-f0-9]{64}$' -or $binding.stream.Length -gt 65536) { throw '小证明绑定无效。' }
        $binding.stream.Position = 0
        if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($binding.stream)).ToLowerInvariant() -cne $binding.hash) { throw '小证明内容改变。' }
    }
}
function Assert-HeldFacts($Bindings) {
    foreach ($binding in $Bindings) {
        $actual = [AIbrowse.FullConversations.FixedPrepareJob]::InspectFile($binding.stream)
        $before = $binding.fact
        if ($actual.Dev -cne $before.Dev -or $actual.Ino -cne $before.Ino -or $actual.Size -ne $before.Size -or $actual.MtimeNs -cne $before.MtimeNs -or $actual.CtimeNs -cne $before.CtimeNs -or $actual.Links -ne $before.Links) { throw '最终文件事实改变。' }
    }
}
function Enter-CleanEnvironment {
    $saved = @{}
    $allow = @('SystemRoot','WINDIR','SystemDrive','TEMP','TMP','COMSPEC','PATHEXT','PATH','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE')
    foreach ($item in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
        if ($allow -notcontains [string]$item.Key) {
            $saved[[string]$item.Key] = [string]$item.Value
            [Environment]::SetEnvironmentVariable([string]$item.Key, [NullString]::Value, 'Process')
        }
    }
    return $saved
}
function Restore-Environment([hashtable]$Saved) {
    foreach ($item in $Saved.GetEnumerator()) { [Environment]::SetEnvironmentVariable($item.Key,$item.Value,'Process') }
}

$result = [ordered]@{ version=1; scopeId=$ScopeId; runtimeId=$RuntimeId; completed=$false; productE2Pass=$false; job=$null; error=$null; durationMs=0 }
$saved = $null
$intentWritten = $false
$clock = [Diagnostics.Stopwatch]::StartNew()
try {
    Assert-Parents $scope
    Assert-Parents $origin
    $initialNames = @((Get-ChildItem -LiteralPath $scope -Force).Name | Sort-Object)
    if (($initialNames -join '|') -cne 'build-proof.json|prepare.cjs') { throw '候选已运行或出现未知文件，禁止重跑。' }
    $intentReceipt = Write-Receipt (Join-Path $scope 'run-intent.json') ([ordered]@{ version=1; scopeId=$ScopeId; runtimeId=$RuntimeId; state='claimed'; productE2Pass=$false }) -Hold
    $intentWritten = $true
    $buildReceipt = Read-BoundFile (Join-Path $scope 'build-proof.json') 65536 $true
    $build = [Text.UTF8Encoding]::new($false,$true).GetString($buildReceipt.bytes) | ConvertFrom-Json
    if ($build.version -ne 1 -or $build.scopeId -cne $ScopeId -or $build.nodeVersion -notmatch '^v24\.') { throw '构建证明身份不符。' }
    $fixedSources = @(
        'tools/data-qualification/full-conversations/files.ts','tools/data-qualification/full-conversations/main.ts',
        'tools/data-qualification/full-conversations/entry.ts','tools/data-qualification/full-conversations/build.ts',
        'tools/data-qualification/projection/samples.ts','tools/data-qualification/projection/projection.ts',
        'tools/data-qualification/fixtures.ts','src/main/ai/conversation-transfer.ts',
        'src/main/storage/bounded-json.ts','package.json','package-lock.json'
    )
    if ((@($build.sources.PSObject.Properties.Name | Sort-Object) -join '|') -cne (@($fixedSources | Sort-Object) -join '|')) { throw '源码绑定集合不符。' }
    foreach ($name in $fixedSources) {
        $bound = Read-BoundFile (Join-Path $repository $name) 1048576 $true
        if ($bound.hash -cne $build.sources.$name) { throw '源码摘要变化。' }
    }
    $bundle = Read-BoundFile (Join-Path $scope 'prepare.cjs') 851968 $true
    if ($bundle.hash -cne $build.bundleSha256) { throw '工具制品摘要变化。' }
    $seedProof = Read-BoundFile (Join-Path $origin 'fixture-proof.json') 65536 $true
    $seed = [Text.UTF8Encoding]::new($false,$true).GetString($seedProof.bytes) | ConvertFrom-Json
    if ($seed.completed -ne $true -or $seed.productE2Pass -ne $false) { throw '来源证明未完成。' }
    $seedPath = Join-Path $origin 'fixtures/conversations/00000000-0000-4000-8000-000000000000.json'
    $seedHash = $seed.hashes.'fixtures/conversations/00000000-0000-4000-8000-000000000000.json'
    $seedReceipt = Read-BoundFile $seedPath 67108864 $true $false
    if ($seedReceipt.length -ne 67108864 -or $seedReceipt.hash -cne $seedHash) { throw '固定原始会话大小或摘要不符。' }
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $nodeIdentity = Read-BoundFile $node 104857600 $true $false
    if ('v' + (Get-Item -LiteralPath $node).VersionInfo.ProductVersion -cne $build.nodeVersion) { throw '实际Node版本不符。' }
    $helper = Join-Path $PSScriptRoot 'FixedPrepareJob.cs'
    $helperIdentity = Read-BoundFile $helper 65536 $true
    $runnerIdentity = Read-BoundFile $PSCommandPath 65536 $true
    Add-Type -Path $helper
    foreach ($stream in $locks) { $heldFacts.Add((Capture-HeldFact $stream)) }
    foreach ($receipt in @($intentReceipt,$buildReceipt,$seedProof)) {
        $heldFacts.Add((Capture-HeldFact $receipt.stream $receipt.hash))
    }
    $seedIdentity = ($heldFacts | Where-Object { [object]::ReferenceEquals($_.stream,$seedReceipt.stream) }).fact
    $disk = [AIbrowse.FullConversations.FixedPrepareJob]::InspectDisk($scope)
    if ($disk.AvailableBytes -lt $disk.RequiredBytes) { throw '目标卷可用空间不足固定分配预算及1GiB余量。' }
    $jobId = [Guid]::NewGuid().ToString('N')
    $intent = [ordered]@{ version=1; scopeId=$ScopeId; runtimeId=$RuntimeId; jobId=$jobId; productE2Pass=$false;
        workMs=$workMs; terminationOnlyMs=30000; activeProcessLimit=1; nativeProcessCommitBytes=2147483648;
        nativeJobCommitBytes=2147483648; sampledRssLimitBytes=1073741824; v8OldSpaceMiB=768; sampleMs=100;
        diskBytes=$diskLimit; disk=$disk; nodeVersion=$build.nodeVersion; nodeSha256=$nodeIdentity.hash;
        buildProofSha256=$buildReceipt.hash; seedProofSha256=$seedProof.hash; seedSha256=$seedReceipt.hash; seedBytes=$seedReceipt.length; seedIdentity=$seedIdentity; bundleSha256=$bundle.hash;
        helperSha256=$helperIdentity.hash; runnerSha256=$runnerIdentity.hash }
    $launchReceipt = Write-Receipt (Join-Path $scope 'run-launch.json') $intent -Hold
    $heldFacts.Add((Capture-HeldFact $launchReceipt.stream $launchReceipt.hash))
    $remaining = $workMs - [int]$clock.ElapsedMilliseconds
    if ($remaining -le 0) { throw '工作期限已到。' }
    $saved = Enter-CleanEnvironment
    $result.job = [AIbrowse.FullConversations.FixedPrepareJob]::Execute($node,(Join-Path $scope 'prepare.cjs'),$RuntimeId,$scope,$jobId,$remaining)
    Restore-Environment $saved
    $saved = $null
    if (-not $result.job.Succeeded -or -not $result.job.ActualZero -or $result.job.OwnershipRetained) { throw '受控Job未完成，原件保留。' }
    $report = Read-BoundFile (Join-Path $scope 'prepare-result.json') 65536 $true
    $heldFacts.Add((Capture-HeldFact $report.stream $report.hash))
    $value = [Text.UTF8Encoding]::new($false,$true).GetString($report.bytes) | ConvertFrom-Json
    $proofReceipt = Read-BoundFile (Join-Path $scope 'fixture-proof.json') 65536 $true
    $heldFacts.Add((Capture-HeldFact $proofReceipt.stream $proofReceipt.hash))
    $proof = [Text.UTF8Encoding]::new($false,$true).GetString($proofReceipt.bytes) | ConvertFrom-Json
    if ($value.completed -ne $true -or $value.productE2Pass -ne $false -or $value.durationMs -gt $workMs -or $proof.completed -ne $true -or $proof.nodeVersion -cne $build.nodeVersion -or $proof.scopeId -cne $ScopeId -or $proof.sessions -ne 50 -or $proof.messageCount -ne 200 -or $proof.sessionBytes -ne 67108864 -or $proof.buildProofSha256 -cne $buildReceipt.hash -or $proof.seed.sourceId -cne $RuntimeId -or $proof.seed.proofSha256 -cne $seedProof.hash) { throw '固定准备回执无效。' }
    $memberNames = @('index.json') + @(0..49 | ForEach-Object { '00000000-0000-4000-8000-{0:x12}.json' -f $_ })
    if ((@($proof.files.PSObject.Properties.Name | Sort-Object) -join '|') -cne (@($memberNames | Sort-Object) -join '|')) { throw '证明成员不闭合。' }
    foreach ($name in $memberNames) {
        $member = Join-Path $scope "conversations\$name"
        Assert-Parents ([IO.Path]::GetDirectoryName($member))
        $held = [IO.File]::Open($member,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        $locks.Add($held)
        $fact = [AIbrowse.FullConversations.FixedPrepareJob]::InspectFile($held)
        $heldFacts.Add([pscustomobject]@{ stream=$held; fact=$fact; hash='' })
        $claimed = $proof.files.$name
        if ($fact.Dev -cne $claimed.identity.dev -or $fact.Ino -cne $claimed.identity.ino -or $fact.MtimeNs -cne $claimed.identity.mtimeNs -or $fact.CtimeNs -cne $claimed.identity.ctimeNs -or $fact.Size -ne $claimed.bytes) { throw '退出后成员身份变化。' }
        if ($name -ne 'index.json' -and ($fact.Size -ne 67108864 -or $claimed.sha256 -cne $seedHash)) { throw '完整会话成员不符。' }
        if ($name -eq 'index.json' -and ($fact.Size -gt 65536 -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($held)).ToLowerInvariant() -cne $claimed.sha256)) { throw '索引摘要不符。' }
    }
    $expected = @('build-proof.json','prepare.cjs','fixture-proof.json','prepare-result.json','run-intent.json','run-launch.json','conversations')
    if ((@((Get-ChildItem -LiteralPath $scope -Force).Name | Sort-Object) -join '|') -cne (@($expected | Sort-Object) -join '|')) { throw '候选根出现未知成员。' }
    $total = 0L
    $files = @(Get-ChildItem -LiteralPath $scope -Force -Recurse)
    if ($files.Count -ne 58) { throw '实际成员数不符。' }
    foreach ($file in $files) {
        if ($file.Attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::SparseFile -bor [IO.FileAttributes]::Compressed)) { throw '输出不是独立普通非稀疏文件集合。' }
        if (-not $file.PSIsContainer) { $total += $file.Length }
    }
    if ($total + 65536 -gt $diskLimit -or $clock.ElapsedMilliseconds -ge $workMs) { throw '工作或磁盘预算超限。' }
    $result.completed = $true
    $result['directoryBytesBeforeReceipt'] = $total
    $result['fixtureProofSha256'] = $proofReceipt.hash
} catch {
    $result.error = '完整会话准备失败，全部原件保留；不得自动重跑。'
} finally {
    if ($null -ne $saved) { Restore-Environment $saved }
    try {
        $result.durationMs = $clock.Elapsed.TotalMilliseconds
        if ($result.durationMs -ge $workMs) { $result.completed=$false }
        if ($intentWritten) {
            $finalReceipt = Write-Receipt (Join-Path $scope 'run-result.json') $result -Hold
            if ($result.completed) { $heldFacts.Add((Capture-HeldFact $finalReceipt.stream $finalReceipt.hash)) }
        }
        if ($result.completed) {
            Assert-HeldHashes $heldFacts
            Assert-Parents $scope
            Assert-Parents (Join-Path $scope 'conversations')
            $expectedFinal = @('build-proof.json','prepare.cjs','fixture-proof.json','prepare-result.json','run-intent.json','run-launch.json','run-result.json','conversations')
            if ((@((Get-ChildItem -LiteralPath $scope -Force).Name | Sort-Object) -join '|') -cne (@($expectedFinal | Sort-Object) -join '|') -or (@((Get-ChildItem -LiteralPath (Join-Path $scope 'conversations') -Force).Name | Sort-Object) -join '|') -cne (@($memberNames | Sort-Object) -join '|')) { $result.completed=$false }
            Assert-HeldFacts $heldFacts
        }
        if ($clock.ElapsedMilliseconds -ge $workMs) { $result.completed=$false }
    } catch {
        $result.completed=$false
        $result.error='最终文件事实复核失败，全部原件保留。'
    } finally { foreach ($stream in $locks) { $stream.Dispose() } }
    $result.durationMs = $clock.Elapsed.TotalMilliseconds
    if ($clock.ElapsedMilliseconds -ge $workMs) { $result.completed=$false }
}
$result | ConvertTo-Json -Depth 12
if (-not $result.completed) { exit 1 }
