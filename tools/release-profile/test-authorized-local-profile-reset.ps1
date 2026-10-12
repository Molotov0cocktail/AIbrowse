[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'AuthorizedProfileReset.psm1') -Force
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$fixtureBase = Join-Path $repository ('log\authorized-profile-reset-tests-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $fixtureBase
$results = [Collections.Generic.List[object]]::new()

function Assert-True([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Rejected([scriptblock]$Action, [string]$Pattern) {
    $message = ''
    try { & $Action | Out-Null } catch { $message = $_.Exception.Message }
    if ($message -notmatch $Pattern) { throw "未得到预期拒绝：$Pattern；实际：$message" }
}
function New-Fixture([string]$Name) {
    $base = Join-Path $fixtureBase $Name
    $roots = @((Join-Path $base 'logical\aibrowse'), (Join-Path $base 'native\aibrowse'))
    foreach ($root in $roots) {
        Assert-True ($root.StartsWith($fixtureBase + '\', [StringComparison]::OrdinalIgnoreCase)) '夹具越界。'
        $null = New-Item -ItemType Directory -Path (Join-Path $root 'nested') -Force
        [IO.File]::WriteAllText((Join-Path $root 'nested\synthetic.txt'), 'synthetic fixture only')
        [IO.File]::WriteAllText((Join-Path ([IO.Path]::GetDirectoryName($root)) 'sibling-canary.txt'), 'must remain')
    }
    [IO.File]::WriteAllText((Join-Path $roots[0] 'logical-only.txt'), 'logical view')
    [IO.File]::WriteAllText((Join-Path $roots[1] 'native-only.txt'), 'native view')
    $evidence = Join-Path $base 'evidence'
    $null = New-Item -ItemType Directory -Path $evidence
    return @{ roots = $roots; evidence = $evidence; base = $base }
}
function Add-Pass([string]$Name) { $results.Add(@{ case = $Name; pass = $true }) }

try {
    foreach ($bad in @('C:\', 'C:\aibrowse\..\other', 'C:\aibrowse\', 'C:\aibrowse.', 'C:\aibrowse ', 'C:\aibrowse:stream', '\\server\share\aibrowse', '\\?\C:\aibrowse', 'C:/aibrowse')) {
        Assert-Rejected { [AIbrowse.ReleaseProfile.AuthorizedProfileMetadata]::Canonical($bad) } '拒绝'
    }
    Add-Pass 'canonical-boundary-aliases'
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($bad in @((Join-Path $repository 'aibrowse'), 'D:\WpSystem\S-1-5-18\AppData\Local\Packages\Fixture\LocalCache\Roaming\aibrowse', "D:\WpSystem\$currentSid\AppData\Local\Packages\Fixture\LocalCache\Roaming")) {
        Assert-Rejected { Get-ProfileAuthorizedRoots $bad } 'native 根'
    }
    Add-Pass 'production-account-and-leaf-policy'
    foreach ($name in @('AIbrowse', 'electron.exe', 'guardian', 'lifecycle-guardian.exe', 'ELECTRON')) {
        Assert-Rejected { Assert-ProfileProcessNames @('pwsh', $name) } '仍存在'
    }
    Assert-ProfileProcessNames @('pwsh', 'Codex')
    Add-Pass 'all-four-process-names'

    $fixture = New-Fixture 'success'
    $views = @(Get-ProfileViews $fixture.roots)
    Assert-True ($views.Count -eq 2 -and $views[0].Files -eq 2 -and $views[1].Files -eq 2) '两个视图未单独完整枚举。'
    Assert-ProfileViewsMatch $views @(Get-ProfileViews $fixture.roots)
    Assert-Rejected { Assert-ProfileMapping $views } '根身份'
    $result = Invoke-ProfileResetViews $fixture.roots $views $fixture.evidence
    Assert-True ($result.ok -and $result.steps.Count -eq 2) '未完成两个路径清空。'
    foreach ($root in $fixture.roots) {
        Assert-True (-not (Test-Path -LiteralPath $root)) '合成根仍有残留。'
        Assert-True (Test-Path -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($root)) 'sibling-canary.txt')) '误删兄弟目录文件。'
    }
    Assert-True (@(Get-ChildItem -LiteralPath $fixture.evidence -File).Count -eq 6) '未保存每步两个视图及终态。'
    Add-Pass 'two-views-remove-and-preserve-siblings'

    $fixture = New-Fixture 'long-path'
    $long = $fixture.roots[1]
    for ($i = 0; $i -lt 12; $i++) { $long = Join-Path $long 'long-cache-member'; $null = New-Item -ItemType Directory -Path $long }
    $longFile = Join-Path $long 'long-synthetic-cache.txt'
    Assert-True ($longFile.Length -gt 260) '长路径反例没有超过旧 Win32 限制。'
    [IO.File]::WriteAllText($longFile, 'long synthetic metadata fixture')
    $views = @(Get-ProfileViews $fixture.roots)
    Assert-True ($views[1].Files -eq 3) '长路径成员未进入完整扫描。'
    $result = Invoke-ProfileResetViews $fixture.roots $views $fixture.evidence
    Assert-True ($result.ok -and -not (Test-Path -LiteralPath $longFile)) '长路径没有通过同一清空路径。'
    Add-Pass 'long-path-metadata-and-delete'

    $fixture = New-Fixture 'absent-native'
    $native = [AIbrowse.ReleaseProfile.AuthorizedProfileMetadata]::Canonical($fixture.roots[1])
    Assert-True ($native.StartsWith($fixtureBase + '\', [StringComparison]::OrdinalIgnoreCase)) '合成 native 删除范围越界。'
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $native -Recurse -Force
    $views = @(Get-ProfileViews $fixture.roots)
    Assert-True ($views[0].Exists -and -not $views[1].Exists) '缺失 native 的反例不成立。'
    Assert-ProfileMapping $views
    $result = Invoke-ProfileResetViews $fixture.roots $views $fixture.evidence
    Assert-True ($result.ok -and $result.steps[1].action -eq 'already-absent') '新计划未安全清空单一剩余视图。'
    Add-Pass 'absent-native-new-plan-clears-remaining-view'

    $fixture = New-Fixture 'absent-native-identity-change'
    $native = [AIbrowse.ReleaseProfile.AuthorizedProfileMetadata]::Canonical($fixture.roots[1])
    Assert-True ($native.StartsWith($fixtureBase + '\', [StringComparison]::OrdinalIgnoreCase)) '合成 native 删除范围越界。'
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $native -Recurse -Force
    $views = @(Get-ProfileViews $fixture.roots)
    Assert-ProfileMapping $views
    $oldRoot = [AIbrowse.ReleaseProfile.AuthorizedProfileMetadata]::Canonical($fixture.roots[0])
    $retained = [AIbrowse.ReleaseProfile.AuthorizedProfileMetadata]::Canonical((Join-Path $fixture.base 'previous-synthetic-root'))
    Assert-True ($oldRoot.StartsWith($fixtureBase + '\', [StringComparison]::OrdinalIgnoreCase) -and $retained.StartsWith($fixtureBase + '\', [StringComparison]::OrdinalIgnoreCase)) '合成身份替换越界。'
    Microsoft.PowerShell.Management\Move-Item -LiteralPath $oldRoot -Destination $retained
    $null = New-Item -ItemType Directory -Path (Join-Path $oldRoot 'nested')
    [IO.File]::WriteAllText((Join-Path $oldRoot 'nested\synthetic.txt'), 'synthetic fixture only')
    [IO.File]::WriteAllText((Join-Path $oldRoot 'logical-only.txt'), 'logical view')
    Assert-Rejected { Invoke-ProfileResetViews $fixture.roots $views $fixture.evidence } '变化：Identity'
    Assert-True (Test-Path -LiteralPath (Join-Path $oldRoot 'logical-only.txt')) '新计划后的身份变化未在删除前拒绝。'
    Add-Pass 'absent-native-plan-still-rejects-root-identity-change'

    $fixture = New-Fixture 'absent-native-wrong-mapping'
    $views = @(Get-ProfileViews $fixture.roots)
    $views[1].Exists = $false
    $views[1].Entries = @()
    $views[0].Entries[0].FinalPath = $fixture.roots[1]
    Assert-Rejected { Assert-ProfileMapping $views } '跨根映射'
    Add-Pass 'absent-native-cross-root-mapping-rejected'

    $fixture = New-Fixture 'stale-plan'
    $views = @(Get-ProfileViews $fixture.roots)
    [IO.File]::WriteAllText((Join-Path $fixture.roots[1] 'added.txt'), 'new data after inspect')
    Assert-Rejected { Invoke-ProfileResetViews $fixture.roots $views $fixture.evidence } '变化'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture.roots[0] 'logical-only.txt')) '旧计划被拒绝前发生删除。'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture.evidence 'failure.json')) '缺少失败与残留证据。'
    Add-Pass 'stale-plan-new-file-no-delete'

    $fixture = New-Fixture 'changed-file'
    $views = @(Get-ProfileViews $fixture.roots)
    [IO.File]::WriteAllText((Join-Path $fixture.roots[0] 'logical-only.txt'), 'changed after inspect and longer')
    Assert-Rejected { Invoke-ProfileResetViews $fixture.roots $views $fixture.evidence } '变化'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture.roots[1] 'native-only.txt')) '元数据变化后仍删除另一视图。'
    Add-Pass 'stale-plan-metadata-no-delete'

    $fixture = New-Fixture 'junction-child'
    $outside = Join-Path $fixture.base 'unrelated'
    $null = New-Item -ItemType Directory -Path $outside
    [IO.File]::WriteAllText((Join-Path $outside 'canary.txt'), 'must remain')
    $null = New-Item -ItemType Junction -Path (Join-Path $fixture.roots[0] 'alias') -Target $outside
    Assert-Rejected { Get-ProfileViews $fixture.roots } '重解析'
    Assert-True (Test-Path -LiteralPath (Join-Path $outside 'canary.txt')) '越界 canary 丢失。'
    Add-Pass 'junction-child-rejected'

    $fixture = New-Fixture 'junction-root'
    $aliasParent = Join-Path $fixture.base 'alias'
    $null = New-Item -ItemType Junction -Path $aliasParent -Target ([IO.Path]::GetDirectoryName($fixture.roots[0]))
    Assert-Rejected { Get-ProfileViews @((Join-Path $aliasParent 'aibrowse'), $fixture.roots[1]) } '重解析'
    Add-Pass 'junction-ancestor-rejected'

    $fixture = New-Fixture 'hardlink'
    $null = New-Item -ItemType HardLink -Path (Join-Path $fixture.roots[1] 'linked.txt') -Target (Join-Path $fixture.roots[0] 'logical-only.txt')
    Assert-Rejected { Get-ProfileViews $fixture.roots } '硬链接'
    Add-Pass 'hardlink-rejected'

    $fixture = New-Fixture 'depth-budget'
    $deep = $fixture.roots[0]
    for ($i = 0; $i -lt 33; $i++) { $deep = Join-Path $deep 'd'; $null = New-Item -ItemType Directory -Path $deep }
    Assert-Rejected { Get-ProfileViews $fixture.roots } '预算'
    Add-Pass 'depth-budget-rejected'

    $fixture = New-Fixture 'active-guardian'
    $views = @(Get-ProfileViews $fixture.roots)
    $guardianPath = Join-Path $fixture.base 'guardian.exe'
    Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\ping.exe') -Destination $guardianPath
    $guardian = Start-Process -FilePath $guardianPath -ArgumentList @('-t', '127.0.0.1') -PassThru -WindowStyle Hidden
    try {
        Assert-Rejected { Invoke-ProfileResetViews $fixture.roots $views $fixture.evidence } '仍存在'
        foreach ($root in $fixture.roots) { Assert-True (Test-Path -LiteralPath $root) '进程拒绝发生在删除之后。' }
    } finally { if (-not $guardian.HasExited) { Stop-Process -Id $guardian.Id -ErrorAction Stop; $guardian.WaitForExit() } }
    Add-Pass 'live-guardian-rejected-before-delete'

    $fixture = New-Fixture 'evidence-create-new'
    $path = Join-Path $fixture.evidence 'existing.json'
    Write-ProfileMetadata $path @{ retained = $true }
    Assert-Rejected { Write-ProfileMetadata $path @{ retained = $false } } 'already exists|已经存在|已存在'
    Assert-True ((Get-Content -LiteralPath $path -Raw | ConvertFrom-Json).retained) '既有失败证据被覆盖。'
    Add-Pass 'failure-evidence-not-overwritten'
    Write-ProfileMetadata (Join-Path $fixtureBase 'test-result.json') @{ ok = $true; results = $results; originalProfileRead = $false; originalProfileModified = $false }
    Write-Output ("PASS {0} 项；合成证据：{1}" -f $results.Count, $fixtureBase)
} catch {
    Write-ProfileMetadata (Join-Path $fixtureBase 'test-failure.json') @{ ok = $false; reason = $_.Exception.Message; results = $results; originalProfileRead = $false; originalProfileModified = $false }
    throw
}
