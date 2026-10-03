[CmdletBinding()]
param([Parameter(Mandatory)][string]$Journal)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$journalPath = [IO.Path]::GetFullPath($Journal)
if (-not $journalPath.StartsWith((Join-Path $repository 'log\stage7-e1\disposable-profile\journal-'), [StringComparison]::OrdinalIgnoreCase)) {
    throw '只允许读取固定disposable-profile journal。'
}
Add-Type -Path `
    (Join-Path $PSScriptRoot 'DisposableProfile.cs'), `
    (Join-Path $PSScriptRoot 'ProfileIsolation.cs'), `
    (Join-Path $PSScriptRoot 'JobProcess.cs'), `
    (Join-Path $PSScriptRoot 'FailedAtomicMetadata.cs')
$native = [AIbrowse.ReleaseProfile.FailedAtomicMetadata]::Inspect($journalPath) | ConvertFrom-Json
$nodeOutput = & (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source `
    (Join-Path $PSScriptRoot 'failed-atomic-node-metadata.mjs') `
    $native.root.alias.Requested $native.root.resolved.Requested
if ($LASTEXITCODE -ne 0) { throw 'Node realpath元数据探针失败。' }
$node = $nodeOutput | ConvertFrom-Json
$output = Join-Path $journalPath 'failed-atomic-metadata-001.json'
$payload = @{ version = 1; native = $native; node = $node } | ConvertTo-Json -Depth 12
$stream = [IO.File]::Open($output, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$writer = $null
try {
    $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
    $writer.Write($payload)
    $writer.Flush()
} finally {
    if ($null -ne $writer) { $writer.Dispose() } else { $stream.Dispose() }
}
Write-Output $output
