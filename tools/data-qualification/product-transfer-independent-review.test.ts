import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { ControlledProcessProbeError } from '../release/process-identity-probe';

// Execute the actual runner with synthetic process/IO ports, never Electron or PowerShell.
const source = ts.createSourceFile(
  'run.ts',
  readFileSync(resolve('tools/data-qualification/product-transfer/run.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const declaration = source.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'main',
);
if (!declaration) throw new Error('固定runner入口缺失');
const code = ts.transpileModule(`${declaration.getText(source)}\nreturn main;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
class Child extends EventEmitter {
  pid = 42;
  stderr = new EventEmitter();
  kill = vi.fn(() => false);
}
const flush = async () => {
  for (let i = 0; i < 600; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

function fixture(mode: 'normal' | 'helper' | 'identity' | 'exit' | 'diagnostic') {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const runnerProcess = {
    platform: 'win32',
    argv: ['node', 'runner', 'package', join('journal', 'runner-output'), 'app-data', 'journal'],
    pid: 41,
    env: {},
    exitCode: 0,
  };
  const product = new Child(),
    helper = new Child();
  let saved = false;
  let failDiagnostic!: (error: Error) => void;
  const diagnostic = new Promise<never>((_, reject) => {
    failDiagnostic = reject;
  });
  void diagnostic.catch(() => undefined);
  const receipts: Record<string, unknown> = {};
  const spawn = vi.fn((file: string, args: string[]) => {
    if (file.endsWith('AIbrowse.exe')) return product;
    if (mode === 'helper') return helper;
    const child = new Child();
    const actionIndex = args.indexOf('-Action');
    const action = actionIndex < 0 ? undefined : args[actionIndex + 1];
    const output = args[args.indexOf('-Output') + 1]!;
    receipts[output] = action ? { ok: true, action } : { hardTotalLimit: 24 };
    if (action === 'SaveBackup') saved = true;
    void Promise.resolve().then(() => {
      child.emit('exit', 0);
      if (action === 'Close' && (mode === 'normal' || mode === 'diagnostic'))
        product.emit('exit', 0);
    });
    return child;
  });
  const identity = vi.fn(() =>
    mode === 'identity'
      ? new Promise<never>(() => undefined)
      : Promise.resolve({ pid: 42, processCreatedFileTime: '1', imagePath: 'AIbrowse.exe' }),
  );
  const writeFile = vi.fn(async (path: string, raw: string) => {
    if (mode === 'diagnostic' && path.endsWith('-stderr.json')) return diagnostic;
    receipts[path] = JSON.parse(raw) as unknown;
  });
  const main = new Function(
    'spawn',
    'createHash',
    'mkdir',
    'readFile',
    'readdir',
    'writeFile',
    'join',
    'resolve',
    'verifyPackagedDirectory',
    'verifyProfileIsolationJournal',
    'probeControlledProcessIdentity',
    'ControlledProcessProbeError',
    'inspectProductBackup',
    'performance',
    'process',
    code,
  )(
    spawn,
    createHash,
    async () => undefined,
    async (path: string) => Buffer.from(JSON.stringify(receipts[path] ?? 'synthetic source')),
    async (path: string) =>
      path.endsWith('aibrowse')
        ? ['.aibrowse-e1-synthetic-owner.json']
        : saved
          ? ['product-backup.aibak']
          : [],
    writeFile,
    join,
    resolve,
    async () => {
      // Spend the original allowance before the short UI/readback phase deadlines begin.
      if (mode === 'exit') await new Promise((done) => setTimeout(done, 479999));
      return {};
    },
    () => ({ version: 2, runId: 'a'.repeat(32) }),
    identity,
    ControlledProcessProbeError,
    async () => ({ bytes: 1 }),
    performance,
    runnerProcess,
  ) as () => Promise<void>;
  let settled = false;
  const original = main().finally(() => {
    settled = true;
  });
  return {
    original,
    spawn,
    helper,
    identity,
    product,
    receipts,
    runnerProcess,
    failDiagnostic,
    settled: () => settled,
  };
}

it('合成正常链可完整结束，控制组不把工具自身夹具失败当作预算红态', async () => {
  const f = fixture('normal');
  await f.original;
  expect(f.runnerProcess.exitCode).toBe(0);
  expect(f.receipts[resolve('journal/runner-output/product-transfer/report.json')]).toMatchObject({
    ok: true,
    productExited: true,
    productExitCode: 0,
  });
});

it('仍持有工作撤销timer的诊断原IO未结束时不能先宣布成功，失败不得吞掉', async () => {
  const f = fixture('diagnostic');
  try {
    await flush();
    expect(f.settled()).toBe(false);
    expect(f.receipts[resolve('journal/runner-output/product-transfer/report.json')]).not.toEqual(
      expect.objectContaining({ ok: true }),
    );
  } finally {
    f.failDiagnostic(new Error('synthetic diagnostic write failed'));
    await f.original;
  }
  expect(f.runnerProcess.exitCode).toBe(1);
});

it('helper kill未证明exit时，runner原480秒期限仍须结束工作且报告未知退出', async () => {
  const f = fixture('helper');
  await flush();
  expect(f.spawn).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(480000);
  expect(f.helper.kill).toHaveBeenCalled();
  expect(f.settled()).toBe(true);
  expect(f.runnerProcess.exitCode).toBe(1);
});

it('产品身份探测原Promise不结算也不能越过runner原480秒工作期限', async () => {
  const f = fixture('identity');
  await flush();
  expect(f.identity).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(480000);
  expect(f.settled()).toBe(true);
  expect(f.runnerProcess.exitCode).toBe(1);
});

it('产品退出等待必须继承剩余工作期限，不能在第480秒另租30秒', async () => {
  const f = fixture('exit');
  await flush();
  await vi.advanceTimersByTimeAsync(479999);
  await flush();
  expect(performance.now()).toBe(479999);
  expect(f.spawn.mock.calls.some(([, args]) => args.includes('Close'))).toBe(true);
  expect(f.settled()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.settled()).toBe(true);
  expect(f.runnerProcess.exitCode).toBe(1);
  expect(f.receipts[resolve('journal/runner-output/product-transfer/report.json')]).toMatchObject({
    ok: false,
    productExited: false,
  });
});

it('预算回执的实际PowerShell写法必须可执行且不覆盖已有原件', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'product-job-receipt-review-')), 'sample.json');
  // Extract only the real receipt function through PowerShell's parser. No native Job or UI loads.
  const command = `$ErrorActionPreference='Stop';
    $text=[IO.File]::ReadAllText($env:AIBROWSE_REVIEW_SCRIPT);
    $tokens=$null; $parseErrors=$null;
    $tree=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$parseErrors);
    if($parseErrors.Count -ne 0){throw '回执脚本解析失败'};
    $nodes=@($tree.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Write-ExclusiveReceipt'},$true));
    if($nodes.Count -ne 1){throw '实际回执函数不是唯一固定入口'};
    . ([scriptblock]::Create($nodes[0].Extent.Text));
    Write-ExclusiveReceipt $env:AIBROWSE_REVIEW_OUTPUT @{version=1;hardTotalLimit=24;total=1}`;
  const invoke = () =>
    spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: {
        ...process.env,
        AIBROWSE_REVIEW_OUTPUT: path,
        AIBROWSE_REVIEW_SCRIPT: resolve('tools/data-qualification/product-transfer/job-budget.ps1'),
      },
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
  const first = invoke();
  expect(first.stderr).toBe('');
  expect(first.status).toBe(0);
  const receipt = readFileSync(path);
  expect(JSON.parse(receipt.toString('utf8'))).toMatchObject({ hardTotalLimit: 24, total: 1 });
  expect(invoke().status).not.toBe(0);
  expect(readFileSync(path)).toEqual(receipt);
});
