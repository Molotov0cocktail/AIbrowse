import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { isCurrentUiFrame } from '../../src/main/security/current-ui-frame';
import { UiDocumentGuard } from '../../src/main/security/ui-document-guard';
import { UiRendererRecovery } from '../../src/main/security/ui-renderer-recovery';
import { validateCoreIpcPayload } from '../../src/main/security/core-ipc-payload';
import { IPC } from '../../src/shared/types/ipc';

const source = ts.createSourceFile(
  'index.ts',
  readFileSync('src/main/index.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
function find(predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (predicate(node)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error('missing main integration node');
  return found;
}
function integration() {
  const trusted = find((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'isTrustedSender');
  const openCall = find(
    (n) =>
      ts.isCallExpression(n) &&
      n.expression.getText(source) === 'ipcMain.handle' &&
      n.arguments[0]?.getText(source) === 'IPC.UiDocumentOpen',
  ) as ts.CallExpression;
  const ready = find(
    (n) => ts.isVariableDeclaration(n) && n.name.getText(source) === 'rendererReady',
  ) as ts.VariableDeclaration;
  if (
    !ready.initializer ||
    !ts.isArrowFunction(ready.initializer) ||
    !ts.isBlock(ready.initializer.body)
  )
    throw new Error('ready callback changed');
  const readyStatements = ready.initializer.body.statements;
  const last = readyStatements.findIndex((s) =>
    s.getText(source).includes('uiRecoveries.get(mainWindow)?.rendererReady()'),
  );
  if (last < 0) throw new Error('ready owner dispatch missing');
  // Execute the actual admission and owner dispatch prefix, excluding smoke suites.
  const script = `${trusted.getText(source)}
    const open = ${openCall.arguments[1]!.getText(source)};
    const ready = (event, payload, token) => { ${readyStatements
      .slice(0, last + 1)
      .map((s) => s.getText(source))
      .join('\n')} };
    ({open,ready,isTrustedSender});`;
  const entry = 'aibrowse://app/index.html';
  const frame = {
    processId: 8,
    routingId: 4,
    detached: true,
    url: entry,
    isDestroyed: () => false,
  };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const win = { webContents: contents, isDestroyed: () => false };
  const guard = new UiDocumentGuard(entry);
  const identity = () => ({ owner: contents, frame, url: frame.url });
  guard.commit(identity());
  const token = guard.token(identity())!;
  const readyCall = vi.fn();
  const functions = vm.runInNewContext(
    ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    {
      isCurrentUiFrame,
      validateCoreIpcPayload,
      IPC,
      mainWindow: win,
      mainFailureShutdown: { isActive: () => false },
      uiDocuments: new WeakMap([[win, guard]]),
      uiRecoveries: new WeakMap([[win, { rendererReady: readyCall }]]),
      watchShutdownStarted: false,
      sourceIpcAdmissionOpen: true,
      logWarn: vi.fn(),
      logInfo: vi.fn(),
    },
  ) as {
    open(event: unknown): string | null;
    ready(event: unknown, payload: unknown, token: string): void;
    isTrustedSender(event: unknown, window: unknown, token: string): boolean;
  };
  const event = { sender: contents, senderFrame: frame, processId: 8, frameId: 4 };
  return { ...functions, event, frame, contents, win, guard, identity, token, readyCall };
}
afterEach(() => vi.useRealTimers());

it('当前index在detached粘滞时允许精确当前RFH，旧原生ID或子frame不能握手或Ready', () => {
  const x = integration();
  expect(x.open(x.event)).toBe(x.token);
  x.ready(x.event, undefined, x.token);
  expect(x.readyCall).toHaveBeenCalledOnce();
  x.readyCall.mockClear();
  for (const event of [
    { ...x.event, processId: 7 },
    { ...x.event, frameId: 3 },
    { ...x.event, senderFrame: { ...x.frame } },
    { ...x.event, sender: {} },
    { ...x.event, processId: Number.POSITIVE_INFINITY },
  ]) {
    expect(x.open(event)).toBeNull();
    expect(x.isTrustedSender(event, x.win, x.token)).toBe(false);
    x.ready(event, undefined, x.token);
  }
  expect(x.readyCall).not.toHaveBeenCalled();
});

it('精确当前原生ID不能绕过入口或token世代，旧Ready不能调用恢复owner', () => {
  const x = integration();
  x.guard.invalidate();
  x.guard.commit(x.identity());
  const fresh = x.guard.token(x.identity())!;
  x.ready(x.event, undefined, x.token);
  x.ready(x.event, { injected: true }, fresh);
  expect(x.readyCall).not.toHaveBeenCalled();
  x.frame.url += '?foreign';
  expect(x.open(x.event)).toBeNull();
  x.ready(x.event, undefined, fresh);
  expect(x.readyCall).not.toHaveBeenCalled();
});

it('重复Ready不能延長同epoch十秒期限，load在截止后到达仍失败一次', async () => {
  vi.useFakeTimers();
  let now = 100;
  let complete!: () => void;
  const choose = vi.fn(async (): Promise<'exit'> => 'exit');
  const exit = vi.fn();
  const recovery = new UiRendererRecovery({
    invalidate: vi.fn(),
    load: () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    choose,
    exit,
    isAlive: () => true,
    now: () => now,
  });
  recovery.crashed();
  await vi.advanceTimersByTimeAsync(0);
  for (let step = 0; step < 8; step++) {
    now += 1_000;
    recovery.rendererReady();
  }
  now = 10_100;
  complete();
  await vi.advanceTimersByTimeAsync(0);
  recovery.rendererReady();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(choose).toHaveBeenCalledExactlyOnceWith(true);
  expect(exit).toHaveBeenCalledOnce();
});
