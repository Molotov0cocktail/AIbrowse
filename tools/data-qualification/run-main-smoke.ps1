param([Parameter(Mandatory)][ValidateSet('empty-exit','default','default-full')][string]$Scenario)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$runId = [Guid]::NewGuid().ToString('N')
$root = Join-Path $repository ('log/stage7-e2/main-' + $Scenario + '-' + $runId)
$profile = Join-Path $root 'profile'
New-Item -ItemType Directory -Path $profile | Out-Null
$entry = Join-Path $repository 'out/main/index.js'
$executable = Join-Path $repository 'node_modules/electron/dist/electron.exe'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw '当前production构建不存在' }
Get-ChildItem -LiteralPath (Join-Path $repository 'out/main'),(Join-Path $repository 'out/lifecycle-guardian') -File |
  ForEach-Object { [ordered]@{ file=$_.FullName; sha256=(Get-FileHash -LiteralPath $_.FullName).Hash } } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'build-hashes.json') -Encoding utf8
$logPath = Join-Path $repository ('log/aibrowse-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
$logOffset = if (Test-Path -LiteralPath $logPath) { (Get-Item -LiteralPath $logPath).Length } else { 0 }
Add-Type -Path (Join-Path $repository 'tools/release-profile/JobProcess.cs')
$saved = @{}
$allow = @('SystemRoot','WINDIR','SystemDrive','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','USERDOMAIN','USERNAME','COMSPEC','PATHEXT','PATH','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE')
foreach ($item in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
  $saved[[string]$item.Key] = [string]$item.Value
  if ($allow -notcontains [string]$item.Key) { [Environment]::SetEnvironmentVariable([string]$item.Key, [NullString]::Value, 'Process') }
}
[Environment]::SetEnvironmentVariable('AIBROWSE_SMOKE','1','Process')
[Environment]::SetEnvironmentVariable('AIBROWSE_USER_DATA_DIR',$profile,'Process')
if ($Scenario -eq 'empty-exit') { [Environment]::SetEnvironmentVariable('AIBROWSE_SOURCES_UI_SMOKE','invalid-fixed-exit-probe','Process') }
# The short default is a bounded diagnosis; the full matrix keeps the prior 600s envelope.
$budget = if ($Scenario -eq 'empty-exit') { 60000 } elseif ($Scenario -eq 'default-full') { 600000 } else { 120000 }
$result = [ordered]@{ runId=$runId; scenario=$Scenario; startedAt=[DateTimeOffset]::Now.ToString('o'); budgetMs=$budget; exitCode=$null; jobReleased=$false; normalExit=$false; ledgerRetired=$false; error=$null }
$clock = [Diagnostics.Stopwatch]::StartNew()
try {
  $callback = [Action[uint32,long]] { param($processId,$created)
    [AIbrowse.ReleaseProfile.JobProcess]::AssertContains($runId,$processId)
    @{ pid=$processId; created=$created; runId=$runId; budgetMs=$budget; arguments=@('.') } | ConvertTo-Json |
      Set-Content -LiteralPath (Join-Path $root 'launch.json') -Encoding utf8
  }
  $code = [AIbrowse.ReleaseProfile.JobProcess]::Execute($executable,@('.'),$repository,$runId,$budget,$callback)
  $result.exitCode = $code
  # Execute returns only after its continuously-held Job handle reports Active=0.
  $result.jobReleased = $true
  $expected = if ($Scenario -eq 'empty-exit') { 1 } else { 0 }
  $result.normalExit = $code -eq $expected
  $ledger = Get-Content -LiteralPath (Join-Path $profile 'lifecycle-guardian/writers.json') -Raw | ConvertFrom-Json
  $result.ledgerRetired = $null -eq $ledger.main -and $null -eq $ledger.utility
} catch {
  $result.error = $_.Exception.Message
  # The specific timeout exception follows an actual-zero observation, not a fresh Job name.
  if ($result.error.Contains('固定验收超时；Job 已确认实际归零')) { $result.jobReleased=$true }
} finally {
  foreach ($item in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
    if (-not $saved.ContainsKey([string]$item.Key)) { [Environment]::SetEnvironmentVariable([string]$item.Key,[NullString]::Value,'Process') }
  }
  foreach ($item in $saved.GetEnumerator()) { [Environment]::SetEnvironmentVariable($item.Key,$item.Value,'Process') }
  if (Test-Path -LiteralPath $logPath) {
    $inputLog = [IO.File]::Open($logPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
    $outputLog = [IO.File]::Open((Join-Path $root 'main-log.txt'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
    try { if ($inputLog.Length -lt $logOffset) { throw '日志滚动，需人工核对完整分段' }; $null=$inputLog.Seek($logOffset,[IO.SeekOrigin]::Begin); $inputLog.CopyTo($outputLog) }
    finally { $outputLog.Dispose(); $inputLog.Dispose() }
  }
  $result['elapsedMs'] = $clock.Elapsed.TotalMilliseconds
  $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'result.json') -Encoding utf8
}
$result | ConvertTo-Json
Write-Output $root
if (-not ($result.normalExit -and $result.jobReleased -and $result.ledgerRetired)) { exit 1 }
