param(
  [Parameter(Mandatory = $true)][string]$ScopeId,
  [Parameter(Mandatory = $true)][ValidateSet('baseline', 'candidate', 'feasibility', 'long')][string]$Mode,
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

$durationMs = if ($Mode -eq 'long') { 7200000 } elseif ($Mode -eq 'feasibility') { 300000 } else { 0 }
$workMs = if ($Mode -eq 'long') { 7500000 } else { 600000 }
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
if ($Mode -in @('candidate','long')) {
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
