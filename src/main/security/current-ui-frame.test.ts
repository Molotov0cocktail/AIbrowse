import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron';
import { describe, expect, it } from 'vitest';
import { isCurrentUiFrame } from './current-ui-frame';
import { UiDocumentGuard } from './ui-document-guard';

function setup() {
  const frame = {
    detached: false,
    processId: 7,
    routingId: 3,
    url: 'aibrowse://app/index.html',
    isDestroyed: () => false,
  };
  const contents = {
    isDestroyed: () => false,
    mainFrame: frame as unknown as WebFrameMain,
  } as WebContents;
  const event = {
    sender: contents,
    senderFrame: frame,
    processId: 7,
    frameId: 3,
  } as unknown as IpcMainInvokeEvent;
  return { frame, contents, event };
}

describe('可信UI当前原生帧身份', () => {
  it('崩溃后当前RFH已重建但detached粘滞时仍允许新文档握手，旧token继续拒绝', () => {
    const x = setup();
    const guard = new UiDocumentGuard(x.frame.url);
    const identity = { owner: x.contents, frame: x.frame, url: x.frame.url };
    guard.commit(identity);
    const old = guard.token(identity);
    guard.invalidate();
    x.frame.detached = true;
    x.frame.processId = 8;
    x.event.processId = 8;
    guard.commit(identity);
    expect(isCurrentUiFrame(x.event, x.contents)).toBe(true);
    expect(guard.accepts(identity, old)).toBe(false);
    expect(guard.accepts(identity, guard.token(identity))).toBe(true);
  });
  it.each(['old-process', 'old-routing', 'destroyed-frame', 'invalid-process', 'invalid-routing'])(
    '拒绝原生身份失效：%s',
    (kind) => {
      const x = setup();
      if (kind === 'old-process') x.event.processId = 6;
      if (kind === 'old-routing') x.event.frameId = 2;
      if (kind === 'destroyed-frame') x.frame.isDestroyed = () => true;
      if (kind === 'invalid-process') x.event.processId = x.frame.processId = -1;
      if (kind === 'invalid-routing') x.event.frameId = x.frame.routingId = Number.NaN;
      expect(isCurrentUiFrame(x.event, x.contents)).toBe(false);
    },
  );
  it('拒绝旧窗口、其它帧、空帧、已销毁contents及native getter异常', () => {
    for (const change of [
      (x: ReturnType<typeof setup>) => Object.assign(x.event, { sender: {} }),
      (x: ReturnType<typeof setup>) => Object.assign(x.event, { senderFrame: { ...x.frame } }),
      (x: ReturnType<typeof setup>) => Object.assign(x.event, { senderFrame: null }),
      (x: ReturnType<typeof setup>) => Object.assign(x.contents, { isDestroyed: () => true }),
      (x: ReturnType<typeof setup>) =>
        Object.defineProperty(x.frame, 'processId', {
          get() {
            throw new Error('native frame unavailable');
          },
        }),
    ]) {
      const x = setup();
      change(x);
      expect(isCurrentUiFrame(x.event, x.contents)).toBe(false);
    }
  });
  it('活的当前帧仍须由独立guard核入口和文档世代', () => {
    const x = setup();
    const guard = new UiDocumentGuard(x.frame.url);
    expect(isCurrentUiFrame(x.event, x.contents)).toBe(true);
    const identity = { owner: x.contents, frame: x.frame, url: x.frame.url + '?foreign' };
    guard.commit(identity);
    expect(guard.token(identity)).toBeNull();
    guard.beginNavigation();
    expect(guard.token({ ...identity, url: x.frame.url })).toBeNull();
  });
});
