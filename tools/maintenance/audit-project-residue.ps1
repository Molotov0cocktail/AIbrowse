param(
    [switch]$CheckOnly,
    [ValidatePattern('^(?:[A-Za-z]:\\|\\\\\?\\Volume\{[0-9a-fA-F-]{36}\}\\)$')]
    [string[]]$Roots = @()
)

$ErrorActionPreference = 'Stop'
# This task-specific inventory reads directory metadata, never regular-file contents.
# Microsoft FILE_FULL_DIR_INFO: offsets 40/56/60/68; classes 14 and 15.
# https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_full_dir_info
# The scan is live, not a filesystem snapshot. Logical sizes count directory entries,
# including hard links, and do not represent allocated or reclaimable disk space.
$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace ProjectResidueAudit {
    public sealed class Aggregate {
        public string Path;
        public string Kind;
        public long Files, Directories, LogicalBytes, ReparsePoints, Errors;
        public Aggregate(string path, string kind) { Path = path; Kind = kind; }
        public void Add(bool directory, bool reparse, long size) {
            if (directory) Directories++; else Files++;
            if (reparse) ReparsePoints++; else if (!directory) LogicalBytes += size;
        }
    }
    public sealed class LargeFile { public string Path; public long LogicalBytes; }
    public sealed class VolumeResult {
        public string Root, StartedUtc, FinishedUtc, Status;
        public long Files, Directories, LogicalBytes, ReparsePoints, Errors, PendingDirectories;
        public double DurationSeconds;
    }
    public sealed class ScanResult {
        public int SchemaVersion = 1;
        public string StartedUtc, FinishedUtc;
        public bool BackupPrivilegeEnabled;
        public int BackupPrivilegeError;
        public string Scope = "Directory metadata only; no regular-file contents; no ACL or ownership changes; no intentional reparse traversal.";
        public string Limitations = "Live non-atomic inventory; filename and size heuristics cannot exclude randomly named residues. Logical bytes are per directory entry, not allocation or reclaimable space. Reparse descendants are excluded. Directory roots are excluded from their own descendant counts. Budgets are checked between synchronous native calls; a blocked kernel call may exceed 20 minutes. Errors and timeouts mean incomplete coverage. Largest-file lists are bounded and exclude credential-like path components.";
        public List<VolumeResult> Volumes = new List<VolumeResult>();
        public List<Aggregate> Aggregates = new List<Aggregate>();
        public List<LargeFile> RepositoryLargestFiles = new List<LargeFile>();
        public List<LargeFile> OutsideUnknownLargestFiles = new List<LargeFile>();
    }
    internal sealed class Frame {
        public string Path;
        public int Primary = -1, Top = -1, LogRoot = -1, LogGroup = -1, First = -1, Profile = -1;
        public Frame Child(string path) {
            return new Frame { Path = path, Primary = Primary, Top = Top, LogRoot = LogRoot,
                LogGroup = LogGroup, First = First, Profile = Profile };
        }
    }
    public static class Scanner {
        const string Repository = @"D:\AIbrowse";
        const string FirstRelease = @"D:\AIbrowse\log\stage7-e6\clean-builds-001\first-release";
        const string Output = @"D:\AIbrowse\log\maintenance\full-disk-audit-20261011-001";
        const uint DirectoryAttribute = 0x10, ReparseAttribute = 0x400;
        const uint OpenFlags = 0x02200000;
        const int BufferSize = 65536;
        static readonly Regex MatchName = new Regex(@"aibrowse|h3br|h3b[-_]|h4-namespace|watch-qualification|stage[ _-]?[67]|\.aibak$|\.aidiag$|native-build|vs[_-]?buildtools|nsis|wix|electron|npm-cache|node-gyp|node_modules|\.h3b-workspaces|^run-[A-Z2-7]{26}$|MsiReview|^(product-(ui-structure|bad-wire|ui-deadline|job-receipt-review|wire|deadline|job-pure)|startup-(preparation|independent|probe)|default-(smoke|production-build)|cross-(scope|readback|dev-independent)|shutdown-diagnostic|transfer-(runtime-independent|copy-buffer|files|pipeline|space)|replacement-(independent|record-independent)|native-(selection-independent|transfer-selection)|full-(transfer|conversations|runner-pure)|probe-wal-future-independent|research-(shutdown|maintenance)|conversation-(identity-review|maintenance|member|read-shutdown|shutdown|snapshot-cancel|storage|transfer|ui-interruption)|factory-maintenance|backup-container|counts-readonly|filename-job-mode-pure|host-structure-independent|independent-maintenance-review|oversize-preflight-controls|rt05-batch|runtime-output|snapshot-cancel-review)-|^(sources|research|watch)\.db(-wal|-shm)?$|^(app\.asar|win-unpacked|installer-build\.json|build-provenance\.json|PowerShell-7\.6\.5-win-x64\.zip|opencode|d3-gate)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        static readonly Regex CredentialName = new Regex(@"credential|secret|token|password|passwd|api[-_]?key|dpapi|\.env(?:\.|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
        [StructLayout(LayoutKind.Sequential)] struct TokenPrivilege { public uint Count; public Luid Luid; public uint Attributes; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, IntPtr buffer, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool DeviceIoControl(SafeFileHandle handle, uint code, IntPtr input, uint inputLength, IntPtr output, uint outputLength, out uint returned, IntPtr overlapped);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivilege state, uint length, IntPtr previous, IntPtr returned);

        static bool EnableBackup(out int error) {
            error = 0; IntPtr token;
            if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) { error = Marshal.GetLastWin32Error(); return false; }
            try {
                Luid luid;
                if (!LookupPrivilegeValue(null, "SeBackupPrivilege", out luid)) { error = Marshal.GetLastWin32Error(); return false; }
                TokenPrivilege state = new TokenPrivilege { Count = 1, Luid = luid, Attributes = 2 };
                bool success = AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero);
                error = Marshal.GetLastWin32Error();
                return success && error == 0;
            } finally { CloseHandle(token); }
        }
        static bool Equal(string a, string b) { return String.Equals(a, b, StringComparison.OrdinalIgnoreCase); }
        static bool Within(string path, string root) { return Equal(path, root) || path.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase); }
        static string Native(string path) { return path.StartsWith(@"\\?\", StringComparison.Ordinal) ? path : @"\\?\" + path; }
        static string Join(string parent, string name) { return parent.TrimEnd('\\') + "\\" + name; }
        static string Quote(string value) {
            if (value == null) return "null";
            StringBuilder b = new StringBuilder("\"");
            foreach (char c in value) {
                if (c == '\\' || c == '"') { b.Append('\\'); b.Append(c); }
                else if (c < 32 || Char.IsSurrogate(c)) b.Append("\\u" + ((int)c).ToString("x4"));
                else b.Append(c);
            }
            return b.Append('"').ToString();
        }
        static StreamWriter NewWriter(string name) {
            return new StreamWriter(new FileStream(Path.Combine(Output, name), FileMode.CreateNew, FileAccess.Write, FileShare.Read), new UTF8Encoding(false));
        }
        static int AddAggregate(ScanResult result, string path, string kind) {
            result.Aggregates.Add(new Aggregate(path, kind)); return result.Aggregates.Count - 1;
        }
        static void EachAggregate(ScanResult result, Frame f, Action<Aggregate> action) {
            int[] ids = { f.Primary, f.Top, f.LogRoot, f.LogGroup, f.First, f.Profile };
            for (int i = 0; i < ids.Length; i++) {
                if (ids[i] < 0) continue;
                bool duplicate = false;
                for (int j = 0; j < i; j++) if (ids[i] == ids[j]) duplicate = true;
                if (!duplicate) action(result.Aggregates[ids[i]]);
            }
        }
        static void Error(StreamWriter errors, ScanResult result, VolumeResult volume, Frame f, string operation, int code) {
            volume.Errors++;
            EachAggregate(result, f, delegate(Aggregate a) { a.Errors++; });
            errors.WriteLine("{\"path\":" + Quote(f.Path) + ",\"operation\":" + Quote(operation) + ",\"win32Error\":" + code + "}");
        }
        static void KeepLargest(List<LargeFile> list, string path, long size, int maximum) {
            if (CredentialName.IsMatch(path)) return;
            if (list.Count == maximum && size <= list[list.Count - 1].LogicalBytes) return;
            list.Add(new LargeFile { Path = path, LogicalBytes = size });
            list.Sort(delegate(LargeFile a, LargeFile b) { int c = b.LogicalBytes.CompareTo(a.LogicalBytes); return c != 0 ? c : StringComparer.OrdinalIgnoreCase.Compare(a.Path, b.Path); });
            if (list.Count > maximum) list.RemoveAt(list.Count - 1);
        }
        static string ReparseTarget(IntPtr buffer, uint length, uint tag) {
            int baseOffset;
            if (tag == 0xA000000C) baseOffset = 20;
            else if (tag == 0xA0000003) baseOffset = 16;
            else return null;
            if (length < baseOffset) return null;
            int start = (ushort)Marshal.ReadInt16(buffer, 8), count = (ushort)Marshal.ReadInt16(buffer, 10);
            if (start % 2 != 0 || count % 2 != 0 || (long)baseOffset + start + count > length) return null;
            return Marshal.PtrToStringUni(IntPtr.Add(buffer, baseOffset + start), count / 2);
        }
        static void Reparse(StreamWriter output, StreamWriter errors, ScanResult result, VolumeResult volume, Frame f, uint attributes) {
            uint tag = 0; string target = null;
            using (SafeFileHandle handle = CreateFileW(Native(f.Path), 0x80, 7, IntPtr.Zero, 3, OpenFlags, IntPtr.Zero)) {
                if (handle.IsInvalid) Error(errors, result, volume, f, "open-reparse-metadata", Marshal.GetLastWin32Error());
                else {
                    IntPtr data = Marshal.AllocHGlobal(16384);
                    try {
                        uint returned;
                        if (DeviceIoControl(handle, 0x000900A8, IntPtr.Zero, 0, data, 16384, out returned, IntPtr.Zero) && returned >= 8) {
                            tag = unchecked((uint)Marshal.ReadInt32(data, 0)); target = ReparseTarget(data, returned, tag);
                        } else Error(errors, result, volume, f, "read-reparse-metadata", Marshal.GetLastWin32Error());
                    } finally { Marshal.FreeHGlobal(data); }
                }
            }
            output.WriteLine("{\"path\":" + Quote(f.Path) + ",\"attributes\":" + attributes + ",\"tag\":" + tag + ",\"target\":" + Quote(target) + ",\"traversed\":false}");
        }
        static void Progress(StreamWriter writer, VolumeResult v, Stopwatch elapsed, string path, int pending, bool final) {
            writer.Flush(); writer.BaseStream.Position = 0; writer.BaseStream.SetLength(0);
            writer.Write("{\"root\":" + Quote(v.Root) + ",\"currentPath\":" + Quote(path) + ",\"utc\":" + Quote(DateTime.UtcNow.ToString("o")) +
                ",\"files\":" + v.Files + ",\"directories\":" + v.Directories + ",\"logicalBytes\":" + v.LogicalBytes + ",\"errors\":" + v.Errors +
                ",\"pendingDirectories\":" + pending + ",\"elapsedSeconds\":" + ((long)elapsed.Elapsed.TotalSeconds) + ",\"volumeFinished\":" + (final ? "true" : "false") + "}");
            writer.Flush();
        }
        public static ScanResult Run(string[] roots) {
            ScanResult result = new ScanResult { StartedUtc = DateTime.UtcNow.ToString("o") };
            int privilegeError; result.BackupPrivilegeEnabled = EnableBackup(out privilegeError); result.BackupPrivilegeError = privilegeError;
            // Refuse output beneath an existing reparse component; no ACL changes are made.
            string part = @"D:\";
            foreach (string segment in Output.Substring(3).Split('\\')) {
                part = Join(part, segment);
                if (Directory.Exists(part) && (File.GetAttributes(part) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("输出目录包含重解析点，已停止。");
            }
            Directory.CreateDirectory(Output);
            using (StreamWriter errors = NewWriter("errors.ndjson"))
            using (StreamWriter reparse = NewWriter("reparse-points.ndjson"))
            using (StreamWriter packages = NewWriter("package-size-matches.ndjson"))
            using (StreamWriter progress = NewWriter("progress.json"))
            using (StreamWriter gaps = NewWriter("unvisited-directories.ndjson")) {
                IntPtr buffer = Marshal.AllocHGlobal(BufferSize);
                IntPtr attributeBuffer = Marshal.AllocHGlobal(8);
                try {
                    foreach (string root in roots) {
                        VolumeResult volume = new VolumeResult { Root = root, StartedUtc = DateTime.UtcNow.ToString("o"), Status = "scanning" };
                        result.Volumes.Add(volume);
                        Stopwatch timer = Stopwatch.StartNew(); long lastProgress = -5000;
                        Stack<Frame> stack = new Stack<Frame>(); stack.Push(new Frame { Path = root });
                        bool expired = false;
                        while (stack.Count > 0) {
                            if (timer.Elapsed.TotalMinutes >= 20) { expired = true; break; }
                            Frame frame = stack.Pop();
                            if (timer.ElapsedMilliseconds - lastProgress >= 5000) {
                                Progress(progress, volume, timer, frame.Path, stack.Count, false);
                                errors.Flush(); reparse.Flush(); packages.Flush(); lastProgress = timer.ElapsedMilliseconds;
                            }
                            using (SafeFileHandle handle = CreateFileW(Native(frame.Path), 0x81, 7, IntPtr.Zero, 3, OpenFlags, IntPtr.Zero)) {
                                if (handle.IsInvalid) { Error(errors, result, volume, frame, "open-directory", Marshal.GetLastWin32Error()); continue; }
                                if (!GetFileInformationByHandleEx(handle, 9, attributeBuffer, 8)) { Error(errors, result, volume, frame, "verify-directory-attributes", Marshal.GetLastWin32Error()); continue; }
                                uint actualAttributes = unchecked((uint)Marshal.ReadInt32(attributeBuffer, 0));
                                if ((actualAttributes & ReparseAttribute) != 0) {
                                    Reparse(reparse, errors, result, volume, frame, actualAttributes);
                                    Error(errors, result, volume, frame, "directory-became-reparse-or-root-is-reparse", 0); continue;
                                }
                                if ((actualAttributes & DirectoryAttribute) == 0) { Error(errors, result, volume, frame, "directory-type-changed", 0); continue; }
                                bool firstBatch = true;
                                while (true) {
                                    if (timer.Elapsed.TotalMinutes >= 20) { expired = true; gaps.WriteLine("{\"path\":" + Quote(frame.Path) + ",\"reason\":\"partially-enumerated-time-budget\"}"); break; }
                                    if (!GetFileInformationByHandleEx(handle, firstBatch ? 15 : 14, buffer, BufferSize)) {
                                        int code = Marshal.GetLastWin32Error();
                                        if (code != 18) Error(errors, result, volume, frame, "enumerate-directory", code);
                                        break;
                                    }
                                    firstBatch = false; int offset = 0;
                                    while (true) {
                                        if (offset < 0 || offset > BufferSize - 68) { Error(errors, result, volume, frame, "invalid-entry-offset", 0); break; }
                                        int next = Marshal.ReadInt32(buffer, offset);
                                        uint attributes = unchecked((uint)Marshal.ReadInt32(buffer, offset + 56));
                                        int nameBytes = Marshal.ReadInt32(buffer, offset + 60);
                                        if (nameBytes < 0 || nameBytes % 2 != 0 || (long)offset + 68 + nameBytes > BufferSize || (next != 0 && (next < 68 + nameBytes || next % 8 != 0 || (long)offset + next > BufferSize - 68))) {
                                            Error(errors, result, volume, frame, "invalid-entry-layout", 0); break;
                                        }
                                        string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + 68), nameBytes / 2);
                                        if (name != "." && name != "..") {
                                            bool directory = (attributes & DirectoryAttribute) != 0, isReparse = (attributes & ReparseAttribute) != 0;
                                            long size = Math.Max(0, Marshal.ReadInt64(buffer, offset + 40));
                                            Frame child = frame.Child(Join(frame.Path, name));
                                            if (directory) volume.Directories++; else volume.Files++;
                                            if (isReparse) volume.ReparsePoints++; else if (!directory) volume.LogicalBytes += size;
                                            EachAggregate(result, frame, delegate(Aggregate a) { a.Add(directory, isReparse, size); });
                                            if (Equal(frame.Path, root)) child.Top = AddAggregate(result, child.Path, directory ? "top_directory" : "top_file");
                                            if (child.Primary < 0 && MatchName.IsMatch(name)) child.Primary = AddAggregate(result, child.Path, Equal(child.Path, Repository) ? "retained_repository" : "candidate_name_or_explicit_path");
                                            if (directory && Equal(name, "aibrowse") && !Equal(child.Path, Repository)) child.Profile = AddAggregate(result, child.Path, "profile_or_named_aibrowse_directory");
                                            if (directory && Equal(child.Path, FirstRelease)) child.First = AddAggregate(result, child.Path, "FIRST");
                                            if (Equal(child.Path, Repository + @"\log")) child.LogRoot = AddAggregate(result, child.Path, "repository_log");
                                            if (Equal(frame.Path, Repository + @"\log") && directory) child.LogGroup = AddAggregate(result, child.Path, "repository_log_subgroup");
                                            // New file roots contain that file; new directory roots count only descendants.
                                            if (!directory || isReparse) {
                                                int[] newIds = { child.Primary != frame.Primary ? child.Primary : -1, child.Top != frame.Top ? child.Top : -1,
                                                    child.Profile != frame.Profile ? child.Profile : -1, child.First != frame.First ? child.First : -1,
                                                    child.LogRoot != frame.LogRoot ? child.LogRoot : -1, child.LogGroup != frame.LogGroup ? child.LogGroup : -1 };
                                                foreach (int id in newIds) if (id >= 0) result.Aggregates[id].Add(directory, isReparse, size);
                                            }
                                            if (isReparse) Reparse(reparse, errors, result, volume, child, attributes);
                                            else if (directory) stack.Push(child);
                                            else {
                                                if (size == 119265470 || size == 119369728 || size == 239075328)
                                                    packages.WriteLine("{\"path\":" + Quote(child.Path) + ",\"logicalBytes\":" + size + ",\"basis\":\"size-only-not-content-identity\"}");
                                                if (Within(child.Path, Repository) && child.First < 0) KeepLargest(result.RepositoryLargestFiles, child.Path, size, 200);
                                                else if (!Within(child.Path, Repository) && child.Primary < 0 && size >= 104857600) KeepLargest(result.OutsideUnknownLargestFiles, child.Path, size, 100);
                                            }
                                        }
                                        if (next == 0) break;
                                        offset += next;
                                    }
                                    if (timer.ElapsedMilliseconds - lastProgress >= 5000) {
                                        Progress(progress, volume, timer, frame.Path, stack.Count, false);
                                        errors.Flush(); reparse.Flush(); packages.Flush(); lastProgress = timer.ElapsedMilliseconds;
                                    }
                                }
                            }
                            if (expired) break;
                        }
                        volume.PendingDirectories = stack.Count;
                        foreach (Frame pending in stack) gaps.WriteLine("{\"path\":" + Quote(pending.Path) + ",\"reason\":\"not-enumerated-time-budget\"}");
                        volume.Status = expired ? "time_budget_exceeded" : volume.Errors > 0 ? "enumerated_with_errors" : "enumerated";
                        volume.DurationSeconds = timer.Elapsed.TotalSeconds; volume.FinishedUtc = DateTime.UtcNow.ToString("o");
                        Progress(progress, volume, timer, null, stack.Count, true);
                        errors.Flush(); reparse.Flush(); packages.Flush(); gaps.Flush();
                    }
                } finally { Marshal.FreeHGlobal(buffer); Marshal.FreeHGlobal(attributeBuffer); }
            }
            result.FinishedUtc = DateTime.UtcNow.ToString("o"); return result;
        }
    }
}
'@

if (-not ('ProjectResidueAudit.Scanner' -as [type])) {
    Add-Type -TypeDefinition $source -Language CSharp
}
if ($CheckOnly) {
    Write-Output 'PowerShell 语法与 C# 原生目录枚举器编译通过；未执行扫描。'
    return
}

$outputRoot = 'D:\AIbrowse\log\maintenance\full-disk-audit-20261011-001'
if ($Roots.Count -eq 0) {
    $Roots = @(Get-Volume | Where-Object { $_.DriveType -eq 'Fixed' -and $_.FileSystem -eq 'NTFS' } | ForEach-Object {
        if ($_.DriveLetter) { [string]$_.DriveLetter + ':\' } else { $_.Path }
    })
    if ($Roots.Count -eq 0) { throw '未发现可枚举的固定NTFS卷。' }
}
$report = [ProjectResidueAudit.Scanner]::Run($Roots)
$json = $report | ConvertTo-Json -Depth 8
$summaryPath = Join-Path $outputRoot 'summary.json'
$stream = [System.IO.File]::Open($summaryPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
try {
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
    $stream.Write($bytes, 0, $bytes.Length)
} finally {
    $stream.Dispose()
}
Write-Output ('元数据清点结束，报告：' + $summaryPath)
$report.Volumes | Select-Object Root, Status, Files, Directories, Errors, DurationSeconds | Format-Table -AutoSize
