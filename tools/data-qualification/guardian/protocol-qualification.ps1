[CmdletBinding()]
param([switch]$BuildOnly, [ValidatePattern('^$|^guardian-protocol-[a-f0-9]{32}$')][string]$PreparedId = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (($BuildOnly -and $PreparedId -ne '') -or (-not $BuildOnly -and $PreparedId -eq '')) { throw '明确选择BuildOnly或PreparedId' }
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$expectedNative = '2276d8adef3405f485257d21f297aebe6dc8897763b38b0435fe9d6cbd43811e'
$expectedHelper = 'c38a902a83fe417a29579af6f1a03e59a41c4c8b22240928cd6f513f892bce53'
$helperSource = Join-Path $repository 'log/stage7-e2/guardian-publish-f4e945f1a6a943d3999645341999ed45/guardian-candidate.exe'
$sources = @('native/lifecycle-guardian/Guardian.cs', 'tools/release-profile/JobProcess.cs', 'tools/data-qualification/guardian/ProtocolObservation.cs', 'tools/data-qualification/guardian/protocol-host.ts', 'tools/data-qualification/guardian/protocol-qualification.ps1')
$modes = @('healthy', 'successor', 'receipt-empty-ads', 'tmp-collision')
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function New-Json([string]$Path, [object]$Value) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 14))
    if ($bytes.Length -gt 65536) { throw '协议单报告超预算' }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Exact-Replace([string]$Source, [string]$Before, [string]$After) {
    $at = $Source.IndexOf($Before, [StringComparison]::Ordinal)
    if ($at -lt 0 -or $Source.IndexOf($Before, $at + 1, [StringComparison]::Ordinal) -ge 0) { throw '协议监督器派生边界改变' }
    $Source.Replace($Before, $After)
}
function Contained([string]$Scope, [string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -cne $Path -or -not $full.StartsWith($Scope + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '协议路径越出自有scope' }
}
if ((Hash (Join-Path $repository $sources[0])) -cne $expectedNative) { throw '产品native冻结失配' }
if ($BuildOnly) {
    if ((Hash $helperSource) -cne $expectedHelper) { throw '私有未插桩helper绑定失配' }
    $id = 'guardian-protocol-' + [Guid]::NewGuid().ToString('N')
    $root = Join-Path $repository ('log/stage7-e2/' + $id)
    if (Test-Path -LiteralPath $root) { throw '协议scope碰撞' }
    $job = [IO.File]::ReadAllText((Join-Path $repository 'tools/release-profile/JobProcess.cs'))
    $job = Exact-Replace $job 'ExtendedLimits limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } };' 'ExtendedLimits limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2008, ActiveProcessLimit = 6 } };'
    $anchor = 'private static string Name(string runId)'
    $job = Exact-Replace $job $anchor ('[DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")] private static extern bool QueryBudget(SafeFileHandle job, int type, out ExtendedLimits value, uint length, IntPtr returned);' + "`n        " + $anchor)
    $anchor = 'if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>())) throw new Win32Exception(Marshal.GetLastWin32Error());'
    $job = Exact-Replace $job $anchor ($anchor + "`n                " + 'if (!QueryBudget(job, 9, out ExtendedLimits actualBudget, (uint)Marshal.SizeOf<ExtendedLimits>(), IntPtr.Zero) || actualBudget.Basic.Flags != 0x2008 || actualBudget.Basic.ActiveProcessLimit != 6) throw new InvalidOperationException("协议Job预算读回失败");')
    # Compile in memory first; no process or Job is created during preparation.
    $observationSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'ProtocolObservation.cs'))
    $usingPattern = '(?m)^using [^;\r\n]+;\r?\n'
    $usingLines = [regex]::Matches(($job + "`n" + $observationSource), $usingPattern).Value | Sort-Object -Unique
    $compilation = ($usingLines -join '') + [regex]::Replace($job, $usingPattern, '') + "`n" + [regex]::Replace($observationSource, $usingPattern, '')
    Add-Type -TypeDefinition $compilation -ErrorAction Stop
    $parentPins = [AIbrowse.GuardianQualification.ProtocolObservation]::Pin((Join-Path $repository 'log/stage7-e2'))
    try {
        [IO.Directory]::CreateDirectory($root) | Out-Null
        $scopePins = [AIbrowse.GuardianQualification.ProtocolObservation]::Pin($root)
        try {
            [IO.File]::WriteAllText((Join-Path $root 'ProtocolJobProcess.cs'), $job, [Text.UTF8Encoding]::new($false))
            [IO.File]::Copy($helperSource, (Join-Path $root 'guardian.exe'), $false)
            foreach ($source in $sources) {
                $name = if ($source -eq 'tools/data-qualification/guardian/protocol-host.ts') { 'protocol-host.ts' } else { 'source-' + [IO.Path]::GetFileName($source) }
                [IO.File]::Copy((Join-Path $repository $source), (Join-Path $root $name), $false)
            }
            $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
            $artifacts = @('ProtocolJobProcess.cs', 'guardian.exe', 'source-Guardian.cs', 'source-JobProcess.cs', 'source-ProtocolObservation.cs', 'protocol-host.ts', 'source-protocol-qualification.ps1')
            New-Json (Join-Path $root 'binding.json') ([ordered]@{ version=1; id=$id; nativeSha256=$expectedNative; helperSha256=$expectedHelper; node=$node; nodeSha256=(Hash $node); modes=$modes; workMs=15000; exitMs=30000; activeProcessLimit=6; maximumHosts=4; totalWorkMs=60000; dataBytes=131072; totalBytes=1048576; sources=@($sources | ForEach-Object { @{ path=$_; sha256=(Hash (Join-Path $repository $_)) } }); artifacts=@($artifacts | ForEach-Object { @{ path=$_; sha256=(Hash (Join-Path $root $_)) } }); preparedOnly=$true; productMainExecuted=$false })
        } finally { $scopePins.Dispose() }
    } finally { $parentPins.Dispose() }
    Write-Output $id
    return
}
$id = $PreparedId
$root = Join-Path $repository ('log/stage7-e2/' + $id)
$binding = Get-Content -LiteralPath (Join-Path $root 'binding.json') -Raw | ConvertFrom-Json
if ($binding.id -cne $id -or $binding.version -ne 1 -or $binding.nativeSha256 -cne $expectedNative -or $binding.helperSha256 -cne $expectedHelper -or $binding.workMs -ne 15000 -or $binding.exitMs -ne 30000 -or $binding.activeProcessLimit -ne 6 -or $binding.maximumHosts -ne 4 -or $binding.totalWorkMs -ne 60000 -or $binding.dataBytes -ne 131072 -or $binding.totalBytes -ne 1048576 -or ($binding.modes -join '|') -cne ($modes -join '|')) { throw '协议合同绑定改变' }
foreach ($entry in $binding.sources) { if ((Hash (Join-Path $repository $entry.path)) -cne $entry.sha256) { throw '协议工具源码改变' } }
foreach ($entry in $binding.artifacts) { Contained $root (Join-Path $root $entry.path); if ((Hash (Join-Path $root $entry.path)) -cne $entry.sha256) { throw '协议制品改变' } }
if ((Hash $binding.node) -cne $binding.nodeSha256) { throw '固定Node映像改变' }
Add-Type -Path (Join-Path $root 'ProtocolJobProcess.cs'), (Join-Path $root 'source-ProtocolObservation.cs')
$scopePins = [AIbrowse.GuardianQualification.ProtocolObservation]::Pin($root)
$results = [Collections.Generic.List[object]]::new()
$failed = $null
$workTotal = 0.0
$hostsStarted = 0
$hostsFinished = 0
try {
    New-Json (Join-Path $root 'claim.json') @{ id=$id; modes=$modes; maximumHosts=4; noRetry=$true; utc=[DateTime]::UtcNow.ToString('o') }
    foreach ($mode in $modes) {
        $data = Join-Path $root ('data-' + $(if ($mode -eq 'successor') { 'healthy' } else { $mode }))
        $evidence = Join-Path $root ('run-' + $mode)
        Contained $root $data; Contained $root $evidence
        if ($mode -eq 'successor') { if (-not (Test-Path -LiteralPath $data -PathType Container)) { throw '后继缺已验证原根' } }
        elseif (Test-Path -LiteralPath $data) { throw '新场景数据根碰撞' }
        if (Test-Path -LiteralPath $evidence) { throw '协议运行原件碰撞' }
        [IO.Directory]::CreateDirectory($data) | Out-Null
        [IO.Directory]::CreateDirectory($evidence) | Out-Null
        $dataPins = [AIbrowse.GuardianQualification.ProtocolObservation]::Pin($data)
        $evidencePins = [AIbrowse.GuardianQualification.ProtocolObservation]::Pin($evidence)
        $clock = [Diagnostics.Stopwatch]::StartNew()
        try {
            $nonce = [Guid]::NewGuid().ToString('N'); $jobId = [Guid]::NewGuid().ToString('N')
            New-Json (Join-Path $evidence 'plan.json') @{ mode=$mode; nonce=$nonce; jobId=$jobId; dataRoot=$data; evidenceRoot=$evidence; workMs=15000; exitMs=30000; activeProcessLimit=6 }
            $hostsStarted++
            $observed = [AIbrowse.GuardianQualification.ProtocolObservation]::Execute($binding.node, (Join-Path $root 'protocol-host.ts'), (Join-Path $root 'guardian.exe'), $data, $evidence, $mode, $nonce, $jobId)
            $hostsFinished++
            New-Json (Join-Path $evidence 'observation.json') $observed
            $healthy = $mode -eq 'healthy' -or $mode -eq 'successor'
            $ledgerPath = Join-Path $data 'lifecycle-guardian/writers.json'
            $after = [AIbrowse.GuardianQualification.ProtocolObservation]::Inspect($ledgerPath)
            $raw = [IO.File]::ReadAllText((Join-Path $evidence 'guardian-stdout.txt'), [Text.Encoding]::ASCII)
            $expected = '1|' + $nonce + '|0|ready' + "`n"
            if ($healthy) {
                $last = if ($mode -eq 'healthy') { 3 } else { 1 }
                for ($sequence=1; $sequence -le $last; $sequence++) { $expected += '1|' + $nonce + '|' + $sequence + '|ok' + "`n" }
            }
            $marker = Join-Path $data 'authorized-marker'
            $temporary = $ledgerPath + '.tmp'
            $ledger = Get-Content -LiteralPath $ledgerPath -Raw | ConvertFrom-Json
            $expectedRoles = if ($mode -eq 'successor') { 'main|guardian' } else { 'main|guardian|utility' }
            $processesMatch = ($observed.Processes.Role -join '|') -ceq $expectedRoles
            foreach ($process in $observed.Processes) {
                $expectedExit = if ($healthy) { 0 } elseif ($process.Role -eq 'guardian') { 2 } else { 91 }
                if (-not $process.Signaled -or $process.ExitCode -ne $expectedExit) { $processesMatch = $false }
            }
            $passed = $observed.ActualZero -and $null -eq $observed.Failure -and $observed.HostExit -eq $(if ($healthy) { 0 } else { 91 }) -and $processesMatch -and $raw -ceq $expected
            if ($healthy) {
                $passed = $passed -and $null -eq $ledger.main -and $null -eq $ledger.utility -and -not (Test-Path -LiteralPath $temporary) -and (Test-Path -LiteralPath (Join-Path $evidence 'host-complete.json'))
                $passed = $passed -and [IO.File]::ReadAllText($marker) -ceq '已授权'
            } else {
                $passed = $passed -and -not (Test-Path -LiteralPath $marker) -and (Test-Path -LiteralPath (Join-Path $evidence 'armed.json')) -and $null -ne $observed.Before -and $observed.Before.identity -ceq $after.identity -and $observed.Before.hash -ceq $after.hash
                if ($mode -eq 'tmp-collision') { $passed = $passed -and (Test-Path -LiteralPath $temporary) -and (Get-Item -LiteralPath $temporary).Length -eq 0 }
                else { $passed = $passed -and -not (Test-Path -LiteralPath $temporary) -and (Get-Item -LiteralPath $ledgerPath -Stream 'qualification-empty').Length -eq 0 }
            }
            $dataBytes = 0L
            foreach ($dataPath in Get-ChildItem -LiteralPath $root -Directory -Filter 'data-*') { foreach ($file in Get-ChildItem -LiteralPath $dataPath.FullName -File -Recurse) { $dataBytes += $file.Length } }
            $total = (Get-ChildItem -LiteralPath $root -File -Recurse | Measure-Object -Property Length -Sum).Sum
            $passed = $passed -and $dataBytes -le 131072 -and $total -lt (1048576 - 32768)
            $record = [ordered]@{ mode=$mode; passed=[bool]$passed; jobId=$jobId; observation=$observed; final=$after; rawFramesExact=($raw -ceq $expected); zeroAuthorizeAck=(-not $healthy -and $raw -ceq $expected); dataBytes=$dataBytes; totalBytesBeforeResult=$total; elapsedMs=$clock.Elapsed.TotalMilliseconds }
            New-Json (Join-Path $evidence 'result.json') $record
            $results.Add($record)
            if (-not $passed) { throw '协议场景oracle失败，停止后续场景' }
        } finally { $evidencePins.Dispose(); $dataPins.Dispose(); $workTotal += $clock.Elapsed.TotalMilliseconds }
        if ($clock.ElapsedMilliseconds -ge 15000 -or $workTotal -ge 60000) { throw '协议场景最后IO或累计工作跨期' }
    }
} catch { $failed = $_.Exception.Message }
finally { $scopePins.Dispose() }
New-Json (Join-Path $root 'summary.json') ([ordered]@{ version=1; id=$id; passed=($null -eq $failed -and $results.Count -eq 4); failure=$failed; hostsStarted=$hostsStarted; hostsFinished=$hostsFinished; hostsCompleted=$results.Count; totalWorkMs=$workTotal; results=$results; productMainExecuted=($hostsStarted -gt 0); electronExecuted=$false; profileRead=$false })
Write-Output $id
if ($null -ne $failed -or $results.Count -ne 4) { throw '实际协议资格未通过；全部现场保留' }
