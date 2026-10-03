param(
  [Parameter(Mandatory = $true)]
  [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $workspace 'log\stage7-e1'))
$resolvedOutput = [System.IO.Path]::GetFullPath((Join-Path $workspace $OutputRoot))
$separator = [System.IO.Path]::DirectorySeparatorChar
if (-not $resolvedOutput.StartsWith($allowedRoot + $separator, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw '输出目录必须位于 log/stage7-e1 下'
}
if (Test-Path -LiteralPath $resolvedOutput) {
  throw '输出目录已存在；资格运行不覆盖旧原件'
}

New-Item -ItemType Directory -Path $resolvedOutput | Out-Null
foreach ($name in @('process-temp', 'appdata', 'localappdata', 'profile')) {
  New-Item -ItemType Directory -Path (Join-Path $resolvedOutput $name) | Out-Null
}

$bundle = Join-Path $resolvedOutput 'electron-security-qualification.cjs'
$esbuild = Join-Path $workspace 'node_modules\.bin\esbuild.cmd'
$entry = Join-Path $workspace 'tools\security\electron-security-qualification.ts'
& $esbuild $entry '--bundle' '--platform=node' '--format=cjs' '--external:electron' "--outfile=$bundle" *> (Join-Path $resolvedOutput 'build.txt')
if ($LASTEXITCODE -ne 0) {
  throw '资格 harness 编译失败'
}

$electron = Join-Path $workspace 'node_modules\electron\dist\electron.exe'
$env:ELECTRON_RUN_AS_NODE = $null
$env:TEMP = Join-Path $resolvedOutput 'process-temp'
$env:TMP = $env:TEMP
$env:APPDATA = Join-Path $resolvedOutput 'appdata'
$env:LOCALAPPDATA = Join-Path $resolvedOutput 'localappdata'

$stdout = Join-Path $resolvedOutput 'stdout.txt'
$stderr = Join-Path $resolvedOutput 'stderr.txt'
$arguments = @(
  ('"' + $bundle + '"'),
  ('"--qualification-root=' + $resolvedOutput + '"'),
  ('"--user-data-dir=' + (Join-Path $resolvedOutput 'profile') + '"')
)
$process = Start-Process -FilePath $electron -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
if (-not $process.WaitForExit(120000)) {
  Stop-Process -Id $process.Id -Force
  throw '资格 harness 超过 120 秒外层预算'
}
if ($process.ExitCode -ne 0) {
  throw "资格 harness 失败，退出码 $($process.ExitCode)"
}

$report = Get-Content -Raw -LiteralPath (Join-Path $resolvedOutput 'report.json') | ConvertFrom-Json
if ($report.status -ne 'PASS') {
  throw '资格报告未通过'
}
$report | ConvertTo-Json -Depth 8
