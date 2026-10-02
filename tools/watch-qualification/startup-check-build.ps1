param([Parameter(Mandatory)][string]$OutputDirectory, [Parameter(Mandatory)][switch]$WindowEnded)
$ErrorActionPreference = 'Stop'
if (-not $WindowEnded) { throw '正式窗口及drain结束后才能构建启动专项' }
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$buildRoot = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vsRoot = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsRoot) { throw '缺少 x64 MSVC 构建工具' }
$msvcRoot = Get-ChildItem (Join-Path $vsRoot 'VC/Tools/MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$sdkInclude = Join-Path $sdkRoot 'Include/10.0.26100.0'
$sdkLib = Join-Path $sdkRoot 'Lib/10.0.26100.0'
$savedInclude = $env:INCLUDE
$savedLib = $env:LIB
try {
  $env:INCLUDE = @((Join-Path $msvcRoot 'include'), (Join-Path $sdkInclude 'ucrt'), (Join-Path $sdkInclude 'shared'), (Join-Path $sdkInclude 'um')) -join ';'
  $env:LIB = @((Join-Path $msvcRoot 'lib/x64'), (Join-Path $sdkLib 'ucrt/x64'), (Join-Path $sdkLib 'um/x64')) -join ';'
  $compiler = Join-Path $msvcRoot 'bin/Hostx64/x64/cl.exe'
  $native = Join-Path $PSScriptRoot 'native'
  $argsCommon = @('/nologo', '/std:c++20', '/EHsc', '/W4', '/WX', '/MT', '/O2', '/utf-8', '/DUNICODE', '/D_UNICODE', "/I$native", "/I$repoRoot/native/watch-qualification")
  & $compiler @argsCommon (Join-Path $native 'startup-check.cc') "/Fo$buildRoot/startup-check.obj" '/link' "/OUT:$buildRoot/startup-check.exe" 'advapi32.lib' 'bcrypt.lib' 'shell32.lib' 'normaliz.lib' 'psapi.lib' '/DYNAMICBASE' '/NXCOMPAT'
  if ($LASTEXITCODE -ne 0) { throw '启动专项原生工具构建失败' }
  Write-Output '启动专项原生工具构建完成'
} finally {
  $env:INCLUDE = $savedInclude
  $env:LIB = $savedLib
}
