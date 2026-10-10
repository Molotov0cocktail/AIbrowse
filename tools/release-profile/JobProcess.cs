using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace AIbrowse.ReleaseProfile
{
    public static class JobProcess
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimits
        {
            public long ProcessTime, JobTime;
            public uint Flags;
            public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimits
        {
            public BasicLimits Basic;
            public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct Accounting
        {
            public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
            public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct Startup
        {
            public uint Size;
            public string Reserved, Desktop, Title;
            public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
            public ushort Show, ReservedBytes;
            public IntPtr ReservedPointer, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct StartupEx { public Startup Startup; public IntPtr Attributes; }
        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string name);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle OpenJobObjectW(uint access, bool inherit, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(SafeFileHandle job, int type, ref ExtendedLimits limits, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(SafeFileHandle job, int type, out Accounting info, uint length, IntPtr returned);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(SafeFileHandle job, uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref UIntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
            bool inherit, uint flags, IntPtr environment, string directory, ref StartupEx startup, out ProcessInformation process);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(SafeFileHandle process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetProcessTimes(SafeFileHandle process, out long created, out long exited, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern SafeFileHandle OpenProcess(uint access, bool inherit, uint processId);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsProcessInJob(SafeFileHandle process, SafeFileHandle job, out bool result);

        private static string Name(string runId) { return "Local\\AIbrowse.ReleaseProfile.Job." + runId; }

        private static uint Active(SafeFileHandle job)
        {
            if (!QueryInformationJobObject(job, 1, out Accounting info, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "无法确认 Job 内实际进程数");
            return info.ActiveProcesses;
        }

        public static void ConfirmReleased(string runId)
        {
            using (SafeFileHandle job = OpenJobObjectW(4, false, Name(runId)))
            {
                if (job.IsInvalid)
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error == 2) return;
                    throw new Win32Exception(error, "无法确认前次 Job 状态");
                }
                Stopwatch budget = Stopwatch.StartNew();
                while (Active(job) != 0)
                {
                    if (budget.Elapsed.TotalSeconds > 30) throw new InvalidOperationException("前次 Job 进程尚未实际退出，保留待恢复");
                    Thread.Sleep(50);
                }
            }
        }

        public static void AssertContains(string runId, uint processId)
        {
            using (SafeFileHandle job = OpenJobObjectW(4, false, Name(runId)))
            using (SafeFileHandle process = OpenProcess(0x1000, false, processId))
            {
                if (job.IsInvalid || process.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法打开受控Job或进程");
                if (!IsProcessInJob(process, job, out bool contained)) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法查询进程Job身份");
                if (!contained) throw new InvalidOperationException("进程不属于本次受控Job");
            }
        }

        private static string Quote(string argument)
        {
            if (argument.IndexOf('\0') >= 0 || argument.IndexOf('\r') >= 0 || argument.IndexOf('\n') >= 0)
                throw new InvalidOperationException("命令参数含控制字符");
            StringBuilder result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char value in argument)
            {
                if (value == '\\') { slashes++; continue; }
                result.Append('\\', value == '"' ? slashes * 2 + 1 : slashes);
                result.Append(value);
                slashes = 0;
            }
            result.Append('\\', slashes * 2).Append('"');
            return result.ToString();
        }

        public static uint Execute(string executable, string[] arguments, string directory, string runId, int timeoutMs, Action<uint, long> started)
        { return ExecuteCore(executable, arguments, directory, runId, timeoutMs, started, null, null); }

        public static uint Execute(string executable, string[] arguments, string directory, string runId, int absoluteDeadlineMs, Action<uint, long> started, Stopwatch originalClock, Func<bool> stopRequested)
        {
            if (originalClock == null || !originalClock.IsRunning || absoluteDeadlineMs < 1 || originalClock.ElapsedMilliseconds >= absoluteDeadlineMs)
                throw new InvalidOperationException("恢复Job原期限已耗尽");
            return ExecuteCore(executable, arguments, directory, runId, absoluteDeadlineMs, started, originalClock, stopRequested);
        }

        private static uint ExecuteCore(string executable, string[] arguments, string directory, string runId, int timeoutMs, Action<uint, long> started, Stopwatch originalClock, Func<bool> stopRequested)
        {
            using (SafeFileHandle job = CreateJobObjectW(IntPtr.Zero, Name(runId)))
            {
                if (job.IsInvalid || Marshal.GetLastWin32Error() == 183) throw new InvalidOperationException("无法创建唯一 Job");
                ExtendedLimits limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } };
                if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>())) throw new Win32Exception(Marshal.GetLastWin32Error());
                UIntPtr bytes = UIntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
                IntPtr attributes = Marshal.AllocHGlobal((int)bytes.ToUInt64());
                IntPtr jobs = Marshal.AllocHGlobal(IntPtr.Size);
                bool initialized = false;
                try
                {
                    if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref bytes)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    initialized = true;
                    Marshal.WriteIntPtr(jobs, job.DangerousGetHandle());
                    // JOB_LIST attaches the process at creation; there is no suspended orphan interval.
                    if (!UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x2000D), jobs, new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "平台不支持创建时原子加入 Job");
                    StartupEx startup = new StartupEx { Startup = new Startup { Size = (uint)Marshal.SizeOf<StartupEx>() }, Attributes = attributes };
                    string command = String.Join(" ", new[] { executable }.Concat(arguments).Select(Quote));
                    if (originalClock != null && originalClock.ElapsedMilliseconds >= timeoutMs)
                        throw new InvalidOperationException("恢复Job启动前原期限已耗尽");
                    if (!CreateProcessW(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false, 0x08080000,
                        IntPtr.Zero, directory, ref startup, out ProcessInformation info)) throw new Win32Exception(Marshal.GetLastWin32Error(), "固定验收工具启动失败");
                    using (SafeFileHandle process = new SafeFileHandle(info.Process, true))
                    using (SafeFileHandle thread = new SafeFileHandle(info.Thread, true))
                    {
                        if (!GetProcessTimes(process, out long created, out _, out _, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
                        started(info.ProcessId, created);
                        Stopwatch budget = originalClock ?? Stopwatch.StartNew();
                        bool timedOut = false;
                        bool rejected = false;
                        long stoppedAt = -1;
                        while (Active(job) != 0)
                        {
                            if (!timedOut && !rejected && stopRequested != null && stopRequested()) {
                                rejected = true; stoppedAt = budget.ElapsedMilliseconds;
                                if (!TerminateJobObject(job, 93)) throw new Win32Exception(Marshal.GetLastWin32Error(), "恢复失败Job终止失败");
                            }
                            if ((originalClock == null ? budget.ElapsedMilliseconds > timeoutMs : budget.ElapsedMilliseconds >= timeoutMs) && !timedOut && !rejected)
                            {
                                timedOut = true;
                                stoppedAt = originalClock == null ? -1 : timeoutMs;
                                if (!TerminateJobObject(job, 92)) throw new Win32Exception(Marshal.GetLastWin32Error(), "终止超时 Job 失败");
                            }
                            if (budget.ElapsedMilliseconds > (stoppedAt >= 0 ? stoppedAt : timeoutMs) + 30000) throw new InvalidOperationException("Job 终止后未实际归零，保留待恢复");
                            Thread.Sleep(50);
                        }
                        if (timedOut) throw new InvalidOperationException("固定验收超时；Job 已确认实际归零");
                        if (rejected) throw new InvalidOperationException("恢复场景失败；Job 已确认实际归零");
                        if (!GetExitCodeProcess(process, out uint exitCode) || exitCode == 259) throw new InvalidOperationException("Job 归零但根进程终态未知");
                        if (originalClock != null && originalClock.ElapsedMilliseconds >= timeoutMs)
                            throw new InvalidOperationException("恢复Job根进程退出晚于原期限");
                        return exitCode;
                    }
                }
                finally
                {
                    if (initialized) DeleteProcThreadAttributeList(attributes);
                    Marshal.FreeHGlobal(attributes);
                    Marshal.FreeHGlobal(jobs);
                }
            }
        }
    }
}
