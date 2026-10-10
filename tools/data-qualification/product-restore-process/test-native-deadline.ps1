[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Keep Capture, Scan, the successor clock binding and Deadline intact. Replace
# only OS/IO boundaries and the clock; no native observer session is constructed.
$sourcePath = Join-Path $PSScriptRoot 'SuccessorObserver.cs'
$source = [IO.File]::ReadAllText($sourcePath)
$sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
$source = $source.Replace('RestoreSuccessorObserver', 'RestoreSuccessorDeadlineFixture')
function Replace-One([string]$Pattern, [string]$Replacement) {
    $regex = [Text.RegularExpressions.Regex]::new($Pattern, [Text.RegularExpressions.RegexOptions]::Singleline)
    if ($regex.Matches($script:source).Count -ne 1) { throw '纯边界替换没有唯一匹配' }
    $script:source = $regex.Replace($script:source, [Text.RegularExpressions.MatchEvaluator]{ param($match) $Replacement }, 1)
}
Replace-One 'private readonly Stopwatch clock = Stopwatch\.StartNew\(\);' @'
private sealed class FixtureClock { public long ElapsedMilliseconds; }
    private readonly FixtureClock clock = new FixtureClock();
    private long cimDelay, openDelay;
    private bool candidateAvailable=true;
'@
Replace-One '\[DllImport\([^\r\n]+\)\] private static extern SafeFileHandle OpenProcess\([^;]+;' @'
private SafeFileHandle OpenProcess(uint access,bool inherit,uint pid) {
        clock.ElapsedMilliseconds += openDelay;
        return new SafeFileHandle(new IntPtr(1),false);
    }
'@
Replace-One '\[DllImport\([^\r\n]+\)\] private static extern uint GetProcessId\([^;]+;' 'private static uint GetProcessId(SafeFileHandle process) { return 20; }'
Replace-One '\[DllImport\([^\r\n]+\)\] private static extern bool GetProcessTimes\([^;]+;' @'
private static bool GetProcessTimes(SafeFileHandle process,out long created,out long exited,out long kernel,out long user) { created=250;exited=kernel=user=0;return true; }
'@
Replace-One '\[DllImport\([^\r\n]+\)\] private static extern bool IsProcessInJob\([^;]+;' 'private static bool IsProcessInJob(SafeFileHandle process,SafeFileHandle job,out bool member) { member=true;return true; }'
Replace-One '\[DllImport\([^\r\n]+\)\] private static extern uint WaitForSingleObject\([^;]+;' 'private static uint WaitForSingleObject(SafeFileHandle process,uint milliseconds) { return 258; }'
Replace-One '\[DllImport\([^\r\n]+\)\] private static extern bool QueryFullProcessImageNameW\([^;]+;' @'
private static bool QueryFullProcessImageNameW(SafeFileHandle process,uint flags,StringBuilder image,ref uint length) { image.Append("D:\\synthetic\\AIbrowse.exe");length=(uint)image.Length;return true; }
'@
Replace-One 'private uint Parent\(uint pid\)\s*\{.*?(?=    private Held Capture)' 'private uint Parent(uint pid) { return 11; }'
Replace-One 'private static string\[\] Arguments\(string command\)\s*\{.*?(?=    public static void ValidateCim)' 'private static string[] Arguments(string command) { return new[]{command}; }'
Replace-One 'private void Refresh\(Held p\)\s*\{.*?(?=    private uint\[\] Members)' 'private void Refresh(Held p) { }'
Replace-One 'private uint\[\] Members\(\)\s*\{.*?(?=    private void Scan)' 'private uint[] Members() { return candidateAvailable?new uint[]{20}:new uint[0]; }'
Replace-One 'private void Record\(string kind,object value\)\s*\{.*?(?=    private string Receipt)' 'private void Record(string kind,object value) { }'
Replace-One 'public static Task<string> ReadFrame\(\)' @'
private RestoreSuccessorDeadlineFixture(long cim,long opening,long scanStart)
    {
        budget=120000; cimDelay=cim; openDelay=opening; clock.ElapsedMilliseconds=scanStart;
        executable="D:\\synthetic\\AIbrowse.exe"; exeIdentity="synthetic";
        current=old=new Held { Pid=10,Parent=1,Role="main",Created="100",Exited="200",Signaled=true,Code=0 };
        currentGuardian=oldGuardian=new Held { Pid=11,Parent=10,Role="guardian",Created="150",Exited="300",Signaled=true,Code=0 };
        held.Add(old); held.Add(oldGuardian);
    }
    private Cim InspectFixture(uint pid)
    {
        clock.ElapsedMilliseconds+=cimDelay;
        return new Cim {Pid=pid,Created="250",Image=executable,Command=executable};
    }
    public static long[] Delayed(long cim,long opening,long scanStart)
    {
        var observer=new RestoreSuccessorDeadlineFixture(cim,opening,scanStart);
        observer.Scan(observer.InspectFixture);
        return new[]{observer.clock.ElapsedMilliseconds,observer.nextSeen};
    }
    public static bool NoRenewal()
    {
        var observer=new RestoreSuccessorDeadlineFixture(59000,0,0);
        observer.Scan(observer.InspectFixture);
        observer.clock.ElapsedMilliseconds=59999;
        observer.Scan(observer.InspectFixture);
        if(observer.nextSeen!=0)return false;
        observer.clock.ElapsedMilliseconds=60000;
        try { observer.Scan(observer.InspectFixture);return false; }
        catch(Exception error) { return error.Message=="deadline"; }
    }
    public static long[] PriorCompletedSample(long delay)
    {
        var observer=new RestoreSuccessorDeadlineFixture(delay,0,1000);
        observer.candidateAvailable=false;
        observer.Scan(observer.InspectFixture);
        observer.candidateAvailable=true;
        observer.clock.ElapsedMilliseconds=10000;
        observer.Scan(observer.InspectFixture);
        return new[]{observer.clock.ElapsedMilliseconds,observer.nextSeen};
    }
    public static Task<string> ReadFrame()
'@
Add-Type -TypeDefinition $source
$cases = 0
$failures = 0
foreach ($scenario in @(@(0,0,0), @(59000,0,0), @(0,0,10000))) {
    $result = [RestoreSuccessorDeadlineFixture]::Delayed($scenario[0],$scenario[1],$scenario[2])
    $ok = $result[0] -eq ($scenario[0]+$scenario[1]+$scenario[2]) -and $result[1] -eq 0
    Write-Output "期限内分类/开句柄/扫描起点=$scenario；锚点=$($result[1])；通过=$ok"
    if (-not $ok) { $failures++ }
    $cases++
}
foreach ($scenario in @(@(61000,0,0), @(60000,0,0), @(0,61000,0), @(35000,26000,0), @(51000,0,10000))) {
    $rejected = $false
    try { $null = [RestoreSuccessorDeadlineFixture]::Delayed($scenario[0],$scenario[1],$scenario[2]) } catch { $rejected = $_.Exception.InnerException.Message -eq 'deadline' }
    Write-Output "超期分类/开句柄/扫描起点=$scenario；按deadline拒绝=$rejected"
    if (-not $rejected) { $failures++ }
    $cases++
}
$stable = [RestoreSuccessorDeadlineFixture]::NoRenewal()
Write-Output "跨后续扫描不重置锚点=$stable"
if (-not $stable) { $failures++ }
$cases++
foreach ($delay in @(0,50999)) {
    $result = [RestoreSuccessorDeadlineFixture]::PriorCompletedSample($delay)
    $ok = $result[0] -eq (10000+$delay) -and $result[1] -eq 1000
    Write-Output "先完整采样1000ms、捕获10000ms、分类耗时=$delay；锚点=$($result[1])；通过=$ok"
    if (-not $ok) { $failures++ }
    $cases++
}
$rejected = $false
try { $null = [RestoreSuccessorDeadlineFixture]::PriorCompletedSample(51000) } catch { $rejected = $_.Exception.InnerException.Message -eq 'deadline' }
Write-Output "原完整样本锚点1000ms、分类返回61000ms；按原期限拒绝=$rejected"
if (-not $rejected) { $failures++ }
$cases++
if ($failures -ne 0) { throw "$cases 项纯期限检查中 $failures 项失败" }
Write-Output "来源SHA256=$sourceHash；保留Capture/Scan/Deadline及锚点绑定，$cases 项纯期限检查通过；没有原生session、产品、Job或UI。"
