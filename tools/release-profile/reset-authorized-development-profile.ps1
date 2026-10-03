# Requires explicit user authorization to discard this account's development data.
# Never invoke this to discard a synthetic test failure or as automatic test cleanup.
[CmdletBinding()]
param([Parameter(Mandatory)][switch]$DiscardAuthorizedDevelopmentData)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $DiscardAuthorizedDevelopmentData) { throw '缺少明确开发数据清空开关。' }
if ($PSVersionTable.PSEdition -ne 'Core') { throw '需要 PowerShell 7。' }
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$parent = [IO.Path]::GetFullPath([Environment]::GetFolderPath('ApplicationData'))
$target = [IO.Path]::GetFullPath((Join-Path $parent 'aibrowse'))
if ([IO.Path]::GetDirectoryName($target) -cne $parent -or [IO.Path]::GetFileName($target) -cne 'aibrowse') { throw '目标不在明确授权目录。' }
if (@(Get-Process -Name AIbrowse,electron -ErrorAction SilentlyContinue).Count -ne 0) { throw '仍存在产品或 Electron 进程。' }
$item = Get-Item -LiteralPath $target -Force
if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '目标不是普通开发数据目录。' }
if ([IO.Path]::GetFullPath((Resolve-Path -LiteralPath $target).Path) -cne $target) { throw '目标解析不一致。' }
if (Test-Path -LiteralPath (Join-Path $target '.aibrowse-e1-synthetic-owner.json')) { throw '该目录属于合成测试，不得清除失败证据。' }
$entries = @(Get-ChildItem -LiteralPath $target -Recurse -Force)
foreach ($entry in $entries) {
    if (-not $entry.FullName.StartsWith($target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '子项越界。' }
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '发现重解析子项，停止清空。' }
}
$evidence = Join-Path $repository ('log/stage7-e1/authorized-profile-reset-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $evidence
@{ target=$target; parent=$parent; entryCount=$entries.Count; userAuthorization='明确允许清空当前开发版AIbrowse数据'; contentsRead=$false; startedUtc=[DateTime]::UtcNow.ToString('O') } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'intent.json') -Encoding utf8
# The resolved absolute target was checked above; deletion stays in this shell.
Remove-Item -LiteralPath $target -Recurse -Force
if (Test-Path -LiteralPath $target) { throw '授权目录未完全移除；保留当前状态，禁止当成功。' }
$null = New-Item -ItemType Directory -Path $target
@{ target=$target; entriesAfter=@(Get-ChildItem -LiteralPath $target -Force).Count; completedUtc=[DateTime]::UtcNow.ToString('O') } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'result.json') -Encoding utf8
Write-Output "授权开发数据已清空并创建空目录。证据：$evidence"
