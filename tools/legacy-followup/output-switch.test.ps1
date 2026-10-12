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
  SaveJson (Join-Path $scope 'result.json') @{passed=$true;checks=$checks;checkCount=$checks.Count;sourceSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'output-switch.ps1')).Hash.ToLowerInvariant();testSha256=(Get-FileHash -LiteralPath $PSCommandPath).Hash.ToLowerInvariant();realOutputTouched=$false;realProfileTouched=$false;productExecuted=$false;syntheticEvidenceOnly=$true;switchId=$switched.id}
  @{passed=$true;scope=$scope;checks=$checks.Count;syntheticEvidenceOnly=$true}|ConvertTo-Json
} catch {
  SaveJson (Join-Path $scope 'failure.json') @{passed=$false;error=$_.Exception.Message;checks=$checks;realOutputTouched=$false;productExecuted=$false}
  throw
}
