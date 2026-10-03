import { describe, expect, it } from 'vitest';
import { isTrustedUiDocument, UiDocumentGuard } from './ui-document-guard';

describe('UI 文档授权', () => {
  const entry = 'aibrowse://app/index.html';
  it('同源其它文档、query、file 和 userinfo 均不是入口', () => {
    for (const url of [
      'aibrowse://app/evil.html',
      entry + '?evil',
      'file:///secret',
      'aibrowse://user@app/index.html',
    ]) {
      expect(isTrustedUiDocument(url, entry)).toBe(false);
    }
    expect(isTrustedUiDocument(entry + '#view', entry)).toBe(true);
    expect(isTrustedUiDocument('http://localhost:5173/evil', 'http://localhost:5173/')).toBe(false);
  });
  it('拒绝旧窗口、子帧、尚未提交和已导航文档的消息', () => {
    const guard = new UiDocumentGuard(entry);
    const identity = { owner: {}, frame: {}, url: entry };
    expect(guard.token(identity)).toBeNull();
    guard.commit(identity);
    const token = guard.token(identity);
    expect(guard.accepts(identity, token)).toBe(true);
    expect(guard.accepts({ ...identity, frame: {} }, token)).toBe(false);
    expect(guard.accepts({ ...identity, owner: {} }, token)).toBe(false);
    guard.beginNavigation();
    expect(guard.accepts(identity, token)).toBe(false);
    guard.rejectNavigation({ ...identity, frame: {} });
    expect(guard.accepts(identity, token)).toBe(false);
    guard.rejectNavigation(identity);
    expect(guard.accepts(identity, token)).toBe(true);
    guard.invalidate();
    expect(guard.accepts(identity, token)).toBe(false);
    guard.commit(identity);
    expect(guard.accepts(identity, token)).toBe(false);
    expect(guard.accepts(identity, guard.token(identity))).toBe(true);
  });
});
