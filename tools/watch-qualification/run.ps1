param(
  [Parameter(Mandatory)][string]$WorkParent,
  [Parameter(Mandatory)][string]$ArtifactRoot,
  [ValidateSet('short', 'formal')][string]$Mode = 'short',
  [Parameter(Mandatory)][switch]$EnvironmentApproved,
  [string]$Collector
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $EnvironmentApproved) { throw '运行前必须完成本轮安全环境及关键改动审核' }
if (-not $Collector) { $Collector = Join-Path $repoRoot 'log/watch-qualification-build/collector.exe' }
$parentRoot = [IO.Path]::GetFullPath($WorkParent)
$outputRoot = [IO.Path]::GetFullPath($ArtifactRoot)
if (-not (Test-Path -LiteralPath $parentRoot -PathType Container)) { throw '工作父目录不存在' }
if (-not (Test-Path -LiteralPath $outputRoot -PathType Container)) { throw '原始证据目录不存在' }
& node '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON' (Join-Path $PSScriptRoot 'safety-preflight.ts') $parentRoot $outputRoot
if ($LASTEXITCODE -ne 0) { throw '启动前安全预检未通过' }
$launchId = [Guid]::NewGuid().ToString('N')
$stdoutPath = Join-Path $outputRoot "launcher-$launchId.stdout.txt"
$stderrPath = Join-Path $outputRoot "launcher-$launchId.stderr.txt"
$receiptPath = Join-Path $outputRoot "launcher-$launchId.json"
$arguments = @('--launch', $repoRoot, $parentRoot, $outputRoot, $Mode, '--environment-approved')
$quoted = foreach ($argument in $arguments) {
  if ($argument.Contains('"') -or $argument.EndsWith('\')) { throw '启动参数无效' }
  '"' + $argument + '"'
}
$limitSeconds = if ($Mode -eq 'formal') { 6600 } else { 600 }
$process = Start-Process -FilePath $Collector -ArgumentList $quoted -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
$timedOut = $false
try {
  $null = $process.Handle
  $birth = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
  if (-not $process.WaitForExit($limitSeconds * 1000)) {
    $timedOut = $true
    $process.Kill()
    if (-not $process.WaitForExit(5000)) { throw '采集器超时终止尚未完成，保留全部原件' }
  }
  $exitCode = $process.ExitCode
  @{ version = 1; pid = $process.Id; creationFileTime = $birth; limitSeconds = $limitSeconds; timedOut = $timedOut; exitCode = $exitCode } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $receiptPath -Encoding utf8
  Get-Content -LiteralPath $stdoutPath
  Get-Content -LiteralPath $stderrPath
  if ($timedOut -or $exitCode -ne 0) { throw '采集未通过；保留本轮全部目录和原始证据' }
} finally {
  if (-not $process.HasExited) {
    $process.Kill()
    $null = $process.WaitForExit(5000)
  }
  $process.Dispose()
}
