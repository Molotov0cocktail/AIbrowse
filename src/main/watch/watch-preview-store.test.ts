import { describe, expect, it } from 'vitest';
import {
  WATCH_PREVIEW_TTL_MS,
  MAX_WATCH_PREVIEWS,
  WatchPreviewStore,
  type WatchPreviewRecord,
} from './watch-preview-store';

const record: WatchPreviewRecord = {
  sourceId: '00000000-0000-4000-8000-000000000001',
  sourceRowVersion: 1,
  locatorFingerprint: 'fingerprint',
  finalOrigin: 'https://example.com',
  accessMode: 'session',
  target: {},
  projection: {},
  fieldCatalog: ['标题'],
  validator: {},
  previewTabId: 'private-tab',
};

describe('D9 WatchPreviewStore', () => {
  it('签发 43 字符随机句柄，并且仅可消费一次', () => {
    const store = new WatchPreviewStore(() => 10);
    const handle = store.issue(record);
    expect(handle).not.toBeNull();
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.consume(handle!)).toEqual(record);
    expect(store.consume(handle!)).toBeNull();
  });

  it('在精确 TTL 边界过期且失败也消费句柄', () => {
    let now = 0;
    const store = new WatchPreviewStore(() => now);
    const handle = store.issue(record);
    expect(handle).not.toBeNull();
    now = WATCH_PREVIEW_TTL_MS;
    expect(store.consume(handle!)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('dispose 幂等清空内存态记录', () => {
    const store = new WatchPreviewStore();
    const handle = store.issue(record);
    expect(handle).not.toBeNull();
    store.dispose();
    store.dispose();
    expect(store.consume(handle!)).toBeNull();
  });

  it('普通预览达到总容量后 fail-closed，并在签发时清理过期项', () => {
    let now = 0;
    const store = new WatchPreviewStore(() => now);
    for (let index = 0; index < MAX_WATCH_PREVIEWS; index += 1)
      expect(store.issue({ ...record, sourceRowVersion: index + 1 })).not.toBeNull();
    expect(store.issue(record)).toBeNull();
    now = WATCH_PREVIEW_TTL_MS;
    expect(store.issue(record)).not.toBeNull();
    expect(store.size).toBe(1);
    store.dispose();
    expect(store.size).toBe(0);
  });

  it('feed discovery 只返回 opaque candidate，按 source 绑定且一次性消费', () => {
    const store = new WatchPreviewStore(() => 10);
    const issued = store.issueDiscovery(record.sourceId, [
      'https://example.com/feed.xml?private=1',
    ]);
    expect(issued?.discoveryHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued?.candidates[0]?.candidateId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const consumed = store.consumeDiscovery(
      issued!.discoveryHandle,
      issued!.candidates[0]!.candidateId,
    );
    expect(consumed).toEqual({
      sourceId: record.sourceId,
      feedUrl: 'https://example.com/feed.xml?private=1',
    });
    expect(
      store.consumeDiscovery(issued!.discoveryHandle, issued!.candidates[0]!.candidateId),
    ).toBeNull();
  });

  it('feed discovery 在 TTL 边界过期，dispose 同时清空 discovery', () => {
    let now = 0;
    const store = new WatchPreviewStore(() => now);
    const issued = store.issueDiscovery(record.sourceId, ['https://example.com/feed']);
    now = WATCH_PREVIEW_TTL_MS;
    expect(
      store.consumeDiscovery(issued!.discoveryHandle, issued!.candidates[0]!.candidateId),
    ).toBeNull();
    store.issueDiscovery(record.sourceId, ['https://example.com/feed']);
    store.dispose();
    expect(store.size).toBe(0);
  });
});
