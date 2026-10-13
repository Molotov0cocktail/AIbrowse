[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RunRoot,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{32}$')][string]$RunId,
  [Parameter(Mandatory = $true)][ValidateSet('first', 'reopen')][string]$Phase,
  [Parameter(Mandatory = $true)][ValidateRange(1, 82000)][int]$DeadlineMs
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $repository 'log\browser-startup-20261014'))
$resolved = [IO.Path]::GetFullPath($RunRoot)
if (-not $resolved.StartsWith($expectedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '运行目录越界' }
Add-Type -Path (Join-Path $repository 'tools\release-profile\JobProcess.cs')
$electron = Join-Path $repository 'node_modules\electron\dist\electron.exe'
$harness = Join-Path $repository 'tools\browser-library-runtime\startup-harness.cjs'
$jobPath = Join-Path $resolved ('job-' + $Phase + '.json')
$record = [ordered]@{ phase = $Phase; runId = $RunId; started = $false; pid = $null; creation = $null; exitCode = $null; jobReleased = $false; error = $null }
try {
  [AIbrowse.ReleaseProfile.JobProcess]::ConfirmReleased($RunId)
  $started = [Action[uint32, long]] {
    param($processId, $creation)
    [AIbrowse.ReleaseProfile.JobProcess]::AssertContains($RunId, $processId)
    $record.started = $true
    $record.pid = $processId
    $record.creation = $creation
    $record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $jobPath -Encoding utf8
  }
  $record.exitCode = [int][AIbrowse.ReleaseProfile.JobProcess]::Execute($electron, @($harness, $resolved, $Phase), $repository, $RunId, $DeadlineMs, $started)
  [AIbrowse.ReleaseProfile.JobProcess]::ConfirmReleased($RunId)
  $record.jobReleased = $true
  if ($record.exitCode -ne 0) { throw "Electron退出码为$($record.exitCode)" }
}
catch {
  try { [AIbrowse.ReleaseProfile.JobProcess]::ConfirmReleased($RunId); $record.jobReleased = $true } catch { $record.error = $_.Exception.ToString() }
  if ($null -eq $record.error) { $record.error = $_.Exception.ToString() }
  $record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $jobPath -Encoding utf8
  exit 1
}
$record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $jobPath -Encoding utf8
exit 0
