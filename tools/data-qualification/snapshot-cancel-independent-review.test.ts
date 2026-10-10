import { EventEmitter, getEventListeners } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { WebContents } from 'electron';
import { afterAll, expect, it, vi } from 'vitest';
import { PageReader } from '../../src/main/browser/page-reader';
import { ConversationServiceImpl } from '../../src/main/ai/conversation-service';
import { ConversationStore } from '../../src/main/ai/conversation-store';
import { ConfigStore } from '../../src/main/ai/config-store';
import type { SecureCredentialStore } from '../../src/main/ai/credential-store';
import { MaintenanceCoordinator } from '../../src/main/storage/maintenance-coordinator';
import { RuntimeShutdown } from '../../src/main/storage/runtime-shutdown';
import type { TabInfo } from '../../src/shared/types/browser';

vi.mock('../../src/main/logger', () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let n = 0; n < 20; n++) await Promise.resolve();
}
function fixture(loading = true) {
  const raw = deferred<unknown>();
  const wc = Object.assign(new EventEmitter(), {
    loading,
    destroyed: false,
    url: 'https://example.test/',
    getURL: () => wc.url,
    getTitle: () => '独审合成页面',
    isDestroyed: () => wc.destroyed,
    isCrashed: () => false,
    isLoadingMainFrame: () => wc.loading,
    executeJavaScriptInIsolatedWorld: vi.fn(() => raw.promise),
  });
  return { wc, raw, contents: wc as unknown as WebContents };
}

it.each(['abort', 'destroy'] as const)(
  '就绪Promise已返回但交接前%s，零迟到注入',
  async (action) => {
    const { wc, contents } = fixture(false);
    const controller = new AbortController();
    const pending = new PageReader().snapshot(contents, 7, controller.signal);
    if (action === 'abort') controller.abort();
    else {
      wc.destroyed = true;
      wc.emit('destroyed');
    }
    const result = await pending;
    expect(result.token).toBeNull();
    expect(wc.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect(wc.eventNames()).toEqual([]);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  },
);

it('无URL的stop通知不授予就绪；撤销移除EventTarget与WebContents监听', async () => {
  const { wc, contents } = fixture(false);
  wc.url = '';
  const controller = new AbortController();
  const pending = new PageReader().snapshot(contents, 7, controller.signal);
  wc.emit('did-stop-loading');
  await flush();
  expect(wc.listenerCount('did-stop-loading')).toBe(1);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
  expect(wc.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  controller.abort();
  await pending;
  expect(wc.eventNames()).toEqual([]);
  expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  wc.url = 'https://example.test/';
  wc.emit('did-stop-loading');
  await flush();
  expect(wc.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
});

it('stop至续体之间再次开始加载会重新挂等待且取消全量移除监听', async () => {
  const { wc, contents } = fixture();
  const controller = new AbortController();
  const pending = new PageReader().snapshot(contents, 7, controller.signal);
  wc.loading = false;
  wc.emit('did-stop-loading');
  wc.loading = true;
  await flush();
  expect(wc.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  expect(wc.listenerCount('did-stop-loading')).toBe(1);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
  controller.abort();
  await pending;
  expect(wc.eventNames()).toEqual([]);
  expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
});

it('一个读者撤销不会释放另一读者的readiness，完成后监听全部归零', async () => {
  const { wc, contents, raw } = fixture();
  const first = new AbortController(),
    second = new AbortController();
  const reader = new PageReader();
  const a = reader.snapshot(contents, 7, first.signal);
  const b = reader.snapshot(contents, 7, second.signal);
  first.abort();
  await a;
  expect(wc.listenerCount('did-stop-loading')).toBe(1);
  expect(getEventListeners(first.signal, 'abort')).toEqual([]);
  expect(second.signal.aborted).toBe(false);
  wc.loading = false;
  wc.emit('did-stop-loading');
  await flush();
  expect(wc.executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce();
  expect(getEventListeners(second.signal, 'abort')).toEqual([]);
  raw.resolve(null);
  await b;
  expect(wc.eventNames()).toEqual([]);
});

it('已dispatch的原Promise拒绝前取消不能完成采集，拒绝后只返回无绑定降级', async () => {
  const { wc, contents, raw } = fixture(false);
  const controller = new AbortController();
  let settled = false;
  const pending = new PageReader().snapshot(contents, 7, controller.signal);
  void pending.then(() => {
    settled = true;
  });
  await flush();
  expect(wc.executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce();
  controller.abort();
  await flush();
  expect(settled).toBe(false);
  raw.reject(new Error('独审受控原调用拒绝'));
  expect(await pending).toMatchObject({
    token: null,
    snapshot: { meta: { degraded: 'main-process-only' } },
  });
  expect(settled).toBe(true);
});

const ownedRoot = mkdtempSync(join(tmpdir(), 'snapshot-cancel-review-'));
afterAll(() => {
  if (
    dirname(resolve(ownedRoot)) !== resolve(tmpdir()) ||
    !basename(ownedRoot).startsWith('snapshot-cancel-review-')
  )
    throw new Error('独审临时目录边界不符');
  rmSync(ownedRoot, { recursive: true, force: true });
});
const credentials: SecureCredentialStore = {
  isAvailable: () => true,
  has: async () => false,
  get: async () => null,
  set: async () => false,
  delete: async () => false,
};

it.each(['maintenance', 'shutdown'] as const)(
  '%s真实Conversation→PageReader取消只发生在全部参与者封口之后',
  async (boundary) => {
    const { wc, contents } = fixture();
    const entered = deferred<void>();
    let allSealed = false,
      observedAllSealed = false;
    const root = join(ownedRoot, boundary);
    const service = new ConversationServiceImpl({
      store: new ConversationStore(root),
      configStore: new ConfigStore(root, credentials),
      credentials,
      browser: {
        getActiveTab: async () =>
          ({ id: 'synthetic', url: wc.url, title: '', active: true, state: 'loading' }) as TabInfo,
        getPageSnapshot: async (_id, signal) => {
          signal?.addEventListener(
            'abort',
            () => {
              observedAllSealed = allSealed;
            },
            { once: true },
          );
          const pending = new PageReader().snapshot(contents, 7, signal);
          entered.resolve();
          return (await pending).snapshot;
        },
      },
    });
    const preview = service.previewContext();
    const rejected = expect(preview).rejects.toThrow('预览暂不可用');
    await entered.promise;
    if (boundary === 'shutdown') {
      await new RuntimeShutdown({
        roots: [],
        producers: [
          service,
          {
            beginShutdown: () => {
              allSealed = true;
            },
            drainBeforeClose: async () => {},
          },
        ],
        waitForUsage: async () => {},
        cleanupWorkspace: async () => ({ ok: true, retainedCount: 0 }),
        closeResources: () => {},
      }).shutdown();
    } else {
      const coordinator = new MaintenanceCoordinator(
        [
          service,
          {
            pauseForMaintenance: () => {
              allSealed = true;
              return true;
            },
            drainForMaintenance: async () => {},
            prepareResumeAfterMaintenance: () => true,
            resumeAfterMaintenance: () => true,
          },
        ],
        async () => {},
      );
      expect(await coordinator.acquire(performance.now() + 1000)).toMatchObject({ ok: true });
    }
    await rejected;
    expect(observedAllSealed).toBe(true);
    expect(wc.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect(wc.eventNames()).toEqual([]);
    expect(service.getPendingOperationCounts()).toEqual({ ask: 0, agentAsk: 0, previewContext: 0 });
    await service.shutdown();
  },
);
