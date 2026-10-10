[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^oversize-preflight-[a-f0-9]{32}$')]
    [string]$ScopeId
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($PSVersionTable.PSEdition -ne 'Core' -or -not [Environment]::Is64BitProcess){throw '需要现有64位PowerShell7'}
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$scope=Join-Path $repository "log\stage7-e2\$ScopeId"
$workMs=120000
$clock=[Diagnostics.Stopwatch]::StartNew()
$locks=[Collections.Generic.List[IO.FileStream]]::new()
$facts=[Collections.Generic.List[object]]::new()
$directories=@{}
$saved=$null
$nativeLoaded=$false
$phase='claim'
$completed=$false
$job=$null
$claimed=$false

function Check-Time {if($clock.Elapsed.TotalMilliseconds -ge $workMs){throw '原120秒工作期限已过'}}
function Assert-Parents([string]$Path) {
    for($current=[IO.Path]::GetFullPath($Path);; $current=[IO.Path]::GetDirectoryName($current)) {
        $item=Get-Item -LiteralPath $current -Force
        if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '受控父链无效'}
        if($nativeLoaded) {
            $identity=[AIbrowse.FullTransfer.FixedTransferJob]::DirectoryIdentity($current)
            if($directories.ContainsKey($current)) {if($directories[$current] -cne $identity){throw '受控父链身份改变'}}
            else {$directories[$current]=$identity}
        }
        $parent=[IO.Path]::GetDirectoryName($current)
        if([string]::IsNullOrEmpty($parent) -or $parent -eq $current){break}
    }
}
function Write-NewJson([string]$Path,$Value,[switch]$Hold) {
    Check-Time
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 12 -Compress))
    if($bytes.Length -gt 65536){throw '固定回执过大'}
    $access=if($Hold){[IO.FileAccess]::ReadWrite}else{[IO.FileAccess]::Write}
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,$access,[IO.FileShare]::Read)
    $owned=$false
    try {
        $stream.Write($bytes);$stream.Flush($true)
        if($Hold){$locks.Add($stream);$owned=$true;return $stream}
    } finally {if(-not $owned){$stream.Dispose()}}
}
function Read-Bound([string]$Path,[long]$Maximum,[bool]$Bytes=$false) {
    Check-Time;Assert-Parents ([IO.Path]::GetDirectoryName($Path))
    $item=Get-Item -LiteralPath $Path -Force
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -le 0 -or $item.Length -gt $Maximum){throw '绑定文件无效'}
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $owned=$false
    try {
        if($stream.Length -ne $item.Length){throw '绑定文件长度改变'}
        $hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant()
        $stream.Position=0
        $content=[byte[]]::new(0)
        if($Bytes){$content=[byte[]]::new([int]$stream.Length);$stream.ReadExactly($content)}
        $locks.Add($stream);$owned=$true
        $fact=$null
        if($nativeLoaded){$fact=[AIbrowse.FullTransfer.FixedTransferJob]::InspectFile($stream)}
        $binding=[pscustomobject]@{path=$Path;stream=$stream;hash=$hash;length=$stream.Length;bytes=$content;fact=$fact;small=$Bytes}
        $facts.Add($binding);return $binding
    } finally {if(-not $owned){$stream.Dispose()}}
}
function Header-Hash([IO.FileStream]$Stream) {
    $buffer=[byte[]]::new(64);$Stream.Position=0;$count=$Stream.Read($buffer,0,$buffer.Length);$Stream.Position=0
    $exact=[byte[]]::new($count)
    if($count -gt 0){[Array]::Copy($buffer,$exact,$count)}
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($exact)).ToLowerInvariant()
}
function Hold-Sparse([string]$Path,$Expected) {
    Check-Time;Assert-Parents ([IO.Path]::GetDirectoryName($Path))
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $locks.Add($stream)
    $native=[AIbrowse.OversizePreflight.SparseFile]::InspectPath($Path)
    $identity=[AIbrowse.OversizePreflight.SparseFile]::Inspect($stream)
    Assert-SparseFact $identity $Expected
    Assert-SparseFact $native $identity
    $header=Header-Hash $stream
    if($header -cne $Expected.HeaderSha256){throw '创建头部与持有句柄不一致'}
    $binding=[pscustomobject]@{path=$Path;stream=$stream;fact=$identity;sparse=$native;header=$header;small=$false;hash=''}
    $facts.Add($binding);return $binding
}
function Assert-SparseFact($Current,$Expected) {
    if(-not $Current.Sparse -or $Current.Length -ne $Expected.Length -or $Current.Identity -cne $Expected.Identity -or $Current.AllocatedBytes -gt 1048576 -or $Current.AllocatedBytes -lt 0 -or $Current.AllocatedBytes -ne $Expected.AllocatedBytes -or $Current.Links -ne 1 -or $Current.Attributes -ne $Expected.Attributes -or $Current.CreationTime -ne $Expected.CreationTime -or $Current.LastWriteTime -ne $Expected.LastWriteTime -or $Current.ChangeTime -ne $Expected.ChangeTime){throw '超限稀疏文件事实无效'}
}
function Assert-Facts {
    foreach($binding in $facts) {
        if($binding.PSObject.Properties.Name -contains 'sparse') {
            $current=[AIbrowse.OversizePreflight.SparseFile]::Inspect($binding.stream)
            Assert-SparseFact $current $binding.fact
            $native=[AIbrowse.OversizePreflight.SparseFile]::InspectPath($binding.path)
            Assert-SparseFact $native $binding.sparse
            if((Header-Hash $binding.stream) -cne $binding.header){throw '超限原件改变'}
        } else {
            $current=[AIbrowse.FullTransfer.FixedTransferJob]::InspectFile($binding.stream)
            if($null -ne $binding.fact -and ($current.Dev -cne $binding.fact.Dev -or $current.Ino -cne $binding.fact.Ino -or $current.Size -ne $binding.fact.Size -or $current.MtimeNs -cne $binding.fact.MtimeNs -or $current.CtimeNs -cne $binding.fact.CtimeNs -or $current.Links -ne $binding.fact.Links)){throw '绑定文件身份改变'}
            if($binding.small) {
                $binding.stream.Position=0
                if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($binding.stream)).ToLowerInvariant() -cne $binding.hash){throw '小绑定内容改变'}
            }
        }
    }
    foreach($path in $directories.Keys){if([AIbrowse.FullTransfer.FixedTransferJob]::DirectoryIdentity($path) -cne $directories[$path]){throw '目录身份改变'}}
}
function Read-Json([string]$Path) {
    $binding=Read-Bound $Path 65536 $true
    return [Text.UTF8Encoding]::new($false,$true).GetString($binding.bytes)|ConvertFrom-Json
}
function Enter-CleanEnvironment {
    $prior=@{};$allow=@('SystemRoot','WINDIR','SystemDrive','TEMP','TMP','COMSPEC','PATHEXT','PATH','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE')
    foreach($item in [Environment]::GetEnvironmentVariables().GetEnumerator()){
        if($allow -notcontains [string]$item.Key){$prior[[string]$item.Key]=[string]$item.Value;[Environment]::SetEnvironmentVariable([string]$item.Key,[NullString]::Value,'Process')}
    }
    return $prior
}
function Restore-Environment([hashtable]$Prior) {
    foreach($item in [Environment]::GetEnvironmentVariables().GetEnumerator()){
        if($item.Key -notin @('SystemRoot','WINDIR','SystemDrive','TEMP','TMP','COMSPEC','PATHEXT','PATH','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE')){[Environment]::SetEnvironmentVariable([string]$item.Key,[NullString]::Value,'Process')}
    }
    foreach($item in $Prior.GetEnumerator()){[Environment]::SetEnvironmentVariable($item.Key,$item.Value,'Process')}
}
function Assert-Closure([string[]]$Expected) {
    $actual=@(Get-ChildItem -LiteralPath $scope -Force)
    if(@($actual|Where-Object {$_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)}).Count -ne 0 -or ((@($actual.Name|Sort-Object)-join '|') -cne (@($Expected|Sort-Object)-join '|'))){throw 'scope成员不闭合'}
}
function Scope-Allocation {
    [long]$total=0
    foreach($item in Get-ChildItem -LiteralPath $scope -Force){
        if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '工具分配量成员无效'}
        $total=[AIbrowse.OversizePreflight.SparseFile]::AddAllocation($total,[AIbrowse.OversizePreflight.SparseFile]::InspectPath($item.FullName).AllocatedBytes)
    }
    return $total
}
function Assert-JsonKeys([Text.Json.JsonElement]$Element) {
    if($Element.ValueKind -eq [Text.Json.JsonValueKind]::Object) {
        $keys=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach($property in $Element.EnumerateObject()) {
            if(-not $keys.Add($property.Name)){throw '构建证明有重复字段'}
            Assert-JsonKeys $property.Value
        }
    } elseif($Element.ValueKind -eq [Text.Json.JsonValueKind]::Array) {
        foreach($member in $Element.EnumerateArray()){Assert-JsonKeys $member}
    }
}
function Parse-BuildProof([byte[]]$Bytes) {
    $text=[Text.UTF8Encoding]::new($false,$true).GetString($Bytes)
    $document=[Text.Json.JsonDocument]::Parse($text)
    try {Assert-JsonKeys $document.RootElement} finally {$document.Dispose()}
    return $text|ConvertFrom-Json
}

$result=[ordered]@{version=1;scopeId=$ScopeId;kind='oversize-preflight-wrapper';completed=$false;phase=$phase;durationMs=0;job=$null;toolAllocatedBytes='pending-wrapper-exit';requiresWrapperExit=$true;productE2Pass=$false;capacityQualified=$false;enospcQualified=$false;actualRun=$true;error=$null}
try {
    Assert-Parents $scope
    $intentPath=Join-Path $scope 'preflight-intent.json'
    if(Test-Path -LiteralPath $intentPath){throw '本scope已有claim，禁止重跑'}
    foreach($item in Get-ChildItem -LiteralPath $scope -Force){
        if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Name -cnotin @('FixedTransferJob.cs','SparseFile.cs','build-proof.json','worker.cjs')){throw '本scope有运行遗留或未知成员，禁止重跑'}
    }
    $intent=Write-NewJson $intentPath ([ordered]@{version=1;scopeId=$ScopeId;workMs=120000;exitOnlyMs=30000;cases=@(5368709121,536870913,67108865,536870913);fileAllocationLimit=1048576;toolAllocationLimit=16777216;freeReserve=1073741824;productE2Pass=$false;capacityQualified=$false;enospcQualified=$false}) -Hold
    $claimed=$true
    $intent.Position=0
    $intentHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($intent)).ToLowerInvariant()
    $intent.Position=0
    $facts.Add([pscustomobject]@{path=$intentPath;stream=$intent;hash=$intentHash;length=$intent.Length;bytes=[byte[]]::new(0);fact=$null;small=$true})
    $buildPath=Join-Path $scope 'build-proof.json'
    $buildBinding=Read-Bound $buildPath 65536 $true
    $build=Parse-BuildProof $buildBinding.bytes
    $currentSourceCommit=(& git -C $repository rev-parse HEAD)
    if($LASTEXITCODE -ne 0){throw '无法读取当前源码提交'}
    $currentSourceCommit=([string]$currentSourceCommit).Trim()
    if($build.version -ne 1 -or $build.scopeId -cne $ScopeId -or $build.kind -cne 'oversize-preflight-build' -or $build.sourceCommit -isnot [string] -or $build.sourceCommit -cnotmatch '^[a-f0-9]{40}$' -or $currentSourceCommit -cne $build.sourceCommit -or $build.builtOnly -isnot [bool] -or $build.builtOnly -ne $true -or $build.executed -isnot [bool] -or $build.executed -ne $false -or $build.productE2Pass -isnot [bool] -or $build.productE2Pass -ne $false -or $build.capacityQualified -isnot [bool] -or $build.capacityQualified -ne $false -or $build.enospcQualified -isnot [bool] -or $build.enospcQualified -ne $false){throw '构建证明字段无效'}
    $phase='binding'
    $required=@('tools/data-qualification/oversize-preflight/build.ts','tools/data-qualification/oversize-preflight/contract.ts','tools/data-qualification/oversize-preflight/worker.ts','tools/data-qualification/oversize-preflight/SparseFile.cs','tools/data-qualification/oversize-preflight/run.ps1','tools/data-qualification/oversize-preflight/README.md','tools/data-qualification/oversize-preflight/contract.test.ts','tools/data-qualification/oversize-preflight/native.test.ps1','tools/data-qualification/oversize-preflight/worker.test.ts','tools/data-qualification/oversize-preflight/wrapper.test.ts','tools/data-qualification/full-transfer/FixedTransferJob.cs','src/main/storage/native-transfer-selection.ts','src/main/storage/staging-sqlite.ts','src/main/storage/backup-container.ts','src/main/storage/dataset-layout.ts','src/main/storage/bounded-json.ts','src/main/ai/conversation-transfer.ts','package.json','package-lock.json')
    if((@($required|Sort-Object)-join '|') -cne (@($build.sources.PSObject.Properties.Name|Sort-Object)-join '|')){throw '来源集合不闭合'}
    $workerInputs=@('tools/data-qualification/oversize-preflight/worker.ts','tools/data-qualification/oversize-preflight/contract.ts','src/main/storage/native-transfer-selection.ts','src/main/storage/staging-sqlite.ts','src/main/storage/backup-container.ts','src/main/storage/dataset-layout.ts','src/main/storage/bounded-json.ts','src/main/ai/conversation-transfer.ts')
    if((@($workerInputs|Sort-Object)-join '|') -cne (@($build.workerBundle.inputs.PSObject.Properties.Name|Sort-Object)-join '|') -or $build.workerBundle.sha256 -cne $build.artifacts.'worker.cjs'.sha256){throw 'worker输入集合或制品摘要不闭合'}
    foreach($item in $build.workerBundle.inputs.PSObject.Properties){if($item.Value -cne $build.sources.($item.Name)){throw 'worker输入未绑定来源'}}
    foreach($item in $build.sources.PSObject.Properties){
        if($item.Value -isnot [string] -or $item.Value -cnotmatch '^[a-f0-9]{64}$'){throw '来源摘要无效'}
        $bound=Read-Bound (Join-Path $repository $item.Name) 33554432 $false
        if($bound.hash -cne $item.Value){throw '来源摘要改变'}
    }
    if((@($build.artifacts.PSObject.Properties.Name|Sort-Object)-join '|') -cne 'FixedTransferJob.cs|SparseFile.cs|worker.cjs'){throw '制品集合无效'}
    foreach($item in $build.artifacts.PSObject.Properties){
        $bound=Read-Bound (Join-Path $scope $item.Name) 8388608 $false
        if($bound.hash -cne $item.Value.sha256 -or $bound.length -ne $item.Value.bytes){throw '制品绑定改变'}
    }
    if($build.fixedTransferJobSha256 -cne 'be1fbf5623ae06da19848f33c5837c1c3ca42827935961d99453a1397cbcd167' -or $build.artifacts.'FixedTransferJob.cs'.sha256 -cne $build.fixedTransferJobSha256 -or $build.sources.'tools/data-qualification/full-transfer/FixedTransferJob.cs' -cne $build.fixedTransferJobSha256){throw '共享监督器来源无效'}
    if($build.artifacts.'SparseFile.cs'.sha256 -cne $build.sources.'tools/data-qualification/oversize-preflight/SparseFile.cs'){throw '稀疏helper复制制品不同源'}
    $node=(Get-Command node.exe -CommandType Application|Select-Object -First 1).Source
    if($build.node.version -cne 'v24.18.0' -or $build.node.sha256 -cne '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de' -or ('v'+(Get-Item -LiteralPath $node).VersionInfo.ProductVersion) -cne $build.node.version){throw '固定Node无效'}
    $nodeBinding=Read-Bound $node 134217728 $false
    if($nodeBinding.hash -cne $build.node.sha256){throw '固定Node摘要改变'}
    Check-Time
    $phase='native-build'
    if('AIbrowse.FullTransfer.FixedTransferJob' -as [type]){throw '必须使用全新PowerShell进程'}
    $assemblyPath=Join-Path $scope 'preflight-helpers.dll'
    Add-Type -Path @((Join-Path $scope 'FixedTransferJob.cs'),(Join-Path $scope 'SparseFile.cs')) -OutputAssembly $assemblyPath
    [void][Reflection.Assembly]::LoadFrom($assemblyPath)
    $nativeLoaded=$true;Assert-Parents $scope
    foreach($binding in $facts){$binding.fact=[AIbrowse.FullTransfer.FixedTransferJob]::InspectFile($binding.stream)}
    $assembly=Read-Bound $assemblyPath 1048576 $false
    $compiler=Read-Bound ([Microsoft.CodeAnalysis.CSharp.CSharpCompilation].Assembly.Location) 33554432 $false
    $result['nativeBuild']=[ordered]@{assemblySha256=$assembly.hash;compilerSha256=$compiler.hash;powerShellVersion=$PSVersionTable.PSVersion.ToString()}
    $disk=[AIbrowse.FullTransfer.FixedTransferJob]::InspectDisk($scope)
    $requiredFree=[AIbrowse.FullTransfer.FixedTransferJob]::Allocation(16777216,$disk.AllocationUnit)+1073741824
    if($disk.AvailableBytes -lt $requiredFree){throw '构造前空间余量不足'}
    $phase='construct'
    $containerHeader=[byte[]]::new(16);[Text.Encoding]::ASCII.GetBytes('AIBAK001').CopyTo($containerHeader,0);$containerHeader[11]=1
    $sqliteHeader=[Text.Encoding]::ASCII.GetBytes("SQLite format 3`0")
    $plans=@(
        @{name='oversize-container.aibak';bytes=5368709121;header=$containerHeader},
        @{name='oversize-sources.db';bytes=536870913;header=$sqliteHeader},
        @{name='oversize-research.db';bytes=67108865;header=$sqliteHeader},
        @{name='oversize-watch.db';bytes=536870913;header=$sqliteHeader}
    )
    foreach($plan in $plans){
        Check-Time;$path=Join-Path $scope $plan.name
        $created=[AIbrowse.OversizePreflight.SparseFile]::Create($path,[long]$plan.bytes,[byte[]]$plan.header)
        [void](Hold-Sparse $path $created)
    }
    $totalAllocated=Scope-Allocation
    if($totalAllocated -gt 16777216){throw '工具落盘预算超限'}
    $disk=[AIbrowse.FullTransfer.FixedTransferJob]::InspectDisk($scope)
    if($disk.AvailableBytes -lt 1073741824){throw '原1GiB空闲余量不足'}
    Assert-Facts;Check-Time
    $phase='execute'
    $saved=Enter-CleanEnvironment
    $remaining=[int][Math]::Floor($workMs-$clock.Elapsed.TotalMilliseconds)
    if($remaining -le 0){throw '原120秒工作期限已过'}
    $job=[AIbrowse.FullTransfer.FixedTransferJob]::Execute('import',$node,(Join-Path $scope 'worker.cjs'),$ScopeId,$scope,([Guid]::NewGuid().ToString('N')),$remaining)
    Check-Time
    if(-not $job.Succeeded -or -not $job.ActualZero -or $job.OwnershipRetained -or $job.ExitCode -ne 0 -or -not $job.LimitsVerified -or $null -ne $job.ExitFailure -or $null -ne $job.Failure -or $job.Samples -lt 1 -or $job.RssPeakBytes -gt 1073741824 -or $job.TreeRssPeakBytes -gt 1073741824){throw '实际Job或精确退出失败'}
    [AIbrowse.FullTransfer.FixedTransferJob]::ValidateLimits('import',$job.LimitFlags,$job.ProcessLimit,$job.ProcessCommitLimit,$job.JobCommitLimit)
    $result.job=[ordered]@{succeeded=$job.Succeeded;actualZero=$job.ActualZero;exitCode=$job.ExitCode;samples=$job.Samples;limitFlags=$job.LimitFlags;processLimit=$job.ProcessLimit;processCommitLimit=[string]$job.ProcessCommitLimit;jobCommitLimit=[string]$job.JobCommitLimit;rssPeakBytes=[string]$job.RssPeakBytes;treeRssPeakBytes=[string]$job.TreeRssPeakBytes;creationFlags=$job.CreationFlags}
    $phase='receipt'
    $proof=Read-Json (Join-Path $scope 'complete.json')
    if($proof.version -ne 1 -or $proof.scopeId -cne $ScopeId -or $proof.kind -cne 'oversize-preflight' -or $proof.nodeVersion -cne 'v24.18.0' -or $proof.controlsReached -ne $true -or $proof.completed -ne $true -or $proof.productE2Pass -ne $false -or $proof.capacityQualified -ne $false -or $proof.enospcQualified -ne $false -or $proof.zeroReadClaimed -ne $false -or $proof.files.Count -ne 4){throw 'worker回执无效'}
    foreach($index in 0..3){
        $actual=$proof.files[$index];$expected=$plans[$index]
        if($actual.id -cne @('container','sources','research','watch')[$index] -or $actual.file -cne $expected.name -or $actual.expectedBytes -ne $expected.bytes -or $actual.observedBytes -ne $expected.bytes -or $actual.rejected -ne $true -or $actual.preserved -ne $true -or $actual.noSidecars -ne $true){throw 'worker逐项回执无效'}
    }
    foreach($name in @('control-container.aibak','control-sources.db','control-research.db','control-watch.db')){[void](Read-Bound (Join-Path $scope $name) 1048576 $false)}
    foreach($name in @('control-sources.db','control-research.db','control-watch.db','oversize-sources.db','oversize-research.db','oversize-watch.db')){foreach($suffix in @('-wal','-shm','-journal')){if(Test-Path -LiteralPath (Join-Path $scope ($name+$suffix))){throw '发现额外sidecar'}}}
    Assert-Facts;Check-Time
    $beforeResult=@('FixedTransferJob.cs','SparseFile.cs','build-proof.json','worker.cjs','preflight-intent.json','preflight-helpers.dll','oversize-container.aibak','oversize-sources.db','oversize-research.db','oversize-watch.db','control-container.aibak','control-sources.db','control-research.db','control-watch.db','complete.json')
    Assert-Closure $beforeResult
    $totalAllocated=Scope-Allocation
    if(($totalAllocated+[AIbrowse.FullTransfer.FixedTransferJob]::Allocation(65536,$disk.AllocationUnit)) -gt 16777216){throw '最终回执预算不足'}
    $disk=[AIbrowse.FullTransfer.FixedTransferJob]::InspectDisk($scope)
    if($disk.AvailableBytes -lt 1073741824){throw '收口时原1GiB空闲余量不足'}
    $result.completed=$false;$result.phase='pending-wrapper-exit';$result.durationMs=$clock.Elapsed.TotalMilliseconds
    [void](Write-NewJson (Join-Path $scope 'preflight-result.json') $result)
    Assert-Closure (@($beforeResult)+@('preflight-result.json'))
    [void](Read-Bound (Join-Path $scope 'preflight-result.json') 65536 $true)
    $totalAllocated=Scope-Allocation
    if($totalAllocated -gt 16777216){throw '最终工具落盘预算超限'}
    $disk=[AIbrowse.FullTransfer.FixedTransferJob]::InspectDisk($scope)
    if($disk.AvailableBytes -lt 1073741824){throw '最终原1GiB空闲余量不足'}
    Assert-Facts;Check-Time
    $completed=$true;$result.completed=$true;$result.phase='complete';$result.durationMs=$clock.Elapsed.TotalMilliseconds;$result.toolAllocatedBytes=[string]$totalAllocated
} catch {
    $completed=$false;$result.completed=$false;$result.phase=$phase;$result.error='超限读前拒绝工具失败，原件及未知所有权保留'
    if($claimed -and -not (Test-Path -LiteralPath (Join-Path $scope 'preflight-result.json'))){try{[void](Write-NewJson (Join-Path $scope 'preflight-result.json') $result)}catch{}}
} finally {
    if($null -ne $saved){try{Restore-Environment $saved}catch{$completed=$false;$result.completed=$false}}
    foreach($stream in $locks){try{$stream.Dispose()}catch{$completed=$false;$result.completed=$false}}
    if($clock.Elapsed.TotalMilliseconds -ge $workMs){$completed=$false;$result.completed=$false;$result.error='原120秒工作期限已过'}
    $result.durationMs=$clock.Elapsed.TotalMilliseconds
}
$result|ConvertTo-Json -Depth 12
if(-not $completed){exit 1}
