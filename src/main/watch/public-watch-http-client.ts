// D3 public-watch-http-client: 仅公网 GET/HEAD 的有界 HTTP 客户端（detailed-design §6.1）。
// - URL/IP/DNS/redirect/downgrade 每跳复验；连接时自定义 lookup 只把已批准地址交给
//   socket（WT-01～WT-03、WRT-01～WRT-03）；HTTP 80 / HTTPS 443 端口闭合。
// - 固定最小 header（UA/Accept/Accept-Encoding + 条件请求 ETag/Last-Modified）；
//   零 Cookie/Authorization/任意调用者 header；零代理隧道。
// - 压缩字节与解压后字节双硬上限，超限立即 destroy；304 映射 unchanged-http。
// - 测试经受控 lookup/transport seam 注入，产品公开接口不暴露绕过能力。
import { promises as dns } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  type BrotliDecompress,
  type Gunzip,
  type Inflate,
} from 'node:zlib';
import {
  MAX_DISCOVERY_HTML_BYTES,
  MAX_FEED_RESPONSE_BYTES,
  MAX_PAGE_HTML_RESPONSE_BYTES,
  MAX_REDIRECTS,
  NETWORK_ATTEMPT_TIMEOUT_MS,
  type Clock,
  type WatchFailureCode,
} from '../../shared/types/watch';
import { isAllowedPublicAddress, validatePublicUrl, type ApprovedTarget } from './network-policy';

export type PublicRequestPurpose = 'feed' | 'page' | 'robots' | 'discovery';

export interface PublicRequest {
  url: string; // 调用者已校验/预校验的输入 URL
  purpose: PublicRequestPurpose;
  etag?: string | null; // 条件请求 If-None-Match
  lastModified?: string | null; // 条件请求 If-Modified-Since
  signal?: AbortSignal;
  deadline?: Date; // 绝对截止；超时受控失败
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

/** 每跳 robots 决策（窄端口：PublicWatchHttpClient 在发起 socket 前咨询）。 */
export type RobotsGateDecision =
  | { kind: 'allowed' }
  | { kind: 'disallowed' }
  | { kind: 'unavailable' }
  | { kind: 'security-rejected' }
  | { kind: 'aborted' };

export interface RobotsGatePort {
  checkAllowed(input: {
    url: string;
    signal?: AbortSignal;
    deadline?: Date;
  }): Promise<RobotsGateDecision>;
}

// ---------------------------------------------------------------------------
// 受控 seam（测试注入；默认接真实 node:http/https + node:dns）
// ---------------------------------------------------------------------------

export interface WatchIncomingLike {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  on(event: 'end', cb: () => void): unknown;
  on(event: 'aborted', cb: () => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  resume?(): unknown;
  destroy?(error?: Error): void;
}

export interface WatchRequestLike {
  on(event: 'response', cb: (res: WatchIncomingLike) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'timeout', cb: () => void): unknown;
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

export interface PublicWatchHttpSeams {
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>; // 默认真实 dns.lookup(all)
  request?: WatchRequestFactory; // 默认 node:http/https
  clock?: Clock; // 默认系统时钟；deadline 判定
  timeoutMs?: number; // 默认 NETWORK_ATTEMPT_TIMEOUT_MS
  userAgent?: string; // 默认产品版本化 UA（不含账号/机器 ID）
  robots?: RobotsGatePort; // 每跳 robots 决策（§6.2）；默认缺省时跳过（D5 装配必须注入）
}

// ---------------------------------------------------------------------------
// 常量与预算表（单一事实源：src/shared/types/watch.ts；robots 256 KiB 复用
// MAX_DISCOVERY_HTML_BYTES，见 detailed-design §6.2）
// ---------------------------------------------------------------------------

export const WATCH_DEFAULT_USER_AGENT =
  'AIbrowse/0.1.0 (Watch; +https://gitee.com/Molotov0coaktail/aibrowse)';

const PURPOSE_MAX_BYTES: Record<PublicRequestPurpose, number> = {
  feed: MAX_FEED_RESPONSE_BYTES,
  page: MAX_PAGE_HTML_RESPONSE_BYTES,
  discovery: MAX_DISCOVERY_HTML_BYTES,
  robots: MAX_DISCOVERY_HTML_BYTES,
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

export class PublicWatchHttpClient {
  private readonly lookup: (hostname: string) => Promise<ResolvedAddress[]>;
  private readonly requestFactory: WatchRequestFactory;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly robots: RobotsGatePort | null;

  constructor(seams: PublicWatchHttpSeams = {}) {
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

  private async run(method: 'GET' | 'HEAD', req: PublicRequest): Promise<PublicFetchResult> {
    const deadlineMs =
      req.deadline instanceof Date ? req.deadline.getTime() : Number.POSITIVE_INFINITY;
    let url = req.url;
    let hops = 0;
    for (;;) {
      const attempt = await this.attemptOnce(method, req, url, deadlineMs);
      if (attempt.kind === 'aborted') return { kind: 'aborted' };
      if (attempt.kind === 'conn-error') {
        return { kind: 'failed', health: 'unavailable', reason: attempt.code };
      }
      if (attempt.kind === 'failed') {
        return { kind: 'failed', health: attempt.health, reason: attempt.reason };
      }
      if (attempt.kind === 'redirect') {
        if (hops >= MAX_REDIRECTS) {
          return { kind: 'failed', health: 'security_rejected', reason: 'redirect-limit' };
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

    // 每跳 robots 决策（§6.2：每个实际 host 在发起 socket 前完成）；robots 请求自身跳过
    if (this.robots !== null && req.purpose !== 'robots') {
      let decision: RobotsGateDecision;
      try {
        decision = await this.robots.checkAllowed({
          url: target.url,
          signal: req.signal,
          deadline: req.deadline,
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

    if (Number.isFinite(deadlineMs) && this.clock.now().getTime() >= deadlineMs) {
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
   * DNS lookup 与 deadline、timeout、abort 竞争：永不返回的 DNS 也必须按时结束。
   * lookup 同步 throw 同样转为受控失败（不会泄漏未处理 rejection）。
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
        for (const t of timers) this.clock.clearTimeout(t);
        if (signal) signal.removeEventListener('abort', onAbort);
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
      if (Number.isFinite(deadlineMs)) {
        const now = this.clock.now().getTime();
        if (now >= deadlineMs) {
          cleanup();
          reject(DNS_TIMEOUT);
          return;
        }
        timers.push(this.clock.setTimeout(fail, deadlineMs - now));
      }
      timers.push(this.clock.setTimeout(fail, this.timeoutMs));

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
      let timeoutHandle: ReturnType<Clock['setTimeout']> | null = null;

      const finish = (value: InternalAttempt | 'retry-next' | 'aborted' | 'failed'): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const cleanup = (): void => {
        if (timeoutHandle !== null) this.clock.clearTimeout(timeoutHandle);
        if (req.signal) req.signal.removeEventListener('abort', onAbort);
      };

      const onAbort = (): void => {
        aborted = true;
        try {
          request?.destroy();
        } catch {
          // 幂等
        }
        finish('aborted');
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

      timeoutHandle = this.clock.setTimeout(() => {
        try {
          activeRequest.destroy();
        } catch {
          // 幂等
        }
        finish('failed');
      }, this.timeoutMs);

      if (req.signal) {
        if (req.signal.aborted) {
          finish('aborted');
          return;
        }
        req.signal.addEventListener('abort', onAbort, { once: true });
      }

      activeRequest.on('response', (res: WatchIncomingLike) => {
        if (aborted || settled) return;
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

        // 不消费的响应（redirect/HEAD/3xx 无 Location）：立即安全销毁或按预算排空，
        // 防止无限 body 持续占用。销毁失败降级为 resume 排空。
        const ignoreResBody = (): void => {
          res.on('error', () => undefined);
          if (typeof res.destroy === 'function') {
            try {
              res.destroy();
              return;
            } catch {
              // 降级排空
            }
          }
          res.resume?.();
        };

        if (REDIRECT_STATUS.has(statusCode)) {
          const location = headerValue(res.headers, 'location');
          if (location === null) {
            ignoreResBody();
            finish({ kind: 'ok', meta, body: Buffer.alloc(0) });
            return;
          }
          let nextUrl: URL;
          try {
            nextUrl = new URL(location, target.url);
          } catch {
            ignoreResBody();
            finish(this.failed('security_rejected', 'redirect-location'));
            return;
          }
          const validated = validatePublicUrl(nextUrl.toString());
          if (!validated.ok) {
            ignoreResBody();
            finish(this.failed('security_rejected', 'redirect-invalid'));
            return;
          }
          if (target.scheme === 'https' && validated.target.scheme === 'http') {
            ignoreResBody();
            finish(this.failed('security_rejected', 'redirect-downgrade'));
            return;
          }
          ignoreResBody();
          finish({ kind: 'redirect', location: validated.target.url });
          return;
        }

        if (method === 'HEAD') {
          ignoreResBody();
          finish({ kind: 'ok', meta, body: Buffer.alloc(0) });
          return;
        }

        this.readBoundedBody(res, req, meta, deadlineMs)
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
      });

      activeRequest.on('error', (err: NodeJS.ErrnoException) => {
        if (settled || aborted) return;
        const code = err.code ?? 'ERR';
        if (CONNECT_RETRYABLE.has(code)) {
          finish('retry-next');
          return;
        }
        finish(this.failed('unavailable', code));
      });

      activeRequest.end();
    });
  }

  private readBoundedBody(
    res: WatchIncomingLike,
    req: PublicRequest,
    meta: PublicResponseMeta,
    deadlineMs: number,
  ): Promise<
    | { kind: 'ok'; meta: PublicResponseMeta; body: Buffer }
    | { kind: 'failed'; health: ClientHealth; reason: string }
  > {
    const maxBytes = PURPOSE_MAX_BYTES[req.purpose];
    return new Promise((resolve) => {
      let compressedBytes = 0;
      let decompressedBytes = 0;
      let finished = false;
      const buffer: Buffer[] = [];

      const deadlineExpired = (): boolean =>
        Number.isFinite(deadlineMs) && this.clock.now().getTime() >= deadlineMs;

      const failBudget = (): void => {
        if (finished) return;
        finished = true;
        try {
          res.destroy?.();
        } catch {
          // 幂等
        }
        resolve({ kind: 'failed', health: 'budget_exceeded', reason: 'response-too-large' });
      };

      const failDeadline = (): void => {
        if (finished) return;
        finished = true;
        try {
          res.destroy?.();
        } catch {
          // 幂等
        }
        resolve({ kind: 'failed', health: 'unavailable', reason: 'deadline' });
      };

      const declaredLength = headerValue(res.headers, 'content-length');
      if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
        const length = Number(declaredLength);
        if (Number.isFinite(length) && length > maxBytes) {
          failBudget();
          return;
        }
      }

      const contentEncoding = (meta.contentEncoding ?? '').trim().toLowerCase();
      const encoding = contentEncoding === '' ? 'identity' : contentEncoding;

      const commitBody = (): void => {
        if (finished) return;
        finished = true;
        meta.byteLength = decompressedBytes;
        meta.compressedByteLength = compressedBytes;
        resolve({ kind: 'ok', meta, body: Buffer.concat(buffer) });
      };

      const onSourceEnd = (): void => {
        if (!finished) commitBody();
      };

      const onSourceError = (): void => {
        if (!finished) {
          finished = true;
          resolve({ kind: 'failed', health: 'unavailable', reason: 'stream-error' });
        }
      };

      const onSourceAborted = (): void => {
        if (!finished) {
          finished = true;
          resolve({ kind: 'failed', health: 'unavailable', reason: 'aborted' });
        }
      };

      if (encoding === 'identity') {
        res.on('data', (chunk: Buffer) => {
          if (finished) return;
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
        });
        res.on('end', onSourceEnd);
        res.on('error', onSourceError);
        res.on('aborted', onSourceAborted);
        return;
      }

      // 压缩路径：压缩字节与解压后字节双上限
      let inflater: Gunzip | Inflate | BrotliDecompress;
      if (encoding === 'gzip' || encoding === 'x-gzip') {
        inflater = createGunzip({ maxOutputLength: maxBytes });
      } else if (encoding === 'deflate') {
        inflater = createInflate({ maxOutputLength: maxBytes });
      } else if (encoding === 'br') {
        inflater = createBrotliDecompress({ maxOutputLength: maxBytes });
      } else {
        finished = true;
        try {
          res.destroy?.();
        } catch {
          // 幂等
        }
        resolve({
          kind: 'failed',
          health: 'security_rejected',
          reason: 'unknown-content-encoding',
        });
        return;
      }

      let inflaterEnded = false;
      inflater.on('data', (chunk: Buffer) => {
        if (finished) return;
        decompressedBytes += chunk.length;
        if (decompressedBytes > maxBytes) {
          failBudget();
          return;
        }
        buffer.push(chunk);
      });
      inflater.on('end', () => {
        if (!finished && !inflaterEnded) {
          inflaterEnded = true;
          commitBody();
        }
      });
      inflater.on('error', () => {
        if (!finished) {
          finished = true;
          try {
            res.destroy?.();
          } catch {
            // 幂等
          }
          resolve({
            kind: 'failed',
            health: 'budget_exceeded',
            reason: 'decompress-failed-or-too-large',
          });
        }
      });

      res.on('data', (chunk: Buffer) => {
        if (finished) return;
        compressedBytes += chunk.length;
        if (compressedBytes > maxBytes) {
          failBudget();
          return;
        }
        if (deadlineExpired()) {
          failDeadline();
          return;
        }
        inflater.write(chunk);
      });
      res.on('end', () => {
        if (!finished) inflater.end();
      });
      res.on('error', onSourceError);
      res.on('aborted', onSourceAborted);
    });
  }
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
