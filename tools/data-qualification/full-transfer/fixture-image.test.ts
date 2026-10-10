import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

let root: string;
let image: Buffer;
function ps(script: string): string {
  const path = join(root, 'test.ps1');
  writeFileSync(path, "$ErrorActionPreference='Stop'\n" + script);
  return execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path], {
    cwd: resolve('.'),
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 65536,
  });
}
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'full-transfer-fixture-pure-'));
  ps(`
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'tools/data-qualification/full-transfer/qualify-runner.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw '入口AST无效'}
$assignment=$ast.Find({param($n)$n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$source'},$true)
$source=$assignment.Right.Find({param($n)$n -is [Management.Automation.Language.StringConstantExpressionAst]},$true).Value
$sourcePath=Join-Path $PSScriptRoot 'Fixture.cs';[IO.File]::WriteAllText($sourcePath,$source)
$executable=Join-Path $PSScriptRoot 'fixture.exe'
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$compilerStart=[Diagnostics.ProcessStartInfo]::new($compiler)
$compilerStart.UseShellExecute=$false;$compilerStart.CreateNoWindow=$true
$loop=$ast.Find({param($n)$n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Variable.Extent.Text -ceq '$argument'},$true)
if($null -eq $loop){throw '编译参数未绑定'}
Invoke-Expression $loop.Extent.Text
$process=[Diagnostics.Process]::Start($compilerStart)
try {
 if(-not $process.WaitForExit(10000)){$process.Kill($true);if(-not $process.WaitForExit(2000)){throw '编译退出未知'};throw '编译超时'}
 if($process.ExitCode -ne 0){throw '固定夹具编译失败'}
} finally {$process.Dispose()}
`);
  image = readFileSync(join(root, 'fixture.exe'));
}, 20000);
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

it('原入口的实际编译参数生成AMD64 WinExe，未执行夹具Main', () => {
  const pe = image.readUInt32LE(0x3c);
  expect(image.readUInt32LE(pe)).toBe(0x4550);
  expect(image.readUInt16LE(pe + 4)).toBe(0x8664);
  expect(image.readUInt16LE(pe + 24)).toBe(0x20b);
  expect(image.readUInt16LE(pe + 24 + 68)).toBe(2);
});

it('执行前PE读取器接受真实WinExe，拒绝console及损坏头并释放所有句柄', () => {
  const pe = image.readUInt32LE(0x3c);
  const edits: Record<string, (bytes: Buffer) => Buffer> = {
    valid: (bytes) => bytes,
    console: (bytes) => {
      bytes.writeUInt16LE(3, pe + 24 + 68);
      return bytes;
    },
    dll: (bytes) => {
      bytes.writeUInt16LE(bytes.readUInt16LE(pe + 22) | 0x2000, pe + 22);
      return bytes;
    },
    notExecutable: (bytes) => {
      bytes.writeUInt16LE(bytes.readUInt16LE(pe + 22) & ~2, pe + 22);
      return bytes;
    },
    x86: (bytes) => {
      bytes.writeUInt16LE(0x14c, pe + 4);
      return bytes;
    },
    pe32: (bytes) => {
      bytes.writeUInt16LE(0x10b, pe + 24);
      return bytes;
    },
    wrongDos: (bytes) => {
      bytes.writeUInt16LE(0, 0);
      return bytes;
    },
    wrongPe: (bytes) => {
      bytes.writeUInt32LE(0, pe);
      return bytes;
    },
    offsetOutside: (bytes) => {
      bytes.writeUInt32LE(0xffffffff, 0x3c);
      return bytes;
    },
    offsetInDos: (bytes) => {
      bytes.writeUInt32LE(8, 0x3c);
      return bytes;
    },
    optionalTooShort: (bytes) => {
      bytes.writeUInt16LE(68, pe + 20);
      return bytes;
    },
    optionalOutside: (bytes) => {
      bytes.writeUInt16LE(65535, pe + 20);
      return bytes;
    },
    truncated: (bytes) => bytes.subarray(0, pe + 24 + 68),
    short: (bytes) => bytes.subarray(0, 63),
    oversized: () => Buffer.alloc(1048577),
  };
  for (const [name, edit] of Object.entries(edits)) {
    writeFileSync(join(root, `${name}.bin`), edit(Buffer.from(image)));
  }
  const outcomes = JSON.parse(
    ps(`
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'tools/data-qualification/full-transfer/qualify-runner.ps1'),[ref]$tokens,[ref]$errors)
$function=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Read-FixtureImage'},$true)
if($null -eq $function){throw 'PE读取器缺失'}
Invoke-Expression $function.Extent.Text
$results=foreach($name in @(${Object.keys(edits)
      .map((name) => `'${name}'`)
      .join(',')})) {
 $path=Join-Path $PSScriptRoot ($name+'.bin');$accepted=$false;$fact=$null
 try{$fact=Read-FixtureImage $path;$accepted=$true}catch{}
 $exclusive=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 $exclusive.Dispose()
 [pscustomobject]@{name=$name;accepted=$accepted;fact=$fact}
}
$results|ConvertTo-Json -Depth 4 -Compress
`),
  ) as { name: string; accepted: boolean; fact: unknown }[];
  expect(outcomes).toHaveLength(Object.keys(edits).length);
  for (const outcome of outcomes)
    expect(outcome.accepted, outcome.name).toBe(outcome.name === 'valid');
  expect(outcomes[0].fact).toEqual({
    bytes: image.byteLength,
    machine: 0x8664,
    optionalHeaderMagic: 0x20b,
    subsystem: 2,
  });
});

it('原入口实际PE拒绝会阻止后继启动边界', () => {
  const consoleImage = Buffer.from(image);
  consoleImage.writeUInt16LE(3, consoleImage.readUInt32LE(0x3c) + 24 + 68);
  writeFileSync(join(root, 'console.bin'), consoleImage);
  expect(
    ps(`
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'tools/data-qualification/full-transfer/qualify-runner.ps1'),[ref]$tokens,[ref]$errors)
$function=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Read-FixtureImage'},$true)
Invoke-Expression $function.Extent.Text
$gate=$ast.Find({param($n)$n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$fixtureImage'},$true)
$execute=$ast.Find({param($n)$n -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Member.Extent.Text -ceq 'Execute'},$true)
if($null -eq $gate -or $gate.Extent.EndOffset -ge $execute.Extent.StartOffset){throw '产物门未先于Job启动'}
$executable=Join-Path $PSScriptRoot 'console.bin';$rejected=$false;$reached=$false
try {Invoke-Expression $gate.Extent.Text;$reached=$true}catch{$rejected=$true}
if(-not $rejected -or $reached){throw 'console产物越过启动门'}
'PASS'
`),
  ).toContain('PASS');
});
