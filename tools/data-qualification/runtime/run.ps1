[CmdletBinding()]
param([Parameter(Mandatory)][ValidatePattern('^runtime-[a-f0-9]{32}$')][string]$BuildId)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) { throw '需要现有 PowerShell 7。' }
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$root = Join-Path $repository "log\stage7-e2\$BuildId"
$electron = Join-Path $repository 'node_modules\electron\dist\electron.exe'
$entry = Join-Path $root 'app\main\index.js'
foreach ($target in @($repository, (Join-Path $repository 'log'), (Join-Path $repository 'log\stage7-e2'), $root, $electron, $entry, (Join-Path $root 'build-proof.json'), (Join-Path $root 'fixture-proof.json'))) {
    $item = Get-Item -LiteralPath $target
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '资格路径不得包含重解析点。' }
}
if ((Test-Path -LiteralPath (Join-Path $root 'runtime')) -or (Test-Path -LiteralPath (Join-Path $root 'job-result.json'))) { throw '本构建已运行或已有证据，禁止覆盖重跑。' }
$proof = Get-Content -LiteralPath (Join-Path $root 'build-proof.json') -Raw | ConvertFrom-Json
$fixture = Get-Content -LiteralPath (Join-Path $root 'fixture-proof.json') -Raw | ConvertFrom-Json
if ($proof.buildId -cne $BuildId -or $proof.version -ne 1 -or $proof.packaged -ne $false -or $proof.smokeMode -ne $false -or $fixture.completed -ne $true) { throw '构建/夹具资格身份不符。' }
if ($proof.budget.maintenanceRuns -ne 2 -or $proof.budget.utilityRuns -ne 1 -or $proof.budget.maintenanceMs -ne 20000 -or $proof.budget.utilityMs -ne 30000 -or $proof.budget.jobMs -ne 90000 -or $proof.budget.jobCleanupMs -ne 30000 -or $proof.budget.diskBytes -ne 2147483648) { throw '冻结资格预算不符。' }

function Assert-FixedHashes([string]$Base, $Hashes) {
    foreach ($property in $Hashes.PSObject.Properties) {
        $name = [string]$property.Name
        if ($name -match '(^[\/]|:|(^|[\/])\.\.([\/]|$))') { throw '摘要成员路径越界。' }
        $path = [IO.Path]::GetFullPath((Join-Path $Base $name))
        if (-not $path.StartsWith($Base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '摘要成员路径越界。' }
        $item = Get-Item -LiteralPath $path
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$property.Value) { throw '绑定摘要不符。' }
    }
}
Assert-FixedHashes $repository $proof.sourceHashes
Assert-FixedHashes $root $proof.artifacts
Assert-FixedHashes $root $fixture.hashes
$electronHash = (Get-FileHash -LiteralPath $electron -Algorithm SHA256).Hash.ToLowerInvariant()
if ($electronHash -cne $proof.electronSha256 -or $proof.electronVersion -cne '43.7.7') { throw '实际 Electron 与固定版本/摘要不符。' }

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
    foreach ($entry in $Saved.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process') }
}

$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$preflightEnvironment = Enter-FixedEnvironment
try { $nodeVersion = & $node --version }
finally { Restore-FixedEnvironment $preflightEnvironment }
if ($LASTEXITCODE -ne 0 -or $nodeVersion -cne $proof.node -or $nodeVersion -notmatch '^v24\.') { throw 'Node 预检版本不符。' }
Add-Type -Path (Join-Path $repository 'tools\release-profile\JobProcess.cs')
$jobId = [Guid]::NewGuid().ToString('N')
$clock = [Diagnostics.Stopwatch]::StartNew()
$result = [ordered]@{ version = 1; buildId = $BuildId; jobId = $jobId; launched = $false; jobReleased = $false; rootProcessId = $null; rootCreated = $null; durationMs = $null; directoryBytes = $null; error = $null; exitCode = $null; completed = $false; productE2Pass = $false; packaged = $false; classification = '未完成'; electronSha256 = $electronHash; buildProofSha256 = (Get-FileHash -LiteralPath (Join-Path $root 'build-proof.json') -Algorithm SHA256).Hash.ToLowerInvariant(); fixtureProofSha256 = (Get-FileHash -LiteralPath (Join-Path $root 'fixture-proof.json') -Algorithm SHA256).Hash.ToLowerInvariant() }
$saved = Enter-FixedEnvironment
try {
    $callback = [Action[uint32,long]] { param($processId, $created)
        [AIbrowse.ReleaseProfile.JobProcess]::AssertContains($jobId, $processId)
        $result.launched = $true; $result.rootProcessId = $processId; $result.rootCreated = $created
    }
    $code = [AIbrowse.ReleaseProfile.JobProcess]::Execute($electron, @($entry, '--runtime-qualification-run'), $root, $jobId, 90000, $callback)
    $result.exitCode = $code
    [AIbrowse.ReleaseProfile.JobProcess]::ConfirmReleased($jobId)
    $result.jobReleased = $true
    $report = Get-Content -LiteralPath (Join-Path $root 'runtime\report.json') -Raw | ConvertFrom-Json
    $bytes = 0L
    foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -Force) {
        if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '资格输出出现重解析点。' }
        if (-not $file.PSIsContainer) { $bytes += $file.Length }
        if ($bytes -gt 2147483648) { throw '资格磁盘预算超限。' }
    }
    $result.directoryBytes = $bytes
    Assert-FixedHashes $root $proof.artifacts
    Assert-FixedHashes $root $fixture.hashes
    if ((Get-FileHash -LiteralPath $electron -Algorithm SHA256).Hash.ToLowerInvariant() -cne $electronHash) { throw '运行后实际 Electron 摘要变化。' }
    $ready = @($report.observations | Where-Object { $_.phase -eq 'acquire-ready' })
    $utility = @($report.observations | Where-Object { $_.phase -eq 'utility' })
    $valid = $code -eq 0 -and $report.completed -eq $true -and $report.productE2Pass -eq $false -and $ready.Count -eq 2 -and $utility.Count -eq 1 -and $report.ui.Count -eq 4 -and $report.durationMs -le 90000 -and $null -ne $report.uiOverall -and $report.uiOverall.oracle.ok -eq $true -and $report.uiOverall.oracle.maxRoundTripMs -le 750 -and $report.uiOverall.oracle.maxGapMs -le 1000
    foreach ($row in $ready) { if ($row.durationMs -gt 20000) { $valid = $false } }
    foreach ($row in $utility) { if ($row.accepted -ne $true -or $row.exited -ne $true -or $row.elapsedMs -gt 30000 -or $row.frames -gt 16 -or $row.bytes -gt 65536) { $valid = $false } }
    foreach ($phase in $report.ui) { if ($phase.oracle.ok -ne $true -or $phase.samples.Count -lt 6 -or $phase.oracle.maxRoundTripMs -gt 750 -or $phase.oracle.maxGapMs -gt 1000) { $valid = $false } }
    $result.completed = $valid
    $result.classification = if ($valid) { '实际 main 同代维护工程资格完成；不授 E2 产品或发行环境通过' } else { '资格失败，原件保留' }
} catch {
    $result.error = $_.Exception.Message
    try { [AIbrowse.ReleaseProfile.JobProcess]::ConfirmReleased($jobId); $result.jobReleased = $true } catch { $result.jobReleased = $false }
} finally {
    Restore-FixedEnvironment $saved
    $result.durationMs = $clock.Elapsed.TotalMilliseconds
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $root 'job-result.json') -Encoding utf8
}
$result | ConvertTo-Json -Depth 8
if (-not $result.completed) { exit 1 }
