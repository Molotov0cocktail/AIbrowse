[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Preflight', 'Run', 'ProbeProcess', 'ProbeDataFiles', 'ArchiveFailed', 'ArchiveCompleted', 'FixtureArchive', 'ValidateTamperBinding')][string]$Action,
    [ValidateSet('All', 'Tamper', 'ProductTransfer', 'RestoreR', 'RestoreP')][string]$Runner = '',
    [string]$PackageRoot,
    [string]$Journal,
    [string]$BindingJournal,
    [uint32]$ProcessId,
    [ValidateSet('RunnerNode', 'ProductOriginal', 'ProductSecond', 'ProductRestart', 'TamperOriginal')][string]$Label = '',
    [ValidateSet('BeforeRestart', 'AfterRestart')][string]$Checkpoint = '',
    [string]$RunId = '',
    [ValidateSet('none', 'rename-before', 'rename-after', 'new-root-created', 'target-exists', 'identity-mismatch')][string]$Fault = '',
    [string]$RestoreScopeId = '',
    [string]$RestoreProofSha256 = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$restoreArguments = $PSBoundParameters.ContainsKey('RestoreScopeId') -or $PSBoundParameters.ContainsKey('RestoreProofSha256')
$restoreRun = $Action -eq 'Run' -and $Runner -in @('RestoreR', 'RestoreP')
if ($restoreArguments -or $restoreRun) {
    if ((-not $restoreRun -and $Action -ne 'ArchiveCompleted') -or
        $RestoreScopeId -cnotmatch '^restore-campaign-[a-f0-9]{32}$' -or
        $RestoreProofSha256 -cnotmatch '^[a-f0-9]{64}$' -or $BindingJournal -ne '') {
        throw '恢复固定入口与外部冻结proof参数不一致。'
    }
}
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
    throw '需要现成PowerShell 7；工具不安装任何运行时。'
}
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$env:AIBROWSE_PROFILE_TOOL_REPOSITORY = $repository
Add-Type -Path (Join-Path $PSScriptRoot 'DisposableProfile.cs'), (Join-Path $PSScriptRoot 'ProfileIsolation.cs'), (Join-Path $PSScriptRoot 'JobProcess.cs'), (Join-Path $PSScriptRoot 'ReleaseDataIdentity.cs')
switch ($Action) {
    'Preflight' { [AIbrowse.ReleaseProfile.DisposableProfile]::Preflight() }
    'Run' {
        if ($Runner -eq '') { throw '实际入口必须选择固定Runner。' }
        $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
        if ($restoreRun) {
            [AIbrowse.ReleaseProfile.DisposableProfile]::Run($PackageRoot, $node, [AIbrowse.ReleaseProfile.ReleaseRunner]::$Runner, $BindingJournal, $RestoreScopeId, $RestoreProofSha256)
        } else {
            [AIbrowse.ReleaseProfile.DisposableProfile]::Run($PackageRoot, $node, [AIbrowse.ReleaseProfile.ReleaseRunner]::$Runner, $BindingJournal)
        }
    }
    'ProbeProcess' {
        if ($Label -eq '' -or $ProcessId -eq 0) { throw '进程探针缺少固定标签或PID。' }
        [AIbrowse.ReleaseProfile.DisposableProfile]::RecordProcessIdentity($Journal, $ProcessId, $Label)
    }
    'ProbeDataFiles' {
        if ($Checkpoint -eq '' -or $Journal -eq '') { throw '数据文件身份探针缺少固定检查点或journal。' }
        [AIbrowse.ReleaseProfile.ReleaseDataIdentity]::Record($Journal, $Checkpoint)
    }
    'ArchiveFailed' {
        if ($Journal -eq '') { throw '失败归档缺少固定journal。' }
        [AIbrowse.ReleaseProfile.DisposableProfile]::ArchiveFailedRun($Journal)
    }
    'ArchiveCompleted' {
        if ($Journal -eq '') { throw '成功归档缺少固定journal。' }
        if ($restoreArguments) {
            [AIbrowse.ReleaseProfile.DisposableProfile]::ArchiveCompletedRun($Journal, $RestoreScopeId, $RestoreProofSha256)
        } else {
            [AIbrowse.ReleaseProfile.DisposableProfile]::ArchiveCompletedRun($Journal)
        }
    }
    'ValidateTamperBinding' {
        if ($Journal -eq '' -or $PackageRoot -eq '') { throw 'Tamper绑定只读验证缺少固定输入。' }
        [AIbrowse.ReleaseProfile.DisposableProfile]::ValidateTamperBindingEvidence($Journal, $PackageRoot)
    }
    'FixtureArchive' {
        if ($RunId -eq '' -or $Fault -eq '') { throw '归档夹具缺少RunId或故障点。' }
        [AIbrowse.ReleaseProfile.DisposableProfile]::RunArchiveFixture($RunId, $(if ($Fault -eq 'none') { '' } else { $Fault }))
    }
}
