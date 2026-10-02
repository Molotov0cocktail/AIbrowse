param([Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$buildRoot = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vsRoot = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsRoot) { throw '缺少 x64 MSVC 构建工具' }
$msvcRoot = Get-ChildItem (Join-Path $vsRoot 'VC/Tools/MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$savedInclude = $env:INCLUDE
$savedLib = $env:LIB
try {
  $env:INCLUDE = @((Join-Path $msvcRoot 'include'), (Join-Path $sdkRoot 'Include/10.0.26100.0/ucrt'), (Join-Path $sdkRoot 'Include/10.0.26100.0/shared'), (Join-Path $sdkRoot 'Include/10.0.26100.0/um')) -join ';'
  $env:LIB = @((Join-Path $msvcRoot 'lib/x64'), (Join-Path $sdkRoot 'Lib/10.0.26100.0/ucrt/x64'), (Join-Path $sdkRoot 'Lib/10.0.26100.0/um/x64')) -join ';'
  $compiler = Join-Path $msvcRoot 'bin/Hostx64/x64/cl.exe'
  & $compiler '/nologo' '/std:c++20' '/EHsc' '/W4' '/WX' '/MT' '/O2' '/utf-8' '/DUNICODE' '/D_UNICODE' "/I$PSScriptRoot/native" "/I$repoRoot/native/watch-qualification" (Join-Path $PSScriptRoot 'native/review-extensions-tests.cc') "/Fo$buildRoot/review-extensions-tests.obj" '/link' "/OUT:$buildRoot/review-extensions-tests.exe" 'advapi32.lib' 'bcrypt.lib' 'shell32.lib' 'normaliz.lib' 'psapi.lib' 'setupapi.lib' 'uuid.lib' '/DYNAMICBASE' '/NXCOMPAT'
  if ($LASTEXITCODE -ne 0) { throw '独立扩展反例构建失败' }
} finally {
  $env:INCLUDE = $savedInclude
  $env:LIB = $savedLib
}
