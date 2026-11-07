$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$testRoot = Join-Path $repositoryRoot ('log/extension-inspector-tests-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$results = [Collections.Generic.List[object]]::new()
$utf8 = [Text.UTF8Encoding]::new($false)

function New-Fixture([string]$name, [string[]]$paths) {
  $archivePath = Join-Path $testRoot ($name + '.zip')
  $archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($path in $paths) {
      $entry = $archive.CreateEntry($path)
      $stream = $entry.Open()
      try {
        $content = if ($path -eq 'manifest.json') { '{"version":"1.0.0"}' } else { 'throw new Error("不得执行插件");' }
        $bytes = $utf8.GetBytes($content)
        $stream.Write($bytes, 0, $bytes.Length)
      }
      finally { $stream.Dispose() }
    }
  }
  finally { $archive.Dispose() }
  return $archivePath
}

# Counterexamples must be rejected before any destination is created.
$negativeCases = @(
  @{ name = 'parent'; paths = @('manifest.json', '../escape.js') },
  @{ name = 'absolute'; paths = @('manifest.json', '/escape.js') },
  @{ name = 'duplicate'; paths = @('manifest.json', 'same.js', 'SAME.js') },
  @{ name = 'reserved'; paths = @('manifest.json', 'con.js') },
  @{ name = 'stream'; paths = @('manifest.json', 'file.js:stream') }
)
foreach ($case in $negativeCases) {
  $archivePath = New-Fixture $case.name $case.paths
  $outputPath = Join-Path $testRoot ($case.name + '-output')
  $rejected = $false
  try { & (Join-Path $PSScriptRoot 'inspect-package.ps1') -ArchivePath $archivePath -OutputDirectory $outputPath | Out-Null }
  catch { $rejected = $true }
  if (-not $rejected -or (Test-Path -LiteralPath $outputPath)) { throw ('反例未安全拒绝：' + $case.name) }
  $results.Add(@{ name = $case.name; passed = $true })
}
$positiveArchive = New-Fixture 'positive' @('manifest.json', 'code.js')
$positiveOutput = Join-Path $testRoot 'positive-output'
& (Join-Path $PSScriptRoot 'inspect-package.ps1') -ArchivePath $positiveArchive -OutputDirectory $positiveOutput | Out-Null
$inventory = Get-Content -Raw (Join-Path $positiveOutput 'inventory.json') | ConvertFrom-Json
if ($inventory.entryCount -ne 2 -or $inventory.textCount -ne 2 -or $inventory.packageVersion -ne '1.0.0') { throw '正常归档清单不正确' }
$codePath = Join-Path $positiveOutput 'text/code.js'
$codeRecord = $inventory.entries | Where-Object path -eq 'code.js'
if ((Get-FileHash -LiteralPath $codePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $codeRecord.sha256) { throw '导出内容摘要不符' }
$results.Add(@{ name = 'positive-byte-preserving-no-execution'; passed = $true })
$overwriteRejected = $false
try { & (Join-Path $PSScriptRoot 'inspect-package.ps1') -ArchivePath $positiveArchive -OutputDirectory $positiveOutput | Out-Null }
catch { $overwriteRejected = $true }
if (-not $overwriteRejected) { throw '旧证据被覆盖' }
$results.Add(@{ name = 'preserve-previous-output'; passed = $true })
$result = @{ passed = $results.Count; cases = $results; evidenceDirectory = $testRoot }
[IO.File]::WriteAllText((Join-Path $testRoot 'result.json'), ($result | ConvertTo-Json -Depth 5), $utf8)
$result | ConvertTo-Json -Depth 5 -Compress
