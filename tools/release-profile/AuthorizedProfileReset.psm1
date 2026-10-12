$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSEdition -ne 'Core' -or -not $IsWindows) { throw '需要 Windows PowerShell 7。' }
if (-not ('AIbrowse.ReleaseProfile.AuthorizedProfileMetadata' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'AuthorizedProfileMetadata.cs')
}

function Assert-ProfileProcessNames([string[]]$Names) {
    foreach ($name in $Names) {
        if ([IO.Path]::GetFileNameWithoutExtension($name) -in @('AIbrowse', 'electron', 'guardian', 'lifecycle-guardian')) {
            throw '仍存在 AIbrowse、Electron 或 guardian 进程；停止清空。'
        }
    }
}

function Assert-ProfileProcessesStopped {
    # Query all visible process names; a failed process query is not an empty result.
    $processes = @(Get-Process -ErrorAction Stop)
    Assert-ProfileProcessNames @($processes | ForEach-Object ProcessName)
}

function Get-ProfileAuthorizedRoots([string]$NativeRoot) {
    $logical = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'aibrowse'
    $null = [AIbrowse.ReleaseProfile.AuthorizedProfileMetadata]::Canonical($logical)
    $null = [AIbrowse.ReleaseProfile.AuthorizedProfileMetadata]::Canonical($NativeRoot)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $pattern = '^[A-Za-z]:\\WpSystem\\' + [regex]::Escape($sid) + '\\AppData\\Local\\Packages\\[A-Za-z0-9._-]+\\LocalCache\\Roaming\\aibrowse$'
    if ($NativeRoot -notmatch $pattern -or $logical -ieq $NativeRoot) { throw 'native 根不符合当前账户的独立应用叶目录边界。' }
    return @($logical, $NativeRoot)
}

function Get-ProfileViews([string[]]$Roots) {
    if ($Roots.Count -ne 2 -or $Roots[0] -ieq $Roots[1]) { throw '必须保留两个不同路径视图。' }
    foreach ($root in $Roots) {
        if ([IO.Path]::GetFileName($root) -cne 'aibrowse') { throw '只能处理精确 aibrowse 叶目录。' }
        [AIbrowse.ReleaseProfile.AuthorizedProfileMetadata]::Snapshot($root, $Roots)
    }
}

function Assert-ProfileMapping([object[]]$Views) {
    if ($Views.Count -ne 2) { throw '必须保留两个授权路径的存在状态。' }
    if (-not $Views[0].Exists -or -not $Views[1].Exists) {
        # Removing an overlay can reveal a different physical root. Only a new stable plan may admit it.
        foreach ($view in $Views) {
            foreach ($entry in $view.Entries) {
                $expected = if ($entry.RelativePath.Length -eq 0) { $view.Root } else { Join-Path $view.Root $entry.RelativePath }
                if ($entry.FinalPath -ine $expected) { throw '单一剩余视图仍存在跨根映射，不能生成续清计划。' }
            }
        }
        return
    }
    if ($Views[0].Entries[0].Identity -cne $Views[1].Entries[0].Identity) { throw '逻辑与 native 根身份不相同。' }
    $nativeEntries = @{}
    foreach ($entry in $Views[1].Entries) { $nativeEntries[$entry.RelativePath] = $entry }
    $mappedFiles = 0
    foreach ($entry in $Views[0].Entries) {
        if ($entry.RelativePath.Length -eq 0) { continue }
        $expected = Join-Path $Views[1].Root $entry.RelativePath
        if ($entry.FinalPath -ieq $expected) {
            if (-not $nativeEntries.ContainsKey($entry.RelativePath) -or $nativeEntries[$entry.RelativePath].Identity -cne $entry.Identity) {
                throw '逻辑子项与 native 视图身份不相符。'
            }
            if (-not $entry.Directory) { $mappedFiles++ }
        }
    }
    if ($mappedFiles -lt 1) { throw '缺少逻辑文件实际映射到 native 根的身份依据。' }
}

function Assert-ProfileViewsMatch([object[]]$Expected, [object[]]$Actual, [switch]$AllowRemoval) {
    if ($Expected.Count -ne 2 -or $Actual.Count -ne 2) { throw '视图数量不符。' }
    for ($i = 0; $i -lt 2; $i++) {
        $old = $Expected[$i]; $current = $Actual[$i]
        if ($old.Root -cne $current.Root) { throw '视图路径变化。' }
        if (-not $AllowRemoval -and ($old.Exists -ne $current.Exists -or $old.Entries.Count -ne $current.Entries.Count)) {
            throw '检查后目录成员数量或存在状态变化。'
        }
        $expectedEntries = @{}
        foreach ($entry in $old.Entries) {
            if ($expectedEntries.ContainsKey($entry.RelativePath)) { throw '计划中存在重复路径。' }
            $expectedEntries[$entry.RelativePath] = $entry
        }
        foreach ($entry in $current.Entries) {
            if (-not $expectedEntries.ContainsKey($entry.RelativePath)) { throw '发现检查后新增的目录成员。' }
            $previous = $expectedEntries[$entry.RelativePath]
            foreach ($field in @('Identity', 'Directory', 'Length', 'Created', 'Links')) {
                if ($previous.$field -cne $entry.$field) { throw "检查后成员身份或元数据变化：$field" }
            }
            if (-not $AllowRemoval -or -not $entry.Directory) {
                foreach ($field in @('FinalPath', 'Attributes', 'Written')) {
                    if ($previous.$field -cne $entry.$field) { throw "检查后成员元数据变化：$field" }
                }
            }
        }
    }
}

function Write-ProfileMetadata([string]$Path, [object]$Value) {
    $json = $Value | ConvertTo-Json -Depth 16
    if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 33554432) { throw '元数据证据超出 32 MiB 预算。' }
    # Evidence uses create-new to retain earlier attempts without overwriting failures.
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
}

function Invoke-ProfileResetViews([string[]]$Roots, [object[]]$Expected, [string]$EvidenceDirectory) {
    # Callers validate production/fixture ownership before entering this shared deletion kernel.
    $steps = [Collections.Generic.List[object]]::new()
    try {
        Assert-ProfileProcessesStopped
        $before = @(Get-ProfileViews $Roots)
        Assert-ProfileViewsMatch $Expected $before
        Write-ProfileMetadata (Join-Path $EvidenceDirectory 'before.json') @{ contentsRead = $false; views = $before }
        for ($i = 0; $i -lt 2; $i++) {
            Assert-ProfileProcessesStopped
            $current = @(Get-ProfileViews $Roots)
            Assert-ProfileViewsMatch $Expected $current -AllowRemoval
            Write-ProfileMetadata (Join-Path $EvidenceDirectory "step-$i-before.json") @{ views = $current }
            $root = $Roots[$i]
            if ($current[$i].Exists) {
                # Recheck the absolute root immediately before native PowerShell deletion.
                $null = [AIbrowse.ReleaseProfile.AuthorizedProfileMetadata]::Canonical($root)
                [AIbrowse.ReleaseProfile.AuthorizedProfileMetadata]::AssertAncestors($root)
                $identity = [AIbrowse.ReleaseProfile.AuthorizedProfileMetadata]::Read($root, '')
                if ($null -eq $identity -or $identity.Identity -cne $current[$i].Entries[0].Identity -or -not $identity.Directory) {
                    throw '删除前目录身份变化。'
                }
                Microsoft.PowerShell.Management\Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
                $action = 'removed'
            } else { $action = 'already-absent' }
            $after = @(Get-ProfileViews $Roots)
            Assert-ProfileViewsMatch $Expected $after -AllowRemoval
            $steps.Add(@{ index = $i; root = $root; action = $action; views = $after })
            Write-ProfileMetadata (Join-Path $EvidenceDirectory "step-$i-after.json") $steps[$steps.Count - 1]
        }
        Assert-ProfileProcessesStopped
        $final = @(Get-ProfileViews $Roots)
        foreach ($view in $final) {
            if ($view.Exists -and $view.Entries.Count -ne 1) { throw '授权目录仍有残留，不能视作清空成功。' }
        }
        $result = @{ ok = $true; contentsRead = $false; backupCreated = $false; views = $final; steps = $steps; completedUtc = [DateTime]::UtcNow.ToString('O') }
        Write-ProfileMetadata (Join-Path $EvidenceDirectory 'result.json') $result
        return $result
    } catch {
        $reason = $_.Exception.Message
        $residuals = @()
        $observationFailed = $false
        try { $residuals = @(Get-ProfileViews $Roots) } catch { $observationFailed = $true }
        Write-ProfileMetadata (Join-Path $EvidenceDirectory 'failure.json') @{ ok = $false; reason = $reason; contentsRead = $false; backupCreated = $false; steps = $steps; residuals = $residuals; residualObservationFailed = $observationFailed }
        throw
    }
}

Export-ModuleMember -Function Assert-ProfileProcessNames, Assert-ProfileProcessesStopped, Get-ProfileAuthorizedRoots, Get-ProfileViews, Assert-ProfileMapping, Assert-ProfileViewsMatch, Write-ProfileMetadata, Invoke-ProfileResetViews
