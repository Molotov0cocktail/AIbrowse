[CmdletBinding()]
param([Parameter(Mandatory)][string]$BaselineSource)

# Author-maintained MSAA fixture adaptation; this run is not independent review.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$evidenceRoot = Join-Path $repository 'log/stage7-e2/native-save-button-completion-001/archive-author-regression'
$runRoot = Join-Path $evidenceRoot ('r-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
[void][IO.Directory]::CreateDirectory($runRoot)
$priorRepository = $env:AIBROWSE_PROFILE_TOOL_REPOSITORY
Add-Type -Path (Join-Path $PSScriptRoot 'DisposableProfile.cs'), (Join-Path $PSScriptRoot 'ProfileIsolation.cs'), (Join-Path $PSScriptRoot 'JobProcess.cs')
$loaderType = [AIbrowse.ReleaseProfile.DisposableProfile].GetNestedType('CompletedArchiveEvidence', [Reflection.BindingFlags]::NonPublic)
$loader = $loaderType.GetConstructor([Reflection.BindingFlags]'Instance,NonPublic', $null, [type[]]@([string]), $null)
$results = [Collections.Generic.List[object]]::new()
$sourcePaths = @(
    'tools/data-qualification/product-transfer/run.ts',
    'tools/data-qualification/product-transfer/ui-driver.ps1',
    'tools/data-qualification/product-transfer/NativeSaveControl.cs',
    'tools/data-qualification/product-transfer/NativeSaveButton.cs',
    'tools/data-qualification/product-transfer/job-budget.ps1',
    'tools/data-qualification/product-transfer/JobBudget.cs',
    'tools/data-qualification/product-transfer/backup-evidence.ts',
    'tools/release-profile/disposable-profile.ps1',
    'tools/release-profile/DisposableProfile.cs',
    'tools/release-profile/ProfileIsolation.cs',
    'tools/release-profile/JobProcess.cs',
    'tools/release-profile/ReleaseDataIdentity.cs',
    'tools/release/ProductWindow.cs',
    'tools/release/package-policy.ts',
    'tools/release/profile-isolation-policy.ts',
    'tools/release/process-identity-probe.ts'
)

function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Write-Json([string]$Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 30 -Compress), [Text.UTF8Encoding]::new($false))
}
function Read-Json([string]$Path) { [IO.File]::ReadAllText($Path) | ConvertFrom-Json -AsHashtable }
function Clone($Value) { $Value | ConvertTo-Json -Depth 30 -Compress | ConvertFrom-Json -AsHashtable }
function Record([string]$Name, [bool]$Pass, $Details = $null) {
    $results.Add(@{ name = $Name; pass = $Pass; details = $Details })
    Write-Json (Join-Path $runRoot 'results.json') @{ ok = @($results | Where-Object { -not $_.pass }).Count -eq 0; cases = $results.ToArray(); actualArchive = $false; actualKnownFolder = $false; actualProduct = $false }
}
function Assert([string]$Name, [bool]$Pass) {
    Record $Name $Pass
    if (-not $Pass) { throw ('独立检查失败：' + $Name) }
}
function Make-Fixture {
    $syntheticRoot = Join-Path $runRoot ('s-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    $id = [Guid]::NewGuid().ToString('N')
    $journal = Join-Path $syntheticRoot ('log/stage7-e1/disposable-profile/journal-' + $id)
    $reportRoot = Join-Path $journal 'runner-output/product-transfer'
    $packageRoot = Join-Path $syntheticRoot 'candidate'
    $publication = Join-Path $reportRoot 'published'
    foreach ($folder in @($publication, (Join-Path $packageRoot 'resources/lifecycle-guardian'))) { [void][IO.Directory]::CreateDirectory($folder) }
    $sources = [ordered]@{}
    foreach ($source in $sourcePaths) {
        $path = Join-Path $syntheticRoot $source
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
        [IO.File]::WriteAllText($path, '独立合成来源 ' + $source)
        $sources[$source] = Hash $path
    }
    foreach ($file in @('AIbrowse.exe', 'resources/app.asar', 'resources/lifecycle-guardian/guardian.exe')) { [IO.File]::WriteAllText((Join-Path $packageRoot $file), '独立合成包字节 ' + $file) }
    $executable = Join-Path $packageRoot 'AIbrowse.exe'
    $profilePath = Join-Path $syntheticRoot 'synthetic-profile'
    $identity = @{ Requested = $profilePath; FinalDos = '\\?\' + $profilePath; FinalGuid = 'synthetic-guid'; FinalNt = 'synthetic-nt'; FileId128 = 'A' * 32; VolumeSerial64 = 'B' * 16; Sddl = 'synthetic-acl'; FileSystem = 'NTFS'; Attributes = 16 }
    $manifest = @{ Version = 2; RunId = $id; DeclaredProfile = $profilePath; ResolvedProfile = $profilePath; PackageExecutable = $executable; BindingJournal = ''; RootIdentity = $identity }
    $terminal = @{ version = 1; runId = $id; ok = $true; result = 0; jobReleased = $true; markerValidated = $true; failureType = ''; failureMessage = '' }
    $profile = @{ version = 2; runId = $id; syntheticFileId = $identity.FileId128; nodeView = @{ declared = @{ dev = '42'; ino = '123' }; resolved = @{ dev = '42'; ino = '123' } } }
    $limits = @{ runnerMs = 480000; outerJobMs = 600000; outerExitMs = 30000; uiMs = 30000; jobProcesses = 24; main = 1; guardian = 1; chromium = 16; utilityIncludingChromiumService = 2; toolProcesses = 4 }
    $package = @{ packageRoot = $packageRoot; executable = 'AIbrowse.exe'; asar = 'resources/app.asar'; executableSha256 = Hash $executable; asarSha256 = Hash (Join-Path $packageRoot 'resources/app.asar'); asarHeaderSha256 = 'c' * 64; integrityResource = @{ file = 'resources\app.asar'; alg = 'sha256'; value = 'c' * 64 }; fuseVersion = '1'; files = @('package.json'); rendererAssets = @(); externalPackages = @(); guardianSha256 = Hash (Join-Path $packageRoot 'resources/lifecycle-guardian/guardian.exe') }
    $rawProcess = @{ version = 1; runId = $id; pid = 200; label = 'ProductOriginal'; processCreatedFileTime = '134049216000000007'; imagePath = $executable; packageStatus = 15700; packageFullName = ''; probeRootFileId128 = $identity.FileId128; probeRootVolumeSerial64 = $identity.VolumeSerial64 }
    $product = Clone $rawProcess
    [void]$product.Remove('version'); [void]$product.Remove('runId')
    $backupFile = Join-Path $publication 'product-backup.aibak'
    $members = @()
    $schemas = @(1, 1, 5, 1)
    $ids = @('sources', 'research', 'watch', 'conversations')
    for ($i = 0; $i -lt 4; $i++) { $members += [ordered]@{ id = $ids[$i]; present = $false; schemaVersion = $schemas[$i]; bytes = 0; sha256 = $null } }
    $snapshot = '321ed023-39da-4a86-bc1c-06934f5b4143'
    $wire = [Text.Encoding]::UTF8.GetBytes(([ordered]@{ formatVersion = 1; productVersion = '0.1.0'; snapshotId = $snapshot; members = $members } | ConvertTo-Json -Depth 10 -Compress))
    $bytes = [byte[]]::new(16 + $wire.Length + 232)
    [Text.Encoding]::ASCII.GetBytes('AIBAK001').CopyTo($bytes, 0)
    $bytes[11] = 1
    $length = [BitConverter]::GetBytes([uint32]$wire.Length); [Array]::Reverse($length); $length.CopyTo($bytes, 12); $wire.CopyTo($bytes, 16)
    $uuid = [Convert]::FromHexString($snapshot.Replace('-', ''))
    for ($i = 0; $i -lt 4; $i++) { $offset = 16 + $wire.Length + 58 * $i; $bytes[$offset] = $i + 1; $uuid.CopyTo($bytes, $offset + 2) }
    [IO.File]::WriteAllBytes($backupFile, $bytes)
    $backup = @{ bytes = $bytes.Length; sha256 = Hash $backupFile; snapshotId = $snapshot; productVersion = '0.1.0'; members = $members }
    $job = @{ version = 1; hardTotalLimit = 24; limitFlags = 8200; sampledCounts = @{ main = 0; guardian = 0; chromium = 0; utility = 0; tools = 2 }; total = 2; identities = @(@{ Pid = 300; CreatedFileTime = [long]134049216000000007; Image = 'C:\synthetic\node.exe' }, @{ Pid = 400; CreatedFileTime = [long]134049216000000019; Image = 'C:\synthetic\pwsh.exe' }) }
    $nodes = @(
        @{ index = 0; parent = -1; relation = 'ancestor'; automationIdClass = 'empty'; controlTypeClass = 'window'; windowClass = 'dialog'; sameProcess = $true; enabled = $true; offscreen = $false; valuePattern = $false; readOnly = $null },
        @{ index = 1; parent = 0; relation = 'host'; automationIdClass = 'file-name-control-host'; controlTypeClass = 'pane'; windowClass = 'file-name-control-host'; sameProcess = $true; enabled = $true; offscreen = $false; valuePattern = $false; readOnly = $null },
        @{ index = 2; parent = 1; relation = 'descendant'; automationIdClass = 'id-1001'; controlTypeClass = 'pane'; windowClass = 'edit'; sameProcess = $true; enabled = $true; offscreen = $false; valuePattern = $false; readOnly = $null }
    )
    $dialog = @{ version = 1; action = 'InspectSaveDialog'; ok = $true; phase = 'identity'; elapsedMs = 21; filenameHostStructure = @{ version = 1; status = 'complete'; scannedNodes = 90; hostCount = 1; ancestorCount = 1; descendantCount = 1; nodes = $nodes }; filenameNativeSelection = @{ status = 'uia-bound'; candidates = 1; nativeHandlePresent = $true }; filenameInitialValueClass = 'exact-default'; dialog = @{ hwnd = 440; owner = 880; processId = 200; filenameIdClass = 'id-1001'; filenameControlType = 'native-edit'; saveName = '保存(&S)'; cancelName = '取消'; mechanism = 'Win32 fixed text / MSAA default action' } }
    $saveProof = @{ version = 1; mechanism = 'MSAA CHILDID_SELF'; controlId = 1; nameClass = 'save'; hresult = 0; role = 43; available = $true; visible = $true; defaultActionPresent = $true; nativeIdentityVerified = $true }
    $cancelProof = $saveProof.Clone(); $cancelProof.controlId = 2; $cancelProof.nameClass = 'cancel'
    $dialog.dialog.saveButton = $saveProof; $dialog.dialog.cancelButton = $cancelProof
    $cancel = $dialog | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable; $cancel.action = 'CancelSave'; $cancel.buttonAction = $cancelProof.Clone()
    $save = $dialog | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable; $save.action = 'SaveBackup'; $save.buttonAction = $saveProof.Clone()
    $nonClaims = @('完整容量', '恢复确认与重启', '独立机器', 'SQLite业务语义', '真实Provider')
    $launch = @{ version = 1; scenario = 'small-backup-cancel-save-readback'; ok = $false; limits = $limits; nonClaims = $nonClaims; profile = $profile; toolSources = $sources; package = $package; phase = 'package'; productArguments = @('--force-renderer-accessibility'); environmentOverrides = @(); providerCalls = 0 }
    $reportJob = Clone $job
    foreach ($item in $reportJob.identities) { $item.CreatedFileTime = [double]$item.CreatedFileTime }
    $report = @{ version = 1; scenario = 'small-backup-cancel-save-readback'; ok = $true; limits = $limits; nonClaims = $nonClaims; profile = $profile; toolSources = $sources; package = $package; product = $product; dialogQualification = $dialog; cancelAction = $cancel; saveAction = $save; backup = $backup; finalJobSample = $reportJob; phase = 'exit'; elapsedMs = 75000.4; productExited = $true; productExitCode = 0; pendingOriginals = @(); unconfirmedChildren = 0; requiresOuterTerminal = $true }
    Write-Json (Join-Path $journal 'manifest.json') $manifest
    Write-Json (Join-Path $journal 'terminal.json') $terminal
    Write-Json (Join-Path $journal 'runner-output/process-ProductOriginal-200.json') $rawProcess
    Write-Json (Join-Path $reportRoot 'launch-contract.json') $launch
    Write-Json (Join-Path $reportRoot 'report.json') $report
    Write-Json (Join-Path $reportRoot 'backup-readback.json') $backup
    Write-Json (Join-Path $reportRoot 'job-18.json') $job
    Write-Json (Join-Path $reportRoot 'ui-4-InspectSaveDialog.json') $dialog
    Write-Json (Join-Path $reportRoot 'ui-6-CancelSave.json') $cancel
    Write-Json (Join-Path $reportRoot 'ui-12-SaveBackup.json') $save
    return @{ repo = $syntheticRoot; journal = $journal; reportRoot = $reportRoot; packageRoot = $packageRoot; backup = $backupFile; report = $report; dialog = $dialog; launch = $launch; job = $job; manifest = $manifest }
}
function Load($Fixture) {
    $env:AIBROWSE_PROFILE_TOOL_REPOSITORY = $Fixture.repo
    $loader.Invoke([object[]]@([string]$Fixture.journal))
}
function Reject([string]$Name, [scriptblock]$Mutate) {
    $fixture = Make-Fixture
    & $Mutate $fixture
    $accepted = $false
    $failureClass = ''
    try { $lease = Load $fixture; $accepted = $true; ([IDisposable]$lease).Dispose() } catch { $failureClass = $_.Exception.GetBaseException().GetType().FullName }
    Record $Name (-not $accepted) @{ fixture = $fixture.journal; accepted = $accepted; failureClass = $failureClass }
    Assert ($Name + '-no-intent') (-not (Test-Path -LiteralPath (Join-Path $fixture.journal 'archive-intent.json')))
    foreach ($path in @((Join-Path $fixture.journal 'manifest.json'), $fixture.backup)) {
        $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); $stream.Dispose()
    }
    Assert ($Name + '-handles-released') $true
}
function Write-Dialog($Fixture) {
    Write-Json (Join-Path $Fixture.reportRoot 'ui-4-InspectSaveDialog.json') $Fixture.dialog
    $Fixture.report.dialogQualification = $Fixture.dialog
    Write-Json (Join-Path $Fixture.reportRoot 'report.json') $Fixture.report
}

try {
    $candidatePaths = @('tools/release-profile/DisposableProfile.cs', 'tools/release-profile/README.md', 'tools/release-profile/test-product-completed-archive.ps1')
    Write-Json (Join-Path $runRoot 'source-hashes.json') @($candidatePaths + $sourcePaths | Sort-Object -Unique | ForEach-Object { @{ path = $_; sha256 = Hash (Join-Path $repository $_) } })
    $runText = [IO.File]::ReadAllText((Join-Path $repository 'tools/data-qualification/product-transfer/run.ts'))
    $block = [regex]::Match($runText, '(?s)const paths = \[(.*?)\];').Groups[1].Value
    $actualSources = @([regex]::Matches($block, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value })
    Assert 'runner-source-set-and-order' (($actualSources -join '|') -ceq ($sourcePaths -join '|'))
    $source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'DisposableProfile.cs')).Replace("`r`n", "`n")
    $before = [IO.File]::ReadAllText($BaselineSource).Replace("`r`n", "`n")
    foreach ($method in @('ArchiveTransition', 'ArchiveFailedRun')) {
        $startPattern = if ($method -eq 'ArchiveTransition') { '        private static ArchiveTransitionResult ArchiveTransition(' } else { '        public static string ArchiveFailedRun(' }
        $startBefore = $before.IndexOf($startPattern); $startAfter = $source.IndexOf($startPattern)
        $endBefore = $before.IndexOf("`n        public static ", $startBefore + $startPattern.Length)
        $endAfter = $source.IndexOf("`n        public static ", $startAfter + $startPattern.Length)
        Assert ($method + '-unchanged') ($before.Substring($startBefore, $endBefore - $startBefore) -ceq $source.Substring($startAfter, $endAfter - $startAfter))
    }
    $positive = Make-Fixture
    $lease = Load $positive
    try {
        Assert 'independent-real-shape-positive' ($null -ne $lease)
        Assert 'product-branch-kind' ($loaderType.GetProperty('Kind', [Reflection.BindingFlags]'Instance,NonPublic').GetValue($lease) -ceq 'completed-product-transfer-small-backup')
        foreach ($path in @((Join-Path $positive.journal 'terminal.json'), $positive.backup, (Join-Path $positive.packageRoot 'AIbrowse.exe'), (Join-Path $positive.repo 'tools/release-profile/DisposableProfile.cs'))) {
            $refused = $false
            try { $test = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite); $test.Dispose() } catch { $refused = $true }
            Assert 'read-lease-denies-writer' $refused
        }
        $budget = $loaderType.GetField('readBudget', [Reflection.BindingFlags]'Instance,NonPublic').GetValue($lease)
        $budget.Stop()
        [Diagnostics.Stopwatch].GetField('_elapsed', [Reflection.BindingFlags]'Instance,NonPublic').SetValue($budget, [long](150 * [Diagnostics.Stopwatch]::Frequency))
        $refused = $false
        try { [void]$loaderType.GetMethod('VerifyBeforeTransition', [Reflection.BindingFlags]'Instance,NonPublic').Invoke($lease, @()) } catch { $refused = $true }
        Assert 'exact-150-seconds-denies-intent' $refused
    } finally { ([IDisposable]$lease).Dispose() }
    Reject 'terminal-null-exit' { param($f) $t = Read-Json (Join-Path $f.journal 'terminal.json'); $t.result = $null; Write-Json (Join-Path $f.journal 'terminal.json') $t }
    Reject 'terminal-wrong-run' { param($f) $t = Read-Json (Join-Path $f.journal 'terminal.json'); $t.runId = '0' * 32; Write-Json (Join-Path $f.journal 'terminal.json') $t }
    Reject 'report-unsettled-work' { param($f) $f.report.pendingOriginals = @('unfinished'); Write-Json (Join-Path $f.reportRoot 'report.json') $f.report }
    Reject 'process-creation-string-differs' { param($f) $f.report.product.processCreatedFileTime = '134049216000000008'; Write-Json (Join-Path $f.reportRoot 'report.json') $f.report }
    Reject 'raw-dialog-report-mismatch' { param($f) $f.dialog.dialog.owner = 990; Write-Json (Join-Path $f.reportRoot 'ui-4-InspectSaveDialog.json') $f.dialog }
    Reject 'raw-job-total-mismatch' { param($f) $f.job.total = 3; Write-Json (Join-Path $f.reportRoot 'job-18.json') $f.job }
    Reject 'source-self-byte-tamper' { param($f) [IO.File]::AppendAllText((Join-Path $f.repo 'tools/release-profile/DisposableProfile.cs'), 'tamper') }
    Reject 'guardian-byte-tamper' { param($f) [IO.File]::AppendAllText((Join-Path $f.packageRoot 'resources/lifecycle-guardian/guardian.exe'), 'tamper') }
    Reject 'backup-byte-tamper' { param($f) [IO.File]::AppendAllText($f.backup, 'tamper') }
    Reject 'mixed-tamper-file' { param($f) [IO.File]::WriteAllText((Join-Path $f.journal 'tamper-binding.json'), '{}') }
    Reject 'additional-report-directory' { param($f) [void][IO.Directory]::CreateDirectory((Join-Path $f.journal 'runner-output/run-1')) }
    Reject 'duplicate-nested-property' { param($f) $p = Join-Path $f.reportRoot 'report.json'; $s = [IO.File]::ReadAllText($p); [IO.File]::WriteAllText($p, $s.Replace('"runnerMs":480000', '"runnerMs":480000,"runnerMs":480000')) }
    Reject 'metadata-hardlink' { param($f) New-Item -ItemType HardLink -Path (Join-Path $f.journal 'manifest-link') -Target (Join-Path $f.journal 'manifest.json') | Out-Null }
    Reject 'package-hardlink' { param($f) New-Item -ItemType HardLink -Path (Join-Path $f.repo 'asar-link') -Target (Join-Path $f.packageRoot 'resources/app.asar') | Out-Null }
    Reject 'backup-hardlink' { param($f) New-Item -ItemType HardLink -Path (Join-Path $f.reportRoot 'backup-link') -Target $f.backup | Out-Null }
    Reject 'dialog-selection-with-no-candidate' { param($f) $f.dialog.filenameHostStructure.nodes[2].automationIdClass = 'other'; Write-Dialog $f }
    Reject 'dialog-input-outside-host-subtree' { param($f) $f.dialog.filenameHostStructure.nodes[2].parent = 0; Write-Dialog $f }
    Reject 'dialog-candidate-wrong-process' { param($f) $f.dialog.filenameHostStructure.nodes[2].sameProcess = $false; Write-Dialog $f }
    Reject 'dialog-candidate-disabled' { param($f) $f.dialog.filenameHostStructure.nodes[2].enabled = $false; Write-Dialog $f }
    Reject 'dialog-candidate-offscreen' { param($f) $f.dialog.filenameHostStructure.nodes[2].offscreen = $true; Write-Dialog $f }
    Reject 'dialog-host-with-wrong-class' { param($f) $f.dialog.filenameHostStructure.nodes[1].automationIdClass = 'other'; Write-Dialog $f }
    $failures = @($results | Where-Object { -not $_.pass })
    Write-Output ('历史独审断言的作者回归：' + $results.Count + '项，失败' + $failures.Count + '；' + $runRoot)
    if ($failures.Count -gt 0) { throw '发现可复现的准入反例；保留现场并要求修复' }
} finally {
    $env:AIBROWSE_PROFILE_TOOL_REPOSITORY = $priorRepository
}
