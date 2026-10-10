[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidatePattern('^physical-full-transfer-[a-f0-9]{32}$')][string]$ScopeId,
 [Parameter(Mandatory)][ValidateSet('campaign')][string]$Mode
)
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
    $current=[IO.Path]::GetFullPath($Path)
    while($true) {
        $item=Get-Item -LiteralPath $current -Force
        if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '受控目录含链接或无效'}
        if($nativeLoaded) {
            $identity=[AIbrowse.FullTransfer.FixedTransferJob]::DirectoryIdentity($current)
            if($boundDirectories.ContainsKey($current)){if($boundDirectories[$current] -cne $identity){throw '目录身份改变'}}
            else {$boundDirectories[$current]=$identity}
        }
        $parent=[IO.Path]::GetDirectoryName($current)
        if([string]::IsNullOrEmpty($parent) -or $parent -eq $current){break}
        $current=$parent
    }
}
function Read-BoundFile([string]$Path,[long]$Maximum,[bool]$KeepOpen,[bool]$KeepBytes=$true) {
    Check-Time
    Assert-Parents ([IO.Path]::GetDirectoryName($Path))
    $item=Get-Item -LiteralPath $Path -Force
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt $Maximum){throw '固定文件无效或过大'}
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $owned=$false
    try {
        if($stream.Length -ne $item.Length){throw '文件长度改变'}
        $hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant()
        $stream.Position=0
        $bytes=[byte[]]::new(0)
        if($KeepBytes){$bytes=[byte[]]::new([int]$stream.Length);$stream.ReadExactly($bytes)}
        Check-Time
        if($KeepOpen){$locks.Add($stream);$owned=$true}
        [pscustomobject]@{hash=$hash;bytes=$bytes;length=$stream.Length;stream=$stream}
    } finally {if(-not $owned){$stream.Dispose()}}
}
function Capture-HeldFact([IO.FileStream]$Stream,[string]$Hash='') {
    [pscustomobject]@{stream=$Stream;path=$Stream.Name;fact=[AIbrowse.FullTransfer.FixedTransferJob]::InspectFile($Stream);hash=$Hash}
}
function Write-Receipt([string]$Path,$Value,[switch]$Hold) {
    Check-Time
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 16))
    if($bytes.Length -gt 65536){throw '固定回执过大'}
    $digest=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    $access=if($Hold){[IO.FileAccess]::ReadWrite}else{[IO.FileAccess]::Write}
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,$access,[IO.FileShare]::Read)
    $owned=$false
    try {
        $stream.Write($bytes);$stream.Flush($true);Check-Time
        if($Hold){$locks.Add($stream);$owned=$true;[pscustomobject]@{stream=$stream;hash=$digest}}
    } finally {if(-not $owned){$stream.Dispose()}}
    if(-not $Hold){[pscustomobject]@{hash=$digest;length=$bytes.Length}}
}
function Assert-Held {
    foreach($binding in $heldFacts) {
        $actual=[AIbrowse.FullTransfer.FixedTransferJob]::InspectFile($binding.stream)
        $before=$binding.fact
        if($actual.Dev -cne $before.Dev -or $actual.Ino -cne $before.Ino -or $actual.Size -ne $before.Size -or $actual.MtimeNs -cne $before.MtimeNs -or $actual.CtimeNs -cne $before.CtimeNs -or $actual.Links -ne $before.Links){throw '最终文件事实改变'}
        if($binding.hash -cne '') {
            if($binding.stream.Length -gt 65536){throw '小证明越界'}
            $binding.stream.Position=0
            if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($binding.stream)).ToLowerInvariant() -cne $binding.hash){throw '小证明内容改变'}
        }
        $pathStream=[IO.File]::Open($binding.path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
        try {
            $pathFact=[AIbrowse.FullTransfer.FixedTransferJob]::InspectFile($pathStream)
            if($pathFact.Dev -cne $before.Dev -or $pathFact.Ino -cne $before.Ino -or $pathFact.Size -ne $before.Size -or $pathFact.MtimeNs -cne $before.MtimeNs -or $pathFact.CtimeNs -cne $before.CtimeNs){throw '当前路径不再指向原文件'}
        } finally {$pathStream.Dispose()}
    }
    foreach($path in $boundDirectories.Keys){if([AIbrowse.FullTransfer.FixedTransferJob]::DirectoryIdentity($path) -cne $boundDirectories[$path]){throw '最终目录身份改变'}}
    Check-Time
}
function Bind-File([string]$Path,[long]$Maximum,[string]$ExpectedHash,[bool]$Small=$false) {
    $receipt=Read-BoundFile $Path $Maximum $true $Small
    if($receipt.hash -cne $ExpectedHash){throw '绑定摘要不符'}
    $heldFacts.Add((Capture-HeldFact $receipt.stream $(if($Small){$receipt.hash}else{''})))
    return $receipt
}
function Hold-Large([string]$Path,$Expected,[switch]$Physical) {
    Check-Time;Assert-Parents ([IO.Path]::GetDirectoryName($Path))
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $locks.Add($stream)
    $binding=Capture-HeldFact $stream
    if($null -ne $Expected) {
        $actual=$binding.fact
        if($actual.Dev -cne $Expected.dev -or $actual.Ino -cne $Expected.ino -or [string]$actual.Size -cne [string]$Expected.size -or $actual.MtimeNs -cne $Expected.mtimeNs -or $actual.CtimeNs -cne $Expected.ctimeNs -or $actual.Links -ne 1){throw '原数据身份变化'}
    }
    $heldFacts.Add($binding)
    if($Physical){return [AIbrowse.PhysicalFullTransfer.Allocation]::Read($stream)}
    return $binding
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
function Check-ConversationNames([string]$Root) {
    $expected=@('index.json')
    for($i=0;$i -lt 50;$i++){$expected+=('00000000-0000-4000-8000-{0:x12}.json' -f $i)}
    if((@((Get-ChildItem -LiteralPath $Root -Force).Name|Sort-Object)-join '|') -cne (@($expected|Sort-Object)-join '|')){throw '会话目录不闭合'}
    Assert-Parents $Root
}
function Check-InputMembers($Proof) {
    $expected=@('sources/sources.db','research/research.db','watch/watch.db','conversations/index.json')
    for($i=0;$i -lt 50;$i++){$expected+=('conversations/00000000-0000-4000-8000-{0:x12}.json' -f $i)}
    if($Proof.files.Count -ne 54 -or (@($Proof.files.member|Sort-Object)-join '|') -cne (@($expected|Sort-Object)-join '|')){throw '输入成员集合无效'}
}
function Enter-CleanEnvironment {
    $saved=@{}
    $allow=@('SystemRoot','WINDIR','SystemDrive','TEMP','TMP','COMSPEC','PATHEXT','PATH','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE')
    foreach($item in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
        if($allow -notcontains [string]$item.Key){$saved[[string]$item.Key]=[string]$item.Value;[Environment]::SetEnvironmentVariable([string]$item.Key,[NullString]::Value,'Process')}
    }
    return $saved
}
function Restore-Environment([hashtable]$Saved){foreach($item in $Saved.GetEnumerator()){[Environment]::SetEnvironmentVariable($item.Key,$item.Value,'Process')}}
function Assert-Deadline($Clock,[int]$WorkMs) {if($Clock.Elapsed.TotalMilliseconds -ge $WorkMs){throw '固定总期限已过'}}
function Assert-ImportAdmission($ImportResult,[string]$ObservedInputProofSha256,$Clock,[int]$WorkMs) {
    Assert-Deadline $Clock $WorkMs
    if($ImportResult.completed -ne $true -or $ImportResult.authorization -cne 'pending-wrapper-exit' -or $ImportResult.electronQualified -ne $false -or $ImportResult.productE2Pass -ne $false -or $ImportResult.job.Succeeded -ne $true -or $ImportResult.job.ActualZero -ne $true -or $ImportResult.job.OwnershipRetained -ne $false){throw '同调用栈导入未成功闭合'}
    if($ObservedInputProofSha256 -cnotmatch '^[a-f0-9]{64}$' -or $ObservedInputProofSha256 -cne $ImportResult.inputProofSha256){throw '同调用栈输入证明摘要改变'}
    Assert-Deadline $Clock $WorkMs
}
function Read-ClosedSmallHash([string]$Path,$Clock,[int]$WorkMs) {
    Assert-Deadline $Clock $WorkMs
    Assert-Parents ([IO.Path]::GetDirectoryName($Path))
    $item=Get-Item -LiteralPath $Path -Force
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 65536){throw '输入证明无效'}
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        if($stream.Length -ne $item.Length){throw '输入证明长度改变'}
        $hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant()
    } finally {$stream.Dispose()}
    Assert-Deadline $Clock $WorkMs
    return $hash
}

function Invoke-Phase {
param(
 [Parameter(Mandatory)][ValidateSet('import','transfer')][string]$Phase,
 [Parameter(Mandatory)]$PhaseClock,
 [Parameter(Mandatory)][int]$PhaseWorkMs,
 [string]$ExpectedInputProofSha256=''
)
    $Mode=$Phase
    $clock=$PhaseClock
    $workMs=$PhaseWorkMs
    $locks=[Collections.Generic.List[IO.FileStream]]::new()
    $heldFacts=[Collections.Generic.List[object]]::new()
    $boundDirectories=@{}
    $nativeLoaded=$false
    $saved=$null
    $cleanupError=$null
    $phaseError=$null
    $result=[ordered]@{version=1;scopeId=$ScopeId;mode=$Mode;authorization='pending-wrapper-exit';completed=$false;productE2Pass=$false;electronQualified=$false;job=$null;durationMs=0;error=$null}
try {
    $helper=Read-BoundFile (Join-Path $scope 'FixedTransferJob.cs') 65536 $true
    $currentHelper=Read-BoundFile (Join-Path $repository 'tools/data-qualification/full-transfer/FixedTransferJob.cs') 65536 $true
    $allocation=Read-BoundFile (Join-Path $scope 'allocation.cs') 65536 $true
    $currentAllocation=Read-BoundFile (Join-Path $PSScriptRoot 'allocation.cs') 65536 $true
    if($helper.hash -cne $currentHelper.hash -or $allocation.hash -cne $currentAllocation.hash){throw '原生工具源码改变'}
    $assemblyPath=Join-Path $scope 'campaign-Job.dll'
    if($Mode -ceq 'import') {
        if('AIbrowse.FullTransfer.FixedTransferJob' -as [type]){throw '必须使用新的PowerShell进程'}
        if(Test-Path -LiteralPath $assemblyPath){throw '原生制品已存在'}
        $nativeText=[Text.UTF8Encoding]::new($false,$true).GetString($helper.bytes)+[Environment]::NewLine+[Text.UTF8Encoding]::new($false,$true).GetString($allocation.bytes)
        Add-Type -TypeDefinition $nativeText -OutputAssembly $assemblyPath
        [void][Reflection.Assembly]::LoadFrom($assemblyPath)
    } elseif(-not ('AIbrowse.FullTransfer.FixedTransferJob' -as [type])) {throw '导入阶段未在当前调用栈完成'}
    $nativeLoaded=$true;Assert-Parents $scope
    $boundIntent=Read-BoundFile (Join-Path $scope 'campaign-intent.json') 65536 $true
    if($boundIntent.hash -cne $claim.hash -or $boundIntent.length -ne $claim.length){throw '一次性claim改变'}
    foreach($item in @($helper,$currentHelper,$allocation,$currentAllocation,$boundIntent)){$heldFacts.Add((Capture-HeldFact $item.stream $item.hash))}
    $nativeAssembly=Read-BoundFile $assemblyPath 1048576 $true $false
    $heldFacts.Add((Capture-HeldFact $nativeAssembly.stream))
    $compilerPath=[Microsoft.CodeAnalysis.CSharp.CSharpCompilation].Assembly.Location
    $compiler=Read-BoundFile $compilerPath 33554432 $true $false
    $heldFacts.Add((Capture-HeldFact $compiler.stream))
    $result['nativeBuild']=@{sourceSha256=$helper.hash;allocationSourceSha256=$allocation.hash;assemblySha256=$nativeAssembly.hash;compilerSha256=$compiler.hash;powerShellVersion=$PSVersionTable.PSVersion.ToString()}
    $build=Read-JsonHeld (Join-Path $scope 'build-proof.json')
    if($build.version -ne 1 -or $build.scopeId -cne $ScopeId -or $build.kind -cne 'physical-full-transfer-build-only' -or $build.productE2Pass -ne $false -or $build.imported -ne $false -or $build.electronQualified -ne $false){throw '构建证明无效'}
    $expectedScopes=@{
      conversations=@('full-conversations-29d6709186ef4d179628e94ec8c73663','a1ac75ca459c2342fd572de2a7cd2b73b8adb5f4597c2941dc068dff61a3086a')
      sources=@('physical-sources512-2aed3c7406694689baa106edd05d79d1','b810582243091851553d4eb3120555a24f02dc8e7513d37b42eedb677c07a522')
      research=@('physical-capacity-728ac71ab99a41babadd33c7fcc50045','d5b425624b27926f1f5e5bc1d39db2f61ed5330de919b99df2efc79db95d13d2')
      watch=@('physical-watch512-4d1f0347a0924c268f1441f62aeb21e8','6caf47b71b22bc703b7eeaabe0df07d6489e074ea10295946da573b317511f2e')
    }
    foreach($key in $expectedScopes.Keys){if($build.sourceScopes.$key.scopeId -cne $expectedScopes[$key][0] -or $build.sourceScopes.$key.proofSha256 -cne $expectedScopes[$key][1]){throw '固定来源映射改变'}}
    $mappingKeys=@($build.mappings|ForEach-Object{"$($_.entry)|$($_.importer)|$($_.request)|$($_.target)"}|Sort-Object)
    $expectedMappings=@(
      'counts|tools/data-qualification/full-transfer/counts-worker-core.ts|./contract|tools/data-qualification/physical-full-transfer/contract.ts',
      'counts|tools/data-qualification/full-transfer/counts.ts|./contract|tools/data-qualification/physical-full-transfer/contract.ts',
      'counts|tools/data-qualification/full-transfer/io.ts|./contract|tools/data-qualification/physical-full-transfer/contract.ts',
      'import|tools/data-qualification/full-transfer/import-entry.ts|./contract|tools/data-qualification/physical-full-transfer/contract.ts',
      'import|tools/data-qualification/full-transfer/import-entry.ts|./input|tools/data-qualification/physical-full-transfer/input.ts',
      'import|tools/data-qualification/full-transfer/io.ts|./contract|tools/data-qualification/physical-full-transfer/contract.ts',
      'main|tools/data-qualification/full-transfer/campaign.ts|./contract|tools/data-qualification/physical-full-transfer/contract.ts',
      'main|tools/data-qualification/full-transfer/counts-electron.ts|./contract|tools/data-qualification/physical-full-transfer/contract.ts',
      'main|tools/data-qualification/full-transfer/counts.ts|./contract|tools/data-qualification/physical-full-transfer/contract.ts',
      'main|tools/data-qualification/full-transfer/io.ts|./contract|tools/data-qualification/physical-full-transfer/contract.ts',
      'main|tools/data-qualification/full-transfer/main.ts|./contract|tools/data-qualification/physical-full-transfer/contract.ts',
      'main|tools/data-qualification/full-transfer/main.ts|./input|tools/data-qualification/physical-full-transfer/input.ts',
      'main|tools/data-qualification/full-transfer/trace.ts|./contract|tools/data-qualification/physical-full-transfer/contract.ts'
    )|Sort-Object
    if(($mappingKeys-join '|') -cne ($expectedMappings-join '|')){throw '构建适配映射不闭合'}
    $expectedBundles=@(
      @{entry='tools/data-qualification/full-transfer/import-entry.ts';count=10;sha256='6637748fda39e6a259c579f1cec024618687f84ff6ecc6a7146f3b1610ca930c'},
      @{entry='tools/data-qualification/full-transfer/main.ts';count=23;sha256='9bdbfb32eb4af69820331de90760f3d4dead8a2de5bd88dcaa34736f2ccb8304'},
      @{entry='src/main/storage/transfer-worker.ts';count=66;sha256='bcf33b853687be67d3bb7b31e6e62ba6b07539e664d2030e7dc4755be4509711'},
      @{entry='tools/data-qualification/full-transfer/counts-worker.ts';count=14;sha256='1e54bc1c82f8e82364b499936a28848462f0e9564b9b18b9b9775976370566de'}
    )
    if($build.bundleInputs.Count -ne $expectedBundles.Count){throw '构建bundle数量无效'}
    $bundleMembers=[Collections.Generic.List[string]]::new()
    for($index=0;$index -lt $expectedBundles.Count;$index++) {
        $names=@($build.bundleInputs[$index])
        $unique=@($names|Sort-Object -Unique)
        $canonical=@($names|Sort-Object)-join '|'
        $sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.UTF8Encoding]::new($false).GetBytes($canonical))).ToLowerInvariant()
        if($names.Count -ne $expectedBundles[$index]['count'] -or $unique.Count -ne $names.Count -or $expectedBundles[$index]['entry'] -cnotin $names -or $sha256 -cne $expectedBundles[$index]['sha256']){throw '固定bundle闭包无效'}
        foreach($name in $names) {
            if($name -in @('tools/data-qualification/full-transfer/contract.ts','tools/data-qualification/full-transfer/input.ts')){throw '构建混入旧输入模块'}
            $bundleMembers.Add($name)
        }
    }
    $requiredExtraSources=@(
      'native/lifecycle-guardian/Guardian.cs','package-lock.json','package.json',
      'tools/data-qualification/full-transfer/FixedTransferJob.cs',
      'tools/data-qualification/physical-full-transfer/allocation.cs',
      'tools/data-qualification/physical-full-transfer/build.ts',
      'tools/data-qualification/physical-full-transfer/contract.test.ts',
      'tools/data-qualification/physical-full-transfer/input.test.ts',
      'tools/data-qualification/physical-full-transfer/mapping.test.ts',
      'tools/data-qualification/physical-full-transfer/mapping.ts',
      'tools/data-qualification/physical-full-transfer/README.md',
      'tools/data-qualification/physical-full-transfer/run.ps1',
      'tools/data-qualification/physical-full-transfer/wrapper.test.ts'
    )
    $expectedSources=@($bundleMembers+$requiredExtraSources|Sort-Object -Unique)
    $actualSources=@($build.sources.PSObject.Properties.Name|Sort-Object -Unique)
    if($actualSources.Count -ne @($build.sources.PSObject.Properties).Count -or ($actualSources-join '|') -cne ($expectedSources-join '|')){throw '构建来源闭包无效'}
    foreach($item in $build.sources.PSObject.Properties) {
        if($item.Name -cnotmatch '^(src/|tools/data-qualification/(physical-full-transfer|full-transfer)/|native/lifecycle-guardian/|node_modules/|package(?:-lock)?\.json$)' -or $item.Name -match '(^|/)\.\.(/|$)' -or $item.Name.Contains('\') -or $item.Name.Contains(':')){throw '源码路径不闭合'}
        if($item.Name -in @('tools/data-qualification/full-transfer/contract.ts','tools/data-qualification/full-transfer/input.ts')){throw '源码证明混入旧输入模块'}
        $null=Bind-File (Join-Path $repository $item.Name) 8388608 $item.Value
    }
    $requiredArtifacts=@('app/lifecycle-guardian-integrity.json','app/main.cjs','app/out/lifecycle-guardian/guardian.exe','app/package.json','app/transfer-worker.js','app/counts-worker.js','import.cjs','FixedTransferJob.cs','allocation.cs')
    if((@($build.artifacts.PSObject.Properties.Name|Sort-Object)-join '|') -cne (@($requiredArtifacts|Sort-Object)-join '|')){throw '制品集合无效'}
    foreach($item in $build.artifacts.PSObject.Properties){$receipt=Bind-File (Join-Path $scope $item.Name) 12582912 $item.Value.sha256;if($receipt.length -ne $item.Value.bytes){throw '制品长度改变'}}
    $node=(Get-Command node.exe -CommandType Application|Select-Object -First 1).Source
    $electron=Join-Path $repository 'node_modules/electron/dist/electron.exe'
    if($build.node.path -cne $node -or $build.electron.path -cne $electron -or $build.node.version -cne 'v24.18.0' -or $build.node.sha256 -cne '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de' -or ('v'+(Get-Item -LiteralPath $node).VersionInfo.ProductVersion) -cne $build.node.version){throw '实际运行时身份无效'}
    $null=Bind-File $node 134217728 $build.node.sha256
    $null=Bind-File $electron 268435456 $build.electron.sha256
    $profile=Join-Path $scope 'profile'
    if($Mode -ceq 'import') {
        if(Test-Path -LiteralPath $profile){throw '导入目录已存在，禁止重跑'}
        $conversationRoot=Join-Path $repository "log/stage7-e2/$($expectedScopes.conversations[0])"
        $conversationProof=Read-JsonHeld (Join-Path $conversationRoot 'fixture-proof.json')
        if((Hash-HeldPath (Join-Path $conversationRoot 'fixture-proof.json')) -cne $expectedScopes.conversations[1]){throw '会话proof改变'}
        Check-ConversationNames (Join-Path $conversationRoot 'conversations')
        foreach($item in $conversationProof.files.PSObject.Properties){if($item.Name -cnotmatch '^(index|00000000-0000-4000-8000-[a-f0-9]{12})\.json$'){throw '会话来源成员无效'};Hold-Large (Join-Path $conversationRoot "conversations/$($item.Name)") $item.Value.identity|Out-Null}
        $sourcePlan=@(
          @('sources','sources.db',536870912,'380ef2a7649dd1c8b000a7bd6a6d925c211437289d43bcde60bafe0dcca4e6e4'),
          @('research','research.db',67108864,'9148fb5b75f3e89d9ff0a7179589428f881824b5b32d350cbbf80a57223ea504'),
          @('watch','watch.db',536870912,'9c58275fb1e0d5209422c428a234203426468b4942aad5574f63fc2fbc796480')
        )
        $sourcePhysical=@()
        foreach($plan in $sourcePlan) {
            $root=Join-Path $repository "log/stage7-e2/$($expectedScopes[$plan[0]][0])"
            $proof=Read-JsonHeld (Join-Path $root 'fixture-proof.json')
            if((Hash-HeldPath (Join-Path $root 'fixture-proof.json')) -cne $expectedScopes[$plan[0]][1]){throw '数据库proof改变'}
            $files=@($proof.files|Where-Object {$_.member -ceq $plan[1]})
            if($proof.completed -ne $true -or $proof.scopeId -cne $expectedScopes[$plan[0]][0] -or $files.Count -ne 1 -or $files[0].bytes -ne $plan[2] -or $files[0].sha256 -cne $plan[3]){throw '数据库来源证明无效'}
            $allocated=Hold-Large (Join-Path $root "fixtures/$($plan[1])") $files[0].identity -Physical
            $sourcePhysical+=@{member=$plan[1];bytes=$plan[2];allocatedBytes=$allocated;ordinaryNonSparseNonCompressed=$true}
        }
        $result['sourcePhysical']=$sourcePhysical
        $disk=[AIbrowse.FullTransfer.FixedTransferJob]::InspectDisk($scope)
        $volume=Write-Receipt (Join-Path $scope 'import-volume.json') @{unit=[string]$disk.AllocationUnit;available=[string]$disk.AvailableBytes} -Hold
        $heldFacts.Add((Capture-HeldFact $volume.stream $volume.hash))
        $executable=$node;$entry=Join-Path $scope 'import.cjs'
    } else {
        $proof=Read-JsonHeld (Join-Path $scope 'input-proof.json')
        if($ExpectedInputProofSha256 -cnotmatch '^[a-f0-9]{64}$' -or $proof.completed -ne $true -or $proof.scopeId -cne $ScopeId -or $proof.files.Count -ne 54 -or $ExpectedInputProofSha256 -cne (Hash-HeldPath (Join-Path $scope 'input-proof.json'))){throw '同调用栈输入证明无效'}
        Check-InputMembers $proof
        foreach($file in $proof.files){$physical=$file.member -in @('sources/sources.db','research/research.db','watch/watch.db');Hold-Large (Join-Path $profile $file.member) $file.identity -Physical:$physical|Out-Null}
        Check-ConversationNames (Join-Path $profile 'conversations')
        $disk=[AIbrowse.FullTransfer.FixedTransferJob]::InspectDisk($scope)
        $volume=Write-Receipt (Join-Path $scope 'transfer-volume.json') @{unit=[string]$disk.AllocationUnit;available=[string]$disk.AvailableBytes} -Hold
        $heldFacts.Add((Capture-HeldFact $volume.stream $volume.hash))
        $executable=$electron;$entry=Join-Path $scope 'app'
    }
    Assert-Held
    $saved=Enter-CleanEnvironment
    $remaining=[int][Math]::Floor($workMs-$clock.Elapsed.TotalMilliseconds)
    if($remaining -le 0){throw '原工作期限已过'}
    $result.job=[AIbrowse.FullTransfer.FixedTransferJob]::Execute($Mode,$executable,$entry,$ScopeId,$scope,([Guid]::NewGuid().ToString('N')),$remaining)
    Check-Time
    if(-not $result.job.Succeeded -or -not $result.job.ActualZero -or $result.job.OwnershipRetained -or $result.job.ExitCode -ne 0 -or -not $result.job.LimitsVerified -or $null -ne $result.job.ExitFailure -or $null -ne $result.job.Failure -or $result.job.Samples -lt 1){throw '实际Job执行或精确退出未通过'}
    [AIbrowse.FullTransfer.FixedTransferJob]::ValidateLimits($Mode,$result.job.LimitFlags,$result.job.ProcessLimit,$result.job.ProcessCommitLimit,$result.job.JobCommitLimit)
    if($Mode -ceq 'import') {
        $proof=Read-JsonHeld (Join-Path $scope 'input-proof.json')
        if($proof.completed -ne $true -or $proof.files.Count -ne 54 -or $proof.scopeId -cne $ScopeId){throw '导入未闭合'}
        Check-InputMembers $proof
        $result['inputProofSha256']=Hash-HeldPath (Join-Path $scope 'input-proof.json')
        foreach($file in $proof.files){Hold-Large (Join-Path $profile $file.member) $file.identity|Out-Null}
    } else {
        $campaign=Read-JsonHeld (Join-Path $scope 'campaign-result.json')
        $null=Bind-File (Join-Path $scope 'observations.jsonl') 65536 $campaign.observations.sha256 $true
        $backup=Read-JsonHeld (Join-Path $scope 'backup-result.json');$restore=Read-JsonHeld (Join-Path $scope 'restore-result.json')
        if($campaign.completed -ne $true -or $campaign.scopeId -cne $ScopeId -or $campaign.actions.Count -ne 2 -or $backup.action -cne 'backup' -or $restore.action -cne 'restore' -or -not $backup.childrenExited -or -not $restore.childrenExited -or $backup.operationId -ceq $restore.operationId -or $backup.snapshotId -cne $restore.snapshotId){throw '双操作证明不闭合'}
        if($restore.proof.expected.conversations.bytes -ne 3355458876 -or $restore.proof.expected.conversations.sha256 -cne 'cced3aa17d685cc1b119f060e3caf9928f49640195599debf9ab51f007546989'){throw '恢复50会话事实不符'}
        $physicalOutputs=@()
        foreach($action in @($backup,$restore)) {
            $counts=$action.counts
            if((@($counts.PSObject.Properties.Name|Sort-Object)-join '|') -cne 'digests|events|evidence|research|rules|sources' -or $counts.sources -ne 5000 -or $counts.research -ne 30 -or $counts.rules -ne 200 -or $counts.events -ne 2800 -or $counts.evidence -ne 8400 -or $counts.digests -ne 1030){throw '实际work计数不符'}
            $operation=Join-Path $profile ('data-transfer/'+$action.operationId.Replace('-',''))
            $expectedOutputs=@('work/sources.db','work/research.db','work/watch.db')
            if($action.action -ceq 'backup'){$expectedOutputs+=@('work/conversations.bin','output.aibak')}else{$expectedOutputs+=@('work/conversations/index.json');for($i=0;$i -lt 50;$i++){$expectedOutputs+=('work/conversations/00000000-0000-4000-8000-{0:x12}.json' -f $i)}}
            if((@($action.outputFacts.path|Sort-Object)-join '|') -cne (@($expectedOutputs|Sort-Object)-join '|')){throw '输出证明成员不闭合'}
            foreach($file in $action.outputFacts) {
                $path=Join-Path $operation $file.path
                if($file.path -in @('work/sources.db','work/research.db','work/watch.db')) {
                    $bytes=switch($file.path){'work/research.db'{67108864}default{536870912}}
                    if([long]$file.identity.size -ne $bytes){throw '物理三库长度不符'}
                    $allocated=Hold-Large $path $file.identity -Physical
                    $physicalOutputs+=@{action=$action.action;member=$file.path;bytes=$bytes;allocatedBytes=$allocated;ordinaryNonSparseNonCompressed=$true}
                } else {Hold-Large $path $file.identity|Out-Null}
            }
            if($action.action -ceq 'restore'){Check-ConversationNames (Join-Path $operation 'work/conversations')}
        }
        if($backup.outputFacts.Count -ne 5 -or $restore.outputFacts.Count -ne 54 -or $physicalOutputs.Count -ne 6){throw '输出数量不符'}
        $publication=Hold-Large (Join-Path $scope 'published.aibak') $backup.publication
        if($publication.fact.Size -gt 5368709120){throw '发布容器超过5GiB'}
        $result['physicalOutputs']=$physicalOutputs
        $ledger=Read-JsonHeld (Join-Path $profile 'lifecycle-guardian/writers.json')
        if($null -ne $ledger.main -or $null -ne $ledger.utility){throw 'Guardian writer未退休'}
    }
    Check-ConversationNames (Join-Path $profile 'conversations')
    Assert-Held
    Assert-Held
} catch {
    $phaseError=$_
} finally {
    if($null -ne $saved){try{Restore-Environment $saved}catch{$cleanupError=$_};$saved=$null}
    foreach($stream in $locks){try{$stream.Dispose()}catch{if($null -eq $cleanupError){$cleanupError=$_}}}
    $locks.Clear()
}
    try {Check-Time}catch{if($null -eq $phaseError){$phaseError=$_}}
    if($null -ne $cleanupError -and $null -eq $phaseError){$phaseError=$cleanupError}
    if($null -ne $phaseError){throw $phaseError}
    $result.completed=$true
    if($Mode -ceq 'transfer'){$result.electronQualified=$true}
    $result.durationMs=$clock.Elapsed.TotalMilliseconds
    $null=Write-Receipt (Join-Path $scope "$Mode-result.pending-wrapper-exit.json") $result
    Check-Time
    $result.durationMs=$clock.Elapsed.TotalMilliseconds
    return [pscustomobject]$result
}

$campaignResult=[ordered]@{version=1;scopeId=$ScopeId;mode='campaign';authorization='stdout-and-wrapper-exit-0';completed=$false;productE2Pass=$false;electronQualified=$false;import=$null;transfer=$null;error=$null}
try {
    Assert-Parents $scope
    if(Test-Path -LiteralPath (Join-Path $scope 'campaign-intent.json')){throw '本campaign已有尝试，禁止重用scope'}
    $claim=Write-Receipt (Join-Path $scope 'campaign-intent.json') @{version=1;scopeId=$ScopeId;mode='campaign';importWorkMs=120000;transferWorkMs=3060000;exitOnlyMs=30000;productE2Pass=$false}
    $intent=$claim
    $importClock=$clock
    $importResult=Invoke-Phase -Phase import -PhaseClock $importClock -PhaseWorkMs 120000
    Assert-Deadline $importClock 120000
    $inputProofSha256=Read-ClosedSmallHash (Join-Path $scope 'input-proof.json') $importClock 120000
    Assert-ImportAdmission $importResult $inputProofSha256 $importClock 120000
    $transferClock=[Diagnostics.Stopwatch]::StartNew()
    $transferResult=Invoke-Phase -Phase transfer -PhaseClock $transferClock -PhaseWorkMs 3060000 -ExpectedInputProofSha256 $inputProofSha256
    Assert-Deadline $transferClock 3060000
    if($transferResult.completed -ne $true -or $transferResult.authorization -cne 'pending-wrapper-exit' -or $transferResult.electronQualified -ne $true -or $transferResult.productE2Pass -ne $false -or $transferResult.job.Succeeded -ne $true -or $transferResult.job.ActualZero -ne $true -or $transferResult.job.OwnershipRetained -ne $false){throw '同调用栈transfer未成功闭合'}
    $campaignResult.import=$importResult
    $campaignResult.transfer=$transferResult
    $campaignResult.completed=$true
    $campaignResult.electronQualified=$true
    $clock=$transferClock;$workMs=3060000
    $pendingWrapperResult=[ordered]@{}
    foreach($item in $campaignResult.GetEnumerator()){$pendingWrapperResult[$item.Key]=$item.Value}
    $pendingWrapperResult.authorization='pending-wrapper-exit'
    $pendingWrapperResult['requiresWrapperExit']=$true
    $null=Write-Receipt (Join-Path $scope 'wrapper-result.pending-wrapper-exit.json') $pendingWrapperResult
    Check-Time
    $successStdout=$campaignResult|ConvertTo-Json -Depth 16
    Check-Time
    [Console]::Out.WriteLine($successStdout)
    Check-Time
    exit 0
} catch {
    $campaignResult.completed=$false
    $campaignResult.error='物理三库完整Transfer campaign资格失败，原件与未知所有权保留'
    $campaignResult|ConvertTo-Json -Depth 16
    exit 2
}
