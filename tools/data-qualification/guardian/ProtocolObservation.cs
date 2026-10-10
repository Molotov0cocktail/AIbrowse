using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace AIbrowse.GuardianQualification
{
    // Observes held process identities outside the product data Job.
    public static class ProtocolObservation
    {
        [StructLayout(LayoutKind.Sequential, Pack = 4)]
        private struct FileInfo
        {
            public uint Attributes; public long Created, Accessed, Written;
            public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeFileHandle OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(SafeFileHandle handle, out long created, out long exited, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(SafeFileHandle handle, uint ms);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(SafeFileHandle handle, out uint code);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageNameW(SafeFileHandle handle, uint flags, StringBuilder image, ref uint count);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
        public sealed class ProcessFact
        {
            public string Role; public uint Pid; public long Created; public uint ExitCode; public bool Signaled;
            internal SafeFileHandle Handle;
        }
        public sealed class FileFact
        {
            public string identity; public string hash; public long bytes; public uint attributes; public uint links;
        }
        public sealed class Result
        {
            public uint HostExit; public bool ActualZero; public double ElapsedMs;
            public string Failure; public ProcessFact[] Processes; public FileFact Before;
        }
        public sealed class Pins : IDisposable
        {
            internal List<SafeFileHandle> Handles = new List<SafeFileHandle>();
            public void Dispose() { for (int i = Handles.Count - 1; i >= 0; i--) Handles[i].Dispose(); Handles.Clear(); }
        }
        private static void Need(bool value) { if (!value) throw new InvalidOperationException("协议独审资格检查失败"); }
        public static Pins Pin(string root)
        {
            Need(Path.GetFullPath(root) == root);
            Pins result = new Pins();
            try
            {
                List<string> paths = new List<string>(); string path = root;
                while (!String.IsNullOrEmpty(path)) { Need(paths.Count < 64); paths.Add(path); path = Path.GetDirectoryName(path); }
                paths.Reverse();
                foreach (string item in paths)
                {
                    SafeFileHandle held = CreateFileW(item, 0xA0, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                    if (held.IsInvalid) { int error = Marshal.GetLastWin32Error(); held.Dispose(); throw new Win32Exception(error); }
                    result.Handles.Add(held); FileInfo info;
                    Need(GetFileInformationByHandle(held, out info) && (info.Attributes & 0x410) == 0x10);
                    StringBuilder final = new StringBuilder(32768); uint count = GetFinalPathNameByHandleW(held, final, (uint)final.Capacity, 0);
                    Need(count > 0 && count < final.Capacity);
                    string canonical = final.ToString(); if (canonical.StartsWith(@"\\?\", StringComparison.Ordinal)) canonical = canonical.Substring(4);
                    Need(String.Equals(canonical.TrimEnd('\\'), item.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase));
                }
                return result;
            }
            catch { result.Dispose(); throw; }
        }
        public static void Save(string path, string text)
        {
            byte[] value = new UTF8Encoding(false, true).GetBytes(text); Need(value.Length <= 65536);
            Need(!File.Exists(path)); string temporary = path + ".publishing";
            using (FileStream stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) { stream.Write(value, 0, value.Length); stream.Flush(true); }
            File.Move(temporary, path);
        }
        public static FileFact Inspect(string path)
        {
            Need((File.GetAttributes(path) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) == 0);
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                FileInfo before, after = new FileInfo(); Need(GetFileInformationByHandle(stream.SafeFileHandle, out before));
                Need(stream.Length <= 4096 && before.Links == 1 && (before.Attributes & 0x410) == 0);
                byte[] value = new byte[(int)stream.Length]; int offset = 0;
                while (offset < value.Length) { int count = stream.Read(value, offset, value.Length - offset); Need(count > 0); offset += count; }
                Need(stream.ReadByte() == -1 && GetFileInformationByHandle(stream.SafeFileHandle, out after));
                Need(before.Volume == after.Volume && before.IndexHigh == after.IndexHigh && before.IndexLow == after.IndexLow && before.Written == after.Written && before.SizeLow == after.SizeLow && before.SizeHigh == after.SizeHigh);
                using (SHA256 sha = SHA256.Create()) return new FileFact { identity = before.Volume.ToString("X8") + ":" + before.IndexHigh.ToString("X8") + before.IndexLow.ToString("X8"), hash = BitConverter.ToString(sha.ComputeHash(value)).Replace("-", "").ToLowerInvariant(), bytes = value.Length, attributes = before.Attributes, links = before.Links };
            }
        }
        private static ProcessFact Hold(string role, uint pid, string image, long expectedCreated)
        {
            SafeFileHandle handle = OpenProcess(0x101000, false, pid);
            try
            {
                Need(!handle.IsInvalid); long created, exited, kernel, user;
                Need(GetProcessTimes(handle, out created, out exited, out kernel, out user));
                Need(expectedCreated == 0 || expectedCreated == created);
                StringBuilder actual = new StringBuilder(32768); uint count = (uint)actual.Capacity;
                Need(QueryFullProcessImageNameW(handle, 0, actual, ref count) && String.Equals(actual.ToString(), image, StringComparison.OrdinalIgnoreCase));
                Need(WaitForSingleObject(handle, 0) == 258);
                ProcessFact fact = new ProcessFact { Role = role, Pid = pid, Created = created, Handle = handle }; handle = null; return fact;
            }
            finally { if (handle != null) handle.Dispose(); }
        }
        public static Result Execute(string node, string script, string helper, string dataRoot, string evidenceRoot, string mode, string nonce, string jobId)
        {
            Need(Marshal.SizeOf(typeof(FileInfo)) == 52 && Marshal.OffsetOf(typeof(FileInfo), "Volume").ToInt32() == 28);
            Stopwatch elapsed = Stopwatch.StartNew(); Result result = new Result();
            List<ProcessFact> held = new List<ProcessFact>(); Exception observerFailure = null;
            ManualResetEvent stop = new ManualResetEvent(false); Thread observer = null;
            try
            {
                Action<uint, long> started = delegate(uint pid, long created)
                {
                    held.Add(Hold("main", pid, node, created));
                    AIbrowse.ReleaseProfile.JobProcess.AssertContains(jobId, pid);
                    observer = new Thread(delegate()
                    {
                        try
                        {
                            bool guardian = false, utility = false, ledger = false;
                            while (!stop.WaitOne(5))
                            {
                                Need(elapsed.ElapsedMilliseconds < 15000);
                                foreach (string role in new string[] { "guardian", "utility" })
                                {
                                    if (role == "guardian" ? guardian : utility) continue;
                                    string request = Path.Combine(evidenceRoot, "observe-" + role + ".txt");
                                    if (!File.Exists(request)) continue;
                                    byte[] bytes = File.ReadAllBytes(request); Need(bytes.Length <= 16);
                                    string text = Encoding.ASCII.GetString(bytes); uint observed = 0;
                                    Need(text.EndsWith("\n", StringComparison.Ordinal) && UInt32.TryParse(text.TrimEnd('\n'), out observed) && text == observed.ToString() + "\n");
                                    ProcessFact fact = Hold(role, observed, role == "guardian" ? helper : node, 0); held.Add(fact);
                                    AIbrowse.ReleaseProfile.JobProcess.AssertContains(jobId, observed);
                                    Save(Path.Combine(evidenceRoot, "observed-" + role + ".txt"), observed + "|" + fact.Created + "\n");
                                    if (role == "guardian") guardian = true; else utility = true;
                                }
                                string ledgerRequest = Path.Combine(evidenceRoot, "observe-ledger.txt");
                                if (!ledger && File.Exists(ledgerRequest))
                                {
                                    Need(File.ReadAllText(ledgerRequest) == "1\n"); result.Before = Inspect(Path.Combine(dataRoot, "lifecycle-guardian", "writers.json"));
                                    Save(Path.Combine(evidenceRoot, "observed-ledger.json"), "{\"identity\":\"" + result.Before.identity + "\",\"hash\":\"" + result.Before.hash + "\"}"); ledger = true;
                                }
                            }
                        }
                        catch (Exception error) { observerFailure = error; }
                    });
                    observer.IsBackground = true; observer.Start();
                };
                result.HostExit = AIbrowse.ReleaseProfile.JobProcess.Execute(node, new string[] { script, helper, dataRoot, evidenceRoot, mode, nonce }, evidenceRoot, jobId, 15000, started);
                result.ActualZero = true;
            }
            catch (Exception error)
            {
                result.Failure = error.GetType().Name + ":" + error.Message;
                if (error.Message.Contains("固定验收超时；Job 已确认实际归零")) result.ActualZero = true;
            }
            finally
            {
                stop.Set();
                if (observer != null && !observer.Join(1000)) throw new InvalidOperationException("协议观察器未退出");
                stop.Dispose();
                try
                {
                    foreach (ProcessFact fact in held)
                    {
                        fact.Signaled = WaitForSingleObject(fact.Handle, 0) == 0;
                        uint code; Need(GetExitCodeProcess(fact.Handle, out code)); fact.ExitCode = code;
                    }
                }
                finally { foreach (ProcessFact fact in held) fact.Handle.Dispose(); }
                result.Processes = held.ToArray();
            }
            if (observerFailure != null) result.Failure = observerFailure.GetType().Name + ":" + observerFailure.Message;
            result.ElapsedMs = elapsed.Elapsed.TotalMilliseconds;
            if (elapsed.ElapsedMilliseconds >= 15000 && result.Failure == null) result.Failure = "协议工作期限耗尽";
            return result;
        }
    }
}
