[CmdletBinding()]
param([string]$ActualJournal = '')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$env:AIBROWSE_PROFILE_TOOL_REPOSITORY = $repository
Add-Type -Path (Join-Path $PSScriptRoot 'DisposableProfile.cs'), (Join-Path $PSScriptRoot 'ProfileIsolation.cs'), (Join-Path $PSScriptRoot 'JobProcess.cs')
$resultDirectory = Join-Path $repository ('log/stage7-e2/independent-archive-fixtures-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($resultDirectory) | Out-Null
$rows = [Collections.Generic.List[object]]::new()
$type = [AIbrowse.ReleaseProfile.DisposableProfile]
$loader = $type.GetNestedType('CompletedArchiveEvidence', [Reflection.BindingFlags]::NonPublic)
$constructor = $loader.GetConstructor([Reflection.BindingFlags]'Instance,NonPublic', $null, [type[]]@([string]), $null)
function Refuses([string]$Name, [scriptblock]$Operation) {
    $rejected = $false
    try { & $Operation | Out-Null } catch { $rejected = $true }
    $rows.Add(@{ case = $Name; pass = $rejected })
}
function Read-Evidence([string]$Journal) {
    $lease = $constructor.Invoke([object[]]@($Journal))
    try { if ($null -eq $lease) { throw '没有只读证据租约' } } finally { ([IDisposable]$lease).Dispose() }
}
function Fixture([string]$Fault) {
    $id = [Guid]::NewGuid().ToString('N')
    $journalRoot = Join-Path $repository 'log/stage7-e1/disposable-profile'
    $journal = Join-Path $journalRoot ('journal-' + $id)
    $reportDirectory = Join-Path $journal 'runner-output/run-1'
    [IO.Directory]::CreateDirectory($reportDirectory) | Out-Null
    $identity = @{ FileId128 = '1' * 32; VolumeSerial64 = '2' * 16 }
    $manifest = @{ Version = 2; RunId = $id; BindingJournal = (Join-Path $journalRoot ('journal-' + [Guid]::NewGuid().ToString('N'))); PackageExecutable = (Join-Path $resultDirectory 'fake/AIbrowse.exe'); DeclaredProfile = (Join-Path $resultDirectory 'appdata/aibrowse'); RootIdentity = $identity }
    $terminal = @{ version = 1; runId = $id; ok = $true; result = 0; jobReleased = $true; markerValidated = $true; failureType = ''; failureMessage = '' }
    $binding = @{ Version = 1; ProductJournal = $manifest.BindingJournal; ExecutableSha256 = 'a' * 64; AsarSha256 = 'b' * 64; AsarHeaderSha256 = 'c' * 64 }
    $report = @{ ok = $true; profileIsolation = @{ version = 2; runId = $id; syntheticFileId = $identity.FileId128 }; original = @{ processIdentity = @{ label = 'TamperOriginal'; imagePath = $manifest.PackageExecutable; probeRootFileId128 = $identity.FileId128; probeRootVolumeSerial64 = $identity.VolumeSerial64 } }; package = @{ executableSha256 = 'a' * 64; asarSha256 = 'b' * 64; asarHeaderSha256 = 'c' * 64 }; appData = [IO.Path]::GetDirectoryName($manifest.DeclaredProfile); evidenceDirectory = $reportDirectory }
    if ($Fault -eq 'missing-manifest-version') { $manifest.Remove('Version') }
    if ($Fault -eq 'terminal-extra-field') { $terminal.unknown = $true }
    if ($Fault -eq 'null-root-identity') { $manifest.RootIdentity = $null }
    $manifestText = $manifest | ConvertTo-Json -Depth 8 -Compress
    $reportText = $report | ConvertTo-Json -Depth 8 -Compress
    $bindingText = $binding | ConvertTo-Json -Compress
    if ($Fault -eq 'nested-duplicate-report') { $reportText = $reportText.Replace('"version":2', '"version":2,"version":2') }
    if ($Fault -eq 'depth-budget') { $bindingText = $bindingText.Substring(0, $bindingText.Length - 1) + ',"extra":' + ('[' * 33) + '0' + (']' * 33) + '}' }
    if ($Fault -eq 'byte-budget') { $bindingText = $bindingText.Substring(0, $bindingText.Length - 1) + ',"extra":"' + ('中' * 6000) + '"}' }
    [IO.File]::WriteAllText((Join-Path $journal 'manifest.json'), $manifestText)
    [IO.File]::WriteAllText((Join-Path $journal 'terminal.json'), ($terminal | ConvertTo-Json -Compress))
    [IO.File]::WriteAllText((Join-Path $journal 'tamper-binding.json'), $bindingText)
    [IO.File]::WriteAllText((Join-Path $reportDirectory 'report.json'), $reportText)
    return $journal
}

try {
    $valid = Fixture ''
    Read-Evidence $valid
    $rows.Add(@{ case = 'independent-positive'; pass = $true; fixture = $valid })
    $lease = $constructor.Invoke([object[]]@([string]$valid))
    try {
        $terminalPath = Join-Path $valid 'terminal.json'
        Refuses 'pinned-terminal-write' { [IO.File]::WriteAllText($terminalPath, '{}') }
        Refuses 'pinned-terminal-rename' { [IO.File]::Move($terminalPath, $terminalPath + '.moved') }
        Refuses 'pinned-journal-rename' { [IO.Directory]::Move($valid, $valid + '-moved') }
    } finally { ([IDisposable]$lease).Dispose() }
    foreach ($fault in @('missing-manifest-version', 'terminal-extra-field', 'null-root-identity', 'nested-duplicate-report', 'depth-budget', 'byte-budget')) {
        $fixture = Fixture $fault
        Refuses $fault { Read-Evidence $fixture }
    }
    foreach ($path in @('relative', '\\server\share\journal-00000000000000000000000000000000', ($valid + ':stream'))) {
        Refuses 'invalid-path-form' { Read-Evidence $path }
    }
    $wrapperTokens = $null; $wrapperErrors = $null
    $wrapperAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'disposable-profile.ps1'), [ref]$wrapperTokens, [ref]$wrapperErrors)
    $rows.Add(@{ case = 'wrapper-ast'; pass = ($wrapperErrors.Count -eq 0 -and $wrapperAst.Extent.Text.Contains('[AIbrowse.ReleaseProfile.DisposableProfile]::ArchiveCompletedRun($Journal)')) })
    if ($ActualJournal -ne '') {
        $fixed = @('manifest.json', 'terminal.json', 'tamper-binding.json')
        $reports = @(Get-ChildItem -LiteralPath (Join-Path $ActualJournal 'runner-output') -Filter report.json -File -Recurse)
        if ($reports.Count -ne 1) { throw '真实只读证据报告数量错误' }
        $files = @($fixed | ForEach-Object { Join-Path $ActualJournal $_ }) + @($reports[0].FullName)
        $before = @($files | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash })
        Read-Evidence $ActualJournal
        $after = @($files | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash })
        $rows.Add(@{ case = 'actual-evidence-readonly'; pass = (($before -join ',') -eq ($after -join ',')); sha256 = $after })
    }
    $failed = @($rows | Where-Object { -not $_.pass })
    @{ ok = ($failed.Count -eq 0); tests = $rows; actualKnownFolderMoved = $false; executableRun = $false } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $resultDirectory 'report.json') -Encoding utf8NoBOM
    Write-Output ('独立归档反例：' + $rows.Count + '项，失败' + $failed.Count + '项；' + $resultDirectory)
    foreach ($row in $failed) { Write-Output ('FAIL ' + $row.case) }
    if ($failed.Count -ne 0) { exit 1 }
} catch {
    @{ ok = $false; error = $_.Exception.ToString(); tests = $rows } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $resultDirectory 'failure.json') -Encoding utf8NoBOM
    throw
}
