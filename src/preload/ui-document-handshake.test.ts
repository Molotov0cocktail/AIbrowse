import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AibrowseBridge } from '../shared/types/app';
import { IPC } from '../shared/types/ipc';

const readyChannel = 'ui:document-ready';
const electron = vi.hoisted(() => ({
  invoke: vi.fn(),
  exposeInMainWorld: vi.fn(),
  on: vi.fn(),
  send: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: electron,
}));
const listeners = new Map<string, () => void>();
const appInfo = { version: 'synthetic' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function bridge(): Promise<AibrowseBridge> {
  await import('./index');
  return electron.exposeInMainWorld.mock.calls.find(
    (call) => call[0] === 'aibrowse',
  )![1] as AibrowseBridge;
}
const flush = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  listeners.clear();
  vi.stubGlobal('__E2_RUNTIME_QUALIFICATION__', false);
  vi.stubGlobal('window', new EventTarget());
  electron.on.mockImplementation((channel: string, listener: () => void) => {
    listeners.set(channel, listener);
  });
  electron.removeListener.mockImplementation((channel: string) => {
    listeners.delete(channel);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function businessWithHandshake(open: () => Promise<string | null>): void {
  electron.invoke.mockImplementation((channel: string) =>
    channel === IPC.UiDocumentOpen ? open() : Promise.resolve(appInfo),
  );
}
const opens = () =>
  electron.invoke.mock.calls.filter((call) => call[0] === IPC.UiDocumentOpen).length;

it('初次null不永久锁死：可信提交通知后仅重握手，原业务只发送一次', async () => {
  let attempts = 0;
  businessWithHandshake(async () => (++attempts === 1 ? null : 'new-token'));
  const api = await bridge();
  const result = api.getAppInfo().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await flush();
  expect(opens()).toBe(1);
  expect(electron.invoke.mock.calls).toHaveLength(1);
  listeners.get(readyChannel)?.();
  await flush();
  expect(await result).toEqual({ value: appInfo });
  expect(electron.invoke.mock.calls).toEqual([
    [IPC.UiDocumentOpen],
    [IPC.UiDocumentOpen],
    [IPC.AppGetInfo, undefined, 'new-token'],
  ]);
});
it('通知先于初次null回执也能恢复，重复通知与并发调用共享两次握手', async () => {
  const first = deferred<string | null>();
  let attempts = 0;
  businessWithHandshake(() => (++attempts === 1 ? first.promise : Promise.resolve('new-token')));
  const api = await bridge();
  const requests = Array.from({ length: 4 }, () => api.getAppInfo().catch((error) => error));
  listeners.get(readyChannel)?.();
  listeners.get(readyChannel)?.();
  first.resolve(null);
  await flush();
  expect(await Promise.all(requests)).toEqual(Array.from({ length: 4 }, () => appInfo));
  expect(opens()).toBe(2);
});
it('首次已授权即使收到提交通知也不再次申请token', async () => {
  const first = deferred<string | null>();
  businessWithHandshake(() => first.promise);
  const api = await bridge();
  listeners.get(readyChannel)?.();
  first.resolve('first-token');
  expect(await api.getAppInfo()).toEqual(appInfo);
  expect(opens()).toBe(1);
});
it('二次null终止，重复通知不得产生第三次握手或业务调用', async () => {
  businessWithHandshake(async () => null);
  const api = await bridge();
  const result = api.getAppInfo().catch((error) => error);
  await flush();
  listeners.get(readyChannel)?.();
  await flush();
  expect(await result).toBeInstanceOf(Error);
  listeners.get(readyChannel)?.();
  await flush();
  expect(opens()).toBe(2);
  expect(electron.invoke.mock.calls).toHaveLength(2);
});
it('没有可信提交通知最多等待10秒，迟到通知不重新打开握手', async () => {
  businessWithHandshake(async () => null);
  const api = await bridge();
  let settled = false;
  const result = api.getAppInfo().catch((error) => {
    settled = true;
    return error;
  });
  await vi.advanceTimersByTimeAsync(9999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBeInstanceOf(Error);
  listeners.get(readyChannel)?.();
  expect(opens()).toBe(1);
});
it.each([1, 2])('第%d次握手异常受控拒绝，不调用业务', async (failing) => {
  let attempt = 0;
  businessWithHandshake(async () => {
    if (++attempt === failing) throw new Error('private');
    return null;
  });
  const api = await bridge();
  const result = api.getAppInfo().catch((error) => error);
  await flush();
  if (failing === 2) {
    listeners.get(readyChannel)?.();
    await flush();
  }
  expect(((await result) as Error).message).toBe('应用文档尚未授权');
  expect(opens()).toBe(failing);
});
it('pagehide退役等待中的文档，迟到成功不得授权或发送业务', async () => {
  const first = deferred<string | null>();
  businessWithHandshake(() => first.promise);
  const api = await bridge();
  const result = api.getAppInfo().catch((error) => error);
  window.dispatchEvent(new Event('pagehide'));
  first.resolve('stale-token');
  await flush();
  expect(await result).toBeInstanceOf(Error);
  expect(electron.invoke.mock.calls).toHaveLength(1);
});
it('超时回调尚未执行时，截止点后的成功回执也不能授权', async () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(100);
  const first = deferred<string | null>();
  businessWithHandshake(() => first.promise);
  const api = await bridge();
  const result = api.getAppInfo().catch((error) => error);
  await flush();
  now.mockReturnValue(10_100);
  first.resolve('late-token');
  await flush();
  expect(await result).toBeInstanceOf(Error);
  expect(electron.invoke.mock.calls).toHaveLength(1);
});
it('已授权文档pagehide后不能再调用业务，业务失败本身也不会触发重新握手', async () => {
  businessWithHandshake(async () => 'token');
  const api = await bridge();
  await api.getAppInfo();
  electron.invoke.mockRejectedValue(new Error('business-failed'));
  await expect(api.getAppInfo()).rejects.toThrow('business-failed');
  expect(opens()).toBe(1);
  window.dispatchEvent(new Event('pagehide'));
  await expect(api.getAppInfo()).rejects.toThrow('应用文档尚未授权');
  expect(electron.invoke.mock.calls).toHaveLength(3);
});
it('就绪发送与读取共享握手；收到通知本身不能发送业务', async () => {
  const second = deferred<string | null>();
  let attempts = 0;
  businessWithHandshake(() => (++attempts === 1 ? Promise.resolve(null) : second.promise));
  const api = await bridge();
  api.notifyRendererReady();
  await flush();
  listeners.get(readyChannel)?.();
  await flush();
  expect(electron.send).not.toHaveBeenCalled();
  second.resolve('new-token');
  await flush();
  expect(electron.send).toHaveBeenCalledExactlyOnceWith(
    IPC.AppRendererReady,
    undefined,
    'new-token',
  );
  expect(opens()).toBe(2);
});
