$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$scope=Join-Path $repository ('log/legacy-followup-20261012/output-switch-fixture-'+[Guid]::NewGuid().ToString('N'))
$fixture=Join-Path $scope 'repository'
$tool=Join-Path $fixture 'tools/legacy-followup/output-switch.ps1'
$utf8=[Text.UTF8Encoding]::new($false)
function WriteText([string]$path,[string]$value){[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path));[IO.File]::WriteAllText($path,$value,$utf8)}
function SaveJson([string]$path,$value){WriteText $path ($value|ConvertTo-Json -Depth 16)}
function Fact([string]$base,[string]$relative){$path=Join-Path $base $relative;return [ordered]@{path=$relative;bytes=(Get-Item -LiteralPath $path).Length;sha256=(Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant()}}
function Inventory([string]$base){return @((Get-ChildItem -LiteralPath $base -Recurse -File)|ForEach-Object {Fact $base ([IO.Path]::GetRelativePath($base,$_.FullName).Replace('\','/'))}|Sort-Object path)}
function Same($first,$second){if(($first|ConvertTo-Json -Depth 8 -Compress) -cne ($second|ConvertTo-Json -Depth 8 -Compress)){throw '合成文件树字节不一致'}}
function InvokeFixtureGit([string[]]$values){& git -C $fixture @values | Out-Null;if($LASTEXITCODE -ne 0){throw '合成仓库Git步骤失败'}}
$checks=[Collections.Generic.List[string]]::new()
function Reject([string]$name,[scriptblock]$operation){$rejected=$false;try{&$operation|Out-Null}catch{$rejected=$true};if(-not $rejected){throw "合成反例未拒绝：$name"};Same $script:old (Inventory $script:output);$checks.Add($name)}
try {
  WriteText $tool ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'output-switch.ps1')))
  $toolSourceSha256=(Get-FileHash -LiteralPath $tool).Hash.ToLowerInvariant();$testSourceSha256=(Get-FileHash -LiteralPath $PSCommandPath).Hash.ToLowerInvariant()
  WriteText (Join-Path $fixture '.gitignore') "/release/`n/output/`n/log/`n"
  WriteText (Join-Path $fixture 'tracked.txt') '合成源码'
  InvokeFixtureGit @('init','--quiet');InvokeFixtureGit @('add','.gitignore','tracked.txt','tools/legacy-followup/output-switch.ps1')
  InvokeFixtureGit @('-c','user.name=AIbrowse fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','test: 合成换包仓库')
  $head=(& git -C $fixture rev-parse HEAD).Trim()
  $release=Join-Path $fixture 'release';$output=Join-Path $fixture 'output'
  foreach($relative in @('old.exe','old.msi','nested/identity.txt')){WriteText (Join-Path $output $relative) ('旧合成原件：'+$relative)}
  $old=Inventory $output
  $payload=Join-Path $release 'win-unpacked'
  foreach($relative in @('AIbrowse.exe','resources/app.asar','resources/lifecycle-guardian/guardian.exe')){WriteText (Join-Path $payload $relative) ('新合成载荷：'+$relative)}
  $stem='AIbrowse-0.1.2-win-x64-internal'
  foreach($relative in @(($stem+'.exe'),($stem+'.msi'),'installer-build.json')){WriteText (Join-Path $release $relative) ('合成封装：'+$relative)}
  $manifest=@{schemaVersion=1;candidateEligible=$true;source=@{gitSha=$head;dirty=$false;version='0.1.2'};payload=@{packageFiles=(Inventory $payload);executable=(Fact $payload 'AIbrowse.exe');guardian=(Fact $payload 'resources/lifecycle-guardian/guardian.exe');asar=(Fact $payload 'resources/app.asar')};installer=(Fact $release ($stem+'.exe'));msi=(Fact $release ($stem+'.msi'));installerBuild=(Fact $release 'installer-build.json')}
  $manifestPath=Join-Path $release 'build-provenance.json';SaveJson $manifestPath $manifest
  $runId=[Guid]::NewGuid().ToString('N');$journal=Join-Path $fixture ('log/legacy-followup-20261012/package/journal-'+$runId)
  $terminalPath=Join-Path $journal 'package-terminal.json'
  $terminal=@{passed=$true;jobCompleted=$true;rootExitCode=0;originalRestored=$true;originalIdentity=@{fixture=$true}}
  SaveJson $terminalPath $terminal
  $result=@{passed=$true;rootExitCode=0;native=@{passed=$true;closeCount=1};binding=@{runId=$runId;packageRoot=$payload;journal=$journal;provenanceSha256=(Fact $release 'build-provenance.json').sha256;executableSha256=$manifest.payload.executable.sha256;guardianSha256=$manifest.payload.guardian.sha256;asarSha256=$manifest.payload.asar.sha256}}
  SaveJson (Join-Path $journal 'runner-output/package-result.json') $result
  $plan=(& $tool -Action CheckOnly -PackageJournal $journal)|ConvertFrom-Json
  Same $old (Inventory $output)
  if($plan.previous.count -ne 3 -or $plan.candidate.count -ne 7){throw '合成计划成员数量不符'}
  $checks.Add('只读计划包含完整七成员且旧三成员未变')
  WriteText (Join-Path $fixture 'tracked.txt') '合成未提交变化'
  Reject '实际Git dirty拒绝' {&$tool -Action CheckOnly -PackageJournal $journal}
  WriteText (Join-Path $fixture 'tracked.txt') '合成源码'
  $manifest.source.gitSha='a'*40;SaveJson $manifestPath $manifest
  Reject 'manifest源码不匹配拒绝' {&$tool -Action CheckOnly -PackageJournal $journal}
  $manifest.source.gitSha=$head;SaveJson $manifestPath $manifest
  $terminal.originalRestored=$false;SaveJson $terminalPath $terminal
  Reject '原profile未恢复拒绝' {&$tool -Action CheckOnly -PackageJournal $journal}
  $terminal.originalRestored=$true;SaveJson $terminalPath $terminal
  $switched=(& $tool -Action Switch -PackageJournal $journal)|ConvertFrom-Json
  if(-not $switched.passed){throw '合成换包未通过'}
  Same $old (Inventory $switched.previousOutput)
  $new=Inventory $output
  if($new.Count -ne 7){throw '新程序或安装器缺失'}
  foreach($fact in $new){$source=Fact $release $fact.path;if($source.bytes -ne $fact.bytes -or $source.sha256 -cne $fact.sha256){throw '新树不是完整来源字节'}}
  $checks.Add('实际Switch新七成员匹配且旧三成员完整保全')
  $rollback=(& $tool -Action Rollback -SwitchId $switched.id)|ConvertFrom-Json
  if(-not $rollback.restored){throw '合成回退未完成'}
  Same $old (Inventory $output)
  Same $new (Inventory (Join-Path $switched.scope 'rolled-back-candidate'))
  $checks.Add('实际Rollback原目录三成员恢复且候选七成员保留')
  # This second fixture is explicitly synthetic and never claims packaged startup.
  SaveJson (Join-Path $output 'build-provenance.json') @{synthetic=$true;version='previous'}
  $old=Inventory $output
  $recordPath=Join-Path $fixture 'log/legacy-followup-20261012/equivalence-record.json'
  $paths=[ordered]@{candidateManifest='release/build-provenance.json';previousManifest='output/build-provenance.json';productionResult='log/fixture/result.json';productionCompletion='log/fixture/completion.json';productionReadback='log/fixture/readback.json';productionLog='log/fixture/production.log';productionDialogAction='log/fixture/dialog.json';failedPackageManifest=([IO.Path]::GetRelativePath($fixture,(Join-Path $journal 'manifest.json')).Replace('\','/'));failedPackageEvents=([IO.Path]::GetRelativePath($fixture,(Join-Path $journal 'events.jsonl')).Replace('\','/'));failedPackageRun='log/legacy-followup-20261012/package-smoke-run.log';profileIdentity='log/legacy-followup-20261012/package-profile-identity.json';staticBinding='log/legacy-followup-20261012/reviewer-package-static-binding.txt';peComparison='log/legacy-followup-20261012/reviewer-package-pe-reuse.json'}
  $proofs=[ordered]@{}
  foreach($name in $paths.Keys){$relative=$paths[$name];if($name -notin @('candidateManifest','previousManifest')){SaveJson (Join-Path $fixture $relative) @{syntheticEvidenceOnly=$true;name=$name}};$proofs[$name]=Fact $fixture $relative}
  $record=@{version=1;qualification='EquivalentEvidence';passed=$true;scope='same-machine-local-reversible';packageLaunchTested=$false;packageLaunchStatus='NOTRUN';sourceGitSha=$head;reviewerConclusion='PASS_WITH_NOTRUN_PACKAGED_STARTUP';machine=@{computerName=[Environment]::MachineName;platform='win32';architecture='x64'};proofs=$proofs}
  SaveJson $recordPath $record
  WriteText (Join-Path $fixture 'doc/tasks/progress.md') '合成允许文档差量'
  InvokeFixtureGit @('add','doc/tasks/progress.md')
  InvokeFixtureGit @('-c','user.name=AIbrowse fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','docs: 合成白名单差量')
  $equivalent=(& $tool -Action CheckOnly -PackageJournal $journal -Qualification EquivalentEvidence -EquivalenceRecord $recordPath)|ConvertFrom-Json
  if($equivalent.packageLaunchTested -or $equivalent.packageLaunchStatus -cne 'NOTRUN' -or $equivalent.evidence.Count -ne 14){throw '等价计划未诚实保留NOTRUN和全部证据'}
  $checks.Add('显式等价模式允许已提交文档差量并诚实NOTRUN')
  $proofs.productionLog.sha256='a'*64;SaveJson $recordPath $record
  Reject '等价证明摘要不匹配拒绝' {&$tool -Action CheckOnly -PackageJournal $journal -Qualification EquivalentEvidence -EquivalenceRecord $recordPath}
  $proofs.productionLog=Fact $fixture $paths.productionLog
  $proofs.productionLog.path='log/fixture/missing.log';SaveJson $recordPath $record
  Reject '等价证明缺失拒绝' {&$tool -Action CheckOnly -PackageJournal $journal -Qualification EquivalentEvidence -EquivalenceRecord $recordPath}
  $proofs.productionLog=Fact $fixture $paths.productionLog;SaveJson $recordPath $record
  $equivalentSwitch=(& $tool -Action Switch -PackageJournal $journal -Qualification EquivalentEvidence -EquivalenceRecord $recordPath)|ConvertFrom-Json
  Same $old (Inventory $equivalentSwitch.previousOutput)
  Same $new (Inventory $output)
  $equivalentResult=Get-Content -LiteralPath (Join-Path $equivalentSwitch.scope 'result.json') -Raw|ConvertFrom-Json
  if($equivalentResult.packageLaunchTested -or $equivalentResult.packageLaunchStatus -cne 'NOTRUN'){throw '等价换包回执夸大验收'}
  &$tool -Action Rollback -SwitchId $equivalentSwitch.id|Out-Null
  Same $old (Inventory $output)
  Same $new (Inventory (Join-Path $equivalentSwitch.scope 'rolled-back-candidate'))
  $checks.Add('等价Switch与Rollback保持两树字节且回执NOTRUN')
  WriteText (Join-Path $fixture 'tracked.txt') '合成产品源码差量'
  InvokeFixtureGit @('add','tracked.txt')
  InvokeFixtureGit @('-c','user.name=AIbrowse fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','test: 合成产品差量拒绝')
  Reject '来源之后产品差量拒绝' {&$tool -Action CheckOnly -PackageJournal $journal -Qualification EquivalentEvidence -EquivalenceRecord $recordPath}
  # The new scope is a separate synthetic tree; all earlier fixtures remain retained.
  [IO.Directory]::Move($output,(Join-Path $scope 'legacy-output-retained'))
  $requiredSources=@('src/main/ai/provider/openai-compatible.ts','src/main/ai/conversation-service.ts','src/main/ai/agent/agent-loop.ts','src/main/research/research-runtime.ts','src/main/research/synthesis/research-prompts.ts','src/main/research/result-validator.ts')
  foreach($source in $requiredSources){WriteText (Join-Path $fixture $source) ('合成源码 '+$source)}
  $unchangedTests="// ---------- 测试替身 ----------`n合成替身与60项断言保持完整`n"
  WriteText (Join-Path $fixture 'src/main/ai/conversation-service.test.ts') ("合成新增只读插桩`n"+$unchangedTests)
  WriteText (Join-Path $fixture 'src/main/ai/conversation-ui-interruption.test.ts') '合成原四项中断测试源码'
  WriteText (Join-Path $fixture 'tools/real-provider/conversation-lock-diagnostic.test.ts') '合成Windows真实锁工具源码'
  WriteText (Join-Path $fixture 'node_modules/electron/dist/electron.exe') '合成Electron'
  InvokeFixtureGit @('add','.');InvokeFixtureGit @('-c','user.name=AIbrowse fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','test: 新scope合成来源')
  $head=(& git -C $fixture rev-parse HEAD).Trim()
  $manifest.source.gitSha=$head
  $manifest.inputs=@{toolchain=@{electron='43.7.7'};buildConfiguration=@(@{path='electron-builder.yml';sha256=('b'*64)});guardianCompiler=@{sourceSha256=('c'*64)};installerCompiler=@{tools=@{nsis='3.13'};sources=@(@{path='tools/build/msi-build.ts';sha256=('d'*64)})}}
  SaveJson $manifestPath $manifest
  foreach($fact in @(Inventory $release)) {if($fact.path -ne 'builder-debug.yml'){WriteText (Join-Path $output $fact.path) ([IO.File]::ReadAllText((Join-Path $release $fact.path)))}}
  $previousManifest=Get-Content -LiteralPath (Join-Path $output 'build-provenance.json') -Raw|ConvertFrom-Json
  $old=Inventory $output
  $manifest.source.version='0.1.3'
  $stem='AIbrowse-0.1.3-win-x64-internal'
  foreach($relative in @(($stem+'.exe'),($stem+'.msi'))){WriteText (Join-Path $release $relative) ('合成新安装器 '+$relative)}
  $manifest.installer=Fact $release ($stem+'.exe');$manifest.msi=Fact $release ($stem+'.msi');SaveJson $manifestPath $manifest
  $newRoot='log/real-provider-20261012'
  $newRecordPath=Join-Path $fixture ($newRoot+'/equivalence-record.json')
  $v2Paths=[ordered]@{candidateManifest='release/build-provenance.json';previousManifest='output/build-provenance.json';staticBinding=($newRoot+'/static.json');packagingComparison=($newRoot+'/packaging.json');providerReview=($newRoot+'/provider-review.md');quality=($newRoot+'/quality.json');priorQualification='log/legacy-followup-20261012/equivalence-record.json';packageReview=($newRoot+'/package-review.json');validatorSupplement=($newRoot+'/validator-supplement.json')}
  SaveJson (Join-Path $fixture $v2Paths.staticBinding) @{ok=$true;executableSha256=$manifest.payload.executable.sha256;asarSha256=$manifest.payload.asar.sha256;guardianSha256=$manifest.payload.guardian.sha256;productExecuted=$false}
  SaveJson (Join-Path $fixture $v2Paths.packagingComparison) @{version=1;previousExecutableSha256=$previousManifest.payload.executable.sha256;candidateExecutableSha256=$manifest.payload.executable.sha256;oldSections=2;newSections=2;sections=@(@{name='.text';sameBytes=$true},@{name='.rsrc';sameBytes=$false});oldResourceCount=2;newResourceCount=2;changedResources=@('INTEGRITY/ELECTRONASAR/1033','16/1/1033');sameExtra=$true}
  WriteText (Join-Path $fixture $v2Paths.providerReview) '合成独立Provider审核 PASS'
  $record.sourceGitSha=$previousManifest.source.gitSha;$record.proofs.candidateManifest.sha256=(Fact $output 'build-provenance.json').sha256;SaveJson $recordPath $record
  $quality=@{version=1;sourceGitSha=$head;checks=@{}}
  foreach($kind in @('test','typecheck','lint','format','build')){$relative=$newRoot+'/'+$kind+'.log';WriteText (Join-Path $fixture $relative) '合成成功输出';$quality.checks[$kind]=@{exitCode=0;log=(Fact $fixture $relative)}}
  SaveJson (Join-Path $fixture $v2Paths.quality) $quality
  $caseNames=@('实时共读来源A','同会话切页来源B','在途互斥与真实流取消','Agent实际读取来源A','同会话第二次Agent工具历史重放','L2表单拒绝无导航','L2表单允许后实际提交','敌对网页共读结构边界')
  foreach($phase in @('probe','conversation','research')){
    $campaign=$newRoot+'/campaign-'+[Guid]::NewGuid().ToString()
    $v2Paths[$phase+'Result']=$campaign+'/result.json';$v2Paths[$phase+'Binding']=$campaign+'/binding.json';$v2Paths[$phase+'Process']=$campaign+'/process-result.json'
    WriteText (Join-Path $fixture ($campaign+'/entry.cjs')) '合成bundle'
    $sourceMap=@{};foreach($source in $requiredSources){$sourceMap[$source]=(Fact $fixture $source).sha256}
    if($phase -eq 'research'){$sourceMap['src/main/research/result-validator.ts']='e'*64}
    SaveJson (Join-Path $fixture $v2Paths[$phase+'Binding']) @{baseline=$head;sources=$sourceMap;bundle=(Fact $fixture ($campaign+'/entry.cjs')).sha256;electron=(Fact $fixture 'node_modules/electron/dist/electron.exe').sha256;requestBudget=28;lifetimeMs=900000}
    SaveJson (Join-Path $fixture $v2Paths[$phase+'Process']) @{root=(Join-Path $fixture $campaign);phase=$phase;exitCode=0;exited=$true;signal=$null}
    $phaseCases=switch($phase){'probe'{@(@{passed=$true},@{passed=$true})};'conversation'{@(@{passed=$true;drained=$true;cases=@($caseNames|ForEach-Object {@{name=$_;passed=$true;terminal=$(if($_ -ceq '在途互斥与真实流取消'){'aborted'}else{'done'})}})})};'research'{@(@{passed=$true;checks=@{sourceStoreEmpty=$true;twoGoalCandidates=$true;capturesPerSource=$true;evidencePerSource=$true;claimsLinked=$true;resultLinked=$true;ownershipIsolated=$true;transferValid=$true;cleanupComplete=$true;withinProviderBudget=$true}})}}
    SaveJson (Join-Path $fixture $v2Paths[$phase+'Result']) @{phase=$phase;budget=28;networkRequests=2;calls=@(@{status=200;errors=@();done=$true},@{status=200;errors=@();done=$true});cases=$phaseCases;finished=$true;fatal=$null;credentialsDeleted=$true;browserDisposed=($phase -ne 'probe')}
  }
  $savedDb=$campaign+'/research/research-scenarios-abc123/research.db';WriteText (Join-Path $fixture $savedDb) '合成只读研究数据'
  $replayDirectory=$newRoot+'/validator-replay-'+[Guid]::NewGuid().ToString()
  $replayReport=$replayDirectory+'/report.json';$replayLog=$replayDirectory+'/process-output.log';$validatorTests=$newRoot+'/research-independent-green.log'
  WriteText (Join-Path $fixture $replayLog) '合成只读回放成功';WriteText (Join-Path $fixture $validatorTests) '合成独立验证88通过，其中独立反例31'
  $fields=@{};foreach($name in @('resultId','taskId','title','summary','blocks','evidenceMap','conflicts','coverage','fetchedAt')){$fields[$name]=$true}
  SaveJson (Join-Path $fixture $replayReport) @{version=1;scope='saved-result-validator-compatibility';passed=$true;rawModelOutputRevalidated=$false;networkCalls=0;readOnlyDatabase=$true;databaseUnchanged=$true;normalizedResultUnchanged=$true;validationPassed=$true;fieldChecks=$fields;conflictOrder='restored-by-persisted-result-ids';database=(Fact $fixture $savedDb);validator=(Fact $fixture 'src/main/research/result-validator.ts');counts=@{tasks=1;results=1;blocks=4;evidence=12;claims=3;conflicts=2}}
  $supplement=@{version=1;scope='saved-result-validator-compatibility';passed=$true;rawModelOutputRevalidated=$false;networkCalls=0;product=@{path='src/main/research/result-validator.ts';beforeSha256=('e'*64);afterSha256=(Fact $fixture 'src/main/research/result-validator.ts').sha256};researchBinding=(Fact $fixture $v2Paths.researchBinding);tests=@{exitCode=0;passed=88;independentPassed=31;log=(Fact $fixture $validatorTests)};replay=@{exitCode=0;report=(Fact $fixture $replayReport);log=(Fact $fixture $replayLog)}}
  SaveJson (Join-Path $fixture $v2Paths.validatorSupplement) $supplement
  $v2Proofs=[ordered]@{}
  foreach($name in $v2Paths.Keys){if($name -ne 'packageReview'){$v2Proofs[$name]=Fact $fixture $v2Paths[$name]}}
  $reviewText=$newRoot+'/package-review.md';WriteText (Join-Path $fixture $reviewText) '合成新独立审核：限定本机可回退更新 PASS，包启动 NOTRUN'
  $reviewHashes=@{};foreach($name in $v2Proofs.Keys){$reviewHashes[$name]=$v2Proofs[$name].sha256}
  $review=@{version=1;sourceGitSha=$head;conclusion='PASS_WITH_NOTRUN_PACKAGED_STARTUP';proofs=$reviewHashes;report=(Fact $fixture $reviewText)}
  SaveJson (Join-Path $fixture $v2Paths.packageReview) $review
  $v2Proofs.packageReview=Fact $fixture $v2Paths.packageReview
  $v2=@{version=2;qualification='EquivalentEvidence';passed=$true;scope='same-machine-local-reversible';packageLaunchTested=$false;packageLaunchStatus='NOTRUN';sourceGitSha=$head;reviewerConclusion='PASS_WITH_NOTRUN_PACKAGED_STARTUP';machine=@{computerName=[Environment]::MachineName;platform='win32';architecture='x64'};proofs=$v2Proofs}
  SaveJson $newRecordPath $v2
  $argsV2=@{Action='CheckOnly';PackageJournal=$journal;Qualification='EquivalentEvidence';EquivalenceRecord=$newRecordPath;EvidenceScope='real-provider-20261012'}
  $newPlan=(&$tool @argsV2)|ConvertFrom-Json
  if($newPlan.packageLaunchTested -or $newPlan.packageLaunchStatus -cne 'NOTRUN' -or $newPlan.source.version -cne '0.1.3'){throw '新scope计划边界不符'}
  Same $old (Inventory $output);$checks.Add('新scope完整绑定计划保持旧树与NOTRUN')
  Reject '新scope无显式qualification拒绝' {&$tool -Action CheckOnly -PackageJournal $journal -EquivalenceRecord $newRecordPath -EvidenceScope real-provider-20261012}
  $v2Proofs.probeResult.sha256='f'*64;SaveJson $newRecordPath $v2
  Reject '新scope未绑定结果拒绝' {&$tool @argsV2}
  $v2Proofs.probeResult=Fact $fixture $v2Paths.probeResult;SaveJson $newRecordPath $v2
  $review.proofs.probeResult='f'*64;SaveJson (Join-Path $fixture $v2Paths.packageReview) $review;$v2Proofs.packageReview=Fact $fixture $v2Paths.packageReview;SaveJson $newRecordPath $v2
  Reject '新scope独审绑定不符拒绝' {&$tool @argsV2}
  $review.proofs.probeResult=$v2Proofs.probeResult.sha256;SaveJson (Join-Path $fixture $v2Paths.packageReview) $review;$v2Proofs.packageReview=Fact $fixture $v2Paths.packageReview;SaveJson $newRecordPath $v2
  function RefreshV2 {
    foreach($name in $v2Paths.Keys){if($name -ne 'packageReview'){$v2Proofs[$name]=Fact $fixture $v2Paths[$name];$review.proofs[$name]=$v2Proofs[$name].sha256}}
    SaveJson (Join-Path $fixture $v2Paths.packageReview) $review
    $v2Proofs.packageReview=Fact $fixture $v2Paths.packageReview;SaveJson $newRecordPath $v2
  }
  function RejectBoundMutation([string]$name,[string]$proofName,[scriptblock]$mutation){
    $path=Join-Path $fixture $v2Paths[$proofName];$original=[IO.File]::ReadAllText($path)
    try {$value=$original|ConvertFrom-Json;&$mutation $value;SaveJson $path $value;RefreshV2;Reject $name {&$tool @argsV2}}
    finally {WriteText $path $original;RefreshV2}
  }
  RejectBoundMutation '新scope真实结果失败即使重绑也拒绝' 'researchResult' {param($v)$v.cases[0].passed=$false}
  RejectBoundMutation '新scope空研究check集合拒绝' 'researchResult' {param($v)$v.cases[0].checks=[pscustomobject]@{}}
  RejectBoundMutation '新scope真实调用HTTP非200拒绝' 'probeResult' {param($v)$v.calls[0].status=401}
  RejectBoundMutation '新scope真实进程未退出拒绝' 'probeProcess' {param($v)$v.exited=$false}
  RejectBoundMutation '新scope关键产品源码未绑定拒绝' 'conversationBinding' {param($v)$v.sources.'src/main/ai/provider/openai-compatible.ts'='f'*64}
  RejectBoundMutation '新scopebundle变化拒绝' 'probeBinding' {param($v)$v.bundle='f'*64}
  RejectBoundMutation '新scope不允许把非零质量门写成通过' 'quality' {param($v)$v.checks.test.exitCode=1}
  RejectBoundMutation '新scopePE代码节变化拒绝' 'packagingComparison' {param($v)$v.sections[0].sameBytes=$false}
  RejectBoundMutation '新scope静态ASAR绑定不符拒绝' 'staticBinding' {param($v)$v.asarSha256='f'*64}
  RejectBoundMutation 'validator补证不得批准其它源码路径' 'validatorSupplement' {param($v)$v.product.path='src/main/research/research-runtime.ts'}
  RejectBoundMutation 'validator补证before摘要不符拒绝' 'validatorSupplement' {param($v)$v.product.beforeSha256='f'*64}
  RejectBoundMutation 'validator补证after摘要不符拒绝' 'validatorSupplement' {param($v)$v.product.afterSha256='f'*64}
  RejectBoundMutation 'validator补证不能声称重验原模型输出' 'validatorSupplement' {param($v)$v.rawModelOutputRevalidated=$true}
  RejectBoundMutation 'validator补证独立测试未通过拒绝' 'validatorSupplement' {param($v)$v.tests.exitCode=1}
  RejectBoundMutation 'validator补证绑定其它研究运行拒绝' 'validatorSupplement' {param($v)$v.researchBinding.path=$v2Paths.probeBinding}
  $savedReplay=[IO.File]::ReadAllText((Join-Path $fixture $replayReport))
  $replayValue=$savedReplay|ConvertFrom-Json;$replayValue.fieldChecks.blocks=$false;SaveJson (Join-Path $fixture $replayReport) $replayValue
  $supplement.replay.report=Fact $fixture $replayReport;SaveJson (Join-Path $fixture $v2Paths.validatorSupplement) $supplement;RefreshV2
  Reject 'validator已绑定回放字段变化拒绝' {&$tool @argsV2}
  WriteText (Join-Path $fixture $replayReport) $savedReplay;$supplement.replay.report=Fact $fixture $replayReport;SaveJson (Join-Path $fixture $v2Paths.validatorSupplement) $supplement;RefreshV2
  $v2.packageLaunchTested=$true;SaveJson $newRecordPath $v2;Reject '新scope不得把未运行包启动写成已运行' {&$tool @argsV2};$v2.packageLaunchTested=$false;SaveJson $newRecordPath $v2
  $oldProviderHash=$review.report.sha256;$oldProviderPath=$review.report.path;$oldProviderBytes=$review.report.bytes
  $review.report=$v2Proofs.providerReview;SaveJson (Join-Path $fixture $v2Paths.packageReview) $review;$v2Proofs.packageReview=Fact $fixture $v2Paths.packageReview;SaveJson $newRecordPath $v2
  Reject '新scope不得用单项审核冒充最终独审' {&$tool @argsV2}
  $review.report=@{path=$oldProviderPath;bytes=$oldProviderBytes;sha256=$oldProviderHash};RefreshV2
  # Composite quality preserves the failed full run and replaces exactly one file.
  $compositePaths=@{fullLog=($newRoot+'/full-002.log');fullExit=($newRoot+'/full-exit-002.json');replacementReport=($newRoot+'/conversation-diagnostic.json');replacementLog=($newRoot+'/conversation-diagnostic.log');beforeSource=($newRoot+'/conversation-service.before.ts');patch=($newRoot+'/conversation-service.patch');controlSource='tools/real-provider/conversation-lock-diagnostic.test.ts';controlReport=($newRoot+'/lock-final.json');controlLog=($newRoot+'/lock-final.log');lockResult='log/conversation-lock-diagnostic/case-abc123/result.json'}
  WriteText (Join-Path $fixture $compositePaths.fullLog) "FAIL  src/main/ai/conversation-service.test.ts > 合成原失败`nsrc/main/ai/conversation-service.test.ts (60 tests | 1 failed)`nstage=rename code=EPERM`nTest Files  1 failed | 472 passed | 1 skipped (474)`nTests  1 failed | 6954 passed | 3 skipped (6958)`n"
  SaveJson (Join-Path $fixture $compositePaths.fullExit) @{exitCode=1;log=$compositePaths.fullLog}
  WriteText (Join-Path $fixture $compositePaths.beforeSource) ("合成原始imports`n"+$unchangedTests)
  WriteText (Join-Path $fixture $compositePaths.patch) "diff --git a/src/main/ai/conversation-service.test.ts b/src/main/ai/conversation-service.test.ts`n--- a/src/main/ai/conversation-service.test.ts`n+++ b/src/main/ai/conversation-service.test.ts`n@@ -1 +1 @@`n-合成原始imports`n+合成新增只读插桩`n"
  foreach($kind in @('replacementLog','controlLog')){WriteText (Join-Path $fixture $compositePaths[$kind]) '合成补验日志'}
  foreach($part in @(@{report='replacementReport';path='src/main/ai/conversation-service.test.ts';count=60},@{report='controlReport';path='tools/real-provider/conversation-lock-diagnostic.test.ts';count=1})){
    $assertions=@(1..$part.count|ForEach-Object {@{status='passed';fullName=('合成断言'+$_);failureMessages=@()}})
    SaveJson (Join-Path $fixture $compositePaths[$part.report]) @{success=$true;numFailedTests=0;numPendingTests=0;numTodoTests=0;testResults=@(@{name=(Join-Path $fixture $part.path);status='passed';assertionResults=$assertions})}
  }
  SaveJson (Join-Path $fixture $compositePaths.lockResult) @{controlWrites=50;saved=$false;oldIndexPreserved=$true;temporaryPreserved=$true;exitCode=0;forcedCleanup=$false}
  $compositeFacts=@{};foreach($name in $compositePaths.Keys){$compositeFacts[$name]=Fact $fixture $compositePaths[$name]}
  $compositeReviewPath=$newRoot+'/composite-review.json';$compositeReviewText=$newRoot+'/composite-review.md'
  WriteText (Join-Path $fixture $compositeReviewText) '合成独立组合审核通过，历史EPERM根因unknown，原全量exit1保留'
  $compositeReviewHashes=@{};foreach($name in $compositeFacts.Keys){$compositeReviewHashes[$name]=$compositeFacts[$name].sha256}
  SaveJson (Join-Path $fixture $compositeReviewPath) @{version=1;sourceGitSha=$head;conclusion='PASS_WITH_UNKNOWN_HISTORICAL_EPERM';proofs=$compositeReviewHashes;report=(Fact $fixture $compositeReviewText)}
  $quality.version=2
  $quality.checks.test=@{mode='bounded-composite';scope='conversation-service-rename-eperm';historicalRootCause='unknown';full=@{exitCode=1;exit=$compositeFacts.fullExit;log=$compositeFacts.fullLog;passed=6954;failed=1;skipped=3;unchangedFilesPassed=472};replacement=@{path='src/main/ai/conversation-service.test.ts';exitCode=0;report=$compositeFacts.replacementReport;log=$compositeFacts.replacementLog;passed=60;beforeTestSha256=$compositeFacts.beforeSource.sha256;afterTestSha256=(Fact $fixture 'src/main/ai/conversation-service.test.ts').sha256;beforeSource=$compositeFacts.beforeSource;patch=$compositeFacts.patch};control=@{path='tools/real-provider/conversation-lock-diagnostic.test.ts';source=$compositeFacts.controlSource;report=$compositeFacts.controlReport;log=$compositeFacts.controlLog;passed=1;lockResult=$compositeFacts.lockResult};deduplicated=@{passed=6955;skipped=3;additionalControlPassed=1};review=(Fact $fixture $compositeReviewPath)}
  SaveJson (Join-Path $fixture $v2Paths.quality) $quality;RefreshV2
  $compositePlan=(&$tool @argsV2)|ConvertFrom-Json
  Same $old (Inventory $output);$checks.Add('quality v2固定组合通过且不改写原全量exit1')
  RejectBoundMutation '组合验收不得把全量exit1改写0' 'quality' {param($v)$v.checks.test.full.exitCode=0}
  RejectBoundMutation '组合验收不得替换其它测试文件' 'quality' {param($v)$v.checks.test.replacement.path='src/main/ai/other.test.ts'}
  RejectBoundMutation '组合验收不能声称历史根因已定位' 'quality' {param($v)$v.checks.test.historicalRootCause='file-lock'}
  RejectBoundMutation '组合验收必须全部60断言' 'quality' {param($v)$v.checks.test.replacement.passed=59}
  RejectBoundMutation '组合验收计数不得重复旧已通过59项' 'quality' {param($v)$v.checks.test.deduplicated.passed=7014}
  RejectBoundMutation '组合验收须绑定当前测试插桩源码' 'quality' {param($v)$v.checks.test.replacement.afterTestSha256='f'*64}
  RejectBoundMutation '组合验收锁反例不能算进原60项' 'quality' {param($v)$v.checks.test.replacement.report=$v.checks.test.control.report}
  $savedBefore=[IO.File]::ReadAllText((Join-Path $fixture $compositePaths.beforeSource))
  WriteText (Join-Path $fixture $compositePaths.beforeSource) ($savedBefore+'原断言差量')
  $quality.checks.test.replacement.beforeSource=Fact $fixture $compositePaths.beforeSource;$quality.checks.test.replacement.beforeTestSha256=$quality.checks.test.replacement.beforeSource.sha256
  SaveJson (Join-Path $fixture $v2Paths.quality) $quality;RefreshV2
  Reject '组合验收插桩改变原断言后缀拒绝' {&$tool @argsV2}
  WriteText (Join-Path $fixture $compositePaths.beforeSource) $savedBefore;$quality.checks.test.replacement.beforeSource=Fact $fixture $compositePaths.beforeSource;$quality.checks.test.replacement.beforeTestSha256=$quality.checks.test.replacement.beforeSource.sha256
  SaveJson (Join-Path $fixture $v2Paths.quality) $quality;RefreshV2
  $argsV2.Action='Switch';$newSwitch=(&$tool @argsV2)|ConvertFrom-Json
  Same $old (Inventory $newSwitch.previousOutput);$newTree=Inventory $output
  &$tool -Action Rollback -SwitchId $newSwitch.id -EvidenceScope real-provider-20261012|Out-Null
  Same $old (Inventory $output);Same $newTree (Inventory (Join-Path $newSwitch.scope 'rolled-back-candidate'))
  $checks.Add('新scope实际Switch与Rollback保全两树')
  # Browser UX scope: promote the synthetic 0.1.3 candidate to previous output, then validate 0.1.4.
  $providerPrevious=Join-Path $scope 'provider-previous-output-retained'
  [IO.Directory]::Move($output,$providerPrevious)
  [IO.Directory]::Move((Join-Path $newSwitch.scope 'rolled-back-candidate'),$output)
  $previousManifest=Get-Content -LiteralPath (Join-Path $output 'build-provenance.json') -Raw|ConvertFrom-Json
  $old=Inventory $output
  $manifest.source.version='0.1.4';$stem='AIbrowse-0.1.4-win-x64-internal'
  foreach($relative in @(($stem+'.exe'),($stem+'.msi'))){WriteText (Join-Path $release $relative) ('合成浏览器UX安装器 '+$relative)}
  $manifest.installer=Fact $release ($stem+'.exe');$manifest.msi=Fact $release ($stem+'.msi');SaveJson $manifestPath $manifest
  $uxRoot='log/browser-ux-20261012';$uxRecordPath=Join-Path $fixture ($uxRoot+'/equivalence-record.json')
  $uxPaths=[ordered]@{candidateManifest='release/build-provenance.json';previousManifest='output/build-provenance.json';staticBinding=($uxRoot+'/static-binding.json');packageInventory=($uxRoot+'/package-inventory.json');guiEvidence=($uxRoot+'/gui-evidence.json');quality=($uxRoot+'/quality.json');hostConstraint=($uxRoot+'/package-launch-constraint.json');priorQualification='log/real-provider-20261012/equivalence-record.json';independentReview=($uxRoot+'/independent-review.json')}
  SaveJson (Join-Path $fixture $uxPaths.staticBinding) @{version=1;passed=$true;sourceGitSha=$head;manifestSha256=(Fact $fixture $uxPaths.candidateManifest).sha256;executableSha256=$manifest.payload.executable.sha256;asarSha256=$manifest.payload.asar.sha256;guardianSha256=$manifest.payload.guardian.sha256}
  SaveJson (Join-Path $fixture $uxPaths.packageInventory) @{version=1;passed=$true;sourceGitSha=$head;manifestSha256=(Fact $fixture $uxPaths.candidateManifest).sha256;packageRoot='release/win-unpacked';files=$manifest.payload.packageFiles;installers=@{installer=$manifest.installer;msi=$manifest.msi;installerBuild=$manifest.installerBuild}}
  $uxArtifacts=[ordered]@{}
  foreach($width in @(1280,800)){$name='desktop'+$width;$relative=$uxRoot+'/'+$name+'.json';SaveJson (Join-Path $fixture $relative) @{viewport=@{width=$width;height=$(if($width -eq 1280){800}else{600})};failures=@();checks=@{compactChromeOk=$true;noDefaultDebugOk=$true;noBottomChromeOk=$true};dom=@{chrome=@{rect=@{height=80}};address=@{width=$(if($width -eq 1280){790}else{476})}}};$uxArtifacts[$name]=Fact $fixture $relative}
  $relative=$uxRoot+'/bounds.json';$uxBoundsPath=Join-Path $fixture $relative;$uxBounds=@{status='passed';failures=@();captures=@(1..78|ForEach-Object {$expected=@{x=0;y=80;width=1280;height=720};@{browserVisible=$true;checks=@{contentSizeOk=$true;webContentsViewBoundsOk=$true;contrast=13};webContentsViews=@(@{visible=$true;bounds=@{x=0;y=80;width=1280;height=720}});expectedViewBounds=$expected;failures=@()}})};SaveJson $uxBoundsPath $uxBounds;$uxArtifacts.bounds=Fact $fixture $relative
  $navigationNames=@('normal','blank','ctrl','script','dangerous','post','task','ai','真实Bing到bilibili');$navigationSources=@(@{originalPassed=$false;originalExitCode=1;excludedOriginalFailures=@(@{name='iframe';passed=$false})},@{originalPassed=$false;originalExitCode=1;excludedOriginalFailures=@(@{name='iframe';passed=$false})})
  $relative=$uxRoot+'/navigation.json';SaveJson (Join-Path $fixture $relative) @{passed=$true;scope='仅列明的八个本地场景与一次真实Bing到bilibili导航；不是原始整场通过，也不授iframe物理输入通过';cases=@($navigationNames|ForEach-Object {@{name=$_;passed=$true}});excluded=@(@{name='iframe-input-not-delivered';status='NOTRUN';reason='合成保留失败'});sources=$navigationSources};$uxArtifacts.navigation=Fact $fixture $relative
  $uxChecks=@{compactChrome=$true;debugDefaultAbsent=$true;localDataMounted=$true;smallWindow=$true;navigationFromWatch=$true;navigationFromResearch=$true;sidePanelBounds=$true}
  SaveJson (Join-Path $fixture $uxPaths.guiEvidence) @{version=1;scope='browser-ux-navigation-repair';passed=$true;sourceGitSha=$head;actualElectron=$true;runtimeExecutable=(Fact $fixture 'node_modules/electron/dist/electron.exe');checks=$uxChecks;artifacts=$uxArtifacts}
  $uxQuality=@{version=2;sourceGitSha=$head;checks=@{}};foreach($kind in @('typecheck','lint','format','build')){$relative=$uxRoot+'/'+$kind+'.log';WriteText (Join-Path $fixture $relative) ('合成全量门 '+$kind);$uxQuality.checks[$kind]=@{exitCode=0;log=(Fact $fixture $relative)}}
  $uxFullLog=$uxRoot+'/full.log';$uxFullExit=$uxRoot+'/full-exit.json';$uxReplacementReport=$uxRoot+'/conversation-ui-interruption.json';$uxReplacementLog=$uxRoot+'/conversation-ui-interruption.log'
  $uxFullText="FAIL  src/main/ai/conversation-ui-interruption.test.ts > 合成rename失败`nsrc/main/ai/conversation-ui-interruption.test.ts (4 tests | 1 failed)`nstage=rename code=EPERM`nTest Files  1 failed | 474 passed | 1 skipped (476)`nTests  1 failed | 6970 passed | 3 skipped (6974)";WriteText (Join-Path $fixture $uxFullLog) $uxFullText;WriteText (Join-Path $fixture $uxFullExit) '1';WriteText (Join-Path $fixture $uxReplacementLog) '合成原四项复验通过'
  $uxAssertions=@(1..4|ForEach-Object {@{status='passed';fullName=('合成原断言'+$_);failureMessages=@()}})
  SaveJson (Join-Path $fixture $uxReplacementReport) @{success=$true;numTotalTests=4;numPassedTests=4;numFailedTests=0;numPendingTests=0;numTodoTests=0;testResults=@(@{name=(Join-Path $fixture 'src/main/ai/conversation-ui-interruption.test.ts');status='passed';assertionResults=$uxAssertions})}
  $uxCompositeReport=$uxRoot+'/composite-review.md';$uxCompositeReview=$uxRoot+'/composite-review.json';WriteText (Join-Path $fixture $uxCompositeReport) '合成独立组合审核PASS，历史EPERM根因unknown'
  $uxTestSource=(Fact $fixture 'src/main/ai/conversation-ui-interruption.test.ts').sha256
  $uxTest=@{mode='bounded-composite';historicalRootCause='unknown';full=@{exitCode=1;passed=6970;failed=1;skipped=3;log=(Fact $fixture $uxFullLog);exit=(Fact $fixture $uxFullExit)};replacement=@{path='src/main/ai/conversation-ui-interruption.test.ts';exitCode=0;passed=4;failed=0;report=(Fact $fixture $uxReplacementReport);log=(Fact $fixture $uxReplacementLog);sourceSha256=$uxTestSource};deduplicated=@{passed=6971;skipped=3}}
  SaveJson (Join-Path $fixture $uxCompositeReview) @{version=1;sourceGitSha=$head;conclusion='PASS_WITH_UNKNOWN_HISTORICAL_EPERM';proofs=@{fullLog=$uxTest.full.log.sha256;fullExit=$uxTest.full.exit.sha256;replacementReport=$uxTest.replacement.report.sha256;replacementLog=$uxTest.replacement.log.sha256;sourceSha256=$uxTestSource};report=(Fact $fixture $uxCompositeReport)}
  $uxTest.review=Fact $fixture $uxCompositeReview;$uxQuality.checks.test=$uxTest;SaveJson (Join-Path $fixture $uxPaths.quality) $uxQuality
  SaveJson (Join-Path $fixture $uxPaths.hostConstraint) @{version=1;sourceGitSha=$head;status='NOTRUN';reason='host-profile-path-redirection-blocked';blockedByHostPathRedirection=$true;packageExecuted=$false}
  $uxProofs=[ordered]@{};foreach($name in $uxPaths.Keys){if($name -ne 'independentReview'){$uxProofs[$name]=Fact $fixture $uxPaths[$name]}}
  $uxReviewReport=$uxRoot+'/independent-review.md';WriteText (Join-Path $fixture $uxReviewReport) '合成独立浏览器UI与导航审核 PASS，包启动NOTRUN'
  $uxReviewHashes=[ordered]@{};foreach($name in $uxProofs.Keys){$uxReviewHashes[$name]=$uxProofs[$name].sha256}
  $uxReview=@{version=1;sourceGitSha=$head;conclusion='PASS_WITH_NOTRUN_PACKAGED_STARTUP';proofs=$uxReviewHashes;report=(Fact $fixture $uxReviewReport)}
  SaveJson (Join-Path $fixture $uxPaths.independentReview) $uxReview;$uxProofs.independentReview=Fact $fixture $uxPaths.independentReview
  $uxRecord=@{version=3;qualification='EquivalentEvidence';passed=$true;scope='browser-ux-navigation-repair';packageLaunchTested=$false;packageLaunchStatus='NOTRUN';packageLaunchNotRunReason='host-profile-path-redirection-blocked';sourceGitSha=$head;reviewerConclusion='PASS_WITH_NOTRUN_PACKAGED_STARTUP';machine=@{computerName=[Environment]::MachineName;platform='win32';architecture='x64'};proofs=$uxProofs}
  SaveJson $uxRecordPath $uxRecord
  $uxArgs=@{Action='CheckOnly';PackageJournal=$journal;Qualification='EquivalentEvidence';EquivalenceRecord=$uxRecordPath;EvidenceScope='browser-ux-20261012'}
  $uxPlan=(&$tool @uxArgs)|ConvertFrom-Json
  if($uxPlan.source.version -cne '0.1.4' -or $uxPlan.packageLaunchTested -or $uxPlan.packageLaunchStatus -cne 'NOTRUN'){throw '浏览器UX计划边界不符'}
  Same $old (Inventory $output);$checks.Add('浏览器UX新scope闭合0.1.4与旧0.1.3且诚实NOTRUN')
  function RefreshUx([string]$name){$uxProofs[$name]=Fact $fixture $uxPaths[$name];if($name -ne 'independentReview'){$uxReview.proofs[$name]=$uxProofs[$name].sha256;SaveJson (Join-Path $fixture $uxPaths.independentReview) $uxReview;$uxProofs.independentReview=Fact $fixture $uxPaths.independentReview};SaveJson $uxRecordPath $uxRecord}
  $uxQuality.checks.test.full.exitCode=0;SaveJson (Join-Path $fixture $uxPaths.quality) $uxQuality;RefreshUx 'quality';Reject '浏览器UX组合门不得伪造全量exit0' {&$tool @uxArgs}
  $uxQuality.checks.test.full.exitCode=1;SaveJson (Join-Path $fixture $uxPaths.quality) $uxQuality;RefreshUx 'quality'
  $uxQuality.checks.test.replacement.sourceSha256='f'*64;SaveJson (Join-Path $fixture $uxPaths.quality) $uxQuality;RefreshUx 'quality';Reject '浏览器UX组合门必须绑定原四项源码' {&$tool @uxArgs}
  $uxQuality.checks.test.replacement.sourceSha256=$uxTestSource;SaveJson (Join-Path $fixture $uxPaths.quality) $uxQuality;RefreshUx 'quality'
  WriteText (Join-Path $fixture $uxFullLog) ($uxFullText+"`nFAIL  src/main/ai/other.test.ts > 合成混入失败");$uxQuality.checks.test.full.log=Fact $fixture $uxFullLog;SaveJson (Join-Path $fixture $uxPaths.quality) $uxQuality;RefreshUx 'quality';Reject '浏览器UX组合门拒绝混入不同FAIL路径' {&$tool @uxArgs}
  WriteText (Join-Path $fixture $uxFullLog) $uxFullText;$uxQuality.checks.test.full.log=Fact $fixture $uxFullLog;SaveJson (Join-Path $fixture $uxPaths.quality) $uxQuality;RefreshUx 'quality'
  $uxBounds.captures[0].webContentsViews[0].bounds.width=1279;SaveJson $uxBoundsPath $uxBounds;$uxArtifacts.bounds=Fact $fixture ($uxRoot+'/bounds.json');SaveJson (Join-Path $fixture $uxPaths.guiEvidence) @{version=1;scope='browser-ux-navigation-repair';passed=$true;sourceGitSha=$head;actualElectron=$true;runtimeExecutable=(Fact $fixture 'node_modules/electron/dist/electron.exe');checks=$uxChecks;artifacts=$uxArtifacts};RefreshUx 'guiEvidence';Reject '浏览器UX可见View坐标错配拒绝' {&$tool @uxArgs}
  $uxBounds.captures[0].webContentsViews[0].bounds.width=1280;SaveJson $uxBoundsPath $uxBounds;$uxArtifacts.bounds=Fact $fixture ($uxRoot+'/bounds.json');SaveJson (Join-Path $fixture $uxPaths.guiEvidence) @{version=1;scope='browser-ux-navigation-repair';passed=$true;sourceGitSha=$head;actualElectron=$true;runtimeExecutable=(Fact $fixture 'node_modules/electron/dist/electron.exe');checks=$uxChecks;artifacts=$uxArtifacts};RefreshUx 'guiEvidence'
  $desktop800Path=Join-Path $fixture ($uxRoot+'/desktop800.json');$desktop800=Get-Content -LiteralPath $desktop800Path -Raw|ConvertFrom-Json;$desktop800.failures=@('合成溢出失败');SaveJson $desktop800Path $desktop800;$uxArtifacts.desktop800=Fact $fixture ($uxRoot+'/desktop800.json')
  SaveJson (Join-Path $fixture $uxPaths.guiEvidence) @{version=1;scope='browser-ux-navigation-repair';passed=$true;sourceGitSha=$head;actualElectron=$true;runtimeExecutable=(Fact $fixture 'node_modules/electron/dist/electron.exe');checks=$uxChecks;artifacts=$uxArtifacts};RefreshUx 'guiEvidence';Reject '浏览器UX原始桌面失败不可由wrapper通过掩盖' {&$tool @uxArgs}
  $desktop800.failures=@();SaveJson $desktop800Path $desktop800;$uxArtifacts.desktop800=Fact $fixture ($uxRoot+'/desktop800.json');SaveJson (Join-Path $fixture $uxPaths.guiEvidence) @{version=1;scope='browser-ux-navigation-repair';passed=$true;sourceGitSha=$head;actualElectron=$true;runtimeExecutable=(Fact $fixture 'node_modules/electron/dist/electron.exe');checks=$uxChecks;artifacts=$uxArtifacts};RefreshUx 'guiEvidence'
  $uxProofs.guiEvidence.sha256='f'*64;SaveJson $uxRecordPath $uxRecord;Reject '浏览器UX篡改摘要拒绝' {&$tool @uxArgs};RefreshUx 'guiEvidence'
  $uxRecord.sourceGitSha='f'*40;SaveJson $uxRecordPath $uxRecord;Reject '浏览器UX错误源码拒绝' {&$tool @uxArgs};$uxRecord.sourceGitSha=$head;SaveJson $uxRecordPath $uxRecord
  $uxChecks.navigationFromResearch=$false;SaveJson (Join-Path $fixture $uxPaths.guiEvidence) @{version=1;scope='browser-ux-navigation-repair';passed=$true;sourceGitSha=$head;actualElectron=$true;runtimeExecutable=(Fact $fixture 'node_modules/electron/dist/electron.exe');checks=$uxChecks;artifacts=$uxArtifacts};RefreshUx 'guiEvidence';Reject '浏览器UX失败导航证据拒绝' {&$tool @uxArgs}
  $uxChecks.navigationFromResearch=$true;SaveJson (Join-Path $fixture $uxPaths.guiEvidence) @{version=1;scope='browser-ux-navigation-repair';passed=$true;sourceGitSha=$head;actualElectron=$true;runtimeExecutable=(Fact $fixture 'node_modules/electron/dist/electron.exe');checks=$uxChecks;artifacts=$uxArtifacts};RefreshUx 'guiEvidence'
  $previousManifest.source.version='0.1.2';SaveJson (Join-Path $output 'build-provenance.json') $previousManifest;RefreshUx 'previousManifest'
  $wrongOldRejected=$false;try{&$tool @uxArgs|Out-Null}catch{$wrongOldRejected=$true};if(-not $wrongOldRejected){throw '合成反例未拒绝：浏览器UX旧包版本错配拒绝'}
  $previousManifest.source.version='0.1.3';SaveJson (Join-Path $output 'build-provenance.json') $previousManifest;RefreshUx 'previousManifest';Same $old (Inventory $output);$checks.Add('浏览器UX旧包版本错配拒绝')
  $uxArgs.Action='Switch';$uxSwitch=(&$tool @uxArgs)|ConvertFrom-Json
  Same $old (Inventory $uxSwitch.previousOutput);$uxNew=Inventory $output
  &$tool -Action Rollback -SwitchId $uxSwitch.id -EvidenceScope browser-ux-20261012|Out-Null
  Same $old (Inventory $output);Same $uxNew (Inventory (Join-Path $uxSwitch.scope 'rolled-back-candidate'))
  $checks.Add('浏览器UX实际Switch与Rollback反例保全0.1.3及0.1.4两树')
  if((Get-FileHash -LiteralPath $tool).Hash.ToLowerInvariant() -cne $toolSourceSha256 -or (Get-FileHash -LiteralPath $PSCommandPath).Hash.ToLowerInvariant() -cne $testSourceSha256){throw 'fixture运行期间工具或测试源码变化'}
  SaveJson (Join-Path $scope 'result.json') @{passed=$true;checks=$checks;checkCount=$checks.Count;sourceSha256=$toolSourceSha256;testSha256=$testSourceSha256;realOutputTouched=$false;realProfileTouched=$false;productExecuted=$false;syntheticEvidenceOnly=$true;switchId=$switched.id}
  @{passed=$true;scope=$scope;checks=$checks.Count;syntheticEvidenceOnly=$true}|ConvertTo-Json
} catch {
  SaveJson (Join-Path $scope 'failure.json') @{passed=$false;error=$_.Exception.Message;checks=$checks;realOutputTouched=$false;productExecuted=$false}
  throw
}
