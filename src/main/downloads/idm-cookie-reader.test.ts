import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
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

describe('IDM 同源缺失头的有限 Cookie 读取', () => {
  it('只执行精确URL的固定只读命令，保留空来源并清理连接', async () => {
    const f = fixture();
    expect(await f.reader.read(f.input)).toEqual({
      cookie: 'session=fixture-only',
      referer: '',
      userAgent: 'FixtureAgent',
    });
    expect(f.debug.sendCommand).toHaveBeenCalledExactlyOnceWith('Network.getCookies', {
      urls: [f.input.snapshot.url],
    });
    expect(f.debug.detach).toHaveBeenCalledTimes(1);
    expect(f.cookies.listenerCount('changed')).toBe(0);
  });
  it.each(['https://other.test/file', 'http://files.example.test/file'])(
    '跨源链不查询Cookie：%s',
    async (other) => {
      const f = fixture();
      f.input.snapshot.urlChain.unshift(other);
      expect(await f.reader.read(f.input)).toBeNull();
      expect(f.debug.attach).not.toHaveBeenCalled();
    },
  );
  it('不接管别人已有的调试连接', async () => {
    const f = fixture();
    f.debug.isAttached.mockReturnValue(true);
    expect(await f.reader.read(f.input)).toBeNull();
    expect(f.debug.attach).not.toHaveBeenCalled();
    expect(f.debug.detach).not.toHaveBeenCalled();
  });
  it.each(['cookie', 'navigation', 'lease', 'dispose'])(
    '读取期间变化安全撤销：%s',
    async (kind) => {
      const f = fixture();
      let resolve!: (value: { cookies: (typeof f.cookie)[] }) => void;
      f.debug.sendCommand.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const pending = f.reader.read(f.input);
      if (kind === 'cookie') f.cookies.emit('changed');
      if (kind === 'navigation') f.frame.url += '?changed=1';
      if (kind === 'lease') f.revoke();
      if (kind === 'dispose') f.reader.dispose();
      resolve({ cookies: [f.cookie] });
      expect(await pending).toBeNull();
      expect(f.debug.detach).toHaveBeenCalledTimes(1);
    },
  );
  it('同名不同路径Cookie不猜测顺序', async () => {
    const f = fixture();
    f.debug.sendCommand.mockResolvedValue({
      cookies: [f.cookie, { ...f.cookie, path: '/download', value: 'second' }],
    });
    expect(await f.reader.read(f.input)).toBeNull();
  });
  it.each([
    { value: 'value; injected=1' },
    { domain: 'other.test' },
    { path: '/elsewhere' },
    { partitionKeyOpaque: true },
    { partitionKey: { topLevelSite: 'https://other.test', hasCrossSiteAncestor: false } },
    { partitionKey: { topLevelSite: 'https://example.test', hasCrossSiteAncestor: true } },
  ])('拒绝不匹配或不明确的Cookie', async (changes) => {
    const f = fixture();
    f.debug.sendCommand.mockResolvedValue({ cookies: [{ ...f.cookie, ...changes }] });
    expect(await f.reader.read(f.input)).toBeNull();
  });
  it('允许已由原生当前frame隔离的同站分区Cookie', async () => {
    const f = fixture();
    f.debug.sendCommand.mockResolvedValue({
      cookies: [
        {
          ...f.cookie,
          partitionKey: { topLevelSite: 'https://example.test', hasCrossSiteAncestor: false },
        } as typeof f.cookie,
      ],
    });
    expect((await f.reader.read(f.input))?.cookie).toBe('session=fixture-only');
  });
});
