[CmdletBinding()]
param([Parameter(Mandatory)][ValidatePattern('^projection-[a-f0-9]{32}$')][string]$BuildId)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) { throw '需要现有 PowerShell 7。' }
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$root = Join-Path $repository "log\stage7-e2\$BuildId"
$bundle = Join-Path $root 'fixture.cjs'
foreach ($path in @($repository, (Join-Path $repository 'log'), (Join-Path $repository 'log\stage7-e2'), $root, $bundle, (Join-Path $root 'build-proof.json'))) {
    if (((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '资格路径不得含重解析点。' }
}
if ((Test-Path -LiteralPath (Join-Path $root 'runtime')) -or (Test-Path -LiteralPath (Join-Path $root 'job-result.json'))) { throw '已运行候选禁止覆盖重跑。' }
$proof = Get-Content -LiteralPath (Join-Path $root 'build-proof.json') -Raw | ConvertFrom-Json
$bundleHash = (Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant()
$launcherHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($proof.buildId -cne $BuildId -or $proof.bundleSha256 -cne $bundleHash -or $proof.toolingHashes.'tools/data-qualification/projection/run.ps1' -cne $launcherHash) { throw '构建或启动器摘要不符。' }
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
$saved = Enter-FixedEnvironment
try { $version = & $node --version }
finally { Restore-FixedEnvironment $saved }
if ($LASTEXITCODE -ne 0 -or $version -cne $proof.node -or $version -notmatch '^v24\.') { throw 'Node 与构建版本不符。' }
Add-Type -Path (Join-Path $repository 'tools/release-profile/JobProcess.cs')
$jobId = [Guid]::NewGuid().ToString('N')
$result = [ordered]@{ buildId=$BuildId; jobId=$jobId; rootProcessId=$null; rootCreated=$null; exitCode=$null; jobReleased=$false; completed=$false; productE2Pass=$false; bundleSha256=$bundleHash; launcherSha256=$launcherHash; directoryBytes=$null; durationMs=$null; error=$null }
$clock = [Diagnostics.Stopwatch]::StartNew()
$saved = Enter-FixedEnvironment
try {
    $callback = [Action[uint32,long]] { param($processId, $created)
        [AIbrowse.ReleaseProfile.JobProcess]::AssertContains($jobId, $processId)
        $result.rootProcessId = $processId; $result.rootCreated = $created
    }
    $result.exitCode = [AIbrowse.ReleaseProfile.JobProcess]::Execute($node, @('--expose-gc', $bundle, '--qualification-run'), $root, $jobId, 30000, $callback)
    [AIbrowse.ReleaseProfile.JobProcess]::ConfirmReleased($jobId)
    $result.jobReleased = $true
    $report = Get-Content -LiteralPath (Join-Path $root 'runtime/report.json') -Raw | ConvertFrom-Json
    $bytes = 0L
    foreach ($item in Get-ChildItem -LiteralPath $root -Recurse -Force) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '资格输出出现重解析点。' }
        if (-not $item.PSIsContainer) { $bytes += $item.Length }
    }
    $result.directoryBytes = $bytes
    if ($bytes -gt 268435456 -or $report.durationMs -gt 30000) { throw '冻结资格预算超限。' }
    if ((Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant() -cne $bundleHash) { throw '实际产物摘要改变。' }
    $result.completed = $result.exitCode -eq 0 -and $report.completed -eq $true -and $report.productE2Pass -eq $false -and $report.streamEvidence.submembers -eq 51 -and $report.streamEvidence.exactEof -eq $true
} catch {
    $result.error = $_.Exception.Message
    try { [AIbrowse.ReleaseProfile.JobProcess]::ConfirmReleased($jobId); $result.jobReleased = $true } catch { $result.jobReleased = $false }
} finally {
    Restore-FixedEnvironment $saved
    $result.durationMs = $clock.Elapsed.TotalMilliseconds
    $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $root 'job-result.json') -Encoding utf8
}
$result | ConvertTo-Json -Depth 6
if (-not $result.completed) { exit 1 }
