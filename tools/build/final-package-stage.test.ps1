$ErrorActionPreference = 'Stop'
$tool = Join-Path $PSScriptRoot 'final-package-stage.ps1'
$toolText = [IO.File]::ReadAllText($tool)
if(!$toolText.Contains('System32\WindowsPowerShell\v1.0\powershell.exe') -or $toolText -notmatch '-Verb RunAs' -or $toolText -notmatch "'CreateNew'" -or $toolText -match 'Copy-Item'){throw '固定提权或CreateNew复制契约缺失'}
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('aibrowse-final-stage-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
function Sha([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Write-Json([string]$Path, $Value) { [IO.File]::WriteAllText($Path, (ConvertTo-Json $Value -Depth 12) + "`n", [Text.UTF8Encoding]::new($false)) }
function New-Fixture([string]$Mode) {
  $scope = Join-Path $testRoot ('product-msi-' + [guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($scope) | Out-Null
  $exe = Join-Path $scope 'selected.exe'; $msi = Join-Path $scope 'selected.msi'
  [IO.File]::WriteAllBytes($exe, [Text.Encoding]::UTF8.GetBytes('selected-exe'))
  [IO.File]::WriteAllBytes($msi, [Text.Encoding]::UTF8.GetBytes('selected-msi'))
  $binding = [ordered]@{
    schema=1;scopeId=[IO.Path]::GetFileName($scope);originalManifestSha256=('1'*64);maximumTransactions=6;budgetMs=180000
    sourceCommit=('2'*40);cleanBuildsVerified=$true;behaviorApplicabilityVerified=$true;cleanBuildReviewSha256=('3'*64)
    behaviorApplicabilityReviewSha256=('4'*64);ordinal4ExitSha256=('5'*64);ordinal4StateSha256=('6'*64)
    package=[ordered]@{name='final-candidate';version='0.1.1';product='{11111111-2222-3333-4444-555555555555}';artifacts=[ordered]@{
      exe=[ordered]@{sha256=(Sha $exe);bytes=(Get-Item $exe).Length};msi=[ordered]@{sha256=(Sha $msi);bytes=(Get-Item $msi).Length}
    }}
  }
  if($Mode -eq 'string-bool'){$binding.cleanBuildsVerified='true'}
  if($Mode -eq 'unknown-field'){$binding['extra']='enemy'}
  if($Mode -eq 'wrong-exe'){$binding.package.artifacts.exe.sha256='7'*64}
  Write-Json (Join-Path $scope 'final-package-binding.json') $binding
  [pscustomobject]@{scope=$scope;exe=$exe;msi=$msi;bindingSha256=(Sha (Join-Path $scope 'final-package-binding.json'))}
}
function Reject([scriptblock]$Case,[string]$Label) {
  try { & $Case; throw ('反例被接受：' + $Label) }
  catch { if($_.Exception.Message -like '反例被接受：*'){throw};Write-Output ('REJECTED:' + $Label) }
}
try {
  $ok=New-Fixture 'valid'
  & $tool -Action Prepare -Scope $ok.scope -FinalBindingSha256 $ok.bindingSha256 -ExeSourcePath $ok.exe -MsiSourcePath $ok.msi | Out-Null
  $plan=Get-Content -LiteralPath (Join-Path $ok.scope 'final-package-stage-plan.json') -Raw -Encoding UTF8|ConvertFrom-Json
  if($plan.schema -ne 1 -or $plan.sources.exe.path -cne $ok.exe -or $plan.sources.msi.path -cne $ok.msi){throw '正控plan错绑'}
  $command=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($plan.encodedCommand))
  if($command -notmatch 'Join-Path \$root ''final-candidate\.exe''' -or $command -notmatch 'Join-Path \$root ''final-candidate\.msi''' -or $command -match 'Start-Process'){throw '内联复制目标或权限越界'}
  if($command -match 'ReadAllBytes' -or $command -notmatch '\$scope=Resolve-LocalFixedPath ' -or $command -notmatch '\$exePath=Resolve-LocalFixedPath ' -or $command -notmatch '\$msiPath=Resolve-LocalFixedPath ' -or $command -notmatch '\[IO\.FileInfo\]'){throw '内联路径或有界读取契约缺失'}
  $tokens=$null;$errors=$null
  [System.Management.Automation.Language.Parser]::ParseInput($command,[ref]$tokens,[ref]$errors)|Out-Null
  if($errors.Count){throw '内联保护复制命令无法解析'}
  $commandAst=[System.Management.Automation.Language.Parser]::ParseInput($command,[ref]$tokens,[ref]$errors)
  $inlineHelperNames=@('Require-StageCondition','Get-StageByteHash','Resolve-LocalFixedPath','Assert-NoStageLinks','Assert-ProtectedStagePath','Save-NewStageJson','Copy-ProtectedStageFile')
  $defaultAliases=@(Get-Alias | ForEach-Object {$_.Name.ToLowerInvariant()})
  foreach($helperName in $inlineHelperNames){
    if($defaultAliases -contains $helperName.ToLowerInvariant()){throw ('内联函数与默认alias冲突：'+$helperName)}
    $helper=@($commandAst.FindAll({param($node)$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $helperName},$true))
    if($helper.Count -ne 1){throw ('内联函数不唯一：'+$helperName)}
    if($helperName -in @('Require-StageCondition','Get-StageByteHash','Resolve-LocalFixedPath')){Invoke-Expression $helper[0].Extent.Text}
  }
  if((Resolve-LocalFixedPath $ok.exe) -cne $ok.exe){throw '内联本地路径正控失败'}
  $knownBytes=[Text.Encoding]::UTF8.GetBytes('aibrowse-inline-hash-control')
  $expectedKnownHash=[BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash($knownBytes)).Replace('-','').ToLowerInvariant()
  if((Get-StageByteHash $knownBytes) -cne $expectedKnownHash){throw '内联字节哈希正控失败'}
  Reject { Resolve-LocalFixedPath '\\server\share\enemy.exe' } 'child-unc-path'
  Reject { Resolve-LocalFixedPath ($ok.exe+':ads') } 'child-ads-path'
  Reject { & $tool -Action Prepare -Scope $ok.scope -FinalBindingSha256 ('a'*64) -ExeSourcePath $ok.exe -MsiSourcePath $ok.msi } 'wrong-binding-hash'
  $stringBool=New-Fixture 'string-bool';Reject { & $tool -Action Prepare -Scope $stringBool.scope -FinalBindingSha256 $stringBool.bindingSha256 -ExeSourcePath $stringBool.exe -MsiSourcePath $stringBool.msi } 'string-bool'
  $unknown=New-Fixture 'unknown-field';Reject { & $tool -Action Prepare -Scope $unknown.scope -FinalBindingSha256 $unknown.bindingSha256 -ExeSourcePath $unknown.exe -MsiSourcePath $unknown.msi } 'unknown-field'
  $wrong=New-Fixture 'wrong-exe';Reject { & $tool -Action Prepare -Scope $wrong.scope -FinalBindingSha256 $wrong.bindingSha256 -ExeSourcePath $wrong.exe -MsiSourcePath $wrong.msi } 'wrong-source-hash'
  $relative=New-Fixture 'valid';Reject { & $tool -Action Prepare -Scope $relative.scope -FinalBindingSha256 $relative.bindingSha256 -ExeSourcePath 'relative.exe' -MsiSourcePath $relative.msi } 'relative-source'
  $paths=New-Fixture 'valid'
  Reject { & $tool -Action Prepare -Scope '\\server\share\product-msi-00000000000000000000000000000000' -FinalBindingSha256 $paths.bindingSha256 -ExeSourcePath $paths.exe -MsiSourcePath $paths.msi } 'unc-scope'
  Reject { & $tool -Action Prepare -Scope $paths.scope -FinalBindingSha256 $paths.bindingSha256 -ExeSourcePath '\\?\C:\enemy.exe' -MsiSourcePath $paths.msi } 'device-source'
  Reject { & $tool -Action Prepare -Scope $paths.scope -FinalBindingSha256 $paths.bindingSha256 -ExeSourcePath 'C:drive-relative.exe' -MsiSourcePath $paths.msi } 'drive-relative-source'
  Reject { & $tool -Action Prepare -Scope $paths.scope -FinalBindingSha256 $paths.bindingSha256 -ExeSourcePath ($paths.exe+':ads') -MsiSourcePath $paths.msi } 'ads-source'
  Reject { & $tool -Action Prepare -Scope $paths.scope -FinalBindingSha256 $paths.bindingSha256 -ExeSourcePath $paths.scope -MsiSourcePath $paths.msi } 'directory-source'
  Write-Output 'PASS：固定两文件保护复制Prepare与输入反例'
}
finally {
  $resolved=[IO.Path]::GetFullPath($testRoot)
  if($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('aibrowse-final-stage-')) { [IO.Directory]::Delete($resolved,$true) }
}
