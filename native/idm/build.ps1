param([string]$OutputPath = 'out/idm/idm-handoff.exe', [switch]$Tests)
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$executable = if ([IO.Path]::IsPathRooted($OutputPath)) { [IO.Path]::GetFullPath($OutputPath) } else { [IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputPath)) }
if (-not $executable.StartsWith($repositoryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'IDM组件输出必须位于受控仓库目录' }
$compilerInputs = @(
  @{ Name = 'Microsoft.CodeAnalysis.dll'; Sha256 = 'a11461236d71889c0d7e440e9b08cb2e381f59a16a845648c3809855b6305dcd' },
  @{ Name = 'Microsoft.CodeAnalysis.CSharp.dll'; Sha256 = 'a1cbb3e005e5f91cbed130ef7eeaa79204e6bb10e05c54ce4c384a81a7646627' }
)
foreach ($inputFile in $compilerInputs) {
  $compilerPath = Join-Path $PSHOME $inputFile.Name
  if (-not (Test-Path -LiteralPath $compilerPath -PathType Leaf) -or (Get-FileHash -LiteralPath $compilerPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $inputFile.Sha256) { throw '现有确定性 C# 编译器与固定输入不符' }
  Add-Type -LiteralPath $compilerPath
}
$frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$referenceInputs = @('mscorlib.dll', 'System.dll', 'System.Core.dll') | ForEach-Object {
  $referencePath = Join-Path $frameworkRoot $_
  if (-not (Test-Path -LiteralPath $referencePath -PathType Leaf)) { throw '现有 Framework 引用不可用' }
  [ordered]@{ name = $_; sha256 = (Get-FileHash -LiteralPath $referencePath -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$outputDirectory = Split-Path -Parent $executable
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$encoding = [Text.UTF8Encoding]::new($false, $true)
$parseOptions = [Microsoft.CodeAnalysis.CSharp.CSharpParseOptions]::Default.WithLanguageVersion([Microsoft.CodeAnalysis.CSharp.LanguageVersion]::CSharp5)
$references = [Microsoft.CodeAnalysis.MetadataReference[]]@($referenceInputs | ForEach-Object { [Microsoft.CodeAnalysis.MetadataReference]::CreateFromFile((Join-Path $frameworkRoot $_.name), [Microsoft.CodeAnalysis.MetadataReferenceProperties]::Assembly, $null) })
function Build-IdmComponent([string]$destination, [bool]$testMode) {
  $sources = @('IdmHandoff.cs')
  if ($testMode) { $sources += 'ProtocolTests.cs' }
  $trees = [Microsoft.CodeAnalysis.SyntaxTree[]]@($sources | ForEach-Object {
    [Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText([IO.File]::ReadAllText((Join-Path $PSScriptRoot $_), $encoding), $parseOptions, "native/idm/$_", $encoding, [Threading.CancellationToken]::None)
  })
  $options = [Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions]::new([Microsoft.CodeAnalysis.OutputKind]::WindowsApplication).WithPlatform([Microsoft.CodeAnalysis.Platform]::X64).WithOptimizationLevel([Microsoft.CodeAnalysis.OptimizationLevel]::Release).WithDeterministic($true).WithConcurrentBuild($false).WithMainTypeName('AIbrowse.Idm.Handoff')
  if ($testMode) { $options = $options.WithOutputKind([Microsoft.CodeAnalysis.OutputKind]::ConsoleApplication).WithMainTypeName('AIbrowse.Idm.ProtocolTests') }
  $compilation = [Microsoft.CodeAnalysis.CSharp.CSharpCompilation]::Create('idm-handoff', $trees, $references, $options)
  $pending = $destination + '.' + [guid]::NewGuid().ToString('N') + '.pending'
  $stream = [IO.File]::Open($pending, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $resources = $compilation.CreateDefaultWin32Resources($true, $false, $null, $null)
  try {
    $result = $compilation.Emit($stream, $null, $null, $resources, $null, $null, [Threading.CancellationToken]::None)
    if (-not $result.Success) { $result.Diagnostics | ForEach-Object ToString | Write-Output; throw 'IDM组件确定性编译失败' }
    $stream.Flush($true)
  } finally { $stream.Dispose(); $resources.Dispose() }
  [IO.File]::Move($pending, $destination, $true)
}
Build-IdmComponent $executable $false
$manifest = [ordered]@{ version = 1; bytes = (Get-Item -LiteralPath $executable).Length; sha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() }
[IO.File]::WriteAllText((Join-Path $outputDirectory 'manifest.json'), ($manifest | ConvertTo-Json -Compress), $encoding)
$compilerManifest = [ordered]@{ schemaVersion=1; powerShell=$PSVersionTable.PSVersion.ToString(); assemblies=$compilerInputs; references=$referenceInputs; sourceSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'IdmHandoff.cs')).Hash.ToLowerInvariant(); buildScriptSha256=(Get-FileHash -LiteralPath $PSCommandPath).Hash.ToLowerInvariant(); options='windowsapplication;x64;release;csharp5;deterministic;no-pdb' }
[IO.File]::WriteAllText((Join-Path $outputDirectory 'compiler.json'), ($compilerManifest | ConvertTo-Json -Depth 8 -Compress), $encoding)
if ($Tests) {
  $testDirectory = Join-Path $repositoryRoot 'log/builtin-tools-20261013/idm-build'
  New-Item -ItemType Directory -Force -Path $testDirectory | Out-Null
  $testExecutable = Join-Path $testDirectory 'protocol-tests.exe'
  Build-IdmComponent $testExecutable $true
  & $testExecutable
  if ($LASTEXITCODE -ne 0) { throw 'IDM 协议原生验证失败' }
}
$manifest | ConvertTo-Json -Compress
