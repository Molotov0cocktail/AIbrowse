param(
  [switch]$Tests,
  [ValidateSet('qualification', 'qualification-diagnostic', 'qualification-load-diagnostic')]
  [string]$Mode = 'qualification'
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$artifactRoot = Join-Path $repoRoot 'log/h3b-native-current'
$dependencyRoot = Join-Path $artifactRoot 'deps'
$buildRoot = Join-Path $artifactRoot 'build'
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
& node (Join-Path $PSScriptRoot 'fetch-deps.mjs')
if ($LASTEXITCODE -ne 0) { throw '资格原生依赖准备失败' }
if (-not (Test-Path (Join-Path $dependencyRoot 'node_headers/include/node/node_api.h'))) {
  & tar -xzf (Join-Path $dependencyRoot 'node-v43.4.0-headers.tar.gz') -C $dependencyRoot
  if ($LASTEXITCODE -ne 0) { throw '资格原生头文件解包失败' }
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vsRoot = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsRoot) { throw '缺少 x64 MSVC 构建工具' }
$msvcRoot = Get-ChildItem (Join-Path $vsRoot 'VC/Tools/MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$sdkVersion = '10.0.26100.0'
$sdkInclude = Join-Path $sdkRoot "Include/$sdkVersion"
$sdkLib = Join-Path $sdkRoot "Lib/$sdkVersion"
$env:INCLUDE = @((Join-Path $msvcRoot 'include'), (Join-Path $sdkInclude 'ucrt'), (Join-Path $sdkInclude 'shared'), (Join-Path $sdkInclude 'um'), (Join-Path $sdkInclude 'winrt')) -join ';'
$env:LIB = @((Join-Path $msvcRoot 'lib/x64'), (Join-Path $sdkLib 'ucrt/x64'), (Join-Path $sdkLib 'um/x64')) -join ';'
$compiler = Join-Path $msvcRoot 'bin/Hostx64/x64/cl.exe'
$headers = Get-ChildItem $dependencyRoot -Filter node_api.h -Recurse | Select-Object -First 1 -ExpandProperty DirectoryName
if (-not $headers) { throw 'Electron 头文件缺失' }
$nativeOut = Join-Path $repoRoot "out/$Mode/main"
New-Item -ItemType Directory -Force -Path $nativeOut | Out-Null
$argsCommon = @('/nologo', '/std:c++20', '/EHsc', '/W4', '/WX', '/MT', '/O2', '/utf-8', '/DUNICODE', '/D_UNICODE', '/DNAPI_VERSION=8', "/I$headers", "/I$PSScriptRoot")
& $compiler @argsCommon '/LD' (Join-Path $PSScriptRoot 'bridge.cc') "/Fo$buildRoot/bridge.obj" '/link' "/OUT:$nativeOut/watch-qualification.node" "/IMPLIB:$buildRoot/watch-qualification.lib" (Join-Path $dependencyRoot 'win-x64-node.lib') 'delayimp.lib' 'advapi32.lib' 'bcrypt.lib' 'shell32.lib' 'normaliz.lib' '/DELAYLOAD:node.exe' '/DYNAMICBASE' '/NXCOMPAT'
if ($LASTEXITCODE -ne 0) { throw '资格原生桥编译失败' }
Write-Output '资格原生桥构建完成'
if ($Tests) {
  & $compiler @argsCommon (Join-Path $PSScriptRoot 'tests.cc') "/Fo$buildRoot/tests.obj" '/link' "/OUT:$buildRoot/tests.exe" 'advapi32.lib' 'bcrypt.lib' 'shell32.lib' 'normaliz.lib' '/DYNAMICBASE' '/NXCOMPAT'
  if ($LASTEXITCODE -ne 0) { throw '资格原生测试编译失败' }
  & (Join-Path $buildRoot 'tests.exe')
  if ($LASTEXITCODE -ne 0) { throw '资格原生聚焦验证失败' }
  & $compiler @argsCommon (Join-Path $PSScriptRoot 'write-io-tests.cc') "/Fo$buildRoot/write-io-tests.obj" '/link' "/OUT:$buildRoot/write-io-tests.exe" 'advapi32.lib' 'bcrypt.lib' 'shell32.lib' 'normaliz.lib' '/DYNAMICBASE' '/NXCOMPAT'
  if ($LASTEXITCODE -ne 0) { throw '资格原生写入测试编译失败' }
  & (Join-Path $buildRoot 'write-io-tests.exe')
  if ($LASTEXITCODE -ne 0) { throw '资格原生写入生命周期验证失败' }
}
