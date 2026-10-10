import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { installUiDocumentSecurity } from './ui-document-security';
const entry = 'aibrowse://app/index.html';
const readyChannel = 'ui:document-ready';
function setup() {
  const native = Object.assign(new EventEmitter(), {
    mainFrame: {},
    getURL: () => entry,
    isDestroyed: () => false,
    loadURL: vi.fn(async () => undefined),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  });
  const contents = native as unknown as WebContents;
  const guard = installUiDocumentSecurity(contents, {
    entry,
    policy: { selfOrigin: null, selfFileUrl: null, selfAppUrl: entry },
    onRecoveryFailed: vi.fn(),
  });
  const identity = () => ({ owner: contents, frame: native.mainFrame, url: entry });
  const commit = (url = entry, main = true) =>
    native.emit('did-frame-navigate', {}, url, 200, 'OK', main, 1, 1);
  return { native, guard, identity, commit };
}
afterEach(() => vi.useRealTimers());
it('可信主文档commit之后才通知，不携带token', () => {
  const x = setup();
  expect(x.guard.token(x.identity())).toBeNull();
  x.native.send.mockImplementation(() => expect(x.guard.token(x.identity())).not.toBeNull());
  x.commit();
  expect(x.native.send.mock.calls).toEqual([[readyChannel]]);
});
it('子帧、未知入口、query不得发送ready或获得token', () => {
  vi.useFakeTimers();
  for (const [url, main] of [
    [entry, false],
    [entry + '?foreign', true],
    ['aibrowse://app/other.html', true],
  ] as const) {
    const x = setup();
    x.commit(url, main);
    expect(x.native.send).not.toHaveBeenCalled();
    expect(x.guard.token(x.identity())).toBeNull();
  }
});
it('崩溃后的新主文档重新通知，旧token/旧frame始终不能恢复', () => {
  const x = setup();
  x.commit();
  const prior = x.identity(),
    old = x.guard.token(prior);
  x.native.emit('render-process-gone');
  expect(x.guard.accepts(prior, old)).toBe(false);
  x.native.mainFrame = {};
  x.native.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  expect(x.guard.token(x.identity())).toBeNull();
  x.commit();
  expect(x.native.send.mock.calls).toEqual([[readyChannel], [readyChannel]]);
  expect(x.guard.accepts(prior, old)).toBe(false);
  expect(x.guard.accepts(x.identity(), old)).toBe(false);
  expect(x.guard.accepts(x.identity(), x.guard.token(x.identity()))).toBe(true);
});
