import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { expect, it, vi } from 'vitest';
import { PageReader } from './page-reader';

vi.mock('../logger', () => ({ logDebug: vi.fn(), logWarn: vi.fn() }));

function fixture(loading = true) {
  const events = new EventEmitter();
  let finish!: (value: unknown) => void;
  const native = new Promise<unknown>((resolve) => (finish = resolve));
  const wc = Object.assign(events, {
    loading,
    destroyed: false,
    crashed: false,
    getURL: () => 'https://example.test/',
    getTitle: () => '合成页面',
    isDestroyed: () => wc.destroyed,
    isCrashed: () => wc.crashed,
    isLoadingMainFrame: () => wc.loading,
    executeJavaScriptInIsolatedWorld: vi.fn(() => native),
  });
  return { wc, finish, contents: wc as unknown as WebContents };
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

it.each(['abort', 'destroy', 'crash'] as const)(
  '加载中%s只结束自有等待，零原生注入且监听归零',
  async (action) => {
    const { wc, contents, finish } = fixture();
    const controller = new AbortController();
    let settled = false;
    const pending = new PageReader().snapshot(contents, 1, controller.signal);
    void pending.then(() => (settled = true));
    try {
      await flush();
      expect(wc.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
      if (action === 'abort') controller.abort();
      if (action === 'destroy') {
        wc.destroyed = true;
        wc.emit('destroyed');
      }
      if (action === 'crash') {
        wc.crashed = true;
        wc.emit('render-process-gone');
      }
      await flush();
      expect(settled).toBe(true);
      expect(await pending).toMatchObject({
        token: null,
        snapshot: { meta: { degraded: 'main-process-only' } },
      });
      expect(wc.eventNames()).toEqual([]);
      expect(wc.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    } finally {
      finish(null);
      await pending;
    }
  },
);

it('只有真实加载完成才注入；撤销过的等待不能被后继加载追认', async () => {
  const { wc, contents, finish } = fixture();
  const reader = new PageReader();
  const cancelled = new AbortController();
  const first = reader.snapshot(contents, 1, cancelled.signal);
  cancelled.abort();
  await first;
  const second = reader.snapshot(contents, 1);
  wc.emit('did-stop-loading');
  await flush();
  expect(wc.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  wc.loading = false;
  wc.emit('did-stop-loading');
  await flush();
  expect(wc.executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce();
  finish(null);
  await second;
  expect(wc.eventNames()).toEqual([]);
});

it('已发出的原生调用不因取消伪装结算，原调用返回后丢弃结果', async () => {
  const { wc, contents, finish } = fixture(false);
  const controller = new AbortController();
  let settled = false;
  const pending = new PageReader().snapshot(contents, 1, controller.signal);
  void pending.then(() => (settled = true));
  await flush();
  expect(wc.executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce();
  controller.abort();
  await flush();
  expect(settled).toBe(false);
  finish(null);
  expect(await pending).toMatchObject({ token: null });
  expect(settled).toBe(true);
});

it('就绪交接期间重新加载时回到自有等待，不进入原生不可取消等待', async () => {
  const { wc, contents } = fixture(false);
  const controller = new AbortController();
  const pending = new PageReader().snapshot(contents, 1, controller.signal);
  wc.loading = true;
  await flush();
  expect(wc.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  controller.abort();
  await pending;
  expect(wc.eventNames()).toEqual([]);
});
