param(
  [Parameter(Mandatory = $true)][string]$ResultDirectory,
  [string]$SourceProfile = (Join-Path $env:APPDATA 'aibrowse'),
  [ValidateSet('full', 'digest-only', 'digest-schema', 'digest-pair')][string]$Mode = 'full'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\maintenance\enter-project-environment.ps1')
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$resultRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot $ResultDirectory))
$evidenceRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'log\legacy-diagnosis-20261012\models'))
if (-not $resultRoot.StartsWith($evidenceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw '诊断结果必须位于本轮模型证据目录内'
}
if (Test-Path -LiteralPath (Join-Path $resultRoot 'result.json')) {
  throw '拒绝覆盖已存在的诊断账本'
}
Push-Location $projectRoot
$priorRunAsNode = $env:ELECTRON_RUN_AS_NODE
try {
  & node (Join-Path $PSScriptRoot 'models-build.mjs') $resultRoot
  if ($LASTEXITCODE -ne 0) { throw '诊断构建失败' }
  $env:AIBROWSE_DIAGNOSTIC_SOURCE_PROFILE = [IO.Path]::GetFullPath($SourceProfile)
  $env:AIBROWSE_DIAGNOSTIC_RESULT_ROOT = $resultRoot
  $env:AIBROWSE_DIAGNOSTIC_MODE = $Mode
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $entry = Join-Path $resultRoot 'entry.cjs'
  $startedUtc = [DateTime]::UtcNow.ToString('o')
  $diagnosticProcess = Start-Process -FilePath (Join-Path $projectRoot 'node_modules\electron\dist\electron.exe') -ArgumentList ('"' + $entry + '"') -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $resultRoot 'stdout.txt') -RedirectStandardError (Join-Path $resultRoot 'stderr.txt')
  [ordered]@{ startedUtc = $startedUtc; finishedUtc = [DateTime]::UtcNow.ToString('o'); exitCode = $diagnosticProcess.ExitCode; pid = $diagnosticProcess.Id } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $resultRoot 'process-result.json')
  if ($diagnosticProcess.ExitCode -ne 0) { throw '真实诊断进程未正常结束；保留原件' }
  Write-Output '模型诊断已结束；结果仅记录计数和分类。'
} finally {
  Remove-Item Env:AIBROWSE_DIAGNOSTIC_SOURCE_PROFILE -ErrorAction SilentlyContinue
  Remove-Item Env:AIBROWSE_DIAGNOSTIC_RESULT_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:AIBROWSE_DIAGNOSTIC_MODE -ErrorAction SilentlyContinue
  if ($null -ne $priorRunAsNode) { $env:ELECTRON_RUN_AS_NODE = $priorRunAsNode }
  Pop-Location
}
