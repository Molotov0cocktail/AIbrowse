[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$env:AIBROWSE_PROFILE_TOOL_REPOSITORY = $repository
Add-Type -Path (Join-Path $PSScriptRoot 'DisposableProfile.cs'), (Join-Path $PSScriptRoot 'ProfileIsolation.cs'), (Join-Path $PSScriptRoot 'JobProcess.cs')
$evidence = Join-Path $repository ('log/stage7-e2/completed-archive-tests-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($evidence) | Out-Null
$rows = [Collections.Generic.List[object]]::new()
function Check([bool]$value, [string]$message) { if (-not $value) { throw $message } }
function Refuses([string]$name, [scriptblock]$operation) {
    $rejected = $false
    try { & $operation | Out-Null } catch { $rejected = $true }
    Check $rejected ('未拒绝反例：' + $name)
    $rows.Add(@{ case = $name; pass = $true })
}
try {
    $runId = [Guid]::NewGuid().ToString('N')
    $terminal = @{ version = 1; runId = $runId; ok = $true; result = 0; jobReleased = $true; markerValidated = $true; failureType = ''; failureMessage = '' } | ConvertTo-Json -Compress
    $type = [AIbrowse.ReleaseProfile.DisposableProfile]
    if ($null -eq $type.GetMethod('ValidateCompletedTerminalFixture')) {
        # The old admission rejects successful runs; retain that behavioral red state.
        [AIbrowse.ReleaseProfile.DisposableProfile]::ValidateFailedTerminalFixture($terminal, $runId) | Out-Null
        throw '旧入口错误接纳成功终态'
    }
    Check ([AIbrowse.ReleaseProfile.DisposableProfile]::ValidateCompletedTerminalFixture($terminal, $runId) -eq $runId) '合法成功终态被拒绝'
    $rows.Add(@{ case = 'completed-terminal'; pass = $true })
    foreach ($field in @('ok', 'result', 'jobReleased', 'markerValidated', 'runId', 'version', 'failureType', 'failureMessage')) {
        $changed = $terminal | ConvertFrom-Json -AsHashtable
        switch ($field) {
            'ok' { $changed.ok = $false }
            'result' { $changed.result = 1 }
            'jobReleased' { $changed.jobReleased = $false }
            'markerValidated' { $changed.markerValidated = $false }
            'runId' { $changed.runId = [Guid]::NewGuid().ToString('N') }
            'version' { $changed.version = 2 }
            'failureType' { $changed.failureType = 'unknown' }
            'failureMessage' { $changed.failureMessage = 'unknown' }
        }
        Refuses ('terminal-' + $field) { [AIbrowse.ReleaseProfile.DisposableProfile]::ValidateCompletedTerminalFixture(($changed | ConvertTo-Json -Compress), $runId) }
    }
    foreach ($invalid in @('{', '[]', ($terminal.Substring(0, $terminal.Length - 1) + ',"ok":true}'), ($terminal -replace '"result":0', '"result":null'), ($terminal -replace '"ok":true', '"ok":"true"'))) {
        Refuses 'malformed-terminal' { [AIbrowse.ReleaseProfile.DisposableProfile]::ValidateCompletedTerminalFixture($invalid, $runId) }
    }
    Refuses 'completed-not-failed' { [AIbrowse.ReleaseProfile.DisposableProfile]::ValidateFailedTerminalFixture($terminal, $runId) }
    $failed = $terminal | ConvertFrom-Json -AsHashtable
    $failed.ok = $false; $failed.result = 1
    Check ([AIbrowse.ReleaseProfile.DisposableProfile]::ValidateFailedTerminalFixture(($failed | ConvertTo-Json -Compress), $runId) -eq $runId) '原失败入口语义改变'
    $rows.Add(@{ case = 'failed-admission-unchanged'; pass = $true })

    $manifest = [AIbrowse.ReleaseProfile.DisposableManifest]::new()
    $manifest.RunId = $runId
    $manifest.BindingJournal = Join-Path $evidence 'synthetic-product-journal'
    $manifest.PackageExecutable = Join-Path $evidence 'synthetic-package/AIbrowse.exe'
    $manifest.DeclaredProfile = Join-Path $evidence 'synthetic-appdata/aibrowse'
    $manifest.RootIdentity.FileId128 = '1' * 32
    $manifest.RootIdentity.VolumeSerial64 = '2' * 16
    $reportDirectory = Join-Path $evidence 'synthetic-report'
    $binding = @{ Version = 1; ProductJournal = $manifest.BindingJournal; ProductReport = (Join-Path $manifest.BindingJournal 'runner-output/product/run-1/report.json'); ExecutableSha256 = 'a' * 64; AsarSha256 = 'b' * 64; AsarHeaderSha256 = 'c' * 64 } | ConvertTo-Json -Compress
    $report = @{
        ok = $true
        package = @{ executableSha256 = 'a' * 64; asarSha256 = 'b' * 64; asarHeaderSha256 = 'c' * 64 }
        original = @{ processIdentity = @{ label = 'TamperOriginal'; imagePath = $manifest.PackageExecutable; probeRootFileId128 = $manifest.RootIdentity.FileId128; probeRootVolumeSerial64 = $manifest.RootIdentity.VolumeSerial64 } }
        profileIsolation = @{ version = 2; runId = $runId; syntheticFileId = $manifest.RootIdentity.FileId128 }
        appData = [IO.Path]::GetDirectoryName($manifest.DeclaredProfile)
        evidenceDirectory = $reportDirectory
    } | ConvertTo-Json -Compress -Depth 8
    Check ([AIbrowse.ReleaseProfile.DisposableProfile]::ValidateCompletedArchiveFixture($terminal, $report, $binding, $manifest, $reportDirectory) -eq $runId) '合法成功报告绑定被拒绝'
    $rows.Add(@{ case = 'completed-report'; pass = $true })
    foreach ($field in @('ok', 'runId', 'root', 'volume', 'package', 'directory', 'binding', 'image')) {
        $changedReport = $report | ConvertFrom-Json -AsHashtable
        $changedBinding = $binding | ConvertFrom-Json -AsHashtable
        switch ($field) {
            'ok' { $changedReport.ok = $false }
            'runId' { $changedReport.profileIsolation.runId = [Guid]::NewGuid().ToString('N') }
            'root' { $changedReport.profileIsolation.syntheticFileId = '3' * 32 }
            'volume' { $changedReport.original.processIdentity.probeRootVolumeSerial64 = '4' * 16 }
            'package' { $changedReport.package.asarSha256 = 'd' * 64 }
            'directory' { $changedReport.evidenceDirectory = (Join-Path $evidence 'unknown') }
            'binding' { $changedBinding.ProductJournal = (Join-Path $evidence 'unknown') }
            'image' { $changedReport.original.processIdentity.imagePath = (Join-Path $evidence 'unknown.exe') }
        }
        Refuses ('report-' + $field) { [AIbrowse.ReleaseProfile.DisposableProfile]::ValidateCompletedArchiveFixture($terminal, ($changedReport | ConvertTo-Json -Depth 8 -Compress), ($changedBinding | ConvertTo-Json -Compress), $manifest, $reportDirectory) }
    }
    foreach ($badReport in @('{', '[]', ($report.Substring(0, $report.Length - 1) + ',"ok":true}'))) {
        Refuses 'malformed-report' { [AIbrowse.ReleaseProfile.DisposableProfile]::ValidateCompletedArchiveFixture($terminal, $badReport, $binding, $manifest, $reportDirectory) }
    }

    # Invoke only the private read-only evidence loader. Never invoke ArchiveCompletedRun.
    $evidenceType = $type.GetNestedType('CompletedArchiveEvidence', [Reflection.BindingFlags]::NonPublic)
    $evidenceConstructor = $evidenceType.GetConstructor([Reflection.BindingFlags]'Instance,NonPublic', $null, [type[]]@([string]), $null)
    function Read-Evidence([string]$journal) {
        $lease = $evidenceConstructor.Invoke([object[]]@($journal))
        try { Check ($null -ne $lease) '没有取得证据租约' } finally { ([IDisposable]$lease).Dispose() }
    }
    Refuses 'unknown-journal-root' { Read-Evidence (Join-Path $evidence ('journal-' + $runId)) }
    foreach ($fault in @('', 'terminal-hardlink', 'manifest-duplicate', 'report-failed', 'second-report-directory', 'unknown-run-directory')) {
        $evidenceId = [Guid]::NewGuid().ToString('N')
        $journalRoot = Join-Path $repository 'log/stage7-e1/disposable-profile'
        $journal = Join-Path $journalRoot ('journal-' + $evidenceId)
        $directoryName = $(if ($fault -eq 'unknown-run-directory') { 'unknown' } else { 'run-1' })
        $reportDir = Join-Path $journal ('runner-output/' + $directoryName)
        [IO.Directory]::CreateDirectory($reportDir) | Out-Null
        $m = $manifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json -AsHashtable
        $m.RunId = $evidenceId
        $m.BindingJournal = Join-Path $journalRoot ('journal-' + [Guid]::NewGuid().ToString('N'))
        $t = $terminal | ConvertFrom-Json -AsHashtable
        $t.runId = $evidenceId
        $b = $binding | ConvertFrom-Json -AsHashtable
        $b.ProductJournal = $m.BindingJournal
        $r = $report | ConvertFrom-Json -AsHashtable
        $r.profileIsolation.runId = $evidenceId
        $r.evidenceDirectory = $reportDir
        if ($fault -eq 'report-failed') { $r.ok = $false }
        $manifestText = $m | ConvertTo-Json -Depth 8 -Compress
        if ($fault -eq 'manifest-duplicate') { $manifestText = $manifestText.Substring(0, $manifestText.Length - 1) + ',"Version":2}' }
        [IO.File]::WriteAllText((Join-Path $journal 'manifest.json'), $manifestText)
        [IO.File]::WriteAllText((Join-Path $journal 'tamper-binding.json'), ($b | ConvertTo-Json -Compress))
        [IO.File]::WriteAllText((Join-Path $reportDir 'report.json'), ($r | ConvertTo-Json -Depth 8 -Compress))
        $terminalPath = Join-Path $journal 'terminal.json'
        [IO.File]::WriteAllText($terminalPath, ($t | ConvertTo-Json -Compress))
        if ($fault -eq 'terminal-hardlink') { New-Item -ItemType HardLink -Path (Join-Path $journal 'terminal-alias.json') -Target $terminalPath | Out-Null }
        if ($fault -eq 'second-report-directory') { [IO.Directory]::CreateDirectory((Join-Path $journal 'runner-output/run-2')) | Out-Null }
        if ($fault -eq '') {
            Read-Evidence $journal
            $rows.Add(@{ case = 'pinned-completed-evidence'; pass = $true; fixtureJournal = $journal })
        } else {
            Refuses ('pinned-evidence-' + $fault) { Read-Evidence $journal }
        }
        Check (-not (Test-Path -LiteralPath (Join-Path $journal 'archive-intent.json'))) '只读证据验证进入了归档转换'
    }

    # Exercise the same fixed transition only in its existing synthetic root.
    foreach ($fault in @('', 'identity-mismatch', 'target-exists')) {
        $fixtureId = [Guid]::NewGuid().ToString('N')
        $fixtureRoot = Join-Path $repository ('log/stage7-e1/disposable-archive-fixtures/fixture-' + $fixtureId)
        $rejected = $false
        try { [AIbrowse.ReleaseProfile.DisposableProfile]::RunArchiveFixture($fixtureId, $fault) | Out-Null } catch { $rejected = $true }
        $source = Join-Path $fixtureRoot 'active/aibrowse'
        $preserved = Join-Path $fixtureRoot ('active/.aibrowse-e1-preserved-' + $fixtureId)
        if ($fault -eq '') {
            Check (-not $rejected) '合成转换未成功'
            Check (@(Get-ChildItem -LiteralPath $source -Force).Count -eq 0) '合成新根不是空目录'
            Check ((Get-Content -LiteralPath (Join-Path $preserved 'fixture-canary.txt') -Raw) -eq ('preserve-' + $fixtureId)) '合成原内容未保留'
        } else {
            Check $rejected ('合成转换未拒绝：' + $fault)
            Check ((Get-Content -LiteralPath (Join-Path $source 'fixture-canary.txt') -Raw) -eq ('preserve-' + $fixtureId)) '拒绝后合成原内容变化'
            if ($fault -eq 'target-exists') { Check ((Get-Content -LiteralPath (Join-Path $preserved 'unknown.txt') -Raw) -eq 'do-not-overwrite') '未知目标被覆盖' }
        }
        $rows.Add(@{ case = ('transition-' + $(if ($fault -eq '') { 'success' } else { $fault })); pass = $true; fixtureId = $fixtureId })
    }
    @{ ok = $true; actualKnownFolderMoved = $false; packageExecutableRun = $false; tests = $rows } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence 'report.json') -Encoding utf8NoBOM
    Write-Output ('成功归档合成验证通过：' + $rows.Count + '项；' + $evidence)
} catch {
    @{ ok = $false; actualKnownFolderMoved = $false; packageExecutableRun = $false; tests = $rows; failure = $_.Exception.ToString() } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence 'failure.json') -Encoding utf8NoBOM
    Write-Output ('失败原件：' + $evidence)
    throw
}
