[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^restore-check-[a-f0-9]{32}$')][string]$ScopeId,
  [Parameter(Mandatory)][ValidateSet('R','P')][string]$Scene,
  [switch]$Feasibility
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$scope=Join-Path $repository "log/stage7-e2/$ScopeId"
$clock=[Diagnostics.Stopwatch]::StartNew()
$workMs=600000
$deadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+$workMs
$locks=[Collections.Generic.List[IO.FileStream]]::new()
$saved=@{}
$result=[ordered]@{version=1;scopeId=$ScopeId;scene=$Scene;feasibility=[bool]$Feasibility;completed=$false;jobs=@();error=$null;elapsedMs=0}
function Check-Time {if($clock.Elapsed.TotalMilliseconds -ge $workMs){throw '固定600秒场景期限已过'}}
function Write-New([string]$Path,$Value) {
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 14))
  $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Hold([string]$Path,[string]$Hash) {
  $item=Get-Item -LiteralPath $Path -Force
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '绑定文件无效'}
  $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  $locks.Add($stream)
  if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant() -cne $Hash){throw '构建来源或制品改变'}
}
function Control([string]$Phase) {
  Check-Time
  $value=@{version=1;scene=$Scene;phase=$Phase;deadline=$deadline;previousPid=$null;previousSession=$null}
  $tmp=Join-Path $scope ('control-'+[guid]::NewGuid().ToString('N')+'.tmp')
  Write-New $tmp $value
  [IO.File]::Move($tmp,(Join-Path $scope 'control.json'),$true)
}
function Required([string]$Name) {
  Check-Time
  $path=Join-Path $scope $Name
  if(-not (Test-Path -LiteralPath $path -PathType Leaf)){throw ('固定完成证据缺席：'+$Name)}
  Get-Content -Raw -LiteralPath $path|ConvertFrom-Json
}
function Run-Job([string]$Mode,[string]$Argument) {
  Check-Time
  $remaining=[int][Math]::Floor($workMs-$clock.Elapsed.TotalMilliseconds)
  if($Mode -ceq 'import'){$remaining=[Math]::Min($remaining,120000);$exe=$build.node.path;$entry=Join-Path $scope 'oracle.cjs'}
  else {$exe=$build.electron.path;$entry=Join-Path $scope 'app'}
  $job=[AIbrowse.FullTransfer.FixedTransferJob]::Execute($Mode,$exe,$entry,$Argument,$scope,[guid]::NewGuid().ToString('N'),$remaining)
  $result.jobs+=@{mode=$Mode;argument=$Argument;job=$job}
  Write-New (Join-Path $scope ('job-'+$result.jobs.Count+'.json')) $job
  if(-not $job.Succeeded -or -not $job.ActualZero -or $job.OwnershipRetained -or $job.ExitCode -ne 0){throw '固定资源Job失败，保留原件'}
  Check-Time
}
try {
  if($PSVersionTable.PSEdition -ne 'Core' -or -not [Environment]::Is64BitProcess){throw '需要64位PowerShell7'}
  $current=$scope
  while($true){$item=Get-Item -LiteralPath $current -Force;if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '目录不是独立实体'};$parent=[IO.Path]::GetDirectoryName($current);if([string]::IsNullOrEmpty($parent)) {break};$current=$parent}
  Write-New (Join-Path $scope 'claim.json') @{scopeId=$ScopeId;scene=$Scene;deadline=$deadline;feasibility=[bool]$Feasibility}
  $build=Get-Content -Raw -LiteralPath (Join-Path $scope 'build.json')|ConvertFrom-Json
  if($build.version -ne 1 -or $build.scopeId -cne $ScopeId){throw '构建记录不符'}
  foreach($property in $build.sources.PSObject.Properties){Hold (Join-Path $repository $property.Name) $property.Value}
  foreach($property in $build.artifacts.PSObject.Properties){Hold (Join-Path $scope $property.Name) $property.Value}
  Hold $build.node.path $build.node.sha256
  Hold $build.electron.path $build.electron.sha256
  if('AIbrowse.FullTransfer.FixedTransferJob' -as [type]){throw '需要新PowerShell进程'}
  $assembly=Join-Path $scope 'FixedTransferJob.dll'
  Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath (Join-Path $scope 'FixedTransferJob.cs')) -OutputAssembly $assembly
  [void][Reflection.Assembly]::LoadFrom($assembly)
  foreach($item in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
    if([string]$item.Key -like 'AIBROWSE_*' -or [string]$item.Key -cin @('ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','NODE_OPTIONS')) {
      $saved[[string]$item.Key]=[string]$item.Value
      [Environment]::SetEnvironmentVariable([string]$item.Key,[NullString]::Value,'Process')
    }
  }
  Control $(if($Feasibility){'boot'}elseif($Scene -ceq 'R'){'backup'}else{'partial'})
  Run-Job 'import' 'prepare'
  $null=Required 'prepare-complete.json'
  Run-Job 'transfer' $ScopeId
  if($Feasibility){$null=Required 'boot-complete.json';Run-Job 'import' 'boot'}
  else {
    if($Scene -ceq 'R') {
      $null=Required 'backup-complete.json'
      Run-Job 'import' 'install-b'
      Control 'restore'
      Run-Job 'transfer' $ScopeId
      $null=Required 'restore-handoff.json'
    } else {$null=Required 'partial-handoff.json';$null=Required 'gate-handoff.json'}
    $null=Required 'successor-complete.json'
    Run-Job 'import' 'verify'
    $null=Required 'verify-complete.json'
    Control 'cold'
    Run-Job 'transfer' $ScopeId
    $null=Required 'cold-complete.json'
    Run-Job 'import' 'verify-cold'
    $null=Required 'verify-cold-complete.json'
  }
  Check-Time
  $result.completed=$true
} catch {$result.error=$_.Exception.Message;$result.completed=$false}
finally {
  foreach($item in $saved.GetEnumerator()){[Environment]::SetEnvironmentVariable($item.Key,$item.Value,'Process')}
  foreach($stream in $locks){$stream.Dispose()}
  $result.elapsedMs=$clock.Elapsed.TotalMilliseconds
  if($result.elapsedMs -ge $workMs){$result.completed=$false;$result.error='固定场景总期限已过'}
  Write-New (Join-Path $scope 'result.json') $result
}
$result|ConvertTo-Json -Depth 14
if(-not $result.completed){exit 1}
