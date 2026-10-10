param([Parameter(Mandatory)][ValidatePattern('^page-reader-exit-[a-f0-9]{32}$')][string]$BuildId)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$root=Join-Path $repository ('log/stage7-e2/'+$BuildId)
$binding=Get-Content -LiteralPath (Join-Path $root 'binding.json') -Raw|ConvertFrom-Json
function Check-Hashes($base,$values) {
  foreach($item in $values.PSObject.Properties) {
    $path=[IO.Path]::GetFullPath((Join-Path $base $item.Name))
    if(-not $path.StartsWith($base+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw '绑定路径不安全'}
    if((Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant() -cne $item.Value){throw '源码或制品绑定改变'}
  }
}
Check-Hashes $repository $binding.sources
Check-Hashes $root $binding.artifacts
$electron=Join-Path $repository 'node_modules/electron/dist/electron.exe'
if((Get-FileHash -LiteralPath $electron).Hash.ToLowerInvariant() -cne $binding.electron -or $binding.budget.cases -ne 4 -or $binding.budget.processes -ne 8 -or $binding.budget.workMs -ne 20000 -or $binding.budget.exitMs -ne 10000 -or $binding.budget.diskBytes -ne 8388608){throw '固定预算或Electron绑定不符'}
$attempt=[IO.File]::Open((Join-Path $root 'attempt.txt'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
$attempt.Dispose()
Add-Type -Path (Join-Path $root 'JobProcess.cs')
$saved=@{}
$allow=@('SystemRoot','WINDIR','SystemDrive','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','USERDOMAIN','USERNAME','COMSPEC','PATHEXT','PATH','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE')
foreach($item in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
  $saved[[string]$item.Key]=[string]$item.Value
  if($allow -notcontains [string]$item.Key){[Environment]::SetEnvironmentVariable([string]$item.Key,[NullString]::Value,'Process')}
}
$jobId=[Guid]::NewGuid().ToString('N')
$result=[ordered]@{buildId=$BuildId;jobId=$jobId;exitCode=$null;actualZero=$false;completed=$false;error=$null}
$clock=[Diagnostics.Stopwatch]::StartNew()
try {
  $appRoot=Join-Path $root 'app'
  $callback=[Action[uint32,long]]{param($processId,$created)
    [AIbrowse.PageReaderQualification.JobProcess]::AssertContains($jobId,$processId)
    @{pid=$processId;created=$created;jobId=$jobId}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'launch.json') -Encoding utf8NoBOM
  }
  $result.exitCode=[AIbrowse.PageReaderQualification.JobProcess]::Execute($electron,@($appRoot),$appRoot,$jobId,20000,$callback)
  $result.actualZero=$true
  if(Test-Path -LiteralPath (Join-Path $appRoot 'completed.json')){$result.completed=(Get-Content -LiteralPath (Join-Path $appRoot 'completed.json') -Raw|ConvertFrom-Json).completed}
  Check-Hashes $repository $binding.sources
  Check-Hashes $root $binding.artifacts
} catch {
  $result.error=$_.Exception.Message
  if($result.error.Contains('固定验收超时；Job 已确认实际归零')){$result.actualZero=$true}
} finally {
  foreach($item in [Environment]::GetEnvironmentVariables().GetEnumerator()){if(-not $saved.ContainsKey([string]$item.Key)){[Environment]::SetEnvironmentVariable([string]$item.Key,[NullString]::Value,'Process')}}
  foreach($item in $saved.GetEnumerator()){[Environment]::SetEnvironmentVariable($item.Key,$item.Value,'Process')}
  $result['elapsedMs']=$clock.Elapsed.TotalMilliseconds
  $bytes=0L
  foreach($file in Get-ChildItem -LiteralPath $root -Recurse -Force){if($file.Attributes -band [IO.FileAttributes]::ReparsePoint){throw '诊断输出链接'};if(-not $file.PSIsContainer){$bytes+=$file.Length}}
  $result['bytes']=$bytes
  if($bytes -gt 8388608){$result.error='诊断磁盘预算超限'}
  $result|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'result.json') -Encoding utf8NoBOM
}
$result|ConvertTo-Json
if(-not ($result.actualZero -and $result.completed -and $result.exitCode -eq 0 -and $null -eq $result.error)){exit 1}
