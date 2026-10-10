[CmdletBinding()]
param([switch]$BuildOnly, [ValidatePattern('^$|^guardian-rename-[a-f0-9]{32}$')][string]$PreparedId = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (($BuildOnly -and $PreparedId -ne '') -or (-not $BuildOnly -and $PreparedId -eq '')) { throw '明确选择BuildOnly或已绑定PreparedId' }
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$sourcePath = Join-Path $repository 'native/lifecycle-guardian/Guardian.cs'
$sourceHash = (Get-FileHash -LiteralPath $sourcePath).Hash.ToLowerInvariant()
if ($sourceHash -ne '648d4e97ba15899d8bc9aa8cbde2e6b77a10a4d6db52d6327aa1bf5e9318fb85') { throw '冻结Guardian源码改变' }
$jobPath = Join-Path $repository 'tools/release-profile/JobProcess.cs'
$sourceFiles = @('native/lifecycle-guardian/Guardian.cs', 'tools/release-profile/JobProcess.cs', 'tools/release-profile/DisposableProfile.cs', 'tools/release-profile/ProfileIsolation.cs', 'tools/data-qualification/guardian/RenamePersistDiagnostic.cs', 'tools/data-qualification/guardian/rename-persist-diagnostic.ps1')
function Write-NewJson([string]$Path, [object]$Value) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 12))
    if ($bytes.Length -gt 262144) { throw '单报告预算超限' }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Replace-Exact([string]$Text, [string]$Before, [string]$After) {
    $position = $Text.IndexOf($Before, [StringComparison]::Ordinal)
    if ($position -lt 0 -or $Text.IndexOf($Before, $position + 1, [StringComparison]::Ordinal) -ge 0) { throw '精确派生边界改变' }
    return $Text.Replace($Before, $After)
}
if ($BuildOnly) {
    $id = 'guardian-rename-' + [Guid]::NewGuid().ToString('N')
    $root = Join-Path $repository ('log/stage7-e2/' + $id)
    if (Test-Path -LiteralPath $root) { throw '构建目录碰撞' }
    [IO.Directory]::CreateDirectory($root) | Out-Null
    $source = [IO.File]::ReadAllText($sourcePath).Replace("`r`n", "`n")
    $start = $source.IndexOf('    private static void Persist()', [StringComparison]::Ordinal)
    $end = $source.IndexOf('    private static uint Active()', [StringComparison]::Ordinal)
    if ($start -lt 0 -or $end -le $start) { throw 'Persist方法边界改变' }
    $originalPersist = $source.Substring($start, $end - $start)
    $bodyStart = $originalPersist.IndexOf('        FileInfo written;', [StringComparison]::Ordinal)
    if ($bodyStart -lt 0) { throw 'Persist写入边界改变' }
    $persistHead = $originalPersist.Substring(0, $bodyStart)
    $persistHead = Replace-Exact $persistHead '        CheckDirectories();' '        RenamePersistDiagnostic.Stage("check-directories-initial"); CheckDirectories();'
    $persistTail = @'
        using (IDisposable pins = RenamePersistDiagnostic.PinDirectories(directory))
        {
            CheckDirectories();
            FileInfo written;
            RenamePersistDiagnostic.Stage("create-temporary-held");
            using (SafeFileHandle held = RenamePersistDiagnostic.CreateTemporary(temp))
            using (FileStream stream = new FileStream(held, FileAccess.ReadWrite, 4096, false))
            {
                RenamePersistDiagnostic.Stage("temporary-identity-initial"); FileIdentity(stream);
                RenamePersistDiagnostic.Stage("temporary-write"); stream.Write(payload, 0, payload.Length);
                RenamePersistDiagnostic.Stage("temporary-flush"); stream.Flush(true);
                RenamePersistDiagnostic.Stage("temporary-identity-written"); written = FileIdentity(stream);
                RenamePersistDiagnostic.Stage("check-directories-written"); CheckDirectories();
                RenamePersistDiagnostic.Stage("check-receipt"); CheckReceipt(final);
                FilePath(temp); Need(Unchanged(written, FileIdentity(stream)));
                RenamePersistDiagnostic.Stage("publish-held-source"); RenamePersistDiagnostic.Publish(stream, directory, final, receipt != null);
                RenamePersistDiagnostic.Stage("published-flush"); stream.Flush(true);
                RenamePersistDiagnostic.Stage("published-held-readback"); stream.Position = 0;
                receiptIdentity = FileIdentity(stream); Need(Same(written, receiptIdentity) && stream.Length == payload.Length);
                for (int i = 0; i < payload.Length; i++) Need(stream.ReadByte() == payload[i]);
                Need(stream.ReadByte() == -1);
                RenamePersistDiagnostic.ValidatePublished(stream, final);
                receipt = payload;
            }
        }
    }
'@
    $candidatePersist = $persistHead + $persistTail.Replace("`r`n", "`n") + "`n"
    $derivedSource = Replace-Exact $source $originalPersist $candidatePersist
    $outsideBefore = $source.Remove($start, $end - $start)
    $outsideAfter = $derivedSource.Remove($start, $candidatePersist.Length)
    if ($outsideAfter -cne $outsideBefore) { throw 'Persist之外源码改变' }
    $derived = Join-Path $root 'Guardian.rename-candidate.cs'
    [IO.File]::WriteAllText($derived, $derivedSource, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $root 'Persist.before.cs.txt'), $originalPersist, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $root 'Persist.after.cs.txt'), $candidatePersist, [Text.UTF8Encoding]::new($false))
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    $executable = Join-Path $root 'rename-persist-diagnostic.exe'
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /main:RenamePersistDiagnostic /r:System.Web.Extensions.dll /out:$executable $derived (Join-Path $PSScriptRoot 'RenamePersistDiagnostic.cs') *> (Join-Path $root 'build.txt')
    if ($LASTEXITCODE -ne 0) { throw ('重命名原语工具编译失败，原件保留：' + $id) }
    $jobSource = [IO.File]::ReadAllText($jobPath)
    $jobSource = Replace-Exact $jobSource 'ExtendedLimits limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } };' 'ExtendedLimits limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2008, ActiveProcessLimit = 2 } };'
    $queryAnchor = 'private static string Name(string runId)'
    $jobSource = Replace-Exact $jobSource $queryAnchor ('[DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")] private static extern bool QueryBudget(SafeFileHandle job, int type, out ExtendedLimits value, uint length, IntPtr returned);' + "`n        " + $queryAnchor)
    $setAnchor = 'if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>())) throw new Win32Exception(Marshal.GetLastWin32Error());'
    $jobSource = Replace-Exact $jobSource $setAnchor ($setAnchor + "`n                " + 'if (!QueryBudget(job, 9, out ExtendedLimits actualBudget, (uint)Marshal.SizeOf<ExtendedLimits>(), IntPtr.Zero) || actualBudget.Basic.Flags != 0x2008 || actualBudget.Basic.ActiveProcessLimit != 2) throw new InvalidOperationException("诊断Job限额读回失败");')
    $jobDerived = Join-Path $root 'RenameJobProcess.cs'
    [IO.File]::WriteAllText($jobDerived, $jobSource, [Text.UTF8Encoding]::new($false))
    $assembly = [Reflection.Assembly]::LoadFile($executable)
    $layout = $assembly.GetType('RenamePersistDiagnostic').GetMethod('LayoutProof', [Reflection.BindingFlags]'Public,Static').Invoke($null, @())
    Write-NewJson (Join-Path $root 'layout-proof.json') @{ proof = [string]$layout; productExecuted = $false; sceneExecuted = $false }
    Add-Type -Path $jobDerived, (Join-Path $repository 'tools/release-profile/DisposableProfile.cs'), (Join-Path $repository 'tools/release-profile/ProfileIsolation.cs')
    $staticFlags = [Reflection.BindingFlags]'Static,NonPublic'
    $profileType = [AIbrowse.ReleaseProfile.DisposableProfile]
    if ($null -eq $profileType.GetMethod('Load', $staticFlags) -or $null -eq $profileType.GetMethod('CheckMarker', $staticFlags) -or $null -eq [AIbrowse.ReleaseProfile.JobProcess].GetMethod('Execute')) { throw '复用监督器静态入口改变' }
    Write-NewJson (Join-Path $root 'supervisor-static.json') @{ compiled = $true; processCreationCalled = $false; jobCreationCalled = $false; fixedJournalRead = $false; limitFlags = 8200; activeProcessLimit = 2; actualBudgetReadbackImplemented = $true; heldJobExitBudgetMs = 30000 }
    [IO.File]::Copy((Join-Path $PSScriptRoot 'RenamePersistDiagnostic.cs'), (Join-Path $root 'source-RenamePersistDiagnostic.cs'), $false)
    [IO.File]::Copy((Join-Path $PSScriptRoot 'rename-persist-diagnostic.ps1'), (Join-Path $root 'source-rename-persist-diagnostic.ps1'), $false)
    $artifacts = @('Guardian.rename-candidate.cs', 'RenameJobProcess.cs', 'rename-persist-diagnostic.exe', 'Persist.before.cs.txt', 'Persist.after.cs.txt', 'layout-proof.json', 'supervisor-static.json', 'source-RenamePersistDiagnostic.cs', 'source-rename-persist-diagnostic.ps1')
    Write-NewJson (Join-Path $root 'binding.json') @{ version = 1; id = $id; sourceSha256 = $sourceHash; compilerSha256 = (Get-FileHash -LiteralPath $compiler).Hash.ToLowerInvariant(); unchangedOutsidePersist = $true; targetNameForm = 'null-root-fixed-canonical-absolute'; sources = @($sourceFiles | ForEach-Object { @{ path = $_; sha256 = (Get-FileHash -LiteralPath (Join-Path $repository $_)).Hash.ToLowerInvariant() } }); artifacts = @($artifacts | ForEach-Object { @{ path = $_; sha256 = (Get-FileHash -LiteralPath (Join-Path $root $_)).Hash.ToLowerInvariant() } }); budget = @{ cases = 2; workMs = 5000; exitMs = 30000; processes = 2; caseDataBytes = 32768; totalBytes = 1048576 }; fixedJournalId = '6697ab3d3a7d477787d250a1984b4698' }
    Write-Output $id
    return
}

$id = $PreparedId
$root = Join-Path $repository ('log/stage7-e2/' + $id)
$binding = Get-Content -LiteralPath (Join-Path $root 'binding.json') -Raw | ConvertFrom-Json
if ($binding.id -cne $id -or $binding.version -ne 1 -or $binding.sourceSha256 -cne $sourceHash -or $binding.fixedJournalId -cne '6697ab3d3a7d477787d250a1984b4698' -or $binding.targetNameForm -cne 'null-root-fixed-canonical-absolute' -or $binding.budget.workMs -ne 5000 -or $binding.budget.exitMs -ne 30000 -or $binding.budget.processes -ne 2) { throw '预备制品绑定不符' }
foreach ($entry in $binding.sources) { if ((Get-FileHash -LiteralPath (Join-Path $repository $entry.path)).Hash.ToLowerInvariant() -cne $entry.sha256) { throw '预备源码改变' } }
foreach ($entry in $binding.artifacts) { if ((Get-FileHash -LiteralPath (Join-Path $root $entry.path)).Hash.ToLowerInvariant() -cne $entry.sha256) { throw '预备制品改变' } }
Write-NewJson (Join-Path $root 'execution-claim.json') @{ id = $id; utc = [DateTime]::UtcNow.ToString('o'); cases = @('plain', 'inherited'); noRetry = $true }
$executable = Join-Path $root 'rename-persist-diagnostic.exe'
$env:AIBROWSE_PROFILE_TOOL_REPOSITORY = $repository
Add-Type -Path (Join-Path $root 'RenameJobProcess.cs'), (Join-Path $repository 'tools/release-profile/DisposableProfile.cs'), (Join-Path $repository 'tools/release-profile/ProfileIsolation.cs')
$parentScope = $null
$siblingPath = $null
$results = [Collections.Generic.List[object]]::new()
$outerFailure = $null
try {
    foreach ($mode in @('plain', 'inherited')) {
        if ($mode -eq 'inherited') {
            $fixedJournal = '6697ab3d3a7d477787d250a1984b4698'
            $journal = Join-Path $repository ('log/stage7-e1/disposable-profile/journal-' + $fixedJournal)
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
            $siblingPath = Join-Path $parent ('.aibrowse-e2-rename-' + [Guid]::NewGuid().ToString('N'))
            if ([IO.Path]::GetFullPath($siblingPath) -cne $siblingPath -or [IO.Path]::GetDirectoryName($siblingPath) -cne $parent -or $siblingPath -eq $manifest.ResolvedProfile -or (Test-Path -LiteralPath $siblingPath)) { throw '同父合成路径超出绑定范围' }
            Write-NewJson (Join-Path $root 'sibling-plan.json') @{ version = 1; journalId = $fixedJournal; manifestSha256 = (Get-FileHash -LiteralPath (Join-Path $journal 'manifest.json')).Hash.ToLowerInvariant(); currentProfileFileId128 = $manifest.RootIdentity.FileId128; parentPath = $parent; parentFileId = $parentIdentity.FileId; targetPath = $siblingPath; onlyInherit = $true }
            Write-Output ('已核对唯一同父合成目标：' + $siblingPath)
        }
        $jobId = [Guid]::NewGuid().ToString('N')
        $caseRoot = $(if ($mode -eq 'inherited') { $siblingPath } else { Join-Path $root 'plain' })
        $caseReport = Join-Path $root ($mode + '.json')
        $result = [ordered]@{ mode = $mode; jobId = $jobId; actualZero = $false; exitCode = $null; failure = $null; reportStatus = $null }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        try {
            $callback = [Action[uint32,long]] { param($processId, $created)
                [AIbrowse.ReleaseProfile.JobProcess]::AssertContains($jobId, $processId)
                Write-NewJson (Join-Path $root ($mode + '-launch.json')) @{ pid = $processId; created = $created; jobId = $jobId; processLimit = 2 }
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
        if (Test-Path -LiteralPath $caseReport) {
            if ((Get-Item -LiteralPath $caseReport).Length -gt 262144) { throw '场景报告预算超限' }
            $worker = Get-Content -LiteralPath $caseReport -Raw | ConvertFrom-Json
            $result.reportStatus = $worker.status
            if ($worker.mode -cne $mode -or $worker.status -cne 'PASS' -or $worker.productExecuted -ne $false -or $worker.elapsedMs -ge 5000) { $result.failure = '场景原语未通过，保留精确失败报告' }
        } else { $result.failure = '未取得场景终态报告' }
        $results.Add($result)
        Write-NewJson (Join-Path $root ($mode + '-supervisor.json')) $result
        if (-not $result.actualZero -or $result.exitCode -ne 0 -or $null -ne $result.failure) { break }
    }
} catch {
    $outerFailure = @{ exceptionType = $_.Exception.GetType().Name; hresult = $_.Exception.HResult; message = $_.Exception.Message }
    Write-NewJson (Join-Path $root 'outer-failure.json') $outerFailure
} finally {
    if ($null -ne $parentScope) { ([IDisposable]$parentScope).Dispose() }
}
$total = 0L
foreach ($file in Get-ChildItem -LiteralPath $root -File -Recurse) { $total += $file.Length }
if ($null -ne $siblingPath -and (Test-Path -LiteralPath $siblingPath)) { foreach ($file in Get-ChildItem -LiteralPath $siblingPath -File -Recurse) { $total += $file.Length } }
$passed = $null -eq $outerFailure -and $results.Count -eq 2 -and @($results | Where-Object { -not $_.actualZero -or $_.exitCode -ne 0 -or $null -ne $_.failure }).Count -eq 0 -and $total -lt (1048576 - 16384)
Write-NewJson (Join-Path $root 'summary.json') @{ status = $(if ($passed) { 'PASS' } else { 'FAIL' }); totalBytesBeforeSummary = $total; reportReserveBytes = 16384; withinBudget = ($total -lt (1048576 - 16384)); results = @($results); outerFailure = $outerFailure; productExecuted = $false; failedProfileDataRead = $false; ownerMarkerRead = ($null -ne $siblingPath); primitiveFeasibilityOnly = $true }
Write-Output $id
if (-not $passed) { exit 1 }
