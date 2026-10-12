[CmdletBinding()]
param([ValidatePattern('^[a-f0-9]{40}$')][string]$SourceSHA = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$scope = 'log/browser-ux-20261012'
$uiSource = 'log/ui-refresh-20261012/20261012T093349920Z-c7dd21f05e4d4252a7cb71c6ff6c19d8'
$journal = 'log/legacy-followup-20261012/package/journal-7cacd772d0ee46baa72771a6e63377bd'

function Need([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Path([string]$Relative) {
  Need (-not [string]::IsNullOrWhiteSpace($Relative) -and $Relative -notmatch '[:\\]' -and -not [IO.Path]::IsPathRooted($Relative)) '证据成员必须是项目相对路径'
  foreach ($part in $Relative.Split('/')) { Need ($part -ne '' -and $part -ne '.' -and $part -ne '..' -and $part.TrimEnd(' ', '.') -ceq $part -and $part.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -lt 0) '证据成员路径不安全' }
  $full = [IO.Path]::GetFullPath((Join-Path $repository $Relative))
  Need ($full.StartsWith($repository + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) '证据路径越界'
  for ($part = $full; $part; $part = [IO.Path]::GetDirectoryName($part)) {
    if (Test-Path -LiteralPath $part) { Need (((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) '证据路径含重解析点' }
  }
  return $full
}
function Fact([string]$Relative) {
  $item = Get-Item -LiteralPath (Path $Relative) -Force
  Need ($item -is [IO.FileInfo] -and $item.Length -le 1073741824) '证据不是预算内普通文件'
  $stream = [IO.File]::Open($item.FullName, 'Open', 'Read', 'Read')
  try { $bytes = $stream.Length; $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant(); Need ($stream.Length -eq $bytes) '证据读取期间变化' } finally { $stream.Dispose() }
  return [ordered]@{ path = $Relative; bytes = $bytes; sha256 = $hash }
}
function ReadJson([string]$Relative) {
  Need ((Fact $Relative).bytes -le 4194304) 'JSON超过读取预算'
  return [IO.File]::ReadAllText((Path $Relative)) | ConvertFrom-Json
}
function NewJson([string]$Relative, $Value) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 30) + "`n")
  $stream = [IO.File]::Open((Path $Relative), 'CreateNew', 'Write', 'Read')
  try { $stream.Write($bytes); $stream.Flush($true) } finally { $stream.Dispose() }
}
function TrueValue($Value) { return ($Value -is [bool] -and $Value) }
function ExitIs([string]$Relative, [string]$Expected) { Need ([IO.File]::ReadAllText((Path $Relative)).Trim() -ceq $Expected) ('退出码不符：' + $Relative) }
function VerifyBound($Proof) {
  $actual = Fact $Proof.path
  Need ($actual.sha256 -ceq $Proof.sha256) '历史证明摘要变化'
  return $actual
}

$head = & git -C $repository rev-parse HEAD
Need ($LASTEXITCODE -eq 0 -and $head -cmatch '^[a-f0-9]{40}$') '不能确定当前源码HEAD'
if ($SourceSHA -eq '') { $SourceSHA = $head }
Need ($SourceSHA -ceq $head) 'SourceSHA必须等于当前HEAD'
$dirty = @(& git -C $repository status --porcelain=v1 --untracked-files=all)
Need ($LASTEXITCODE -eq 0 -and $dirty.Count -eq 0) '证据包装只允许干净源码'
$outputs = @('composite-review.json', 'quality.json', 'static-binding.json', 'package-inventory.json', 'gui-evidence.json', 'package-launch-constraint.json', 'fact-wrap.json', 'proofs-awaiting-review.json')
foreach ($name in $outputs) { Need (-not (Test-Path -LiteralPath (Path ($scope + '/' + $name)))) '目标证明已存在，拒绝覆盖' }
Need (-not (Test-Path -LiteralPath (Path ($scope + '/gui-final')))) 'GUI复制目标已存在，拒绝混入旧文件'

$candidateFact = Fact 'release/build-provenance.json'; $candidate = ReadJson $candidateFact.path
Need ((TrueValue $candidate.candidateEligible) -and $candidate.source.dirty -is [bool] -and -not $candidate.source.dirty -and $candidate.source.gitSha -ceq $SourceSHA -and $candidate.source.version -ceq '0.1.4') '候选不是当前干净0.1.4'
foreach ($file in $candidate.payload.packageFiles) { $actual = Fact ('release/win-unpacked/' + $file.path); Need ($actual.bytes -eq $file.bytes -and $actual.sha256 -ceq $file.sha256) '实际包成员字节不匹配清单' }
foreach ($name in @('installer', 'msi', 'installerBuild')) { $expected = $candidate.$name; $actual = Fact ('release/' + $expected.path); Need ($actual.bytes -eq $expected.bytes -and $actual.sha256 -ceq $expected.sha256) '候选安装器或身份文件变化' }
$previousFact = Fact 'output/build-provenance.json'; $previous = ReadJson $previousFact.path
Need ($previous.source.version -ceq '0.1.3' -and (TrueValue $previous.candidateEligible)) '当前output不是已选定0.1.3'
$priorFact = Fact 'log/real-provider-20261012/equivalence-record.json'; $prior = ReadJson $priorFact.path
Need ($prior.version -eq 2 -and (TrueValue $prior.passed) -and $prior.sourceGitSha -ceq $previous.source.gitSha -and $prior.proofs.candidateManifest.sha256 -ceq $previousFact.sha256) '历史资格未绑定当前output'
$legacyFact = VerifyBound $prior.proofs.priorQualification; $legacy = ReadJson $legacyFact.path
$hostFacts = [ordered]@{ priorQualification = $priorFact; previousManifest = $previousFact; legacyQualification = $legacyFact }
foreach ($name in @('failedPackageManifest', 'failedPackageEvents', 'failedPackageRun', 'profileIdentity')) { $hostFacts[$name] = VerifyBound $legacy.proofs.$name }
Need ($hostFacts.failedPackageManifest.path -ceq ($journal + '/manifest.json') -and $hostFacts.failedPackageEvents.path -ceq ($journal + '/events.jsonl')) '历史宿主约束不是固定journal'
Need ([IO.File]::ReadAllText((Path $hostFacts.failedPackageRun.path)).Contains('句柄实际路径不符合固定目标，拒绝路径别名或重定向')) '历史宿主路径约束原件不符'

$rawStaticFact = Fact ($scope + '/static-binding-raw.json'); $rawStatic = ReadJson $rawStaticFact.path
Need ((TrueValue $rawStatic.ok) -and $rawStatic.productExecuted -is [bool] -and -not $rawStatic.productExecuted) '真实静态验证未通过或误称执行产品'
foreach ($mapping in @(@('executableSha256', 'executable'), @('asarSha256', 'asar'), @('guardianSha256', 'guardian'))) { Need ($rawStatic.($mapping[0]) -ceq $candidate.payload.($mapping[1]).sha256) '静态验证与候选payload摘要不符' }
$static = [ordered]@{ version = 1; passed = $true; sourceGitSha = $SourceSHA; manifestSha256 = $candidateFact.sha256; executableSha256 = $rawStatic.executableSha256; asarSha256 = $rawStatic.asarSha256; guardianSha256 = $rawStatic.guardianSha256 }
$inventory = [ordered]@{ version = 1; passed = $true; sourceGitSha = $SourceSHA; manifestSha256 = $candidateFact.sha256; packageRoot = 'release/win-unpacked'; files = @($candidate.payload.packageFiles); installers = [ordered]@{ installer = $candidate.installer; msi = $candidate.msi; installerBuild = $candidate.installerBuild } }

$reviewFact = Fact ($scope + '/product-review.md'); $reviewText = [IO.File]::ReadAllText((Path $reviewFact.path))
Need ($reviewText.Contains('PASS（产品差量与限定组合验收）') -and $reviewText.Contains('PASS_WITH_UNKNOWN_HISTORICAL_EPERM')) '既有独审没有批准产品与限定组合验收'
$reviewedSourceFacts = @([regex]::Matches($reviewText, '(?m)^- (src/[^\r\n:]+): ([a-f0-9]{64})\s*$') | ForEach-Object { $fact = Fact $_.Groups[1].Value; Need ($fact.sha256 -ceq $_.Groups[2].Value) '既有产品审核源码已变化'; $fact })
Need ($reviewedSourceFacts.Count -ge 14) '既有审核缺少产品源码冻结范围'
$fullLog = Fact ($scope + '/full-tests-01.log'); $fullExit = Fact ($scope + '/full-tests-01.exit'); ExitIs $fullExit.path '1'
$fullText = [IO.File]::ReadAllText((Path $fullLog.path))
Need ($fullText.Contains('src/main/ai/conversation-ui-interruption.test.ts (4 tests | 1 failed)') -and $fullText.Contains('stage=rename') -and $fullText.Contains('code=EPERM') -and $fullText -match 'Tests\s+1 failed \| 6970 passed \| 3 skipped \(6974\)') '原始全量失败范围不符'
$replacementReport = Fact ($scope + '/conversation-interruption-isolated-01.json'); $replacementLog = Fact ($scope + '/conversation-interruption-isolated-01.log')
ExitIs ($scope + '/conversation-interruption-isolated-01.exit') '0'
$replacement = ReadJson $replacementReport.path
Need ((TrueValue $replacement.success) -and $replacement.numTotalTests -eq 4 -and $replacement.numPassedTests -eq 4 -and $replacement.numFailedTests -eq 0 -and $replacement.numPendingTests -eq 0) '原四项补验未通过'
$testSource = Fact 'src/main/ai/conversation-ui-interruption.test.ts'
$diagnosisFact = Fact ($scope + '/conversation-interruption-diagnosis.json'); $diagnosis = ReadJson $diagnosisFact.path
foreach ($source in $diagnosis.sources) { Need ((Fact $source.path).sha256 -ceq $source.sha256) '组合验收相关源码已变化' }
$composite = [ordered]@{ version = 1; sourceGitSha = $SourceSHA; conclusion = 'PASS_WITH_UNKNOWN_HISTORICAL_EPERM'; proofs = [ordered]@{ fullLog = $fullLog.sha256; fullExit = $fullExit.sha256; replacementReport = $replacementReport.sha256; replacementLog = $replacementLog.sha256; sourceSha256 = $testSource.sha256 }; report = $reviewFact }
$qualityChecks = [ordered]@{ test = [ordered]@{ mode = 'bounded-composite'; historicalRootCause = 'unknown'; full = [ordered]@{ exitCode = 1; passed = 6970; failed = 1; skipped = 3; log = $fullLog; exit = $fullExit }; replacement = [ordered]@{ path = $testSource.path; exitCode = 0; passed = 4; failed = 0; report = $replacementReport; log = $replacementLog; sourceSha256 = $testSource.sha256 }; deduplicated = [ordered]@{ passed = 6971; skipped = 3 }; review = $null } }
$qualityExitFacts = [ordered]@{}
foreach ($name in @('typecheck', 'lint', 'format', 'build')) { $exitFact = Fact ($scope + '/' + $name + '-final.exit'); ExitIs $exitFact.path '0'; $qualityExitFacts[$name] = $exitFact; $qualityChecks[$name] = [ordered]@{ exitCode = 0; log = (Fact ($scope + '/' + $name + '-final.log')) } }

$uiFact = Fact ($uiSource + '/result.json'); $ui = ReadJson $uiFact.path
Need ($ui.status -ceq 'passed' -and @($ui.failures).Count -eq 0 -and @($ui.captures).Count -eq 78 -and $ui.inputs.providerCalls -eq 0) '最终UI场景未完整通过'
$uiReviewFact = Fact ($scope + '/reviewer-evidence-validation.json'); $uiReview = ReadJson $uiReviewFact.path
Need ($uiReview.uiSha256 -ceq $uiFact.sha256 -and $uiReview.sourceCount -eq 322 -and $uiReview.artifactCount -eq 5 -and $uiReview.captures -eq 78) '独立UI原件核验未绑定当前选定运行'
foreach ($property in $ui.inputs.sourceHashes.PSObject.Properties) { Need ((Fact $property.Name).sha256 -ceq $property.Value) ('UI来源源码已变化：' + $property.Name) }
$copyPlan = [Collections.Generic.List[object]]::new(); $copyPlan.Add(@{ source = $uiFact.path; destination = ($scope + '/gui-final/result.json'); fact = $uiFact })
$seenCopies = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($capture in $ui.captures) {
  Need (@($capture.failures).Count -eq 0 -and (TrueValue $capture.checks.webContentsViewBoundsOk)) 'UI capture或真实bounds未通过'
  foreach ($check in $capture.checks.PSObject.Properties) { Need ($check.Value -isnot [bool] -or $check.Value) 'UI capture含失败检查' }
  foreach ($extension in @('png', 'json')) { $relative = $capture.$extension; Need ($relative -cmatch ('^captures/[A-Za-z0-9-]+\.' + $extension + '$') -and $seenCopies.Add($relative)) '只复制唯一截图及JSON，禁止profile/session树'; $copyPlan.Add(@{ source = ($uiSource + '/' + $relative); destination = ($scope + '/gui-final/' + $relative); fact = (Fact ($uiSource + '/' + $relative)) }) }
}
$defaults = @($ui.captures | Where-Object { $_.scene -ceq '浏览器基线' })
Need ($defaults.Count -eq 6) '默认尺寸主题矩阵不完整'
foreach ($capture in $defaults) { Need ((TrueValue $capture.checks.compactChromeOk) -and (TrueValue $capture.checks.noDefaultDebugOk) -and (TrueValue $capture.checks.noBottomChromeOk) -and $capture.dom.chrome.rect.height -le 86 -and $capture.dom.address.width -ge 180) '默认布局oracle未通过' }
Need (@($ui.captures | Where-Object { $_.scene -ceq '本地数据详情' }).Count -eq 6) 'LocalData详情矩阵不完整'
Need ((TrueValue $ui.workspaceNavigation.watchNewTab) -and (TrueValue $ui.workspaceNavigation.watchActivateTab) -and (TrueValue $ui.workspaceNavigation.nativeContentVisible)) 'Watch返回浏览的实际UI证据未通过'
$appNavigationFact = Fact ($scope + '/app-navigation-green.log')
Need ([IO.File]::ReadAllText((Path $appNavigationFact.path)) -match 'Tests\s+12 passed \(12\)') 'App工作区导航原十二项未通过'
$navigationFact = Fact ($scope + '/aggregate.json'); $navigation = ReadJson $navigationFact.path
Need ((TrueValue $navigation.passed) -and @($navigation.cases).Count -eq 9) '导航九子场聚合未通过'
foreach ($property in $navigation.productSourceHashes.PSObject.Properties) { Need ((Fact $property.Name).sha256 -ceq $property.Value) '真实导航产品源码已变化' }

# Every input is checked before creating any new evidence. Copies are byte-preserving;
# historical builds remain historical and are never relabeled as packaged startup.
[void][IO.Directory]::CreateDirectory((Path ($scope + '/gui-final/captures')))
$copied = @($copyPlan | ForEach-Object { [IO.File]::Copy((Path $_.source), (Path $_.destination), $false); $fact = Fact $_.destination; Need ($fact.bytes -eq $_.fact.bytes -and $fact.sha256 -ceq $_.fact.sha256) 'GUI原件复制字节不一致'; $fact })
NewJson ($scope + '/composite-review.json') $composite
$qualityChecks.test.review = Fact ($scope + '/composite-review.json')
NewJson ($scope + '/quality.json') ([ordered]@{ version = 2; sourceGitSha = $SourceSHA; checks = $qualityChecks })
NewJson ($scope + '/static-binding.json') $static
NewJson ($scope + '/package-inventory.json') $inventory
$gui = [ordered]@{ version = 1; scope = 'browser-ux-navigation-repair'; passed = $true; sourceGitSha = $SourceSHA; actualElectron = $true; runtimeExecutable = (Fact 'node_modules/electron/dist/electron.exe'); checks = [ordered]@{ compactChrome = $true; debugDefaultAbsent = $true; localDataMounted = $true; smallWindow = $true; navigationFromWatch = $true; navigationFromResearch = $true; sidePanelBounds = $true }; artifacts = [ordered]@{ desktop1280 = (Fact ($scope + '/gui-final/captures/1280x800-light-browser.json')); desktop800 = (Fact ($scope + '/gui-final/captures/800x600-dark-browser.json')); navigation = $navigationFact; bounds = (Fact ($scope + '/gui-final/result.json')) } }
NewJson ($scope + '/gui-evidence.json') $gui
NewJson ($scope + '/package-launch-constraint.json') ([ordered]@{ version = 1; sourceGitSha = $SourceSHA; status = 'NOTRUN'; reason = 'host-profile-path-redirection-blocked'; blockedByHostPathRedirection = $true; packageExecuted = $false })
NewJson ($scope + '/fact-wrap.json') ([ordered]@{
  version = 1; sourceGitSha = $SourceSHA; scope = '待审核事实包装，未签发最终换包资格'; productReview = $reviewFact; reviewedProductSources = $reviewedSourceFacts; staticBindingRaw = $rawStaticFact; qualityExitFiles = $qualityExitFacts; compositeDiagnosis = $diagnosisFact
  gui = [ordered]@{ originalResult = $uiFact; independentValidation = $uiReviewFact; copiedFiles = $copied; sourceBinding = '322个UI源码摘要与当前源码相同；五个历史out产物摘要由既有独立核验绑定，release构建可替换out，不冒称重新运行UI。'; researchNavigation = [ordered]@{ evidenceKind = 'App组件分支原十二项单测及既有产品审核'; log = $appNavigationFact; source = (Fact 'src/renderer/src/App.navigation.test.ts'); actualElectronResearchNavigationTested = $false }; iframePhysicalInput = 'NOTRUN：输入未触达，原失败未改写' }
  hostConstraint = [ordered]@{ evidenceReused = $true; reexecuted = $false; candidatePackageExecuted = $false; description = '沿用历史固定journal与已选定0.1.3资格中的宿主profile路径重定向约束；本轮没有新执行PackageSmoke，不宣称重新验证宿主状态。'; proofs = $hostFacts }
  notCreated = @('independent-review.json', 'equivalence-record.json')
})
$proofs = [ordered]@{ candidateManifest = $candidateFact; previousManifest = $previousFact; staticBinding = (Fact ($scope + '/static-binding.json')); packageInventory = (Fact ($scope + '/package-inventory.json')); guiEvidence = (Fact ($scope + '/gui-evidence.json')); quality = (Fact ($scope + '/quality.json')); hostConstraint = (Fact ($scope + '/package-launch-constraint.json')); priorQualification = $priorFact }
NewJson ($scope + '/proofs-awaiting-review.json') ([ordered]@{ version = 1; sourceGitSha = $SourceSHA; status = 'AWAITING_INDEPENDENT_PACKAGE_REVIEW'; packageLaunchStatus = 'NOTRUN'; proofs = $proofs; factWrap = (Fact ($scope + '/fact-wrap.json')) })
Write-Output '八项proof事实包装已生成；最终独立包审核与等价记录尚未签发。'
