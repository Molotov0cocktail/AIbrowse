[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Preflight', 'Restore', 'Run', 'FixturePrepare', 'FixtureExercise')][string]$Action,
    [string]$Journal,
    [string]$FixtureParent,
    [string]$PackageRoot,
    [ValidateSet('Tamper', 'Product')][string]$Runner = '',
    [string]$Fault = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
    throw '需要现成 PowerShell 7；工具不安装任何运行时。'
}
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$env:AIBROWSE_PROFILE_TOOL_REPOSITORY = $repository
$env:AIBROWSE_PROFILE_TOOL_NODE = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
Add-Type -Path (Join-Path $PSScriptRoot 'ProfileIsolation.cs'), (Join-Path $PSScriptRoot 'JobProcess.cs')
if ($Fault -ne '' -and $Fault -notin [AIbrowse.ReleaseProfile.Isolation]::FaultPoints) { throw '未知故障点。' }
switch ($Action) {
    'Preflight' {
        [AIbrowse.ReleaseProfile.Isolation]::Preflight([Environment]::GetFolderPath('ApplicationData'))
    }
    'Restore' {
        if ($Fault -ne '') { throw '独立恢复入口不接受故障注入。' }
        [AIbrowse.ReleaseProfile.Isolation]::Restore($Journal, '')
        '原 profile FileID 与 ACL 已确认恢复；所有合成目录和日志保留。'
    }
    'Run' {
        if ($Fault -ne '') { throw '实际入口不接受故障注入。' }
        if ($Runner -eq '') { throw '实际入口必须选择固定Runner。' }
        $runnerValue = switch ($Runner) {
            'Tamper' { [AIbrowse.ReleaseProfile.ReleaseRunner]::Tamper }
            'Product' { [AIbrowse.ReleaseProfile.ReleaseRunner]::Product }
        }
        [AIbrowse.ReleaseProfile.Isolation]::Run(
            $PackageRoot,
            (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source,
            $runnerValue
        )
    }
    'FixturePrepare' {
        [AIbrowse.ReleaseProfile.Isolation]::Prepare($FixtureParent, $true, $Fault)
    }
    'FixtureExercise' {
        [AIbrowse.ReleaseProfile.Isolation]::Exercise($Journal, $Fault)
    }
}
