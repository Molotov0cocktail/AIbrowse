param(
  [Parameter(Mandatory = $true)][string]$Scope,
  [Parameter(Mandatory = $true)][string]$ManifestSha256,
  [Parameter(Mandatory = $true)][ValidateSet('upgrade','running-reject','uninstall','reinstall','final-uninstall')][string]$Step,
  [string]$FinalBindingPath = '',
  [string]$FinalBindingSha256 = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# This unelevated recorder only elevates the bound native EXE or the system msiexec.
# It never runs an elevated script, starts the app, changes a profile, or kills a process.
function Require([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Digest([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Hash-Bytes([byte[]]$Bytes) {
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { [BitConverter]::ToString($hasher.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant() } finally { $hasher.Dispose() }
}
function Read-BoundJson([string]$Path, [int]$MaximumBytes, [string]$Label) {
  $item = Get-Item -LiteralPath $Path -Force
  Require ($item -is [IO.FileInfo] -and ($item.Attributes -band [IO.FileAttributes]::Directory) -eq 0 -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) ($Label + '不是普通文件')
  $file = [IO.File]::Open($Path, 'Open', 'Read', 'Read')
  try {
    Require ($MaximumBytes -gt 0 -and $file.Length -gt 0 -and $file.Length -le $MaximumBytes) ($Label + '字节超过预算')
    $bytes = New-Object byte[] ([int]$file.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $read = $file.Read($bytes, $offset, $bytes.Length - $offset)
      Require ($read -gt 0) ($Label + '提前EOF')
      $offset += $read
    }
    Require ($file.ReadByte() -eq -1) ($Label + '超出预期长度')
  } finally { $file.Dispose() }
  try { $text = [Text.UTF8Encoding]::new($false,$true).GetString($bytes) } catch { throw ($Label + '不是严格UTF-8') }
  try { $value = ConvertFrom-Json -InputObject $text -ErrorAction Stop } catch { throw ($Label + '不是有效JSON') }
  [pscustomobject]@{ Bytes=$bytes; Sha256=(Hash-Bytes $bytes); Value=$value }
}
function Require-Closed($Value, [string[]]$Names, [string]$Label) {
  Require ($Value -is [pscustomobject]) ($Label + '必须是对象')
  $actual = @($Value.PSObject.Properties.Name)
  Require ($actual.Count -eq $Names.Count) ($Label + '字段不闭合')
  foreach ($name in $Names) { Require ($actual -ccontains $name) ($Label + '字段不闭合') }
}
function Require-Bool($Value, [string]$Label) { Require ($Value -is [bool]) ($Label + '必须是JSON boolean') }
function Require-Integer($Value, [string]$Label) { Require ($Value -is [int] -or $Value -is [long]) ($Label + '必须是JSON整数') }
function Require-String($Value, [string]$Label) { Require ($Value -is [string]) ($Label + '必须是JSON字符串') }
function Require-Sha($Value, [string]$Label) { Require ($Value -is [string] -and $Value -cmatch '^[a-f0-9]{64}$') ($Label + '必须是SHA256') }
function Require-Artifact($Value, [string]$Label) {
  Require-Closed $Value @('sha256','bytes') $Label
  Require-Sha $Value.sha256 ($Label + '.sha256')
  Require-Integer $Value.bytes ($Label + '.bytes')
  Require ($Value.bytes -gt 0) ($Label + '.bytes无效')
}
function Save([string]$Name, $Value) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $Value -Depth 20) + "`n")
  $file = [IO.File]::Open((Join-Path $scopePath $Name), 'CreateNew', 'Write', 'None')
  try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
}
function Protected([string]$Path) {
  for ($part = $Path; $part; $part = [IO.Path]::GetDirectoryName($part)) {
    Require (((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) '原生路径祖先或成员含链接'
  }
  $acl = Get-Acl -LiteralPath $Path
  $trusted = @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  Require ($trusted -contains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) '原生路径 owner 不可信'
  $writes = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    Require (!($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $writes) -ne 0 -and $trusted -notcontains $rule.IdentityReference.Value)) '原生路径允许非可信写入'
  }
}
Require ([Environment]::Is64BitProcess) '需要64位PowerShell'
$scopePath = [IO.Path]::GetFullPath($Scope)
$scopeId = [IO.Path]::GetFileName($scopePath)
Require ($scopeId -cmatch '^product-msi-[a-f0-9]{32}$' -and $ManifestSha256 -cmatch '^[a-f0-9]{64}$') '固定 scope/hash 不规范'
$manifestPath = Join-Path $scopePath 'manifest.json'
$manifestInput = Read-BoundJson $manifestPath 524288 '原矩阵清单'
Require ($manifestInput.Sha256 -ceq $ManifestSha256) '原矩阵清单来源变化'
$manifest = $manifestInput.Value
Require ($manifest.scopeId -ceq $scopeId -and $manifest.budget.maximumTransactions -eq 6 -and $manifest.budget.secondsPerTransaction -eq 180 -and $manifest.identity -ceq '69F81EEA-69A7-4E92-A794-B882158DE0D9') '原矩阵合同不匹配'
$protectedRoot = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) ('AIbrowse Product Review ' + $scopeId.Substring(12))
Protected ([Environment]::GetFolderPath('ProgramFiles'))
Protected $protectedRoot
$candidate = @($manifest.packages | Where-Object name -CEQ 'candidate')
Require ($candidate.Count -eq 1 -and $candidate[0].version -ceq '0.1.1' -and $candidate[0].product -cmatch '^\{[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}\}$') '候选身份不闭合'
$candidate = $candidate[0]
foreach ($kind in @('exe','msi')) {
  $bound = Join-Path $protectedRoot ('candidate.' + $kind)
  Protected $bound
  Require ((Digest $bound) -ceq $candidate.artifacts.$kind.sha256 -and (Get-Item -LiteralPath $bound).Length -eq $candidate.artifacts.$kind.bytes) '受保护原生候选字节变化'
}
$steps = @('upgrade','running-reject','uninstall','reinstall','final-uninstall')
$originalCandidate = $candidate
$finalBinding = $null
$candidateStem = 'candidate'
$index = [Array]::IndexOf($steps,$Step)
$ordinal = $index + 2
if ($index -eq 0) {
  $prior = Get-Content -LiteralPath (Join-Path $protectedRoot 'install-wrapper-exit.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  Require ($prior.exit -eq 0 -and (Test-Path -LiteralPath (Join-Path $protectedRoot 'failure.json'))) '必须保留已首装成功但工具失败的原场'
} else {
  $priorInput = Read-BoundJson (Join-Path $scopePath ('direct-' + $steps[$index - 1] + '-exit.json')) 65536 '前一原生事务回执'
  $prior = $priorInput.Value
  Require-Bool $prior.exited '前一原生事务exited'
  foreach ($name in @('transactionOrdinal','actualExit','expectedExit','durationMs')) { Require-Integer $prior.$name ('前一原生事务.' + $name) }
  Require ($prior.transactionOrdinal -eq ($ordinal - 1) -and $prior.exited -eq $true -and $prior.actualExit -eq $prior.expectedExit -and $prior.durationMs -ge 0 -and $prior.durationMs -le 180000) '前一原生事务未满足固定合同，禁止继续'
}
if ($FinalBindingPath -ne '' -or $FinalBindingSha256 -ne '') {
  Require ($Step -in @('reinstall','final-uninstall') -and $FinalBindingSha256 -cmatch '^[a-f0-9]{64}$') '最终输入只允许ordinal5/6承接'
  Require ([IO.Path]::GetFullPath($FinalBindingPath) -ceq (Join-Path $scopePath 'final-package-binding.json')) '补充清单必须位于原矩阵固定路径'
  $finalInput = Read-BoundJson $FinalBindingPath 524288 '补充清单'
  Require ($finalInput.Sha256 -ceq $FinalBindingSha256) '补充清单摘要变化'
  $finalBinding = $finalInput.Value
  Require-Closed $finalBinding @('schema','scopeId','originalManifestSha256','maximumTransactions','budgetMs','sourceCommit','cleanBuildsVerified','behaviorApplicabilityVerified','cleanBuildReviewSha256','behaviorApplicabilityReviewSha256','ordinal4ExitSha256','ordinal4StateSha256','package') '补充清单'
  foreach ($name in @('schema','maximumTransactions','budgetMs')) { Require-Integer $finalBinding.$name ('补充清单.' + $name) }
  foreach ($name in @('scopeId','originalManifestSha256','sourceCommit')) { Require-String $finalBinding.$name ('补充清单.' + $name) }
  Require ($finalBinding.schema -eq 1 -and $finalBinding.scopeId -ceq $scopeId -and $finalBinding.originalManifestSha256 -ceq $ManifestSha256 -and $finalBinding.maximumTransactions -eq 6 -and $finalBinding.budgetMs -eq 180000) '补充清单合同不匹配'
  Require-Bool $finalBinding.cleanBuildsVerified 'cleanBuildsVerified'
  Require-Bool $finalBinding.behaviorApplicabilityVerified 'behaviorApplicabilityVerified'
  Require ($finalBinding.sourceCommit -cmatch '^[a-f0-9]{40}$' -and $finalBinding.cleanBuildsVerified -eq $true -and $finalBinding.behaviorApplicabilityVerified -eq $true) '最终构建或旧证据适用性未完成'
  foreach ($name in @('cleanBuildReviewSha256','behaviorApplicabilityReviewSha256','ordinal4ExitSha256','ordinal4StateSha256')) { Require-Sha $finalBinding.$name ('补充清单.' + $name) }
  $candidate = $finalBinding.package
  Require-Closed $candidate @('name','version','product','artifacts') '最终候选'
  foreach ($name in @('name','version','product')) { Require-String $candidate.$name ('最终候选.' + $name) }
  Require-Closed $candidate.artifacts @('exe','msi') '最终候选.artifacts'
  Require-Artifact $candidate.artifacts.exe '最终候选.exe'
  Require-Artifact $candidate.artifacts.msi '最终候选.msi'
  Require ($candidate.name -ceq 'final-candidate' -and $candidate.version -ceq '0.1.1' -and $candidate.product -cmatch '^\{[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}\}$' -and $candidate.product -cne $originalCandidate.product) '最终候选身份不闭合'
  $cleanInput = Read-BoundJson (Join-Path $scopePath 'final-clean-build-review.json') 524288 '双洁净构建报告'
  $behaviorInput = Read-BoundJson (Join-Path $scopePath 'final-behavior-applicability-review.json') 524288 '行为适用性报告'
  Require ($cleanInput.Sha256 -ceq $finalBinding.cleanBuildReviewSha256 -and $behaviorInput.Sha256 -ceq $finalBinding.behaviorApplicabilityReviewSha256) '最终独审报告摘要变化'
  function Require-ReportCandidate($Report, [string]$Label) {
    Require-Closed $Report.candidate @('productCode','exe','msi') ($Label + '.candidate')
    Require-String $Report.candidate.productCode ($Label + '.candidate.productCode')
    Require-Artifact $Report.candidate.exe ($Label + '.candidate.exe')
    Require-Artifact $Report.candidate.msi ($Label + '.candidate.msi')
    Require ($Report.candidate.productCode -ceq $candidate.product -and $Report.candidate.exe.sha256 -ceq $candidate.artifacts.exe.sha256 -and $Report.candidate.exe.bytes -eq $candidate.artifacts.exe.bytes -and $Report.candidate.msi.sha256 -ceq $candidate.artifacts.msi.sha256 -and $Report.candidate.msi.bytes -eq $candidate.artifacts.msi.bytes) ($Label + '最终候选错绑')
  }
  $cleanReport = $cleanInput.Value
  Require-Closed $cleanReport @('schema','verdict','sourceCommit','originalManifestSha256','candidate','provenance') '双洁净构建报告'
  Require-Closed $cleanReport.provenance @('firstSha256','secondSha256','selectedSha256') '双洁净构建provenance'
  foreach ($name in @('firstSha256','secondSha256','selectedSha256')) { Require-Sha $cleanReport.provenance.$name ('provenance.' + $name) }
  Require ($cleanReport.provenance.firstSha256 -cne $cleanReport.provenance.secondSha256 -and @($cleanReport.provenance.firstSha256,$cleanReport.provenance.secondSha256) -ccontains $cleanReport.provenance.selectedSha256) '双洁净构建选择身份无效'
  $behaviorReport = $behaviorInput.Value
  Require-Closed $behaviorReport @('schema','verdict','sourceCommit','originalManifestSha256','candidate') '行为适用性报告'
  foreach ($report in @($cleanReport,$behaviorReport)) {
    Require-Integer $report.schema '最终独审报告.schema'
    foreach ($name in @('verdict','sourceCommit','originalManifestSha256')) { Require-String $report.$name ('最终独审报告.' + $name) }
    Require ($report.schema -eq 1 -and $report.verdict -ceq 'PASS' -and $report.sourceCommit -ceq $finalBinding.sourceCommit -and $report.originalManifestSha256 -ceq $ManifestSha256) '最终独审报告来源或结论错绑'
  }
  Require-ReportCandidate $cleanReport '双洁净构建报告'
  Require-ReportCandidate $behaviorReport '行为适用性报告'
  $fourthInput = if ($Step -eq 'reinstall') { $priorInput } else { Read-BoundJson (Join-Path $scopePath 'direct-uninstall-exit.json') 65536 'ordinal4回执' }
  $stateInput = Read-BoundJson (Join-Path $scopePath 'final-preinstall-state.json') 524288 'ordinal4退休状态'
  $retirementInput = Read-BoundJson (Join-Path $scopePath 'ordinal4-retirement-evidence.json') 4194304 'ordinal4完整退休原件'
  Require ($fourthInput.Sha256 -ceq $finalBinding.ordinal4ExitSha256 -and $stateInput.Sha256 -ceq $finalBinding.ordinal4StateSha256) '旧包退休证据变化'
  $fourth = $fourthInput.Value
  Require-Bool $fourth.exited 'ordinal4.exited'
  foreach ($name in @('transactionOrdinal','actualExit','durationMs')) { Require-Integer $fourth.$name ('ordinal4.' + $name) }
  Require-String $fourth.step 'ordinal4.step'
  Require ($fourth.transactionOrdinal -eq 4 -and $fourth.step -ceq 'uninstall' -and $fourth.exited -eq $true -and $fourth.actualExit -eq 0 -and $fourth.durationMs -ge 0 -and $fourth.durationMs -le 180000) '旧包未实际卸载'
  $state = $stateInput.Value
  Require-Closed $state @('schema','verdict','transactionOrdinal','productCode','originalManifestSha256','evidenceSha256') 'ordinal4退休状态'
  foreach ($name in @('schema','transactionOrdinal')) { Require-Integer $state.$name ('ordinal4退休状态.' + $name) }
  foreach ($name in @('verdict','productCode','originalManifestSha256')) { Require-String $state.$name ('ordinal4退休状态.' + $name) }
  Require-Sha $state.evidenceSha256 'ordinal4退休状态.evidenceSha256'
  Require ($state.schema -eq 1 -and $state.verdict -ceq 'PASS' -and $state.transactionOrdinal -eq 4 -and $state.productCode -ceq $originalCandidate.product -and $state.originalManifestSha256 -ceq $ManifestSha256 -and $state.evidenceSha256 -ceq $retirementInput.Sha256) '旧包退休状态错绑'
  foreach ($kind in @('exe','msi')) {
    $bound = Join-Path $protectedRoot ('final-candidate.' + $kind)
    Protected $bound
    Require ($candidate.artifacts.$kind.sha256 -cmatch '^[a-f0-9]{64}$' -and $candidate.artifacts.$kind.bytes -gt 0 -and (Digest $bound) -ceq $candidate.artifacts.$kind.sha256 -and (Get-Item -LiteralPath $bound).Length -eq $candidate.artifacts.$kind.bytes) '受保护最终候选字节变化'
  }
  if ($Step -eq 'final-uninstall') {
    $fifthClaimInput = Read-BoundJson (Join-Path $scopePath 'direct-reinstall-claim.json') 65536 'ordinal5 claim'
    $fifthExitInput = $priorInput
    $fifthClaim = $fifthClaimInput.Value
    $fifthExit = $fifthExitInput.Value
    Require-Closed $fifthClaim @('schema','step','transactionOrdinal','maximumTransactions','priorMechanismTransactions','priorOriginalToolFailureRetained','manifestSha256','finalBindingSha256','cleanBuildReviewSha256','behaviorApplicabilityReviewSha256','ordinal4ExitSha256','ordinal4StateSha256','ordinal4RetirementEvidenceSha256','ordinal5ClaimSha256','ordinal5ExitSha256','productCode','candidateExeSha256','candidateMsiSha256','recorderSha256','nativePath','nativeSha256','args','expectedExit','budgetMs','createdUtc') 'ordinal5 claim'
    Require-Bool $fifthExit.exited 'ordinal5.exited'
    Require-Bool $fifthClaim.priorOriginalToolFailureRetained 'ordinal5.priorOriginalToolFailureRetained'
    foreach ($name in @('schema','transactionOrdinal','maximumTransactions','priorMechanismTransactions','expectedExit','budgetMs')) { Require-Integer $fifthClaim.$name ('ordinal5 claim.' + $name) }
    foreach ($name in @('transactionOrdinal','actualExit','expectedExit','durationMs')) { Require-Integer $fifthExit.$name ('ordinal5 exit.' + $name) }
    foreach ($name in @('step','manifestSha256','finalBindingSha256','cleanBuildReviewSha256','behaviorApplicabilityReviewSha256','ordinal4ExitSha256','ordinal4StateSha256','ordinal4RetirementEvidenceSha256','productCode','candidateExeSha256','candidateMsiSha256','nativeSha256')) { Require-String $fifthClaim.$name ('ordinal5 claim.' + $name) }
    Require-String $fifthExit.step 'ordinal5 exit.step'
    Require ($fifthClaim.schema -eq 1 -and $fifthClaim.transactionOrdinal -eq 5 -and $fifthClaim.maximumTransactions -eq 6 -and $fifthClaim.priorMechanismTransactions -eq 19 -and $fifthClaim.priorOriginalToolFailureRetained -eq $true -and $fifthClaim.step -ceq 'reinstall' -and $fifthClaim.manifestSha256 -ceq $ManifestSha256 -and $fifthClaim.finalBindingSha256 -ceq $FinalBindingSha256 -and $fifthClaim.cleanBuildReviewSha256 -ceq $cleanInput.Sha256 -and $fifthClaim.behaviorApplicabilityReviewSha256 -ceq $behaviorInput.Sha256 -and $fifthClaim.ordinal4ExitSha256 -ceq $fourthInput.Sha256 -and $fifthClaim.ordinal4StateSha256 -ceq $stateInput.Sha256 -and $fifthClaim.ordinal4RetirementEvidenceSha256 -ceq $retirementInput.Sha256 -and $fifthClaim.productCode -ceq $candidate.product -and $fifthClaim.candidateExeSha256 -ceq $candidate.artifacts.exe.sha256 -and $fifthClaim.candidateMsiSha256 -ceq $candidate.artifacts.msi.sha256 -and $fifthClaim.nativeSha256 -ceq $candidate.artifacts.exe.sha256 -and $fifthClaim.expectedExit -eq 0 -and $fifthClaim.budgetMs -eq 180000 -and $fifthExit.transactionOrdinal -eq 5 -and $fifthExit.step -ceq 'reinstall' -and $fifthExit.exited -eq $true -and $fifthExit.actualExit -eq 0 -and $fifthExit.expectedExit -eq 0 -and $fifthExit.durationMs -ge 0 -and $fifthExit.durationMs -le 180000) '第5/6次最终输入或真实退出不一致'
  }
  $candidateStem = 'final-candidate'
} else {
  Require ($Step -notin @('reinstall','final-uninstall')) '第5/6次必须绑定选定最终洁净包'
}
$interactive = $Step -in @('upgrade','reinstall')
$nativePath = if ($interactive) { Join-Path $protectedRoot ($candidateStem + '.exe') } else { Join-Path ([Environment]::GetFolderPath('Windows')) 'System32/msiexec.exe' }
if (!$interactive) { Protected ([Environment]::GetFolderPath('Windows')); Protected ([IO.Path]::GetDirectoryName($nativePath)) }
Protected $nativePath
$nativeSha256 = Digest $nativePath
$expected = if ($Step -eq 'running-reject') { 1603 } else { 0 }
$arguments = if ($interactive) { @() } else { @('/x',$candidate.product,'/qn','/norestart','/l*v',('"' + (Join-Path $protectedRoot ('direct-' + $Step + '.msi.log')) + '"')) }
$claim = [ordered]@{ schema=1; step=$Step; transactionOrdinal=$ordinal; maximumTransactions=6; priorMechanismTransactions=19; priorOriginalToolFailureRetained=$true; manifestSha256=$ManifestSha256; finalBindingSha256=$(if ($null -ne $finalBinding) { $FinalBindingSha256 } else { $null }); cleanBuildReviewSha256=$(if ($null -ne $finalBinding) { $cleanInput.Sha256 } else { $null }); behaviorApplicabilityReviewSha256=$(if ($null -ne $finalBinding) { $behaviorInput.Sha256 } else { $null }); ordinal4ExitSha256=$(if ($null -ne $finalBinding) { $fourthInput.Sha256 } else { $null }); ordinal4StateSha256=$(if ($null -ne $finalBinding) { $stateInput.Sha256 } else { $null }); ordinal4RetirementEvidenceSha256=$(if ($null -ne $finalBinding) { $retirementInput.Sha256 } else { $null }); ordinal5ClaimSha256=$(if ($Step -eq 'final-uninstall') { $fifthClaimInput.Sha256 } else { $null }); ordinal5ExitSha256=$(if ($Step -eq 'final-uninstall') { $fifthExitInput.Sha256 } else { $null }); productCode=$candidate.product; candidateExeSha256=$(if ($null -ne $finalBinding) { $candidate.artifacts.exe.sha256 } else { $null }); candidateMsiSha256=$(if ($null -ne $finalBinding) { $candidate.artifacts.msi.sha256 } else { $null }); recorderSha256=(Digest $PSCommandPath); nativePath=$nativePath; nativeSha256=$nativeSha256; args=$arguments; expectedExit=$expected; budgetMs=180000; createdUtc=[DateTime]::UtcNow.ToString('O') }
Save ('direct-' + $Step + '-claim.json') $claim
$timer = [Diagnostics.Stopwatch]::StartNew()
if ($interactive) { $native = Start-Process -FilePath $nativePath -Verb RunAs -PassThru }
else { $native = Start-Process -FilePath $nativePath -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -PassThru }
$startTicks = $native.StartTime.ToUniversalTime().Ticks
Save ('direct-' + $Step + '-process.json') ([ordered]@{ pid=$native.Id; startTicks=$startTicks; nativePath=$nativePath; utc=[DateTime]::UtcNow.ToString('O') })
while (!$native.WaitForExit(500) -and $timer.ElapsedMilliseconds -lt 180000) { }
$exited = $native.HasExited
$actual = if ($exited) { $native.ExitCode } else { $null }
$exitTicks = if ($exited) { $native.ExitTime.ToUniversalTime().Ticks } else { $null }
Save ('direct-' + $Step + '-exit.json') ([ordered]@{ step=$Step; transactionOrdinal=$ordinal; pid=$native.Id; startTicks=$startTicks; exitTicks=$exitTicks; durationMs=$timer.ElapsedMilliseconds; exited=$exited; actualExit=$actual; expectedExit=$expected; msiChildObservation=$(if ($interactive) { 'NOTOBSERVED；原生wrapper总寿命提供保守上界' } else { '直接系统msiexec' }); temporaryObservation='NOTOBSERVED；复用未变NSIS机制的已审输入与约束'; forcedTermination=$false; utc=[DateTime]::UtcNow.ToString('O') })
Require ($exited -and $actual -eq $expected -and $timer.ElapsedMilliseconds -le 180000) '真实退出或180秒期限不满足；保留原现场，不终止/重试'
Write-Output ('原生事务已退出：' + $Step + ' ordinal=' + $ordinal + '/6 exit=' + $actual + '；安装状态与人工观察另行审核')
