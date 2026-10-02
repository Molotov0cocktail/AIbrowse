param(
  [Parameter(Mandatory)][string]$TestsExecutable,
  [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$suffix = [Guid]::NewGuid().ToString('N')
$stdoutPath = Join-Path $outputRoot "watchdog-$suffix.stdout.txt"
$stderrPath = Join-Path $outputRoot "watchdog-$suffix.stderr.txt"
$parentProcess = $null
$childProcess = $null
$outsiderProcess = $null
try {
  $outsiderProcess = Start-Process -FilePath $TestsExecutable -ArgumentList '--wait' -WindowStyle Hidden -PassThru
  $null = $outsiderProcess.Handle
  $parentProcess = Start-Process -FilePath $TestsExecutable -ArgumentList '--containment-suspended' -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  $null = $parentProcess.Handle
  $parentBirth = $parentProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
  $deadline = [Environment]::TickCount64 + 5000
  do {
    $line = Get-Content -LiteralPath $stdoutPath -Raw
    if ($line -match '^(\d+) (\d+)\s*$') { break }
    if ([Environment]::TickCount64 -ge $deadline) { throw '合成暂停子进程身份未到达' }
    Start-Sleep -Milliseconds 10
  } while ($true)
  $childProcess = [Diagnostics.Process]::GetProcessById([int]$Matches[1])
  $null = $childProcess.Handle
  if ($childProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $Matches[2]) { throw '暂停子进程身份不符' }
  if ($parentProcess.WaitForExit(50)) { throw '合成父进程提前退出' }
  $parentProcess.Kill()
  if (-not $parentProcess.WaitForExit(5000)) { throw '精确父句柄终止超时' }
  if (-not $childProcess.WaitForExit(5000)) { throw '暂停子进程没有被外层Job收口' }
  if ($outsiderProcess.HasExited) { throw '无关合成进程被误杀' }
  @{ version = 1; parentCreationFileTime = $parentBirth; parentKilled = $true; suspendedChildExited = $true; unrelatedProcessAlive = $true } |
    ConvertTo-Json -Compress
} finally {
  foreach ($ownedProcess in @($parentProcess, $childProcess, $outsiderProcess)) {
    if ($null -eq $ownedProcess) { continue }
    if (-not $ownedProcess.HasExited) {
      $ownedProcess.Kill()
      $null = $ownedProcess.WaitForExit(5000)
    }
    $ownedProcess.Dispose()
  }
}
