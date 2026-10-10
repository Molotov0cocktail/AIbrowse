[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($PSVersionTable.PSEdition -ne 'Core' -or -not [Environment]::Is64BitProcess -or $PSBoundParameters.Count -ne 0){throw '原生小检查入口无效'}
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$scope=Join-Path $repository ('log/stage7-e2/physical-capacity-native-small-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($scope)
$native=[IO.File]::ReadAllText((Join-Path $repository 'tools/data-qualification/full-transfer/FixedTransferJob.cs'))+[Environment]::NewLine+[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'allocation.cs'))
Add-Type -TypeDefinition $native
$path=Join-Path $scope 'ordinary.bin'
$file=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
try {
    $file.Write([byte[]]::new(65536));$file.Flush($true)
    $fact=[AIbrowse.FullTransfer.FixedTransferJob]::InspectFile($file)
    $allocated=[AIbrowse.PhysicalCapacity.Allocation]::Read($file)
    if($fact.Size -ne 65536 -or $fact.Links -ne 1 -or $allocated -lt 65536){throw '普通文件分配量检查失败'}
} finally {$file.Dispose()}
$link=Join-Path $scope 'hardlink.bin'
$null=New-Item -ItemType HardLink -Path $link -Target $path
$file=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
    $rejected=$false
    try{$null=[AIbrowse.PhysicalCapacity.Allocation]::Read($file)}catch{$rejected=$true}
    if(-not $rejected){throw '硬链接未拒绝'}
} finally {$file.Dispose()}
$tokens=$null;$parseErrors=$null
$null=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'run.ps1'),[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count -ne 0){throw '固定wrapper解析失败'}
@{passed=3;allocatedBytes=$allocated;retained=$true;productE2Pass=$false;actualCapacityRun=$false}|ConvertTo-Json
