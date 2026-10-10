[CmdletBinding()]
param([switch]$TerminalOnly)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$evidence=Join-Path $repository 'log/stage7-e2/oversize-preflight-independent-repair-001'
$run=Join-Path $evidence ('controls-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($run)
$candidate=Join-Path $PSScriptRoot 'oversize-preflight/run.ps1'
$seedScope=Join-Path $repository 'log/stage7-e2/oversize-preflight-b5a2ce2061a94edd9ad7d4a8762e5428'
$source=[IO.File]::ReadAllText($candidate)
$template=[IO.File]::ReadAllText((Join-Path $seedScope 'build-proof.json'))
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count -ne 0){throw '候选语法错误'}
$cases=[Collections.Generic.List[object]]::new()
function Need([bool]$Value,[string]$Message='独立反例断言失败'){if(-not $Value){throw $Message}}
function Reject([scriptblock]$Action){$denied=$false;try{& $Action}catch{$denied=$true};Need $denied '必须拒绝的操作成功了'}
function Test([string]$Name,[scriptblock]$Action){try{& $Action;$cases.Add([pscustomobject]@{name=$Name;passed=$true;error=$null})}catch{$cases.Add([pscustomobject]@{name=$Name;passed=$false;error=$_.Exception.Message})}}
function Hash([string]$Path){return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Invoke-Entry([string]$Script,[string]$Id,[string]$Label){
    $output=& pwsh -NoProfile -File $Script -ScopeId $Id 2>&1
    $exitCode=$LASTEXITCODE
    $text=$output -join "`n"
    [IO.File]::WriteAllText((Join-Path $run ($Label+'.txt')),$text)
    Need ($exitCode -eq 1) '真实子PowerShell未以1退出'
    $receipt=$text|ConvertFrom-Json
    Need ($receipt.completed -eq $false -and $null -eq $receipt.job) '失败不能产生Job或完成回执'
    return $receipt
}
function New-Scope {
    $id='oversize-preflight-'+[Guid]::NewGuid().ToString('N')
    $path=Join-Path $repository ('log/stage7-e2/'+$id)
    [void][IO.Directory]::CreateDirectory($path)
    $proof=$template|ConvertFrom-Json
    $proof.scopeId=$id
    foreach($name in @('worker.cjs','FixedTransferJob.cs')){[IO.File]::Copy((Join-Path $seedScope $name),(Join-Path $path $name))}
    return [pscustomobject]@{id=$id;path=$path;proof=$proof}
}

# All original-entry cases lack a usable sparse helper and cannot reach construction even if a gate regresses.
$mutations=@(
    @{name='missing-proof';phase='claim';apply={param($s)}},
    @{name='invalid-proof';phase='claim';apply={param($s)}},
    @{name='missing-helper';phase='binding';apply={param($s)}},
    @{name='duplicate-escaped-key';phase='claim';apply={param($s)}},
    @{name='duplicate-source-key';phase='claim';apply={param($s)}},
    @{name='extra-source';phase='binding';apply={param($s)$s.proof.sources|Add-Member -NotePropertyName 'src/extra.ts' -NotePropertyValue ('a'*64)}},
    @{name='missing-bundle';phase='binding';apply={param($s)$s.proof.workerBundle.inputs.PSObject.Properties.Remove('src/main/storage/staging-sqlite.ts')}},
    @{name='extra-bundle';phase='binding';apply={param($s)$s.proof.workerBundle.inputs|Add-Member -NotePropertyName 'src/extra.ts' -NotePropertyValue ('a'*64)}},
    @{name='unbound-bundle';phase='binding';apply={param($s)$s.proof.workerBundle.inputs.'src/main/storage/staging-sqlite.ts'='b'*64}},
    @{name='unbound-worker';phase='binding';apply={param($s)$s.proof.workerBundle.sha256='c'*64}},
    @{name='changed-source';phase='binding';apply={param($s)$s.proof.sources.'tools/data-qualification/oversize-preflight/README.md'='d'*64}},
    @{name='changed-artifact';phase='binding';apply={param($s)[IO.File]::WriteAllText((Join-Path $s.path 'worker.cjs'),'wrong')}},
    @{name='sparse-artifact-not-source';phase='binding';apply={param($s)
        $path=Join-Path $s.path 'SparseFile.cs'
        [IO.File]::WriteAllText($path,'// invalid copied source')
        $s.proof.artifacts.'SparseFile.cs'.bytes=(Get-Item -LiteralPath $path).Length
        $s.proof.artifacts.'SparseFile.cs'.sha256=Hash $path
    }},
    @{name='existing-result';phase='claim';prior=$true;apply={param($s)[IO.File]::WriteAllText((Join-Path $s.path 'preflight-result.json'),'prior-result')}},
    @{name='existing-complete';phase='claim';prior=$true;apply={param($s)[IO.File]::WriteAllText((Join-Path $s.path 'complete.json'),'prior-complete')}}
)
foreach($name in @('backup-container','dataset-layout','bounded-json')){
    $mutations+=@{name=('remove-'+$name);phase='binding';remove=('src/main/storage/'+$name+'.ts');apply={param($s)}}
}
$mutations+=@{name='remove-conversation-transfer';phase='binding';remove='src/main/ai/conversation-transfer.ts';apply={param($s)}}
foreach($mutation in $(if($TerminalOnly){@()}else{$mutations})){
    Test ('真实完整入口及修补后重入-'+$mutation.name) {
        $s=New-Scope
        if($mutation.ContainsKey('remove')){$s.proof.sources.PSObject.Properties.Remove($mutation.remove)}
        & $mutation.apply $s
        $text=$s.proof|ConvertTo-Json -Depth 12 -Compress
        if($mutation.name -eq 'invalid-proof'){$text='{invalid'}
        if($mutation.name -eq 'duplicate-escaped-key'){$text=$text.Replace('"version":1','"version":1,"vers\u0069on":1')}
        if($mutation.name -eq 'duplicate-source-key'){$text=$text.Replace('"sources":{','"sources":{"package.json":"'+('e'*64)+'",')}
        if($mutation.name -ne 'missing-proof'){[IO.File]::WriteAllText((Join-Path $s.path 'build-proof.json'),$text)}
        $receipt=Invoke-Entry $candidate $s.id $mutation.name
        Need ($receipt.phase -ceq $mutation.phase) '失败阶段与预期不符'
        Need ($receipt.actualRun -is [bool] -and $receipt.actualRun) '真实初始化未执行'
        Need (-not (Test-Path -LiteralPath (Join-Path $s.path 'preflight-helpers.dll')))
        Need (@(Get-ChildItem -LiteralPath $s.path -Filter 'oversize-*').Count -eq 0)
        if($mutation.ContainsKey('prior')){Need (-not (Test-Path -LiteralPath (Join-Path $s.path 'preflight-intent.json')))}
        else{Need (Test-Path -LiteralPath (Join-Path $s.path 'preflight-intent.json'))}
        $proofPath=Join-Path $s.path 'build-proof.json'
        if(Test-Path -LiteralPath $proofPath){[IO.File]::Copy($proofPath,(Join-Path $run ($mutation.name+'-original-proof.json')))}
        $correct=$template|ConvertFrom-Json;$correct.scopeId=$s.id
        [IO.File]::WriteAllText($proofPath,($correct|ConvertTo-Json -Depth 12 -Compress))
        $prior=@{};foreach($file in Get-ChildItem -LiteralPath $s.path){$prior[$file.Name]=Hash $file.FullName}
        $again=Invoke-Entry $candidate $s.id ($mutation.name+'-reenter')
        Need ($again.phase -ceq 'claim') '修补proof后未在claim门拒绝'
        $after=@(Get-ChildItem -LiteralPath $s.path)
        Need ($after.Count -eq $prior.Count)
        foreach($file in $after){Need ($prior[$file.Name] -ceq (Hash $file.FullName)) '重入改写了已有原件'}
    }
}

# Load exact function definitions, with actual native helpers and bounded files.
foreach($definition in $ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst]}){. ([ScriptBlock]::Create($definition.Extent.Text))}
Add-Type -Path @((Join-Path $PSScriptRoot 'full-transfer/FixedTransferJob.cs'),(Join-Path $PSScriptRoot 'oversize-preflight/SparseFile.cs'))
$nativeLoaded=$true;$directories=@{};$clock=[Diagnostics.Stopwatch]::StartNew();$workMs=120000
$locks=[Collections.Generic.List[IO.FileStream]]::new();$facts=[Collections.Generic.List[object]]::new()
if(-not $TerminalOnly){
$scope=Join-Path $run 'native';[void][IO.Directory]::CreateDirectory($scope)
$path=Join-Path $scope 'sparse.bin'
$created=[AIbrowse.OversizePreflight.SparseFile]::Create($path,1048577,[Text.Encoding]::ASCII.GetBytes('independent-bounded-header'))
try {
    Test '真实1MiB加1稀疏句柄与分配量联用' {
        Need ($created.Sparse -and $created.Length -eq 1048577 -and $created.AllocatedBytes -gt 0 -and $created.AllocatedBytes -le 1048576)
        $held=Hold-Sparse $path $created
        Need ($held.stream.Length -eq 1048577)
        Need (([AIbrowse.OversizePreflight.SparseFile]::Inspect($held.stream)).Identity -ceq $created.Identity)
        Assert-Facts
        Need ((Scope-Allocation) -eq $created.AllocatedBytes)
    }
    Test '真实读写claim分配量可读取且仍禁止外部写入和替换' {
        $claimPath=Join-Path $scope 'claim.json'
        $claim=Write-NewJson $claimPath ([ordered]@{held=$true}) -Hold
        $claimFact=[AIbrowse.OversizePreflight.SparseFile]::Inspect($claim)
        $pathFact=[AIbrowse.OversizePreflight.SparseFile]::InspectPath($claimPath)
        Need ($pathFact.Identity -ceq $claimFact.Identity -and $pathFact.AllocatedBytes -eq $claimFact.AllocatedBytes)
        Need ((Scope-Allocation) -eq ($created.AllocatedBytes+$claimFact.AllocatedBytes))
        Reject {[IO.File]::WriteAllBytes($claimPath,[byte[]](1))}
        Reject {[IO.File]::Move($claimPath,(Join-Path $scope 'claim-renamed.json'))}
        Need ($claim.CanWrite)
    }
    Test '共享普通文件检查仍拒绝sparse' {Reject {[void][AIbrowse.FullTransfer.FixedTransferJob]::InspectFile($facts[0].stream)}}
    Test 'sparse锁拒绝写入替换且普通文件不冒充稀疏' {
        Reject {[IO.File]::WriteAllBytes($path,[byte[]](2))}
        Reject {[IO.File]::Move($path,(Join-Path $scope 'renamed.bin'))}
        $plain=Join-Path $scope 'plain.bin';[IO.File]::WriteAllBytes($plain,[byte[]](1,2,3))
        Reject {[void](Hold-Sparse $plain $created)}
    }
    Test '同EOF不同文件身份拒绝' {
        $second=Join-Path $scope 'second.bin'
        [void][AIbrowse.OversizePreflight.SparseFile]::Create($second,1048577,[Text.Encoding]::ASCII.GetBytes('independent-bounded-header'))
        Reject {[void](Hold-Sparse $second $created)}
    }
    foreach($field in @('Length','AllocatedBytes','Links','Attributes','CreationTime','LastWriteTime','ChangeTime')){
        Test ('稀疏元数据反例-'+$field) {$changed=$created|Select-Object *;$changed.$field=$changed.$field+1;Reject {Assert-SparseFact $changed $created}}
    }
    Test '头部摘要反例' {$wrong=$created|Select-Object *;$wrong.HeaderSha256='a'*64;Reject {[void](Hold-Sparse $path $wrong)}}
    Test '16MiB边界和long异常均有界' {
        foreach($pair in @(@(0L,16777216L),@(16777215L,1L),@(16777216L,0L))){Need ([AIbrowse.OversizePreflight.SparseFile]::AddAllocation($pair[0],$pair[1]) -eq 16777216L)}
        foreach($pair in @(@(16777216L,1L),@(-1L,0L),@(0L,-1L),@(0L,[long]::MaxValue),@([long]::MaxValue,0L))){Reject {[void][AIbrowse.OversizePreflight.SparseFile]::AddAllocation($pair[0],$pair[1])}}
    }
} finally {foreach($stream in $locks){$stream.Dispose()};$locks.Clear();$facts.Clear()}
Test '真实hardlink与重解析成员拒绝' {
    $link=Join-Path $scope 'hardlink.bin';[void](New-Item -ItemType HardLink -Path $link -Target $path)
    Reject {[void][AIbrowse.OversizePreflight.SparseFile]::InspectPath($path)}
    $junction=Join-Path $scope 'junction';[void](New-Item -ItemType Junction -Path $junction -Target $run)
    Reject {[void][AIbrowse.OversizePreflight.SparseFile]::InspectPath($junction)}
    Reject {Scope-Allocation}
}

# The full-prefix copies retain all actual code except four EOFs and two explicit pre-Job safety stops.
foreach($budgetFailure in @($false,$true)){
    Test ('真实完整小EOF前缀-预算失败='+$budgetFailure) {
        $s=New-Scope
        [IO.File]::Copy((Join-Path $seedScope 'SparseFile.cs'),(Join-Path $s.path 'SparseFile.cs'))
        [IO.File]::WriteAllText((Join-Path $s.path 'build-proof.json'),($s.proof|ConvertTo-Json -Depth 12 -Compress))
        $bounded=$source.Replace('$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot ''..\..\..''))',('$repository='''+$repository.Replace("'","''")+''''))
        foreach($size in @('5368709121','536870913','67108865')){$bounded=$bounded.Replace(('bytes='+$size),'bytes=1048577')}
        Need ([regex]::Matches($bounded,'bytes=1048577').Count -eq 4)
        $bounded=$bounded.Replace('$phase=''execute''','$phase=''independent-pre-execute-stop'';throw ''独立小前缀停在Execute前''')
        $executeLine=@($bounded -split "`n"|Where-Object {$_.Contains('FixedTransferJob]::Execute(')})
        Need ($executeLine.Count -eq 1)
        $bounded=$bounded.Replace($executeLine[0],"throw '独立第二道禁止Job执行'")
        Need (-not $bounded.Contains('::Execute('))
        if($budgetFailure){$bounded=$bounded.Replace('$totalAllocated=Scope-Allocation','$totalAllocated=[AIbrowse.OversizePreflight.SparseFile]::AddAllocation(16777216,1)')}
        $boundedPath=Join-Path $run ('bounded-'+$budgetFailure+'.ps1');[IO.File]::WriteAllText($boundedPath,$bounded)
        $receipt=Invoke-Entry $boundedPath $s.id ('bounded-'+$budgetFailure)
        $expected=if($budgetFailure){'construct'}else{'independent-pre-execute-stop'}
        Need ($receipt.phase -ceq $expected) '完整小前缀未到达预期门'
        Need ($receipt.nativeBuild.assemblySha256 -cmatch '^[a-f0-9]{64}$')
        $files=@(Get-ChildItem -LiteralPath $s.path -Filter 'oversize-*');Need ($files.Count -eq 4)
        foreach($file in $files){Need ($file.Length -eq 1048577);Need (([AIbrowse.OversizePreflight.SparseFile]::InspectPath($file.FullName)).AllocatedBytes -le 1048576)}
        $again=Invoke-Entry $candidate $s.id ('bounded-'+$budgetFailure+'-reenter');Need ($again.phase -ceq 'claim')
    }
}
}

# Replay exact initialization, receipt IO, final state and finally; inject only late failure observations.
$body=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})[0]
$statements=@($body.Body.Statements)
$start=@($statements|Where-Object {$_.Extent.Text -ceq '$result.completed=$false'})
Need ($start.Count -eq 1)
$tail=$source.Substring($start[0].Extent.StartOffset,$statements[-1].Extent.EndOffset-$start[0].Extent.StartOffset)
Need (-not $tail.Contains('::Execute(') -and -not $tail.Contains('SparseFile]::Create'))
$finish='try {'+[Environment]::NewLine+$tail+[Environment]::NewLine+'} '+$body.CatchClauses[0].Extent.Text+' finally '+$body.Finally.Extent.Text
$initial=@($ast.EndBlock.Statements|Where-Object {$_.Extent.Text.StartsWith('$result=[ordered]')})[0].Extent.Text
function Scope-Allocation {if($script:mode -eq 'allocation'){return 16777217L};return 4096L}
function Assert-Facts {
    if($script:mode -eq 'identity'){throw '独立反例末尾身份失败'}
    if($script:mode -eq 'clock'){$script:workMs=0}
    if($script:mode -eq 'finally-clock'){$script:clock=[pscustomobject]@{Elapsed=[pscustomobject]@{TotalMilliseconds=1}}}
}
foreach($mode in @('normal','identity','clock','allocation','finally-clock')){
    Test ('真实尾部pending与终态-'+$mode) {
        $ScopeId='oversize-preflight-'+[Guid]::NewGuid().ToString('N')
        $scope=Join-Path $run ('tail-'+$mode);[void][IO.Directory]::CreateDirectory($scope)
        $nativeLoaded=$true;$directories=@{};$script:clock=[Diagnostics.Stopwatch]::StartNew();$script:workMs=120000
        $locks=[Collections.Generic.List[IO.FileStream]]::new();$facts=[Collections.Generic.List[object]]::new()
        $saved=$null;$phase='receipt';$completed=$false;$job=$null;$beforeResult=@();$claimed=$true
        if($mode -eq 'finally-clock'){
            # Keep original finally; a held stream disposal pushes the deterministic clock over budget.
            $disposeHook=New-Object PSObject
            $disposeHook|Add-Member -MemberType ScriptMethod -Name Dispose -Value {$script:clock.Elapsed.TotalMilliseconds=120000}
            $locks=[Collections.Generic.List[object]]::new();$locks.Add($disposeHook)
        }
        . ([ScriptBlock]::Create($initial))
        . ([ScriptBlock]::Create($finish))
        $receipt=[IO.File]::ReadAllText((Join-Path $scope 'preflight-result.json'))|ConvertFrom-Json
        Need ($receipt.completed -eq $false -and $receipt.phase -ceq 'pending-wrapper-exit' -and $receipt.requiresWrapperExit -eq $true)
        Need ($completed -eq ($mode -eq 'normal') -and $result.completed -eq ($mode -eq 'normal')) ('终态不符：completed='+$completed+';result='+$result.completed+';elapsed='+$clock.Elapsed.TotalMilliseconds+';budget='+$workMs)
    }
}
$report=[ordered]@{version=1;wrapperSha256=(Hash $candidate);scopeUnderReview='oversize-preflight-b5a2ce2061a94edd9ad7d4a8762e5428';actualLargeEofCreated=$false;jobStarted=$false;cases=$cases.ToArray();total=$cases.Count;failed=@($cases|Where-Object {-not $_.passed}).Count}
$json=$report|ConvertTo-Json -Depth 10
[IO.File]::WriteAllText((Join-Path $run 'results.json'),$json)
$json
if($report.failed -gt 0){exit 1}
