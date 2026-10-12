# This destructive entry point only clears the two explicitly authorized local application views.
[CmdletBinding(DefaultParameterSetName = 'Inspect')]
param(
    [Parameter(Mandatory)][ValidateSet('Inspect', 'Reset')][string]$Action,
    [Parameter(Mandatory, ParameterSetName = 'Inspect')][string]$NativeRoot,
    [Parameter(Mandatory, ParameterSetName = 'Inspect')][string]$EvidenceDirectory,
    [Parameter(Mandatory, ParameterSetName = 'Reset')][string]$PlanPath,
    [Parameter(Mandatory, ParameterSetName = 'Reset')][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$PlanSha256,
    [Parameter(Mandatory, ParameterSetName = 'Reset')][switch]$DiscardAuthorizedLocalData
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'AuthorizedProfileReset.psm1') -Force
if ($Action -cne $PSCmdlet.ParameterSetName) { throw '操作与参数组不符。' }
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$logRoot = Join-Path $repository 'log'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$toolHashes = @{}
foreach ($name in @('reset-authorized-local-profile.ps1', 'AuthorizedProfileReset.psm1', 'AuthorizedProfileMetadata.cs')) {
    $toolHashes[$name] = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash
}

function Assert-EvidencePath([string]$Path) {
    $null = [AIbrowse.ReleaseProfile.AuthorizedProfileMetadata]::Canonical($Path)
    if (-not $Path.StartsWith($logRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '证据只能写入项目 log 子目录。' }
    [AIbrowse.ReleaseProfile.AuthorizedProfileMetadata]::AssertAncestors($Path)
}

if ($Action -eq 'Inspect') {
    $roots = @(Get-ProfileAuthorizedRoots $NativeRoot)
    Assert-EvidencePath $EvidenceDirectory
    if (Test-Path -LiteralPath $EvidenceDirectory) { throw '证据目录已存在；必须保留旧检查并选择新目录。' }
    Assert-ProfileProcessesStopped
    $null = New-Item -ItemType Directory -Path $EvidenceDirectory
    try {
        $views = @(Get-ProfileViews $roots)
        Assert-ProfileMapping $views
        Assert-ProfileProcessesStopped
        $second = @(Get-ProfileViews $roots)
        Assert-ProfileViewsMatch $views $second
        $plan = @{ version = 1; accountSid = $sid; roots = $roots; toolHashes = $toolHashes; views = $views; contentsRead = $false; backupCreated = $false; inspectedUtc = [DateTime]::UtcNow.ToString('O'); maximumEntriesPerView = 20000; maximumDepth = 32 }
        $path = Join-Path $EvidenceDirectory 'plan.json'
        Write-ProfileMetadata $path $plan
        @{ action = 'Inspect'; ok = $true; planPath = $path; planSha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash; views = @($views | Select-Object Root, Exists, Files, Directories, Bytes); contentsRead = $false } | ConvertTo-Json -Depth 6
    } catch {
        Write-ProfileMetadata (Join-Path $EvidenceDirectory 'inspection-failure.json') @{ ok = $false; reason = $_.Exception.Message; contentsRead = $false; roots = $roots }
        throw
    }
} else {
    if (-not $DiscardAuthorizedLocalData) { throw '缺少本次已授权清空的显式开关。' }
    Assert-EvidencePath $PlanPath
    $item = Get-Item -LiteralPath $PlanPath -Force
    if ($item.PSIsContainer -or $item.Length -gt 33554432 -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '计划不是有界普通元数据文件。' }
    $planMetadata = [AIbrowse.ReleaseProfile.AuthorizedProfileMetadata]::Read($PlanPath, '')
    if ($null -eq $planMetadata -or $planMetadata.FinalPath -cne $PlanPath) { throw '计划文件路径包含别名或已经消失。' }
    if ((Get-FileHash -LiteralPath $PlanPath -Algorithm SHA256).Hash -cne $PlanSha256.ToUpperInvariant()) { throw '计划摘要与已审核值不符。' }
    $plan = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json -AsHashtable
    if ($plan.version -ne 1 -or $plan.accountSid -cne $sid -or $plan.roots.Count -ne 2 -or $plan.contentsRead -ne $false) { throw '计划版本、账户或范围不符。' }
    $roots = @(Get-ProfileAuthorizedRoots $plan.roots[1])
    if ($roots[0] -cne $plan.roots[0] -or $roots[1] -cne $plan.roots[1]) { throw '计划不是当前账户的精确授权目录。' }
    foreach ($name in $toolHashes.Keys) {
        if ($plan.toolHashes[$name] -cne $toolHashes[$name]) { throw '清空工具已变化，必须重新 Inspect 并审核计划。' }
    }
    Assert-ProfileProcessesStopped
    $current = @(Get-ProfileViews $roots)
    Assert-ProfileMapping $current
    Assert-ProfileViewsMatch $plan.views $current
    $runDirectory = Join-Path ([IO.Path]::GetDirectoryName($PlanPath)) ('reset-' + [Guid]::NewGuid().ToString('N'))
    Assert-EvidencePath $runDirectory
    $null = New-Item -ItemType Directory -Path $runDirectory
    Write-ProfileMetadata (Join-Path $runDirectory 'intent.json') @{ planPath = $PlanPath; planSha256 = $PlanSha256.ToUpperInvariant(); accountSid = $sid; roots = $roots; toolHashes = $toolHashes; backupCreated = $false; contentsRead = $false; startedUtc = [DateTime]::UtcNow.ToString('O') }
    $result = Invoke-ProfileResetViews $roots $plan.views $runDirectory
    @{ action = 'Reset'; ok = $result.ok; evidenceDirectory = $runDirectory; views = $result.views; contentsRead = $false; backupCreated = $false } | ConvertTo-Json -Depth 6
}
