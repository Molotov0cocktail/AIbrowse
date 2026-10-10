[CmdletBinding()]
param([Parameter(Mandatory)][ValidatePattern('^utility-[a-f0-9]{32}$')][string]$BuildId)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) { throw '需要现有PowerShell 7。' }
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$root = Join-Path $repository "log\stage7-e2\$BuildId"
$executable = Join-Path $root 'pack\win-unpacked\AIbrowseE2UtilityQualification.exe'
foreach ($target in @($repository, (Join-Path $repository 'log'), (Join-Path $repository 'log\stage7-e2'), $root, (Join-Path $root 'pack'), (Join-Path $root 'pack\win-unpacked'), $executable)) {
    $item = Get-Item -LiteralPath $target
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '资格路径不得包含重解析点。' }
}
if (Test-Path -LiteralPath (Join-Path $root 'runtime')) { throw '此构建已启动过；保留原件，禁止覆盖重跑。' }
if (Test-Path -LiteralPath (Join-Path $root 'job-result.json')) { throw '此构建已有Job记录；禁止覆盖。' }

function Enter-FixedEnvironment {
    $saved = @{}
    $allow = @('SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'USERDOMAIN', 'USERNAME', 'COMSPEC', 'PATHEXT', 'PATH', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE')
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
try { $proofText = & $node --experimental-strip-types (Join-Path $PSScriptRoot 'verify.ts') $BuildId }
finally { Restore-FixedEnvironment $preflightEnvironment }
if ($LASTEXITCODE -ne 0) { throw '实际资格包静态验证失败。' }
$proof = $proofText | ConvertFrom-Json
$original = Get-Content -LiteralPath (Join-Path $root 'package-proof.json') -Raw | ConvertFrom-Json
if ($proof.executableSha256 -ne $original.executableSha256 -or $proof.asarSha256 -ne $original.asarSha256) { throw '资格产物与构建原件不一致。' }
Add-Type -Path (Join-Path $repository 'tools\release-profile\JobProcess.cs')
$jobId = [Guid]::NewGuid().ToString('N')
$clock = [Diagnostics.Stopwatch]::StartNew()
$result = [ordered]@{ version = 1; buildId = $BuildId; jobId = $jobId; launched = $false; jobReleased = $false; rootProcessId = $null; rootCreated = $null; durationMs = $null; directoryBytes = $null; error = $null; exitCode = $null; ok = $false; classification = '未完成'; executableSha256 = $proof.executableSha256; asarSha256 = $proof.asarSha256 }
$saved = Enter-FixedEnvironment
try {
    $callback = [Action[uint32,long]] { param($processId, $created)
        [AIbrowse.ReleaseProfile.JobProcess]::AssertContains($jobId, $processId)
        $result.launched = $true
        $result.rootProcessId = $processId
        $result.rootCreated = $created
    }
    $code = [AIbrowse.ReleaseProfile.JobProcess]::Execute($executable, @('--qualification-run'), (Split-Path -Parent $executable), $jobId, 90000, $callback)
    $result.exitCode = $code
    [AIbrowse.ReleaseProfile.JobProcess]::ConfirmReleased($jobId)
    $result.jobReleased = $true
    $report = Get-Content -LiteralPath (Join-Path $root 'runtime\report.json') -Raw | ConvertFrom-Json
    $finalProofText = & $node --experimental-strip-types (Join-Path $PSScriptRoot 'verify.ts') $BuildId
    if ($LASTEXITCODE -ne 0) { throw '运行后静态或磁盘预算核验失败。' }
    $finalProof = $finalProofText | ConvertFrom-Json
    if ($finalProof.executableSha256 -ne $original.executableSha256 -or $finalProof.asarSha256 -ne $original.asarSha256) { throw '运行后产物摘要改变。' }
    $result.directoryBytes = $finalProof.directoryBytes
    $result.ok = $code -eq 0 -and $report.ok -eq $true -and $report.outstandingChildren -eq 0 -and $report.fixture.unchanged -eq $true
    $result.classification = if ($result.ok) { '资格完成，Job已归零' } else { '资格未通过，保留原件' }
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
if (-not $result.ok) { exit 1 }
