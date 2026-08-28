// D3 public-watch-http-client: 仅公网 GET/HEAD 的有界 HTTP 客户端（detailed-design §6.1/§6.2 R2）。
// - 唯一产品构造入口 createPublicWatchHttpStack(...)：模块内部装配 raw transport → RobotsPolicy →
//   target-gated client。raw transport/client、其 constructor 与任意 URL test seam 均不导出；
//   调用方只能获得 target-gated 能力与 RobotsPolicy 生命周期窄端口。
// - page/feed/discovery 必经 RobotsPolicy；robots 初始 URL 只由目标 canonical authority 派生为
//   无 query/fragment 的 /robots.txt；伪造 purpose=robots + 任意 host/path/query/method 在
//   URL 解析/DNS/request factory/socket 前 security_rejected。缺 gate fail-closed。
// - 单资源总 deadline：入口一次性冻结 min(start+30s, externalDeadline)，DNS/robots/全部候选地址/
//   redirect/body 共用；每个等待点只用剩余时间，任何路径不续杯；第一个终态胜出，迟到事件零改终态。
// - URL/IP/DNS/redirect/downgrade 每跳复验；连接时自定义 lookup 只把已批准地址交给 socket。
// - 压缩字节与解压后字节双硬上限，超限立即 destroy；304 映射 unchanged-http；零 Cookie/Proxy。
import { promises as dns } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import {
  MAX_DISCOVERY_HTML_BYTES,
  MAX_FEED_RESPONSE_BYTES,
  MAX_PAGE_HTML_RESPONSE_BYTES,
  MAX_REDIRECTS,
  MAX_ROBOTS_RESPONSE_BYTES,
  NETWORK_ATTEMPT_TIMEOUT_MS,
  type Clock,
  type WatchFailureCode,
} from '../../shared/types/watch';
import { isAllowedPublicAddress, validatePublicUrl, type ApprovedTarget } from './network-policy';
import { RobotsPolicy } from './robots-policy';

export type PublicRequestPurpose = 'feed' | 'page' | 'robots' | 'discovery';

/** target-gated 公开入口只允许 page/feed/discovery；robots 由工厂内部派生，purpose 不是权限令牌。 */
export type TargetPurpose = 'feed' | 'page' | 'discovery';

/** raw（内部）请求；purpose='robots' 只能由 RobotsPolicy 内部发起。 */
export interface PublicRequest {
  url: string; // 调用者已校验/预校验的输入 URL
  purpose: PublicRequestPurpose;
  etag?: string | null; // 条件请求 If-None-Match
  lastModified?: string | null; // 条件请求 If-Modified-Since
  signal?: AbortSignal;
  deadline?: Date; // 绝对截止；超时受控失败
}

/** target-gated 公开请求：purpose 闭合为 feed/page/discovery。 */
export interface TargetRequest {
  url: string;
  purpose: TargetPurpose;
  etag?: string | null;
  lastModified?: string | null;
  signal?: AbortSignal;
  deadline?: Date;
}

export interface PublicResponseMeta {
  finalUrl: string; // 跟随 redirect 后的最终规范化 URL（主进程记录）
  statusCode: number;
  statusMessage: string;
  contentType: string | null;
  contentEncoding: string | null;
  etag: string | null;
  lastModified: string | null;
  retryAfter: number | null; // 秒数（存在时）
  fetchedAt: string; // ISO 8601
  byteLength: number; // 解压后（或 identity）正文字节数；HEAD 为 0
  compressedByteLength: number; // 传输压缩字节数；identity 与正文相同
}

export interface PublicFetchOk {
  kind: 'ok';
  meta: PublicResponseMeta;
  body: Buffer; // HEAD 时为空 Buffer
}

export type PublicFetchResult =
  | PublicFetchOk
  | { kind: 'unchanged-http'; meta: PublicResponseMeta }
  | { kind: 'aborted' }
  | {
      kind: 'failed';
      health: Extract<
        WatchFailureCode,
        | 'security_rejected'
        | 'budget_exceeded'
        | 'unavailable'
        | 'parse_changed'
        | 'robots_disallowed'
      >;
      reason: string;
    };

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** 每跳 robots 决策（窄端口：raw 客户端在发起 socket 前咨询；模块内私有，不导出）。 */
type RobotsGateDecision =
  | { kind: 'allowed' }
  | { kind: 'disallowed' }
  | { kind: 'unavailable' }
  | { kind: 'security-rejected' }
  | { kind: 'aborted' };

/** raw 客户端咨询 robots 的窄端口（模块内私有：安全工厂内部装配真实 RobotsPolicy 后注入）。 */
interface RobotsGatePort {
  checkAllowed(input: {
    url: string;
    signal?: AbortSignal;
    deadline?: Date;
  }): Promise<RobotsGateDecision>;
}

// ---------------------------------------------------------------------------
// 受控 seam 类型（测试注入；默认接真实 node:http/https + node:dns）
// ---------------------------------------------------------------------------

/** 压缩解压器窄 seam 返回对象（真实 zlib Gunzip/Inflate/BrotliDecompress 天然满足）。 */
export interface WatchInflaterLike {
  write(chunk: Buffer): boolean;
  end(): void;
  destroy(): void;
  destroyed: boolean;
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  on(event: 'end', cb: () => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  removeListener(event: 'data', cb: (chunk: Buffer) => void): unknown;
  removeListener(event: 'end', cb: () => void): unknown;
  removeListener(event: 'error', cb: (err: Error) => void): unknown;
  removeAllListeners(): unknown;
}

export interface WatchIncomingLike {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  on(event: 'end', cb: () => void): unknown;
  on(event: 'aborted', cb: () => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  removeListener(event: 'data', cb: (chunk: Buffer) => void): unknown;
  removeListener(event: 'end', cb: () => void): unknown;
  removeListener(event: 'aborted', cb: () => void): unknown;
  removeListener(event: 'error', cb: (err: Error) => void): unknown;
  removeListener(event: 'close', cb: () => void): unknown;
  resume?(): unknown;
  destroy?(error?: Error): void;
}

export interface WatchRequestLike {
  on(event: 'response', cb: (res: WatchIncomingLike) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'timeout', cb: () => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  removeListener(event: 'response', cb: (res: WatchIncomingLike) => void): unknown;
  removeListener(event: 'error', cb: (err: Error) => void): unknown;
  removeListener(event: 'timeout', cb: () => void): unknown;
  removeListener(event: 'close', cb: () => void): unknown;
  setTimeout(ms: number): unknown;
  end(): void;
  abort(): void;
  destroy(error?: Error): void;
}

export type WatchLookupFn = (
  hostname: string,
  options: unknown,
  callback: (
    err: Error | null,
    address: string | { address: string; family: number }[],
    family?: number,
  ) => void,
) => void;

export interface WatchRequestOptions {
  method: 'GET' | 'HEAD';
  protocol: 'http:' | 'https:';
  hostname: string;
  port: number;
  path: string;
  headers: Record<string, string>;
  lookup: WatchLookupFn;
}

export type WatchRequestFactory = (options: WatchRequestOptions) => WatchRequestLike;

/** 安全工厂受控 seam（只注入依赖，不能取得任意网络客户端或替换/关闭 RobotsPolicy）。 */
export interface PublicWatchStackSeams {
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>; // 默认真实 dns.lookup(all)
  request?: WatchRequestFactory; // 默认 node:http/https
  clock?: Clock; // 默认系统时钟；deadline 判定
  timeoutMs?: number; // 默认 NETWORK_ATTEMPT_TIMEOUT_MS（内部总预算）
  userAgent?: string; // 默认产品版本化 UA（不含账号/机器 ID）
  robotsCacheMs?: number; // RobotsPolicy 缓存时长（默认 24h）
  uaProduct?: string; // robots UA product token（默认 aibrowse）
  createInflater?: (
    encoding: 'gzip' | 'deflate' | 'br',
    maxOutputLength: number,
  ) => WatchInflaterLike; // 压缩解压器工厂（默认 node:zlib；只影响 body 解压，不改变安全装配）
}

/** target-gated client：只允许 page/feed/discovery。 */
export interface TargetGatedClient {
  get(req: TargetRequest): Promise<PublicFetchResult>;
  head(req: TargetRequest): Promise<PublicFetchResult>;
}

/** 工厂返回：target-gated 能力 + RobotsPolicy 生命周期窄端口。 */
export interface PublicWatchStack {
  target: TargetGatedClient;
  robots: { clearCache(): void };
}

// ---------------------------------------------------------------------------
// 常量与预算表（单一事实源：src/shared/types/watch.ts；robots 独立 512,000-byte 预算）
// ---------------------------------------------------------------------------

export const WATCH_DEFAULT_USER_AGENT =
  'AIbrowse/0.1.0 (Watch; +https://gitee.com/Molotov0coaktail/aibrowse)';

const PURPOSE_MAX_BYTES: Record<PublicRequestPurpose, number> = {
  feed: MAX_FEED_RESPONSE_BYTES,
  page: MAX_PAGE_HTML_RESPONSE_BYTES,
  discovery: MAX_DISCOVERY_HTML_BYTES,
  robots: MAX_ROBOTS_RESPONSE_BYTES,
};

const PURPOSE_ACCEPT: Record<PublicRequestPurpose, string> = {
  feed: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
  page: 'text/html, application/xhtml+xml, */*;q=0.5',
  discovery: 'text/html, application/xhtml+xml, */*;q=0.5',
  robots: 'text/plain, */*;q=0.5',
};

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const CONNECT_RETRYABLE = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'EADDRNOTAVAIL',
]);

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const direct = headers[name];
  if (direct !== undefined) {
    return Array.isArray(direct) ? (direct.length > 0 ? String(direct[0]) : null) : String(direct);
  }
  const lower = headers[name.toLowerCase()];
  if (lower !== undefined) {
    return Array.isArray(lower) ? (lower.length > 0 ? String(lower[0]) : null) : String(lower);
  }
  return null;
}

function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    return Math.max(0, Math.ceil((parsed - nowMs) / 1000));
  }
  return null;
}

function createSystemClock(): Clock {
  return {
    now: () => new Date(),
    setTimeout: (cb, ms) => ({
      kind: 'timer' as const,
      id: Number(globalThis.setTimeout(cb, ms)),
    }),
    clearTimeout: (h) =>
      globalThis.clearTimeout(h.id as unknown as Parameters<typeof globalThis.clearTimeout>[0]),
  };
}

type ClientHealth = Extract<
  WatchFailureCode,
  'security_rejected' | 'budget_exceeded' | 'unavailable' | 'parse_changed' | 'robots_disallowed'
>;

type InternalAttempt =
  | { kind: 'ok'; meta: PublicResponseMeta; body: Buffer }
  | { kind: 'redirect'; location: string }
  | { kind: 'conn-error'; code: string }
  | { kind: 'failed'; health: ClientHealth; reason: string }
  | { kind: 'aborted' };

/** DNS 竞争哨兵：区分 abort / timeout / lookup 自身失败。 */
const DNS_ABORTED = Symbol('dns-aborted');
const DNS_TIMEOUT = Symbol('dns-timeout');
const DNS_ERROR = Symbol('dns-error');

// ---------------------------------------------------------------------------
// emitter-local transport drain（#S6-043 两阶段协议；模块私有，不导出）
// ---------------------------------------------------------------------------
// 两类 drain 都不是业务 listener，也不参与 Promise settlement：
// - error sink 从安装起对所属 emitter 的所有 error 都无条件 no-op，不读取 settlement；
// - close cleanup 幂等移除本 emitter 的 error sink + close listener，每次 removeListener
//   单独 try/catch（一个 remove 抛错不形成 uncaught exception、不阻止另一个清理）；
// - 两个 callback 只闭包所属 emitter 与彼此，不捕获 settlement/业务结果/timer/AbortSignal/
//   body buffer/inflater/另一 emitter/process 或全局 registry/listener；
// - close 永不到达时仅该 emitter 自包含 drain pair 可随不可达 transport 对象 GC。

/** ClientRequest 创建成功后立即安装的 request drain pair。 */
function installRequestDrain(req: WatchRequestLike): void {
  const requestErrorDrain = (err: NodeJS.ErrnoException): void => {
    void err; // 无条件 no-op
  };
  const requestCloseCleanup = (): void => {
    try {
      req.removeListener('error', requestErrorDrain);
    } catch {
      // 单项异常隔离
    }
    try {
      req.removeListener('close', requestCloseCleanup);
    } catch {
      // 单项异常隔离
    }
  };
  req.on('error', requestErrorDrain);
  req.on('close', requestCloseCleanup);
}

/** 每个 IncomingMessage 一经交付、接入任何 body reader/discard/destroy/resume 前安装的 response drain pair。 */
function installResponseDrain(res: WatchIncomingLike): void {
  const responseErrorDrain = (err: Error): void => {
    void err; // 无条件 no-op
  };
  const responseCloseCleanup = (): void => {
    try {
      res.removeListener('error', responseErrorDrain);
    } catch {
      // 单项异常隔离
    }
    try {
      res.removeListener('close', responseCloseCleanup);
    } catch {
      // 单项异常隔离
    }
  };
  res.on('error', responseErrorDrain);
  res.on('close', responseCloseCleanup);
}

/**
 * raw transport（模块私有，不导出）：任意目的 GET/HEAD，每跳 NetworkPolicy + robots gate。
 * 单资源总 deadline 在 run() 入口冻结；purpose='robots' 携带的 Date deadline 视为继承的绝对截止
 * （不重新冻结内部 30 秒），因此 robots 子请求共享外层同一 effectiveDeadline。
 */
class PublicWatchHttpClient {
  private readonly lookup: (hostname: string) => Promise<ResolvedAddress[]>;
  private readonly requestFactory: WatchRequestFactory;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly createInflater: (
    encoding: 'gzip' | 'deflate' | 'br',
    maxOutputLength: number,
  ) => WatchInflaterLike;
  private readonly robots: RobotsGatePort | null;

  constructor(
    seams: {
      lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
      request?: WatchRequestFactory;
      clock?: Clock;
      timeoutMs?: number;
      userAgent?: string;
      createInflater?: (
        encoding: 'gzip' | 'deflate' | 'br',
        maxOutputLength: number,
      ) => WatchInflaterLike;
      robots?: RobotsGatePort | null;
    } = {},
  ) {
    this.lookup =
      seams.lookup ??
      (async (hostname: string): Promise<ResolvedAddress[]> => {
        const records = await dns.lookup(hostname, { all: true, verbatim: true });
        return records.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
      });
    this.requestFactory = seams.request ?? this.defaultRequestFactory;
    this.clock = seams.clock ?? createSystemClock();
    this.timeoutMs = seams.timeoutMs ?? NETWORK_ATTEMPT_TIMEOUT_MS;
    this.userAgent = seams.userAgent ?? WATCH_DEFAULT_USER_AGENT;
    this.createInflater =
      seams.createInflater ??
      ((encoding, maxOutputLength): WatchInflaterLike => {
        if (encoding === 'gzip') return createGunzip({ maxOutputLength });
        if (encoding === 'deflate') return createInflate({ maxOutputLength });
        return createBrotliDecompress({ maxOutputLength });
      });
    this.robots = seams.robots ?? null;
  }

  private defaultRequestFactory: WatchRequestFactory = (options) => {
    const req = options.protocol === 'https:' ? httpsRequest(options) : httpRequest(options);
    return req as unknown as WatchRequestLike;
  };

  head(req: PublicRequest): Promise<PublicFetchResult> {
    return this.run('HEAD', req);
  }

  get(req: PublicRequest): Promise<PublicFetchResult> {
    return this.run('GET', req);
  }

  private failedResult(health: ClientHealth, reason: string): PublicFetchResult {
    return { kind: 'failed', health, reason };
  }

  private async run(method: 'GET' | 'HEAD', req: PublicRequest): Promise<PublicFetchResult> {
    // 缺 gate 的 page/feed/discovery 在 URL/DNS/request factory/socket 前 fail-closed
    if (this.robots === null && req.purpose !== 'robots') {
      return this.failedResult('unavailable', 'robots-gate-missing');
    }
    const startedAt = this.clock.now().getTime();
    let effectiveDeadline: number;
    if (
      req.purpose === 'robots' &&
      req.deadline instanceof Date &&
      Number.isFinite(req.deadline.getTime())
    ) {
      // 嵌套 robots 子请求：继承外层绝对截止，不重新冻结内部 30 秒
      effectiveDeadline = req.deadline.getTime();
    } else if (req.deadline instanceof Date) {
      const ext = req.deadline.getTime();
      if (!Number.isFinite(ext)) {
        // Invalid Date：零 DNS、零 socket
        return this.failedResult('unavailable', 'invalid-deadline');
      }
      if (ext <= startedAt) {
        // 已过期：零 DNS、零 socket
        return this.failedResult('unavailable', 'deadline-expired');
      }
      effectiveDeadline = Math.min(startedAt + this.timeoutMs, ext);
    } else {
      effectiveDeadline = startedAt + this.timeoutMs;
    }

    let url = req.url;
    let hops = 0;
    for (;;) {
      if (this.clock.now().getTime() >= effectiveDeadline) {
        return this.failedResult('unavailable', 'deadline');
      }
      const attempt = await this.attemptOnce(method, req, url, effectiveDeadline);
      if (attempt.kind === 'aborted') return { kind: 'aborted' };
      if (attempt.kind === 'conn-error') {
        return this.failedResult('unavailable', attempt.code);
      }
      if (attempt.kind === 'failed') {
        return { kind: 'failed', health: attempt.health, reason: attempt.reason };
      }
      if (attempt.kind === 'redirect') {
        if (hops >= MAX_REDIRECTS) {
          return this.failedResult('security_rejected', 'redirect-limit');
        }
        hops += 1;
        url = attempt.location;
        continue;
      }
      if (attempt.meta.statusCode === 304) {
        return { kind: 'unchanged-http', meta: attempt.meta };
      }
      return { kind: 'ok', meta: attempt.meta, body: attempt.body };
    }
  }

  private async attemptOnce(
    method: 'GET' | 'HEAD',
    req: PublicRequest,
    url: string,
    deadlineMs: number,
  ): Promise<InternalAttempt> {
    const base = validatePublicUrl(url);
    if (!base.ok) {
      return this.failed('security_rejected', base.reason);
    }
    const target = base.target;

    if (this.clock.now().getTime() >= deadlineMs) {
      return this.failed('unavailable', 'deadline');
    }
    if (req.signal?.aborted) {
      return { kind: 'aborted' };
    }

    // 每跳 robots 决策（§6.2：每个实际 host 在发起 socket 前完成）；robots 请求自身跳过。
    // 传入同一 absolute effectiveDeadline，robots 子请求共享且不续杯。
    if (this.robots !== null && req.purpose !== 'robots') {
      let decision: RobotsGateDecision;
      try {
        decision = await this.robots.checkAllowed({
          url: target.url,
          signal: req.signal,
          deadline: new Date(deadlineMs),
        });
      } catch {
        return this.failed('unavailable', 'robots-error');
      }
      switch (decision.kind) {
        case 'allowed':
          break;
        case 'aborted':
          return { kind: 'aborted' };
        case 'disallowed':
          return this.failed('robots_disallowed', 'robots-disallowed');
        case 'unavailable':
          return this.failed('unavailable', 'robots-unavailable');
        case 'security-rejected':
          return this.failed('security_rejected', 'robots-security');
      }
    }

    if (this.clock.now().getTime() >= deadlineMs) {
      return this.failed('unavailable', 'deadline');
    }
    if (req.signal?.aborted) {
      return { kind: 'aborted' };
    }

    let addresses: ResolvedAddress[];
    try {
      addresses = await this.lookupWithTimeout(target.host, deadlineMs, req.signal);
    } catch (err) {
      if (err === DNS_ABORTED) return { kind: 'aborted' };
      if (err === DNS_TIMEOUT) return this.failed('unavailable', 'dns-timeout');
      return this.failed('unavailable', 'dns-failed');
    }
    if (addresses.length === 0) {
      return this.failed('unavailable', 'no-addresses');
    }
    // 全部候选必须为允许的公网 unicast；任一非公网（含公私混合）整次拒绝
    for (const a of addresses) {
      if (!isAllowedPublicAddress(a.address)) {
        return this.failed('security_rejected', 'address-not-public');
      }
    }

    if (this.clock.now().getTime() >= deadlineMs) {
      return this.failed('unavailable', 'deadline');
    }
    if (req.signal?.aborted) {
      return { kind: 'aborted' };
    }

    let lastConnError: string | null = null;
    for (const addr of addresses) {
      const result = await this.attemptAddress(method, req, target, addr, deadlineMs);
      if (result === 'retry-next') {
        lastConnError = 'connect-failed';
        continue;
      }
      if (result === 'aborted') return { kind: 'aborted' };
      if (result === 'failed') return this.failed('unavailable', 'connect-failed');
      return result;
    }
    return this.failed('unavailable', lastConnError ?? 'connect-failed');
  }

  /**
   * DNS lookup 与 remaining deadline、abort 竞争：永不返回的 DNS 也必须按时结束；
   * timer 只能设为 remaining（不续杯）。lookup 同步 throw 同样转为受控失败。
   */
  private lookupWithTimeout(
    hostname: string,
    deadlineMs: number,
    signal: AbortSignal | undefined,
  ): Promise<ResolvedAddress[]> {
    return new Promise<ResolvedAddress[]>((resolve, reject) => {
      let settled = false;
      const timers: ReturnType<Clock['setTimeout']>[] = [];
      const cleanup = (): void => {
        for (const t of timers) {
          try {
            this.clock.clearTimeout(t);
          } catch {
            // 单项失败继续剩余清理
          }
        }
        if (signal) {
          try {
            signal.removeEventListener('abort', onAbort);
          } catch {
            // 单项失败继续剩余清理
          }
        }
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(DNS_ABORTED);
      };
      const fail = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(DNS_TIMEOUT);
      };
      const succeed = (records: ResolvedAddress[]): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(records);
      };
      const failError = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(DNS_ERROR);
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const remaining = deadlineMs - this.clock.now().getTime();
      if (remaining <= 0) {
        cleanup();
        reject(DNS_TIMEOUT);
        return;
      }
      timers.push(this.clock.setTimeout(fail, remaining));

      let lookupPromise: Promise<ResolvedAddress[]>;
      try {
        lookupPromise = Promise.resolve(this.lookup(hostname));
      } catch {
        failError();
        return;
      }
      lookupPromise.then(succeed, failError);
    });
  }

  private failed(health: ClientHealth, reason: string): InternalAttempt {
    return { kind: 'failed', health, reason };
  }

  private async attemptAddress(
    method: 'GET' | 'HEAD',
    req: PublicRequest,
    target: ApprovedTarget,
    addr: ResolvedAddress,
    deadlineMs: number,
  ): Promise<InternalAttempt | 'retry-next' | 'aborted' | 'failed'> {
    const parsed = new URL(target.url);
    const path = `${parsed.pathname}${parsed.search}`;
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: PURPOSE_ACCEPT[req.purpose],
      'Accept-Encoding': 'gzip, deflate, br',
    };
    if (req.etag && req.etag.length > 0) headers['If-None-Match'] = req.etag;
    if (req.lastModified && req.lastModified.length > 0)
      headers['If-Modified-Since'] = req.lastModified;

    const sealedLookup: WatchLookupFn = (hostname, options, callback) => {
      void hostname;
      const all =
        typeof options === 'object' &&
        options !== null &&
        (options as { all?: boolean }).all === true;
      if (all) {
        // 数组形态：只交付已批准地址（单元素）
        callback(null, [{ address: addr.address, family: addr.family }]);
      } else {
        callback(null, addr.address, addr.family);
      }
    };

    return new Promise<InternalAttempt | 'retry-next' | 'aborted' | 'failed'>((resolve) => {
      let settled = false;
      let aborted = false;
      let request: WatchRequestLike | null = null;
      let response: WatchIncomingLike | null = null;
      let inflater: WatchInflaterLike | null = null;
      let timeoutHandle: ReturnType<Clock['setTimeout']> | null = null;
      // 正文 reader 的幂等 release handle：deadline/abort 直接调用，不等迟到事件。
      let releaseBody: (() => void) | null = null;
      // onResponse 自移除用：request 构造完成后指向同一 request 对象；cleanup 返回前置 null。
      let guardRequest: WatchRequestLike | null = null;

      // 外层 settlement 信号：readBoundedBody 据此拒绝迟到 chunk/end/error 的一切副作用。
      const isOuterSettled = (): boolean => settled;

      const finish = (value: InternalAttempt | 'retry-next' | 'aborted' | 'failed'): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      // 统一、幂等的首终态 cleanup：无论 success/deadline/abort/budget/stream-error/request-error，
      // 立即清除全部 timer/AbortSignal listener、释放正文 reader、销毁 request/response/inflater，
      // 并无条件移除 request 的业务 response/error/timeout listener；requestErrorDrain 与
      // requestCloseCleanup 按 #S6-043 两阶段协议保留至 request close，不在此移除。
      // 每一步单独异常隔离：任一 remove/destroy/clear 抛错不得阻止剩余清理。cleanup 返回时
      // request 的业务 response/error/timeout listener 必为 0；全部 request listener（含 drain）
      // 只有在 request close 之后才能断言为零（由 requestCloseCleanup 自清理）。
      const cleanup = (): void => {
        if (timeoutHandle !== null) {
          try {
            this.clock.clearTimeout(timeoutHandle);
          } catch {
            // 单项失败继续剩余清理
          }
          timeoutHandle = null;
        }
        if (req.signal) {
          try {
            req.signal.removeEventListener('abort', onAbort);
          } catch {
            // 单项失败继续剩余清理
          }
        }
        if (releaseBody !== null) {
          try {
            releaseBody();
          } catch {
            // 单项失败继续剩余清理
          }
          releaseBody = null;
        }
        if (inflater !== null) {
          try {
            inflater.removeAllListeners();
          } catch {
            // 幂等
          }
          try {
            inflater.destroy();
          } catch {
            // 幂等
          }
          inflater = null;
        }
        if (response !== null) {
          try {
            response.destroy?.();
          } catch {
            // 幂等
          }
          response = null;
        }
        if (request !== null) {
          // #S6-043：先移除全部 request 业务 listener（response/error/timeout）；
          // request drain（error sink + close cleanup）保留至 request close，不在此移除。
          try {
            request.removeListener('error', onRequestError);
          } catch {
            // 幂等
          }
          try {
            request.removeListener('timeout', onRequestTimeout);
          } catch {
            // 幂等
          }
          try {
            request.removeListener('response', onResponse);
          } catch {
            // 幂等
          }
          // 调用栈 discard guard：先安装再 destroy/abort fallback，finally 必移除，
          // 且必须在业务 Promise 结算前归零。request.destroy() 同步抛错至多一次受控
          // abort fallback，fallback 返回或抛错后立即结算；二者都不等待 close。
          try {
            request.on('response', onGuardResponse);
          } catch {
            // 幂等
          }
          try {
            request.destroy();
          } catch {
            try {
              request.abort();
            } catch {
              // 幂等
            }
          } finally {
            try {
              request.removeListener('response', onGuardResponse);
            } catch {
              // 幂等
            }
          }
          request = null;
        }
        guardRequest = null;
      };

      const onAbort = (): void => {
        aborted = true;
        finish('aborted');
      };

      // request 级 timeout（transport 若在绝对截止前自行报超时，同样受控 deadline 失败）。
      const onRequestTimeout = (): void => {
        if (settled || aborted) return;
        finish(this.failed('unavailable', 'deadline'));
      };

      const onRequestError = (err: NodeJS.ErrnoException): void => {
        if (settled || aborted) return;
        const code = err.code ?? 'ERR';
        if (CONNECT_RETRYABLE.has(code)) {
          finish('retry-next');
          return;
        }
        finish(this.failed('unavailable', code));
      };

      // 调用栈 discard guard（#S6-043）：只覆盖 request.destroy()/abort fallback 调用栈内
      // 同步发出的 response；finally 必移除，跨事件轮不保留。收到 response 先安装其自身
      // response drain，再 destroy；仅 destroy 缺失或同步抛错时 resume。零 body reader/inflater。
      const onGuardResponse = (res: WatchIncomingLike): void => {
        try {
          activeRequest.removeListener('response', onGuardResponse);
        } catch {
          // 幂等
        }
        installResponseDrain(res);
        if (typeof res.destroy === 'function') {
          try {
            res.destroy();
            return;
          } catch {
            // 降级排空
          }
        }
        try {
          res.resume?.();
        } catch {
          // 幂等
        }
      };

      // 不消费的响应（redirect/HEAD/3xx 无 Location/迟到 response）：立即安全销毁；
      // response drain 必须已由调用方（onResponse/call-stack guard）先安装；此处只负责
      // destroy，或 destroy 缺失/同步抛错时的受控 resume 排空。各项分别异常隔离。
      const safeDiscardResponse = (res: WatchIncomingLike): void => {
        if (typeof res.destroy === 'function') {
          try {
            res.destroy();
            return;
          } catch {
            // 降级排空
          }
        }
        try {
          res.resume?.();
        } catch {
          // 幂等
        }
      };

      const onResponse = (res: WatchIncomingLike): void => {
        // 每个 request 至多一个 response；正常或迟到路径都在处理前自移除本守卫。
        if (guardRequest !== null) {
          try {
            guardRequest.removeListener('response', onResponse);
          } catch {
            // 幂等
          }
        }
        // #S6-043：response 一经交付，必须先安装 product-owned named response drain，
        // 再进入 body reader、discard、destroy 或 resume；drain 保留至 response close 自清理。
        installResponseDrain(res);
        if (aborted || settled) {
          // deadline/abort 先于 response：迟到 response 立即安全销毁或受控 resume，
          // 零正文 listener、零新 socket。
          safeDiscardResponse(res);
          return;
        }
        response = res;
        const statusCode = res.statusCode;
        const nowMs = this.clock.now().getTime();
        const meta: PublicResponseMeta = {
          finalUrl: target.url,
          statusCode,
          statusMessage: res.statusMessage ?? '',
          contentType: headerValue(res.headers, 'content-type'),
          contentEncoding: headerValue(res.headers, 'content-encoding'),
          etag: headerValue(res.headers, 'etag'),
          lastModified: headerValue(res.headers, 'last-modified'),
          retryAfter: parseRetryAfter(headerValue(res.headers, 'retry-after'), nowMs),
          fetchedAt: new Date(nowMs).toISOString(),
          byteLength: 0,
          compressedByteLength: 0,
        };

        if (REDIRECT_STATUS.has(statusCode)) {
          const location = headerValue(res.headers, 'location');
          if (location === null) {
            safeDiscardResponse(res);
            finish({ kind: 'ok', meta, body: Buffer.alloc(0) });
            return;
          }
          let nextUrl: URL;
          try {
            nextUrl = new URL(location, target.url);
          } catch {
            safeDiscardResponse(res);
            finish(this.failed('security_rejected', 'redirect-location'));
            return;
          }
          const validated = validatePublicUrl(nextUrl.toString());
          if (!validated.ok) {
            safeDiscardResponse(res);
            finish(this.failed('security_rejected', 'redirect-invalid'));
            return;
          }
          if (target.scheme === 'https' && validated.target.scheme === 'http') {
            safeDiscardResponse(res);
            finish(this.failed('security_rejected', 'redirect-downgrade'));
            return;
          }
          safeDiscardResponse(res);
          finish({ kind: 'redirect', location: validated.target.url });
          return;
        }

        if (method === 'HEAD') {
          safeDiscardResponse(res);
          finish({ kind: 'ok', meta, body: Buffer.alloc(0) });
          return;
        }

        // 正文读取：identity → inflater=null；压缩 → 经窄 seam 创建；未知编码 fail-closed。
        const contentEncoding = (meta.contentEncoding ?? '').trim().toLowerCase();
        const enc = contentEncoding === '' ? 'identity' : contentEncoding;
        if (enc === 'identity') {
          inflater = null;
        } else {
          const norm =
            enc === 'gzip' || enc === 'x-gzip'
              ? 'gzip'
              : enc === 'deflate'
                ? 'deflate'
                : enc === 'br'
                  ? 'br'
                  : null;
          if (norm === null) {
            safeDiscardResponse(res);
            finish(this.failed('security_rejected', 'unknown-content-encoding'));
            return;
          }
          try {
            inflater = this.createInflater(norm, PURPOSE_MAX_BYTES[req.purpose]);
          } catch {
            // inflater 工厂同步 throw：受控失败
            safeDiscardResponse(res);
            finish(this.failed('unavailable', 'inflater-factory'));
            return;
          }
        }

        const bodyReader = this.readBoundedBody(
          res,
          req,
          meta,
          deadlineMs,
          inflater,
          isOuterSettled,
        );
        releaseBody = bodyReader.release;
        bodyReader.promise
          .then((bodyResult) => {
            if (bodyResult.kind === 'failed') {
              finish(this.failed(bodyResult.health, bodyResult.reason));
              return;
            }
            finish({ kind: 'ok', meta: bodyResult.meta, body: bodyResult.body });
          })
          .catch(() => {
            finish(this.failed('unavailable', 'read-failed'));
          });
      };

      try {
        request = this.requestFactory({
          method,
          protocol: target.scheme === 'https' ? 'https:' : 'http:',
          hostname: target.host,
          port: target.port,
          path,
          headers,
          lookup: sealedLookup,
        });
      } catch {
        // requestFactory 同步 throw：受控失败，不泄漏 rejection
        finish(this.failed('unavailable', 'request-factory'));
        return;
      }
      const activeRequest = request;
      guardRequest = activeRequest;
      // #S6-043：request 创建成功后立即安装 emitter-local request drain（error sink +
      // close cleanup），在业务 listener/timer/AbortSignal 装配之前；drain 保留至 request close。
      installRequestDrain(activeRequest);

      // socket 超时只能设为 remaining（同一 absolute effectiveDeadline，不续杯）
      const remaining = deadlineMs - this.clock.now().getTime();
      if (remaining <= 0) {
        finish(this.failed('unavailable', 'deadline'));
        return;
      }
      timeoutHandle = this.clock.setTimeout(() => {
        finish(this.failed('unavailable', 'deadline'));
      }, remaining);

      if (req.signal) {
        if (req.signal.aborted) {
          finish('aborted');
          return;
        }
        req.signal.addEventListener('abort', onAbort, { once: true });
      }

      activeRequest.on('response', onResponse);
      activeRequest.on('error', onRequestError);
      activeRequest.on('timeout', onRequestTimeout);

      activeRequest.end();
    });
  }

  private readBoundedBody(
    res: WatchIncomingLike,
    req: PublicRequest,
    meta: PublicResponseMeta,
    deadlineMs: number,
    inflater: WatchInflaterLike | null,
    isOuterSettled: () => boolean,
  ): {
    promise: Promise<
      | { kind: 'ok'; meta: PublicResponseMeta; body: Buffer }
      | { kind: 'failed'; health: ClientHealth; reason: string }
    >;
    release: () => void;
  } {
    const maxBytes = PURPOSE_MAX_BYTES[req.purpose];
    let compressedBytes = 0;
    let decompressedBytes = 0;
    let finished = false;
    let released = false;
    let inflaterEnded = false;
    const buffer: Buffer[] = [];

    const deadlineExpired = (): boolean =>
      Number.isFinite(deadlineMs) && this.clock.now().getTime() >= deadlineMs;

    // 幂等释放：清除本实现注册的 res/inflater listener 并销毁 inflater。
    // attempt 首终态 cleanup 直接调用；迟到事件到达（外层已 settle 或本地已 settle）时也调用，
    // 保证首终态立即移除本实现注册的 res/inflater 业务 listener，不等迟到事件；response 的
    // product-owned drain（responseErrorDrain/responseCloseCleanup）由 response close 自清理。
    // 每个 removeListener 与 inflater.destroy 分别异常隔离：单项抛错继续剩余清理，不泄漏未处理异常。
    function release(): void {
      if (released) return;
      released = true;
      try {
        res.removeListener('data', onSourceData);
      } catch {
        // 幂等
      }
      try {
        res.removeListener('data', onCompressedData);
      } catch {
        // 幂等
      }
      try {
        res.removeListener('end', onSourceEnd);
      } catch {
        // 幂等
      }
      try {
        res.removeListener('error', onSourceError);
      } catch {
        // 幂等
      }
      try {
        res.removeListener('aborted', onSourceAborted);
      } catch {
        // 幂等
      }
      if (inflater !== null) {
        try {
          inflater.removeListener('data', onInflaterData);
        } catch {
          // 幂等
        }
        try {
          inflater.removeListener('end', onInflaterEnd);
        } catch {
          // 幂等
        }
        try {
          inflater.removeListener('error', onInflaterError);
        } catch {
          // 幂等
        }
        try {
          inflater.destroy();
        } catch {
          // 幂等
        }
      }
    }

    function failBudget(): void {
      if (finished || isOuterSettled()) return;
      finished = true;
      release();
      resolveFn({ kind: 'failed', health: 'budget_exceeded', reason: 'response-too-large' });
    }

    function failDeadline(): void {
      if (finished || isOuterSettled()) return;
      finished = true;
      release();
      resolveFn({ kind: 'failed', health: 'unavailable', reason: 'deadline' });
    }

    function commitBody(): void {
      if (finished || isOuterSettled()) return;
      finished = true;
      release();
      meta.byteLength = decompressedBytes;
      meta.compressedByteLength = compressedBytes;
      resolveFn({ kind: 'ok', meta, body: Buffer.concat(buffer) });
    }

    function onSourceData(chunk: Buffer): void {
      if (finished) return;
      if (isOuterSettled()) {
        release();
        return;
      }
      if (deadlineExpired()) {
        failDeadline();
        return;
      }
      compressedBytes += chunk.length;
      decompressedBytes += chunk.length;
      if (decompressedBytes > maxBytes) {
        failBudget();
        return;
      }
      buffer.push(chunk);
    }

    function onCompressedData(chunk: Buffer): void {
      if (finished) return;
      if (isOuterSettled()) {
        release();
        return;
      }
      compressedBytes += chunk.length;
      if (compressedBytes > maxBytes) {
        failBudget();
        return;
      }
      if (deadlineExpired()) {
        failDeadline();
        return;
      }
      inflater?.write(chunk);
    }

    function onSourceEnd(): void {
      if (finished) return;
      if (isOuterSettled()) {
        release();
        return;
      }
      if (inflater === null) commitBody();
      else inflater.end();
    }

    function onSourceError(): void {
      if (finished) return;
      if (isOuterSettled()) {
        release();
        return;
      }
      finished = true;
      release();
      resolveFn({ kind: 'failed', health: 'unavailable', reason: 'stream-error' });
    }

    function onSourceAborted(): void {
      if (finished) return;
      if (isOuterSettled()) {
        release();
        return;
      }
      finished = true;
      release();
      resolveFn({ kind: 'failed', health: 'unavailable', reason: 'aborted' });
    }

    function onInflaterData(chunk: Buffer): void {
      if (finished) return;
      if (isOuterSettled()) {
        release();
        return;
      }
      decompressedBytes += chunk.length;
      if (decompressedBytes > maxBytes) {
        failBudget();
        return;
      }
      buffer.push(chunk);
    }

    function onInflaterEnd(): void {
      if (finished) return;
      if (isOuterSettled()) {
        release();
        return;
      }
      if (!inflaterEnded) {
        inflaterEnded = true;
        commitBody();
      }
    }

    function onInflaterError(): void {
      if (finished) return;
      if (isOuterSettled()) {
        release();
        return;
      }
      finished = true;
      release();
      resolveFn({
        kind: 'failed',
        health: 'budget_exceeded',
        reason: 'decompress-failed-or-too-large',
      });
    }

    let resolveFn: (
      value:
        | { kind: 'ok'; meta: PublicResponseMeta; body: Buffer }
        | { kind: 'failed'; health: ClientHealth; reason: string },
    ) => void = () => {
      // 幂等占位：executor 同步赋值为真正 resolve
    };

    const promise = new Promise<
      | { kind: 'ok'; meta: PublicResponseMeta; body: Buffer }
      | { kind: 'failed'; health: ClientHealth; reason: string }
    >((resolve) => {
      resolveFn = resolve;
      const declaredLength = headerValue(res.headers, 'content-length');
      if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
        const length = Number(declaredLength);
        if (Number.isFinite(length) && length > maxBytes) {
          failBudget();
          return;
        }
      }

      if (inflater === null) {
        res.on('data', onSourceData);
        res.on('end', onSourceEnd);
        res.on('error', onSourceError);
        res.on('aborted', onSourceAborted);
        return;
      }

      // 压缩路径：压缩字节与解压后字节双上限
      inflater.on('data', onInflaterData);
      inflater.on('end', onInflaterEnd);
      inflater.on('error', onInflaterError);
      res.on('data', onCompressedData);
      res.on('end', onSourceEnd);
      res.on('error', onSourceError);
      res.on('aborted', onSourceAborted);
    });

    return { promise, release };
  }
}

// ---------------------------------------------------------------------------
// 安全工厂：唯一产品构造入口（raw transport → RobotsPolicy → target-gated）
// ---------------------------------------------------------------------------

function guardTargetRequest(
  req: TargetRequest,
): { ok: true } | { ok: false; result: PublicFetchResult } {
  if (req === null || typeof req !== 'object' || typeof req.url !== 'string') {
    return {
      ok: false,
      result: { kind: 'failed', health: 'security_rejected', reason: 'invalid-request' },
    };
  }
  const purpose = req.purpose;
  // purpose 是校验字段，不是权限令牌：伪造 purpose='robots' 或任何非 target 目的零网络拒绝
  if (purpose !== 'feed' && purpose !== 'page' && purpose !== 'discovery') {
    return {
      ok: false,
      result: { kind: 'failed', health: 'security_rejected', reason: 'purpose-rejected' },
    };
  }
  const v = validatePublicUrl(req.url);
  if (!v.ok) {
    return {
      ok: false,
      result: { kind: 'failed', health: 'security_rejected', reason: v.reason },
    };
  }
  return { ok: true };
}

function targetFetch(
  method: 'GET' | 'HEAD',
  req: TargetRequest,
  raw: PublicWatchHttpClient,
): Promise<PublicFetchResult> {
  const guard = guardTargetRequest(req);
  if (!guard.ok) return Promise.resolve(guard.result);
  const rawCall = method === 'GET' ? raw.get.bind(raw) : raw.head.bind(raw);
  return rawCall({
    url: req.url,
    purpose: req.purpose,
    etag: req.etag,
    lastModified: req.lastModified,
    signal: req.signal,
    deadline: req.deadline,
  });
}

/**
 * 唯一产品构造入口：在模块内部创建未导出的 raw robots transport → RobotsPolicy →
 * target-gated client。raw、constructor 与任意 URL test seam 均不导出。
 * 工厂无条件装配真实 RobotsPolicy：调用方不能提供、关闭或伪造 robots gate（无绕过路径）；
 * 测试只能经此工厂注入 DNS/request factory/Clock/inflater 等不改变安全装配的窄 seam。
 */
export function createPublicWatchHttpStack(seams: PublicWatchStackSeams = {}): PublicWatchStack {
  let policy: RobotsPolicy | null = null;
  const raw = new PublicWatchHttpClient({
    lookup: seams.lookup,
    request: seams.request,
    clock: seams.clock,
    timeoutMs: seams.timeoutMs,
    userAgent: seams.userAgent,
    createInflater: seams.createInflater,
    robots: {
      checkAllowed: async (input): Promise<RobotsGateDecision> => {
        if (policy === null) return { kind: 'unavailable' };
        return policy.checkAllowed(input);
      },
    },
  });
  policy = new RobotsPolicy({
    client: raw,
    clock: seams.clock,
    uaProduct: seams.uaProduct,
    robotsCacheMs: seams.robotsCacheMs,
  });

  const target: TargetGatedClient = {
    get: (req) => targetFetch('GET', req, raw),
    head: (req) => targetFetch('HEAD', req, raw),
  };

  return {
    target,
    robots: {
      clearCache: () => {
        policy?.clearCache();
      },
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP 状态分类（§7 Acquisition 失败闭环的客户端侧投影）
// ---------------------------------------------------------------------------

export type PublicHttpStatusClass =
  'ok' | 'unchanged-http' | 'redirect' | 'parse-changed' | 'unavailable';

export function classifyPublicHttpStatus(statusCode: number): PublicHttpStatusClass {
  if (statusCode === 304) return 'unchanged-http';
  if (statusCode >= 300 && statusCode < 400) return 'redirect';
  if (statusCode === 404 || statusCode === 410) return 'parse-changed';
  if (statusCode === 401 || statusCode === 403 || statusCode === 429 || statusCode >= 500) {
    return 'unavailable';
  }
  if (statusCode >= 400 && statusCode < 500) return 'parse-changed';
  return 'ok';
}
