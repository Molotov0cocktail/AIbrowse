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

        public static string Run(string packageRoot, string nodeExecutable, ReleaseRunner runner, string bindingJournal)
        {
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
                else if (runner != ReleaseRunner.All || !String.IsNullOrEmpty(bindingJournal))
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
                        string script = runner == ReleaseRunner.All ? "run-release-checks.ts" : "run-tamper-tests.ts";
                        uint? result = null;
                        Exception failure = null;
                        bool jobReleased = false;
                        bool markerValidated = false;
                        try
                        {
                            result = JobProcess.Execute(nodeExecutable, new[] {
                                "--experimental-strip-types", Path.Combine(Repository(), "tools", "release", script), packageRoot, output,
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
