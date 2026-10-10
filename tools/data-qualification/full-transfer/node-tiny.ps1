[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($PSBoundParameters.Count -ne 0){throw '固定Node资格不接受参数'}
if($PSVersionTable.PSVersion.Major -lt 7){throw '固定Node资格需要PowerShell 7'}
$clock=[Diagnostics.Stopwatch]::StartNew()
$workMs=12000
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$id=[Guid]::NewGuid().ToString('N')
$scopeId="full-transfer-node-tiny-$id"
$scope=Join-Path $repository "log/stage7-e2/$scopeId"
$locks=[Collections.Generic.List[IO.FileStream]]::new()
$saved=$null
$job=$null
$ok=$false
$binding=$null
$phase='scope'
$failurePhase=$null
$scopeCreated=$false
# Pin the installed development Node candidate without persisting its machine path.
$expectedNodeSha256='9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de'
function Check-Time {
    if($clock.Elapsed.TotalMilliseconds -ge $workMs){throw '固定Node原工作期限已过'}
}
function Check-Parents([string]$Path) {
    for($parent=[IO.Path]::GetDirectoryName($Path);;$parent=[IO.Path]::GetDirectoryName($parent)) {
        $item=Get-Item -LiteralPath $parent
        if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '固定Node父目录无效'}
        if([string]::IsNullOrEmpty([IO.Path]::GetDirectoryName($parent))){break}
    }
}
function Hash-Stream([IO.FileStream]$Stream) {
    $Stream.Position=0
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Stream)).ToLowerInvariant()
}
function Hold-File([string]$Path,[long]$Maximum) {
    Check-Time;Check-Parents $Path
    $item=Get-Item -LiteralPath $Path
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '固定Node文件无效'}
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $locks.Add($stream)
    if($stream.Length -le 0 -or $stream.Length -gt $Maximum){throw '固定Node文件大小无效'}
    return @{stream=$stream;sha256=(Hash-Stream $stream)}
}
function Write-New([string]$Name,[string]$Text) {
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes($Text)
    if($bytes.Length -gt 65536){throw '固定Node回执过大'}
    $stream=[IO.File]::Open((Join-Path $scope $Name),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Read-NodeImage([IO.FileStream]$Stream) {
    if($Stream.Length -lt 64 -or $Stream.Length -gt 134217728){throw '固定Node PE大小无效'}
    $Stream.Position=0
    $reader=[IO.BinaryReader]::new($Stream,[Text.Encoding]::UTF8,$true)
    try {
        if($reader.ReadUInt16() -ne 0x5a4d){throw '固定Node DOS签名无效'}
        $Stream.Position=0x3c;$offset=$reader.ReadUInt32()
        if($offset -lt 64 -or $offset -gt ($Stream.Length-24)){throw '固定Node PE头越界'}
        $Stream.Position=$offset
        if($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664){throw '固定Node不是AMD64 PE'}
        $Stream.Position=$offset+20;$optional=$reader.ReadUInt16();$flags=$reader.ReadUInt16()
        if($optional -lt 112 -or ([long]$offset+24+$optional) -gt $Stream.Length -or ($flags -band 2) -eq 0 -or ($flags -band 0x2000) -ne 0){throw '固定Node可执行头无效'}
        $Stream.Position=$offset+24
        if($reader.ReadUInt16() -ne 0x20b){throw '固定Node不是PE32+'}
        $Stream.Position=$offset+24+68
        if($reader.ReadUInt16() -ne 3){throw '固定Node不是console子系统'}
        return [ordered]@{machine=34404;optionalHeaderMagic=523;subsystem=3;bytes=$Stream.Length}
    } finally {$reader.Dispose()}
}
function Test-NodeJob($Job) {
    if(-not $Job.Succeeded -or -not $Job.ActualZero -or $Job.OwnershipRetained -or -not $Job.LimitsVerified -or
        $null -ne $Job.ExitFailure -or $null -ne $Job.Failure -or $Job.ExitCode -ne 0 -or $Job.Samples -lt 1 -or
        $Job.CreationFlags -ne 524296 -or $Job.ProcessLimit -ne 1 -or $Job.LimitFlags -ne 0x2308 -or $Job.ProcessCommitLimit -ne 2147483648 -or
        $Job.JobCommitLimit -ne 2147483648 -or $Job.RssPeakBytes -gt 1073741824 -or $Job.TreeRssPeakBytes -gt 1073741824){throw '固定Node实际Job门失败'}
}
function Test-TinyReceipt($Proof) {
    if((@($Proof.PSObject.Properties.Name|Sort-Object)-join '|') -cne 'dataSha256|nodeVersion|productE2Pass|stdioCompleted|version' -or
        ($Proof.version -isnot [int] -and $Proof.version -isnot [long]) -or $Proof.version -ne 1 -or
        $Proof.nodeVersion -isnot [string] -or $Proof.nodeVersion -cne 'v24.18.0' -or
        $Proof.productE2Pass -isnot [bool] -or $Proof.productE2Pass -ne $false -or $Proof.stdioCompleted -isnot [bool] -or $Proof.stdioCompleted -ne $true -or
        $Proof.dataSha256 -isnot [string] -or
        $Proof.dataSha256 -cne 'be45cb2605bf36bebde684841a28f0fd43c69850a3dce5fedba69928ee3a8991'){throw '固定Node完成回执无效'}
}
function Test-Bindings([object[]]$Facts) {
    foreach($fact in $Facts) {
        Check-Time
        $identity=[AIbrowse.FullTransfer.FixedTransferJob]::InspectFile($fact.stream)
        if($fact.ContainsKey('identity') -and (($identity|ConvertTo-Json -Compress) -cne ($fact.identity|ConvertTo-Json -Compress))){throw '固定Node绑定身份已改变'}
        if((Hash-Stream $fact.stream) -cne $fact.sha256){throw '固定Node绑定内容已改变'}
        Check-Time
    }
}
function Check-Scope {
    $allowed=@('node-tiny.ps1','FixedTransferJob.cs','helper.dll','tiny.cjs','intent.json','payload.bin','complete.json','result.json')
    $total=0L
    foreach($item in Get-ChildItem -LiteralPath $scope -Force) {
        if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Name -cnotin $allowed){throw '固定Node落盘成员不闭合'}
        $total+=$item.Length
    }
    # Reserve the full receipt allowance before writing result.json.
    if($total -gt (1048576-65536)){throw '固定Node落盘预算超限'}
}
function Enter-CleanEnvironment {
    $prior=@{}
    foreach($item in Get-ChildItem Env:){$prior[$item.Name]=$item.Value}
    foreach($name in @($prior.Keys)) {
        if($name -notin @('SystemRoot','WINDIR','SystemDrive','TEMP','TMP','COMSPEC','PATHEXT','PATH','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE')) {
            [Environment]::SetEnvironmentVariable($name,$null,'Process')
        }
    }
    return $prior
}
function Restore-Environment($Prior) {
    foreach($item in Get-ChildItem Env:){[Environment]::SetEnvironmentVariable($item.Name,$null,'Process')}
    foreach($name in $Prior.Keys){[Environment]::SetEnvironmentVariable($name,$Prior[$name],'Process')}
}
$source=@'
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
let failed = false;
const fail = () => { failed = true; process.exitCode = 2; };
try {
  if (process.version !== 'v24.18.0' || process.argv.length !== 3 ||
      !/^full-transfer-node-tiny-[a-f0-9]{32}$/.test(process.argv[2]) ||
      path.basename(__dirname) !== process.argv[2] || process.cwd() !== __dirname) throw new Error();
  const payload = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  fs.writeFileSync(path.join(__dirname, 'payload.bin'), payload, { flag: 'wx', flush: true });
  const dataSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'payload.bin'))).digest('hex');
  if (dataSha256 !== 'be45cb2605bf36bebde684841a28f0fd43c69850a3dce5fedba69928ee3a8991') throw new Error();
  process.stdout.on('error', fail);
  process.stderr.on('error', fail);
  process.stdout.write('{"imported":true,"productE2Pass":false}\n', (error) => {
    if (error) { fail(); return; }
    process.stderr.write('完整Transfer输入导入失败，现场保留\n', (error) => {
      if (error) { fail(); return; }
      setTimeout(() => {
        if (failed) return;
        try {
          fs.writeFileSync(path.join(__dirname, 'complete.json'), JSON.stringify({ version: 1,
            nodeVersion: process.version, dataSha256, stdioCompleted: true, productE2Pass: false }), { flag: 'wx', flush: true });
        } catch { fail(); }
      }, 1000);
    });
  });
} catch { fail(); }
'@
try {
    Check-Parents $scope
    if(Test-Path -LiteralPath $scope){throw '固定Node资格scope已存在'}
    [IO.Directory]::CreateDirectory($scope)|Out-Null
    $scopeCreated=$true
    $phase='binding'
    $tool=Hold-File $PSCommandPath 65536
    $helper=Hold-File (Join-Path $PSScriptRoot 'FixedTransferJob.cs') 65536
    $phase='runtime'
    $node=(Get-Command node.exe -CommandType Application|Select-Object -First 1).Source
    $runtime=Hold-File $node 134217728
    if($runtime.sha256 -cne $expectedNodeSha256 -or (Get-Item -LiteralPath $node).VersionInfo.ProductVersion -cne '24.18.0'){throw '固定Node运行时绑定不符'}
    $image=Read-NodeImage $runtime.stream
    $helper.stream.Position=0;$reader=[IO.StreamReader]::new($helper.stream,[Text.Encoding]::UTF8,$false,4096,$true)
    try{$helperSource=$reader.ReadToEnd()}finally{$reader.Dispose()}
    $tool.stream.Position=0;$reader=[IO.StreamReader]::new($tool.stream,[Text.Encoding]::UTF8,$false,4096,$true)
    try{$toolSource=$reader.ReadToEnd()}finally{$reader.Dispose()}
    Write-New 'node-tiny.ps1' $toolSource
    Write-New 'FixedTransferJob.cs' $helperSource
    Write-New 'tiny.cjs' $source
    if('AIbrowse.FullTransfer.FixedTransferJob' -as [type]){throw '固定Node资格需要新PowerShell进程'}
    $assemblyPath=Join-Path $scope 'helper.dll'
    $phase='compile'
    Check-Time
    Add-Type -TypeDefinition $helperSource -OutputAssembly $assemblyPath
    [void][Reflection.Assembly]::LoadFrom($assemblyPath)
    $phase='binding'
    $assembly=Hold-File $assemblyPath 1048576
    $compiler=Hold-File ([Microsoft.CodeAnalysis.CSharp.CSharpCompilation].Assembly.Location) 33554432
    $entry=Join-Path $scope 'tiny.cjs';$script=Hold-File $entry 65536
    $facts=@($tool,$helper,$runtime,$assembly,$compiler,$script)
    foreach($fact in $facts){$fact.identity=[AIbrowse.FullTransfer.FixedTransferJob]::InspectFile($fact.stream)}
    $binding=[ordered]@{toolSha256=$tool.sha256;helperSha256=$helper.sha256;assemblySha256=$assembly.sha256;compilerSha256=$compiler.sha256;scriptSha256=$script.sha256;nodeSha256=$runtime.sha256;nodeVersion='v24.18.0';nodeImage=$image;creationFlags=524296;mode='import';activeLimit=1;workMs=$workMs;terminationOnlyMs=30000;maxDiskBytes=1048576}
    Write-New 'intent.json' (([ordered]@{scopeId=$scopeId;binding=$binding;productE2Pass=$false})|ConvertTo-Json -Depth 6)
    Check-Scope;Check-Time
    $saved=Enter-CleanEnvironment
    $remaining=[int][Math]::Floor($workMs-$clock.Elapsed.TotalMilliseconds)
    if($remaining -le 0){throw '固定Node原工作期限已过'}
    $phase='execute'
    $job=[AIbrowse.FullTransfer.FixedTransferJob]::Execute('import',$node,$entry,$scopeId,$scope,$id,$remaining)
    Check-Time;Test-NodeJob $job
    $phase='receipt'
    $receipt=Hold-File (Join-Path $scope 'complete.json') 4096
    $receipt.stream.Position=0;$reader=[IO.StreamReader]::new($receipt.stream,[Text.Encoding]::UTF8,$false,4096,$true)
    try{$proof=$reader.ReadToEnd()|ConvertFrom-Json}finally{$reader.Dispose()}
    Test-TinyReceipt $proof
    $payload=Hold-File (Join-Path $scope 'payload.bin') 16
    if($payload.stream.Length -ne 16 -or $payload.sha256 -cne $proof.dataSha256){throw '固定Node小文件往返不符'}
    $phase='final-bindings'
    Test-Bindings (@($facts)+@($receipt,$payload))
    $phase='finish'
    Check-Scope;Check-Time;$ok=$true
} catch {
    $ok=$false;$failurePhase=$phase
} finally {
    try{if($null -ne $saved){Restore-Environment $saved}}catch{$ok=$false;if($null -eq $failurePhase){$failurePhase='finish'}}
    foreach($stream in $locks){try{$stream.Dispose()}catch{$ok=$false;if($null -eq $failurePhase){$failurePhase='finish'}}}
    if($clock.Elapsed.TotalMilliseconds -ge $workMs){$ok=$false;if($null -eq $failurePhase){$failurePhase='finish'}}
    $result=[ordered]@{scopeId=$scopeId;ok=$ok;phase=if($null -eq $failurePhase){$phase}else{$failurePhase};job=$job;binding=$binding;durationMs=$clock.Elapsed.TotalMilliseconds;failure=if($ok){$null}else{'固定Node资格失败，原件与未知所有权保留'};requiresWrapperExit=$true;productE2Pass=$false}
    try{if($scopeCreated){Write-New 'result.json' ($result|ConvertTo-Json -Depth 12)}}catch{$ok=$false;$result.ok=$false;if($null -eq $failurePhase){$result.phase='finish'};$result.failure='固定Node资格失败，原件与未知所有权保留'}
    # The persisted snapshot precedes its own flush; only the final output plus exit proves completion.
    if($clock.Elapsed.TotalMilliseconds -ge $workMs){$ok=$false;$result.ok=$false;if($null -eq $failurePhase){$result.phase='finish'};$result.failure='固定Node资格失败，原件与未知所有权保留'}
    $result.durationMs=$clock.Elapsed.TotalMilliseconds
    $result|ConvertTo-Json -Depth 12
}
if($clock.Elapsed.TotalMilliseconds -ge $workMs){$ok=$false}
if(-not $ok){exit 2}
