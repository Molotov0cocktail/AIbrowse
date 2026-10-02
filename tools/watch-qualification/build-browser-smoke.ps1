param()
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$buildRoot = Join-Path $repoRoot 'log/watch-qualification-build'
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
$esbuild = Join-Path $repoRoot 'node_modules/.bin/esbuild.cmd'
& $esbuild (Join-Path $PSScriptRoot 'browser-smoke.ts') '--bundle' '--platform=node' '--format=cjs' '--target=node24' '--external:electron' '--sourcemap=external' "--outfile=$buildRoot/browser-smoke.cjs"
if ($LASTEXITCODE -ne 0) { throw '浏览器产品冒烟构建失败' }
& (Join-Path $PSScriptRoot 'build.ps1') -Target blank-feasibility -OutputDirectory $buildRoot
if ($LASTEXITCODE -ne 0) { throw '浏览器产品冒烟启动器构建失败' }
