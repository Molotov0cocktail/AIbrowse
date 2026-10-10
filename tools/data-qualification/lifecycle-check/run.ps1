[CmdletBinding()]
param([Parameter(Mandatory)][ValidatePattern('^lifecycle-check-[a-f0-9]{32}$')][string]$ScopeId)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$scope=Join-Path $repository "log/stage7-e3/$ScopeId"
$locks=[Collections.Generic.List[IO.FileStream]]::new()
$saved=@{}
$result=[ordered]@{version=1;scopeId=$ScopeId;completed=$false;jobs=@();error=$null}
function Write-New([string]$Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))}
function Hold([string]$Path,[string]$Hash){
  $file=Get-Item -LiteralPath $Path
  if(($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $file.PSIsContainer){throw '绑定文件类型无效'}
  $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  $locks.Add($stream)
  $sha=[Security.Cryptography.SHA256]::Create()
  try{$actual=[Convert]::ToHexString($sha.ComputeHash($stream)).ToLowerInvariant();$stream.Position=0}finally{$sha.Dispose()}
  if($actual -cne $Hash){throw '绑定摘要改变'}
}
function Job([string]$Mode,[string]$Argument,[bool]$ExpectedFault=$false){
  $exe=$build.electron.path;$entry=Join-Path $scope 'app'
  if($Mode -ceq 'import'){$exe=$build.node.path;$entry=Join-Path $scope 'oracle.cjs'}
  $job=[AIbrowse.FullTransfer.FixedTransferJob]::Execute($Mode,$exe,$entry,$Argument,$scope,[guid]::NewGuid().ToString('N'),120000)
  $result.jobs+=@{mode=$Mode;argument=$Argument;job=$job}
  Write-New (Join-Path $scope ('job-'+$result.jobs.Count+'.json')) $job
  if(-not $job.Started -or -not $job.ActualZero -or -not $job.LimitsVerified -or $job.OwnershipRetained -or $job.ExitFailure){throw 'Job身份/限额/实际退出失败'}
  if($ExpectedFault){
    if($job.ExitCode -ne 1 -or $job.Failure -cne 'exit-nonzero'){throw 'main故障未走预置exit1'}
    $fault=Get-Content -Raw -LiteralPath (Join-Path $scope 'fault-injected.json')|ConvertFrom-Json
    if($fault.pid -ne $job.ProcessId -or ($job.DurationMs-$fault.elapsedMs) -gt 10000){throw 'main故障退出身份或十秒门失败'}
  }elseif($job.ExitCode -ne 0 -or $job.Failure -or -not $job.Succeeded){throw '固定场失败'}
}
try{
  $current=[IO.Path]::GetFullPath($scope)
  while($true){$item=Get-Item -LiteralPath $current;if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'scope祖先不安全'};$parent=[IO.Directory]::GetParent($current);if($null -eq $parent){break};$current=$parent.FullName}
  if(Test-Path -LiteralPath (Join-Path $scope 'run-clock.json')){throw '禁止复用固定scope'}
  $build=Get-Content -Raw -LiteralPath (Join-Path $scope 'build.json')|ConvertFrom-Json
  if($build.version -ne 1 -or $build.scopeId -cne $ScopeId){throw '构建绑定不符'}
  foreach($property in $build.sources.PSObject.Properties){Hold (Join-Path $repository $property.Name) $property.Value}
  foreach($property in $build.artifacts.PSObject.Properties){Hold (Join-Path $scope $property.Name) $property.Value}
  Hold $build.node.path $build.node.sha256;Hold $build.electron.path $build.electron.sha256
  if('AIbrowse.FullTransfer.FixedTransferJob' -as [type]){throw '需要新PowerShell进程'}
  $assembly=Join-Path $scope 'FixedTransferJob.dll'
  Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath (Join-Path $scope 'FixedTransferJob.cs')) -OutputAssembly $assembly
  [void][Reflection.Assembly]::LoadFrom($assembly)
  foreach($item in [Environment]::GetEnvironmentVariables().GetEnumerator()){
    if($item.Key.StartsWith('AIBROWSE_') -or $item.Key -in @('ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','NODE_OPTIONS')){$saved[$item.Key]=$item.Value;[Environment]::SetEnvironmentVariable($item.Key,$null,'Process')}
  }
  Write-New (Join-Path $scope 'run-clock.json') @{startedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
  Job 'import' 'seed'
  foreach($phase in @('exercise','main-fault','cold')){
    Write-New (Join-Path $scope "$phase-control.json") @{deadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+120000}
    Job 'transfer' $phase ($phase -ceq 'main-fault')
    Job 'import' $phase
  }
  $result.completed=$true
}catch{$result.error=$_.Exception.Message}
finally{
  foreach($stream in $locks){$stream.Dispose()}
  foreach($key in $saved.Keys){[Environment]::SetEnvironmentVariable($key,$saved[$key],'Process')}
  if(-not (Test-Path -LiteralPath (Join-Path $scope 'result.json'))){Write-New (Join-Path $scope 'result.json') $result}
}
if(-not $result.completed){Write-Error $result.error;exit 1}
Write-Output "固定生命周期真实场通过：$ScopeId"
