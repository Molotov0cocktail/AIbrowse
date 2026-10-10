[CmdletBinding()]
param([switch]$RedOnly, [string]$BaselineSource = '')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$previousRepository = $env:AIBROWSE_PROFILE_TOOL_REPOSITORY
if ($BaselineSource -ne '' -and -not $RedOnly) { throw '旧源码仅用于甄别红态' }
$archiveSource = if ($BaselineSource -eq '') { Join-Path $PSScriptRoot 'DisposableProfile.cs' } else { [IO.Path]::GetFullPath($BaselineSource) }
Add-Type -Path $archiveSource, (Join-Path $PSScriptRoot 'ProfileIsolation.cs'), (Join-Path $PSScriptRoot 'JobProcess.cs')
$evidence = Join-Path $repository ('log/stage7-e2/product-completed-archive-implementation-001/c-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
[IO.Directory]::CreateDirectory($evidence) | Out-Null
$sourceBlock = [regex]::Match([IO.File]::ReadAllText((Join-Path $repository 'tools/data-qualification/product-transfer/run.ts')), '(?s)const paths = \[(.*?)\];').Groups[1].Value
$sourcePaths = @([regex]::Matches($sourceBlock, "'([^']+)'" ) | ForEach-Object { $_.Groups[1].Value })
if ($sourcePaths.Count -ne 16 -or $sourcePaths -notcontains 'tools/data-qualification/product-transfer/NativeSaveControl.cs') { throw '实际runner来源清单未冻结16项' }
$type = [AIbrowse.ReleaseProfile.DisposableProfile].GetNestedType('CompletedArchiveEvidence', [Reflection.BindingFlags]::NonPublic)
$constructor = $type.GetConstructor([Reflection.BindingFlags]'Instance,NonPublic', $null, [type[]]@([string]), $null)
$rows = [Collections.Generic.List[object]]::new()
function Write-Json([string]$Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 20 -Compress), [Text.UTF8Encoding]::new($false))
}
function Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Fixture([string]$Fault) {
    $repo = Join-Path $evidence ('r-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    $id = [Guid]::NewGuid().ToString('N')
    $journal = Join-Path $repo ('log/stage7-e1/disposable-profile/journal-' + $id)
    $run = Join-Path $journal 'runner-output/product-transfer'
    $package = Join-Path $repo 'candidate'
    foreach ($path in @($run, (Join-Path $run 'published'), (Join-Path $package 'resources/lifecycle-guardian'))) { [IO.Directory]::CreateDirectory($path) | Out-Null }
    $sources = [ordered]@{}
    foreach ($path in $sourcePaths) {
        $file = Join-Path $repo $path
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file)) | Out-Null
        [IO.File]::WriteAllText($file, 'synthetic-source-' + $path)
        $sources[$path] = Hash $file
    }
    $exe = Join-Path $package 'AIbrowse.exe'; $asar = Join-Path $package 'resources/app.asar'; $guardian = Join-Path $package 'resources/lifecycle-guardian/guardian.exe'
    foreach ($path in @($exe, $asar, $guardian)) { [IO.File]::WriteAllText($path, 'fixed-candidate') }
    $backupPath = Join-Path $run 'published/product-backup.aibak'
    [IO.File]::WriteAllText($backupPath, 'fixed-backup')
    $identity = @{ FileId128 = '1' * 32; VolumeSerial64 = '2' * 16; Sddl = 'synthetic'; FileSystem = 'NTFS'; Attributes = 16; Requested = (Join-Path $repo 'appdata/aibrowse'); FinalDos = (Join-Path $repo 'appdata/aibrowse'); FinalGuid = 'synthetic-guid-view'; FinalNt = 'synthetic-nt-view' }
    $manifest = @{ Version = 2; RunId = $id; BindingJournal = ''; PackageExecutable = $exe; DeclaredProfile = (Join-Path $repo 'appdata/aibrowse'); ResolvedProfile = (Join-Path $repo 'appdata/aibrowse'); RootIdentity = $identity }
    $terminal = @{ version = 1; runId = $id; ok = $true; result = 0; jobReleased = $true; markerValidated = $true; failureType = ''; failureMessage = '' }
    $profile = @{ version = 2; runId = $id; syntheticFileId = $identity.FileId128; nodeView = @{ declared = @{ dev = '1'; ino = '2' }; resolved = @{ dev = '1'; ino = '2' } } }
    $limits = @{ runnerMs = 480000; outerJobMs = 600000; outerExitMs = 30000; uiMs = 30000; jobProcesses = 24; main = 1; guardian = 1; chromium = 16; utilityIncludingChromiumService = 2; toolProcesses = 4 }
    $pack = @{ packageRoot = $package; executable = 'AIbrowse.exe'; asar = 'resources/app.asar'; executableSha256 = (Hash $exe); asarSha256 = (Hash $asar); asarHeaderSha256 = 'c' * 64; guardianSha256 = (Hash $guardian); integrityResource = @{ file = 'resources\app.asar'; alg = 'sha256'; value = 'c' * 64 }; fuseVersion = '1'; files = @('package.json'); rendererAssets = @(); externalPackages = @() }
    $process = @{ version = 1; runId = $id; label = 'ProductOriginal'; pid = 123; processCreatedFileTime = '100001'; imagePath = $exe; packageStatus = 15700; packageFullName = ''; probeRootFileId128 = $identity.FileId128; probeRootVolumeSerial64 = $identity.VolumeSerial64 }
    $product = $process.Clone(); $product.Remove('version'); $product.Remove('runId')
    $members = @(); $names = @('sources', 'research', 'watch', 'conversations'); $schemas = @(1, 1, 5, 1)
    for ($i = 0; $i -lt 4; $i++) { $members += @{ id = $names[$i]; present = $false; schemaVersion = $schemas[$i]; bytes = 0; sha256 = $null } }
    $backup = @{ bytes = (Get-Item -LiteralPath $backupPath).Length; sha256 = (Hash $backupPath); snapshotId = [Guid]::NewGuid().ToString(); productVersion = '0.1.0'; members = $members }
    $job = @{ version = 1; hardTotalLimit = 24; limitFlags = 0x2008; total = 2; sampledCounts = @{ main = 0; guardian = 0; chromium = 0; utility = 0; tools = 2 }; identities = @(@{ Pid = 456; CreatedFileTime = 100001; Image = 'C:\synthetic\node.exe' }, @{ Pid = 789; CreatedFileTime = 100002; Image = 'C:\synthetic\pwsh.exe' }) }
    $nodes = @(
        @{ index = 0; parent = -1; relation = 'ancestor'; automationIdClass = 'empty'; controlTypeClass = 'window'; windowClass = 'dialog'; sameProcess = $true; enabled = $true; offscreen = $false; valuePattern = $false; readOnly = $null },
        @{ index = 1; parent = 0; relation = 'host'; automationIdClass = 'file-name-control-host'; controlTypeClass = 'pane'; windowClass = 'file-name-control-host'; sameProcess = $true; enabled = $true; offscreen = $false; valuePattern = $false; readOnly = $null },
        @{ index = 2; parent = 1; relation = 'descendant'; automationIdClass = 'id-1001'; controlTypeClass = 'edit'; windowClass = 'edit'; sameProcess = $true; enabled = $true; offscreen = $false; valuePattern = $false; readOnly = $null }
    )
    $dialog = @{ version = 1; action = 'InspectSaveDialog'; ok = $true; phase = 'identity'; elapsedMs = 1; filenameInitialValueClass = 'exact-default'; filenameNativeSelection = @{ status = 'uia-bound'; candidates = 1; nativeHandlePresent = $true }; filenameHostStructure = @{ version = 1; status = 'complete'; scannedNodes = 3; hostCount = 1; ancestorCount = 1; descendantCount = 1; nodes = $nodes }; dialog = @{ hwnd = 200; owner = 100; processId = 123; filenameIdClass = 'id-1001'; filenameControlType = 'native-edit'; saveName = 'Save'; cancelName = 'Cancel'; mechanism = 'Win32 fixed text / MSAA default action' } }
    $saveProof = @{ version = 1; mechanism = 'MSAA CHILDID_SELF'; controlId = 1; nameClass = 'save'; hresult = 0; role = 43; available = $true; visible = $true; defaultActionPresent = $true; nativeIdentityVerified = $true }
    $cancelProof = $saveProof.Clone(); $cancelProof.controlId = 2; $cancelProof.nameClass = 'cancel'
    $dialog.dialog.saveButton = $saveProof; $dialog.dialog.cancelButton = $cancelProof
    $cancel = $dialog | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable; $cancel.action = 'CancelSave'; $cancel.buttonAction = $cancelProof.Clone()
    $save = $dialog | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable; $save.action = 'SaveBackup'; $save.buttonAction = $saveProof.Clone()
    $nonClaims = @('完整容量', '恢复确认与重启', '独立机器', 'SQLite业务语义', '真实Provider')
    $launch = @{ version = 1; scenario = 'small-backup-cancel-save-readback'; ok = $false; limits = $limits; nonClaims = $nonClaims; profile = $profile; toolSources = $sources; package = $pack; phase = 'package'; productArguments = @('--force-renderer-accessibility'); environmentOverrides = @(); providerCalls = 0 }
    $report = @{ version = 1; scenario = 'small-backup-cancel-save-readback'; ok = $true; limits = $limits; nonClaims = $nonClaims; profile = $profile; toolSources = $sources; package = $pack; product = $product; dialogQualification = $dialog; cancelAction = $cancel; saveAction = $save; backup = $backup; finalJobSample = $job; phase = 'exit'; elapsedMs = 100; productExited = $true; productExitCode = 0; pendingOriginals = @(); unconfirmedChildren = 0; requiresOuterTerminal = $true }
    switch ($Fault) {
        'terminal-failed' { $terminal.ok = $false; $terminal.result = 1 }
        'terminal-unknown' { $terminal.result = $null }
        'terminal-run' { $terminal.runId = [Guid]::NewGuid().ToString('N') }
        'terminal-job' { $terminal.jobReleased = $false }
        'terminal-marker' { $terminal.markerValidated = $false }
        'manifest-version' { $manifest.Remove('Version') }
        'manifest-binding-missing' { $manifest.Remove('BindingJournal') }
        'manifest-root' { $manifest.RootIdentity = $null }
        'manifest-root-missing' { $manifest.Remove('RootIdentity') }
        'manifest-root-field-missing' { $identity.Remove('FileSystem') }
        'manifest-root-reparse' { $identity.Attributes = 0x410 }
        'mixed-binding' { $manifest.BindingJournal = Join-Path $repo ('log/stage7-e1/disposable-profile/journal-' + [Guid]::NewGuid().ToString('N')) }
        'mixed-tamper-file' { [IO.File]::WriteAllText((Join-Path $journal 'tamper-binding.json'), '{}') }
        'second-directory' { [IO.Directory]::CreateDirectory((Join-Path $journal 'runner-output/run-1')) | Out-Null }
        'scenario' { $report.scenario = 'unknown' }
        'report-failed' { $report.ok = $false }
        'report-phase' { $report.phase = 'readback' }
        'report-exit' { $report.productExitCode = $null }
        'report-pending' { $report.pendingOriginals = @('late-io') }
        'report-child' { $report.unconfirmedChildren = 1 }
        'report-failure' { $report.failure = 'hidden failure' }
        'report-limit' { $limits.jobProcesses = 25 }
        'launch-override' { $launch.environmentOverrides = @('AIBROWSE_ANY') }
        'profile-run' { $profile.runId = [Guid]::NewGuid().ToString('N') }
        'profile-node' { $profile.nodeView.resolved.ino = '3' }
        'process-created' { $process.processCreatedFileTime = '100002' }
        'process-run' { $process.runId = [Guid]::NewGuid().ToString('N') }
        'process-root' { $process.probeRootFileId128 = '3' * 32 }
        'package-bytes' { [IO.File]::AppendAllText($asar, 'changed') }
        'package-absolute-exe' { $pack.executable = $exe }
        'package-absolute-asar' { $pack.asar = $asar }
        'package-numeric-fuse' { $pack.fuseVersion = 1 }
        'source-bytes' { [IO.File]::AppendAllText((Join-Path $repo 'tools/release-profile/DisposableProfile.cs'), 'changed') }
        'source-extra' { $sources['../unknown'] = 'a' * 64 }
        'source-missing' { $sources.Remove('tools/data-qualification/product-transfer/NativeSaveControl.cs') }
        'backup-bytes' { [IO.File]::AppendAllText($backupPath, 'changed') }
        'backup-extra' { [IO.File]::WriteAllText((Join-Path $run 'published/unknown'), 'preserve') }
        'backup-member' { $backup.members[0].schemaVersion = 2 }
        'backup-readback' { }
        'job-total' { $job.total = 3 }
        'job-duplicate-pid' { $job.identities[1].Pid = 456 }
        'button-missing' { $dialog.dialog.Remove('saveButton') }
        'button-hresult' { $saveProof.hresult = 1 }
        'button-role' { $saveProof.role = 42 }
        'button-visible' { $saveProof.visible = $false }
        'button-available' { $saveProof.available = $false }
        'button-default' { $saveProof.defaultActionPresent = $false }
        'button-identity' { $saveProof.nativeIdentityVerified = $false }
        'button-id' { $saveProof.controlId = 2 }
        'button-class' { $saveProof.nameClass = 'cancel' }
        'button-unknown' { $saveProof.raw = 'PRIVATE_NAME' }
        'button-old-mechanism' { $dialog.dialog.mechanism = 'Win32 fixed text / UIA Invoke' }
        'cancel-contradiction' { $cancel.buttonAction.controlId = 1 }
        'save-contradiction' { $save.buttonAction.nameClass = 'cancel' }
        'action-wrong' { $save.action = 'CancelSave' }
        'action-failed' { $cancel.ok = $false }
        'dialog-failed' { $dialog.ok = $false }
        'dialog-pid' { $dialog.dialog.processId = 321 }
        'dialog-missing-window' { $dialog.Remove('dialog') }
        'dialog-incomplete-tree' { $dialog.filenameHostStructure.status = 'collecting' }
        'dialog-tree-count' { $dialog.filenameHostStructure.descendantCount = 2 }
        'dialog-tree-budget' { $dialog.filenameHostStructure.scannedNodes = 513 }
        'dialog-tree-parent' { $nodes[2].parent = 2 }
        'dialog-unknown-class' { $nodes[2].windowClass = 'not-a-class' }
        'dialog-failure-extra' { $dialog.failure = 'earlier-failure' }
    }
    if ($Fault.StartsWith('report-missing-')) { $report.Remove($Fault.Substring(15)) }
    if ($Fault.StartsWith('launch-missing-')) { $launch.Remove($Fault.Substring(15)) }
    Write-Json (Join-Path $journal 'manifest.json') $manifest
    Write-Json (Join-Path $journal 'terminal.json') $terminal
    Write-Json (Join-Path $run 'launch-contract.json') $launch
    Write-Json (Join-Path $run 'report.json') $report
    Write-Json (Join-Path $run 'backup-readback.json') $backup
    Write-Json (Join-Path $run 'job-18.json') $job
    Write-Json (Join-Path $run 'ui-4-InspectSaveDialog.json') $dialog
    Write-Json (Join-Path $run 'ui-6-CancelSave.json') $cancel
    Write-Json (Join-Path $run 'ui-12-SaveBackup.json') $save
    Write-Json (Join-Path $journal 'runner-output/process-ProductOriginal-123.json') $process
    if ($Fault -eq 'backup-readback') { $backup.snapshotId = [Guid]::NewGuid().ToString(); Write-Json (Join-Path $run 'backup-readback.json') $backup }
    if ($Fault -eq 'report-duplicate') { $path = Join-Path $run 'report.json'; $text = [IO.File]::ReadAllText($path); [IO.File]::WriteAllText($path, $text.Substring(0, $text.Length - 1) + ',"ok":true}') }
    if ($Fault -eq 'report-too-large') { [IO.File]::WriteAllText((Join-Path $run 'report.json'), 'x' * 1048577) }
    if ($Fault -eq 'report-invalid-utf8') { [IO.File]::WriteAllBytes((Join-Path $run 'report.json'), [byte[]]@(0xc0, 0xaf)) }
    if ($Fault -eq 'terminal-hardlink') { New-Item -ItemType HardLink -Path (Join-Path $journal 'terminal-alias') -Target (Join-Path $journal 'terminal.json') | Out-Null }
    if ($Fault -eq 'backup-hardlink') { New-Item -ItemType HardLink -Path (Join-Path $run 'backup-alias') -Target $backupPath | Out-Null }
    if ($Fault -eq 'source-hardlink') { New-Item -ItemType HardLink -Path (Join-Path $repo 'source-alias') -Target (Join-Path $repo 'tools/release-profile/DisposableProfile.cs') | Out-Null }
    if ($Fault -eq 'package-hardlink') { New-Item -ItemType HardLink -Path (Join-Path $repo 'package-alias') -Target $asar | Out-Null }
    return @{ repo = $repo; journal = $journal; run = $run; backup = $backupPath; asar = $asar; source = (Join-Path $repo 'tools/release-profile/DisposableProfile.cs') }
}
function Load-Evidence($Fixture) {
    $env:AIBROWSE_PROFILE_TOOL_REPOSITORY = $Fixture.repo
    return $constructor.Invoke([object[]]@([string]$Fixture.journal))
}
try {
    $valid = Fixture ''
    $lease = Load-Evidence $valid
    try {
        if ($RedOnly) { throw '旧实现错误接纳ProductTransfer；红态未建立' }
        foreach ($path in @((Join-Path $valid.journal 'terminal.json'), $valid.backup, $valid.asar, $valid.source)) {
            $refused = $false
            try { [IO.File]::AppendAllText($path, 'must-not-write') } catch { $refused = $true }
            if (-not $refused) { throw '持锁证据允许写入' }
            $rows.Add(@{ case = 'pinned-write'; pass = $true })
            $refused = $false
            try { [IO.File]::Move($path, $path + '.moved') } catch { $refused = $true }
            if (-not $refused) { throw '持锁证据允许替换路径' }
            $rows.Add(@{ case = 'pinned-rename'; pass = $true })
        }
        $readHash = $type.GetMethod('ReadHash', [Reflection.BindingFlags]'Instance,NonPublic')
        $refused = $false
        try { $readHash.Invoke($lease, [object[]]@([string]$valid.source, [long]1, 'fixture/budget', [long]0, $null)) | Out-Null } catch { $refused = $true }
        if (-not $refused) { throw '固定读前字节门未拒绝超限文件' }
        $rows.Add(@{ case = 'read-before-size-budget'; pass = $true })
        $kind = $type.GetProperty('Kind', [Reflection.BindingFlags]'Instance,NonPublic').GetValue($lease)
        if ($kind -cne 'completed-product-transfer-small-backup') { throw '归档分支身份错误' }
        $rows.Add(@{ case = 'product-success-readonly'; pass = $true })
        foreach ($path in @($valid.journal, $valid.run, [IO.Path]::GetDirectoryName($valid.backup), [IO.Path]::GetDirectoryName($valid.source), [IO.Path]::GetDirectoryName($valid.asar))) {
            $refused = $false
            try { [IO.Directory]::Move($path, $path + '-moved') } catch { $refused = $true }
            if (-not $refused) { throw '持锁证据允许替换父目录' }
            $rows.Add(@{ case = 'pinned-directory-rename'; pass = $true })
        }
        $budget = $type.GetField('readBudget', [Reflection.BindingFlags]'Instance,NonPublic').GetValue($lease)
        $budget.Stop()
        $elapsed = [Diagnostics.Stopwatch].GetField('_elapsed', [Reflection.BindingFlags]'Instance,NonPublic')
        if ($null -eq $elapsed) { throw '当前runtime不支持只读期限夹具注入' }
        $elapsed.SetValue($budget, [long]([Diagnostics.Stopwatch]::Frequency * 150))
        $refused = $false
        try { $type.GetMethod('VerifyBeforeTransition', [Reflection.BindingFlags]'Instance,NonPublic').Invoke($lease, @()) } catch { $refused = $true }
        if (-not $refused) { throw '过期期限仍准入intent' }
        $rows.Add(@{ case = 'expired-before-intent'; pass = $true })
        $refused = $false
        try { $readHash.Invoke($lease, [object[]]@([string]$valid.source, [long]8388608, 'fixture/expired', [long]0, $null)) | Out-Null } catch { $refused = $true }
        if (-not $refused) { throw '阶段重新授予读取期限' }
        $rows.Add(@{ case = 'shared-expired-deadline'; pass = $true })
    } finally { ([IDisposable]$lease).Dispose() }
    $faults = @('terminal-failed','terminal-unknown','terminal-run','terminal-job','terminal-marker','manifest-version','manifest-binding-missing','manifest-root','mixed-binding','mixed-tamper-file','second-directory','scenario','report-failed','report-phase','report-exit','report-pending','report-child','report-failure','report-limit','launch-override','profile-run','profile-node','process-created','process-run','process-root','package-bytes','package-absolute-exe','package-absolute-asar','package-numeric-fuse','source-bytes','source-extra','source-missing','backup-bytes','backup-extra','backup-member','backup-readback','job-total','job-duplicate-pid','dialog-failed','report-duplicate','terminal-hardlink','backup-hardlink','source-hardlink','package-hardlink','report-too-large','report-invalid-utf8')
    $faults += @('version','scenario','ok','limits','nonClaims','profile','toolSources','package','product','dialogQualification','cancelAction','saveAction','backup','finalJobSample','phase','elapsedMs','productExited','productExitCode','pendingOriginals','unconfirmedChildren','requiresOuterTerminal') | ForEach-Object { 'report-missing-' + $_ }
    $faults += @('version','scenario','ok','limits','nonClaims','profile','toolSources','package','phase','productArguments','environmentOverrides','providerCalls') | ForEach-Object { 'launch-missing-' + $_ }
    $faults += @('dialog-pid','dialog-missing-window','dialog-incomplete-tree','dialog-tree-count','dialog-tree-budget','dialog-tree-parent','dialog-unknown-class','dialog-failure-extra')
    $faults += @('button-missing','button-hresult','button-role','button-visible','button-available','button-default','button-identity','button-id','button-class','button-unknown','button-old-mechanism','cancel-contradiction','save-contradiction','action-wrong','action-failed')
    $faults += @('manifest-root-missing','manifest-root-field-missing','manifest-root-reparse')
    foreach ($fault in $faults) {
        $fixture = Fixture $fault
        $refused = $false
        try { $lease = Load-Evidence $fixture; ([IDisposable]$lease).Dispose() } catch { $refused = $true }
        if (-not $refused) { throw ('未拒绝反例：' + $fault) }
        if (Test-Path -LiteralPath (Join-Path $fixture.journal 'archive-intent.json')) { throw '只读校验进入实际归档' }
        foreach ($path in @((Join-Path $fixture.journal 'terminal.json'), $fixture.backup, $fixture.source)) {
            $check = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            $check.Dispose()
        }
        $rows.Add(@{ case = $fault; pass = $true })
    }
    @{ ok = $true; actualKnownFolderMoved = $false; executableRun = $false; tests = $rows } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $evidence 'report.json') -Encoding utf8NoBOM
    Write-Output ('ProductTransfer成功归档只读资格：' + $rows.Count + '项通过；' + $evidence)
} catch {
    @{ ok = $false; tests = $rows; failure = $_.Exception.ToString() } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $evidence 'failure.json') -Encoding utf8NoBOM
    throw
} finally { $env:AIBROWSE_PROFILE_TOOL_REPOSITORY = $previousRepository }
