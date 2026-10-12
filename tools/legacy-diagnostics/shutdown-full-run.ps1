param([Parameter(Mandatory)][ValidatePattern('^full-[a-f0-9]{32}$')][string]$BuildId)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$root = Join-Path $repository ('log/legacy-diagnosis-20261012/shutdown/' + $BuildId)
$appRoot = Join-Path $root 'app'
$binding = Get-Content -LiteralPath (Join-Path $root 'binding.json') -Raw | ConvertFrom-Json
function Check-Hashes($base, $values) {
  foreach ($item in $values.PSObject.Properties) {
    $path = [IO.Path]::GetFullPath((Join-Path $base $item.Name))
    if (-not $path.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '绑定路径不安全' }
    if ((Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant() -cne $item.Value) { throw '绑定改变' }
  }
}
Check-Hashes $repository $binding.sources
Check-Hashes $root $binding.artifacts
foreach ($item in $binding.originalOut) { if ((Get-FileHash -LiteralPath (Join-Path $repository $item.path)).Hash.ToLowerInvariant() -cne $item.sha256) { throw '普通out绑定改变' } }
$electron = Join-Path $repository 'node_modules/electron/dist/electron.exe'
if ((Get-FileHash -LiteralPath $electron).Hash.ToLowerInvariant() -cne $binding.electron -or $binding.budget.applicationMs -ne 300000 -or $binding.budget.observationAfterQuitMs -ne 10000 -or $binding.budget.processes -ne 64) { throw '运行时或固定预算改变' }
$attempt = [IO.File]::Open((Join-Path $root 'attempt.txt'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read); $attempt.Dispose()
Add-Type -Path (Join-Path $root 'JobProcess.cs')
$saved = @{}
$allow = @('SystemRoot','WINDIR','SystemDrive','USERPROFILE','USERDOMAIN','USERNAME','COMSPEC','PATHEXT','PATH','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE')
foreach ($item in [Environment]::GetEnvironmentVariables().GetEnumerator()) { $saved[[string]$item.Key] = [string]$item.Value; if ($allow -notcontains [string]$item.Key) { [Environment]::SetEnvironmentVariable([string]$item.Key,[NullString]::Value,'Process') } }
foreach ($name in @('APPDATA','LOCALAPPDATA','TEMP','TMP')) { $directory=Join-Path $root $name; New-Item -ItemType Directory -Path $directory | Out-Null; [Environment]::SetEnvironmentVariable($name,$directory,'Process') }
$profile = Join-Path $root 'profile'; New-Item -ItemType Directory -Path $profile | Out-Null
[Environment]::SetEnvironmentVariable('AIBROWSE_SMOKE','1','Process')
[Environment]::SetEnvironmentVariable('AIBROWSE_USER_DATA_DIR',$profile,'Process')
$jobId = [Guid]::NewGuid().ToString('N')
$result = [ordered]@{ buildId=$BuildId; jobId=$jobId; exitCode=$null; actualZero=$false; observationStopped=$false; error=$null }
$clock = [Diagnostics.Stopwatch]::StartNew()
try {
  $callback = [Action[uint32,long]] { param($processId,$created) [AIbrowse.ShutdownFullDiagnostic.JobProcess]::AssertContains($jobId,$processId); @{ pid=$processId; created=$created; jobId=$jobId } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'launch.json') -Encoding utf8NoBOM }
  $stopRequested = [Func[bool]] { return [IO.File]::Exists((Join-Path $appRoot 'shutdown-observation.json')) }
  $result.exitCode = [AIbrowse.ShutdownFullDiagnostic.JobProcess]::Execute($electron,@('.'),$appRoot,$jobId,300000,$callback,$clock,$stopRequested)
  $result.actualZero = $true
  Check-Hashes $repository $binding.sources
  Check-Hashes $root $binding.artifacts
} catch {
  $result.error = $_.Exception.Message
  if ($result.error.Contains('Job 已确认实际归零')) { $result.actualZero = $true }
  $result.observationStopped = [IO.File]::Exists((Join-Path $appRoot 'shutdown-observation.json'))
} finally {
  foreach ($item in [Environment]::GetEnvironmentVariables().GetEnumerator()) { if (-not $saved.ContainsKey([string]$item.Key)) { [Environment]::SetEnvironmentVariable([string]$item.Key,[NullString]::Value,'Process') } }
  foreach ($item in $saved.GetEnumerator()) { [Environment]::SetEnvironmentVariable($item.Key,$item.Value,'Process') }
  $result['elapsedMs'] = $clock.Elapsed.TotalMilliseconds
  $result['artifactBytes'] = 0L
  $result['artifactEntries'] = 0
  foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -Force) {
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '诊断输出包含链接' }
    $result.artifactEntries++
    if (-not $file.PSIsContainer) { $result.artifactBytes += $file.Length }
    if ($result.artifactEntries -gt 4096 -or $result.artifactBytes -gt 268435456) { throw '诊断产物预算超限' }
  }
  Check-Hashes $repository $binding.sources
  Check-Hashes $root $binding.artifacts
  foreach ($item in $binding.originalOut) { if ((Get-FileHash -LiteralPath (Join-Path $repository $item.path)).Hash.ToLowerInvariant() -cne $item.sha256) { throw '普通out绑定改变' } }
  $result['interpretation'] = '关联诊断；观察窗后Job终止不代表正常产品退出'
  $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'result.json') -Encoding utf8NoBOM
}
$result | ConvertTo-Json
if (-not $result.actualZero) { exit 2 }
if ($result.exitCode -ne 0) { exit 1 }
