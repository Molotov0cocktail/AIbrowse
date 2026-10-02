param(
  [Parameter(Mandatory)][string]$WorkParent,
  [Parameter(Mandatory)][string]$ArtifactRoot,
  [Parameter(Mandatory)][string]$ToolPath,
  [Parameter(Mandatory)][switch]$WindowEnded
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
foreach ($directory in @('out/main', 'out/qualification-diagnostic/main')) {
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
$quoted = foreach ($argument in @($repoRoot, $parentRoot, $outputRoot, '--window-ended')) {
  if ($argument.Contains('"') -or $argument.EndsWith('\')) { throw '启动专项参数无效' }
  '"' + $argument + '"'
}
$process = Start-Process -FilePath $executable -ArgumentList $quoted -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
$timedOut = $false
try {
  $null = $process.Handle
  $birth = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
  if (-not $process.WaitForExit(420000)) {
    $timedOut = $true
    $process.Kill()
    if (-not $process.WaitForExit(5000)) { throw '启动专项进程树收口待确认' }
  }
  @{ pid = $process.Id; creationFileTime = $birth; timedOut = $timedOut; exitCode = $process.ExitCode } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $outputRoot "startup-launcher-$id.json") -Encoding utf8
  Get-Content -LiteralPath $stdoutPath
  Get-Content -LiteralPath $stderrPath
  if ($timedOut -or $process.ExitCode -ne 0) { throw '启动专项失败，原件保留；禁止无诊断重复' }
} finally {
  if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(5000) }
  $process.Dispose()
}
