import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

function runPowerShell(body: string): Record<string, unknown> {
  const evidence = resolve('log/stage7-e2/independent-full-conversations-runner-review-001');
  mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(evidence, 'pure-'));
  const file = join(root, 'probe.ps1');
  writeFileSync(file, `$ErrorActionPreference='Stop'\n${body}`, { flag: 'wx' });
  const stdout = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', file], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 65536,
  });
  writeFileSync(join(root, 'stdout.json'), stdout, { flag: 'wx' });
  return JSON.parse(stdout) as Record<string, unknown>;
}

it('实际只读共享句柄在本机阻止包含目录被改名', () => {
  const result = runPowerShell(String.raw`
$original=Join-Path $PSScriptRoot 'original'
$moved=Join-Path $PSScriptRoot 'moved'
[IO.Directory]::CreateDirectory($original)|Out-Null
[IO.File]::WriteAllText((Join-Path $original 'member'),'small')
$held=[IO.File]::Open((Join-Path $original 'member'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
$renamed=$false
try { [IO.Directory]::Move($original,$moved); $renamed=$true } catch { } finally { $held.Dispose() }
@{renamed=$renamed}|ConvertTo-Json
`);
  expect(result.renamed).toBe(false);
});

it('记录只读共享锁下元数据与hardlink能力，不能把写锁当作全部元数据不变', () => {
  const result = runPowerShell(String.raw`
$path=Join-Path $PSScriptRoot 'member'
[IO.File]::WriteAllText($path,'small')
$held=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
$writeBlocked=$false;$timeChanged=$false;$linked=$false
try {
  try {$writer=[IO.File]::OpenWrite($path);$writer.Dispose()}catch{$writeBlocked=$true}
  try {[IO.File]::SetLastWriteTimeUtc($path,[DateTime]::UtcNow.AddDays(1));$timeChanged=$true}catch{}
  try {New-Item -ItemType HardLink -Path (Join-Path $PSScriptRoot 'other') -Target $path|Out-Null;$linked=$true}catch{}
}finally{$held.Dispose()}
@{writeBlocked=$writeBlocked;timeChanged=$timeChanged;linked=$linked}|ConvertTo-Json
`);
  expect(result.writeBlocked).toBe(true);
});

it('实际wrapper原生启动前必须持有seed文件读锁，而不只有seed proof', () => {
  const result = runPowerShell(String.raw`
$repository=(Get-Location).Path
$toolDirectory=Join-Path $repository 'tools/data-qualification/full-conversations'
$source=Join-Path $toolDirectory 'run.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw '实际wrapper语法错误'}
foreach($fn in $ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] }) { Invoke-Expression $fn.Extent.Text }
$ScopeId='full-conversations-'+[Guid]::NewGuid().ToString('N')
$RuntimeId='runtime-'+[Guid]::NewGuid().ToString('N')
$scope=Join-Path $repository ('log/stage7-e2/'+$ScopeId)
$origin=Join-Path $repository ('log/stage7-e2/'+$RuntimeId)
[IO.Directory]::CreateDirectory($scope)|Out-Null
[IO.Directory]::CreateDirectory((Join-Path $origin 'fixtures/conversations'))|Out-Null
$seedPath=Join-Path $origin 'fixtures/conversations/00000000-0000-4000-8000-000000000000.json'
[IO.File]::WriteAllText($seedPath,'tiny-seed')
$seedHash=(Get-FileHash -LiteralPath $seedPath).Hash.ToLowerInvariant()
Write-Receipt (Join-Path $origin 'fixture-proof.json') @{completed=$true;productE2Pass=$false;hashes=@{'fixtures/conversations/00000000-0000-4000-8000-000000000000.json'=$seedHash}}
$outer=@($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })[0]
$sourceNamesStatement=@($outer.Body.Statements | Where-Object { $_.Extent.Text.StartsWith('$fixedSources = @(') })[0]
Invoke-Expression $sourceNamesStatement.Extent.Text
$sources=@{}
foreach($name in $fixedSources) {$sources[$name]=(Get-FileHash -LiteralPath (Join-Path $repository $name)).Hash.ToLowerInvariant()}
[IO.File]::WriteAllText((Join-Path $scope 'prepare.cjs'),'never execute')
$bundleHash=(Get-FileHash -LiteralPath (Join-Path $scope 'prepare.cjs')).Hash.ToLowerInvariant()
$node=(Get-Command node.exe -CommandType Application|Select-Object -First 1).Source
Write-Receipt (Join-Path $scope 'build-proof.json') @{version=1;scopeId=$ScopeId;nodeVersion=('v'+(Get-Item $node).VersionInfo.ProductVersion);sources=$sources;bundleSha256=$bundleHash}
$locks=[Collections.Generic.List[IO.FileStream]]::new()
$heldFacts=[Collections.Generic.List[object]]::new()
$intentWritten=$false
$clock=[Diagnostics.Stopwatch]::StartNew()
$workMs=150000
$proofBlocked=$false;$seedBlocked=$false
try {
  foreach($statement in $outer.Body.Statements) {
    if($statement.Extent.Text.StartsWith('Add-Type -Path')){break}
    # Capacity is reduced only in this preflight fixture; no native process can start.
    $text=$statement.Extent.Text.Replace('$PSScriptRoot','$toolDirectory').Replace('$PSCommandPath','$source').Replace('67108864','9')
    Invoke-Expression $text
  }
  try {$probe=[IO.File]::Open((Join-Path $origin 'fixture-proof.json'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read);$probe.Dispose()}catch{$proofBlocked=$true}
  try {$probe=[IO.File]::Open($seedPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read);$probe.Dispose()}catch{$seedBlocked=$true}
} finally { foreach($stream in $locks){$stream.Dispose()} }
@{proofBlocked=$proofBlocked;seedBlocked=$seedBlocked;scope=$scope;origin=$origin}|ConvertTo-Json
`);
  expect(result.proofBlocked).toBe(true);
  expect(result.seedBlocked).toBe(true);
});

it.each([
  'none',
  'hardlink',
  'mtime',
  'proof',
  'input-mtime',
  'proof-mtime',
  'deadline',
  'close-deadline',
])('实际最终回执之后须保留成功控制及拒绝%s变化', (mutation) => {
  const result = runPowerShell(String.raw`
$mutation='${mutation}'
$source=Join-Path (Get-Location).Path 'tools/data-qualification/full-conversations/run.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw '实际wrapper语法错误'}
foreach($fn in $ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] }) { Invoke-Expression $fn.Extent.Text }
$outer=@($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })[0]
Add-Type -Path (Join-Path ([IO.Path]::GetDirectoryName($source)) 'FixedPrepareJob.cs')
Add-Type -TypeDefinition @'
using System;
using System.IO;
public sealed class ReviewClock {
 public static long Ms;
 public long ElapsedMilliseconds {get{return Ms;}}
 public TimeSpan Elapsed {get{return TimeSpan.FromMilliseconds(Ms);}}
}
public sealed class ClosingClockFile : FileStream {
 public ClosingClockFile(string path):base(path,FileMode.Open,FileAccess.Read,FileShare.Read){}
 protected override void Dispose(bool disposing){base.Dispose(disposing);if(disposing)ReviewClock.Ms=150001;}
}
'@
$scope=Join-Path $PSScriptRoot 'scope'
$members=Join-Path $scope 'conversations'
[IO.Directory]::CreateDirectory($members)|Out-Null
foreach($name in @('build-proof.json','prepare.cjs','fixture-proof.json','prepare-result.json','run-intent.json','run-launch.json')) {
  [IO.File]::WriteAllText((Join-Path $scope $name),'{}')
}
$memberNames=@('index.json')+@(0..49|ForEach-Object{'00000000-0000-4000-8000-{0:x12}.json' -f $_})
$locks=[Collections.Generic.List[IO.FileStream]]::new()
$heldFacts=[Collections.Generic.List[object]]::new()
$facts=@{}
foreach($name in @('build-proof.json','prepare.cjs','fixture-proof.json','prepare-result.json','run-intent.json','run-launch.json')){
  $receipt=Read-BoundFile (Join-Path $scope $name) 65536 $true
  $heldFacts.Add((Capture-HeldFact $receipt.stream $receipt.hash))
  if($name -eq 'fixture-proof.json'){$proofReceipt=$receipt}
}
$inputPath=Join-Path $PSScriptRoot 'seed'
[IO.File]::WriteAllText($inputPath,'tiny-input')
$input=Read-BoundFile $inputPath 65536 $true $false
$heldFacts.Add((Capture-HeldFact $input.stream))
foreach($name in $memberNames){
  $path=Join-Path $members $name
  [IO.File]::WriteAllText($path,'tiny')
  $held=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  $locks.Add($held)
  $facts[$name]=[AIbrowse.FullConversations.FixedPrepareJob]::InspectFile($held)
  $heldFacts.Add((Capture-HeldFact $held))
  if($name -eq 'index.json'){$victimStream=$held}
}
if($mutation -eq 'close-deadline'){
  $closing=[ClosingClockFile]::new($inputPath)
  $locks.Add($closing)
  $heldFacts.Add((Capture-HeldFact $closing))
}
$victim=Join-Path $members $memberNames[0]
$realReceipt=(Get-Command Write-Receipt).ScriptBlock
$script:changed=$false;$script:blocked=$false
function Write-Receipt([string]$Path,$Value,[switch]$Hold){
  $receipt=& $realReceipt $Path $Value -Hold:$Hold
  if($mutation -eq 'hardlink'){
    New-Item -ItemType HardLink -Path (Join-Path $PSScriptRoot 'outside-link') -Target $victim|Out-Null
    try{[AIbrowse.FullConversations.FixedPrepareJob]::InspectFile($victimStream)|Out-Null}catch{$script:changed=$true}
  }elseif($mutation -in @('mtime','input-mtime','proof-mtime')){
    $target=if($mutation -eq 'input-mtime'){$inputPath}elseif($mutation -eq 'proof-mtime'){Join-Path $scope 'fixture-proof.json'}else{$victim}
    $before=(Get-Item -LiteralPath $target).LastWriteTimeUtc
    [IO.File]::SetLastWriteTimeUtc($target,[DateTime]::UtcNow.AddDays(1))
    $script:changed=(Get-Item -LiteralPath $target).LastWriteTimeUtc -ne $before
  }elseif($mutation -eq 'proof'){
    $proofPath=Join-Path $scope 'fixture-proof.json'
    try{
      [IO.File]::WriteAllText($proofPath,'{"replaced":true}')
      $script:changed=(Get-FileHash -LiteralPath $proofPath).Hash.ToLowerInvariant() -cne $proofReceipt.hash
    }catch{$script:blocked=$true}
  }elseif($mutation -eq 'deadline'){
    [ReviewClock]::Ms=150001
  }
  return $receipt
}
$saved=$null;$intentWritten=$true;$workMs=150000
$clock=[ReviewClock]::new()
$result=@{completed=$true;durationMs=0}
$rejected=$false
try{
  . (Invoke-Expression $outer.Finally.Extent.Text)
  foreach($statement in $ast.EndBlock.Statements){
    if($statement.Extent.StartOffset -lt $outer.Extent.EndOffset){continue}
    if($statement.Extent.Text.StartsWith('$result |')){break}
    Invoke-Expression $statement.Extent.Text
  }
}catch{$rejected=$true}
@{changed=$script:changed;blocked=$script:blocked;elapsed=$clock.ElapsedMilliseconds;completed=($result.completed -and -not $rejected);scope=$scope}|ConvertTo-Json
`);
  expect(result.changed).toBe(
    ['hardlink', 'mtime', 'input-mtime', 'proof-mtime'].includes(mutation),
  );
  expect(result.blocked).toBe(mutation === 'proof');
  if (mutation.endsWith('deadline')) expect(result.elapsed).toBe(150001);
  expect(result.completed).toBe(mutation === 'none' || mutation === 'proof');
});
