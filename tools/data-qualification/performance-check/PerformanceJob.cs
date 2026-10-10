using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace AIbrowse.Performance
{
    public static class PerformanceJob
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

        private static string Name(string runId) { return "Local\\AIbrowse.Performance.Job." + runId; }

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
            public string JobId;
            public bool Started, ActualZero, LimitsVerified, OwnershipRetained, Succeeded;
            public uint ProcessId, ExitCode, ActiveAtEnd, LimitFlags, ProcessLimit, CreationFlags;
            public long CreatedFileTime;
            public ulong ProcessCommitLimit, JobCommitLimit, RssPeakBytes, TreeRssPeakBytes, NativePeakProcessCommit, NativePeakJobCommit;
            public uint RssPeakProcessId;
            public string RssPeakCreatedFileTime, RssPeakRole;
            public int RssPeakSampleAttempt;
            public int Samples;
            public double DurationMs, RootStartedElapsedMs;
            public string Failure = "not-started";
            public string FailureStage, NativeFailureType, ExitFailure, FailedSampleImage;
            public int NativeErrorCode, SampleAssigned, SampleCount;
            public uint SampleProcessId, SampleWait;
            public bool SampleListObserved;
            public int PidListExpansions, SampledIdentities;
            public PidListObservation PidListFirst, PidListLast, ExpandedPidListFirst, ExpandedPidListLast;
            public System.Collections.Generic.List<ResourcePoint> ResourcePoints = new System.Collections.Generic.List<ResourcePoint>();
        }
        public sealed class ResourcePoint { public long ElapsedMs; public ulong RssBytes, PrivateBytes, Handles; public uint Processes; }
        public sealed class PidListObservation {
            public uint Capacity, Assigned, Count, ReturnedBytes;
            public int Error;
            public bool Succeeded;
        }
        private enum NativeStage {
            Start, SetLimits, ReadLimits, ValidateLimits, AllocateAttributes, InitializeAttributes, UpdateAttributes,
            CreateRoot, RootTimes, RootMembership, RootImage, ActiveCount,
            PidListAllocate, PidListDeadline, PidListRead, PidListMembership, SamplePid, PriorHandleWait, SampleOpen,
            SampleTimes, SampleMembership, SampleHandleBudget, SampleWait, SampleCurrentTimes,
            SampleCurrentMembership, SampleActiveBudget, SampleMemory, SampleSum, Sleep
        }
        private sealed class NativeDiagnostic {
            public NativeStage Stage;
            public int Assigned, Count;
            public uint Pid, Wait;
            public bool ListObserved;
        }
        // Only fixed categories and bounded native integers cross the evidence boundary.
        private static void RecordNativeFailure(Result result, NativeDiagnostic diagnostic, Exception error) {
            if(result.Failure==null||result.Failure=="not-started")result.Failure="native-failed";
            result.FailureStage=diagnostic.Stage.ToString();
            result.NativeFailureType=error is Win32Exception ? "win32" : error is OverflowException ? "overflow" : error is InvalidOperationException ? "invariant" : "managed";
            result.NativeErrorCode=error is Win32Exception native ? native.NativeErrorCode : 0;
            result.SampleAssigned=diagnostic.Assigned;result.SampleCount=diagnostic.Count;
            result.SampleProcessId=diagnostic.Pid;result.SampleWait=diagnostic.Wait;
            result.SampleListObserved=diagnostic.ListObserved;
        }
        private static void RecordExitFailure(Result result,string failure) {
            if(result.ExitFailure==null)result.ExitFailure=failure;
            if(result.Failure==null||result.Failure=="not-started")result.Failure=failure;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct MemoryCounters {
            public uint Size, PageFaults;
            public UIntPtr PeakWorkingSet, WorkingSet, PeakPagedPool, PagedPool, PeakNonPagedPool, NonPagedPool, Pagefile, PeakPagefile, PrivateUsage;
        }
        [DllImport("psapi.dll", SetLastError=true)] private static extern bool GetProcessMemoryInfo(SafeFileHandle process, ref MemoryCounters counters, uint size);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetProcessHandleCount(SafeFileHandle process, out uint count);
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
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
        public static string DirectoryIdentity(string path) {
            using(var handle=CreateFileW(path,0,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
                if(handle.IsInvalid||!GetFileInformationByHandle(handle,out FileInfo info)||(info.Attributes&0x400)!=0||(info.Attributes&0x10)==0)throw new Win32Exception();
                return info.Volume.ToString()+":"+(((ulong)info.IndexHigh<<32)|info.IndexLow).ToString();
            }
        }
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
            Allocation(0,unit);
            return new Disk {AllocationUnit=unit,AvailableBytes=available,RequiredBytes=0};
        }
        private static uint ModeProcesses(string mode) {
            if(mode=="import")return 1;
            if(mode=="transfer"||mode=="performance")return 24;
            if(mode=="filename")return 4;
            throw new InvalidOperationException("固定Job模式无效");
        }
        public static void ValidateLimits(string mode, uint flags, uint processes, ulong processBytes, ulong jobBytes) {
            if (flags != 0x2308 || processes != ModeProcesses(mode) || processBytes != CommitBytes || jobBytes != (mode == "import" ? CommitBytes : 2 * CommitBytes))
                throw new InvalidOperationException("Job原生限额读回不符");
        }

        private sealed class Sampled { public SafeFileHandle Handle; public long Created; }
        // This bounded diagnostic never changes the failure, member count, or ownership gate.
        private static string FailedImage(Sampled sample,uint pid,SafeFileHandle job,Result result,Stopwatch budget,int workMs) {
            try {
                if(budget.ElapsedMilliseconds>=workMs)return "unknown";
                uint length=32768;var image=new StringBuilder((int)length);
                if(!QueryFullProcessImageNameW(sample.Handle,0,image,ref length)||length==0||length>=32768||image.Length!=length)return "unknown";
                if(!GetProcessTimes(sample.Handle,out long created,out _,out _,out _)||created!=sample.Created||
                    !IsProcessInJob(sample.Handle,job,out bool member)||!member||budget.ElapsedMilliseconds>=workMs)return "unknown";
                if(pid==result.ProcessId)return created==result.CreatedFileTime?"root":"unknown";
                string system=Environment.SystemDirectory;
                if(String.IsNullOrEmpty(system))return "unknown";
                return String.Equals(image.ToString(),System.IO.Path.Combine(system,"conhost.exe"),StringComparison.OrdinalIgnoreCase)?"system-console-host":"other";
            } catch {return "unknown";}
        }
        [DllImport("kernel32.dll", EntryPoint="QueryInformationJobObject", SetLastError=true)]
        private static extern bool ReadPids(SafeFileHandle job,int kind,IntPtr buffer,uint size,out uint returned);
        private static void CheckSampleTime(Result result,NativeDiagnostic diagnostic,Stopwatch budget,int workMs) {
            diagnostic.Stage=NativeStage.PidListDeadline;
            if(budget.ElapsedMilliseconds>=workMs) {result.Failure="deadline";throw new InvalidOperationException("采样已超过原工作期限");}
        }
        private static ulong SampleJob(SafeFileHandle job,System.Collections.Generic.Dictionary<uint,Sampled> held,Result result,NativeDiagnostic diagnostic,Stopwatch budget,int workMs,ref long nextResourceMs) {
            diagnostic.ListObserved=false;diagnostic.Assigned=0;diagnostic.Count=0;diagnostic.Pid=0;diagnostic.Wait=0;
            result.PidListFirst=null;result.PidListLast=null;
            CheckSampleTime(result,diagnostic,budget,workMs);
            diagnostic.Stage=NativeStage.PidListAllocate;
            const int maximumBytes=8+128*8;
            IntPtr buffer=Marshal.AllocHGlobal(maximumBytes);
            try {
                int count=0;
                for(int attempt=0;attempt<2;attempt++) {
                    CheckSampleTime(result,diagnostic,budget,workMs);
                    uint capacity=attempt==0?32u:128u,bytes=8+capacity*8;
                    // Failed-call bytes are diagnostics only. Never trust them as a member list.
                    Marshal.Copy(new byte[maximumBytes],0,buffer,maximumBytes);
                    diagnostic.Stage=NativeStage.PidListRead;
                    bool success=ReadPids(job,3,buffer,bytes,out uint returned);
                    int error=success?0:Marshal.GetLastWin32Error();
                    var observation=new PidListObservation {Capacity=capacity,Assigned=unchecked((uint)Marshal.ReadInt32(buffer,0)),
                        Count=unchecked((uint)Marshal.ReadInt32(buffer,4)),ReturnedBytes=returned,Error=error,Succeeded=success};
                    if(attempt==0)result.PidListFirst=observation;
                    result.PidListLast=observation;
                    diagnostic.Assigned=unchecked((int)observation.Assigned);diagnostic.Count=unchecked((int)observation.Count);diagnostic.ListObserved=success;
                    if(attempt==1)result.ExpandedPidListLast=observation;
                    if(!success) {
                        if(error==234&&attempt==0) {
                            result.PidListExpansions++;result.ExpandedPidListFirst=observation;result.ExpandedPidListLast=null;
                            continue;
                        }
                        throw new Win32Exception(error);
                    }
                    diagnostic.Stage=NativeStage.PidListMembership;
                    if(observation.Count>capacity||observation.Assigned!=observation.Count||returned>bytes||returned<8+observation.Count*8)
                        throw new InvalidOperationException("Job成员集合不完整或无效");
                    count=checked((int)observation.Count);
                    break;
                }
                // Validate the entire list before opening even the first process.
                var pids=new uint[count];var unique=new System.Collections.Generic.HashSet<uint>();
                for(int i=0;i<count;i++) {
                    diagnostic.Stage=NativeStage.SamplePid;
                    uint pid=checked((uint)Marshal.ReadInt64(buffer,8+i*8));
                    if(pid==0||!unique.Add(pid))throw new InvalidOperationException("Job成员身份重复或无效");
                    pids[i]=pid;
                }
                ulong tree=0,privateBytes=0,handles=0;uint activeCandidates=0;
                foreach(uint pid in pids) {
                    CheckSampleTime(result,diagnostic,budget,workMs);
                    diagnostic.Pid=pid;diagnostic.Wait=0;
                    Sampled sample;
                    diagnostic.Stage=NativeStage.PriorHandleWait;
                    bool known=held.TryGetValue(pid,out sample);
                    uint priorWait=known?WaitForSingleObject(sample.Handle,0):0;
                    diagnostic.Wait=priorWait;
                    if(known&&priorWait!=0&&priorWait!=258)throw new Win32Exception(Marshal.GetLastWin32Error());
                    if(!known||priorWait==0) {
                        // Never sample an unverified PID. A transient open failure rejects this run.
                        diagnostic.Stage=NativeStage.SampleOpen;
                        var handle=OpenProcess(0x1010|0x100000,false,pid);
                        try {
                            if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
                            diagnostic.Stage=NativeStage.SampleTimes;
                            if(!GetProcessTimes(handle,out long created,out _,out _,out _))throw new Win32Exception(Marshal.GetLastWin32Error());
                            diagnostic.Stage=NativeStage.SampleMembership;
                            if(!IsProcessInJob(handle,job,out bool member))throw new Win32Exception(Marshal.GetLastWin32Error());
                            if(!member)throw new InvalidOperationException();
                            diagnostic.Stage=NativeStage.SampleHandleBudget;
                            if(result.SampledIdentities>=128)throw new InvalidOperationException("采样身份预算超限");
                            if(sample!=null)sample.Handle.Dispose();
                            sample=new Sampled {Handle=handle,Created=created};held[pid]=sample;handle=null;result.SampledIdentities++;
                        } finally {if(handle!=null)handle.Dispose();}
                    }
                    diagnostic.Stage=NativeStage.SampleWait;
                    uint wait=WaitForSingleObject(sample.Handle,0);diagnostic.Wait=wait;
                    if(wait!=0&&wait!=258)throw new Win32Exception(Marshal.GetLastWin32Error());
                    diagnostic.Stage=NativeStage.SampleCurrentTimes;
                    if(!GetProcessTimes(sample.Handle,out long current,out _,out _,out _))throw new Win32Exception(Marshal.GetLastWin32Error());
                    if(current!=sample.Created)throw new InvalidOperationException();
                    diagnostic.Stage=NativeStage.SampleCurrentMembership;
                    if(!IsProcessInJob(sample.Handle,job,out bool still))throw new Win32Exception(Marshal.GetLastWin32Error());
                    if(!still)throw new InvalidOperationException();
                    if(wait==0) {
                        // A proven exited identity needs no held reference; rejected processes can otherwise remain accounted.
                        sample.Handle.Dispose();held.Remove(pid);continue;
                    }
                    diagnostic.Stage=NativeStage.SampleActiveBudget;
                    if(++activeCandidates>result.ProcessLimit) {
                        result.FailedSampleImage=FailedImage(sample,pid,job,result,budget,workMs);
                        throw new InvalidOperationException("采样活成员超过原进程限额");
                    }
                    diagnostic.Stage=NativeStage.SampleMemory;
                    var memory=new MemoryCounters {Size=(uint)Marshal.SizeOf<MemoryCounters>()};
                    if(!GetProcessMemoryInfo(sample.Handle,ref memory,memory.Size))throw new Win32Exception(Marshal.GetLastWin32Error());
                    ulong rss=memory.WorkingSet.ToUInt64();
                    privateBytes=checked(privateBytes+memory.PrivateUsage.ToUInt64());
                    if(!GetProcessHandleCount(sample.Handle,out uint handleCount))throw new Win32Exception(Marshal.GetLastWin32Error());
                    handles=checked(handles+handleCount);
                    if(rss>result.RssPeakBytes) {
                        result.RssPeakBytes=rss;
                        result.RssPeakProcessId=pid;
                        result.RssPeakCreatedFileTime=sample.Created.ToString(System.Globalization.CultureInfo.InvariantCulture);
                        result.RssPeakRole=pid==result.ProcessId&&sample.Created==result.CreatedFileTime?"root":"other";
                        result.RssPeakSampleAttempt=result.Samples+1;
                    }
                    diagnostic.Stage=NativeStage.SampleSum;
                    tree=checked(tree+memory.WorkingSet.ToUInt64());
                }
                if(budget.ElapsedMilliseconds>=nextResourceMs) {
                    if(result.ResourcePoints.Count>=751)throw new InvalidOperationException("资源时点预算超限");
                    result.ResourcePoints.Add(new ResourcePoint {ElapsedMs=budget.ElapsedMilliseconds,RssBytes=tree,PrivateBytes=privateBytes,Handles=handles,Processes=activeCandidates});
                    do {nextResourceMs=checked(nextResourceMs+10000);} while(nextResourceMs<=budget.ElapsedMilliseconds);
                }
                CheckSampleTime(result,diagnostic,budget,workMs);
                result.Samples++;return tree;
            } finally {Marshal.FreeHGlobal(buffer);}
        }
        public static Result Execute(string mode, string executable, string entry, string argument, string directory, string runId, int workMs) {
            uint modeProcesses=ModeProcesses(mode);
            if (IntPtr.Size != 8 || workMs < 1 || workMs > (mode == "performance" ? 7500000 : mode == "transfer" ? 3060000 : 120000) ||
                !System.Text.RegularExpressions.Regex.IsMatch(runId, "\\A[0-9a-f]{32}\\z"))
                throw new InvalidOperationException("固定Job参数无效");
            var result = new Result { JobId=runId };
            var budget = Stopwatch.StartNew();
            SafeFileHandle job = CreateJobObjectW(IntPtr.Zero, Name(runId));
            int creationError=Marshal.GetLastWin32Error();
            if(job.IsInvalid || creationError==183) {job.Dispose();throw new InvalidOperationException("无法创建唯一Job");}
            SafeFileHandle process = null;
            bool assigned = false; var sampled = new System.Collections.Generic.Dictionary<uint, Sampled>();
            var diagnostic=new NativeDiagnostic();
            try {
                var limits = new ExtendedLimits { Basic = new BasicLimits { Flags=0x2308, ActiveProcessLimit=modeProcesses }, ProcessMemory=new UIntPtr(CommitBytes), JobMemory=new UIntPtr(mode == "import" ? CommitBytes : 2 * CommitBytes) };
                diagnostic.Stage=NativeStage.SetLimits;
                if (!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf<ExtendedLimits>())) throw new Win32Exception(Marshal.GetLastWin32Error());
                diagnostic.Stage=NativeStage.ReadLimits;
                if (!ReadLimits(job,9,out limits,(uint)Marshal.SizeOf<ExtendedLimits>(),IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
                diagnostic.Stage=NativeStage.ValidateLimits;
                ValidateLimits(mode,limits.Basic.Flags,limits.Basic.ActiveProcessLimit,limits.ProcessMemory.ToUInt64(),limits.JobMemory.ToUInt64());
                result.LimitsVerified=true;result.LimitFlags=limits.Basic.Flags;result.ProcessLimit=limits.Basic.ActiveProcessLimit;
                result.ProcessCommitLimit=limits.ProcessMemory.ToUInt64();result.JobCommitLimit=limits.JobMemory.ToUInt64();
                UIntPtr bytes=UIntPtr.Zero;
                diagnostic.Stage=NativeStage.AllocateAttributes;
                InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes);
                IntPtr attributes=Marshal.AllocHGlobal((int)bytes.ToUInt64());
                IntPtr jobs=Marshal.AllocHGlobal(IntPtr.Size);
                bool initialized=false;
                try {
                    diagnostic.Stage=NativeStage.InitializeAttributes;
                    if (!InitializeProcThreadAttributeList(attributes,1,0,ref bytes)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    initialized=true;Marshal.WriteIntPtr(jobs,job.DangerousGetHandle());
                    diagnostic.Stage=NativeStage.UpdateAttributes;
                    if (!UpdateProcThreadAttribute(attributes,0,new UIntPtr(0x2000D),jobs,new UIntPtr((uint)IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    var startup=new StartupEx {Startup=new Startup {Size=(uint)Marshal.SizeOf<StartupEx>()},Attributes=attributes};
                    string command=String.Join(" ",(mode == "import" ? new[] {executable,"--max-old-space-size=768",entry,argument} : new[] {executable,entry,argument}).Select(Quote));
                    if (budget.ElapsedMilliseconds >= workMs) {result.Failure="deadline";throw new InvalidOperationException();}
                    diagnostic.Stage=NativeStage.CreateRoot;
                    uint creationFlags=mode=="import"?0x00080008u:0x08080000u;
                    result.CreationFlags=creationFlags;
                    if (!CreateProcessW(executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,creationFlags,IntPtr.Zero,directory,ref startup,out ProcessInformation info)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    result.RootStartedElapsedMs=budget.Elapsed.TotalMilliseconds;
                    process=new SafeFileHandle(info.Process,true);assigned=true;result.Started=true;result.ProcessId=info.ProcessId;
                    using (var thread=new SafeFileHandle(info.Thread,true)) {}
                    diagnostic.Stage=NativeStage.RootTimes;
                    if (!GetProcessTimes(process,out long created,out _,out _,out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    diagnostic.Stage=NativeStage.RootMembership;
                    if (!IsProcessInJob(process,job,out bool member)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    if (!member) throw new InvalidOperationException();
                    uint length=32768;var image=new StringBuilder((int)length);
                    diagnostic.Stage=NativeStage.RootImage;
                    if (!QueryFullProcessImageNameW(process,0,image,ref length)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    if (!String.Equals(image.ToString(),executable,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
                    result.CreatedFileTime=created;
                } finally {
                    if(initialized)DeleteProcThreadAttributeList(attributes);
                    Marshal.FreeHGlobal(attributes);Marshal.FreeHGlobal(jobs);
                }
                result.Failure=null;
                long nextResourceMs=0;
                for (;;) {
                    diagnostic.Stage=NativeStage.ActiveCount;
                    result.ActiveAtEnd=Active(job);
                    if(result.ActiveAtEnd==0) {result.ActualZero=true;break;}
                    if(budget.ElapsedMilliseconds>=workMs) {result.Failure="deadline";break;}
                    ulong tree=SampleJob(job, sampled, result,diagnostic,budget,workMs,ref nextResourceMs);
                    result.TreeRssPeakBytes=Math.Max(result.TreeRssPeakBytes,tree);
                    if(result.RssPeakBytes>RssBytes || tree>(mode == "import" ? RssBytes : 2*RssBytes)) {result.Failure="rss-sample-limit";break;}
                    diagnostic.Stage=NativeStage.Sleep;Thread.Sleep(100);
                }
            } catch(Exception error) {RecordNativeFailure(result,diagnostic,error);}
            finally {
                Stopwatch closing=null;
                if (!job.IsInvalid && !result.ActualZero) {
                    // Termination and both exit proofs share this one deadline, including native-call latency.
                    closing=Stopwatch.StartNew();
                    bool terminated=TerminateJobObject(job,92);
                    if(!terminated && assigned)RecordExitFailure(result,"terminate-failed");
                    while(closing.ElapsedMilliseconds<30000) {
                        try {
                            result.ActiveAtEnd=Active(job);
                            if(closing.ElapsedMilliseconds>=30000)break;
                            if(result.ActiveAtEnd==0){result.ActualZero=true;break;}
                        }catch {}
                        long left=30000-closing.ElapsedMilliseconds;
                        if(left<=0)break;
                        Thread.Sleep((int)Math.Min(50,left));
                    }
                    if(!result.ActualZero)RecordExitFailure(result,"job-exit-unknown");
                }
                if(result.ActualZero && process!=null) {
                    uint left=(uint)Math.Max(0,closing==null?Math.Min(10000,workMs-budget.ElapsedMilliseconds):30000-closing.ElapsedMilliseconds);
                    if(closing!=null&&left==0) {result.ActualZero=false;RecordExitFailure(result,"exit-deadline");}
                    else if(WaitForSingleObject(process,left)!=0) {result.ActualZero=false;RecordExitFailure(result,"exact-process-exit-unknown");}
                    else if(closing!=null&&closing.ElapsedMilliseconds>=30000) {result.ActualZero=false;RecordExitFailure(result,"exit-deadline");}
                }
                if(result.ActualZero) {
                    if(process!=null) {
                        if(GetExitCodeProcess(process,out uint code)&&code!=259)result.ExitCode=code;
                        else RecordExitFailure(result,"exit-unknown");
                    }
                    if(!job.IsInvalid && ReadLimits(job,9,out ExtendedLimits finalLimits,(uint)Marshal.SizeOf<ExtendedLimits>(),IntPtr.Zero)) {
                        result.NativePeakProcessCommit=finalLimits.PeakProcessMemory.ToUInt64();result.NativePeakJobCommit=finalLimits.PeakJobMemory.ToUInt64();
                        try {ValidateLimits(mode,finalLimits.Basic.Flags,finalLimits.Basic.ActiveProcessLimit,finalLimits.ProcessMemory.ToUInt64(),finalLimits.JobMemory.ToUInt64());}catch {result.LimitsVerified=false;RecordExitFailure(result,"limits-changed");}
                    } else {result.LimitsVerified=false;RecordExitFailure(result,"limits-unknown");}
                    foreach(var item in sampled.Values)item.Handle.Dispose(); if(process!=null)process.Dispose();job.Dispose();
                } else {
                    result.OwnershipRetained=true;RecordExitFailure(result,"ownership-retained");
                    lock(retained) {retained.Add(job);if(process!=null)retained.Add(process);foreach(var item in sampled.Values)retained.Add(item.Handle);}
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
