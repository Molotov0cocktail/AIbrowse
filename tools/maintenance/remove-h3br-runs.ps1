param([switch]$CheckOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$targetRoot = 'D:\AIbrowse-h3br-runs'
$receiptPath = 'D:\AIbrowse\log\maintenance\h3br-cleanup-20261011-001.json'

# Restore access through a no-follow handle; never propagate ACLs to children.
$nativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class H3brCleanupAccess {
    [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] struct TokenPrivileges {
        public uint Count; public Luid Luid; public uint Attributes;
    }
    [StructLayout(LayoutKind.Sequential)] struct AttributeTag { public uint Attributes; public uint Tag; }
    [StructLayout(LayoutKind.Sequential)] struct FileStandard {
        public long AllocationSize; public long EndOfFile; public uint Links;
        [MarshalAs(UnmanagedType.U1)] public bool DeletePending;
        [MarshalAs(UnmanagedType.U1)] public bool Directory;
    }
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disable, ref TokenPrivileges state, uint length, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, out AttributeTag info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, out FileStandard info, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint length, uint flags);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, IntPtr size);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
    [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(SafeFileHandle handle, int type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

    public static void Enable(string name) {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) throw new Win32Exception();
        try {
            Luid luid;
            if (!LookupPrivilegeValue(null, name, out luid)) throw new Win32Exception();
            var state = new TokenPrivileges { Count = 1, Luid = luid, Attributes = 2 };
            if (!AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
            int error = Marshal.GetLastWin32Error();
            if (error != 0) throw new Win32Exception(error);
        } finally { CloseHandle(token); }
    }

    public static SafeFileHandle Unlock(string path) {
        const string root = @"D:\AIbrowse-h3br-runs";
        if (!path.Equals(root, StringComparison.OrdinalIgnoreCase) && !path.StartsWith(root + @"\", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Path outside authorized root");
        var file = CreateFileW(path, 0x00060080, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (file.IsInvalid) { int error = Marshal.GetLastWin32Error(); file.Dispose(); throw new Win32Exception(error); }
        try {
            AttributeTag info;
            if (!GetFileInformationByHandleEx(file, 9, out info, 8)) throw new Win32Exception();
            if ((info.Attributes & 0x400) != 0) throw new InvalidOperationException("Reparse point retained");
            FileStandard standard;
            if (!GetFileInformationByHandleEx(file, 1, out standard, (uint)Marshal.SizeOf(typeof(FileStandard)))) throw new Win32Exception();
            if (!standard.Directory && standard.Links != 1) throw new InvalidOperationException("Multiple hard links retained");
            var finalPath = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandleW(file, finalPath, 32768, 0);
            if (length == 0 || length >= 32768) throw new Win32Exception();
            if (!finalPath.ToString().Equals(@"\\?\" + path, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Resolved path mismatch");
            IntPtr descriptor;
            string user = WindowsIdentity.GetCurrent().User.Value;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;" + user + ")", 1, out descriptor, IntPtr.Zero)) throw new Win32Exception();
            try {
                bool present, defaulted; IntPtr dacl;
                if (!GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted) || !present || dacl == IntPtr.Zero)
                    throw new InvalidOperationException("Invalid replacement ACL");
                uint error = SetSecurityInfo(file, 1, 0x80000004, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
                if (error != 0) throw new Win32Exception((int)error);
            } finally { LocalFree(descriptor); }
            return file;
        } catch { file.Dispose(); throw; }
    }
}
'@
Add-Type -TypeDefinition $nativeSource
if ($CheckOnly) { Write-Output '语法及系统接口编译检查通过；未修改权限或删除文件。'; exit 0 }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '需要通过 Windows UAC 启动管理员进程。'
}
if (Test-Path -LiteralPath $receiptPath) { throw '回执已存在，禁止覆盖或无诊断重跑。' }
$rootItem = Get-Item -LiteralPath $targetRoot -Force
if ($rootItem.FullName -cne $targetRoot -or -not $rootItem.PSIsContainer -or
    ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '根路径身份不符。' }
$topChildren = @(Get-ChildItem -LiteralPath $targetRoot -Force)
if ($topChildren.Count -ne 30) { throw '预检的 30 个运行目录发生变化，停止。' }
foreach ($child in $topChildren) {
    if (-not $child.PSIsContainer -or $child.Name -cnotmatch '^run-[A-Z2-7]{26}$' -or
        ($child.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '发现非预期顶层条目，停止。' }
}
foreach ($ancestor in @('D:\AIbrowse', 'D:\AIbrowse\log', 'D:\AIbrowse\log\maintenance')) {
    if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw '回执目录包含链接，停止。'
    }
}

$result = [ordered]@{
    target = $targetRoot; startedUtc = [DateTime]::UtcNow.ToString('o'); status = 'running'
    filesDeleted = 0; directoriesDeleted = 0; logicalBytesDeleted = [long]0
    credentialsRead = $false; followedLinks = $false; error = $null
}
$timer = [Diagnostics.Stopwatch]::StartNew()
$script:visited = 0
function Remove-VerifiedEntry([string]$EntryPath, [int]$Depth) {
    $fullPath = [IO.Path]::GetFullPath($EntryPath)
    if ($fullPath -cne $targetRoot -and -not $fullPath.StartsWith($targetRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw '拒绝越界路径。'
    }
    $script:visited++
    if ($Depth -gt 128 -or $script:visited -gt 200000 -or $timer.Elapsed.TotalMinutes -gt 10) { throw '达到有界清理预算，停止。' }
    $pinned = [H3brCleanupAccess]::Unlock($fullPath)
    try {
        $entry = Get-Item -LiteralPath $fullPath -Force
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '保留目录链接，停止。' }
        if ($entry.PSIsContainer) {
            foreach ($childEntry in @(Get-ChildItem -LiteralPath $fullPath -Force)) {
                Remove-VerifiedEntry -EntryPath $childEntry.FullName -Depth ($Depth + 1)
            }
            if (@(Get-ChildItem -LiteralPath $fullPath -Force).Count -ne 0) { throw '目录未空，停止。' }
        }
        $isDirectory = $entry.PSIsContainer
        $entryBytes = if ($isDirectory) { 0L } else { $entry.Length }
    } finally { $pinned.Dispose() }
    # Every parent remains pinned while its children are removed. No recursive Remove-Item.
    Remove-Item -LiteralPath $fullPath -Force -ErrorAction Stop -Confirm:$false
    if ($isDirectory) { $result.directoriesDeleted++ } else {
        $result.filesDeleted++; $result.logicalBytesDeleted += $entryBytes
    }
}

$workerExit = 1
try {
    [H3brCleanupAccess]::Enable('SeBackupPrivilege')
    [H3brCleanupAccess]::Enable('SeRestorePrivilege')
    Remove-VerifiedEntry -EntryPath $targetRoot -Depth 0
    if (Test-Path -LiteralPath $targetRoot) { throw '目录仍存在。' }
    $result.status = 'deleted'
    $workerExit = 0
} catch {
    $result.status = 'stopped'
    $result.error = $_.Exception.Message
} finally {
    $result['endedUtc'] = [DateTime]::UtcNow.ToString('o')
    $result['elapsedSeconds'] = $timer.Elapsed.TotalSeconds
    $stream = [IO.File]::Open($receiptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($result | ConvertTo-Json -Depth 4))
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
}
exit $workerExit
