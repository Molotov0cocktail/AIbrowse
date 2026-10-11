param(
  [Parameter(Mandatory = $true)][string]$ScopeId,
  [Parameter(Mandatory = $true)][ValidateSet('baseline', 'candidate', 'feasibility', 'long', 'fixed-long', 'turnover')][string]$Mode,
  [string]$BaselineScopeId = ''
)
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
if ($ScopeId -notmatch '^performance-check-[a-f0-9]{32}$') { throw 'scope id invalid' }
$scope = Join-Path $repository "log/stage7-e4/$ScopeId"
if (-not (Test-Path -LiteralPath $scope -PathType Container)) { throw 'scope missing' }
$scopeInfo = Get-Item -LiteralPath $scope -Force
if (($scopeInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'scope cannot be a reparse point' }

function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function NeedNew([string]$Path) { if (Test-Path -LiteralPath $Path) { throw "evidence already exists: $Path" } }
function VerifyBinding([string]$Path, [string]$Expected, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or (Hash $Path) -ne $Expected) { throw "$Label binding changed" }
}
$supplementModes = @('fixed-long', 'turnover')
$approvedBaselineScopeId = 'performance-check-c8e3852d7c5e4e54b92b171652ba6f48'
$approvedBaselineOracleSha256 = 'bd04e914df32a4661f2ba54216767ac4a1821278f4c0334ee3ed3bd9d49ad0ba'
$approvedBaselineBuildSha256 = '3b4b4ab8f2dbf21abb7ee751fe22bba747d72de8300a2e8a1c13f6d7850d3a99'
$applicabilityPath = Join-Path $repository 'log/stage7-e4/performance-supplement-independent-review-001/baseline-applicability.json'
$fixedSourceManifestPath = Join-Path $repository 'log/stage7-e6/final-quality-numeric-dccbb0b307bf43279afd8161bfcfb842/git-files-before.sha256'
$fixedSourceManifestSha256 = '3a47ce55c6015c0bc92f5e57171f1b68d2eddab88be138bd515a0fcbe777e210'
$buildPath = Join-Path $scope 'build.json'
$build = Get-Content -LiteralPath $buildPath -Raw | ConvertFrom-Json -Depth 100
if ($build.version -ne 1 -or $build.scopeId -ne $ScopeId -or $build.profile -ne 'ordinary-production-no-qualification') { throw 'build binding invalid' }
foreach ($property in $build.sources.PSObject.Properties) {
  $path = Join-Path $repository ($property.Name -replace '/', '\')
  VerifyBinding $path $property.Value "source $($property.Name)"
}
foreach ($property in $build.artifacts.PSObject.Properties) {
  $path = Join-Path $scope ($property.Name -replace '/', '\')
  VerifyBinding $path $property.Value "artifact $($property.Name)"
}
$oraclePath = Join-Path $scope 'oracle.cjs'
VerifyBinding $oraclePath $build.toolArtifacts.'oracle.cjs' 'oracle'
$seedPath = Join-Path $scope 'seed.cjs'
VerifyBinding $seedPath $build.toolArtifacts.'seed.cjs' 'seed'
VerifyBinding $build.electron.path $build.electron.sha256 'Electron'

$durationMs = if ($Mode -in @('long', 'fixed-long')) { 7200000 } elseif ($Mode -eq 'turnover') { 1080000 } elseif ($Mode -eq 'feasibility') { 300000 } else { 0 }
$workMs = if ($Mode -in @('long', 'fixed-long')) { 7500000 } elseif ($Mode -eq 'turnover') { 1140000 } else { 600000 }
$wholeDeadlineMs = if ($Mode -in @('baseline','candidate')) { 900000 } else { $workMs }
$controlPath = Join-Path $scope 'control.json'
$jobPath = Join-Path $scope 'job.json'
NeedNew $controlPath; NeedNew (Join-Path $scope 'oracle.json')
NeedNew (Join-Path $scope 'profile'); NeedNew (Join-Path $scope 'baseline-fixture.json')
NeedNew (Join-Path $scope 'persistence-seed.json'); NeedNew (Join-Path $scope 'fixture-port.json')
NeedNew (Join-Path $scope 'job-setup.json')
NeedNew (Join-Path $scope 'persistence-before'); NeedNew (Join-Path $scope 'persistence-after')
if ($Mode -notin @('baseline','candidate')) { NeedNew $jobPath; NeedNew (Join-Path $scope 'runtime-result.json'); NeedNew (Join-Path $scope 'runtime-failure.json') }
$baseline = $null
$baselineBinding = $null
if ($Mode -in @('candidate','long','fixed-long','turnover')) {
  if ($BaselineScopeId -notmatch '^performance-check-[a-f0-9]{32}$') { throw 'long mode requires a valid baseline scope' }
  $baselinePath = Join-Path $repository "log/stage7-e4/$BaselineScopeId/oracle.json"
  $baselineReport = Get-Content -LiteralPath $baselinePath -Raw | ConvertFrom-Json -Depth 100
  if ($baselineReport.verdict -ne 'PASS' -or $baselineReport.mode -ne 'baseline') { throw 'baseline oracle is not a PASS baseline' }
  $baselineHash = Hash $baselinePath
  $baseline = [ordered]@{ scopeId = $BaselineScopeId; sha256 = $baselineHash; report = $baselineReport }
  $baselineBinding = @($baselinePath, $baselineHash, 'baseline oracle')
}
$credentialFile = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)) 'aibrowse\credentials.json'
$externalProviderStatus = if (Test-Path -LiteralPath $credentialFile -PathType Leaf) {
  'not-run-credential-file-present-has-key-not-checked'
} else {
  'not-run-credential-file-missing'
}
$control = [ordered]@{
  version = 1
  mode = $Mode
  durationMs = $durationMs
  deadlineEpochMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $wholeDeadlineMs
  externalProviderStatus = $externalProviderStatus
}
if ($null -ne $baseline) { $control.baseline = $baseline }
$baselineApplicabilityBinding = $null
$fixedSourceManifestBinding = $null
$baselineBuildBinding = $null
if ($Mode -in $supplementModes) {
  if ($BaselineScopeId -ne $approvedBaselineScopeId -or $baseline.sha256 -ne $approvedBaselineOracleSha256) { throw 'supplement baseline is not the approved fixed baseline' }
  if (-not (Test-Path -LiteralPath $applicabilityPath -PathType Leaf)) { throw 'supplement independent applicability report missing' }
  $applicabilityInfo = Get-Item -LiteralPath $applicabilityPath -Force
  if (($applicabilityInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $applicabilityInfo.Length -lt 2 -or $applicabilityInfo.Length -gt 262144) { throw 'supplement applicability report type or size invalid' }
  $applicabilityRaw = [IO.File]::ReadAllText($applicabilityPath, [Text.Encoding]::UTF8)
  $applicability = $applicabilityRaw | ConvertFrom-Json -Depth 20
  if ($applicability.version -ne 1 -or $applicability.verdict -ne 'PASS' -or
      $applicability.baselineScopeId -ne $approvedBaselineScopeId -or
      $applicability.baselineOracleSha256 -ne $approvedBaselineOracleSha256 -or
      $applicability.fixedFirstSourceCommit -ne '207cdde3cb05550679c612e6e3561aac7a2bf248' -or
      $applicability.fixedFirstProvenanceSha256 -ne 'b587dc18fc3cac46f9038ed31983631d0f8a8a27d27fcc3381114f20611d310a' -or
      $applicability.fixedFirstSourceManifestSha256 -ne $fixedSourceManifestSha256) {
    throw 'supplement applicability contract invalid'
  }
  VerifyBinding $fixedSourceManifestPath $fixedSourceManifestSha256 'fixed FIRST source manifest'
  $fixedSources = @{}
  foreach ($line in [IO.File]::ReadLines($fixedSourceManifestPath)) {
    if ($line -notmatch '^([a-f0-9]{64})  (.+)$' -or $fixedSources.ContainsKey($Matches[2])) { throw 'fixed FIRST source manifest invalid' }
    $fixedSources[$Matches[2]] = $Matches[1]
  }
  $baselineBuildPath = Join-Path $repository "log/stage7-e4/$approvedBaselineScopeId/build.json"
  VerifyBinding $baselineBuildPath $approvedBaselineBuildSha256 'fixed baseline build manifest'
  $baselineBuild = Get-Content -LiteralPath $baselineBuildPath -Raw | ConvertFrom-Json -Depth 100
  $dependencyPaths = @(
    'node_modules/react/jsx-runtime.js',
    'node_modules/react/index.js',
    'node_modules/react-dom/client.js',
    'node_modules/react/cjs/react-jsx-runtime.production.js',
    'node_modules/react/cjs/react.production.js',
    'node_modules/react-dom/cjs/react-dom-client.production.js',
    'node_modules/scheduler/index.js',
    'node_modules/react-dom/index.js',
    'node_modules/react-dom/cjs/react-dom.production.js',
    'node_modules/scheduler/cjs/scheduler.production.js'
  )
  $actualDependencies = @($build.sources.PSObject.Properties | Where-Object { $_.Name.StartsWith('node_modules/') })
  if ($actualDependencies.Count -ne $dependencyPaths.Count) { throw 'supplement dependency source set changed' }
  foreach ($name in $dependencyPaths) {
    $current = $build.sources.PSObject.Properties[$name].Value
    $original = $baselineBuild.sources.PSObject.Properties[$name].Value
    if ($current -notmatch '^[a-f0-9]{64}$' -or $current -ne $original) { throw "supplement dependency source changed: $name" }
  }
  foreach ($property in $build.sources.PSObject.Properties) {
    if (-not $property.Name.StartsWith('tools/data-qualification/performance-check/') -and
        -not $property.Name.StartsWith('node_modules/') -and $fixedSources[$property.Name] -ne [string]$property.Value) {
      throw "product source is not fixed FIRST: $($property.Name)"
    }
  }
  if (($build.environment | ConvertTo-Json -Compress) -cne ($baselineBuild.environment | ConvertTo-Json -Compress)) { throw 'supplement machine environment changed' }
  foreach ($name in @(
    'tools/data-qualification/performance-check/baseline-fixture.ts',
    'tools/data-qualification/performance-check/build.ts',
    'tools/data-qualification/performance-check/config.ts'
  )) {
    if ($build.sources.PSObject.Properties[$name].Value -ne $baselineBuild.sources.PSObject.Properties[$name].Value) { throw "preserved baseline source changed: $name" }
  }
  $approvedModes = @($applicability.approvedModes)
  if ($approvedModes.Count -ne 2 -or $approvedModes[0] -ne 'fixed-long' -or $approvedModes[1] -ne 'turnover') { throw 'supplement approved modes invalid' }
  $requiredSupplementSources = @(
    'tools/data-qualification/performance-check/entry.ts',
    'tools/data-qualification/performance-check/metric-oracle.ts',
    'tools/data-qualification/performance-check/oracle.ts',
    'tools/data-qualification/performance-check/PerformanceJob.cs',
    'tools/data-qualification/performance-check/run.ps1'
  )
  $sourceProperties = @($applicability.supplementSources.PSObject.Properties)
  if ($sourceProperties.Count -ne $requiredSupplementSources.Count) { throw 'supplement reviewed source set invalid' }
  foreach ($name in $requiredSupplementSources) {
    $reviewed = $applicability.supplementSources.PSObject.Properties[$name].Value
    $built = $build.sources.PSObject.Properties[$name].Value
    if ($reviewed -notmatch '^[a-f0-9]{64}$' -or $built -ne $reviewed) { throw "supplement reviewed source changed: $name" }
  }
  if ($applicability.arbitraryAdditionalTurnoverCovered -ne $false -or $applicability.longerIntervalLeakCovered -ne $false) { throw 'supplement limitation statement invalid' }
  $applicabilityHash = Hash $applicabilityPath
  $control.baselineApplicability = [ordered]@{
    relativePath = 'log/stage7-e4/performance-supplement-independent-review-001/baseline-applicability.json'
    sha256 = $applicabilityHash
    report = $applicability
  }
  $baselineApplicabilityBinding = @($applicabilityPath, $applicabilityHash, 'supplement baseline applicability')
  $fixedSourceManifestBinding = @($fixedSourceManifestPath, $fixedSourceManifestSha256, 'fixed FIRST source manifest')
  $baselineBuildBinding = @($baselineBuildPath, $approvedBaselineBuildSha256, 'fixed baseline build manifest')
}
[IO.File]::WriteAllText($controlPath, ($control | ConvertTo-Json -Compress -Depth 100), [Text.UTF8Encoding]::new($false))

$sourcePath = Join-Path $PSScriptRoot 'PerformanceJob.cs'
$sourceHash = Hash $sourcePath
Add-Type -Path $sourcePath -ErrorAction Stop
if ((Hash $sourcePath) -ne $sourceHash) { throw 'Job source changed during compile' }
$bindings = @()
foreach ($property in $build.sources.PSObject.Properties) { $bindings += ,@((Join-Path $repository ($property.Name -replace '/', '\')), [string]$property.Value, "source $($property.Name)") }
foreach ($property in $build.artifacts.PSObject.Properties) { $bindings += ,@((Join-Path $scope ($property.Name -replace '/', '\')), [string]$property.Value, "artifact $($property.Name)") }
$bindings += ,@($oraclePath, [string]$build.toolArtifacts.'oracle.cjs', 'oracle')
$bindings += ,@($seedPath, [string]$build.toolArtifacts.'seed.cjs', 'seed')
$bindings += ,@([string]$build.electron.path, [string]$build.electron.sha256, 'Electron')
$bindings += ,@($controlPath, (Hash $controlPath), 'control')
if ($null -ne $baselineBinding) { $bindings += ,$baselineBinding }
if ($null -ne $baselineApplicabilityBinding) { $bindings += ,$baselineApplicabilityBinding }
if ($null -ne $fixedSourceManifestBinding) { $bindings += ,$fixedSourceManifestBinding }
if ($null -ne $baselineBuildBinding) { $bindings += ,$baselineBuildBinding }
$held = [Collections.Generic.List[IO.FileStream]]::new()
$prior = @{}
foreach ($entry in [Environment]::GetEnvironmentVariables().Keys) {
  $name = [string]$entry
  if ($name.StartsWith('AIBROWSE_') -or $name -in @('ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','NODE_OPTIONS')) {
    $prior[$name] = [ordered]@{ present = $true; value = [Environment]::GetEnvironmentVariable($name) }
    [Environment]::SetEnvironmentVariable($name, [NullString]::Value)
    if ([Environment]::GetEnvironmentVariables().Contains($name)) { throw "environment clear failed: $name" }
  }
}
try {
  foreach ($binding in $bindings) {
    VerifyBinding $binding[0] $binding[1] $binding[2]
    $held.Add([IO.File]::Open($binding[0], [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read))
  }
  try {
    & (Get-Command node.exe -ErrorAction Stop).Source $seedPath $scope
    if ($LASTEXITCODE -ne 0) { throw "performance seed failed: $LASTEXITCODE" }
    $setupRunId = [Guid]::NewGuid().ToString('N')
    $setupResult = [AIbrowse.Performance.PerformanceJob]::Execute('performance', $build.electron.path, (Join-Path $scope 'app'), 'setup', $scope, $setupRunId, 120000)
    [IO.File]::WriteAllText((Join-Path $scope 'job-setup.json'), ($setupResult | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    if (-not $setupResult.Succeeded) { throw 'performance setup failed' }
    if ($Mode -in @('baseline','candidate')) {
      $baselineClock = [Diagnostics.Stopwatch]::StartNew()
      for ($iteration = 0; $iteration -lt 7; $iteration++) {
        $remainingMs = $wholeDeadlineMs - [int]$baselineClock.ElapsedMilliseconds
        if ($remainingMs -lt 1000) { throw 'baseline whole deadline exceeded' }
        $iterationWorkMs = [Math]::Min($workMs, $remainingMs)
        $runId = [Guid]::NewGuid().ToString('N')
        $result = [AIbrowse.Performance.PerformanceJob]::Execute('performance', $build.electron.path, (Join-Path $scope 'app'), "baseline-$iteration", $scope, $runId, $iterationWorkMs)
        $iterationJob = Join-Path $scope "job-baseline-$iteration.json"
        [IO.File]::WriteAllText($iterationJob, ($result | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
        if (-not $result.Succeeded) { throw "baseline iteration $iteration failed" }
      }
    } else {
      $runId = [Guid]::NewGuid().ToString('N')
      $result = [AIbrowse.Performance.PerformanceJob]::Execute('performance', $build.electron.path, (Join-Path $scope 'app'), $ScopeId, $scope, $runId, $workMs)
      [IO.File]::WriteAllText($jobPath, ($result | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    }
    foreach ($binding in $bindings) { VerifyBinding $binding[0] $binding[1] $binding[2] }
    & (Get-Command node.exe -ErrorAction Stop).Source $oraclePath $scope
    if ($LASTEXITCODE -ne 0) { throw "performance oracle failed: $LASTEXITCODE" }
  } finally {
    foreach ($stream in $held) { $stream.Dispose() }
  }
} finally {
  foreach ($name in $prior.Keys) {
    [Environment]::SetEnvironmentVariable($name, [NullString]::Value)
    [Environment]::SetEnvironmentVariable($name, [string]$prior[$name].value)
  }
}
