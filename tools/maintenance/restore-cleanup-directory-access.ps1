param([switch]$CheckOnly, [string]$OriginalProfileParent)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$nativeSource = @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class CleanupDirectoryAccessRepair {
    [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] struct Privileges { public uint Count; public Luid Luid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct AttributeTag { public uint Attributes; public uint Tag; }
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disable, ref Privileges state, uint length, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, out AttributeTag info, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint length, uint flags);
    public static void Enable(string name) {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) throw new Win32Exception();
        try {
            Luid luid;
            if (!LookupPrivilegeValue(null, name, out luid)) throw new Win32Exception();
            var state = new Privileges { Count=1, Luid=luid, Attributes=2 };
            if (!AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
            int error=Marshal.GetLastWin32Error(); if(error!=0) throw new Win32Exception(error);
        } finally { CloseHandle(token); }
    }
    public static SafeFileHandle Pin(string path) {
        var handle=CreateFileW(path,0x00060080,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
        if(handle.IsInvalid) { int error=Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
        try {
            AttributeTag info;
            if(!GetFileInformationByHandleEx(handle,9,out info,8)) throw new Win32Exception();
            if((info.Attributes & 0x400)!=0 || (info.Attributes & 0x10)==0) throw new InvalidOperationException("Only ordinary directories are allowed");
            var resolved=new StringBuilder(32768);
            uint length=GetFinalPathNameByHandleW(handle,resolved,32768,0);
            if(length==0 || length>=32768 || !resolved.ToString().Equals(@"\\?\"+path,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Resolved directory mismatch");
            return handle;
        } catch { handle.Dispose(); throw; }
    }
    public static bool CopyReceipt(string source, string destination) {
        using(var handle=CreateFileW(source,0x80000000,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
            if(handle.IsInvalid) { int error=Marshal.GetLastWin32Error(); if(error==2 || error==3) return false; throw new Win32Exception(error); }
            AttributeTag info;
            if(!GetFileInformationByHandleEx(handle,9,out info,8)) throw new Win32Exception();
            if((info.Attributes & 0x410)!=0) throw new InvalidOperationException("Receipt must be an ordinary file");
            var resolved=new StringBuilder(32768);
            uint length=GetFinalPathNameByHandleW(handle,resolved,32768,0);
            if(length==0 || length>=32768 || !resolved.ToString().Equals(@"\\?\"+source,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Resolved receipt mismatch");
            using(var input=new FileStream(handle,FileAccess.Read)) {
                if(input.Length>8388608) throw new InvalidOperationException("Receipt exceeds bound");
                using(var output=new FileStream(destination,FileMode.CreateNew,FileAccess.Write,FileShare.Read)) input.CopyTo(output);
            }
            return true;
        }
    }
}
'@
Add-Type -TypeDefinition $nativeSource
if ($CheckOnly) { Write-Output '权限恢复脚本语法与原生接口编译通过；未修改权限。'; return }

$repository = 'D:\AIbrowse'
$logRoot = Join-Path $repository 'log'
$first = Join-Path $logRoot 'stage7-e6\clean-builds-001\first-release'
$profiles = Join-Path $logRoot 'local-archive\profiles'
$receipt = Join-Path $repository '.local-dev\cleanup-directory-access-repair-002.json'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$userSid = $identity.User.Value
$requiredSids = @('S-1-5-18','S-1-5-32-544',$userSid)
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '需要管理员进程。' }
if (Test-Path -LiteralPath $receipt) { throw '恢复回执已存在，禁止覆盖。' }
function Assert-OrdinaryAncestors([string]$Path) {
    $candidate=$Path
    while ($candidate) {
        $item=Get-Item -LiteralPath $candidate -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw ('目录或祖先不是普通目录：'+$candidate) }
        $candidate=[IO.Path]::GetDirectoryName($candidate.TrimEnd('\'))
    }
}
Assert-OrdinaryAncestors ([IO.Path]::GetDirectoryName($receipt))
Assert-OrdinaryAncestors $logRoot
function Get-Rules($Acl) { return @($Acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) }
function Get-RightsFingerprint($Acl) {
    return (@(Get-Rules $Acl | ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.IdentityReference.Value,$_.AccessControlType,[int]$_.FileSystemRights,[int]$_.InheritanceFlags,[int]$_.PropagationFlags } | Sort-Object) -join ';')
}
function Is-TemporaryDacl($Acl) {
    if (-not $Acl.AreAccessRulesProtected) { return $false }
    $rules=@(Get-Rules $Acl)
    if ($rules.Count -ne 3) { return $false }
    foreach ($sid in $requiredSids) {
        $matches=@($rules | Where-Object { $_.IdentityReference.Value -ceq $sid -and $_.AccessControlType -eq 'Allow' -and [int]$_.FileSystemRights -eq 2032127 -and -not $_.IsInherited -and [int]$_.InheritanceFlags -eq 0 -and [int]$_.PropagationFlags -eq 0 })
        if ($matches.Count -ne 1) { return $false }
    }
    return $true
}
function Assert-ProfileAccess($Acl,[string]$Path) {
    $rules=@(Get-Rules $Acl)
    if ($rules.Count -eq 0 -or @($rules | Where-Object AccessControlType -eq 'Deny').Count) { throw ('档案目录权限为空或含拒绝项，不能冻结：'+$Path) }
    foreach ($sid in $requiredSids) {
        $allow=@($rules | Where-Object { $_.IdentityReference.Value -ceq $sid -and $_.AccessControlType -eq 'Allow' -and ([int]$_.FileSystemRights -band 131241) -eq 131241 -and ([int]$_.PropagationFlags -band 2) -eq 0 })
        if (-not $allow.Count) { throw ('档案目录缺少当前用户/SYSTEM/Administrators可读权限：'+$Path) }
    }
}
$result=[ordered]@{startedUtc=[DateTime]::UtcNow.ToString('o');status='running';restoredDirectories=[Collections.Generic.List[string]]::new();profileBarrierAdded=$false;profileRootsChecked=0;profileRightsUnchanged=$false;profileRestoredFromOriginalParent=$false;directFilesAclWritten=0;descendantInheritanceRecomputed=$false;credentialContentsRead=$false;errors=[Collections.Generic.List[object]]::new()}
$timer=[Diagnostics.Stopwatch]::StartNew()
$pins=[Collections.Generic.List[object]]::new()
$exitCode=1
try {
    [CleanupDirectoryAccessRepair]::Enable('SeBackupPrivilege')
    [CleanupDirectoryAccessRepair]::Enable('SeRestorePrivilege')
    foreach ($name in @('cleanup-result.json','cleanup-progress.json')) {
        $source=Join-Path $logRoot ('maintenance\cleanup-consolidation-20261012-001\'+$name)
        $preview=Join-Path $repository ('.local-dev\preview-'+$name)
        if (-not (Test-Path -LiteralPath $preview)) {
            try { $result['preview-'+$name]=[CleanupDirectoryAccessRepair]::CopyReceipt($source,$preview) }
            catch { $result.errors.Add([pscustomobject]@{path=$source;message=('复制操作回执失败：'+$_.Exception.Message)}) }
        }
    }
    $profileFingerprint=$null
    if (Test-Path -LiteralPath $profiles) {
        Assert-OrdinaryAncestors $profiles
        $profilePin=[CleanupDirectoryAccessRepair]::Pin($profiles)
        $pins.Add($profilePin)
        $profileAcl=Get-Acl -LiteralPath $profiles
        $result['profileRootAclBefore']=[pscustomobject]@{protected=$profileAcl.AreAccessRulesProtected;sddl=$profileAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);rules=@(Get-Rules $profileAcl).Count}
        try { Assert-ProfileAccess $profileAcl $profiles }
        catch {
            if (-not $OriginalProfileParent) { throw '损坏档案根需要通过 -OriginalProfileParent 提供未触碰的原 Roaming 父目录。' }
            $reference=[IO.Path]::GetFullPath($OriginalProfileParent).TrimEnd('\')
            if ($reference -cne $OriginalProfileParent -or [IO.Path]::GetFileName($reference) -cne 'Roaming' -or $reference.StartsWith($repository+'\',[StringComparison]::OrdinalIgnoreCase)) { throw '原档案权限来源必须为项目外的规范 Roaming 目录。' }
            Assert-OrdinaryAncestors $reference
            $referenceAcl=Get-Acl -LiteralPath $reference
            Assert-ProfileAccess $referenceAcl $reference
            $referenceSddl=$referenceAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
            $profileAcl=[Security.AccessControl.DirectorySecurity]::new()
            $profileAcl.SetSecurityDescriptorSddlForm($referenceSddl,[Security.AccessControl.AccessControlSections]::Access)
            $profileAcl.SetAccessRuleProtection($true,$true)
            $result['originalProfileParent']=[pscustomobject]@{path=$reference;sddl=$referenceSddl}
            Set-Acl -LiteralPath $profiles -AclObject $profileAcl
            $result.profileRestoredFromOriginalParent=$true
            $result.profileBarrierAdded=$true
            $result.descendantInheritanceRecomputed=$true
            $profileAcl=Get-Acl -LiteralPath $profiles
            Assert-ProfileAccess $profileAcl $profiles
        }
        $profileFingerprint=Get-RightsFingerprint $profileAcl
        $result.profileRootsChecked++
        foreach ($profile in @(Get-ChildItem -LiteralPath $profiles -Directory -Force)) {
            if ($profile.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '档案根包含目录链接，停止。' }
            Assert-ProfileAccess (Get-Acl -LiteralPath $profile.FullName) $profile.FullName
            $result.profileRootsChecked++
        }
        if (-not $profileAcl.AreAccessRulesProtected) {
            $profileAcl.SetAccessRuleProtection($true,$true)
            Set-Acl -LiteralPath $profiles -AclObject $profileAcl
            $result.profileBarrierAdded=$true
        }
        if ((Get-RightsFingerprint (Get-Acl -LiteralPath $profiles)) -cne $profileFingerprint) { throw '档案隔离屏障改变了有效ACE，停止。' }
    }
    $pending=[Collections.Generic.Stack[string]]::new()
    $pending.Push($logRoot)
    $visited=0
    while ($pending.Count) {
        $path=$pending.Pop()
        if (-not ($path -ceq $logRoot -or $path.StartsWith($logRoot+'\',[StringComparison]::OrdinalIgnoreCase))) { throw '恢复目录越界。' }
        if ($path -ceq $first -or $path -ceq $profiles) { continue }
        $visited++
        if ($visited -gt 100000 -or $timer.Elapsed.TotalMinutes -gt 10) { throw '达到恢复预算。' }
        try {
            $item=Get-Item -LiteralPath $path -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
            $pin=[CleanupDirectoryAccessRepair]::Pin($path)
            try {
                $acl=Get-Acl -LiteralPath $path
                if (Is-TemporaryDacl $acl) {
                    $acl.SetAccessRuleProtection($false,$true)
                    Set-Acl -LiteralPath $path -AclObject $acl
                    $result.descendantInheritanceRecomputed=$true
                    if ((Get-Acl -LiteralPath $path).AreAccessRulesProtected) { throw '目录继承未恢复。' }
                    $result.restoredDirectories.Add($path)
                }
                foreach ($child in @(Get-ChildItem -LiteralPath $path -Directory -Force)) { $pending.Push($child.FullName) }
            } finally { $pin.Dispose() }
        } catch { $result.errors.Add([pscustomobject]@{path=$path;message=$_.Exception.Message}) }
    }
    if ($null -ne $profileFingerprint) {
        $after=Get-Acl -LiteralPath $profiles
        $result.profileRightsUnchanged=$after.AreAccessRulesProtected -and (Get-RightsFingerprint $after) -ceq $profileFingerprint
        if (-not $result.profileRightsUnchanged) { throw '档案目录权限发生非预期变化。' }
    } else { $result.profileRightsUnchanged=$true }
    $result['firstExeSha256']=(Get-FileHash -LiteralPath (Join-Path $first 'win-unpacked\AIbrowse.exe') -Algorithm SHA256).Hash
    if ($result.firstExeSha256 -cne '373F81B386EA1CD439B6F1B1D350B3E9DBD05F173879200796CBF83998693AEA') { throw 'FIRST应用摘要不符。' }
    $result.status=if ($result.errors.Count -eq 0) { 'completed' } else { 'completed_with_errors' }
    if ($result.errors.Count -eq 0) { $exitCode=0 }
} catch { $result.status='stopped'; $result.errors.Add([pscustomobject]@{path=$null;message=$_.Exception.Message}) }
finally {
    foreach ($pin in $pins) { $pin.Dispose() }
    $result['endedUtc']=[DateTime]::UtcNow.ToString('o')
    $result['elapsedSeconds']=$timer.Elapsed.TotalSeconds
    $result['sourceSha256']=(Get-FileHash -LiteralPath $PSCommandPath).Hash
    $stream=[IO.File]::Open($receipt,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try { $bytes=[Text.Encoding]::UTF8.GetBytes(($result | ConvertTo-Json -Depth 6));$stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
}
exit $exitCode
