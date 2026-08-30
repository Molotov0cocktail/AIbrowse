// D7 feed-acquisition-service: Feed 公开采集路由（detailed-design §6.4/#S6-054/
// #S6-056/§7、threat-model §3.6/WRT-18）。D3 安全工厂 target-gated client →
// FeedParser → 统一 envelope 盖章 → 304 条件请求闭环。
//
// 边界：
// - 只消费 D3 createPublicWatchHttpStack().target（purpose='feed'）；
// - FeedParser 只产 FeedProjectionValue + canonical JSON + valueHash；本服务以 HTTP
//   主进程记录盖章统一 FeedProjection envelope（ruleId/sourceId/capturedAt、固定
//   documentId=null、finalUrl 安全投影、contentHash=SHA-256(utf8(canonicalJson))）；
// - 条件请求 ETag/Last-Modified 只来自 ProcessingService 验证过的 WatchBaselineHint
//   （kind='feed'），禁止从最新 Run metadata 猜测；
// - 已有 Baseline 的 304=unchanged（零 parser/diff/baseline 写）；首次/无 hint 的
//   304 → 同 deadline/gate 无条件 GET 恰一次，再次 304 → unavailable 零 Baseline；
// - MAX_FEED_PROJECTION_BYTES 是 parser 输出上限；进入 processing 若
//   byteLength>MAX_PAGE_PROJECTION_BYTES → budget_exceeded（旧 Baseline 保留/首次零）；
// - Feed/Page 都汇入唯一 WatchProcessingService（本服务只产 acquisition DTO）。
import { createHash } from 'node:crypto';
import { logInfo } from '../logger';
import {
  MAX_PAGE_PROJECTION_BYTES,
  type ConditionalResponseMetadata,
  type FeedAcquisitionDisposition,
  type FeedAcquisitionResult,
  type FeedProjection,
  type WatchAcquisitionInput,
  type WatchFailureCode,
  type WatchRule,
} from '../../shared/types/watch';
import type { TargetGatedClient, PublicFetchResult } from './public-watch-http-client';
import { classifyPublicHttpStatus } from './public-watch-http-client';
import { parseFeedXml } from './feed-parser';
import { evidenceSafeUrl } from '../../shared/watch/diff/evidence';
import { utf8ByteLength } from '../../shared/watch/watch-budget';

export interface FeedAcquisitionServiceOptions {
  target: TargetGatedClient;
}

/**
 * Feed 网络请求 URL（#S6-054 FIXED DECISION 8）：保留合法 path+query，只去掉
 * fragment（fragment 不发送给服务器）；校验 http/https、无 userinfo、长度有界。
 * 与 evidenceSafeUrl（去 query/fragment 的安全投影）不同——后者只用于持久化/
 * Evidence/日志，禁止反向用作请求 URL。
 */
function requestFeedUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  parsed.hash = '';
  return parsed.href;
}

export class FeedAcquisitionService {
  private readonly target: TargetGatedClient;

  constructor(options: FeedAcquisitionServiceOptions) {
    this.target = options.target;
  }

  private failure(
    health: WatchFailureCode,
    retryable: boolean,
    disposition: FeedAcquisitionDisposition,
  ): Extract<FeedAcquisitionResult, { ok: false }> {
    return { ok: false, health, retryable, retryAfterSeconds: null, disposition };
  }

  /**
   * Feed 采集（§6.4）：仅 public。输入 rule.target 必须为 feed 且 URL 已规范。
   * baselineHint.kind 必须为 'feed'（有 Baseline）或 'none'（首次）。
   */
  async run(input: WatchAcquisitionInput): Promise<FeedAcquisitionResult> {
    if (input.rule.kind !== 'feed' || input.rule.accessMode !== 'public') {
      return this.failure('security_rejected', false, 'security');
    }
    const target = input.rule.target;
    if (target.type !== 'feed') return this.failure('parse_changed', false, 'parse');
    // #S6-054 FIXED DECISION 8：Rule locator 的 query 是网络目标身份的一部分，
    // 实际网络请求必须保留合法 path+query；evidenceSafeUrl 是持久化/Evidence/日志
    // 的 URL 安全投影，不能反向用作请求 URL。
    const feedUrl = requestFeedUrl(target.feedUrl);
    if (feedUrl === null) return this.failure('security_rejected', false, 'security');

    const hint = input.baselineHint;
    if (hint.kind === 'page') return this.failure('unavailable', false, 'internal');

    // 条件请求 header 只来自验证过的 Baseline hint
    const hasBaseline = hint.kind === 'feed';
    const validators = hint.kind === 'feed' ? hint.validators : { etag: null, lastModified: null };
    const deadline = new Date(input.deadlineMs);

    const fetched = await this.target.get({
      url: feedUrl,
      purpose: 'feed',
      etag: hasBaseline ? validators.etag : null,
      lastModified: hasBaseline ? validators.lastModified : null,
      signal: input.signal,
      deadline,
    });

    if (fetched.kind === 'aborted') return this.failure('unavailable', true, 'aborted');
    if (fetched.kind === 'failed') return this.failedHealth(fetched);

    const meta = fetched.meta;
    const statusClass = classifyPublicHttpStatus(meta.statusCode);
    if (statusClass === 'unchanged-http') {
      // 304
      if (hasBaseline) {
        return {
          ok: true,
          kind: 'not-modified',
          finalUrl: meta.finalUrl,
          fetchedAt: meta.fetchedAt,
          expectedSourceLocatorFingerprint: input.rule.sourceLocatorFingerprint,
          responseMetadata: this.conditionalMetadata(meta, 304),
        };
      }
      // 首次 304：同 acquisition/deadline/gate 无条件 GET 恰一次
      const second = await this.target.get({
        url: feedUrl,
        purpose: 'feed',
        signal: input.signal,
        deadline,
      });
      if (second.kind === 'aborted') return this.failure('unavailable', true, 'aborted');
      if (second.kind === 'failed') return this.failedHealth(second);
      const secondMeta = second.meta;
      if (classifyPublicHttpStatus(secondMeta.statusCode) === 'unchanged-http') {
        return this.failure('unavailable', false, 'first-baseline-304');
      }
      if (second.kind !== 'ok') return this.failure('unavailable', true, 'network');
      return this.buildProjection(input.rule, second.body, secondMeta);
    }

    if (statusClass === 'parse-changed') return this.failure('parse_changed', false, 'parse');
    if (statusClass === 'unavailable') return this.failure('unavailable', true, 'network');
    if (statusClass === 'redirect') return this.failure('parse_changed', false, 'parse');
    if (fetched.kind !== 'ok' || !Buffer.isBuffer(fetched.body)) {
      return this.failure('unavailable', true, 'internal');
    }
    return this.buildProjection(input.rule, fetched.body, fetched.meta);
  }

  private failedHealth(
    failed: Extract<PublicFetchResult, { kind: 'failed' }>,
  ): FeedAcquisitionResult {
    switch (failed.health) {
      case 'security_rejected':
        return this.failure('security_rejected', false, 'security');
      case 'budget_exceeded':
        return this.failure('budget_exceeded', false, 'budget');
      case 'robots_disallowed':
        return this.failure('robots_disallowed', false, 'robots');
      case 'unavailable':
        return this.failure('unavailable', true, 'network');
      case 'parse_changed':
        return this.failure('parse_changed', false, 'parse');
      default:
        return this.failure('unavailable', true, 'internal');
    }
  }

  /** HTTP 成功且 parser/validator 通过后：盖章统一 envelope（#S6-054）。 */
  private async buildProjection(
    rule: WatchRule,
    body: Buffer,
    meta: {
      finalUrl: string;
      fetchedAt: string;
      etag: string | null;
      lastModified: string | null;
      statusCode: number;
      retryAfter: number | null;
    },
  ): Promise<FeedAcquisitionResult> {
    const parsed = await parseFeedXml(body);
    if (!parsed.ok) {
      if (parsed.health === 'security_rejected')
        return this.failure('security_rejected', false, 'security');
      if (parsed.health === 'budget_exceeded')
        return this.failure('budget_exceeded', false, 'budget');
      if (parsed.health === 'dependency_unavailable') {
        return this.failure('dependency_unavailable', false, 'dependency');
      }
      return this.failure('parse_changed', false, 'parse');
    }
    // 进入 processing 的持久化预算：> MAX_PAGE_PROJECTION_BYTES → budget_exceeded
    if (parsed.byteLength > MAX_PAGE_PROJECTION_BYTES) {
      return this.failure('budget_exceeded', false, 'budget');
    }
    // finalUrl 安全投影（与 Evidence 相同：去 fragment/query；非法 → security_rejected）
    const finalUrl = evidenceSafeUrl(meta.finalUrl);
    if (finalUrl === null) return this.failure('security_rejected', false, 'security');
    const capturedAt = meta.fetchedAt;
    if (!Number.isFinite(Date.parse(capturedAt))) {
      return this.failure('unavailable', true, 'internal');
    }
    const contentHash = createHash('sha256').update(parsed.canonicalJson, 'utf8').digest('hex');
    const projection: FeedProjection = {
      schemaVersion: 1,
      ruleId: rule.id,
      sourceId: rule.sourceId,
      finalUrl,
      capturedAt,
      documentId: null,
      contentHash,
      byteLength: parsed.byteLength,
      value: parsed.value,
    };
    const responseMetadata = this.conditionalMetadata(meta, 200);
    logInfo('watch', `Feed 采集成功（rule=${rule.id}，bytes=${projection.byteLength}）`);
    return {
      ok: true,
      kind: 'projection',
      projection,
      expectedSourceLocatorFingerprint: rule.sourceLocatorFingerprint,
      responseMetadata,
    };
  }

  /**
   * Feed 网络请求 URL（#S6-054 FIXED DECISION 8）：保留合法 path+query，只去掉
   * fragment（fragment 不发送给服务器）；校验 http/https、无 userinfo、长度有界。
   * 与 evidenceSafeUrl（去 query/fragment 的安全投影）不同——后者只用于持久化/
   * Evidence/日志，禁止反向用作请求 URL。
   */
  private conditionalMetadata(
    meta: { etag: string | null; lastModified: string | null },
    httpStatus: 200 | 304,
  ): ConditionalResponseMetadata {
    const etagBytes = meta.etag === null ? 0 : utf8ByteLength(meta.etag);
    const lmBytes = meta.lastModified === null ? 0 : utf8ByteLength(meta.lastModified);
    const warnings: ConditionalResponseMetadata['warnings'] = [];
    if (etagBytes > 1_024) warnings.push('etag-oversize');
    if (lmBytes > 1_024) warnings.push('last-modified-oversize');
    return {
      httpStatus,
      etag: etagBytes > 1_024 ? null : meta.etag,
      lastModified: lmBytes > 1_024 ? null : meta.lastModified,
      warnings,
    };
  }
}
