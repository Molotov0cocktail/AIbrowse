$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$root=Join-Path $repository ('log/legacy-followup-20261012/package-tests-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$nativeFixture=@'
using System;
using System.IO;
using AIbrowse.ReleaseProfile;
public static class PackageIsolationFixture {
  private static void Same(Identity first, Identity second) {
    if(first.FileId!=second.FileId || first.Sddl!=second.Sddl || first.VolumeSerial!=second.VolumeSerial) throw new Exception("合成目录身份或ACL改变");
  }
  public static void RoundTrip(string root,string fault) {
    Native.CreateNewDirectory(root);
    string active=Path.Combine(root,"aibrowse"), staged=Path.Combine(root,"synthetic"), original=Path.Combine(root,"original"), retired=Path.Combine(root,"retired");
    Native.CreateNewDirectory(active); Native.CreateNewDirectory(staged);
    File.WriteAllText(Path.Combine(active,"canary.txt"),"固定合成内容");
    Identity expected; using(var lease=new DirectoryLease(active,false))expected=lease.Identity;
    string fileId; using(var file=Native.Open(Path.Combine(active,"canary.txt"),0x20080,3,false))fileId=Native.Identity(file,false).FileId;
    try {
      using(var lease=new DirectoryLease(active,true))Native.Rename(lease,original);
      if(fault=="protect")throw new InvalidOperationException("合成故障");
      using(var lease=new DirectoryLease(staged,true))Native.Rename(lease,active);
      if(fault=="activate")throw new InvalidOperationException("合成故障");
    } catch(InvalidOperationException) { if(fault=="none")throw; }
    finally {
      if(Directory.Exists(original)) {
        if(Directory.Exists(active))using(var lease=new DirectoryLease(active,true))Native.Rename(lease,retired);
        using(var lease=new DirectoryLease(original,true))Native.Rename(lease,active);
      }
    }
    using(var lease=new DirectoryLease(active,false))Same(expected,lease.Identity);
    using(var file=Native.Open(Path.Combine(active,"canary.txt"),0x20080,3,false))if(Native.Identity(file,false).FileId!=fileId)throw new Exception("合成文件实体改变");
    if(File.ReadAllText(Path.Combine(active,"canary.txt"))!="固定合成内容")throw new Exception("合成原件改变");
  }
}
'@
$sources=@('tools/release-profile/ProfileIsolation.cs','tools/release-profile/JobProcess.cs','tools/data-qualification/product-restore-process/SuccessorObserver.cs','tools/legacy-followup/package-lease.cs')
# Compile as separate syntax trees so each controlled source keeps its own using directives.
$fixturePath=Join-Path $root 'fixture.cs'
[IO.File]::WriteAllText($fixturePath,$nativeFixture)
Add-Type -Path (@($sources|ForEach-Object {Join-Path $repository $_})+@($fixturePath))
$results=[Collections.Generic.List[object]]::new()
function Pass([string]$name,[scriptblock]$action){&$action;$results.Add(@{name=$name;passed=$true})}
function Reject([string]$name,[scriptblock]$action){$rejected=$false;try{&$action}catch{$rejected=$true};if(-not $rejected){throw "反例未拒绝：$name"};$results.Add(@{name=$name;passed=$true})}
try {
  Pass '两原进程退出且无writer才退休' {if(-not [PackageSmokeLease]::CanRetire($true,0,$true,0,$true,0)){throw '正控未退休'}}
  Pass 'main未退出不退休' {if([PackageSmokeLease]::CanRetire($false,$null,$true,0,$true,1)){throw '提前退休'}}
  Pass 'guardian未退出不退休' {if([PackageSmokeLease]::CanRetire($true,0,$false,$null,$true,1)){throw '提前退休'}}
  Pass '残余product成员不退休' {if([PackageSmokeLease]::CanRetire($true,0,$true,0,$true,1)){throw '提前退休'}}
  Pass '当前Job成员仍是活句柄可复用观察' {[PackageSmokeLease]::ValidateExistingMember($false)}
  Reject '已退休句柄不能遮住当前同PID新实体' {[PackageSmokeLease]::ValidateExistingMember($true)}
  Reject 'main非零退出拒绝' {[PackageSmokeLease]::CanRetire($true,91,$true,0,$true,0)}
  Reject 'guardian非零退出拒绝' {[PackageSmokeLease]::CanRetire($true,0,$true,2,$true,0)}
  Reject 'writer未退休拒绝' {[PackageSmokeLease]::CanRetire($true,0,$true,0,$false,0)}
  $rootHash='a'*64;$session='b'*32
  $ledger=@{version=1;root=$rootHash;session=$session;main=$null;utility=$null}|ConvertTo-Json -Compress
  Pass '闭合账本同根同session双null' {[PackageSmokeLease]::ValidateRetiredLedger($ledger,$rootHash,$session)}
  Reject '账本跨session拒绝' {[PackageSmokeLease]::ValidateRetiredLedger($ledger,$rootHash,('c'*32))}
  Reject '账本跨root拒绝' {[PackageSmokeLease]::ValidateRetiredLedger($ledger,('d'*64),$session)}
  Reject '账本重复字段拒绝' {[PackageSmokeLease]::ValidateRetiredLedger($ledger.Replace('{','{"main":null,'),$rootHash,$session)}
  Reject '账本未知字段拒绝' {[PackageSmokeLease]::ValidateRetiredLedger($ledger.Replace('{','{"unknown":null,'),$rootHash,$session)}
  $writer=@{version=1;root=$rootHash;session=$session;main=@{pid=123;created='134000000000000001';image='e'*64};utility=$null}|ConvertTo-Json -Compress
  Reject '账本main存活拒绝' {[PackageSmokeLease]::ValidateRetiredLedger($writer,$rootHash,$session)}
  foreach($fault in @('none','protect','activate')){Pass ("同父rename及恢复："+$fault) {[PackageIsolationFixture]::RoundTrip((Join-Path $root $fault),$fault)}}
  $report=@{passed=$true;tests=$results.Count;results=$results;sources=@($sources|ForEach-Object {@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $repository $_)).Hash.ToLowerInvariant()}});realProfileTouched=$false;productStarted=$false}
  $report|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $root 'result.json') -Encoding utf8NoBOM
  @{root=$root;passed=$true;tests=$results.Count}|ConvertTo-Json
} catch {
  @{passed=$false;error=$_.Exception.Message;results=$results}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $root 'failed.json') -Encoding utf8NoBOM
  throw
}
