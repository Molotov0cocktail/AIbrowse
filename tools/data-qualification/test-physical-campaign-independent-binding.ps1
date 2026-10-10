[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$evidence=Join-Path $repository 'log/stage7-e2/physical-campaign-independent-review-001'
[IO.Directory]::CreateDirectory($evidence)|Out-Null
$ScopeId='physical-full-transfer-9763bfffd4da408d9d7533992006d92c'
$scope=Join-Path $repository ('log/stage7-e2/'+$ScopeId)
$proofPath=Join-Path $scope 'build-proof.json'
$proofText=[IO.File]::ReadAllText($proofPath)
$proof=$proofText|ConvertFrom-Json
$mismatches=[Collections.Generic.List[string]]::new()
foreach($source in $proof.sources.PSObject.Properties){
    if((Get-FileHash -LiteralPath (Join-Path $repository $source.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $source.Value){$mismatches.Add($source.Name)}
}
foreach($artifact in $proof.artifacts.PSObject.Properties){
    $path=Join-Path $scope $artifact.Name
    if((Get-Item -LiteralPath $path).Length -ne $artifact.Value.bytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $artifact.Value.sha256){$mismatches.Add($artifact.Name)}
}
foreach($source in $proof.sourceScopes.PSObject.Properties){
    $path=Join-Path $repository ('log/stage7-e2/'+$source.Value.scopeId+'/fixture-proof.json')
    if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $source.Value.proofSha256){$mismatches.Add('来源proof：'+$source.Name)}
}
$candidate=Join-Path $PSScriptRoot 'physical-full-transfer/run.ps1'
$text=[IO.File]::ReadAllText($candidate)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors)
if($errors.Count){throw '候选语法失败'}
$phase=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq 'Invoke-Phase'})[0]
$phaseTry=@($phase.Body.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})[0]
$statements=@($phaseTry.Body.Statements)
$first=@($statements|Where-Object {$_.Extent.Text.StartsWith('if($build.version')})[0].Extent.StartOffset
$last=@($statements|Where-Object {$_.Extent.Text.StartsWith('$node=')})[0].Extent.StartOffset
$checks=[ScriptBlock]::Create($text.Substring($first,$last-$first))
function Bind-File([string]$Path,[long]$Maximum,[string]$ExpectedHash,[bool]$Small=$false){
    $script:bindingCount++
    if($Path.StartsWith($scope)){return [pscustomobject]@{length=$build.artifacts.($Path.Substring($scope.Length+1).Replace('\','/')).bytes}}
    return [pscustomobject]@{length=0}
}
$cases=[Collections.Generic.List[object]]::new()
$mutations=@(
    @{name='完整原件';reject=$false;mutate={}},
    @{name='空bundle';reject=$true;mutate={$build.bundleInputs=@()}},
    @{name='未绑定输入';reject=$true;mutate={$build.bundleInputs[2]+=@('src/review-unbound.ts')}},
    @{name='错bundle顺序';reject=$true;mutate={$a=$build.bundleInputs[0];$build.bundleInputs[0]=$build.bundleInputs[1];$build.bundleInputs[1]=$a}},
    @{name='重复bundle成员';reject=$true;mutate={$build.bundleInputs[2][1]=$build.bundleInputs[2][0]}},
    @{name='漏映射';reject=$true;mutate={$build.mappings=@($build.mappings|Select-Object -Skip 1)}},
    @{name='重复映射';reject=$true;mutate={$build.mappings+=@($build.mappings[0])}},
    @{name='旧输入混入';reject=$true;mutate={$build.bundleInputs[0]+=@('tools/data-qualification/full-transfer/input.ts')}},
    @{name='缺制品';reject=$true;mutate={$build.artifacts.PSObject.Properties.Remove('allocation.cs')}},
    @{name='额外来源';reject=$true;mutate={$build.sources|Add-Member -NotePropertyName 'src/review-extra.ts' -NotePropertyValue ('a'*64)}},
    @{name='来源scope替换';reject=$true;mutate={$build.sourceScopes.sources.scopeId='physical-sources512-'+('0'*32)}},
    @{name='来源proof替换';reject=$true;mutate={$build.sourceScopes.watch.proofSha256='0'*64}}
)
foreach($mutation in $mutations){
    $build=$proofText|ConvertFrom-Json;$bindingCount=0
    & $mutation.mutate
    $rejected=$false
    try{& $checks}catch{$rejected=$true}
    $cases.Add([pscustomobject]@{name=$mutation.name;pass=($rejected -eq $mutation.reject);rejected=$rejected;bindings=$bindingCount})
}
foreach($source in $proof.sources.PSObject.Properties.Name){
    $build=$proofText|ConvertFrom-Json;$bindingCount=0
    $build.sources.PSObject.Properties.Remove($source)
    $rejected=$false
    try{& $checks}catch{$rejected=$true}
    $cases.Add([pscustomobject]@{name=('缺来源：'+$source);pass=$rejected;rejected=$rejected;bindings=$bindingCount})
}
$report=[ordered]@{version=1;scopeId=$ScopeId;baseline=(& git -C $repository rev-parse HEAD);buildProofSha256=(Get-FileHash -LiteralPath $proofPath -Algorithm SHA256).Hash.ToLowerInvariant();candidateSha256=(Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant();sources=@($proof.sources.PSObject.Properties).Count;artifacts=@($proof.artifacts.PSObject.Properties).Count;bundles=$proof.bundleInputs.Count;mappings=$proof.mappings.Count;mismatches=$mismatches.ToArray();total=$cases.Count;passed=@($cases|Where-Object {$_.pass}).Count;failed=@($cases|Where-Object {-not $_.pass}).Count;cases=$cases.ToArray();jobInvoked=$false;largeDataRead=$false;actualModel='不可验证'}
$json=$report|ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path $evidence ('binding-'+[Guid]::NewGuid().ToString('N')+'.json')),$json,[Text.UTF8Encoding]::new($false))
$json
if($report.failed -or $mismatches.Count){exit 1}
