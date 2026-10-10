[CmdletBinding()]
param([Parameter(Mandatory)][string]$Evidence)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$Evidence=[IO.Path]::GetFullPath($Evidence)
if(Test-Path -LiteralPath $Evidence){throw '拒绝覆盖已有原件'}
[void][IO.Directory]::CreateDirectory($Evidence)
$sources=@(
    (Join-Path $PSScriptRoot '../product-transfer/NativeSaveControl.cs'),
    (Join-Path $PSScriptRoot '../product-transfer/NativeSaveButton.cs'),
    (Join-Path $PSScriptRoot '../native-file-selection/NativeSelectionEdit.cs'),
    (Join-Path $PSScriptRoot 'NativeProductFileSelection.cs'),
    (Join-Path $PSScriptRoot 'FileSelectionPureTests.cs')
)
Add-Type -Path $sources
$checks=@([ProductFileSelectionPureTests]::Run())
$report=@{version=1;passed=$checks.Count;checks=$checks;actualUi=$false;actualCom=$false;actualJob=$false;sources=@($sources|ForEach-Object{@{name=[IO.Path]::GetFileName($_);sha256=(Get-FileHash -LiteralPath $_).Hash.ToLowerInvariant()}})}
$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($report|ConvertTo-Json -Depth 5))
$stream=[IO.File]::Open((Join-Path $Evidence 'result.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
Write-Output ($report|ConvertTo-Json -Depth 5 -Compress)
