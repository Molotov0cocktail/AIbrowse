[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Preflight', 'Run', 'ProbeProcess', 'ProbeDataFiles', 'ArchiveFailed', 'FixtureArchive', 'ValidateTamperBinding')][string]$Action,
    [ValidateSet('All', 'Tamper')][string]$Runner = '',
    [string]$PackageRoot,
    [string]$Journal,
    [string]$BindingJournal,
    [uint32]$ProcessId,
    [ValidateSet('RunnerNode', 'ProductOriginal', 'ProductSecond', 'ProductRestart', 'TamperOriginal')][string]$Label = '',
    [ValidateSet('BeforeRestart', 'AfterRestart')][string]$Checkpoint = '',
    [string]$RunId = '',
    [ValidateSet('none', 'rename-before', 'rename-after', 'new-root-created', 'target-exists', 'identity-mismatch')][string]$Fault = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
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
        [AIbrowse.ReleaseProfile.DisposableProfile]::Run(
            $PackageRoot,
            (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source,
            $(if ($Runner -eq 'All') { [AIbrowse.ReleaseProfile.ReleaseRunner]::All } else { [AIbrowse.ReleaseProfile.ReleaseRunner]::Tamper }),
            $BindingJournal
        )
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
    'ValidateTamperBinding' {
        if ($Journal -eq '' -or $PackageRoot -eq '') { throw 'Tamper绑定只读验证缺少固定输入。' }
        [AIbrowse.ReleaseProfile.DisposableProfile]::ValidateTamperBindingEvidence($Journal, $PackageRoot)
    }
    'FixtureArchive' {
        if ($RunId -eq '' -or $Fault -eq '') { throw '归档夹具缺少RunId或故障点。' }
        [AIbrowse.ReleaseProfile.DisposableProfile]::RunArchiveFixture($RunId, $(if ($Fault -eq 'none') { '' } else { $Fault }))
    }
}
