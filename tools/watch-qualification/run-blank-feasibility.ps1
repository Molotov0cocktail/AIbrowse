param([Parameter(Mandatory)][string]$WorkParent, [Parameter(Mandatory)][string]$ArtifactRoot, [switch]$ProductSmoke)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$toolPath = Join-Path $repoRoot 'log/watch-qualification-build/blank-feasibility.exe'
$parentRoot = [IO.Path]::GetFullPath($WorkParent)
$outputRoot = [IO.Path]::GetFullPath($ArtifactRoot)
foreach ($directory in @($parentRoot, $outputRoot)) {
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw '实验目录不存在' }
}
$id = [Guid]::NewGuid().ToString('N')
$stdoutPath = Join-Path $outputRoot "blank-launcher-$id.stdout.txt"
$stderrPath = Join-Path $outputRoot "blank-launcher-$id.stderr.txt"
$quoted = foreach ($argument in @($repoRoot, $parentRoot, $outputRoot)) {
  if ($argument.Contains('"') -or $argument.EndsWith('\')) { throw '实验参数无效' }
  '"' + $argument + '"'
}
if ($ProductSmoke) { $quoted += '--product-smoke' }
$process = Start-Process -FilePath $toolPath -ArgumentList $quoted -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
$timedOut = $false
try {
  $null = $process.Handle
  $birth = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
  if (-not $process.WaitForExit(120000)) {
    $timedOut = $true
    $process.Kill()
    if (-not $process.WaitForExit(5000)) { throw '实验进程树收口待确认' }
  }
  @{ pid = $process.Id; creationFileTime = $birth; timedOut = $timedOut; exitCode = $process.ExitCode } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $outputRoot "blank-launcher-$id.json") -Encoding utf8
  Get-Content -LiteralPath $stdoutPath
  Get-Content -LiteralPath $stderrPath
  if ($timedOut -or $process.ExitCode -ne 0) { throw '空白页实验失败，原件保留' }
} finally {
  if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(5000) }
  $process.Dispose()
}
