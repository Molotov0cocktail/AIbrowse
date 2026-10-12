[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$run = Join-Path $repository ('log/browser-settings-20261012/output-selection-test-' + [Guid]::NewGuid().ToString('N'))
$checks = [Collections.Generic.List[string]]::new()
function Need([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }
function WriteText([string]$path, [string]$value) {
  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
  [IO.File]::WriteAllText($path, $value, [Text.UTF8Encoding]::new($false))
}
function Save([string]$path, $value) { WriteText $path ($value | ConvertTo-Json -Depth 24) }
function Fact([string]$base, [string]$relative) {
  $path = Join-Path $base $relative
  return [ordered]@{ path = $relative; bytes = (Get-Item -LiteralPath $path).Length; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
}
function Inventory([string]$base) {
  return @(Get-ChildItem -LiteralPath $base -Recurse -File | ForEach-Object { Fact $base ([IO.Path]::GetRelativePath($base, $_.FullName).Replace('\', '/')) } | Sort-Object { $_.path })
}
function Same($expected, $actual) { Need (($expected | ConvertTo-Json -Depth 24 -Compress) -ceq ($actual | ConvertTo-Json -Depth 24 -Compress)) '旧树字节变化' }
function InvokeFixtureGit([string[]]$arguments) {
  & git -C $script:fixture @arguments | Out-Null
  Need ($LASTEXITCODE -eq 0) '合成 Git 操作失败'
}
# Synthetic trees contain text fixtures, so process observations are controlled independently
# of the real product qualification running elsewhere in the workspace.
$global:AIbrowseOutputSelectionSyntheticProcess = ''
function Get-Process {
  param([string[]]$Name, [string]$ErrorAction)
  if ($global:AIbrowseOutputSelectionSyntheticProcess -in $Name) { return [pscustomobject]@{ ProcessName = $global:AIbrowseOutputSelectionSyntheticProcess } }
}
function Rebind {
  Save $script:manifestPath $script:manifest
  $script:review.manifestSha256 = (Fact $script:release 'build-provenance.json').sha256
  Save $script:reviewPath $script:review
}
function Fixture([string]$name, [string]$source) {
  $script:fixture = Join-Path $run $name
  $script:tool = Join-Path $fixture 'tools/browser-library-runtime/select-output.ps1'
  WriteText $tool $source
  WriteText (Join-Path $fixture '.gitignore') "/release/`n/output/`n/log/`n"
  WriteText (Join-Path $fixture 'tracked.txt') '合成源码'
  InvokeFixtureGit @('init', '--quiet')
  InvokeFixtureGit @('add', '.gitignore', 'tracked.txt', 'tools/browser-library-runtime/select-output.ps1')
  InvokeFixtureGit @('-c', 'user.name=AIbrowse fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'test: 合成候选选择仓库')
  $script:head = (& git -C $fixture rev-parse HEAD).Trim()
  $script:release = Join-Path $fixture 'release'; $script:output = Join-Path $fixture 'output'
  foreach ($relative in @('old.exe', 'old.msi', 'nested/identity.txt')) { WriteText (Join-Path $output $relative) ('旧合成原件：' + $relative) }
  $script:old = Inventory $output
  $script:payload = Join-Path $release 'win-unpacked'
  foreach ($relative in @('AIbrowse.exe', 'resources/app.asar', 'resources/lifecycle-guardian/guardian.exe', 'locales/zh-CN.pak')) { WriteText (Join-Path $payload $relative) ('新合成载荷：' + $relative) }
  $stem = 'AIbrowse-0.1.5-win-x64-internal'
  foreach ($relative in @(($stem + '.exe'), ($stem + '.msi'), 'installer-build.json', 'builder-debug.yml', 'AIbrowse-0.1.4-win-x64-internal.exe')) { WriteText (Join-Path $release $relative) ('合成封装：' + $relative) }
  $asar = Fact $payload 'resources/app.asar'
  $script:manifest = @{ schemaVersion = 1; candidateEligible = $true; source = @{ gitSha = $head; dirty = $false; version = '0.1.5' }; payload = @{ packageFiles = (Inventory $payload); executable = (Fact $payload 'AIbrowse.exe'); guardian = (Fact $payload 'resources/lifecycle-guardian/guardian.exe'); asar = @{ path = $asar.path; sha256 = $asar.sha256; headerSha256 = ('e' * 64); files = @() } }; installer = (Fact $release ($stem + '.exe')); msi = (Fact $release ($stem + '.msi')); installerBuild = (Fact $release 'installer-build.json') }
  $script:manifestPath = Join-Path $release 'build-provenance.json'
  $script:proofRelative = 'log/browser-settings-20261012/independent-review.md'
  WriteText (Join-Path $fixture $proofRelative) '合成独立审核材料；不是实际产品验收'
  $script:review = @{ sourceGitSha = $head; manifestSha256 = ''; decision = 'PASS'; scope = 'browser-settings-20261012'; proofs = @((Fact $fixture $proofRelative)); packageLaunchStatus = 'NOTRUN' }
  $script:reviewPath = Join-Path $fixture 'log/browser-settings-20261012/review.json'
  Rebind
}
function Reject([string]$name, [scriptblock]$operation) {
  $rejected = $false
  try { & $operation | Out-Null } catch { $rejected = $true }
  Need $rejected ('反例未拒绝：' + $name)
  Same $script:old (Inventory $script:output)
  $checks.Add($name)
}
function ReviewMutation([string]$name, [scriptblock]$mutate) {
  $saved = $review | ConvertTo-Json -Depth 24
  try { & $mutate $review; Save $reviewPath $review; Reject $name { & $tool -ReviewRecord $reviewPath } }
  finally { $script:review = $saved | ConvertFrom-Json -AsHashtable; Save $reviewPath $review }
}
function ManifestMutation([string]$name, [scriptblock]$mutate) {
  $saved = $manifest | ConvertTo-Json -Depth 24
  try { & $mutate $manifest; Rebind; Reject $name { & $tool -ReviewRecord $reviewPath } }
  finally { $script:manifest = $saved | ConvertFrom-Json -AsHashtable; Rebind }
}
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'select-output.ps1'))
$sourceSha256 = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'select-output.ps1')).Hash.ToLowerInvariant()
try {
  Fixture 'normal' $source
  $beforePlan = @(Get-ChildItem -LiteralPath (Join-Path $fixture 'log') -Recurse -File).Count
  $plan = (& $tool -ReviewRecord $reviewPath) | ConvertFrom-Json -AsHashtable
  Need ($plan.candidate.count -eq 8 -and $plan.previous.count -eq 3 -and $plan.packageLaunchStatus -ceq 'NOTRUN') '只读计划或 NOTRUN 边界不符'
  Need (@(Get-ChildItem -LiteralPath (Join-Path $fixture 'log') -Recurse -File).Count -eq $beforePlan) '只读计划写入了文件'
  Same $old (Inventory $output); $checks.Add('只读完整清单、零换包写入及 NOTRUN 保留')
  foreach ($processName in @('AIbrowse', 'guardian')) {
    $global:AIbrowseOutputSelectionSyntheticProcess = $processName
    Reject ('拒绝进程存在：' + $processName) { & $tool -ReviewRecord $reviewPath }
  }
  $global:AIbrowseOutputSelectionSyntheticProcess = ''
  ReviewMutation '审核拒绝结论' { param($v) $v.decision = 'REPAIR' }
  ReviewMutation '审核错误 scope' { param($v) $v.scope = 'old-scope' }
  ReviewMutation '审核错误 HEAD' { param($v) $v.sourceGitSha = 'f' * 40 }
  ReviewMutation '审核 manifest 不匹配' { param($v) $v.manifestSha256 = 'f' * 64 }
  ReviewMutation '审核未知字段' { param($v) $v.unreviewed = $true }
  ReviewMutation '审核空证明' { param($v) $v.proofs = @() }
  ReviewMutation '审核状态类型不是字符串' { param($v) $v.decision = @('PASS') }
  ReviewMutation '审核启动状态不允许 FAILED' { param($v) $v.packageLaunchStatus = 'FAILED' }
  ReviewMutation '证明 hash 不匹配' { param($v) $v.proofs[0].sha256 = 'e' * 64 }
  ReviewMutation '证明 bytes 非整数' { param($v) $v.proofs[0].bytes = 0.5 }
  ReviewMutation '证明重复' { param($v) $v.proofs = @($v.proofs[0], $v.proofs[0]) }
  ReviewMutation '证明越出 log' { param($v) $v.proofs[0] = Fact $fixture 'tracked.txt' }
  ReviewMutation '证明 parent traversal' { param($v) $v.proofs[0].path = 'log/../tracked.txt' }
  ReviewMutation '证明 ADS' { param($v) $v.proofs[0].path += ':stream' }
  ReviewMutation '证明自身引用' { param($v) $v.proofs[0] = Fact $fixture 'log/browser-settings-20261012/review.json' }
  WriteText (Join-Path $fixture 'tracked.txt') '未提交源码'
  Reject '真实 Git dirty' { & $tool -ReviewRecord $reviewPath }
  WriteText (Join-Path $fixture 'tracked.txt') '合成源码'
  ManifestMutation '候选源码不匹配' { param($v) $v.source.gitSha = 'e' * 40 }
  ManifestMutation '候选版本不匹配' { param($v) $v.source.version = '0.1.4' }
  ManifestMutation '候选 dirty' { param($v) $v.source.dirty = $true }
  ManifestMutation '候选不 eligible' { param($v) $v.candidateEligible = $false }
  ManifestMutation '候选重复文件' { param($v) $v.payload.packageFiles += $v.payload.packageFiles[0] }
  ManifestMutation '候选漏列文件' { param($v) $v.payload.packageFiles = @($v.payload.packageFiles | Select-Object -Skip 1) }
  ManifestMutation '候选文件错 hash' { param($v) $v.payload.packageFiles[0].sha256 = 'd' * 64 }
  ManifestMutation '候选旧安装器名' { param($v) $v.installer.path = 'AIbrowse-0.1.4-win-x64-internal.exe' }
  $savedReview = [IO.File]::ReadAllText($reviewPath)
  WriteText $reviewPath ('{"decision":"PASS",' + $savedReview.Substring(1))
  Reject 'JSON 重复字段' { & $tool -ReviewRecord $reviewPath }
  WriteText $reviewPath $savedReview
  $extra = Join-Path $payload 'unlisted.txt'; WriteText $extra '未列入清单'
  Reject '包目录存在未列入文件' { & $tool -ReviewRecord $reviewPath }
  [IO.File]::Move($extra, (Join-Path $fixture 'log/unlisted-retained.txt'))
  $proofPath = Join-Path $fixture $proofRelative
  $alias = Join-Path $fixture 'log/proof-hardlink.md'
  New-Item -ItemType HardLink -Path $alias -Target $proofPath | Out-Null
  Reject '证明 hardlink' { & $tool -ReviewRecord $reviewPath }
  # Keep both old aliases; create a fresh regular proof instead of deleting evidence.
  $review.proofs[0].path = 'log/fresh-proof.md'; WriteText (Join-Path $fixture $review.proofs[0].path) '新单链接合成证明'
  $review.proofs[0] = Fact $fixture $review.proofs[0].path; Save $reviewPath $review
  $junction = Join-Path $fixture 'log/proof-junction'; New-Item -ItemType Junction -Path $junction -Target (Join-Path $fixture 'log/browser-settings-20261012') | Out-Null
  ReviewMutation '证明 reparse ancestor' { param($v) $v.proofs[0] = Fact $fixture 'log/proof-junction/independent-review.md' }
  $review.packageLaunchStatus = 'PASS'; Save $reviewPath $review
  $passPlan = (& $tool -ReviewRecord $reviewPath) | ConvertFrom-Json -AsHashtable
  Need ($passPlan.packageLaunchStatus -ceq 'PASS') '已审核启动 PASS 未保留'; $checks.Add('启动 PASS 与 NOTRUN 独立保留')
  $review.packageLaunchStatus = 'NOTRUN'; Save $reviewPath $review
  $selected = (& $tool -Action Switch -ReviewRecord $reviewPath) | ConvertFrom-Json -AsHashtable
  Need ($selected.passed -and $selected.originalBytesPreserved -and $selected.packageLaunchStatus -ceq 'NOTRUN') '完整选择结果失败'
  Same $old (Inventory $selected.backup)
  Same $passPlan.candidate.files (Inventory $output)
  Need (-not (Test-Path -LiteralPath (Join-Path $output 'builder-debug.yml')) -and -not (Test-Path -LiteralPath (Join-Path $output 'AIbrowse-0.1.4-win-x64-internal.exe'))) '复制了无关旧产物'
  $checks.Add('完整选择与旧树保留，不复制 debug 或旧安装器')
  $selectedPlanPath = Join-Path $selected.scope 'plan.json'; $selectedPlan = Get-Content -LiteralPath $selectedPlanPath -Raw | ConvertFrom-Json -AsHashtable
  $selectedPlan.backup = Join-Path $fixture 'log/other'; Save $selectedPlanPath $selectedPlan
  $rejected = $false; try { & $tool -Action Rollback -SwitchId $selected.id | Out-Null } catch { $rejected = $true }
  Need $rejected '篡改回退目录未拒绝'; Same $passPlan.candidate.files (Inventory $output); Same $old (Inventory $selected.backup)
  $checks.Add('回退计划不能改写固定目录')
  $selectedPlan.backup = $selected.backup; Save $selectedPlanPath $selectedPlan
  $rolled = (& $tool -Action Rollback -SwitchId $selected.id) | ConvertFrom-Json -AsHashtable
  Need $rolled.restored '回退未成功'; Same $old (Inventory $output)
  $retained = @(Get-ChildItem -LiteralPath $selected.scope -Directory | Where-Object { $_.Name.StartsWith('rolled-back-candidate-') })
  Need ($retained.Count -eq 1) '回退未保留完整新树'; Same $passPlan.candidate.files (Inventory $retained[0].FullName)
  & $tool -Action Rollback -SwitchId $selected.id | Out-Null
  Same $old (Inventory $output); $checks.Add('完整回退、保留新树及幂等重试')
  $needle = '[IO.Directory]::Move($output, $backup); $oldMoved = $true'
  Need ($source.Contains($needle)) '故障注入锚点失效'
  Fixture 'fault-after-old-move' ($source.Replace($needle, ($needle + "; throw '合成注入：旧目录移动后失败'")))
  Reject '旧目录已移动后失败自动回退' { & $tool -Action Switch -ReviewRecord $reviewPath }
  $failures = @(Get-ChildItem -LiteralPath (Join-Path $fixture 'log') -Recurse -File -Filter 'failure-*.json')
  Need ($failures.Count -eq 1) '故障现场缺失'
  $failure = Get-Content -LiteralPath $failures[0].FullName -Raw | ConvertFrom-Json -AsHashtable
  Need ($failure.oldMoved -and -not $failure.newMoved -and $failure.originalUntouchedOrRestored -and $null -eq $failure.rollbackError) '自动回退结论错误'
  Need (Test-Path -LiteralPath (Join-Path $failures[0].DirectoryName 'staging/build-provenance.json')) '失败 staging 被删除'
  $checks.Add('失败收据及 staging 现场保留')
  Fixture 'explicit-scope-version' $source
  $review.scope = 'watch-repair-20261012'
  $manifest.source.version = '0.1.6'
  foreach ($extension in @('exe', 'msi')) {
    $relative = 'AIbrowse-0.1.6-win-x64-internal.' + $extension
    WriteText (Join-Path $release $relative) ('合成新版本：' + $extension)
    $key = if ($extension -eq 'exe') { 'installer' } else { 'msi' }
    $manifest[$key] = Fact $release $relative
  }
  Rebind
  Reject '新任务不能误用历史默认范围' { & $tool -ReviewRecord $reviewPath -ExpectedVersion '0.1.6' }
  Reject '新版本不能误用历史默认版本' { & $tool -ReviewRecord $reviewPath -QualificationScope 'watch-repair-20261012' }
  Reject '任务范围拒绝父目录' { & $tool -ReviewRecord $reviewPath -QualificationScope '../watch-repair' -ExpectedVersion '0.1.6' }
  Reject '任务版本拒绝路径' { & $tool -ReviewRecord $reviewPath -QualificationScope 'watch-repair-20261012' -ExpectedVersion '../0.1.6' }
  $selected = (& $tool -Action Switch -ReviewRecord $reviewPath -QualificationScope 'watch-repair-20261012' -ExpectedVersion '0.1.6') | ConvertFrom-Json -AsHashtable
  Need ($selected.scope.StartsWith((Join-Path $fixture 'log/watch-repair-20261012') + [IO.Path]::DirectorySeparatorChar)) '新任务证据目录不符'
  Same $old (Inventory $selected.backup)
  $rolled = (& $tool -Action Rollback -SwitchId $selected.id -QualificationScope 'watch-repair-20261012' -ExpectedVersion '0.1.6') | ConvertFrom-Json -AsHashtable
  Need $rolled.restored '显式范围回退失败'; Same $old (Inventory $output)
  $checks.Add('显式任务与版本完整换包和回退，历史默认兼容')
  $result = @{ passed = $true; scope = 'synthetic-output-selection'; productLaunched = $false; candidateToolSha256 = $sourceSha256; testSha256 = (Get-FileHash -LiteralPath $PSCommandPath).Hash.ToLowerInvariant(); count = $checks.Count; checks = $checks.ToArray(); retained = $run }
  Save (Join-Path $run 'result.json') $result
  $result | ConvertTo-Json -Depth 5
} catch {
  Save (Join-Path $run 'failure.json') @{ passed = $false; checks = $checks.ToArray(); error = $_.Exception.Message; stack = $_.ScriptStackTrace; candidateToolSha256 = $sourceSha256 }
  throw
}
