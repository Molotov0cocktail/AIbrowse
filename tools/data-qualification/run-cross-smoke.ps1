param([Parameter(Mandatory)][ValidateSet('dev','production')][string]$Variant)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$runId = [Guid]::NewGuid().ToString('N')
$root = Join-Path $repository ('log/stage7-e2/cross-' + $Variant + '-' + $runId)
New-Item -ItemType Directory -Path $root | Out-Null
$clock = [Diagnostics.Stopwatch]::StartNew()
$node = (Get-Command node -ErrorAction Stop).Source
$electron = Join-Path $repository 'node_modules/electron/dist/electron.exe'
$cli = Join-Path $repository 'node_modules/electron-vite/dist/cli.js'
$viteRuntime = Join-Path $repository 'node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js'
$reader = Join-Path $PSScriptRoot 'cross-smoke-readback.ts'
$scopeTool = Join-Path $PSScriptRoot 'cross-smoke-scope.ts'
$jobSource = Join-Path $repository 'tools/release-profile/JobProcess.cs'
# The pinned launcher propagates Electron's close code. Bind this assumption,
# rather than treating an arbitrary Node root exit as the Electron exit code.
if (-not ([IO.File]::ReadAllText($viteRuntime).Contains("ps.on('close', process.exit);"))) { throw '固定开发启动器退出传递契约已改变' }
if (-not (Test-Path -LiteralPath (Join-Path $repository 'out/main/index.js') -PathType Leaf)) { throw '先完成当前普通候选构建' }
function Write-NewJson([string]$Path, $Value) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 12))
  if ($bytes.Length -gt 1048576) { throw '工具记录超出预算' }
  $file = [IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try { $file.Write($bytes); $file.Flush($true) } finally { $file.Dispose() }
}
function Hash-Files($Paths) {
  $items = @($Paths | Sort-Object -Unique)
  if ($items.Count -gt 2000) { throw '源码或制品成员超过工具预算' }
  foreach ($path in $items) { [ordered]@{ path=$path; sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash } }
}
function Current-Out {
  $paths = @()
  foreach ($part in @('main','preload','renderer','lifecycle-guardian')) {
    $paths += @((Get-ChildItem -LiteralPath (Join-Path $repository ('out/' + $part)) -Recurse -File).FullName)
  }
  return @(Hash-Files $paths)
}
$sourcePaths = @((Get-ChildItem -LiteralPath (Join-Path $repository 'src') -Recurse -File).FullName)
$sourcePaths += @((Get-ChildItem -LiteralPath (Join-Path $repository 'tools/build') -File).FullName)
$sourcePaths += (Join-Path $repository 'package.json')
$sourcePaths += $scopeTool
$sourcePaths += @($PSCommandPath,$reader,$jobSource,$cli,$viteRuntime,(Join-Path $repository 'native/lifecycle-guardian/Guardian.cs'),(Join-Path $repository 'tools/build/guardian.ps1'),(Join-Path $repository 'electron.vite.config.ts'),(Join-Path $repository 'package-lock.json'))
$sourceBinding = @(Hash-Files $sourcePaths)
Add-Type -Path $jobSource
$compilerAssembly = [Microsoft.CodeAnalysis.CSharp.CSharpCompilation].Assembly.Location
Write-NewJson (Join-Path $root 'binding.json') ([ordered]@{
  version=1; variant=$Variant; runId=$runId; source=$sourceBinding;
  executables=@(Hash-Files @($node,$electron)); runtime=[Environment]::Version.ToString();
  compiler=@(Hash-Files @($compilerAssembly));
  productProcessMs=120000; totalMs=900000; cleanupReserveMs=30000;
  readbackProcessMs=10000; preparationProcessMs=10000; maxBoundOutBytes=33554432; maxLogBytesPerStep=8388608; sampledArtifactBytes=268435456;
  maxArtifactEntries=4096; maxArtifactDepth=16;
  provider='离线夹具；清除真实Provider凭据'; actual='本脚本运行后由逐步原件证明，预检不授通过'
})
$saved = @{}
$allow = @('SystemRoot','WINDIR','SystemDrive','USERPROFILE','USERDOMAIN','USERNAME','COMSPEC','PATHEXT','PATH','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE')
foreach ($item in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
  $saved[[string]$item.Key] = [string]$item.Value
  if ($allow -notcontains [string]$item.Key) { [Environment]::SetEnvironmentVariable([string]$item.Key,[NullString]::Value,'Process') }
}
foreach ($name in @('APPDATA','LOCALAPPDATA')) {
  $directory = Join-Path $root $name
  New-Item -ItemType Directory -Path $directory | Out-Null
  [Environment]::SetEnvironmentVariable($name,$directory,'Process')
}
[Environment]::SetEnvironmentVariable('TEMP',$root,'Process')
[Environment]::SetEnvironmentVariable('TMP',$root,'Process')
[Environment]::SetEnvironmentVariable('AIBROWSE_SMOKE','1','Process')
$steps = [Collections.Generic.List[object]]::new()
$passed = $false
$failure = $null
try {
  foreach ($kind in @('session','sources','sources-ui','research','watch')) {
    $dataProfile = Join-Path $root ('profile-' + $kind)
    New-Item -ItemType Directory -Path $dataProfile | Out-Null
    $flag = switch ($kind) {
      'session' { 'AIBROWSE_SESSION_SMOKE' }
      'sources' { 'AIBROWSE_SOURCES_SMOKE' }
      'sources-ui' { 'AIBROWSE_SOURCES_UI_SMOKE' }
      'research' { 'AIBROWSE_RESEARCH_SMOKE' }
      'watch' { 'AIBROWSE_WATCH_SMOKE' }
    }
    $runningId = $null
    foreach ($mode in @('set','check')) {
      $remaining = 900000 - $clock.ElapsedMilliseconds
      if ($remaining -le 45000) { throw '整轮剩余时间不足以监督并读回一次进程' }
      $budget = [int][Math]::Min(120000, $remaining - 45000)
      $stepId = [Guid]::NewGuid().ToString('N')
      $prefix = Join-Path $root ($kind + '-' + $mode)
      [Environment]::SetEnvironmentVariable('AIBROWSE_USER_DATA_DIR',$dataProfile,'Process')
      [Environment]::SetEnvironmentVariable($flag,$mode,'Process')
      $appRoot = $prefix + '.app'
      $buildReceipt = $prefix + '.before-build.json'
      $scopeRequest = $prefix + '.scope.json'
      Write-NewJson $scopeRequest @{ repository=$repository; appRoot=$appRoot; receipt=$buildReceipt; electron=$electron }
      $exe = if ($Variant -eq 'dev') { $node } else { $electron }
      $arguments = if ($Variant -eq 'dev') { @('--import',([Uri]::new($scopeTool).AbsoluteUri),$cli,'dev') } else { @('.') }
      $step = [ordered]@{ kind=$kind; mode=$mode; runId=$stepId; budgetMs=$budget; appRoot=$appRoot; startedAt=[DateTimeOffset]::Now.ToString('o'); exitCode=$null; prepareJobZero=$null; jobZero=$false; readbackJobZero=$false; passed=$false; error=$null }
      $launchReceipt = @{ pid=0; created=0; runId=$stepId; arguments=$arguments; budgetMs=$budget }
      $prepareReceipt = $null; $readerReceipt = $null; $nativePhase = $null
      try {
        $frozenOut = if ($Variant -eq 'production') { @(Current-Out) } else { $null }
        if ($Variant -eq 'production') {
          Write-NewJson ($prefix + '.frozen-out.json') $frozenOut
          $prepareId = [Guid]::NewGuid().ToString('N')
          $prepareBudget = [int][Math]::Min(10000,900000 - $clock.ElapsedMilliseconds - 30000)
          if ($prepareBudget -le 0) { throw '准备剩余期限不足' }
          $prepareReceipt = @{ pid=0; created=0; runId=$prepareId }
          $step.prepareJobZero=$false; $nativePhase='prepare'
          $prepareCallback = [Action[uint32,long]] { param($processId,$created) $prepareReceipt.pid=$processId; $prepareReceipt.created=$created }
          $prepareCode = [AIbrowse.ReleaseProfile.JobProcess]::Execute($node,@($scopeTool,$scopeRequest),$repository,$prepareId,$prepareBudget,$prepareCallback)
          $step.prepareJobZero=$true
          Write-NewJson ($prefix + '.prepare-launch.json') $prepareReceipt
          if ($prepareCode -ne 0) { throw '私有应用目录准备失败' }
        } else {
          [Environment]::SetEnvironmentVariable('AIBROWSE_CROSS_REQUEST',$scopeRequest,'Process')
        }
        # Recompute from the same round clock after every preparation IO.
        $budget = [int][Math]::Min(120000,900000 - $clock.ElapsedMilliseconds - 45000)
        if ($budget -le 0) { throw '应用启动剩余期限不足' }
        $step.budgetMs=$budget; $launchReceipt.budgetMs=$budget
        $callback = [Action[uint32,long]] { param($processId,$created)
          $launchReceipt.pid=$processId; $launchReceipt.created=$created
        }
        $launchDirectory = if ($Variant -eq 'dev') { $repository } else { $appRoot }
        $nativePhase='application'
        $step.exitCode = [AIbrowse.ReleaseProfile.JobProcess]::Execute($exe,$arguments,$launchDirectory,$stepId,$budget,$callback)
        # Execute owns this same handle from atomic creation until Active=0.
        $step.jobZero = $true
        [Environment]::SetEnvironmentVariable('AIBROWSE_CROSS_REQUEST',[NullString]::Value,'Process')
        Write-NewJson ($prefix + '.launch.json') $launchReceipt
        $afterOut = @(Current-Out)
        if ($Variant -eq 'production' -and ($afterOut | ConvertTo-Json -Compress) -cne ($frozenOut | ConvertTo-Json -Compress)) { throw '运行期间制品集合改变' }
        Write-NewJson ($prefix + '.build.json') $afterOut
        $requestPath = $prefix + '.request.json'
        $outputPath = $prefix + '.readback.json'
        Write-NewJson $requestPath @{ root=$root; profile=$dataProfile; repository=$repository; appRoot=$appRoot; buildReceipt=$buildReceipt; kind=$kind; mode=$mode; exitCode=$step.exitCode; jobZero=$true; expectedRunningId=$runningId; output=$outputPath }
        $readId = [Guid]::NewGuid().ToString('N')
        $readerBudget = [int][Math]::Min(10000, 900000 - $clock.ElapsedMilliseconds - 30000)
        if ($readerBudget -le 0) { throw '整轮剩余时间不足以监督读回及归零' }
        $readerReceipt = @{ pid=0; created=0; runId=$readId; budgetMs=$readerBudget }
        $readCallback = [Action[uint32,long]] { param($processId,$created) $readerReceipt.pid=$processId; $readerReceipt.created=$created }
        $nativePhase='readback'
        $readCode = [AIbrowse.ReleaseProfile.JobProcess]::Execute($node,@($reader,$requestPath),$repository,$readId,$readerBudget,$readCallback)
        $step.readbackJobZero = $true
        Write-NewJson ($prefix + '.reader-launch.json') $readerReceipt
        if ($readCode -ne 0) { throw '固定marker/账本/数据读回未通过' }
        $readback = [IO.File]::ReadAllText($outputPath) | ConvertFrom-Json
        if (-not $readback.passed -or -not $readback.ledgerRetired) { throw '关闭证据不完整' }
        if ($kind -eq 'research' -and $mode -eq 'set') { $runningId = $readback.runningId }
        $after = @(Hash-Files $sourcePaths)
        if (($after | ConvertTo-Json -Compress) -cne ($sourceBinding | ConvertTo-Json -Compress)) { throw '运行期间候选源码改变' }
        if ($clock.ElapsedMilliseconds -ge 900000) { throw '整轮时间预算已耗尽' }
        $step.passed = $true
      } catch {
        $step.error = $_.Exception.Message
        if ($step.error.Contains('固定验收超时；Job 已确认实际归零')) {
          switch ($nativePhase) {
            'prepare' { $step.prepareJobZero=$true }
            'application' { $step.jobZero=$true }
            'readback' { $step.readbackJobZero=$true }
          }
        }

        throw
      } finally {
        if ($null -ne $prepareReceipt -and $prepareReceipt.pid -ne 0 -and -not (Test-Path -LiteralPath ($prefix + '.prepare-launch.json'))) { Write-NewJson ($prefix + '.prepare-launch.json') $prepareReceipt }
        if ($launchReceipt.pid -ne 0 -and -not (Test-Path -LiteralPath ($prefix + '.launch.json'))) { Write-NewJson ($prefix + '.launch.json') $launchReceipt }
        if ($null -ne $readerReceipt -and $readerReceipt.pid -ne 0 -and -not (Test-Path -LiteralPath ($prefix + '.reader-launch.json'))) { Write-NewJson ($prefix + '.reader-launch.json') $readerReceipt }
        $steps.Add($step)
        Write-NewJson ($prefix + '.result.json') $step
        if ($clock.ElapsedMilliseconds -ge 900000) { throw '单步原件写入后整轮期限已耗尽' }
      }
    }
    [Environment]::SetEnvironmentVariable($flag,[NullString]::Value,'Process')
  }
  if ($clock.ElapsedMilliseconds -ge 900000) { throw '整轮时间预算已耗尽' }
  $passed = $true
} catch { $failure = $_.Exception.Message }
finally {
  foreach ($item in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
    if (-not $saved.ContainsKey([string]$item.Key)) { [Environment]::SetEnvironmentVariable([string]$item.Key,[NullString]::Value,'Process') }
  }
  foreach ($item in $saved.GetEnumerator()) { [Environment]::SetEnvironmentVariable($item.Key,$item.Value,'Process') }
  if ($clock.ElapsedMilliseconds -ge 900000) { $passed=$false; $failure='最终原件写入前整轮期限已耗尽' }
  Write-NewJson (Join-Path $root 'result.json') @{ passed=$passed; error=$failure; elapsedMs=$clock.ElapsedMilliseconds; steps=$steps.ToArray() }
  if ($clock.ElapsedMilliseconds -ge 900000) { $passed=$false; $failure='最终原件写入后整轮期限已耗尽' }
  # A candidate result alone is never sufficient: completion and exit zero are required.
  Write-NewJson (Join-Path $root 'completion.json') @{ passed=$passed; error=$failure; elapsedMs=$clock.ElapsedMilliseconds; resultSha256=(Get-FileHash -LiteralPath (Join-Path $root 'result.json') -Algorithm SHA256).Hash }
  if ($clock.ElapsedMilliseconds -ge 900000) { $passed=$false }
}
Write-Output $root
if ($clock.ElapsedMilliseconds -ge 900000) { $passed=$false }
if (-not $passed) { exit 1 }
