import { expect, it, vi } from 'vitest';
import { SourceUsageTracker } from './usage-tracker';

it('清空run和dispose不能丢失已准入异步usage写的真实排水', async () => {
  let resolve!: () => void;
  const pending = new Promise<void>((yes) => {
    resolve = yes;
  });
  const tracker = new SourceUsageTracker(() => pending);
  const bridge = tracker.bridge('run');
  bridge.recordSearchHits([
    { sourceId: 'source', scope: 'page', canonicalKey: 'https://example.com/' },
  ]);
  bridge.onBrowserOpen('https://example.com/', true);
  bridge.clearRun();
  tracker.dispose();
  let drained = false;
  const drain = tracker.waitForIdle().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  resolve();
  await drain;
  expect(drained).toBe(true);
});

it('usage写失败完成后可以排水，保留既有非阻断错误语义', async () => {
  const tracker = new SourceUsageTracker(async () => {
    throw new Error('合成失败');
  });
  const bridge = tracker.bridge('run');
  bridge.recordSearchHits([
    { sourceId: 'source', scope: 'page', canonicalKey: 'https://example.com/' },
  ]);
  expect(() => bridge.onBrowserOpen('https://example.com/', true)).not.toThrow();
  await expect(tracker.waitForIdle()).resolves.toBeUndefined();
});

it.each(['clearRun', 'dispose'] as const)(
  '%s后迟到search不能重新登记并触发usage写',
  async (action) => {
    const writer = vi.fn();
    const tracker = new SourceUsageTracker(writer);
    const bridge = tracker.bridge('run');
    if (action === 'clearRun') bridge.clearRun();
    else tracker.dispose();
    bridge.recordSearchHits([
      { sourceId: 'source', scope: 'page', canonicalKey: 'https://example.com/' },
    ]);
    bridge.onBrowserOpen('https://example.com/', true);
    await tracker.waitForIdle();
    expect(writer).not.toHaveBeenCalled();
  },
);
