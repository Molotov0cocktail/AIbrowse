param(
    [switch]$CheckOnly,
    [switch]$CheckAclIsolation,
    [Parameter(Mandatory=$false)][string]$PlanPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$nativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class ProjectCleanupAccess {
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
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorControl(IntPtr descriptor, out ushort control, out uint revision);
    [DllImport("advapi32.dll", SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor, uint revision, uint information, out IntPtr text, out uint length);
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

    public static SafeFileHandle Unlock(string path, string root) {
        string originalDacl;
        return Unlock(path, root, out originalDacl);
    }

    public static SafeFileHandle Unlock(string path, string root, out string originalDacl) {
        return Open(path, root, out originalDacl, true);
    }

    public static SafeFileHandle Pin(string path, string root) {
        string originalDacl;
        return Open(path, root, out originalDacl, false);
    }

    private static SafeFileHandle Open(string path, string root, out string originalDacl, bool unlock) {
        originalDacl = null;
        if (String.IsNullOrEmpty(root)) throw new InvalidOperationException("Missing authorized root");
        if (!path.Equals(root, StringComparison.OrdinalIgnoreCase) && !path.StartsWith(root + @"\", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Path outside authorized root");
        // MAXIMUM_ALLOWED prevents SetSecurityInfo from propagating ACEs to children.
        // https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo
        if (!System.IO.Path.IsPathFullyQualified(path) || !System.IO.Path.GetFullPath(path).Equals(path, StringComparison.Ordinal))
            throw new InvalidOperationException("Path must be canonical and absolute");
        var file = CreateFileW(@"\\?\" + path, 0x02000000, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
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
            originalDacl = ReadDacl(file);
            if (!unlock) return file;
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

    public static string ReadDacl(SafeFileHandle file) {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint error = GetSecurityInfo(file, 1, 4, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error);
        try {
            IntPtr text; uint length;
            if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, 4, out text, out length)) throw new Win32Exception();
            try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
        } finally { LocalFree(descriptor); }
    }

    public static void RestoreDacl(SafeFileHandle file, string originalDacl) {
        IntPtr descriptor;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(originalDacl, 1, out descriptor, IntPtr.Zero)) throw new Win32Exception();
        try {
            bool present, defaulted; IntPtr dacl; ushort control; uint revision;
            if (!GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted) || !present || dacl == IntPtr.Zero)
                throw new InvalidOperationException("Original DACL is absent; refuse a broad replacement");
            if (!GetSecurityDescriptorControl(descriptor, out control, out revision)) throw new Win32Exception();
            uint information = 4u | (((control & 0x1000) != 0) ? 0x80000000u : 0x20000000u);
            uint error = SetSecurityInfo(file, 1, information, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
            if (error != 0) throw new Win32Exception((int)error);
            if (!String.Equals(ReadDacl(file), originalDacl, StringComparison.Ordinal))
                throw new InvalidOperationException("Original directory DACL was not restored exactly");
        } finally { LocalFree(descriptor); }
    }
}
'@
Add-Type -TypeDefinition $nativeSource
if ($CheckOnly) { Write-Output '语法与原生接口编译通过；未修改文件。'; return }
if ($CheckAclIsolation) {
    # A single synthetic fixture verifies no propagation and exact restoration; no cleanup jobs run.
    $fixture = 'D:\AIbrowse\.local-dev\acl-isolation-check-001'
    $checkReceipt = 'D:\AIbrowse\.local-dev\acl-isolation-check-001.json'
    if ((Test-Path -LiteralPath $fixture) -or (Test-Path -LiteralPath $checkReceipt)) { throw 'ACL夹具或回执已存在，禁止覆盖。' }
    $ancestor = [IO.Path]::GetDirectoryName($fixture)
    while ($ancestor) {
        $item = Get-Item -LiteralPath $ancestor -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'ACL夹具祖先不是普通目录。' }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor.TrimEnd('\'))
    }
    [void][IO.Directory]::CreateDirectory((Join-Path $fixture 'child'))
    $marker = Join-Path $fixture 'child\marker.txt'
    [IO.File]::WriteAllText($marker, 'synthetic ACL isolation check')
    $paths = @($fixture,(Join-Path $fixture 'child'),$marker)
    $before = @{}
    foreach ($path in $paths) { $before[$path]=(Get-Acl -LiteralPath $path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) }
    $check = [ordered]@{status='running';childDaclsUnchangedDuringUnlock=$false;allDaclsRestored=$false;markerReadable=$false;sourceSha256=(Get-FileHash -LiteralPath $PSCommandPath).Hash}
    $handle=$null
    try {
        $original=$null
        $handle=[ProjectCleanupAccess]::Unlock($fixture,$fixture,[ref]$original)
        foreach ($path in $paths[1..2]) {
            if ((Get-Acl -LiteralPath $path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -cne $before[$path]) { throw '父目录临时解锁改变了子项DACL。' }
        }
        $check.childDaclsUnchangedDuringUnlock=$true
        [ProjectCleanupAccess]::RestoreDacl($handle,$original)
        $handle.Dispose(); $handle=$null
        foreach ($path in $paths) {
            if ((Get-Acl -LiteralPath $path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -cne $before[$path]) { throw '目录DACL未精确恢复。' }
        }
        $check.allDaclsRestored=$true
        if ([IO.File]::ReadAllText($marker) -cne 'synthetic ACL isolation check') { throw '合成子文件不可读。' }
        $check.markerReadable=$true
        $check.status='passed'
    } catch { $check.status='failed'; $check['error']=$_.Exception.Message; throw }
    finally {
        try { if ($handle) { try { [ProjectCleanupAccess]::RestoreDacl($handle,$original) } finally { $handle.Dispose() } } }
        finally { [IO.File]::WriteAllText($checkReceipt,($check | ConvertTo-Json),[Text.UTF8Encoding]::new($false)) }
    }
    $check | ConvertTo-Json
    return
}
if (-not $PlanPath) { throw '必须提供本地精确清理计划。' }
$repository = 'D:\AIbrowse'
$first = Join-Path $repository 'log\stage7-e6\clean-builds-001\first-release'
$archive = Join-Path $repository 'log\local-archive'
$maintenance = Join-Path $repository 'log\maintenance'
$planFull = [IO.Path]::GetFullPath($PlanPath)
if (-not $planFull.StartsWith($maintenance + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '计划必须位于项目维护日志内。' }
$plan = Get-Content -LiteralPath $planFull -Raw | ConvertFrom-Json
$output = [IO.Path]::GetDirectoryName($planFull)
$receipt = Join-Path $output 'cleanup-result.json'
if (Test-Path -LiteralPath $receipt) { throw '已有操作回执，禁止覆盖。' }
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '受限旧测试目录需要Windows UAC管理员进程。' }
if (@(Get-Process | Where-Object ProcessName -match '^(AIbrowse|aibrowse-guardian|electron|msiexec)$').Count) { throw '发现相关运行进程，停止。' }
function Is-Within([string]$Path, [string]$Root) {
    return $Path.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or $Path.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Assert-NoLinkAncestors([string]$Path) {
    $candidate = $Path
    while ($candidate) {
        $item = Get-Item -LiteralPath $candidate -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('路径祖先为链接：' + $candidate) }
        $candidate = [IO.Path]::GetDirectoryName($candidate.TrimEnd('\'))
    }
}
Assert-NoLinkAncestors $output
Assert-NoLinkAncestors $first
Assert-NoLinkAncestors $archive
$tempRoot = [IO.Path]::GetFullPath([string]$plan.tempRoot).TrimEnd('\')
if ($tempRoot -notmatch '^[A-Z]:\\Users\\[^\\]+\\AppData\\Local\\Temp$') { throw '非预期用户Temp根。' }
$jobs = @($plan.jobs)
foreach ($job in $jobs) {
    $full = [IO.Path]::GetFullPath([string]$job.path).TrimEnd('\')
    if ($full -cne $job.path) { throw '清理目标不是规范绝对路径。' }
    $valid = switch ($job.mode) {
        'prune-log' { $full -ceq (Join-Path $repository 'log') }
        'test-tree' { $full -match '^D:\\AIbrowse\\\.h3b-workspaces\\run-[A-Z2-7]{26}$' -or $full.StartsWith((Join-Path $repository 'log') + '\', [StringComparison]::OrdinalIgnoreCase) }
        'empty-temp' { [IO.Path]::GetDirectoryName($full).Equals($tempRoot, [StringComparison]::OrdinalIgnoreCase) }
        'archive-review' { [IO.Path]::GetDirectoryName($full) -ceq 'C:\Program Files' -and [IO.Path]::GetFileName($full).StartsWith('AIbrowse', [StringComparison]::Ordinal) }
        default { $false }
    }
    if (-not $valid -or (Is-Within $full $first) -or (Is-Within $full $archive) -or (Is-Within $full $maintenance)) { throw ('拒绝目标范围：' + $full) }
    Assert-NoLinkAncestors ([IO.Path]::GetDirectoryName($full))
}
$firstBefore = @(Get-ChildItem -LiteralPath $first -File -Recurse -Force | ForEach-Object {
    [pscustomobject]@{ Path=$_.FullName; Length=$_.Length; Sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
})
$result = [ordered]@{ startedUtc=[DateTime]::UtcNow.ToString('o'); status='running'; filesDeleted=0L; directoriesDeleted=0L; linksDeleted=0L; logicalBytesDeleted=0L; archivedFiles=0L; archivedBytes=0L; reusedArchivedFiles=0L; reusedArchivedBytes=0L; filesRetained=0L; directoriesDaclRestored=0L; retainedHardLinks=[Collections.Generic.List[string]]::new(); jobs=[Collections.Generic.List[object]]::new(); errors=[Collections.Generic.List[object]]::new(); firstVerified=$false; credentialContentsRead=$false; followedLinks=$false }
$timer = [Diagnostics.Stopwatch]::StartNew()
$script:visited = 0
$script:lastProgress = 0.0
$testRoots = @($jobs | Where-Object mode -eq 'test-tree' | ForEach-Object path)
$testRootSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($testRoot in $testRoots) { [void]$testRootSet.Add($testRoot) }
$exactFiles = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($deleteFile in @($plan.exactDeleteFiles)) {
    $deleteFileFull = [IO.Path]::GetFullPath([string]$deleteFile)
    if ($deleteFileFull -cne $deleteFile -or -not (Is-Within $deleteFileFull (Join-Path $repository 'log'))) { throw '精确文件清单越界。' }
    foreach ($protected in @($first,$archive,$maintenance)) { if (Is-Within $deleteFileFull $protected) { throw '精确文件清单包含保留目录。' } }
    [void]$exactFiles.Add($deleteFileFull)
}
$binaryExtensions = @('.exe','.dll','.node','.pdb','.obj','.lib','.exp','.ilk','.pch','.msi','.msix','.zip','.7z','.asar','.pak','.bin','.dmp','.etl','.vsman','.cab')
function Get-SharedSha256([string]$Path) {
    # Readers must share the WRITE/DELETE access held by MAXIMUM_ALLOWED identity pins.
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
        $hash=[Security.Cryptography.SHA256]::Create()
        try { return [Convert]::ToHexString($hash.ComputeHash($stream)) }
        finally { $hash.Dispose() }
    } finally { $stream.Dispose() }
}
function Is-TestTree([string]$Path) {
    $candidate = $Path
    while ($candidate) {
        if ($testRootSet.Contains($candidate)) { return $true }
        $candidate = [IO.Path]::GetDirectoryName($candidate)
    }
    return $false
}
function Update-Progress {
    if (($timer.Elapsed.TotalSeconds - $script:lastProgress) -ge 5) {
        $script:lastProgress = $timer.Elapsed.TotalSeconds
        [IO.File]::WriteAllText((Join-Path $output 'cleanup-progress.json'), ([ordered]@{ elapsedSeconds=$timer.Elapsed.TotalSeconds; visited=$script:visited; filesDeleted=$result.filesDeleted; directoriesDeleted=$result.directoriesDeleted; bytesDeleted=$result.logicalBytesDeleted; archivedFiles=$result.archivedFiles } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    }
}
function Visit-Entry([string]$Path, [string]$Root, [string]$Mode, [int]$Depth) {
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not (Is-Within $full $Root)) { throw '拒绝越界条目。' }
    foreach ($protected in @($first,$archive,$maintenance)) { if (Is-Within $full $protected) { return } }
    if ($full -match '(?i)7ZH3LHUDMG7EVBK6ESGEECUVEM|canary') { return }
    $script:visited++
    if ($Depth -gt 128 -or $script:visited -gt 300000 -or $timer.Elapsed.TotalMinutes -gt 25) { throw '达到清理预算。' }
    Update-Progress
    $entry = Get-Item -LiteralPath $full -Force
    $isLink = [bool]($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)
    if ($isLink) {
        # Delete the link itself, with no recursion or target access.
        if ($entry.PSIsContainer) { [IO.Directory]::Delete($full, $false) } else { [IO.File]::Delete($full) }
        $result.linksDeleted++
        return
    }
    if ($entry.PSIsContainer) {
        $originalDacl = $null
        $pinned = [ProjectCleanupAccess]::Pin($full, $Root)
        try {
            try { $children = @(Get-ChildItem -LiteralPath $full -Force) }
            catch {
                if ($_.CategoryInfo.Category -ne 'PermissionDenied' -and $_.Exception -isnot [UnauthorizedAccessException]) { throw }
                $pinned.Dispose()
                $pinned = [ProjectCleanupAccess]::Unlock($full, $Root, [ref]$originalDacl)
                $children = @(Get-ChildItem -LiteralPath $full -Force)
            }
            foreach ($child in $children) { Visit-Entry $child.FullName $Root $Mode ($Depth + 1) }
            $empty = @(Get-ChildItem -LiteralPath $full -Force).Count -eq 0
        } finally {
            try { if ($originalDacl) { [ProjectCleanupAccess]::RestoreDacl($pinned, $originalDacl); $result.directoriesDaclRestored++ } }
            finally { $pinned.Dispose() }
        }
        if ($empty -and $full -cne (Join-Path $repository 'log')) {
            Remove-Item -LiteralPath $full -Force -Confirm:$false
            $result.directoriesDeleted++
        }
        return
    }
    # Never open, archive, or delete credential-like files or unresolved canary records.
    if ($full -match '(?i)credential|secret|password|passwd|api[-_]?key|dpapi|(^|[\\.])env([\\.]|$)' -or ($Mode -ne 'archive-review' -and $full -match 'e5-review-unknown')) {
        $result.filesRetained++
        return
    }
    if ($Mode -eq 'empty-temp') { $result.filesRetained++; return }
    $smallRecord = ($entry.Length -le 1MB) -and ($entry.Extension -match '^\.(md|ps1|cs|cpp|h|ts|js|mjs)$' -or $entry.Name -match '(?i)report|result|verdict|claim|receipt|evidence|proof|manifest|summary|judgment|ledger|request|audit')
    $delete = (($Mode -eq 'test-tree' -or (Is-TestTree $full)) -and -not $smallRecord) -or ($binaryExtensions -contains $entry.Extension.ToLowerInvariant()) -or $exactFiles.Contains($full)
    if ($Mode -eq 'prune-log' -and $entry.Length -gt 1MB -and $entry.Name -match '^(early-io-|telemetry-|.*disassembly|dd_|setup-).*\.(jsonl|log|txt)$') { $delete = $true }
    if ($Mode -eq 'archive-review') { $delete = $entry.Length -gt 10MB -and $entry.Extension -match '^\.(exe|msi)$' }
    $archiveFile = $Mode -eq 'archive-review' -and -not $delete
    if (-not $delete -and -not $archiveFile) { $result.filesRetained++; return }
    $length = $entry.Length
    $archiveReused = $false
    try { $pinned = [ProjectCleanupAccess]::Unlock($full, $Root) }
    catch {
        $cause=$_.Exception
        while ($cause.InnerException) { $cause=$cause.InnerException }
        if ($cause.Message -ceq 'Multiple hard links retained') { $result.retainedHardLinks.Add($full); $result.filesRetained++; return }
        throw
    }
    try {
        if ($archiveFile) {
            $relative = $full.Substring($Root.Length).TrimStart('\')
            $destination = Join-Path (Join-Path (Join-Path $archive 'installer-review') ([IO.Path]::GetFileName($Root))) $relative
            $destination = [IO.Path]::GetFullPath($destination)
            if (-not (Is-Within $destination $archive)) { throw '归档目标越界。' }
            $parent = [IO.Path]::GetDirectoryName($destination)
            $existing = $parent
            while (-not (Test-Path -LiteralPath $existing)) { $existing = [IO.Path]::GetDirectoryName($existing) }
            Assert-NoLinkAncestors $existing
            [void][IO.Directory]::CreateDirectory($parent)
            Assert-NoLinkAncestors $parent
            if (Test-Path -LiteralPath $destination) {
                $existingArchive = Get-Item -LiteralPath $destination -Force
                if ($existingArchive.PSIsContainer -or ($existingArchive.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '既有归档不是普通文件，拒绝复用。' }
                if ($existingArchive.Length -ne $length -or (Get-SharedSha256 $full) -cne (Get-SharedSha256 $destination)) { throw '既有归档与源不一致，保留双方并拒绝覆盖。' }
                $archiveReused = $true
            } else {
                $inputStream=[IO.File]::Open($full,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
                try {
                    $outputStream=[IO.File]::Open($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
                    try { $inputStream.CopyTo($outputStream); $outputStream.Flush($true) }
                    finally { $outputStream.Dispose() }
                } finally { $inputStream.Dispose() }
                [IO.File]::SetLastWriteTimeUtc($destination,$entry.LastWriteTimeUtc)
            }
            if ((Get-Item -LiteralPath $destination).Length -ne $length -or (Get-SharedSha256 $full) -cne (Get-SharedSha256 $destination)) { throw '归档校验不符，保留原件。' }
        }
    } finally { $pinned.Dispose() }
    Remove-Item -LiteralPath $full -Force -Confirm:$false
    if ($archiveReused) { $result.reusedArchivedFiles++; $result.reusedArchivedBytes += $length }
    elseif ($archiveFile) { $result.archivedFiles++; $result.archivedBytes += $length }
    else { $result.filesDeleted++; $result.logicalBytesDeleted += $length }
}
$workerExit = 1
try {
    [ProjectCleanupAccess]::Enable('SeBackupPrivilege')
    [ProjectCleanupAccess]::Enable('SeRestorePrivilege')
    foreach ($job in $jobs) {
        if ($job.mode -eq 'test-tree' -and (Is-Within $job.path (Join-Path $repository 'log'))) { continue }
        if (-not (Test-Path -LiteralPath $job.path)) { $result.jobs.Add([pscustomobject]@{path=$job.path;mode=$job.mode;status='already_absent'}); continue }
        try {
            Visit-Entry $job.path $job.path $job.mode 0
            $result.jobs.Add([pscustomobject]@{path=$job.path;mode=$job.mode;status='processed';rootRemains=(Test-Path -LiteralPath $job.path)})
        } catch {
            $result.errors.Add([pscustomobject]@{path=$job.path;message=$_.Exception.Message})
            if ($timer.Elapsed.TotalMinutes -gt 25) { break }
        }
    }
    foreach ($file in $firstBefore) {
        if ((Get-Item -LiteralPath $file.Path).Length -ne $file.Length -or (Get-FileHash -LiteralPath $file.Path -Algorithm SHA256).Hash -cne $file.Sha256) { throw 'FIRST身份发生变化。' }
    }
    if (@(Get-ChildItem -LiteralPath $first -File -Recurse -Force).Count -ne $firstBefore.Count) { throw 'FIRST文件数发生变化。' }
    $result.firstVerified = $true
    $result.status = if ($result.errors.Count -eq 0) { 'completed' } else { 'completed_with_retained_errors' }
    if ($result.errors.Count -eq 0) { $workerExit = 0 }
} catch { $result.status='stopped'; $result.errors.Add([pscustomobject]@{path=$null;message=$_.Exception.Message}) }
finally {
    $result['endedUtc']=[DateTime]::UtcNow.ToString('o')
    $result['elapsedSeconds']=$timer.Elapsed.TotalSeconds
    $result['sourceSha256']=(Get-FileHash -LiteralPath $PSCommandPath).Hash
    $result['planSha256']=(Get-FileHash -LiteralPath $planFull).Hash
    $stream=[IO.File]::Open($receipt,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try { $bytes=[Text.Encoding]::UTF8.GetBytes(($result | ConvertTo-Json -Depth 6)); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
}
exit $workerExit
