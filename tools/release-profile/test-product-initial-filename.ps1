[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$sourcePath = Join-Path $PSScriptRoot 'test-product-completed-archive.ps1'
$source = [IO.File]::ReadAllText($sourcePath)
$scriptRootLiteral = "'" + $PSScriptRoot.Replace("'", "''") + "'"
$boundSource = $source.Replace('$PSScriptRoot', $scriptRootLiteral)
$needle = "filenameInitialValueClass = 'exact-default'"
if ([regex]::Matches($boundSource, [regex]::Escape($needle)).Count -ne 1) {
    throw '固定作者夹具的初值分类位置变化'
}

function Invoke-ClassificationFixture([string]$Classification, [bool]$Expected) {
    $variant = $boundSource.Replace($needle, "filenameInitialValueClass = '$Classification'")
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ('aibrowse-initial-archive-' + [Guid]::NewGuid().ToString('N') + '.ps1')
    [IO.File]::WriteAllText($temporary, $variant, [Text.UTF8Encoding]::new($false))
    try {
        & pwsh.exe -NoProfile -NonInteractive -File $temporary *> $null
        $accepted = $LASTEXITCODE -eq 0
    } finally {
        [IO.File]::Delete($temporary)
    }
    if ($accepted -ne $Expected) {
        throw "ProductCompleted初值分类结果不符：$Classification"
    }
}

Invoke-ClassificationFixture 'exact-stem' $true
foreach ($classification in @('', 'empty', 'other', 'Exact-default', 'exact-default ', 'exact-stem ', 'path', 'different-extension')) {
    Invoke-ClassificationFixture $classification $false
}

Write-Output 'ProductCompleted初值分类：exact-stem通过，八项闭合反例拒绝'
