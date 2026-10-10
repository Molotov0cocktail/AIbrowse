using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Synthetic entry point for an exact, instrumented Guardian.Persist derivative.
internal static class PersistDiagnostic
{
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct FileInfo
    {
        public uint Attributes; public long Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool EncryptFileW(string file);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateDirectoryW(string directory, IntPtr security);

    private static readonly Stopwatch Clock = Stopwatch.StartNew();
    private static readonly List<object> Events = new List<object>();
    private static string current = "entry", dataDirectory;
    private static int generation;
    private static readonly Type Product = typeof(Guardian);
    private const BindingFlags PrivateStatic = BindingFlags.NonPublic | BindingFlags.Static;

    private static string Hash(byte[] bytes)
    {
        using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
    }
    private static object Snapshot(string name)
    {
        string path = Path.Combine(dataDirectory, name);
        if (!File.Exists(path)) return new { file = name, exists = false };
        try
        {
            using (FileStream file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                FileInfo info;
                if (!GetFileInformationByHandle(file.SafeFileHandle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (file.Length > 4096) throw new InvalidOperationException("合成文件预算超限");
                byte[] bytes = new byte[(int)file.Length];
                int offset = 0;
                while (offset < bytes.Length) { int count = file.Read(bytes, offset, bytes.Length - offset); if (count == 0) throw new EndOfStreamException(); offset += count; }
                return new { file = name, exists = true, volume = info.Volume.ToString("X8"), fileId64 = info.IndexHigh.ToString("X8") + info.IndexLow.ToString("X8"), attributes = info.Attributes, size = bytes.Length, sha256 = Hash(bytes), writtenFileTime = info.Written.ToString() };
            }
        }
        catch (Exception error)
        {
            return new { file = name, exists = true, snapshotUnavailable = true, exceptionType = error.GetType().Name, hresult = error.HResult, win32LowWord = error.HResult & 65535 };
        }
    }
    public static void Stage(string name)
    {
        current = name;
        if (Events.Count >= 80 || Clock.ElapsedMilliseconds >= 5000) throw new InvalidOperationException("合成诊断预算超限");
        // Observation failures cannot replace the product operation's exception.
        Events.Add(new { generation = generation, stage = name, elapsedMs = Clock.Elapsed.TotalMilliseconds, files = new[] { Snapshot("writers.json"), Snapshot("writers.json.tmp") } });
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
        type.GetField("Pid").SetValue(value, pid);
        type.GetField("Created").SetValue(value, (long)pid);
        type.GetField("Image").SetValue(value, new string('a', 64));
        type.GetField("Role").SetValue(value, role);
        return value;
    }
    private static void WriteResult(string path, object value)
    {
        byte[] bytes = new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(value));
        if (bytes.Length > 262144) throw new InvalidOperationException("合成诊断报告超限");
        using (FileStream file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) { file.Write(bytes, 0, bytes.Length); file.Flush(true); }
    }
    public static int Main(string[] args)
    {
        if (args.Length != 3 || (args[1] != "plain" && args[1] != "efs" && args[1] != "inherited")) return 4;
        string root = Path.GetFullPath(args[0]), output = Path.GetFullPath(args[2]);
        string mode = args[1];
        object failure = null;
        string status = "FAIL";
        int exit = 1;
        bool created = false;
        try
        {
            if (Marshal.SizeOf(typeof(FileInfo)) != 52 || Marshal.OffsetOf(typeof(FileInfo), "Written").ToInt32() != 20 || Marshal.OffsetOf(typeof(FileInfo), "Volume").ToInt32() != 28 || Marshal.OffsetOf(typeof(FileInfo), "IndexLow").ToInt32() != 48) throw new InvalidOperationException("Win32文件身份观察布局不符");
            string ownDirectory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            if (output != Path.Combine(ownDirectory, mode + ".json")) throw new InvalidOperationException("诊断输出不属于当前独立制品目录");
            if (mode == "inherited")
            {
                string planPath = Path.Combine(ownDirectory, "sibling-plan.json");
                byte[] bytes = File.ReadAllBytes(planPath);
                if (bytes.Length > 4096) throw new InvalidOperationException("同父诊断计划超限");
                Dictionary<string, object> plan = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(bytes));
                string parent = Path.GetDirectoryName(root), suffix = Path.GetFileName(root);
                Guid parsed;
                const string prefix = ".aibrowse-e2-persist-";
                if ((string)plan["targetPath"] != root || (string)plan["parentPath"] != parent || !suffix.StartsWith(prefix, StringComparison.Ordinal) || !Guid.TryParseExact(suffix.Substring(prefix.Length), "N", out parsed)) throw new InvalidOperationException("同父诊断路径未绑定");
                object identity = Invoke("DirectoryIdentity", parent);
                Type type = identity.GetType();
                string fileId = ((uint)type.GetField("Volume").GetValue(identity)).ToString("X8") + ":" + ((uint)type.GetField("IndexHigh").GetValue(identity)).ToString("X8") + ((uint)type.GetField("IndexLow").GetValue(identity)).ToString("X8");
                if (fileId != (string)plan["parentFileId"]) throw new InvalidOperationException("同父诊断实体身份改变");
            }
            else if (Path.GetDirectoryName(root) != ownDirectory || Path.GetFileName(root) != mode) throw new InvalidOperationException("诊断路径不属于当前独立制品目录");
            if (root != args[0] || Directory.Exists(root) || File.Exists(root) || File.Exists(output)) throw new InvalidOperationException("诊断目录必须全新");
            Invoke("DirectoryIdentity", ownDirectory);
            if (!CreateDirectoryW(root, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            created = true;
            current = "directory-encryption";
            if (mode == "efs")
            {
                if (!EncryptFileW(root)) throw new Win32Exception(Marshal.GetLastWin32Error(), "新合成目录无法启用EFS");
                if ((File.GetAttributes(root) & FileAttributes.Encrypted) == 0) throw new InvalidOperationException("EFS属性未读回");
            }
            else if (mode == "plain" && (File.GetAttributes(root) & FileAttributes.Encrypted) != 0) throw new InvalidOperationException("普通对照继承了EFS");
            dataDirectory = Path.Combine(root, "lifecycle-guardian");
            Directory.CreateDirectory(dataDirectory);
            Set("root", root); Set("directory", dataDirectory);
            Set("rootIdentity", Invoke("DirectoryIdentity", root));
            Set("directoryIdentity", Invoke("DirectoryIdentity", dataDirectory));
            Set("rootHash", new string('b', 64)); Set("nonce", new string('c', 32));
            Set("main", Writer(101, "main")); Set("utility", null);
            generation = 1; Stage("persist-start"); Invoke("Persist"); Stage("persist-complete");
            Set("utility", Writer(102, "probe"));
            generation = 2; Stage("persist-start"); Invoke("Persist"); Stage("persist-complete");
            byte[] final = File.ReadAllBytes(Path.Combine(dataDirectory, "writers.json"));
            if (File.Exists(Path.Combine(dataDirectory, "writers.json.tmp")) || !Encoding.UTF8.GetString(final).Contains("\"role\":\"probe\"")) throw new InvalidOperationException("第二代账本未完成");
            status = "PASS"; exit = 0;
        }
        catch (Exception error)
        {
            if (mode == "efs" && current == "directory-encryption") { status = "NOTRUN"; exit = 3; }
            Win32Exception native = error as Win32Exception;
            failure = new { stage = current, generation = generation, exceptionType = error.GetType().Name, hresult = error.HResult, win32Code = native == null ? error.HResult & 65535 : native.NativeErrorCode };
        }
        finally
        {
            if (dataDirectory != null) Events.Add(new { generation = generation, stage = "final-observation", elapsedMs = Clock.Elapsed.TotalMilliseconds, files = new[] { Snapshot("writers.json"), Snapshot("writers.json.tmp") } });
            WriteResult(output, new { version = 1, mode = mode, status = status, elapsedMs = Clock.Elapsed.TotalMilliseconds, rootAttributes = created ? (int)File.GetAttributes(root) : 0, failure = failure, events = Events, productExecuted = false });
        }
        return exit;
    }
}
