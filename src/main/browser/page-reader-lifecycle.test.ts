import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { expect, it, vi } from 'vitest';
import { PageReader } from './page-reader';

vi.mock('../logger', () => ({ logDebug: vi.fn(), logWarn: vi.fn() }));

function fixture(loading = true) {
  const events = new EventEmitter();
  let finish!: (value: unknown) => void;
  let fail!: (reason: unknown) => void;
  const native = new Promise<unknown>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
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
    close: vi.fn(() => {
      wc.destroyed = true;
      wc.emit('destroyed');
    }),
  });
  return { wc, finish, fail, native, contents: wc as unknown as WebContents };
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

it('未封闭准入不能获得退出停止权限', async () => {
  const reader = new PageReader();
  await expect(reader.stopSnapshotsForShutdown()).rejects.toThrow('退出');
});

it.each([false, true])(
  '批准退休精确快照实体，原 transport 保持 pending（预先销毁：%s）',
  async (destroyed) => {
    const { wc, contents, native } = fixture(false);
    const reader = new PageReader();
    let nativeSettled = false;
    let requestSettled = false;
    void native.then(() => (nativeSettled = true));
    const operation = reader.snapshot(contents, 1);
    void operation.then(() => (requestSettled = true));
    await flush();
    if (destroyed) {
      wc.destroyed = true;
      wc.emit('destroyed');
    }
    reader.beginSnapshotShutdown();
    await flush();
    expect(requestSettled).toBe(false);
    const stop = reader.stopSnapshotsForShutdown();
    expect(reader.stopSnapshotsForShutdown()).toBe(stop);
    await stop;
    expect(await operation).toEqual({ status: 'cancelled', snapshot: null, token: null });
    expect(nativeSettled).toBe(false);
    expect(wc.close).toHaveBeenCalledTimes(destroyed ? 0 : 1);
    expect(wc.eventNames()).toEqual([]);
  },
);

it('批准后等待 destroyed 事实，调用 close 返回不冒充实体退休', async () => {
  const { wc, contents } = fixture(false);
  const reader = new PageReader();
  wc.close.mockImplementation(() => undefined);
  const operation = reader.snapshot(contents, 1);
  let settled = false;
  void operation.then(() => (settled = true));
  await flush();
  reader.beginSnapshotShutdown();
  const stop = reader.stopSnapshotsForShutdown();
  await flush();
  expect(wc.close).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  wc.destroyed = true;
  wc.emit('destroyed');
  await stop;
  expect(await operation).toMatchObject({ status: 'cancelled' });
});

it.each(['resolve', 'reject'] as const)(
  '已取消快照的迟到%s不读取结果或重新接受绑定',
  async (kind) => {
    const { wc, contents, finish, fail } = fixture(false);
    const reader = new PageReader();
    const operation = reader.snapshot(contents, 1);
    await flush();
    reader.beginSnapshotShutdown();
    await reader.stopSnapshotsForShutdown();
    const result = await operation;
    const read = vi.fn(() => {
      throw new Error('不得读取迟到内容');
    });
    if (kind === 'resolve') finish(Object.defineProperty({}, 'token', { get: read }));
    else fail(new Error('合成迟到拒绝'));
    await flush();
    reader.acceptSnapshot(contents, result);
    expect(read).not.toHaveBeenCalled();
    expect(wc.close).toHaveBeenCalledOnce();
    expect(await reader.click(contents, 'el-1', 'toggle', 1)).toMatchObject({ ok: false });
  },
);

it('同实体已有交互必须先真实结算，批准不能提前销毁或退休交互', async () => {
  const { wc, contents, finish } = fixture(false);
  const reader = new PageReader();
  let finishInteraction!: (value: unknown) => void;
  const interactionNative = new Promise<unknown>((resolve) => (finishInteraction = resolve));
  wc.executeJavaScriptInIsolatedWorld.mockReturnValueOnce(interactionNative);
  const interaction = reader.scroll(contents, 1);
  const snapshot = reader.snapshot(contents, 1);
  await flush();
  reader.beginSnapshotShutdown();
  const stop = reader.stopSnapshotsForShutdown();
  await flush();
  expect(wc.close).not.toHaveBeenCalled();
  expect(await reader.scroll(contents, 1)).toMatchObject({ ok: false });
  expect(wc.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
  finishInteraction({ ok: true, viewport: { scrollX: 0, scrollY: 1, width: 10, height: 10 } });
  expect(await interaction).toMatchObject({ ok: true });
  await stop;
  expect(await snapshot).toMatchObject({ status: 'cancelled' });
  expect(wc.close).toHaveBeenCalledOnce();
  finish(null);
});

it('等待交互时原快照自然结算，停止不再销毁实体', async () => {
  const { wc, contents, finish } = fixture(false);
  const reader = new PageReader();
  let finishInteraction!: (value: unknown) => void;
  wc.executeJavaScriptInIsolatedWorld.mockReturnValueOnce(
    new Promise((resolve) => (finishInteraction = resolve)),
  );
  const interaction = reader.scroll(contents, 1);
  const snapshot = reader.snapshot(contents, 1);
  await flush();
  reader.beginSnapshotShutdown();
  const stop = reader.stopSnapshotsForShutdown();
  finish(null);
  expect(await snapshot).toMatchObject({ status: 'cancelled' });
  finishInteraction({ ok: false });
  await interaction;
  await stop;
  expect(wc.close).not.toHaveBeenCalled();
});

it('批准只取消自有就绪等待，不派发新脚本或关闭正在加载的实体', async () => {
  const { wc, contents } = fixture();
  const reader = new PageReader();
  const operation = reader.snapshot(contents, 1);
  await flush();
  reader.beginSnapshotShutdown();
  await reader.stopSnapshotsForShutdown();
  expect(await operation).toMatchObject({ status: 'cancelled' });
  expect(await reader.snapshot(contents, 1)).toMatchObject({ status: 'cancelled' });
  expect(wc.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  expect(wc.close).not.toHaveBeenCalled();
  expect(wc.eventNames()).toEqual([]);
});

it('close 失败保留未结算请求，不用调用意图冒充退休事实', async () => {
  const { wc, contents, finish } = fixture(false);
  const reader = new PageReader();
  wc.close.mockImplementation(() => {
    throw new Error('合成关闭失败');
  });
  const operation = reader.snapshot(contents, 1);
  let settled = false;
  void operation.then(() => (settled = true));
  await flush();
  reader.beginSnapshotShutdown();
  await expect(reader.stopSnapshotsForShutdown()).rejects.toThrow('合成关闭失败');
  expect(settled).toBe(false);
  expect(wc.destroyed).toBe(false);
  expect(wc.eventNames()).toEqual([]);
  finish(null);
  expect(await operation).toMatchObject({ status: 'cancelled' });
});

it('一页的交互等待不阻止其它快照实体退休，同页多快照只关闭一次', async () => {
  const first = fixture(false);
  const second = fixture(false);
  const reader = new PageReader();
  let finishInteraction!: (value: unknown) => void;
  first.wc.executeJavaScriptInIsolatedWorld.mockReturnValueOnce(
    new Promise((resolve) => (finishInteraction = resolve)),
  );
  const interaction = reader.scroll(first.contents, 1);
  const held = reader.snapshot(first.contents, 1);
  const ready = [reader.snapshot(second.contents, 1), reader.snapshot(second.contents, 1)];
  await flush();
  reader.beginSnapshotShutdown();
  const stop = reader.stopSnapshotsForShutdown();
  await flush();
  expect(first.wc.close).not.toHaveBeenCalled();
  expect(second.wc.close).toHaveBeenCalledOnce();
  expect(await Promise.all(ready)).toEqual([
    { status: 'cancelled', snapshot: null, token: null },
    { status: 'cancelled', snapshot: null, token: null },
  ]);
  finishInteraction({ ok: false });
  await interaction;
  await stop;
  expect(await held).toMatchObject({ status: 'cancelled' });
  expect(first.wc.close).toHaveBeenCalledOnce();
});
