[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$evidence=Join-Path $repository 'log/stage7-e2/oversize-preflight-repair-001'
[void][IO.Directory]::CreateDirectory($evidence)
$root=Join-Path $evidence ('small-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$candidate=Join-Path $PSScriptRoot 'run.ps1'
$source=[IO.File]::ReadAllText($candidate)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw '候选PowerShell解析失败'}
$cases=[Collections.Generic.List[object]]::new()
function Test-Case([string]$Name,[scriptblock]$Action) {
    try {& $Action;$cases.Add([pscustomobject]@{name=$Name;passed=$true;error=$null})}
    catch {$cases.Add([pscustomobject]@{name=$Name;passed=$false;error=$_.Exception.Message})}
}
function Need([bool]$Value){if(-not $Value){throw '反例断言失败'}}
function Reject([scriptblock]$Action){$rejected=$false;try{& $Action}catch{$rejected=$true};Need $rejected}
# Load actual candidate function definitions; full entry tests below use fresh PowerShell processes.
foreach($definition in $ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst]}){
    . ([ScriptBlock]::Create($definition.Extent.Text))
}
Add-Type -Path @((Join-Path $PSScriptRoot '../full-transfer/FixedTransferJob.cs'),(Join-Path $PSScriptRoot 'SparseFile.cs'))
$nativeLoaded=$true;$directories=@{};$clock=[Diagnostics.Stopwatch]::StartNew();$workMs=120000
$locks=[Collections.Generic.List[IO.FileStream]]::new();$facts=[Collections.Generic.List[object]]::new()
$scope=Join-Path $root 'native'
[void][IO.Directory]::CreateDirectory($scope)
$path=Join-Path $scope 'small-sparse.bin'
$created=[AIbrowse.OversizePreflight.SparseFile]::Create($path,1048577,[Text.Encoding]::ASCII.GetBytes('bounded-header'))
Test-Case '真实小稀疏创建、Hold、Assert-Facts和分配量联用' {
    Need ($created.Sparse -and $created.Length -eq 1048577 -and $created.AllocatedBytes -le 1048576)
    [void](Hold-Sparse $path $created)
    Assert-Facts
    Need ((Scope-Allocation) -eq $created.AllocatedBytes)
}
Test-Case '普通小文件仍由共享InspectFile验证' {
    $regular=Join-Path $scope 'regular.bin'
    [IO.File]::WriteAllBytes($regular,[byte[]](1,2,3))
    [void](Read-Bound $regular 16 $true)
    Assert-Facts
    Need ((Scope-Allocation) -ge $created.AllocatedBytes)
}
Test-Case '真实分配量累计兼容持有读写claim且仍禁止其它写者' {
    $claimPath=Join-Path $scope 'held-claim.json'
    $claim=Write-NewJson $claimPath ([ordered]@{claim=$true}) -Hold
    Need ((Scope-Allocation) -ge $created.AllocatedBytes)
    Reject {[IO.File]::WriteAllBytes($claimPath,[byte[]](9))}
    Need ($claim.CanWrite)
}
Test-Case '共享普通文件检查继续拒绝稀疏输入' {
    $stream=[IO.File]::OpenRead($path)
    try{Reject {[void][AIbrowse.FullTransfer.FixedTransferJob]::InspectFile($stream)}}finally{$stream.Dispose()}
}
Test-Case '创建同名原件拒绝覆盖' {Reject {[void][AIbrowse.OversizePreflight.SparseFile]::Create($path,16,[byte[]](1))}}
Test-Case '持有句柄期间替换原件被OS拒绝' {Reject {[IO.File]::Move($path,(Join-Path $scope 'replaced.bin'))}}
Test-Case '持有句柄期间写入原件被OS拒绝' {Reject {[IO.File]::WriteAllBytes($path,[byte[]](9))}}
Test-Case '同长度新稀疏文件不能替代创建身份' {
    $other=Join-Path $scope 'other.bin'
    [void][AIbrowse.OversizePreflight.SparseFile]::Create($other,1048577,[Text.Encoding]::ASCII.GetBytes('bounded-header'))
    Reject {[void](Hold-Sparse $other $created)}
}
Test-Case '创建头部hash失配必须拒绝' {
    $wrong=$created.HeaderSha256;$created.HeaderSha256='a'*64
    try{Reject {[void](Hold-Sparse $path $created)}}finally{$created.HeaderSha256=$wrong}
}
foreach($field in @('Length','Attributes','CreationTime','LastWriteTime','ChangeTime','AllocatedBytes','Links')){
    Test-Case ('稀疏事实漂移拒绝-'+$field) {
        $changed=$created|Select-Object *
        $changed.$field=$changed.$field+1
        Reject {Assert-SparseFact $changed $created}
    }
}
Test-Case '最终头部hash失配拒绝' {
    $bound=@($facts|Where-Object {$_.PSObject.Properties.Name -contains 'sparse'})[0]
    $prior=$bound.header;$bound.header='b'*64
    try{Reject {Assert-Facts}}finally{$bound.header=$prior}
}
foreach($pair in @(@(0,16777216),@(16777215,1),@(16777216,0))){
    Test-Case ('分配量16MiB边界-'+($pair -join '-')) {Need ([AIbrowse.OversizePreflight.SparseFile]::AddAllocation($pair[0],$pair[1]) -eq 16777216)}
}
foreach($pair in @(@(16777216,1),@(0,-1),@(-1,0),@(0,[long]::MaxValue),@([long]::MaxValue,1))){
    Test-Case ('分配量异常或超限拒绝-'+($pair -join '-')) {Reject {[void][AIbrowse.OversizePreflight.SparseFile]::AddAllocation($pair[0],$pair[1])}}
}
foreach($stream in $locks){$stream.Dispose()};$locks.Clear();$facts.Clear()
Test-Case '真实hardlink由专属检查和Hold拒绝' {
    $linked=Join-Path $scope 'linked.bin'
    [void](New-Item -ItemType HardLink -Path $linked -Target $path)
    Reject {[void][AIbrowse.OversizePreflight.SparseFile]::InspectPath($path)}
    Reject {[void](Hold-Sparse $linked $created)}
}
Test-Case '真实目录重解析成员被分配量门拒绝' {
    $priorScope=$scope;$scope=Join-Path $root 'reparse'
    [void][IO.Directory]::CreateDirectory($scope)
    try {
        $junction=Join-Path $scope 'junction'
        [void](New-Item -ItemType Junction -Path $junction -Target $root)
        Reject {[void][AIbrowse.OversizePreflight.SparseFile]::InspectPath($junction)}
        Reject {Scope-Allocation}
    } finally {$scope=$priorScope}
}
foreach($stream in $locks){$stream.Dispose()};$locks.Clear();$facts.Clear()
# Preserve all tiny original controls and failure scopes; no cleanup or import Execute occurs.
$buildOutput=& node --experimental-strip-types (Join-Path $PSScriptRoot 'build.ts') 2>&1
if($LASTEXITCODE -ne 0){throw '小制品构建失败'}
[IO.File]::WriteAllText((Join-Path $root 'build.txt'),($buildOutput -join "`n"))
$buildReceipt=@($buildOutput|Where-Object {([string]$_).StartsWith('{')})
Need ($buildReceipt.Count -eq 1)
$seedId=([string]$buildReceipt[0]|ConvertFrom-Json).scopeId
$seedScope=Join-Path $repository ('log/stage7-e2/'+$seedId)
$template=[IO.File]::ReadAllText((Join-Path $seedScope 'build-proof.json'))|ConvertFrom-Json
foreach($property in $template.sources.PSObject.Properties){$property.Value=(Get-FileHash -LiteralPath (Join-Path $repository $property.Name) -Algorithm SHA256).Hash.ToLowerInvariant()}
foreach($name in @('FixedTransferJob.cs','SparseFile.cs')){
    $from=if($name -eq 'FixedTransferJob.cs'){Join-Path $PSScriptRoot '../full-transfer/FixedTransferJob.cs'}else{Join-Path $PSScriptRoot $name}
    $template.artifacts.$name.bytes=(Get-Item -LiteralPath $from).Length
    $template.artifacts.$name.sha256=(Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash.ToLowerInvariant()
}
$inputNames=@('tools/data-qualification/oversize-preflight/worker.ts','tools/data-qualification/oversize-preflight/contract.ts','src/main/storage/native-transfer-selection.ts','src/main/storage/staging-sqlite.ts','src/main/storage/backup-container.ts','src/main/storage/dataset-layout.ts','src/main/storage/bounded-json.ts','src/main/ai/conversation-transfer.ts')
$inputs=[ordered]@{};foreach($name in $inputNames){$inputs[$name]=$template.sources.$name}
$template.workerBundle=[ordered]@{inputs=$inputs;sha256=$template.artifacts.'worker.cjs'.sha256}
$templateJson=$template|ConvertTo-Json -Depth 10 -Compress
$entryCases=@(
    @{name='缺proof';phase='claim';mutation={param($entry,$proof)};missingProof=$true},
    @{name='坏proof';phase='claim';mutation={param($entry,$proof)};badProof=$true},
    @{name='提交错格式';phase='claim';mutation={param($entry,$proof)$proof.sourceCommit='A'*40}},
    @{name='提交错类型';phase='claim';mutation={param($entry,$proof)$proof.sourceCommit=1}},
    @{name='运行proof不同HEAD';phase='claim';mutation={param($entry,$proof)$proof.sourceCommit='0'*40}},
    @{name='缺helper';phase='binding';mutation={param($entry,$proof)}},
    @{name='删除容器来源';phase='binding';mutation={param($entry,$proof)$proof.sources.PSObject.Properties.Remove('src/main/storage/backup-container.ts')}},
    @{name='删除布局来源';phase='binding';mutation={param($entry,$proof)$proof.sources.PSObject.Properties.Remove('src/main/storage/dataset-layout.ts')}},
    @{name='删除JSON来源';phase='binding';mutation={param($entry,$proof)$proof.sources.PSObject.Properties.Remove('src/main/storage/bounded-json.ts')}},
    @{name='删除会话来源';phase='binding';mutation={param($entry,$proof)$proof.sources.PSObject.Properties.Remove('src/main/ai/conversation-transfer.ts')}},
    @{name='额外来源';phase='binding';mutation={param($entry,$proof)$proof.sources|Add-Member -NotePropertyName 'src/extra.ts' -NotePropertyValue ('a'*64)}},
    @{name='空bundle';phase='binding';mutation={param($entry,$proof)$proof.workerBundle.inputs=[pscustomobject]@{}}},
    @{name='未绑定bundle输入';phase='binding';mutation={param($entry,$proof)$proof.workerBundle.inputs.'src/main/storage/staging-sqlite.ts'='a'*64}},
    @{name='缺bundle输入';phase='binding';mutation={param($entry,$proof)$proof.workerBundle.inputs.PSObject.Properties.Remove('src/main/storage/staging-sqlite.ts')}},
    @{name='额外bundle输入';phase='binding';mutation={param($entry,$proof)$proof.workerBundle.inputs|Add-Member -NotePropertyName 'src/extra.ts' -NotePropertyValue ('a'*64)}},
    @{name='worker输出失配';phase='binding';mutation={param($entry,$proof)$proof.workerBundle.sha256='a'*64}},
    @{name='重复JSON键';phase='claim';mutation={param($entry,$proof)};duplicate=$true},
    @{name='已有失败回执';phase='claim';mutation={param($entry,$proof)[IO.File]::WriteAllText((Join-Path $entry 'preflight-result.json'),'{}')};prior=$true},
    @{name='未知运行遗留';phase='claim';mutation={param($entry,$proof)[IO.File]::WriteAllText((Join-Path $entry 'complete.json'),'{}')};prior=$true},
    @{name='Sparse复制不同源';phase='binding';mutation={param($entry,$proof)
        $copied=Join-Path $entry 'SparseFile.cs'
        [IO.File]::WriteAllText($copied,'// mismatched bounded artifact')
        $proof.artifacts.'SparseFile.cs'.bytes=(Get-Item -LiteralPath $copied).Length
        $proof.artifacts.'SparseFile.cs'.sha256=(Get-FileHash -LiteralPath $copied -Algorithm SHA256).Hash.ToLowerInvariant()
    };helper=$true}
)
foreach($entryCase in $entryCases){
    Test-Case ('真实全wrapper安全入口-'+$entryCase.name) {
        $entryId='oversize-preflight-'+[Guid]::NewGuid().ToString('N')
        $entry=Join-Path $repository ('log/stage7-e2/'+$entryId)
        [void][IO.Directory]::CreateDirectory($entry)
        $proof=$templateJson|ConvertFrom-Json;$proof.scopeId=$entryId
        [IO.File]::Copy((Join-Path $seedScope 'worker.cjs'),(Join-Path $entry 'worker.cjs'))
        [IO.File]::Copy((Join-Path $PSScriptRoot '../full-transfer/FixedTransferJob.cs'),(Join-Path $entry 'FixedTransferJob.cs'))
        if($entryCase.ContainsKey('helper')){[IO.File]::Copy((Join-Path $PSScriptRoot 'SparseFile.cs'),(Join-Path $entry 'SparseFile.cs'))}
        & $entryCase.mutation $entry $proof
        $proofText=$proof|ConvertTo-Json -Depth 10 -Compress
        if($entryCase.ContainsKey('badProof')){$proofText='{bad-json'}
        if($entryCase.ContainsKey('duplicate')){$proofText=$proofText.Replace('"version":1','"version":1,"vers\u0069on":1')}
        if(-not $entryCase.ContainsKey('missingProof')){[IO.File]::WriteAllText((Join-Path $entry 'build-proof.json'),$proofText)}
        $output=& pwsh -NoProfile -File $candidate -ScopeId $entryId 2>&1
        $exitCode=$LASTEXITCODE
        [IO.File]::WriteAllText((Join-Path $root ($entryCase.name+'.txt')),($output -join "`n"))
        Need ($exitCode -eq 1)
        $receipt=($output -join "`n")|ConvertFrom-Json
        Need ($receipt.completed -eq $false -and $null -eq $receipt.job -and $receipt.phase -ceq $entryCase.phase)
        Need (-not (Test-Path -LiteralPath (Join-Path $entry 'preflight-helpers.dll')))
        Need (@(Get-ChildItem -LiteralPath $entry -Filter 'oversize-*').Count -eq 0)
        if(-not $entryCase.ContainsKey('prior')){Need (Test-Path -LiteralPath (Join-Path $entry 'preflight-intent.json'))}
        if($entryCase.ContainsKey('missingProof') -or $entryCase.ContainsKey('badProof') -or $entryCase.ContainsKey('duplicate')){
            $failedProof=Join-Path $entry 'build-proof.json'
            if(Test-Path -LiteralPath $failedProof){[IO.File]::Copy($failedProof,(Join-Path $root ($entryCase.name+'-original-proof.json')))}
            [IO.File]::WriteAllText($failedProof,($proof|ConvertTo-Json -Depth 10 -Compress))
        }
        $before=@{};foreach($item in Get-ChildItem -LiteralPath $entry){$before[$item.Name]=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash}
        $again=& pwsh -NoProfile -File $candidate -ScopeId $entryId 2>&1
        Need ($LASTEXITCODE -eq 1)
        $retry=($again -join "`n")|ConvertFrom-Json
        Need ($retry.phase -ceq 'claim' -and $retry.completed -eq $false -and $null -eq $retry.job)
        foreach($item in Get-ChildItem -LiteralPath $entry){Need ($before[$item.Name] -ceq (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash)}
    }
}
# Run the complete wrapper with only EOF sizes and an explicit pre-Execute stop changed.
# This exercises initialization, claim, exact bindings, joint compilation and all native facts.
foreach($budgetFailure in @($false,$true)){
    Test-Case ('完整wrapper小EOF到Job前停止-预算反例='+$budgetFailure) {
        $entryId='oversize-preflight-'+[Guid]::NewGuid().ToString('N')
        $entry=Join-Path $repository ('log/stage7-e2/'+$entryId)
        [void][IO.Directory]::CreateDirectory($entry)
        $proof=$templateJson|ConvertFrom-Json;$proof.scopeId=$entryId
        [IO.File]::Copy((Join-Path $seedScope 'worker.cjs'),(Join-Path $entry 'worker.cjs'))
        [IO.File]::Copy((Join-Path $PSScriptRoot '../full-transfer/FixedTransferJob.cs'),(Join-Path $entry 'FixedTransferJob.cs'))
        [IO.File]::Copy((Join-Path $PSScriptRoot 'SparseFile.cs'),(Join-Path $entry 'SparseFile.cs'))
        [IO.File]::WriteAllText((Join-Path $entry 'build-proof.json'),($proof|ConvertTo-Json -Depth 10 -Compress))
        $bounded=$source.Replace('$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot ''..\..\..''))',('$repository='''+$repository.Replace("'","''")+''''))
        foreach($size in @('5368709121','536870913','67108865')){$bounded=$bounded.Replace(('bytes='+$size), 'bytes=1048577')}
        $bounded=$bounded.Replace('$phase=''execute''','$phase=''execute-test-stop'';throw ''有界整入口在Execute之前停止''')
        if($budgetFailure){$bounded=$bounded.Replace('$totalAllocated=Scope-Allocation','$totalAllocated=[AIbrowse.OversizePreflight.SparseFile]::AddAllocation(16777216,1)')}
        $scriptPath=Join-Path $root ('bounded-'+$budgetFailure+'.ps1')
        [IO.File]::WriteAllText($scriptPath,$bounded)
        $output=& pwsh -NoProfile -File $scriptPath -ScopeId $entryId 2>&1
        $exitCode=$LASTEXITCODE
        [IO.File]::WriteAllText((Join-Path $root ('bounded-'+$budgetFailure+'.txt')),($output -join "`n"))
        Need ($exitCode -eq 1)
        $receipt=($output -join "`n")|ConvertFrom-Json
        $expectedPhase=if($budgetFailure){'construct'}else{'execute-test-stop'}
        Need ($receipt.completed -eq $false -and $null -eq $receipt.job -and $receipt.phase -ceq $expectedPhase)
        Need ($receipt.nativeBuild.assemblySha256 -cmatch '^[a-f0-9]{64}$')
        $smallFiles=@(Get-ChildItem -LiteralPath $entry -Filter 'oversize-*')
        Need ($smallFiles.Count -eq 4)
        foreach($small in $smallFiles){Need ($small.Length -eq 1048577)}
        $diskReceipt=[IO.File]::ReadAllText((Join-Path $entry 'preflight-result.json'))|ConvertFrom-Json
        Need ($diskReceipt.completed -eq $false -and $diskReceipt.requiresWrapperExit -eq $true)
        $retry=& pwsh -NoProfile -File $candidate -ScopeId $entryId 2>&1
        Need ($LASTEXITCODE -eq 1)
        Need ((($retry -join "`n")|ConvertFrom-Json).phase -ceq 'claim')
    }
}
# Replay the unchanged terminal statements with real receipt IO and bounded late-failure oracles.
$body=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})[0]
$statements=@($body.Body.Statements)
$start=@($statements|Where-Object {$_.Extent.Text -ceq '$result.completed=$false'})
Need ($start.Count -eq 1)
$tail=$source.Substring($start[0].Extent.StartOffset,$statements[-1].Extent.EndOffset-$start[0].Extent.StartOffset)
Need (-not $tail.Contains('::Execute(') -and -not $tail.Contains('SparseFile]::Create'))
$finish='try {'+[Environment]::NewLine+$tail+[Environment]::NewLine+'} '+$body.CatchClauses[0].Extent.Text+' finally '+$body.Finally.Extent.Text
$initial=@($ast.EndBlock.Statements|Where-Object {$_.Extent.Text.StartsWith('$result=[ordered]')})[0].Extent.Text
function Scope-Allocation {if($script:mode -eq 'late-allocation'){return 16777217L};return 4096L}
function Assert-Facts {
    if($script:mode -eq 'late-identity'){throw '小反例末尾身份失败'}
    if($script:mode -eq 'late-deadline'){$script:workMs=0}
}
foreach($mode in @('normal','late-identity','late-deadline','late-allocation')){
    Test-Case ('持久化pending不能自授成功-'+$mode) {
        $ScopeId='oversize-preflight-'+[Guid]::NewGuid().ToString('N')
        $scope=Join-Path $root ('terminal-'+$mode)
        [void][IO.Directory]::CreateDirectory($scope)
        $nativeLoaded=$true;$directories=@{};$clock=[Diagnostics.Stopwatch]::StartNew();$script:workMs=120000
        $locks=[Collections.Generic.List[IO.FileStream]]::new();$facts=[Collections.Generic.List[object]]::new()
        $saved=$null;$phase='receipt';$completed=$false;$job=$null;$beforeResult=@();$claimed=$true
        . ([ScriptBlock]::Create($initial))
        . ([ScriptBlock]::Create($finish))
        $receipt=[IO.File]::ReadAllText((Join-Path $scope 'preflight-result.json'))|ConvertFrom-Json
        Need ($receipt.completed -eq $false -and $receipt.phase -ceq 'pending-wrapper-exit' -and $receipt.requiresWrapperExit -eq $true)
        Need ($completed -eq ($mode -eq 'normal') -and $result.completed -eq ($mode -eq 'normal'))
    }
}
$report=[ordered]@{version=1;wrapperSha256=(Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant();seedScope=$seedId;actualLargeEofCreated=$false;jobStarted=$false;cases=$cases.ToArray();total=$cases.Count;failed=@($cases|Where-Object {-not $_.passed}).Count}
$json=$report|ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path $root 'results.json'),$json)
$json
if($report.failed -gt 0){exit 1}
