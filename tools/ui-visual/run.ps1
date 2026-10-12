param(
  [string]$RunRoot = '',
  [switch]$Build
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $repositoryRoot 'tools/maintenance/enter-project-environment.ps1')

if ($Build) {
  Push-Location $repositoryRoot
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw '产品构建失败' }
  } finally {
    Pop-Location
  }
}

if ([string]::IsNullOrWhiteSpace($RunRoot)) {
  $timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
  $RunRoot = Join-Path $repositoryRoot ('log/browser-settings-20261012/' + $timestamp + '-' + [guid]::NewGuid().ToString('N'))
}

$resolvedRunRoot = [IO.Path]::GetFullPath($RunRoot)
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'log/browser-settings-20261012'))
if (-not $resolvedRunRoot.StartsWith($allowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw '运行目录必须是 log/browser-settings-20261012 下的唯一子目录'
}
if (Test-Path -LiteralPath $resolvedRunRoot) {
  throw '运行目录已存在，拒绝覆盖既有原件'
}

$electron = Join-Path $repositoryRoot 'node_modules/electron/dist/electron.exe'
$harness = Join-Path $repositoryRoot 'tools/ui-visual'
if (-not (Test-Path -LiteralPath $electron -PathType Leaf)) { throw '工程 Electron 不可用，请先安装锁定依赖' }
$runParent = Split-Path -Parent $resolvedRunRoot
$runName = Split-Path -Leaf $resolvedRunRoot
$launchStdout = Join-Path $runParent ($runName + '-launch.stdout.log')
$launchStderr = Join-Path $runParent ($runName + '-launch.stderr.log')
foreach ($launchLog in @($launchStdout, $launchStderr)) {
  if (Test-Path -LiteralPath $launchLog) { throw '启动日志已存在，拒绝覆盖既有原件' }
}

$isolatedEnvironmentKeys = @(
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_RENDERER_URL',
  'AIBROWSE_SMOKE',
  'AIBROWSE_SESSION_SMOKE',
  'AIBROWSE_SOURCES_SMOKE',
  'AIBROWSE_SOURCES_UI_SMOKE',
  'AIBROWSE_WATCH_SMOKE',
  'AIBROWSE_RESEARCH_SMOKE',
  'AIBROWSE_LIVE_PROVIDER',
  'AIBROWSE_LIVE_WATCH',
  'AIBROWSE_LIVE_SITES',
  'AIBROWSE_LIVE_AGENT',
  'AIBROWSE_LIVE_AGENT_PRE',
  'AIBROWSE_LIVE_AGENT_SUPPLEMENT',
  'AIBROWSE_LIVE_AGENT_SOURCES',
  'AIBROWSE_LIVE_RESEARCH',
  'AIBROWSE_WATCH_H3A',
  'AIBROWSE_WATCH_H3A_DIAGNOSTIC',
  'AIBROWSE_USER_DATA_DIR',
  'AIBROWSE_UI_VISUAL_RUN_ROOT'
)
$savedEnvironment = @{}
foreach ($key in $isolatedEnvironmentKeys) {
  $value = [Environment]::GetEnvironmentVariable($key, 'Process')
  $savedEnvironment[$key] = $value
  Remove-Item -LiteralPath ('Env:' + $key) -ErrorAction SilentlyContinue
}
[Environment]::SetEnvironmentVariable('AIBROWSE_UI_VISUAL_RUN_ROOT', $resolvedRunRoot, 'Process')
$exitCode = 1
$launchFailure = $null
try {
  try {
    $electronProcess = Start-Process -FilePath $electron -ArgumentList @($harness) -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput $launchStdout -RedirectStandardError $launchStderr
    if (-not $electronProcess.WaitForExit(180000)) {
      $launchFailure = '启动后 180 秒未退出'
      Stop-Process -Id $electronProcess.Id -Force
      $electronProcess.WaitForExit()
    } else {
      $exitCode = $electronProcess.ExitCode
    }
  } catch {
    $launchFailure = $_.Exception.Message
  }
} finally {
  foreach ($key in $isolatedEnvironmentKeys) {
    if ($null -eq $savedEnvironment[$key]) {
      Remove-Item -LiteralPath ('Env:' + $key) -ErrorAction SilentlyContinue
    } else {
      [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process')
    }
  }
}

Write-Output ('UI_VISUAL_RUN_ROOT=' + $resolvedRunRoot)
Write-Output ('UI_VISUAL_LAUNCH_STDOUT=' + $launchStdout)
Write-Output ('UI_VISUAL_LAUNCH_STDERR=' + $launchStderr)
if ($null -ne $launchFailure) {
  throw ('UI 可视验收启动失败：' + $launchFailure)
}
$resultPath = Join-Path $resolvedRunRoot 'result.json'
if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
  $resultStatus = (Get-Content -Raw -LiteralPath $resultPath | ConvertFrom-Json).status
  if ($resultStatus -ne 'passed') { $exitCode = 1 }
} else {
  $exitCode = 1
}
if ($exitCode -ne 0) { throw ('UI 可视验收失败，Electron exit=' + $exitCode) }
