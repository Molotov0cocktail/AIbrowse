param(
  [Parameter(Mandatory = $true)][string]$ArchivePath,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Inspect an archive as data only; never load or execute extension code.
$sourcePath = (Resolve-Path -LiteralPath $ArchivePath).Path
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$allowedOutputRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'log')) + [IO.Path]::DirectorySeparatorChar
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $outputPath.StartsWith($allowedOutputRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw '静态分析输出必须位于项目 log 目录内'
}
if (Test-Path -LiteralPath $outputPath) { throw '输出目录已存在，拒绝覆盖旧证据' }
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$archive = [IO.Compression.ZipFile]::OpenRead($sourcePath)
$entries = [Collections.Generic.List[object]]::new()
$names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$totalBytes = 0L
try {
  if ($archive.Entries.Count -gt 4096) { throw '归档条目超出静态分析预算' }
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName.Replace('\', '/')
    $segments = $name.TrimEnd('/').Split('/')
    if ([string]::IsNullOrEmpty($name) -or $name.StartsWith('/') -or $name.Contains(':') -or
        $name -match '[\x00-\x1f]' -or
        @($segments | Where-Object { $_ -in @('', '.', '..') -or $_ -match '[. ]$|^(?i:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)' }).Count -gt 0 -or
        (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
      throw '归档包含不安全路径或符号链接'
    }
    if (-not $names.Add($name)) { throw '归档包含大小写不敏感的重复路径' }
    if ($entry.Length -gt 32MB) { throw '单个归档条目超出预算' }
    $totalBytes += $entry.Length
    if ($totalBytes -gt 128MB) { throw '归档解压总量超出预算' }
  }
  # Validate every destination before the first write.
  $textRoot = Join-Path $outputPath 'text'
  foreach ($entry in $archive.Entries) {
    $candidatePath = [IO.Path]::GetFullPath((Join-Path $textRoot $entry.FullName))
    if (-not $candidatePath.StartsWith($textRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw '归档目标越出静态分析目录'
    }
  }
  [IO.Directory]::CreateDirectory($textRoot) | Out-Null
  foreach ($entry in $archive.Entries) {
    if ($entry.FullName.EndsWith('/')) {
      $entries.Add([ordered]@{ path = $entry.FullName; kind = 'directory'; bytes = 0 })
      continue
    }
    $stream = $entry.Open()
    $buffer = [IO.MemoryStream]::new()
    try {
      $chunk = [byte[]]::new(65536)
      while (($count = $stream.Read($chunk, 0, $chunk.Length)) -gt 0) {
        if ($buffer.Length + $count -gt $entry.Length) { throw '解压内容超过声明大小，停止读取' }
        $buffer.Write($chunk, 0, $count)
      }
      $bytes = $buffer.ToArray()
    }
    finally { $stream.Dispose(); $buffer.Dispose() }
    if ($bytes.Length -ne $entry.Length) { throw '解压字节数与归档元数据不符' }
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    $isText = $entry.FullName -match '\.(?:js|json|html|css|map)$|(?:^|/)ReadMe$'
    $entries.Add([ordered]@{ path = $entry.FullName; kind = $(if ($isText) { 'text' } else { 'binary' }); bytes = $bytes.Length; sha256 = $hash })
    if (-not $isText) { continue }
    $text = $utf8.GetString($bytes)
    $target = Join-Path $textRoot $entry.FullName
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
    [IO.File]::WriteAllBytes($target, $bytes)
    if ($entry.FullName -in @('default_config.json', 'default_config.content.json', 'manifest.json')) {
      $data = $text | ConvertFrom-Json -AsHashtable
      [IO.File]::WriteAllText((Join-Path $outputPath ($entry.FullName + '.pretty.json')), ($data | ConvertTo-Json -Depth 100), $utf8)
    }
    if ($entry.FullName -eq 'locales.json') {
      $data = $text | ConvertFrom-Json -AsHashtable
      [IO.File]::WriteAllText((Join-Path $outputPath 'zh-CN.pretty.json'), ($data['zh-CN'] | ConvertTo-Json -Depth 100), $utf8)
    }
  }
  $manifestPath = Join-Path $textRoot 'manifest.json'
  $manifest = [IO.File]::ReadAllText($manifestPath, $utf8) | ConvertFrom-Json
  $result = [ordered]@{
    scope = '仅静态文件完整性与文本导出；未执行插件，不构成业务兼容或安全审计通过'
    packageVersion = $manifest.version
    toolSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    archiveSha256 = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    entryCount = $entries.Count
    textCount = @($entries | Where-Object { $_.kind -eq 'text' }).Count
    binaryCount = @($entries | Where-Object { $_.kind -eq 'binary' }).Count
    directoryCount = @($entries | Where-Object { $_.kind -eq 'directory' }).Count
    sourceMapCount = @($entries | Where-Object { $_.path -match '\.map$' }).Count
    totalBytes = $totalBytes
    entries = $entries
  }
  [IO.File]::WriteAllText((Join-Path $outputPath 'inventory.json'), ($result | ConvertTo-Json -Depth 8), $utf8)
  [pscustomobject]$result | Select-Object scope, packageVersion, archiveSha256, entryCount, textCount, binaryCount, directoryCount, sourceMapCount, totalBytes | ConvertTo-Json -Compress
}
finally { $archive.Dispose() }
