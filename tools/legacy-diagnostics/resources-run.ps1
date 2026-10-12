param([switch]$CheckOnly, [switch]$StartupOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../maintenance/enter-project-environment.ps1')
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Add-Type -Path @((Join-Path $PSScriptRoot 'resources-native.cs'), (Join-Path $PSScriptRoot 'resources-job.cs'), (Join-Path $PSScriptRoot '../data-qualification/performance-check/PerformanceJob.cs'))
if ($CheckOnly) { Write-Output '原生资源工具编译通过；未启动产品。'; exit 0 }
$runId = [Guid]::NewGuid().ToString('N')
$scope = Join-Path $repo "log/legacy-diagnosis-20261012/resources/resource-run-$runId"
[IO.Directory]::CreateDirectory((Join-Path $scope 'profile')) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $scope 'app')) | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'out') -Destination (Join-Path $scope 'app/out') -Recurse
[pscustomobject]@{name='aibrowse-resource-diagnostic';version='0.1.1';main=(Join-Path $PSScriptRoot 'resources-entry.cjs')} | ConvertTo-Json | Set-Content (Join-Path $scope 'app/package.json') -Encoding utf8
$sourcePaths = @('tools/legacy-diagnostics/resources-native.cs','tools/legacy-diagnostics/resources-entry.cjs','tools/legacy-diagnostics/resources-job.cs','tools/legacy-diagnostics/resources-run.ps1','tools/data-qualification/performance-check/PerformanceJob.cs','out/main/index.js','out/preload/index.js','node_modules/electron/dist/electron.exe')
$sourcePaths += @(Get-ChildItem -LiteralPath (Join-Path $repo 'out') -Recurse -File | ForEach-Object { [IO.Path]::GetRelativePath($repo, $_.FullName).Replace('\','/') })
$sourcePaths = @($sourcePaths | Sort-Object -Unique)
$binding = @($sourcePaths | ForEach-Object { $full = Join-Path $repo $_; [pscustomobject]@{ path=$_; sha256=(Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant() } })
$binding | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $scope 'binding.json') -Encoding utf8
$runtimeBudget = if ($StartupOnly) { 30000 } else { 780000 }
[pscustomobject]@{head=(& git -C $repo rev-parse HEAD); os=[Environment]::OSVersion.VersionString; node=(& node --version); power=(& powercfg /getactivescheme); startupOnly=[bool]$StartupOnly; phases=@('warm-90s','idle-before-120s','snapshot-load-120s','idle-after-snapshot-120s','turnover-20','idle-after-turnover-120s'); purpose='有界资源类型与生命周期诊断；不替代两小时增长验收'; runtimeBudgetMs=$runtimeBudget; externalProviderCalls=0} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $scope 'plan.json') -Encoding utf8
$worker = [AIbrowse.LegacyResources.JobWorker]::new((Join-Path $repo 'node_modules/electron/dist/electron.exe'), (Join-Path $scope 'app'), $scope, $runId, $runtimeBudget)
$probes = @{}
$currentProbes = @{}
$watch = [Diagnostics.Stopwatch]::StartNew()
$nextSample = 0
$failure = $null
Write-Output "资源诊断已启动：$scope"
try {
  while ($worker.Thread.IsAlive) {
    $statePath = Join-Path $scope 'state.json'
    if (Test-Path -LiteralPath $statePath) {
      $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
      foreach ($memberPid in [AIbrowse.LegacyResources.ProcessProbe]::JobPids($runId)) {
        $pidKey = [string]$memberPid
        if (-not $currentProbes.ContainsKey($pidKey) -or $null -ne $currentProbes[$pidKey].probe.ExitFileTime()) {
          $role = @($state.pids | Where-Object pid -eq $memberPid | Select-Object -ExpandProperty role)
          $entry = [pscustomobject]@{ probe=[AIbrowse.LegacyResources.ProcessProbe]::new($memberPid); role=if ($role.Count -eq 1) { $role[0] } else { 'native-only' } }
          $key = $pidKey + ':' + $entry.probe.CreatedFileTime
          $probes[$key] = $entry
          $currentProbes[$pidKey] = $entry
        }
      }
      if ($watch.ElapsedMilliseconds -ge $nextSample) {
        $facts = @($probes.Values | ForEach-Object { $_.probe.Capture() })
        $sample = [pscustomobject]@{ elapsedMs=$watch.Elapsed.TotalMilliseconds; epochMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); state=$state; facts=$facts }
        [IO.File]::AppendAllText((Join-Path $scope 'samples.jsonl'), ($sample | ConvertTo-Json -Depth 9 -Compress) + "`n")
        $nextSample = $watch.ElapsedMilliseconds + 10000
      }
    }
    Start-Sleep -Milliseconds 250
  }
  $worker.Thread.Join()
  if ($worker.Error) { throw $worker.Error }
} catch {
  $failure = $_.Exception.GetType().Name + ': ' + $_.Exception.Message
  [IO.File]::WriteAllText((Join-Path $scope 'stop.request'), 'collector-failed')
  Write-Output "资源采集失败，等待既有 Job 监督器有界退出：$failure"
  while ($worker.Thread.IsAlive) { Start-Sleep -Milliseconds 500 }
} finally {
  $lifetimes = @($probes.Values | ForEach-Object { [pscustomobject]@{ pid=$_.probe.Pid; role=$_.role; createdFileTime=$_.probe.CreatedFileTime; exitFileTime=$_.probe.ExitFileTime() } })
  foreach ($entry in $probes.Values) { $entry.probe.Dispose() }
  $lifetimes | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $scope 'lifetimes.json') -Encoding utf8
  $worker.Result | ConvertTo-Json -Depth 12 | Set-Content (Join-Path $scope 'job.json') -Encoding utf8
  $unchanged = @($binding | ForEach-Object { (Get-FileHash -LiteralPath (Join-Path $repo $_.path) -Algorithm SHA256).Hash.ToLowerInvariant() -eq $_.sha256 }) -notcontains $false
  $events = @(Get-Content -LiteralPath (Join-Path $scope 'events.jsonl') -ErrorAction SilentlyContinue | ForEach-Object { $_ | ConvertFrom-Json })
  $eventFailure = @($events | Where-Object kind -In @('failure','fatal-observed','startup-error-dialog')).Count -gt 0
  $completed = @($events | Where-Object kind -eq $(if ($StartupOnly) { 'startup-complete' } else { 'work-complete' })).Count -eq 1
  [pscustomobject]@{ collectionFailure=$failure; eventFailure=$eventFailure; completed=$completed; bindingUnchanged=$unchanged; scope=$scope; durationMs=$watch.Elapsed.TotalMilliseconds; jobSucceeded=$worker.Result.Succeeded; jobZero=$worker.Result.ActualZero; exitCode=$worker.Result.ExitCode } | ConvertTo-Json | Set-Content (Join-Path $scope 'result.json') -Encoding utf8
}
Get-Content -LiteralPath (Join-Path $scope 'result.json')
if ($failure -or $eventFailure -or -not $completed -or -not $worker.Result.Succeeded -or -not $unchanged) { exit 1 }
