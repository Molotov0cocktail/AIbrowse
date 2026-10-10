using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// Only the verified main process may grant data access through this protocol.
internal static class Guardian
{
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
    {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Limits
    {
        public BasicLimits Basic; public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Accounting
    {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct ProcessEntry
    {
        public uint Size, Usage, ProcessId; public UIntPtr Heap; public uint Module, Threads, ParentProcessId;
        public int Priority; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Exe;
    }
    [StructLayout(LayoutKind.Sequential, Pack = 4)] private struct FileInfo
    {
        public uint Attributes; public long Created, Accessed, Written; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(SafeFileHandle job, int type, ref Limits value, uint length);
    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")] private static extern bool QueryLimits(SafeFileHandle job, int type, out Limits value, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")] private static extern bool QueryAccounting(SafeFileHandle job, int type, out Accounting value, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(SafeFileHandle job, SafeFileHandle process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(SafeFileHandle process, SafeFileHandle job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(SafeFileHandle job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeFileHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(SafeFileHandle process, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(SafeFileHandle process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageNameW(SafeFileHandle process, uint flags, StringBuilder image, ref uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32FirstW(SafeFileHandle snapshot, ref ProcessEntry value);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32NextW(SafeFileHandle snapshot, ref ProcessEntry value);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int type, byte[] info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetFileInformationByHandle(SafeFileHandle file, int type, IntPtr info, uint length);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetKernelObjectSecurity(SafeFileHandle file, uint information, byte[] descriptor, uint length, out uint required);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

    private sealed class Writer
    {
        public uint Pid; public long Created; public string Image, Role; public SafeFileHandle Handle;
        public string Json(bool role)
        {
            return "{" + (role ? "\"role\":\"" + Role + "\"," : "") + "\"pid\":" + Pid + ",\"created\":\"" + Created + "\",\"image\":\"" + Image + "\"}";
        }
    }
    private const string WriterPattern = "\\{\"pid\":([1-9][0-9]{0,9}),\"created\":\"([1-9][0-9]{0,18})\",\"image\":\"([a-f0-9]{64})\"\\}";
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly object Sync = new object();
    private static SafeFileHandle job;
    private static FileStream ownership;
    private static Writer main, utility;
    private static string rootHash, nonce, directory, executable, appRoot;
    private static bool relaunch;
    private static volatile bool stopped;
    private static uint sequence;
    private static int frames, bytes;
    private static Stopwatch admission;
    private static Stopwatch finished;
    private static Stream output;
    private static FileInfo rootIdentity, directoryIdentity;
    private static FileInfo receiptIdentity;
    private static byte[] receipt;
    private sealed class SecurityFacts
    {
        public byte[] Descriptor;
        public uint Attributes;
    }
    private sealed class DirectoryPins : IDisposable
    {
        public readonly List<SafeFileHandle> Handles = new List<SafeFileHandle>();
        public void Dispose()
        {
            for (int i = Handles.Count - 1; i >= 0; i--) Handles[i].Dispose();
            Handles.Clear();
        }
    }
    private static SecurityFacts securityBaseline;
    private static FileInfo ownershipIdentity;
    private static byte[] ownershipBytes;
    private static string root;
    private static string stage = "启动";
    private static void Report(Exception error)
    {
        try
        {
            byte[] text = Utf8.GetBytes("生命周期保护失败：" + stage + ":" + error.GetType().Name + ":" + error.HResult + "\n");
            Stream stderr = Console.OpenStandardError(); stderr.Write(text, 0, text.Length); stderr.Flush();
        }
        catch { }
    }

    private static void Need(bool condition) { if (!condition) throw new InvalidOperationException("生命周期校验失败"); }
    private static void Deadline() { Need(admission.ElapsedMilliseconds < 10000); }
    private static string Hash(byte[] value) { using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(value)).Replace("-", "").ToLowerInvariant(); }
    private static bool Same(FileInfo a, FileInfo b) { return a.Volume == b.Volume && a.IndexHigh == b.IndexHigh && a.IndexLow == b.IndexLow; }
    private static bool Unchanged(FileInfo a, FileInfo b) { return Same(a, b) && a.SizeHigh == b.SizeHigh && a.SizeLow == b.SizeLow && a.Written == b.Written; }
    private static FileInfo DirectoryIdentity(string path)
    {
        Need(Path.IsPathRooted(path) && Path.GetFullPath(path) == path);
        string cursor = path;
        while (!String.IsNullOrEmpty(cursor))
        {
            Need((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) == 0);
            cursor = Path.GetDirectoryName(cursor);
        }
        using (SafeFileHandle handle = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero))
        {
            FileInfo info = new FileInfo(); Need(!handle.IsInvalid && GetFileInformationByHandle(handle, out info));
            Need((info.Attributes & 0x10) != 0); return info;
        }
    }
    private static void CheckDirectories()
    {
        Need(Same(rootIdentity, DirectoryIdentity(root)) && Same(directoryIdentity, DirectoryIdentity(directory)));
    }
    private static FileInfo FileIdentity(FileStream stream)
    {
        FileInfo info; Need(GetFileInformationByHandle(stream.SafeFileHandle, out info));
        Need(info.Links == 1 && (info.Attributes & 0x410) == 0); return info;
    }
    private static void FilePath(string path)
    {
        Need((File.GetAttributes(path) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) == 0);
    }
    private static bool EqualBytes(byte[] left, byte[] right)
    {
        if (left == null || right == null || left.Length != right.Length) return false;
        for (int i = 0; i < left.Length; i++) if (left[i] != right[i]) return false;
        return true;
    }
    private static SecurityFacts ReadSecurity(FileStream stream)
    {
        FileInfo before = FileIdentity(stream);
        uint length;
        bool initial = GetKernelObjectSecurity(stream.SafeFileHandle, 7, null, 0, out length);
        int error = Marshal.GetLastWin32Error();
        if (initial || error != 122) throw new Win32Exception(error);
        Need(length > 0 && length <= 65536);
        byte[] bytes = new byte[(int)length]; uint returned;
        if (!GetKernelObjectSecurity(stream.SafeFileHandle, 7, bytes, length, out returned)) throw new Win32Exception(Marshal.GetLastWin32Error());
        Need(returned == length);
        RawSecurityDescriptor descriptor = new RawSecurityDescriptor(bytes, 0);
        byte[] normalized = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(normalized, 0);
        FileInfo after = FileIdentity(stream);
        Need(Unchanged(before, after) && (before.Attributes & 0x4800) == (after.Attributes & 0x4800));
        return new SecurityFacts { Descriptor = normalized, Attributes = after.Attributes & 0x4800 };
    }
    private static bool SameSecurity(SecurityFacts left, SecurityFacts right)
    {
        return left != null && right != null && left.Attributes == right.Attributes && EqualBytes(left.Descriptor, right.Descriptor);
    }
    private static void ValidateStreams(byte[] bytes, long expectedLength)
    {
        // Exactly one unnamed data stream is allowed; even an empty named stream is foreign.
        Need(bytes != null && bytes.Length >= 38 && bytes.Length <= 4096 && expectedLength >= 0 && expectedLength <= 4096);
        Need(BitConverter.ToUInt32(bytes, 0) == 0 && BitConverter.ToUInt32(bytes, 4) == 14);
        Need(BitConverter.ToInt64(bytes, 8) == expectedLength && BitConverter.ToInt64(bytes, 16) >= expectedLength);
        Need(Encoding.Unicode.GetString(bytes, 24, 14) == "::$DATA");
    }
    private static void CheckStreams(FileStream stream)
    {
        Need(stream.Length >= 0 && stream.Length <= 4096);
        byte[] bytes = new byte[4096];
        if (!GetFileInformationByHandleEx(stream.SafeFileHandle, 7, bytes, (uint)bytes.Length)) throw new Win32Exception(Marshal.GetLastWin32Error());
        ValidateStreams(bytes, stream.Length);
    }
    private static void CheckSafety(FileStream stream)
    {
        FileIdentity(stream); CheckStreams(stream);
        Need(SameSecurity(securityBaseline, ReadSecurity(stream)));
    }
    private static byte[] ReadBytes(FileStream stream)
    {
        Need(stream.Length >= 0 && stream.Length <= 4096);
        byte[] bytes = new byte[(int)stream.Length]; stream.Position = 0; int offset = 0;
        while (offset < bytes.Length) { int read = stream.Read(bytes, offset, bytes.Length - offset); Need(read > 0); offset += read; }
        Need(stream.ReadByte() == -1); return bytes;
    }
    private static void CheckBytes(FileStream stream, byte[] expected)
    {
        Need(expected != null && expected.Length <= 4096 && stream.Length == expected.Length);
        stream.Position = 0;
        for (int i = 0; i < expected.Length; i++) Need(stream.ReadByte() == expected[i]);
        Need(stream.ReadByte() == -1);
    }
    private static void CheckOwnership()
    {
        Need(ownership != null && Unchanged(ownershipIdentity, FileIdentity(ownership)));
        CheckBytes(ownership, ownershipBytes); CheckSafety(ownership);
        Need(Unchanged(ownershipIdentity, FileIdentity(ownership)));
    }
    private static DirectoryPins PinDirectories()
    {
        DirectoryPins pins = new DirectoryPins();
        try
        {
            List<string> paths = new List<string>(); string cursor = directory;
            while (!String.IsNullOrEmpty(cursor)) { Need(paths.Count < 64); paths.Add(cursor); cursor = Path.GetDirectoryName(cursor); }
            paths.Reverse();
            foreach (string path in paths)
            {
                SafeFileHandle handle = CreateFileW(path, 0xA0, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
                pins.Handles.Add(handle);
                FileInfo info; Need(GetFileInformationByHandle(handle, out info) && (info.Attributes & 0x410) == 0x10);
            }
            CheckDirectories(); return pins;
        }
        catch { pins.Dispose(); throw; }
    }
    private static SafeFileHandle CreateTemporary(string path)
    {
        SafeFileHandle handle = CreateFileW(path, 0xC0030000, 1, IntPtr.Zero, 1, 0x00200080, IntPtr.Zero);
        if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
        return handle;
    }
    private static void RenameHeld(FileStream stream, string final, bool replace)
    {
        Need(IntPtr.Size == 8 && final == Path.Combine(directory, "writers.json") && Path.GetFullPath(final) == final);
        byte[] name = Encoding.Unicode.GetBytes(final); Need(name.Length > 0 && name.Length <= 65532);
        int length = checked(24 + name.Length); IntPtr info = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.Copy(new byte[length], 0, info, length);
            Marshal.WriteInt32(info, 0, replace ? 1 : 0);
            // Win32 normalizes a complete DOS path; RootDirectory must remain NULL.
            Marshal.WriteIntPtr(info, 8, IntPtr.Zero); Marshal.WriteInt32(info, 16, name.Length);
            Marshal.Copy(name, 0, IntPtr.Add(info, 20), name.Length);
            if (!SetFileInformationByHandle(stream.SafeFileHandle, 3, info, (uint)length)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally { Marshal.FreeHGlobal(info); }
    }
    private static FileInfo CheckPublished(string path, FileInfo written, byte[] payload, bool writerHeld)
    {
        FilePath(path);
        using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, writerHeld ? FileShare.ReadWrite | FileShare.Delete : FileShare.Read))
        {
            FileInfo observed = FileIdentity(stream); Need(Same(written, observed));
            CheckBytes(stream, payload); CheckSafety(stream);
            Need(Unchanged(observed, FileIdentity(stream)));
            return observed;
        }
    }
    private static string Image(SafeFileHandle handle)
    {
        StringBuilder value = new StringBuilder(32768); uint length = (uint)value.Capacity;
        Need(QueryFullProcessImageNameW(handle, 0, value, ref length)); return value.ToString();
    }
    private static long Created(SafeFileHandle handle)
    {
        long created, exited, kernel, user; Need(GetProcessTimes(handle, out created, out exited, out kernel, out user)); return created;
    }
    private static uint Parent(uint pid)
    {
        using (SafeFileHandle snapshot = CreateToolhelp32Snapshot(2, 0))
        {
            Need(!snapshot.IsInvalid); ProcessEntry entry = new ProcessEntry(); entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
            bool more = Process32FirstW(snapshot, ref entry); int count = 0;
            while (more && count++ < 65536)
            {
                Deadline(); if (entry.ProcessId == pid) return entry.ParentProcessId;
                more = Process32NextW(snapshot, ref entry);
            }
            throw new InvalidOperationException("父进程身份未知");
        }
    }
    private static string ImageIdentity(string path)
    {
        Need(String.Equals(path, executable, StringComparison.OrdinalIgnoreCase));
        using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            FileInfo info = FileIdentity(stream);
            // Identity is supplementary; the held process handle and creation time own the process.
            return Hash(Utf8.GetBytes(Path.GetFullPath(path).ToUpperInvariant() + "|" + info.Volume + "|" + info.IndexHigh + "|" + info.IndexLow + "|" + info.SizeHigh + "|" + info.SizeLow + "|" + info.Written));
        }
    }
    private static Writer OpenWriter(uint pid, string role, uint parent)
    {
        SafeFileHandle handle = OpenProcess(0x101101, false, pid);
        try
        {
            Need(!handle.IsInvalid && WaitForSingleObject(handle, 0) == 258);
            long created = Created(handle);
            Need(Parent(pid) == parent);
            if (main != null) Need(created >= main.Created && WaitForSingleObject(main.Handle, 0) == 258);
            Writer writer = new Writer { Pid = pid, Created = created, Image = ImageIdentity(Image(handle)), Role = role, Handle = handle };
            handle = null; return writer;
        }
        finally { if (handle != null) handle.Dispose(); }
    }
    private static Writer Decode(Match match, int index, string role)
    {
        uint pid = 0; long created = 0;
        Need(UInt32.TryParse(match.Groups[index].Value, out pid) && pid != 0 && Int64.TryParse(match.Groups[index + 1].Value, out created) && created > 0);
        return new Writer { Pid = pid, Created = created, Image = match.Groups[index + 2].Value, Role = role };
    }
    private static void WaitPrevious(Writer writer)
    {
        if (writer == null) return;
        using (SafeFileHandle handle = OpenProcess(0x101000, false, writer.Pid))
        {
            if (handle.IsInvalid) { Need(Marshal.GetLastWin32Error() == 87); return; }
            if (Created(handle) != writer.Created) return;
            while (WaitForSingleObject(handle, 0) == 258) { Deadline(); Thread.Sleep(10); }
            Need(WaitForSingleObject(handle, 0) == 0);
        }
    }
    private static void ReadPrevious(bool fresh)
    {
        string final = Path.Combine(directory, "writers.json"), temp = final + ".tmp";
        Need(securityBaseline == null && ownership != null && !File.Exists(temp) && !Directory.Exists(temp));
        ownershipIdentity = FileIdentity(ownership); CheckStreams(ownership);
        ownershipBytes = ReadBytes(ownership); SecurityFacts ownerSecurity = ReadSecurity(ownership);
        if (fresh)
        {
            Need(!File.Exists(final) && !Directory.Exists(final));
            securityBaseline = ownerSecurity; CheckOwnership(); return;
        }
        Need(File.Exists(final));
        FilePath(final);
        using (FileStream stream = new FileStream(final, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            receiptIdentity = FileIdentity(stream); Need(stream.Length > 0 && stream.Length <= 4096);
            CheckStreams(stream); SecurityFacts previousSecurity = ReadSecurity(stream);
            Need(SameSecurity(ownerSecurity, previousSecurity)); securityBaseline = previousSecurity;
            byte[] buffer = new byte[(int)stream.Length]; int offset = 0;
            while (offset < buffer.Length) { int read = stream.Read(buffer, offset, buffer.Length - offset); Need(read > 0); offset += read; }
            Need(stream.ReadByte() == -1);
            string pattern = "\\A\\{\"version\":1,\"root\":\"([a-f0-9]{64})\",\"session\":\"([a-f0-9]{32})\",\"main\":(null|" + WriterPattern + "),\"utility\":(null|\\{\"role\":\"(probe|transfer)\",\"pid\":([1-9][0-9]{0,9}),\"created\":\"([1-9][0-9]{0,18})\",\"image\":\"([a-f0-9]{64})\"\\})\\}\\z";
            Match match = Regex.Match(Utf8.GetString(buffer), pattern, RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
            Need(match.Success && match.Groups[1].Value == rootHash);
            Writer previousMain = match.Groups[3].Value == "null" ? null : Decode(match, 4, "main");
            Writer previousUtility = match.Groups[7].Value == "null" ? null : Decode(match, 9, match.Groups[8].Value);
            Need(previousUtility == null || (previousMain != null && previousUtility.Pid != previousMain.Pid && previousUtility.Created >= previousMain.Created && previousUtility.Image == previousMain.Image));
            WaitPrevious(previousMain); WaitPrevious(previousUtility);
            CheckSafety(stream); Need(Unchanged(receiptIdentity, FileIdentity(stream)));
            receipt = buffer;
        }
        CheckOwnership();
    }
    private static void CheckReceipt(string path)
    {
        if (receipt == null) { Need(!File.Exists(path) && !Directory.Exists(path)); return; }
        FilePath(path);
        using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            Need(Unchanged(receiptIdentity, FileIdentity(stream)) && stream.Length == receipt.Length);
            CheckBytes(stream, receipt); CheckSafety(stream);
            Need(Unchanged(receiptIdentity, FileIdentity(stream)));
        }
    }
    private static void Persist()
    {
        CheckDirectories(); CheckOwnership();
        string final = Path.Combine(directory, "writers.json"), temp = final + ".tmp";
        byte[] payload = Utf8.GetBytes("{\"version\":1,\"root\":\"" + rootHash + "\",\"session\":\"" + nonce + "\",\"main\":" + (main == null ? "null" : main.Json(false)) + ",\"utility\":" + (utility == null ? "null" : utility.Json(true)) + "}");
        Need(payload.Length <= 4096);
        FileInfo written, published;
        using (DirectoryPins pins = PinDirectories())
        {
            CheckOwnership(); CheckReceipt(final);
            stage = "创建持久临时账本";
            using (SafeFileHandle held = CreateTemporary(temp))
            using (FileStream stream = new FileStream(held, FileAccess.ReadWrite, 4096, false))
            {
                // Validate the inherited protection before the first payload byte is written.
                Need(stream.Length == 0); FileIdentity(stream); CheckSafety(stream);
                stage = "写入持久临时账本";
                stream.Write(payload, 0, payload.Length); stream.Flush(true); written = FileIdentity(stream);
                CheckBytes(stream, payload); CheckSafety(stream);
                CheckDirectories(); CheckOwnership(); CheckReceipt(final);
                FilePath(temp); CheckPublished(temp, written, payload, true);
                CheckBytes(stream, payload); CheckSafety(stream);
                Need(Unchanged(written, FileIdentity(stream)));
                stage = "发布持久账本"; RenameHeld(stream, final, receipt != null);
                stream.Flush(true); Need(Same(written, FileIdentity(stream)));
                CheckBytes(stream, payload); CheckSafety(stream);
                CheckPublished(final, written, payload, true);
                Need(!File.Exists(temp) && !Directory.Exists(temp));
                CheckDirectories(); CheckOwnership();
                CheckBytes(stream, payload); CheckSafety(stream);
            }
            // Closing the writing handle can finalize its last-write time.
            stage = "复核持久账本";
            CheckDirectories(); CheckOwnership();
            published = CheckPublished(final, written, payload, false);
            CheckDirectories();
        }
        receiptIdentity = published; receipt = payload;
    }
    private static uint Active()
    {
        Accounting info; Need(QueryAccounting(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)); return info.ActiveProcesses;
    }
    private static void Send(uint seq, string code)
    {
        byte[] line = Encoding.ASCII.GetBytes("1|" + nonce + "|" + seq + "|" + code + "\n");
        output.Write(line, 0, line.Length); output.Flush();
    }
    private static string Quote(string value)
    {
        StringBuilder result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); result.Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    private static void Stop(bool allowGrace)
    {
        lock (Sync)
        {
            if (stopped) return; stopped = true;
            try
            {
                if (job == null || job.IsInvalid) return;
                bool graceful = allowGrace && finished != null;
                Stopwatch exit = graceful ? finished : Stopwatch.StartNew();
                if (graceful)
                {
                    stage = "等待正常main退出";
                    while (main != null && WaitForSingleObject(main.Handle, 0) != 0)
                    { Need(exit.ElapsedMilliseconds < 10000); Thread.Sleep(10); }
                }
                stage = "终止Job"; Need(TerminateJobObject(job, 91));
                while (Active() != 0 || (main != null && WaitForSingleObject(main.Handle, 0) != 0))
                { Need(exit.ElapsedMilliseconds < 10000); Thread.Sleep(10); }
                if (utility != null) { Need(WaitForSingleObject(utility.Handle, 0) == 0); utility.Handle.Dispose(); utility = null; }
                if (main != null) { main.Handle.Dispose(); main = null; }
                Need(!relaunch || graceful);
                stage = "退休全部writer"; Persist(); job.Dispose(); job = null; ownership.Dispose(); ownership = null;
                Need(exit.ElapsedMilliseconds < 10000);
                if (relaunch)
                {
                    ProcessStartInfo info = new ProcessStartInfo(executable, String.IsNullOrEmpty(appRoot) ? "" : Quote(appRoot));
                    info.UseShellExecute = false; info.CreateNoWindow = true;
                    Process child = Process.Start(info); Need(child != null); child.Dispose();
                }
                Environment.Exit(0);
            }
            catch (Exception error) { Report(error); Environment.Exit(2); }
        }
    }
    private static void Receive(string frame)
    {
        lock (Sync)
        {
            Need(!stopped && finished == null && WaitForSingleObject(main.Handle, 0) == 258);
            string[] fields = frame.Split('|'); uint seq = 0;
            Need(fields.Length >= 4 && fields[0] == "1" && fields[1] == nonce && UInt32.TryParse(fields[2], out seq) && seq == sequence + 1 && fields[2] == seq.ToString());
            sequence = seq; admission = Stopwatch.StartNew(); stage = fields[3];
            if (fields[3] == "authorize")
            {
                uint pid = 0; Need(fields.Length == 6 && (fields[4] == "probe" || fields[4] == "transfer") && UInt32.TryParse(fields[5], out pid) && fields[5] == pid.ToString() && utility == null && pid != main.Pid);
                Writer pending = OpenWriter(pid, fields[4], main.Pid);
                bool contains; Need(IsProcessInJob(pending.Handle, job, out contains) && contains);
                utility = pending; Persist(); Deadline(); Need(WaitForSingleObject(pending.Handle, 0) == 258);
            }
            else if (fields[3] == "retire")
            {
                uint pid; Need(fields.Length == 5 && UInt32.TryParse(fields[4], out pid) && fields[4] == pid.ToString() && utility != null && utility.Pid == pid);
                // Electron may report exit before the Windows process handle signals.
                uint wait = WaitForSingleObject(utility.Handle, 0);
                while (wait == 258)
                {
                    Deadline(); Need(WaitForSingleObject(main.Handle, 0) == 258);
                    Thread.Sleep(1); wait = WaitForSingleObject(utility.Handle, 0);
                }
                Need(wait == 0); Deadline();
                Writer old = utility; utility = null; Persist(); old.Handle.Dispose();
            }
            else if (fields[3] == "relaunch") { Need(fields.Length == 4 && !relaunch); relaunch = true; }
            else if (fields[3] == "finish") { Need(fields.Length == 4 && utility == null); finished = Stopwatch.StartNew(); }
            else throw new InvalidOperationException("协议类型无效");
            Deadline(); Send(sequence, "ok");
        }
    }
    public static int Main(string[] args)
    {
        try
        {
            admission = Stopwatch.StartNew(); output = Console.OpenStandardOutput();
            uint pid = 0; Need(args.Length == 5 && UInt32.TryParse(args[1], out pid) && pid != 0 && Regex.IsMatch(args[2], "\\A[a-f0-9]{32}\\z"));
            root = Path.GetFullPath(args[0]); Need(root == args[0]); nonce = args[2]; executable = Path.GetFullPath(args[3]); Need(executable == args[3]); appRoot = args[4];
            Need(appRoot == "" || (Path.IsPathRooted(appRoot) && Path.GetFullPath(appRoot) == appRoot));
            if (appRoot != "") DirectoryIdentity(appRoot);
            rootIdentity = DirectoryIdentity(root);
            rootHash = Hash(Utf8.GetBytes(root.ToUpperInvariant() + "|" + rootIdentity.Volume + "|" + rootIdentity.IndexHigh + "|" + rootIdentity.IndexLow));
            directory = Path.Combine(root, "lifecycle-guardian"); bool fresh = !Directory.Exists(directory);
            if (fresh) Directory.CreateDirectory(directory);
            directoryIdentity = DirectoryIdentity(directory);
            string lockPath = Path.Combine(directory, "owner.lock"); if (!fresh) FilePath(lockPath);
            ownership = new FileStream(lockPath, fresh ? FileMode.CreateNew : FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            FileIdentity(ownership); Need(ownership.Length <= 4096);
            stage = "读取旧writer"; ReadPrevious(fresh); Deadline();
            uint ownPid = (uint)Process.GetCurrentProcess().Id;
            Need(Parent(ownPid) == pid);
            main = OpenWriter(pid, "main", Parent(pid));
            using (SafeFileHandle self = OpenProcess(0x101000, false, ownPid)) Need(!self.IsInvalid && main.Created <= Created(self));
            string name = "Global\\AIbrowse.DataWriters." + rootHash;
            for (;;)
            {
                Deadline(); job = CreateJobObjectW(IntPtr.Zero, name); int error = Marshal.GetLastWin32Error(); Need(!job.IsInvalid);
                if (error != 183) break; job.Dispose(); job = null; Thread.Sleep(20);
            }
            Limits limits = new Limits(); limits.Basic.Flags = 0x2000;
            Need(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(Limits))));
            Limits actual; Need(QueryLimits(job, 9, out actual, (uint)Marshal.SizeOf(typeof(Limits)), IntPtr.Zero) && actual.Basic.Flags == 0x2000);
            Need(AssignProcessToJobObject(job, main.Handle)); bool member;
            Need(IsProcessInJob(main.Handle, job, out member) && member);
            using (SafeFileHandle self = OpenProcess(0x101000, false, ownPid)) Need(IsProcessInJob(self, job, out member) && !member);
            stage = "登记main"; Persist(); Deadline(); Send(0, "ready");
            // Stop owns the same lock while retiring and disposing writer handles.
            Thread monitor = new Thread(delegate() { for (;;) { bool exited, expired; lock (Sync) { if (stopped) return; exited = WaitForSingleObject(main.Handle, 20) == 0; expired = finished != null && finished.ElapsedMilliseconds >= 10000; } if (exited || expired) { Stop(!expired); return; } } });
            monitor.IsBackground = true; monitor.Start();
            using (Stream input = Console.OpenStandardInput())
            {
                StringBuilder line = new StringBuilder();
                for (;;)
                {
                    int value = input.ReadByte(); if (value == -1) { Stop(true); return 2; }
                    Need(++bytes <= 16 * 1024 * 1024);
                    if (value == 10) { Need(++frames <= 65536); Receive(line.ToString()); line.Length = 0; }
                    else { Need(value >= 0x20 && value <= 0x7e && line.Length < 4096); line.Append((char)value); }
                }
            }
        }
        catch (Exception error) { Report(error); Stop(false); return 2; }
    }
}
