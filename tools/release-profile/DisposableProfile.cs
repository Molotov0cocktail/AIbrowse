using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace AIbrowse.ReleaseProfile
{
    public sealed class DisposableIdentity
    {
        public string Requested { get; set; } = "";
        public string FinalDos { get; set; } = "";
        public string FinalGuid { get; set; } = "";
        public string FinalNt { get; set; } = "";
        public string VolumeSerial64 { get; set; } = "";
        public string FileId128 { get; set; } = "";
        public string Sddl { get; set; } = "";
        public string FileSystem { get; set; } = "";
        public uint Attributes { get; set; }
    }

    public sealed class DisposableManifest
    {
        public int Version { get; set; } = 2;
        public string RunId { get; set; } = "";
        public string DeclaredProfile { get; set; } = "";
        public string ResolvedProfile { get; set; } = "";
        public string PackageExecutable { get; set; } = "";
        public string BindingJournal { get; set; } = "";
        public DisposableIdentity RootIdentity { get; set; } = new DisposableIdentity();
    }

    public sealed class TamperBinding
    {
        public int Version { get; set; } = 1;
        public string ProductJournal { get; set; } = "";
        public string ProductReport { get; set; } = "";
        public string ExecutableSha256 { get; set; } = "";
        public string AsarSha256 { get; set; } = "";
        public string AsarHeaderSha256 { get; set; } = "";
    }

    internal static class DisposableNative
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct BasicInfo
        {
            public uint Attributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
            public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FileIdInfo
        {
            public ulong VolumeSerialNumber;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public byte[] FileId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SecurityAttributes
        {
            public uint Length;
            public IntPtr SecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateDirectoryW(string path, IntPtr security);
        [DllImport("kernel32.dll", EntryPoint = "CreateDirectoryW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateDirectorySecure(string path, ref SecurityAttributes security);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle file, out BasicInfo info);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int type, out FileIdInfo info, uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool GetVolumeInformationByHandleW(SafeFileHandle file, StringBuilder volumeName, uint volumeNameSize,
            out uint serial, out uint componentLength, out uint flags, StringBuilder fileSystem, uint fileSystemSize);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetKernelObjectSecurity(SafeFileHandle handle, uint requested, byte[] descriptor, uint length, out uint required);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint length, uint flags);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern SafeFileHandle OpenProcess(uint access, bool inherit, uint processId);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool QueryFullProcessImageNameW(SafeFileHandle process, uint flags, StringBuilder image, ref uint length);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        internal static extern int GetPackageFullName(SafeFileHandle process, ref uint length, StringBuilder packageFullName);

        internal static SafeFileHandle Open(string path, bool directory, bool readData = false, uint share = 3)
        {
            uint access = 0x20080u | (readData ? 1u : 0u);
            SafeFileHandle handle = CreateFileW(path, access, share, IntPtr.Zero, 3,
                0x00200000u | (directory ? 0x02000000u : 0u), IntPtr.Zero);
            if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error(), "无法打开固定profile身份"); }
            return handle;
        }

        internal static void CreateDirectoryExclusive(string path)
        {
            if (!CreateDirectoryW(path, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "无法独占创建证据目录");
        }

        internal static void CreateDirectoryExclusive(string path, string sddl)
        {
            RawSecurityDescriptor descriptor = new RawSecurityDescriptor(sddl);
            byte[] bytes = new byte[descriptor.BinaryLength];
            descriptor.GetBinaryForm(bytes, 0);
            GCHandle pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            try
            {
                SecurityAttributes security = new SecurityAttributes {
                    Length = (uint)Marshal.SizeOf<SecurityAttributes>(),
                    SecurityDescriptor = pinned.AddrOfPinnedObject(),
                    Inherit = false
                };
                if (!CreateDirectorySecure(path, ref security))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "无法按固定ACL独占创建新profile根");
            }
            finally { pinned.Free(); }
        }

        internal static string ReadUtf8Bounded(SafeFileHandle handle, int maximumBytes)
        {
            long length = RandomAccess.GetLength(handle);
            if (length < 1 || length > maximumBytes) throw new InvalidOperationException("profile标记文件大小无效");
            byte[] bytes = new byte[(int)length];
            int offset = 0;
            while (offset < bytes.Length)
            {
                int count = RandomAccess.Read(handle, bytes.AsSpan(offset), offset);
                if (count == 0) throw new EndOfStreamException("profile标记文件读取不完整");
                offset += count;
            }
            if (RandomAccess.GetLength(handle) != length) throw new InvalidOperationException("profile标记文件读取期间发生变化");
            return new UTF8Encoding(false, true).GetString(bytes);
        }

        private static string FinalPath(SafeFileHandle handle, uint flags)
        {
            StringBuilder value = new StringBuilder(2048);
            uint length = GetFinalPathNameByHandleW(handle, value, (uint)value.Capacity, flags);
            if (length == 0 || length >= value.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法解析profile实际路径");
            return value.ToString();
        }

        internal static DisposableIdentity Identity(SafeFileHandle handle, string requested, bool directory)
        {
            if (!GetFileInformationByHandle(handle, out BasicInfo basic) ||
                !GetFileInformationByHandleEx(handle, 18, out FileIdInfo id, (uint)Marshal.SizeOf<FileIdInfo>()))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "无法读取128位文件身份");
            if ((basic.Attributes & 0x400) != 0 || ((basic.Attributes & 0x10) != 0) != directory)
                throw new InvalidOperationException("固定profile含重解析点或对象类型错误");
            if (!directory && basic.Links != 1) throw new InvalidOperationException("profile标记文件具有硬链接");
            GetKernelObjectSecurity(handle, 7, null, 0, out uint required);
            if (required == 0 || required > 65536) throw new InvalidOperationException("profile ACL超出预算");
            byte[] descriptor = new byte[required];
            if (!GetKernelObjectSecurity(handle, 7, descriptor, required, out required)) throw new Win32Exception(Marshal.GetLastWin32Error());
            StringBuilder fileSystem = new StringBuilder(64);
            if (!GetVolumeInformationByHandleW(handle, null, 0, out uint serial, out _, out _, fileSystem, 64))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "无法读取profile卷身份");
            if (fileSystem.ToString() != "NTFS" || (uint)id.VolumeSerialNumber != serial)
                throw new InvalidOperationException("profile实际句柄不在同一NTFS卷");
            return new DisposableIdentity {
                Requested = requested,
                FinalDos = FinalPath(handle, 0),
                FinalGuid = FinalPath(handle, 1),
                FinalNt = FinalPath(handle, 2),
                VolumeSerial64 = id.VolumeSerialNumber.ToString("X16"),
                FileId128 = Convert.ToHexString(id.FileId),
                Sddl = new RawSecurityDescriptor(descriptor, 0).GetSddlForm(AccessControlSections.Owner | AccessControlSections.Group | AccessControlSections.Access),
                FileSystem = fileSystem.ToString(),
                Attributes = basic.Attributes
            };
        }
    }

    internal sealed class DisposableLease : IDisposable
    {
        internal SafeFileHandle AliasHandle { get; }
        internal SafeFileHandle ResolvedHandle { get; }
        internal DisposableIdentity Identity { get; }
        internal string Declared { get; }
        internal string Resolved { get; }

        internal DisposableLease(bool requireEmpty)
        {
            string appData = Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData)).TrimEnd(Path.DirectorySeparatorChar);
            Declared = Path.Combine(appData, "aibrowse");
            if (!String.Equals(Declared, Path.GetFullPath(Declared), StringComparison.Ordinal)) throw new InvalidOperationException("KnownFolder profile路径不规范");
            AliasHandle = DisposableNative.Open(Declared, true);
            SafeFileHandle openedResolved = null;
            try
            {
                Identity = DisposableNative.Identity(AliasHandle, Declared, true);
                if (!Identity.FinalDos.StartsWith("\\\\?\\", StringComparison.Ordinal)) throw new InvalidOperationException("profile未解析为固定DOS实体路径");
                Resolved = Identity.FinalDos.Substring(4);
                openedResolved = DisposableNative.Open(Resolved, true);
                DisposableIdentity resolvedIdentity = DisposableNative.Identity(openedResolved, Resolved, true);
                DisposableProfile.Equal(Identity, resolvedIdentity);
                if (requireEmpty && Directory.EnumerateFileSystemEntries(Declared).Any()) throw new InvalidOperationException("固定KnownFolder profile不是空目录");
                ResolvedHandle = openedResolved;
                openedResolved = null;
            }
            catch
            {
                if (openedResolved != null) openedResolved.Dispose();
                AliasHandle.Dispose();
                throw;
            }
        }

        public void Dispose()
        {
            ResolvedHandle.Dispose();
            AliasHandle.Dispose();
        }
    }

    public static class DisposableProfile
    {
        public const string OwnerMarker = ".aibrowse-e1-synthetic-owner.json";

        private sealed class ExclusiveGuard : IDisposable
        {
            private readonly Mutex mutex;
            internal ExclusiveGuard()
            {
                mutex = new Mutex(false, "Local\\AIbrowse.ReleaseProfile.Disposable");
                bool acquired;
                try { acquired = mutex.WaitOne(0); }
                catch (AbandonedMutexException) { acquired = true; }
                if (!acquired)
                {
                    mutex.Dispose();
                    throw new InvalidOperationException("另一个disposable profile资格正在运行");
                }
            }
            public void Dispose()
            {
                mutex.ReleaseMutex();
                mutex.Dispose();
            }
        }

        private static string Repository()
        {
            string value = Environment.GetEnvironmentVariable("AIBROWSE_PROFILE_TOOL_REPOSITORY");
            if (String.IsNullOrEmpty(value)) throw new InvalidOperationException("缺少工具仓库绑定");
            return Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);
        }

        private sealed class ArchiveTransitionResult
        {
            internal string PreservedPath { get; set; } = "";
            internal DisposableIdentity PreservedIdentity { get; set; } = new DisposableIdentity();
            internal DisposableIdentity NewRootIdentity { get; set; } = new DisposableIdentity();
        }

        internal static void Equal(DisposableIdentity first, DisposableIdentity second)
        {
            if (first.FileId128 != second.FileId128 || first.VolumeSerial64 != second.VolumeSerial64 ||
                first.Sddl != second.Sddl || first.FileSystem != "NTFS" || second.FileSystem != "NTFS")
                throw new InvalidOperationException("KnownFolder别名与解析实体不是同一身份");
        }

        private static bool SecurityEquivalent(string first, string second)
        {
            RawSecurityDescriptor left = new RawSecurityDescriptor(first);
            RawSecurityDescriptor right = new RawSecurityDescriptor(second);
            if (left.Owner != right.Owner || left.Group != right.Group) return false;
            const ControlFlags allowedDifference = ControlFlags.DiscretionaryAclAutoInherited;
            if ((left.ControlFlags & ControlFlags.DiscretionaryAclPresent) == 0 ||
                (right.ControlFlags & ControlFlags.DiscretionaryAclPresent) == 0 ||
                (left.ControlFlags & ~allowedDifference) != (right.ControlFlags & ~allowedDifference) ||
                left.DiscretionaryAcl == null || right.DiscretionaryAcl == null)
                return false;
            byte[] leftAcl = new byte[left.DiscretionaryAcl.BinaryLength];
            byte[] rightAcl = new byte[right.DiscretionaryAcl.BinaryLength];
            left.DiscretionaryAcl.GetBinaryForm(leftAcl, 0);
            right.DiscretionaryAcl.GetBinaryForm(rightAcl, 0);
            return leftAcl.SequenceEqual(rightAcl);
        }

        public static bool SecurityEquivalentFixture(string first, string second)
        {
            return SecurityEquivalent(first, second);
        }

        private static void Durable(string path, string contents)
        {
            using (FileStream stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough))
            {
                byte[] bytes = Encoding.UTF8.GetBytes(contents + "\n");
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
        }

        private static string EvidenceRoot()
        {
            string value = Path.Combine(Repository(), "log", "stage7-e1", "disposable-profile");
            Directory.CreateDirectory(value);
            return value;
        }

        private static void SecureDirectory(string path)
        {
            DirectorySecurity security = new DirectorySecurity();
            SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            FileSystemAclExtensions.SetAccessControl(new DirectoryInfo(path), security);
        }

        private static void CheckProcesses()
        {
            foreach (string name in new[] { "aibrowse", "electron" })
            {
                Process[] processes = Process.GetProcessesByName(name);
                try { if (processes.Length != 0) throw new InvalidOperationException("AIbrowse或Electron进程仍存在"); }
                finally { foreach (Process process in processes) process.Dispose(); }
            }
        }

        public static string Preflight()
        {
            using (ExclusiveGuard guard = new ExclusiveGuard())
            {
                CheckProcesses();
                using (DisposableLease lease = new DisposableLease(true))
                {
                    return JsonSerializer.Serialize(new { ok = true, declaredProfile = lease.Declared, resolvedProfile = lease.Resolved, identity = lease.Identity, empty = true });
                }
            }
        }

        internal static DisposableManifest Load(string journal)
        {
            string expectedRoot = EvidenceRoot();
            journal = Path.GetFullPath(journal).TrimEnd(Path.DirectorySeparatorChar);
            if (Path.GetDirectoryName(journal) != expectedRoot || !Path.GetFileName(journal).StartsWith("journal-"))
                throw new InvalidOperationException("journal不属于固定证据目录");
            string file = Path.Combine(journal, "manifest.json");
            if (new FileInfo(file).Length > 32768) throw new InvalidOperationException("journal manifest超限");
            DisposableManifest manifest = JsonSerializer.Deserialize<DisposableManifest>(File.ReadAllText(file)) ?? throw new InvalidOperationException("journal manifest无效");
            if (manifest.Version != 2 || !Guid.TryParseExact(manifest.RunId, "N", out _) || Path.GetFileName(journal) != "journal-" + manifest.RunId)
                throw new InvalidOperationException("journal身份无效");
            return manifest;
        }

        private static void ValidateFailedTerminalElement(JsonElement root, string runId)
        {
            if (root.ValueKind != JsonValueKind.Object ||
                root.GetProperty("version").GetInt32() != 1 ||
                root.GetProperty("runId").GetString() != runId ||
                root.GetProperty("ok").GetBoolean() ||
                !root.GetProperty("jobReleased").GetBoolean() ||
                !root.GetProperty("markerValidated").GetBoolean())
                throw new InvalidOperationException("失败终态未证明Job归零与marker复验");
            JsonElement result = root.GetProperty("result");
            if (result.ValueKind != JsonValueKind.Null &&
                (result.ValueKind != JsonValueKind.Number || !result.TryGetUInt32(out uint exitCode) || exitCode == 0))
                throw new InvalidOperationException("失败终态没有非零或未知的根退出码");
        }

        private static void ValidateFailedTerminal(string journal, string runId)
        {
            string path = Path.Combine(journal, "terminal.json");
            FileInfo file = new FileInfo(path);
            if (!file.Exists || file.Length < 2 || file.Length > 16384) throw new InvalidOperationException("失败终态文件缺失或超限");
            using (JsonDocument terminal = JsonDocument.Parse(File.ReadAllText(path)))
            {
                ValidateFailedTerminalElement(terminal.RootElement, runId);
            }
        }

        private static string Sha256(string path)
        {
            using (FileStream stream = File.OpenRead(path))
            {
                return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
            }
        }

        private static TamperBinding ValidateTamperBinding(string journal, string packageRoot)
        {
            DisposableManifest manifest = Load(journal);
            ValidateFailedTerminal(journal, manifest.RunId);
            string archivePath = Path.Combine(journal, "archive.json");
            FileInfo archiveFile = new FileInfo(archivePath);
            if (!archiveFile.Exists || archiveFile.Length < 2 || archiveFile.Length > 65536)
                throw new InvalidOperationException("Product失败轮归档证据缺失或超限");
            using (JsonDocument archive = JsonDocument.Parse(File.ReadAllText(archivePath)))
            {
                JsonElement root = archive.RootElement;
                if (root.GetProperty("version").GetInt32() != 1 ||
                    root.GetProperty("runId").GetString() != manifest.RunId ||
                    !root.GetProperty("ok").GetBoolean() ||
                    String.IsNullOrEmpty(root.GetProperty("preservedPath").GetString()))
                    throw new InvalidOperationException("Product失败轮未完成固定归档");
            }
            string combinedPath = Path.Combine(journal, "runner-output", "combined-failure.json");
            FileInfo combinedFile = new FileInfo(combinedPath);
            if (!combinedFile.Exists || combinedFile.Length < 2 || combinedFile.Length > 16384)
                throw new InvalidOperationException("All失败绑定原件缺失或超限");
            using (JsonDocument combined = JsonDocument.Parse(File.ReadAllText(combinedPath)))
            {
                JsonElement root = combined.RootElement;
                if (root.GetProperty("ok").GetBoolean() || root.GetProperty("error").GetString() != "固定tamper资格失败")
                    throw new InvalidOperationException("All失败未限定在Tamper阶段");
            }
            string productRoot = Path.Combine(journal, "runner-output", "product");
            string[] reports = Directory.GetFiles(productRoot, "report.json", SearchOption.AllDirectories);
            if (reports.Length != 1) throw new InvalidOperationException("Product成功报告数量无效");
            string reportPath = reports[0];
            FileInfo reportFile = new FileInfo(reportPath);
            if (reportFile.Length < 2 || reportFile.Length > 1048576)
                throw new InvalidOperationException("Product成功报告大小无效");
            string executable = Path.Combine(packageRoot, "AIbrowse.exe");
            string asar = Path.Combine(packageRoot, "resources", "app.asar");
            string executableSha256 = Sha256(executable);
            string asarSha256 = Sha256(asar);
            string asarHeaderSha256;
            using (JsonDocument report = JsonDocument.Parse(File.ReadAllText(reportPath)))
            {
                JsonElement root = report.RootElement;
                JsonElement package = root.GetProperty("package");
                asarHeaderSha256 = package.GetProperty("asarHeaderSha256").GetString() ?? "";
                string recordedExecutable = package.GetProperty("executableSha256").GetString() ?? "";
                string recordedAsar = package.GetProperty("asarSha256").GetString() ?? "";
                string evidenceDirectory = Path.GetFullPath(root.GetProperty("evidenceDirectory").GetString() ?? "");
                if (!root.GetProperty("ok").GetBoolean() ||
                    recordedExecutable != executableSha256 || recordedAsar != asarSha256 ||
                    Path.GetDirectoryName(reportPath) != evidenceDirectory || asarHeaderSha256.Length != 64)
                    throw new InvalidOperationException("Product报告与当前候选字节未绑定");
            }
            return new TamperBinding {
                ProductJournal = journal,
                ProductReport = reportPath,
                ExecutableSha256 = executableSha256,
                AsarSha256 = asarSha256,
                AsarHeaderSha256 = asarHeaderSha256
            };
        }

        public static string ValidateTamperBindingEvidence(string journal, string packageRoot)
        {
            packageRoot = Path.GetFullPath(packageRoot).TrimEnd(Path.DirectorySeparatorChar);
            return JsonSerializer.Serialize(ValidateTamperBinding(journal, packageRoot));
        }

        public static string ValidateFailedTerminalFixture(string contents, string runId)
        {
            if (!Guid.TryParseExact(runId, "N", out _) || contents.Length > 16384) throw new InvalidOperationException("终态夹具输入无效");
            using (JsonDocument terminal = JsonDocument.Parse(contents))
            {
                ValidateFailedTerminalElement(terminal.RootElement, runId);
            }
            return runId;
        }

        private static JsonDocument ParseCompletedEvidence(string contents, int maximumBytes)
        {
            if (Encoding.UTF8.GetByteCount(contents) > maximumBytes)
                throw new InvalidOperationException("成功归档证据超限");
            JsonDocument document = JsonDocument.Parse(contents, new JsonDocumentOptions { MaxDepth = 32 });
            try { RejectDuplicateEvidenceProperties(document.RootElement); return document; }
            catch { document.Dispose(); throw; }
        }

        private static void RejectDuplicateEvidenceProperties(JsonElement element)
        {
            if (element.ValueKind == JsonValueKind.Object)
            {
                HashSet<string> names = new HashSet<string>(StringComparer.Ordinal);
                foreach (JsonProperty property in element.EnumerateObject())
                {
                    if (!names.Add(property.Name)) throw new InvalidOperationException("成功归档证据含重复字段");
                    RejectDuplicateEvidenceProperties(property.Value);
                }
            }
            else if (element.ValueKind == JsonValueKind.Array)
                foreach (JsonElement item in element.EnumerateArray()) RejectDuplicateEvidenceProperties(item);
        }

        private static string ValidateCompletedTerminal(string contents, string runId)
        {
            if (!Guid.TryParseExact(runId, "N", out _)) throw new InvalidOperationException("成功终态runId无效");
            using (JsonDocument terminal = ParseCompletedEvidence(contents, 16384))
            {
                JsonElement root = terminal.RootElement;
                string[] fields = { "version", "runId", "ok", "result", "jobReleased", "markerValidated", "failureType", "failureMessage" };
                if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != fields.Length ||
                    root.EnumerateObject().Any(property => !fields.Contains(property.Name)) ||
                    root.GetProperty("version").GetInt32() != 1 || root.GetProperty("runId").GetString() != runId ||
                    !root.GetProperty("ok").GetBoolean() || !root.GetProperty("result").TryGetUInt32(out uint result) || result != 0 ||
                    !root.GetProperty("jobReleased").GetBoolean() || !root.GetProperty("markerValidated").GetBoolean() ||
                    root.GetProperty("failureType").GetString() != "" || root.GetProperty("failureMessage").GetString() != "")
                    throw new InvalidOperationException("成功终态未证明正常退出、Job归零与marker复验");
            }
            return runId;
        }

        public static string ValidateCompletedTerminalFixture(string contents, string runId)
        {
            return ValidateCompletedTerminal(contents, runId);
        }

        private static bool CompletedHash(string value)
        {
            return value != null && value.Length == 64 && value.All(c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));
        }

        private static string ValidateCompletedArchiveElements(string terminal, string report, string binding,
            DisposableManifest manifest, string reportDirectory)
        {
            ValidateCompletedTerminal(terminal, manifest.RunId);
            using (JsonDocument parsedReport = ParseCompletedEvidence(report, 1048576))
            using (JsonDocument parsedBinding = ParseCompletedEvidence(binding, 16384))
            {
                JsonElement root = parsedReport.RootElement;
                JsonElement bound = parsedBinding.RootElement;
                JsonElement profile = root.GetProperty("profileIsolation");
                JsonElement package = root.GetProperty("package");
                JsonElement process = root.GetProperty("original").GetProperty("processIdentity");
                if (String.IsNullOrEmpty(manifest.BindingJournal) || bound.GetProperty("Version").GetInt32() != 1 ||
                    bound.GetProperty("ProductJournal").GetString() != manifest.BindingJournal ||
                    !root.GetProperty("ok").GetBoolean() || profile.GetProperty("version").GetInt32() != 2 ||
                    profile.GetProperty("runId").GetString() != manifest.RunId ||
                    profile.GetProperty("syntheticFileId").GetString() != manifest.RootIdentity.FileId128 ||
                    process.GetProperty("label").GetString() != "TamperOriginal" ||
                    process.GetProperty("imagePath").GetString() != manifest.PackageExecutable ||
                    process.GetProperty("probeRootFileId128").GetString() != manifest.RootIdentity.FileId128 ||
                    process.GetProperty("probeRootVolumeSerial64").GetString() != manifest.RootIdentity.VolumeSerial64 ||
                    Path.Combine(root.GetProperty("appData").GetString() ?? "", "aibrowse") != manifest.DeclaredProfile ||
                    root.GetProperty("evidenceDirectory").GetString() != reportDirectory)
                    throw new InvalidOperationException("成功报告与本轮profile、候选或证据目录不一致");
                foreach (string field in new[] { "ExecutableSha256", "AsarSha256", "AsarHeaderSha256" })
                {
                    string hash = bound.GetProperty(field).GetString();
                    string reportField = Char.ToLowerInvariant(field[0]) + field.Substring(1);
                    if (!CompletedHash(hash) || package.GetProperty(reportField).GetString() != hash)
                        throw new InvalidOperationException("成功报告与原Tamper候选摘要不一致");
                }
            }
            return manifest.RunId;
        }

        // Read-only fixture seam; the real entry uses the same validators with pinned files.
        public static string ValidateCompletedArchiveFixture(string terminal, string report, string binding,
            DisposableManifest manifest, string reportDirectory)
        {
            return ValidateCompletedArchiveElements(terminal, report, binding, manifest, reportDirectory);
        }

        private static readonly string[] ProductTransferSources = {
            "tools/data-qualification/product-transfer/run.ts",
            "tools/data-qualification/product-transfer/ui-driver.ps1",
            "tools/data-qualification/product-transfer/NativeSaveControl.cs",
            "tools/data-qualification/product-transfer/NativeSaveButton.cs",
            "tools/data-qualification/product-transfer/job-budget.ps1",
            "tools/data-qualification/product-transfer/JobBudget.cs",
            "tools/data-qualification/product-transfer/backup-evidence.ts",
            "tools/release-profile/disposable-profile.ps1",
            "tools/release-profile/DisposableProfile.cs",
            "tools/release-profile/ProfileIsolation.cs",
            "tools/release-profile/JobProcess.cs",
            "tools/release-profile/ReleaseDataIdentity.cs",
            "tools/release/ProductWindow.cs",
            "tools/release/package-policy.ts",
            "tools/release/profile-isolation-policy.ts",
            "tools/release/process-identity-probe.ts"
        };

        private static void ProductFact(bool condition)
        {
            if (!condition) throw new InvalidOperationException("ProductTransfer成功归档证据不完整或不一致");
        }

        private static void ProductFields(JsonElement value, params string[] names)
        {
            ProductFact(value.ValueKind == JsonValueKind.Object && value.EnumerateObject().Count() == names.Length &&
                value.EnumerateObject().All(property => names.Contains(property.Name)));
        }

        private static bool EvidenceEqual(JsonElement first, JsonElement second)
        {
            if (first.ValueKind != second.ValueKind) return false;
            switch (first.ValueKind)
            {
                case JsonValueKind.Object:
                    return first.EnumerateObject().Count() == second.EnumerateObject().Count() &&
                        first.EnumerateObject().All(property => second.TryGetProperty(property.Name, out JsonElement other) && EvidenceEqual(property.Value, other));
                case JsonValueKind.Array:
                    return first.GetArrayLength() == second.GetArrayLength() &&
                        first.EnumerateArray().Zip(second.EnumerateArray(), EvidenceEqual).All(equal => equal);
                case JsonValueKind.String: return first.GetString() == second.GetString();
                // The Node report projects helper JSON numbers through IEEE-754.
                // Exact process creation identity is separately bound as a string.
                case JsonValueKind.Number:
                    return first.TryGetDouble(out double left) && second.TryGetDouble(out double right) &&
                        Double.IsFinite(left) && Double.IsFinite(right) && left == right;
                case JsonValueKind.True:
                case JsonValueKind.False:
                case JsonValueKind.Null: return true;
                default: return false;
            }
        }

        private static void ProductStrings(JsonElement value, params string[] expected)
        {
            ProductFact(value.ValueKind == JsonValueKind.Array && value.GetArrayLength() == expected.Length);
            for (int index = 0; index < expected.Length; index++) ProductFact(value[index].GetString() == expected[index]);
        }

        private static bool ProductDecimal(string value, bool positive = false)
        {
            return value != null && value.Length > 0 && value.Length <= 20 && value.All(c => c >= '0' && c <= '9') &&
                UInt64.TryParse(value, out ulong number) && (!positive || number > 0);
        }

        private static void ProductLimits(JsonElement limits)
        {
            string[] names = { "runnerMs", "outerJobMs", "outerExitMs", "uiMs", "jobProcesses", "main", "guardian", "chromium", "utilityIncludingChromiumService", "toolProcesses" };
            int[] values = { 480000, 600000, 30000, 30000, 24, 1, 1, 16, 2, 4 };
            ProductFields(limits, names);
            for (int index = 0; index < names.Length; index++) ProductFact(limits.GetProperty(names[index]).GetInt32() == values[index]);
        }

        private static void ProductProfile(JsonElement profile, DisposableManifest manifest)
        {
            ProductFields(profile, "version", "runId", "syntheticFileId", "nodeView");
            ProductFact(profile.GetProperty("version").GetInt32() == 2 && profile.GetProperty("runId").GetString() == manifest.RunId &&
                profile.GetProperty("syntheticFileId").GetString() == manifest.RootIdentity.FileId128);
            JsonElement node = profile.GetProperty("nodeView");
            ProductFields(node, "declared", "resolved");
            foreach (string view in new[] { "declared", "resolved" })
            {
                ProductFields(node.GetProperty(view), "dev", "ino");
                foreach (string part in new[] { "dev", "ino" }) ProductFact(ProductDecimal(node.GetProperty(view).GetProperty(part).GetString()));
            }
            ProductFact(EvidenceEqual(node.GetProperty("declared"), node.GetProperty("resolved")));
        }

        private static void ProductManifest(JsonElement manifest)
        {
            ProductFields(manifest, "Version", "RunId", "DeclaredProfile", "ResolvedProfile", "PackageExecutable", "BindingJournal", "RootIdentity");
            foreach (string name in new[] { "DeclaredProfile", "ResolvedProfile", "PackageExecutable" })
            {
                string path = manifest.GetProperty(name).GetString();
                ProductFact(!String.IsNullOrEmpty(path) && path.Length <= 2048 && Path.IsPathFullyQualified(path));
            }
            JsonElement identity = manifest.GetProperty("RootIdentity");
            ProductFields(identity, "Requested", "FinalDos", "FinalGuid", "FinalNt", "VolumeSerial64", "FileId128", "Sddl", "FileSystem", "Attributes");
            foreach (string name in new[] { "Requested", "FinalDos", "FinalGuid", "FinalNt", "Sddl" })
                ProductFact(!String.IsNullOrEmpty(identity.GetProperty(name).GetString()));
            string file = identity.GetProperty("FileId128").GetString(), volume = identity.GetProperty("VolumeSerial64").GetString();
            ProductFact(file != null && file.Length == 32 && volume != null && volume.Length == 16 &&
                (file + volume).All(c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) &&
                identity.GetProperty("FileSystem").GetString() == "NTFS" && (identity.GetProperty("Attributes").GetUInt32() & 0x410) == 0x10);
        }

        private static void ProductBackup(JsonElement backup)
        {
            ProductFields(backup, "bytes", "sha256", "snapshotId", "productVersion", "members");
            long bytes = backup.GetProperty("bytes").GetInt64();
            string version = backup.GetProperty("productVersion").GetString();
            ProductFact(bytes > 0 && bytes <= 5L * 1024 * 1024 * 1024 && CompletedHash(backup.GetProperty("sha256").GetString()) &&
                Guid.TryParseExact(backup.GetProperty("snapshotId").GetString(), "D", out _) &&
                version != null && version.Length >= 1 && version.Length <= 64 && version.All(c => c >= 32 && c <= 126));
            JsonElement members = backup.GetProperty("members");
            ProductFact(members.ValueKind == JsonValueKind.Array && members.GetArrayLength() == 4);
            string[] ids = { "sources", "research", "watch", "conversations" };
            int[] schemas = { 1, 1, 5, 1 };
            long[] limits = { 512L << 20, 64L << 20, 512L << 20, 3201L << 20 };
            for (int index = 0; index < ids.Length; index++)
            {
                JsonElement row = members[index];
                ProductFields(row, "id", "present", "schemaVersion", "bytes", "sha256");
                long size = row.GetProperty("bytes").GetInt64();
                ProductFact(row.GetProperty("id").GetString() == ids[index] && row.GetProperty("schemaVersion").GetInt32() == schemas[index] && size >= 0 && size <= limits[index]);
                ProductFact(row.GetProperty("present").GetBoolean()
                    ? CompletedHash(row.GetProperty("sha256").GetString())
                    : size == 0 && row.GetProperty("sha256").ValueKind == JsonValueKind.Null);
            }
        }

        private static void ProductJob(JsonElement job)
        {
            ProductFields(job, "version", "hardTotalLimit", "limitFlags", "sampledCounts", "total", "identities");
            ProductFact(job.GetProperty("version").GetInt32() == 1 && job.GetProperty("hardTotalLimit").GetInt32() == 24 &&
                (job.GetProperty("limitFlags").GetUInt32() & 0x2008) == 0x2008);
            JsonElement counts = job.GetProperty("sampledCounts"), identities = job.GetProperty("identities");
            string[] names = { "main", "guardian", "chromium", "utility", "tools" };
            int[] maxima = { 1, 1, 16, 2, 4 };
            ProductFields(counts, names);
            int total = 0;
            for (int index = 0; index < names.Length; index++)
            {
                int count = counts.GetProperty(names[index]).GetInt32();
                ProductFact(count >= 0 && count <= maxima[index]); total += count;
            }
            ProductFact(total > 0 && total <= 24 && job.GetProperty("total").GetInt32() == total &&
                identities.ValueKind == JsonValueKind.Array && identities.GetArrayLength() == total);
            HashSet<uint> pids = new HashSet<uint>();
            foreach (JsonElement process in identities.EnumerateArray())
            {
                ProductFields(process, "Pid", "CreatedFileTime", "Image");
                uint pid = process.GetProperty("Pid").GetUInt32();
                string image = process.GetProperty("Image").GetString();
                ProductFact(pid > 0 && pids.Add(pid) && process.GetProperty("CreatedFileTime").GetInt64() > 0 &&
                    image != null && image.Length <= 2048 && Path.IsPathFullyQualified(image));
            }
        }

        private static void ValidateProductCompletedElements(JsonElement launch, JsonElement report, JsonElement backup,
            JsonElement process, JsonElement job, JsonElement dialog, DisposableManifest manifest)
        {
            ProductFields(launch, "version", "scenario", "ok", "limits", "nonClaims", "profile", "toolSources", "package", "phase", "productArguments", "environmentOverrides", "providerCalls");
            ProductFields(report, "version", "scenario", "ok", "limits", "nonClaims", "profile", "toolSources", "package", "product", "dialogQualification", "cancelAction", "saveAction", "backup", "finalJobSample", "phase", "elapsedMs", "productExited", "productExitCode", "pendingOriginals", "unconfirmedChildren", "requiresOuterTerminal");
            foreach (JsonElement item in new[] { launch, report })
            {
                ProductFact(item.GetProperty("version").GetInt32() == 1 && item.GetProperty("scenario").GetString() == "small-backup-cancel-save-readback");
                ProductLimits(item.GetProperty("limits"));
                ProductStrings(item.GetProperty("nonClaims"), "完整容量", "恢复确认与重启", "独立机器", "SQLite业务语义", "真实Provider");
                ProductProfile(item.GetProperty("profile"), manifest);
                ProductFields(item.GetProperty("toolSources"), ProductTransferSources);
            }
            foreach (string field in new[] { "limits", "nonClaims", "profile", "toolSources", "package" }) ProductFact(EvidenceEqual(launch.GetProperty(field), report.GetProperty(field)));
            ProductFact(!launch.GetProperty("ok").GetBoolean() && launch.GetProperty("phase").GetString() == "package" && launch.GetProperty("providerCalls").GetInt32() == 0);
            ProductStrings(launch.GetProperty("productArguments"), "--force-renderer-accessibility");
            ProductStrings(launch.GetProperty("environmentOverrides"));
            double elapsed = report.GetProperty("elapsedMs").GetDouble();
            ProductFact(report.GetProperty("ok").GetBoolean() && report.GetProperty("phase").GetString() == "exit" &&
                Double.IsFinite(elapsed) && elapsed >= 0 && elapsed < 480000 && report.GetProperty("productExited").GetBoolean() &&
                report.GetProperty("productExitCode").GetInt32() == 0 && report.GetProperty("unconfirmedChildren").GetInt32() == 0 && report.GetProperty("requiresOuterTerminal").GetBoolean());
            ProductStrings(report.GetProperty("pendingOriginals"));
            ProductFields(process, "version", "runId", "pid", "label", "processCreatedFileTime", "imagePath", "packageStatus", "packageFullName", "probeRootFileId128", "probeRootVolumeSerial64");
            JsonElement product = report.GetProperty("product");
            ProductFields(product, "pid", "label", "processCreatedFileTime", "imagePath", "packageStatus", "packageFullName", "probeRootFileId128", "probeRootVolumeSerial64");
            foreach (JsonProperty field in product.EnumerateObject()) ProductFact(EvidenceEqual(field.Value, process.GetProperty(field.Name)));
            int status = process.GetProperty("packageStatus").GetInt32();
            string packageName = process.GetProperty("packageFullName").GetString();
            ProductFact(process.GetProperty("version").GetInt32() == 1 && process.GetProperty("runId").GetString() == manifest.RunId &&
                process.GetProperty("label").GetString() == "ProductOriginal" && process.GetProperty("pid").GetUInt32() > 0 &&
                ProductDecimal(process.GetProperty("processCreatedFileTime").GetString(), true) && process.GetProperty("imagePath").GetString() == manifest.PackageExecutable &&
                process.GetProperty("probeRootFileId128").GetString() == manifest.RootIdentity.FileId128 && process.GetProperty("probeRootVolumeSerial64").GetString() == manifest.RootIdentity.VolumeSerial64 &&
                packageName != null && (status == 15700 ? packageName == "" : status == 0 && packageName.Length > 0 && packageName.Length <= 4096));
            JsonElement package = report.GetProperty("package");
            ProductFields(package, "packageRoot", "executable", "executableSha256", "asar", "asarSha256", "asarHeaderSha256", "integrityResource", "fuseVersion", "files", "rendererAssets", "externalPackages", "guardianSha256");
            string packageRoot = Path.GetDirectoryName(manifest.PackageExecutable);
            ProductFact(package.GetProperty("executable").GetString() == "AIbrowse.exe" && package.GetProperty("packageRoot").GetString() == packageRoot &&
                package.GetProperty("asar").GetString() == "resources/app.asar" && package.GetProperty("fuseVersion").GetString() == "1");
            foreach (string field in new[] { "executableSha256", "asarSha256", "asarHeaderSha256", "guardianSha256" }) ProductFact(CompletedHash(package.GetProperty(field).GetString()));
            JsonElement integrity = package.GetProperty("integrityResource");
            ProductFields(integrity, "file", "alg", "value");
            ProductFact((integrity.GetProperty("file").GetString() ?? "").Replace('/', '\\').ToLowerInvariant() == "resources\\app.asar" &&
                integrity.GetProperty("alg").GetString() == "sha256" && integrity.GetProperty("value").GetString() == package.GetProperty("asarHeaderSha256").GetString());
            foreach (string field in new[] { "files", "rendererAssets", "externalPackages" })
                ProductFact(package.GetProperty(field).ValueKind == JsonValueKind.Array && package.GetProperty(field).EnumerateArray().All(item => item.ValueKind == JsonValueKind.String));
            ProductBackup(backup);
            ProductFact(EvidenceEqual(backup, report.GetProperty("backup")) && EvidenceEqual(job, report.GetProperty("finalJobSample")) && EvidenceEqual(dialog, report.GetProperty("dialogQualification")));
            ProductJob(job);
            ProductDialog(dialog, product, "InspectSaveDialog");
        }

        private static void ProductDialog(JsonElement dialog, JsonElement product, string action)
        {
            string[] fields = { "version", "action", "ok", "phase", "elapsedMs", "filenameHostStructure", "filenameNativeSelection", "filenameInitialValueClass", "dialog" };
            ProductFields(dialog, action == "InspectSaveDialog" ? fields : fields.Concat(new[] { "buttonAction" }).ToArray());
            // The successful helper retains its initial diagnostic phase; failures replace it.
            ProductFact(dialog.GetProperty("version").GetInt32() == 1 && dialog.GetProperty("action").GetString() == action && dialog.GetProperty("ok").GetBoolean() &&
                dialog.GetProperty("phase").GetString() == "identity" && dialog.GetProperty("elapsedMs").GetInt64() >= 0 && dialog.GetProperty("elapsedMs").GetInt64() < 30000 &&
                new[] { "exact-default", "exact-stem" }.Contains(dialog.GetProperty("filenameInitialValueClass").GetString()));
            JsonElement window = dialog.GetProperty("dialog");
            ProductFields(window, "hwnd", "owner", "processId", "filenameIdClass", "filenameControlType", "saveName", "cancelName", "mechanism", "saveButton", "cancelButton");
            ProductFact(window.GetProperty("hwnd").GetInt64() != 0 && window.GetProperty("owner").GetInt64() != 0 &&
                window.GetProperty("hwnd").GetInt64() != window.GetProperty("owner").GetInt64() && window.GetProperty("processId").GetUInt32() == product.GetProperty("pid").GetUInt32() &&
                window.GetProperty("filenameIdClass").GetString() == "id-1001" && window.GetProperty("filenameControlType").GetString() == "native-edit" &&
                window.GetProperty("mechanism").GetString() == "Win32 fixed text / MSAA default action" &&
                new[] { "保存", "保存(S)", "保存(&S)", "Save", "&Save" }.Contains(window.GetProperty("saveName").GetString()) &&
                new[] { "取消", "Cancel" }.Contains(window.GetProperty("cancelName").GetString()));
            JsonElement structure = dialog.GetProperty("filenameHostStructure");
            ProductFields(structure, "version", "status", "scannedNodes", "hostCount", "ancestorCount", "descendantCount", "nodes");
            int ancestors = structure.GetProperty("ancestorCount").GetInt32(), descendants = structure.GetProperty("descendantCount").GetInt32();
            int scanned = structure.GetProperty("scannedNodes").GetInt32();
            ProductFact(structure.GetProperty("version").GetInt32() == 1 && structure.GetProperty("status").GetString() == "complete" &&
                structure.GetProperty("hostCount").GetInt32() == 1 && ancestors >= 1 && ancestors <= 8 && descendants >= 1 && descendants <= 16 &&
                scanned >= ancestors + descendants + 1 && scanned <= 512);
            JsonElement nodes = structure.GetProperty("nodes");
            ProductFact(nodes.ValueKind == JsonValueKind.Array && nodes.GetArrayLength() == ancestors + descendants + 1);
            int nativeCandidates = 0;
            for (int index = 0; index < nodes.GetArrayLength(); index++)
            {
                JsonElement node = nodes[index];
                ProductFields(node, "index", "parent", "relation", "automationIdClass", "controlTypeClass", "windowClass", "sameProcess", "enabled", "offscreen", "valuePattern", "readOnly");
                int parent = node.GetProperty("parent").GetInt32();
                ProductFact(node.GetProperty("index").GetInt32() == index && (index == 0 ? parent == -1 : parent >= 0 && parent < index));
                string relation = node.GetProperty("relation").GetString();
                // The fixed producer emits the ancestor chain, then host, then its subtree.
                ProductFact(relation == (index < ancestors ? "ancestor" : index == ancestors ? "host" : "descendant") &&
                    (index <= ancestors ? parent == index - 1 : parent >= ancestors));
                ProductFact(new[] { "empty", "id-1001", "file-name-control-host", "other" }.Contains(node.GetProperty("automationIdClass").GetString()) &&
                    new[] { "edit", "combo-box", "pane", "custom", "group", "window", "button", "text", "other" }.Contains(node.GetProperty("controlTypeClass").GetString()) &&
                    new[] { "empty", "dialog", "edit", "combo-box", "combo-box-ex32", "direct-ui", "dui-view", "file-name-control-host", "button", "static", "other" }.Contains(node.GetProperty("windowClass").GetString()));
                foreach (string flag in new[] { "sameProcess", "enabled", "offscreen", "valuePattern" }) node.GetProperty(flag).GetBoolean();
                ProductFact(node.GetProperty("valuePattern").GetBoolean()
                    ? node.GetProperty("readOnly").ValueKind == JsonValueKind.True || node.GetProperty("readOnly").ValueKind == JsonValueKind.False
                    : node.GetProperty("readOnly").ValueKind == JsonValueKind.Null);
                if (index == ancestors)
                    ProductFact(node.GetProperty("automationIdClass").GetString() == "file-name-control-host" &&
                        node.GetProperty("sameProcess").GetBoolean() && node.GetProperty("enabled").GetBoolean() && !node.GetProperty("offscreen").GetBoolean());
                else
                    ProductFact(node.GetProperty("automationIdClass").GetString() != "file-name-control-host");
                if (index > ancestors && node.GetProperty("automationIdClass").GetString() == "id-1001" && node.GetProperty("windowClass").GetString() == "edit")
                {
                    nativeCandidates++;
                    ProductFact(node.GetProperty("sameProcess").GetBoolean() && node.GetProperty("enabled").GetBoolean() && !node.GetProperty("offscreen").GetBoolean());
                }
            }
            ProductFact(nativeCandidates == 1 && nodes.EnumerateArray().Count(node => node.GetProperty("relation").GetString() == "ancestor") == ancestors &&
                nodes.EnumerateArray().Count(node => node.GetProperty("relation").GetString() == "descendant") == descendants &&
                nodes.EnumerateArray().Count(node => node.GetProperty("relation").GetString() == "host") == 1);
            JsonElement selection = dialog.GetProperty("filenameNativeSelection");
            ProductFields(selection, "status", "candidates", "nativeHandlePresent");
            ProductFact(selection.GetProperty("status").GetString() == "uia-bound" && selection.GetProperty("candidates").GetInt32() == 1 && selection.GetProperty("nativeHandlePresent").GetBoolean());
            ProductButton(window.GetProperty("saveButton"), 1);
            ProductButton(window.GetProperty("cancelButton"), 2);
            if (action != "InspectSaveDialog") {
                int controlId = action == "CancelSave" ? 2 : 1;
                ProductButton(dialog.GetProperty("buttonAction"), controlId);
                ProductFact(EvidenceEqual(dialog.GetProperty("buttonAction"), window.GetProperty(controlId == 1 ? "saveButton" : "cancelButton")));
            }
        }

        private static void ProductButton(JsonElement proof, int controlId)
        {
            ProductFields(proof, "version", "mechanism", "controlId", "nameClass", "hresult", "role", "available", "visible", "defaultActionPresent", "nativeIdentityVerified");
            ProductFact(proof.GetProperty("version").GetInt32() == 1 && proof.GetProperty("mechanism").GetString() == "MSAA CHILDID_SELF" &&
                proof.GetProperty("controlId").GetInt32() == controlId && proof.GetProperty("nameClass").GetString() == (controlId == 1 ? "save" : "cancel") &&
                proof.GetProperty("hresult").GetInt32() == 0 && proof.GetProperty("role").GetInt32() == 43 &&
                proof.GetProperty("available").GetBoolean() && proof.GetProperty("visible").GetBoolean() &&
                proof.GetProperty("defaultActionPresent").GetBoolean() && proof.GetProperty("nativeIdentityVerified").GetBoolean());
        }

        private sealed class CompletedArchiveEvidence : IDisposable
        {
            private readonly List<IDisposable> held = new List<IDisposable>();
            private readonly HashSet<string> pinnedDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            private readonly Stopwatch readBudget = Stopwatch.StartNew();
            private long metadataBytes;
            internal DisposableManifest Manifest { get; private set; }
            internal Dictionary<string, string> Hashes { get; } = new Dictionary<string, string>();
            internal string Journal { get; private set; }
            internal string Kind { get; private set; } = "completed-tamper";

            private void CheckBudget()
            {
                if (readBudget.ElapsedMilliseconds >= 150000)
                    throw new InvalidOperationException("成功归档证据统一读取期限耗尽；原件保留");
            }

            private void PinDirectory(string path)
            {
                path = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar);
                if (pinnedDirectories.Add(path)) held.Add(new Scope(path));
            }

            private string ReadHash(string path, long maximumBytes, string key, out long length, long? expectedLength = null)
            {
                CheckBudget();
                PinDirectory(Path.GetDirectoryName(path));
                SafeFileHandle handle = DisposableNative.Open(path, false, true, 1);
                held.Add(handle);
                DisposableNative.Identity(handle, path, false);
                length = RandomAccess.GetLength(handle);
                if (length < 1 || length > maximumBytes || (expectedLength.HasValue && length != expectedLength.Value))
                    throw new InvalidOperationException("成功归档文件长度或读取预算不符；原件保留");
                byte[] buffer = new byte[65536];
                long offset = 0;
                using (IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
                {
                    while (offset < length)
                    {
                        CheckBudget();
                        int count = RandomAccess.Read(handle, buffer.AsSpan(0, (int)Math.Min(buffer.Length, length - offset)), offset);
                        CheckBudget();
                        if (count == 0) throw new EndOfStreamException("成功归档文件读取不完整");
                        hash.AppendData(buffer, 0, count);
                        offset += count;
                    }
                    if (RandomAccess.GetLength(handle) != length) throw new InvalidOperationException("成功归档文件身份已变化");
                    string value = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
                    Hashes.Add(key, value);
                    return value;
                }
            }

            private string Read(string relative, int maximumBytes)
            {
                CheckBudget();
                string path = Path.Combine(Journal, relative);
                SafeFileHandle handle = DisposableNative.Open(path, false, true, 1);
                held.Add(handle);
                DisposableNative.Identity(handle, path, false);
                long length = RandomAccess.GetLength(handle);
                if (length < 1 || length > maximumBytes || length > 8L * 1024 * 1024 - metadataBytes)
                    throw new InvalidOperationException("成功归档元数据累计读取预算超限");
                metadataBytes += length;
                byte[] bytes = new byte[(int)length];
                int offset = 0;
                while (offset < bytes.Length)
                {
                    CheckBudget();
                    int count = RandomAccess.Read(handle, bytes.AsSpan(offset, Math.Min(65536, bytes.Length - offset)), offset);
                    CheckBudget();
                    if (count == 0) throw new EndOfStreamException("成功归档元数据读取不完整");
                    offset += count;
                }
                if (RandomAccess.GetLength(handle) != length) throw new InvalidOperationException("成功归档元数据长度已改变");
                string contents = new UTF8Encoding(false, true).GetString(bytes);
                CheckBudget();
                Hashes.Add(relative, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
                return contents;
            }

            private JsonDocument ReadJson(string relative, int maximumBytes)
            {
                return ParseCompletedEvidence(Read(relative, maximumBytes), maximumBytes);
            }

            private JsonElement RestoreJson(string relative,int maximum=65536)
            {
                PinDirectory(Path.GetDirectoryName(Path.Combine(Journal,relative)));
                using(var document=ReadJson(relative,maximum))return document.RootElement.Clone();
            }
            private static double RestoreNumber(JsonElement value,double minimum,double maximum)
            {
                RestoreFact(value.TryGetDouble(out double number)&&Double.IsFinite(number)&&number>=minimum&&number<maximum); return number;
            }
            private static void RestoreIdentitySame(JsonElement first,JsonElement second)
            {
                foreach(string key in new[]{"pid","created","image"})RestoreFact(EvidenceEqual(first.GetProperty(key),second.GetProperty(key)));
            }
            private static void RestoreExited(JsonElement value,string role,string executable,bool ordinary=false)
            {
                if(ordinary)RestoreFields(value,"pid","created","image","imageIdentity","parentPid","role","session","signaled","exitCode","exitFileTime");
                else RestoreFields(value,"pid","created","image","imageIdentity","parentPid","role","session","registeredWriter","signaled","exitCode","exitFileTime");
                RestoreFact(value.GetProperty("role").GetString()==role&&value.GetProperty("pid").GetUInt32()>0&&value.GetProperty("signaled").GetBoolean()&&value.GetProperty("exitCode").GetUInt32()==0&&value.GetProperty("image").GetString()==executable&&CompletedHash(value.GetProperty("imageIdentity").GetString()));
                long created=Int64.Parse(value.GetProperty("created").GetString()),exited=Int64.Parse(value.GetProperty("exitFileTime").GetString()); RestoreFact(created>0&&exited>=created);
            }
            private void RestoreScope(JsonElement value,JsonElement proof)
            {
                RestoreFact(value.GetProperty("version").GetInt32()==1&&value.GetProperty("runId").GetString()==Manifest.RunId);
                foreach(string key in new[]{"bindingSha256","executableSha256","guardianSha256"})RestoreFact(value.GetProperty(key).GetString()==proof.GetProperty(key).GetString());
                RestoreFact(value.GetProperty("manifestSha256").GetString()==Hashes["manifest.json"]);
                var profile=value.GetProperty("profile"); RestoreFields(profile,"fileId128","volumeSerial64","guardianRootHash");
                RestoreFact(profile.GetProperty("fileId128").GetString()==Manifest.RootIdentity.FileId128.ToLowerInvariant()&&profile.GetProperty("volumeSerial64").GetString()==Manifest.RootIdentity.VolumeSerial64.ToLowerInvariant()&&CompletedHash(profile.GetProperty("guardianRootHash").GetString()));
                RestoreFact(CompletedHash(value.GetProperty("markerSha256").GetString()));
                var limits=value.GetProperty("limits"); RestoreFields(limits,"flags","total","held","records","bytes");
                RestoreFact(limits.GetProperty("flags").GetInt32()==0x2008&&limits.GetProperty("total").GetInt32()==24);
                RestoreNumber(limits.GetProperty("held"),2,129); RestoreNumber(limits.GetProperty("records"),0,513); RestoreNumber(limits.GetProperty("bytes"),0,2097153);
                double budget=RestoreNumber(value.GetProperty("budgetMs"),1,3600001); RestoreNumber(value.GetProperty("elapsedMs"),0,budget);
            }
            private void RestoreRetirement(JsonElement value,JsonElement proof,bool ordinary)
            {
                if(ordinary)RestoreFields(value,"version","runId","initial","elapsedMs","budgetMs","manifestSha256","markerSha256","bindingSha256","executableSha256","guardianSha256","profile","limits","main","guardian","ledger","ledgerSha256","members");
                else RestoreFields(value,"version","runId","scene","transition","kind","elapsedMs","budgetMs","manifestSha256","markerSha256","bindingSha256","executableSha256","guardianSha256","profile","limits","sample","facts");
                RestoreScope(value,proof);
                var facts=ordinary?value:value.GetProperty("facts");
                if(!ordinary)RestoreFields(facts,"currentMain","currentGuardian","ledger","ledgerSha256","held","utilityCoverage");
                JsonElement main=facts.GetProperty(ordinary?"main":"currentMain"),guardian=facts.GetProperty(ordinary?"guardian":"currentGuardian");
                RestoreExited(main,"main",Manifest.PackageExecutable,ordinary);
                RestoreExited(guardian,"guardian",Path.Combine(Path.GetDirectoryName(Manifest.PackageExecutable),"resources","lifecycle-guardian","guardian.exe"),ordinary);
                RestoreFact(guardian.GetProperty("parentPid").GetUInt32()==main.GetProperty("pid").GetUInt32());
                if(ordinary) { RestoreIdentitySame(value.GetProperty("initial"),main); RestoreNumber(value.GetProperty("budgetMs"),1,30001); }
                else {
                    RestoreFact(facts.GetProperty("utilityCoverage").GetString()=="held-observations-plus-guardian-retirement");
                    var held=facts.GetProperty("held"); RestoreFact(held.ValueKind==JsonValueKind.Array&&held.GetArrayLength()>=2&&held.GetArrayLength()<=128);
                    foreach(var item in held.EnumerateArray()) {
                        string role=item.GetProperty("role").GetString(); RestoreFact(role=="main"||role=="guardian"||role=="utility");
                        RestoreFact(item.GetProperty("signaled").GetBoolean()&&item.GetProperty("exitCode").ValueKind==JsonValueKind.Number);
                        if(role!="utility"||item.GetProperty("registeredWriter").GetBoolean())RestoreFact(item.GetProperty("exitCode").GetUInt32()==0);
                    }
                }
                var ledger=facts.GetProperty("ledger"); RestoreFields(ledger,"version","root","session","main","utility");
                RestoreFact(ledger.GetProperty("version").GetInt32()==1&&ledger.GetProperty("root").GetString()==value.GetProperty("profile").GetProperty("guardianRootHash").GetString()&&ledger.GetProperty("session").GetString()==guardian.GetProperty("session").GetString()&&ledger.GetProperty("main").ValueKind==JsonValueKind.Null&&ledger.GetProperty("utility").ValueKind==JsonValueKind.Null&&CompletedHash(facts.GetProperty("ledgerSha256").GetString()));
                var members=ordinary?value.GetProperty("members"):value.GetProperty("sample").GetProperty("members");
                RestoreFact(members.ValueKind==JsonValueKind.Array&&members.GetArrayLength()>0&&members.GetArrayLength()<=4);
                var ids=new HashSet<uint>(); foreach(var member in members.EnumerateArray()) { RestoreFields(member,"pid","created","role"); RestoreFact(member.GetProperty("role").GetString()=="tool"&&ids.Add(member.GetProperty("pid").GetUInt32())); }
                if(!ordinary) {
                    var sample=value.GetProperty("sample"); RestoreFields(sample,"main","guardian","chromium","utility","tools","members");
                    foreach(string key in new[]{"main","guardian","chromium","utility"})RestoreFact(sample.GetProperty(key).GetInt32()==0);
                    RestoreFact(sample.GetProperty("tools").GetInt32()==members.GetArrayLength());
                }
            }
            private void ReadRestore(string terminal,string scopeId,string proofSha)
            {
                RestoreFact(RestoreId(scopeId)&&CompletedHash(proofSha)&&Manifest.BindingJournal==""&&!File.Exists(Path.Combine(Journal,"restore-invalid.json"))&&!Directory.Exists(Path.Combine(Journal,"restore-invalid.json")));
                ValidateCompletedTerminal(terminal,Manifest.RunId);
                var admission=RestoreJson("restore-admission.json");
                RestoreFields(admission,"version","runId","scene","scopeId","proofSha256","nodeExecutable","preflightElapsedMs","sceneBudgetMs","toolBudgetMs");
                string scene=admission.GetProperty("scene").GetString(); RestoreFact(scene=="R"||scene=="P");
                int total=scene=="R"?4410000:2990000;
                RestoreFact(admission.GetProperty("version").GetInt32()==1&&admission.GetProperty("runId").GetString()==Manifest.RunId&&admission.GetProperty("scopeId").GetString()==scopeId&&admission.GetProperty("proofSha256").GetString()==proofSha&&admission.GetProperty("sceneBudgetMs").GetInt32()==total&&admission.GetProperty("toolBudgetMs").GetInt32()==180000);
                RestoreNumber(admission.GetProperty("preflightElapsedMs"),0,180000);
                var current=new RestoreAdmission(scopeId,proofSha,Path.GetDirectoryName(Manifest.PackageExecutable),admission.GetProperty("nodeExecutable").GetString(),readBudget,150000); held.Add(current);
                var start=RestoreJson("restore-start.json"); RestoreFields(start,"version","runId","scene","proofSha256","preflightElapsedMs");
                RestoreFact(start.GetProperty("version").GetInt32()==1&&start.GetProperty("runId").GetString()==Manifest.RunId&&start.GetProperty("scene").GetString()==scene&&start.GetProperty("proofSha256").GetString()==proofSha);
                double preflight=RestoreNumber(start.GetProperty("preflightElapsedMs"),admission.GetProperty("preflightElapsedMs").GetDouble(),180000);
                var terminalRestore=RestoreJson("restore-terminal.json");
                RestoreFields(terminalRestore,"version","runId","scene","scopeId","proofSha256","elapsedMs","sceneBudgetMs","preflightElapsedMs","ok");
                RestoreFact(terminalRestore.GetProperty("version").GetInt32()==1&&terminalRestore.GetProperty("runId").GetString()==Manifest.RunId&&terminalRestore.GetProperty("scene").GetString()==scene&&terminalRestore.GetProperty("scopeId").GetString()==scopeId&&terminalRestore.GetProperty("proofSha256").GetString()==proofSha&&terminalRestore.GetProperty("sceneBudgetMs").GetInt32()==total&&terminalRestore.GetProperty("ok").GetBoolean());
                RestoreNumber(terminalRestore.GetProperty("elapsedMs"),preflight,total);
                string run="runner-output/restore-campaign/";
                var launch=RestoreJson(run+"launch-contract.json",2<<20); RestoreFields(launch,"version","scene","limits","proof","noClaims","arguments");
                RestoreFact(launch.GetProperty("version").GetInt32()==1&&launch.GetProperty("scene").GetString()==scene&&EvidenceEqual(launch.GetProperty("proof"),current.Proof));
                var limits=launch.GetProperty("limits");
                string[] limitKeys={"R","P","ui","helper","boot","close","partial","transfer","offline","actions"};
                int[] limitValues={4410000,2990000,30000,35000,60000,30000,20000,1500000,180000,32};
                RestoreFields(limits,limitKeys); for(int i=0;i<limitKeys.Length;i++)RestoreFact(limits.GetProperty(limitKeys[i]).GetInt32()==limitValues[i]);
                var arguments=launch.GetProperty("arguments"); RestoreFields(arguments,"initial","cold","successor");
                RestoreFact(arguments.GetProperty("initial").GetArrayLength()==1&&arguments.GetProperty("initial")[0].GetString()=="--force-renderer-accessibility"&&arguments.GetProperty("cold").GetArrayLength()==0&&arguments.GetProperty("successor").GetString()=="产品guardian固定继任参数");
                var report=RestoreJson(run+"report.json");
                RestoreFields(report,"version","scene","ok","result","elapsedMs","pending","children","observers","leases","failure","outerJobReleaseRequired","productGoneChecks");
                RestoreFact(report.GetProperty("version").GetInt32()==1&&report.GetProperty("scene").GetString()==scene&&report.GetProperty("ok").GetBoolean()&&report.GetProperty("pending").GetInt32()==0&&report.GetProperty("children").GetInt32()==0&&report.GetProperty("failure").GetString()=="none"&&report.GetProperty("outerJobReleaseRequired").GetBoolean());
                RestoreNumber(report.GetProperty("elapsedMs"),0,total-preflight);
                int gone=scene=="R"?3:2; RestoreFact(report.GetProperty("productGoneChecks").GetInt32()==gone);
                for(int i=1;i<=gone;i++) {
                    var sample=RestoreJson(run+"job-quiescent-"+i+".json"); RestoreFields(sample,"version","hardTotalLimit","limitFlags","total","sampledCounts","identities");
                    RestoreFact(sample.GetProperty("version").GetInt32()==1&&sample.GetProperty("hardTotalLimit").GetInt32()==24&&sample.GetProperty("limitFlags").GetInt32()==0x2008);
                    var counts=sample.GetProperty("sampledCounts"); RestoreFields(counts,"main","guardian","chromium","utility","tools");
                    foreach(string key in new[]{"main","guardian","chromium","utility"})RestoreFact(counts.GetProperty(key).GetInt32()==0);
                    int tools=counts.GetProperty("tools").GetInt32(); RestoreFact(tools>=1&&tools<=4&&sample.GetProperty("total").GetInt32()==tools&&sample.GetProperty("identities").GetArrayLength()==tools);
                }
                var result=report.GetProperty("result"); RestoreFields(result,"scene","actions","offlineMs");
                RestoreFact(result.GetProperty("scene").GetString()==scene&&result.GetProperty("actions").GetInt32()==(scene=="R"?28:29)); RestoreNumber(result.GetProperty("offlineMs"),preflight,180000);
                foreach(string key in new[]{"observers","leases"}) { var values=report.GetProperty(key); RestoreFact(values.ValueKind==JsonValueKind.Array&&values.GetArrayLength()==(key=="observers"?1:scene=="R"?2:1)&&values.EnumerateArray().All(v=>v.GetInt32()==0)); }
                var children=RestoreJson(run+"child-receipts.json",8<<20); RestoreFact(children.ValueKind==JsonValueKind.Array&&children.GetArrayLength()>0&&children.GetArrayLength()<=128);
                foreach(var child in children.EnumerateArray()) {
                    RestoreFields(child,"pid","exitSeen","exitCode","closeCode","failed","stderrBytes","stderrBase64");
                    RestoreFact(child.GetProperty("pid").GetUInt32()>0&&child.GetProperty("exitSeen").GetBoolean()&&child.GetProperty("exitCode").GetInt32()==0&&child.GetProperty("closeCode").GetInt32()==0&&!child.GetProperty("failed").GetBoolean());
                    int count=child.GetProperty("stderrBytes").GetInt32(); RestoreFact(count>=0&&count<=65536&&Convert.FromBase64String(child.GetProperty("stderrBase64").GetString()).Length==count);
                }
                JsonElement before=RestoreJson(run+"verify-oracle.json"),cold=RestoreJson(run+"verify-cold-oracle.json");
                var variantFixture=RestoreJson(run+"fixture-"+(scene=="R"?"B":"H")+".json");
                foreach(var oracle in new[]{before,cold,RestoreJson(run+"fixture-A.json"),variantFixture}) {
                    RestoreFields(oracle,"bytes","hashes"); RestoreNumber(oracle.GetProperty("bytes"),1,(16<<20)+1); RestoreHashes(oracle.GetProperty("hashes"));
                }
                RestoreFact(EvidenceEqual(before.GetProperty("hashes"),cold.GetProperty("hashes")));
                string backupName=scene=="R"?"product-A":"synthetic-H";
                var wire=RestoreJson(run+backupName+"-wire.json");
                if(scene=="R")RestoreFields(wire,"bytes","sha256","snapshotId","productVersion","members");
                else { RestoreFields(wire,"origin","bytes","sha256","snapshotId","productVersion","members"); RestoreFact(wire.GetProperty("origin").GetString()=="受控合成生产管线备份"); }
                long backupLength=wire.GetProperty("bytes").GetInt64(); RestoreFact(backupLength>0&&backupLength<=(16L<<20)&&CompletedHash(wire.GetProperty("sha256").GetString()));
                string digest=ReadHash(Path.Combine(Journal,run,backupName+".aibak"),16L<<20,run+backupName+".aibak",out _,backupLength); RestoreFact(digest==wire.GetProperty("sha256").GetString());
                var members=wire.GetProperty("members"); RestoreFact(members.GetArrayLength()==4);
                var domainNames=new HashSet<string>(); foreach(var member in members.EnumerateArray()) { RestoreFields(member,"id","present","schemaVersion","bytes","sha256"); string domain=member.GetProperty("id").GetString(); RestoreFact(new[]{"sources","research","watch","conversations"}.Contains(domain)&&domainNames.Add(domain)&&member.GetProperty("present").GetBoolean()&&member.GetProperty("bytes").GetInt64()>0&&CompletedHash(member.GetProperty("sha256").GetString())); }
                if(scene=="R") { var rollback=RestoreJson(run+"rollback-B-oracle.json"); RestoreFields(rollback,"bytes","hashes"); RestoreNumber(rollback.GetProperty("bytes"),1,(16<<20)+1); RestoreFact(EvidenceEqual(rollback.GetProperty("hashes"),variantFixture.GetProperty("hashes"))); }
                else {
                    JsonElement bad=RestoreJson(run+"bad-index-proof.json"),rollback=RestoreJson(run+"rollback-bad-index.json"),recovery=RestoreJson(run+"recovery-entry.json");
                    RestoreFields(bad,"bytes","sha256"); RestoreFields(rollback,"preserved","sha256"); RestoreFields(recovery,"gatePresent","badIndexPreserved","storeClaim");
                    RestoreFact(bad.GetProperty("bytes").GetInt32()>0&&CompletedHash(bad.GetProperty("sha256").GetString())&&rollback.GetProperty("preserved").GetBoolean()&&rollback.GetProperty("sha256").GetString()==bad.GetProperty("sha256").GetString()&&recovery.GetProperty("gatePresent").GetBoolean()&&recovery.GetProperty("badIndexPreserved").GetBoolean());
                }
                ReadRestoreActions(scene,current.Proof);
                Kind="completed-restore-"+scene; CheckBudget();
            }

            private void ReadRestoreActions(string scene,JsonElement proof)
            {
                string process="runner-output/restore-process-"+scene+"/";
                int transitions=scene=="R"?1:2;
                var final=RestoreJson(process+"t"+transitions+"-final.json");
                RestoreRetirement(final,proof,false);
                RestoreFact(final.GetProperty("scene").GetString()==scene&&final.GetProperty("transition").GetInt32()==transitions&&final.GetProperty("kind").GetString()=="final");
                var transitionsProof=new List<JsonElement>();
                for(int t=1;t<=transitions;t++) {
                    var value=RestoreJson(process+"t"+t+"-transition.json"); RestoreScope(value,proof);
                    RestoreFields(value,"version","runId","scene","transition","kind","elapsedMs","budgetMs","manifestSha256","markerSha256","bindingSha256","executableSha256","guardianSha256","profile","limits","sample","facts");
                    RestoreFact(value.GetProperty("scene").GetString()==scene&&value.GetProperty("transition").GetInt32()==t&&value.GetProperty("kind").GetString()=="transition");
                    var facts=value.GetProperty("facts");
                    RestoreFields(facts,"oldMain","oldGuardian","newMain","newGuardian","heldUtilities","uncaptured","utilityCoverage","oldSession","newSession","ledger","ledgerSha256","approval","successorSeenMs");
                    RestoreExited(facts.GetProperty("oldMain"),"main",Manifest.PackageExecutable);
                    RestoreExited(facts.GetProperty("oldGuardian"),"guardian",Path.Combine(Path.GetDirectoryName(Manifest.PackageExecutable),"resources","lifecycle-guardian","guardian.exe"));
                    RestoreFact(!facts.GetProperty("newMain").GetProperty("signaled").GetBoolean()&&!facts.GetProperty("newGuardian").GetProperty("signaled").GetBoolean());
                    transitionsProof.Add(facts);
                }
                RestoreIdentitySame(transitionsProof.Last().GetProperty("newMain"),final.GetProperty("facts").GetProperty("currentMain"));
                if(scene=="P")RestoreIdentitySame(transitionsProof[0].GetProperty("newMain"),transitionsProof[1].GetProperty("oldMain"));
                string output=Path.Combine(Journal,"runner-output");
                var ordinary=Directory.EnumerateDirectories(output,"ordinary-*").Take(4).Select(path=>RestoreJson("runner-output/"+Path.GetFileName(path)+"/retired.json")).OrderBy(value=>Int64.Parse(value.GetProperty("main").GetProperty("created").GetString())).ToArray();
                RestoreFact(ordinary.Length==(scene=="R"?2:1)); foreach(var value in ordinary)RestoreRetirement(value,proof,true);
                string[] actions=scene=="R" ? new[]{"BootHealthy","OpenBackup","SaveBackup","WaitBackupCompleted","Close","BootHealthy","OpenRestore","CancelOpen","WaitCancelled","OpenRestore","SelectRestore","Cancel","WaitCancelled","OpenRestore","SelectRestore","Approve","BootHealthy","ReadSources","ReadResearch","ReadWatch","ReadConversation","Close","BootHealthy","ReadSources","ReadResearch","ReadWatch","ReadConversation","Close"} : new[]{"BootPartial","OpenPartial","Cancel","WaitCancelled","OpenPartial","Approve","BootRecovery","OpenRestore","CancelOpen","WaitCancelled","OpenRestore","SelectRestore","Cancel","WaitCancelled","OpenRestore","SelectRestore","Approve","BootHealthy","ReadSources","ReadResearch","ReadWatch","ReadConversation","Close","BootHealthy","ReadSources","ReadResearch","ReadWatch","ReadConversation","Close"};
                for(int i=0;i<actions.Length;i++) {
                    int sequence=i+1; string action=actions[i];
                    if(action=="Approve"||action=="Cancel") {
                        int transition=scene=="R"||sequence<=6?1:2; string purpose=scene=="P"&&sequence<=6?"partial":"restore";
                        string prefix="runner-output/restore-native/"+scene+"-t"+transition+"-a"+sequence;
                        JsonElement start=RestoreJson(prefix+"-start.json"),native=RestoreJson(prefix+"-native.json"),approval=RestoreJson(prefix+".json");
                        RestoreFields(start,"version","scene","transition","actionSequence","purpose","action");
                        RestoreFields(native,"version","scene","transition","actionSequence","purpose","result","ok","actionCount","elapsedMs","failure");
                        RestoreFields(approval,"version","runId","scene","transition","actionSequence","purpose","result","nativeReceiptSha256");
                        foreach(var row in new[]{start,native,approval})RestoreFact(row.GetProperty("version").GetInt32()==1&&row.GetProperty("scene").GetString()==scene&&row.GetProperty("transition").GetInt32()==transition&&row.GetProperty("actionSequence").GetInt32()==sequence&&row.GetProperty("purpose").GetString()==purpose);
                        RestoreFact(start.GetProperty("action").GetString()==action&&native.GetProperty("ok").GetBoolean()&&native.GetProperty("actionCount").GetInt32()==1&&native.GetProperty("failure").GetString()=="none"&&native.GetProperty("result").GetString()==(action=="Approve"?"approved":"cancelled")&&approval.GetProperty("result").GetString()==native.GetProperty("result").GetString()&&approval.GetProperty("runId").GetString()==Manifest.RunId&&approval.GetProperty("nativeReceiptSha256").GetString()==Hashes[prefix+"-native.json"]);
                        RestoreNumber(native.GetProperty("elapsedMs"),0,30000);
                        if(action=="Approve") { var accepted=transitionsProof[transition-1].GetProperty("approval"); RestoreFact(accepted.GetProperty("sequence").GetInt32()==sequence&&accepted.GetProperty("sha256").GetString()==Hashes[prefix+".json"]); }
                    } else {
                        var row=RestoreJson("runner-output/restore-ui/"+scene+"-a"+sequence+".json");
                        RestoreFields(row,"version","scene","actionSequence","action","ok","identity","mainWindowHandle","elapsedMs","failure");
                        RestoreFact(row.GetProperty("version").GetInt32()==1&&row.GetProperty("scene").GetString()==scene&&row.GetProperty("actionSequence").GetInt32()==sequence&&row.GetProperty("action").GetString()==action&&row.GetProperty("ok").GetBoolean()&&row.GetProperty("failure").GetString()=="none"); RestoreNumber(row.GetProperty("elapsedMs"),0,30000);
                        JsonElement expected=scene=="R" ? (sequence<=5?ordinary[0].GetProperty("main"):sequence<=16?transitionsProof[0].GetProperty("oldMain"):sequence<=22?final.GetProperty("facts").GetProperty("currentMain"):ordinary.Last().GetProperty("main")) : (sequence<=6?transitionsProof[0].GetProperty("oldMain"):sequence<=17?transitionsProof[0].GetProperty("newMain"):sequence<=23?final.GetProperty("facts").GetProperty("currentMain"):ordinary[0].GetProperty("main"));
                        RestoreIdentitySame(row.GetProperty("identity"),expected);
                    }
                }
            }

            private void ReadProduct(string terminal, string relative, string reportDirectory)
            {
                ProductFact(Manifest.BindingJournal == "" && Manifest.RootIdentity != null &&
                    !String.IsNullOrEmpty(Manifest.DeclaredProfile) && !String.IsNullOrEmpty(Manifest.ResolvedProfile) &&
                    !String.IsNullOrEmpty(Manifest.PackageExecutable) && Path.IsPathFullyQualified(Manifest.PackageExecutable) &&
                    !Manifest.PackageExecutable.StartsWith("\\\\", StringComparison.Ordinal) && Manifest.PackageExecutable.IndexOf(':', 2) < 0 &&
                    Path.GetFileName(Manifest.PackageExecutable) == "AIbrowse.exe" && !File.Exists(Path.Combine(Journal, "tamper-binding.json")) &&
                    !Directory.Exists(Path.Combine(Journal, "tamper-binding.json")));
                ValidateCompletedTerminal(terminal, Manifest.RunId);
                using (JsonDocument launch = ReadJson(Path.Combine(relative, "launch-contract.json"), 1048576))
                using (JsonDocument report = ReadJson(Path.Combine(relative, "report.json"), 1048576))
                using (JsonDocument backup = ReadJson(Path.Combine(relative, "backup-readback.json"), 16384))
                using (JsonDocument job = ReadJson(Path.Combine(relative, "job-18.json"), 65536))
                using (JsonDocument dialog = ReadJson(Path.Combine(relative, "ui-4-InspectSaveDialog.json"), 65536))
                using (JsonDocument cancel = ReadJson(Path.Combine(relative, "ui-6-CancelSave.json"), 65536))
                using (JsonDocument save = ReadJson(Path.Combine(relative, "ui-12-SaveBackup.json"), 65536))
                {
                    uint pid = report.RootElement.GetProperty("product").GetProperty("pid").GetUInt32();
                    ProductFact(pid > 0);
                    using (JsonDocument process = ReadJson(Path.Combine("runner-output", "process-ProductOriginal-" + pid + ".json"), 65536))
                    {
                        ValidateProductCompletedElements(launch.RootElement, report.RootElement, backup.RootElement,
                            process.RootElement, job.RootElement, dialog.RootElement, Manifest);
                    }
                    ProductDialog(cancel.RootElement, report.RootElement.GetProperty("product"), "CancelSave");
                    ProductDialog(save.RootElement, report.RootElement.GetProperty("product"), "SaveBackup");
                    ProductFact(EvidenceEqual(cancel.RootElement, report.RootElement.GetProperty("cancelAction")) &&
                        EvidenceEqual(save.RootElement, report.RootElement.GetProperty("saveAction")));
                    string repository = Repository();
                    PinDirectory(repository);
                    long sourceBytes = 0;
                    foreach (string source in ProductTransferSources)
                    {
                        string expected = report.RootElement.GetProperty("toolSources").GetProperty(source).GetString();
                        ProductFact(CompletedHash(expected));
                        string actual = ReadHash(Path.Combine(repository, source.Replace('/', Path.DirectorySeparatorChar)),
                            Math.Min(8L << 20, (32L << 20) - sourceBytes), "source/" + source, out long count);
                        sourceBytes += count;
                        ProductFact(actual == expected);
                    }
                    string packageRoot = Path.GetDirectoryName(Manifest.PackageExecutable);
                    PinDirectory(packageRoot);
                    string[] packageFiles = { "AIbrowse.exe", "resources/app.asar", "resources/lifecycle-guardian/guardian.exe" };
                    string[] packageFields = { "executableSha256", "asarSha256", "guardianSha256" };
                    long[] packageLimits = { 512L << 20, 32L << 20, 512L << 10 };
                    for (int index = 0; index < packageFiles.Length; index++)
                    {
                        string actual = ReadHash(Path.Combine(packageRoot, packageFiles[index].Replace('/', Path.DirectorySeparatorChar)),
                            packageLimits[index], "package/" + packageFiles[index], out _);
                        ProductFact(actual == report.RootElement.GetProperty("package").GetProperty(packageFields[index]).GetString());
                    }
                    string published = Path.Combine(reportDirectory, "published");
                    PinDirectory(published);
                    string[] entries = Directory.EnumerateFileSystemEntries(published).Take(2).ToArray();
                    string backupPath = Path.Combine(published, "product-backup.aibak");
                    ProductFact(entries.Length == 1 && entries[0] == backupPath);
                    string digest = ReadHash(backupPath, 5L * 1024 * 1024 * 1024,
                        Path.Combine(relative, "published", "product-backup.aibak"), out long backupBytes, backup.RootElement.GetProperty("bytes").GetInt64());
                    ProductFact(backupBytes == backup.RootElement.GetProperty("bytes").GetInt64() &&
                        digest == backup.RootElement.GetProperty("sha256").GetString());
                    CheckBudget();
                    Kind = "completed-product-transfer-small-backup";
                }
            }

            internal CompletedArchiveEvidence(string journal):this(journal,"","") {}

            internal CompletedArchiveEvidence(string journal,string restoreScopeId,string restoreProofSha256)
            {
                try
                {
                    if (String.IsNullOrWhiteSpace(journal) || journal.Length > 2048 || !Path.IsPathFullyQualified(journal) ||
                        journal.StartsWith("\\\\", StringComparison.Ordinal) || journal.IndexOf(':', 2) >= 0)
                        throw new InvalidOperationException("成功归档只接受固定本地journal");
                    Journal = Path.GetFullPath(journal).TrimEnd(Path.DirectorySeparatorChar);
                    string name = Path.GetFileName(Journal);
                    if (Path.GetDirectoryName(Journal) != EvidenceRoot() || !name.StartsWith("journal-", StringComparison.Ordinal) ||
                        !Guid.TryParseExact(name.Substring(8), "N", out _))
                        throw new InvalidOperationException("成功归档journal不属于固定证据目录");
                    held.Add(new Scope(Journal));
                    string manifestText = Read("manifest.json", 32768);
                    using (JsonDocument parsed = ParseCompletedEvidence(manifestText, 32768))
                    {
                        if (!parsed.RootElement.TryGetProperty("Version", out JsonElement version) ||
                            version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out int number) || number != 2)
                            throw new InvalidOperationException("成功归档manifest必须显式声明版本2");
                        if (!parsed.RootElement.TryGetProperty("BindingJournal", out JsonElement bound) || bound.ValueKind != JsonValueKind.String)
                            throw new InvalidOperationException("成功归档manifest必须显式声明绑定分支");
                        if (bound.GetString() == "") ProductManifest(parsed.RootElement);
                        Manifest = JsonSerializer.Deserialize<DisposableManifest>(manifestText) ?? throw new InvalidOperationException("成功归档manifest无效");
                    }
                    if (Manifest.Version != 2 || name != "journal-" + Manifest.RunId || !Guid.TryParseExact(Manifest.RunId, "N", out _))
                        throw new InvalidOperationException("成功归档manifest身份无效");
                    string output = Path.Combine(Journal, "runner-output");
                    held.Add(new DirectoryLease(output, false));
                    if(File.Exists(Path.Combine(Journal,"restore-admission.json"))) {
                        ReadRestore(Read("terminal.json",16384),restoreScopeId,restoreProofSha256); return;
                    }
                    RestoreFact(String.IsNullOrEmpty(restoreScopeId)&&String.IsNullOrEmpty(restoreProofSha256));
                    string[] directories = Directory.EnumerateDirectories(output).Take(2).ToArray();
                    if (directories.Length != 1) throw new InvalidOperationException("成功归档报告目录数量无效");
                    string reportDirectory = directories[0];
                    string runName = Path.GetFileName(reportDirectory);
                    held.Add(new DirectoryLease(reportDirectory, false));
                    string terminal = Read("terminal.json", 16384);
                    if (Manifest.BindingJournal == "")
                    {
                        ProductFact(runName == "product-transfer");
                        ReadProduct(terminal, Path.Combine("runner-output", runName), reportDirectory);
                        return;
                    }
                    string prior = Manifest.BindingJournal;
                    string priorName = Path.GetFileName(prior);
                    if (!Path.IsPathFullyQualified(prior) || Path.GetDirectoryName(prior) != EvidenceRoot() ||
                        !priorName.StartsWith("journal-", StringComparison.Ordinal) || !Guid.TryParseExact(priorName.Substring(8), "N", out _) || prior == Journal)
                        throw new InvalidOperationException("成功归档Tamper绑定不属于固定前轮journal");
                    if (!runName.StartsWith("run-", StringComparison.Ordinal) || runName.Length < 5 || runName.Length > 24 ||
                        !runName.Substring(4).All(c => c >= '0' && c <= '9'))
                        throw new InvalidOperationException("成功归档报告不属于固定run目录");
                    string binding = Read("tamper-binding.json", 16384);
                    string report = Read(Path.Combine("runner-output", runName, "report.json"), 1048576);
                    ValidateCompletedArchiveElements(terminal, report, binding, Manifest, reportDirectory);
                }
                catch { Dispose(); throw; }
            }

            public void Dispose()
            {
                foreach (IDisposable resource in held.AsEnumerable().Reverse()) resource.Dispose();
                held.Clear();
            }

            internal void VerifyBeforeTransition() { CheckBudget(); }
        }

        public static string ArchiveCompletedRun(string journal)
        { return ArchiveCompletedRun(journal,"",""); }

        public static string ArchiveCompletedRun(string journal,string restoreScopeId,string restoreProofSha256)
        {
            using (ExclusiveGuard guard = new ExclusiveGuard())
            {
                CheckProcesses();
                using (CompletedArchiveEvidence evidence = new CompletedArchiveEvidence(journal,restoreScopeId,restoreProofSha256))
                {
                    DisposableManifest manifest = evidence.Manifest;
                    JobProcess.ConfirmReleased(manifest.RunId);
                    using (DisposableLease current = new DisposableLease(false)) CheckMarker(manifest, current);
                    CheckProcesses();
                    evidence.VerifyBeforeTransition();
                    string preservedPath = Path.Combine(Path.GetDirectoryName(manifest.ResolvedProfile), ".aibrowse-e1-preserved-" + manifest.RunId);
                    ArchiveTransitionResult result = ArchiveTransition(manifest.ResolvedProfile, preservedPath,
                        evidence.Journal, manifest.RunId, manifest.RootIdentity, "");
                    using (DisposableLease replacement = new DisposableLease(true))
                    {
                        if (replacement.Declared != manifest.DeclaredProfile ||
                            !String.Equals(replacement.Resolved, manifest.ResolvedProfile, StringComparison.OrdinalIgnoreCase))
                            throw new InvalidOperationException("成功归档新根的KnownFolder视图不一致；保留新旧两方");
                        Equal(result.NewRootIdentity, replacement.Identity);
                    }
                    string receipt = Path.Combine(evidence.Journal, "archive-completed.json");
                    Durable(receipt, JsonSerializer.Serialize(new {
                        version = 1, runId = manifest.RunId, ok = true, kind = evidence.Kind,
                        evidenceSha256 = evidence.Hashes, preservedPath = result.PreservedPath,
                        preservedIdentity = result.PreservedIdentity, newRootIdentity = result.NewRootIdentity
                    }));
                    return receipt;
                }
            }
        }

        internal static void CheckMarker(DisposableManifest manifest, DisposableLease lease)
        {
            Equal(manifest.RootIdentity, lease.Identity);
            if (manifest.DeclaredProfile != lease.Declared || manifest.ResolvedProfile != lease.Resolved)
                throw new InvalidOperationException("journal profile路径不匹配");
            string aliasMarker = Path.Combine(lease.Declared, OwnerMarker);
            string resolvedMarker = Path.Combine(lease.Resolved, OwnerMarker);
            using (SafeFileHandle alias = DisposableNative.Open(aliasMarker, false, true, 1))
            using (SafeFileHandle resolved = DisposableNative.Open(resolvedMarker, false, false, 1))
            {
                Equal(DisposableNative.Identity(alias, aliasMarker, false), DisposableNative.Identity(resolved, resolvedMarker, false));
                using (JsonDocument marker = JsonDocument.Parse(DisposableNative.ReadUtf8Bounded(alias, 4096)))
                {
                    if (marker.RootElement.GetProperty("version").GetInt32() != 1 ||
                        marker.RootElement.GetProperty("runId").GetString() != manifest.RunId ||
                        marker.RootElement.GetProperty("fileId128").GetString() != manifest.RootIdentity.FileId128 ||
                        marker.RootElement.GetProperty("volumeSerial64").GetString() != manifest.RootIdentity.VolumeSerial64)
                        throw new InvalidOperationException("disposable profile marker不匹配");
                }
            }
        }

        private static void StopAtArchiveFault(string fault, string point)
        {
            if (fault == point)
            {
                Console.Out.Flush();
                Console.Error.Flush();
                Environment.Exit(point == "rename-before" ? 91 : point == "rename-after" ? 92 : 93);
            }
        }

        private static ArchiveTransitionResult ArchiveTransition(
            string sourcePath,
            string preservedPath,
            string journal,
            string runId,
            DisposableIdentity expected,
            string fault)
        {
            sourcePath = Path.GetFullPath(sourcePath).TrimEnd(Path.DirectorySeparatorChar);
            preservedPath = Path.GetFullPath(preservedPath).TrimEnd(Path.DirectorySeparatorChar);
            if (!String.Equals(Path.GetDirectoryName(sourcePath), Path.GetDirectoryName(preservedPath), StringComparison.OrdinalIgnoreCase) ||
                File.Exists(preservedPath) || Directory.Exists(preservedPath))
                throw new InvalidOperationException("归档目标不是不存在的固定同父路径");
            Durable(Path.Combine(journal, "archive-intent.json"), JsonSerializer.Serialize(new {
                version = 1, runId, state = "intent", sourcePath, preservedPath,
                expectedRoot = expected, replacementPolicy = "new-empty-root-with-original-sddl"
            }));
            StopAtArchiveFault(fault, "rename-before");
            using (DirectoryLease parent = new DirectoryLease(Path.GetDirectoryName(sourcePath), false))
            using (DirectoryLease source = new DirectoryLease(sourcePath, true))
            {
                Native.SameVolume(parent.Identity, source.Identity);
                DisposableIdentity pinnedSource = DisposableNative.Identity(source.Handle, sourcePath, true);
                Equal(expected, pinnedSource);
                Native.Rename(source, preservedPath);
                DisposableIdentity preserved = DisposableNative.Identity(source.Handle, preservedPath, true);
                Equal(expected, preserved);
                Durable(Path.Combine(journal, "archive-renamed.json"), JsonSerializer.Serialize(new {
                    version = 1, runId, state = "preserved", sourcePath, preservedPath,
                    preservedIdentity = preserved
                }));
                StopAtArchiveFault(fault, "rename-after");
                try
                {
                    DisposableNative.CreateDirectoryExclusive(sourcePath, expected.Sddl);
                }
                catch
                {
                    if (File.Exists(sourcePath) || Directory.Exists(sourcePath))
                        throw new InvalidOperationException("新根创建失败且原路径出现未知对象；拒绝回滚覆盖");
                    Native.Rename(source, sourcePath);
                    Durable(Path.Combine(journal, "archive-rollback.json"), JsonSerializer.Serialize(new {
                        version = 1, runId, state = "rolled-back-before-replacement", sourcePath,
                        restoredIdentity = DisposableNative.Identity(source.Handle, sourcePath, true)
                    }));
                    throw;
                }
                using (SafeFileHandle newRoot = DisposableNative.Open(sourcePath, true))
                {
                    DisposableIdentity newIdentity = DisposableNative.Identity(newRoot, sourcePath, true);
                    if (newIdentity.FileId128 == expected.FileId128 ||
                        newIdentity.VolumeSerial64 != expected.VolumeSerial64 ||
                        !SecurityEquivalent(newIdentity.Sddl, expected.Sddl) ||
                        Directory.EnumerateFileSystemEntries(sourcePath).Any())
                        throw new InvalidOperationException("新空profile根身份不符合固定归档策略；保留新旧两方");
                    Durable(Path.Combine(journal, "archive-created.json"), JsonSerializer.Serialize(new {
                        version = 1, runId, state = "new-root-created", sourcePath, preservedPath,
                        preservedIdentity = preserved, newRootIdentity = newIdentity
                    }));
                    StopAtArchiveFault(fault, "new-root-created");
                    return new ArchiveTransitionResult {
                        PreservedPath = preservedPath,
                        PreservedIdentity = preserved,
                        NewRootIdentity = newIdentity
                    };
                }
            }
        }

        public static string ArchiveFailedRun(string journal)
        {
            using (ExclusiveGuard guard = new ExclusiveGuard())
            {
                CheckProcesses();
                DisposableManifest manifest = Load(journal);
                ValidateFailedTerminal(journal, manifest.RunId);
                using (DisposableLease current = new DisposableLease(false))
                {
                    CheckMarker(manifest, current);
                }
                string preservedPath = Path.Combine(
                    Path.GetDirectoryName(manifest.ResolvedProfile),
                    ".aibrowse-e1-preserved-" + manifest.RunId);
                ArchiveTransitionResult result = ArchiveTransition(
                    manifest.ResolvedProfile, preservedPath, journal, manifest.RunId,
                    manifest.RootIdentity, "");
                using (DisposableLease replacement = new DisposableLease(true))
                {
                    if (!String.Equals(replacement.Declared, manifest.DeclaredProfile, StringComparison.Ordinal) ||
                        !String.Equals(replacement.Resolved, manifest.ResolvedProfile, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("新空profile根的KnownFolder别名视图不一致；保留新旧两方");
                    Equal(result.NewRootIdentity, replacement.Identity);
                }
                string report = Path.Combine(journal, "archive.json");
                Durable(report, JsonSerializer.Serialize(new {
                    version = 1, runId = manifest.RunId, ok = true,
                    preservedPath = result.PreservedPath,
                    preservedIdentity = result.PreservedIdentity,
                    newRootIdentity = result.NewRootIdentity
                }));
                return report;
            }
        }

        public static string RunArchiveFixture(string runId, string fault)
        {
            if (!Guid.TryParseExact(runId, "N", out _) ||
                !new[] { "", "rename-before", "rename-after", "new-root-created", "target-exists", "identity-mismatch" }.Contains(fault))
                throw new InvalidOperationException("归档夹具参数无效");
            string fixtureBase = Path.Combine(Repository(), "log", "stage7-e1", "disposable-archive-fixtures");
            Directory.CreateDirectory(fixtureBase);
            string root = Path.Combine(fixtureBase, "fixture-" + runId);
            DisposableNative.CreateDirectoryExclusive(root);
            string parent = Path.Combine(root, "active");
            DisposableNative.CreateDirectoryExclusive(parent);
            string source = Path.Combine(parent, "aibrowse");
            DisposableNative.CreateDirectoryExclusive(source);
            string journal = Path.Combine(root, "journal");
            DisposableNative.CreateDirectoryExclusive(journal);
            File.WriteAllText(Path.Combine(source, OwnerMarker), JsonSerializer.Serialize(new { version = 1, runId }));
            File.WriteAllText(Path.Combine(source, "fixture-canary.txt"), "preserve-" + runId);
            DisposableIdentity identity;
            using (SafeFileHandle handle = DisposableNative.Open(source, true))
                identity = DisposableNative.Identity(handle, source, true);
            string preserved = Path.Combine(parent, ".aibrowse-e1-preserved-" + runId);
            if (fault == "target-exists")
            {
                DisposableNative.CreateDirectoryExclusive(preserved);
                File.WriteAllText(Path.Combine(preserved, "unknown.txt"), "do-not-overwrite");
            }
            if (fault == "identity-mismatch") identity.FileId128 = new String('F', 32);
            string transitionFault = new[] { "rename-before", "rename-after", "new-root-created" }.Contains(fault) ? fault : "";
            ArchiveTransitionResult result = ArchiveTransition(source, preserved, journal, runId, identity, transitionFault);
            string report = Path.Combine(journal, "fixture-report.json");
            Durable(report, JsonSerializer.Serialize(new {
                version = 1, runId, ok = true, source, preserved,
                preservedIdentity = result.PreservedIdentity, newRootIdentity = result.NewRootIdentity
            }));
            return report;
        }

        private static bool IsRestore(ReleaseRunner runner) { return runner == ReleaseRunner.RestoreR || runner == ReleaseRunner.RestoreP; }
        private static int RestoreBudget(ReleaseRunner runner)
        {
            if (runner == ReleaseRunner.RestoreR) return 4410000;
            if (runner == ReleaseRunner.RestoreP) return 2990000;
            throw new InvalidOperationException("未知恢复场景");
        }
        private static void RestoreFact(bool value,[System.Runtime.CompilerServices.CallerLineNumber] int line=0) { if (!value) throw new InvalidOperationException("恢复固定准入或归档证据不一致；原件保留，源码行 "+line); }
        private static bool RestoreId(string value)
        {
            return value != null && value.Length == 49 && value.StartsWith("restore-campaign-", StringComparison.Ordinal) &&
                value.Substring(17).All(c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));
        }
        private static bool RestoreRelative(string value)
        {
            return !String.IsNullOrEmpty(value) && value.Length <= 512 && !value.StartsWith("/", StringComparison.Ordinal) &&
                value.Split('/').All(p => p.Length > 0 && p != "." && p != "..") &&
                value.All(c => Char.IsAsciiLetterOrDigit(c) || "_.@/-".Contains(c));
        }
        private static readonly string[] RestoreDirectories = {
            "tools/data-qualification/product-restore-campaign", "tools/data-qualification/product-restore-ui",
            "tools/data-qualification/product-restore-lifecycle", "tools/data-qualification/product-restore-process",
            "tools/data-qualification/product-restore-fixtures"
        };
        private static readonly string[] RestoreSharedSources = {
            "package.json", "package-lock.json", "native/lifecycle-guardian/Guardian.cs",
            "tools/release-profile/disposable-profile.ps1", "tools/release-profile/DisposableProfile.cs",
            "tools/release-profile/ProfileIsolation.cs", "tools/release-profile/JobProcess.cs", "tools/release-profile/ReleaseDataIdentity.cs",
            "tools/release/ProductWindow.cs", "tools/data-qualification/product-transfer/NativeSaveButton.cs",
            "tools/data-qualification/product-transfer/NativeSaveControl.cs", "tools/data-qualification/native-file-selection/NativeSelectionEdit.cs",
            "tools/data-qualification/product-transfer/JobBudget.cs", "tools/data-qualification/product-transfer/job-budget.ps1",
            "tools/data-qualification/product-transfer/backup-evidence.ts", "tools/data-qualification/envelope-fixtures.ts",
            "tools/data-qualification/fixtures.ts", "tools/release/profile-isolation-policy.ts",
            "electron.vite.config.ts", "tools/build/release-plugins.ts",
            "src/main/watch/qualification/acquisition.ts", "src/main/watch/qualification/context.ts",
            "src/main/watch/qualification/gpu-info.ts", "src/main/watch/qualification/launch-authority.ts",
            "src/main/watch/qualification/manifest.ts", "src/main/watch/qualification/native-bridge.ts",
            "src/main/watch/qualification/native-contract.ts", "src/main/watch/qualification/pausable-clock.ts",
            "src/main/watch/qualification/qpc.ts", "src/main/watch/qualification/registry.ts",
            "src/main/watch/qualification/round-release-gate.ts", "src/main/watch/qualification/run-timing.ts",
            "src/main/watch/qualification/runtime.ts", "src/main/watch/qualification/sampler.ts",
            "src/main/watch/qualification/seed-authorization.ts", "src/main/watch/qualification/telemetry.ts"
        };
        private static Dictionary<string,string> RestoreHashes(JsonElement value)
        {
            RestoreFact(value.ValueKind == JsonValueKind.Object);
            var result = new Dictionary<string,string>(StringComparer.Ordinal);
            foreach (var p in value.EnumerateObject()) {
                RestoreFact(result.Count < 2048 && RestoreRelative(p.Name) && p.Value.ValueKind == JsonValueKind.String && CompletedHash(p.Value.GetString()));
                result.Add(p.Name, p.Value.GetString());
            }
            RestoreFact(result.Count > 0); return result;
        }
        private static void RestoreFields(JsonElement value, params string[] fields)
        {
            RestoreFact(value.ValueKind == JsonValueKind.Object && value.EnumerateObject().Count() == fields.Length && value.EnumerateObject().All(p => fields.Contains(p.Name)));
        }
        // This admission owns every source, bundle and candidate file until the outer Job has closed.
        private sealed class RestoreAdmission : IDisposable
        {
            private readonly List<IDisposable> held = new List<IDisposable>();
            private readonly HashSet<string> directories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            private readonly Stopwatch clock;
            private readonly long maximumMs;
            private long sourceBytes;
            internal string ScopePath { get; private set; }
            internal string ProofSha { get; private set; }
            internal JsonElement Proof { get; private set; }
            internal string Node { get; private set; }
            internal void Check() { RestoreFact(clock.ElapsedMilliseconds < maximumMs); }
            private void PinDirectory(string directory)
            {
                Check(); directory = Path.GetFullPath(directory);
                if (directories.Add(directory)) held.Add(new Scope(directory));
                Check();
            }
            private SafeFileHandle Pin(string path, long maximum, out long length)
            {
                Check(); PinDirectory(Path.GetDirectoryName(path));
                var file = DisposableNative.Open(path, false, true, 1); held.Add(file);
                var id = DisposableNative.Identity(file, path, false);
                RestoreFact(String.Equals(id.FinalDos, "\\\\?\\" + Path.GetFullPath(path), StringComparison.OrdinalIgnoreCase));
                length = RandomAccess.GetLength(file); RestoreFact(length > 0 && length <= maximum); Check(); return file;
            }
            private string Hash(SafeFileHandle file, long length)
            {
                using(var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256)) {
                    byte[] buffer = new byte[65536]; long offset = 0;
                    while(offset < length) {
                        Check(); int count = RandomAccess.Read(file, buffer.AsSpan(0,(int)Math.Min(buffer.Length,length-offset)),offset);
                        Check(); RestoreFact(count > 0); digest.AppendData(buffer,0,count); offset += count;
                    }
                    RestoreFact(RandomAccess.GetLength(file)==length); Check(); return Convert.ToHexString(digest.GetHashAndReset()).ToLowerInvariant();
                }
            }
            private string HashFile(string path,long maximum)
            {
                var file = Pin(path,maximum,out long length); return Hash(file,length);
            }
            private JsonDocument Read(string path,int maximum,string expected)
            {
                var file = Pin(path,maximum,out long length); RestoreFact(expected==null || Hash(file,length)==expected);
                string value=DisposableNative.ReadUtf8Bounded(file,maximum); Check(); return ParseCompletedEvidence(value,maximum);
            }
            internal RestoreAdmission(string scopeId,string proofSha,string packageRoot,string node,Stopwatch clock,long maximumMs=180000)
            {
                this.clock=clock; this.maximumMs=maximumMs;
                try {
                    RestoreFact(RestoreId(scopeId)&&CompletedHash(proofSha)&&Path.IsPathFullyQualified(packageRoot)&&Path.IsPathFullyQualified(node));
                    ScopePath=Path.Combine(Repository(),"log","stage7-e2",scopeId); ProofSha=proofSha; Node=Path.GetFullPath(node);
                    RestoreFact(Path.GetFileName(Node)=="node.exe"); PinDirectory(ScopePath);
                    using(var proof=Read(Path.Combine(ScopePath,"build-proof.json"),2<<20,proofSha)) {
                        var p=proof.RootElement;
                        RestoreFields(p,"version","scopeId","packageRoot","bindingPath","bindingSha256","executableSha256","asarSha256","guardianSha256","nodeSha256","sources","bundles","inputs","rendered");
                        RestoreFact(p.GetProperty("version").GetInt32()==1&&p.GetProperty("scopeId").GetString()==scopeId&&p.GetProperty("packageRoot").GetString()==packageRoot);
                        foreach(string key in new[]{"bindingSha256","executableSha256","asarSha256","guardianSha256","nodeSha256"}) RestoreFact(CompletedHash(p.GetProperty(key).GetString()));
                        var bundles=RestoreHashes(p.GetProperty("bundles")); RestoreFact(bundles.Keys.OrderBy(x=>x).SequenceEqual(new[]{"offline.cjs","run.cjs"}));
                        // Pin executable bundles before spending the source hashing budget.
                        foreach(var b in bundles) RestoreFact(HashFile(Path.Combine(ScopePath,b.Key),8<<20)==b.Value);
                        string bindingPath=p.GetProperty("bindingPath").GetString(); RestoreFact(Path.IsPathFullyQualified(bindingPath)&&!bindingPath.StartsWith("\\\\",StringComparison.Ordinal)&&bindingPath.IndexOf(':',2)<0);
                        using(var binding=Read(bindingPath,2<<20,p.GetProperty("bindingSha256").GetString())) {
                            var b=binding.RootElement;
                            RestoreFields(b,"ok","executableSha256","asarSha256","asarHeaderSha256","guardianSha256","fuses","artifacts","modules","sourceGraphSha256","references","productExecuted");
                            RestoreFact(b.GetProperty("ok").GetBoolean()&&!b.GetProperty("productExecuted").GetBoolean());
                            foreach(string key in new[]{"executableSha256","asarSha256","guardianSha256"}) RestoreFact(b.GetProperty(key).GetString()==p.GetProperty(key).GetString());
                            var sources=RestoreHashes(p.GetProperty("sources")); var required=new HashSet<string>(RestoreSharedSources,StringComparer.Ordinal);
                            foreach(string directory in RestoreDirectories) {
                                string full=Path.Combine(Repository(),directory.Replace('/',Path.DirectorySeparatorChar)); PinDirectory(full);
                                string[] entries=Directory.EnumerateFileSystemEntries(full).Take(65).ToArray(); RestoreFact(entries.Length>0&&entries.Length<=64);
                                foreach(string entry in entries) { RestoreFact(new[]{".ts",".ps1",".cs",".md"}.Contains(Path.GetExtension(entry))); required.Add(directory+"/"+Path.GetFileName(entry)); }
                            }
                            var modules=b.GetProperty("modules"); RestoreFact(modules.ValueKind==JsonValueKind.Array&&modules.GetArrayLength()>0&&modules.GetArrayLength()<=2048);
                            var moduleNames=new HashSet<string>(StringComparer.Ordinal);
                            foreach(var module in modules.EnumerateArray()) {
                                RestoreFields(module,"path","sha256"); string name=module.GetProperty("path").GetString(),sha=module.GetProperty("sha256").GetString();
                                RestoreFact(RestoreRelative(name)&&moduleNames.Add(name)&&CompletedHash(sha)&&sources.TryGetValue(name,out string current)&&current==sha); required.Add(name);
                            }
                            RestoreFact(required.SetEquals(sources.Keys));
                            RestoreFields(p.GetProperty("inputs"),"run.cjs","offline.cjs");
                            foreach(var input in p.GetProperty("inputs").EnumerateObject()) {
                                RestoreFact(input.Value.ValueKind==JsonValueKind.Array&&input.Value.GetArrayLength()>0&&input.Value.GetArrayLength()<=2048);
                                var names=new HashSet<string>(StringComparer.Ordinal);
                                foreach(var item in input.Value.EnumerateArray()) { string name=item.GetString(); RestoreFact(sources.ContainsKey(name)&&names.Add(name)); }
                            }
                            RestoreFields(p.GetProperty("rendered"),"run.cjs","offline.cjs");
                            foreach(var bundle in p.GetProperty("rendered").EnumerateObject()) {
                                RestoreFact(bundle.Value.ValueKind==JsonValueKind.Array&&bundle.Value.GetArrayLength()>0&&bundle.Value.GetArrayLength()<=2048);
                                var inputs=new HashSet<string>(p.GetProperty("inputs").GetProperty(bundle.Name).EnumerateArray().Select(v=>v.GetString()),StringComparer.Ordinal);
                                var rendered=new HashSet<string>(StringComparer.Ordinal);
                                foreach(var item in bundle.Value.EnumerateArray()) { string name=item.GetString(); RestoreFact(inputs.Contains(name)&&rendered.Add(name)&&!name.StartsWith("src/main/watch/qualification/",StringComparison.Ordinal)&&!name.Split('/').Contains("node_modules")); }
                                RestoreFact(rendered.Contains("tools/data-qualification/product-restore-campaign/"+(bundle.Name=="run.cjs"?"run.ts":"offline-entry.ts")));
                            }
                            foreach(var source in sources) {
                                var file=Pin(Path.Combine(Repository(),source.Key.Replace('/',Path.DirectorySeparatorChar)),Math.Min(8L<<20,(32L<<20)-sourceBytes),out long length);
                                sourceBytes+=length; RestoreFact(Hash(file,length)==source.Value);
                            }
                        }
                        string[] paths={"AIbrowse.exe","resources/app.asar","resources/lifecycle-guardian/guardian.exe"};
                        string[] keys={"executableSha256","asarSha256","guardianSha256"}; long[] maxima={512L<<20,32L<<20,4L<<20};
                        for(int i=0;i<paths.Length;i++) RestoreFact(HashFile(Path.Combine(packageRoot,paths[i].Replace('/',Path.DirectorySeparatorChar)),maxima[i])==p.GetProperty(keys[i]).GetString());
                        RestoreFact(HashFile(Node,128L<<20)==p.GetProperty("nodeSha256").GetString());
                        Proof=p.Clone(); Check();
                    }
                } catch { Dispose(); throw; }
            }
            public void Dispose() { foreach(var resource in held.AsEnumerable().Reverse())resource.Dispose(); held.Clear(); }
        }

        private static bool RestoreFailureReported(string journal,string scene)
        {
            string path=Path.Combine(journal,"runner-output","restore-campaign","report.json");
            if (!File.Exists(path)) return Directory.Exists(path);
            try {
                using(var file=DisposableNative.Open(path,false,true,1)) {
                    DisposableNative.Identity(file,path,false);
                    using(var report=ParseCompletedEvidence(DisposableNative.ReadUtf8Bounded(file,65536),65536)) {
                        var r=report.RootElement;
                        RestoreFields(r,"version","scene","ok","result","elapsedMs","pending","children","observers","leases","failure","outerJobReleaseRequired","productGoneChecks");
                        return r.GetProperty("version").GetInt32()!=1 || r.GetProperty("scene").GetString()!=scene || !r.GetProperty("ok").GetBoolean();
                    }
                }
            } catch (Win32Exception error) when (error.NativeErrorCode==32) { return false; }
            catch { return true; }
        }
        private static string RunRestore(string packageRoot,string nodeExecutable,ReleaseRunner runner,string scopeId,string proofSha)
        {
            Stopwatch original=Stopwatch.StartNew();
            RestoreFact(RestoreId(scopeId)&&CompletedHash(proofSha));
            packageRoot=Path.GetFullPath(packageRoot).TrimEnd(Path.DirectorySeparatorChar);
            nodeExecutable=Path.GetFullPath(nodeExecutable);
            string scene=runner==ReleaseRunner.RestoreR?"R":"P";
            int sceneBudget=RestoreBudget(runner);
            using(var admission=new RestoreAdmission(scopeId,proofSha,packageRoot,nodeExecutable,original))
            using(var guard=new ExclusiveGuard()) {
                CheckProcesses(); admission.Check();
                using(var lease=new DisposableLease(true)) {
                    admission.Check();
                    string runId=Guid.NewGuid().ToString("N"),journal=Path.Combine(EvidenceRoot(),"journal-"+runId);
                    DisposableNative.CreateDirectoryExclusive(journal); SecureDirectory(journal);
                    var manifest=new DisposableManifest { RunId=runId,DeclaredProfile=lease.Declared,ResolvedProfile=lease.Resolved,PackageExecutable=Path.Combine(packageRoot,"AIbrowse.exe"),BindingJournal="",RootIdentity=lease.Identity };
                    Durable(Path.Combine(journal,"manifest.json"),JsonSerializer.Serialize(manifest));
                    Durable(Path.Combine(lease.Declared,OwnerMarker),JsonSerializer.Serialize(new{version=1,runId,fileId128=lease.Identity.FileId128,volumeSerial64=lease.Identity.VolumeSerial64}));
                    using(var markerPin=DisposableNative.Open(Path.Combine(lease.Declared,OwnerMarker),false,true,1)) {
                        CheckMarker(manifest,lease);
                        string output=Path.Combine(journal,"runner-output"); DisposableNative.CreateDirectoryExclusive(output);
                        admission.Check();
                        long preflight=original.ElapsedMilliseconds;
                        Durable(Path.Combine(journal,"restore-admission.json"),JsonSerializer.Serialize(new{version=1,runId,scene,scopeId,proofSha256=proofSha,nodeExecutable,preflightElapsedMs=preflight,sceneBudgetMs=sceneBudget,toolBudgetMs=180000}));
                        uint? result=null; Exception failure=null; bool jobReleased=false,markerValidated=false;
                        try {
                            admission.Check();
                            preflight=original.ElapsedMilliseconds;
                            result=JobProcess.Execute(nodeExecutable,new[]{Path.Combine(admission.ScopePath,"run.cjs"),scene,admission.ScopePath,packageRoot,output,Path.GetDirectoryName(lease.Declared),journal,preflight.ToString(System.Globalization.CultureInfo.InvariantCulture)},Repository(),runId,sceneBudget,(pid,created)=>{
                                RecordProcessIdentity(journal,pid,"RunnerNode",created); admission.Check();
                                string temporary=Path.Combine(journal,"restore-start.json.tmp");
                                Durable(temporary,JsonSerializer.Serialize(new{version=1,runId,scene,proofSha256=proofSha,preflightElapsedMs=original.ElapsedMilliseconds}));
                                admission.Check(); File.Move(temporary,Path.Combine(journal,"restore-start.json")); admission.Check();
                            },original,()=>RestoreFailureReported(journal,scene));
                            RestoreFact(result==0&&original.ElapsedMilliseconds<sceneBudget);
                        } catch(Exception error) { failure=error; }
                        try { JobProcess.ConfirmReleased(runId); jobReleased=true; } catch(Exception error) { if(failure==null)failure=error; }
                        try { CheckMarker(manifest,lease); markerValidated=true; RestoreFact(original.ElapsedMilliseconds<sceneBudget); } catch(Exception error) { if(failure==null)failure=error; }
                        Durable(Path.Combine(journal,"restore-terminal.json"),JsonSerializer.Serialize(new{version=1,runId,scene,scopeId,proofSha256=proofSha,elapsedMs=original.ElapsedMilliseconds,sceneBudgetMs=sceneBudget,preflightElapsedMs=preflight,ok=failure==null&&result==0}));
                        if(original.ElapsedMilliseconds>=sceneBudget&&failure==null)failure=new InvalidOperationException("恢复终态关闭晚于原期限");
                        Durable(Path.Combine(journal,"terminal.json"),JsonSerializer.Serialize(new{version=1,runId,ok=failure==null&&result==0,result,jobReleased,markerValidated,failureType=failure==null?"":failure.GetType().FullName,failureMessage=failure==null?"":failure.Message}));
                        if(original.ElapsedMilliseconds>=sceneBudget&&failure==null) {
                            Durable(Path.Combine(journal,"restore-invalid.json"),"{\"version\":1,\"reason\":\"terminal-close-late\"}");
                            failure=new InvalidOperationException("恢复最终回执关闭晚于原期限");
                        }
                        if(failure!=null)throw new InvalidOperationException("恢复固定资格未通过；保留profile与原件",failure);
                        return journal;
                    }
                }
            }
        }

        public static string Run(string packageRoot, string nodeExecutable, ReleaseRunner runner, string bindingJournal)
        { return Run(packageRoot,nodeExecutable,runner,bindingJournal,"",""); }

        public static string Run(string packageRoot, string nodeExecutable, ReleaseRunner runner, string bindingJournal,string restoreScopeId,string restoreProofSha256)
        {
            if (IsRestore(runner)) {
                RestoreFact(String.IsNullOrEmpty(bindingJournal));
                return RunRestore(packageRoot,nodeExecutable,runner,restoreScopeId,restoreProofSha256);
            }
            RestoreFact(String.IsNullOrEmpty(restoreScopeId)&&String.IsNullOrEmpty(restoreProofSha256));
            using (ExclusiveGuard guard = new ExclusiveGuard())
            {
                CheckProcesses();
                packageRoot = Path.GetFullPath(packageRoot).TrimEnd(Path.DirectorySeparatorChar);
                string executable = Path.Combine(packageRoot, "AIbrowse.exe");
                if (!File.Exists(executable) || Path.GetFileName(nodeExecutable) != "node.exe") throw new InvalidOperationException("固定runner输入无效");
                TamperBinding tamperBinding = null;
                if (runner == ReleaseRunner.Tamper)
                {
                    if (String.IsNullOrEmpty(bindingJournal)) throw new InvalidOperationException("Tamper续验缺少Product绑定journal");
                    tamperBinding = ValidateTamperBinding(bindingJournal, packageRoot);
                }
                else if ((runner != ReleaseRunner.All && runner != ReleaseRunner.ProductTransfer) || !String.IsNullOrEmpty(bindingJournal))
                    throw new InvalidOperationException("固定runner与绑定参数组合无效");
                using (DisposableLease lease = new DisposableLease(true))
                {
                    string runId = Guid.NewGuid().ToString("N");
                    string journal = Path.Combine(EvidenceRoot(), "journal-" + runId);
                    DisposableNative.CreateDirectoryExclusive(journal);
                    SecureDirectory(journal);
                    DisposableManifest manifest = new DisposableManifest {
                        RunId = runId, DeclaredProfile = lease.Declared, ResolvedProfile = lease.Resolved,
                        PackageExecutable = executable, BindingJournal = bindingJournal ?? "", RootIdentity = lease.Identity
                    };
                    Durable(Path.Combine(journal, "manifest.json"), JsonSerializer.Serialize(manifest));
                    if (tamperBinding != null)
                        Durable(Path.Combine(journal, "tamper-binding.json"), JsonSerializer.Serialize(tamperBinding));
                    string markerPath = Path.Combine(lease.Declared, OwnerMarker);
                    Durable(markerPath, JsonSerializer.Serialize(new {
                        version = 1, runId, fileId128 = lease.Identity.FileId128, volumeSerial64 = lease.Identity.VolumeSerial64
                    }));
                    using (SafeFileHandle markerPin = DisposableNative.Open(markerPath, false, true, 1))
                    {
                        CheckMarker(manifest, lease);
                        string output = Path.Combine(journal, "runner-output");
                        DisposableNative.CreateDirectoryExclusive(output);
                        string script = runner == ReleaseRunner.ProductTransfer
                            ? Path.Combine(Repository(), "tools", "data-qualification", "product-transfer", "run.ts")
                            : Path.Combine(Repository(), "tools", "release", runner == ReleaseRunner.All ? "run-release-checks.ts" : "run-tamper-tests.ts");
                        uint? result = null;
                        Exception failure = null;
                        bool jobReleased = false;
                        bool markerValidated = false;
                        try
                        {
                            result = JobProcess.Execute(nodeExecutable, new[] {
                                "--experimental-strip-types", script, packageRoot, output,
                                Path.GetDirectoryName(lease.Declared), journal
                            }, Repository(), runId, 600000, (pid, created) => {
                                RecordProcessIdentity(journal, pid, "RunnerNode", created);
                            });
                            if (result != 0) failure = new InvalidOperationException("固定runner失败；disposable profile与原件均保留");
                        }
                        catch (Exception error) { failure = error; }
                        try
                        {
                            JobProcess.ConfirmReleased(runId);
                            jobReleased = true;
                        }
                        catch (Exception error) { if (failure == null) failure = error; }
                        try
                        {
                            CheckMarker(manifest, lease);
                            markerValidated = true;
                        }
                        catch (Exception error) { if (failure == null) failure = error; }
                        Durable(Path.Combine(journal, "terminal.json"), JsonSerializer.Serialize(new {
                            version = 1, runId, ok = failure == null && result == 0,
                            result, jobReleased, markerValidated,
                            failureType = failure == null ? "" : failure.GetType().FullName,
                            failureMessage = failure == null ? "" : failure.Message
                        }));
                        if (failure != null) throw new InvalidOperationException("固定资格未通过；disposable profile与全部原件均保留", failure);
                        return journal;
                    }
                }
            }
        }

        public static string RecordProcessIdentity(string journal, uint processId, string label, long expectedCreated = 0)
        {
            if (!new[] { "RunnerNode", "ProductOriginal", "ProductSecond", "ProductRestart", "TamperOriginal" }.Contains(label))
                throw new InvalidOperationException("未知进程探针标签");
            DisposableManifest manifest = Load(journal);
            JobProcess.AssertContains(manifest.RunId, processId);
            using (DisposableLease lease = new DisposableLease(false))
            {
                CheckMarker(manifest, lease);
                using (SafeFileHandle process = DisposableNative.OpenProcess(0x1000, false, processId))
                {
                    if (process.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法打开受控进程");
                    if (!GetProcessTimesForIdentity(process, out long actualCreated)) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法读取受控进程创建时间");
                    if (expectedCreated != 0 && actualCreated != expectedCreated) throw new InvalidOperationException("受控进程PID已被复用");
                    StringBuilder image = new StringBuilder(2048);
                    uint imageLength = (uint)image.Capacity;
                    if (!DisposableNative.QueryFullProcessImageNameW(process, 0, image, ref imageLength)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    if (label == "RunnerNode")
                    {
                        if (!String.Equals(Path.GetFileName(image.ToString()), "node.exe", StringComparison.OrdinalIgnoreCase))
                            throw new InvalidOperationException("runner根进程不是固定node.exe");
                    }
                    else if (!String.Equals(Path.GetFullPath(image.ToString()), manifest.PackageExecutable, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("受控产品进程不属于最终候选EXE");
                    uint packageLength = 0;
                    int status = DisposableNative.GetPackageFullName(process, ref packageLength, null);
                    string packageName = "";
                    if (status == 122 && packageLength > 0 && packageLength <= 4096)
                    {
                        StringBuilder package = new StringBuilder((int)packageLength);
                        status = DisposableNative.GetPackageFullName(process, ref packageLength, package);
                        if (status == 0) packageName = package.ToString();
                    }
                    if (status != 0 && status != 15700) throw new Win32Exception(status, "无法读取进程package identity");
                    string output = Path.Combine(journal, "runner-output", "process-" + label + "-" + processId + ".json");
                    Durable(output, JsonSerializer.Serialize(new {
                        version = 1, runId = manifest.RunId, pid = processId, label,
                        processCreatedFileTime = actualCreated.ToString(),
                        imagePath = image.ToString(), packageStatus = status, packageFullName = packageName,
                        probeRootFileId128 = lease.Identity.FileId128, probeRootVolumeSerial64 = lease.Identity.VolumeSerial64
                    }));
                    return output;
                }
            }
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetProcessTimes(SafeFileHandle process, out long created, out long exited, out long kernel, out long user);

        private static bool GetProcessTimesForIdentity(SafeFileHandle process, out long created)
        {
            return GetProcessTimes(process, out created, out _, out _, out _);
        }
    }
}
