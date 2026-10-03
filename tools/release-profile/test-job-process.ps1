[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -Path (Join-Path $PSScriptRoot 'JobProcess.cs')
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$evidence = Join-Path $repository ('log\stage7-e1\profile-isolation\job-tests-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $evidence | Out-Null
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$fixture = Join-Path $PSScriptRoot 'fixture-job.mjs'
$rows = [Collections.Generic.List[object]]::new()
$currentRunId = ''
$membershipRows = [Collections.Generic.List[object]]::new()
$started = [Action[uint32, long]] {
    param($processId, $creation)
    [AIbrowse.ReleaseProfile.JobProcess]::AssertContains($currentRunId, $processId)
    $foreignRejected = $false
    try { [AIbrowse.ReleaseProfile.JobProcess]::AssertContains($currentRunId, [uint32]$PID) }
    catch { $foreignRejected = $true }
    if (-not $foreignRejected) { throw 'Job成员检查接受了外部PowerShell进程。' }
    $membershipRows.Add(@{ runId = $currentRunId; pid = $processId; created = $creation; foreignRejected = $true })
}
try {
    $runId = [Guid]::NewGuid().ToString('N')
    $currentRunId = $runId
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $exitCode = [AIbrowse.ReleaseProfile.JobProcess]::Execute($node, @($fixture, 'parent'), $repository, $runId, 10000, $started)
    if ($exitCode -ne 0 -or $timer.ElapsedMilliseconds -lt 1400) { throw 'Job 未等待根进程退出后的子孙实际结束。' }
    [AIbrowse.ReleaseProfile.JobProcess]::ConfirmReleased($runId)
    $rows.Add(@{ case = 'descendant-after-parent'; exitCode = $exitCode; elapsedMs = $timer.ElapsedMilliseconds; pass = $true })

    $runId = [Guid]::NewGuid().ToString('N')
    $currentRunId = $runId
    $caught = $false
    try { [AIbrowse.ReleaseProfile.JobProcess]::Execute($node, @($fixture, 'timeout'), $repository, $runId, 250, $started) | Out-Null }
    catch { $caught = $_.Exception.InnerException.Message -eq '固定验收超时；Job 已确认实际归零' }
    if (-not $caught) { throw '超时未产生实际归零后的明确失败。' }
    [AIbrowse.ReleaseProfile.JobProcess]::ConfirmReleased($runId)
    $rows.Add(@{ case = 'timeout-actual-zero'; pass = $true })

    $runId = [Guid]::NewGuid().ToString('N')
    $currentRunId = $runId
    $caught = $false
    try { [AIbrowse.ReleaseProfile.JobProcess]::Execute((Join-Path $evidence 'nonexistent.exe'), @(), $repository, $runId, 250, $started) | Out-Null }
    catch { $caught = $true }
    if (-not $caught) { throw '启动不存在的工具未失败。' }
    [AIbrowse.ReleaseProfile.JobProcess]::ConfirmReleased($runId)
    $rows.Add(@{ case = 'startup-failure'; pass = $true })
    @{ ok = $true; tests = $rows; membership = $membershipRows } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence 'report.json') -Encoding utf8
    Write-Output ('Job 进程验证通过：' + $rows.Count + ' 项。证据：' + $evidence)
}
catch {
    @{ ok = $false; tests = $rows; failure = $_.Exception.ToString() } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence 'failure.json') -Encoding utf8
    throw
}
