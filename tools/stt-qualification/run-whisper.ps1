[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CliPath,
    [Parameter(Mandatory = $true)][string]$ModelPath,
    [Parameter(Mandatory = $true)][string]$InputManifest,
    [Parameter(Mandatory = $true)][string]$OutputDir,
    [ValidateRange(1, 64)][int]$Threads = 4
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Resolve-LocalFile([string]$Path, [string]$BaseDirectory) {
    if (-not [IO.Path]::IsPathRooted($Path)) { $Path = Join-Path $BaseDirectory $Path }
    $resolved = [IO.Path]::GetFullPath($Path)
    if ($resolved -notmatch '^[A-Za-z]:\\' -or $resolved.Substring(3).Contains(':')) {
        throw '只允许本地磁盘普通文件路径，不允许网络路径或备用数据流。'
    }
    $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($resolved))
    if ($drive.DriveType -eq [IO.DriveType]::Network) { throw '不允许网络驱动器。' }
    $item = Get-Item -LiteralPath $resolved -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw '输入必须是普通文件。'
    }
    return $item.FullName
}

function ConvertTo-WindowsArgument([string]$Value) {
    # Quote according to the Windows CRT argv backslash/quote rules; no shell is used.
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Get-FreeMemoryBytes {
    $system = Get-CimInstance -ClassName Win32_OperatingSystem -Property FreePhysicalMemory -OperationTimeoutSec 2
    return [long]$system.FreePhysicalMemory * 1024
}

function Write-Json([string]$Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 15), $utf8)
}

$baseDirectory = (Get-Location).Path
$cli = Resolve-LocalFile $CliPath $baseDirectory
$model = Resolve-LocalFile $ModelPath $baseDirectory
$manifestPath = Resolve-LocalFile $InputManifest $baseDirectory
if ([IO.Path]::GetExtension($cli) -ine '.exe') { throw 'CLI 必须是本地 exe。' }
if ((Get-Item -LiteralPath $manifestPath).Length -gt 1MB) { throw '输入清单超过 1 MiB。' }
$manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
if (-not $manifest.PSObject.Properties['samples'] -or @($manifest.samples).Count -eq 0) {
    throw '输入清单必须包含非空 samples 数组。'
}
$validated = New-Object 'System.Collections.Generic.List[object]'
$seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($sample in $manifest.samples) {
    if (-not $sample.PSObject.Properties['id'] -or $sample.id -isnot [string] -or
        $sample.id -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$' -or -not $seen.Add($sample.id)) {
        throw '样本 id 必须唯一且只包含字母、数字、下划线、短横线。'
    }
    if ($sample.language -cnotin @('en', 'zh', 'ja') -or $sample.reference -isnot [string] -or
        $sample.audioPath -isnot [string] -or $sample.durationSeconds -isnot [ValueType] -or
        -not ([double]$sample.durationSeconds -gt 0) -or [double]::IsInfinity([double]$sample.durationSeconds)) {
        throw '样本语言、参考文本、音频路径或时长无效。'
    }
    $audio = Resolve-LocalFile $sample.audioPath ([IO.Path]::GetDirectoryName($manifestPath))
    if ([IO.Path]::GetExtension($audio) -ine '.wav') { throw '只接受本地 WAV 文件。' }
    $audioStream = [IO.File]::OpenRead($audio)
    try {
        $header = New-Object byte[] 12
        if ($audioStream.Read($header, 0, 12) -ne 12 -or [Text.Encoding]::ASCII.GetString($header, 0, 4) -ne 'RIFF' -or
            [Text.Encoding]::ASCII.GetString($header, 8, 4) -ne 'WAVE') { throw '音频不是 RIFF/WAVE 文件。' }
    } finally { $audioStream.Dispose() }
    $validated.Add([ordered]@{
        id = $sample.id; language = $sample.language; audioPath = $audio
        durationSeconds = [double]$sample.durationSeconds
        audioSha256 = (Get-FileHash -LiteralPath $audio -Algorithm SHA256).Hash.ToLowerInvariant()
    })
}

if (-not [IO.Path]::IsPathRooted($OutputDir)) { $OutputDir = Join-Path $baseDirectory $OutputDir }
$output = [IO.Path]::GetFullPath($OutputDir)
if (Test-Path -LiteralPath $output) { throw '输出目录已存在；为保留证据，拒绝覆盖。' }
[void](New-Item -ItemType Directory -Path $output)
$limits = [ordered]@{
    workingSetBytes = 1610612736; minimumAvailableMemoryBytes = 3221225472
    sampleWallSeconds = 120; processPollMilliseconds = 200; memoryPollMilliseconds = 1000
}
$logicalCount = [Environment]::ProcessorCount
$results = New-Object 'System.Collections.Generic.List[object]'
$report = [ordered]@{
    schemaVersion = 1; startedAt = [DateTime]::UtcNow.ToString('o'); completedAt = $null
    status = 'running'; stopReason = $null; threads = $Threads; logicalProcessorCount = $logicalCount
    limits = $limits; samples = $results
    cli = @{ path = $cli; sha256 = (Get-FileHash -LiteralPath $cli -Algorithm SHA256).Hash.ToLowerInvariant() }
    model = @{ path = $model; sha256 = (Get-FileHash -LiteralPath $model -Algorithm SHA256).Hash.ToLowerInvariant() }
    manifest = @{ path = $manifestPath; sha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() }
    measurement = 'wall 包含每条进程启动、模型加载和解码；工作集每 200ms 采样，系统可用内存约每 1s 采样；CPU 为进程累计时间。'
}
Write-Json (Join-Path $output 'result.json') $report

foreach ($sample in $validated) {
    $prefix = Join-Path $output $sample.id
    $row = [ordered]@{
        id = $sample.id; language = $sample.language; audioPath = $sample.audioPath
        audioSha256 = $sample.audioSha256; durationSeconds = $sample.durationSeconds
        status = 'not_started'; stopReason = $null; exitCode = $null; processId = $null
        wallSeconds = 0.0; cpuSeconds = 0.0; cpuNormalizedPercent = $null; rtf = $null
        peakWorkingSetBytes = 0L; minimumAvailableMemoryBytes = $null
        jsonPath = $prefix + '.json'; stdoutPath = $prefix + '.stdout.log'; stderrPath = $prefix + '.stderr.log'
        telemetryPath = $prefix + '.telemetry.json'; error = $null
    }
    $results.Add($row)
    $process = New-Object System.Diagnostics.Process
    $stdout = $null; $stderr = $null; $stdoutTask = $null; $stderrTask = $null
    $started = $false; $stopBatch = $false
    $watch = New-Object System.Diagnostics.Stopwatch
    $telemetry = New-Object 'System.Collections.Generic.List[object]'
    try {
        $available = Get-FreeMemoryBytes
        $row.minimumAvailableMemoryBytes = $available
        if ($available -lt $limits.minimumAvailableMemoryBytes) {
            $row.status = 'resource_limit'; $row.stopReason = 'available_memory_below_limit'; $stopBatch = $true
        } else {
            $arguments = @('-m', $model, '-f', $sample.audioPath, '-l', $sample.language, '-t', [string]$Threads,
                '-p', '1', '-ng', '-bs', '5', '-bo', '5', '-tp', '0', '-oj', '-of', $prefix)
            $row['arguments'] = $arguments
            $process.StartInfo.FileName = $cli
            $process.StartInfo.WorkingDirectory = [IO.Path]::GetDirectoryName($cli)
            $process.StartInfo.UseShellExecute = $false
            $process.StartInfo.CreateNoWindow = $true
            $process.StartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
            $process.StartInfo.RedirectStandardOutput = $true
            $process.StartInfo.RedirectStandardError = $true
            if ($process.StartInfo.PSObject.Properties['ArgumentList']) {
                foreach ($argument in $arguments) { $process.StartInfo.ArgumentList.Add($argument) }
            } else {
                $process.StartInfo.Arguments = ($arguments | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
            }
            $stdout = [IO.File]::Open($row.stdoutPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
            $stderr = [IO.File]::Open($row.stderrPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
            $watch.Start()
            $started = $process.Start()
            if (-not $started) { throw '无法创建解码进程。' }
            $row.processId = $process.Id
            $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
            $stderrTask = $process.StandardError.BaseStream.CopyToAsync($stderr)
            if (-not $process.HasExited) { $process.PriorityClass = [Diagnostics.ProcessPriorityClass]::BelowNormal }
            $nextMemoryRead = 1.0
            $row.status = 'running'
            while (-not $process.HasExited) {
                $process.Refresh()
                $elapsed = $watch.Elapsed.TotalSeconds
                $row.cpuSeconds = $process.TotalProcessorTime.TotalSeconds
                $workingSet = $process.WorkingSet64
                $row.peakWorkingSetBytes = [Math]::Max($row.peakWorkingSetBytes, [Math]::Max($workingSet, $process.PeakWorkingSet64))
                $stopReason = $null
                if ($row.peakWorkingSetBytes -gt $limits.workingSetBytes) { $stopReason = 'working_set_above_limit' }
                elseif ($elapsed -ge $limits.sampleWallSeconds) { $stopReason = 'wall_time_limit' }
                if (-not $stopReason -and $elapsed -ge $nextMemoryRead) {
                    $available = Get-FreeMemoryBytes
                    $row.minimumAvailableMemoryBytes = [Math]::Min($row.minimumAvailableMemoryBytes, $available)
                    $nextMemoryRead = $watch.Elapsed.TotalSeconds + 1.0
                    if ($available -lt $limits.minimumAvailableMemoryBytes) { $stopReason = 'available_memory_below_limit' }
                }
                $telemetry.Add(@{ wallSeconds = $elapsed; cpuSeconds = $row.cpuSeconds; workingSetBytes = $workingSet; availableMemoryBytes = $available })
                if ($stopReason) {
                    $row.status = 'resource_limit'; $row.stopReason = $stopReason; $stopBatch = $true
                    if (-not $process.HasExited) { $process.Kill() }
                    break
                }
                Start-Sleep -Milliseconds $limits.processPollMilliseconds
            }
            if (-not $process.WaitForExit(5000)) { throw '终止 owned 进程后等待退出超时。' }
            $watch.Stop()
            $row.exitCode = $process.ExitCode
            $row.cpuSeconds = $process.TotalProcessorTime.TotalSeconds
            $row.peakWorkingSetBytes = [Math]::Max($row.peakWorkingSetBytes, $process.PeakWorkingSet64)
            if ($row.status -eq 'running' -and ($row.peakWorkingSetBytes -gt $limits.workingSetBytes -or $watch.Elapsed.TotalSeconds -ge $limits.sampleWallSeconds)) {
                $row.status = 'resource_limit'; $stopBatch = $true
                $row.stopReason = if ($row.peakWorkingSetBytes -gt $limits.workingSetBytes) { 'working_set_above_limit' } else { 'wall_time_limit' }
            }
            if ($row.status -eq 'running') {
                if ($row.exitCode -ne 0) { $row.status = 'process_failed' }
                elseif (-not (Test-Path -LiteralPath $row.jsonPath -PathType Leaf)) { $row.status = 'output_missing' }
                else { $row.status = 'completed' }
            }
        }
    } catch {
        $row.error = '采集或进程执行失败：' + $_.Exception.Message
        if ($row.status -ne 'resource_limit') { $row.status = 'harness_error'; $row.stopReason = 'monitor_or_execution_error' }
        $stopBatch = $true
    } finally {
        try {
            if ($started -and -not $process.HasExited) {
                $process.Kill()
                if (-not $process.WaitForExit(5000)) { throw 'owned 进程未及时退出。' }
            }
            if ($started -and $process.HasExited) {
                $row.exitCode = $process.ExitCode
                $row.cpuSeconds = $process.TotalProcessorTime.TotalSeconds
            }
        } catch {
            $row.error = '进程清理失败：' + $_.Exception.Message
            $row.status = 'harness_error'; $row.stopReason = 'owned_process_cleanup_error'; $stopBatch = $true
        }
        $watch.Stop()
        $row.wallSeconds = $watch.Elapsed.TotalSeconds
        if ($row.wallSeconds -gt 0) {
            $row.rtf = $row.wallSeconds / $row.durationSeconds
            $row.cpuNormalizedPercent = 100 * $row.cpuSeconds / $row.wallSeconds / $logicalCount
        }
        foreach ($copyTask in @($stdoutTask, $stderrTask)) {
            if ($null -ne $copyTask) {
                try { if (-not $copyTask.Wait(5000)) { throw '输出管道等待超时。' } }
                catch { $row.error = '保存原始输出失败：' + $_.Exception.Message; $row.status = 'harness_error'; $row.stopReason = 'output_capture_error'; $stopBatch = $true }
            }
        }
        if ($null -ne $stdout) { $stdout.Dispose() }
        if ($null -ne $stderr) { $stderr.Dispose() }
        $process.Dispose()
        Write-Json $row.telemetryPath @($telemetry.ToArray())
        if ($stopBatch) { $report.stopReason = $row.stopReason; $report.status = 'stopped' }
        Write-Json (Join-Path $output 'result.json') $report
    }
    if ($stopBatch) { break }
}

foreach ($sample in $validated) {
    if (-not ($results | Where-Object { $_.id -eq $sample.id })) {
        $results.Add(@{ id = $sample.id; status = 'not_run'; stopReason = 'batch_stopped'; audioSha256 = $sample.audioSha256 })
    }
}
if ($report.status -eq 'running') {
    $report.status = if (@($results | Where-Object { $_.status -ne 'completed' }).Count) { 'completed_with_failures' } else { 'completed' }
}
$report.completedAt = [DateTime]::UtcNow.ToString('o')
Write-Json (Join-Path $output 'result.json') $report
Write-Host ('离线评估结束：' + $report.status + '；报告：' + (Join-Path $output 'result.json'))
if ($report.status -ne 'completed') { exit 1 }
