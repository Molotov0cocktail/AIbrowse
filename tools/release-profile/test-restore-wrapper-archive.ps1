[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'test-restore-wrapper-admission.ps1') -LibraryOnly
$loader=$type.GetNestedType('CompletedArchiveEvidence',[Reflection.BindingFlags]::NonPublic)
$archiveConstructor=$loader.GetConstructor([Reflection.BindingFlags]'Instance,NonPublic',$null,[type[]]@([string],[string],[string]),$null)
$archiveRows=[Collections.Generic.List[object]]::new()
function Record([string]$Root,[string]$Name,$Value) {
    $path=Join-Path $Root $Name
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))|Out-Null
    Write-Json $path $Value
}
function Process-Fact([uint32]$Id,[string]$Role,[uint32]$Parent,[string]$Image,[bool]$Exited=$true) {
    return @{pid=$Id;created=([long]$Id*100).ToString();image=$Image;imageIdentity=('a'*64);parentPid=$Parent;role=$Role;session=$(if($Role -eq 'guardian'){'e'*32}else{$null});registeredWriter=$false;signaled=$Exited;exitCode=$(if($Exited){0}else{$null});exitFileTime=$(if($Exited){([long]$Id*100+50).ToString()}else{$null})}
}
function Identity-Of($Fact) { return @{pid=$Fact.pid;created=$Fact.created;image=$Fact.image} }
function Archive-Fixture([string]$Scene,[string]$Fault) {
    $f=Fixture 'normal';$env:AIBROWSE_PROFILE_TOOL_REPOSITORY=$f.Repo
    $runId=[Guid]::NewGuid().ToString('N');$journal=Join-Path $f.Repo ('log/stage7-e1/disposable-profile/journal-'+$runId)
    $run='runner-output/restore-campaign/';$proof=[IO.File]::ReadAllText($f.Proof)|ConvertFrom-Json -AsHashtable
    $exe=Join-Path $f.Package 'AIbrowse.exe';$guardian=Join-Path $f.Package 'resources/lifecycle-guardian/guardian.exe'
    $profile=Join-Path $f.Repo 'synthetic-profile'
    $rootIdentity=@{Requested=$profile;FinalDos=$profile;FinalGuid='fixture';FinalNt='fixture';VolumeSerial64=('1'*16);FileId128=('2'*32);Sddl='fixture';FileSystem='NTFS';Attributes=16}
    Record $journal 'manifest.json' @{Version=2;RunId=$runId;DeclaredProfile=$profile;ResolvedProfile=$profile;PackageExecutable=$exe;BindingJournal='';RootIdentity=$rootIdentity}
    $total=if($Scene -eq 'R'){4410000}else{2990000}
    Record $journal 'terminal.json' @{version=1;runId=$runId;ok=$true;result=0;jobReleased=$true;markerValidated=$true;failureType='';failureMessage=''}
    Record $journal 'restore-admission.json' @{version=1;runId=$runId;scene=$Scene;scopeId=$f.Id;proofSha256=$f.Expected;nodeExecutable=$f.Node;preflightElapsedMs=10;sceneBudgetMs=$total;toolBudgetMs=180000}
    Record $journal 'restore-start.json' @{version=1;runId=$runId;scene=$Scene;proofSha256=$f.Expected;preflightElapsedMs=20}
    Record $journal 'restore-terminal.json' @{version=1;runId=$runId;scene=$Scene;scopeId=$f.Id;proofSha256=$f.Expected;elapsedMs=2000;sceneBudgetMs=$total;preflightElapsedMs=15;ok=$true}
    $limits=@{R=4410000;P=2990000;ui=30000;helper=35000;boot=60000;close=30000;partial=20000;transfer=1500000;offline=180000;actions=32}
    Record $journal ($run+'launch-contract.json') @{version=1;scene=$Scene;limits=$limits;proof=$proof;noClaims=@('E2整体通过','独立Windows环境','物理磁盘耗尽','真实Provider');arguments=@{initial=@('--force-renderer-accessibility');cold=@();successor='产品guardian固定继任参数'}}
    $actions=if($Scene -eq 'R'){@('BootHealthy','OpenBackup','SaveBackup','WaitBackupCompleted','Close','BootHealthy','OpenRestore','CancelOpen','WaitCancelled','OpenRestore','SelectRestore','Cancel','WaitCancelled','OpenRestore','SelectRestore','Approve','BootHealthy','ReadSources','ReadResearch','ReadWatch','ReadConversation','Close','BootHealthy','ReadSources','ReadResearch','ReadWatch','ReadConversation','Close')}else{@('BootPartial','OpenPartial','Cancel','WaitCancelled','OpenPartial','Approve','BootRecovery','OpenRestore','CancelOpen','WaitCancelled','OpenRestore','SelectRestore','Cancel','WaitCancelled','OpenRestore','SelectRestore','Approve','BootHealthy','ReadSources','ReadResearch','ReadWatch','ReadConversation','Close','BootHealthy','ReadSources','ReadResearch','ReadWatch','ReadConversation','Close')}
    $gone=if($Scene -eq 'R'){3}else{2};$leases=if($Scene -eq 'R'){@(0,0)}else{@(0)}
    Record $journal ($run+'report.json') @{version=1;scene=$Scene;ok=$true;result=@{scene=$Scene;actions=$actions.Count;offlineMs=500};elapsedMs=1000;pending=0;children=0;observers=@(0);leases=@($leases);failure='none';outerJobReleaseRequired=$true;productGoneChecks=$gone}
    Record $journal ($run+'child-receipts.json') @(@{pid=900;exitSeen=$true;exitCode=0;closeCode=0;failed=$false;stderrBytes=0;stderrBase64=''})
    for($i=1;$i -le $gone;$i++){Record $journal ($run+'job-quiescent-'+$i+'.json') @{version=1;hardTotalLimit=24;limitFlags=0x2008;total=1;sampledCounts=@{main=0;guardian=0;chromium=0;utility=0;tools=1};identities=@(@{Pid=900;CreatedFileTime=90;Image='node.exe'})}}
    $oracle=@{bytes=9000;hashes=@{sources=('a'*64);research=('b'*64);watch=('c'*64);conversations=('d'*64)}}
    foreach($name in @('verify-oracle','verify-cold-oracle','fixture-A',$(if($Scene -eq 'R'){'fixture-B'}else{'fixture-H'}))){Record $journal ($run+$name+'.json') $oracle}
    if($Scene -eq 'R'){Record $journal ($run+'rollback-B-oracle.json') $oracle}else{
        Record $journal ($run+'bad-index-proof.json') @{bytes=6;sha256=('f'*64)}
        Record $journal ($run+'rollback-bad-index.json') @{preserved=$true;sha256=('f'*64)}
        Record $journal ($run+'recovery-entry.json') @{gatePresent=$true;badIndexPreserved=$true;storeClaim='fixture'}
    }
    $backup=if($Scene -eq 'R'){'product-A'}else{'synthetic-H'};$backupPath=Join-Path $journal ($run+$backup+'.aibak');[IO.File]::WriteAllText($backupPath,'fixed backup')
    $wire=@{bytes=(Get-Item -LiteralPath $backupPath).Length;sha256=(Hash $backupPath);snapshotId=[Guid]::NewGuid().ToString();productVersion='0.1.0';members=@('sources','research','watch','conversations'|ForEach-Object{@{id=$_;present=$true;schemaVersion=1;bytes=5;sha256=('a'*64)}})}
    if($Scene -eq 'P'){$wire.origin='受控合成生产管线备份'}
    Record $journal ($run+$backup+'-wire.json') $wire
    $initial=Process-Fact 10 'main' 1 $exe;$a=Process-Fact 20 'main' 1 $exe;$recovery=Process-Fact 30 'main' 11 $exe;$restored=Process-Fact 40 'main' 21 $exe;$cold=Process-Fact 50 'main' 1 $exe
    $receiptBase=@{version=1;runId=$runId;elapsedMs=100;budgetMs=30000;manifestSha256=(Hash (Join-Path $journal 'manifest.json'));markerSha256=('a'*64);bindingSha256=$proof.bindingSha256;executableSha256=$proof.executableSha256;guardianSha256=$proof.guardianSha256;profile=@{fileId128=('2'*32);volumeSerial64=('1'*16);guardianRootHash=('b'*64)};limits=@{flags=0x2008;total=24;held=4;records=8;bytes=2000}}
    $ledger=@{version=1;root=('b'*64);session=('e'*32);main=$null;utility=$null};$members=@(@{pid=900;created='9000';role='tool'})
    $ordinary=if($Scene -eq 'R'){@($initial,$cold)}else{@($cold)}
    foreach($main in $ordinary){$receipt=$receiptBase.Clone();$receipt.initial=Identity-Of $main;$receipt.main=$main.Clone();$receipt.main.Remove('registeredWriter');$receipt.guardian=Process-Fact ($main.pid+1) 'guardian' $main.pid $guardian;$receipt.guardian.Remove('registeredWriter');$receipt.ledger=$ledger;$receipt.ledgerSha256='a'*64;$receipt.members=$members;Record $journal ('runner-output/ordinary-'+$main.pid+'-'+$main.created+'/retired.json') $receipt}
    $count=if($Scene -eq 'R'){1}else{2}
    for($t=1;$t -le $count;$t++){
        $old=if($Scene -eq 'R'){$a}elseif($t -eq 1){$initial}else{$recovery};$next=if($Scene -eq 'P' -and $t -eq 1){$recovery}else{$restored}
        $approvalSequence=if($Scene -eq 'R'){16}elseif($t -eq 1){6}else{17}
        $receipt=$receiptBase.Clone();$receipt.scene=$Scene;$receipt.transition=$t;$receipt.kind='transition'
        $alive=$next.Clone();$alive.signaled=$false;$alive.exitCode=$null;$alive.exitFileTime=$null
        $receipt.sample=@{main=1;guardian=1;chromium=0;utility=0;tools=1;members=$members}
        $receipt.facts=@{oldMain=$old;oldGuardian=(Process-Fact ($old.pid+1) 'guardian' $old.pid $guardian);newMain=$alive;newGuardian=(Process-Fact ($next.pid+1) 'guardian' $next.pid $guardian $false);approval=@{sequence=$approvalSequence;sha256=('a'*64)};heldUtilities=@();uncaptured=@();utilityCoverage='held-observations-plus-guardian-retirement';oldSession=('d'*32);newSession=('e'*32);ledger=$ledger;ledgerSha256=('a'*64);successorSeenMs=10}
        Record $journal ('runner-output/restore-process-'+$Scene+'/t'+$t+'-transition.json') $receipt
    }
    $final=$receiptBase.Clone();$final.scene=$Scene;$final.transition=$count;$final.kind='final';$final.facts=@{currentMain=$restored;currentGuardian=(Process-Fact 41 'guardian' 40 $guardian);ledger=$ledger;ledgerSha256=('a'*64);held=@($restored,(Process-Fact 41 'guardian' 40 $guardian));utilityCoverage='held-observations-plus-guardian-retirement'};$final.sample=@{main=0;guardian=0;chromium=0;utility=0;tools=1;members=$members}
    Record $journal ('runner-output/restore-process-'+$Scene+'/t'+$count+'-final.json') $final
    for($i=0;$i -lt $actions.Count;$i++){
        $sequence=$i+1;$action=$actions[$i]
        if($action -in @('Approve','Cancel')){
            $transition=if($Scene -eq 'R' -or $sequence -le 6){1}else{2};$purpose=if($Scene -eq 'P' -and $sequence -le 6){'partial'}else{'restore'};$outcome=if($action -eq 'Approve'){'approved'}else{'cancelled'}
            $prefix='runner-output/restore-native/'+$Scene+'-t'+$transition+'-a'+$sequence
            Record $journal ($prefix+'-start.json') @{version=1;scene=$Scene;transition=$transition;actionSequence=$sequence;purpose=$purpose;action=$action}
            Record $journal ($prefix+'-native.json') @{version=1;scene=$Scene;transition=$transition;actionSequence=$sequence;purpose=$purpose;result=$outcome;ok=$true;actionCount=1;elapsedMs=10;failure='none'}
            Record $journal ($prefix+'.json') @{version=1;runId=$runId;scene=$Scene;transition=$transition;actionSequence=$sequence;purpose=$purpose;result=$outcome;nativeReceiptSha256=(Hash (Join-Path $journal ($prefix+'-native.json')))}
            if($action -eq 'Approve'){$path=Join-Path $journal ('runner-output/restore-process-'+$Scene+'/t'+$transition+'-transition.json');$value=[IO.File]::ReadAllText($path)|ConvertFrom-Json -AsHashtable;$value.facts.approval.sha256=Hash (Join-Path $journal ($prefix+'.json'));Write-Json $path $value}
        }else{
            $main=if($Scene -eq 'R'){if($sequence -le 5){$initial}elseif($sequence -le 16){$a}elseif($sequence -le 22){$restored}else{$cold}}else{if($sequence -le 6){$initial}elseif($sequence -le 17){$recovery}elseif($sequence -le 23){$restored}else{$cold}}
            Record $journal ('runner-output/restore-ui/'+$Scene+'-a'+$sequence+'.json') @{version=1;scene=$Scene;actionSequence=$sequence;action=$action;ok=$true;identity=(Identity-Of $main);mainWindowHandle='500';elapsedMs=10;failure='none'}
        }
    }
    switch($Fault){
        'missing-ui' {[IO.File]::Move((Join-Path $journal ('runner-output/restore-ui/'+$Scene+'-a1.json')),(Join-Path $journal 'preserved-missing-ui.json'))}
        'missing-oracle' {[IO.File]::Move((Join-Path $journal ($run+'verify-cold-oracle.json')),(Join-Path $journal 'preserved-missing-oracle.json'))}
        'late-terminal' {$path=Join-Path $journal 'restore-terminal.json';$value=[IO.File]::ReadAllText($path)|ConvertFrom-Json -AsHashtable;$value.elapsedMs=$total;Write-Json $path $value}
        'invalid-close' {Record $journal 'restore-invalid.json' @{version=1;reason='terminal-close-late'}}
        'failed-job' {$path=Join-Path $journal 'terminal.json';$value=[IO.File]::ReadAllText($path)|ConvertFrom-Json -AsHashtable;$value.jobReleased=$false;Write-Json $path $value}
        'residual-product' {$path=Join-Path $journal ($run+'job-quiescent-1.json');$value=[IO.File]::ReadAllText($path)|ConvertFrom-Json -AsHashtable;$value.sampledCounts.chromium=1;Write-Json $path $value}
        'cold-mixed' {$path=Join-Path $journal ($run+'verify-cold-oracle.json');$value=[IO.File]::ReadAllText($path)|ConvertFrom-Json -AsHashtable;$value.hashes.watch='0'*64;Write-Json $path $value}
        'native-count' {$n=if($Scene -eq 'R'){16}else{6};$path=Join-Path $journal ('runner-output/restore-native/'+$Scene+'-t1-a'+$n+'-native.json');$value=[IO.File]::ReadAllText($path)|ConvertFrom-Json -AsHashtable;$value.actionCount=2;Write-Json $path $value}
        'pending-child' {$path=Join-Path $journal ($run+'report.json');$value=[IO.File]::ReadAllText($path)|ConvertFrom-Json -AsHashtable;$value.children=1;Write-Json $path $value}
        'backup-changed' {[IO.File]::AppendAllText($backupPath,'changed')}
        'wrong-proof' {$f.Expected='0'*64}
    }
    $f.Journal=$journal;return $f
}
try{
    foreach($scene in @('R','P')){
        foreach($fault in @('normal','missing-ui','missing-oracle','late-terminal','invalid-close','failed-job','residual-product','cold-mixed','native-count','pending-child','backup-changed','wrong-proof')){
            $f=Archive-Fixture $scene $fault;$lease=$null;$accepted=$false
            try{$lease=$archiveConstructor.Invoke(@([string]$f.Journal,[string]$f.Id,[string]$f.Expected));$accepted=$true}catch{if($fault -eq 'normal'){Write-Output $_.Exception.InnerException.ToString();throw}}finally{if($null -ne $lease){$lease.Dispose()}}
            if($accepted -ne ($fault -eq 'normal')){throw ('归档判定错误：'+$scene+'/'+$fault)}
            $archiveRows.Add(@{scene=$scene;case=$fault;accepted=$accepted})
        }
    }
    Write-Json (Join-Path $evidence 'archive-report.json') @{ok=$true;cases=$archiveRows;productExecuted=$false;archiveExecuted=$false;profileTouched=$false}
    Write-Output ('恢复成功归档只读加载器 '+$archiveRows.Count+' 项通过；未执行归档或触碰真实profile。原件：'+$evidence)
}finally{$env:AIBROWSE_PROFILE_TOOL_REPOSITORY=$previous}
