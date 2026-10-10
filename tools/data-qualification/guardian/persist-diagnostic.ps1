[CmdletBinding()]
param([switch]$BuildOnly, [ValidatePattern('^$|^[a-f0-9]{32}$')][string]$FixedJournalId = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$id = 'guardian-persist-' + [Guid]::NewGuid().ToString('N')
$root = Join-Path $repository ('log/stage7-e2/' + $id)
[IO.Directory]::CreateDirectory($root) | Out-Null
$sourcePath = Join-Path $repository 'native/lifecycle-guardian/Guardian.cs'
$sourceHash = (Get-FileHash -LiteralPath $sourcePath).Hash.ToLowerInvariant()
if ($sourceHash -ne '648d4e97ba15899d8bc9aa8cbde2e6b77a10a4d6db52d6327aa1bf5e9318fb85') { throw '冻结Guardian源码改变' }
$source = [IO.File]::ReadAllText($sourcePath).Replace("`r`n", "`n")
function Replace-Once([string]$Before, [string]$After) {
    $position = $script:source.IndexOf($Before, [StringComparison]::Ordinal)
    if ($position -lt 0 -or $script:source.IndexOf($Before, $position + 1, [StringComparison]::Ordinal) -ge 0) { throw '精确诊断插桩边界改变' }
    $script:source = $script:source.Replace($Before, $After)
}
Replace-Once 'CheckDirectories();
        string final = Path.Combine(directory, "writers.json"), temp = final + ".tmp";' 'PersistDiagnostic.Stage("check-directories-initial"); CheckDirectories();
        string final = Path.Combine(directory, "writers.json"), temp = final + ".tmp";'
Replace-Once 'using (FileStream stream = new FileStream(temp, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))' 'PersistDiagnostic.Stage("create-temporary");
        using (FileStream stream = new FileStream(temp, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))'
Replace-Once 'FileIdentity(stream); stream.Write(payload, 0, payload.Length); stream.Flush(true); written = FileIdentity(stream);' 'PersistDiagnostic.Stage("temporary-identity-initial"); FileIdentity(stream); PersistDiagnostic.Stage("temporary-write"); stream.Write(payload, 0, payload.Length); PersistDiagnostic.Stage("temporary-flush"); stream.Flush(true); PersistDiagnostic.Stage("temporary-identity-written"); written = FileIdentity(stream);'
Replace-Once 'CheckDirectories(); CheckReceipt(final);' 'PersistDiagnostic.Stage("check-directories-written"); CheckDirectories(); PersistDiagnostic.Stage("check-receipt"); CheckReceipt(final);'
Replace-Once 'FilePath(temp);' 'PersistDiagnostic.Stage("temporary-path"); FilePath(temp);'
Replace-Once 'using (FileStream stream = new FileStream(temp, FileMode.Open, FileAccess.Read, FileShare.Read)) Need(Unchanged(written, FileIdentity(stream)));' 'PersistDiagnostic.Stage("temporary-identity-reopened"); using (FileStream stream = new FileStream(temp, FileMode.Open, FileAccess.Read, FileShare.Read)) Need(Unchanged(written, FileIdentity(stream)));'
Replace-Once 'if (receipt != null) File.Replace(temp, final, null); else File.Move(temp, final);' 'PersistDiagnostic.Stage(receipt != null ? "replace-final" : "move-first-final"); if (receipt != null) File.Replace(temp, final, null); else File.Move(temp, final); PersistDiagnostic.Stage("read-published-final");'
Replace-Once 'receiptIdentity = FileIdentity(stream); Need(Same(written, receiptIdentity) && stream.Length == payload.Length);' 'PersistDiagnostic.Stage("published-final-identity"); receiptIdentity = FileIdentity(stream); Need(Same(written, receiptIdentity) && stream.Length == payload.Length); PersistDiagnostic.Stage("published-final-bytes");'
$derived = Join-Path $root 'Guardian.persist-diagnostic.cs'
[IO.File]::WriteAllText($derived, $source, [Text.UTF8Encoding]::new($false))
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$executable = Join-Path $root 'persist-diagnostic.exe'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /main:PersistDiagnostic /r:System.Web.Extensions.dll /out:$executable $derived (Join-Path $PSScriptRoot 'PersistDiagnostic.cs') *> (Join-Path $root 'build.txt')
if ($LASTEXITCODE -ne 0) { throw '持久化诊断编译失败，原件保留' }
$jobPath = Join-Path $repository 'tools/release-profile/JobProcess.cs'
$jobSource = [IO.File]::ReadAllText($jobPath)
$originalLimits = 'ExtendedLimits limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } };'
if ($jobSource.IndexOf($originalLimits) -lt 0 -or $jobSource.IndexOf($originalLimits) -ne $jobSource.LastIndexOf($originalLimits)) { throw 'Job预算插入边界改变' }
$jobSource = $jobSource.Replace($originalLimits, 'ExtendedLimits limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2008, ActiveProcessLimit = 2 } };')
$queryAnchor = 'private static string Name(string runId)'
$jobSource = $jobSource.Replace($queryAnchor, '[DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")] private static extern bool QueryBudget(SafeFileHandle job, int type, out ExtendedLimits value, uint length, IntPtr returned);' + "`n        " + $queryAnchor)
$setAnchor = 'if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>())) throw new Win32Exception(Marshal.GetLastWin32Error());'
$jobSource = $jobSource.Replace($setAnchor, $setAnchor + "`n                " + 'if (!QueryBudget(job, 9, out ExtendedLimits actualBudget, (uint)Marshal.SizeOf<ExtendedLimits>(), IntPtr.Zero) || actualBudget.Basic.Flags != 0x2008 || actualBudget.Basic.ActiveProcessLimit != 2) throw new InvalidOperationException("诊断Job限额读回失败");')
$jobDerived = Join-Path $root 'PersistJobProcess.cs'
[IO.File]::WriteAllText($jobDerived, $jobSource, [Text.UTF8Encoding]::new($false))
@{ version = 1; id = $id; sourceSha256 = $sourceHash; jobSourceSha256 = (Get-FileHash $jobPath).Hash.ToLowerInvariant(); compilerSha256 = (Get-FileHash $compiler).Hash.ToLowerInvariant(); sources = @('tools/data-qualification/guardian/PersistDiagnostic.cs', 'tools/data-qualification/guardian/persist-diagnostic.ps1') | ForEach-Object { @{ path = $_; sha256 = (Get-FileHash (Join-Path $repository $_)).Hash.ToLowerInvariant() } }; artifacts = @('Guardian.persist-diagnostic.cs', 'PersistJobProcess.cs', 'persist-diagnostic.exe') | ForEach-Object { @{ path = $_; sha256 = (Get-FileHash (Join-Path $root $_)).Hash.ToLowerInvariant() } }; budget = @{ cases = $(if ($FixedJournalId -eq '') { 2 } else { 1 }); workMs = 5000; exitMs = 30000; processes = 2; caseDataBytes = 32768; totalBytes = 1048576 } } | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $root 'binding.json') -Encoding utf8NoBOM
Write-Output $id
if ($BuildOnly) { return }
$parentScope = $null
$siblingPath = $null
$modes = @('plain', 'efs')
if ($FixedJournalId -ne '') {
    $env:AIBROWSE_PROFILE_TOOL_REPOSITORY = $repository
    Add-Type -Path $jobDerived, (Join-Path $repository 'tools/release-profile/DisposableProfile.cs'), (Join-Path $repository 'tools/release-profile/ProfileIsolation.cs')
    $journal = Join-Path $repository ('log/stage7-e1/disposable-profile/journal-' + $FixedJournalId)
    $profileType = [AIbrowse.ReleaseProfile.DisposableProfile]
    $privateStatic = [Reflection.BindingFlags]'Static,NonPublic'
    $manifest = $profileType.GetMethod('Load', $privateStatic).Invoke($null, [object[]]@([string]$journal))
    $leaseType = $profileType.Assembly.GetType('AIbrowse.ReleaseProfile.DisposableLease')
    $lease = $leaseType.GetConstructor([Reflection.BindingFlags]'Instance,NonPublic', $null, [type[]]@([bool]), $null).Invoke([object[]]@($false))
    try { $profileType.GetMethod('CheckMarker', $privateStatic).Invoke($null, [object[]]@($manifest.PSObject.BaseObject, $lease.PSObject.BaseObject)) | Out-Null } finally { ([IDisposable]$lease).Dispose() }
    $parent = [IO.Path]::GetDirectoryName($manifest.ResolvedProfile)
    $scopeType = $profileType.Assembly.GetType('AIbrowse.ReleaseProfile.Scope')
    $parentScope = $scopeType.GetConstructor([type[]]@([string])).Invoke([object[]]@([string]$parent))
    $parentIdentity = $scopeType.GetProperty('Parent').GetValue($parentScope).Identity
    $siblingPath = Join-Path $parent ('.aibrowse-e2-persist-' + [Guid]::NewGuid().ToString('N'))
    if ([IO.Path]::GetFullPath($siblingPath) -cne $siblingPath -or [IO.Path]::GetDirectoryName($siblingPath) -cne $parent -or $siblingPath -eq $manifest.ResolvedProfile -or (Test-Path -LiteralPath $siblingPath)) { throw '同父合成目标不符合批准范围' }
    @{ version = 1; journalId = $FixedJournalId; manifestSha256 = (Get-FileHash -LiteralPath (Join-Path $journal 'manifest.json')).Hash.ToLowerInvariant(); currentProfileFileId128 = $manifest.RootIdentity.FileId128; parentPath = $parent; parentFileId = $parentIdentity.FileId; targetPath = $siblingPath; onlyInherit = $true } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'sibling-plan.json') -Encoding utf8NoBOM
    Write-Output ('已核对唯一合成目标：' + $siblingPath)
    $modes = @('inherited')
} else { Add-Type -Path $jobDerived }
$results = [Collections.Generic.List[object]]::new()
try { foreach ($mode in $modes) {
    $jobId = [Guid]::NewGuid().ToString('N')
    $caseRoot = $(if ($mode -eq 'inherited') { $siblingPath } else { Join-Path $root $mode })
    $caseReport = Join-Path $root ($mode + '.json')
    $result = [ordered]@{ mode = $mode; jobId = $jobId; actualZero = $false; exitCode = $null; failure = $null }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
        $callback = [Action[uint32,long]] { param($processId,$created)
            [AIbrowse.ReleaseProfile.JobProcess]::AssertContains($jobId, $processId)
            @{ pid = $processId; created = $created; jobId = $jobId; processLimit = 2 } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root ($mode + '-launch.json')) -Encoding utf8NoBOM
        }
        $result.exitCode = [AIbrowse.ReleaseProfile.JobProcess]::Execute($executable, @($caseRoot, $mode, $caseReport), $root, $jobId, 5000, $callback)
        $result.actualZero = $true
    } catch {
        $result.failure = $_.Exception.Message
        if ($result.failure.Contains('固定验收超时；Job 已确认实际归零')) { $result.actualZero = $true }
    }
    $result['elapsedMs'] = $clock.Elapsed.TotalMilliseconds
    $caseBytes = 0L
    if (Test-Path -LiteralPath $caseRoot) { foreach ($file in Get-ChildItem -LiteralPath $caseRoot -File -Recurse) { $caseBytes += $file.Length } }
    $result['dataBytes'] = $caseBytes
    if ($caseBytes -gt 32768) { $result.failure = '场景数据预算超限' }
    $results.Add($result)
    $results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'result.json') -Encoding utf8NoBOM
    if (-not $result.actualZero -or $null -ne $result.failure) { break }
} } finally { if ($null -ne $parentScope) { ([IDisposable]$parentScope).Dispose() } }
$total = 0L
foreach ($file in Get-ChildItem -LiteralPath $root -File -Recurse) { $total += $file.Length }
if ($null -ne $siblingPath -and (Test-Path -LiteralPath $siblingPath)) { foreach ($file in Get-ChildItem -LiteralPath $siblingPath -File -Recurse) { $total += $file.Length } }
@{ totalBytes = $total; withinBudget = ($total -le 1048576); results = $results; productExecuted = $false; failedProfileDataRead = $false; ownerMarkerRead = ($FixedJournalId -ne '') } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $root 'summary.json') -Encoding utf8NoBOM
if ($total -gt 1048576 -or @($results | Where-Object { -not $_.actualZero -or $_.exitCode -notin @(0, 3) -or $null -ne $_.failure }).Count -gt 0) { exit 1 }
