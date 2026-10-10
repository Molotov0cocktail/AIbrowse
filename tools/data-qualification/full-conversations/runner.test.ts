import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function powershell(source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'full-runner-pure-'));
  roots.push(root);
  const file = join(root, 'test.ps1');
  writeFileSync(file, `$ErrorActionPreference='Stop'\n${source}`);
  return execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', file], {
    cwd: resolve('.'),
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 65536,
    encoding: 'utf8',
  });
}
it('固定runner与小资格脚本通过PowerShell原生语法解析', () => {
  expect(
    powershell(`
foreach($name in @('run.ps1','qualify-runner.ps1')) {
 $tokens=$null;$errors=$null
 [void][Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) "tools/data-qualification/full-conversations/$name"),[ref]$tokens,[ref]$errors)
 if($errors.Count){throw '语法错误'}
}
'PASS'
`),
  ).toContain('PASS');
});
it('真实排他回执函数拒绝覆盖且原字节不变', () => {
  expect(
    powershell(`
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'tools/data-qualification/full-conversations/run.ps1'),[ref]$tokens,[ref]$errors)
$fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Write-Receipt'},$true)
Invoke-Expression $fn.Extent.Text
$path=Join-Path $PSScriptRoot 'receipt.json'
Write-Receipt $path @{version=1}
$old=[IO.File]::ReadAllText($path)
$rejected=$false
try{Write-Receipt $path @{version=2}}catch{$rejected=$true}
if(-not $rejected -or [IO.File]::ReadAllText($path) -cne $old){throw '原件被覆盖'}
'PASS'
`),
  ).toContain('PASS');
});
it('原seed读取使用同句柄摘要且持续拒绝写入和删除，未分配seed正文', () => {
  expect(
    powershell(`
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'tools/data-qualification/full-conversations/run.ps1'),[ref]$tokens,[ref]$errors)
foreach($name in @('Assert-Parents','Read-BoundFile')) {
 $fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
 Invoke-Expression $fn.Extent.Text
}
$locks=[Collections.Generic.List[IO.FileStream]]::new()
$path=Join-Path $PSScriptRoot 'seed.json'
$bytes=[Text.Encoding]::UTF8.GetBytes('fixed tiny seed')
[IO.File]::WriteAllBytes($path,$bytes)
$receipt=Read-BoundFile $path 67108864 $true $false
try {
 if($receipt.hash -cne [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -or $receipt.length -ne $bytes.Length -or $receipt.bytes.Length -ne 0 -or $locks.Count -ne 1 -or -not [object]::ReferenceEquals($locks[0],$receipt.stream)){throw '未绑定同一原句柄'}
 $writeRejected=$false;$deleteRejected=$false
 try{[IO.File]::WriteAllText($path,'changed')}catch{$writeRejected=$true}
 try{[IO.File]::Delete($path)}catch{$deleteRejected=$true}
 if(-not $writeRejected -or -not $deleteRejected){throw '原件未被持续锁定'}
} finally {foreach($stream in $locks){$stream.Dispose()}}
[IO.File]::WriteAllText($path,'released')
'PASS'
`),
  ).toContain('PASS');
  const runner = readFileSync('tools/data-qualification/full-conversations/run.ps1', 'utf8');
  expect(runner).toContain('Read-BoundFile $seedPath 67108864 $true $false');
  expect(runner).toContain('$seedReceipt.length -ne 67108864');
  expect(runner).toContain('$seedReceipt.hash -cne $seedHash');
});
it('编译真实CSharp并验证原生限额读回的纯边界，不调用native Job', () => {
  expect(
    powershell(`
Add-Type -Path tools/data-qualification/full-conversations/FixedPrepareJob.cs
[AIbrowse.FullConversations.FixedPrepareJob]::ValidateLimits(0x2308,1,2147483648,2147483648)
foreach($case in @(@(0x2000,1,2147483648,2147483648),@(0x2308,2,2147483648,2147483648),@(0x2308,1,1073741824,2147483648),@(0x2308,1,2147483648,1073741824))) {
 $rejected=$false
 try{[AIbrowse.FullConversations.FixedPrepareJob]::ValidateLimits($case[0],$case[1],$case[2],$case[3])}catch{$rejected=$true}
 if(-not $rejected){throw '错误限额被接受'}
}
if([AIbrowse.FullConversations.FixedPrepareJob]::Allocation(65537,4096) -ne 69632){throw '向上分配错误'}
$rejected=$false
try{[AIbrowse.FullConversations.FixedPrepareJob]::Allocation(1,0)}catch{$rejected=$true}
if(-not $rejected){throw '零分配单位被接受'}
'PASS'
`),
  ).toContain('PASS');
});
it('固定入口不使用重新打开Job作为退出证据，旧准备6文件无接口改动', () => {
  const native = readFileSync(
    'tools/data-qualification/full-conversations/FixedPrepareJob.cs',
    'utf8',
  );
  const runner = readFileSync('tools/data-qualification/full-conversations/run.ps1', 'utf8');
  expect(native).toContain('0x2000D');
  expect(native).toContain('result.ActiveAtEnd=Active(job)');
  expect(native).not.toContain('ConfirmReleased');
  expect(runner).not.toContain('ConfirmReleased');
  expect(runner).toContain('$workMs = 150000');
  expect(runner).toContain('terminationOnlyMs=30000');
  expect(runner).toContain('Read-BoundFile $node 104857600 $true $false');
});

it('真实wrapper预检失败留档且同scope拒绝重跑，不启动Node', () => {
  const scopeId = `full-conversations-${randomUUID().replaceAll('-', '')}`;
  const runtimeId = `runtime-${randomUUID().replaceAll('-', '')}`;
  const scope = resolve('log/stage7-e2', scopeId);
  mkdirSync(scope);
  mkdirSync(resolve('log/stage7-e2', runtimeId));
  writeFileSync(join(scope, 'build-proof.json'), '{"version":999}');
  writeFileSync(join(scope, 'prepare.cjs'), 'throw Error("禁止启动");');
  const run = () =>
    spawnSync(
      'pwsh.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        'tools/data-qualification/full-conversations/run.ps1',
        '-ScopeId',
        scopeId,
        '-RuntimeId',
        runtimeId,
      ],
      { windowsHide: true, timeout: 15000, maxBuffer: 65536, encoding: 'utf8' },
    );
  const first = run();
  expect(first.status).toBe(1);
  const original = readFileSync(join(scope, 'run-result.json'));
  expect(JSON.parse(original.toString('utf8'))).toMatchObject({ completed: false, job: null });
  const second = run();
  expect(second.status).toBe(1);
  expect(readFileSync(join(scope, 'run-result.json'))).toEqual(original);
  writeFileSync(
    join(scope, 'test-evidence.json'),
    JSON.stringify({
      scopeId,
      runtimeId,
      firstExit: first.status,
      secondExit: second.status,
      firstOutput: first.stdout,
      secondOutput: second.stdout,
      syntheticExpectedFailure: true,
      productE2Pass: false,
    }),
    { flag: 'wx' },
  );
  // Expected failure receipts are retained under log; no actual prepare job was launched.
});

it.each(['none', 'mtime', 'hardlink', 'input-mtime', 'proof-mtime', 'proof-write'] as const)(
  '实际finally使用完整原事实集合处理%s，正常完成阳性不能因夹具缺变量假绿',
  (mutation) => {
    const output = powershell(String.raw`
$tokens=$null;$errors=$null
$source=Join-Path (Get-Location) 'tools/data-qualification/full-conversations/run.ps1'
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
foreach($fn in $ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst]}){Invoke-Expression $fn.Extent.Text}
$outer=@($ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})[0]
Add-Type -Path tools/data-qualification/full-conversations/FixedPrepareJob.cs
$scope=Join-Path $PSScriptRoot 'scope'
$members=Join-Path $scope 'conversations'
[IO.Directory]::CreateDirectory($members)|Out-Null
$locks=[Collections.Generic.List[IO.FileStream]]::new()
$heldFacts=[Collections.Generic.List[object]]::new()
foreach($name in @('build-proof.json','prepare.cjs','fixture-proof.json','prepare-result.json','run-intent.json','run-launch.json')){
 $path=Join-Path $scope $name
 [IO.File]::WriteAllText($path,'{}')
 $receipt=Read-BoundFile $path 65536 $true
 $heldFacts.Add((Capture-HeldFact $receipt.stream $receipt.hash))
}
$inputPath=Join-Path $PSScriptRoot 'input.json'
[IO.File]::WriteAllText($inputPath,'input')
$inputReceipt=Read-BoundFile $inputPath 65536 $true
$heldFacts.Add((Capture-HeldFact $inputReceipt.stream))
$memberNames=@('index.json')+@(0..49|ForEach-Object{'00000000-0000-4000-8000-{0:x12}.json' -f $_})
foreach($name in $memberNames){
 $path=Join-Path $members $name
 [IO.File]::WriteAllText($path,'tiny')
 $receipt=Read-BoundFile $path 65536 $true
 $heldFacts.Add((Capture-HeldFact $receipt.stream))
}
$script:changed=$false;$script:blocked=$false
$realReceipt=(Get-Command Write-Receipt).ScriptBlock
function Write-Receipt([string]$Path,$Value,[switch]$Hold){
 $receipt=& $realReceipt $Path $Value -Hold:$Hold
 $kind='${mutation}'
 $victim=Join-Path $members 'index.json'
 if($kind -eq 'hardlink'){
   New-Item -ItemType HardLink -Path (Join-Path $PSScriptRoot 'outside-link') -Target $victim|Out-Null
   $script:changed=$true
 }elseif($kind -in @('mtime','input-mtime','proof-mtime')){
   if($kind -eq 'input-mtime'){$victim=$inputPath}
   if($kind -eq 'proof-mtime'){$victim=Join-Path $scope 'fixture-proof.json'}
   [IO.File]::SetLastWriteTimeUtc($victim,[DateTime]::UtcNow.AddDays(1))
   $script:changed=$true
 }elseif($kind -eq 'proof-write'){
   try{[IO.File]::WriteAllText((Join-Path $scope 'fixture-proof.json'),'changed');$script:changed=$true}catch{$script:blocked=$true}
 }
 return $receipt
}
$saved=$null;$intentWritten=$true;$workMs=150000
$clock=[Diagnostics.Stopwatch]::StartNew()
$result=@{completed=$true;durationMs=0}
. (Invoke-Expression $outer.Finally.Extent.Text)
@{completed=$result.completed;changed=$script:changed;blocked=$script:blocked}|ConvertTo-Json
`);
    const result = JSON.parse(output) as { completed: boolean; changed: boolean; blocked: boolean };
    expect(result.completed).toBe(mutation === 'none' || mutation === 'proof-write');
    expect(result.changed).toBe(mutation !== 'none' && mutation !== 'proof-write');
    expect(result.blocked).toBe(mutation === 'proof-write');
  },
);
