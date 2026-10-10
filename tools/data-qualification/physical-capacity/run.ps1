[CmdletBinding()]
param([Parameter(Mandatory)][ValidatePattern('^physical-capacity-[a-f0-9]{32}$')][string]$ScopeId)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($PSVersionTable.PSEdition -ne 'Core' -or -not [Environment]::Is64BitProcess){throw '需要现有64位PowerShell7'}
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$scope=Join-Path $repository "log\stage7-e2\$ScopeId"
$workMs=120000
$clock=[Diagnostics.Stopwatch]::StartNew()
$locks=[Collections.Generic.List[IO.FileStream]]::new()
$heldFacts=[Collections.Generic.List[object]]::new()
$boundDirectories=@{}
$nativeLoaded=$false
function Check-Time {if($clock.Elapsed.TotalMilliseconds -ge $workMs){throw '固定总期限已过'}}
function Assert-Parents([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($true) {
        $item = Get-Item -LiteralPath $current -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '受控目录含链接或无效。' }
        if($nativeLoaded) {
            $identity=[AIbrowse.FullTransfer.FixedTransferJob]::DirectoryIdentity($current)
            if($boundDirectories.ContainsKey($current)) {if($boundDirectories[$current] -cne $identity){throw '目录身份改变'}}
            else {$boundDirectories[$current]=$identity}
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) { break }
        $current = $parent
    }
}
function Read-BoundFile([string]$Path, [long]$Maximum, [bool]$KeepOpen, [bool]$KeepBytes = $true) {
    Check-Time
    Assert-Parents ([IO.Path]::GetDirectoryName($Path))
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt $Maximum) { throw '固定文件无效或过大。' }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $owned = $false
    try {
        if ($stream.Length -ne $item.Length) { throw '文件长度改变。' }
        $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant()
        $stream.Position = 0
        $bytes = [byte[]]::new(0)
        if ($KeepBytes) { $bytes = [byte[]]::new([int]$stream.Length); $stream.ReadExactly($bytes) }
        Check-Time
        if ($KeepOpen) { $locks.Add($stream); $owned = $true }
        [pscustomobject]@{ hash = $hash; bytes = $bytes; length = $stream.Length; stream = $stream }
    } finally { if (-not $owned) { $stream.Dispose() } }
}
function Write-Receipt([string]$Path, $Value, [switch]$Hold) {
    Check-Time
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 12))
    if ($bytes.Length -gt 65536) { throw '固定回执过大。' }
    $access = if ($Hold) { [IO.FileAccess]::ReadWrite } else { [IO.FileAccess]::Write }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, $access, [IO.FileShare]::Read)
    $owned = $false
    try {
        $stream.Write($bytes); $stream.Flush($true); Check-Time
        if ($Hold) {
            $locks.Add($stream); $owned = $true
            [pscustomobject]@{ stream=$stream; length=$bytes.Length; hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() }
        }
    } finally { if (-not $owned) { $stream.Dispose() } }
}
function Capture-HeldFact([IO.FileStream]$Stream, [string]$Hash = '') {
    [pscustomobject]@{ stream=$Stream; path=$Stream.Name; fact=[AIbrowse.FullTransfer.FixedTransferJob]::InspectFile($Stream); hash=$Hash }
}
function Assert-HeldHashes($Bindings) {
    foreach ($binding in $Bindings) {
        if ($binding.hash -ceq '') { continue }
        if ($binding.hash -cnotmatch '^[a-f0-9]{64}$' -or $binding.stream.Length -gt 65536) { throw '小证明绑定无效。' }
        $binding.stream.Position = 0
        if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($binding.stream)).ToLowerInvariant() -cne $binding.hash) { throw '小证明内容改变。' }
    }
}
function Assert-HeldFacts($Bindings) {
    foreach ($binding in $Bindings) {
        $actual = [AIbrowse.FullTransfer.FixedTransferJob]::InspectFile($binding.stream)
        $before = $binding.fact
        if ($actual.Dev -cne $before.Dev -or $actual.Ino -cne $before.Ino -or $actual.Size -ne $before.Size -or $actual.MtimeNs -cne $before.MtimeNs -or $actual.CtimeNs -cne $before.CtimeNs -or $actual.Links -ne $before.Links) { throw '最终文件事实改变。' }
        $pathStream=[IO.File]::Open($binding.path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
        try {
            $pathFact=[AIbrowse.FullTransfer.FixedTransferJob]::InspectFile($pathStream)
            if($pathFact.Dev -cne $before.Dev -or $pathFact.Ino -cne $before.Ino -or $pathFact.Size -ne $before.Size -or $pathFact.MtimeNs -cne $before.MtimeNs -or $pathFact.CtimeNs -cne $before.CtimeNs){throw '当前路径不再指向原文件'}
        } finally {$pathStream.Dispose()}
    }
    foreach($path in $boundDirectories.Keys){if([AIbrowse.FullTransfer.FixedTransferJob]::DirectoryIdentity($path) -cne $boundDirectories[$path]){throw '最终目录身份改变'}}
}
function Enter-CleanEnvironment {
    $saved = @{}
    $allow = @('SystemRoot','WINDIR','SystemDrive','TEMP','TMP','COMSPEC','PATHEXT','PATH','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE')
    foreach ($item in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
        if ($allow -notcontains [string]$item.Key) {
            $saved[[string]$item.Key] = [string]$item.Value
            [Environment]::SetEnvironmentVariable([string]$item.Key, [NullString]::Value, 'Process')
        }
    }
    return $saved
}
function Restore-Environment([hashtable]$Saved) {
    foreach ($item in $Saved.GetEnumerator()) { [Environment]::SetEnvironmentVariable($item.Key,$item.Value,'Process') }
}

function Bind-File([string]$Path, [long]$Maximum, [string]$ExpectedHash, [bool]$Small=$false) {
    $receipt=Read-BoundFile $Path $Maximum $true $Small
    if($receipt.hash -cne $ExpectedHash){throw '绑定摘要不符'}
    $heldFacts.Add((Capture-HeldFact $receipt.stream $(if($Small){$receipt.hash}else{''})))
    return $receipt
}
function Hold-Large([string]$Path, $Expected) {
    Check-Time
    Assert-Parents ([IO.Path]::GetDirectoryName($Path))
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $locks.Add($stream)
    $binding=Capture-HeldFact $stream
    if($null -ne $Expected) {
        $actual=$binding.fact
        if($actual.Dev -cne $Expected.dev -or $actual.Ino -cne $Expected.ino -or [string]$actual.Size -cne [string]$Expected.size -or $actual.MtimeNs -cne $Expected.mtimeNs -or $actual.CtimeNs -cne $Expected.ctimeNs -or $actual.Links -ne 1){throw '原数据身份变化'}
    }
    $heldFacts.Add($binding);Check-Time
}
function Read-JsonHeld([string]$Path) {
    $receipt=Read-BoundFile $Path 65536 $true
    $heldFacts.Add((Capture-HeldFact $receipt.stream $receipt.hash))
    return [Text.UTF8Encoding]::new($false,$true).GetString($receipt.bytes)|ConvertFrom-Json
}
function Hash-HeldPath([string]$Path) {
    $found=@($heldFacts|Where-Object {$_.path -ceq $Path})
    if($found.Count -ne 1 -or $found[0].hash -cnotmatch '^[a-f0-9]{64}$'){throw '小证明原绑定缺失'}
    return $found[0].hash
}

function Assert-JournalProof($Journal) {
    if($null -eq $Journal -or (@($Journal.PSObject.Properties.Name|Sort-Object)-join '|') -cne 'budgetBytes|continuousPeakVerified|finalAbsent|journalObservations|maxObservedBytes|observations'){throw 'journal证明字段不闭合'}
    foreach($name in @('budgetBytes','maxObservedBytes','observations','journalObservations')) {
        $value=$Journal.$name
        if(($value -isnot [int] -and $value -isnot [long]) -or $value -lt 0 -or $value -gt 9007199254740991){throw 'journal证明数字无效'}
    }
    if($Journal.budgetBytes -ne 134217728 -or $Journal.maxObservedBytes -gt 134217728 -or $Journal.observations -lt 2 -or $Journal.journalObservations -ge $Journal.observations -or ($Journal.journalObservations -eq 0 -and $Journal.maxObservedBytes -ne 0) -or $Journal.finalAbsent -isnot [bool] -or $Journal.finalAbsent -ne $true -or $Journal.continuousPeakVerified -isnot [bool] -or $Journal.continuousPeakVerified -ne $false){throw 'journal观测或结束证明不成立'}
}

$result=[ordered]@{version=1;scopeId=$ScopeId;kind='research64-node-construction';completed=$false;productE2Pass=$false;electronQualified=$false;job=$null;durationMs=0;error=$null}
$saved=$null
try {
    Assert-Parents $scope
    if(Test-Path -LiteralPath (Join-Path $scope 'generate-intent.json')){throw '本scope已有尝试，禁止重跑'}
    $helper=Read-BoundFile (Join-Path $scope 'FixedTransferJob.cs') 65536 $true
    $currentHelper=Read-BoundFile (Join-Path $repository 'tools/data-qualification/full-transfer/FixedTransferJob.cs') 65536 $true
    $allocation=Read-BoundFile (Join-Path $scope 'allocation.cs') 65536 $true
    $currentAllocation=Read-BoundFile (Join-Path $PSScriptRoot 'allocation.cs') 65536 $true
    if($helper.hash -cne $currentHelper.hash -or $allocation.hash -cne $currentAllocation.hash){throw '原生源码改变'}
    if('AIbrowse.FullTransfer.FixedTransferJob' -as [type]){throw '必须使用全新PowerShell进程'}
    $intent=Write-Receipt (Join-Path $scope 'generate-intent.json') @{version=1;scopeId=$ScopeId;workMs=120000;exitOnlyMs=30000;targetBytes=67108864;journalBudgetBytes=134217728;productE2Pass=$false;electronQualified=$false} -Hold
    $assemblyPath=Join-Path $scope 'generate-Job.dll'
    if(Test-Path -LiteralPath $assemblyPath){throw '原生制品已经存在'}
    $nativeText=[Text.UTF8Encoding]::new($false,$true).GetString($helper.bytes)+[Environment]::NewLine+[Text.UTF8Encoding]::new($false,$true).GetString($allocation.bytes)
    Add-Type -TypeDefinition $nativeText -OutputAssembly $assemblyPath
    [void][Reflection.Assembly]::LoadFrom($assemblyPath)
    $nativeLoaded=$true;Assert-Parents $scope;Check-Time
    foreach($item in @($helper,$currentHelper,$allocation,$currentAllocation,$intent)){$heldFacts.Add((Capture-HeldFact $item.stream $item.hash))}
    $nativeAssembly=Read-BoundFile $assemblyPath 1048576 $true $false
    $heldFacts.Add((Capture-HeldFact $nativeAssembly.stream))
    $compilerPath=[Microsoft.CodeAnalysis.CSharp.CSharpCompilation].Assembly.Location
    $compiler=Read-BoundFile $compilerPath 33554432 $true $false
    $heldFacts.Add((Capture-HeldFact $compiler.stream))
    $result['nativeBuild']=@{sourceSha256=$helper.hash;allocationSourceSha256=$allocation.hash;assemblySha256=$nativeAssembly.hash;compilerSha256=$compiler.hash;powerShellVersion=$PSVersionTable.PSVersion.ToString()}
    $build=Read-JsonHeld (Join-Path $scope 'build-proof.json')
    if($build.version -ne 1 -or $build.scopeId -cne $ScopeId -or $build.kind -cne 'research64-node-construction' -or $build.productE2Pass -ne $false -or $build.electronQualified -ne $false -or $build.runtimeId -cne 'runtime-9399eea0c11d4e6f9cde46ae2369376b' -or $build.sourceProof -cne 'f07a1a59ef5639d10c17eae1a80e6f7709d681623230c64d7bd54f4b089077e5'){throw '固定构建证明无效'}
    $requiredSources=@('tools/data-qualification/physical-capacity/build.ts','tools/data-qualification/physical-capacity/run.ps1','tools/data-qualification/physical-capacity/allocation.cs','tools/data-qualification/physical-capacity/generate.ts','tools/data-qualification/physical-capacity/padding.ts','tools/data-qualification/physical-capacity/backup.ts','tools/data-qualification/physical-capacity/journal.ts','tools/data-qualification/physical-capacity/contract.ts','tools/data-qualification/physical-capacity/main.ts','tools/data-qualification/full-transfer/FixedTransferJob.cs','tools/data-qualification/full-transfer/io.ts','tools/data-qualification/full-transfer/contract.ts','package.json','package-lock.json')
    foreach($name in $requiredSources){if($name -cnotin $build.sources.PSObject.Properties.Name){throw '必要来源缺失'}}
    foreach($item in $build.sources.PSObject.Properties){
        if($item.Name -cnotmatch '^(src/|tools/data-qualification/(physical-capacity|full-transfer)/|node_modules/|package(?:-lock)?\.json$)' -or $item.Name.Contains('..') -or $item.Name.Contains('\') -or $item.Name.Contains(':')){throw '绑定源码路径无效'}
        $null=Bind-File (Join-Path $repository $item.Name) 8388608 $item.Value
    }
    if((@($build.artifacts.PSObject.Properties.Name|Sort-Object)-join '|') -cne 'allocation.cs|FixedTransferJob.cs|generate.cjs'){throw '制品集合无效'}
    foreach($item in $build.artifacts.PSObject.Properties){$receipt=Bind-File (Join-Path $scope $item.Name) 8388608 $item.Value.sha256;if($receipt.length -ne $item.Value.bytes){throw '制品长度改变'}}
    $node=(Get-Command node.exe -CommandType Application|Select-Object -First 1).Source
    if($build.node.version -cne 'v24.18.0' -or $build.node.sha256 -cne '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de' -or ('v'+(Get-Item -LiteralPath $node).VersionInfo.ProductVersion) -cne $build.node.version){throw '固定Node版本改变'}
    $null=Bind-File $node 134217728 $build.node.sha256
    $runtime=Join-Path $repository 'log/stage7-e2/runtime-9399eea0c11d4e6f9cde46ae2369376b'
    $null=Read-JsonHeld (Join-Path $runtime 'fixture-proof.json')
    if((Hash-HeldPath (Join-Path $runtime 'fixture-proof.json')) -cne $build.sourceProof){throw '合成源证明改变'}
    $source=Join-Path $runtime 'fixtures/research/research.db'
    Hold-Large $source $null
    if((@((Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($source)) -Force).Name)-join '|') -cne 'research.db'){throw '原库附属文件未闭合'}
    if(Test-Path -LiteralPath (Join-Path $scope 'fixtures')){throw '输出目录已存在'}
    $disk=[AIbrowse.FullTransfer.FixedTransferJob]::InspectDisk($scope)
    $required=2*[AIbrowse.FullTransfer.FixedTransferJob]::Allocation(67108864,$disk.AllocationUnit)+[AIbrowse.FullTransfer.FixedTransferJob]::Allocation(134217728,$disk.AllocationUnit)+[AIbrowse.FullTransfer.FixedTransferJob]::Allocation(16777216,$disk.AllocationUnit)+1073741824
    if($disk.AvailableBytes -lt $required){throw '逐文件空间预算不足'}
    $volume=Write-Receipt (Join-Path $scope 'generate-volume.json') @{unit=[string]$disk.AllocationUnit;available=[string]$disk.AvailableBytes;required=[string]$required} -Hold
    $heldFacts.Add((Capture-HeldFact $volume.stream $volume.hash))
    Assert-HeldHashes $heldFacts;Assert-HeldFacts $heldFacts;Check-Time
    $saved=Enter-CleanEnvironment
    $remaining=[int][Math]::Floor($workMs-$clock.Elapsed.TotalMilliseconds)
    if($remaining -le 0){throw '原工作期限已过'}
    $result.job=[AIbrowse.FullTransfer.FixedTransferJob]::Execute('import',$node,(Join-Path $scope 'generate.cjs'),$ScopeId,$scope,([Guid]::NewGuid().ToString('N')),$remaining)
    Check-Time
    if(-not $result.job.Succeeded -or -not $result.job.ActualZero -or $result.job.OwnershipRetained -or $result.job.ExitCode -ne 0 -or -not $result.job.LimitsVerified -or $null -ne $result.job.ExitFailure -or $null -ne $result.job.Failure -or $result.job.Samples -lt 1){throw '实际Job或精确退出未通过'}
    [AIbrowse.FullTransfer.FixedTransferJob]::ValidateLimits('import',$result.job.LimitFlags,$result.job.ProcessLimit,$result.job.ProcessCommitLimit,$result.job.JobCommitLimit)
    $proof=Read-JsonHeld (Join-Path $scope 'fixture-proof.json')
    if($proof.version -ne 1 -or $proof.scopeId -cne $ScopeId -or $proof.kind -cne 'research64-node-construction' -or $proof.completed -ne $true -or $proof.productE2Pass -ne $false -or $proof.electronQualified -ne $false -or $proof.sourceProof -cne $build.sourceProof -or $proof.buildProofSha256 -cne (Hash-HeldPath (Join-Path $scope 'build-proof.json')) -or $proof.nodeVersion -cne $build.node.version -or $proof.allocationUnit -cne [string]$disk.AllocationUnit -or $proof.requiredFreeBytes -cne [string]$required){throw '输出证明不闭合'}
    if($proof.files.Count -ne 2 -or (@($proof.files.member|Sort-Object)-join '|') -cne 'research-backup.db|research.db'){throw '输出成员不闭合'}
    Assert-JournalProof $proof.journal
    $result['journal']=$proof.journal
    $physical=@()
    foreach($file in $proof.files){
        if($file.bytes -ne 67108864 -or $file.sha256 -cnotmatch '^[a-f0-9]{64}$'){throw '输出容量无效'}
        $path=Join-Path $scope ('fixtures/'+$file.member)
        Hold-Large $path $file.identity
        $binding=@($heldFacts|Where-Object {$_.path -ceq $path})
        if($binding.Count -ne 1){throw '输出身份缺失'}
        $physical+=@{member=$file.member;bytes=67108864;allocatedBytes=[AIbrowse.PhysicalCapacity.Allocation]::Read($binding[0].stream);ordinaryNonSparseNonCompressed=$true}
    }
    if((@((Get-ChildItem -LiteralPath (Join-Path $scope 'fixtures') -Force).Name|Sort-Object)-join '|') -cne 'research-backup.db|research.db'){throw '输出附属文件未闭合'}
    $result['physical']=$physical
    $result['fixtureProofSha256']=Hash-HeldPath (Join-Path $scope 'fixture-proof.json')
    Assert-HeldHashes $heldFacts;Assert-HeldFacts $heldFacts;Check-Time
    $result.completed=$true;$result.durationMs=$clock.Elapsed.TotalMilliseconds
    $receipt=Write-Receipt (Join-Path $scope 'generate-result.json') $result -Hold
    $heldFacts.Add((Capture-HeldFact $receipt.stream $receipt.hash))
    Assert-HeldHashes $heldFacts;Assert-HeldFacts $heldFacts;Check-Time
} catch {
    $result.completed=$false;$result.error='物理容量前置失败，原件及未知所有权保留'
} finally {
    if($null -ne $saved){Restore-Environment $saved}
    foreach($stream in $locks){try{$stream.Dispose()}catch{$result.completed=$false}}
    if($clock.Elapsed.TotalMilliseconds -ge $workMs){$result.completed=$false;$result.error='原工作期限已过'}
    $result.durationMs=$clock.Elapsed.TotalMilliseconds
}
$result|ConvertTo-Json -Depth 12
if(-not $result.completed){exit 1}
