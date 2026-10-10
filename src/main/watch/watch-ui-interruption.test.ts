import { describe, expect, it, vi } from 'vitest';
import type { BrowserController } from '../browser/browser-controller';
import type { BrowserWatchReader, WatchReaderResult } from './browser-watch-reader';
import type { WatchAcquisitionService } from './watch-acquisition-service';
import type { TargetGatedClient } from './public-watch-http-client';
import { SessionGrantStore } from './session-grant-store';
import { WatchPreviewService } from './watch-preview-service';
import { WatchPreviewStore } from './watch-preview-store';

const sourceId = '00000000-0000-4000-8000-000000000001';
function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const url = 'https://example.com/news';
const source = {
  status: 'found' as const,
  projection: {
    sourceId,
    rowVersion: 1,
    enabled: true,
    deletedAt: null,
    scope: 'page' as const,
    canonicalKey: url,
  },
};
const input = {
  sourceId,
  accessMode: 'session' as const,
  regions: [{ kind: 'main-text' as const, label: '正文' }],
};
const read: WatchReaderResult = {
  ok: true,
  channels: { mainText: '受控预览正文', headings: [], tables: [], links: [] },
  meta: { url, capturedAt: '2026-10-10T00:00:00.000Z', documentId: '1' },
  suspicion: null,
};
function fixture(reader: (signal: AbortSignal) => Promise<WatchReaderResult>) {
  const store = new WatchPreviewStore();
  const grants = new SessionGrantStore({});
  const preview = new WatchPreviewService({
    store,
    grants: () => grants,
    source: () => source,
    acquisition: () => null,
    discoveryTarget: () => null,
    browser: () =>
      ({ getActiveTab: async () => ({ id: 'tab-1', url }) }) as unknown as BrowserController,
    reader: () =>
      ({
        read: ({ signal }: { signal: AbortSignal }) => reader(signal),
      }) as unknown as BrowserWatchReader,
  });
  return { store, grants, preview };
}
function handle(result: Awaited<ReturnType<WatchPreviewService['previewPage']>>): string {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('固定预览未成功');
  expect(typeof result.value.previewHandle).toBe('string');
  return result.value.previewHandle as string;
}

describe('E3 Watch 界面中断退役', () => {
  it('清空真实预览、discovery和session grant；重复中断后仍接受新界面请求', async () => {
    const { preview, store, grants } = fixture(async () => read);
    const granted = preview.issueSessionGrant(handle(await preview.previewPage(input)));
    expect(granted.ok).toBe(true);
    if (!granted.ok) throw new Error('固定授权未成功');
    const oldPreview = granted.value.previewHandle as string;
    const oldGrant = granted.value.sessionGrantHandle as string;
    const discovery = store.issueDiscovery(sourceId, ['https://example.com/feed.xml']);
    expect(discovery).not.toBeNull();
    if (discovery === null) throw new Error('固定候选未签发');
    expect(store.size).toBe(2);
    expect(grants.recordCount()).toBe(1);

    preview.interruptUiRequests();
    preview.interruptUiRequests();
    expect(store.size).toBe(0);
    expect(grants.recordCount()).toBe(0);
    expect(preview.issueSessionGrant(oldPreview)).toEqual({
      ok: false,
      errorCode: 'preview-expired',
    });
    expect(
      grants.consume({
        handle: oldGrant,
        sourceId,
        previewTabId: 'tab-1',
        finalOrigin: 'https://example.com',
        targetDigest: 'unneeded-after-retirement',
      }),
    ).toEqual({ ok: false, reason: 'not-found' });
    await expect(
      preview.previewFeed({
        mode: 'candidate',
        discoveryHandle: discovery.discoveryHandle,
        candidateId: discovery.candidates[0]!.candidateId,
      }),
    ).resolves.toEqual({ ok: false, errorCode: 'preview-expired' });

    const fresh = handle(await preview.previewPage(input));
    expect(fresh).not.toBe(oldPreview);
    expect(preview.issueSessionGrant(fresh).ok).toBe(true);
    expect(grants.recordCount()).toBe(1);
    await preview.drainBeforeClose();
  });

  it('中断保留controller及lease到真实finally；迟到成功不签发，维护随后可正常恢复', async () => {
    const entered = deferred<AbortSignal>();
    const delayed = deferred<WatchReaderResult>();
    const { preview, store, grants } = fixture(async (signal) => {
      entered.resolve(signal);
      return delayed.promise;
    });
    const pending = preview.previewPage(input);
    const signal = await entered.promise;
    const abort = vi.spyOn(AbortController.prototype, 'abort');
    try {
      preview.interruptUiRequests();
      preview.interruptUiRequests();
      expect(signal.aborted).toBe(true);
      expect(abort).toHaveBeenCalledTimes(2);
      expect(abort.mock.contexts[0]).toBe(abort.mock.contexts[1]);
      expect(preview.pauseForMaintenance(1)).toBe(true);
      let drained = false;
      const drain = preview.drainForMaintenance(1).then(() => {
        drained = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(drained).toBe(false);
      expect(preview.prepareResumeAfterMaintenance(1)).toBe(false);
      expect(abort).toHaveBeenCalledTimes(3);
      delayed.resolve(read);
      await expect(pending).resolves.toEqual({ ok: false, errorCode: 'unavailable' });
      await drain;
      expect(store.size).toBe(0);
      expect(grants.recordCount()).toBe(0);
      preview.interruptUiRequests();
      expect(abort).toHaveBeenCalledTimes(3);
      expect(preview.resumeAfterMaintenance(1)).toBe(true);
      expect(preview.issueSessionGrant(handle(await preview.previewPage(input))).ok).toBe(true);
    } finally {
      delayed.resolve(read);
      abort.mockRestore();
      await preview.drainBeforeClose();
    }
  });

  it('中断后的迟到feed发现不发布候选；新的发现仍可签发', async () => {
    const entered = deferred<AbortSignal>();
    const delayed = deferred<void>();
    const store = new WatchPreviewStore();
    const preview = new WatchPreviewService({
      store,
      grants: () => null,
      source: () => source,
      browser: () => null,
      reader: () => null,
      acquisition: () =>
        ({
          run: async () => ({
            ok: false,
            health: 'parse_changed',
            retryable: false,
            retryAfterSeconds: null,
            disposition: 'parse',
          }),
        }) as unknown as WatchAcquisitionService,
      discoveryTarget: () =>
        ({
          get: async ({ signal }: { signal: AbortSignal }) => {
            entered.resolve(signal);
            await delayed.promise;
            return {
              kind: 'ok',
              meta: { finalUrl: url },
              body: Buffer.from(
                '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>',
              ),
            };
          },
        }) as unknown as TargetGatedClient,
    });
    const pending = preview.previewFeed({ mode: 'source', sourceId });
    const signal = await entered.promise;
    preview.interruptUiRequests();
    expect(signal.aborted).toBe(true);
    delayed.resolve();
    await expect(pending).resolves.toEqual({ ok: false, errorCode: 'unavailable' });
    expect(store.size).toBe(0);
    const fresh = await preview.previewFeed({ mode: 'source', sourceId });
    expect(fresh).toMatchObject({
      ok: true,
      value: { candidates: [{ targetDisplay: 'example.com/feed.xml' }] },
    });
    expect(store.size).toBe(1);
    await preview.drainBeforeClose();
  });
});
