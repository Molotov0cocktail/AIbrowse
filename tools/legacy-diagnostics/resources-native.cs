using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace AIbrowse.LegacyResources
{
    public sealed class ProcessProbe : IDisposable
    {
        [DllImport("kernel32.dll", SetLastError = true)] static extern SafeFileHandle OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle OpenJobObjectW(uint access, bool inherit, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(SafeFileHandle job, int information, IntPtr buffer, uint length, IntPtr returned);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(SafeFileHandle process, out long created, out long exited, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessHandleCount(SafeFileHandle process, out uint count);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(SafeFileHandle process, uint milliseconds);
        [DllImport("kernel32.dll")] static extern uint PssCaptureSnapshot(SafeFileHandle process, uint flags, uint context, out IntPtr snapshot);
        [DllImport("kernel32.dll")] static extern uint PssFreeSnapshot(IntPtr process, IntPtr snapshot);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")] static extern uint PssWalkMarkerCreate(IntPtr allocator, out IntPtr marker);
        [DllImport("kernel32.dll")] static extern uint PssWalkMarkerFree(IntPtr marker);
        [DllImport("kernel32.dll")] static extern uint PssWalkSnapshot(IntPtr snapshot, uint information, IntPtr marker, IntPtr buffer, uint length);
        [DllImport("user32.dll")] static extern uint GetGuiResources(SafeFileHandle process, uint flags);
        [DllImport("ntdll.dll")] static extern int NtQueryObject(IntPtr handle, int information, IntPtr buffer, uint length, out uint returned);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(SafeFileHandle source, IntPtr handle, IntPtr target, out SafeFileHandle duplicate, uint access, bool inherit, uint options);

        readonly SafeFileHandle process;
        public readonly int Pid;
        public readonly string CreatedFileTime;
        public static int[] JobPids(string runId)
        {
            if (!System.Text.RegularExpressions.Regex.IsMatch(runId, "\\A[0-9a-f]{32}\\z")) throw new InvalidOperationException("Job 身份无效");
            using (var job = OpenJobObjectW(4, false, "Local\\AIbrowse.Performance.Job." + runId))
            {
                if (job.IsInvalid) return new int[0];
                IntPtr buffer = Marshal.AllocHGlobal(264);
                try
                {
                    if (!QueryInformationJobObject(job, 3, buffer, 264, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    int count = Marshal.ReadInt32(buffer, 4);
                    if (count < 0 || count > 24) throw new InvalidOperationException("Job 进程数超限");
                    var pids = new int[count];
                    for (int index = 0; index < count; index++) pids[index] = checked((int)Marshal.ReadInt64(buffer, 8 + index * 8));
                    return pids;
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
        }
        public ProcessProbe(int pid)
        {
            if (IntPtr.Size != 8) throw new InvalidOperationException("仅支持 Windows x64");
            Pid = pid;
            process = OpenProcess(0x00100450, false, pid);
            if (process.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            long created, exited, kernel, user;
            if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
            CreatedFileTime = created.ToString();
        }
        public sealed class HandleFact { public string Value; public string Type; public uint Flags; }
        public sealed class SnapshotFact
        {
            public int Pid; public string CreatedFileTime; public string ExitFileTime; public bool Exited;
            public uint NativeHandles; public uint Gdi; public uint User; public long Rss; public long PrivateBytes;
            public double DurationMs; public List<HandleFact> Handles = new List<HandleFact>();
            public Dictionary<string, int> Types = new Dictionary<string, int>();
        }
        public string ExitFileTime()
        {
            long created, exited, kernel, user;
            if (!GetProcessTimes(process, out created, out exited, out kernel, out user) || created.ToString() != CreatedFileTime)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return exited == 0 ? null : exited.ToString();
        }
        string TypeName(IntPtr targetHandle)
        {
            SafeFileHandle duplicate;
            if (!DuplicateHandle(process, targetHandle, GetCurrentProcess(), out duplicate, 0, false, 2)) return "unresolved-duplicate-" + Marshal.GetLastWin32Error();
            using (duplicate)
            {
                IntPtr buffer = Marshal.AllocHGlobal(4096);
                try
                {
                    uint returned;
                    int status = NtQueryObject(duplicate.DangerousGetHandle(), 2, buffer, 4096, out returned);
                    if (status != 0) return "unresolved-query-" + status.ToString("x");
                    int bytes = (ushort)Marshal.ReadInt16(buffer);
                    IntPtr text = Marshal.ReadIntPtr(buffer, 8);
                    if (bytes <= 0 || bytes > 256 || bytes % 2 != 0 || text == IntPtr.Zero) return "unresolved";
                    return Marshal.PtrToStringUni(text, bytes / 2);
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
        }
        public SnapshotFact Capture()
        {
            var watch = Stopwatch.StartNew();
            var result = new SnapshotFact { Pid = Pid, CreatedFileTime = CreatedFileTime, ExitFileTime = ExitFileTime(), Exited = WaitForSingleObject(process, 0) == 0 };
            if (result.Exited) return result;
            if (!GetProcessHandleCount(process, out result.NativeHandles)) throw new Win32Exception(Marshal.GetLastWin32Error());
            result.Gdi = GetGuiResources(process, 0); result.User = GetGuiResources(process, 1);
            using (var managed = Process.GetProcessById(Pid)) { result.Rss = managed.WorkingSet64; result.PrivateBytes = managed.PrivateMemorySize64; }
            IntPtr snapshot = IntPtr.Zero, marker = IntPtr.Zero, buffer = IntPtr.Zero;
            try
            {
                uint status = PssCaptureSnapshot(process, 0x34, 0, out snapshot);
                if (status != 0) throw new Win32Exception((int)status, "句柄快照失败");
                status = PssWalkMarkerCreate(IntPtr.Zero, out marker);
                if (status != 0) throw new Win32Exception((int)status);
                buffer = Marshal.AllocHGlobal(136);
                while ((status = PssWalkSnapshot(snapshot, 2, marker, buffer, 136)) == 0)
                {
                    if (result.Handles.Count >= 16384 || watch.ElapsedMilliseconds > 10000) throw new InvalidOperationException("句柄快照超预算");
                    var handle = Marshal.ReadIntPtr(buffer, 0);
                    int typeBytes = (ushort)Marshal.ReadInt16(buffer, 56);
                    IntPtr typePointer = Marshal.ReadIntPtr(buffer, 64);
                    string type = typeBytes > 0 && typeBytes <= 256 && typeBytes % 2 == 0 && typePointer != IntPtr.Zero
                        ? Marshal.PtrToStringUni(typePointer, typeBytes / 2).TrimEnd('\0') : TypeName(handle);
                    result.Handles.Add(new HandleFact { Value = handle.ToInt64().ToString("x"), Type = type, Flags = (uint)Marshal.ReadInt32(buffer, 8) });
                    if (!result.Types.ContainsKey(type)) result.Types[type] = 0;
                    result.Types[type]++;
                }
                if (status != 259) throw new Win32Exception((int)status, "句柄遍历失败");
            }
            finally
            {
                if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
                if (marker != IntPtr.Zero) PssWalkMarkerFree(marker);
                if (snapshot != IntPtr.Zero) PssFreeSnapshot(GetCurrentProcess(), snapshot);
            }
            result.DurationMs = watch.Elapsed.TotalMilliseconds;
            return result;
        }
        public void Dispose() { process.Dispose(); }
    }
}
