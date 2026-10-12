import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { PageReader } from '../../src/main/browser/page-reader';
import type { BrowserControllerImpl } from '../../src/main/browser/browser-controller';
import type { ConversationServiceImpl } from '../../src/main/ai/conversation-service';

const captured = vi.hoisted(() => ({ records: [] as string[] }));
const electron = vi.hoisted(() => ({
  app: null as unknown as EventEmitter & { getAppPath(): string },
}));
vi.mock('electron', () => ({
  get app() {
    return electron.app;
  },
}));
vi.mock('node:fs', () => ({
  appendFileSync: (_path: string, value: string) => captured.records.push(value),
  writeFileSync: vi.fn(),
}));

let originalExitListeners: Set<(code: number) => void>;
beforeEach(() => {
  vi.resetModules();
  captured.records = [];
  electron.app = Object.assign(new EventEmitter(), { getAppPath: () => 'synthetic-app' });
  originalExitListeners = new Set(process.listeners('exit'));
});
afterEach(() => {
  for (const listener of process.listeners('exit'))
    if (!originalExitListeners.has(listener)) process.removeListener('exit', listener);
});

async function setup() {
  let resolveRaw!: (value: unknown) => void;
  let rejectRaw!: (reason: Error) => void;
  const raw = new Promise<unknown>((resolve, reject) => {
    resolveRaw = resolve;
    rejectRaw = reject;
  });
  const wc = Object.assign(new EventEmitter(), {
    id: 17,
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    executeJavaScriptInIsolatedWorld: vi.fn<
      (world: number, scripts: Array<{ code: string }>) => Promise<unknown>
    >(() => raw),
  });
  const signal = new AbortController();
  const reader = {
    snapshot: () => wc.executeJavaScriptInIsolatedWorld(999, [{ code: 'synthetic' }]),
  } as unknown as PageReader;
  const browser = {
    getOwnedWebContentsId: () => 17,
    getPageSnapshot: () => reader.snapshot(wc as unknown as WebContents, 9, signal.signal),
    closeTab: vi.fn(async () => true),
    dispose: vi.fn(),
  } as unknown as BrowserControllerImpl;
  const service = {
    previewContext: () => browser.getPageSnapshot('synthetic-tab', signal.signal),
    drainBeforeClose: vi.fn(() => new Promise<void>(() => {})),
    getPendingOperationCounts: () => ({ ask: 0, agentAsk: 0, previewContext: 1 }),
  } as unknown as ConversationServiceImpl;
  const { install } = await import('./shutdown-observer');
  install({
    PageReader: { prototype: reader },
    BrowserControllerImpl: { prototype: browser },
    ConversationServiceImpl: { prototype: service },
  });
  electron.app.emit('web-contents-created', {}, wc);
  return { wc, signal, reader, browser, service, raw, resolveRaw, rejectRaw };
}

it('观察器逐层返回原Promise并保留preview到native的父子关联', async () => {
  const fixture = await setup();
  const result = fixture.service.previewContext();
  expect(result).toBe(fixture.raw);
  fixture.resolveRaw({ synthetic: true });
  await result;
  const records = captured.records.map(
    (record) =>
      JSON.parse(record) as {
        event: string;
        detail: { id: number; parent: number | null; kind: string };
      },
  );
  const begin = records.filter((record) => record.event === 'begin').map((record) => record.detail);
  expect(begin.map((receipt) => receipt.kind)).toEqual([
    'preview',
    'controller-snapshot',
    'reader',
    'native',
  ]);
  expect(begin.map((receipt) => receipt.parent)).toEqual([
    null,
    begin[0]!.id,
    begin[1]!.id,
    begin[2]!.id,
  ]);
  expect(records.filter((record) => record.event === 'settled')).toHaveLength(4);
});

it('关闭事件及abort不伪造原nativePromise退休，原拒绝对象保持', async () => {
  const fixture = await setup();
  const result = fixture.service.previewContext();
  let settled = false;
  void result.catch(() => {
    settled = true;
  });
  fixture.wc.emit('destroyed');
  fixture.signal.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(captured.records.some((record) => record.includes('reader-abort'))).toBe(true);
  const error = new Error('合成拒绝对象');
  fixture.rejectRaw(error);
  await expect(result).rejects.toBe(error);
});

it('native诊断不落盘脚本、页面正文或URL输入', async () => {
  const fixture = await setup();
  const native = fixture.wc.executeJavaScriptInIsolatedWorld as unknown as (
    world: number,
    scripts: Array<{ code: string }>,
  ) => Promise<unknown>;
  const promise = native(999, [
    { code: 'secret-page-body https://private.example/?credential=canary' },
  ]);
  fixture.resolveRaw('secret-page-body');
  await promise;
  const evidence = captured.records.join('');
  expect(evidence).not.toMatch(/secret-page-body|private\.example|credential=canary/);
  expect(evidence).toContain('native-dispatch-state');
});

it('生命周期观察不新增WebContents监听，保持默认冒烟零等待监听oracle', async () => {
  const fixture = await setup();
  for (const name of ['did-stop-loading', 'destroyed', 'render-process-gone'])
    expect(fixture.wc.listenerCount(name)).toBe(0);
  const listener = vi.fn();
  fixture.wc.on('did-stop-loading', listener);
  const event = { synthetic: true };
  expect(fixture.wc.emit('did-stop-loading', event)).toBe(true);
  expect(listener).toHaveBeenCalledExactlyOnceWith(event);
  fixture.wc.removeListener('did-stop-loading', listener);
  expect(fixture.wc.emit('did-stop-loading', event)).toBe(false);
  expect(captured.records.filter((record) => record.includes('wc-load-stop'))).toHaveLength(2);
  const receiver = new EventEmitter();
  const received = vi.fn();
  receiver.on('synthetic', function (this: EventEmitter, value: unknown) {
    received(this, value);
  });
  expect(fixture.wc.emit.call(receiver, 'synthetic', event)).toBe(true);
  expect(received).toHaveBeenCalledExactlyOnceWith(receiver, event);
  const failure = new Error('原事件异常');
  receiver.on('synthetic-error', () => {
    throw failure;
  });
  expect(() => fixture.wc.emit.call(receiver, 'synthetic-error')).toThrow(failure);
});
