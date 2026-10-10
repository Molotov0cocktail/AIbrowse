[CmdletBinding()]
param([Parameter(Mandatory)][ValidatePattern('^drain-[a-f0-9]{32}$')][string]$BuildId)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) { throw '需要现有 PowerShell 7。' }
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$root = Join-Path $repository "log\stage7-e2\$BuildId"
$bundle = Join-Path $root 'fixture.cjs'
foreach ($target in @($repository, (Join-Path $repository 'log'), (Join-Path $repository 'log\stage7-e2'), $root, $bundle, (Join-Path $root 'build-proof.json'))) {
    $item = Get-Item -LiteralPath $target
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '资格路径不得包含重解析点。' }
}
if ((Test-Path -LiteralPath (Join-Path $root 'runtime')) -or (Test-Path -LiteralPath (Join-Path $root 'job-result.json'))) { throw '本构建已运行或已有证据，禁止覆盖重跑。' }
$proof = Get-Content -LiteralPath (Join-Path $root 'build-proof.json') -Raw | ConvertFrom-Json
if ($proof.buildId -ne $BuildId -or $proof.version -ne 1) { throw '构建证据身份不符。' }
$originalHash = (Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant()
if ($proof.bundleSha256 -cne $originalHash) { throw '实际夹具摘要不符。' }
$launcherHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($proof.toolingHashes.'tools/data-qualification/drain/run.ps1' -cne $launcherHash) { throw '启动器与本次构建证据不一致，须重新静态构建。' }
if ($proof.budget.rounds -ne 3 -or $proof.budget.roundMs -ne 20000 -or $proof.budget.jobMs -ne 90000 -or $proof.budget.jobCleanupMs -ne 30000 -or $proof.budget.diskBytes -ne 1073741824) { throw '冻结资格预算不符。' }

function Enter-FixedEnvironment {
    $saved = @{}
    $allow = @('SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'PATH', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE')
    foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
        if ($allow -notcontains [string]$entry.Key) {
            $saved[[string]$entry.Key] = [string]$entry.Value
            [Environment]::SetEnvironmentVariable([string]$entry.Key, [NullString]::Value, 'Process')
        }
    }
    return $saved
}

function Restore-FixedEnvironment([hashtable]$Saved) {
    foreach ($entry in $Saved.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
}

$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$preflightEnvironment = Enter-FixedEnvironment
try { $nodeVersion = & $node --version }
finally { Restore-FixedEnvironment $preflightEnvironment }
if ($LASTEXITCODE -ne 0 -or $nodeVersion -cne $proof.node -or $nodeVersion -notmatch '^v24\.') { throw 'Node 与构建版本不符。' }
$nodeHash = (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant()
Add-Type -Path (Join-Path $repository 'tools\release-profile\JobProcess.cs')
$jobId = [Guid]::NewGuid().ToString('N')
$clock = [Diagnostics.Stopwatch]::StartNew()
$result = [ordered]@{ version = 1; buildId = $BuildId; jobId = $jobId; launched = $false; jobReleased = $false; rootProcessId = $null; rootCreated = $null; durationMs = $null; directoryBytes = $null; error = $null; exitCode = $null; completed = $false; productE2Pass = $false; classification = '未完成'; bundleSha256 = $originalHash; launcherSha256 = $launcherHash; node = $nodeVersion; nodeSha256 = $nodeHash }
$saved = Enter-FixedEnvironment
try {
    $callback = [Action[uint32,long]] { param($processId, $created)
        [AIbrowse.ReleaseProfile.JobProcess]::AssertContains($jobId, $processId)
        $result.launched = $true
        $result.rootProcessId = $processId
        $result.rootCreated = $created
    }
    $code = [AIbrowse.ReleaseProfile.JobProcess]::Execute($node, @($bundle, '--qualification-run'), $root, $jobId, 90000, $callback)
    $result.exitCode = $code
    [AIbrowse.ReleaseProfile.JobProcess]::ConfirmReleased($jobId)
    $result.jobReleased = $true
    $report = Get-Content -LiteralPath (Join-Path $root 'runtime\report.json') -Raw | ConvertFrom-Json
    $bytes = 0L
    foreach ($entry in Get-ChildItem -LiteralPath $root -Recurse -Force) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '资格输出出现重解析点。' }
        if (-not $entry.PSIsContainer) { $bytes += $entry.Length }
        if ($bytes -gt 1073741824) { throw '资格磁盘预算超限。' }
    }
    $result.directoryBytes = $bytes
    if ((Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant() -cne $originalHash -or $report.bundleSha256 -cne $originalHash) { throw '运行后夹具摘要不符。' }
    $valid = $code -eq 0 -and $report.completed -eq $true -and $report.productE2Pass -eq $false -and $report.rounds.Count -eq 3
    foreach ($round in $report.rounds) {
        if ($round.cases.Count -ne 3 -or $round.durationMs -ge 20000) { $valid = $false }
        foreach ($case in $round.cases) {
            if ($case.observedEarlyReturn -ne $true -or $case.outstanding -ne 0 -or $case.abortObserved -ne $true) { $valid = $false }
        }
    }
    $result.completed = $valid
    $result.classification = if ($valid) { '旧方法提前返回反例收集完成，Job 已归零；不授 E2 通过' } else { '资格未完成，保留原件' }
} catch {
    $result.classification = '运行或退出确认失败，保留原件'
    $result.error = $_.Exception.Message
    try { [AIbrowse.ReleaseProfile.JobProcess]::ConfirmReleased($jobId); $result.jobReleased = $true } catch { $result.jobReleased = $false }
} finally {
    Restore-FixedEnvironment $saved
    $result.durationMs = $clock.Elapsed.TotalMilliseconds
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $root 'job-result.json') -Encoding utf8
}
$result | ConvertTo-Json -Depth 8
if (-not $result.completed) { exit 1 }
