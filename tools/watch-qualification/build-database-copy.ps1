param([switch]$Tests, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'log/watch-qualification-copy-build' }
$buildRoot = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vsRoot = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsRoot) { throw '缺少 x64 MSVC 构建工具' }
$msvcRoot = Get-ChildItem (Join-Path $vsRoot 'VC/Tools/MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$sdkVersion = '10.0.26100.0'
$sdkInclude = Join-Path $sdkRoot "Include/$sdkVersion"
$sdkLib = Join-Path $sdkRoot "Lib/$sdkVersion"
$savedInclude = $env:INCLUDE
$savedLib = $env:LIB
try {
  $env:INCLUDE = @((Join-Path $msvcRoot 'include'), (Join-Path $sdkInclude 'ucrt'), (Join-Path $sdkInclude 'shared'), (Join-Path $sdkInclude 'um')) -join ';'
  $env:LIB = @((Join-Path $msvcRoot 'lib/x64'), (Join-Path $sdkLib 'ucrt/x64'), (Join-Path $sdkLib 'um/x64')) -join ';'
  $compiler = Join-Path $msvcRoot 'bin/Hostx64/x64/cl.exe'
  $native = Join-Path $PSScriptRoot 'native'
  $argsCommon = @('/nologo', '/std:c++20', '/EHsc', '/W4', '/WX', '/MT', '/O2', '/utf-8', '/DUNICODE', '/D_UNICODE', "/I$native", "/I$repoRoot/native/watch-qualification")
  $targets = @('database-copy')
  if ($Tests) { $targets += 'database-copy-tests' }
  foreach ($target in $targets) {
    & $compiler @argsCommon (Join-Path $native "$target.cc") "/Fo$buildRoot/$target.obj" '/link' "/OUT:$buildRoot/$target.exe" 'advapi32.lib' 'bcrypt.lib' 'shell32.lib' 'normaliz.lib' 'psapi.lib' 'ntdll.lib' '/DYNAMICBASE' '/NXCOMPAT'
    if ($LASTEXITCODE -ne 0) { throw "关闭后副本工具构建失败：$target" }
  }
  if ($Tests) {
    & (Join-Path $buildRoot 'database-copy-tests.exe')
    if ($LASTEXITCODE -ne 0) { throw '关闭后副本工具反例失败' }
  }
  Write-Output '关闭后数据库副本工具构建完成'
} finally {
  $env:INCLUDE = $savedInclude
  $env:LIB = $savedLib
}
