param(
  [Parameter(Mandatory)][string]$Collector,
  [Parameter(Mandatory)][string]$FixtureRequest
)
$ErrorActionPreference = 'Stop'
$requestPath = [IO.Path]::GetFullPath($FixtureRequest)
$fixture = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
$fixtureParent = Split-Path -Parent $requestPath
$root = [IO.Path]::GetFullPath($fixture.root)
if ((Split-Path -Parent $root) -ne $fixtureParent -or (Split-Path -Leaf $root) -ne 'run-AAAAAAAAAAAAAAAAAAAAAAAAAA') {
  throw '不是独立合成夹具'
}
$dbPath = Join-Path $root 'user-data/watch/watch.db'
$dbHash = (Get-FileHash -LiteralPath $dbPath).Hash
function Verify-OwnedFixture([string]$Target, [string]$IdentityFile, [int]$ExpectedCode) {
  $suffix = [Guid]::NewGuid().ToString('N')
  $stdoutPath = Join-Path $fixtureParent "verify-$suffix.stdout.jsonl"
  $stderrPath = Join-Path $fixtureParent "verify-$suffix.stderr.txt"
  $arguments = @('--verify-released', $Target, $IdentityFile, $fixture.watchId, $fixture.dbId)
  $quoted = foreach ($argument in $arguments) {
    if ($argument.Contains('"') -or $argument.EndsWith('\')) { throw '夹具参数无效' }
    '"' + $argument + '"'
  }
  $process = Start-Process -FilePath $Collector -ArgumentList $quoted -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  try {
    $null = $process.Handle
    if (-not $process.WaitForExit(5000)) { throw '只读验证超时' }
    if ($process.ExitCode -ne $ExpectedCode) { throw "只读验证退出码错误：$($process.ExitCode)" }
    if ($ExpectedCode -eq 0) {
      $observation = Get-Content -LiteralPath $stdoutPath -Raw | ConvertFrom-Json
      if ($observation.status -ne 'ok' -or -not $observation.dbExclusive) { throw '只读成功协议错误' }
    }
  } finally {
    if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(5000) }
    $process.Dispose()
  }
}
Verify-OwnedFixture $root $fixture.rootIds 0
Verify-OwnedFixture $root (Join-Path $fixtureParent 'invalid.json') 79
$alias = Join-Path $fixtureParent 'owned-review-junction'
if (Test-Path -LiteralPath $alias) { throw '夹具junction已存在' }
try {
  New-Item -ItemType Junction -Path $alias -Target $fixtureParent | Out-Null
  Verify-OwnedFixture (Join-Path $alias (Split-Path -Leaf $root)) $fixture.rootIds 79
} finally {
  if (Test-Path -LiteralPath $alias) {
    $entry = Get-Item -LiteralPath $alias -Force
    if ($entry.LinkType -ne 'Junction' -or $entry.Target -ne $fixtureParent) { throw '未知夹具junction，保留不动' }
    Remove-Item -LiteralPath $alias -Force
  }
}
if ((Get-FileHash -LiteralPath $dbPath).Hash -ne $dbHash -or -not (Test-Path -LiteralPath (Join-Path $root 'user-data/preserve.txt'))) {
  throw '只读验证改变了数据库或合成用户文件'
}
Write-Output '只读CLI正常释放exit0、未知身份字段exit79、祖先junction拒绝exit79、DB内容及用户文件未改动。'
