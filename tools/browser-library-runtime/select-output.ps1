[CmdletBinding()]
param(
  [ValidateSet('CheckOnly', 'Switch', 'Rollback')][string]$Action = 'CheckOnly',
  [string]$ReviewRecord = '',
  [ValidatePattern('^[a-f0-9]{32}$')][string]$SwitchId = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$release = Join-Path $repository 'release'
$output = Join-Path $repository 'output'
$evidence = Join-Path $repository 'log/browser-settings-20261012'
function Need([bool]$value, [string]$message) { if (-not $value) { throw $message } }
Need ([OperatingSystem]::IsWindows()) '此工具仅适用 Windows 本地候选选择'

# Reject alternate directory routes and multiply linked files before reading or moving.
if (-not ('AIbrowse.OutputSelectionFile' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace AIbrowse {
  public static class OutputSelectionFile {
    [StructLayout(LayoutKind.Sequential)] private struct Info {
      public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh,
        WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    public static void Check(SafeFileHandle handle) {
      Info info;
      if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception();
      if (info.Links != 1 || (info.Attributes & (0x400U | 0x10U | 0x40U)) != 0)
        throw new InvalidOperationException("不是单链接普通文件");
    }
  }
}
'@
}
function SafePath([string]$path) {
  $full = [IO.Path]::GetFullPath($path)
  Need ($full.StartsWith($repository + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) '路径越出固定项目目录'
  for ($part = $full; $part; $part = [IO.Path]::GetDirectoryName($part)) {
    if (Test-Path -LiteralPath $part) {
      Need (((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) '路径含重解析点'
    }
  }
  return $full
}
function Member([string]$base, [string]$relative) {
  Need (-not [string]::IsNullOrWhiteSpace($relative) -and $relative -notmatch '[:\\]' -and -not [IO.Path]::IsPathRooted($relative)) '成员路径不是相对路径'
  foreach ($part in $relative.Split('/')) {
    Need ($part -ne '' -and $part -ne '.' -and $part -ne '..' -and $part.TrimEnd(' ', '.') -ceq $part -and $part.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -lt 0 -and $part -notmatch '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') '成员路径不安全'
  }
  $full = SafePath (Join-Path $base $relative)
  Need ($full.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) '成员越出目录'
  return $full
}
function OpenRegular([string]$path, [long]$limit = 1073741824) {
  $full = SafePath $path
  $item = Get-Item -LiteralPath $full -Force
  Need ($item -is [IO.FileInfo] -and $item.Length -le $limit) '不是预算内普通文件'
  $stream = [IO.File]::Open($full, 'Open', 'Read', 'Read')
  try { [AIbrowse.OutputSelectionFile]::Check($stream.SafeFileHandle); Need ($stream.Length -le $limit) '文件字节超限'; return $stream }
  catch { $stream.Dispose(); throw }
}
function FileFact([string]$path, [string]$relative) {
  $stream = OpenRegular $path
  try {
    $bytes = $stream.Length
    $sha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant()
    Need ($stream.Length -eq $bytes) '文件读取期间变化'
    return [ordered]@{ path = $relative; bytes = $bytes; sha256 = $sha }
  } finally { $stream.Dispose() }
}
function ExactKeys($value, [string[]]$keys) {
  Need ($value -is [Collections.IDictionary] -and $value.Count -eq $keys.Count) '字段集合不闭合'
  foreach ($key in $keys) { Need ($value.Contains($key)) '缺少固定字段' }
}
function ValidFact($fact) {
  ExactKeys $fact @('path', 'bytes', 'sha256')
  Need ($fact.path -is [string] -and $fact.sha256 -is [string] -and $fact.sha256 -cmatch '^[a-f0-9]{64}$' -and ($fact.bytes -is [long] -or $fact.bytes -is [int]) -and $fact.bytes -ge 0 -and $fact.bytes -le 1073741824) '成员身份或预算无效'
}
function Facts($facts, [string]$base) {
  Need ($facts -is [array] -and $facts.Count -le 4096) '文件清单预算无效'
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $total = 0L
  foreach ($fact in $facts) {
    ValidFact $fact
    [void](Member $base $fact.path)
    Need ($seen.Add($fact.path)) '文件清单重复'
    $total += $fact.bytes
    Need ($total -le 2147483648) '文件总字节超限'
  }
}
function Tree([string]$base) {
  [void](SafePath $base)
  Need ((Get-Item -LiteralPath $base -Force) -is [IO.DirectoryInfo]) '树根不是普通目录'
  $queue = [Collections.Generic.Queue[string]]::new(); $queue.Enqueue($base)
  $files = [Collections.Generic.List[object]]::new(); $total = 0L; $visited = 0
  while ($queue.Count -gt 0) {
    foreach ($item in Get-ChildItem -LiteralPath ($queue.Dequeue()) -Force) {
      $visited++; Need ($visited -le 8192) '目录成员超限'
      [void](SafePath $item.FullName)
      if ($item.PSIsContainer) { $queue.Enqueue($item.FullName) } else {
        $relative = [IO.Path]::GetRelativePath($base, $item.FullName).Replace('\', '/')
        [void](Member $base $relative)
        $fact = FileFact $item.FullName $relative; $total += $fact.bytes
        Need ($files.Count -lt 4096 -and $total -le 2147483648) '文件数量或字节预算超限'
        $files.Add($fact)
      }
    }
  }
  return @($files | Sort-Object { $_.path })
}
function AssertFiles([string]$base, $expected) {
  Facts $expected $base
  $actual = @(Tree $base); Need ($actual.Count -eq $expected.Count) '成员数量变化'
  $map = @{}; foreach ($fact in $actual) { $map[$fact.path] = $fact }
  foreach ($fact in $expected) {
    Need ($map.ContainsKey($fact.path) -and $map[$fact.path].bytes -eq $fact.bytes -and $map[$fact.path].sha256 -ceq $fact.sha256) '成员缺失、字节或摘要变化'
  }
}
function UniqueJson($element, [int]$depth = 0) {
  Need ($depth -le 24) 'JSON 深度超限'
  if ($element.ValueKind -eq [Text.Json.JsonValueKind]::Object) {
    $keys = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($property in $element.EnumerateObject()) { Need ($keys.Add($property.Name)) 'JSON 字段重复'; UniqueJson $property.Value ($depth + 1) }
  } elseif ($element.ValueKind -eq [Text.Json.JsonValueKind]::Array) {
    foreach ($child in $element.EnumerateArray()) { UniqueJson $child ($depth + 1) }
  }
}
function ReadJson([string]$path) {
  $stream = OpenRegular $path 4194304
  try {
    $bytes = [byte[]]::new($stream.Length); $stream.ReadExactly($bytes)
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    $document = [Text.Json.JsonDocument]::Parse($text)
    try { UniqueJson $document.RootElement } finally { $document.Dispose() }
    return @{ value = ($text | ConvertFrom-Json -AsHashtable); fact = [ordered]@{
      path = [IO.Path]::GetRelativePath($repository, $path).Replace('\', '/'); bytes = [long]$bytes.Length
      sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    } }
  } finally { $stream.Dispose() }
}
function NewJson([string]$path, $value) {
  [void](SafePath $path)
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($value | ConvertTo-Json -Depth 24))
  $stream = [IO.File]::Open($path, 'CreateNew', 'Write', 'Read')
  try { $stream.Write($bytes); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Idle {
  Need (@(Get-Process -Name AIbrowse, guardian -ErrorAction SilentlyContinue).Count -eq 0) '应用或 guardian 尚未退出，禁止换包'
}
function Head {
  $value = & git -C $repository rev-parse HEAD
  Need ($LASTEXITCODE -eq 0 -and $value -cmatch '^[a-f0-9]{40}$') '无法确认当前源码'
  $dirty = @(& git -C $repository status --porcelain=v1 --untracked-files=all)
  Need ($LASTEXITCODE -eq 0 -and $dirty.Count -eq 0) '当前项目源码工作区不干净'
  return $value
}
function IgnoredLog([string]$relative) {
  Need ($relative.StartsWith('log/', [StringComparison]::Ordinal)) '审核证明必须位于项目 log 内'
  $path = Member $repository $relative
  & git -C $repository check-ignore --quiet -- $relative
  Need ($LASTEXITCODE -eq 0) '审核证明必须是未跟踪的 ignored log 文件'
  return $path
}
function AssertProof($proof) {
  ValidFact $proof
  $actual = FileFact (IgnoredLog $proof.path) $proof.path
  Need ($actual.bytes -eq $proof.bytes -and $actual.sha256 -ceq $proof.sha256) '审核证明字节或摘要不匹配'
}
function RestorePrevious($plan, [string]$scope, [string]$backup) {
  Idle
  if (-not (Test-Path -LiteralPath $backup)) { AssertFiles $output $plan.previous.files; return }
  AssertFiles $backup $plan.previous.files
  if (Test-Path -LiteralPath $output) {
    $retainedFiles = @(Tree $output)
    $retained = SafePath (Join-Path $scope ('rolled-back-candidate-' + [Guid]::NewGuid().ToString('N')))
    Need (-not (Test-Path -LiteralPath $retained)) '回退保留目录已存在'
    NewJson (Join-Path $scope ('rollback-candidate-' + [Guid]::NewGuid().ToString('N') + '.json')) @{ files = $retainedFiles; destination = $retained }
    [IO.Directory]::Move($output, $retained)
    AssertFiles $retained $retainedFiles
  }
  Need (-not (Test-Path -LiteralPath $output)) '恢复目标已被占用'
  [IO.Directory]::Move($backup, $output)
  AssertFiles $output $plan.previous.files
}
if ($Action -eq 'Rollback') {
  Need ($SwitchId -ne '' -and $ReviewRecord -eq '') '回退只接受固定 SwitchId'
  $scope = SafePath (Join-Path $evidence ('output-selection-' + $SwitchId))
  $backup = SafePath (Join-Path $evidence ('previous-output-' + $SwitchId))
  $plan = (ReadJson (Join-Path $scope 'plan.json')).value
  Need ($plan.version -eq 1 -and $plan.id -ceq $SwitchId -and $plan.scope -ceq 'browser-settings-20261012' -and $plan.output -ceq $output -and $plan.backup -ceq $backup -and $plan.release -ceq $release -and $plan.staging -ceq (Join-Path $scope 'staging')) '回退计划不属于固定目录'
  Facts $plan.previous.files $output
  Need ($plan.previous.count -eq $plan.previous.files.Count) '回退文件计数不符'
  RestorePrevious $plan $scope $backup
  NewJson (Join-Path $scope ('rollback-' + [Guid]::NewGuid().ToString('N') + '.json')) @{ restored = $true; previous = $plan.previous; output = $output }
  @{ restored = $true; output = $output; scope = $scope } | ConvertTo-Json
  return
}
Need ($SwitchId -eq '' -and $ReviewRecord -ne '') '计划或换包须提供 ReviewRecord'
Idle
$verificationHead = Head
$reviewPath = SafePath $ReviewRecord
$reviewRelative = [IO.Path]::GetRelativePath($repository, $reviewPath).Replace('\', '/')
[void](IgnoredLog $reviewRelative)
$reviewRead = ReadJson $reviewPath; $review = $reviewRead.value
ExactKeys $review @('sourceGitSha', 'manifestSha256', 'decision', 'scope', 'proofs', 'packageLaunchStatus')
foreach ($key in @('sourceGitSha', 'manifestSha256', 'decision', 'scope', 'packageLaunchStatus')) { Need ($review[$key] -is [string]) '审核固定字段类型无效' }
Need ($review.decision -ceq 'PASS' -and $review.scope -ceq 'browser-settings-20261012' -and $review.sourceGitSha -ceq $verificationHead -and $review.manifestSha256 -cmatch '^[a-f0-9]{64}$' -and $review.packageLaunchStatus -cin @('PASS', 'NOTRUN')) '独立审核范围、结论或源码绑定无效'
Need ($review.proofs -is [array] -and $review.proofs.Count -ge 1 -and $review.proofs.Count -le 1024) '审核证明数量超限或为空'
$seenProofs = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($proof in $review.proofs) { AssertProof $proof; Need ($seenProofs.Add($proof.path) -and $proof.path -cne $reviewRelative) '审核证明重复或自引用' }
$manifestRead = ReadJson (Member $release 'build-provenance.json'); $manifest = $manifestRead.value
Need ($manifestRead.fact.sha256 -ceq $review.manifestSha256) '审核未绑定当前包 manifest'
Need ($manifest.source.gitSha -is [string] -and $manifest.source.version -is [string]) '包来源身份类型无效'
Need ($manifest.schemaVersion -eq 1 -and $manifest.candidateEligible -is [bool] -and $manifest.candidateEligible -and $manifest.source.dirty -is [bool] -and -not $manifest.source.dirty -and $manifest.source.gitSha -ceq $verificationHead -and $manifest.source.version -ceq '0.1.5') '包来源不是本轮干净源码候选'
$stem = 'AIbrowse-0.1.5-win-x64-internal'
Need ($manifest.installer.path -ceq ($stem + '.exe') -and $manifest.msi.path -ceq ($stem + '.msi') -and $manifest.installerBuild.path -ceq 'installer-build.json') '两个安装器或身份文件命名不符'
AssertFiles (Join-Path $release 'win-unpacked') $manifest.payload.packageFiles
foreach ($key in @('executable', 'asar', 'guardian')) {
  $fact = $manifest.payload[$key]
  $expectedPath = switch ($key) { 'executable' { 'AIbrowse.exe' }; 'asar' { 'resources/app.asar' }; 'guardian' { 'resources/lifecycle-guardian/guardian.exe' } }
  Need ($fact.path -ceq $expectedPath) '关键包成员路径不符'
  $matched = @($manifest.payload.packageFiles | Where-Object { $_.path -ceq $expectedPath })
  Need ($matched.Count -eq 1 -and $matched[0].sha256 -ceq $fact.sha256) '关键包成员未纳入完整清单'
  if ($key -ne 'asar') { Need ($matched[0].bytes -eq $fact.bytes) '关键包成员字节不符' }
}
$candidate = [Collections.Generic.List[object]]::new()
foreach ($fact in $manifest.payload.packageFiles) { $candidate.Add([ordered]@{ path = 'win-unpacked/' + $fact.path; bytes = $fact.bytes; sha256 = $fact.sha256 }) }
foreach ($fact in @($manifest.installer, $manifest.msi, $manifest.installerBuild)) {
  ValidFact $fact
  $actual = FileFact (Member $release $fact.path) $fact.path
  Need ($actual.bytes -eq $fact.bytes -and $actual.sha256 -ceq $fact.sha256) '安装器或安装构建身份不匹配'
  $candidate.Add($actual)
}
$candidate.Add([ordered]@{ path = 'build-provenance.json'; bytes = $manifestRead.fact.bytes; sha256 = $manifestRead.fact.sha256 })
$candidateFiles = @($candidate | Sort-Object { $_.path }); Facts $candidateFiles $release
$old = @(Tree $output)
$id = [Guid]::NewGuid().ToString('N')
$scope = SafePath (Join-Path $evidence ('output-selection-' + $id))
$backup = SafePath (Join-Path $evidence ('previous-output-' + $id))
$staging = SafePath (Join-Path $scope 'staging')
$proofFiles = @($review.proofs) + @($reviewRead.fact)
$plan = [ordered]@{ version = 1; id = $id; scope = 'browser-settings-20261012'; release = $release; output = $output; backup = $backup; staging = $staging; sourceGitSha = $verificationHead; manifestSha256 = $manifestRead.fact.sha256; packageLaunchStatus = $review.packageLaunchStatus; candidate = @{ count = $candidateFiles.Count; files = $candidateFiles }; previous = @{ count = $old.Count; files = $old }; evidence = $proofFiles; scriptSha256 = (FileFact $PSCommandPath 'select-output.ps1').sha256 }
if ($Action -eq 'CheckOnly') { $plan | ConvertTo-Json -Depth 24; return }
Need (-not (Test-Path -LiteralPath $scope) -and -not (Test-Path -LiteralPath $backup)) '唯一操作目录已被占用'
[void][IO.Directory]::CreateDirectory($staging)
NewJson (Join-Path $scope 'plan.json') $plan
$oldMoved = $false; $newMoved = $false
try {
  foreach ($fact in $candidateFiles) {
    $target = Member $staging $fact.path
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
    [IO.File]::Copy((Member $release $fact.path), $target, $false)
  }
  AssertFiles $staging $candidateFiles
  foreach ($fact in $candidateFiles) {
    $actual = FileFact (Member $release $fact.path) $fact.path
    Need ($actual.bytes -eq $fact.bytes -and $actual.sha256 -ceq $fact.sha256) '复制期间候选变化'
  }
  AssertFiles $output $old
  foreach ($proof in $proofFiles) { AssertProof $proof }
  Need ((Head) -ceq $verificationHead) '复制期间源码变化'
  Need ((FileFact $PSCommandPath 'select-output.ps1').sha256 -ceq $plan.scriptSha256) '复制期间选择工具变化'
  Idle
  [void](SafePath $backup); [void](SafePath $output); [void](SafePath $staging)
  [IO.Directory]::Move($output, $backup); $oldMoved = $true
  AssertFiles $backup $old
  [IO.Directory]::Move($staging, $output); $newMoved = $true
  AssertFiles $output $candidateFiles
  AssertFiles $backup $old
  $result = @{ passed = $true; id = $id; output = $output; backup = $backup; scope = $scope; originalBytesPreserved = $true; sourceGitSha = $verificationHead; manifestSha256 = $manifestRead.fact.sha256; packageLaunchStatus = $review.packageLaunchStatus }
  NewJson (Join-Path $scope 'result.json') $result
  $result | ConvertTo-Json
} catch {
  $originalError = $_.Exception.Message; $restored = $false; $rollbackError = $null
  try {
    if ($oldMoved) {
      Need ($newMoved -or -not (Test-Path -LiteralPath $output)) '旧输出移动后出现未知目标，保留现场并停止自动回退'
      RestorePrevious $plan $scope $backup; $restored = $true
    } else { AssertFiles $output $old; $restored = $true }
  } catch { $rollbackError = $_.Exception.Message }
  NewJson (Join-Path $scope ('failure-' + [Guid]::NewGuid().ToString('N') + '.json')) @{ error = $originalError; oldMoved = $oldMoved; newMoved = $newMoved; originalUntouchedOrRestored = $restored; rollbackError = $rollbackError; recovery = "pwsh -NoProfile -File tools/browser-library-runtime/select-output.ps1 -Action Rollback -SwitchId $id" }
  throw "候选选择失败；现场已保留：$scope；原输出保持或恢复：$restored"
}
