[CmdletBinding()]
param([string[]]$FaultPoints = @())

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$evidence = Join-Path $repository 'log\stage7-e1\profile-isolation'
$testRoot = Join-Path $evidence ('tests-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$env:AIBROWSE_PROFILE_TOOL_REPOSITORY = $repository
Add-Type -Path (Join-Path $PSScriptRoot 'ProfileIsolation.cs'), (Join-Path $PSScriptRoot 'JobProcess.cs')
if ($FaultPoints.Count -eq 0) { $FaultPoints = [AIbrowse.ReleaseProfile.Isolation]::FaultPoints }
foreach ($point in $FaultPoints) {
    if ($point -notin [AIbrowse.ReleaseProfile.Isolation]::FaultPoints) { throw '未知的聚焦故障点。' }
}
$entry = Join-Path $PSScriptRoot 'profile-isolation.ps1'
$pwsh = (Get-Process -Id $PID).Path
$results = [Collections.Generic.List[object]]::new()

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function New-Fixture([string]$Name) {
    $parent = Join-Path $testRoot $Name
    New-Item -ItemType Directory -Path (Join-Path $parent 'aibrowse') | Out-Null
    $canary = Join-Path $parent 'aibrowse\fixture-original.txt'
    [IO.File]::WriteAllText($canary, ('原件合成哨兵 ' + [Guid]::NewGuid().ToString('N')))
    $lease = [AIbrowse.ReleaseProfile.DirectoryLease]::new((Join-Path $parent 'aibrowse'), $false)
    try { $identity = $lease.Identity } finally { $lease.Dispose() }
    return @{ Parent = $parent; Original = $identity; Hash = (Get-FileHash -LiteralPath $canary).Hash }
}

function Invoke-Child([string[]]$Arguments, [string]$Name) {
    $stdout = Join-Path $testRoot ($Name + '.stdout.txt')
    $stderr = Join-Path $testRoot ($Name + '.stderr.txt')
    $start = [Diagnostics.ProcessStartInfo]::new($pwsh)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($arg in @('-NoLogo', '-NoProfile', '-File', $entry) + $Arguments) { $start.ArgumentList.Add($arg) }
    $process = [Diagnostics.Process]::Start($start)
    try {
        $outTask = $process.StandardOutput.ReadToEndAsync()
        $errTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) { throw '合成子进程超过 30 秒预算；保留现场。' }
        [IO.File]::WriteAllText($stdout, $outTask.GetAwaiter().GetResult())
        [IO.File]::WriteAllText($stderr, $errTask.GetAwaiter().GetResult())
        return $process.ExitCode
    }
    finally { $process.Dispose() }
}

function Find-Journal([string]$Parent) {
    $found = @(Get-ChildItem -LiteralPath $evidence -Directory -Filter 'journal-*' | Where-Object {
        $manifestFile = Join-Path $_.FullName 'manifest.json'
        (Test-Path -LiteralPath $manifestFile) -and ((Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json).Parent -eq $Parent)
    })
    Assert-True ($found.Count -eq 1) '每个夹具必须有唯一 journal。'
    return $found[0].FullName
}

function Assert-Original($Fixture) {
    $active = Join-Path $Fixture.Parent 'aibrowse'
    $lease = [AIbrowse.ReleaseProfile.DirectoryLease]::new($active, $false)
    try {
        Assert-True ($lease.Identity.FileId -eq $Fixture.Original.FileId) '原件 FileID 不一致。'
        Assert-True ($lease.Identity.Sddl -eq $Fixture.Original.Sddl) '原件 ACL 不一致。'
    }
    finally { $lease.Dispose() }
    Assert-True ((Get-FileHash -LiteralPath (Join-Path $active 'fixture-original.txt')).Hash -eq $Fixture.Hash) '合成原件正文改变。'
}

function New-ActivatedFixture([string]$Name) {
    $fixture = New-Fixture $Name
    $journal = [AIbrowse.ReleaseProfile.Isolation]::Prepare($fixture.Parent, $true, '')
    $code = Invoke-Child @('-Action', 'FixtureExercise', '-Journal', $journal, '-Fault', 'activate-done') $Name
    Assert-True ($code -eq 91) '未命中 active 故障点。'
    $fixture.Journal = $journal
    return $fixture
}

try {
    foreach ($point in $FaultPoints) {
        $fixture = New-Fixture $point
        if ($point -in @('manifest', 'synthetic-created', 'synthetic-identified', 'marker-written', 'ready')) {
            $code = Invoke-Child @('-Action', 'FixturePrepare', '-FixtureParent', $fixture.Parent, '-Fault', $point) ($point + '-fault')
            $journal = Find-Journal $fixture.Parent
        }
        else {
            $journal = [AIbrowse.ReleaseProfile.Isolation]::Prepare($fixture.Parent, $true, '')
            $code = Invoke-Child @('-Action', 'FixtureExercise', '-Journal', $journal, '-Fault', $point) ($point + '-fault')
        }
        Assert-True ($code -eq 91) ('未命中故障点：' + $point)
        $code = Invoke-Child @('-Action', 'Restore', '-Journal', $journal) ($point + '-restore')
        Assert-True ($code -eq 0) ('独立恢复失败：' + $point)
        Assert-Original $fixture
        $code = Invoke-Child @('-Action', 'Restore', '-Journal', $journal) ($point + '-idempotent')
        Assert-True ($code -eq 0) ('幂等恢复失败：' + $point)
        Assert-Original $fixture
        $results.Add(@{ case = $point; pass = $true; journal = $journal })
    }

    $fixture = New-ActivatedFixture 'locked-file'
    $lockPath = Join-Path $fixture.Parent 'aibrowse\fixture-locked.db'
    $handle = [IO.File]::Open($lockPath, 'CreateNew', 'ReadWrite', 'None')
    try {
        $code = Invoke-Child @('-Action', 'Restore', '-Journal', $fixture.Journal) 'locked-refusal'
        Assert-True ($code -ne 0) '锁定数据文件未阻止恢复。'
    }
    finally { $handle.Dispose() }
    Assert-True ((Invoke-Child @('-Action', 'Restore', '-Journal', $fixture.Journal) 'locked-released') -eq 0) '释放文件后未恢复。'
    Assert-Original $fixture
    $results.Add(@{ case = 'locked-file'; pass = $true })

    $fixture = New-ActivatedFixture 'unknown-active'
    $active = Join-Path $fixture.Parent 'aibrowse'
    $preserved = Join-Path $fixture.Parent 'fixture-preserved-synthetic'
    Move-Item -LiteralPath $active -Destination $preserved
    New-Item -ItemType Directory -Path $active | Out-Null
    [IO.File]::WriteAllText((Join-Path $active 'unknown.txt'), 'unknown')
    Assert-True ((Invoke-Child @('-Action', 'Restore', '-Journal', $fixture.Journal) 'unknown-refusal') -ne 0) '未知目录被覆盖。'
    Assert-True ((Get-Content -LiteralPath (Join-Path $active 'unknown.txt') -Raw) -eq 'unknown') '未知目录发生改写。'
    Move-Item -LiteralPath $active -Destination (Join-Path $fixture.Parent 'fixture-preserved-unknown')
    Move-Item -LiteralPath $preserved -Destination $active
    Assert-True ((Invoke-Child @('-Action', 'Restore', '-Journal', $fixture.Journal) 'unknown-resolved') -eq 0) '冲突解除后恢复失败。'
    Assert-Original $fixture
    $results.Add(@{ case = 'unknown-active'; pass = $true })

    $fixture = New-ActivatedFixture 'reparse-child'
    $external = Join-Path $testRoot 'fixture-external-sentinel'
    New-Item -ItemType Directory -Path $external | Out-Null
    [IO.File]::WriteAllText((Join-Path $external 'sentinel.txt'), 'unchanged')
    $junction = Join-Path $fixture.Parent 'aibrowse\fixture-junction'
    New-Item -ItemType Junction -Path $junction -Target $external | Out-Null
    Assert-True ((Invoke-Child @('-Action', 'Restore', '-Journal', $fixture.Journal) 'reparse-refusal') -ne 0) '重解析点未阻止恢复。'
    Assert-True ((Get-Content -LiteralPath (Join-Path $external 'sentinel.txt') -Raw) -eq 'unchanged') '外部哨兵改变。'
    Move-Item -LiteralPath $junction -Destination (Join-Path $fixture.Parent 'fixture-preserved-junction')
    Assert-True ((Invoke-Child @('-Action', 'Restore', '-Journal', $fixture.Journal) 'reparse-resolved') -eq 0) '移出重解析点后恢复失败。'
    Assert-Original $fixture
    $results.Add(@{ case = 'reparse-child'; pass = $true })

    $fixture = New-ActivatedFixture 'acl-change'
    $manifest = Get-Content -LiteralPath (Join-Path $fixture.Journal 'manifest.json') -Raw | ConvertFrom-Json
    $original = Join-Path $fixture.Parent ('.aibrowse-e1-original-' + $manifest.RunId)
    $savedAcl = Get-Acl -LiteralPath $original
    $changedAcl = Get-Acl -LiteralPath $original
    $changedAcl.SetAccessRuleProtection($true, $true)
    Set-Acl -LiteralPath $original -AclObject $changedAcl
    Assert-True ((Invoke-Child @('-Action', 'Restore', '-Journal', $fixture.Journal) 'acl-refusal') -ne 0) '原件 ACL 变化未阻止恢复。'
    $restoreAcl = [Security.AccessControl.DirectorySecurity]::new()
    $restoreAcl.SetSecurityDescriptorSddlForm($savedAcl.Sddl, [Security.AccessControl.AccessControlSections]::Access)
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($original), $restoreAcl)
    Assert-True ((Invoke-Child @('-Action', 'Restore', '-Journal', $fixture.Journal) 'acl-resolved') -eq 0) '恢复 ACL 后仍失败。'
    Assert-Original $fixture
    $results.Add(@{ case = 'original-acl-change'; pass = $true })

    $fixture = New-Fixture 'mutex'
    $journal = [AIbrowse.ReleaseProfile.Isolation]::Prepare($fixture.Parent, $true, '')
    $digest = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($fixture.Parent.ToUpperInvariant()))
    $mutex = [Threading.Mutex]::new($false, ('Local\AIbrowse.ReleaseProfile.' + [Convert]::ToHexString($digest)))
    Assert-True $mutex.WaitOne(0) '无法持有合成测试互斥。'
    try { Assert-True ((Invoke-Child @('-Action', 'FixtureExercise', '-Journal', $journal) 'mutex-refusal') -ne 0) '排他互斥失败。' }
    finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
    Assert-Original $fixture
    $results.Add(@{ case = 'concurrent-mutex'; pass = $true })

    @{ ok = $true; count = $results.Count; tests = $results; actualProfileMoved = $false } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $testRoot 'report.json') -Encoding utf8
    Write-Output ('合成 profile 故障与冲突验证通过：' + $results.Count + ' 项。证据：' + $testRoot)
}
catch {
    @{ ok = $false; completed = $results; failure = $_.Exception.Message; actualProfileMoved = $false } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $testRoot 'failure.json') -Encoding utf8
    throw
}
