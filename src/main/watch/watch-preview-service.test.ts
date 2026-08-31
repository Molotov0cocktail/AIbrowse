import { describe, expect, it } from 'vitest';
import type { WatchAcquisitionService } from './watch-acquisition-service';
import type { TargetGatedClient } from './public-watch-http-client';
import { WatchPreviewService } from './watch-preview-service';
import { WatchPreviewStore } from './watch-preview-store';

const sourceId = '00000000-0000-4000-8000-000000000001';
const source = {
  status: 'found' as const,
  projection: {
    sourceId,
    rowVersion: 1,
    enabled: true,
    deletedAt: null,
    scope: 'page' as const,
    canonicalKey: 'https://example.com/news',
  },
};

function service(acquisitionResult: unknown, target: TargetGatedClient): WatchPreviewService {
  return new WatchPreviewService({
    store: new WatchPreviewStore(),
    source: () => source,
    acquisition: () =>
      ({ run: async () => acquisitionResult }) as unknown as WatchAcquisitionService,
    discoveryTarget: () => target,
    browser: () => null,
    reader: () => null,
    grants: () => null,
  });
}

const meta = {
  finalUrl: 'https://example.com/news',
  statusCode: 200,
  statusMessage: 'OK',
  contentType: 'text/html',
  contentEncoding: null,
  etag: null,
  lastModified: null,
  retryAfter: null,
  fetchedAt: '2026-01-01T00:00:00.000Z',
  byteLength: 100,
  compressedByteLength: 100,
};

describe('D9 Feed discovery 安全预览', () => {
  it('仅在 direct feed 的 parse 失败后走 purpose=discovery，并隐藏真实 query', async () => {
    let purpose = '';
    const target = {
      get: async (request: { purpose: string }) => {
        purpose = request.purpose;
        return {
          kind: 'ok' as const,
          meta,
          body: Buffer.from(
            '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml?token=secret"></head></html>',
          ),
        };
      },
    } as unknown as TargetGatedClient;
    const result = await service(
      {
        ok: false,
        health: 'parse_changed',
        retryable: false,
        retryAfterSeconds: null,
        disposition: 'parse',
      },
      target,
    ).previewFeed({ mode: 'source', sourceId });
    expect(purpose).toBe('discovery');
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('token=secret');
    expect(JSON.stringify(result)).toContain('example.com/feed.xml');
  });

  it('security failure 不回退 discovery', async () => {
    let called = false;
    const target = {
      get: async () => {
        called = true;
        return { kind: 'aborted' as const };
      },
    } as unknown as TargetGatedClient;
    const result = await service(
      {
        ok: false,
        health: 'security_rejected',
        retryable: false,
        retryAfterSeconds: null,
        disposition: 'security',
      },
      target,
    ).previewFeed({ mode: 'source', sourceId });
    expect(result).toEqual({ ok: false, errorCode: 'security-rejected' });
    expect(called).toBe(false);
  });
});
