param(
  [Parameter(Mandatory)][ValidateSet('dev', 'production')][string]$Variant,
  [Parameter(Mandatory)][ValidateSet('default', 'session', 'sources', 'sources-ui', 'research', 'watch')][string]$Kind,
  [Parameter(Mandatory)][string]$ArtifactRoot
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$evidenceRoot = [IO.Path]::GetFullPath($ArtifactRoot)
if (-not (Test-Path -LiteralPath $evidenceRoot -PathType Container)) { throw '产品冒烟证据目录不存在' }
$runId = [Guid]::NewGuid().ToString('N')
$runRoot = Join-Path ([IO.Path]::GetTempPath()) ('aibrowse-product-smoke-' + $runId)
$dataRoot = Join-Path $runRoot 'user-data'
$appData = Join-Path $runRoot 'appdata'
$localData = Join-Path $runRoot 'localappdata'
foreach ($directory in @($runRoot, $dataRoot, $appData, $localData)) {
  New-Item -ItemType Directory -Path $directory | Out-Null
}
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$viteCli = Join-Path $repoRoot 'node_modules/electron-vite/dist/cli.js'
$viteMode = if ($Variant -eq 'dev') { 'dev' } else { 'preview' }
$productionEntry = Join-Path $repoRoot 'out/main/index.js'
if ($Variant -eq 'production' -and -not (Test-Path -LiteralPath $productionEntry -PathType Leaf)) {
  throw '请先为当前候选完成普通production构建'
}
$flag = switch ($Kind) {
  'session' { 'AIBROWSE_SESSION_SMOKE' }
  'sources' { 'AIBROWSE_SOURCES_SMOKE' }
  'sources-ui' { 'AIBROWSE_SOURCES_UI_SMOKE' }
  'research' { 'AIBROWSE_RESEARCH_SMOKE' }
  'watch' { 'AIBROWSE_WATCH_SMOKE' }
  default { $null }
}
$modes = if ($Kind -eq 'default') { @('default') } else { @('set', 'check') }
foreach ($mode in $modes) {
  $prefix = Join-Path $evidenceRoot "product-$Variant-$Kind-$mode-$runId"
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $nodeExe
  $startInfo.WorkingDirectory = $repoRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  # The coordinator builds once after source review; set/check use that same build.
  $cliArguments = @($viteCli, $viteMode)
  if ($Variant -eq 'production') { $cliArguments += '--skipBuild' }
  $cliArguments += @('--', "--user-data-dir=$dataRoot")
  foreach ($argument in $cliArguments) {
    $startInfo.ArgumentList.Add($argument)
  }
  # Do not inherit Provider credentials, Node hooks or unrelated smoke switches.
  $startInfo.Environment.Clear()
  foreach ($key in @('SystemRoot', 'WINDIR', 'SystemDrive', 'PATH', 'COMSPEC', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS')) {
    $value = [Environment]::GetEnvironmentVariable($key)
    if ($null -ne $value) { $startInfo.Environment[$key] = $value }
  }
  $startInfo.Environment['APPDATA'] = $appData
  $startInfo.Environment['LOCALAPPDATA'] = $localData
  $startInfo.Environment['TEMP'] = $runRoot
  $startInfo.Environment['TMP'] = $runRoot
  $startInfo.Environment['AIBROWSE_SMOKE'] = '1'
  $startInfo.Environment['AIBROWSE_USER_DATA_DIR'] = $dataRoot
  if ($flag) { $startInfo.Environment[$flag] = $mode }
  $entryHash = if ($Variant -eq 'production') { (Get-FileHash -LiteralPath $productionEntry -Algorithm SHA256).Hash } else { $null }
  $stdout = [IO.File]::Open($prefix + '.stdout.txt', [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  $stderr = [IO.File]::Open($prefix + '.stderr.txt', [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  $started = $false
  $timedOut = $false
  try {
    $started = $process.Start()
    if (-not $started) { throw '产品冒烟未启动' }
    $birth = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
    $outCopy = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
    $errCopy = $process.StandardError.BaseStream.CopyToAsync($stderr)
    # Polling keeps an external 15-minute deadline without relying on app timers.
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while (-not $process.WaitForExit(1000)) {
      if ($deadline.Elapsed.TotalSeconds -ge 900) {
        $timedOut = $true
        $process.Kill($true)
        if (-not $process.WaitForExit(5000)) { throw '产品冒烟超时后收口未完成' }
        break
      }
    }
    if (-not [Threading.Tasks.Task]::WaitAll(@($outCopy, $errCopy), 5000)) { throw '产品冒烟输出管道未结束' }
    @{ variant=$Variant; kind=$Kind; mode=$mode; runId=$runId; pid=$process.Id; creationFileTime=$birth;
       elapsedSeconds=$deadline.Elapsed.TotalSeconds; exitCode=$process.ExitCode; timedOut=$timedOut;
       userData=$dataRoot; entrySha256=$entryHash; provider='离线FakeProvider；没有真实Provider授权注入' } |
      ConvertTo-Json | Set-Content -LiteralPath ($prefix + '.json') -Encoding utf8
    Write-Output "产品冒烟 $Variant/$Kind/$mode exit=$($process.ExitCode)"
    if ($timedOut -or $process.ExitCode -ne 0) { throw '产品冒烟失败，停止后继并保留根及原件' }
  } finally {
    if ($started -and -not $process.HasExited) { $process.Kill($true); $null = $process.WaitForExit(5000) }
    $stdout.Dispose()
    $stderr.Dispose()
    $process.Dispose()
  }
}
# No deletion: failed roots, shared set/check databases and logs remain reviewable.
Write-Output '产品冒烟进程已结束；须核对原始断言与正常退出，不以wrapper exit0代替产品结论。'
