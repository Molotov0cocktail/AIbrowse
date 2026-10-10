[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$evidence=Join-Path $repository 'log/stage7-e2/physical-full-transfer-independent-review-001'
$scope=Join-Path $repository 'log/stage7-e2/physical-full-transfer-51616c6a6882462e97e1f7c82834e224'
$proofPath=Join-Path $scope 'build-proof.json'
$proof=[IO.File]::ReadAllText($proofPath)|ConvertFrom-Json
$mismatches=[Collections.Generic.List[string]]::new()
foreach($item in $proof.sources.PSObject.Properties){
    if((Get-FileHash -LiteralPath (Join-Path $repository $item.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $item.Value){$mismatches.Add($item.Name)}
}
foreach($item in $proof.artifacts.PSObject.Properties){
    $path=Join-Path $scope $item.Name
    if((Get-Item -LiteralPath $path).Length -ne $item.Value.bytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $item.Value.sha256){$mismatches.Add($item.Name)}
}
$missingClosure=@($proof.bundleInputs|ForEach-Object {$_}|Sort-Object -Unique|Where-Object {$null -eq $proof.sources.PSObject.Properties[$_]})
$candidateHashes=[ordered]@{}
foreach($file in Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'physical-full-transfer') -File){$candidateHashes[$file.Name]=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}

# Only compile the allocation query; the process supervisor and product are never loaded.
Add-Type -Path (Join-Path $PSScriptRoot 'physical-full-transfer/allocation.cs')
$sampleRoot=Join-Path $evidence ('allocation-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($sampleRoot)|Out-Null
$sample=Join-Path $sampleRoot 'ordinary.bin'
[IO.File]::WriteAllBytes($sample,[byte[]]::new(8193))
$handle=[IO.File]::OpenRead($sample)
try {$allocated=[AIbrowse.PhysicalFullTransfer.Allocation]::Read($handle)}finally{$handle.Dispose()}
$link=Join-Path $sampleRoot 'hardlink.bin'
New-Item -ItemType HardLink -Path $link -Value $sample|Out-Null
$linkRejected=$false
$handle=[IO.File]::OpenRead($sample)
try {[void][AIbrowse.PhysicalFullTransfer.Allocation]::Read($handle)}catch{$linkRejected=$true}finally{$handle.Dispose()}
$sparse=Join-Path $sampleRoot 'sparse.bin'
[IO.File]::WriteAllBytes($sparse,[byte[]]::new(8193))
$sparseOutput=& fsutil.exe sparse setflag $sparse 2>&1
if($LASTEXITCODE -ne 0){throw '独立小文件稀疏标志设置失败'}
[IO.File]::WriteAllText((Join-Path $evidence 'sparse-command.txt'),($sparseOutput|Out-String))
$sparseRejected=$false
$handle=[IO.File]::OpenRead($sparse)
try {[void][AIbrowse.PhysicalFullTransfer.Allocation]::Read($handle)}catch{$sparseRejected=$true}finally{$handle.Dispose()}
$result=[ordered]@{
    version=1
    baseline=(& git -C $repository rev-parse HEAD)
    scopeId=$proof.scopeId
    buildProofSha256=(Get-FileHash -LiteralPath $proofPath -Algorithm SHA256).Hash.ToLowerInvariant()
    sourceCount=@($proof.sources.PSObject.Properties).Count
    artifactCount=@($proof.artifacts.PSObject.Properties).Count
    bundleCount=$proof.bundleInputs.Count
    mappingCount=$proof.mappings.Count
    mismatches=$mismatches.ToArray()
    missingClosure=$missingClosure
    candidateHashes=$candidateHashes
    allocation=@{ordinaryBytes=8193;ordinaryAllocated=$allocated;hardlinkRejected=$linkRejected;sparseRejected=$sparseRejected}
    jobInvoked=$false
    largeDataRead=$false
    actualModel='不可验证'
}
$json=$result|ConvertTo-Json -Depth 6
[IO.File]::WriteAllText((Join-Path $evidence 'binding-and-allocation.json'),$json,[Text.UTF8Encoding]::new($false))
$json
if($mismatches.Count -gt 0 -or $missingClosure.Count -gt 0 -or $allocated -lt 8193 -or -not $linkRejected -or -not $sparseRejected){exit 1}
