[CmdletBinding()]
param([switch]$BuildOnly, [ValidatePattern('^$|^guardian-publish-[a-f0-9]{32}$')][string]$PreparedId = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (($BuildOnly -and $PreparedId -ne '') -or (-not $BuildOnly -and $PreparedId -eq '')) { throw '明确指定BuildOnly或PreparedId' }
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
function New-Json([string]$Path,[object]$Value) {
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 10))
    if($bytes.Length -gt 262144){throw '资格报告超限'}
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Exact-Replace([string]$Source,[string]$Before,[string]$After){
    $index=$Source.IndexOf($Before,[StringComparison]::Ordinal)
    if($index -lt 0 -or $Source.IndexOf($Before,$index+1,[StringComparison]::Ordinal) -ge 0){throw '资格派生边界改变'}
    return $Source.Replace($Before,$After)
}
$sourceFiles=@('native/lifecycle-guardian/Guardian.cs','tools/release-profile/JobProcess.cs','tools/data-qualification/guardian/PublishQualification.cs','tools/data-qualification/guardian/publish-qualification.ps1')
$cases=@('normal-consecutive','tmp-dacl-before-write','owner-empty-ads','receipt-empty-ads','tmp-empty-ads','cached-both-dacl','final-collision','tmp-collision','receipt-identity','receipt-bytes','receipt-hardlink','directory-identity','before-publish-failure','after-publish-corrupt','late-final-io','encrypted-mismatch','compressed-mismatch','stream-query-failure','stream-query-truncated','stream-parser-extra-empty','stream-parser-overflow','stream-parser-truncated')
if($BuildOnly){
    $id='guardian-publish-'+[Guid]::NewGuid().ToString('N')
    $root=Join-Path $repository ('log/stage7-e2/'+$id)
    if(Test-Path -LiteralPath $root){throw '资格目录碰撞'}
    [IO.Directory]::CreateDirectory($root)|Out-Null
    $source=[IO.File]::ReadAllText((Join-Path $repository $sourceFiles[0])).Replace("`r`n","`n")
    $begin=$source.IndexOf('    private static void Persist()', [StringComparison]::Ordinal)
    $end=$source.IndexOf('    private static uint Active()', [StringComparison]::Ordinal)
    if($begin -lt 0 -or $end -le $begin){throw 'Persist方法边界改变'}
    $persist=$source.Substring($begin,$end-$begin)
    $pattern='using \(FileStream stream = new FileStream\([^\r\n]+\)\)\s*\{'
    $matches=[regex]::Matches($persist,$pattern)
    if($matches.Count -lt 1){throw '临时源句柄插桩边界改变'}
    $match=$matches[0]
    if(-not $persist.Substring(0,$match.Index).Contains('string final =')){throw '插桩不在已知Persist临时文件块'}
    $injected=$persist.Insert($match.Index+$match.Length,"`n            PublishQualification.AfterTemporaryCreated(stream, temp);")
    $source=Exact-Replace $source $persist $injected
    $source=Exact-Replace $source 'RenameHeld(stream, final, receipt != null);' 'PublishQualification.BeforePublish(); RenameHeld(stream, final, receipt != null); PublishQualification.AfterPublish(stream);'
    $source=Exact-Replace $source 'published = CheckPublished(final, written, payload, false);' 'published = CheckPublished(final, written, payload, false); PublishQualification.AfterFinalIo();'
    $source=Exact-Replace $source 'Need(admission.ElapsedMilliseconds < 10000);' 'Need(admission.ElapsedMilliseconds + PublishQualification.ClockOffset < 10000);'
    $source=Exact-Replace $source 'GetFileInformationByHandleEx(stream.SafeFileHandle, 7, bytes, (uint)bytes.Length)' 'PublishQualification.StreamQuery(stream.SafeFileHandle, bytes)'
    $derived=Join-Path $root 'Guardian.qualification.cs'
    [IO.File]::WriteAllText($derived,$source,[Text.UTF8Encoding]::new($false))
    [IO.File]::Copy((Join-Path $repository $sourceFiles[0]),(Join-Path $root 'Guardian.original.cs'),$false)
    foreach($name in @('PublishQualification.cs','publish-qualification.ps1')){[IO.File]::Copy((Join-Path $PSScriptRoot $name),(Join-Path $root ('source-'+$name)),$false)}
    $compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    $executable=Join-Path $root 'publish-qualification.exe'
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /main:PublishQualification /r:System.Web.Extensions.dll /out:$executable $derived (Join-Path $PSScriptRoot 'PublishQualification.cs') *> (Join-Path $root 'build.txt')
    if($LASTEXITCODE -ne 0){throw ('资格编译失败：'+$id)}
    $candidate=Join-Path $root 'guardian-candidate.exe'
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /out:$candidate (Join-Path $root 'Guardian.original.cs') *> (Join-Path $root 'candidate-build.txt')
    if($LASTEXITCODE -ne 0){throw ('产品私有编译失败：'+$id)}
    $job=[IO.File]::ReadAllText((Join-Path $repository 'tools/release-profile/JobProcess.cs'))
    $job=Exact-Replace $job 'ExtendedLimits limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } };' 'ExtendedLimits limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2008, ActiveProcessLimit = 2 } };'
    $anchor='private static string Name(string runId)'
    $job=Exact-Replace $job $anchor ('[DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")] private static extern bool QueryBudget(SafeFileHandle job, int type, out ExtendedLimits value, uint length, IntPtr returned);'+"`n        "+$anchor)
    $anchor='if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>())) throw new Win32Exception(Marshal.GetLastWin32Error());'
    $job=Exact-Replace $job $anchor ($anchor+"`n                "+'if (!QueryBudget(job, 9, out ExtendedLimits actualBudget, (uint)Marshal.SizeOf<ExtendedLimits>(), IntPtr.Zero) || actualBudget.Basic.Flags != 0x2008 || actualBudget.Basic.ActiveProcessLimit != 2) throw new InvalidOperationException("资格Job预算不符");')
    [IO.File]::WriteAllText((Join-Path $root 'QualificationJobProcess.cs'),$job,[Text.UTF8Encoding]::new($false))
    Add-Type -Path (Join-Path $root 'QualificationJobProcess.cs')
    $artifacts=@('Guardian.qualification.cs','Guardian.original.cs','publish-qualification.exe','guardian-candidate.exe','QualificationJobProcess.cs','source-PublishQualification.cs','source-publish-qualification.ps1')
    New-Json (Join-Path $root 'binding.json') @{id=$id;version=2;compilerSha256=(Get-FileHash -LiteralPath $compiler).Hash.ToLowerInvariant();sources=@($sourceFiles|ForEach-Object{@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $repository $_)).Hash.ToLowerInvariant()}});artifacts=@($artifacts|ForEach-Object{@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $root $_)).Hash.ToLowerInvariant()}});cases=$cases;workMs=5000;exitMs=30000;processes=2;dataBytes=262144;totalBytes=1048576}
    Write-Output $id
    return
}
$id=$PreparedId
$root=Join-Path $repository ('log/stage7-e2/'+$id)
$binding=Get-Content -LiteralPath (Join-Path $root 'binding.json') -Raw|ConvertFrom-Json
if($binding.id -cne $id -or $binding.version -ne 2 -or $binding.workMs -ne 5000 -or $binding.exitMs -ne 30000 -or $binding.processes -ne 2 -or $binding.dataBytes -ne 262144 -or $binding.totalBytes -ne 1048576 -or ($binding.cases -join '|') -cne ($cases -join '|')){throw '资格预算绑定改变'}
foreach($entry in $binding.sources){if((Get-FileHash -LiteralPath (Join-Path $repository $entry.path)).Hash.ToLowerInvariant() -cne $entry.sha256){throw '资格源码改变'}}
foreach($entry in $binding.artifacts){if((Get-FileHash -LiteralPath (Join-Path $root $entry.path)).Hash.ToLowerInvariant() -cne $entry.sha256){throw '资格制品改变'}}
New-Json (Join-Path $root 'claim.json') @{utc=[DateTime]::UtcNow.ToString('o');id=$id;cases=$binding.cases;noRetry=$true}
Add-Type -Path (Join-Path $root 'QualificationJobProcess.cs')
$jobId=[Guid]::NewGuid().ToString('N')
$result=[ordered]@{actualZero=$false;exitCode=$null;failure=$null;jobId=$jobId;productMainExecuted=$false}
$clock=[Diagnostics.Stopwatch]::StartNew()
try{
    $callback=[Action[uint32,long]]{param($processId,$created)
        [AIbrowse.ReleaseProfile.JobProcess]::AssertContains($jobId,$processId)
        New-Json (Join-Path $root 'launch.json') @{pid=$processId;created=$created;jobId=$jobId;activeProcessLimit=2}
    }
    $result.exitCode=[AIbrowse.ReleaseProfile.JobProcess]::Execute((Join-Path $root 'publish-qualification.exe'),@($root),$root,$jobId,5000,$callback)
    $result.actualZero=$true
}catch{$result.failure=$_.Exception.Message;if($result.failure.Contains('固定验收超时；Job 已确认实际归零')){$result.actualZero=$true}}
$result['elapsedMs']=$clock.Elapsed.TotalMilliseconds
$data=0L
foreach($name in $binding.cases){$casePath=Join-Path $root $name;if(Test-Path -LiteralPath $casePath){foreach($file in Get-ChildItem -LiteralPath $casePath -File -Recurse){$data+=$file.Length}}}
$total=(Get-ChildItem -LiteralPath $root -File -Recurse|Measure-Object -Property Length -Sum).Sum
$result['dataBytes']=$data;$result['totalBytesBeforeResult']=$total
$result['withinBudget']=$data -le 262144 -and $total -lt (1048576-16384)
$observed=Get-Content -LiteralPath (Join-Path $root 'cases.json') -Raw|ConvertFrom-Json
$result['allCasesPassed']=$observed.failures -eq 0 -and $null -eq $observed.unexpected -and ($observed.cases.name -join '|') -ceq ($cases -join '|') -and @($observed.cases|Where-Object {-not $_.oraclePassed}).Count -eq 0
New-Json (Join-Path $root 'result.json') $result
Write-Output $id
if(-not $result.actualZero -or $result.exitCode -ne 0 -or $null -ne $result.failure -or -not $result.withinBudget -or -not $result.allCasesPassed){exit 1}
