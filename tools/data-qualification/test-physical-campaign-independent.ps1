[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$evidence=Join-Path $repository 'log/stage7-e2/physical-campaign-independent-review-001'
[IO.Directory]::CreateDirectory($evidence)|Out-Null
$runRoot=Join-Path $evidence ('counterexamples-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($runRoot)|Out-Null
$candidate=Join-Path $PSScriptRoot 'physical-full-transfer/run.ps1'
$text=[IO.File]::ReadAllText($candidate)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors)
if($errors.Count){throw '候选语法失败'}
function Original-Function([string]$Name){
    $found=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $Name})
    if($found.Count -ne 1){throw '函数边界不唯一'}
    return $found[0]
}
function Replace-Once([string]$Source,[string]$Before,[string]$After){
    if($Source.Split($Before).Count -ne 2){throw '注入边界不唯一'}
    return $Source.Replace($Before,$After)
}
$functions=@('Check-Time','Assert-Parents','Read-BoundFile','Assert-Deadline','Assert-ImportAdmission','Read-ClosedSmallHash')|ForEach-Object{(Original-Function $_).Extent.Text}
$receipt=(Original-Function 'Write-Receipt').Extent.Text
$receipt=Replace-Once $receipt 'if($bytes.Length -gt 65536)' "Test-ReceiptBoundary `$Path 'serialize'; if(`$bytes.Length -gt 65536)"
$receipt=Replace-Once $receipt '$stream.Flush($true);Check-Time' '$stream.Flush($true);Test-ReceiptBoundary $Path ''flush'';Check-Time'
$receipt=Replace-Once $receipt '$stream.Dispose()' '$stream.Dispose();Test-ReceiptBoundary $Path ''close'''
$receipt=Replace-Once $receipt 'if(-not $Hold){[pscustomobject]' 'Test-ReceiptBoundary $Path ''move''; if(-not $Hold){[pscustomobject]'
$phase=Original-Function 'Invoke-Phase'
$phaseTry=@($phase.Body.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})[0]
$workload=@'
    [IO.File]::AppendAllText((Join-Path $scope 'calls.txt'),$Mode+[Environment]::NewLine)
    if($caseName -ceq 'import-missing-helper'){$null=Read-BoundFile (Join-Path $scope 'FixedTransferJob.cs') 65536 $true}
    $script:phaseMode=$Mode;$script:phaseClock=$clock;$script:phaseWorkMs=$workMs
    $saved=@{review='synthetic'}
    $realHandle=[IO.File]::Open((Join-Path $scope ($Mode+'-handle')), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $locks.Add($realHandle)
    $mockHandle=[pscustomobject]@{}
    $mockHandle|Add-Member -MemberType ScriptMethod -Name Dispose -Value {
        [IO.File]::AppendAllText((Join-Path $scope 'cleanup.txt'),$script:phaseMode+'-close'+[Environment]::NewLine)
        if($caseName -ceq ($script:phaseMode+'-close-failure')){throw '独立注入关闭失败'}
        if($caseName -ceq ($script:phaseMode+'-close-late')){$script:phaseClock.Elapsed.TotalMilliseconds=$script:phaseWorkMs+1}
    }
    $locks.Add($mockHandle)
    if($caseName -eq ($Mode+'-work-failure') -or $caseName -ceq 'forged-disk'){throw '独立注入工作失败'}
    $result.job=@{Succeeded=$true;ActualZero=$true;OwnershipRetained=$false}
    if($Mode -ceq 'import'){
        [IO.File]::WriteAllText((Join-Path $scope 'input-proof.json'),'synthetic bounded input proof')
        $result['inputProofSha256']=(Get-FileHash -LiteralPath (Join-Path $scope 'input-proof.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        if($caseName -ceq 'import-wrong-hash'){$result['inputProofSha256']='0'*64}
        if($caseName -ceq 'import-ownership'){$result.job.OwnershipRetained=$true}
    }
    Assert-Held
'@
$phaseSource=$phase.Extent.Text
$relativeStart=$phaseTry.Body.Extent.StartOffset-$phase.Extent.StartOffset
$phaseSource=$phaseSource.Substring(0,$relativeStart)+'{'+[Environment]::NewLine+$workload+[Environment]::NewLine+'}'+$phaseSource.Substring($relativeStart+$phaseTry.Body.Extent.Text.Length)
$phaseSource=Replace-Once $phaseSource '$locks=[Collections.Generic.List[IO.FileStream]]::new()' '$locks=[Collections.Generic.List[object]]::new()'
$phaseSource=Replace-Once $phaseSource 'return [pscustomobject]$result' "if(`$caseName -ceq (`$Mode+'-return-late')){`$clock.Elapsed.TotalMilliseconds=`$workMs+1}; return [pscustomobject]`$result"
$mainStart=@($ast.EndBlock.Statements|Where-Object {$_.Extent.Text.StartsWith('$campaignResult=')})[0].Extent.StartOffset
$main=$text.Substring($mainStart)
$main=Replace-Once $main '$transferClock=[Diagnostics.Stopwatch]::StartNew()' '$transferClock=[pscustomobject]@{Elapsed=[pscustomobject]@{TotalMilliseconds=1}}'
$main=Replace-Once $main '$successStdout=$campaignResult|ConvertTo-Json -Depth 16' '$successStdout=$campaignResult|ConvertTo-Json -Depth 16; if($caseName -ceq ''final-serialize-late''){$clock.Elapsed.TotalMilliseconds=$workMs+1}'
$main=Replace-Once $main '[Console]::Out.WriteLine($successStdout)' @'
    if($caseName -ceq 'stdout-failure'){throw '独立注入stdout失败'}
    [Console]::Out.WriteLine($successStdout)
    [IO.File]::WriteAllText((Join-Path $scope 'success-stdout-observed'),'true')
    if($caseName -ceq 'stdout-late'){$clock.Elapsed.TotalMilliseconds=$workMs+1}
'@
$prelude=@'
param([string]$scope,[string]$caseName)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$ScopeId='physical-full-transfer-'+('0'*32)
$clock=[pscustomobject]@{Elapsed=[pscustomobject]@{TotalMilliseconds=1}}
$workMs=120000;$nativeLoaded=$false;$boundDirectories=@{}
function Test-ReceiptBoundary([string]$Path,[string]$Boundary){
    $prefix=if($Path.EndsWith('import-result.pending-wrapper-exit.json')){'import'}elseif($Path.EndsWith('transfer-result.pending-wrapper-exit.json')){'transfer'}elseif($Path.EndsWith('wrapper-result.pending-wrapper-exit.json')){'final'}else{'claim'}
    if($caseName -ceq ($prefix+'-receipt-'+$Boundary+'-late')){
        if($Boundary -ceq 'move'){[IO.File]::Move($Path,$Path+'.late-move',$false)}
        $clock.Elapsed.TotalMilliseconds=$workMs+1
    }
}
function Restore-Environment([hashtable]$Saved){
    [IO.File]::AppendAllText((Join-Path $scope 'cleanup.txt'),$script:phaseMode+'-restore'+[Environment]::NewLine)
    if($caseName -ceq ($script:phaseMode+'-environment-failure')){throw '独立注入环境恢复失败'}
    if($caseName -ceq ($script:phaseMode+'-environment-late')){$script:phaseClock.Elapsed.TotalMilliseconds=$script:phaseWorkMs+1}
}
function Assert-Held {if($caseName -ceq 'import-identity-failure'){throw '独立注入身份失败'}}
if($caseName -ceq 'forged-disk'){
    [IO.File]::WriteAllText((Join-Path $scope 'import-result.json'),'{"completed":true,"authorization":"stdout-and-wrapper-exit-0","job":{"Succeeded":true,"ActualZero":true,"OwnershipRetained":false}}')
}
'@
$child=$prelude+[Environment]::NewLine+($functions-join [Environment]::NewLine)+[Environment]::NewLine+$receipt+[Environment]::NewLine+$phaseSource+[Environment]::NewLine+$main
$childPath=Join-Path $runRoot 'original-control-flow.ps1'
[IO.File]::WriteAllText($childPath,$child,[Text.UTF8Encoding]::new($false))
$childTokens=$null;$childErrors=$null
$null=[Management.Automation.Language.Parser]::ParseInput($child,[ref]$childTokens,[ref]$childErrors)
if($childErrors.Count){throw '审核注入语法失败'}
$cases=[Collections.Generic.List[object]]::new()
function Record([string]$Name,[bool]$Pass,$Details){$cases.Add([pscustomobject]@{name=$Name;pass=$Pass;details=$Details})}
function Run-Child([string]$Name,[string]$Root){
    [IO.Directory]::CreateDirectory($Root)|Out-Null
    $start=[Diagnostics.ProcessStartInfo]::new((Get-Command pwsh -CommandType Application).Source)
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    foreach($argument in @('-NoProfile','-File',$childPath,'-scope',$Root,'-caseName',$Name)){$start.ArgumentList.Add($argument)}
    $process=[Diagnostics.Process]::new();$process.StartInfo=$start
    try {
        if(-not $process.Start()){throw '审核子进程未启动'}
        $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
        if(-not $process.WaitForExit(10000)){$process.Kill();$process.WaitForExit();throw '纯反例子进程超时'}
        $output=$stdout.GetAwaiter().GetResult();$errorText=$stderr.GetAwaiter().GetResult()
        [IO.File]::WriteAllText((Join-Path $Root ('stdout-'+$Name+'.txt')),$output)
        [IO.File]::WriteAllText((Join-Path $Root ('stderr-'+$Name+'.txt')),$errorText)
        return [pscustomobject]@{exitCode=$process.ExitCode;stdout=$output;stderr=$errorText}
    } finally {$process.Dispose()}
}
$scenarioNames=@('control','import-missing-helper','import-work-failure','import-identity-failure','import-environment-failure','import-environment-late','import-close-failure','import-close-late','import-return-late','import-receipt-serialize-late','import-receipt-flush-late','import-receipt-close-late','import-receipt-move-late','import-wrong-hash','import-ownership','forged-disk','transfer-close-failure','transfer-close-late','transfer-return-late','transfer-receipt-close-late','final-receipt-close-late','final-serialize-late','stdout-failure','stdout-late')
foreach($name in $scenarioNames){
    $root=Join-Path $runRoot $name
    $observed=Run-Child $name $root
    $calls=if(Test-Path -LiteralPath (Join-Path $root 'calls.txt')){@([IO.File]::ReadAllLines((Join-Path $root 'calls.txt')))}else{@()}
    $importCalls=@($calls|Where-Object {$_ -ceq 'import'}).Count
    $transferCalls=@($calls|Where-Object {$_ -ceq 'transfer'}).Count
    $stdoutSuccess=Test-Path -LiteralPath (Join-Path $root 'success-stdout-observed')
    $expectedTransfer=if($name.StartsWith('import-') -or $name -ceq 'forged-disk'){0}else{1}
    $pass=$importCalls -eq 1 -and $transferCalls -eq $expectedTransfer -and $observed.exitCode -eq $(if($name -ceq 'control'){0}else{2})
    $pass=$pass -and $stdoutSuccess -eq ($name -in @('control','stdout-late'))
    $pending=@(Get-ChildItem -LiteralPath $root -Filter '*.pending-wrapper-exit.json')
    foreach($file in $pending){$value=[IO.File]::ReadAllText($file.FullName)|ConvertFrom-Json;$pass=$pass -and $value.authorization -ceq 'pending-wrapper-exit' -and $value.productE2Pass -eq $false}
    foreach($path in @(Get-ChildItem -LiteralPath $root -Filter '*-handle')){$handle=[IO.File]::Open($path.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::None);$handle.Dispose()}
    Record $name $pass @{exitCode=$observed.exitCode;importCalls=$importCalls;transferCalls=$transferCalls;stdoutSuccess=$stdoutSuccess;pendingFiles=$pending.Count;stderr=$observed.stderr}
}
$retryRoot=Join-Path $runRoot 'import-missing-helper'
$claimPath=Join-Path $retryRoot 'campaign-intent.json'
$before=(Get-FileHash -LiteralPath $claimPath -Algorithm SHA256).Hash
$retry=Run-Child 'control' $retryRoot
$after=(Get-FileHash -LiteralPath $claimPath -Algorithm SHA256).Hash
$calls=@([IO.File]::ReadAllLines((Join-Path $retryRoot 'calls.txt')))
Record '预检失败claim保留且同scope拒绝再进入阶段' ($retry.exitCode -eq 2 -and $before -ceq $after -and $calls.Count -eq 1) @{exitCode=$retry.exitCode;calls=$calls;claimUnchanged=($before -ceq $after)}
foreach($oldMode in @('import','transfer')){
    $rejected=$false
    try {& $candidate -ScopeId ('physical-full-transfer-'+('f'*32)) -Mode $oldMode}catch{$rejected=$true}
    Record ('外部模式拒绝：'+$oldMode) $rejected $null
}
$report=[ordered]@{version=1;candidateSha256=(Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant();childSha256=(Get-FileHash -LiteralPath $childPath -Algorithm SHA256).Hash.ToLowerInvariant();runRoot=$runRoot;jobInvoked=$false;largeDataRead=$false;total=$cases.Count;passed=@($cases|Where-Object {$_.pass}).Count;failed=@($cases|Where-Object {-not $_.pass}).Count;cases=$cases.ToArray()}
$json=$report|ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path $runRoot 'results.json'),$json,[Text.UTF8Encoding]::new($false))
$json
if($report.failed){exit 1}
