import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { WebContents, WebFrameMain } from 'electron';
import { IdmDownloadCookieReader } from './idm-cookie-reader';

function fixture() {
  let current = true;
  let attached = false;
  const cookies = new EventEmitter();
  const frame = {
    url: 'https://files.example.test/page',
    origin: 'https://files.example.test',
    parent: null,
    detached: false,
  };
  const cookie = {
    name: 'session',
    value: 'fixture-only',
    domain: 'files.example.test',
    path: '/',
    secure: true,
    httpOnly: true,
  };
  const debug = Object.assign(new EventEmitter(), {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => {
      attached = true;
    }),
    detach: vi.fn(() => {
      attached = false;
      debug.emit('detach');
    }),
    sendCommand: vi.fn(async () => ({ cookies: [cookie] })),
  });
  const wc = {
    mainFrame: frame,
    session: { cookies },
    debugger: debug,
    isDestroyed: () => false,
    getUserAgent: () => 'FixtureAgent',
  };
  const reader = new IdmDownloadCookieReader();
  const input = {
    webContents: wc as unknown as WebContents,
    frame: frame as unknown as WebFrameMain,
    snapshot: {
      url: 'https://files.example.test/download/file.zip',
      urlChain: ['https://files.example.test/download/file.zip'],
      filename: 'file.zip',
      hasUserGesture: true,
      initiatorOrigin: frame.origin,
    },
    referrer: '',
    isCurrent: () => current,
  };
  return {
    reader,
    input,
    cookie,
    cookies,
    debug,
    frame,
    revoke: () => {
      current = false;
    },
  };
}

afterEach(() => vi.useRealTimers());
it('独审：主文档blob URL不满足实际HTTP页面的兼容读取资格', async () => {
  const f = fixture();
  f.frame.url = 'blob:https://files.example.test/fixture';
  expect(await f.reader.read(f.input)).toBeNull();
  expect(f.debug.sendCommand).not.toHaveBeenCalled();
});
it('独审：链内blob URL即使继承相同origin仍不得查询Cookie', async () => {
  const f = fixture();
  f.input.snapshot.urlChain.unshift('blob:https://files.example.test/fixture');
  expect(await f.reader.read(f.input)).toBeNull();
  expect(f.debug.sendCommand).not.toHaveBeenCalled();
});
it('独审：不可序列化但site非opaque的分区不得冒充普通Cookie', async () => {
  const f = fixture();
  f.debug.sendCommand.mockResolvedValue({
    cookies: [{ ...f.cookie, partitionKeyOpaque: false } as typeof f.cookie],
  });
  expect(await f.reader.read(f.input)).toBeNull();
});
it('独审：无响应命令在2秒后关闭自己的连接并清掉观察器', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.debug.sendCommand.mockImplementation(() => new Promise(() => {}));
  const pending = f.reader.read(f.input);
  await vi.advanceTimersByTimeAsync(2001);
  expect(await pending).toBeNull();
  expect(f.debug.detach).toHaveBeenCalledExactlyOnceWith();
  expect(f.cookies.listenerCount('changed')).toBe(0);
  expect(f.debug.listenerCount('detach')).toBe(0);
});
it('独审：调试连接被外部摘除后迟到数据不返回也不detach继任者', async () => {
  const f = fixture();
  let finish!: (value: { cookies: (typeof f.cookie)[] }) => void;
  f.debug.sendCommand.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.reader.read(f.input);
  f.debug.emit('detach');
  finish({ cookies: [f.cookie] });
  expect(await pending).toBeNull();
  expect(f.debug.detach).not.toHaveBeenCalled();
});
it('独审：许可撤销即使命令一直不回也在观察周期内终结', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.debug.sendCommand.mockImplementation(() => new Promise(() => {}));
  const pending = f.reader.read(f.input);
  f.revoke();
  await vi.advanceTimersByTimeAsync(51);
  expect(await pending).toBeNull();
  expect(f.debug.detach).toHaveBeenCalledTimes(1);
});
