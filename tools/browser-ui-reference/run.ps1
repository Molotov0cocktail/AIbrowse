$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $repositoryRoot 'tools/maintenance/enter-project-environment.ps1')
$previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
try {
  $process = Start-Process -FilePath (Join-Path $repositoryRoot 'node_modules/electron/dist/electron.exe') -ArgumentList @($PSScriptRoot) -WindowStyle Hidden -PassThru -Wait
  $runExitCode = $process.ExitCode
  Write-Output ('参考图查看器退出码：' + $process.ExitCode)
} finally {
  $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode
}
if ($runExitCode -ne 0) { throw ('参考图查看器失败，退出码：' + $runExitCode) }
