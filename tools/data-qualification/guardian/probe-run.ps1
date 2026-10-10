param([Parameter(Mandatory)][ValidatePattern('^guardian-probe-[a-f0-9]{32}$')][string]$BuildId)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$root = Join-Path $repository ('log/stage7-e2/' + $BuildId)
$appRoot = Join-Path $root 'app'
$proof = Get-Content -LiteralPath (Join-Path $root 'binding.json') -Raw | ConvertFrom-Json
if (Test-Path -LiteralPath (Join-Path $root 'result.json')) { throw '资格原件已存在，禁止重跑' }
function Check-Hashes($base, $values) {
  foreach ($property in $values.PSObject.Properties) {
    $target = [IO.Path]::GetFullPath((Join-Path $base $property.Name))
    if (-not $target.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '绑定成员越界' }
    if ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '绑定成员包含链接' }
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $property.Value) { throw '绑定摘要改变' }
  }
}
Check-Hashes $repository $proof.sourceHashes
Check-Hashes $root $proof.artifacts
$electron = Join-Path $repository 'node_modules/electron/dist/electron.exe'
if ((Get-FileHash -LiteralPath $electron -Algorithm SHA256).Hash.ToLowerInvariant() -cne $proof.electronSha256 -or $proof.budget.probes -ne 20 -or $proof.budget.ms -ne 30000) { throw '资格固定预算改变' }
Add-Type -Path (Join-Path $repository 'tools/release-profile/JobProcess.cs')
$saved = @{}
$allow = @('SystemRoot','WINDIR','SystemDrive','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','USERDOMAIN','USERNAME','COMSPEC','PATHEXT','PATH','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE')
foreach ($item in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
  $saved[[string]$item.Key] = [string]$item.Value
  if ($allow -notcontains [string]$item.Key) { [Environment]::SetEnvironmentVariable([string]$item.Key, [NullString]::Value, 'Process') }
}
$jobId = [Guid]::NewGuid().ToString('N')
$result = [ordered]@{ buildId=$BuildId; jobId=$jobId; exitCode=$null; actualZero=$false; completed=$false; error=$null }
$clock = [Diagnostics.Stopwatch]::StartNew()
try {
  $callback = [Action[uint32,long]] { param($processId,$created)
    [AIbrowse.ReleaseProfile.JobProcess]::AssertContains($jobId,$processId)
    @{ pid=$processId; created=$created; jobId=$jobId } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'launch.json') -Encoding utf8
  }
  $result.exitCode = [AIbrowse.ReleaseProfile.JobProcess]::Execute($electron,@($appRoot),$appRoot,$jobId,30000,$callback)
  $result.actualZero = $true
  if (Test-Path -LiteralPath (Join-Path $appRoot 'completed.json')) { $result.completed = (Get-Content -LiteralPath (Join-Path $appRoot 'completed.json') -Raw | ConvertFrom-Json).completed }
  Check-Hashes $repository $proof.sourceHashes
  Check-Hashes $root $proof.artifacts
} catch {
  $result.error = $_.Exception.Message
  if ($result.error.Contains('固定验收超时；Job 已确认实际归零')) { $result.actualZero = $true }
} finally {
  foreach ($item in [Environment]::GetEnvironmentVariables().GetEnumerator()) { if (-not $saved.ContainsKey([string]$item.Key)) { [Environment]::SetEnvironmentVariable([string]$item.Key,[NullString]::Value,'Process') } }
  foreach ($item in $saved.GetEnumerator()) { [Environment]::SetEnvironmentVariable($item.Key,$item.Value,'Process') }
  $result['elapsedMs'] = $clock.Elapsed.TotalMilliseconds
  $bytes = 0L
  foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -Force) { if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '资格输出出现链接' }; if (-not $file.PSIsContainer) { $bytes += $file.Length } }
  $result['bytes'] = $bytes
  if ($bytes -gt 52428800) { $result.error = '资格磁盘预算超限' }
  $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'result.json') -Encoding utf8
}
$result | ConvertTo-Json
if (-not ($result.completed -and $result.actualZero -and $result.exitCode -eq 0 -and $null -eq $result.error)) { exit 1 }
