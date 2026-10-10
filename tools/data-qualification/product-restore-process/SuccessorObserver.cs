using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

// Read-only observer. The release-profile owner retains termination and scope ownership.
public sealed class RestoreSuccessorObserver : IDisposable
{
    [StructLayout(LayoutKind.Sequential)] private struct Basic { public long ProcessTime, JobTime; public uint Flags; public UIntPtr Min, Max; public uint Limit; public UIntPtr Affinity; public uint Priority, Scheduling; }
    [StructLayout(LayoutKind.Sequential)] private struct Limits { public Basic Basic; public ulong R, W, O, RB, WB, OB; public UIntPtr PM, JM, PPM, PJM; }
    [StructLayout(LayoutKind.Sequential, Pack=4)] private struct FileFacts { public uint Attributes; public long Created, Accessed, Written; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] private struct Entry { public uint Size, Usage, Pid; public UIntPtr Heap; public uint Module, Threads, Parent; public int Priority; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string Exe; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern SafeFileHandle OpenJobObjectW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, IntPtr data, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern SafeFileHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool IsProcessInJob(SafeFileHandle process, SafeFileHandle job, out bool member);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint GetProcessId(SafeFileHandle process);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetProcessTimes(SafeFileHandle process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint WaitForSingleObject(SafeFileHandle process, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetExitCodeProcess(SafeFileHandle process, out uint code);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool QueryFullProcessImageNameW(SafeFileHandle process, uint flags, StringBuilder image, ref uint length);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool Process32FirstW(SafeFileHandle snapshot, ref Entry entry);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool Process32NextW(SafeFileHandle snapshot, ref Entry entry);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileFacts facts);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, byte[] facts, uint size);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);

    public sealed class Cim { public uint Pid; public string Created, Image, Command; }
    private sealed class Held : IDisposable
    {
        public SafeFileHandle Handle;
        public uint Pid, Parent;
        public string Created, Image, ImageIdentity, Role, Session;
        public string Exited;
        public uint? Code;
        public bool Signaled, Writer;
        public long ObservedNotAfterMs;
        public object Facts() { return new { pid=Pid, created=Created, image=Image, imageIdentity=ImageIdentity, parentPid=Parent, role=Role, session=Session, registeredWriter=Writer, signaled=Signaled, exitCode=Code, exitFileTime=Exited }; }
        public void Dispose() { if(Handle!=null) Handle.Dispose(); }
    }
    private sealed class LedgerWriter { public uint Pid; public string Created, Image, Role; }
    private sealed class Ledger { public string Root, Session, Sha; public LedgerWriter Main, Utility; public object Projection; }
    private readonly List<Held> held = new List<Held>();
    private readonly HashSet<string> utilitySeen = new HashSet<string>();
    private readonly List<object> uncaptured = new List<object>();
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly UTF8Encoding utf8 = new UTF8Encoding(false, true);
    private SafeFileHandle job;
    private readonly string run, scene, journal, root, declared, executable, guardian, output, exeSha, guardianSha, bindingSha;
    private readonly string fileId128, volume64, rootHash, manifestSha, markerSha, exeIdentity, guardianIdentity;
    private readonly long budget;
    private readonly uint runner;
    private string runnerImage, helperImage;
    private Held current, currentGuardian, old, oldGuardian, next, nextGuardian;
    private Ledger ledger;
    private string oldSession, state="ready", firstFailure, approvalSha;
    private int transition, sequence, action, recordCount;
    private long recordBytes, nextSeen=-1;
    // The previous complete sample started before a newly discovered successor
    // could have appeared in its Job snapshot. Zero is the initial session bound.
    private long previousCompleteSampleStart;
    private bool disposed, approved, cancelled, finished;
    private readonly Queue<string> frames = new Queue<string>();
    private int[] counts = new int[5];
    private string lastLedgerSha;
    private string lastSampleSha;
    private readonly HashSet<Held> retired = new HashSet<Held>();

    private sealed class ObservationFailure : Exception { public ObservationFailure(string code):base(code) {} }
    private static void Need(bool value, string code) { if(!value) throw new ObservationFailure(code); }
    private static string Hash(byte[] bytes) { return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(); }
    private static bool Hex(string value, int length) { return value!=null && Regex.IsMatch(value,"\\A[a-f0-9]{"+length+"}\\z",RegexOptions.CultureInvariant); }
    private static string Text(JsonElement value, string key) { return value.GetProperty(key).GetString(); }
    private static void Fields(JsonElement value, params string[] names)
    {
        Need(value.ValueKind==JsonValueKind.Object,"schema");
        string[] keys=value.EnumerateObject().Select(p=>p.Name).ToArray();
        Need(keys.Length==names.Length && keys.Distinct().Count()==keys.Length && keys.All(names.Contains),"schema");
    }
    private static long Time(string value) { long n; Need(value!=null && Regex.IsMatch(value,"\\A[1-9][0-9]{0,18}\\z") && Int64.TryParse(value,out n),"time"); return Int64.Parse(value); }
    private static void NoReparse(string path)
    {
        string cursor=Path.GetFullPath(path);
        while(!String.IsNullOrEmpty(cursor)) { Need((File.GetAttributes(cursor)&FileAttributes.ReparsePoint)==0,"reparse"); cursor=Path.GetDirectoryName(cursor); }
    }
    private static FileFacts Facts(SafeFileHandle handle, bool directory)
    {
        FileFacts f=new FileFacts(); Need(!handle.IsInvalid && GetFileInformationByHandle(handle,out f),"file-api");
        Need((f.Attributes&0x400)==0 && ((f.Attributes&0x10)!=0)==directory && (directory || f.Links==1),"file-kind"); return f;
    }
    private static bool Same(FileFacts a, FileFacts b) { return a.Volume==b.Volume && a.IndexHigh==b.IndexHigh && a.IndexLow==b.IndexLow && a.SizeHigh==b.SizeHigh && a.SizeLow==b.SizeLow && a.Written==b.Written; }
    private byte[] Read(string path, int max)
    {
        NoReparse(path);
        using(var h=CreateFileW(path,0x80000000,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero))
        using(var stream=new FileStream(h,FileAccess.Read)) {
            FileFacts before=Facts(h,false); Need(stream.Length>0 && stream.Length<=max,"file-budget");
            byte[] bytes=new byte[(int)stream.Length]; stream.ReadExactly(bytes); Need(stream.ReadByte()==-1 && Same(before,Facts(h,false)),"file-changed"); return bytes;
        }
    }
    private string ImageIdentity(string path)
    {
        NoReparse(path);
        using(var h=CreateFileW(path,0x80000000,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) {
            FileFacts f=Facts(h,false);
            return Hash(utf8.GetBytes(Path.GetFullPath(path).ToUpperInvariant()+"|"+f.Volume+"|"+f.IndexHigh+"|"+f.IndexLow+"|"+f.SizeHigh+"|"+f.SizeLow+"|"+f.Written));
        }
    }
    private string Root(string path, bool expected)
    {
        NoReparse(path);
        using(var h=CreateFileW(path,0,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
            FileFacts f=Facts(h,true); byte[] id=new byte[24]; Need(GetFileInformationByHandleEx(h,18,id,24),"root-api");
            string volume=BitConverter.ToUInt64(id,0).ToString("x16"), file=Convert.ToHexString(id,8,16).ToLowerInvariant();
            if(expected) Need(file==fileId128 && volume==volume64,"root-identity");
            return Hash(utf8.GetBytes(Path.GetFullPath(path).ToUpperInvariant()+"|"+f.Volume+"|"+f.IndexHigh+"|"+f.IndexLow));
        }
    }
    private void CheckScope(bool hashes)
    {
        Deadline(); Need(Hash(Read(Path.Combine(journal,"manifest.json"),32768))==manifestSha,"manifest-changed");
        Need(Root(root,true)==rootHash,"root-changed"); Root(declared,true);
        Need(Hash(Read(Path.Combine(root,".aibrowse-e1-synthetic-owner.json"),4096))==markerSha,"owner-changed");
        Need(ImageIdentity(executable)==exeIdentity && ImageIdentity(guardian)==guardianIdentity,"image-changed");
        if(hashes) Need(BinaryHash(executable,512*1024*1024)==exeSha && BinaryHash(guardian,4*1024*1024)==guardianSha,"binary-changed");
        Deadline();
    }
    private string BinaryHash(string path,long maximum)
    {
        NoReparse(path);
        using(var h=CreateFileW(path,0x80000000,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero))
        using(var stream=new FileStream(h,FileAccess.Read)) {
            FileFacts before=Facts(h,false); Need(stream.Length>0&&stream.Length<=maximum,"binary-budget");
            string hash=Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
            Need(Same(before,Facts(h,false)),"binary-changed"); return hash;
        }
    }
    private void Deadline() { Need(!disposed && clock.ElapsedMilliseconds<budget && (nextSeen<0 || clock.ElapsedMilliseconds-nextSeen<60000),"deadline"); }

    public RestoreSuccessorObserver(string configuration, Func<uint,Cim> inspect, long helperStartupMilliseconds)
    {
        try {
            Need(Encoding.UTF8.GetByteCount(configuration)<=4096,"frame-budget");
            using(var doc=JsonDocument.Parse(configuration)) {
                JsonElement c=doc.RootElement;
                Fields(c,"version","runId","scene","journal","runnerPid","initial","remainingMs","executableSha256","guardianSha256","bindingSha256");
                Need(c.GetProperty("version").GetInt32()==1,"version");
                run=Text(c,"runId"); scene=Text(c,"scene"); journal=Path.GetFullPath(Text(c,"journal"));
                Need(Hex(run,32) && (scene=="R" || scene=="P") && Path.GetFileName(journal)=="journal-"+run,"scope");
                runner=c.GetProperty("runnerPid").GetUInt32(); Need(helperStartupMilliseconds>=0,"startup-time"); budget=c.GetProperty("remainingMs").GetInt64()-helperStartupMilliseconds;
                Need(runner>0 && budget>0 && budget<=3600000,"budget");
                exeSha=Text(c,"executableSha256"); guardianSha=Text(c,"guardianSha256"); bindingSha=Text(c,"bindingSha256");
                Need(Hex(exeSha,64)&&Hex(guardianSha,64)&&Hex(bindingSha,64),"binding");
                byte[] manifest=Read(Path.Combine(journal,"manifest.json"),32768); manifestSha=Hash(manifest);
                using(var m=JsonDocument.Parse(manifest)) {
                    var v=m.RootElement;
                    Fields(v,"Version","RunId","DeclaredProfile","ResolvedProfile","PackageExecutable","BindingJournal","RootIdentity");
                    Need(v.GetProperty("Version").GetInt32()==2 && Text(v,"RunId")==run,"manifest");
                    root=Text(v,"ResolvedProfile"); declared=Text(v,"DeclaredProfile"); executable=Text(v,"PackageExecutable");
                    Need(Path.GetFullPath(root)==root && Path.GetFullPath(declared)==declared && Path.GetFullPath(executable)==executable && String.Equals(Path.GetFileName(executable),"AIbrowse.exe",StringComparison.OrdinalIgnoreCase),"paths");
                    var id=v.GetProperty("RootIdentity"); Fields(id,"Requested","FinalDos","FinalGuid","FinalNt","VolumeSerial64","FileId128","Sddl","FileSystem","Attributes"); fileId128=Text(id,"FileId128").ToLowerInvariant(); volume64=Text(id,"VolumeSerial64").ToLowerInvariant();
                    Need(Hex(fileId128,32)&&Hex(volume64,16),"root-schema");
                }
                guardian=Path.Combine(Path.GetDirectoryName(executable),"resources","lifecycle-guardian","guardian.exe");
                output=Path.Combine(journal,"runner-output","restore-process-"+scene);
                Need(!Directory.Exists(output),"evidence-exists"); Directory.CreateDirectory(output);
                rootHash=Root(root,true); Root(declared,true);
                byte[] marker=Read(Path.Combine(root,".aibrowse-e1-synthetic-owner.json"),4096); markerSha=Hash(marker);
                using(var markerDoc=JsonDocument.Parse(marker)) {
                    var m=markerDoc.RootElement; Fields(m,"version","runId","fileId128","volumeSerial64"); Need(m.GetProperty("version").GetInt32()==1 && Text(m,"runId")==run && Text(m,"fileId128").ToLowerInvariant()==fileId128 && Text(m,"volumeSerial64").ToLowerInvariant()==volume64,"owner");
                }
                exeIdentity=ImageIdentity(executable); guardianIdentity=ImageIdentity(guardian); CheckScope(true);
                job=OpenJobObjectW(4,false,"Local\\AIbrowse.ReleaseProfile.Job."+run); Need(!job.IsInvalid,"job-open");
                JsonElement initial=c.GetProperty("initial"); Fields(initial,"pid","created","image");
                current=Capture(initial.GetProperty("pid").GetUInt32(),inspect);
                Need(current!=null && current.Role=="main" && current.Created==Text(initial,"created") && String.Equals(current.Image,Text(initial,"image"),StringComparison.OrdinalIgnoreCase),"initial");
                // Both tools must already belong to the audited outer Job.
                Held r=Capture(runner,inspect), h=Capture((uint)Environment.ProcessId,inspect);
                Need(r!=null && h!=null,"tools"); runnerImage=r.Image; helperImage=h.Image;
                Scan(inspect); ledger=ReadLedger(); currentGuardian=FindGuardian(current,ledger.Session);
                Need(currentGuardian!=null && Matches(ledger.Main,current),"initial-ledger");
                CaptureUtility(ledger,inspect); Emit("ready",null);
            }
        } catch { Dispose(); throw; }
    }
    private static string[] Arguments(string command)
    {
        Need(!String.IsNullOrEmpty(command) && command.Length<=32768,"command"); int count; IntPtr p=CommandLineToArgvW(command,out count); Need(p!=IntPtr.Zero,"command-api");
        try { Need(count>0 && count<=128,"command-count"); string[] values=new string[count]; for(int i=0;i<count;i++) values[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size)); return values; } finally { LocalFree(p); }
    }
    public static void ValidateCim(uint pid,string created,string image,Cim cim)
    {
        Need(cim!=null && pid==cim.Pid && Time(created)/10==Time(cim.Created)/10 && String.Equals(image,cim.Image,StringComparison.OrdinalIgnoreCase),"cim-identity");
    }
    public static void ValidateRoles(int main,int guardians,int chromium,int utilities,int tools,bool exactGuardianPair)
    {
        Need(main>=0&&main<=1&&guardians>=0&&guardians<=2&&chromium>=0&&chromium<=16&&utilities>=0&&utilities<=2&&tools>=0&&tools<=4&&main+guardians+chromium+utilities+tools<=24,"role-budget");
        Need(guardians<2||exactGuardianPair,"guardian-overlap");
    }
    private uint Parent(uint pid)
    {
        using(var s=CreateToolhelp32Snapshot(2,0)) {
            Need(!s.IsInvalid,"parent-api"); Entry e=new Entry { Size=(uint)Marshal.SizeOf<Entry>() }; bool more=Process32FirstW(s,ref e); int count=0;
            while(more && count++<65536) { Deadline(); if(e.Pid==pid)return e.Parent; more=Process32NextW(s,ref e); }
            throw new InvalidOperationException("parent-missing");
        }
    }
    private Held Capture(uint pid,Func<uint,Cim> inspect)
    {
        // A held process object prevents PID reuse; never replace its handle by PID.
        Held existing=held.SingleOrDefault(p=>p.Pid==pid);
        if(existing!=null) { Refresh(existing); return existing; }
        // Freeze before OpenProcess, parent lookup or CIM can block. Classification
        // may identify the role later, but it never grants a fresh boot allowance.
        long observedNotAfter=previousCompleteSampleStart;
        Need(held.Count<128,"held-budget"); var handle=OpenProcess(0x101000,false,pid);
        if(handle.IsInvalid) { int error=Marshal.GetLastWin32Error(); handle.Dispose(); Need(error==87,"process-open"); return null; }
        try {
            long created=0,exited,kernel,user; bool member;
            Need(GetProcessId(handle)==pid && GetProcessTimes(handle,out created,out exited,out kernel,out user) && IsProcessInJob(handle,job,out member)&&member,"process-identity");
            if(WaitForSingleObject(handle,0)==0)return null;
            uint length=32768; var image=new StringBuilder((int)length); Need(QueryFullProcessImageNameW(handle,0,image,ref length),"image-api");
            Held p=new Held {Handle=handle,Pid=pid,Created=created.ToString(),Image=image.ToString(),ObservedNotAfterMs=observedNotAfter};
            p.Parent=Parent(pid);
            Cim cim=inspect(pid); ValidateCim(pid,p.Created,p.Image,cim); string[] args=Arguments(cim.Command);
            if(String.Equals(p.Image,guardian,StringComparison.OrdinalIgnoreCase)) {
                Need(String.Equals(args[0],p.Image,StringComparison.OrdinalIgnoreCase),"command-image");
                Need(args.Length==6 && args[1]==root && args[2]==p.Parent.ToString() && Hex(args[3],32) && String.Equals(args[4],executable,StringComparison.OrdinalIgnoreCase) && args[5]=="","guardian-arguments");
                p.Role="guardian"; p.Session=args[3]; p.ImageIdentity=guardianIdentity;
            } else if(String.Equals(p.Image,executable,StringComparison.OrdinalIgnoreCase)) {
                Need(String.Equals(args[0],p.Image,StringComparison.OrdinalIgnoreCase),"command-image");
                string[] types=args.Where(v=>v.StartsWith("--type=",StringComparison.Ordinal)).ToArray(); Need(types.Length<=1,"role");
                if(types.Length==0) { Need(args.Length==1 || (current==null && args.Length==2 && args[1]=="--force-renderer-accessibility"),"main-arguments"); p.Role="main"; }
                else if(types[0]=="--type=utility")p.Role="utility";
                else { Need(new[]{"--type=renderer","--type=gpu-process","--type=crashpad-handler"}.Contains(types[0]),"role"); p.Role="chromium"; }
                p.ImageIdentity=exeIdentity;
            } else {
                Need(pid==runner || pid==(uint)Environment.ProcessId || String.Equals(p.Image,runnerImage,StringComparison.OrdinalIgnoreCase) || String.Equals(p.Image,helperImage,StringComparison.OrdinalIgnoreCase) || String.Equals(p.Image,Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"conhost.exe"),StringComparison.OrdinalIgnoreCase),"unknown-image");
                p.Role="tool"; p.ImageIdentity=ImageIdentity(p.Image);
            }
            BindSuccessorDeadline(p); Refresh(p); Deadline(); Need(!p.Signaled,"candidate-exited"); held.Add(p); handle=null; Record("held",p.Facts()); return p;
        } finally { if(handle!=null)handle.Dispose(); }
    }
    private void BindSuccessorDeadline(Held p)
    {
        if(old==null || p.Role!="main" || p==current || retired.Contains(p))return;
        Need(p.ObservedNotAfterMs>=0 && p.ObservedNotAfterMs<=clock.ElapsedMilliseconds,"successor-anchor");
        if(nextSeen<0)nextSeen=p.ObservedNotAfterMs;
        else Need(nextSeen==p.ObservedNotAfterMs,"successor-anchor-changed");
        Deadline();
    }
    private void Refresh(Held p)
    {
        uint wait=WaitForSingleObject(p.Handle,0); Need(wait==0 || wait==258,"wait-api");
        long created,exited,kernel,user; Need(GetProcessTimes(p.Handle,out created,out exited,out kernel,out user) && created.ToString()==p.Created && GetProcessId(p.Handle)==p.Pid,"held-identity");
        if(wait==0 && !p.Signaled) { uint code; Need(GetExitCodeProcess(p.Handle,out code) && exited>0,"exit-api"); p.Signaled=true; p.Code=code; p.Exited=exited.ToString(); Record("signal",p.Facts()); }
        if(wait==258) { bool member; Need(IsProcessInJob(p.Handle,job,out member)&&member,"membership"); }
    }
    private uint[] Members()
    {
        int size=Math.Max(8+IntPtr.Size*24,Marshal.SizeOf<Limits>()); IntPtr p=Marshal.AllocHGlobal(size);
        try {
            Need(QueryInformationJobObject(job,9,p,(uint)size,IntPtr.Zero),"limits-api"); Limits l=Marshal.PtrToStructure<Limits>(p); Need(l.Basic.Flags==0x2008 && l.Basic.Limit==24,"limits");
            Need(QueryInformationJobObject(job,3,p,(uint)(8+IntPtr.Size*24),IntPtr.Zero),"members-api");
            int assigned=Marshal.ReadInt32(p),count=Marshal.ReadInt32(p,4); Need(assigned==count && count>=1 && count<=24,"members-incomplete");
            uint[] ids=new uint[count]; for(int i=0;i<count;i++) ids[i]=checked((uint)Marshal.ReadIntPtr(p,8+IntPtr.Size*i).ToInt64());
            Need(ids.All(v=>v>0)&&ids.Distinct().Count()==count,"members-identity"); return ids;
        } finally { Marshal.FreeHGlobal(p); }
    }
    private void Scan(Func<uint,Cim> inspect)
    {
        long sampleStarted=clock.ElapsedMilliseconds;
        Deadline(); foreach(Held p in held.ToArray())Refresh(p);
        foreach(uint pid in Members()) {
            Held p=Capture(pid,inspect);
            // A vanished unclassified member cannot be called a harmless Chromium child.
            Need(p!=null || (ledger!=null && ledger.Utility!=null && ledger.Utility.Pid==pid),"member-unobserved");
        }
        foreach(Held p in held)Refresh(p);
        Held[] live=held.Where(p=>!p.Signaled).ToArray(); counts=new[]{live.Count(p=>p.Role=="main"),live.Count(p=>p.Role=="guardian"),live.Count(p=>p.Role=="chromium"),live.Count(p=>p.Role=="utility"),live.Count(p=>p.Role=="tool")};
        foreach(Held p in held.Where(p=>p.Role=="main" && p!=current && p!=old && p!=next && !retired.Contains(p))) {
            Need(old!=null && !cancelled && next==null && p.Parent==oldGuardian.Pid && old.Signaled && Time(p.Created)>Time(old.Exited) && Time(p.Created)>=Time(oldGuardian.Created),"successor-parent");
            Need(nextSeen>=0 && nextSeen==p.ObservedNotAfterMs,"successor-anchor-missing");
            next=p; Record("successor-candidate",p.Facts());
        }
        foreach(Held g in live.Where(p=>p.Role=="guardian")) {
            bool currentChild=g.Parent==current.Pid && Time(g.Created)>=Time(current.Created);
            bool nextChild=next!=null && g.Parent==next.Pid && Time(g.Created)>=Time(next.Created);
            Need(currentChild || nextChild,"guardian-parent");
            if(currentChild && currentGuardian!=null)Need(g==currentGuardian,"third-guardian");
            if(nextChild) { Need(nextGuardian==null || nextGuardian==g,"third-guardian"); nextGuardian=g; }
        }
        ValidateRoles(counts[0],counts[1],counts[2],counts[3],counts[4],old!=null && next!=null && nextGuardian!=null && !cancelled);
        string sampleSha=Hash(JsonSerializer.SerializeToUtf8Bytes(Sample()));
        if(sampleSha!=lastSampleSha) { Record("members",Sample()); lastSampleSha=sampleSha; }
        Deadline();
        previousCompleteSampleStart=sampleStarted;
    }
    private object Sample()
    {
        return new { main=counts[0],guardian=counts[1],chromium=counts[2],utility=counts[3],tools=counts[4],members=held.Where(p=>!p.Signaled).OrderBy(p=>p.Pid).Select(p=>new{pid=p.Pid,created=p.Created,role=p.Role}).ToArray() };
    }
    private static LedgerWriter Writer(JsonElement e,bool utility)
    {
        if(e.ValueKind==JsonValueKind.Null)return null;
        Fields(e,utility?new[]{"role","pid","created","image"}:new[]{"pid","created","image"});
        var w=new LedgerWriter {Pid=e.GetProperty("pid").GetUInt32(),Created=Text(e,"created"),Image=Text(e,"image"),Role=utility?Text(e,"role"):"main"};
        Need(w.Pid>0&&Time(w.Created)>0&&Hex(w.Image,64)&&(!utility || w.Role=="probe" || w.Role=="transfer"),"ledger-writer"); return w;
    }
    private Ledger ReadLedger()
    {
        byte[] bytes=Read(Path.Combine(root,"lifecycle-guardian","writers.json"),4096);
        using(var d=JsonDocument.Parse(bytes)) {
            var v=d.RootElement; Fields(v,"version","root","session","main","utility");
            var l=new Ledger {Root=Text(v,"root"),Session=Text(v,"session"),Sha=Hash(bytes),Main=Writer(v.GetProperty("main"),false),Utility=Writer(v.GetProperty("utility"),true),Projection=v.Clone()};
            Need(v.GetProperty("version").GetInt32()==1 && l.Root==rootHash && Hex(l.Session,32),"ledger-root");
            Need(l.Utility==null || (l.Main!=null && l.Utility.Pid!=l.Main.Pid && Time(l.Utility.Created)>=Time(l.Main.Created) && l.Utility.Image==l.Main.Image),"ledger-mixed");
            if(lastLedgerSha!=l.Sha) { Record("ledger",new{sha256=l.Sha,projection=l.Projection}); lastLedgerSha=l.Sha; }
            return l;
        }
    }
    private static bool Matches(LedgerWriter w,Held p) { return w!=null && p!=null && w.Pid==p.Pid && w.Created==p.Created && w.Image==p.ImageIdentity; }
    private Held FindGuardian(Held main,string session)
    {
        Held[] found=held.Where(p=>p.Role=="guardian" && p.Parent==main.Pid && p.Session==session && Time(p.Created)>=Time(main.Created)).ToArray();
        Need(found.Length<=1,"guardian-ambiguous"); return found.SingleOrDefault();
    }
    private void CaptureUtility(Ledger l,Func<uint,Cim> inspect)
    {
        if(l.Utility==null)return;
        Held parent=Matches(l.Main,current)?current:Matches(l.Main,next)?next:null; Need(parent!=null,"utility-generation");
        string key=l.Utility.Pid+":"+l.Utility.Created; Held p=Capture(l.Utility.Pid,inspect);
        if(p==null) { if(utilitySeen.Add(key)) { var fact=new{pid=l.Utility.Pid,created=l.Utility.Created,role=l.Utility.Role,classification="not-held",exitCode=(uint?)null}; uncaptured.Add(fact); Record("uncaptured",fact); } return; }
        Need(Matches(l.Utility,p)&&p.Role=="utility"&&p.Parent==parent.Pid,"utility-identity");
        p.Writer=true; utilitySeen.Add(key);
    }
    private void ValidateLedger(Ledger l)
    {
        if(old==null)Need(l.Session==currentGuardian.Session && (Matches(l.Main,current) || (current.Signaled&&l.Main==null&&l.Utility==null)),"current-ledger");
        else if(l.Session==oldSession)Need(Matches(l.Main,old) || (l.Main==null&&l.Utility==null),"old-ledger");
        else Need(next!=null && nextGuardian!=null && l.Session==nextGuardian.Session && l.Session!=oldSession && Matches(l.Main,next),"new-ledger");
    }
    public void Poll(Func<uint,Cim> inspect)
    {
        if(firstFailure!=null || finished)return;
        try {
            CheckScope(false); ledger=ReadLedger(); Scan(inspect); ValidateLedger(ledger); CaptureUtility(ledger,inspect);
            if(old!=null && oldGuardian.Signaled)Need(oldGuardian.Code==0,"guardian-exit");
            if(cancelled)Need(next==null && !current.Signaled && !currentGuardian.Signaled,"cancelled-successor");
            if(old!=null && approved && next!=null && nextGuardian!=null && old.Signaled && oldGuardian.Signaled) {
                Need(old.Code==0 && oldGuardian.Code==0 && !next.Signaled && !nextGuardian.Signaled,"transition-exit");
                Need(Time(next.Created)<=Time(oldGuardian.Exited) && Time(next.Created)>=Time(oldGuardian.Created),"parent-lifetime");
                Held[] utilities=held.Where(p=>p.Role=="utility" && p.Parent==old.Pid).ToArray();
                Need(utilities.All(p=>p.Signaled && (!p.Writer || p.Code==0) && Time(p.Exited)<=Time(next.Created)),"utility-not-retired");
                if(ledger.Session!=nextGuardian.Session || !Matches(ledger.Main,next))return;
                CheckScope(true); Scan(inspect); ledger=ReadLedger(); ValidateLedger(ledger); CaptureUtility(ledger,inspect);
                Need(!next.Signaled&&!nextGuardian.Signaled&&ledger.Session==nextGuardian.Session&&Matches(ledger.Main,next),"accept-current"); Deadline();
                string sha=Receipt("transition",new { oldMain=old.Facts(),oldGuardian=oldGuardian.Facts(),newMain=next.Facts(),newGuardian=nextGuardian.Facts(),heldUtilities=utilities.Select(p=>p.Facts()).ToArray(),uncaptured=uncaptured.ToArray(),utilityCoverage="held-observations-plus-guardian-retirement",oldSession,newSession=ledger.Session,ledger=ledger.Projection,ledgerSha256=ledger.Sha,approval=new{sequence=action,sha256=approvalSha},successorSeenMs=nextSeen });
                Refresh(next); Refresh(nextGuardian); CheckScope(false); Need(!next.Signaled&&!nextGuardian.Signaled,"accept-exited"); Deadline(); retired.Add(old); retired.Add(oldGuardian); current=next; currentGuardian=nextGuardian; old=null; oldGuardian=null; next=null; nextGuardian=null; nextSeen=-1; state="accepted"; Emit(state,sha);
            }
        } catch(Exception error) { Failure(error is ObservationFailure?error.Message:"native-or-io"); }
    }
    public void Command(string frame,Func<uint,Cim> inspect)
    {
        try {
            Need(firstFailure==null && !finished,"terminal"); Deadline(); Need(utf8.GetByteCount(frame)<=4096,"frame-budget");
            using(var d=JsonDocument.Parse(frame)) {
                var v=d.RootElement; Fields(v,"version","runId","scene","transition","sequence","command","actionSequence","receiptSha256");
                Need(v.GetProperty("version").GetInt32()==1 && Text(v,"runId")==run && Text(v,"scene")==scene && v.GetProperty("sequence").GetInt32()==sequence+1,"protocol-order");
                int t=v.GetProperty("transition").GetInt32(),a=v.GetProperty("actionSequence").GetInt32(); string command=Text(v,"command"),sha=Text(v,"receiptSha256");
                sequence++; Poll(inspect); Need(firstFailure==null,"poll-failed"); Deadline();
                if(command=="arm") {
                    Need(old==null && !cancelled && t==transition+1 && t<=(scene=="R"?1:2) && a>action && sha==null && !current.Signaled && !currentGuardian.Signaled,"arm-state");
                    transition=t; action=a; recordCount=0; recordBytes=0; uncaptured.Clear(); utilitySeen.Clear(); old=current; oldGuardian=currentGuardian; oldSession=ledger.Session; approved=false; approvalSha=null;
                    Need(Matches(ledger.Main,old) && ledger.Session==oldGuardian.Session,"arm-ledger"); CheckScope(true); state="armed"; Emit(state,null);
                } else {
                    Need(t==transition,"transition-order");
                    if(command=="approved") { Need(old!=null && state=="armed" && !cancelled && !approved && a==action && Hex(sha,64),"approval"); CheckApproval(sha,"approved"); approved=true; approvalSha=sha; state="approved"; Emit(state,null); }
                    else if(command=="cancelled") { Need(old!=null && state=="armed" && !approved && a==action && Hex(sha,64) && next==null && !old.Signaled && !oldGuardian.Signaled,"cancel"); CheckApproval(sha,"cancelled"); cancelled=true; state="cancelled"; Emit(state,null); }
                    else if(command=="assert-current") { Need(old==null && a==0 && sha==null && !current.Signaled && !currentGuardian.Signaled,"assert"); Emit("current",null); }
                    else if(command=="finish") {
                        Need(old==null && a==0 && sha==null && transition==(scene=="R"?1:2) && held.Where(p=>p.Role=="main"||p.Role=="guardian"||p.Role=="utility").All(p=>p.Signaled&&((p.Role=="utility"&&!p.Writer)||p.Code==0)) && ledger.Main==null&&ledger.Utility==null,"finish");
                        string final=Receipt("final",new{currentMain=current.Facts(),currentGuardian=currentGuardian.Facts(),ledger=ledger.Projection,ledgerSha256=ledger.Sha,held=held.Where(p=>p.Role=="main"||p.Role=="guardian"||p.Role=="utility").Select(p=>p.Facts()).ToArray(),utilityCoverage="held-observations-plus-guardian-retirement"});
                        Deadline(); finished=true; state="finished"; Emit(state,final);
                    } else throw new InvalidOperationException("command");
                }
                Deadline();
            }
        } catch(Exception error) { Failure(error is ObservationFailure?error.Message:"native-or-io"); }
    }
    private void CheckApproval(string sha,string result)
    {
        byte[] bytes=Read(Path.Combine(journal,"runner-output","restore-native",scene+"-t"+transition+"-a"+action+".json"),4096);
        Need(Hash(bytes)==sha,"approval-hash");
        using(var d=JsonDocument.Parse(bytes)) {
            var v=d.RootElement; Fields(v,"version","runId","scene","transition","actionSequence","purpose","result","nativeReceiptSha256");
            Need(v.GetProperty("version").GetInt32()==1&&Text(v,"runId")==run&&Text(v,"scene")==scene&&v.GetProperty("transition").GetInt32()==transition&&v.GetProperty("actionSequence").GetInt32()==action&&Text(v,"purpose")==((scene=="P"&&transition==1)?"partial":"restore")&&Text(v,"result")==result&&Hex(Text(v,"nativeReceiptSha256"),64),"approval-receipt");
        }
        Deadline();
    }
    private void Exclusive(string name,byte[] bytes)
    {
        using(var stream=new FileStream(Path.Combine(output,name),FileMode.CreateNew,FileAccess.Write,FileShare.Read)) { stream.Write(bytes); stream.Flush(true); }
    }
    private void Record(string kind,object value)
    {
        byte[] bytes=JsonSerializer.SerializeToUtf8Bytes(new{version=1,runId=run,scene,transition,record=recordCount+1,elapsedMs=clock.ElapsedMilliseconds,kind,value});
        Need(bytes.Length<=4096 && recordCount<512 && recordBytes+bytes.Length<=2*1024*1024,"record-budget");
        Exclusive("t"+transition+"-record-"+(++recordCount).ToString("D3")+".json",bytes); recordBytes+=bytes.Length;
    }
    private string Receipt(string kind,object facts)
    {
        byte[] bytes=JsonSerializer.SerializeToUtf8Bytes(new{version=1,runId=run,scene,transition,kind,elapsedMs=clock.ElapsedMilliseconds,budgetMs=budget,manifestSha256=manifestSha,markerSha256=markerSha,bindingSha256=bindingSha,executableSha256=exeSha,guardianSha256=guardianSha,profile=new{fileId128,volumeSerial64=volume64,guardianRootHash=rootHash},limits=new{flags=0x2008,total=24,held=held.Count,records=recordCount,bytes=recordBytes},sample=Sample(),facts});
        Need(bytes.Length<=65536,"receipt-budget"); Exclusive("t"+transition+"-"+kind+".json",bytes); return Hash(bytes);
    }
    private void Emit(string value,string sha)
    {
        string frame=JsonSerializer.Serialize(new{version=1,runId=run,scene,transition,sequence,state=value,elapsedMs=clock.ElapsedMilliseconds,receiptSha256=sha,current=current==null?null:new{pid=current.Pid,created=current.Created,image=current.Image},failure=firstFailure});
        Need(utf8.GetByteCount(frame)<=4096,"frame-budget"); frames.Enqueue(frame);
    }
    public void Fail(string ignored)
    { Failure(ignored=="input-closed"?"input-closed":"helper-failed"); }
    private void Failure(string reason)
    {
        if(firstFailure!=null)return;
        string phase=state;
        firstFailure="observation-failed"; state="failed";
        try { Receipt("failure",new{failure=firstFailure,reason,phase,held=held.Select(p=>p.Facts()).ToArray()}); } catch { }
        Emit("failed",null);
    }
    public string[] DrainFrames() { string[] result=frames.ToArray(); frames.Clear(); return result; }
    public bool Terminal { get { return firstFailure!=null || finished; } }
    public void Dispose() { if(disposed)return; disposed=true; foreach(Held p in held)p.Dispose(); if(job!=null)job.Dispose(); }
    public static Task<string> ReadFrame()
    {
        // Console.In's synchronized ReadAsync may execute synchronously. Keep the one
        // bounded pending read off the polling thread; process close owns its lifetime.
        return Task.Run(delegate() {
            var text=new StringBuilder();
            for(;;) {
                int value=Console.In.Read();
                if(value<0) { Need(text.Length==0,"truncated-input"); return (string)null; }
                if(value==10)return text.ToString();
                Need(value!=13 && value>=0x20 && text.Length<4096,"input-frame"); text.Append((char)value);
            }
        });
    }
}
