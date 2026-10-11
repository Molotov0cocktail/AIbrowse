param([Parameter(Mandatory=$true)][string]$PlanPath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$archive = 'D:\AIbrowse\log\local-archive'
$planFull = [IO.Path]::GetFullPath($PlanPath)
if (-not $planFull.StartsWith('D:\AIbrowse\log\maintenance\', [StringComparison]::OrdinalIgnoreCase)) { throw '计划路径越界。' }
$plan = Get-Content -LiteralPath $planFull -Raw | ConvertFrom-Json
$receipt = Join-Path ([IO.Path]::GetDirectoryName($planFull)) 'archive-moves.json'
if (Test-Path -LiteralPath $receipt) { throw '迁移回执已存在，拒绝覆盖。' }
if (@(Get-Process | Where-Object ProcessName -match '^(AIbrowse|aibrowse-guardian|electron)$').Count) { throw '应用仍在运行。' }
function Assert-OrdinaryPath([string]$Path) {
    $candidate=$Path
    while ($candidate) {
        $item=Get-Item -LiteralPath $candidate -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('拒绝链接路径：'+$candidate) }
        $candidate=[IO.Path]::GetDirectoryName($candidate.TrimEnd('\'))
    }
}
function Read-TreeMetadata([string]$Root) {
    $pending=[Collections.Generic.Stack[string]]::new()
    $pending.Push($Root)
    $files=0L; $bytes=0L; $directories=0L
    while ($pending.Count) {
        foreach($entry in @(Get-ChildItem -LiteralPath $pending.Pop() -Force)) {
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '历史备份含链接，保留原位。' }
            if ($entry.PSIsContainer) { $directories++; $pending.Push($entry.FullName) } else { $files++; $bytes+=$entry.Length }
        }
    }
    return [pscustomobject]@{files=$files;directories=$directories;logicalBytes=$bytes}
}
Assert-OrdinaryPath $archive
$profileDestination=Join-Path $archive 'profiles'
if (Test-Path -LiteralPath $profileDestination) { Assert-OrdinaryPath $profileDestination } else { [void][IO.Directory]::CreateDirectory($profileDestination) }
$rows=[Collections.Generic.List[object]]::new()
$status='running'
try {
    foreach($root in @($plan.preservedProfiles.roots)) {
        $source=[IO.Path]::GetFullPath([string]$root.Path)
        if ($source -cne $root.Path -or $source -notmatch '^D:\\WpSystem\\[^\\]+\\AppData\\Local\\Packages\\[^\\]+\\LocalCache\\Roaming\\\.aibrowse-e1-preserved-[0-9a-f]+$') { throw '历史profile源路径不符。' }
        $destination=[IO.Path]::GetFullPath((Join-Path $profileDestination ([IO.Path]::GetFileName($source))))
        if (-not $destination.StartsWith($profileDestination+'\',[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $destination)) { throw '迁移目标越界或已存在。' }
        Assert-OrdinaryPath $source
        Assert-OrdinaryPath $profileDestination
        $before=Read-TreeMetadata $source
        if ($before.files -ne $root.Files -or $before.logicalBytes -ne $root.LogicalBytes) { throw '历史profile元数据偏离已核清单。' }
        $aclBefore=(Get-Acl -LiteralPath $source).Sddl
        # Both canonical paths are on D:; this is a directory rename, not credential copying or parsing.
        Move-Item -LiteralPath $source -Destination $destination
        $after=Read-TreeMetadata $destination
        $aclSame=(Get-Acl -LiteralPath $destination).Sddl -ceq $aclBefore
        if ((Test-Path -LiteralPath $source) -or $after.files -ne $before.files -or $after.logicalBytes -ne $before.logicalBytes -or $after.directories -ne $before.directories -or -not $aclSame) { throw '同卷迁移后核对不符。' }
        $rows.Add([pscustomobject]@{source=$source;destination=$destination;files=$after.files;logicalBytes=$after.logicalBytes;aclPreserved=$aclSame;status='moved_same_volume'})
    }
    $source=[IO.Path]::GetFullPath([string]$plan.documentsBackup.source)
    $destination=[IO.Path]::GetFullPath([string]$plan.documentsBackup.destination)
    if ($source -notmatch '^C:\\Users\\[^\\]+\\Documents\\AIbrowse-backup\.aibak$' -or $destination -cne (Join-Path $archive 'exports\AIbrowse-backup.aibak')) { throw '备份导出路径不符。' }
    Assert-OrdinaryPath $source
    if (Test-Path -LiteralPath $destination) { throw '导出归档已存在。' }
    $parent=[IO.Path]::GetDirectoryName($destination)
    if (Test-Path -LiteralPath $parent) { Assert-OrdinaryPath $parent } else { [void][IO.Directory]::CreateDirectory($parent) }
    Assert-OrdinaryPath $parent
    $length=(Get-Item -LiteralPath $source).Length
    if ($length -ne $plan.documentsBackup.bytes) { throw '备份导出大小偏离已核清单。' }
    Copy-Item -LiteralPath $source -Destination $destination
    if ((Get-Item -LiteralPath $destination).Length -ne $length -or (Get-FileHash -LiteralPath $source).Hash -cne (Get-FileHash -LiteralPath $destination).Hash) { throw '备份归档校验失败，原件保留。' }
    Remove-Item -LiteralPath $source
    $rows.Add([pscustomobject]@{source=$source;destination=$destination;files=1;logicalBytes=$length;status='copied_verified_source_removed'})
    $status='completed'
} catch { $status='stopped'; $rows.Add([pscustomobject]@{status='error';message=$_.Exception.Message}) }
finally {
    $result=[ordered]@{status=$status;credentialContentsRead=$false;entries=$rows;endedUtc=[DateTime]::UtcNow.ToString('o')}
    $stream=[IO.File]::Open($receipt,[IO.FileMode]::CreateNew)
    try { $bytes=[Text.Encoding]::UTF8.GetBytes(($result|ConvertTo-Json -Depth 5)); $stream.Write($bytes,0,$bytes.Length) } finally {$stream.Dispose()}
}
if ($status -ne 'completed') { throw '归档迁移未全部完成，详见本地回执。' }
Write-Output ('归档完成：'+$rows.Count+'项；没有读取凭据内容。')
