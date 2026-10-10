import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

// Execute the current main functions without booting Electron or copying their logic.
const source = ts.createSourceFile(
  'main.ts',
  readFileSync(resolve('src/main/index.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
function body(name: string): string {
  const matches = source.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  expect(matches).toHaveLength(1);
  return matches[0]!.getText(source);
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const finished = deferred(),
    drained = deferred(),
    cleanup = deferred();
  let phase = 'draining';
  const guardian = { finishShutdown: vi.fn(() => finished.promise) };
  const app = { exit: vi.fn() },
    failed = vi.fn();
  const code = ts.transpileModule(
    `let guardianFinished: Promise<void> | null = null;
    ${body('finishGuardianShutdown')}
    ${body('exitAfterRendererAdmissionDrain')}
    return { finishGuardianShutdown, exitAfterRendererAdmissionDrain };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const functions = new Function(
    'lifecycleGuardian',
    'runtimeShutdown',
    'shutdownRuntime',
    'app',
    'reportShutdownFailure',
    'mainFailureShutdown',
    code,
  )(guardian, { getPhase: () => phase }, () => drained.promise, app, failed, {
    isActive: () => false,
  }) as {
    finishGuardianShutdown(): Promise<void>;
    exitAfterRendererAdmissionDrain(code: number, cleanup: () => Promise<void>): void;
  };
  return {
    ...functions,
    guardian,
    app,
    failed,
    finished,
    drained,
    cleanup,
    close: () => {
      phase = 'closed';
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

it('main未closed不得发送finish，closed后的重复请求共享同一个原Promise', async () => {
  const f = fixture();
  await expect(f.finishGuardianShutdown()).rejects.toThrow();
  expect(f.guardian.finishShutdown).not.toHaveBeenCalled();
  f.close();
  const first = f.finishGuardianShutdown();
  expect(f.finishGuardianShutdown()).toBe(first);
  expect(f.guardian.finishShutdown).toHaveBeenCalledOnce();
  f.finished.resolve();
  await first;
});

it.each([false, true])('main退出等待原drain、cleanup和finish；finish失败=%s', async (reject) => {
  const f = fixture();
  const cleanup = vi.fn(() => f.cleanup.promise);
  f.exitAfterRendererAdmissionDrain(7, cleanup);
  await flush();
  expect(cleanup).not.toHaveBeenCalled();
  expect(f.guardian.finishShutdown).not.toHaveBeenCalled();
  f.close();
  f.drained.resolve();
  await flush();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(f.guardian.finishShutdown).not.toHaveBeenCalled();
  f.cleanup.resolve();
  await flush();
  expect(f.guardian.finishShutdown).toHaveBeenCalledOnce();
  expect(f.app.exit).not.toHaveBeenCalled();
  if (reject) f.finished.reject(new Error('finish unconfirmed'));
  else f.finished.resolve();
  await flush();
  if (reject) {
    expect(f.app.exit).not.toHaveBeenCalled();
    expect(f.failed).toHaveBeenCalledOnce();
  } else {
    expect(f.app.exit).toHaveBeenCalledExactlyOnceWith(7);
    expect(f.failed).not.toHaveBeenCalled();
  }
});
