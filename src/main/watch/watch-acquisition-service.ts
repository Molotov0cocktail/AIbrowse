// Sixth Stage D6: PageAcquisitionRouter —— public/session 页面采集严格路由
//（detailed-design §7/§8/§12.2、threat-model WT-09～WT-12/WT-22～WT-23、
// WRT-09～WRT-11/WRT-19、FIXED DECISIONS 9/10/11/12）。
//
// 边界：
// - public 只消费 D3 安全工厂的 TargetGatedClient + PublicHtmlSaxReader；
//   session 只消费 WatchTaskTabWorkspace + BrowserWatchReader；两条路径零
//   相互调用、零自动回退、零共享 Cookie/网络客户端；唯一汇合点是
//   DocumentChannels validator 与 PageProjector；
// - 每次 Session attempt 在共享 HostRequestGate 成功后精确创建一个全新
//   task Tab（retry 必须新建；attemptDeadline 入口一次性冻结、不可变）；
// - 登录/captcha/challenge 只使用受控结构信号 + 主进程 URL/降级状态；
// - 成功仅返回可信、闭合、有界的 PageProjection（携带输入 rule 的 expected
//   sourceLocatorFingerprint 供 D7 CAS）；失败返回闭合 health/disposition。
// - 本模块零 DB 写入、零 Diff/Event；D6 成功绝不伪装为 D5 的 `{ok:true}→unchanged`。
import type {
  PageTarget,
  PageProjection,
  WatchAccessMode,
  WatchFailureCode,
  Clock,
} from '../../shared/types/watch';
import type { TargetGatedClient, PublicFetchResult } from './public-watch-http-client';
import { classifyPublicHttpStatus } from './public-watch-http-client';
import { readPublicHtml } from './public-html-sax-reader';
import { validateDocumentChannels } from '../../shared/watch/document-channels';
import { HostRequestGate } from './host-request-gate';
import { WatchTaskTabWorkspace } from './watch-task-tab-workspace';
import {
  BrowserWatchReader,
  freezeAttemptDeadline,
  type SnapshotSuspicion,
} from './browser-watch-reader';
import {
  pageLocatorKey,
  projectPageProjection,
  sessionConsentTargetCheck,
  urlOrigin,
  type PageProjectionResult,
} from './page-projector';
import { validatePageTarget } from '../../shared/watch/watch-targets';
import { urlChallengeMarkers } from './browser-watch-reader';
import { logInfo, logWarn } from '../logger';

// ---------------------------------------------------------------------------
// 闭合结果类型
// ---------------------------------------------------------------------------

export type PageAcquisitionDisposition =
  | 'ok'
  | 'aborted'
  | 'consent-missing'
  | 'consent-mismatch'
  | 'origin-mismatch'
  | 'source-changed'
  | 'login'
  | 'captcha'
  | 'suspicious'
  | 'tab-error'
  | 'tab-closed-by-user'
  | 'tab-missing'
  | 'timeout'
  | 'snapshot-invalid'
  | 'cleanup-failed'
  | 'workspace-failed'
  | 'network'
  | 'robots'
  | 'budget'
  | 'parse'
  | 'security'
  | 'redirect-status'
  | 'protocol'
  | 'invalid-target'
  | 'internal';

export type PageAcquisitionResult =
  | {
      ok: true;
      projection: PageProjection;
      accessMode: WatchAccessMode;
      expectedSourceLocatorFingerprint: string; // 输入 rule 的 locator fingerprint（D7 CAS 用）
    }
  | {
      ok: false;
      health: WatchFailureCode;
      retryable: boolean;
      retryAfterSeconds: number | null;
      disposition: PageAcquisitionDisposition;
    };

export interface PageAcquisitionInput {
  target: PageTarget;
  accessMode: WatchAccessMode;
  ruleId: string;
  sourceId: string;
  sourceLocatorFingerprint: string;
  signal: AbortSignal;
  deadline: Date; // Coordinator 传入的绝对截止（不可变）
}

export interface PageAcquisitionRouterOptions {
  publicTarget: TargetGatedClient; // D3 createPublicWatchHttpStack().target
  workspace: WatchTaskTabWorkspace;
  reader: BrowserWatchReader;
  hostGate: HostRequestGate;
  clock: Clock;
}

const FAILED_IMMEDIATE: ReadonlySet<WatchFailureCode> = new Set([
  'login_required',
  'captcha',
  'parse_changed',
  'robots_disallowed',
  'security_rejected',
  'budget_exceeded',
  'dependency_unavailable',
]);

function failure(
  health: WatchFailureCode,
  retryable: boolean,
  retryAfterSeconds: number | null,
  disposition: PageAcquisitionDisposition,
): PageAcquisitionResult {
  return { ok: false, health, retryable, retryAfterSeconds, disposition };
}

function failedHealth(
  failed: Extract<PublicFetchResult, { kind: 'failed' }>,
): PageAcquisitionResult {
  switch (failed.health) {
    case 'security_rejected':
      return failure('security_rejected', false, null, 'security');
    case 'budget_exceeded':
      return failure('budget_exceeded', false, null, 'budget');
    case 'robots_disallowed':
      return failure('robots_disallowed', false, null, 'robots');
    case 'unavailable':
      return failure('unavailable', true, null, 'network');
    case 'parse_changed':
      return failure('parse_changed', false, null, 'parse');
    default:
      return failure('unavailable', true, null, 'internal');
  }
}

export class PageAcquisitionRouter {
  private readonly publicTarget: TargetGatedClient;
  private readonly workspace: WatchTaskTabWorkspace;
  private readonly reader: BrowserWatchReader;
  private readonly hostGate: HostRequestGate;
  private readonly clock: Clock;

  constructor(options: PageAcquisitionRouterOptions) {
    this.publicTarget = options.publicTarget;
    this.workspace = options.workspace;
    this.reader = options.reader;
    this.hostGate = options.hostGate;
    this.clock = options.clock;
  }

  async run(input: PageAcquisitionInput): Promise<PageAcquisitionResult> {
    if (input.target === null || typeof input.target !== 'object') {
      return failure('parse_changed', false, null, 'invalid-target');
    }
    const validated = validatePageTarget(input.target);
    if (!validated.ok) {
      return failure('parse_changed', false, null, 'invalid-target');
    }
    if (input.accessMode !== 'public' && input.accessMode !== 'session') {
      return failure('security_rejected', false, null, 'invalid-target');
    }
    if (input.accessMode === 'public') return this.acquirePublic(input, validated.target);
    return this.acquireSession(input, validated.target);
  }

  // -------------------------------------------------------------------------
  // public 路径：D3 TargetGatedClient → PublicHtmlSaxReader → Projector
  // -------------------------------------------------------------------------

  private async acquirePublic(
    input: PageAcquisitionInput,
    target: PageTarget,
  ): Promise<PageAcquisitionResult> {
    const attemptDeadline = freezeAttemptDeadline(this.clock.now().getTime(), input.deadline);
    const canonicalUrl = pageLocatorKey(target.pageUrl);
    if (canonicalUrl === null) {
      return failure('security_rejected', false, null, 'invalid-target');
    }
    const fetched = await this.publicTarget.get({
      url: canonicalUrl,
      purpose: 'page',
      signal: input.signal,
      deadline: attemptDeadline,
    });
    if (fetched.kind === 'aborted') {
      return failure('unavailable', true, null, 'aborted');
    }
    if (fetched.kind === 'failed') return failedHealth(fetched);
    const meta = fetched.meta;
    // HTTP 状态分类（D3 §7 客户端侧投影；304 无 Baseline 属协议异常）
    const statusClass = classifyPublicHttpStatus(meta.statusCode);
    switch (statusClass) {
      case 'unchanged-http': // 304：无条件 GET 仍 304 → 协议异常
        return failure('unavailable', true, meta.retryAfter, 'protocol');
      case 'redirect': // 终态 3xx（无 Location 已由 D3 消费）：结构异常
        return failure('parse_changed', false, null, 'redirect-status');
      case 'parse-changed':
        return failure('parse_changed', false, null, 'parse');
      case 'unavailable':
        return failure('unavailable', true, meta.retryAfter, 'network');
      case 'ok':
        break;
    }
    // 公开路径无法获得表单结构信号：URL 登录/challenge path 信号单独出现
    // 不可靠分类 → 保守 unavailable（FIXED 10）
    const markers = urlChallengeMarkers(meta.finalUrl);
    if (markers.login || markers.challenge) {
      logWarn('watch', '公开页面 URL 命中登录/挑战路径且无法可靠分类（unavailable）');
      return failure('unavailable', true, null, 'suspicious');
    }
    if (fetched.kind !== 'ok' || !Buffer.isBuffer(fetched.body)) {
      return failure('unavailable', true, null, 'internal');
    }
    let contentTypeCharset: string | null = null;
    if (typeof meta.contentType === 'string') {
      const m = /;\s*charset=([^;\s]+)/i.exec(meta.contentType);
      if (m !== null) contentTypeCharset = m[1]!;
    }
    const html = readPublicHtml(fetched.body, meta.finalUrl, { contentTypeCharset });
    if (!html.ok) {
      return failure(html.health, FAILED_IMMEDIATE.has(html.health) ? false : true, null, 'parse');
    }
    const channelsOk = validateDocumentChannels(html.channels);
    if (!channelsOk.ok) {
      return failure('parse_changed', false, null, 'parse');
    }
    return this.projectAndReturn(
      input,
      'public',
      channelsOk.channels,
      meta.finalUrl,
      meta.fetchedAt,
      null,
    );
  }

  // -------------------------------------------------------------------------
  // session 路径：consent → host gate → task Tab → Reader → 复验 → 清理 → Projector
  // -------------------------------------------------------------------------

  private async acquireSession(
    input: PageAcquisitionInput,
    target: PageTarget,
  ): Promise<PageAcquisitionResult> {
    // 1. consent/授权一致性（零 Tab、零网络）
    const consentCheck = sessionConsentTargetCheck(target);
    if (!consentCheck.ok) {
      const disposition =
        consentCheck.health === 'login_required'
          ? consentCheck.reason === 'consent-missing'
            ? 'consent-missing'
            : 'consent-mismatch'
          : 'origin-mismatch';
      return failure(
        consentCheck.health === 'login_required' ? 'login_required' : 'security_rejected',
        false,
        null,
        disposition,
      );
    }

    // 2. 一次性冻结 attempt deadline（不可再重新计算；禁止 retry/poll 续杯）
    const nowMs = this.clock.now().getTime();
    const attemptDeadline = freezeAttemptDeadline(nowMs, input.deadline);
    const deadlineMs = attemptDeadline.getTime();

    // 3. host gate：createTab(pageUrl) 前必须取得（public/session 共享同一注册表）
    const hostKey = sessionHostKey(target.pageUrl);
    if (hostKey === null) {
      return failure('security_rejected', false, null, 'invalid-target');
    }
    const gate = await this.hostGate.acquire(hostKey, {
      signal: input.signal,
      deadlineMs,
    });
    if (!gate.ok) {
      return failure('unavailable', true, null, gate.reason === 'aborted' ? 'aborted' : 'timeout');
    }

    // 4. 精确 task Tab（全新、provisional 所有权 + 焦点三态）
    const acquired = await this.workspace.acquire(target.pageUrl, input.signal);
    if (!acquired.ok) {
      switch (acquired.errorCode) {
        case 'tab-create-aborted':
          return failure('unavailable', true, null, 'aborted');
        case 'workspace-busy':
        case 'invalid-url':
        case 'tab-create-failed':
        case 'tab-closed-by-user':
        case 'tab-restore-focus-failed':
          return failure('unavailable', true, null, 'workspace-failed');
        case 'cleanup-failed':
          return failure('dependency_unavailable', false, null, 'cleanup-failed');
        default:
          return failure('unavailable', true, null, 'workspace-failed');
      }
    }
    const tabId = acquired.lease.tabId;
    let releaseAttempted = false;
    try {
      // 5. ready → 实时 snapshot → 后置复验（Reader 内部完成）
      const read = await this.reader.read({
        tabId,
        signal: input.signal,
        deadline: attemptDeadline,
      });
      if (!read.ok) {
        return this.mapReadFailure(read.code, read.suspicion);
      }
      // 6. final URL / origin / locator 复验 + challenge 分类
      const classification = this.classifySessionPage(target, read.meta.url, read.suspicion);
      if (classification !== null) return classification;
      // 7. 先精确清理，再形成 Projection（清理失败 → 零 Projection + Watch unavailable）
      releaseAttempted = true;
      const released = await this.workspace.release(tabId);
      if (!released.ok) {
        return failure('dependency_unavailable', false, null, 'cleanup-failed');
      }
      if (released.userClosed) {
        return failure('unavailable', true, null, 'tab-closed-by-user');
      }
      return this.projectAndReturn(
        input,
        'session',
        read.channels,
        read.meta.url,
        read.meta.capturedAt,
        read.meta.documentId,
      );
    } finally {
      // 失败路径（read/classification/project 前）尽力精确清理：仅当主路径尚未
      // 发起 release 时才重试（避免对同一 close 失败重复 closeTab/重复
      // markUnavailable）；清理失败由 release 分支负责标记不可用。
      if (!releaseAttempted && this.workspace.isOwned(tabId)) {
        const released = await this.workspace.release(tabId);
        if (!released.ok) {
          logWarn('watch', 'Session attempt 异常路径清理失败（所有权保留，Watch 不可用）');
        }
      }
    }
  }

  /** 最终 URL/consent origin/locator/challenge 组合判定（session）。 */
  private classifySessionPage(
    target: PageTarget,
    finalUrl: string,
    suspicion: SnapshotSuspicion | null,
  ): PageAcquisitionResult | null {
    if (
      finalUrl === '' ||
      finalUrl.startsWith('chrome-error://') ||
      finalUrl.startsWith('chrome://error')
    ) {
      return failure('unavailable', true, null, 'tab-error');
    }
    const finalOrigin = urlOrigin(finalUrl);
    if (finalOrigin === null) {
      return failure('security_rejected', false, null, 'security');
    }
    // 跨 origin：安全拒绝（Session 登录态绝不跨源投影）
    const consentOrigin = urlOrigin(target.sessionConsent!.origin);
    if (consentOrigin === null || finalOrigin !== consentOrigin) {
      return failure('security_rejected', false, null, 'origin-mismatch');
    }
    if (suspicion === 'login') {
      return failure('login_required', false, null, 'login');
    }
    if (suspicion === 'captcha') {
      return failure('captcha', false, null, 'captcha');
    }
    if (suspicion === 'unknown') {
      return failure('unavailable', true, null, 'suspicious');
    }
    // 同 origin 但 locator 改变：source-changed disposition（零自动改 Rule）
    const finalKey = pageLocatorKey(finalUrl);
    const pageKey = pageLocatorKey(target.pageUrl);
    if (finalKey === null || pageKey === null || finalKey !== pageKey) {
      return failure('parse_changed', false, null, 'source-changed');
    }
    return null;
  }

  private mapReadFailure(
    code: string,
    suspicion: SnapshotSuspicion | undefined,
  ): PageAcquisitionResult {
    switch (code) {
      case 'aborted':
        return failure('unavailable', true, null, 'aborted');
      case 'timeout':
        return failure('unavailable', true, null, 'timeout');
      case 'tab-error':
        return failure('unavailable', true, null, 'tab-error');
      case 'tab-missing':
        return failure('unavailable', true, null, 'tab-missing');
      case 'tab-closed-by-user':
        return failure('unavailable', true, null, 'tab-closed-by-user');
      case 'snapshot-degraded':
        if (suspicion === 'captcha') return failure('captcha', false, null, 'captcha');
        if (suspicion === 'login') return failure('login_required', false, null, 'login');
        if (suspicion === 'unknown') return failure('unavailable', true, null, 'suspicious');
        return failure('unavailable', true, null, 'snapshot-invalid');
      case 'snapshot-null':
      case 'snapshot-invalid':
        if (suspicion === 'captcha') return failure('captcha', false, null, 'captcha');
        if (suspicion === 'login') return failure('login_required', false, null, 'login');
        if (suspicion === 'unknown') return failure('unavailable', true, null, 'suspicious');
        return failure('unavailable', true, null, 'snapshot-invalid');
      case 'internal':
        return failure('unavailable', true, null, 'internal');
      default:
        return failure('unavailable', true, null, 'internal');
    }
  }

  private projectAndReturn(
    input: PageAcquisitionInput,
    accessMode: WatchAccessMode,
    channels: import('../../shared/types/watch').DocumentChannels,
    finalUrl: string,
    capturedAt: string,
    documentId: string | null,
  ): PageAcquisitionResult {
    const projected: PageProjectionResult = projectPageProjection({
      channels,
      regions: input.target.regions,
      ruleId: input.ruleId,
      sourceId: input.sourceId,
      finalUrl,
      capturedAt,
      documentId,
    });
    if (!projected.ok) {
      switch (projected.health) {
        case 'budget_exceeded':
          return failure('budget_exceeded', false, null, 'budget');
        case 'security_rejected':
          return failure('security_rejected', false, null, 'security');
        case 'unavailable':
          return failure('unavailable', true, null, 'snapshot-invalid');
        case 'parse_changed':
        default:
          return failure('parse_changed', false, null, 'parse');
      }
    }
    logInfo(
      'watch',
      `页面采集成功（mode=${accessMode}，rule=${input.ruleId}，bytes=${projected.projection.byteLength}）`,
    );
    return {
      ok: true,
      projection: projected.projection,
      accessMode,
      expectedSourceLocatorFingerprint: input.sourceLocatorFingerprint,
    };
  }
}

/**
 * Session 顶层导航 hostKey（§4.3）：与 PublicWatchHttpClient 共用同一
 * `host:effectivePort` 注册表；session 页面允许任意显式端口（dev/内网），
 * 因此不能使用仅 80/443 的 deriveHostKey，按同一键形状派生。
 */
export function sessionHostKey(pageUrl: string): string | null {
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username !== '' || parsed.password !== '') return null;
    const effectivePort =
      parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
    if (!Number.isInteger(effectivePort) || effectivePort <= 0 || effectivePort > 65535) {
      return null;
    }
    return `${parsed.hostname.toLowerCase()}:${effectivePort}`;
  } catch {
    return null;
  }
}
