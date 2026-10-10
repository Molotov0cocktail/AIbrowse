[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Keep the candidate's Scan and Deadline control flow. Replace only its clock and
# native/IO boundaries so this review never opens a process, Job, UI, or profile.
$sourcePath = Join-Path $PSScriptRoot 'product-restore-process/SuccessorObserver.cs'
$source = [IO.File]::ReadAllText($sourcePath)
$sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
$source = $source.Replace('RestoreSuccessorObserver', 'RestoreSuccessorObserverDeadlineReview')

function Replace-One([string]$Pattern, [string]$Replacement) {
    $patternObject = [Text.RegularExpressions.Regex]::new($Pattern, [Text.RegularExpressions.RegexOptions]::Singleline)
    if ($patternObject.Matches($script:source).Count -ne 1) { throw '独立纯边界替换没有唯一匹配' }
    $script:source = $patternObject.Replace($script:source, [Text.RegularExpressions.MatchEvaluator]{ param($match) $Replacement }, 1)
}

Replace-One 'private readonly Stopwatch clock = Stopwatch\.StartNew\(\);' @'
private sealed class ReviewClock { public long ElapsedMilliseconds; }
    private readonly ReviewClock clock = new ReviewClock();
    private long reviewDelay;
'@
Replace-One 'private Held Capture\(uint pid,Func<uint,Cim> inspect\)\s*\{.*?(?=    private void Refresh)' @'
private Held Capture(uint pid,Func<uint,Cim> inspect)
    {
        // The candidate was first held at monotonic zero. Native/CIM work then
        // returns successfully after the injected delay, under the scene budget.
        clock.ElapsedMilliseconds += reviewDelay;
        var p = new Held { Handle=null, Session=null, Pid=20, Parent=11, Role="main", Created="250", Image="synthetic", ImageIdentity="synthetic", Signaled=false };
        held.Add(p);
        return p;
    }

'@
Replace-One 'private void Refresh\(Held p\)\s*\{.*?(?=    private uint\[\] Members)' @'
private void Refresh(Held p) { }

'@
Replace-One 'private uint\[\] Members\(\)\s*\{.*?(?=    private void Scan)' @'
private uint[] Members() { return new uint[] { 20 }; }

'@
Replace-One 'private void Record\(string kind,object value\)\s*\{.*?(?=    private string Receipt)' @'
private void Record(string kind,object value) { }

'@
Replace-One 'public static Task<string> ReadFrame\(\)' @'
private RestoreSuccessorObserverDeadlineReview(long delay)
    {
        budget=120000;
        reviewDelay=delay;
        current=old=new Held { Pid=10, Parent=1, Role="main", Created="100", Exited="200", Signaled=true, Code=0 };
        currentGuardian=oldGuardian=new Held { Pid=11, Parent=10, Role="guardian", Created="150", Exited="300", Signaled=true, Code=0 };
        held.Add(old);
        held.Add(oldGuardian);
    }
    public static long[] ReviewDelayedDiscovery(long delay)
    {
        var observer=new RestoreSuccessorObserverDeadlineReview(delay);
        observer.Scan(null);
        return new long[] { 0, observer.clock.ElapsedMilliseconds, observer.nextSeen, observer.budget };
    }
    public static Task<string> ReadFrame()
'@

Add-Type -TypeDefinition $source
$first = [RestoreSuccessorObserverDeadlineReview]::ReviewDelayedDiscovery(0)
if ($first[1] -ne 0) { throw '零延迟控制失败' }
$inTime = [RestoreSuccessorObserverDeadlineReview]::ReviewDelayedDiscovery(59000)
if ($inTime[1] -ne 59000) { throw '期限内控制失败' }
$rejected = $false
$late = $null
try { $late = [RestoreSuccessorObserverDeadlineReview]::ReviewDelayedDiscovery(61000) }
catch { $rejected = $true }
Write-Output "来源SHA256=$sourceHash；原Scan/Deadline保留，clock/native/IO已替换纯边界；未创建observer原生session、产品、Job或UI。"
Write-Output "控制项2/2通过；超期捕获分类拒绝=$rejected"
if (-not $rejected) {
    Write-Output "首次持有=$($late[0])ms；分类返回=$($late[1])ms；后写nextSeen=$($late[2])ms；场景预算=$($late[3])ms。"
    throw '已有后继身份的分类耗时超过boot60，原Scan/Deadline仍接受并后移起点。'
}
Write-Output '独立原生控制流纯期限反例通过。'
