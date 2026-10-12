[CmdletBinding()]
param(
  [ValidateSet('CheckOnly','Switch','Rollback')][string]$Action='CheckOnly',
  [string]$PackageJournal='',
  [ValidateSet('PackageSmoke','EquivalentEvidence')][string]$Qualification='PackageSmoke',
  [string]$EquivalenceRecord='',
  [ValidateSet('legacy-followup-20261012','real-provider-20261012')][string]$EvidenceScope='legacy-followup-20261012',
  [ValidatePattern('^[a-f0-9]{32}$')][string]$SwitchId=''
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$release=Join-Path $repository 'release'
$output=Join-Path $repository 'output'
$evidence=Join-Path $repository ('log/'+$EvidenceScope)
function Need([bool]$value,[string]$message){if(-not $value){throw $message}}
function SafePath([string]$path) {
  $full=[IO.Path]::GetFullPath($path)
  Need ($full.StartsWith($repository+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) '路径越出固定项目目录'
  for($part=$full;$part;$part=[IO.Path]::GetDirectoryName($part)) {
    if(Test-Path -LiteralPath $part){Need (((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) '路径含重解析点'}
  }
  return $full
}
function Member([string]$base,[string]$relative) {
  Need (-not [string]::IsNullOrWhiteSpace($relative) -and $relative -notmatch '[:\\]' -and -not [IO.Path]::IsPathRooted($relative)) '成员路径不是相对路径'
  foreach($part in $relative.Split('/')){Need ($part -ne '' -and $part -ne '.' -and $part -ne '..' -and $part.TrimEnd(' ','.') -ceq $part -and $part.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -lt 0) '成员路径不安全'}
  $full=SafePath (Join-Path $base $relative)
  Need ($full.StartsWith($base+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) '成员越出目录'
  return $full
}
function FileFact([string]$path,[string]$relative) {
  $full=SafePath $path
  $item=Get-Item -LiteralPath $full -Force
  Need ($item -is [IO.FileInfo] -and $item.Length -le 1073741824) '不是预算内普通文件'
  $stream=[IO.File]::Open($full,'Open','Read','Read')
  try{$bytes=$stream.Length;$sha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant();Need ($stream.Length -eq $bytes) '文件读取期间变化'}finally{$stream.Dispose()}
  return [ordered]@{path=$relative;bytes=$bytes;sha256=$sha}
}
function Tree([string]$base) {
  [void](SafePath $base)
  Need ((Get-Item -LiteralPath $base -Force) -is [IO.DirectoryInfo]) '树根不是普通目录'
  $queue=[Collections.Generic.Queue[string]]::new();$queue.Enqueue($base)
  $files=[Collections.Generic.List[object]]::new();$total=0L;$visited=0
  while($queue.Count -gt 0) {
    foreach($item in Get-ChildItem -LiteralPath ($queue.Dequeue()) -Force) {
      $visited++;Need ($visited -le 8192) '目录成员超限'
      [void](SafePath $item.FullName)
      if($item.PSIsContainer){$queue.Enqueue($item.FullName)}else {
        $relative=[IO.Path]::GetRelativePath($base,$item.FullName).Replace('\','/')
        $fact=FileFact $item.FullName $relative;$total+=$fact.bytes
        Need ($files.Count -lt 4096 -and $total -le 2147483648) '文件数量或字节预算超限'
        $files.Add($fact)
      }
    }
  }
  return @($files|Sort-Object path)
}
function AssertFiles([string]$base,$expected) {
  $actual=@(Tree $base);Need ($actual.Count -eq $expected.Count) '成员数量变化'
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $map=@{};foreach($fact in $actual){$map[$fact.path]=$fact}
  foreach($fact in $expected) {
    [void](Member $base $fact.path)
    Need ($seen.Add($fact.path) -and $map.ContainsKey($fact.path)) '成员缺失或重复'
    Need ($fact.sha256 -cmatch '^[a-f0-9]{64}$' -and $map[$fact.path].bytes -eq $fact.bytes -and $map[$fact.path].sha256 -ceq $fact.sha256) '成员字节或摘要变化'
  }
}
function ReadJson([string]$path) {
  $fact=FileFact $path ([IO.Path]::GetFileName($path));Need ($fact.bytes -le 4194304) 'JSON预算超限'
  return Get-Content -LiteralPath $path -Raw|ConvertFrom-Json
}
function NewJson([string]$path,$value) {
  [void](SafePath $path)
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($value|ConvertTo-Json -Depth 24))
  $stream=[IO.File]::Open($path,'CreateNew','Write','Read')
  try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Idle {
  Need (@(Get-Process -Name AIbrowse,guardian -ErrorAction SilentlyContinue).Count -eq 0) '应用或guardian尚未退出，禁止换包'
}
function Head {
  $value=& git -C $repository rev-parse HEAD
  Need ($LASTEXITCODE -eq 0 -and $value -cmatch '^[a-f0-9]{40}$') '无法确认当前源码'
  $dirty=@(& git -C $repository status --porcelain=v1 --untracked-files=all)
  Need ($LASTEXITCODE -eq 0 -and $dirty.Count -eq 0) '当前项目源码工作区不干净'
  return $value
}
function AssertSource([string]$source,[string]$current) {
  Need ($source -cmatch '^[a-f0-9]{40}$') '来源源码身份无效'
  if($Qualification -eq 'PackageSmoke' -or $EvidenceScope -eq 'real-provider-20261012'){Need ($source -ceq $current) '包来源不是当前源码';return}
  & git -C $repository merge-base --is-ancestor $source $current
  Need ($LASTEXITCODE -eq 0) '包来源不是当前源码祖先'
  $changed=@(& git -C $repository diff --name-only --no-renames $source $current --)
  Need ($LASTEXITCODE -eq 0) '无法核对来源源码差量'
  $allowed=@('doc/tasks/legacy-repair.md','doc/tasks/progress.md','tools/legacy-followup/output-switch.ps1','tools/legacy-followup/output-switch.test.ps1')
  foreach($path in $changed){Need ($path -cin $allowed) '来源之后存在产品、构建或依赖差量'}
}
function TrueValue($value){return ($value -is [bool] -and $value)}
function ExactKeys($value,[string[]]$names) {
  Need ($null -ne $value -and @($value.PSObject.Properties).Count -eq $names.Count) '证明字段集合不闭合'
  foreach($name in $names){Need ($null -ne $value.PSObject.Properties[$name]) '证明缺少固定字段'}
}
function SameValue($first,$second) {return (($first|ConvertTo-Json -Depth 24 -Compress) -ceq ($second|ConvertTo-Json -Depth 24 -Compress))}
function BoundProof($proof,[Collections.Generic.List[object]]$collected,[bool]$currentScope=$true) {
  ExactKeys $proof @('path','bytes','sha256')
  Need ($proof.path -is [string] -and $proof.sha256 -cmatch '^[a-f0-9]{64}$') '证明路径或摘要无效'
  if($currentScope){Need ($proof.path.StartsWith('log/real-provider-20261012/',[StringComparison]::Ordinal)) '证明不属于本轮固定目录'}
  $actual=FileFact (Member $repository $proof.path) $proof.path
  Need ($actual.bytes -eq $proof.bytes -and $actual.sha256 -ceq $proof.sha256) '证明字节或摘要不匹配'
  $collected.Add($actual)
  return (Member $repository $proof.path)
}
function AssertValidatorSupplement($proofs,[Collections.Generic.List[object]]$collected) {
  $supplement=ReadJson (Member $repository $proofs.validatorSupplement.path)
  ExactKeys $supplement @('version','scope','passed','rawModelOutputRevalidated','networkCalls','product','researchBinding','tests','replay')
  Need ($supplement.version -eq 1 -and $supplement.scope -ceq 'saved-result-validator-compatibility' -and (TrueValue $supplement.passed) -and $supplement.rawModelOutputRevalidated -is [bool] -and -not $supplement.rawModelOutputRevalidated -and $supplement.networkCalls -is [long] -and $supplement.networkCalls -eq 0) 'validator补证范围或诚实边界不符'
  ExactKeys $supplement.product @('path','beforeSha256','afterSha256')
  $product=$supplement.product
  Need ($product.path -ceq 'src/main/research/result-validator.ts' -and $product.beforeSha256 -cmatch '^[a-f0-9]{64}$' -and $product.afterSha256 -cmatch '^[a-f0-9]{64}$' -and $product.beforeSha256 -cne $product.afterSha256) 'validator补证不是唯一允许的实际源码差量'
  [void](BoundProof $supplement.researchBinding $collected)
  Need ($supplement.researchBinding.path -ceq $proofs.researchBinding.path -and $supplement.researchBinding.bytes -eq $proofs.researchBinding.bytes -and $supplement.researchBinding.sha256 -ceq $proofs.researchBinding.sha256) 'validator补证不是当前选定研究运行'
  $binding=ReadJson (Member $repository $proofs.researchBinding.path)
  Need ($binding.sources.($product.path) -ceq $product.beforeSha256) 'validator补证before不是实际研究源码'
  $current=FileFact (Member $repository $product.path) $product.path
  Need ($current.sha256 -ceq $product.afterSha256) 'validator补证after不是当前源码';$collected.Add($current)
  ExactKeys $supplement.tests @('exitCode','passed','independentPassed','log')
  Need ($supplement.tests.exitCode -is [long] -and $supplement.tests.exitCode -eq 0 -and $supplement.tests.passed -eq 88 -and $supplement.tests.independentPassed -eq 31) 'validator补证修后测试或独审反例不完整'
  [void](BoundProof $supplement.tests.log $collected)
  ExactKeys $supplement.replay @('exitCode','report','log')
  Need ($supplement.replay.exitCode -is [long] -and $supplement.replay.exitCode -eq 0) 'validator补证离线回放未通过'
  $reportPath=BoundProof $supplement.replay.report $collected
  [void](BoundProof $supplement.replay.log $collected)
  $replayDirectory=[IO.Path]::GetDirectoryName($supplement.replay.report.path).Replace('\','/')
  Need ($replayDirectory -cmatch '^log/real-provider-20261012/validator-replay-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -and $supplement.replay.report.path -ceq ($replayDirectory+'/report.json') -and $supplement.replay.log.path -ceq ($replayDirectory+'/process-output.log')) 'validator回放证据不属于同一固定运行'
  $replay=ReadJson $reportPath
  ExactKeys $replay @('version','scope','passed','rawModelOutputRevalidated','networkCalls','readOnlyDatabase','databaseUnchanged','normalizedResultUnchanged','validationPassed','fieldChecks','conflictOrder','database','validator','counts')
  Need ($replay.version -eq 1 -and $replay.scope -ceq 'saved-result-validator-compatibility' -and (TrueValue $replay.passed) -and $replay.rawModelOutputRevalidated -is [bool] -and -not $replay.rawModelOutputRevalidated -and $replay.networkCalls -is [long] -and $replay.networkCalls -eq 0 -and $replay.conflictOrder -ceq 'restored-by-persisted-result-ids') 'validator回放夸大原始模型输出或范围'
  foreach($name in @('readOnlyDatabase','databaseUnchanged','normalizedResultUnchanged','validationPassed')){Need (TrueValue $replay.$name) 'validator只读回放或结果恒等未通过'}
  $fields=@('resultId','taskId','title','summary','blocks','evidenceMap','conflicts','coverage','fetchedAt');ExactKeys $replay.fieldChecks $fields
  foreach($name in $fields){Need (TrueValue $replay.fieldChecks.$name) 'validator回放字段不恒等'}
  ExactKeys $replay.counts @('tasks','results','blocks','evidence','claims','conflicts')
  Need ($replay.counts.tasks -eq 1 -and $replay.counts.results -eq 1 -and $replay.counts.blocks -eq 4 -and $replay.counts.evidence -eq 12 -and $replay.counts.claims -eq 3 -and $replay.counts.conflicts -eq 2) 'validator回放不是已审核结果投影'
  $researchDirectory=[IO.Path]::GetDirectoryName($proofs.researchBinding.path).Replace('\','/')
  $databasePrefix=$researchDirectory+'/research/'
  Need ($replay.database.path.StartsWith($databasePrefix,[StringComparison]::Ordinal) -and $replay.database.path.Substring($databasePrefix.Length) -cmatch '^research-scenarios-[A-Za-z0-9]{6}/research\.db$') 'validator回放数据库不属于选定研究运行'
  Need ($replay.validator.path -ceq $product.path -and $replay.validator.sha256 -ceq $product.afterSha256) 'validator回放未使用修后校验器'
  [void](BoundProof $replay.database $collected)
  [void](BoundProof $replay.validator $collected $false)
  return $product
}
function AssertCampaign([string]$phase,$proofs,[Collections.Generic.List[object]]$collected,$validatorDelta) {
  $resultProof=$proofs.($phase+'Result');$bindingProof=$proofs.($phase+'Binding');$processProof=$proofs.($phase+'Process')
  $directory=[IO.Path]::GetDirectoryName($resultProof.path).Replace('\','/')
  Need ($directory -cmatch '^log/real-provider-20261012/campaign-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -and $resultProof.path -ceq ($directory+'/result.json') -and $bindingProof.path -ceq ($directory+'/binding.json') -and $processProof.path -ceq ($directory+'/process-result.json')) '真实场景三项证据未绑定同一运行'
  $result=ReadJson (Member $repository $resultProof.path);$binding=ReadJson (Member $repository $bindingProof.path);$process=ReadJson (Member $repository $processProof.path)
  Need ($result.phase -ceq $phase -and (TrueValue $result.finished) -and $null -eq $result.fatal -and (TrueValue $result.credentialsDeleted)) '真实场景未正常结束或凭据未清理'
  Need ($process.phase -ceq $phase -and $process.root -ceq (Member $repository $directory) -and (TrueValue $process.exited) -and $process.exitCode -is [long] -and $process.exitCode -eq 0 -and $null -eq $process.signal) '真实场景进程未正常退出'
  if($phase -ne 'probe'){Need (TrueValue $result.browserDisposed) '真实场景浏览器未清理'}
  $limit=switch($phase){'probe'{2};'conversation'{14};'research'{16}}
  Need ($result.budget -eq 28 -and $binding.requestBudget -eq 28 -and $binding.lifetimeMs -eq 900000 -and $result.networkRequests -ge 1 -and $result.networkRequests -le $limit -and @($result.calls).Count -eq $result.networkRequests) '真实场景请求账本或预算不符'
  $cancelled=0
  foreach($call in $result.calls){
    Need ($call.status -eq 200) '真实场景存在非成功HTTP响应'
    if(-not (TrueValue $call.done) -or @($call.errors).Count -gt 0){
      Need ($phase -eq 'conversation' -and -not (TrueValue $call.done) -and @($call.errors|Where-Object {$_ -cne 'aborted'}).Count -eq 0) '真实场景存在未完成或失败流'
      $cancelled++
    }
  }
  Need ($cancelled -le 1) '真实取消流数量越界'
  $expectedCases=if($phase -eq 'probe'){2}else{1}
  Need (@($result.cases).Count -eq $expectedCases) '真实场景结果数量不符'
  foreach($case in $result.cases){Need (TrueValue $case.passed) '真实场景未通过'}
  if($phase -eq 'conversation'){
    $case=$result.cases[0];Need (TrueValue $case.drained) '真实会话未排水'
    $names=@('实时共读来源A','同会话切页来源B','在途互斥与真实流取消','Agent实际读取来源A','同会话第二次Agent工具历史重放','L2表单拒绝无导航','L2表单允许后实际提交','敌对网页共读结构边界')
    Need (@($case.cases).Count -eq $names.Count) '真实会话子场景不完整'
    foreach($name in $names){$rows=@($case.cases|Where-Object {$_.name -ceq $name});Need ($rows.Count -eq 1 -and (TrueValue $rows[0].passed)) '真实会话子场景未通过或重复'}
    Need (($case.cases|Where-Object {$_.name -ceq '在途互斥与真实流取消'}).terminal -ceq 'aborted') '真实取消终态缺失'
  }
  if($phase -eq 'research'){
    $names=@('sourceStoreEmpty','twoGoalCandidates','capturesPerSource','evidencePerSource','claimsLinked','resultLinked','ownershipIsolated','transferValid','cleanupComplete','withinProviderBudget')
    ExactKeys $result.cases[0].checks $names
    foreach($name in $names){Need (TrueValue $result.cases[0].checks.$name) '真实Research验收项未通过'}
  }
  $bundlePath=Member $repository ($directory+'/entry.cjs');$bundle=FileFact $bundlePath ($directory+'/entry.cjs')
  Need ($bundle.sha256 -ceq $binding.bundle) '真实场景bundle绑定变化';$collected.Add($bundle)
  $electron=FileFact (Member $repository 'node_modules/electron/dist/electron.exe') 'node_modules/electron/dist/electron.exe'
  Need ($electron.sha256 -ceq $binding.electron) '真实场景Electron绑定变化';$collected.Add($electron)
  $required=@('src/main/ai/provider/openai-compatible.ts')
  if($phase -eq 'conversation'){$required+=@('src/main/ai/conversation-service.ts','src/main/ai/agent/agent-loop.ts')}
  if($phase -eq 'research'){$required+=@('src/main/research/research-runtime.ts','src/main/research/synthesis/research-prompts.ts','src/main/research/result-validator.ts')}
  foreach($path in $required){Need ($null -ne $binding.sources.PSObject.Properties[$path]) '真实场景缺少关键源码绑定'}
  # Reuse earlier phases only for unchanged applicable production modules.
  foreach($property in $binding.sources.PSObject.Properties){
    $path=$property.Name
    if(-not $path.StartsWith('src/',[StringComparison]::Ordinal)){continue}
    if($phase -ne 'research' -and $path.StartsWith('src/main/research/',[StringComparison]::Ordinal)){continue}
    $fact=FileFact (Member $repository $path) $path
    $supplemented=$phase -eq 'research' -and $path -ceq 'src/main/research/result-validator.ts' -and $path -ceq $validatorDelta.path -and $property.Value -ceq $validatorDelta.beforeSha256 -and $fact.sha256 -ceq $validatorDelta.afterSha256
    Need ($fact.sha256 -ceq $property.Value -or $supplemented) '真实场景适用产品源码已变化';$collected.Add($fact)
  }
}
function AssertCompositeTests($test,[string]$sourceGitSha,[Collections.Generic.List[object]]$collected) {
  ExactKeys $test @('mode','scope','historicalRootCause','full','replacement','control','deduplicated','review')
  Need ($test.mode -ceq 'bounded-composite' -and $test.scope -ceq 'conversation-service-rename-eperm' -and $test.historicalRootCause -ceq 'unknown') '组合验收范围或历史unknown边界不符'
  ExactKeys $test.full @('exitCode','exit','log','passed','failed','skipped','unchangedFilesPassed')
  Need ($test.full.exitCode -is [long] -and $test.full.exitCode -eq 1 -and $test.full.passed -eq 6954 -and $test.full.failed -eq 1 -and $test.full.skipped -eq 3 -and $test.full.unchangedFilesPassed -eq 472) '组合验收改写原全量失败'
  $fullLog=BoundProof $test.full.log $collected;$fullExit=ReadJson (BoundProof $test.full.exit $collected)
  Need ($fullExit.exitCode -eq 1 -and $fullExit.log -ceq $test.full.log.path -and $test.full.log.bytes -le 16777216) '原全量退出或日志绑定不符'
  $text=[IO.File]::ReadAllText($fullLog)
  $target='src/main/ai/conversation-service.test.ts'
  $failures=[regex]::Matches($text,'(?m)^\s*FAIL\s+([^\r\n>]+)\s*>')
  Need ($failures.Count -eq 1 -and $failures[0].Groups[1].Value.Trim() -ceq $target -and $text.Contains($target+' (60 tests | 1 failed)') -and $text.Contains('stage=rename') -and $text.Contains('code=EPERM') -and $text -match 'Test Files\s+1 failed \| 472 passed \| 1 skipped \(474\)' -and $text -match 'Tests\s+1 failed \| 6954 passed \| 3 skipped \(6958\)') '原全量日志不是唯一固定失败及未影响结果'
  ExactKeys $test.replacement @('path','exitCode','report','log','passed','beforeTestSha256','afterTestSha256','beforeSource','patch')
  $replacement=$test.replacement
  Need ($replacement.path -ceq $target -and $replacement.exitCode -is [long] -and $replacement.exitCode -eq 0 -and $replacement.passed -eq 60) '补验必须是固定文件完整60项'
  $beforePath=BoundProof $replacement.beforeSource $collected
  $after=FileFact (Member $repository $target) $target;$collected.Add($after)
  Need ($replacement.beforeTestSha256 -ceq $replacement.beforeSource.sha256 -and $replacement.afterTestSha256 -ceq $after.sha256 -and $replacement.beforeSource.bytes -le 1048576 -and $after.bytes -le 1048576) '补验插桩前后测试源码未绑定'
  $beforeText=[IO.File]::ReadAllText($beforePath).Replace("`r`n","`n");$afterText=[IO.File]::ReadAllText((Member $repository $target)).Replace("`r`n","`n")
  $marker='// ---------- 测试替身 ----------'
  $beforeIndex=$beforeText.IndexOf($marker,[StringComparison]::Ordinal);$afterIndex=$afterText.IndexOf($marker,[StringComparison]::Ordinal)
  Need ($beforeIndex -ge 0 -and $afterIndex -ge 0 -and $beforeText.Substring($beforeIndex) -ceq $afterText.Substring($afterIndex)) '插桩改变原测试替身或60项断言'
  $patchPath=BoundProof $replacement.patch $collected;Need ($replacement.patch.bytes -le 1048576) '插桩补丁超限'
  $patchText=[IO.File]::ReadAllText($patchPath)
  $headers=[regex]::Matches($patchText,'(?m)^diff --git ([^\r\n]+)')
  Need ($headers.Count -eq 1 -and $headers[0].Groups[1].Value -ceq ('a/'+$target+' b/'+$target)) '插桩补丁不是唯一固定测试文件'
  ExactKeys $test.control @('path','source','report','log','passed','lockResult')
  $control=$test.control
  Need ($control.path -ceq 'tools/real-provider/conversation-lock-diagnostic.test.ts' -and $control.source.path -ceq $control.path -and $control.passed -eq 1) '锁控制不是固定独立反例'
  [void](BoundProof $control.source $collected $false)
  foreach($part in @($replacement,$control)){
    $report=ReadJson (BoundProof $part.report $collected);[void](BoundProof $part.log $collected)
    Need ((TrueValue $report.success) -and $report.numFailedTests -eq 0 -and $report.numPendingTests -eq 0 -and $report.numTodoTests -eq 0) '补验报告含失败或跳过'
    $rows=@($report.testResults|Where-Object {([IO.Path]::GetFullPath($_.name)) -ceq (Member $repository $part.path)})
    Need ($rows.Count -eq 1 -and $rows[0].status -ceq 'passed' -and @($rows[0].assertionResults).Count -eq $part.passed) '补验报告未覆盖精确文件及全部断言'
    foreach($assertion in $rows[0].assertionResults){Need ($assertion.status -ceq 'passed' -and @($assertion.failureMessages).Count -eq 0) '补验原断言未通过'}
  }
  Need ($control.lockResult.path -cmatch '^log/conversation-lock-diagnostic/case-[A-Za-z0-9]{6}/result\.json$') '真实锁证明路径不属于固定控制场'
  $locked=ReadJson (BoundProof $control.lockResult $collected $false)
  ExactKeys $locked @('controlWrites','saved','oldIndexPreserved','temporaryPreserved','exitCode','forcedCleanup')
  Need ($locked.controlWrites -eq 50 -and $locked.saved -is [bool] -and -not $locked.saved -and (TrueValue $locked.oldIndexPreserved) -and (TrueValue $locked.temporaryPreserved) -and $locked.exitCode -eq 0 -and $locked.forcedCleanup -is [bool] -and -not $locked.forcedCleanup) '真实Windows锁控制或自然退出未通过'
  ExactKeys $test.deduplicated @('passed','skipped','additionalControlPassed')
  Need ($test.deduplicated.passed -eq 6955 -and $test.deduplicated.passed -eq ($test.full.passed-59+$replacement.passed) -and $test.deduplicated.skipped -eq 3 -and $test.deduplicated.additionalControlPassed -eq 1) '组合计数重复或减少覆盖'
  $review=ReadJson (BoundProof $test.review $collected)
  ExactKeys $review @('version','sourceGitSha','conclusion','proofs','report')
  Need ($review.version -eq 1 -and $review.sourceGitSha -ceq $sourceGitSha -and $review.conclusion -ceq 'PASS_WITH_UNKNOWN_HISTORICAL_EPERM') '组合验收未获限定独审'
  $proofs=@{fullLog=$test.full.log;fullExit=$test.full.exit;replacementReport=$replacement.report;replacementLog=$replacement.log;beforeSource=$replacement.beforeSource;patch=$replacement.patch;controlSource=$control.source;controlReport=$control.report;controlLog=$control.log;lockResult=$control.lockResult}
  ExactKeys $review.proofs @($proofs.Keys)
  foreach($name in $proofs.Keys){Need ($review.proofs.$name -ceq $proofs[$name].sha256) '组合独审未绑定完整证明'}
  [void](BoundProof $review.report $collected)
}
function AssertProviderEvidence($record,$manifest,$manifestFact,[Collections.Generic.List[object]]$collected) {
  ExactKeys $record @('version','qualification','passed','scope','packageLaunchTested','packageLaunchStatus','sourceGitSha','reviewerConclusion','machine','proofs')
  Need ($record.version -eq 2 -and $manifest.source.version -ceq '0.1.3' -and $record.qualification -ceq 'EquivalentEvidence' -and (TrueValue $record.passed) -and $record.scope -ceq 'same-machine-local-reversible' -and $record.reviewerConclusion -ceq 'PASS_WITH_NOTRUN_PACKAGED_STARTUP') '新scope等价记录不适用'
  Need ($record.packageLaunchTested -is [bool] -and -not $record.packageLaunchTested -and $record.packageLaunchStatus -ceq 'NOTRUN' -and $record.sourceGitSha -ceq $manifest.source.gitSha) '新scope必须诚实NOTRUN并绑定候选源码'
  ExactKeys $record.machine @('computerName','platform','architecture')
  Need ($record.machine.computerName -ceq [Environment]::MachineName -and $record.machine.platform -ceq 'win32' -and $record.machine.architecture -ceq 'x64' -and [OperatingSystem]::IsWindows() -and [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [Runtime.InteropServices.Architecture]::X64) '新scope不适用于当前机器'
  $names=@('candidateManifest','previousManifest','staticBinding','packagingComparison','providerReview','quality','probeResult','probeBinding','probeProcess','conversationResult','conversationBinding','conversationProcess','researchResult','researchBinding','researchProcess','priorQualification','packageReview','validatorSupplement')
  ExactKeys $record.proofs $names
  $fixed=@{candidateManifest='release/build-provenance.json';previousManifest='output/build-provenance.json';priorQualification='log/legacy-followup-20261012/equivalence-record.json';validatorSupplement='log/real-provider-20261012/validator-supplement.json'}
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($name in $names){
    $proof=$record.proofs.$name;Need ($seen.Add($proof.path)) '新scope证明路径重复'
    if($fixed.ContainsKey($name)){Need ($proof.path -ceq $fixed[$name]) '新scope固定证明路径不符'}
    [void](BoundProof $proof $collected (-not $fixed.ContainsKey($name)))
  }
  Need ($record.proofs.candidateManifest.sha256 -ceq $manifestFact.sha256) '新scope候选清单绑定不符'
  $previous=ReadJson (Member $repository $fixed.previousManifest)
  Need ($previous.source.version -ceq '0.1.2' -and (TrueValue $previous.candidateEligible) -and $previous.source.dirty -is [bool] -and -not $previous.source.dirty) '旧包不是已选定干净0.1.2'
  AssertFiles (Join-Path $output 'win-unpacked') $previous.payload.packageFiles
  foreach($fact in @($previous.installer,$previous.msi,$previous.installerBuild)){$actual=FileFact (Member $output $fact.path) $fact.path;Need ($actual.bytes -eq $fact.bytes -and $actual.sha256 -ceq $fact.sha256) '旧安装器或身份文件变化'}
  foreach($key in @('toolchain','buildConfiguration','guardianCompiler')){Need (SameValue $previous.inputs.$key $manifest.inputs.$key) '封装工具链或构建配置已变化'}
  Need (SameValue $previous.inputs.installerCompiler.tools $manifest.inputs.installerCompiler.tools) '安装构建工具变化'
  $oldSources=@($previous.inputs.installerCompiler.sources|Where-Object {$_.path -notin @('package.json','package-lock.json')})
  $newSources=@($manifest.inputs.installerCompiler.sources|Where-Object {$_.path -notin @('package.json','package-lock.json')})
  Need (SameValue $oldSources $newSources) '安装器作者源码变化'
  Need ($previous.payload.guardian.sha256 -ceq $manifest.payload.guardian.sha256) 'Guardian字节变化'
  $prior=ReadJson (Member $repository $fixed.priorQualification)
  Need ($prior.version -eq 1 -and (TrueValue $prior.passed) -and $prior.sourceGitSha -ceq $previous.source.gitSha -and $prior.reviewerConclusion -ceq 'PASS_WITH_NOTRUN_PACKAGED_STARTUP' -and $prior.packageLaunchTested -is [bool] -and -not $prior.packageLaunchTested -and $prior.packageLaunchStatus -ceq 'NOTRUN') '旧限定资格与旧包来源不符'
  Need ($prior.proofs.candidateManifest.sha256 -ceq $record.proofs.previousManifest.sha256) '旧资格未绑定当前旧包清单'
  foreach($name in @('productionResult','productionCompletion','productionReadback','productionLog','productionDialogAction','failedPackageManifest','failedPackageEvents','failedPackageRun','profileIdentity','staticBinding','peComparison')){
    $proof=$prior.proofs.$name
    Need ($proof.path.StartsWith('log/',[StringComparison]::Ordinal)) '历史证明路径越界'
    if($name -in @('failedPackageManifest','failedPackageEvents')){
      $leaf=if($name -eq 'failedPackageManifest'){'manifest.json'}else{'events.jsonl'}
      Need ((Member $repository $proof.path) -ceq (Join-Path $journal $leaf)) '历史隔离journal不匹配'
    }
    # Legacy v1 proofs historically require only path and digest, not byte count.
    $fact=FileFact (Member $repository $proof.path) $proof.path
    Need ($fact.sha256 -ceq $proof.sha256) '复用的历史证明摘要变化';$collected.Add($fact)
  }
  $static=ReadJson (Member $repository $record.proofs.staticBinding.path)
  Need ((TrueValue $static.ok) -and $static.executableSha256 -ceq $manifest.payload.executable.sha256 -and $static.asarSha256 -ceq $manifest.payload.asar.sha256 -and $static.guardianSha256 -ceq $manifest.payload.guardian.sha256 -and $static.productExecuted -is [bool] -and -not $static.productExecuted) '当前包静态绑定未通过'
  $pe=ReadJson (Member $repository $record.proofs.packagingComparison.path)
  Need ($pe.version -eq 1 -and $pe.previousExecutableSha256 -ceq $previous.payload.executable.sha256 -and $pe.candidateExecutableSha256 -ceq $manifest.payload.executable.sha256 -and $pe.oldSections -eq $pe.newSections -and $pe.newSections -gt 0 -and @($pe.sections).Count -eq $pe.newSections -and $pe.oldResourceCount -eq $pe.newResourceCount -and (TrueValue $pe.sameExtra)) 'PE封装比较未绑定两个包'
  $sectionNames=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach($section in $pe.sections){Need ($sectionNames.Add($section.name) -and $section.sameBytes -is [bool] -and ($section.sameBytes -or $section.name -ceq '.rsrc')) 'PE代码或未知节变化'}
  foreach($resource in $pe.changedResources){Need ($resource -cin @('INTEGRITY/ELECTRONASAR/1033','16/1/1033')) 'PE存在未审资源变化'}
  $quality=ReadJson (Member $repository $record.proofs.quality.path)
  Need ($quality.version -in @(1,2) -and $quality.sourceGitSha -ceq $manifest.source.gitSha) '质量证据来源不符'
  $checks=@('test','typecheck','lint','format','build');ExactKeys $quality.checks $checks
  foreach($check in $checks){
    $item=$quality.checks.$check
    if($quality.version -eq 2 -and $check -eq 'test'){AssertCompositeTests $item $quality.sourceGitSha $collected;continue}
    ExactKeys $item @('exitCode','log');Need ($item.exitCode -is [long] -and $item.exitCode -eq 0) '质量门未通过';[void](BoundProof $item.log $collected)
  }
  $validatorDelta=AssertValidatorSupplement $record.proofs $collected
  foreach($phase in @('probe','conversation','research')){AssertCampaign $phase $record.proofs $collected $validatorDelta}
  $review=ReadJson (Member $repository $record.proofs.packageReview.path)
  ExactKeys $review @('version','sourceGitSha','conclusion','proofs','report')
  Need ($review.version -eq 1 -and $review.sourceGitSha -ceq $manifest.source.gitSha -and $review.conclusion -ceq 'PASS_WITH_NOTRUN_PACKAGED_STARTUP') '新独立换包审核未通过'
  $reviewed=@($names|Where-Object {$_ -cne 'packageReview'});ExactKeys $review.proofs $reviewed
  foreach($name in $reviewed){Need ($review.proofs.$name -ceq $record.proofs.$name.sha256) '新独立审核未绑定全部证据'}
  Need (-not $seen.Contains($review.report.path) -and $review.report.sha256 -cne $record.proofs.providerReview.sha256) '最终独审正文不能复用既有单项审核'
  [void](BoundProof $review.report $collected)
}
function RestorePrevious($plan,[string]$scope,[string]$backup) {
  Idle
  if(-not (Test-Path -LiteralPath $backup)){AssertFiles $output $plan.previous.files;return}
  AssertFiles $backup $plan.previous.files
  if(Test-Path -LiteralPath $output) {
    # Preserve even a failed candidate byte-for-byte before restoring the old tree.
    $retainedFiles=@(Tree $output)
    $retained=SafePath (Join-Path $scope 'rolled-back-candidate')
    Need (-not (Test-Path -LiteralPath $retained)) '回退保留目录已存在'
    NewJson (Join-Path $scope ('rollback-candidate-'+[Guid]::NewGuid().ToString('N')+'.json')) @{files=$retainedFiles;destination=$retained}
    [IO.Directory]::Move($output,$retained)
    AssertFiles $retained $retainedFiles
  }
  Need (-not (Test-Path -LiteralPath $output)) '恢复目标已被占用'
  [IO.Directory]::Move($backup,$output)
  AssertFiles $output $plan.previous.files
}
if($Action -eq 'Rollback') {
  Need ($SwitchId -ne '' -and $PackageJournal -eq '' -and $EquivalenceRecord -eq '' -and $Qualification -eq 'PackageSmoke') '回退只接受固定SwitchId'
  $scope=SafePath (Join-Path $evidence ('output-switch-'+$SwitchId))
  $backup=SafePath (Join-Path $evidence ('previous-output-'+$SwitchId))
  $plan=ReadJson (Join-Path $scope 'plan.json')
  Need ($plan.version -eq 1 -and $plan.id -ceq $SwitchId -and $plan.output -ceq $output -and $plan.backup -ceq $backup -and $plan.release -ceq $release) '回退计划不属于固定目录'
  RestorePrevious $plan $scope $backup
  NewJson (Join-Path $scope ('rollback-'+[Guid]::NewGuid().ToString('N')+'.json')) @{restored=$true;previous=$plan.previous;output=$output}
  @{restored=$true;output=$output;scope=$scope}|ConvertTo-Json
  return
}
Need ($SwitchId -eq '' -and $PackageJournal -ne '') '计划或换包须提供PackageSmoke journal'
Need ($EvidenceScope -eq 'legacy-followup-20261012' -or $Qualification -eq 'EquivalentEvidence') '新scope只允许显式等价验收'
Idle
$journal=SafePath $PackageJournal
Need ([IO.Path]::GetDirectoryName($journal) -ceq (Join-Path $repository 'log/legacy-followup-20261012/package') -and [IO.Path]::GetFileName($journal) -cmatch '^journal-[a-f0-9]{32}$') '不是固定PackageSmoke journal'
$manifestPath=Member $release 'build-provenance.json'
$manifest=ReadJson $manifestPath
$verificationHead=Head
Need ($manifest.candidateEligible -is [bool] -and $manifest.candidateEligible -and $manifest.source.dirty -is [bool] -and -not $manifest.source.dirty) '包来源不是干净源码候选'
AssertSource $manifest.source.gitSha $verificationHead
Need ($manifest.source.version -cmatch '^\d+\.\d+\.\d+$') '版本无效'
$stem='AIbrowse-'+$manifest.source.version+'-win-x64-internal'
Need ($manifest.installer.path -ceq ($stem+'.exe') -and $manifest.msi.path -ceq ($stem+'.msi') -and $manifest.installerBuild.path -ceq 'installer-build.json') '两个安装器或身份文件命名不符'
$manifestFact=FileFact $manifestPath 'build-provenance.json'
$proofFiles=[Collections.Generic.List[object]]::new()
if($Qualification -eq 'PackageSmoke') {
Need ($EquivalenceRecord -eq '') '默认验收不接受等价记录'
$terminalPath=Member $journal 'package-terminal.json'
$resultPath=Member $journal 'runner-output/package-result.json'
$terminal=ReadJson $terminalPath;$result=ReadJson $resultPath
Need ($terminal.passed -is [bool] -and $terminal.passed -and $terminal.jobCompleted -is [bool] -and $terminal.jobCompleted -and $terminal.rootExitCode -eq 0 -and $terminal.originalRestored -is [bool] -and $terminal.originalRestored) 'PackageSmoke未正常结束并恢复原profile'
Need ($result.passed -is [bool] -and $result.passed -and $result.rootExitCode -eq 0 -and $result.native.passed -is [bool] -and $result.native.passed -and $result.native.closeCount -eq 1) '实际包启动或正常关闭未通过'
Need ($result.binding.runId -ceq [IO.Path]::GetFileName($journal).Substring(8) -and $result.binding.packageRoot -ceq (Join-Path $release 'win-unpacked') -and $result.binding.journal -ceq $journal -and $result.binding.provenanceSha256 -ceq $manifestFact.sha256 -and $result.binding.executableSha256 -ceq $manifest.payload.executable.sha256 -and $result.binding.guardianSha256 -ceq $manifest.payload.guardian.sha256 -and $result.binding.asarSha256 -ceq $manifest.payload.asar.sha256) '验收证据与当前包不匹配'
foreach($path in @($terminalPath,$resultPath)){$proofFiles.Add((FileFact $path ([IO.Path]::GetRelativePath($repository,$path).Replace('\','/'))))}
} else {
  Need ($EquivalenceRecord -ne '' -and (SafePath $EquivalenceRecord) -ceq (Join-Path $evidence 'equivalence-record.json')) '等价记录不属于固定本轮证据目录'
  $record=ReadJson $EquivalenceRecord
  if($EvidenceScope -eq 'real-provider-20261012') {
    AssertProviderEvidence $record $manifest $manifestFact $proofFiles
    $proofFiles.Add((FileFact $EquivalenceRecord 'log/real-provider-20261012/equivalence-record.json'))
  } else {
  Need ($record.version -eq 1 -and $record.qualification -ceq 'EquivalentEvidence' -and $record.passed -is [bool] -and $record.passed -and $record.scope -ceq 'same-machine-local-reversible' -and $record.reviewerConclusion -ceq 'PASS_WITH_NOTRUN_PACKAGED_STARTUP') '等价记录未获限定审核通过'
  Need ($record.packageLaunchTested -is [bool] -and -not $record.packageLaunchTested -and $record.packageLaunchStatus -ceq 'NOTRUN' -and $record.sourceGitSha -ceq $manifest.source.gitSha) '等价记录隐瞒实际包未启动或来源不符'
  Need ($record.machine.computerName -ceq [Environment]::MachineName -and $record.machine.platform -ceq 'win32' -and $record.machine.architecture -ceq 'x64' -and [OperatingSystem]::IsWindows() -and [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [Runtime.InteropServices.Architecture]::X64) '等价记录不适用于当前机器'
  $proofNames=@('candidateManifest','previousManifest','productionResult','productionCompletion','productionReadback','productionLog','productionDialogAction','failedPackageManifest','failedPackageEvents','failedPackageRun','profileIdentity','staticBinding','peComparison')
  Need (@($record.proofs.PSObject.Properties).Count -eq $proofNames.Count) '等价证明集合不闭合'
  $fixed=@{candidateManifest='release/build-provenance.json';previousManifest='output/build-provenance.json';failedPackageManifest=([IO.Path]::GetRelativePath($repository,(Join-Path $journal 'manifest.json')).Replace('\','/'));failedPackageEvents=([IO.Path]::GetRelativePath($repository,(Join-Path $journal 'events.jsonl')).Replace('\','/'));failedPackageRun='log/legacy-followup-20261012/package-smoke-run.log';profileIdentity='log/legacy-followup-20261012/package-profile-identity.json';staticBinding='log/legacy-followup-20261012/reviewer-package-static-binding.txt';peComparison='log/legacy-followup-20261012/reviewer-package-pe-reuse.json'}
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($name in $proofNames) {
    $proof=$record.proofs.$name
    Need ($proof.sha256 -cmatch '^[a-f0-9]{64}$' -and $seen.Add($proof.path)) '证明摘要或成员重复'
    if($fixed.ContainsKey($name)){Need ($proof.path -ceq $fixed[$name]) '证明不属于固定文件'}else{Need ($proof.path.StartsWith('log/',[StringComparison]::Ordinal)) '运行证明不属于项目日志'}
    $actual=FileFact (Member $repository $proof.path) $proof.path
    Need ($actual.sha256 -ceq $proof.sha256) '等价证明缺失或摘要不匹配'
    $proofFiles.Add($actual)
  }
  $proofFiles.Add((FileFact $EquivalenceRecord 'log/legacy-followup-20261012/equivalence-record.json'))
  }
}
$candidate=[Collections.Generic.List[object]]::new()
foreach($fact in $manifest.payload.packageFiles){$candidate.Add([ordered]@{path=('win-unpacked/'+$fact.path);bytes=$fact.bytes;sha256=$fact.sha256})}
AssertFiles (Join-Path $release 'win-unpacked') $manifest.payload.packageFiles
foreach($fact in @($manifest.installer,$manifest.msi,$manifest.installerBuild)) {
  $actual=FileFact (Member $release $fact.path) $fact.path
  Need ($actual.bytes -eq $fact.bytes -and $actual.sha256 -ceq $fact.sha256) '安装器或安装构建身份不匹配'
  $candidate.Add($actual)
}
$candidate.Add($manifestFact)
$old=@(Tree $output)
$id=[Guid]::NewGuid().ToString('N')
$scope=SafePath (Join-Path $evidence ('output-switch-'+$id))
$backup=SafePath (Join-Path $evidence ('previous-output-'+$id))
$staging=SafePath (Join-Path $scope 'staging')
$plan=[ordered]@{version=1;id=$id;release=$release;output=$output;backup=$backup;staging=$staging;source=$manifest.source;verificationHead=$verificationHead;qualification=$Qualification;packageLaunchTested=($Qualification -eq 'PackageSmoke');packageLaunchStatus=$(if($Qualification -eq 'PackageSmoke'){'PASS'}else{'NOTRUN'});scope='same-machine-local-reversible';candidate=@{count=$candidate.Count;files=@($candidate|Sort-Object path)};previous=@{count=$old.Count;files=$old};packageJournal=$journal;evidence=@($proofFiles.ToArray());scriptSha256=(FileFact $PSCommandPath 'output-switch.ps1').sha256}
if($Action -eq 'CheckOnly'){$plan|ConvertTo-Json -Depth 24;return}
Need (-not (Test-Path -LiteralPath $scope) -and -not (Test-Path -LiteralPath $backup)) '唯一换包目录已存在'
[void][IO.Directory]::CreateDirectory($scope)
NewJson (Join-Path $scope 'plan.json') $plan
$oldMoved=$false;$newMoved=$false
try {
  [void][IO.Directory]::CreateDirectory($staging)
  foreach($fact in $plan.candidate.files) {
    $source=Member $release $fact.path;$target=Member $staging $fact.path
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
    [IO.File]::Copy($source,$target,$false)
  }
  AssertFiles $staging $plan.candidate.files
  foreach($fact in $plan.candidate.files){$actual=FileFact (Member $release $fact.path) $fact.path;Need ($actual.bytes -eq $fact.bytes -and $actual.sha256 -ceq $fact.sha256) '复制期间发行源变化'}
  AssertFiles $output $plan.previous.files
  foreach($fact in $plan.evidence){Need ((FileFact (Member $repository $fact.path) $fact.path).sha256 -ceq $fact.sha256) '验收证据变化'}
  Need ((Head) -ceq $plan.verificationHead) '切换前源码HEAD变化'
  AssertSource $plan.source.gitSha $plan.verificationHead
  Idle
  [IO.Directory]::Move($output,$backup);$oldMoved=$true
  AssertFiles $backup $plan.previous.files
  [IO.Directory]::Move($staging,$output);$newMoved=$true
  AssertFiles $output $plan.candidate.files
  AssertFiles $backup $plan.previous.files
  NewJson (Join-Path $scope 'result.json') @{passed=$true;id=$id;output=$output;previousOutput=$backup;source=$plan.source;qualification=$plan.qualification;packageLaunchTested=$plan.packageLaunchTested;packageLaunchStatus=$plan.packageLaunchStatus;scope=$plan.scope;files=$plan.candidate.count;previousFiles=$plan.previous.count;originalBytesPreserved=$true}
  @{passed=$true;id=$id;output=$output;previousOutput=$backup;scope=$scope}|ConvertTo-Json
} catch {
  $problem=$_.Exception.Message;$restored=$false;$restoreProblem=$null
  if($oldMoved) {
    try {
      Need ($newMoved -or -not (Test-Path -LiteralPath $output)) '未知目录占用output，停止自动回退'
      RestorePrevious $plan $scope $backup;$restored=$true
    }catch{$restoreProblem=$_.Exception.Message}
  }
  NewJson (Join-Path $scope 'failure.json') @{passed=$false;error=$problem;oldMoved=$oldMoved;newMoved=$newMoved;originalUntouched=(-not $oldMoved);originalRestored=$restored;restoreError=$restoreProblem;recoveryCommand=('pwsh -NoProfile -File tools/legacy-followup/output-switch.ps1 -Action Rollback -SwitchId '+$id+' -EvidenceScope '+$EvidenceScope)}
  throw "换包失败，证据与所有目录保留：$problem；回退状态=$restored"
}
