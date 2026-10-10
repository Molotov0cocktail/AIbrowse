[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$evidence=Join-Path $repository 'log/stage7-e2/physical-full-transfer-independent-repair-001'
$scope=Join-Path $repository 'log/stage7-e2/physical-full-transfer-d4c9d36de2b34b02b16c6dca36126d12'
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
    allocationEvidenceReused='../physical-full-transfer-independent-review-001/binding-and-allocation.json'
    jobInvoked=$false
    largeDataRead=$false
    actualModel='不可验证'
}
$json=$result|ConvertTo-Json -Depth 6
[IO.File]::WriteAllText((Join-Path $evidence 'binding-002.json'),$json,[Text.UTF8Encoding]::new($false))
$json
if($mismatches.Count -gt 0 -or $missingClosure.Count -gt 0){exit 1}
