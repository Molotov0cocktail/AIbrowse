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
    public enum ReleaseRunner
    {
        Tamper,
        Product,
        All,
        ProductTransfer,
        RestoreR,
        RestoreP
    }

    public sealed class Identity
    {
        public string FileId { get; set; } = "";
        public string Sddl { get; set; } = "";
        public string VolumeSerial { get; set; } = "";
        public string FileSystem { get; set; } = "";
        public string FinalPath { get; set; } = "";
    }

    public sealed class Manifest
    {
        public int Version { get; set; } = 1;
        public string RunId { get; set; } = "";
        public string Parent { get; set; } = "";
        public Identity ParentIdentity { get; set; } = new Identity();
        public Identity OriginalIdentity { get; set; } = new Identity();
        public Identity SyntheticIdentity { get; set; } = new Identity();
        public bool Fixture { get; set; }
    }

    public sealed class DirectoryLease : IDisposable
    {
        internal SafeFileHandle Handle;
        public Identity Identity { get; private set; }

        public DirectoryLease(string path, bool movable)
        {
            Handle = Native.Open(path, 0x20080u | (movable ? 0x10000u : 0u), 3, true);
            try
            {
                Identity = Native.Identity(Handle, true);
                Native.AssertFinalPath(Identity, path);
            }
            catch { Handle.Dispose(); throw; }
        }

        public void Dispose() { Handle.Dispose(); }
    }

    internal sealed class Scope : IDisposable
    {
        private readonly List<DirectoryLease> ancestors = new List<DirectoryLease>();
        private readonly Mutex mutex;
        public DirectoryLease Parent { get; private set; }

        public Scope(string parent)
        {
            byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes(parent.ToUpperInvariant()));
            mutex = new Mutex(false, "Local\\AIbrowse.ReleaseProfile." + Convert.ToHexString(digest));
            bool held;
            try { held = mutex.WaitOne(0); }
            catch (AbandonedMutexException) { held = true; }
            if (!held) { mutex.Dispose(); throw new InvalidOperationException("隔离或恢复已由另一进程持有"); }
            try
            {
                string root = Path.GetPathRoot(parent);
                if (Native.GetDriveType(root) != 3 || new DriveInfo(root).DriveFormat != "NTFS")
                    throw new InvalidOperationException("只接受本地固定 NTFS 卷");
                string current = root;
                ancestors.Add(new DirectoryLease(current, false));
                foreach (string part in parent.Substring(root.Length).Split(Path.DirectorySeparatorChar))
                {
                    current = Path.Combine(current, part);
                    ancestors.Add(new DirectoryLease(current, false));
                }
                Parent = ancestors[ancestors.Count - 1];
            }
            catch { Dispose(); throw; }
        }

        public void Dispose()
        {
            foreach (DirectoryLease item in ancestors.AsEnumerable().Reverse()) item.Dispose();
            ancestors.Clear();
            try { mutex.ReleaseMutex(); } catch (ApplicationException) { }
            mutex.Dispose();
        }
    }

    internal static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        internal struct FileInfo
        {
            public uint Attributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
            public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct RenameInfo
        {
            public uint Flags;
            public IntPtr Root;
            public uint NameLength;
            public ushort Name;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int type, byte[] buffer, uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool GetVolumeInformationByHandleW(SafeFileHandle file, StringBuilder volumeName, uint volumeNameSize,
            out uint serial, out uint componentLength, out uint flags, StringBuilder fileSystem, uint fileSystemSize);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetKernelObjectSecurity(SafeFileHandle handle, uint requested, byte[] descriptor, uint length, out uint required);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetFileInformationByHandle(SafeFileHandle file, int type, IntPtr buffer, uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint length, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        internal static extern uint GetDriveType(string root);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateDirectoryW(string path, IntPtr security);

        internal static void CreateNewDirectory(string path)
        {
            if (!CreateDirectoryW(path, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "唯一目录创建失败，禁止认领已存在对象");
        }

        internal static SafeFileHandle Open(string path, uint access, uint share, bool directory)
        {
            SafeFileHandle handle = CreateFileW(path, access, share, IntPtr.Zero, 3,
                0x00200000u | (directory ? 0x02000000u : 0u), IntPtr.Zero);
            if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error(), "无法独占所需目录或文件身份"); }
            return handle;
        }

        internal static Identity Identity(SafeFileHandle handle, bool directory)
        {
            if (!GetFileInformationByHandle(handle, out FileInfo info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory)
                throw new InvalidOperationException("拒绝重解析点或非预期对象类型");
            if (!directory && info.Links != 1) throw new InvalidOperationException("合成文件不能具有硬链接");
            GetKernelObjectSecurity(handle, 7, null, 0, out uint required);
            if (required == 0 || required > 65536) throw new InvalidOperationException("ACL 读取预算无效");
            byte[] bytes = new byte[required];
            if (!GetKernelObjectSecurity(handle, 7, bytes, required, out required)) throw new Win32Exception(Marshal.GetLastWin32Error());
            byte[] fileId = new byte[24];
            StringBuilder fileSystem = new StringBuilder(64), finalPath = new StringBuilder(512);
            if (!GetFileInformationByHandleEx(handle, 18, fileId, 24) ||
                !GetVolumeInformationByHandleW(handle, null, 0, out uint volumeSerial, out _, out _, fileSystem, 64))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "无法确认句柄实际卷身份");
            uint pathLength = GetFinalPathNameByHandleW(handle, finalPath, 512, 0);
            ulong serial64 = BitConverter.ToUInt64(fileId, 0);
            if (pathLength == 0 || pathLength >= 512 || volumeSerial != info.Volume || (uint)serial64 != info.Volume || fileSystem.ToString() != "NTFS")
                throw new InvalidOperationException("实际句柄卷信息不一致或不是 NTFS");
            return new Identity { FileId = info.Volume.ToString("X8") + ":" + info.IndexHigh.ToString("X8") + info.IndexLow.ToString("X8"),
                Sddl = new RawSecurityDescriptor(bytes, 0).GetSddlForm(AccessControlSections.Owner | AccessControlSections.Group | AccessControlSections.Access),
                VolumeSerial = serial64.ToString("X16"), FileSystem = fileSystem.ToString(), FinalPath = finalPath.ToString() };
        }

        internal static void AssertFinalPath(Identity identity, string expected)
        {
            if (!String.Equals(identity.FinalPath.TrimEnd('\\'), ("\\\\?\\" + Path.GetFullPath(expected)).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("句柄实际路径不符合固定目标，拒绝路径别名或重定向");
        }

        internal static void SameVolume(Identity first, Identity second)
        {
            if (String.IsNullOrEmpty(first.VolumeSerial) || first.VolumeSerial != second.VolumeSerial || first.FileSystem != "NTFS" || second.FileSystem != "NTFS")
                throw new InvalidOperationException("父目录与 profile 实际句柄不在同一 NTFS 卷，禁止切换");
        }

        internal static void Rename(DirectoryLease source, string destination)
        {
            byte[] name = Encoding.Unicode.GetBytes(destination);
            int offset = Marshal.OffsetOf<RenameInfo>(nameof(RenameInfo.Name)).ToInt32();
            int size = offset + name.Length + 2;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.Copy(new byte[size], 0, buffer, size);
                Marshal.WriteInt32(buffer, Marshal.OffsetOf<RenameInfo>(nameof(RenameInfo.NameLength)).ToInt32(), name.Length);
                Marshal.Copy(name, 0, IntPtr.Add(buffer, offset), name.Length);
                if (!SetFileInformationByHandle(source.Handle, 3, buffer, (uint)size))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "同父原子重命名失败；保留全部目录");
                AssertFinalPath(Identity(source.Handle, true), destination);
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
    }

    public static class Isolation
    {
        public const string OwnerMarker = ".aibrowse-e1-synthetic-owner.json";
        public static readonly string[] FaultPoints = {
            "manifest", "synthetic-created", "synthetic-identified", "marker-written", "ready",
            "protect-intent", "protect-renamed", "protect-done", "activate-intent", "activate-renamed", "activate-done",
            "job-intent", "job-started", "job-zero",
            "retire-intent", "retire-renamed", "retire-done", "restore-intent", "restore-renamed", "restore-done", "complete"
        };

        private static string Canonical(string path)
        {
            if (String.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path) || path.StartsWith("\\\\") || path.IndexOf(':', 2) >= 0)
                throw new InvalidOperationException("只接受绝对本地目录");
            string result = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar);
            if (result.Length < 4 || result.Length > 220 || result != path.TrimEnd(Path.DirectorySeparatorChar))
                throw new InvalidOperationException("目录必须规范且在路径预算内");
            return result;
        }

        private static string Child(Manifest manifest, string kind)
        {
            string name = kind == "active" ? "aibrowse" : ".aibrowse-e1-" + kind + "-" + manifest.RunId;
            string value = Path.Combine(manifest.Parent, name);
            if (Path.GetDirectoryName(value) != manifest.Parent) throw new InvalidOperationException("目录越出明确父目录");
            return value;
        }

        private static bool Exists(string path)
        {
            try { File.GetAttributes(path); return true; }
            catch (FileNotFoundException) { return false; }
            catch (DirectoryNotFoundException) { return false; }
        }

        private static void Equal(Identity actual, Identity expected)
        {
            if (actual.FileId != expected.FileId || actual.Sddl != expected.Sddl ||
                (expected.VolumeSerial != "" && actual.VolumeSerial != expected.VolumeSerial) ||
                (expected.FileSystem != "" && actual.FileSystem != expected.FileSystem))
                throw new InvalidOperationException("目录 FileID 或 ACL 已变化，必须保留现场待恢复");
        }

        private static void Durable(string file, string contents, bool append)
        {
            if (append && Exists(file))
            {
                using (SafeFileHandle handle = Native.Open(file, 0x40020000, 1, false))
                {
                    Native.Identity(handle, false);
                    using (FileStream stream = new FileStream(handle, FileAccess.Write))
                    {
                        stream.Seek(0, SeekOrigin.End);
                        stream.Write(Encoding.UTF8.GetBytes(contents + "\n"));
                        stream.Flush(true);
                    }
                }
            }
            else
            {
                using (FileStream stream = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough))
                {
                    stream.Write(Encoding.UTF8.GetBytes(contents + "\n"));
                    stream.Flush(true);
                }
            }
        }

        private static void Event(string journal, string stage, string fault)
        {
            string events = Path.Combine(journal, "events.jsonl");
            if (Exists(events) && new FileInfo(events).Length > 65536) throw new InvalidOperationException("隔离日志超出预算，保留现场待恢复");
            Durable(events, JsonSerializer.Serialize(new { stage, utc = DateTime.UtcNow }), true);
            if (stage == fault) Environment.Exit(91);
        }

        private static void CheckProcesses()
        {
            // Process names are intentionally conservative; no command line or private profile contents are read.
            foreach (string name in new[] { "aibrowse", "electron" })
            {
                Process[] processes = Process.GetProcessesByName(name);
                try
                {
                    if (processes.Length != 0) throw new InvalidOperationException("AIbrowse 或 Electron 进程仍存在，不能切换 profile");
                }
                finally { foreach (Process process in processes) process.Dispose(); }
            }
        }

        public static string Preflight(string parent)
        {
            parent = Canonical(parent);
            using (Scope scope = new Scope(parent))
            using (DirectoryLease original = new DirectoryLease(Path.Combine(parent, "aibrowse"), false))
            {
                Native.SameVolume(scope.Parent.Identity, original.Identity);
                CheckProcesses();
                return JsonSerializer.Serialize(new { ok = true, parentIdentity = scope.Parent.Identity, originalIdentity = original.Identity,
                    originalContentsRead = false, localNtfs = true, noReparseAncestors = true });
            }
        }

        private static void EnsureTarget(Manifest manifest)
        {
            Canonical(manifest.Parent);
            if (manifest.Version != 1 || !Guid.TryParseExact(manifest.RunId, "N", out _)) throw new InvalidOperationException("隔离清单版本或 UUID 无效");
            string actual = Canonical(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData));
            if (!manifest.Fixture && !String.Equals(manifest.Parent, actual, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("恢复父目录不等于 Windows KnownFolder");
            if (manifest.Fixture)
            {
                string fixtures = Canonical(Path.Combine(Repository(), "log", "stage7-e1", "profile-isolation"));
                if (!manifest.Parent.StartsWith(fixtures + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("合成夹具越出固定证据目录");
            }
        }

        private static string Repository()
        {
            string root = Environment.GetEnvironmentVariable("AIBROWSE_PROFILE_TOOL_REPOSITORY");
            if (String.IsNullOrEmpty(root)) throw new InvalidOperationException("缺少工具源码目录绑定");
            return Canonical(root);
        }

        private static void CheckJournal(string journal, Manifest manifest)
        {
            journal = Canonical(journal);
            string evidence = Path.Combine(Repository(), "log", "stage7-e1", "profile-isolation");
            if (Path.GetDirectoryName(journal) != evidence || Path.GetFileName(journal) != "journal-" + manifest.RunId)
                throw new InvalidOperationException("清单位置不属于固定隔离证据目录");
            if (journal.StartsWith(manifest.Parent + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("清单不能位于被切换目录内");
        }

        private static void CheckJournalLocation(string journal)
        {
            journal = Canonical(journal);
            string evidence = Path.Combine(Repository(), "log", "stage7-e1", "profile-isolation");
            string name = Path.GetFileName(journal);
            if (Path.GetDirectoryName(journal) != evidence || !name.StartsWith("journal-") || !Guid.TryParseExact(name.Substring(8), "N", out _))
                throw new InvalidOperationException("恢复只接受固定证据目录中的 UUID journal");
        }

        private static void Rename(string source, string destination, Identity identity, string journal, string stage, string fault)
        {
            if (Path.GetDirectoryName(source) != Path.GetDirectoryName(destination)) throw new InvalidOperationException("仅允许同父重命名");
            using (DirectoryLease lease = new DirectoryLease(source, true))
            {
                RenamePinned(lease, destination, identity, journal, stage, fault);
            }
        }

        private static void RenamePinned(DirectoryLease lease, string destination, Identity identity, string journal, string stage, string fault)
        {
            using (DirectoryLease destinationParent = new DirectoryLease(Path.GetDirectoryName(destination), false))
            {
            Identity current = Native.Identity(lease.Handle, true);
            Equal(current, identity);
            Native.SameVolume(destinationParent.Identity, current);
            if (Exists(destination)) throw new InvalidOperationException("目标已存在，禁止覆盖未知目录");
            Event(journal, stage + "-intent", fault);
            Native.Rename(lease, destination);
            Equal(Native.Identity(lease.Handle, true), identity);
            Event(journal, stage + "-renamed", fault);
            Event(journal, stage + "-done", fault);
            }
        }

        public static string Prepare(string parent, bool fixture, string fault)
        {
            Manifest manifest = new Manifest { RunId = Guid.NewGuid().ToString("N"), Parent = Canonical(parent), Fixture = fixture };
            EnsureTarget(manifest);
            string journal = Path.Combine(Repository(), "log", "stage7-e1", "profile-isolation", "journal-" + manifest.RunId);
            CheckJournal(journal, manifest);
            using (Scope scope = new Scope(parent))
            using (DirectoryLease original = new DirectoryLease(Child(manifest, "active"), false))
            {
                Native.SameVolume(scope.Parent.Identity, original.Identity);
                CheckProcesses();
                manifest.ParentIdentity = scope.Parent.Identity;
                manifest.OriginalIdentity = original.Identity;
                Native.CreateNewDirectory(journal);
                DirectorySecurity security = new DirectorySecurity();
                SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
                security.SetAccessRuleProtection(true, false);
                security.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                FileSystemAclExtensions.SetAccessControl(new DirectoryInfo(journal), security);
                Durable(Path.Combine(journal, "manifest.json"), JsonSerializer.Serialize(manifest), false);
                Event(journal, "manifest", fault);
                string synthetic = Child(manifest, "synthetic");
                if (Exists(synthetic)) throw new InvalidOperationException("合成目录发生碰撞");
                Native.CreateNewDirectory(synthetic);
                Event(journal, "synthetic-created", fault);
                using (DirectoryLease staged = new DirectoryLease(synthetic, false)) manifest.SyntheticIdentity = staged.Identity;
                Native.SameVolume(scope.Parent.Identity, manifest.SyntheticIdentity);
                Durable(Path.Combine(journal, "synthetic.json"), JsonSerializer.Serialize(manifest.SyntheticIdentity), false);
                Event(journal, "synthetic-identified", fault);
                Durable(Path.Combine(synthetic, OwnerMarker), JsonSerializer.Serialize(new { runId = manifest.RunId, fileId = manifest.SyntheticIdentity.FileId }), false);
                Event(journal, "marker-written", fault);
                Event(journal, "ready", fault);
            }
            return journal;
        }

        private static Manifest Load(string journal)
        {
            journal = Canonical(journal);
            CheckJournalLocation(journal);
            using (DirectoryLease root = new DirectoryLease(journal, false))
            {
                string file = Path.Combine(journal, "manifest.json");
                if (new FileInfo(file).Length > 16384) throw new InvalidOperationException("清单超限");
                using (SafeFileHandle handle = Native.Open(file, 0x80020000, 1, false))
                {
                    Native.Identity(handle, false);
                    using (FileStream stream = new FileStream(handle, FileAccess.Read))
                    {
                        if (stream.Length > 16384) throw new InvalidOperationException("清单超限");
                        return JsonSerializer.Deserialize<Manifest>(stream) ?? throw new InvalidOperationException("清单无效");
                    }
                }
            }
        }

        private static void LoadSynthetic(string journal, Manifest manifest)
        {
            string file = Path.Combine(journal, "synthetic.json");
            if (!Exists(file)) return;
            if (new FileInfo(file).Length > 16384) throw new InvalidOperationException("合成身份超限");
            using (SafeFileHandle handle = Native.Open(file, 0x80020000, 1, false))
            {
                Native.Identity(handle, false);
                using (FileStream stream = new FileStream(handle, FileAccess.Read))
                {
                    if (stream.Length > 16384) throw new InvalidOperationException("合成身份超限");
                    manifest.SyntheticIdentity = JsonSerializer.Deserialize<Identity>(stream) ?? throw new InvalidOperationException("合成身份无效");
                }
            }
        }

        private static void CheckMarker(string path, Manifest manifest)
        {
            string marker = Path.Combine(path, OwnerMarker);
            using (SafeFileHandle handle = Native.Open(marker, 0x80020000, 1, false))
            {
                Native.Identity(handle, false);
                using (FileStream stream = new FileStream(handle, FileAccess.Read))
                {
                    if (stream.Length > 1024) throw new InvalidOperationException("owner marker 超限");
                    using (JsonDocument doc = JsonDocument.Parse(stream))
                    {
                        if (doc.RootElement.GetProperty("runId").GetString() != manifest.RunId || doc.RootElement.GetProperty("fileId").GetString() != manifest.SyntheticIdentity.FileId)
                            throw new InvalidOperationException("合成 owner marker 不匹配");
                    }
                }
            }
        }

        private static List<IDisposable> LockSynthetic(string path, Manifest manifest)
        {
            List<IDisposable> leases = new List<IDisposable>();
            try
            {
                CheckMarker(path, manifest);
                Queue<string> pending = new Queue<string>();
                pending.Enqueue(path);
                int count = 0;
                Stopwatch budget = Stopwatch.StartNew();
                while (pending.Count != 0)
                {
                    string current = pending.Dequeue();
                    if (++count > 4096 || budget.Elapsed.TotalSeconds > 10) throw new InvalidOperationException("合成目录释放确认超出预算");
                    if (current != path) leases.Add(new DirectoryLease(current, false));
                    foreach (string item in Directory.EnumerateFileSystemEntries(current))
                    {
                        if (++count > 4096 || budget.Elapsed.TotalSeconds > 10) throw new InvalidOperationException("合成目录释放确认超出预算");
                        FileAttributes attrs = File.GetAttributes(item);
                        if ((attrs & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("合成目录含重解析点，保留待恢复");
                        if ((attrs & FileAttributes.Directory) != 0) pending.Enqueue(item);
                        else
                        {
                            SafeFileHandle handle = Native.Open(item, 0x80020000, 4, false);
                            leases.Add(handle);
                            Native.Identity(handle, false);
                        }
                    }
                }
                return leases;
            }
            catch { foreach (IDisposable lease in leases.AsEnumerable().Reverse()) lease.Dispose(); throw; }
        }

        private static void RestoreLocked(string journal, Manifest manifest, Scope scope, string fault)
        {
            Equal(Native.Identity(scope.Parent.Handle, true), manifest.ParentIdentity);
            JobProcess.ConfirmReleased(manifest.RunId);
            CheckProcesses();
            string active = Child(manifest, "active"), original = Child(manifest, "original"), retired = Child(manifest, "retired");
            if (!Exists(original))
            {
                using (DirectoryLease root = new DirectoryLease(active, false))
                {
                    Equal(root.Identity, manifest.OriginalIdentity);
                    Native.SameVolume(scope.Parent.Identity, root.Identity);
                }
                Event(journal, "complete", fault);
                return;
            }
            using (DirectoryLease protectedRoot = new DirectoryLease(original, false))
            {
                Equal(protectedRoot.Identity, manifest.OriginalIdentity);
                Native.SameVolume(scope.Parent.Identity, protectedRoot.Identity);
            }
            if (Exists(active))
            {
                using (DirectoryLease current = new DirectoryLease(active, true))
                {
                    Equal(current.Identity, manifest.SyntheticIdentity);
                    Native.SameVolume(scope.Parent.Identity, current.Identity);
                    List<IDisposable> locks = LockSynthetic(active, manifest);
                    // Windows refuses directory rename while descendant handles are open, even with FILE_SHARE_DELETE.
                    // The root DELETE handle stays pinned after the bounded exclusive-open proof is released.
                    foreach (IDisposable item in locks.AsEnumerable().Reverse()) item.Dispose();
                    CheckProcesses();
                    Equal(Native.Identity(scope.Parent.Handle, true), manifest.ParentIdentity);
                    RenamePinned(current, retired, manifest.SyntheticIdentity, journal, "retire", fault);
                }
            }
            if (Exists(retired))
            {
                using (DirectoryLease root = new DirectoryLease(retired, false))
                {
                    Equal(root.Identity, manifest.SyntheticIdentity);
                    Native.SameVolume(scope.Parent.Identity, root.Identity);
                }
                CheckMarker(retired, manifest);
            }
            CheckProcesses();
            Equal(Native.Identity(scope.Parent.Handle, true), manifest.ParentIdentity);
            Rename(original, active, manifest.OriginalIdentity, journal, "restore", fault);
            using (DirectoryLease restored = new DirectoryLease(active, false))
            {
                Equal(restored.Identity, manifest.OriginalIdentity);
                Native.SameVolume(scope.Parent.Identity, restored.Identity);
            }
            Event(journal, "complete", fault);
        }

        public static void Restore(string journal, string fault)
        {
            CheckJournalLocation(journal);
            using (Scope journalScope = new Scope(journal))
            {
            Manifest manifest = Load(journal);
            EnsureTarget(manifest);
            CheckJournal(journal, manifest);
            LoadSynthetic(journal, manifest);
            using (Scope scope = new Scope(manifest.Parent)) RestoreLocked(journal, manifest, scope, fault);
            }
        }

        public static void Exercise(string journal, string fault)
        {
            CheckJournalLocation(journal);
            using (Scope journalScope = new Scope(journal))
            {
            Manifest manifest = Load(journal);
            EnsureTarget(manifest);
            CheckJournal(journal, manifest);
            LoadSynthetic(journal, manifest);
            if (!manifest.Fixture) throw new InvalidOperationException("故障入口仅接受合成夹具");
            using (Scope scope = new Scope(manifest.Parent))
            {
                Activate(journal, manifest, scope, fault);
                if (fault.StartsWith("job-", StringComparison.Ordinal))
                {
                    string node = Environment.GetEnvironmentVariable("AIBROWSE_PROFILE_TOOL_NODE");
                    if (String.IsNullOrEmpty(node)) throw new InvalidOperationException("合成 Job 夹具缺少 Node");
                    Event(journal, "job-intent", fault);
                    uint code = JobProcess.Execute(node, new[] { Path.Combine(Repository(), "tools", "release-profile", "fixture-job.mjs"), "timeout" },
                        Repository(), manifest.RunId, 10000, (pid, created) => Event(journal, "job-started", fault));
                    if (code != 0) throw new InvalidOperationException("合成 Job 夹具失败");
                    Event(journal, "job-zero", fault);
                }
                RestoreLocked(journal, manifest, scope, fault);
            }
            }
        }

        public static string Run(string packageRoot, string nodeExecutable, ReleaseRunner runner)
        {
            string parent = Canonical(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData));
            packageRoot = Canonical(packageRoot);
            nodeExecutable = Path.GetFullPath(nodeExecutable);
            if (!String.Equals(Path.GetFileName(nodeExecutable), "node.exe", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("固定入口需要本机 node.exe");
            using (Scope scope = new Scope(parent))
            {
                string journal = Prepare(parent, false, "");
                Console.WriteLine("隔离恢复清单：" + journal);
                Console.WriteLine("异常中断后运行 tools/release-profile/profile-isolation.ps1 -Action Restore -Journal <上述清单目录>。");
                using (Scope journalScope = new Scope(journal))
                {
                    Manifest manifest = Load(journal);
                    LoadSynthetic(journal, manifest);
                    uint result = 0;
                    try
                    {
                        Activate(journal, manifest, scope, "");
                        string output = Path.Combine(journal, "runner-output");
                        Native.CreateNewDirectory(output);
                        Event(journal, "job-intent", "");
                        string runnerScript = runner switch
                        {
                            ReleaseRunner.Tamper => "run-tamper-tests.ts",
                            ReleaseRunner.Product => "run-packaged-product-checks.ts",
                            _ => throw new InvalidOperationException("未知固定验收入口")
                        };
                        result = JobProcess.Execute(nodeExecutable, new[] {
                            Path.Combine(Repository(), "tools", "release", runnerScript),
                            packageRoot, output, parent, journal
                        }, Repository(), manifest.RunId, 300000, (pid, created) => {
                            Durable(Path.Combine(journal, "owned-process.json"), JsonSerializer.Serialize(new { pid, creationFileTime = created }), false);
                            Event(journal, "job-started", "");
                        });
                        Event(journal, "job-zero", "");
                    }
                    catch
                    {
                        Event(journal, "run-failed", "");
                        throw;
                    }
                    finally
                    {
                        // Restore errors remain visible. No directory or evidence is deleted, including on runner failure.
                        RestoreLocked(journal, manifest, scope, "");
                    }
                    if (result != 0) throw new InvalidOperationException("固定验收工具失败，原 profile 已恢复；详见 journal 中证据");
                    return journal;
                }
            }
        }

        private static void Activate(string journal, Manifest manifest, Scope scope, string fault)
        {
            Equal(Native.Identity(scope.Parent.Handle, true), manifest.ParentIdentity);
            CheckProcesses();
            string synthetic = Child(manifest, "synthetic");
            using (DirectoryLease root = new DirectoryLease(synthetic, false))
            {
                Equal(root.Identity, manifest.SyntheticIdentity);
                Native.SameVolume(scope.Parent.Identity, root.Identity);
            }
            CheckMarker(synthetic, manifest);
            Rename(Child(manifest, "active"), Child(manifest, "original"), manifest.OriginalIdentity, journal, "protect", fault);
            Rename(synthetic, Child(manifest, "active"), manifest.SyntheticIdentity, journal, "activate", fault);
        }
    }
}
