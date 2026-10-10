using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class ProductTransferJobBudget
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Basic { public long ProcessTime, JobTime; public uint Flags; public UIntPtr Min, Max; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Extended { public Basic Basic; public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern SafeFileHandle OpenJobObjectW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetInformationJobObject(SafeFileHandle job,int kind,ref Extended value,uint size);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool QueryInformationJobObject(SafeFileHandle job,int kind,IntPtr value,uint size,IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern SafeFileHandle OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool IsProcessInJob(SafeFileHandle process,SafeFileHandle job,out bool present);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetProcessTimes(SafeFileHandle process,out long created,out long exited,out long kernel,out long user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool QueryFullProcessImageNameW(SafeFileHandle process,uint flags,StringBuilder path,ref uint length);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint GetProcessId(SafeFileHandle process);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint WaitForSingleObject(SafeFileHandle process,uint milliseconds);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentProcessId();
    public sealed class Identity {
        public uint Pid { get; private set; }
        public long CreatedFileTime { get; private set; }
        public string Image { get; private set; }
        internal Identity(uint pid,long created,string image) {Pid=pid;CreatedFileTime=created;Image=image;}
    }
    // CIM exposes microsecond timestamps, so compare their common precision.
    public static void ValidateIdentity(uint nativePid,long nativeCreated,string nativeImage,uint cimPid,long cimCreated,string cimImage) {
        if(nativePid==0||nativePid!=cimPid||nativeCreated<=0||nativeCreated/10!=cimCreated/10||String.IsNullOrEmpty(nativeImage)||
           !String.Equals(nativeImage,cimImage,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("CIM与所持原生进程身份不符");
    }
    public static void ValidateLimits(uint flags,uint count) {
        if((flags&0x2008)!=0x2008||count!=24) throw new InvalidOperationException("原生Job实际限额读回不符");
    }
    private static SafeFileHandle Open(string runId) {
        if(!System.Text.RegularExpressions.Regex.IsMatch(runId,"\\A[0-9a-f]{32}\\z")) throw new InvalidOperationException("Job标识无效");
        var job=OpenJobObjectW(6,false,"Local\\AIbrowse.ReleaseProfile.Job."+runId);
        if(job.IsInvalid) {job.Dispose();throw new Win32Exception(Marshal.GetLastWin32Error());}
        return job;
    }
    private static uint[] Members(SafeFileHandle job) {
        int bytes=8+IntPtr.Size*24;IntPtr memory=Marshal.AllocHGlobal(bytes);
        try {
            if(!QueryInformationJobObject(job,3,memory,(uint)bytes,IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            int assigned=Marshal.ReadInt32(memory,0), count=Marshal.ReadInt32(memory,4);
            if(count<1||count>24||assigned!=count) throw new InvalidOperationException("Job进程列表超限或不完整");
            uint[] result=new uint[count];
            for(int i=0;i<count;i++)result[i]=checked((uint)Marshal.ReadIntPtr(memory,8+i*IntPtr.Size).ToInt64());
            if(result.Distinct().Count()!=count)throw new InvalidOperationException("Job重复进程身份");
            return result.OrderBy(pid=>pid).ToArray();
        } finally {Marshal.FreeHGlobal(memory);}
    }
    private static Identity ReadIdentity(SafeFileHandle process,SafeFileHandle job) {
        if(process.IsInvalid||WaitForSingleObject(process,0)!=258||!IsProcessInJob(process,job,out bool inside)||!inside||
           !GetProcessTimes(process,out long created,out _,out _,out _)) throw new InvalidOperationException("所持进程不再存活或不在本Job");
        uint pid=GetProcessId(process),length=32768;var path=new StringBuilder((int)length);
        if(pid==0||!QueryFullProcessImageNameW(process,0,path,ref length))throw new Win32Exception(Marshal.GetLastWin32Error());
        return new Identity(pid,created,path.ToString());
    }
    public sealed class Sample:IDisposable {
        private readonly SafeFileHandle job;
        private readonly List<SafeFileHandle> processes=new List<SafeFileHandle>();
        private readonly List<Identity> identities=new List<Identity>();
        private bool disposed;
        public Identity[] Processes {get {return identities.ToArray();}}
        public uint LimitFlags {get;private set;}
        public uint ActiveProcessLimit {get;private set;}
        internal Sample(string runId,bool apply,uint runner) {
            job=Open(runId);
            try {
                foreach(uint pid in Members(job)) {
                    var process=OpenProcess(0x101000,false,pid);processes.Add(process);
                    var identity=ReadIdentity(process,job);
                    if(identity.Pid!=pid)throw new InvalidOperationException("原生句柄与候选PID不一致");
                    identities.Add(identity);
                }
                if(!identities.Any(value=>value.Pid==runner)||!identities.Any(value=>value.Pid==GetCurrentProcessId()))throw new InvalidOperationException("runner或采样器不在同一Job");
                if(apply) {
                    var limit=new Extended {Basic=new Basic {Flags=0x2008,ActiveLimit=24}};
                    if(!SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf<Extended>()))throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                Verify();
            } catch {Dispose();throw;}
        }
        public void Verify() {
            if(disposed)throw new InvalidOperationException("原生样本已关闭");
            for(int i=0;i<processes.Count;i++) {
                var current=ReadIdentity(processes[i],job);var before=identities[i];
                if(current.Pid!=before.Pid||current.CreatedFileTime!=before.CreatedFileTime||!String.Equals(current.Image,before.Image,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("原生进程样本发生变化");
            }
            if(!Members(job).SequenceEqual(identities.Select(value=>value.Pid)))throw new InvalidOperationException("Job成员集合在采样中变化");
            IntPtr memory=Marshal.AllocHGlobal(Marshal.SizeOf<Extended>());
            try {
                if(!QueryInformationJobObject(job,9,memory,(uint)Marshal.SizeOf<Extended>(),IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error());
                var limits=Marshal.PtrToStructure<Extended>(memory);ValidateLimits(limits.Basic.Flags,limits.Basic.ActiveLimit);
                LimitFlags=limits.Basic.Flags;ActiveProcessLimit=limits.Basic.ActiveLimit;
            } finally {Marshal.FreeHGlobal(memory);}
        }
        public void Dispose() {if(disposed)return;disposed=true;foreach(var process in processes)process.Dispose();job.Dispose();}
    }
    public static Sample Inspect(string runId,bool apply,uint runner) {return new Sample(runId,apply,runner);}
}
