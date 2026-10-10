[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Preflight', 'Run')][string]$Action,
    [switch]$Acknowledge5GiB
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
    throw '需要现成PowerShell 7；工具不安装任何运行时。'
}
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$logRoot = Join-Path $repository 'log'
$stageRoot = Join-Path $logRoot 'stage7-e2'
$requiredFreeBytes = [int64](6GB)
$candidateBytes = [int64](5GB)
$timeBudgetMs = 300000

function Enter-FixedEnvironment {
    $saved = @{}
    $allow = @('SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'USERDOMAIN', 'USERNAME', 'COMSPEC', 'PATHEXT', 'PATH', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE')
    foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
        if ($allow -notcontains [string]$entry.Key) {
            $saved[[string]$entry.Key] = [string]$entry.Value
            [Environment]::SetEnvironmentVariable([string]$entry.Key, [NullString]::Value, 'Process')
        }
    }
    return $saved
}

function Restore-FixedEnvironment([hashtable]$Saved) {
    foreach ($entry in $Saved.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
}

function Assert-OrdinaryDirectory([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw ('资格路径不是普通目录或含重解析点：' + $item.Name)
    }
}

function Initialize-FixedRoot {
    Assert-OrdinaryDirectory $repository
    if (-not (Test-Path -LiteralPath $logRoot)) { New-Item -ItemType Directory -Path $logRoot | Out-Null }
    Assert-OrdinaryDirectory $logRoot
    if (-not (Test-Path -LiteralPath $stageRoot)) { New-Item -ItemType Directory -Path $stageRoot | Out-Null }
    Assert-OrdinaryDirectory $stageRoot
}

function Get-Preflight {
    Initialize-FixedRoot
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $saved = Enter-FixedEnvironment
    try { $nodeVersion = (& $node --version) }
    finally { Restore-FixedEnvironment $saved }
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v24\.') { throw '需要现成Node.js 24。' }
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($stageRoot))
    [ordered]@{
        revision = 'container-io-v1'
        purpose = '5 GiB候选容器流式I/O资格；不是E2 PASS或历史合法最大值证明'
        candidateBytes = $candidateBytes
        safetyBytes = $requiredFreeBytes - $candidateBytes
        requiredFreeBytes = $requiredFreeBytes
        availableFreeBytes = $drive.AvailableFreeSpace
        enoughDisk = $drive.AvailableFreeSpace -ge $requiredFreeBytes
        timeBudgetMs = $timeBudgetMs
        node = $nodeVersion
        powershell = $PSVersionTable.PSVersion.ToString()
        cacheClaim = '未控制或清空操作系统缓存；结果不称冷缓存'
        fixedSource = (Join-Path $PSScriptRoot 'container-io.ts')
        outputRoot = $stageRoot
    }
}

$preflight = Get-Preflight
if ($Action -eq 'Preflight') {
    $preflight | ConvertTo-Json -Depth 6
    return
}
if (-not $Acknowledge5GiB) {
    throw 'Run必须显式提供-Acknowledge5GiB；本入口将写入并保留5 GiB合成原件。'
}
if (-not $preflight.enoughDisk) { throw '可用磁盘不足5 GiB单文件与1 GiB安全余量。' }

$runId = [Guid]::NewGuid().ToString('N')
$runRoot = Join-Path $stageRoot ('container-io-' + $runId)
New-Item -ItemType Directory -Path $runRoot | Out-Null
Assert-OrdinaryDirectory $runRoot
$launcherPath = Join-Path $runRoot 'launcher.json'
$launcher = [ordered]@{
    revision = 'container-io-launcher-v1'
    runId = $runId
    status = 'intent-recorded'
    preflight = $preflight
    process = $null
    exitCode = $null
    jobReleased = $false
    fileVerification = $null
    failure = $null
}
$launcher | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $launcherPath -Encoding utf8

Add-Type -Path (Join-Path $repository 'tools\release-profile\JobProcess.cs')
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$source = Join-Path $PSScriptRoot 'container-io.ts'
$currentRunId = $runId
$started = [Action[uint32, long]] {
    param($processId, $creation)
    [AIbrowse.ReleaseProfile.JobProcess]::AssertContains($currentRunId, $processId)
    $launcher.process = [ordered]@{ pid = $processId; creationFileTimeUtc = $creation; jobMembership = $true }
    $launcher.status = 'running'
    $launcher | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $launcherPath -Encoding utf8
}
$savedEnvironment = Enter-FixedEnvironment
try {
    $exitCode = [AIbrowse.ReleaseProfile.JobProcess]::Execute(
        $node,
        @('--experimental-strip-types', $source, 'run', $runId),
        $repository,
        $runId,
        $timeBudgetMs,
        $started
    )
    $launcher.exitCode = $exitCode
    [AIbrowse.ReleaseProfile.JobProcess]::ConfirmReleased($runId)
    $launcher.jobReleased = $true
    if ($exitCode -ne 0) { throw ('Node资格进程失败，退出码：' + $exitCode) }
    $dataPath = Join-Path $runRoot 'container-5gib.bin'
    $item = Get-Item -LiteralPath $dataPath -Force
    $sparse = ($item.Attributes -band [IO.FileAttributes]::SparseFile) -ne 0
    $reparse = ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    $compressed = ($item.Attributes -band [IO.FileAttributes]::Compressed) -ne 0
    $launcher.fileVerification = [ordered]@{
        length = $item.Length
        sparse = $sparse
        reparse = $reparse
        compressed = $compressed
        ioClaim = '实际顺序流写与fsync/读回；不等于物理盘冷缓存吞吐'
        ordinaryNonSparse = $item.Length -eq $candidateBytes -and -not $sparse -and -not $reparse
    }
    if (-not $launcher.fileVerification.ordinaryNonSparse) { throw '5 GiB原件不是长度匹配的普通非稀疏文件。' }
    $reportPath = Join-Path $runRoot 'report.json'
    $report = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
    if ($report.status -ne 'measurement-complete-awaiting-launcher-verification') {
        throw 'Node报告未进入待launcher复验终态。'
    }
    $report.status = 'measurement-complete'
    $report | Add-Member -NotePropertyName launcherVerification -NotePropertyValue $launcher.fileVerification -Force
    $report | Add-Member -NotePropertyName jobReleased -NotePropertyValue $true -Force
    $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $reportPath -Encoding utf8
    $launcher.status = 'completed'
}
catch {
    $failureMessage = $_.Exception.Message
    try {
        [AIbrowse.ReleaseProfile.JobProcess]::ConfirmReleased($runId)
        $launcher.jobReleased = $true
    }
    catch {
        $launcher.failure = '资格进程失败且Job实际归零未确认；全部原件保留。'
    }
    if ($null -eq $launcher.failure) { $launcher.failure = $failureMessage }
    $launcher.status = 'failed-originals-preserved'
    throw
}
finally {
    Restore-FixedEnvironment $savedEnvironment
    $launcher | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $launcherPath -Encoding utf8
}
Write-Output ('5 GiB容器I/O资格完成；原件：' + $runRoot)
