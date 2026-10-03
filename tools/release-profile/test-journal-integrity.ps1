[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$env:AIBROWSE_PROFILE_TOOL_REPOSITORY = $repository
Add-Type -Path (Join-Path $PSScriptRoot 'ProfileIsolation.cs'), (Join-Path $PSScriptRoot 'JobProcess.cs')
$testRoot = Join-Path $repository ('log\stage7-e1\profile-isolation\journal-tests-' + [Guid]::NewGuid().ToString('N'))
$parent = Join-Path $testRoot 'fixture-parent'
New-Item -ItemType Directory -Path (Join-Path $parent 'aibrowse') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $parent 'aibrowse\fixture.txt'), 'original')
$journal = [AIbrowse.ReleaseProfile.Isolation]::Prepare($parent, $true, '')
$manifest = Get-Content -LiteralPath (Join-Path $journal 'manifest.json') -Raw | ConvertFrom-Json
$tests = [Collections.Generic.List[object]]::new()
try {
    $events = Join-Path $journal 'events.jsonl'
    $saved = Join-Path $journal 'fixture-preserved-events.jsonl'
    Move-Item -LiteralPath $events -Destination $saved
    $outside = Join-Path $testRoot 'fixture-outside-sentinel.txt'
    [IO.File]::WriteAllText($outside, 'outside sentinel')
    New-Item -ItemType HardLink -Path $events -Target $outside | Out-Null
    $caught = $false
    try { [AIbrowse.ReleaseProfile.Isolation]::Exercise($journal, '') }
    catch { $caught = $_.Exception.InnerException.Message -eq '合成文件不能具有硬链接' }
    if (-not $caught) { throw 'journal 硬链接没有被拒绝。' }
    if ((Get-Content -LiteralPath $outside -Raw) -ne 'outside sentinel') { throw '外部哨兵被追加。' }
    Move-Item -LiteralPath $events -Destination (Join-Path $journal 'fixture-preserved-hardlink')
    Move-Item -LiteralPath $saved -Destination $events
    $tests.Add(@{ case = 'journal-hardlink-refused'; pass = $true })

    $collision = Join-Path $parent ('.aibrowse-e1-original-' + $manifest.RunId)
    New-Item -ItemType Directory -Path $collision | Out-Null
    $caught = $false
    try { [AIbrowse.ReleaseProfile.Isolation]::Exercise($journal, '') }
    catch { $caught = $_.Exception.InnerException.Message -eq '目标已存在，禁止覆盖未知目录' }
    if (-not $caught) { throw '保护目标冲突未被拒绝。' }
    Move-Item -LiteralPath $collision -Destination (Join-Path $parent 'fixture-preserved-collision')
    $tests.Add(@{ case = 'protect-destination-collision'; pass = $true })

    [AIbrowse.ReleaseProfile.Isolation]::Exercise($journal, '')
    $lease = [AIbrowse.ReleaseProfile.DirectoryLease]::new((Join-Path $parent 'aibrowse'), $false)
    try {
        if ($lease.Identity.FileId -ne $manifest.OriginalIdentity.FileId -or $lease.Identity.Sddl -ne $manifest.OriginalIdentity.Sddl) {
            throw '恢复后的原目录身份不一致。'
        }
    }
    finally { $lease.Dispose() }
    if ((Get-Content -LiteralPath (Join-Path $parent 'aibrowse\fixture.txt') -Raw) -ne 'original') { throw '原件内容变化。' }
    $tests.Add(@{ case = 'current-source-complete-cycle'; pass = $true })
    @{ ok = $true; tests = $tests; journal = $journal; actualProfileMoved = $false } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $testRoot 'report.json') -Encoding utf8
    Write-Output ('journal 反例通过：' + $tests.Count + ' 项。证据：' + $testRoot)
}
catch {
    @{ ok = $false; tests = $tests; failure = $_.Exception.ToString(); actualProfileMoved = $false } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $testRoot 'failure.json') -Encoding utf8
    throw
}
