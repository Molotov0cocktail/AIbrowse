param([Parameter(Mandatory)][ValidateSet('dev','production')][string]$Variant)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$runId = [Guid]::NewGuid().ToString('N')
$root = Join-Path $repository ('log/stage7-e2/default-smoke-' + $Variant + '-' + $runId)
New-Item -ItemType Directory -Path $root | Out-Null
$clock = [Diagnostics.Stopwatch]::StartNew()
$workBudgetMs = 600000
$jobZeroReserveMs = 30000
$jobZeroCreditMs = 0
$node = (Get-Command node -ErrorAction Stop).Source
$electron = Join-Path $repository 'node_modules/electron/dist/electron.exe'
$cli = Join-Path $repository 'node_modules/electron-vite/dist/cli.js'
$viteRuntime = Join-Path $repository 'node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js'
$scopeTool = Join-Path $PSScriptRoot 'scope.ts'
$reader = Join-Path $PSScriptRoot 'readback.ts'
$jobSource = Join-Path $repository 'tools/release-profile/JobProcess.cs'
$compilerAssembly = [Microsoft.CodeAnalysis.CSharp.CSharpCompilation].Assembly.Location

function Work-ElapsedMs { return [long]$clock.ElapsedMilliseconds - [long]$jobZeroCreditMs }
function Work-RemainingMs { return [long]$workBudgetMs - (Work-ElapsedMs) }
function Write-NewJson([string]$Path, $Value) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 32))
  if ($bytes.Length -gt 8388608) { throw '默认冒烟工具记录超过8MiB预算' }
  $file = [IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try { $file.Write($bytes); $file.Flush($true) } finally { $file.Dispose() }
}
function Snapshot-Files($Paths, [long]$MaximumTotalBytes = [long]::MaxValue, [long]$MaximumFileBytes = [long]::MaxValue) {
  $items = @($Paths | ForEach-Object { [IO.Path]::GetFullPath([string]$_) } | Sort-Object -Unique)
  if ($items.Count -gt 4096) { throw '绑定成员超过4096项预算' }
  [long]$total = 0
  $result = @()
  foreach ($path in $items) {
    $before = Get-Item -LiteralPath $path -Force
    if (-not $before.PSIsContainer -and ($before.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
      $relative = [IO.Path]::GetRelativePath($repository,$path).Replace('\','/')
      if (($relative.Split('/')).Count -gt 16) { throw '绑定成员超过深度预算' }
      if ($before.Length -gt $MaximumFileBytes) { throw '绑定成员超过单文件字节预算' }
      $total += $before.Length
      if ($total -gt $MaximumTotalBytes) { throw '绑定集合超过字节预算' }
      $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
      $after = Get-Item -LiteralPath $path -Force
      if ($after.PSIsContainer -or $after.Length -ne $before.Length -or $after.LastWriteTimeUtc.Ticks -ne $before.LastWriteTimeUtc.Ticks) { throw '绑定成员读取期间改变' }
      $result += [ordered]@{ path=$relative; bytes=$before.Length; written=$before.LastWriteTimeUtc.Ticks; sha256=$hash }
    } else { throw '绑定成员不是普通文件' }
  }
  return @($result)
}
function Source-Paths {
  $paths = @()
  foreach ($directory in @('src','tools','native/lifecycle-guardian')) {
    $paths += @((Get-ChildItem -LiteralPath (Join-Path $repository $directory) -Recurse -File -Force).FullName)
  }
  foreach ($name in @('.node-version','.npmrc','package.json','package-lock.json','electron.vite.config.ts','eslint.config.mjs','vitest.config.ts','tsconfig.json','tsconfig.node.json','tsconfig.web.json')) {
    $paths += Join-Path $repository $name
  }
  return @($paths)
}
function Out-Paths {
  $paths = @()
  foreach ($part in @('main','preload','renderer','lifecycle-guardian')) {
    $directory = Join-Path $repository ('out/' + $part)
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw '普通构建缺少完整输出目录' }
    $paths += @((Get-ChildItem -LiteralPath $directory -Recurse -File -Force).FullName)
  }
  return @($paths)
}
function Assert-OrdinaryProductionBuild {
  $required = @('out/main/index.js','out/main/lifecycle-guardian-integrity.json','out/preload/index.js','out/renderer/index.html','out/lifecycle-guardian/guardian.exe','out/lifecycle-guardian/manifest.json')
  foreach ($relative in $required) {
    $path = Join-Path $repository $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw ('普通production build缺少：' + $relative) }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '普通production build包含链接' }
  }
  $integrityPath = Join-Path $repository 'out/main/lifecycle-guardian-integrity.json'
  $manifestPath = Join-Path $repository 'out/lifecycle-guardian/manifest.json'
  $integrityBytes = [IO.File]::ReadAllBytes($integrityPath)
  $manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
  if ($integrityBytes.Length -gt 4096 -or $manifestBytes.Length -gt 4096) { throw '普通build helper清单超出预算' }
  if ([Convert]::ToHexString($integrityBytes) -cne [Convert]::ToHexString($manifestBytes)) { throw '普通build主制品与helper清单不一致' }
  $manifest = [Text.UTF8Encoding]::new($false,$true).GetString($manifestBytes) | ConvertFrom-Json
  $helperPath = Join-Path $repository 'out/lifecycle-guardian/guardian.exe'
  if ((@($manifest.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'bytes,sha256,version' -or
      $manifest.version -ne 1 -or $manifest.bytes -ne (Get-Item -LiteralPath $helperPath).Length -or
      [string]$manifest.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
      [string]$manifest.sha256 -cne (Get-FileHash -LiteralPath $helperPath -Algorithm SHA256).Hash.ToLowerInvariant()) {
    throw '普通build helper完整性绑定无效'
  }
  return [ordered]@{ manifestSha256=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant(); helperSha256=[string]$manifest.sha256 }
}
function Measure-Artifacts {
  [long]$bytes = 0; [int]$entries = 0
  $pending = [Collections.Generic.Queue[object]]::new(); $pending.Enqueue(@($root,0))
  while ($pending.Count -ne 0) {
    $current = $pending.Dequeue(); $path=[string]$current[0]; $depth=[int]$current[1]
    if ($depth -gt 16) { throw '默认冒烟原件超过深度预算' }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '默认冒烟原件包含链接' }
    $entries += 1
    if ($entries -gt 4096) { throw '默认冒烟原件超过成员预算' }
    if ($item.PSIsContainer) { foreach ($child in @(Get-ChildItem -LiteralPath $path -Force)) { $pending.Enqueue(@($child.FullName,$depth+1)) } } else { $bytes += $item.Length }
    if ($bytes -gt 268435456) { throw '默认冒烟原件超过256MiB预算' }
  }
  return [ordered]@{ bytes=$bytes; entries=$entries }
}
function Add-ZeroCredit([long]$PhaseElapsed, [long]$Budget, [string]$Message) {
  if ($Message.Contains('固定验收超时；Job 已确认实际归零')) {
    $available = [Math]::Max(0,$jobZeroReserveMs-$script:jobZeroCreditMs)
    $script:jobZeroCreditMs += [Math]::Min($available,[Math]::Max(0,$PhaseElapsed-$Budget))
    return $true
  }
  return $false
}
function Assert-WorkOpen([string]$Message) { if ((Work-ElapsedMs) -ge $workBudgetMs) { throw $Message } }

$sourcePaths = @(); $runtimePaths = @(); $sourceBinding = @(); $runtimeBinding = @()
$frozenOut = $null; $ordinaryBuild = $null; $saved = @{}; $environmentCaptured = $false
$steps = [Collections.Generic.List[object]]::new(); $passed = $false; $failure = $null
try {
  if (-not (Test-Path -LiteralPath $electron -PathType Leaf)) { throw '固定Electron运行时不存在' }
  if (-not ([IO.File]::ReadAllText($viteRuntime).Contains("ps.on('close', process.exit);"))) { throw '固定开发启动器退出传递契约已改变' }
  if ($Variant -eq 'production') { $ordinaryBuild = Assert-OrdinaryProductionBuild }
  $sourcePaths = @(Source-Paths); $sourceBinding = @(Snapshot-Files $sourcePaths ([long]::MaxValue) 8388608)
  $runtimePaths = @($node,$electron,$compilerAssembly,$cli)
  $runtimePaths += @((Get-ChildItem -LiteralPath (Join-Path $repository 'node_modules/electron-vite/dist') -Recurse -File -Force).FullName)
  $runtimePaths += Join-Path $repository 'node_modules/electron-vite/package.json'
  $runtimeBinding = @(Snapshot-Files $runtimePaths)
  if ($Variant -eq 'production') { $frozenOut = @(Snapshot-Files (Out-Paths) 33554432) }
  Add-Type -Path $jobSource
  Write-NewJson (Join-Path $root 'binding.json') ([ordered]@{
    version=1; variant=$Variant; runId=$runId; source=$sourceBinding; runtime=$runtimeBinding; initialOut=$frozenOut; ordinaryBuild=$ordinaryBuild
    workBudgetMs=$workBudgetMs; jobZeroReserveMs=$jobZeroReserveMs; preparationProcessMs=10000; readbackProcessMs=10000; applicationCloseReserveMs=30000
    sourceOrToolFileBytes=8388608; productSnapshotBytes=33554432; privateLogBytes=8388608
    sampledArtifactBytes=268435456; maxArtifactEntries=4096; maxArtifactDepth=16
    provider='离线夹具；环境白名单不注入真实Provider凭据'; actual='须由本轮result与completion及进程exit0证明；预检不授通过'
  })
  Assert-WorkOpen '绑定原件写入后600秒工作预算已耗尽'
  $allow = @('SystemRoot','WINDIR','SystemDrive','USERPROFILE','USERDOMAIN','USERNAME','COMSPEC','PATHEXT','PATH','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE')
  foreach ($item in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
    $saved[[string]$item.Key] = [string]$item.Value
    if ($allow -notcontains [string]$item.Key) { [Environment]::SetEnvironmentVariable([string]$item.Key,[NullString]::Value,'Process') }
  }
  $environmentCaptured = $true
  foreach ($name in @('APPDATA','LOCALAPPDATA','TEMP','TMP')) { $directory=Join-Path $root $name; New-Item -ItemType Directory -Path $directory | Out-Null; [Environment]::SetEnvironmentVariable($name,$directory,'Process') }
  [Environment]::SetEnvironmentVariable('AIBROWSE_SMOKE','1','Process')

  $prefix=Join-Path $root $Variant; $profile=Join-Path $root 'profile'; New-Item -ItemType Directory -Path $profile | Out-Null
  [Environment]::SetEnvironmentVariable('AIBROWSE_USER_DATA_DIR',$profile,'Process')
  $appRoot=$prefix+'.app'; $buildReceipt=$prefix+'.before-build.json'; $scopeRequest=$prefix+'.scope.json'
  Write-NewJson $scopeRequest @{ repository=$repository; appRoot=$appRoot; receipt=$buildReceipt; electron=$electron }
  $stepId=[Guid]::NewGuid().ToString('N')
  $step=[ordered]@{ variant=$Variant; runId=$stepId; startedAt=[DateTimeOffset]::Now.ToString('o'); budgetMs=$null; exitCode=$null; prepareJobZero=($Variant -eq 'dev'); jobZero=$false; readbackJobZero=$false; passed=$false; phase='prepare'; error=$null }
  $prepareReceipt=$null; $launchReceipt=@{ pid=0; created=0; runId=$stepId; budgetMs=0 }; $readerReceipt=$null
  try {
    if ($Variant -eq 'production') {
      $prepareBudget=[int][Math]::Min(10000,(Work-RemainingMs)-30000)
      if ($prepareBudget -le 0) { throw 'production准备未给应用与收口保留工作期限' }
      $prepareId=[Guid]::NewGuid().ToString('N'); $prepareReceipt=@{ pid=0; created=0; runId=$prepareId; budgetMs=$prepareBudget }
      $prepareCallback=[Action[uint32,long]] { param($childProcessId,$createdFileTime) $prepareReceipt.pid=$childProcessId; $prepareReceipt.created=$createdFileTime; [AIbrowse.ReleaseProfile.JobProcess]::AssertContains($prepareId,$childProcessId) }
      $phaseClock=[Diagnostics.Stopwatch]::StartNew()
      try { $prepareCode=[AIbrowse.ReleaseProfile.JobProcess]::Execute($node,@($scopeTool,$scopeRequest),$repository,$prepareId,$prepareBudget,$prepareCallback); $step.prepareJobZero=$true } catch { if (Add-ZeroCredit $phaseClock.ElapsedMilliseconds $prepareBudget $_.Exception.Message) { $step.prepareJobZero=$true }; throw }
      Write-NewJson ($prefix+'.prepare-launch.json') $prepareReceipt
      if ($prepareCode -ne 0) { throw 'production私有应用目录准备失败' }
      if ((@(Snapshot-Files (Out-Paths) 33554432) | ConvertTo-Json -Compress -Depth 8) -cne ($frozenOut | ConvertTo-Json -Compress -Depth 8)) { throw 'production准备期间普通build制品改变' }
    } else { [Environment]::SetEnvironmentVariable('AIBROWSE_DEFAULT_REQUEST',$scopeRequest,'Process') }
    $budget=[int][Math]::Min([int]::MaxValue,(Work-RemainingMs)-30000)
    if ($budget -le 0) { throw '应用启动未保留30秒读回与最终收口预算' }
    $step.budgetMs=$budget; $launchReceipt.budgetMs=$budget; $step.phase='application'
    $callback=[Action[uint32,long]] { param($childProcessId,$createdFileTime) $launchReceipt.pid=$childProcessId; $launchReceipt.created=$createdFileTime; [AIbrowse.ReleaseProfile.JobProcess]::AssertContains($stepId,$childProcessId) }
    $exe=if($Variant -eq 'dev'){$node}else{$electron}; $arguments=if($Variant -eq 'dev'){@('--import',([Uri]::new($scopeTool).AbsoluteUri),$cli,'dev')}else{@('.')}; $directory=if($Variant -eq 'dev'){$repository}else{$appRoot}
    $phaseClock=[Diagnostics.Stopwatch]::StartNew()
    try { $step.exitCode=[AIbrowse.ReleaseProfile.JobProcess]::Execute($exe,$arguments,$directory,$stepId,$budget,$callback); $step.jobZero=$true } catch { if (Add-ZeroCredit $phaseClock.ElapsedMilliseconds $budget $_.Exception.Message) { $step.jobZero=$true }; throw }
    [Environment]::SetEnvironmentVariable('AIBROWSE_DEFAULT_REQUEST',[NullString]::Value,'Process')
    Write-NewJson ($prefix+'.launch.json') $launchReceipt
    if ($Variant -eq 'production' -and (@(Snapshot-Files (Out-Paths) 33554432) | ConvertTo-Json -Compress -Depth 8) -cne ($frozenOut | ConvertTo-Json -Compress -Depth 8)) { throw 'production应用运行期间普通build制品改变' }
    if ($Variant -eq 'dev') { $frozenOut=@(Snapshot-Files (Out-Paths) 33554432) }
    $requestPath=$prefix+'.request.json'; $outputPath=$prefix+'.readback.json'
    Write-NewJson $requestPath @{ root=$root; repository=$repository; appRoot=$appRoot; profile=$profile; buildReceipt=$buildReceipt; output=$outputPath; exitCode=$step.exitCode; jobZero=$true }
    $readerBudget=[int][Math]::Min(10000,(Work-RemainingMs)); if($readerBudget -le 0){throw '读回仍使用原600秒工作预算且余额不足'}
    $readerId=[Guid]::NewGuid().ToString('N'); $readerReceipt=@{ pid=0; created=0; runId=$readerId; budgetMs=$readerBudget }
    $readerCallback=[Action[uint32,long]] { param($childProcessId,$createdFileTime) $readerReceipt.pid=$childProcessId; $readerReceipt.created=$createdFileTime; [AIbrowse.ReleaseProfile.JobProcess]::AssertContains($readerId,$childProcessId) }
    $step.phase='readback'; $phaseClock=[Diagnostics.Stopwatch]::StartNew()
    try { $readCode=[AIbrowse.ReleaseProfile.JobProcess]::Execute($node,@($reader,$requestPath),$repository,$readerId,$readerBudget,$readerCallback); $step.readbackJobZero=$true } catch { if (Add-ZeroCredit $phaseClock.ElapsedMilliseconds $readerBudget $_.Exception.Message) { $step.readbackJobZero=$true }; throw }
    Write-NewJson ($prefix+'.reader-launch.json') $readerReceipt
    if ($readCode -ne 0) { throw '默认完整marker、正常退出或账本读回未通过' }
    $readback=Get-Content -LiteralPath $outputPath -Raw | ConvertFrom-Json
    if (-not $readback.passed -or -not $readback.ledgerRetired) { throw '默认冒烟关闭证据不完整' }
    if ((@(Snapshot-Files (Out-Paths) 33554432) | ConvertTo-Json -Compress -Depth 8) -cne ($frozenOut | ConvertTo-Json -Compress -Depth 8)) { throw '默认冒烟读回期间制品改变' }
    if ((@(Snapshot-Files $sourcePaths ([long]::MaxValue) 8388608) | ConvertTo-Json -Compress -Depth 8) -cne ($sourceBinding | ConvertTo-Json -Compress -Depth 8)) { throw '运行期间候选源码或工具改变' }
    if ((@(Snapshot-Files $runtimePaths) | ConvertTo-Json -Compress -Depth 8) -cne ($runtimeBinding | ConvertTo-Json -Compress -Depth 8)) { throw '运行期间固定运行时改变' }
    Assert-WorkOpen '默认冒烟600秒工作预算已耗尽'
    $step.phase='closed'; $step.passed=$true; $passed=$true
  } catch { [Environment]::SetEnvironmentVariable('AIBROWSE_DEFAULT_REQUEST',[NullString]::Value,'Process'); $step.error=$_.Exception.Message; throw }
  finally {
    if ($null -ne $prepareReceipt -and $prepareReceipt.pid -ne 0 -and -not (Test-Path -LiteralPath ($prefix+'.prepare-launch.json'))) { Write-NewJson ($prefix+'.prepare-launch.json') $prepareReceipt }
    if ($launchReceipt.pid -ne 0 -and -not (Test-Path -LiteralPath ($prefix+'.launch.json'))) { Write-NewJson ($prefix+'.launch.json') $launchReceipt }
    if ($null -ne $readerReceipt -and $readerReceipt.pid -ne 0 -and -not (Test-Path -LiteralPath ($prefix+'.reader-launch.json'))) { Write-NewJson ($prefix+'.reader-launch.json') $readerReceipt }
    $steps.Add($step); Write-NewJson ($prefix+'.result.json') $step
  }
} catch { $failure=$_.Exception.Message; $passed=$false }
finally {
  if ($environmentCaptured) {
    foreach ($item in [Environment]::GetEnvironmentVariables().GetEnumerator()) { if (-not $saved.ContainsKey([string]$item.Key)) { [Environment]::SetEnvironmentVariable([string]$item.Key,[NullString]::Value,'Process') } }
    foreach ($item in $saved.GetEnumerator()) { [Environment]::SetEnvironmentVariable($item.Key,$item.Value,'Process') }
  }
  try {
    if ($sourcePaths.Count -ne 0 -and (@(Snapshot-Files $sourcePaths ([long]::MaxValue) 8388608) | ConvertTo-Json -Compress -Depth 8) -cne ($sourceBinding | ConvertTo-Json -Compress -Depth 8)) { throw '最终候选源码或工具改变' }
    if ($runtimePaths.Count -ne 0 -and (@(Snapshot-Files $runtimePaths) | ConvertTo-Json -Compress -Depth 8) -cne ($runtimeBinding | ConvertTo-Json -Compress -Depth 8)) { throw '最终固定运行时改变' }
    if ($null -ne $frozenOut -and (@(Snapshot-Files (Out-Paths) 33554432) | ConvertTo-Json -Compress -Depth 8) -cne ($frozenOut | ConvertTo-Json -Compress -Depth 8)) { throw '最终普通build制品改变' }
    $usage=Measure-Artifacts; Assert-WorkOpen '最终原件写入前600秒工作预算已耗尽'
  } catch { $passed=$false; if($null -eq $failure){$failure=$_.Exception.Message}; $usage=$null }
  Write-NewJson (Join-Path $root 'result.json') @{ passed=$passed; firstError=$failure; variant=$Variant; workElapsedMs=(Work-ElapsedMs); wallElapsedMs=$clock.ElapsedMilliseconds; jobZeroCreditMs=$jobZeroCreditMs; usage=$usage; steps=$steps.ToArray() }
  if ((Work-ElapsedMs) -ge $workBudgetMs) { $passed=$false; if($null -eq $failure){$failure='result关闭后600秒工作预算已耗尽'} }
  $resultHash=(Get-FileHash -LiteralPath (Join-Path $root 'result.json') -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-NewJson (Join-Path $root 'completion.json') @{ passed=$passed; firstError=$failure; variant=$Variant; workElapsedMs=(Work-ElapsedMs); wallElapsedMs=$clock.ElapsedMilliseconds; resultSha256=$resultHash }
  if ((Work-ElapsedMs) -ge $workBudgetMs) { $passed=$false }
  try { $null=Measure-Artifacts } catch { $passed=$false }
}
Write-Output $root
if ((Work-ElapsedMs) -ge $workBudgetMs) { $passed=$false }
if (-not $passed) { exit 1 }
