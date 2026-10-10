import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import * as pathModule from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, expect, it } from 'vitest';

let root: string;
let tinySource: string;
const scriptPath = 'tools/data-qualification/full-transfer/node-tiny.ps1';
function ps(script: string): string {
  const target = join(root, 'pure.ps1');
  writeFileSync(
    target,
    "$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n" +
      script,
  );
  return execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', target], {
    cwd: resolve('.'),
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 131072,
  });
}
const parse = `
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) '${scriptPath}'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw $errors[0]}
function Load-Function([string]$Name) {
 $fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $Name},$true)
 if($null -eq $fn){throw '纯边界缺失'}
 return $fn.Extent.Text
}
`;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'full-transfer-node-tiny-pure-'));
  tinySource = JSON.parse(
    ps(
      parse +
        `
$node=$ast.Find({param($n)$n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$source'},$true)
$node.Right.Find({param($n)$n -is [Management.Automation.Language.StringConstantExpressionAst]},$true).Value|ConvertTo-Json -Compress
`,
    ),
  ) as string;
}, 20000);
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

it('固定Node PE读取实际流：只接受AMD64 PE32+ console，保持持有流', () => {
  const valid = Buffer.alloc(512);
  valid.writeUInt16LE(0x5a4d);
  valid.writeUInt32LE(64, 0x3c);
  valid.writeUInt32LE(0x4550, 64);
  valid.writeUInt16LE(0x8664, 68);
  valid.writeUInt16LE(112, 84);
  valid.writeUInt16LE(2, 86);
  valid.writeUInt16LE(0x20b, 88);
  valid.writeUInt16LE(3, 156);
  const variants: Record<string, (bytes: Buffer) => void> = {
    valid: () => {},
    winexe: (bytes) => {
      bytes.writeUInt16LE(2, 156);
    },
    x86: (bytes) => {
      bytes.writeUInt16LE(0x14c, 68);
    },
    pe32: (bytes) => {
      bytes.writeUInt16LE(0x10b, 88);
    },
    dll: (bytes) => {
      bytes.writeUInt16LE(0x2002, 86);
    },
    signature: (bytes) => {
      bytes.writeUInt32LE(0, 64);
    },
    offset: (bytes) => {
      bytes.writeUInt32LE(0xffffffff, 0x3c);
    },
    optional: (bytes) => {
      bytes.writeUInt16LE(65535, 84);
    },
  };
  for (const [name, change] of Object.entries(variants)) {
    const bytes = Buffer.from(valid);
    change(bytes);
    writeFileSync(join(root, name), bytes);
  }
  const result = JSON.parse(
    ps(
      parse +
        `
Invoke-Expression (Load-Function 'Read-NodeImage')
$output=foreach($name in @(${Object.keys(variants)
          .map((name) => `'${name}'`)
          .join(',')})) {
 $stream=[IO.File]::OpenRead((Join-Path $PSScriptRoot $name));$accepted=$false
 try {try{$null=Read-NodeImage $stream;$accepted=$true}catch{};$held=$stream.CanRead}
 finally {$stream.Dispose()}
 [pscustomobject]@{name=$name;accepted=$accepted;held=$held}
}
$output|ConvertTo-Json -Compress
`,
    ),
  ) as { name: string; accepted: boolean; held: boolean }[];
  for (const item of result) {
    expect(item.accepted, item.name).toBe(item.name === 'valid');
    expect(item.held).toBe(true);
  }
});

it('原Job成功判定拒绝异常退出、采样缺失、放宽限额及所有权未知', () => {
  const changes = [
    '$job.Succeeded=$false',
    '$job.ActualZero=$false',
    '$job.OwnershipRetained=$true',
    '$job.LimitsVerified=$false',
    "$job.ExitFailure='exit-unknown'",
    "$job.Failure='deadline'",
    '$job.ExitCode=92',
    '$job.Samples=0',
    '$job.CreationFlags=0x08080000',
    '$job.ProcessLimit=2',
    '$job.LimitFlags=0x2000',
    '$job.ProcessCommitLimit=4294967296',
    '$job.JobCommitLimit=4294967296',
    '$job.RssPeakBytes=1073741825',
    '$job.TreeRssPeakBytes=1073741825',
  ];
  const result = JSON.parse(
    ps(
      parse +
        `
Invoke-Expression (Load-Function 'Test-NodeJob')
$mutations=@('',${changes.map((change) => `'${change.replaceAll("'", "''")}'`).join(',')})
$results=foreach($change in $mutations) {
 $job=[pscustomobject]@{Succeeded=$true;ActualZero=$true;OwnershipRetained=$false;LimitsVerified=$true;ExitFailure=$null;Failure=$null;ExitCode=0;Samples=1;CreationFlags=524296;ProcessLimit=1;LimitFlags=0x2308;ProcessCommitLimit=2147483648;JobCommitLimit=2147483648;RssPeakBytes=100;TreeRssPeakBytes=100}
 if($change){Invoke-Expression $change}
 $accepted=$false;try{Test-NodeJob $job;$accepted=$true}catch{}
 $accepted
}
$results|ConvertTo-Json -Compress
`,
    ),
  ) as boolean[];
  expect(result).toEqual([true, ...changes.map(() => false)]);
});

it('完成回执形状、工作截止、闭合落盘和排他创建均由实际PS函数判定', () => {
  expect(
    ps(
      parse +
        `
foreach($name in @('Test-TinyReceipt','Check-Time','Write-New','Check-Scope')){Invoke-Expression (Load-Function $name)}
$scope=Join-Path $PSScriptRoot 'scope';[IO.Directory]::CreateDirectory($scope)|Out-Null
$proof=[pscustomobject]@{version=1;nodeVersion='v24.18.0';productE2Pass=$false;stdioCompleted=$true;dataSha256='be45cb2605bf36bebde684841a28f0fd43c69850a3dce5fedba69928ee3a8991'}
Test-TinyReceipt $proof
$failures=0;$proof.stdioCompleted=$false;try{Test-TinyReceipt $proof}catch{$failures++}
$proof.stdioCompleted='True';try{Test-TinyReceipt $proof}catch{$failures++}
$proof.stdioCompleted=$true;$proof.version='1';try{Test-TinyReceipt $proof}catch{$failures++};$proof.version=1
$proof.stdioCompleted=$true;$proof|Add-Member NoteProperty privatePath 'secret';try{Test-TinyReceipt $proof}catch{$failures++}
$clock=[pscustomobject]@{Elapsed=[pscustomobject]@{TotalMilliseconds=12000}};$workMs=12000
try{Check-Time}catch{$failures++}
Write-New 'intent.json' '{}';try{Write-New 'intent.json' 'overwritten'}catch{$failures++}
if([IO.File]::ReadAllText((Join-Path $scope 'intent.json')) -cne '{}'){throw '旧回执被覆盖'}
Check-Scope
Write-New 'unknown.json' '{}';try{Check-Scope}catch{$failures++}
if($failures -ne 7){throw '闭合门缺失'}
'PASS'
`,
    ),
  ).toContain('PASS');
});

it('实际绑定函数持锁、重验hash和身份，拒绝变更并遵守原截止', () => {
  expect(
    ps(
      parse +
        `
foreach($name in @('Check-Time','Check-Parents','Hash-Stream','Hold-File','Test-Bindings')){Invoke-Expression (Load-Function $name)}
Add-Type -TypeDefinition 'namespace AIbrowse.FullTransfer {public static class FixedTransferJob {public static int Identity=1;public static int Calls;public static object InspectFile(System.IO.FileStream stream){Calls++;return Identity;}}}'
$clock=[pscustomobject]@{Elapsed=[pscustomobject]@{TotalMilliseconds=0}};$workMs=12000
$locks=[Collections.Generic.List[IO.FileStream]]::new()
$path=Join-Path $PSScriptRoot 'bound.bin';[IO.File]::WriteAllText($path,'fixed')
$failures=0
try {
 $fact=Hold-File $path 64;$fact.identity=1;Test-Bindings @($fact)
 try{$writer=[IO.File]::OpenWrite($path);$writer.Dispose()}catch{$failures++}
 $hash=$fact.sha256;$fact.sha256='wrong';try{Test-Bindings @($fact)}catch{$failures++};$fact.sha256=$hash
 [AIbrowse.FullTransfer.FixedTransferJob]::Identity=2;try{Test-Bindings @($fact)}catch{$failures++}
 [AIbrowse.FullTransfer.FixedTransferJob]::Identity=1;$clock.Elapsed.TotalMilliseconds=12000
 $calls=[AIbrowse.FullTransfer.FixedTransferJob]::Calls;try{Test-Bindings @($fact)}catch{$failures++}
 if([AIbrowse.FullTransfer.FixedTransferJob]::Calls -ne $calls){throw '过期后仍读取身份'}
} finally {foreach($stream in $locks){$stream.Dispose()}}
if($failures -ne 4){throw '绑定门缺失'}
$exclusive=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$exclusive.Dispose()
'PASS'
`,
    ),
  ).toContain('PASS');
});

const scriptCases = [
  'success',
  'version',
  'argv',
  'cwd',
  'existing-payload',
  'wrong-read',
  'stdout-throw',
  'stdout-error',
  'stderr-error',
  'stdio-event',
  'complete-error',
] as const;
for (const name of scriptCases) {
  it(`原tiny脚本执行于纯IO端口：${name}`, () => {
    const scopeId = 'full-transfer-node-tiny-' + 'a'.repeat(32);
    const directory = resolve(root, scopeId);
    const files = new Map<string, Buffer>();
    if (name === 'existing-payload') files.set('payload.bin', Buffer.from('old'));
    const events = new Map<string, () => void>();
    const timers: (() => void)[] = [];
    const writes: string[] = [];
    const fakeProcess = {
      version: name === 'version' ? 'v26.0.0' : 'v24.18.0',
      argv: ['node.exe', 'tiny.cjs', scopeId, ...(name === 'argv' ? ['extra'] : [])],
      cwd: () => (name === 'cwd' ? root : directory),
      exitCode: 0,
      stdout: {
        on: (_event: string, fn: () => void) => {
          events.set('stdout', fn);
        },
        write: (text: string, callback: (error?: Error) => void) => {
          writes.push(text);
          if (name === 'stdout-throw') throw new Error();
          callback(name === 'stdout-error' ? new Error() : undefined);
        },
      },
      stderr: {
        on: (_event: string, fn: () => void) => {
          events.set('stderr', fn);
        },
        write: (text: string, callback: (error?: Error) => void) => {
          writes.push(text);
          callback(name === 'stderr-error' ? new Error() : undefined);
        },
      },
    };
    const fs = {
      writeFileSync: (
        target: string,
        data: Uint8Array | string,
        options: { flag: string; flush: boolean },
      ) => {
        expect(options).toEqual({ flag: 'wx', flush: true });
        expect(pathModule.dirname(target)).toBe(directory);
        const member = basename(target);
        if (files.has(member) || (name === 'complete-error' && member === 'complete.json'))
          throw new Error();
        files.set(member, Buffer.from(data));
      },
      readFileSync: (target: string) =>
        name === 'wrong-read' ? Buffer.from('bad') : files.get(basename(target)),
    };
    runInNewContext(
      tinySource,
      {
        __dirname: directory,
        Buffer,
        process: fakeProcess,
        require: (module: string) => {
          if (module === 'node:fs') return fs;
          if (module === 'node:crypto') return { createHash };
          if (module === 'node:path') return pathModule;
          throw new Error('脚本加载范围超限');
        },
        setTimeout: (callback: () => void, delay: number) => {
          expect(delay).toBe(1000);
          timers.push(callback);
        },
      },
      { timeout: 1000 },
    );
    if (name === 'stdio-event') events.get('stdout')!();
    expect(timers.length).toBeLessThanOrEqual(1);
    for (const timer of timers) timer();
    const completed = files.has('complete.json');
    expect(completed).toBe(name === 'success');
    expect(fakeProcess.exitCode).toBe(name === 'success' ? 0 : 2);
    expect([...files.values()].reduce((sum, bytes) => sum + bytes.length, 0)).toBeLessThan(4096);
    if (completed) {
      expect(writes).toEqual([
        '{"imported":true,"productE2Pass":false}\n',
        '完整Transfer输入导入失败，现场保留\n',
      ]);
      expect(JSON.parse(files.get('complete.json')!.toString('utf8'))).toEqual({
        version: 1,
        nodeVersion: 'v24.18.0',
        stdioCompleted: true,
        productE2Pass: false,
        dataSha256: 'be45cb2605bf36bebde684841a28f0fd43c69850a3dce5fedba69928ee3a8991',
      });
    }
  });
}

it('固定PS入口没有脚本或运行时参数，实际源码绑定范围可审核', () => {
  const source = readFileSync(scriptPath, 'utf8');
  expect(
    ps(parse + `if($ast.ParamBlock.Parameters.Count -ne 0){throw '入口接受外部参数'};'PASS'`),
  ).toContain('PASS');
  expect(source).toContain(
    "$expectedNodeSha256='9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de'",
  );
});

it('原catch/finally输出闭合首失败phase，清理和回执错误不泄露异常正文', () => {
  const result = JSON.parse(
    ps(
      parse +
        `
$outer=$ast.FindAll({param($n)$n -is [Management.Automation.Language.TryStatementAst] -and $null -ne $n.Finally -and $n.Finally.Extent.Text.Contains('$result=[ordered]')},$true)
if($outer.Count -ne 1){throw '外层收口未唯一绑定'}
$catch=$outer[0].CatchClauses[0].Body.Extent.Text
$finally=$outer[0].Finally.Extent.Text
function Write-New([string]$Name,[string]$Text){if($case -ceq 'write'){throw 'private-phase-path'};$script:writes++}
function Restore-Environment($Prior){throw 'private-phase-path'}
$results=foreach($case in @('runtime','receipt','cleanup','write','scope')) {
 $scopeId='fixed';$ok=$true;$phase='finish';$failurePhase=$null;$scopeCreated=$case -cne 'scope';$saved=$null;$binding=$null;$job=$null;$locks=@();$script:writes=0
 $clock=[pscustomobject]@{Elapsed=[pscustomobject]@{TotalMilliseconds=0}};$workMs=12000
 if($case -in @('runtime','receipt','scope')) {
   $phase=$case
   # Invoke the original catch in the current scope so assignments are retained.
   . ([scriptblock]::Create($catch.Substring(1,$catch.Length-2)))
   $saved=@{test='private-phase-path'}
 }
 if($case -ceq 'cleanup'){$saved=@{test='private-phase-path'}}
 $json=. ([scriptblock]::Create($finally.Substring(1,$finally.Length-2)))
 [pscustomobject]@{case=$case;result=($json -join [Environment]::NewLine|ConvertFrom-Json);writes=$script:writes}
}
$results|ConvertTo-Json -Depth 8 -Compress
`,
    ),
  ) as { case: string; result: { phase: string; ok: boolean }; writes: number }[];
  for (const item of result) {
    expect(item.result.phase).toBe(
      ['runtime', 'receipt', 'scope'].includes(item.case) ? item.case : 'finish',
    );
    expect(item.result.ok).toBe(false);
    if (item.case === 'scope') expect(item.writes).toBe(0);
  }
  expect(JSON.stringify(result)).not.toContain('private-phase-path');
});
