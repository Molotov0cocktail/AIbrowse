import { describe, expect, it } from 'vitest';
import type { WatchAcquisitionService } from './watch-acquisition-service';
import type { TargetGatedClient } from './public-watch-http-client';
import { WatchPreviewService } from './watch-preview-service';
import { WatchPreviewStore } from './watch-preview-store';
import { readPublicHtml } from './public-html-sax-reader';
import { previewPageRegions } from './page-projector';
import type { BrowserController } from '../browser/browser-controller';
import type { BrowserWatchReader } from './browser-watch-reader';

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
const tableHtml = Buffer.from(
  '<html><body><table><tr><th>名称</th><th>价格</th></tr><tr><td>A</td><td>1</td></tr></table></body></html>',
);

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
    expect(result).toMatchObject({ ok: true });
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

describe('D9 Table Region 候选发现', () => {
  it('公开模式保持正式 Region payload/output，并返回有界表头指纹组', async () => {
    let purpose = '';
    const parsed = readPublicHtml(tableHtml, meta.finalUrl);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const regionResult = previewPageRegions({ ...parsed.channels, mainText: '_' }, [
      { kind: 'table', label: '表格候选', headerFingerprint: '0'.repeat(64), occurrence: 0 },
    ]);
    expect(regionResult.ok ? 'ok' : `${regionResult.health}:${regionResult.reason}`).toBe('ok');
    const target = {
      get: async (request: { purpose: string }) => {
        purpose = request.purpose;
        return {
          kind: 'ok' as const,
          meta,
          body: tableHtml,
        };
      },
    } as unknown as TargetGatedClient;
    const result = await service({}, target).previewPage({
      sourceId,
      accessMode: 'public',
      regions: [
        {
          kind: 'table',
          label: '表格候选',
          headerFingerprint: '0'.repeat(64),
          occurrence: 0,
        },
      ],
    });
    expect(purpose).toBe('page');
    expect(result).toMatchObject({ ok: true });
    expect(result).toMatchObject({
      value: {
        previewHandle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        regions: [
          {
            kind: 'table',
            groups: [
              {
                fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
                occurrenceCount: 1,
                columns: 2,
              },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('<table>');
  });
});

describe('D9 Session 预览 origin 竞态', () => {
  it('读取期间导航到其他 origin 时拒绝主进程盖章的最终投影', async () => {
    const preview = new WatchPreviewService({
      store: new WatchPreviewStore(),
      source: () => source,
      acquisition: () => null,
      discoveryTarget: () => null,
      browser: () =>
        ({
          getActiveTab: async () => ({ id: 'tab-1', url: source.projection.canonicalKey }),
        }) as unknown as BrowserController,
      reader: () =>
        ({
          read: async () => ({
            ok: true as const,
            channels: {
              mainText: '第一段。\r\n第二段。\t第三段。',
              headings: [],
              tables: [],
              links: [],
            },
            meta: {
              url: 'https://evil.example/redirected',
              capturedAt: '2026-08-31T00:00:00.000Z',
              documentId: 'doc-evil',
            },
          }),
        }) as unknown as BrowserWatchReader,
      grants: () => null,
    });
    await expect(
      preview.previewPage({
        sourceId,
        accessMode: 'session',
        regions: [{ kind: 'main-text', label: '正文' }],
      }),
    ).resolves.toEqual({ ok: false, errorCode: 'security-rejected' });
  });
});
