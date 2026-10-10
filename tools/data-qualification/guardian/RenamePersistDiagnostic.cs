using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Synthetic entry point for a source-bound Guardian.Persist rename candidate.
internal static class RenamePersistDiagnostic
{
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct FileInfo
    {
        public uint Attributes; public long Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct RenameLayout
    {
        public byte ReplaceIfExists; public IntPtr RootDirectory;
        public uint FileNameLength; public ushort FileName;
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateDirectoryW(string directory, IntPtr security);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, IntPtr value, uint length);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetKernelObjectSecurity(SafeFileHandle file, uint information, byte[] descriptor, uint length, out uint required);

    private sealed class SecurityFact
    {
        public uint requestedInformation = 7;
        public bool querySucceeded;
        public uint queriedBytes;
        public int controlFlags, daclAceCount;
        public string sha256;
    }
    private sealed class Pins : IDisposable
    {
        internal readonly List<SafeFileHandle> Handles = new List<SafeFileHandle>();
        internal string Directory;
        public void Dispose()
        {
            if (activePins == this) activePins = null;
            for (int i = Handles.Count - 1; i >= 0; i--) Handles[i].Dispose();
            Handles.Clear();
        }
    }
    private static readonly Stopwatch Clock = Stopwatch.StartNew();
    private static readonly List<object> Events = new List<object>();
    private static readonly Type Product = typeof(Guardian);
    private const BindingFlags PrivateStatic = BindingFlags.NonPublic | BindingFlags.Static;
    private static Pins activePins;
    private static string current = "entry", dataDirectory;
    private static int generation;

    private static void Need(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
    private static string Hash(byte[] value)
    {
        using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(value)).Replace("-", "").ToLowerInvariant();
    }
    public static string LayoutProof()
    {
        Need(IntPtr.Size == 8 && Marshal.SizeOf(typeof(FileInfo)) == 52 && Marshal.OffsetOf(typeof(FileInfo), "Written").ToInt32() == 20 && Marshal.OffsetOf(typeof(FileInfo), "Volume").ToInt32() == 28 && Marshal.OffsetOf(typeof(FileInfo), "IndexLow").ToInt32() == 48, "Win32文件身份布局错误");
        Need(Marshal.SizeOf(typeof(RenameLayout)) == 24 && Marshal.OffsetOf(typeof(RenameLayout), "RootDirectory").ToInt32() == 8 && Marshal.OffsetOf(typeof(RenameLayout), "FileNameLength").ToInt32() == 16 && Marshal.OffsetOf(typeof(RenameLayout), "FileName").ToInt32() == 20, "Win32重命名布局错误");
        return "x64: FileInfo=52/Written=20/Volume=28/IndexLow=48; Rename=24/RootDirectory=8/FileNameLength=16/FileName=20";
    }
    private static FileInfo Info(SafeFileHandle handle)
    {
        FileInfo info;
        if (handle.IsInvalid || !GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return info;
    }
    private static bool Same(FileInfo left, FileInfo right)
    {
        return left.Volume == right.Volume && left.IndexHigh == right.IndexHigh && left.IndexLow == right.IndexLow;
    }
    private static void Ordinary(FileInfo info) { Need(info.Links == 1 && (info.Attributes & 0x410) == 0, "合成文件类型或链接数错误"); }
    private static SecurityFact Security(SafeFileHandle handle)
    {
        uint required;
        bool initial = GetKernelObjectSecurity(handle, 7, null, 0, out required);
        int error = Marshal.GetLastWin32Error();
        if (initial || error != 122 || required == 0 || required > 65536) throw new Win32Exception(error, "安全描述符大小查询失败或超限");
        byte[] bytes = new byte[(int)required];
        if (!GetKernelObjectSecurity(handle, 7, bytes, required, out required)) throw new Win32Exception(Marshal.GetLastWin32Error());
        Need(required == bytes.Length, "安全描述符查询长度改变");
        RawSecurityDescriptor descriptor = new RawSecurityDescriptor(bytes, 0);
        byte[] normalized = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(normalized, 0);
        return new SecurityFact { querySucceeded = true, queriedBytes = required, controlFlags = (int)descriptor.ControlFlags, daclAceCount = descriptor.DiscretionaryAcl == null ? -1 : descriptor.DiscretionaryAcl.Count, sha256 = Hash(normalized) };
    }
    private static byte[] ReadBytes(FileStream file)
    {
        Need(file.Length >= 0 && file.Length <= 4096, "合成文件预算超限");
        byte[] value = new byte[(int)file.Length]; int offset = 0;
        while (offset < value.Length) { int read = file.Read(value, offset, value.Length - offset); Need(read > 0, "合成文件截断"); offset += read; }
        Need(file.ReadByte() == -1, "合成文件出现尾随字节"); return value;
    }
    private static object Snapshot(string name)
    {
        string path = Path.Combine(dataDirectory, name);
        if (!File.Exists(path)) return new { file = name, exists = false };
        try
        {
            Need((File.GetAttributes(path) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) == 0, "观察对象不是普通文件");
            using (FileStream file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                FileInfo info = Info(file.SafeFileHandle); Ordinary(info);
                byte[] value = ReadBytes(file);
                return new { file = name, exists = true, volume = info.Volume.ToString("X8"), fileId64 = info.IndexHigh.ToString("X8") + info.IndexLow.ToString("X8"), attributes = info.Attributes, size = value.Length, sha256 = Hash(value), writtenFileTime = info.Written.ToString(), security = Security(file.SafeFileHandle) };
            }
        }
        catch (Exception error)
        {
            Win32Exception native = error as Win32Exception;
            return new { file = name, exists = true, snapshotUnavailable = true, exceptionType = error.GetType().Name, hresult = error.HResult, win32Code = native == null ? error.HResult & 65535 : native.NativeErrorCode };
        }
    }
    public static void Stage(string name)
    {
        current = name;
        Need(Events.Count < 80 && Clock.ElapsedMilliseconds < 5000, "合成诊断预算超限");
        Events.Add(new { generation = generation, stage = name, elapsedMs = Clock.Elapsed.TotalMilliseconds, files = new[] { Snapshot("writers.json"), Snapshot("writers.json.tmp") } });
    }
    public static IDisposable PinDirectories(string directory)
    {
        Need(activePins == null && Path.GetFullPath(directory) == directory, "目录绑定状态错误");
        Pins pins = new Pins { Directory = directory };
        try
        {
            List<string> paths = new List<string>(); string cursor = directory;
            while (!String.IsNullOrEmpty(cursor)) { Need(paths.Count < 64, "目录深度超限"); paths.Add(cursor); cursor = Path.GetDirectoryName(cursor); }
            paths.Reverse();
            foreach (string path in paths)
            {
                SafeFileHandle handle = CreateFileW(path, 0xA0, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
                pins.Handles.Add(handle);
                FileInfo info = Info(handle); Need((info.Attributes & 0x410) == 0x10, "目录包含重解析或类型改变");
            }
            activePins = pins; return pins;
        }
        catch { pins.Dispose(); throw; }
    }
    public static SafeFileHandle CreateTemporary(string path)
    {
        Need(activePins != null && path == Path.Combine(activePins.Directory, "writers.json.tmp"), "临时对象路径未绑定");
        SafeFileHandle handle = CreateFileW(path, 0xC0030000, 1, IntPtr.Zero, 1, 0x00200080, IntPtr.Zero);
        if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
        return handle;
    }
    public static void Publish(FileStream source, string directory, string final, bool replace)
    {
        Need(activePins != null && directory == activePins.Directory && final == Path.Combine(directory, "writers.json") && Path.GetFullPath(final) == final, "发布目录未绑定");
        Stage("security-source-identity");
        FileInfo written = Info(source.SafeFileHandle); Ordinary(written);
        Stage("security-source-query");
        SecurityFact sourceSecurity = Security(source.SafeFileHandle);
        SecurityFact targetSecurity = null;
        uint targetAttributes = 0;
        if (replace)
        {
            Stage("security-target-open");
            using (FileStream target = new FileStream(final, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                FileInfo previous = Info(target.SafeFileHandle); Ordinary(previous);
                Stage("security-target-receipt");
                Invoke("CheckReceipt", final);
                Stage("security-target-query");
                targetSecurity = Security(target.SafeFileHandle); targetAttributes = previous.Attributes;
                Stage("security-target-compare");
                Need(sourceSecurity.sha256 == targetSecurity.sha256, "目标与源的owner/group/DACL不同");
                Need((written.Attributes & 0x4800) == (previous.Attributes & 0x4800), "目标与源的加密/压缩属性不同");
            }
        }
        Events.Add(new { generation = generation, stage = "security-comparison", elapsedMs = Clock.Elapsed.TotalMilliseconds, source = sourceSecurity, target = targetSecurity, sourceAttributes = written.Attributes, targetAttributes = targetAttributes, saclQueried = false, efsRecipientsQueried = false, resourceAttributesQueried = false });
        Stage(replace ? "rename-replace-final" : "rename-first-final");
        byte[] name = Encoding.Unicode.GetBytes(final);
        int length = Marshal.SizeOf(typeof(RenameLayout)) + name.Length;
        byte[] value = new byte[length];
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.Copy(value, 0, buffer, length);
            Marshal.WriteInt32(buffer, 0, replace ? 1 : 0);
            Marshal.WriteIntPtr(buffer, 8, IntPtr.Zero);
            Marshal.WriteInt32(buffer, 16, name.Length); Marshal.Copy(name, 0, IntPtr.Add(buffer, 20), name.Length);
            bool ok = SetFileInformationByHandle(source.SafeFileHandle, 3, buffer, (uint)length);
            int error = ok ? 0 : Marshal.GetLastWin32Error();
            Events.Add(new { generation = generation, stage = "rename-return", success = ok, win32Code = error, elapsedMs = Clock.Elapsed.TotalMilliseconds, fileInformationClass = 3, replaceIfExists = replace, bufferBytes = length, fileNameBytes = name.Length, rootDirectoryNull = true, targetNameForm = "fixed-canonical-absolute", targetPath = final, ancestorPinsHeld = activePins.Handles.Count });
            if (!ok) throw new Win32Exception(error);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    public static void ValidatePublished(FileStream source, string final)
    {
        Stage("published-path-identity");
        FileInfo expected = Info(source.SafeFileHandle); Ordinary(expected);
        SecurityFact expectedSecurity = Security(source.SafeFileHandle);
        using (FileStream published = new FileStream(final, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            FileInfo actual = Info(published.SafeFileHandle); Ordinary(actual);
            Need(Same(expected, actual) && source.Length == published.Length && expected.Attributes == actual.Attributes, "发布路径实体不等于持有源");
            Need(Security(published.SafeFileHandle).sha256 == expectedSecurity.sha256, "发布路径安全描述符改变");
            source.Position = 0; Need(Hash(ReadBytes(source)) == Hash(ReadBytes(published)), "发布路径内容改变");
        }
        Need(!File.Exists(final + ".tmp") && !Directory.Exists(final + ".tmp"), "发布后临时名字仍存在");
        Invoke("CheckDirectories"); Stage("published-complete");
    }
    private static void Set(string name, object value) { Product.GetField(name, PrivateStatic).SetValue(null, value); }
    private static object Invoke(string name, params object[] args)
    {
        try { return Product.GetMethod(name, PrivateStatic).Invoke(null, args); }
        catch (TargetInvocationException error) { throw error.InnerException; }
    }
    private static object Writer(uint pid, string role)
    {
        Type type = Product.GetNestedType("Writer", BindingFlags.NonPublic);
        object value = Activator.CreateInstance(type, true);
        type.GetField("Pid").SetValue(value, pid); type.GetField("Created").SetValue(value, (long)pid);
        type.GetField("Image").SetValue(value, new string('a', 64)); type.GetField("Role").SetValue(value, role); return value;
    }
    private static void WriteResult(string path, object value)
    {
        byte[] bytes = new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(value));
        Need(bytes.Length <= 262144, "合成诊断报告超限");
        using (FileStream file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) { file.Write(bytes, 0, bytes.Length); file.Flush(true); }
    }
    public static int Main(string[] args)
    {
        if (args.Length != 3 || (args[1] != "plain" && args[1] != "inherited")) return 4;
        string root = Path.GetFullPath(args[0]), output = Path.GetFullPath(args[2]), mode = args[1];
        object failure = null; string status = "FAIL"; int exit = 1; bool created = false;
        try
        {
            LayoutProof();
            string ownDirectory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            Need(output == Path.Combine(ownDirectory, mode + ".json"), "报告路径未绑定独立制品目录");
            if (mode == "inherited")
            {
                string planPath = Path.Combine(ownDirectory, "sibling-plan.json");
                Need(new System.IO.FileInfo(planPath).Length <= 4096, "同父计划超限");
                byte[] bytes = File.ReadAllBytes(planPath);
                Dictionary<string, object> plan = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(bytes));
                string parent = Path.GetDirectoryName(root), suffix = Path.GetFileName(root); Guid parsed;
                const string prefix = ".aibrowse-e2-rename-";
                Need((string)plan["journalId"] == "6697ab3d3a7d477787d250a1984b4698" && (string)plan["targetPath"] == root && (string)plan["parentPath"] == parent && suffix.StartsWith(prefix, StringComparison.Ordinal) && Guid.TryParseExact(suffix.Substring(prefix.Length), "N", out parsed), "同父路径未绑定固定journal");
                object identity = Invoke("DirectoryIdentity", parent); Type type = identity.GetType();
                string fileId = ((uint)type.GetField("Volume").GetValue(identity)).ToString("X8") + ":" + ((uint)type.GetField("IndexHigh").GetValue(identity)).ToString("X8") + ((uint)type.GetField("IndexLow").GetValue(identity)).ToString("X8");
                Need(fileId == (string)plan["parentFileId"], "同父实体身份改变");
            }
            else Need(Path.GetDirectoryName(root) == ownDirectory && Path.GetFileName(root) == mode, "普通场景路径未绑定");
            Need(root == args[0] && !Directory.Exists(root) && !File.Exists(root) && !File.Exists(output), "合成目录必须全新");
            Invoke("DirectoryIdentity", ownDirectory);
            if (!CreateDirectoryW(root, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            created = true;
            Need(mode != "plain" || (File.GetAttributes(root) & FileAttributes.Encrypted) == 0, "普通对照继承EFS");
            dataDirectory = Path.Combine(root, "lifecycle-guardian");
            if (!CreateDirectoryW(dataDirectory, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            Set("root", root); Set("directory", dataDirectory);
            Set("rootIdentity", Invoke("DirectoryIdentity", root)); Set("directoryIdentity", Invoke("DirectoryIdentity", dataDirectory));
            Set("rootHash", new string('b', 64)); Set("nonce", new string('c', 32)); Set("main", Writer(101, "main")); Set("utility", null);
            using (FileStream owner = new FileStream(Path.Combine(dataDirectory, "owner.lock"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
            {
                generation = 1; Stage("persist-start"); Invoke("Persist"); Stage("persist-complete");
                Set("utility", Writer(102, "probe"));
                generation = 2; Stage("persist-start"); Invoke("Persist"); Stage("persist-complete");
            }
            byte[] final = File.ReadAllBytes(Path.Combine(dataDirectory, "writers.json"));
            Need(!File.Exists(Path.Combine(dataDirectory, "writers.json.tmp")) && Encoding.UTF8.GetString(final).Contains("\"role\":\"probe\""), "第二代账本未完成");
            status = "PASS"; exit = 0;
        }
        catch (Exception error)
        {
            Win32Exception native = error as Win32Exception;
            failure = new { stage = current, generation = generation, exceptionType = error.GetType().Name, hresult = error.HResult, win32Code = native == null ? error.HResult & 65535 : native.NativeErrorCode };
        }
        finally
        {
            if (dataDirectory != null) Events.Add(new { generation = generation, stage = "final-observation", elapsedMs = Clock.Elapsed.TotalMilliseconds, files = new[] { Snapshot("writers.json"), Snapshot("writers.json.tmp") } });
            WriteResult(output, new { version = 1, mode = mode, status = status, elapsedMs = Clock.Elapsed.TotalMilliseconds, rootAttributes = created ? (int)File.GetAttributes(root) : 0, failure = failure, events = Events, productExecuted = false, fullSecurityMetadataEquivalence = false, physicalPowerLossTested = false });
        }
        return exit;
    }
}
