import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { MainFailureShutdown } from '../../src/main/security/main-failure-shutdown';

// Execute the current production before-quit callback, without booting Electron.
const source = ts.createSourceFile(
  'main.ts',
  readFileSync(resolve('src/main/index.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
function beforeQuit(): string {
  const callbacks: ts.Node[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'app.on' &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === 'before-quit'
    )
      callbacks.push(node.arguments[1]!);
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(callbacks).toHaveLength(1);
  return callbacks[0]!.getText(source);
}

function notification(): string {
  const callbacks: ts.Node[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === 'mainFailureShutdown' &&
      node.initializer &&
      ts.isNewExpression(node.initializer)
    ) {
      const ports = node.initializer.arguments?.[0];
      if (ports && ts.isObjectLiteralExpression(ports)) {
        for (const property of ports.properties) {
          if (ts.isPropertyAssignment(property) && property.name.getText(source) === 'notify')
            callbacks.push(property.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(callbacks).toHaveLength(1);
  return callbacks[0]!.getText(source);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(['drain', 'cleanup'] as const)(
  '正常退出挂起于%s时发生main故障，旧退出链不得抢先启动guardian宽限',
  async (stage) => {
    vi.useFakeTimers();
    let releaseDrain!: () => void;
    let releaseCleanup!: () => void;
    const drain = new Promise<void>((resolve) => (releaseDrain = resolve));
    const cleanup = new Promise<void>((resolve) => (releaseCleanup = resolve));
    const finish = vi.fn(async () => undefined);
    const exit = vi.fn();
    let signal: AbortSignal | undefined;
    const shutdown = new MainFailureShutdown({
      stopAdmission: vi.fn(),
      notify: (_reason, current) => {
        signal = current;
        return new Promise<void>(() => {});
      },
      drain: () => drain,
      finishGuardian: finish,
      exit,
    });
    const app = { quit: vi.fn() };
    const code = ts.transpileModule(
      `let shutdownQuitReady = false;
       let shutdownQuitScheduled = false;
       return ${beforeQuit()};`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const handler = new Function(
      'mainFailureShutdown',
      'shutdownRuntime',
      'cleanupSmokeDirectories',
      'finishGuardianShutdown',
      'app',
      'logInfo',
      'reportShutdownFailure',
      code,
    )(
      shutdown,
      () => drain,
      () => cleanup,
      finish,
      app,
      vi.fn(),
      vi.fn(),
    ) as (event: { preventDefault(): void }) => void;
    handler({ preventDefault: vi.fn() });
    if (stage === 'cleanup') {
      releaseDrain();
      await vi.advanceTimersByTimeAsync(0);
    }
    shutdown.begin();
    releaseDrain();
    releaseCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(false);
    expect(finish).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(signal?.aborted).toBe(true);
    expect(finish).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  },
);

it('正常退出已发guardian finish后发生main故障，不能再开启等待用户的通知', async () => {
  const shown = vi.fn(async () => undefined);
  const code = ts.transpileModule(`return ${notification()};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const notify = new Function('guardianFinished', 'app', 'dialog', 'logError', code)(
    new Promise<void>(() => {}),
    { isReady: () => true },
    { showMessageBox: shown },
    vi.fn(),
  ) as (reason: 'main-error', signal: AbortSignal) => Promise<void>;
  await notify('main-error', new AbortController().signal);
  expect(shown).not.toHaveBeenCalled();
});

it.each([false, true])('已有finish ack永久挂起仍保留实际drain门，drain挂起=%s', async (hung) => {
  vi.useFakeTimers();
  let release!: () => void;
  const drain = new Promise<void>((resolve) => (release = resolve));
  const notify = vi.fn(() => new Promise<void>(() => {}));
  const finish = vi.fn(() => new Promise<void>(() => {}));
  const exit = vi.fn();
  const shutdown = new MainFailureShutdown({
    stopAdmission: vi.fn(),
    notify,
    drain: () => drain,
    hasGuardianFinishStarted: () => true,
    finishGuardian: finish,
    exit,
  });
  shutdown.begin();
  await vi.advanceTimersByTimeAsync(500);
  expect(exit).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  expect(finish).not.toHaveBeenCalled();
  if (hung) {
    await vi.advanceTimersByTimeAsync(9_499);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
  } else {
    release();
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(finish).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('共享真实finish入口在故障接管后拒绝normal，仅故障所有者可发唯一退休命令', async () => {
  const matches = source.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'finishGuardianShutdown',
  );
  expect(matches).toHaveLength(1);
  const finish = vi.fn(() => new Promise<void>(() => {}));
  const code = ts.transpileModule(
    `let guardianFinished = null;
     ${matches[0]!.getText(source)}
     return finishGuardianShutdown;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const request = new Function('mainFailureShutdown', 'lifecycleGuardian', 'runtimeShutdown', code)(
    { isActive: () => true },
    { finishShutdown: finish },
    { getPhase: () => 'closed' },
  ) as (owner?: 'normal' | 'failure') => Promise<void>;
  await expect(request()).rejects.toThrow('异常退出');
  expect(finish).not.toHaveBeenCalled();
  const first = request('failure');
  expect(request('failure')).toBe(first);
  expect(finish).toHaveBeenCalledOnce();
});
