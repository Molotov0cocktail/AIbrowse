param([string]$OutputRoot = 'out/lifecycle-guardian')
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$outputDirectory = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputRoot))
if (-not $outputDirectory.StartsWith($repositoryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'guardian 输出必须位于受控仓库目录'
}
$compilerInputs = @(
  @{ Name = 'Microsoft.CodeAnalysis.dll'; Sha256 = 'a11461236d71889c0d7e440e9b08cb2e381f59a16a845648c3809855b6305dcd' },
  @{ Name = 'Microsoft.CodeAnalysis.CSharp.dll'; Sha256 = 'a1cbb3e005e5f91cbed130ef7eeaa79204e6bb10e05c54ce4c384a81a7646627' }
)
foreach ($inputFile in $compilerInputs) {
  $compilerPath = Join-Path $PSHOME $inputFile.Name
  if (-not (Test-Path -LiteralPath $compilerPath -PathType Leaf) -or
      (Get-FileHash -LiteralPath $compilerPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $inputFile.Sha256) {
    throw '现有确定性 C# 编译器与固定输入不符'
  }
  Add-Type -LiteralPath $compilerPath
}
$frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$referenceInputs = @('mscorlib.dll', 'System.dll', 'System.Core.dll') | ForEach-Object {
  $referencePath = Join-Path $frameworkRoot $_
  if (-not (Test-Path -LiteralPath $referencePath -PathType Leaf)) { throw '现有 Framework 引用不可用' }
  [ordered]@{ name = $_; sha256 = (Get-FileHash -LiteralPath $referencePath -Algorithm SHA256).Hash.ToLowerInvariant() }
}
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$executable = Join-Path $outputDirectory 'guardian.exe'
$pendingExecutable = Join-Path $outputDirectory ('guardian-' + [guid]::NewGuid().ToString('N') + '.pending')
$source = Join-Path $repositoryRoot 'native/lifecycle-guardian/Guardian.cs'
$encoding = [Text.UTF8Encoding]::new($false, $true)
$parseOptions = [Microsoft.CodeAnalysis.CSharp.CSharpParseOptions]::Default.WithLanguageVersion([Microsoft.CodeAnalysis.CSharp.LanguageVersion]::CSharp5)
$tree = [Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText(
  [IO.File]::ReadAllText($source, $encoding), $parseOptions, 'native/lifecycle-guardian/Guardian.cs',
  $encoding, [Threading.CancellationToken]::None)
$references = [Microsoft.CodeAnalysis.MetadataReference[]]@($referenceInputs | ForEach-Object {
  [Microsoft.CodeAnalysis.MetadataReference]::CreateFromFile(
    (Join-Path $frameworkRoot $_.name), [Microsoft.CodeAnalysis.MetadataReferenceProperties]::Assembly, $null)
})
$options = [Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions]::new([Microsoft.CodeAnalysis.OutputKind]::WindowsApplication).
  WithPlatform([Microsoft.CodeAnalysis.Platform]::X64).
  WithOptimizationLevel([Microsoft.CodeAnalysis.OptimizationLevel]::Release).
  WithDeterministic($true).
  WithConcurrentBuild($false)
$compilation = [Microsoft.CodeAnalysis.CSharp.CSharpCompilation]::Create(
  'guardian', [Microsoft.CodeAnalysis.SyntaxTree[]]@($tree), $references, $options)
$stream = [IO.File]::Open($pendingExecutable, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
$resources = $compilation.CreateDefaultWin32Resources($true, $false, $null, $null)
try {
  $result = $compilation.Emit($stream, $null, $null, $resources, $null, $null, [Threading.CancellationToken]::None)
  if (-not $result.Success) {
    throw 'guardian 确定性编译失败'
  }
  $stream.Flush($true)
} finally { $stream.Dispose(); $resources.Dispose() }
$size = (Get-Item -LiteralPath $pendingExecutable).Length
if ($size -gt 524288) { throw 'guardian 文件超出固定上限' }
$manifest = [ordered]@{ version = 1; bytes = $size; sha256 = (Get-FileHash -LiteralPath $pendingExecutable -Algorithm SHA256).Hash.ToLowerInvariant() }
[IO.File]::Move($pendingExecutable, $executable, $true)
[IO.File]::WriteAllText((Join-Path $outputDirectory 'manifest.json'), ($manifest | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
$compilerManifest = [ordered]@{
  schemaVersion = 1
  powerShell = $PSVersionTable.PSVersion.ToString()
  assemblies = @($compilerInputs | ForEach-Object { [ordered]@{ name = $_.Name; sha256 = $_.Sha256 } })
  references = @($referenceInputs)
  sourceSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
  buildScriptSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
  options = 'windowsapplication;x64;release;csharp5;deterministic;no-pdb'
}
[IO.File]::WriteAllText((Join-Path $outputDirectory 'compiler.json'), ($compilerManifest | ConvertTo-Json -Depth 8 -Compress), $encoding)
$manifest | ConvertTo-Json -Compress
