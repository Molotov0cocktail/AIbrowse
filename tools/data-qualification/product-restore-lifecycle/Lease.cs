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

// Narrow normal-close lease. It never opens the writer Job or owner lock.
public sealed class OrdinaryLifecycleLease : IDisposable
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

    private sealed class Held : IDisposable
    {
        public SafeFileHandle Handle;
        public uint Pid, Parent;
        public string Created, Image, ImageIdentity, Role, Session;
        public string Exited;
        public uint? Code;
        public bool Signaled;
        public object Facts() { return new { pid=Pid, created=Created, image=Image, imageIdentity=ImageIdentity, parentPid=Parent, role=Role, session=Session, signaled=Signaled, exitCode=Code, exitFileTime=Exited }; }
        public void Dispose() { if(Handle!=null) Handle.Dispose(); }
    }
    private sealed class LedgerWriter { public uint Pid; public string Created, Image, Role; }
    private sealed class Ledger { public string Root, Session, Sha; public LedgerWriter Main, Utility; public object Projection; }
    private readonly List<Held> held = new List<Held>();
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly UTF8Encoding utf8 = new UTF8Encoding(false, true);
    private SafeFileHandle job;
    private readonly string run, journal, root, declared, executable, guardian, output, exeSha, guardianSha, bindingSha;
    private readonly string fileId128, volume64, rootHash, manifestSha, markerSha, exeIdentity, guardianIdentity;
    private readonly long budget;
    private readonly uint runner;
    private string runnerImage, helperImage;
    private Held main, guardianProcess;
    private Ledger ledger;
    private int records;
    private long recordBytes;
    private string retiredSha;
    private string lastLedgerSha;
    private bool disposed;
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
    private void Deadline() { Need(!disposed && clock.ElapsedMilliseconds < budget, "deadline"); }
    private static string[] Arguments(string command)
    {
        Need(!String.IsNullOrEmpty(command) && command.Length<=32768,"command"); int count; IntPtr p=CommandLineToArgvW(command,out count); Need(p!=IntPtr.Zero,"command-api");
        try { Need(count>0 && count<=128,"command-count"); string[] values=new string[count]; for(int i=0;i<count;i++) values[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size)); return values; } finally { LocalFree(p); }
    }
    private uint Parent(uint pid)
    {
        using(var s=CreateToolhelp32Snapshot(2,0)) {
            Need(!s.IsInvalid,"parent-api"); Entry e=new Entry { Size=(uint)Marshal.SizeOf<Entry>() }; bool more=Process32FirstW(s,ref e); int count=0;
            while(more && count++<65536) { Deadline(); if(e.Pid==pid)return e.Parent; more=Process32NextW(s,ref e); }
            throw new InvalidOperationException("parent-missing");
        }
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

    public OrdinaryLifecycleLease(string configuration, Func<uint,RestoreSuccessorObserver.Cim> inspect, long startupMs)
    {
        try {
            Need(utf8.GetByteCount(configuration)<=4096 && startupMs>=0,"configuration");
            using(var d=JsonDocument.Parse(configuration)) {
                var c=d.RootElement;
                Fields(c,"version","runId","journal","runnerPid","initial","remainingMs","executableSha256","guardianSha256","bindingSha256");
                Need(c.GetProperty("version").GetInt32()==1,"version");
                run=Text(c,"runId"); journal=Path.GetFullPath(Text(c,"journal"));
                Need(Hex(run,32) && Path.GetFileName(journal)=="journal-"+run,"scope");
                budget=c.GetProperty("remainingMs").GetInt64()-startupMs;
                Need(budget>0 && budget<=30000,"budget");
                runner=c.GetProperty("runnerPid").GetUInt32(); Need(runner>0,"runner");
                exeSha=Text(c,"executableSha256"); guardianSha=Text(c,"guardianSha256"); bindingSha=Text(c,"bindingSha256");
                Need(Hex(exeSha,64)&&Hex(guardianSha,64)&&Hex(bindingSha,64),"binding");
                byte[] manifest=Read(Path.Combine(journal,"manifest.json"),32768); manifestSha=Hash(manifest);
                using(var m=JsonDocument.Parse(manifest)) {
                    var v=m.RootElement;
                    Fields(v,"Version","RunId","DeclaredProfile","ResolvedProfile","PackageExecutable","BindingJournal","RootIdentity");
                    Need(v.GetProperty("Version").GetInt32()==2 && Text(v,"RunId")==run,"manifest");
                    root=Text(v,"ResolvedProfile"); declared=Text(v,"DeclaredProfile"); executable=Text(v,"PackageExecutable");
                    Need(Path.GetFullPath(root)==root && Path.GetFullPath(declared)==declared && Path.GetFullPath(executable)==executable && String.Equals(Path.GetFileName(executable),"AIbrowse.exe",StringComparison.OrdinalIgnoreCase),"paths");
                    var id=v.GetProperty("RootIdentity"); Fields(id,"Requested","FinalDos","FinalGuid","FinalNt","VolumeSerial64","FileId128","Sddl","FileSystem","Attributes");
                    fileId128=Text(id,"FileId128").ToLowerInvariant(); volume64=Text(id,"VolumeSerial64").ToLowerInvariant();
                    Need(Hex(fileId128,32)&&Hex(volume64,16),"root-schema");
                }
                guardian=Path.Combine(Path.GetDirectoryName(executable),"resources","lifecycle-guardian","guardian.exe");
                rootHash=Root(root,true); Root(declared,true);
                byte[] marker=Read(Path.Combine(root,".aibrowse-e1-synthetic-owner.json"),4096); markerSha=Hash(marker);
                using(var m=JsonDocument.Parse(marker)) {
                    var v=m.RootElement; Fields(v,"version","runId","fileId128","volumeSerial64");
                    Need(v.GetProperty("version").GetInt32()==1 && Text(v,"runId")==run && Text(v,"fileId128").ToLowerInvariant()==fileId128 && Text(v,"volumeSerial64").ToLowerInvariant()==volume64,"marker");
                }
                exeIdentity=ImageIdentity(executable); guardianIdentity=ImageIdentity(guardian); CheckScope(true);
                job=OpenJobObjectW(4,false,"Local\\AIbrowse.ReleaseProfile.Job."+run); Need(!job.IsInvalid,"job-open");
                var initial=c.GetProperty("initial"); Fields(initial,"pid","created","image");
                output=Path.Combine(journal,"runner-output","ordinary-"+initial.GetProperty("pid").GetUInt32()+"-"+Time(Text(initial,"created")));
                NoReparse(Path.GetDirectoryName(output)); Need(!Directory.Exists(output)&&!File.Exists(output),"evidence-exists"); Directory.CreateDirectory(output);
                main=Capture(initial.GetProperty("pid").GetUInt32(),inspect);
                Need(main.Role=="main" && main.Created==Text(initial,"created") && String.Equals(main.Image,Text(initial,"image"),StringComparison.OrdinalIgnoreCase),"initial");
                runnerImage=Capture(runner,inspect).Image; helperImage=Capture((uint)Environment.ProcessId,inspect).Image;
                Scan(inspect); ledger=ReadLedger();
                Held[] guardians=held.Where(p=>p.Role=="guardian" && !p.Signaled).ToArray(); Need(guardians.Length==1,"guardian-count");
                guardianProcess=guardians[0];
                Need(guardianProcess.Parent==main.Pid && Time(guardianProcess.Created)>=Time(main.Created) && guardianProcess.Session==ledger.Session && Matches(ledger.Main,main),"initial-ledger");
                Refresh(main); Refresh(guardianProcess); Need(!main.Signaled&&!guardianProcess.Signaled,"initial-exited"); Deadline();
            }
        } catch { Dispose(); throw; }
    }
    private Held Capture(uint pid,Func<uint,RestoreSuccessorObserver.Cim> inspect)
    {
        Held existing=held.SingleOrDefault(p=>p.Pid==pid);
        if(existing!=null) { Refresh(existing); return existing; }
        Need(held.Count<128,"held-budget"); var h=OpenProcess(0x101000,false,pid);
        try {
            long created=0,exited,kernel,user; bool member;
            Need(!h.IsInvalid && GetProcessId(h)==pid && GetProcessTimes(h,out created,out exited,out kernel,out user) && IsProcessInJob(h,job,out member)&&member && WaitForSingleObject(h,0)==258,"process-identity");
            uint length=32768; var image=new StringBuilder((int)length); Need(QueryFullProcessImageNameW(h,0,image,ref length),"image-api");
            var p=new Held {Handle=h,Pid=pid,Created=created.ToString(),Image=image.ToString(),Parent=Parent(pid)};
            var cim=inspect(pid); RestoreSuccessorObserver.ValidateCim(pid,p.Created,p.Image,cim); string[] args=Arguments(cim.Command);
            if(String.Equals(p.Image,guardian,StringComparison.OrdinalIgnoreCase)) {
                Need(String.Equals(args[0],p.Image,StringComparison.OrdinalIgnoreCase),"command-image");
                Need(args.Length==6 && args[1]==root && args[2]==p.Parent.ToString() && Hex(args[3],32) && String.Equals(args[4],executable,StringComparison.OrdinalIgnoreCase) && args[5]=="","guardian-arguments");
                p.Role="guardian"; p.Session=args[3]; p.ImageIdentity=guardianIdentity;
            } else if(String.Equals(p.Image,executable,StringComparison.OrdinalIgnoreCase)) {
                Need(String.Equals(args[0],p.Image,StringComparison.OrdinalIgnoreCase),"command-image");
                string[] types=args.Where(a=>a.StartsWith("--type=",StringComparison.Ordinal)).ToArray(); Need(types.Length<=1,"role");
                if(types.Length==0) { Need(args.Length==1 || (args.Length==2&&args[1]=="--force-renderer-accessibility"),"main-arguments"); p.Role="main"; }
                else if(types[0]=="--type=utility")p.Role="utility";
                else { Need(new[]{"--type=renderer","--type=gpu-process","--type=crashpad-handler"}.Contains(types[0]),"role"); p.Role="chromium"; }
                p.ImageIdentity=exeIdentity;
            } else {
                Need(pid==runner || pid==(uint)Environment.ProcessId || String.Equals(p.Image,runnerImage,StringComparison.OrdinalIgnoreCase) || String.Equals(p.Image,helperImage,StringComparison.OrdinalIgnoreCase) || String.Equals(p.Image,Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"conhost.exe"),StringComparison.OrdinalIgnoreCase),"unknown-image");
                p.Role="tool"; p.ImageIdentity=ImageIdentity(p.Image);
            }
            Refresh(p); Deadline(); Need(!p.Signaled,"capture-exited"); held.Add(p); h=null; Record("held",p.Facts()); return p;
        } finally { if(h!=null)h.Dispose(); }
    }
    private Held[] Scan(Func<uint,RestoreSuccessorObserver.Cim> inspect)
    {
        Deadline(); foreach(Held p in held.ToArray())Refresh(p);
        foreach(uint pid in Members())Capture(pid,inspect);
        foreach(Held p in held)Refresh(p);
        var live=held.Where(p=>!p.Signaled).ToArray();
        RestoreSuccessorObserver.ValidateRoles(live.Count(p=>p.Role=="main"),live.Count(p=>p.Role=="guardian"),live.Count(p=>p.Role=="chromium"),live.Count(p=>p.Role=="utility"),live.Count(p=>p.Role=="tool"),false);
        Need(held.Where(p=>p.Role=="main").All(p=>p==main),"unexpected-main");
        Need(held.Where(p=>p.Role=="guardian").All(p=>p.Parent==main.Pid && Time(p.Created)>=Time(main.Created) && (guardianProcess==null || p==guardianProcess)),"unexpected-guardian");
        Deadline(); return live;
    }
    public bool Poll(Func<uint,RestoreSuccessorObserver.Cim> inspect)
    {
        Need(retiredSha==null,"already-retired"); CheckScope(false); var live=Scan(inspect); ledger=ReadLedger();
        Need(ledger.Session==guardianProcess.Session && (Matches(ledger.Main,main) || (ledger.Main==null&&ledger.Utility==null)),"ledger-generation");
        if(!CanRetire(main.Signaled,main.Code,guardianProcess.Signaled,guardianProcess.Code,ledger.Main==null&&ledger.Utility==null,live.Count(p=>p.Role!="tool")))return false;
        CheckScope(true); live=Scan(inspect); Need(live.All(p=>p.Role=="tool"),"product-remains");
        ledger=ReadLedger(); Need(ledger.Session==guardianProcess.Session&&ledger.Main==null&&ledger.Utility==null,"ledger-retirement");
        var members=live.Select(p=>new{pid=p.Pid,created=p.Created,role=p.Role}).ToArray();
        byte[] receipt=JsonSerializer.SerializeToUtf8Bytes(new{version=1,runId=run,initial=new{pid=main.Pid,created=main.Created,image=main.Image},elapsedMs=clock.ElapsedMilliseconds,budgetMs=budget,manifestSha256=manifestSha,markerSha256=markerSha,bindingSha256=bindingSha,executableSha256=exeSha,guardianSha256=guardianSha,profile=new{fileId128,volumeSerial64=volume64,guardianRootHash=rootHash},limits=new{flags=0x2008,total=24,held=held.Count,records,bytes=recordBytes},main=main.Facts(),guardian=guardianProcess.Facts(),ledger=ledger.Projection,ledgerSha256=ledger.Sha,members});
        Need(receipt.Length<=65536,"receipt-budget"); Exclusive("retired.json",receipt); Deadline(); retiredSha=Hash(receipt); return true;
    }
    private void Exclusive(string name,byte[] bytes)
    {
        NoReparse(output);
        using(var stream=new FileStream(Path.Combine(output,name),FileMode.CreateNew,FileAccess.Write,FileShare.Read)) { stream.Write(bytes); stream.Flush(true); }
        Deadline();
    }
    private void Record(string kind,object value)
    {
        byte[] bytes=JsonSerializer.SerializeToUtf8Bytes(new{version=1,runId=run,record=records+1,elapsedMs=clock.ElapsedMilliseconds,kind,value});
        Need(bytes.Length<=4096 && records<512 && recordBytes+bytes.Length<=2097152,"record-budget");
        Exclusive("record-"+(++records).ToString("D3")+".json",bytes); recordBytes+=bytes.Length;
    }
    private string Frame(string state,string receiptSha256)
    {
        Deadline(); string value=JsonSerializer.Serialize(new{version=1,runId=run,state,elapsedMs=clock.ElapsedMilliseconds,main=main.Facts(),guardian=guardianProcess.Facts(),receiptSha256});
        Need(utf8.GetByteCount(value)<=4096,"frame-budget"); return value;
    }
    public string ReadyFrame() { Need(retiredSha==null,"already-retired"); Refresh(main); Refresh(guardianProcess); Need(!main.Signaled&&!guardianProcess.Signaled,"ready-exited"); return Frame("ready",null); }
    public string RetiredFrame() { Need(retiredSha!=null,"not-retired"); return Frame("retired",retiredSha); }
    public static bool CanRetire(bool mainSignal,uint? mainCode,bool guardianSignal,uint? guardianCode,bool ledgerRetired,int products)
    {
        Need(products>=0&&products<=24,"product-count");
        Need(mainSignal?mainCode==0:mainCode==null,"main-exit");
        Need(guardianSignal?guardianCode==0:guardianCode==null,"guardian-exit");
        if(!mainSignal || !guardianSignal || products!=0)return false;
        Need(ledgerRetired,"ledger-retirement"); return true;
    }
    public void Dispose() { if(disposed)return; disposed=true; foreach(var p in held)p.Dispose(); if(job!=null)job.Dispose(); }
}
