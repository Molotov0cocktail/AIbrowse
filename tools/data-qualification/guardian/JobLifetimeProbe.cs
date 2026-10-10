using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// Qualification only. All processes are this executable's direct children.
internal static class JobLifetimeProbe
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
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int type, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(SafeFileHandle job, int type, out Accounting info, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")]
    private static extern bool QueryAccounting(SafeFileHandle job, int type, out Accounting info, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")]
    private static extern bool QueryProcessList(SafeFileHandle job, int type, IntPtr info, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, SafeFileHandle job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(SafeFileHandle job, uint code);

    private static void Require(bool ok, string message)
    {
        if (!ok) throw new InvalidOperationException(message + " (" + Marshal.GetLastWin32Error() + ")");
    }
    private static SafeFileHandle Create(string name, bool fresh)
    {
        SafeFileHandle job = CreateJobObjectW(IntPtr.Zero, name);
        int error = Marshal.GetLastWin32Error();
        if (job.IsInvalid || (error == 183) == fresh)
        {
            job.Dispose();
            throw new Win32Exception(error, "Job身份与预期不符");
        }
        if (fresh)
        {
            ExtendedLimits limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000;
            Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "设置Job失败");
        }
        return job;
    }
    private static uint Active(SafeFileHandle job)
    {
        Accounting info;
        Require(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "查询Job失败");
        return info.ActiveProcesses;
    }
    private static void Diagnose(string label, SafeFileHandle job, Process child)
    {
        Accounting info;
        uint returned;
        bool contained;
        bool queried = QueryAccounting(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), out returned);
        int queryError = Marshal.GetLastWin32Error();
        bool checkedMembership = IsProcessInJob(child.Handle, job, out contained);
        bool self;
        bool checkedSelf = IsProcessInJob(Process.GetCurrentProcess().Handle, job, out self);
        Console.WriteLine("DIAG " + label + " handle=" + job.DangerousGetHandle() +
            " query=" + queried + " error=" + queryError + " size=" + Marshal.SizeOf(typeof(Accounting)) +
            " returned=" + returned + " total=" + info.TotalProcesses + " active=" + info.ActiveProcesses +
            " terminated=" + info.TerminatedProcesses + " membership=" + checkedMembership + ":" + contained +
            " self=" + checkedSelf + ":" + self + " exited=" + child.WaitForExit(0));
        IntPtr list = Marshal.AllocHGlobal(8 + 16 * IntPtr.Size);
        try
        {
            Require(QueryProcessList(job, 3, list, (uint)(8 + 16 * IntPtr.Size), out returned), "Job成员列表超限或失败");
            int length = Marshal.ReadInt32(list, 4);
            Require(length >= 0 && length <= 16, "Job成员列表超限");
            for (int i = 0; i < length; i++)
            {
                int id = checked((int)Marshal.ReadIntPtr(list, 8 + i * IntPtr.Size).ToInt64());
                using (Process member = Process.GetProcessById(id))
                    Console.WriteLine("MEMBER " + label + " pid=" + id + " image=" + member.ProcessName + " created=" + member.StartTime.ToUniversalTime().Ticks);
            }
        }
        finally { Marshal.FreeHGlobal(list); }
    }
    private static Process Start(string arguments)
    {
        ProcessStartInfo info = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, arguments);
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardInput = true;
        info.RedirectStandardOutput = true;
        Process child = Process.Start(info);
        // Materialize the exact kernel process handle before any termination.
        Require(child.Handle != IntPtr.Zero, "子进程句柄无效");
        return child;
    }
    private static void Attach(SafeFileHandle job, Process process)
    {
        Require(AssignProcessToJobObject(job, process.Handle), "加入Job失败");
        bool contained;
        Require(IsProcessInJob(process.Handle, job, out contained) && contained, "Job归属无效");
    }
    private static void StopOwned(Process child)
    {
        if (!child.HasExited) child.Kill();
        Require(child.WaitForExit(2000), "自有子进程退出未知");
    }
    private static void FreshEventually(string name)
    {
        Stopwatch watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < 2000)
        {
            using (SafeFileHandle job = CreateJobObjectW(IntPtr.Zero, name))
            {
                int error = Marshal.GetLastWin32Error();
                Require(!job.IsInvalid, "重开Job失败");
                if (error != 183) return;
            }
            Thread.Sleep(20);
        }
        throw new InvalidOperationException("旧Job仍存在");
    }
    private static void CloseCases(string name, bool observer)
    {
        using (SafeFileHandle job = Create(name, true))
        using (Process child = Start("leaf"))
        {
            try
            {
                Attach(job, child);
                Require(Active(job) > 0, "Job未计入自有进程");
                if (observer)
                {
                    using (SafeFileHandle other = Create(name, false))
                    {
                        Diagnose("owner-before-close", job, child);
                        Diagnose("observer-before-close", other, child);
                        job.Dispose();
                        Require(!child.WaitForExit(100), "观察handle未保持Job寿命");
                        Diagnose("observer-after-close", other, child);
                        // A console host may join after the managed child starts.
                        bool contained;
                        Require(IsProcessInJob(child.Handle, other, out contained) && contained && Active(other) > 0,
                            "观察handle未保留确切子进程");
                    }
                }
                else job.Dispose();
                Require(child.WaitForExit(2000), "last-close后实际退出未知");
            }
            finally { StopOwned(child); }
        }
        FreshEventually(name);
    }
    private static void Nested(string name)
    {
        using (SafeFileHandle outer = Create(name + ".outer", true))
        using (SafeFileHandle inner = Create(name, true))
        using (Process child = Start("leaf"))
        {
            try
            {
                Attach(outer, child);
                Attach(inner, child);
                Require(Active(outer) > 0 && Active(inner) > 0, "嵌套计数错误");
                Require(TerminateJobObject(inner, 93), "终止嵌套Job失败");
                Require(child.WaitForExit(2000), "嵌套Job实际退出未知");
                Stopwatch watch = Stopwatch.StartNew();
                while (Active(inner) != 0 && watch.ElapsedMilliseconds < 2000) Thread.Sleep(10);
                Require(Active(inner) == 0 && Active(outer) == 0, "嵌套Job未归零");
            }
            finally { StopOwned(child); }
        }
    }
    private static int Owner(string name)
    {
        using (SafeFileHandle job = Create(name, true))
        using (Process child = Start("leaf"))
        {
            try
            {
                Attach(job, child);
                Console.WriteLine(child.Id);
                Console.Out.Flush();
                Console.ReadLine();
                Require(TerminateJobObject(job, 94), "父通道关闭后终止失败");
                Require(child.WaitForExit(2000), "父通道关闭后退出未知");
                Stopwatch wait = Stopwatch.StartNew();
                while (Active(job) != 0 && wait.ElapsedMilliseconds < 2000) Thread.Sleep(10);
                Require(Active(job) == 0, "父通道关闭后Job未归零");
                return 0;
            }
            finally { StopOwned(child); }
        }
    }
    private static void OwnerCase(string name, bool crash)
    {
        using (Process owner = Start("owner " + name))
        {
            try
            {
                var line = owner.StandardOutput.ReadLineAsync();
                Require(line.Wait(2000), "owner就绪超时");
                int id;
                Require(Int32.TryParse(line.Result, out id), "owner未返回固定PID");
                using (Process child = Process.GetProcessById(id))
                {
                    Require(child.Handle != IntPtr.Zero, "leaf句柄无效");
                    if (crash) owner.Kill();
                    else owner.StandardInput.Close();
                    Require(owner.WaitForExit(2500), "owner退出未知");
                    Require(child.WaitForExit(2500), "owner退出后leaf仍存活");
                    if (!crash) Require(owner.ExitCode == 0, "owner未确认实际归零");
                }
            }
            finally { StopOwned(owner); }
        }
        FreshEventually(name);
    }
    private static int InheritedMain()
    {
        Require(Console.ReadLine() == "go", "main未收到受控启动许可");
        using (Process child = Start("leaf"))
        {
            Console.WriteLine(child.Id);
            Console.Out.Flush();
            Console.ReadLine();
            StopOwned(child);
        }
        return 0;
    }
    private static void Inheritance(string name)
    {
        using (SafeFileHandle job = Create(name, true))
        using (Process main = Start("inherited-main"))
        {
            try
            {
                Attach(job, main);
                main.StandardInput.WriteLine("go");
                main.StandardInput.Flush();
                var line = main.StandardOutput.ReadLineAsync();
                Require(line.Wait(2000), "继承子进程启动超时");
                int id;
                Require(Int32.TryParse(line.Result, out id), "继承子进程PID无效");
                using (Process child = Process.GetProcessById(id))
                {
                    Require(child.Handle != IntPtr.Zero, "继承子进程句柄无效");
                    // No Assign call is made for this child.
                    Diagnose("inherited-tree", job, child);
                    bool contained;
                    Require(IsProcessInJob(child.Handle, job, out contained) && contained, "子进程未自动继承Job");
                    main.Kill();
                    Require(main.WaitForExit(2000), "main退出未知");
                    Require(TerminateJobObject(job, 95), "main退出后终止树失败");
                    Require(child.WaitForExit(2000), "main退出后继承子进程退出未知");
                    Stopwatch wait = Stopwatch.StartNew();
                    while (Active(job) != 0 && wait.ElapsedMilliseconds < 2000) Thread.Sleep(10);
                    Require(Active(job) == 0, "main退出后Job未归零");
                }
            }
            finally { StopOwned(main); }
        }
        FreshEventually(name);
    }
    private static void NameBarrier()
    {
        Stopwatch total = Stopwatch.StartNew();
        for (int iteration = 0; iteration < 20; iteration++)
        {
            Require(total.ElapsedMilliseconds < 10000, "命名资格总预算耗尽");
            string name = "Local\\AIbrowse.GuardianQualification." + Guid.NewGuid().ToString("N");
            using (SafeFileHandle job = Create(name, true))
            using (Process child = Start("leaf"))
            {
                try
                {
                    Attach(job, child);
                    job.Dispose();
                    bool before = child.WaitForExit(0);
                    using (SafeFileHandle next = CreateJobObjectW(IntPtr.Zero, name))
                    {
                        int error = Marshal.GetLastWin32Error();
                        Require(!next.IsInvalid, "同名Job查询失败");
                        bool after = child.WaitForExit(0);
                        Console.WriteLine("BARRIER iteration=" + iteration + " fresh=" + (error != 183) + " before=" + before + " after=" + after);
                        Require(error == 183 || after, "REPLAN同名新Job可早于旧进程实际退出");
                    }
                    Require(child.WaitForExit(2000), "旧进程实际退出未知");
                }
                finally { StopOwned(child); }
            }
        }
        Console.WriteLine("PASS name-barrier-samples elapsedMs=" + total.ElapsedMilliseconds);
    }
    public static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "leaf") { Thread.Sleep(15000); return 0; }
            if (args.Length == 1 && args[0] == "inherited-main") return InheritedMain();
            if (args.Length == 1 && args[0] == "name-barrier") { NameBarrier(); return 0; }
            if (args.Length == 2 && args[0] == "owner") return Owner(args[1]);
            if (args.Length == 1 && args[0] == "diagnose-observer")
            {
                CloseCases("Local\\AIbrowse.GuardianQualification." + Guid.NewGuid().ToString("N"), true);
                Console.WriteLine("PASS observer-diagnostic");
                return 0;
            }
            Require(args.Length == 0, "参数无效");
            string name = "Local\\AIbrowse.GuardianQualification." + Guid.NewGuid().ToString("N");
            Stopwatch total = Stopwatch.StartNew();
            CloseCases(name + ".close", false); Console.WriteLine("PASS last-close+actual-exit+fresh-name");
            CloseCases(name + ".observer", true); Console.WriteLine("PASS observer-retains-job-until-close");
            Nested(name + ".nested"); Console.WriteLine("PASS nested-job+actual-zero");
            OwnerCase(name + ".stdin", false); Console.WriteLine("PASS stdin-eof+actual-zero");
            OwnerCase(name + ".crash", true); Console.WriteLine("PASS owner-crash+actual-exit+fresh-name");
            Inheritance(name + ".inherited"); Console.WriteLine("PASS main-job+child-inheritance+actual-zero");
            Require(total.ElapsedMilliseconds < 60000, "资格总预算超时");
            Console.WriteLine("elapsedMs=" + total.ElapsedMilliseconds);
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine("FAIL " + error.Message); return 1; }
    }
}
