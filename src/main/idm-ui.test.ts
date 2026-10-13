import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ send: vi.fn(), dispose: vi.fn(), getStatus: vi.fn() }));
vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  return { app: new Emitter() };
});
vi.mock('./downloads/idm-service', () => ({
  IdmDownloadService: class {
    send = calls.send;
    dispose = calls.dispose;
    getStatus = calls.getStatus;
  },
}));

import { createIdmFeature } from './idm-ui';
const windows: EventEmitter[] = [];
afterEach(() => {
  for (const win of windows.splice(0)) win.emit('closed');
  vi.clearAllMocks();
});

function fixture() {
  const win = new EventEmitter();
  windows.push(win);
  return { win, feature: createIdmFeature(win as BrowserWindow) };
}

it('仅使用手动服务检测安装和交接地址，不依赖原生helper或Session', async () => {
  const { feature } = fixture();
  const current = () => true;
  calls.getStatus.mockResolvedValueOnce({ available: true });
  await expect(feature.getStatus()).resolves.toEqual({ available: true });
  feature.send('https://example.com/file.zip', current);
  expect(calls.send).toHaveBeenCalledExactlyOnceWith('https://example.com/file.zip', current);
});

it('关闭窗口后移除退出监听，服务释放一次', () => {
  const previous = app.listenerCount('will-quit');
  const { win } = fixture();
  expect(app.listenerCount('will-quit')).toBe(previous + 1);
  win.emit('closed');
  win.emit('closed');
  expect(calls.dispose).toHaveBeenCalledOnce();
  expect(app.listenerCount('will-quit')).toBe(previous);
});

it('退出应用后移除窗口监听，后续关闭不重复释放', () => {
  const { win } = fixture();
  app.emit('will-quit');
  expect(win.listenerCount('closed')).toBe(0);
  win.emit('closed');
  expect(calls.dispose).toHaveBeenCalledOnce();
});
