[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('import-success','import-child','transfer-success','transfer-limit','timeout')][string]$Case)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$id=[Guid]::NewGuid().ToString('N')
$scope=Join-Path $repository "log/stage7-e2/full-transfer-native-$id"
for($path=[IO.Path]::GetDirectoryName($scope);;$path=[IO.Path]::GetDirectoryName($path)) {
    $item=Get-Item -LiteralPath $path
    if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '资格目录无效'}
    if([string]::IsNullOrEmpty([IO.Path]::GetDirectoryName($path))){break}
}
[IO.Directory]::CreateDirectory($scope)|Out-Null
function Write-New([string]$Path,[string]$Text) {
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes($Text)
    if($bytes.Length -gt 65536){throw '小回执超限'}
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Read-FixtureImage([string]$Path) {
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $reader=$null
    try {
        if($stream.Length -lt 64 -or $stream.Length -gt 1048576){throw '固定夹具PE大小无效'}
        $reader=[IO.BinaryReader]::new($stream)
        if($reader.ReadUInt16() -ne 0x5a4d){throw '固定夹具DOS签名无效'}
        $stream.Position=0x3c;$peOffset=$reader.ReadUInt32()
        if($peOffset -lt 64 -or $peOffset -gt ($stream.Length-24)){throw '固定夹具PE头越界'}
        $stream.Position=$peOffset
        if($reader.ReadUInt32() -ne 0x4550){throw '固定夹具PE签名无效'}
        $machine=$reader.ReadUInt16()
        if($machine -ne 0x8664){throw '固定夹具不是AMD64'}
        $stream.Position=$peOffset+20;$optionalBytes=$reader.ReadUInt16();$flags=$reader.ReadUInt16()
        if($optionalBytes -lt 112 -or ([long]$peOffset+24+$optionalBytes) -gt $stream.Length){throw '固定夹具可选头越界'}
        if(($flags -band 2) -eq 0 -or ($flags -band 0x2000) -ne 0){throw '固定夹具不是独立可执行文件'}
        $stream.Position=$peOffset+24;$magic=$reader.ReadUInt16()
        if($magic -ne 0x20b){throw '固定夹具不是PE32+'}
        $stream.Position=$peOffset+24+68;$subsystem=$reader.ReadUInt16()
        if($subsystem -ne 2){throw '固定夹具不是无控制台WinExe'}
        return [ordered]@{bytes=$stream.Length;machine=$machine;optionalHeaderMagic=$magic;subsystem=$subsystem}
    } finally {
        if($null -ne $reader){$reader.Dispose()}else{$stream.Dispose()}
    }
}
$source=@'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
public static class Fixture {
 public static int Main(string[] args) {
  var data=new byte[1048576];data[0]=1;
  string mode=args[args.Length-1];
  if(mode=="leaf"){Thread.Sleep(5000);GC.KeepAlive(data);return 0;}
  if(mode=="timeout"){Thread.Sleep(10000);return 3;}
  int created=0,denied=0;
  var children=new System.Collections.Generic.List<Process>();
  int total=mode=="import-child"?1:mode=="transfer-limit"?24:mode=="transfer-success"?1:0;
  for(int i=0;i<total;i++) {
   try {var child=Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,"leaf"){UseShellExecute=false,CreateNoWindow=true});children.Add(child);created++;}
   catch(System.ComponentModel.Win32Exception){denied++;}
  }
  foreach(var child in children){if(!child.WaitForExit(7000)||child.ExitCode!=0)return 4;child.Dispose();}
  string json="{\"created\":"+created+",\"denied\":"+denied+",\"bytesPerProcess\":1048576}";
  using(var file=new FileStream("case-result.json",FileMode.CreateNew,FileAccess.Write,FileShare.Read)){byte[] bytes=System.Text.Encoding.UTF8.GetBytes(json);file.Write(bytes,0,bytes.Length);file.Flush(true);}
  GC.KeepAlive(data);return 0;
 }
}
'@
$sourcePath=Join-Path $scope 'Fixture.cs';Write-New $sourcePath $source
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$executable=Join-Path $scope 'fixture.exe'
$compilerStart=[Diagnostics.ProcessStartInfo]::new($compiler)
$compilerStart.UseShellExecute=$false;$compilerStart.CreateNoWindow=$true
foreach($argument in @('/nologo','/target:winexe','/platform:x64','/optimize+',"/out:$executable",$sourcePath)){$compilerStart.ArgumentList.Add($argument)}
$compilerProcess=[Diagnostics.Process]::Start($compilerStart)
if(-not $compilerProcess.WaitForExit(10000)) {
    try{$compilerProcess.Kill($true)}catch{}
    if(-not $compilerProcess.WaitForExit(2000)){throw '小夹具编译进程退出未知，原件保留'}
    $compilerProcess.Dispose();throw '小夹具编译超时'
}
$compilerCode=$compilerProcess.ExitCode;$compilerProcess.Dispose()
if($compilerCode -ne 0){throw '小夹具编译失败'}
$fixtureImage=Read-FixtureImage $executable
$helper=Join-Path $PSScriptRoot 'FixedTransferJob.cs'
if('AIbrowse.FullTransfer.FixedTransferJob' -as [type]){throw '必须使用新的PowerShell进程'}
Add-Type -Path $helper
$mode=if($Case.StartsWith('import-')){'import'}else{'transfer'}
$workMs=if($Case -ceq 'timeout'){1500}else{12000}
Write-New (Join-Path $scope 'intent.json') (([ordered]@{case=$Case;mode=$mode;workMs=$workMs;terminationOnlyMs=30000;maxProcesses=24;maxAllocationPerProcess=1048576;maxDiskBytes=1048576;fixtureImage=$fixtureImage;helperSha256=(Get-FileHash -LiteralPath $helper).Hash;compilerSha256=(Get-FileHash -LiteralPath $compiler).Hash;exeSha256=(Get-FileHash -LiteralPath $executable).Hash;sourceSha256=(Get-FileHash -LiteralPath $sourcePath).Hash;toolSha256=(Get-FileHash -LiteralPath $PSCommandPath).Hash;productE2Pass=$false})|ConvertTo-Json)
$ok=$false;$job=$null
try {
    $job=[AIbrowse.FullTransfer.FixedTransferJob]::Execute($mode,$executable,'fixed',$Case,$scope,$id,$workMs)
    if(-not $job.ActualZero -or $job.OwnershipRetained -or -not $job.LimitsVerified -or $null -ne $job.ExitFailure){throw '原Job退出或收口资格不完整'}
    [AIbrowse.FullTransfer.FixedTransferJob]::ValidateLimits($mode,$job.LimitFlags,$job.ProcessLimit,$job.ProcessCommitLimit,$job.JobCommitLimit)
    if($Case -ceq 'timeout') {
        if($job.Succeeded -or $job.Failure -cne 'deadline' -or $job.ExitCode -ne 92){throw '超时未正确撤销'}
    } else {
        if(-not $job.Succeeded){throw '固定小资格失败'}
        $proof=Get-Content -LiteralPath (Join-Path $scope 'case-result.json') -Raw|ConvertFrom-Json
        $created=switch($Case){'import-success'{0}'import-child'{0}'transfer-success'{1}'transfer-limit'{23}}
        $denied=if($Case -in @('import-child','transfer-limit')){1}else{0}
        if($proof.created -ne $created -or $proof.denied -ne $denied -or $proof.bytesPerProcess -ne 1048576){throw '原生进程数门未成立'}
    }
    if((Get-ChildItem -LiteralPath $scope -File|Measure-Object -Property Length -Sum).Sum -gt 1048576){throw '小资格落盘超限'}
    $ok=$true
} finally {
    Write-New (Join-Path $scope 'result.json') (([ordered]@{ok=$ok;case=$Case;job=$job;productE2Pass=$false})|ConvertTo-Json -Depth 10)
    [pscustomobject]@{scopeId="full-transfer-native-$id";ok=$ok;job=$job}|ConvertTo-Json -Depth 10
}
if(-not $ok){exit 2}
