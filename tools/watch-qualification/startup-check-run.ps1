param(
  [Parameter(Mandatory)][string]$WorkParent,
  [Parameter(Mandatory)][string]$ArtifactRoot,
  [Parameter(Mandatory)][string]$ToolPath,
  [Parameter(Mandatory)][switch]$WindowEnded,
  [ValidateSet('all', 'writer-main-delay')][string]$Case = 'all'
)
$ErrorActionPreference = 'Stop'
if (-not $WindowEnded) { throw '正式窗口及drain结束后才能运行启动专项' }
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$parentRoot = [IO.Path]::GetFullPath($WorkParent)
$outputRoot = [IO.Path]::GetFullPath($ArtifactRoot)
$executable = [IO.Path]::GetFullPath($ToolPath)
foreach ($directory in @($parentRoot, $outputRoot)) {
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw '启动专项目录不存在' }
}
$id = [Guid]::NewGuid().ToString('N')
$stdoutPath = Join-Path $outputRoot "startup-launcher-$id.stdout.txt"
$stderrPath = Join-Path $outputRoot "startup-launcher-$id.stderr.txt"
$manifest = @()
$artifactDirectories = if ($Case -eq 'writer-main-delay') { @('out/qualification-load-diagnostic/main') } else { @('out/main', 'out/qualification-diagnostic/main') }
foreach ($directory in $artifactDirectories) {
  $files = Get-ChildItem -LiteralPath (Join-Path $repoRoot $directory) -File |
    Where-Object { $_.Extension -in @('.js', '.node') } | Sort-Object Name
  if (-not $files) { throw '启动专项缺少新编译产物' }
  foreach ($file in $files) {
    $manifest += @{ category = $directory; artifact = $file.Name; sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
  }
}
foreach ($source in @('startup-check-observer.cjs', 'startup-check-positive.cjs')) {
  $manifest += @{ category = 'observer'; artifact = $source; sha256 = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $source) -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$manifest += @{ category = 'launcher'; artifact = 'startup-check.exe'; sha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() }
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputRoot "startup-manifest-$id.json") -Encoding utf8
$launchArguments = @($repoRoot, $parentRoot, $outputRoot, '--window-ended')
if ($Case -eq 'writer-main-delay') { $launchArguments += 'writer-main-delay' }
$quoted = foreach ($argument in $launchArguments) {
  if ($argument.Contains('"') -or $argument.EndsWith('\')) { throw '启动专项参数无效' }
  '"' + $argument + '"'
}
$process = Start-Process -FilePath $executable -ArgumentList $quoted -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
$timedOut = $false
try {
  $null = $process.Handle
  $birth = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
  $limitMilliseconds = if ($Case -eq 'writer-main-delay') { 60000 } else { 420000 }
  if (-not $process.WaitForExit($limitMilliseconds)) {
    $timedOut = $true
    $process.Kill()
    if (-not $process.WaitForExit(5000)) { throw '启动专项进程树收口待确认' }
  }
  @{ pid = $process.Id; creationFileTime = $birth; timedOut = $timedOut; exitCode = $process.ExitCode } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $outputRoot "startup-launcher-$id.json") -Encoding utf8
  Get-Content -LiteralPath $stdoutPath
  Get-Content -LiteralPath $stderrPath
  if ($timedOut -or $process.ExitCode -ne 0) { throw '启动专项失败，原件保留；禁止无诊断重复' }
  if ($Case -eq 'writer-main-delay') {
    $recordFiles = @(Get-ChildItem -LiteralPath $outputRoot -Filter 'startup-writer-main-delay-*.jsonl' -File)
    $errorFiles = @(Get-ChildItem -LiteralPath $outputRoot -Filter 'startup-writer-main-delay-*.stderr.txt' -File)
    if ($recordFiles.Count -ne 1 -or $errorFiles.Count -ne 1) { throw '写入反例需要独立的单轮原件目录' }
    $records = @(Get-Content -LiteralPath $recordFiles[0].FullName | ConvertFrom-Json)
    $begin = @($records | Where-Object { $_.kind -eq 'observer' -and $_.observation.kind -eq 'writer-main-delay-begin' })
    $end = @($records | Where-Object { $_.kind -eq 'observer' -and $_.observation.kind -eq 'writer-main-delay-end' })
    $failures = @(Get-Content -LiteralPath $errorFiles[0].FullName | Where-Object { $_.StartsWith('资格原生首错 ') } | ForEach-Object { $_.Substring('资格原生首错 '.Length) | ConvertFrom-Json } | Where-Object { $_.record -eq 1 })
    if ($begin.Count -ne 1 -or $end.Count -ne 1 -or $failures.Count -ne 1) { throw '写入反例首错或阻塞时序缺证，原件保留' }
    $beginTicks = [Convert]::ToUInt64($begin[0].observation.qpcTicks, 16)
    $endTicks = [Convert]::ToUInt64($end[0].observation.qpcTicks, 16)
    $failure = $failures[0]
    $firstFrame = @($records | Where-Object { $_.kind -eq 'telemetry' -and $_.frame.sequence -eq $begin[0].observation.firstSequence })
    $frequency = [uint64]$begin[0].observation.qpcFrequency
    $queueSeconds = ([uint64]$failure.scheduledQpc - [uint64]$failure.enqueuedQpc) / $frequency
    $executeSeconds = ([uint64]$failure.executeEndQpc - [uint64]$failure.executeBeginQpc) / $frequency
    $verified = $firstFrame.Count -eq 1 -and [uint64]$firstFrame[0].qpc -lt $endTicks -and
      $endTicks -gt $beginTicks -and ($endTicks - $beginTicks) / $frequency -ge 2.5 -and
      $failure.code -eq 1 -and $failure.stage -eq 3 -and $failure.workKind -eq 1 -and
      $failure.sequence -eq $begin[0].observation.secondSequence -and $failure.frequency -eq $frequency -and
      $failure.ioCompletedQpc -eq 0 -and $failure.scheduledQpc -ge $endTicks -and
      $failure.executeBeginQpc -ge $failure.scheduledQpc -and $failure.executeEndQpc -ge $failure.executeBeginQpc -and
      $queueSeconds -gt 2
    @{ detectedPreSubmitTimeout = $verified; firstSequence = $begin[0].observation.firstSequence;
       rejectedSequence = $failure.sequence; code = $failure.code; stage = $failure.stage;
       mainDelaySeconds = ($endTicks - $beginTicks) / $frequency; queueSeconds = $queueSeconds;
       executeSeconds = $executeSeconds; firstFrameReadBeforeMainRelease = ($firstFrame.Count -eq 1 -and [uint64]$firstFrame[0].qpc -lt $endTicks) } |
      ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputRoot 'writer-main-delay-report.json') -Encoding utf8
    if (-not $verified) { throw '写入反例未证明提交前排队超时，原件保留；禁止无诊断重复' }
    Write-Output '写入反例已证明：父进程在main释放前读到前帧；后帧在提交前超过原两秒入队期限。'
  }
} finally {
  if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(5000) }
  $process.Dispose()
}
