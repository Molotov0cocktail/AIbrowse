[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidatePattern('^full-transfer-[a-f0-9]{32}$')][string]$ScopeId,
 [Parameter(Mandatory)][ValidateSet('import','transfer')][string]$Mode
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($PSVersionTable.PSEdition -ne 'Core' -or -not [Environment]::Is64BitProcess){throw '需要现有64位PowerShell7'}
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$scope=Join-Path $repository "log\stage7-e2\$ScopeId"
$workMs=if($Mode -ceq 'import'){120000}else{3060000}
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
function Check-ConversationNames([string]$Root) {
    $expected=@('index.json')
    for($i=0;$i -lt 50;$i++) {$expected+=('00000000-0000-4000-8000-{0:x12}.json' -f $i)}
    if((@((Get-ChildItem -LiteralPath $Root -Force).Name|Sort-Object)-join '|') -cne (@($expected|Sort-Object)-join '|')){throw '会话目录不闭合'}
    Assert-Parents $Root
}
function Check-InputMembers($Proof) {
    $expected=@('sources/sources.db','research/research.db','watch/watch.db','conversations/index.json')
    for($i=0;$i -lt 50;$i++){$expected+=('conversations/00000000-0000-4000-8000-{0:x12}.json' -f $i)}
    if($Proof.files.Count -ne 54 -or (@($Proof.files.member|Sort-Object)-join '|') -cne (@($expected|Sort-Object)-join '|')){throw '输入成员集合无效'}
}

$result=[ordered]@{version=1;scopeId=$ScopeId;mode=$Mode;completed=$false;productE2Pass=$false;job=$null;durationMs=0;error=$null}
$saved=$null
try {
    Assert-Parents $scope
    $helperPath=Join-Path $scope 'FixedTransferJob.cs'
    $helperReceipt=Read-BoundFile $helperPath 65536 $true
    $currentHelper=Read-BoundFile (Join-Path $PSScriptRoot 'FixedTransferJob.cs') 65536 $true
    if($helperReceipt.hash -cne $currentHelper.hash){throw '原生工具源码改变'}
    if('AIbrowse.FullTransfer.FixedTransferJob' -as [type]){throw '必须在新的PowerShell进程运行，禁止复用旧原生类型'}
    $intent=Write-Receipt (Join-Path $scope "$Mode-intent.json") @{version=1;scopeId=$ScopeId;mode=$Mode;workMs=$workMs;exitOnlyMs=30000;productE2Pass=$false} -Hold
    $assemblyPath=Join-Path $scope "$Mode-Job.dll"
    if(Test-Path -LiteralPath $assemblyPath){throw '原生制品已存在'}
    Add-Type -TypeDefinition ([Text.UTF8Encoding]::new($false,$true).GetString($helperReceipt.bytes)) -OutputAssembly $assemblyPath
    [void][Reflection.Assembly]::LoadFrom($assemblyPath)
    $nativeLoaded=$true;Assert-Parents $scope
    Check-Time
    $heldFacts.Add((Capture-HeldFact $helperReceipt.stream $helperReceipt.hash))
    $heldFacts.Add((Capture-HeldFact $currentHelper.stream $currentHelper.hash))
    $heldFacts.Add((Capture-HeldFact $intent.stream $intent.hash))
    $nativeAssembly=Read-BoundFile $assemblyPath 1048576 $true $false
    $heldFacts.Add((Capture-HeldFact $nativeAssembly.stream))
    $compilerAssembly=[Microsoft.CodeAnalysis.CSharp.CSharpCompilation].Assembly.Location
    $compilerBinding=Read-BoundFile $compilerAssembly 33554432 $true $false
    $heldFacts.Add((Capture-HeldFact $compilerBinding.stream))
    $result['nativeBuild']=@{sourceSha256=$helperReceipt.hash;assemblySha256=$nativeAssembly.hash;compilerSha256=$compilerBinding.hash;powerShellVersion=$PSVersionTable.PSVersion.ToString()}
    $disk=[AIbrowse.FullTransfer.FixedTransferJob]::InspectDisk($scope)
    $volume=Write-Receipt (Join-Path $scope "$Mode-volume.json") @{unit=[string]$disk.AllocationUnit;available=[string]$disk.AvailableBytes} -Hold
    $heldFacts.Add((Capture-HeldFact $volume.stream $volume.hash))
    $build=Read-JsonHeld (Join-Path $scope 'build-proof.json')
    if($build.version -ne 1 -or $build.scopeId -cne $ScopeId -or $build.productE2Pass -ne $false -or $build.conversationId -cne 'full-conversations-29d6709186ef4d179628e94ec8c73663' -or $build.runtimeId -cne 'runtime-9399eea0c11d4e6f9cde46ae2369376b'){throw '来源ID或构建证明无效'}
    foreach($item in $build.sources.PSObject.Properties) {
        if($item.Name -cnotmatch '^(src/|tools/data-qualification/full-transfer/|native/lifecycle-guardian/|node_modules/|package(?:-lock)?\.json$)' -or $item.Name -match '(^|/)\.\.(/|$)' -or $item.Name.Contains('\')){throw '源码路径不闭合'}
        $null=Bind-File (Join-Path $repository $item.Name) 8388608 $item.Value
    }
    $requiredArtifacts=@('app/lifecycle-guardian-integrity.json','app/main.cjs','app/out/lifecycle-guardian/guardian.exe','app/package.json','app/transfer-worker.js','app/counts-worker.js','import.cjs')
    if((@($build.artifacts.PSObject.Properties.Name|Sort-Object)-join '|') -cne (@($requiredArtifacts|Sort-Object)-join '|')){throw '制品集合无效'}
    foreach($item in $build.artifacts.PSObject.Properties){$null=Bind-File (Join-Path $scope $item.Name) 8388608 $item.Value.sha256}
    $node=(Get-Command node.exe -CommandType Application|Select-Object -First 1).Source
    $electron=Join-Path $repository 'node_modules/electron/dist/electron.exe'
    if($build.node.path -cne $node -or $build.electron.path -cne $electron -or $build.node.version -cne ('v'+(Get-Item -LiteralPath $node).VersionInfo.ProductVersion)){throw '实际运行时身份无效'}
    $null=Bind-File $node 134217728 $build.node.sha256
    $null=Bind-File $electron 268435456 $build.electron.sha256
    $full=Join-Path $repository "log/stage7-e2/$($build.conversationId)"
    $runtime=Join-Path $repository "log/stage7-e2/$($build.runtimeId)"
    $profile=Join-Path $scope 'profile'
    if($Mode -ceq 'import') {
        if(Test-Path -LiteralPath $profile){throw '导入目录已存在，禁止重跑'}
        $proof=Read-JsonHeld (Join-Path $full 'fixture-proof.json')
        $null=Read-JsonHeld (Join-Path $runtime 'fixture-proof.json')
        Check-ConversationNames (Join-Path $full 'conversations')
        foreach($item in $proof.files.PSObject.Properties){
            if($item.Name -cnotmatch '^(index|00000000-0000-4000-8000-[a-f0-9]{12})\.json$'){throw '来源成员路径无效'}
            Hold-Large (Join-Path $full "conversations/$($item.Name)") $item.Value.identity
        }
        foreach($member in @('sources/sources.db','research/research.db','watch/watch.db')){Hold-Large (Join-Path $runtime "fixtures/$member") $null}
        $executable=$node;$entry=Join-Path $scope 'import.cjs'
    } else {
        $importResult=Read-JsonHeld (Join-Path $scope 'import-result.json')
        if($importResult.completed -ne $true -or $importResult.job.Succeeded -ne $true -or $importResult.job.ActualZero -ne $true -or $importResult.job.OwnershipRetained -ne $false){throw '原始导入没有成功退出'}
        $proof=Read-JsonHeld (Join-Path $scope 'input-proof.json')
        if($proof.completed -ne $true -or $proof.scopeId -cne $ScopeId -or $proof.files.Count -ne 54){throw '输入证明无效'}
        if($importResult.inputProofSha256 -cne (Hash-HeldPath (Join-Path $scope 'input-proof.json'))){throw '导入完成时的原输入证明已改变'}
        Check-InputMembers $proof
        foreach($file in $proof.files){
            if($file.member -cnotmatch '^(sources/sources\.db|research/research\.db|watch/watch\.db|conversations/(index|00000000-0000-4000-8000-[a-f0-9]{12})\.json)$'){throw '成员路径无效'}
            Hold-Large (Join-Path $profile $file.member) $file.identity
        }
        Check-ConversationNames (Join-Path $profile 'conversations')
        $executable=$electron;$entry=Join-Path $scope 'app'
    }
    Assert-HeldHashes $heldFacts;Assert-HeldFacts $heldFacts;Check-Time
    $saved=Enter-CleanEnvironment
    $remaining=[int][Math]::Floor($workMs-$clock.Elapsed.TotalMilliseconds)
    if($remaining -le 0){throw '原工作期限已过'}
    $result.job=[AIbrowse.FullTransfer.FixedTransferJob]::Execute($Mode,$executable,$entry,$ScopeId,$scope,([Guid]::NewGuid().ToString('N')),$remaining)
    Check-Time
    if(-not $result.job.Succeeded -or -not $result.job.ActualZero -or $result.job.OwnershipRetained -or $result.job.ExitCode -ne 0){throw '原始Job执行或实际退出未通过'}
    [AIbrowse.FullTransfer.FixedTransferJob]::ValidateLimits($Mode,$result.job.LimitFlags,$result.job.ProcessLimit,$result.job.ProcessCommitLimit,$result.job.JobCommitLimit)
    if($Mode -ceq 'import') {
        $proof=Read-JsonHeld (Join-Path $scope 'input-proof.json')
        if($proof.completed -ne $true -or $proof.files.Count -ne 54 -or $proof.scopeId -cne $ScopeId){throw '导入未闭合'}
        Check-InputMembers $proof
        $result['inputProofSha256']=Hash-HeldPath (Join-Path $scope 'input-proof.json')
        foreach($file in $proof.files){Hold-Large (Join-Path $profile $file.member) $file.identity}
        Check-ConversationNames (Join-Path $full 'conversations')
    } else {
        $campaign=Read-JsonHeld (Join-Path $scope 'campaign-result.json')
        $null=Bind-File (Join-Path $scope 'observations.jsonl') 65536 $campaign.observations.sha256 $true
        $backup=Read-JsonHeld (Join-Path $scope 'backup-result.json');$restore=Read-JsonHeld (Join-Path $scope 'restore-result.json')
        if($campaign.completed -ne $true -or $campaign.scopeId -cne $ScopeId -or $campaign.actions.Count -ne 2 -or $backup.action -cne 'backup' -or $restore.action -cne 'restore' -or -not $backup.childrenExited -or -not $restore.childrenExited -or $backup.operationId -ceq $restore.operationId -or $backup.snapshotId -cne $restore.snapshotId){throw '双操作证明不闭合'}
        if($restore.proof.expected.conversations.bytes -ne 3355458876 -or $restore.proof.expected.conversations.sha256 -cne 'cced3aa17d685cc1b119f060e3caf9928f49640195599debf9ab51f007546989'){throw '恢复50会话事实不符'}
        foreach($action in @($backup,$restore)) {
            $counts=$action.counts
            if((@($counts.PSObject.Properties.Name|Sort-Object)-join '|') -cne 'digests|events|evidence|research|rules|sources' -or $counts.sources -ne 5000 -or $counts.research -ne 30 -or $counts.rules -ne 200 -or $counts.events -ne 2800 -or $counts.evidence -ne 8400 -or $counts.digests -ne 1030){throw '实际work计数不符'}
            if($action.operationId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'){throw '操作身份无效'}
            $operation=Join-Path $profile ('data-transfer/'+$action.operationId.Replace('-',''))
            $expectedOutputs=@('work/sources.db','work/research.db','work/watch.db')
            if($action.action -ceq 'backup'){$expectedOutputs+=@('work/conversations.bin','output.aibak')}
            else {
                $expectedOutputs+='work/conversations/index.json'
                for($i=0;$i -lt 50;$i++){$expectedOutputs+=('work/conversations/00000000-0000-4000-8000-{0:x12}.json' -f $i)}
            }
            if((@($action.outputFacts.path|Sort-Object)-join '|') -cne (@($expectedOutputs|Sort-Object)-join '|')){throw '输出证明成员不闭合'}
            foreach($file in $action.outputFacts) {
                if($file.path -cnotmatch '^(work/(sources\.db|research\.db|watch\.db|conversations\.bin)|output\.aibak|work/conversations/(index|00000000-0000-4000-8000-[a-f0-9]{12})\.json)$'){throw '输出路径无效'}
                Hold-Large (Join-Path $operation $file.path) $file.identity
            }
            if($action.action -ceq 'restore'){Check-ConversationNames (Join-Path $operation 'work/conversations')}
        }
        if($backup.outputFacts.Count -ne 5 -or $restore.outputFacts.Count -ne 54){throw '输出数量不符'}
        Hold-Large (Join-Path $scope 'published.aibak') $backup.publication
        $ledger=Read-JsonHeld (Join-Path $profile 'lifecycle-guardian/writers.json')
        if($null -ne $ledger.main -or $null -ne $ledger.utility){throw 'Guardian writer未退休'}
    }
    Check-ConversationNames (Join-Path $profile 'conversations')
    Assert-HeldHashes $heldFacts;Assert-HeldFacts $heldFacts;Check-Time
    $result.completed=$true;$result.durationMs=$clock.Elapsed.TotalMilliseconds
    $receipt=Write-Receipt (Join-Path $scope "$Mode-result.json") $result -Hold
    $heldFacts.Add((Capture-HeldFact $receipt.stream $receipt.hash))
    Check-ConversationNames (Join-Path $profile 'conversations')
    Assert-HeldHashes $heldFacts;Assert-HeldFacts $heldFacts;Check-Time
} catch {
    $result.completed=$false;$result.error='容量资格失败，原件与未知所有权保留'
} finally {
    if($null -ne $saved){Restore-Environment $saved}
    foreach($stream in $locks){try{$stream.Dispose()}catch{$result.completed=$false}}
    if($clock.Elapsed.TotalMilliseconds -ge $workMs){$result.completed=$false;$result.error='原工作期限已过'}
    $result.durationMs=$clock.Elapsed.TotalMilliseconds
}
$result|ConvertTo-Json -Depth 12
if(-not $result.completed){exit 2}

