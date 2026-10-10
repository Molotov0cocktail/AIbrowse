[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PackageRoot,
  [Parameter(Mandatory)][string]$FinalSourceManifest,
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$FinalSourceManifestSHA,
  [Parameter(Mandatory)][string]$FirstEmptyEvidence,
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$FirstEmptyEvidenceSHA,
  [Parameter(Mandatory)][string]$Root,
  [Parameter(Mandatory)][string]$Scope
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) { throw '需要现成PowerShell 7' }
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$preparation = & $node --experimental-strip-types (Join-Path $PSScriptRoot 'final-runtime-security-check.ts') $PackageRoot $FinalSourceManifest $FinalSourceManifestSHA $FirstEmptyEvidence $FirstEmptyEvidenceSHA $Root $Scope
if ($LASTEXITCODE -ne 0) { throw '准备失败，未启动产品' }
$receipt = $preparation | ConvertFrom-Json
$preparedBytes = [IO.File]::ReadAllBytes((Join-Path $Scope 'prepared.json'))
if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($preparedBytes)).ToLowerInvariant() -cne $receipt.preparedSha256) { throw '准备记录摘要不符' }
$prepared = [Text.Encoding]::UTF8.GetString($preparedBytes) | ConvertFrom-Json
function Hash-File([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Assert-Files([string]$Directory, $Expected) {
  $actual = @(Get-ChildItem -LiteralPath $Directory -Recurse -File)
  if ($actual.Count -ne $Expected.Count) { throw 'payload成员集合改变' }
  foreach ($entry in $Expected) {
    $path = Join-Path $Directory $entry.path
    $parent = [IO.Path]::GetDirectoryName($path)
    while ($parent.Length -ge $Directory.Length) {
      if (((Get-Item -LiteralPath $parent).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'payload祖先含链接' }
      if ($parent -ieq $Directory) { break }
      $parent = [IO.Path]::GetDirectoryName($parent)
    }
    $item = Get-Item -LiteralPath $path
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -ne $entry.bytes -or (Hash-File $path) -cne $entry.sha256) { throw 'payload字节改变' }
  }
}
$savedEnvironment = @{}
try {
foreach ($source in $prepared.tools) {
  if ((Hash-File (Join-Path $repository $source.path)) -cne $source.sha256) { throw '工具来源改变' }
}
if ((Hash-File $FinalSourceManifest) -cne $FinalSourceManifestSHA -or (Hash-File $FirstEmptyEvidence) -cne $FirstEmptyEvidenceSHA) { throw '来源证据改变' }
$firstBytes = [IO.File]::ReadAllBytes((Join-Path $Scope 'first-empty.json'))
if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($firstBytes)).ToLowerInvariant() -cne $FirstEmptyEvidenceSHA) { throw '首次空根证据副本不符' }
$native = Join-Path $repository 'tools\release-profile'
Add-Type -Path (Join-Path $native 'DisposableProfile.cs'), (Join-Path $native 'ProfileIsolation.cs'), (Join-Path $native 'JobProcess.cs'), (Join-Path $native 'ReleaseDataIdentity.cs'), (Join-Path $PSScriptRoot 'FinalRuntimeSecurityCheck.cs')
foreach ($entry in @(Get-ChildItem Env:)) {
  if ($entry.Name.StartsWith('AIBROWSE_') -or $entry.Name -in @('NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL')) {
    $savedEnvironment[$entry.Name] = $entry.Value
    [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process')
  }
}
  if (@(Get-Process -Name AIbrowse, guardian -ErrorAction SilentlyContinue).Count -ne 0) { throw '既有应用或guardian尚未退休，禁止启动' }
  foreach ($fixture in $prepared.fixtures) {
    Assert-Files $PackageRoot $prepared.originalFiles
    Assert-Files (Join-Path $Scope $fixture.scene) $fixture.files
    [AIbrowse.ReleaseProfile.FinalRuntimeSecurityCheck]::Run($Scope, $Root, [Text.Encoding]::UTF8.GetString($firstBytes), $fixture.scene)
    Assert-Files $PackageRoot $prepared.originalFiles
  }
  $report = @{ ok = $true; scope = $Scope; preparedSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($preparedBytes)).ToLowerInvariant(); finalSourceManifestSha256 = $FinalSourceManifestSHA; firstEmptyEvidenceSha256 = $FirstEmptyEvidenceSHA; scenarios = @('content-tamper', 'loose-app-tamper'); ordinaryStartup = '另由第5次安装证明'; environmentPositiveControl = '另由第5次安装证明'; profileReset = $false }
  $output = [IO.File]::Open((Join-Path $Scope 'report.json'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
  try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Depth 8)); $output.Write($bytes); $output.Flush($true) } finally { $output.Dispose() }
  $report | ConvertTo-Json -Depth 8
} catch {
  $failure = @{ ok = $false; error = $_.Exception.Message; sourceManifestSha256 = $FinalSourceManifestSHA; firstFailureStopsSequence = $true; originalPackageUnchanged = $false }
  try { Assert-Files $PackageRoot $prepared.originalFiles; $failure.originalPackageUnchanged = $true } catch { $failure.originalPackageCheckError = $_.Exception.Message }
  $output = [IO.File]::Open((Join-Path $Scope 'failure.json'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
  try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($failure | ConvertTo-Json)); $output.Write($bytes); $output.Flush($true) } finally { $output.Dispose() }
  throw
} finally {
  foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
}
