[CmdletBinding()]
param(
  [ValidateSet('CheckOnly','Switch','Rollback')][string]$Action='CheckOnly',
  [string]$PackageJournal='',
  [ValidateSet('PackageSmoke','EquivalentEvidence')][string]$Qualification='PackageSmoke',
  [string]$EquivalenceRecord='',
  [ValidatePattern('^[a-f0-9]{32}$')][string]$SwitchId=''
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$release=Join-Path $repository 'release'
$output=Join-Path $repository 'output'
$evidence=Join-Path $repository 'log/legacy-followup-20261012'
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
  if($Qualification -eq 'PackageSmoke'){Need ($source -ceq $current) '包来源不是当前源码';return}
  & git -C $repository merge-base --is-ancestor $source $current
  Need ($LASTEXITCODE -eq 0) '包来源不是当前源码祖先'
  $changed=@(& git -C $repository diff --name-only --no-renames $source $current --)
  Need ($LASTEXITCODE -eq 0) '无法核对来源源码差量'
  $allowed=@('doc/tasks/legacy-repair.md','doc/tasks/progress.md','tools/legacy-followup/output-switch.ps1','tools/legacy-followup/output-switch.test.ps1')
  foreach($path in $changed){Need ($path -cin $allowed) '来源之后存在产品、构建或依赖差量'}
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
Idle
$journal=SafePath $PackageJournal
Need ([IO.Path]::GetDirectoryName($journal) -ceq (Join-Path $evidence 'package') -and [IO.Path]::GetFileName($journal) -cmatch '^journal-[a-f0-9]{32}$') '不是固定PackageSmoke journal'
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
  NewJson (Join-Path $scope 'failure.json') @{passed=$false;error=$problem;oldMoved=$oldMoved;newMoved=$newMoved;originalUntouched=(-not $oldMoved);originalRestored=$restored;restoreError=$restoreProblem;recoveryCommand=('pwsh -NoProfile -File tools/legacy-followup/output-switch.ps1 -Action Rollback -SwitchId '+$id)}
  throw "换包失败，证据与所有目录保留：$problem；回退状态=$restored"
}
