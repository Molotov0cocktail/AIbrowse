using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Only synthetic owned files are changed. Guardian.Main and data writers are not run.
internal static class PublishQualification
{
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct NativeFileInfo
    {
        public uint Attributes; public long Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    private sealed class FileFact
    {
        public bool exists; public string identity, sha256; public long size; public uint attributes, links;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out NativeFileInfo info);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int type, byte[] info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern void SetLastError(uint error);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateHardLinkW(string name, string existing, IntPtr security);
    private const BindingFlags Flags = BindingFlags.NonPublic | BindingFlags.Static;
    private static readonly Type Product = typeof(Guardian);
    private static readonly Stopwatch Clock = Stopwatch.StartNew();
    private static string scenario, finalPath;
    private static int generation;
    private static bool mutationApplied;
    private static Exception hookFailure;
    private static string cachedSecurity, changedReceiptSecurity, changedTempSecurity;
    public static long ClockOffset;
    public static readonly string[] Cases = {
        "normal-consecutive", "tmp-dacl-before-write", "owner-empty-ads", "receipt-empty-ads", "tmp-empty-ads", "cached-both-dacl",
        "final-collision", "tmp-collision", "receipt-identity", "receipt-bytes", "receipt-hardlink", "directory-identity",
        "before-publish-failure", "after-publish-corrupt", "late-final-io", "encrypted-mismatch", "compressed-mismatch",
        "stream-query-failure", "stream-query-truncated", "stream-parser-extra-empty", "stream-parser-overflow", "stream-parser-truncated"
    };
    private static void Need(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
    private static string Hash(byte[] value)
    {
        using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(value)).Replace("-", "").ToLowerInvariant();
    }
    private static void Set(string name, object value) { Product.GetField(name, Flags).SetValue(null, value); }
    private static object Get(string name) { return Product.GetField(name, Flags).GetValue(null); }
    private static FileFact Fact(string path)
    {
        if (!File.Exists(path)) return new FileFact { exists = false };
        using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            NativeFileInfo info;
            if (!GetFileInformationByHandle(stream.SafeFileHandle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            Need((info.Attributes & 0x410) == 0 && stream.Length <= 4096, "资格原件类型或预算错误");
            byte[] bytes = new byte[(int)stream.Length]; int offset = 0;
            while (offset < bytes.Length) { int count = stream.Read(bytes, offset, bytes.Length - offset); Need(count > 0, "资格原件截断"); offset += count; }
            return new FileFact { exists = true, identity = info.Volume.ToString("X8") + ":" + info.IndexHigh.ToString("X8") + info.IndexLow.ToString("X8"), sha256 = Hash(bytes), size = bytes.Length, attributes = info.Attributes, links = info.Links };
        }
    }
    private static object Invoke(string name, params object[] args)
    {
        try { return Product.GetMethod(name, Flags).Invoke(null, args); }
        catch (TargetInvocationException error) { throw error.InnerException; }
    }
    private static string Descriptor(object facts) { return Hash((byte[])facts.GetType().GetField("Descriptor").GetValue(facts)); }
    private static string PathDescriptor(string path)
    {
        using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) return Descriptor(Invoke("ReadSecurity", stream));
    }
    private static void ChangeDacl(string path)
    {
        FileSecurity security = File.GetAccessControl(path, AccessControlSections.Access);
        string before = Hash(security.GetSecurityDescriptorBinaryForm());
        security.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.ReadAttributes, InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
        File.SetAccessControl(path, security);
        string after = Hash(File.GetAccessControl(path, AccessControlSections.Access).GetSecurityDescriptorBinaryForm());
        Need(before != after, "合成DACL变化未成立");
    }
    public static void AfterTemporaryCreated(FileStream stream, string path)
    {
        Need(Clock.ElapsedMilliseconds < 5000, "资格工作期限耗尽");
        if (generation != 2) return;
        try
        {
            if (scenario == "tmp-dacl-before-write" || scenario == "cached-both-dacl")
            {
                Need(stream.Length == 0, "故障钩子已晚于首次写入");
                if (scenario == "cached-both-dacl")
                {
                    cachedSecurity = Descriptor(Get("securityBaseline"));
                    ChangeDacl(finalPath); changedReceiptSecurity = PathDescriptor(finalPath);
                }
                ChangeDacl(path); changedTempSecurity = Descriptor(Invoke("ReadSecurity", stream));
                if (scenario == "cached-both-dacl") Need(changedReceiptSecurity == changedTempSecurity && cachedSecurity != changedTempSecurity, "两槽共同漂移条件未成立");
                mutationApplied = true;
            }
            else if (scenario == "tmp-empty-ads") { Need(stream.Length == 0, "额外流注入过晚"); EmptyAds(path); mutationApplied = true; }
        }
        catch (Exception error) { hookFailure = error; throw; }
    }
    public static void BeforePublish()
    {
        if (scenario == "before-publish-failure" && generation == 2) { mutationApplied = true; throw new IOException("资格固定发布前故障"); }
    }
    public static void AfterPublish(FileStream stream)
    {
        if (scenario != "after-publish-corrupt" || generation != 2) return;
        try { stream.SetLength(1); stream.Position = 0; stream.WriteByte(33); stream.Flush(true); mutationApplied = true; }
        catch (Exception error) { hookFailure = error; throw; }
    }
    public static void AfterFinalIo()
    {
        if (scenario == "late-final-io" && generation == 2) { ClockOffset = 10001; mutationApplied = true; }
    }
    public static bool StreamQuery(SafeFileHandle handle, byte[] value)
    {
        if (scenario == "stream-query-failure") { mutationApplied = true; SetLastError(5); return false; }
        bool result = GetFileInformationByHandleEx(handle, 7, value, (uint)value.Length);
        if (scenario == "stream-query-truncated" && result) { Array.Clear(value, 0, value.Length); mutationApplied = true; }
        return result;
    }
    private static object Writer(uint pid, string role)
    {
        Type type = Product.GetNestedType("Writer", BindingFlags.NonPublic);
        object value = Activator.CreateInstance(type, true);
        type.GetField("Pid").SetValue(value, pid); type.GetField("Created").SetValue(value, (long)pid);
        type.GetField("Image").SetValue(value, new string('a', 64)); type.GetField("Role").SetValue(value, role); return value;
    }
    private static void EmptyAds(string path)
    {
        using (SafeFileHandle handle = CreateFileW(path + ":qualification-empty", 0xC0000000, 7, IntPtr.Zero, 1, 0x80, IntPtr.Zero))
        {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            using (FileStream stream = new FileStream(handle, FileAccess.ReadWrite)) { Need(stream.Length == 0, "额外流非空"); stream.Flush(true); }
        }
    }
    private static Exception Attempt(string name, params object[] args)
    {
        try { Invoke(name, args); return null; } catch (Exception error) { return error; }
    }
    private static bool SameFact(FileFact left, FileFact right) { return left != null && left.exists && right.exists && left.identity == right.identity && left.sha256 == right.sha256; }
    private static object Pure(string name)
    {
        bool passed; Exception rejection = null;
        if (name == "encrypted-mismatch" || name == "compressed-mismatch")
        {
            Type type = Product.GetNestedType("SecurityFacts", BindingFlags.NonPublic);
            object left = Activator.CreateInstance(type, true), right = Activator.CreateInstance(type, true);
            type.GetField("Descriptor").SetValue(left, new byte[] { 1, 2 }); type.GetField("Descriptor").SetValue(right, new byte[] { 1, 2 });
            type.GetField("Attributes").SetValue(left, (uint)0); type.GetField("Attributes").SetValue(right, name == "encrypted-mismatch" ? (uint)0x4000 : (uint)0x800);
            passed = !(bool)Invoke("SameSecurity", left, right);
        }
        else
        {
            byte[] value = new byte[name == "stream-parser-truncated" ? 37 : 4096];
            if (value.Length >= 38)
            {
                Array.Copy(BitConverter.GetBytes((uint)14), 0, value, 4, 4); Array.Copy(Encoding.Unicode.GetBytes("::$DATA"), 0, value, 24, 14);
                Array.Copy(BitConverter.GetBytes(name == "stream-parser-overflow" ? UInt32.MaxValue : (uint)40), 0, value, 0, 4);
                if (name == "stream-parser-extra-empty")
                {
                    byte[] extra = Encoding.Unicode.GetBytes(":qualification-empty:$DATA");
                    Array.Copy(BitConverter.GetBytes((uint)extra.Length), 0, value, 44, 4); Array.Copy(extra, 0, value, 64, extra.Length);
                }
            }
            rejection = Attempt("ValidateStreams", value, (long)0); passed = rejection != null;
        }
        return new { name = name, oraclePassed = passed, evidence = "纯事实反例；未改变系统加密或压缩策略", rejected = rejection != null, exceptionType = rejection == null ? null : rejection.GetType().Name, protocolExecuted = false };
    }
    private static object Run(string scope, string name)
    {
        scenario = name; generation = 0; mutationApplied = false; hookFailure = null; ClockOffset = 0;
        cachedSecurity = changedReceiptSecurity = changedTempSecurity = null;
        if (name == "encrypted-mismatch" || name == "compressed-mismatch" || name.StartsWith("stream-parser-", StringComparison.Ordinal)) return Pure(name);
        string root = Path.Combine(scope, name), directory = Path.Combine(root, "lifecycle-guardian");
        Need(Path.GetFullPath(root) == root && Path.GetDirectoryName(root) == scope && !File.Exists(root) && !Directory.Exists(root), "资格目标必须是scope内全新目录");
        Directory.CreateDirectory(directory);
        string owner = Path.Combine(directory, "owner.lock"), final = Path.Combine(directory, "writers.json"), temp = final + ".tmp";
        finalPath = final;
        using (FileStream created = new FileStream(owner, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { }
        FileFact before = null, collision = null;
        if (name == "owner-empty-ads") { EmptyAds(owner); mutationApplied = true; }
        if (name == "final-collision") { File.WriteAllText(final, "资格保留碰撞"); before = Fact(final); mutationApplied = true; }
        Set("root", root); Set("directory", directory);
        Set("rootIdentity", Invoke("DirectoryIdentity", root)); Set("directoryIdentity", Invoke("DirectoryIdentity", directory));
        Set("rootHash", new string('b', 64)); Set("nonce", new string('c', 32)); Set("main", Writer(101, "main")); Set("utility", null);
        Set("receipt", null); Set("receiptIdentity", null); Set("admission", Stopwatch.StartNew()); Set("securityBaseline", null);
        Exception rejection; bool passed = false; bool? successorRejected = null;
        using (FileStream lockFile = new FileStream(owner, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            Set("ownership", lockFile);
            try
            {
                rejection = Attempt("ReadPrevious", true);
                bool initialReject = name == "owner-empty-ads" || name == "final-collision" || name.StartsWith("stream-query-", StringComparison.Ordinal);
                if (!initialReject)
                {
                    Need(rejection == null, "合成新owner初始化失败"); generation = 1;
                    rejection = Attempt("Persist"); Need(rejection == null, "合成首账本发布失败"); before = Fact(final);
                    if (name == "receipt-empty-ads") { EmptyAds(final); mutationApplied = true; Set("securityBaseline", null); rejection = Attempt("ReadPrevious", false); }
                    else
                    {
                        if (name == "tmp-collision") { File.WriteAllText(temp, "资格保留临时碰撞"); collision = Fact(temp); mutationApplied = true; }
                        if (name == "receipt-identity") { byte[] old = File.ReadAllBytes(final); File.Move(final, final + ".retained"); File.WriteAllBytes(final, old); before = Fact(final); mutationApplied = true; }
                        if (name == "receipt-bytes") { byte[] old = File.ReadAllBytes(final); old[0] = 33; File.WriteAllBytes(final, old); before = Fact(final); mutationApplied = true; }
                        if (name == "receipt-hardlink") { if (!CreateHardLinkW(final + ".alias", final, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error()); before = Fact(final); mutationApplied = true; }
                        if (name == "directory-identity") { string other = Path.Combine(root, "other"); Directory.CreateDirectory(other); Set("directoryIdentity", Invoke("DirectoryIdentity", other)); mutationApplied = true; }
                        Set("utility", Writer(102, "probe")); generation = 2; rejection = Attempt("Persist");
                        if (name == "late-final-io" && rejection == null) rejection = Attempt("Deadline");
                    }
                }
                if (hookFailure != null) throw new InvalidOperationException("资格注入工序失败", hookFailure);
                if (name != "normal-consecutive") Need(mutationApplied, "未到达确定故障注入点");
                FileFact afterHeld = Fact(final), tempHeld = Fact(temp); bool oldUnchanged = SameFact(before, afterHeld);
                if (name == "normal-consecutive") passed = rejection == null && afterHeld.exists && afterHeld.size > before.size && afterHeld.identity != before.identity && !tempHeld.exists;
                else if (name == "tmp-dacl-before-write" || name == "tmp-empty-ads" || name == "cached-both-dacl") passed = rejection != null && tempHeld.exists && tempHeld.size == 0 && oldUnchanged;
                else if (name == "before-publish-failure") passed = rejection != null && tempHeld.exists && tempHeld.size > before.size && oldUnchanged;
                else if (name == "after-publish-corrupt") passed = rejection != null && afterHeld.exists && afterHeld.size == 1 && afterHeld.identity != before.identity && !tempHeld.exists;
                else if (name == "late-final-io") passed = rejection != null && afterHeld.exists && afterHeld.size > before.size && !tempHeld.exists && ClockOffset == 10001;
                else if (name == "owner-empty-ads" || name.StartsWith("stream-query-", StringComparison.Ordinal)) passed = rejection != null && !afterHeld.exists && !tempHeld.exists;
                else if (name == "tmp-collision") passed = rejection != null && oldUnchanged && SameFact(collision, tempHeld);
                else passed = rejection != null && oldUnchanged && !tempHeld.exists;
                if (name == "before-publish-failure" || name == "after-publish-corrupt" || name == "receipt-empty-ads" || name == "tmp-dacl-before-write" || name == "tmp-empty-ads" || name == "cached-both-dacl")
                {
                    ClockOffset = 0; Set("securityBaseline", null); Set("receipt", null); Set("receiptIdentity", null);
                    successorRejected = Attempt("ReadPrevious", false) != null; passed = passed && successorRejected == true;
                }
            }
            finally { Set("ownership", null); }
        }
        FileFact after = Fact(final), temporary = Fact(temp);
        return new { name = name, oraclePassed = passed, mutationApplied = mutationApplied, rejected = rejection != null, exceptionType = rejection == null ? null : rejection.GetType().Name, hresult = rejection == null ? 0 : rejection.HResult, temporaryBytes = temporary.exists ? temporary.size : -1, oldFinalUnchanged = SameFact(before, after), before = before, after = after, temporary = temporary, cachedSecurity = cachedSecurity, changedReceiptSecurity = changedReceiptSecurity, changedTempSecurity = changedTempSecurity, successorRejected = successorRejected, protocolExecuted = false };
    }
    public static int Main(string[] args)
    {
        if (args.Length != 1) return 4;
        string scope = Path.GetFullPath(args[0]);
        Need(Marshal.SizeOf(typeof(NativeFileInfo)) == 52 && Marshal.OffsetOf(typeof(NativeFileInfo), "Volume").ToInt32() == 28, "资格观察器布局错误");
        Need(scope == args[0] && scope == Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "资格目录未绑定制品");
        string output = Path.Combine(scope, "cases.json"); Need(!File.Exists(output), "资格原件已存在");
        List<object> results = new List<object>(); int failures = 0; object unexpected = null;
        try
        {
            foreach (string name in Cases)
            {
                object result = Run(scope, name); results.Add(result);
                if (!(bool)result.GetType().GetProperty("oraclePassed").GetValue(result, null)) failures++;
                Need(Clock.ElapsedMilliseconds < 5000, "资格工作期限耗尽");
            }
        }
        catch (Exception error) { unexpected = new { kind = error.GetType().Name, message = error.Message, hresult = error.HResult, innerKind = error.InnerException == null ? null : error.InnerException.GetType().Name, innerHresult = error.InnerException == null ? 0 : error.InnerException.HResult, scenario = scenario, generation = generation }; failures++; }
        byte[] bytes = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(new { version = 2, elapsedMs = Clock.Elapsed.TotalMilliseconds, cases = results, failures = failures, unexpected = unexpected, productMainExecuted = false, profileRead = false }));
        Need(bytes.Length <= 262144, "资格报告超限");
        using (FileStream stream = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
        return failures == 0 ? 0 : 1;
    }
}
