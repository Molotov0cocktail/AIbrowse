using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace AIbrowse.FullConversations
{
    public static class FixedPrepareJob
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

        private static string Name(string runId) { return "Local\\AIbrowse.FullConversations.Job." + runId; }

        private static uint Active(SafeFileHandle job)
        {
            if (!QueryInformationJobObject(job, 1, out Accounting info, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "无法确认 Job 内实际进程数");
            return info.ActiveProcesses;
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

        // The same native handles remain owned until this Job is observed empty.
        public sealed class Result {
            public bool Started, ActualZero, LimitsVerified, OwnershipRetained, Succeeded;
            public uint ProcessId, ExitCode, ActiveAtEnd, LimitFlags, ProcessLimit;
            public long CreatedFileTime;
            public ulong ProcessCommitLimit, JobCommitLimit, RssPeakBytes, NativePeakProcessCommit, NativePeakJobCommit;
            public int Samples;
            public double DurationMs;
            public string Failure = "not-started";
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct MemoryCounters {
            public uint Size, PageFaults;
            public UIntPtr PeakWorkingSet, WorkingSet, PeakPagedPool, PagedPool, PeakNonPagedPool, NonPagedPool, Pagefile, PeakPagefile, PrivateUsage;
        }
        [DllImport("psapi.dll", SetLastError=true)] private static extern bool GetProcessMemoryInfo(SafeFileHandle process, ref MemoryCounters counters, uint size);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern uint WaitForSingleObject(SafeFileHandle process, uint timeout);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool QueryFullProcessImageNameW(SafeFileHandle process, uint flags, StringBuilder image, ref uint length);
        [DllImport("kernel32.dll", EntryPoint="QueryInformationJobObject", SetLastError=true)] private static extern bool ReadLimits(SafeFileHandle job, int type, out ExtendedLimits info, uint length, IntPtr returned);
        private static readonly System.Collections.Generic.List<SafeFileHandle> retained = new System.Collections.Generic.List<SafeFileHandle>();
        public const ulong CommitBytes = 2147483648UL;
        public const ulong RssBytes = 1073741824UL;
        [StructLayout(LayoutKind.Sequential)] private struct FileInfo {
            public uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
        }
        [StructLayout(LayoutKind.Sequential)] private struct FileBasic {public long Created,Accessed,Written,Changed;public uint Attributes;}
        [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file,out FileInfo info);
        [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle file,int kind,out FileBasic info,uint size);
        public sealed class FileFact {public string Dev,Ino,MtimeNs,CtimeNs;public long Size;public uint Links;}
        public static FileFact InspectFile(System.IO.FileStream stream) {
            if(!GetFileInformationByHandle(stream.SafeFileHandle,out FileInfo info)||!GetFileInformationByHandleEx(stream.SafeFileHandle,0,out FileBasic basic,(uint)Marshal.SizeOf<FileBasic>()))throw new Win32Exception();
            if((info.Attributes&0xE10)!=0||info.Links!=1)throw new InvalidOperationException("非独立普通文件");
            return new FileFact {Dev=info.Volume.ToString(),Ino=(((ulong)info.IndexHigh<<32)|info.IndexLow).ToString(),
                Size=checked((long)(((ulong)info.SizeHigh<<32)|info.SizeLow)),Links=info.Links,
                MtimeNs=checked((basic.Written-116444736000000000L)*100).ToString(),CtimeNs=checked((basic.Changed-116444736000000000L)*100).ToString()};
        }
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool GetDiskFreeSpaceW(string root,out uint sectors,out uint bytes,out uint free,out uint total);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool GetDiskFreeSpaceExW(string root,out ulong available,out ulong total,out ulong free);
        public sealed class Disk {public ulong AllocationUnit, AvailableBytes, RequiredBytes;}
        public static ulong Allocation(ulong bytes,ulong unit) {if(unit==0||unit>1048576)throw new InvalidOperationException("分配单位无效");return checked(((bytes+unit-1)/unit)*unit);}
        public static Disk InspectDisk(string path) {
            string root=System.IO.Path.GetPathRoot(System.IO.Path.GetFullPath(path));
            if(!GetDiskFreeSpaceW(root,out uint sectors,out uint bytes,out _,out _)||!GetDiskFreeSpaceExW(root,out ulong available,out _,out _))throw new Win32Exception();
            ulong unit=checked((ulong)sectors*bytes);
            // 50 sessions, index, bounded tool/receipts, two conservative directory slots, 1 GiB headroom.
            ulong required=checked(50*Allocation(67108864,unit)+Allocation(851968,unit)+10*Allocation(65536,unit)+1073741824);
            return new Disk {AllocationUnit=unit,AvailableBytes=available,RequiredBytes=required};
        }
        public static void ValidateLimits(uint flags, uint processes, ulong processBytes, ulong jobBytes) {
            if (flags != 0x2308 || processes != 1 || processBytes != CommitBytes || jobBytes != CommitBytes)
                throw new InvalidOperationException("Job原生限额读回不符");
        }
        public static Result Execute(string executable, string entry, string argument, string directory, string runId, int workMs) {
            if (IntPtr.Size != 8 || workMs < 1 || workMs > 150000 ||
                !System.Text.RegularExpressions.Regex.IsMatch(runId, "\\A[0-9a-f]{32}\\z"))
                throw new InvalidOperationException("固定Job参数无效");
            var result = new Result();
            var budget = Stopwatch.StartNew();
            SafeFileHandle job = CreateJobObjectW(IntPtr.Zero, Name(runId));
            int creationError=Marshal.GetLastWin32Error();
            if(job.IsInvalid || creationError==183) {job.Dispose();throw new InvalidOperationException("无法创建唯一Job");}
            SafeFileHandle process = null;
            bool assigned = false;
            try {
                var limits = new ExtendedLimits { Basic = new BasicLimits { Flags=0x2308, ActiveProcessLimit=1 }, ProcessMemory=new UIntPtr(CommitBytes), JobMemory=new UIntPtr(CommitBytes) };
                if (!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf<ExtendedLimits>())) throw new Win32Exception();
                if (!ReadLimits(job,9,out limits,(uint)Marshal.SizeOf<ExtendedLimits>(),IntPtr.Zero)) throw new Win32Exception();
                ValidateLimits(limits.Basic.Flags,limits.Basic.ActiveProcessLimit,limits.ProcessMemory.ToUInt64(),limits.JobMemory.ToUInt64());
                result.LimitsVerified=true;result.LimitFlags=limits.Basic.Flags;result.ProcessLimit=limits.Basic.ActiveProcessLimit;
                result.ProcessCommitLimit=limits.ProcessMemory.ToUInt64();result.JobCommitLimit=limits.JobMemory.ToUInt64();
                UIntPtr bytes=UIntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes);
                IntPtr attributes=Marshal.AllocHGlobal((int)bytes.ToUInt64());
                IntPtr jobs=Marshal.AllocHGlobal(IntPtr.Size);
                bool initialized=false;
                try {
                    if (!InitializeProcThreadAttributeList(attributes,1,0,ref bytes)) throw new Win32Exception();
                    initialized=true;Marshal.WriteIntPtr(jobs,job.DangerousGetHandle());
                    if (!UpdateProcThreadAttribute(attributes,0,new UIntPtr(0x2000D),jobs,new UIntPtr((uint)IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) throw new Win32Exception();
                    var startup=new StartupEx {Startup=new Startup {Size=(uint)Marshal.SizeOf<StartupEx>()},Attributes=attributes};
                    string command=String.Join(" ",new[] {executable,"--max-old-space-size=768",entry,argument}.Select(Quote));
                    if (budget.ElapsedMilliseconds >= workMs) {result.Failure="deadline";throw new InvalidOperationException();}
                    if (!CreateProcessW(executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x08080000,IntPtr.Zero,directory,ref startup,out ProcessInformation info)) throw new Win32Exception();
                    process=new SafeFileHandle(info.Process,true);assigned=true;result.Started=true;result.ProcessId=info.ProcessId;
                    using (var thread=new SafeFileHandle(info.Thread,true)) {}
                    if (!GetProcessTimes(process,out long created,out _,out _,out _) || !IsProcessInJob(process,job,out bool member) || !member) throw new Win32Exception();
                    uint length=32768;var image=new StringBuilder((int)length);
                    if (!QueryFullProcessImageNameW(process,0,image,ref length) || !String.Equals(image.ToString(),executable,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
                    result.CreatedFileTime=created;
                } finally {
                    if(initialized)DeleteProcThreadAttributeList(attributes);
                    Marshal.FreeHGlobal(attributes);Marshal.FreeHGlobal(jobs);
                }
                result.Failure=null;
                for (;;) {
                    result.ActiveAtEnd=Active(job);
                    if(result.ActiveAtEnd==0) {result.ActualZero=true;break;}
                    if(budget.ElapsedMilliseconds>=workMs) {result.Failure="deadline";break;}
                    if(WaitForSingleObject(process,0)==258) {
                        var memory=new MemoryCounters {Size=(uint)Marshal.SizeOf<MemoryCounters>()};
                        if(!GetProcessMemoryInfo(process,ref memory,memory.Size))throw new Win32Exception();
                        result.Samples++;result.RssPeakBytes=Math.Max(result.RssPeakBytes,memory.WorkingSet.ToUInt64());
                        if(result.RssPeakBytes>RssBytes) {result.Failure="rss-sample-limit";break;}
                    }
                    Thread.Sleep(100);
                }
            } catch {if(result.Failure==null||result.Failure=="not-started")result.Failure="native-failed";}
            finally {
                if (!job.IsInvalid && !result.ActualZero) {
                    bool terminated=TerminateJobObject(job,92);
                    if(!terminated && assigned && result.Failure==null)result.Failure="terminate-failed";
                    var closing=Stopwatch.StartNew();
                    do {
                        try {result.ActiveAtEnd=Active(job);if(result.ActiveAtEnd==0){result.ActualZero=true;break;}}catch {}
                        if(closing.ElapsedMilliseconds>=30000)break;
                        Thread.Sleep(50);
                    } while(true);
                }
                if(result.ActualZero) {
                    if(process!=null) {
                        if(GetExitCodeProcess(process,out uint code)&&code!=259)result.ExitCode=code;
                        else result.Failure="exit-unknown";
                    }
                    if(!job.IsInvalid && ReadLimits(job,9,out ExtendedLimits finalLimits,(uint)Marshal.SizeOf<ExtendedLimits>(),IntPtr.Zero)) {
                        result.NativePeakProcessCommit=finalLimits.PeakProcessMemory.ToUInt64();result.NativePeakJobCommit=finalLimits.PeakJobMemory.ToUInt64();
                        try {ValidateLimits(finalLimits.Basic.Flags,finalLimits.Basic.ActiveProcessLimit,finalLimits.ProcessMemory.ToUInt64(),finalLimits.JobMemory.ToUInt64());}catch {result.Failure="limits-changed";}
                    } else result.Failure="limits-unknown";
                    if(process!=null)process.Dispose();job.Dispose();
                } else {
                    result.OwnershipRetained=true;result.Failure="ownership-retained";
                    lock(retained) {retained.Add(job);if(process!=null)retained.Add(process);}
                }
                result.DurationMs=budget.Elapsed.TotalMilliseconds;
                if(result.Failure==null && result.DurationMs>=workMs)result.Failure="deadline";
                if(result.Failure==null && result.ExitCode!=0)result.Failure="exit-nonzero";
                result.Succeeded=result.Started&&result.ActualZero&&!result.OwnershipRetained&&result.Failure==null;
            }
            return result;
        }
    }
}
