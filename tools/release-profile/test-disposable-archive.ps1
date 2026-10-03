[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$env:AIBROWSE_PROFILE_TOOL_REPOSITORY = $repository
Add-Type -Path (Join-Path $PSScriptRoot 'DisposableProfile.cs'), (Join-Path $PSScriptRoot 'ProfileIsolation.cs'), (Join-Path $PSScriptRoot 'JobProcess.cs')
$entry = Join-Path $PSScriptRoot 'disposable-profile.ps1'
$fixtureBase = Join-Path $repository 'log\stage7-e1\disposable-archive-fixtures'
[IO.Directory]::CreateDirectory($fixtureBase) | Out-Null
$rows = [Collections.Generic.List[object]]::new()

function Assert-True([bool]$Value, [string]$Failure) {
    if (-not $Value) { throw $Failure }
}

$validRunId = [Guid]::NewGuid().ToString('N')
$validTerminal = @{ version = 1; runId = $validRunId; ok = $false; result = 1; jobReleased = $true; markerValidated = $true } | ConvertTo-Json -Compress
Assert-True ([AIbrowse.ReleaseProfile.DisposableProfile]::ValidateFailedTerminalFixture($validTerminal, $validRunId) -eq $validRunId) '有效失败终态被拒绝。'
foreach ($change in @('ok', 'jobReleased', 'markerValidated', 'version', 'result')) {
    $record = $validTerminal | ConvertFrom-Json -AsHashtable
    if ($change -eq 'ok') { $record[$change] = $true }
    elseif ($change -eq 'version') { $record[$change] = 2 }
    elseif ($change -eq 'result') { $record[$change] = 0 }
    else { $record[$change] = $false }
    $rejected = $false
    try { [AIbrowse.ReleaseProfile.DisposableProfile]::ValidateFailedTerminalFixture(($record | ConvertTo-Json -Compress), $validRunId) | Out-Null }
    catch { $rejected = $true }
    Assert-True $rejected "失败终态反例未拒绝：$change"
}
$wrongRunRejected = $false
try { [AIbrowse.ReleaseProfile.DisposableProfile]::ValidateFailedTerminalFixture($validTerminal, [Guid]::NewGuid().ToString('N')) | Out-Null }
catch { $wrongRunRejected = $true }
Assert-True $wrongRunRejected '失败终态错误runId未拒绝。'
$rows.Add(@{ case = 'terminal-policy'; pass = $true })

$autoInherited = 'O:SYG:SYD:AI(A;;FA;;;SY)'
$autoRecalculated = 'O:SYG:SYD:(A;;FA;;;SY)'
$protected = 'O:SYG:SYD:P(A;;FA;;;SY)'
Assert-True ([AIbrowse.ReleaseProfile.DisposableProfile]::SecurityEquivalentFixture($autoInherited, $autoRecalculated)) '仅AutoInherited差异未被接受。'
Assert-True (-not [AIbrowse.ReleaseProfile.DisposableProfile]::SecurityEquivalentFixture($autoInherited, $protected)) 'Protected控制位差异被错误接受。'
$nullDaclRejected = $false
try {
    $nullDaclRejected = -not [AIbrowse.ReleaseProfile.DisposableProfile]::SecurityEquivalentFixture('O:SYG:SYD:NO_ACCESS_CONTROL', 'O:SYG:SYD:NO_ACCESS_CONTROL')
} catch { $nullDaclRejected = $true }
Assert-True $nullDaclRejected 'null DACL未fail-closed。'
$rows.Add(@{ case = 'acl-control-flags'; pass = $true })

$expectedExit = @{ 'rename-before' = 91; 'rename-after' = 92; 'new-root-created' = 93 }
foreach ($fault in $expectedExit.Keys) {
    $runId = [Guid]::NewGuid().ToString('N')
    $process = Start-Process pwsh.exe -ArgumentList @(
        '-NoProfile', '-File', $entry, '-Action', 'FixtureArchive', '-RunId', $runId, '-Fault', $fault
    ) -Wait -PassThru -WindowStyle Hidden
    Assert-True ($process.ExitCode -eq $expectedExit[$fault]) "归档故障点退出码错误：$fault"
    $root = Join-Path $fixtureBase ('fixture-' + $runId)
    $source = Join-Path $root 'active\aibrowse'
    $preserved = Join-Path $root ('active\.aibrowse-e1-preserved-' + $runId)
    $journal = Join-Path $root 'journal'
    Assert-True (Test-Path -LiteralPath (Join-Path $journal 'archive-intent.json') -PathType Leaf) "缺少归档intent：$fault"
    if ($fault -eq 'rename-before') {
        Assert-True (Test-Path -LiteralPath $source -PathType Container) 'rename前源目录丢失。'
        Assert-True (-not (Test-Path -LiteralPath $preserved)) 'rename前出现归档目录。'
    } elseif ($fault -eq 'rename-after') {
        Assert-True (-not (Test-Path -LiteralPath $source)) 'rename后原路径仍存在。'
        Assert-True (Test-Path -LiteralPath (Join-Path $preserved 'fixture-canary.txt') -PathType Leaf) 'rename后归档canary丢失。'
        Assert-True (Test-Path -LiteralPath (Join-Path $journal 'archive-renamed.json') -PathType Leaf) 'rename后缺少durable状态。'
    } else {
        Assert-True (Test-Path -LiteralPath (Join-Path $preserved 'fixture-canary.txt') -PathType Leaf) '新根创建后归档canary丢失。'
        Assert-True (Test-Path -LiteralPath $source -PathType Container) '新根创建后原路径缺失。'
        Assert-True (@(Get-ChildItem -LiteralPath $source -Force).Count -eq 0) '新根创建后不是空目录。'
        $created = Get-Content -Raw -LiteralPath (Join-Path $journal 'archive-created.json') | ConvertFrom-Json
        Assert-True ($created.preservedIdentity.FileId128 -ne $created.newRootIdentity.FileId128) '归档与新根FileID未分离。'
    }
    $rows.Add(@{ case = $fault; pass = $true; runId = $runId; root = $root })
}

$successRunId = [Guid]::NewGuid().ToString('N')
$success = Start-Process pwsh.exe -ArgumentList @(
    '-NoProfile', '-File', $entry, '-Action', 'FixtureArchive', '-RunId', $successRunId, '-Fault', 'none'
) -Wait -PassThru -WindowStyle Hidden
Assert-True ($success.ExitCode -eq 0) '无故障归档夹具未成功。'
$successRoot = Join-Path $fixtureBase ('fixture-' + $successRunId)
$successSource = Join-Path $successRoot 'active\aibrowse'
$successPreserved = Join-Path $successRoot ('active\.aibrowse-e1-preserved-' + $successRunId)
Assert-True (@(Get-ChildItem -LiteralPath $successSource -Force).Count -eq 0) '成功归档的新根不是空目录。'
Assert-True (Test-Path -LiteralPath (Join-Path $successPreserved 'fixture-canary.txt') -PathType Leaf) '成功归档未保留canary。'
Assert-True (Test-Path -LiteralPath (Join-Path $successRoot 'journal\fixture-report.json') -PathType Leaf) '成功归档缺少报告。'
$rows.Add(@{ case = 'success'; pass = $true; runId = $successRunId; root = $successRoot })

foreach ($refusal in @('target-exists', 'identity-mismatch')) {
    $runId = [Guid]::NewGuid().ToString('N')
    $process = Start-Process pwsh.exe -ArgumentList @(
        '-NoProfile', '-File', $entry, '-Action', 'FixtureArchive', '-RunId', $runId, '-Fault', $refusal
    ) -Wait -PassThru -WindowStyle Hidden
    Assert-True ($process.ExitCode -ne 0) "归档反例未拒绝：$refusal"
    $root = Join-Path $fixtureBase ('fixture-' + $runId)
    $source = Join-Path $root 'active\aibrowse'
    Assert-True (Test-Path -LiteralPath (Join-Path $source 'fixture-canary.txt') -PathType Leaf) "归档反例移动了源：$refusal"
    if ($refusal -eq 'target-exists') {
        $preserved = Join-Path $root ('active\.aibrowse-e1-preserved-' + $runId)
        Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $preserved 'unknown.txt')) -eq 'do-not-overwrite') '未知归档目标被覆盖。'
    }
    $rows.Add(@{ case = $refusal; pass = $true; runId = $runId; root = $root })
}

$reportRoot = Join-Path $fixtureBase ('report-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($reportRoot) | Out-Null
@{ ok = $true; tests = $rows } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $reportRoot 'report.json') -Encoding utf8NoBOM
Write-Output "Disposable归档策略验证通过：$reportRoot"
