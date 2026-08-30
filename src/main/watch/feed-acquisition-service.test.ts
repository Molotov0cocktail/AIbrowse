// D7 feed-acquisition-service tests: 公开 Feed 采集路由（detailed-design
// §6.4/#S6-054/#S6-056/§7、threat-model §3.6/WRT-18）。真实 node:sqlite 不参与
//（本模块零 DB）；使用 fake TargetGatedClient 捕获请求 URL。红→绿覆盖：
// - Rule locator 的 query 是网络目标身份的一部分：请求 URL 必须保留合法
//   path+query（fragment 不进请求），而 persisted finalUrl/Evidence 仍去
//   query/fragment（#S6-054 安全投影）；
// - 条件 header 只来自已验证 Baseline hint；304 首次/已有 Baseline 分支；
// - 200 成功 → FeedProjection envelope（contentHash=SHA-256(canonical)）。
import { describe, expect, it } from 'vitest';
import { FeedAcquisitionService } from './feed-acquisition-service';
import type { TargetGatedClient, PublicFetchResult } from './public-watch-http-client';
import { sha256Hex } from '../../shared/watch/diff/evidence';
import type {
  ConditionalResponseMetadata,
  WatchAcquisitionInput,
  WatchBaselineHint,
  WatchRule,
} from '../../shared/types/watch';

const FINGERPRINT = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function makeFeedRule(overrides: Partial<WatchRule> = {}): WatchRule {
  return {
    id: 'rule-1',
    sourceId: 'src-1',
    kind: 'feed',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'public',
    schedule: { kind: 'interval', intervalMinutes: 60 },
    target: { type: 'feed', feedUrl: 'https://example.com/rss.xml', format: 'rss2' },
    condition: null,
    notificationLevel: 'normal',
    sourceRowVersion: 1,
    sourceLocatorFingerprint: FINGERPRINT,
    nextDueAt: null,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

// 捕获每次 target.get 的 URL（含 query），返回固定 200 XML body
function capturingTarget(
  urls: string[],
  body: Buffer = Buffer.from(
    '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>' +
      '<link>https://example.com</link><description>d</description>' +
      '<item><title>a</title><link>https://example.com/a</link><guid>g1</guid>' +
      '<description>s</description></item></channel></rss>',
    'utf8',
  ),
): TargetGatedClient {
  return {
    async get(req: {
      url: string;
      purpose: 'feed' | 'page' | 'discovery';
      etag?: string | null;
      lastModified?: string | null;
      signal?: AbortSignal;
      deadline?: Date;
    }): Promise<PublicFetchResult> {
      urls.push(req.url);
      return {
        kind: 'ok',
        meta: {
          finalUrl: req.url,
          statusCode: 200,
          statusMessage: 'OK',
          contentType: 'application/rss+xml',
          contentEncoding: null,
          etag: '"v1"',
          lastModified: '2026-08-28T00:00:00.000Z',
          retryAfter: null,
          fetchedAt: '2026-08-28T00:00:00.000Z',
          byteLength: body.length,
          compressedByteLength: body.length,
        },
        body,
      };
    },
    async head(): Promise<PublicFetchResult> {
      throw new Error('head 不应被调用');
    },
  };
}

function input(rule: WatchRule, hint: WatchBaselineHint): WatchAcquisitionInput {
  return {
    rule,
    baselineHint: hint,
    signal: new AbortController().signal,
    deadlineMs: Date.parse('2026-08-28T00:00:01.000Z'),
  };
}

function feedHint(): WatchBaselineHint {
  return {
    kind: 'feed',
    expectedBaselineVersion: 1,
    contentHash: 'a'.repeat(64),
    validators: { etag: '"old"', lastModified: null },
  };
}

describe('FeedAcquisitionService（#S6-054/#S6-056）', () => {
  it('query-bearing Feed：请求 URL 保留 path+query；persisted finalUrl 去 query', async () => {
    const urls: string[] = [];
    const svc = new FeedAcquisitionService({ target: capturingTarget(urls) });
    const rule = makeFeedRule({
      target: {
        type: 'feed',
        feedUrl: 'https://example.com/feed.xml?cat=tech#frag',
        format: 'rss2',
      },
    });
    const r = await svc.run(input(rule, { kind: 'none', expectedBaselineVersion: 0 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.kind !== 'projection') throw new Error('期望 projection');
    // 请求 URL 保留合法 path+query（fragment 不发送给服务器）
    expect(urls.length).toBe(1);
    expect(urls[0]).toContain('?cat=tech');
    expect(urls[0]).not.toContain('#frag');
    // persisted projection.finalUrl 去 query/fragment
    expect(r.projection.finalUrl).toBe('https://example.com/feed.xml');
    expect(r.projection.finalUrl).not.toContain('?');
  });

  it('200 成功 envelope：contentHash=SHA-256(canonical value bytes)，byteLength 精确', async () => {
    const urls: string[] = [];
    const svc = new FeedAcquisitionService({ target: capturingTarget(urls) });
    const rule = makeFeedRule();
    const r = await svc.run(input(rule, { kind: 'none', expectedBaselineVersion: 0 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.kind !== 'projection') throw new Error('期望 projection');
    const canonical = JSON.stringify(r.projection.value);
    expect(Buffer.byteLength(canonical, 'utf8')).toBe(r.projection.byteLength);
    expect(sha256Hex(canonical)).toBe(r.projection.contentHash);
    expect(r.projection.documentId).toBeNull();
  });

  it('条件 header 只来自 hint：Feed hint → etag/lastModified 传给 target', async () => {
    const seen: Array<{ url: string; etag: string | null; lastModified: string | null }> = [];
    const svc = new FeedAcquisitionService({
      target: {
        async get(req): Promise<PublicFetchResult> {
          seen.push({
            url: req.url,
            etag: req.etag ?? null,
            lastModified: req.lastModified ?? null,
          });
          return {
            kind: 'unchanged-http',
            meta: {
              finalUrl: req.url,
              statusCode: 304,
              statusMessage: 'Not Modified',
              contentType: null,
              contentEncoding: null,
              etag: '"new"',
              lastModified: null,
              retryAfter: null,
              fetchedAt: '2026-08-28T00:00:00.000Z',
              byteLength: 0,
              compressedByteLength: 0,
            },
          };
        },
        async head(): Promise<PublicFetchResult> {
          throw new Error('head 不应被调用');
        },
      },
    });
    const rule = makeFeedRule();
    const r = await svc.run(input(rule, feedHint()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('not-modified');
    expect(seen[0]!.etag).toBe('"old"');
    expect(seen[0]!.lastModified).toBeNull();
    if (r.kind !== 'not-modified') return;
    const meta: ConditionalResponseMetadata = r.responseMetadata;
    expect(meta.httpStatus).toBe(304);
    expect(meta.etag).toBe('"new"');
  });
});
