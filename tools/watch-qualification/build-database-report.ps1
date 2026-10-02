$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$outputRoot = Join-Path $repoRoot 'log/watch-qualification-build'
$entry = Join-Path $PSScriptRoot 'database-report.ts'
$output = Join-Path $outputRoot 'database-report.mjs'
$esbuild = Join-Path $repoRoot 'node_modules/.bin/esbuild.cmd'

if (-not (Test-Path -LiteralPath $esbuild -PathType Leaf)) {
  throw '缺少仓库锁定依赖中的 esbuild'
}
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
& $esbuild $entry '--bundle' '--platform=node' '--format=esm' '--target=node24' '--sourcemap=external' "--outfile=$output"
if ($LASTEXITCODE -ne 0) { throw '数据库报告器构建失败' }
Write-Output $output
