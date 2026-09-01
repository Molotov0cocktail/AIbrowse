// D3 public-watch-http-client tests: 网络安全（WT-01～WT-04、WRT-01～WRT-05/WRT-19）、
// 条件请求/压缩/超时/重定向，全部经安全工厂注入的受控 lookup/transport/Clock 验证，零真实网络。
// raw transport/client、constructor 与任意 URL test seam 均不导出；测试只经
// createPublicWatchHttpStack(...) 注入依赖并观察 target-gated 窄能力。
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import { createGunzip, gzipSync, type Gunzip } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../shared/watch/clock';
import {
  MAX_FEED_RESPONSE_BYTES,
  MAX_REDIRECTS,
  MAX_ROBOTS_RESPONSE_BYTES,
} from '../../shared/types/watch';
import * as watchClientModule from './public-watch-http-client';
import {
  classifyPublicHttpStatus,
  createPublicWatchHttpStack,
  WATCH_DEFAULT_USER_AGENT,
  type PublicWatchStackSeams,
  type WatchHostGatePort,
  type WatchIncomingLike,
  type WatchInflaterLike,
  type WatchRequestFactory,
  type WatchRequestLike,
  type WatchRequestOptions,
} from './public-watch-http-client';
import { HostRequestGate } from './host-request-gate';

// ---------------------------------------------------------------------------
// 测试 transport seam：捕获请求选项，由测试控制响应
// ---------------------------------------------------------------------------

class FakeIncoming extends EventEmitter implements WatchIncomingLike {
  statusCode = 200;
  statusMessage = 'OK';
  headers: Record<string, string | string[] | undefined> = {};
  destroyed = false;
  // R5 失败注入：单项清理抛错时验证其余清理继续。
  failDestroy = false;
  failResume = false;
  // 确定性敌手 seam：destroy 后强制异步投递 aborted → error → close。该强制顺序不代表
  // 真实 Node 在零 error listener 时必然发出 error（Node 24.18.0 为条件发射）。
  adversaryError: Error | null = null;
  // never-close seam：destroy 后不投递 close（仅对应 emitter 自包含 drain pair 保留）。
  neverClose = false;
  private closed = false;
  resume(): void {
    if (this.failResume) throw new Error('injected resume failure');
    // 忠实 Node：resume() 排空被丢弃的响应流后最终 close；用于 destroy 缺失/抛错 → resume 排空路径。
    if (this.destroyed || this.closed || this.neverClose) return;
    queueMicrotask(() => {
      if (this.closed) return;
      this.closed = true;
      this.emit('close');
    });
  }
  // 忠实 Node 24 IncomingMessage.destroy()：异步投递 aborted → (可选敌手 error) → close。
  // 不再用“destroy 后零投递”掩盖缺 listener 的缺陷；业务终态后迟到 error 必须由 drain 承载。
  destroy(error?: Error): void {
    if (this.failDestroy) throw new Error('injected response.destroy failure');
    if (this.destroyed) return;
    this.destroyed = true;
    const err = error ?? this.adversaryError;
    queueMicrotask(() => {
      if (this.closed) return;
      this.emit('aborted');
      if (this.neverClose) return;
      this.closed = true;
      if (err !== null) this.emit('error', err);
      this.emit('close');
    });
  }
}

class FakeRequest extends EventEmitter implements WatchRequestLike {
  destroyed = false;
  // R5 失败注入 / 竞态模拟。
  failDestroy = false;
  // 若设置，request.destroy() 会同步发出一次 'response'（覆盖 destroy 内同步竞态）。
  emitResponseOnDestroy: FakeIncoming | null = null;
  // never-close seam：destroy 后不投递 close（request drain 保留至不可达对象 GC）。
  neverClose = false;
  private closed = false;
  setTimeout(ms: number): unknown {
    void ms;
    return this;
  }
  end(): void {}
  // 忠实 Node 24 request.abort()：异步投递 close（probe 实测 abort 不发 request error）。
  abort(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => {
      if (this.closed) return;
      this.closed = true;
      this.emit('close');
    });
  }
  // 忠实 Node 24 ClientRequest.destroy()：无 error 参数也会异步投递 error ECONNRESET + close
  // （pre-socket/pre-response 实测顺序）；close 自清理 drain pair。
  destroy(error?: Error): void {
    if (this.failDestroy) throw new Error('injected request.destroy failure');
    if (this.destroyed) return;
    if (this.emitResponseOnDestroy !== null) {
      const res = this.emitResponseOnDestroy;
      this.emitResponseOnDestroy = null;
      this.emit('response', res);
    }
    this.destroyed = true;
    const err = error ?? Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    queueMicrotask(() => {
      if (this.closed) return;
      if (this.neverClose) {
        this.emit('error', err);
        return;
      }
      this.closed = true;
      this.emit('error', err);
      this.emit('close');
    });
  }
}

interface CapturedRequest {
  options: WatchRequestOptions;
  request: FakeRequest; // 底层 transport（listenerCount/资源断言用）
  responded: boolean;
  respond(status: number, headers: Record<string, string>, body?: Buffer | string | null): void;
  respondChunked(
    status: number,
    headers: Record<string, string>,
    chunks: Array<Buffer | string>,
  ): void;
  openResponse(status: number, headers: Record<string, string>): FakeIncoming;
  error(code: string): void;
  timeout(): void;
}

function isRobotsRequest(options: WatchRequestOptions): boolean {
  return options.method === 'GET' && options.path === '/robots.txt';
}

function makeCap(req: FakeRequest, options: WatchRequestOptions): CapturedRequest {
  const cap: CapturedRequest = {
    options,
    request: req,
    responded: false,
    respond(status, headers, body = null) {
      cap.responded = true;
      const res = cap.openResponse(status, headers);
      if (body !== null) {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
        if (buf.length > 0) res.emit('data', buf);
      }
      res.emit('end');
    },
    respondChunked(status, headers, chunks) {
      cap.responded = true;
      const res = cap.openResponse(status, headers);
      for (const c of chunks) res.emit('data', Buffer.isBuffer(c) ? c : Buffer.from(c, 'utf8'));
      res.emit('end');
    },
    openResponse(status, headers) {
      cap.responded = true;
      const res = new FakeIncoming();
      res.statusCode = status;
      res.headers = headers;
      req.emit('response', res);
      return res;
    },
    error(code) {
      req.emit('error', Object.assign(new Error(code), { code }));
    },
    timeout() {
      req.emit('timeout');
    },
  };
  return cap;
}

// 默认 lookup：模拟真实 dns.lookup 行为——IP 字面量原样返回，域名返回公网地址。
const PUBLIC_LOOKUP = async (hostname: string): Promise<{ address: string; family: 4 | 6 }[]> => {
  const kind = isIP(hostname);
  if (kind === 4) return [{ address: hostname, family: 4 }];
  if (kind === 6) return [{ address: hostname, family: 6 }];
  return [{ address: '93.184.216.34', family: 4 }];
};

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 安全工厂测试 harness：注入受控 lookup/request/Clock；robots 请求默认自动 404（allow-all），
 * 测试只关心目标请求时可设 autoRobots:false 手动驱动 robots 响应。
 * createInflater 是只影响压缩解压、不改变安全装配的窄 seam（用于观察 inflater 生命周期）。
 * 构造经 as unknown as 双断言：证明即使调用方强塞 seams 类型之外的键也只会被忽略/按窄 seam 处理。
 */
function createHarness(
  opts: {
    lookup?: (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;
    clock?: FakeClock;
    timeoutMs?: number;
    autoRobots?: boolean;
    createInflater?: (
      encoding: 'gzip' | 'deflate' | 'br',
      maxOutputLength: number,
    ) => WatchInflaterLike;
    hostGate?: WatchHostGatePort;
  } = {},
) {
  const captured: CapturedRequest[] = [];
  const factory: WatchRequestFactory = (options) => {
    const req = new FakeRequest();
    const cap = makeCap(req, options);
    captured.push(cap);
    if (opts.autoRobots !== false && isRobotsRequest(options)) {
      queueMicrotask(() => {
        if (!cap.responded) cap.respond(404, {}, '');
      });
    }
    return req;
  };
  const stack = createPublicWatchHttpStack({
    lookup: opts.lookup ?? PUBLIC_LOOKUP,
    request: factory,
    clock: opts.clock,
    timeoutMs: opts.timeoutMs ?? 30_000,
    createInflater: opts.createInflater,
    hostGate: opts.hostGate,
  } as unknown as PublicWatchStackSeams);
  return {
    stack,
    captured,
    targets: (): CapturedRequest[] => captured.filter((c) => !isRobotsRequest(c.options)),
  };
}

describe('WRT-01/WRT-02/WRT-03 — 零 socket 与地址校验（经安全工厂）', () => {
  it('localhost/私网 URL 在 validate 阶段拒绝，transport 零调用', async () => {
    const h = createHarness();
    for (const url of [
      'https://localhost/feed',
      'http://127.0.0.1/feed',
      'https://10.0.0.1/x',
      'https://192.168.1.1/x',
      'http://[::1]/x',
      'https://foo.local/feed',
      'http://example.com:8080/feed',
      'https://user:pass@example.com/',
    ]) {
      const r = await h.stack.target.get({ url, purpose: 'feed' });
      expect(r.kind, url).toBe('failed');
      if (r.kind === 'failed') expect(r.health, url).toBe('security_rejected');
    }
    expect(h.captured.length).toBe(0); // 零 socket（含 robots）
  });

  it('lookup 返回私网/回环/链路本地/混合 → security_rejected，transport 零调用', async () => {
    for (const addresses of [
      [{ address: '10.0.0.5', family: 4 as const }],
      [{ address: '127.0.0.1', family: 4 as const }],
      [{ address: '::1', family: 6 as const }],
      [{ address: '169.254.1.1', family: 4 as const }],
      [
        { address: '93.184.216.34', family: 4 as const },
        { address: '10.0.0.1', family: 4 as const },
      ], // 公私混合
      [{ address: '224.0.0.1', family: 4 as const }],
      [{ address: '240.0.0.1', family: 4 as const }],
    ]) {
      const h = createHarness({ lookup: async () => addresses });
      const r = await h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('security_rejected');
      expect(h.captured.length).toBe(0);
    }
  });

  it('lookup 失败/空 → unavailable（无 socket）', async () => {
    const h = createHarness({
      lookup: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    const r = await h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
    expect(h.captured.length).toBe(0);
  });

  it('IPv6 非公网字面量（fec0/文档段/benchmark/未分配/RESERVED）→ security_rejected，零 socket', async () => {
    for (const host of [
      '[fec0::1]',
      '[2001:db8::1]',
      '[2001:2::1]',
      '[3fff::1]',
      '[2000::1]',
      '[2d00::1]',
    ]) {
      const h = createHarness();
      const r = await h.stack.target.get({ url: `http://${host}/feed`, purpose: 'feed' });
      expect(r.kind, host).toBe('failed');
      if (r.kind === 'failed') expect(r.health, host).toBe('security_rejected');
      expect(h.captured.length, host).toBe(0);
    }
  });

  it('lookup 返回 IPv6 非公网（含混合）→ security_rejected，零 socket', async () => {
    for (const addresses of [
      [{ address: 'fec0::1', family: 6 as const }],
      [{ address: '2001:db8::1', family: 6 as const }],
      [{ address: '2001:2::1', family: 6 as const }],
      [{ address: '3fff::1', family: 6 as const }],
      [{ address: '2000::1', family: 6 as const }],
      [{ address: '2d00::1', family: 6 as const }],
      [
        { address: '2606:4700:4700::1111', family: 6 as const },
        { address: 'fec0::1', family: 6 as const },
      ],
    ]) {
      const h = createHarness({ lookup: async () => addresses });
      const r = await h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('security_rejected');
      expect(h.captured.length).toBe(0);
    }
  });

  it('已分配普通 GUA IPv6（DNS 路径）到达受控 socket', async () => {
    const h = createHarness({
      lookup: async () => [{ address: '2606:4700:4700::1111', family: 6 as const }],
    });
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    // robots 与目标请求均已创建（robots 自动 404 → allow-all）
    expect(h.captured.length).toBe(2);
    expect(isRobotsRequest(h.captured[0]!.options)).toBe(true);
    expect(h.targets().length).toBe(1);
    h.targets()[0]!.respond(200, {}, '<rss/>');
    expect((await promise).kind).toBe('ok');
  });

  it('连接时 sealed lookup 只返回已批准地址（DNS trap/rebinding 无法注入）', async () => {
    const h = createHarness();
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    expect(h.targets().length).toBe(1);
    h.targets()[0]!.respond(200, {}, '<rss/>');
    const r = await promise;
    expect(r.kind).toBe('ok');
    const { options } = h.targets()[0]!;
    // 无论 hostname 如何，sealed lookup 只交付 93.184.216.34
    let got: { address: string; family: number } | null = null;
    let gotAll: unknown = null;
    options.lookup('evil-dns.example', { all: false }, (err, addr, family) => {
      expect(err).toBeNull();
      got = { address: addr as string, family: family ?? 0 };
    });
    options.lookup('evil-dns.example', { all: true }, (_err, addr) => {
      gotAll = addr;
    });
    expect(got).toEqual({ address: '93.184.216.34', family: 4 });
    expect(JSON.stringify(gotAll)).toBe(JSON.stringify([{ address: '93.184.216.34', family: 4 }]));
  });

  it('多地址：首地址连接失败则回退下一批准地址', async () => {
    const h = createHarness({
      lookup: async () => [
        { address: '93.184.216.34', family: 4 as const },
        { address: '151.101.1.140', family: 4 as const },
      ],
    });
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    expect(h.targets().length).toBe(1);
    h.targets()[0]!.error('ECONNREFUSED');
    await flush();
    // 第二个地址：交付 200
    expect(h.targets().length).toBe(2);
    h.targets()[1]!.respond(200, { 'content-type': 'application/rss+xml' }, '<rss/>');
    const r = await promise;
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.meta.statusCode).toBe(200);
  });
});

describe('固定 header / 条件请求 / 304', () => {
  it('请求 header 固定：UA/Accept/Accept-Encoding，零 Cookie/Auth/自定义', async () => {
    const h = createHarness();
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const headers = h.targets()[0]!.options.headers;
    expect(headers['User-Agent']).toBe(WATCH_DEFAULT_USER_AGENT);
    expect(headers['Accept']).toContain('application/rss+xml');
    expect(headers['Accept-Encoding']).toBe('gzip, deflate, br');
    expect(headers['Cookie']).toBeUndefined();
    expect(headers['Authorization']).toBeUndefined();
    for (const k of Object.keys(headers)) {
      expect(k.toLowerCase()).not.toBe('cookie');
      expect(k.toLowerCase()).not.toBe('authorization');
    }
    h.targets()[0]!.respond(200, {}, '<rss/>');
    await promise;
  });

  it('条件请求 ETag/Last-Modified 发送', async () => {
    const h = createHarness();
    const promise = h.stack.target.get({
      url: 'https://example.com/feed',
      purpose: 'feed',
      etag: '"abc"',
      lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    });
    await flush();
    expect(h.targets()[0]!.options.headers['If-None-Match']).toBe('"abc"');
    expect(h.targets()[0]!.options.headers['If-Modified-Since']).toBe(
      'Mon, 01 Jan 2024 00:00:00 GMT',
    );
    h.targets()[0]!.respond(304, { etag: '"abc"' }, null);
    const r = await promise;
    expect(r.kind).toBe('unchanged-http');
  });

  it('304 映射 unchanged-http，不解析空 body；ETag/Last-Modified 稳定回读', async () => {
    const h = createHarness();
    const promise = h.stack.target.get({
      url: 'https://example.com/feed',
      purpose: 'feed',
      etag: '"e1"',
    });
    await flush();
    h.targets()[0]!.respond(
      304,
      { etag: '"e1"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
      null,
    );
    const r = await promise;
    expect(r.kind).toBe('unchanged-http');
    if (r.kind === 'unchanged-http') {
      expect(r.meta.etag).toBe('"e1"');
      expect(r.meta.lastModified).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
    }
  });

  it('HEAD 请求返回 meta、零 body', async () => {
    const h = createHarness();
    const promise = h.stack.target.head({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    expect(h.targets()[0]!.options.method).toBe('HEAD');
    h.targets()[0]!.respond(200, { 'content-type': 'application/rss+xml' }, 'ignored-body');
    const r = await promise;
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.body.length).toBe(0);
      expect(r.meta.byteLength).toBe(0);
    }
  });
});

describe('redirect — 每跳复验（WRT-03）', () => {
  it('302 → 合法新 host 跟随；finalUrl 更新（每跳新 host 必经 robots）', async () => {
    const h = createHarness();
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    h.targets()[0]!.respond(302, { location: 'https://cdn.example.com/feed.xml' }, null);
    await flush();
    expect(h.targets().length).toBe(2);
    expect(h.targets()[1]!.options.hostname).toBe('cdn.example.com');
    h.targets()[1]!.respond(200, {}, '<rss/>');
    const r = await promise;
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.meta.finalUrl).toBe('https://cdn.example.com/feed.xml');
  });

  it('redirect 到私网/私网地址/file/javascript → security_rejected，无后续请求', async () => {
    for (const location of [
      'http://10.0.0.1/feed',
      'http://localhost/feed',
      'http://192.168.1.1/feed',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'http://x.local/feed',
    ]) {
      const h = createHarness();
      const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      h.targets()[0]!.respond(302, { location }, null);
      const r = await promise;
      expect(r.kind, location).toBe('failed');
      if (r.kind === 'failed') expect(r.health, location).toBe('security_rejected');
      expect(h.targets().length, location).toBe(1); // 无后续请求
    }
  });

  it('HTTPS→HTTP downgrade 拒绝', async () => {
    const h = createHarness();
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    h.targets()[0]!.respond(302, { location: 'http://example.com/feed' }, null);
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('security_rejected');
    expect(h.targets().length).toBe(1);
  });

  it('redirect 超过 5 跳拒绝', async () => {
    const h = createHarness();
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    for (let i = 0; i <= MAX_REDIRECTS + 1; i += 1) {
      await flush();
      const ts = h.targets();
      if (ts.length === 0) break;
      ts[ts.length - 1]!.respond(302, { location: 'https://example.com/feed' }, null);
    }
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('security_rejected');
  });

  it('3xx 无 Location 按响应结束返回（不无限跟随）', async () => {
    const h = createHarness();
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    h.targets()[0]!.respond(302, {}, null);
    const r = await promise;
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.meta.statusCode).toBe(302);
    expect(h.targets().length).toBe(1);
  });
});

describe('预算/超时/慢流（WRT-04）', () => {
  it('Content-Length 超预算立即 budget_exceeded（feed 2 MiB）', async () => {
    const h = createHarness();
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    h.targets()[0]!.respond(200, { 'content-length': String(MAX_FEED_RESPONSE_BYTES + 1) }, '');
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('budget_exceeded');
  });

  it('== MAX identity 接受；MAX+1 拒绝', async () => {
    const atMax = 'x'.repeat(MAX_FEED_RESPONSE_BYTES);
    const h1 = createHarness();
    const p1 = h1.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    h1.targets()[0]!.respond(200, {}, atMax);
    const r1 = await p1;
    expect(r1.kind).toBe('ok');
    if (r1.kind === 'ok') expect(r1.meta.byteLength).toBe(MAX_FEED_RESPONSE_BYTES);

    const h2 = createHarness();
    const p2 = h2.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    h2.targets()[0]!.respond(200, {}, 'x'.repeat(MAX_FEED_RESPONSE_BYTES + 1));
    const r2 = await p2;
    expect(r2.kind).toBe('failed');
    if (r2.kind === 'failed') expect(r2.health).toBe('budget_exceeded');
  });

  it('gzip 解压后 == MAX 接受、MAX+1 拒绝（解压字节硬上限）', async () => {
    const maxText = 'a'.repeat(MAX_FEED_RESPONSE_BYTES);
    const gzMax = gzipSync(Buffer.from(maxText, 'utf8'));
    const h1 = createHarness();
    const p1 = h1.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    h1.targets()[0]!.respond(200, { 'content-encoding': 'gzip' }, gzMax);
    const r1 = await p1;
    expect(r1.kind).toBe('ok');
    if (r1.kind === 'ok') {
      expect(r1.meta.byteLength).toBe(MAX_FEED_RESPONSE_BYTES);
      expect(r1.body.toString('utf8')).toBe(maxText);
    }

    const h2 = createHarness();
    const p2 = h2.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    h2.targets()[0]!.respond(
      200,
      { 'content-encoding': 'gzip' },
      gzipSync(Buffer.from('a'.repeat(MAX_FEED_RESPONSE_BYTES + 1), 'utf8')),
    );
    const r2 = await p2;
    expect(r2.kind).toBe('failed');
    if (r2.kind === 'failed') expect(r2.health).toBe('budget_exceeded');
  });

  it('未知 Content-Encoding fail-closed（security_rejected，不回退 identity）', async () => {
    const h = createHarness();
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    h.targets()[0]!.respond(200, { 'content-encoding': 'xz' }, 'x'.repeat(100));
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('security_rejected');
  });

  it('慢流超过 deadline 受控失败并 destroy；随后正常请求仍成功', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const promise = h.stack.target.get({
      url: 'https://example.com/feed',
      purpose: 'feed',
      deadline: new Date(5000),
    });
    await flush();
    const res = h.targets()[0]!.openResponse(200, {});
    res.emit('data', Buffer.from('part1', 'utf8')); // t=0 < deadline
    await flush();
    clock.pushNow(6000); // 超过 deadline
    res.emit('data', Buffer.from('part2', 'utf8')); // 触发 failDeadline
    res.emit('end');
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');

    // 随后正常请求（无 deadline）成功
    const h2 = createHarness();
    const p2 = h2.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    h2.targets()[0]!.respond(200, {}, '<rss/>');
    const r2 = await p2;
    expect(r2.kind).toBe('ok');
  });

  it('socket 在总 deadline 到期时受控销毁（30 秒内）', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    expect(h.targets().length).toBe(1);
    clock.advanceTo(30_000);
    await flush();
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
  });

  it('连接错误（ECONNREFUSED 等）→ unavailable', async () => {
    const h = createHarness();
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    h.targets()[0]!.error('ECONNREFUSED');
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
  });
});

describe('DNS lookup 竞争 deadline/timeout/abort（WRT-04 覆盖 DNS 生命周期）', () => {
  it('永不返回的目标 DNS → 总 deadline 内受控失败，零目标 socket', async () => {
    const clock = new FakeClock(0);
    let calls = 0;
    const h = createHarness({
      clock,
      lookup: async () => {
        calls += 1;
        if (calls === 1) return [{ address: '93.184.216.34', family: 4 as const }]; // robots DNS
        return new Promise(() => {}); // 目标 DNS 永不返回
      },
    });
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    expect(h.targets().length).toBe(0); // 目标 DNS 未返回 → 零目标 socket
    clock.advanceTo(30_000);
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
    expect(h.targets().length).toBe(0);
  });

  it('已过期 deadline → 立即失败（零 DNS、零 socket）', async () => {
    const h = createHarness();
    const r = await h.stack.target.get({
      url: 'https://example.com/feed',
      purpose: 'feed',
      deadline: new Date(Date.now() - 1),
    });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
    expect(h.captured.length).toBe(0);
  });

  it('abort 在 DNS 期间 → aborted', async () => {
    const controller = new AbortController();
    const h = createHarness({
      lookup: async () => new Promise(() => {}),
    });
    const promise = h.stack.target.get({
      url: 'https://example.com/feed',
      purpose: 'feed',
      signal: controller.signal,
    });
    controller.abort();
    const r = await promise;
    expect(r.kind).toBe('aborted');
    expect(h.captured.length).toBe(0);
  });

  it('requestFactory 同步 throw → 受控 unavailable（不拒绝 promise）', async () => {
    const stack = createPublicWatchHttpStack({
      lookup: PUBLIC_LOOKUP,
      request: () => {
        throw new Error('boom');
      },
    });
    const r = await stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
  });
});

describe('每跳 robots gate（WRT-05 每跳部分；真实 RobotsPolicy 装配）', () => {
  it('初始 host allowed → redirect 下一 host robots disallowed → 下一 host 零 socket', async () => {
    const h = createHarness({ autoRobots: false });
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    expect(h.captured.length).toBe(1); // robots(example.com)
    expect(isRobotsRequest(h.captured[0]!.options)).toBe(true);
    h.captured[0]!.respond(404, {}, ''); // allow-all
    await flush();
    expect(h.targets().length).toBe(1);
    h.targets()[0]!.respond(302, { location: 'https://cdn.example.com/feed.xml' }, null);
    await flush();
    expect(h.captured.length).toBe(3); // robots-a, target-a, robots-cdn
    h.captured[2]!.respond(200, {}, 'User-agent: aibrowse\nDisallow: /\n');
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('robots_disallowed');
    expect(h.targets().length).toBe(1); // cdn 零目标 socket
  });

  it('robots 获取失败（requestFactory throw）→ fail-closed unavailable，不假定允许', async () => {
    const stack = createPublicWatchHttpStack({
      lookup: PUBLIC_LOOKUP,
      request: () => {
        throw new Error('boom');
      },
    });
    const r = await stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
  });

  it('真实 RobotsPolicy 装配：robots 子请求自身不递归咨询 gate（零递归）', async () => {
    const h = createHarness(); // 真实 RobotsPolicy + auto-robots
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    expect(h.captured.length).toBe(2); // robots.txt（内部派生）+ 目标
    expect(isRobotsRequest(h.captured[0]!.options)).toBe(true);
    expect(isRobotsRequest(h.captured[1]!.options)).toBe(false);
    h.targets()[0]!.respond(200, {}, '<rss/>');
    expect((await promise).kind).toBe('ok');
  });
});

describe('不消费响应的安全销毁（WRT-04 生命周期）', () => {
  it('redirect 无限 body：立即销毁前一个响应并继续', async () => {
    const h = createHarness();
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const res = h.targets()[0]!.openResponse(302, { location: 'https://cdn.example.com/feed.xml' });
    res.emit('data', Buffer.from('x', 'utf8')); // 不 emit end → 无限 body
    await flush();
    expect(h.targets().length).toBe(2);
    expect(res.destroyed).toBe(true);
    h.targets()[1]!.respond(200, {}, '<rss/>');
    const r = await promise;
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.meta.finalUrl).toBe('https://cdn.example.com/feed.xml');
  });

  it('HEAD 无限 body：立即销毁响应并返回零 body', async () => {
    const h = createHarness();
    const promise = h.stack.target.head({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const res = h.targets()[0]!.openResponse(200, {});
    res.emit('data', Buffer.from('x', 'utf8')); // 不 emit end
    await flush();
    const r = await promise;
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.body.length).toBe(0);
    expect(res.destroyed).toBe(true);
  });

  it('3xx 无 Location 无限 body：销毁并返回 3xx 结果', async () => {
    const h = createHarness();
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const res = h.targets()[0]!.openResponse(302, {});
    res.emit('data', Buffer.from('x', 'utf8'));
    await flush();
    const r = await promise;
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.meta.statusCode).toBe(302);
    expect(res.destroyed).toBe(true);
    expect(h.targets().length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R2 甄别 oracle（转绿；覆盖安全工厂、robots 独立预算、总 deadline、伪造 purpose）
// ---------------------------------------------------------------------------

describe('R2 工厂与能力边界', () => {
  it('模块公开 surface 不包含 raw client、constructor、RobotsGatePort 或任意 URL fetch seam', () => {
    const surface = watchClientModule as unknown as Record<string, unknown>;
    expect(typeof surface.createPublicWatchHttpStack).toBe('function');
    expect(surface.PublicWatchHttpClient).toBeUndefined();
    expect(surface.PublicWatchHttpSeams).toBeUndefined();
    expect(surface.RobotsPolicy).toBeUndefined();
    expect(surface.RobotsGatePort).toBeUndefined();
  });

  it('结构 oracle：PublicWatchStackSeams 不含 robots 注入点；公开工厂调用方无法提供 robots gate', () => {
    // 若 'robots' 出现在 seam 键集，则 AssertNoRobots 求值为 never，const check 赋值在
    // typecheck 层失败——这是只靠类型系统即可证明的公开工厂结构契约。
    type AssertNoRobots<T> = 'robots' extends keyof T ? never : true;
    const check: AssertNoRobots<PublicWatchStackSeams> = true;
    expect(check).toBe(true);
    // 运行时层面：即使调用方用强类型断言塞入 robots 键，安全工厂也只能忽略它（见 R3 套件）。
  });

  it('目标 https://EXAMPLE.com:443/a?x=1#f 的第一次 robots 请求只能是 https://example.com/robots.txt', async () => {
    const h = createHarness({ autoRobots: false });
    const promise = h.stack.target.get({ url: 'https://EXAMPLE.com:443/a?x=1#f', purpose: 'feed' });
    await flush();
    expect(h.captured.length).toBe(1);
    const { options } = h.captured[0]!;
    expect(options.method).toBe('GET');
    expect(options.hostname).toBe('example.com');
    expect(options.path).toBe('/robots.txt');
    expect(options.port).toBe(443);
    expect(options.protocol).toBe('https:');
    h.captured[0]!.respond(404, {}, '');
    await flush();
    expect(h.targets().length).toBe(1);
    h.targets()[0]!.respond(200, {}, '<rss/>');
    expect((await promise).kind).toBe('ok');
  });

  it('伪造 purpose=robots + 任意 host/path/query/fragment 或 method=HEAD → 零 DNS、零 request、零 socket', async () => {
    const h = createHarness();
    const cases: Array<() => Promise<unknown>> = [
      () =>
        h.stack.target.get({
          url: 'https://evil.example.com/robots.txt',
          purpose: 'robots' as never,
        }),
      () =>
        h.stack.target.get({ url: 'https://example.com/other-path', purpose: 'robots' as never }),
      () =>
        h.stack.target.get({
          url: 'https://example.com/robots.txt?x=1',
          purpose: 'robots' as never,
        }),
      () =>
        h.stack.target.get({ url: 'https://example.com/robots.txt#f', purpose: 'robots' as never }),
      () =>
        h.stack.target.head({ url: 'https://example.com/robots.txt', purpose: 'robots' as never }),
      () => h.stack.target.get({ url: 'https://example.com/x', purpose: 'unknown' as never }),
    ];
    for (const run of cases) {
      const r = (await run()) as { kind: string; health?: string };
      expect(r.kind).toBe('failed');
      expect((r as { health?: string }).health).toBe('security_rejected');
    }
    expect(h.captured.length).toBe(0);
  });

  it('合法 redirect 继承同一 absolute deadline（不续杯）', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const promise = h.stack.target.get({
      url: 'https://example.com/feed',
      purpose: 'feed',
      deadline: new Date(30_000),
    });
    await flush();
    clock.advanceTo(20_000);
    h.targets()[0]!.respond(302, { location: 'https://cdn.example.com/feed.xml' }, null);
    await flush();
    expect(h.targets().length).toBe(2);
    clock.advanceTo(30_000); // 第二跳 socket 仍在原 deadline 内销毁（若续杯将到 50s）
    await flush();
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
  });
});

describe('R2 robots 独立预算（512,000，不复用 discovery 预算）', () => {
  it('robots 512,000 identity == MAX 接受并继续目标请求', async () => {
    const h = createHarness({ autoRobots: false });
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    expect(h.captured.length).toBe(1);
    const head = 'User-agent: aibrowse\nDisallow: /x\n';
    const body = head + '#'.repeat(MAX_ROBOTS_RESPONSE_BYTES - Buffer.byteLength(head, 'utf8'));
    h.captured[0]!.respond(200, {}, body);
    await flush();
    expect(h.targets().length).toBe(1);
    h.targets()[0]!.respond(200, {}, '<rss/>');
    const r = await promise;
    expect(r.kind).toBe('ok');
  });

  it('robots 512,001 identity 在第 512,001 byte destroy；目标零请求', async () => {
    const h = createHarness({ autoRobots: false });
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const res = h.captured[0]!.openResponse(200, {});
    const head = 'User-agent: aibrowse\nDisallow: /x\n';
    const body = head + '#'.repeat(MAX_ROBOTS_RESPONSE_BYTES + 1 - Buffer.byteLength(head, 'utf8'));
    res.emit('data', Buffer.from(body, 'utf8'));
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('budget_exceeded');
    expect(res.destroyed).toBe(true);
    expect(h.targets().length).toBe(0);
  });

  it('robots on-wire compressed 512,001 → destroy；解压后 512,001 → destroy', async () => {
    // on-wire：压缩流本身 > 512,000（不可压缩数据）
    const h1 = createHarness({ autoRobots: false });
    const p1 = h1.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const res1 = h1.captured[0]!.openResponse(200, { 'content-encoding': 'gzip' });
    const incompressible = randomBytes(MAX_ROBOTS_RESPONSE_BYTES + 1024);
    res1.emit('data', gzipSync(incompressible)); // 压缩后仍 > 512,000
    const r1 = await p1;
    expect(r1.kind).toBe('failed');
    expect(res1.destroyed).toBe(true);

    // 解压后：压缩流小但解压 > 512,000
    const h2 = createHarness({ autoRobots: false });
    const p2 = h2.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const res2 = h2.captured[0]!.openResponse(200, { 'content-encoding': 'gzip' });
    res2.emit('data', gzipSync(Buffer.from('a'.repeat(MAX_ROBOTS_RESPONSE_BYTES + 1))));
    const r2 = await p2;
    expect(r2.kind).toBe('failed');
    expect(res2.destroyed).toBe(true);
  });

  it('robots 超限后，后续其它 host 的正常请求仍可用', async () => {
    const h = createHarness({ autoRobots: false });
    const p1 = h.stack.target.get({ url: 'https://a.example.com/feed', purpose: 'feed' });
    await flush();
    const res = h.captured[0]!.openResponse(200, {});
    const head = 'User-agent: aibrowse\nDisallow: /x\n';
    const body = head + '#'.repeat(MAX_ROBOTS_RESPONSE_BYTES + 1 - Buffer.byteLength(head, 'utf8'));
    res.emit('data', Buffer.from(body, 'utf8'));
    const r1 = await p1;
    expect(r1.kind).toBe('failed');
    expect(res.destroyed).toBe(true);

    const p2 = h.stack.target.get({ url: 'https://b.example.com/feed', purpose: 'feed' });
    await flush();
    expect(h.captured.length).toBe(2);
    h.captured[1]!.respond(404, {}, '');
    await flush();
    h.targets()[0]!.respond(200, {}, '<rss/>');
    expect((await p2).kind).toBe('ok');
  });
});

describe('R2 单资源总 deadline（零 DNS/零 socket / 不续杯 / 迟到事件零改终态）', () => {
  it('Invalid Date deadline 零 DNS、零 socket', async () => {
    const h = createHarness();
    const r = await h.stack.target.get({
      url: 'https://example.com/feed',
      purpose: 'feed',
      deadline: new Date(Number.NaN),
    });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
    expect(h.captured.length).toBe(0);
  });

  it('外部 deadline start+10s：10 秒内销毁', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const promise = h.stack.target.get({
      url: 'https://example.com/feed',
      purpose: 'feed',
      deadline: new Date(10_000),
    });
    await flush();
    clock.advanceTo(10_000);
    await flush();
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
  });

  it('外部 deadline start+60s：仍在内部 30 秒内销毁', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const promise = h.stack.target.get({
      url: 'https://example.com/feed',
      purpose: 'feed',
      deadline: new Date(60_000),
    });
    await flush();
    clock.advanceTo(30_000);
    await flush();
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
  });

  it('DNS + 两地址失败 + 静默 body 累计不得超过同一截止（不续杯）', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({
      clock,
      lookup: async () => [
        { address: '93.184.216.34', family: 4 as const },
        { address: '151.101.1.140', family: 4 as const },
      ],
    });
    const promise = h.stack.target.get({
      url: 'https://example.com/feed',
      purpose: 'feed',
      deadline: new Date(20_000),
    });
    await flush();
    // 首地址：20s 内第 5s 连接失败
    clock.advanceTo(5_000);
    h.targets()[0]!.error('ECONNREFUSED');
    await flush();
    // 次地址：第 10s 打开静默 body（socket timer = 剩余 10s → 20s 到期）
    clock.advanceTo(10_000);
    h.targets()[1]!.openResponse(200, {});
    await flush();
    clock.advanceTo(20_000);
    await flush();
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
  });

  it('到期后 socket 的迟到 chunk/end 不得改变终态或产生新 socket', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const res = h.targets()[0]!.openResponse(200, {});
    clock.advanceTo(30_000); // 总 deadline 到期 → socket 销毁 + fail
    await flush();
    res.emit('data', Buffer.from('late', 'utf8')); // 迟到事件
    res.emit('end');
    await flush();
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
    expect(h.targets().length).toBe(1); // 不产生新 socket
  });
});

describe('R3 安全工厂无条件装配真实 RobotsPolicy（无 robots 绕过）', () => {
  it('调用方强塞 robots gate 被忽略：工厂只装配真实 RobotsPolicy（产生真实 robots.txt 请求）', async () => {
    const captured: CapturedRequest[] = [];
    const factory: WatchRequestFactory = (options) => {
      const req = new FakeRequest();
      const cap = makeCap(req, options);
      captured.push(cap);
      if (isRobotsRequest(options)) {
        queueMicrotask(() => {
          if (!cap.responded) cap.respond(404, {}, '');
        });
      }
      return req;
    };
    const stack = createPublicWatchHttpStack({
      lookup: PUBLIC_LOOKUP,
      request: factory,
      robots: {
        checkAllowed: async () => {
          throw new Error('bypass-gate-should-be-ignored');
        },
      },
    } as unknown as PublicWatchStackSeams);
    const promise = stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    expect(captured.length).toBe(2);
    expect(isRobotsRequest(captured[0]!.options)).toBe(true);
    expect(captured[1]!.options.path).toBe('/feed');
    captured[1]!.respond(200, {}, '<rss/>');
    const r = await promise;
    expect(r.kind).toBe('ok');
  });
});

describe('R3 deadline/abort 生命周期（统一幂等 cleanup；迟到事件零副作用）', () => {
  it('identity 静默 body：总 deadline 到期后 response 已销毁，timer 已清除', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const res = h.targets()[0]!.openResponse(200, {});
    clock.advanceTo(30_000);
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
    expect(res.destroyed).toBe(true);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it('gzip 静默 body：总 deadline 到期后 response 与 inflater 均已销毁，listener 清除', async () => {
    const clock = new FakeClock(0);
    const inflaters: Gunzip[] = [];
    const h = createHarness({
      clock,
      createInflater: (_encoding, max) => {
        const s = createGunzip({ maxOutputLength: max });
        inflaters.push(s);
        return s;
      },
    });
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const res = h.targets()[0]!.openResponse(200, { 'content-encoding': 'gzip' });
    clock.advanceTo(30_000);
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
    expect(res.destroyed).toBe(true);
    expect(inflaters.length).toBe(1);
    expect(inflaters[0]!.destroyed).toBe(true);
    expect(inflaters[0]!.listenerCount('data')).toBe(0);
  });

  it('abort 关闭全部活动资源（request/response/inflater）', async () => {
    const controller = new AbortController();
    const inflaters: Gunzip[] = [];
    const h = createHarness({
      createInflater: (_encoding, max) => {
        const s = createGunzip({ maxOutputLength: max });
        inflaters.push(s);
        return s;
      },
    });
    const promise = h.stack.target.get({
      url: 'https://example.com/feed',
      purpose: 'feed',
      signal: controller.signal,
    });
    await flush();
    const res = h.targets()[0]!.openResponse(200, { 'content-encoding': 'gzip' });
    controller.abort();
    const r = await promise;
    expect(r.kind).toBe('aborted');
    expect(res.destroyed).toBe(true);
    expect(inflaters.length).toBe(1);
    expect(inflaters[0]!.destroyed).toBe(true);
  });

  it('deadline 到期后迟到 data/end/error 不写入、不改变终态、不创建新 socket（压缩路径）', async () => {
    const clock = new FakeClock(0);
    const inflaters: Gunzip[] = [];
    const h = createHarness({
      clock,
      createInflater: (_encoding, max) => {
        const s = createGunzip({ maxOutputLength: max });
        inflaters.push(s);
        return s;
      },
    });
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const res = h.targets()[0]!.openResponse(200, { 'content-encoding': 'gzip' });
    clock.advanceTo(30_000);
    // 同步终态后、response close 前的 drain 窗口：迟到的 error 由 product-owned response
    // drain 吸收（零未处理异常），data/end 无业务 listener 纯 no-op、不写入 inflater。
    res.emit('error', new Error('late'));
    res.emit('data', Buffer.from('late', 'utf8'));
    res.emit('end');
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
    // 业务终态已 settle：迟到的 error 由 product-owned response drain 吸收（零未处理异常）；
    // await 后 res 已 close → drain 自清理，res/inflater 业务 listener 与 drain 全部归零
    expect(res.destroyed).toBe(true);
    expect(inflaters[0]!.destroyed).toBe(true);
    expect(res.listenerCount('data')).toBe(0);
    expect(res.listenerCount('end')).toBe(0);
    expect(res.listenerCount('error')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
    expect(res.listenerCount('aborted')).toBe(0);
    expect(inflaters[0]!.listenerCount('data')).toBe(0);
    expect(inflaters[0]!.listenerCount('end')).toBe(0);
    expect(inflaters[0]!.listenerCount('error')).toBe(0);
    await flush();
    expect(h.targets().length).toBe(1);
    expect(res.listenerCount('data')).toBe(0);
    expect(res.listenerCount('error')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });

  it('settlement 后 timer 与 listener 被清除，迟到事件无副作用且无未处理 rejection', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      const res = h.targets()[0]!.openResponse(200, {});
      res.emit('data', Buffer.from('x', 'utf8'));
      await flush();
      res.emit('end');
      const r = await promise;
      expect(r.kind).toBe('ok');
      expect(clock.pendingTimerCount()).toBe(0);
      expect(res.listenerCount('data')).toBe(0);
      expect(res.listenerCount('end')).toBe(0);
      expect(res.listenerCount('error')).toBe(0);
      res.emit('data', Buffer.from('late', 'utf8'));
      res.emit('end');
      await flush();
      expect(unhandled.length).toBe(0);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});

describe('首终态立即闭合业务 listener/resource；drain 保留至各自 close（不依赖迟到事件触发清理）', () => {
  it('identity 静默 body 总 deadline 后：首终态业务 listener 归零 + drain 保留；close 后全部 listener 归零', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const res = h.targets()[0]!.openResponse(200, {});
    clock.advanceTo(30_000);
    // 首终态同步状态（response close 前）：业务 listener 已移除，drain 保留
    expect(res.listenerCount('data')).toBe(0);
    expect(res.listenerCount('end')).toBe(0);
    expect(res.listenerCount('aborted')).toBe(0);
    expect(res.listenerCount('error')).toBe(1); // 仅 responseErrorDrain
    expect(res.listenerCount('close')).toBe(1); // 仅 responseCloseCleanup
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
    expect(res.destroyed).toBe(true);
    expect(clock.pendingTimerCount()).toBe(0);
    // await 后 response 已 close：drain 自清理，全部 listener 归零
    for (const ev of ['data', 'end', 'error', 'aborted', 'close'] as const) {
      expect(res.listenerCount(ev)).toBe(0);
    }
  });

  it('gzip 静默 body 总 deadline 后：首终态业务 listener 归零 + drain 保留；close 后 response/inflater listener 归零', async () => {
    const clock = new FakeClock(0);
    const inflaters: Gunzip[] = [];
    const h = createHarness({
      clock,
      createInflater: (_encoding, max) => {
        const s = createGunzip({ maxOutputLength: max });
        inflaters.push(s);
        return s;
      },
    });
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const res = h.targets()[0]!.openResponse(200, { 'content-encoding': 'gzip' });
    clock.advanceTo(30_000);
    // 首终态同步状态（response close 前）：业务 listener 已移除，drain 保留
    expect(res.listenerCount('data')).toBe(0);
    expect(res.listenerCount('end')).toBe(0);
    expect(res.listenerCount('aborted')).toBe(0);
    expect(res.listenerCount('error')).toBe(1); // 仅 responseErrorDrain
    expect(res.listenerCount('close')).toBe(1); // 仅 responseCloseCleanup
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
    expect(res.destroyed).toBe(true);
    expect(inflaters.length).toBe(1);
    expect(inflaters[0]!.destroyed).toBe(true);
    // await 后 response 已 close：drain 自清理；inflater 业务 listener 已移除
    for (const ev of ['data', 'end', 'error', 'aborted', 'close'] as const) {
      expect(res.listenerCount(ev)).toBe(0);
    }
    for (const ev of ['data', 'end', 'error'] as const) {
      expect(inflaters[0]!.listenerCount(ev)).toBe(0);
    }
  });

  it('abort 后：首终态业务 listener 归零 + drain 保留；close 后 response/inflater listener 归零（不等待迟到事件）', async () => {
    const controller = new AbortController();
    const inflaters: Gunzip[] = [];
    const h = createHarness({
      createInflater: (_encoding, max) => {
        const s = createGunzip({ maxOutputLength: max });
        inflaters.push(s);
        return s;
      },
    });
    const promise = h.stack.target.get({
      url: 'https://example.com/feed',
      purpose: 'feed',
      signal: controller.signal,
    });
    await flush();
    const res = h.targets()[0]!.openResponse(200, { 'content-encoding': 'gzip' });
    controller.abort();
    // 首终态同步状态（response close 前）：业务 listener 已移除，drain 保留
    expect(res.listenerCount('data')).toBe(0);
    expect(res.listenerCount('end')).toBe(0);
    expect(res.listenerCount('aborted')).toBe(0);
    expect(res.listenerCount('error')).toBe(1); // 仅 responseErrorDrain
    expect(res.listenerCount('close')).toBe(1); // 仅 responseCloseCleanup
    const r = await promise;
    expect(r.kind).toBe('aborted');
    expect(res.destroyed).toBe(true);
    expect(inflaters.length).toBe(1);
    expect(inflaters[0]!.destroyed).toBe(true);
    // await 后 response 已 close：drain 自清理
    for (const ev of ['data', 'end', 'error', 'aborted', 'close'] as const) {
      expect(res.listenerCount(ev)).toBe(0);
    }
    for (const ev of ['data', 'end', 'error'] as const) {
      expect(inflaters[0]!.listenerCount(ev)).toBe(0);
    }
  });

  it('deadline 先于 response：首终态移除业务 response/error/timeout listener 且 requestErrorDrain 保留至 close（close 后全 0）', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const req = h.targets()[0]!.request;
    clock.advanceTo(30_000);
    // 首终态同步状态（request close 前）：业务 listener 已移除，drain 保留
    expect(req.listenerCount('response')).toBe(0);
    expect(req.listenerCount('timeout')).toBe(0);
    expect(req.listenerCount('error')).toBe(1); // 仅 requestErrorDrain
    expect(req.listenerCount('close')).toBe(1); // 仅 requestCloseCleanup
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
    expect(req.destroyed).toBe(true);
    // await 后 request 已 close：drain 自清理，全部 request listener 归零
    expect(req.listenerCount('response')).toBe(0);
    expect(req.listenerCount('error')).toBe(0);
    expect(req.listenerCount('timeout')).toBe(0);
    expect(req.listenerCount('close')).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
    // 终态后的 synthetic response 被忽略（不依赖存活 listener 销毁）：零新 socket、结果不变
    const late = h.targets()[0]!.openResponse(200, {});
    for (const ev of ['data', 'end', 'error', 'aborted'] as const) {
      expect(late.listenerCount(ev)).toBe(0);
    }
    await flush();
    expect(h.targets().length).toBe(1); // 零新 socket
  });

  it('abort 先于 response：首终态移除业务 response/error/timeout listener 且 requestErrorDrain 保留至 close（close 后全 0）', async () => {
    const clock = new FakeClock(0);
    const controller = new AbortController();
    const h = createHarness({ clock });
    const promise = h.stack.target.get({
      url: 'https://example.com/feed',
      purpose: 'feed',
      signal: controller.signal,
    });
    await flush();
    const req = h.targets()[0]!.request;
    controller.abort();
    // 首终态同步状态（request close 前）：业务 listener 已移除，drain 保留
    expect(req.listenerCount('response')).toBe(0);
    expect(req.listenerCount('timeout')).toBe(0);
    expect(req.listenerCount('error')).toBe(1); // 仅 requestErrorDrain
    expect(req.listenerCount('close')).toBe(1); // 仅 requestCloseCleanup
    const r = await promise;
    expect(r.kind).toBe('aborted');
    expect(req.destroyed).toBe(true);
    // await 后 request 已 close：drain 自清理，全部 request listener 归零
    expect(req.listenerCount('response')).toBe(0);
    expect(req.listenerCount('error')).toBe(0);
    expect(req.listenerCount('timeout')).toBe(0);
    expect(req.listenerCount('close')).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
    // 终态后的 synthetic response 被忽略：零新 socket
    h.targets()[0]!.openResponse(200, {});
    await flush();
    expect(h.targets().length).toBe(1); // 零新 socket
  });

  it('success/body-deadline/abort/request-error 后：首终态保留 drain，request close 后全部 request listener 归零', async () => {
    // success（终态在 body end 微任务；await 后 request 已 close → drain 自清理）
    {
      const h = createHarness();
      const p = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      h.targets()[0]!.respond(200, {}, '<rss/>');
      expect((await p).kind).toBe('ok');
      const req = h.targets()[0]!.request;
      expect(req.listenerCount('response')).toBe(0);
      expect(req.listenerCount('error')).toBe(0);
      expect(req.listenerCount('timeout')).toBe(0);
    }
    // body-deadline（response 已交付，静默 body；终态同步发生于 advanceTo）
    {
      const clock = new FakeClock(0);
      const h = createHarness({ clock });
      const p = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      h.targets()[0]!.openResponse(200, {});
      const req = h.targets()[0]!.request;
      clock.advanceTo(30_000);
      // 首终态同步状态（request close 前）：业务 listener 已移除，drain 保留
      expect(req.listenerCount('response')).toBe(0);
      expect(req.listenerCount('timeout')).toBe(0);
      expect(req.listenerCount('error')).toBe(1); // 仅 requestErrorDrain
      expect(req.listenerCount('close')).toBe(1); // 仅 requestCloseCleanup
      const r = await p;
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('unavailable');
      // await 后 request 已 close：drain 自清理
      expect(req.listenerCount('response')).toBe(0);
      expect(req.listenerCount('error')).toBe(0);
      expect(req.listenerCount('timeout')).toBe(0);
      expect(req.listenerCount('close')).toBe(0);
    }
    // abort（response 已交付；终态同步发生于 abort()）
    {
      const controller = new AbortController();
      const h = createHarness();
      const p = h.stack.target.get({
        url: 'https://example.com/feed',
        purpose: 'feed',
        signal: controller.signal,
      });
      await flush();
      h.targets()[0]!.openResponse(200, {});
      const req = h.targets()[0]!.request;
      controller.abort();
      // 首终态同步状态（request close 前）：业务 listener 已移除，drain 保留
      expect(req.listenerCount('response')).toBe(0);
      expect(req.listenerCount('timeout')).toBe(0);
      expect(req.listenerCount('error')).toBe(1); // 仅 requestErrorDrain
      expect(req.listenerCount('close')).toBe(1); // 仅 requestCloseCleanup
      const r = await p;
      expect(r.kind).toBe('aborted');
      // await 后 request 已 close：drain 自清理
      expect(req.listenerCount('response')).toBe(0);
      expect(req.listenerCount('error')).toBe(0);
      expect(req.listenerCount('timeout')).toBe(0);
      expect(req.listenerCount('close')).toBe(0);
    }
    // request-error（response 未交付；终态同步发生于 error()）
    {
      const h = createHarness();
      const p = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      h.targets()[0]!.error('ECONNREFUSED');
      const req = h.targets()[0]!.request;
      // 首终态同步状态（request close 前）：业务 listener 已移除，drain 保留
      expect(req.listenerCount('response')).toBe(0);
      expect(req.listenerCount('timeout')).toBe(0);
      expect(req.listenerCount('error')).toBe(1); // 仅 requestErrorDrain
      expect(req.listenerCount('close')).toBe(1); // 仅 requestCloseCleanup
      const r = await p;
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('unavailable');
      // await 后 request 已 close：drain 自清理
      expect(req.listenerCount('response')).toBe(0);
      expect(req.listenerCount('error')).toBe(0);
      expect(req.listenerCount('timeout')).toBe(0);
      expect(req.listenerCount('close')).toBe(0);
    }
  });

  it('终态后再发送 data/end/error/response：结果不变、零未处理异常、零 buffer/inflater 副作用', async () => {
    const clock = new FakeClock(0);
    const inflaters: Gunzip[] = [];
    const h = createHarness({
      clock,
      createInflater: (_encoding, max) => {
        const s = createGunzip({ maxOutputLength: max });
        inflaters.push(s);
        return s;
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      const res = h.targets()[0]!.openResponse(200, { 'content-encoding': 'gzip' });
      res.emit('data', gzipSync(Buffer.from('<rss/>', 'utf8')));
      res.emit('end');
      const r = await promise;
      expect(r.kind).toBe('ok');
      // await 后 request 已 close：业务 listener 与 request drain 全部归零
      const req = h.targets()[0]!.request;
      expect(req.listenerCount('response')).toBe(0);
      expect(req.listenerCount('error')).toBe(0);
      expect(req.listenerCount('timeout')).toBe(0);
      // response 已销毁且 drain 已自清理（close 后 error/close listener 为 0）：
      // 后续 data/end 纯 no-op；真实 Node 在 close 后不再发出 error，产品也未遗留
      // 任何 error listener 掩盖缺陷。
      res.emit('data', Buffer.from('late', 'utf8'));
      res.emit('end');
      expect(res.listenerCount('error')).toBe(0);
      expect(res.listenerCount('close')).toBe(0);
      // 迟到的 request response：已无 listener，纯 no-op（不创建新 socket）
      h.targets()[0]!.openResponse(200, {});
      expect(h.targets().length).toBe(1);
      expect(inflaters.length).toBe(1);
      expect(inflaters[0]!.destroyed).toBe(true);
      expect(res.listenerCount('data')).toBe(0);
      await flush();
      expect(unhandled.length).toBe(0);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});

describe('首终态移除业务 request listener（drain 保留至 close）+ 逐项异常隔离', () => {
  function trackUnhandled(): { unhandled: unknown[]; detach: () => void } {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    return {
      unhandled,
      detach: () => process.removeListener('unhandledRejection', onUnhandled),
    };
  }

  it('cleanup 后发送 synthetic response/data/end：结果不变、零新 socket、零 buffer/inflater 副作用、零未处理异常', async () => {
    const clock = new FakeClock(0);
    const inflaters: Gunzip[] = [];
    const h = createHarness({
      clock,
      createInflater: (_e, max) => {
        const s = createGunzip({ maxOutputLength: max });
        inflaters.push(s);
        return s;
      },
    });
    const t = trackUnhandled();
    try {
      const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      clock.advanceTo(30_000); // deadline 先于 response：首终态
      const r = await promise;
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('unavailable');
      const req = h.targets()[0]!.request;
      expect(req.listenerCount('response')).toBe(0);
      expect(req.listenerCount('error')).toBe(0);
      expect(req.listenerCount('timeout')).toBe(0);
      // 终态后 synthetic response + data/end：被忽略，零正文 listener、零 inflater 创建、零新 socket
      const late = h.targets()[0]!.openResponse(200, { 'content-encoding': 'gzip' });
      for (const ev of ['data', 'end', 'error', 'aborted'] as const) {
        expect(late.listenerCount(ev)).toBe(0);
      }
      late.emit('data', gzipSync(Buffer.from('late', 'utf8')));
      late.emit('end');
      await flush();
      expect(h.targets().length).toBe(1); // 零新 socket
      expect(inflaters.length).toBe(0); // 零 inflater 创建/驱动
      expect(r.kind).toBe('failed'); // 结果不变
      if (r.kind === 'failed') expect(r.health).toBe('unavailable');
      expect(t.unhandled.length).toBe(0); // 零未处理 rejection
    } finally {
      t.detach();
    }
  });

  it('request.destroy() 内同步发出 response：response 被安全丢弃；首终态 drain 保留，close 后全部 listener 归零', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const req = h.targets()[0]!.request;
    const syncRes = new FakeIncoming();
    syncRes.statusCode = 200;
    syncRes.headers = {};
    req.emitResponseOnDestroy = syncRes; // destroy() 内同步发出 response
    clock.advanceTo(30_000);
    // 首终态同步状态（request close 前）：业务 listener 已移除，request drain 保留；
    // 同步 response 已被 call-stack guard 先装 drain 再 destroy
    expect(syncRes.destroyed).toBe(true);
    expect(req.listenerCount('response')).toBe(0);
    expect(req.listenerCount('timeout')).toBe(0);
    expect(req.listenerCount('error')).toBe(1); // 仅 requestErrorDrain
    expect(req.listenerCount('close')).toBe(1); // 仅 requestCloseCleanup
    expect(syncRes.listenerCount('error')).toBe(1); // 仅 responseErrorDrain
    expect(syncRes.listenerCount('close')).toBe(1); // 仅 responseCloseCleanup
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
    // await 后 request 与同步 response 均已 close：drain 自清理，全部 listener 归零
    expect(req.listenerCount('response')).toBe(0);
    expect(req.listenerCount('error')).toBe(0);
    expect(req.listenerCount('timeout')).toBe(0);
    expect(req.listenerCount('close')).toBe(0);
    expect(syncRes.listenerCount('error')).toBe(0);
    expect(syncRes.listenerCount('close')).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it('单项抛错隔离：response.removeListener 抛错，其余 listener/timer/resource 继续清理', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const t = trackUnhandled();
    try {
      const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      const res = h.targets()[0]!.openResponse(200, {});
      res.removeListener = (() => {
        throw new Error('injected response.removeListener failure');
      }) as unknown as typeof res.removeListener;
      clock.advanceTo(30_000);
      const r = await promise;
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('unavailable');
      const req = h.targets()[0]!.request;
      expect(req.listenerCount('response')).toBe(0);
      expect(req.listenerCount('error')).toBe(0);
      expect(req.listenerCount('timeout')).toBe(0);
      expect(res.destroyed).toBe(true); // response.destroy 仍执行
      expect(req.destroyed).toBe(true); // request.destroy 仍执行
      expect(clock.pendingTimerCount()).toBe(0); // timer 已清除
      expect(t.unhandled.length).toBe(0);
    } finally {
      t.detach();
    }
  });

  it('单项抛错隔离：inflater.removeListener 抛错，其余 listener/timer/resource 继续清理', async () => {
    const clock = new FakeClock(0);
    const inflaters: Gunzip[] = [];
    const h = createHarness({
      clock,
      createInflater: (_e, max) => {
        const s = createGunzip({ maxOutputLength: max });
        s.removeListener = (() => {
          throw new Error('injected inflater.removeListener failure');
        }) as unknown as Gunzip['removeListener'];
        inflaters.push(s);
        return s;
      },
    });
    const t = trackUnhandled();
    try {
      const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      const res = h.targets()[0]!.openResponse(200, { 'content-encoding': 'gzip' });
      clock.advanceTo(30_000);
      const r = await promise;
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('unavailable');
      const req = h.targets()[0]!.request;
      expect(req.listenerCount('response')).toBe(0);
      expect(req.listenerCount('error')).toBe(0);
      expect(req.listenerCount('timeout')).toBe(0);
      expect(res.destroyed).toBe(true);
      expect(inflaters[0]!.destroyed).toBe(true); // inflater.destroy 仍执行
      expect(clock.pendingTimerCount()).toBe(0);
      expect(t.unhandled.length).toBe(0);
    } finally {
      t.detach();
    }
  });

  it('单项抛错隔离：inflater.destroy 抛错，其余 listener/timer/resource 继续清理', async () => {
    const clock = new FakeClock(0);
    const inflaters: Gunzip[] = [];
    const h = createHarness({
      clock,
      createInflater: (_e, max) => {
        const s = createGunzip({ maxOutputLength: max });
        s.destroy = (() => {
          throw new Error('injected inflater.destroy failure');
        }) as unknown as Gunzip['destroy'];
        inflaters.push(s);
        return s;
      },
    });
    const t = trackUnhandled();
    try {
      const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      const res = h.targets()[0]!.openResponse(200, { 'content-encoding': 'gzip' });
      clock.advanceTo(30_000);
      const r = await promise;
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('unavailable');
      const req = h.targets()[0]!.request;
      expect(req.listenerCount('response')).toBe(0);
      expect(req.listenerCount('error')).toBe(0);
      expect(req.listenerCount('timeout')).toBe(0);
      for (const ev of ['data', 'end', 'error', 'aborted'] as const) {
        expect(res.listenerCount(ev)).toBe(0);
      }
      expect(inflaters[0]!.listenerCount('data')).toBe(0); // removeListener/removeAllListeners 已执行
      expect(clock.pendingTimerCount()).toBe(0);
      expect(t.unhandled.length).toBe(0);
    } finally {
      t.detach();
    }
  });

  it('单项抛错隔离：response.destroy 抛错，其余 listener/timer/resource 继续清理', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const t = trackUnhandled();
    try {
      const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      const res = h.targets()[0]!.openResponse(200, {});
      res.failDestroy = true;
      clock.advanceTo(30_000);
      const r = await promise;
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('unavailable');
      const req = h.targets()[0]!.request;
      expect(req.listenerCount('response')).toBe(0);
      expect(req.listenerCount('error')).toBe(0);
      expect(req.listenerCount('timeout')).toBe(0);
      // releaseBody 已移除 res 业务 listener（data/end/aborted）；response.destroy 抛错后
      // response 未销毁也未 close，product-owned response drain（error/close）按契约保留至
      // response close——此处断言 drain 存在且不泄漏未处理异常。
      for (const ev of ['data', 'end', 'aborted'] as const) {
        expect(res.listenerCount(ev)).toBe(0); // releaseBody 已移除 res 业务 listener
      }
      expect(res.listenerCount('error')).toBe(1); // product-owned response drain
      expect(res.listenerCount('close')).toBe(1); // drain close cleanup
      expect(req.destroyed).toBe(true);
      expect(clock.pendingTimerCount()).toBe(0);
      expect(t.unhandled.length).toBe(0);
    } finally {
      t.detach();
    }
  });

  it('单项抛错隔离：request.removeListener 抛错，其余 listener/timer/resource 继续清理', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const t = trackUnhandled();
    try {
      const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      const req = h.targets()[0]!.request;
      const res = h.targets()[0]!.openResponse(200, {});
      req.removeListener = (() => {
        throw new Error('injected request.removeListener failure');
      }) as unknown as typeof req.removeListener;
      clock.advanceTo(30_000);
      const r = await promise;
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('unavailable');
      expect(req.destroyed).toBe(true); // request.destroy 仍执行
      expect(res.destroyed).toBe(true); // response.destroy 仍执行
      expect(clock.pendingTimerCount()).toBe(0); // timer 已清除
      expect(t.unhandled.length).toBe(0);
    } finally {
      t.detach();
    }
  });

  it('单项抛错隔离：request.destroy 抛错，listener/timer/response 继续清理', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const t = trackUnhandled();
    try {
      const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      const req = h.targets()[0]!.request;
      req.failDestroy = true;
      const res = h.targets()[0]!.openResponse(200, {});
      clock.advanceTo(30_000);
      const r = await promise;
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('unavailable');
      expect(req.listenerCount('response')).toBe(0); // finally 仍移除 response listener
      expect(req.listenerCount('error')).toBe(0);
      expect(req.listenerCount('timeout')).toBe(0);
      expect(res.destroyed).toBe(true);
      expect(clock.pendingTimerCount()).toBe(0);
      expect(t.unhandled.length).toBe(0);
    } finally {
      t.detach();
    }
  });

  it('单项抛错隔离：timer clear 抛错，request/response 清理继续', async () => {
    let failClear = false;
    const clock = new FakeClock(0);
    const origClear = clock.clearTimeout.bind(clock);
    clock.clearTimeout = ((handle: Parameters<FakeClock['clearTimeout']>[0]) => {
      if (failClear) throw new Error('injected clearTimeout failure');
      return origClear(handle);
    }) as unknown as FakeClock['clearTimeout'];
    const h = createHarness({ clock });
    const t = trackUnhandled();
    try {
      const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      const res = h.targets()[0]!.openResponse(200, {});
      failClear = true; // DNS/robots 已结算，此后 clearTimeout 抛错
      clock.advanceTo(30_000);
      const r = await promise;
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('unavailable');
      const req = h.targets()[0]!.request;
      expect(req.listenerCount('response')).toBe(0);
      expect(req.listenerCount('error')).toBe(0);
      expect(req.listenerCount('timeout')).toBe(0);
      expect(res.destroyed).toBe(true);
      expect(req.destroyed).toBe(true);
      expect(t.unhandled.length).toBe(0);
    } finally {
      t.detach();
    }
  });

  it('单项抛错隔离：AbortSignal removeEventListener 抛错，request/response/timer 清理继续', async () => {
    const clock = new FakeClock(0);
    const controller = new AbortController();
    let failRemove = false;
    const signal = new Proxy(controller.signal, {
      get(target, prop, receiver) {
        if (prop === 'removeEventListener') {
          return (type: string, listener: () => void, options?: EventListenerOptions): void => {
            if (failRemove) throw new Error('injected removeEventListener failure');
            target.removeEventListener(type, listener, options);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as AbortSignal;
    const h = createHarness({ clock });
    const t = trackUnhandled();
    try {
      const promise = h.stack.target.get({
        url: 'https://example.com/feed',
        purpose: 'feed',
        signal,
      });
      await flush();
      const res = h.targets()[0]!.openResponse(200, {});
      failRemove = true; // DNS/robots 已结算，此后 removeEventListener 抛错
      controller.abort();
      const r = await promise;
      expect(r.kind).toBe('aborted');
      const req = h.targets()[0]!.request;
      expect(req.listenerCount('response')).toBe(0);
      expect(req.listenerCount('error')).toBe(0);
      expect(req.listenerCount('timeout')).toBe(0);
      expect(res.destroyed).toBe(true);
      expect(req.destroyed).toBe(true);
      expect(clock.pendingTimerCount()).toBe(0);
      expect(t.unhandled.length).toBe(0);
    } finally {
      t.detach();
    }
  });
});

describe('D3-R6 两阶段终态：business terminal 与 emitter-local request/response drain', () => {
  function trackUnhandled(): { unhandled: unknown[]; detach: () => void } {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    return {
      unhandled,
      detach: () => process.removeListener('unhandledRejection', onUnhandled),
    };
  }

  function namesOf(emitter: EventEmitter, ev: string): string[] {
    return emitter.listeners(ev).map((f) => (f as { name?: string }).name ?? '');
  }

  // 只让「移除指定 callback」抛错：精确命中 drain 的 error sink / close cleanup，不影响业务 listener 清理。
  function makeRemoveThrowOnCallback(emitter: EventEmitter, cb: unknown): void {
    const origRemove = emitter.removeListener.bind(emitter) as (...args: unknown[]) => unknown;
    emitter.removeListener = ((ev: unknown, c: unknown): unknown => {
      if (c === cb) throw new Error(`injected removeListener(${String(ev)}) failure`);
      return origRemove(ev, c);
    }) as unknown as typeof emitter.removeListener;
  }

  it('request 创建后立即安装 named request drain；业务终态后 drain 保留至 close，close 后归零', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const req = h.targets()[0]!.request;
    // 创建后立即安装：error sink + close cleanup，业务 listener 随后
    expect(namesOf(req, 'error')).toEqual(['requestErrorDrain', 'onRequestError']);
    expect(namesOf(req, 'close')).toEqual(['requestCloseCleanup']);
    expect(req.listenerCount('response')).toBe(1); // 业务 onResponse
    expect(req.listenerCount('timeout')).toBe(1); // 业务 onRequestTimeout
    clock.advanceTo(30_000); // 同步终态：cleanup 同步执行，request.destroy 调度异步 error+close
    // 终态同步后、request close 前：业务 listener 已归零，drain 仍保留
    expect(req.listenerCount('response')).toBe(0);
    expect(req.listenerCount('timeout')).toBe(0);
    expect(req.listenerCount('error')).toBe(1); // 仅 requestErrorDrain
    expect(req.listenerCount('close')).toBe(1); // 仅 requestCloseCleanup
    expect(namesOf(req, 'error')).toEqual(['requestErrorDrain']);
    const r = await promise;
    expect(r.kind).toBe('failed');
    // close 后 drain 归零；异步 destroy error 由 drain 吸收
    expect(req.listenerCount('error')).toBe(0);
    expect(req.listenerCount('close')).toBe(0);
    expect(req.listenerCount('response')).toBe(0);
    expect(req.listenerCount('timeout')).toBe(0);
  });

  it('response 一经交付先装 named response drain，再进 body reader；close 后 drain 归零', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const res = h.targets()[0]!.openResponse(200, {});
    // 交付同步：drain 先装（error/close），body reader 业务 listener 随后
    expect(namesOf(res, 'error')).toEqual(['responseErrorDrain', 'onSourceError']);
    expect(namesOf(res, 'close')).toEqual(['responseCloseCleanup']);
    expect(res.listenerCount('data')).toBe(1);
    expect(res.listenerCount('end')).toBe(1);
    expect(res.listenerCount('aborted')).toBe(1);
    clock.advanceTo(30_000);
    // 终态同步后、close 前：业务 listener 归零，drain 仍保留
    expect(res.listenerCount('data')).toBe(0);
    expect(res.listenerCount('end')).toBe(0);
    expect(res.listenerCount('aborted')).toBe(0);
    expect(res.listenerCount('error')).toBe(1); // 仅 responseErrorDrain
    expect(res.listenerCount('close')).toBe(1); // 仅 responseCloseCleanup
    const r = await promise;
    expect(r.kind).toBe('failed');
    // close 后 drain 归零
    expect(res.listenerCount('error')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });

  it('HEAD/redirect discard 路径同样先装 response drain；close 后归零', async () => {
    const h = createHarness();
    const p = h.stack.target.head({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const res = h.targets()[0]!.openResponse(200, {});
    expect(namesOf(res, 'error')[0]).toBe('responseErrorDrain');
    expect(res.listenerCount('data')).toBe(0); // HEAD 不接 body reader
    const r = await p;
    expect(r.kind).toBe('ok');
    expect(res.listenerCount('error')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });

  it('确定性敌手 seam：强制异步 aborted → error → close；error 由 product-owned drain 吸收并 close 归零（非真实 Node 必然顺序）', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const t = trackUnhandled();
    try {
      const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      const res = h.targets()[0]!.openResponse(200, {});
      res.adversaryError = new Error('adversary ECONNRESET');
      clock.advanceTo(30_000);
      // 终态同步后：业务 listener 已归零，drain 保留；强制 error 即将被 drain 接收
      expect(res.listenerCount('error')).toBe(1); // 仅 responseErrorDrain
      const r = await promise;
      expect(r.kind).toBe('failed');
      // forced aborted → error → close：error 由 drain 吸收，close 后归零，零未处理异常
      expect(res.listenerCount('error')).toBe(0);
      expect(res.listenerCount('close')).toBe(0);
      expect(res.destroyed).toBe(true);
      expect(t.unhandled.length).toBe(0);
    } finally {
      t.detach();
    }
  });

  it('never-close seam：业务 Promise 已结算，零 timer/AbortSignal/正文/解压器/业务闭包；仅 emitter-local drain pair 保留', async () => {
    const clock = new FakeClock(0);
    const controller = new AbortController();
    const inflaters: Gunzip[] = [];
    const h = createHarness({
      clock,
      createInflater: (_e, max) => {
        const s = createGunzip({ maxOutputLength: max });
        inflaters.push(s);
        return s;
      },
    });
    const promise = h.stack.target.get({
      url: 'https://example.com/feed',
      purpose: 'feed',
      signal: controller.signal,
    });
    await flush();
    const req = h.targets()[0]!.request;
    const res = h.targets()[0]!.openResponse(200, { 'content-encoding': 'gzip' });
    req.neverClose = true; // request destroy 不投递 close
    res.neverClose = true; // response destroy 不投递 close
    clock.advanceTo(30_000);
    const r = await promise;
    expect(r.kind).toBe('failed');
    // 业务终态：timer 0、inflater 已销毁、业务 listener 0
    expect(clock.pendingTimerCount()).toBe(0);
    expect(inflaters.length).toBe(1);
    expect(inflaters[0]!.destroyed).toBe(true);
    expect(req.listenerCount('response')).toBe(0);
    expect(req.listenerCount('timeout')).toBe(0);
    for (const ev of ['data', 'end', 'aborted'] as const) {
      expect(res.listenerCount(ev)).toBe(0);
    }
    // 仅保留 emitter-local drain pair（close 永不到达 → 随不可达 transport GC）
    expect(req.listenerCount('error')).toBe(1);
    expect(req.listenerCount('close')).toBe(1);
    expect(res.listenerCount('error')).toBe(1);
    expect(res.listenerCount('close')).toBe(1);
    expect(namesOf(req, 'error')).toEqual(['requestErrorDrain']);
    expect(namesOf(res, 'error')).toEqual(['responseErrorDrain']);
    // AbortSignal listener 已移除：终态后 abort 不再触发任何业务副作用
    controller.abort();
    await flush();
    expect(r.kind).toBe('failed');
    expect(clock.pendingTimerCount()).toBe(0);
    expect(req.listenerCount('error')).toBe(1); // 仍只 drain，无新业务 listener
  });

  it('close 自清理后重复调用保存的 drain callback 幂等、零业务副作用', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const t = trackUnhandled();
    try {
      const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      const req = h.targets()[0]!.request;
      const res = h.targets()[0]!.openResponse(200, {});
      const reqCloseCb = req.listeners('close')[0] as () => void;
      const reqErrorSink = req.listeners('error')[0] as (err: Error) => void;
      const resCloseCb = res.listeners('close')[0] as () => void;
      const resErrorSink = res.listeners('error')[0] as (err: Error) => void;
      expect((reqErrorSink as { name?: string }).name).toBe('requestErrorDrain');
      expect((resErrorSink as { name?: string }).name).toBe('responseErrorDrain');
      clock.advanceTo(30_000);
      const r = await promise;
      expect(r.kind).toBe('failed');
      // close 后 drain 已自清理
      expect(req.listenerCount('error')).toBe(0);
      expect(req.listenerCount('close')).toBe(0);
      expect(res.listenerCount('error')).toBe(0);
      expect(res.listenerCount('close')).toBe(0);
      // 保存的 callback 重复调用幂等：纯 no-op，零业务副作用、零未处理异常
      reqCloseCb();
      reqCloseCb();
      resCloseCb();
      resCloseCb();
      reqErrorSink(new Error('late'));
      resErrorSink(new Error('late'));
      await flush();
      expect(r.kind).toBe('failed');
      expect(t.unhandled.length).toBe(0);
    } finally {
      t.detach();
    }
  });

  it('request close cleanup：removeListener(error sink) 抛错不阻止 removeListener(close)，零未处理异常', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const t = trackUnhandled();
    try {
      const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      const req = h.targets()[0]!.request;
      const drainSink = req.listeners('error')[0]; // requestErrorDrain（先装）
      makeRemoveThrowOnCallback(req, drainSink);
      clock.advanceTo(30_000);
      const r = await promise;
      expect(r.kind).toBe('failed');
      // error sink 移除抛错（隔离捕获）；close cleanup 仍成功移除自身 close listener
      expect(req.listenerCount('error')).toBe(1); // 泄漏的 requestErrorDrain（remove 抛错）
      expect(req.listenerCount('close')).toBe(0);
      expect(t.unhandled.length).toBe(0);
    } finally {
      t.detach();
    }
  });

  it('request close cleanup：removeListener(close cleanup) 抛错不阻止 removeListener(error)，零未处理异常', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const t = trackUnhandled();
    try {
      const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      const req = h.targets()[0]!.request;
      const drainCloseCb = req.listeners('close')[0]; // requestCloseCleanup
      makeRemoveThrowOnCallback(req, drainCloseCb);
      clock.advanceTo(30_000);
      const r = await promise;
      expect(r.kind).toBe('failed');
      // close cleanup 自身移除抛错（隔离捕获）；error sink 仍成功移除
      expect(req.listenerCount('error')).toBe(0);
      expect(req.listenerCount('close')).toBe(1); // 泄漏的 requestCloseCleanup（remove 抛错）
      expect(t.unhandled.length).toBe(0);
    } finally {
      t.detach();
    }
  });

  it('response close cleanup：removeListener(error sink) 抛错不阻止 removeListener(close)，零未处理异常', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const t = trackUnhandled();
    try {
      const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      const res = h.targets()[0]!.openResponse(200, {});
      const drainSink = res.listeners('error')[0]; // responseErrorDrain（先装）
      makeRemoveThrowOnCallback(res, drainSink);
      clock.advanceTo(30_000);
      const r = await promise;
      expect(r.kind).toBe('failed');
      expect(res.listenerCount('error')).toBe(1); // 泄漏的 responseErrorDrain（remove 抛错）
      expect(res.listenerCount('close')).toBe(0);
      expect(t.unhandled.length).toBe(0);
    } finally {
      t.detach();
    }
  });

  it('response close cleanup：removeListener(close cleanup) 抛错不阻止 removeListener(error)，零未处理异常', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const t = trackUnhandled();
    try {
      const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      const res = h.targets()[0]!.openResponse(200, {});
      const drainCloseCb = res.listeners('close')[0]; // responseCloseCleanup
      makeRemoveThrowOnCallback(res, drainCloseCb);
      clock.advanceTo(30_000);
      const r = await promise;
      expect(r.kind).toBe('failed');
      expect(res.listenerCount('error')).toBe(0);
      expect(res.listenerCount('close')).toBe(1); // 泄漏的 responseCloseCleanup（remove 抛错）
      expect(t.unhandled.length).toBe(0);
    } finally {
      t.detach();
    }
  });

  it('request.destroy 同步抛错：至多一次受控 abort fallback；终态一次、drain close 后归零', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const t = trackUnhandled();
    try {
      const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      const req = h.targets()[0]!.request;
      const res = h.targets()[0]!.openResponse(200, {});
      req.failDestroy = true;
      const origAbort = req.abort.bind(req);
      let abortCalls = 0;
      req.abort = (): void => {
        abortCalls += 1;
        origAbort();
      };
      clock.advanceTo(30_000);
      const r = await promise;
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('unavailable');
      expect(abortCalls).toBe(1); // 至多一次 abort fallback
      expect(req.listenerCount('error')).toBe(0); // abort → close → drain 归零
      expect(req.listenerCount('close')).toBe(0);
      expect(res.listenerCount('error')).toBe(0); // response destroy + close 正常
      expect(res.listenerCount('close')).toBe(0);
      expect(clock.pendingTimerCount()).toBe(0);
      expect(t.unhandled.length).toBe(0);
    } finally {
      t.detach();
    }
  });

  it('response.destroy 缺失 → drain 先装后 resume 排空；close 后 drain 归零', async () => {
    const h = createHarness();
    const p = h.stack.target.head({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const res = new FakeIncoming();
    res.statusCode = 200;
    res.headers = {};
    res.destroy = undefined as unknown as FakeIncoming['destroy'];
    const origResume = res.resume.bind(res);
    let resumed = 0;
    res.resume = ((): void => {
      resumed += 1;
      origResume();
    }) as unknown as FakeIncoming['resume'];
    h.targets()[0]!.request.emit('response', res);
    // drain 先装，destroy 缺失 → resume 排空
    expect(namesOf(res, 'error')[0]).toBe('responseErrorDrain');
    expect(resumed).toBe(1);
    const r = await p;
    expect(r.kind).toBe('ok');
    expect(res.listenerCount('error')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });

  it('response.destroy 同步抛错 → drain 先装后 resume 排空；close 后 drain 归零', async () => {
    const h = createHarness();
    const p = h.stack.target.head({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const res = new FakeIncoming();
    res.statusCode = 200;
    res.headers = {};
    res.failDestroy = true;
    const origResume = res.resume.bind(res);
    let resumed = 0;
    res.resume = ((): void => {
      resumed += 1;
      origResume();
    }) as unknown as FakeIncoming['resume'];
    h.targets()[0]!.request.emit('response', res);
    expect(namesOf(res, 'error')[0]).toBe('responseErrorDrain');
    expect(resumed).toBe(1);
    const r = await p;
    expect(r.kind).toBe('ok');
    expect(res.listenerCount('error')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });

  it('call-stack guard：request.destroy 内同步 late response 先装 drain 再 destroy，close 后归零', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const t = trackUnhandled();
    try {
      const promise = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      const req = h.targets()[0]!.request;
      const syncRes = new FakeIncoming();
      syncRes.statusCode = 200;
      syncRes.headers = {};
      req.emitResponseOnDestroy = syncRes; // destroy() 内同步发出 response
      clock.advanceTo(30_000);
      // guard 先为 sync response 安装 drain，再 destroy
      expect(syncRes.destroyed).toBe(true);
      expect(namesOf(syncRes, 'error')[0]).toBe('responseErrorDrain');
      expect(req.listenerCount('response')).toBe(0); // guard 已移除
      const r = await promise;
      expect(r.kind).toBe('failed');
      // sync response close 后 drain 归零；request drain 也随 close 归零
      expect(syncRes.listenerCount('error')).toBe(0);
      expect(syncRes.listenerCount('close')).toBe(0);
      expect(req.listenerCount('error')).toBe(0);
      expect(req.listenerCount('close')).toBe(0);
      expect(clock.pendingTimerCount()).toBe(0);
      expect(t.unhandled.length).toBe(0);
    } finally {
      t.detach();
    }
  });

  it('success/deadline/abort/request-error/body-error/budget-error 每类终态恰好结算一次且迟到事件零改态', async () => {
    // success
    {
      const h = createHarness();
      const p = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      h.targets()[0]!.respond(200, {}, '<rss/>');
      const r = await p;
      expect(r.kind).toBe('ok');
      // 迟到事件零改态（request 已 close：error 不再被真实 Node 发出，只验证其它迟到事件不触发二次结算）
      h.targets()[0]!.timeout();
      h.targets()[0]!.openResponse(200, {});
      await flush();
      expect(r.kind).toBe('ok');
    }
    // deadline
    {
      const clock = new FakeClock(0);
      const h = createHarness({ clock });
      const p = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      clock.advanceTo(30_000);
      const r = await p;
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('unavailable');
      h.targets()[0]!.timeout();
      h.targets()[0]!.openResponse(200, {});
      await flush();
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('unavailable');
    }
    // abort
    {
      const controller = new AbortController();
      const h = createHarness();
      const p = h.stack.target.get({
        url: 'https://example.com/feed',
        purpose: 'feed',
        signal: controller.signal,
      });
      await flush();
      controller.abort();
      const r = await p;
      expect(r.kind).toBe('aborted');
      h.targets()[0]!.timeout();
      h.targets()[0]!.openResponse(200, {});
      await flush();
      expect(r.kind).toBe('aborted');
    }
    // request-error
    {
      const h = createHarness();
      const p = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      h.targets()[0]!.error('ECONNREFUSED');
      const r = await p;
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('unavailable');
      h.targets()[0]!.timeout();
      h.targets()[0]!.openResponse(200, {});
      await flush();
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('unavailable');
    }
    // body-error（压缩流中途 error → stream-error 终态一次；response close 后迟到 data 零改态）
    {
      const h = createHarness();
      const p = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      const res = h.targets()[0]!.openResponse(200, { 'content-encoding': 'gzip' });
      res.emit('error', new Error('mid-stream'));
      const r = await p;
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('unavailable');
      res.emit('data', Buffer.from('late', 'utf8'));
      await flush();
      expect(r.kind).toBe('failed');
    }
    // budget-error
    {
      const h = createHarness();
      const p = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      const res = h.targets()[0]!.openResponse(200, {});
      res.emit('data', Buffer.alloc(MAX_FEED_RESPONSE_BYTES + 1, 0x61));
      const r = await p;
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('budget_exceeded');
      res.emit('data', Buffer.alloc(10, 0x61));
      await flush();
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('budget_exceeded');
    }
  });
});

describe('R3 IPv6 robots authority（真实工厂链）', () => {
  it('https://[2606:4700:4700::1111]/feed → 首次请求精确到该 IPv6 authority 的 /robots.txt → 目标到达受控 socket', async () => {
    const h = createHarness({ autoRobots: false });
    const promise = h.stack.target.get({
      url: 'https://[2606:4700:4700::1111]/feed',
      purpose: 'feed',
    });
    await flush();
    expect(h.captured.length).toBe(1);
    const robots = h.captured[0]!;
    expect(robots.options.method).toBe('GET');
    expect(robots.options.protocol).toBe('https:');
    expect(robots.options.hostname).toBe('2606:4700:4700::1111');
    expect(robots.options.port).toBe(443);
    expect(robots.options.path).toBe('/robots.txt');
    robots.respond(404, {}, '');
    await flush();
    expect(h.targets().length).toBe(1);
    const target = h.targets()[0]!;
    expect(target.options.hostname).toBe('2606:4700:4700::1111');
    expect(target.options.path).toBe('/feed');
    target.respond(200, {}, '<rss/>');
    const r = await promise;
    expect(r.kind).toBe('ok');
  });
});

describe('classifyPublicHttpStatus', () => {
  it('2xx ok / 304 unchanged / 3xx redirect / 404·410 parse-changed / 401·403·429·5xx unavailable / 其余 4xx parse-changed', () => {
    expect(classifyPublicHttpStatus(200)).toBe('ok');
    expect(classifyPublicHttpStatus(201)).toBe('ok');
    expect(classifyPublicHttpStatus(304)).toBe('unchanged-http');
    expect(classifyPublicHttpStatus(301)).toBe('redirect');
    expect(classifyPublicHttpStatus(302)).toBe('redirect');
    expect(classifyPublicHttpStatus(404)).toBe('parse-changed');
    expect(classifyPublicHttpStatus(410)).toBe('parse-changed');
    expect(classifyPublicHttpStatus(401)).toBe('unavailable');
    expect(classifyPublicHttpStatus(403)).toBe('unavailable');
    expect(classifyPublicHttpStatus(429)).toBe('unavailable');
    expect(classifyPublicHttpStatus(500)).toBe('unavailable');
    expect(classifyPublicHttpStatus(503)).toBe('unavailable');
    expect(classifyPublicHttpStatus(400)).toBe('parse-changed');
    expect(classifyPublicHttpStatus(451)).toBe('parse-changed');
  });
});

// ---------------------------------------------------------------------------
// D5 E：hostGate 注入（FIXED 2/5）——每个实际 socket start（robots/目标/redirect/
// 地址重试）前登记式取得 gate 许可；同 canonical host:effectivePort 相邻 start ≥5s；
// redirect 到新 host 重入对应 gate。缺省（未注入）→ D3 独立行为不变（既有测试全绿）。
// ---------------------------------------------------------------------------
describe('D5 E：PublicWatchStackSeams.hostGate 注入（FIXED 2/5）', () => {
  function gateHarness(
    clock: FakeClock,
    gate: HostRequestGate,
    opts: { lookup?: (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]> } = {},
  ) {
    const captured: CapturedRequest[] = [];
    const startTimes: number[] = [];
    const factory: WatchRequestFactory = (options) => {
      startTimes.push(clock.now().getTime());
      const req = new FakeRequest();
      const cap = makeCap(req, options);
      captured.push(cap);
      if (isRobotsRequest(options)) {
        queueMicrotask(() => {
          if (!cap.responded) cap.respond(404, {}, '');
        });
      }
      return req;
    };
    const stack = createPublicWatchHttpStack({
      lookup: opts.lookup ?? PUBLIC_LOOKUP,
      request: factory,
      clock,
      timeoutMs: 30_000,
      hostGate: gate,
    } as unknown as PublicWatchStackSeams);
    return {
      stack,
      captured,
      startTimes,
      targets: (): CapturedRequest[] => captured.filter((c) => !isRobotsRequest(c.options)),
    };
  }

  it('robots 与目标 socket 起点两两 ≥5000ms（同 host 登记制）', async () => {
    const clock = new FakeClock(0);
    const gate = new HostRequestGate({ clock });
    const h = gateHarness(clock, gate);
    const p = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush(); // robots 404 microtask + robots socket（T0）
    expect(h.captured.length).toBe(1);
    expect(h.startTimes[0]).toBe(0);
    expect(gate.lastStartedAt('example.com:443')).toBe(0);
    clock.advanceBy(5_000); // gate 允许目标 socket
    await flush();
    expect(h.captured.length).toBe(2);
    h.targets()[0]!.respond(200, {}, 'ok'); // 响应目标请求
    const r = await p;
    expect(r.kind).toBe('ok');
    expect(h.captured.length).toBe(2);
    expect(h.startTimes[1]! - h.startTimes[0]!).toBe(5_000);
    expect(gate.lastStartedAt('example.com:443')).toBe(5_000);
  });

  it('redirect 到新 host 重入对应 gate：各 host 内相邻 socket ≥5000ms，跨 host 不阻塞', async () => {
    const clock = new FakeClock(0);
    const gate = new HostRequestGate({ clock });
    const h = gateHarness(clock, gate);
    const p = h.stack.target.get({ url: 'https://old.example.com/feed', purpose: 'feed' });
    await flush(); // robots(old) T0
    expect(h.captured.length).toBe(1);
    clock.advanceBy(5_000); // target(old)
    await flush();
    expect(h.captured.length).toBe(2);
    h.targets()[0]!.respond(302, { location: 'https://new.example.com/page' }, '');
    await flush(); // redirect → robots(new)（新 host key 首次 → 立即，T5000）
    expect(h.captured.length).toBe(3);
    clock.advanceBy(5_000); // target(new)（新 host gate 间隔）
    await flush();
    expect(h.captured.length).toBe(4);
    h.targets()[1]!.respond(200, {}, 'ok');
    const r = await p;
    expect(r.kind).toBe('ok');
    // 顺序：robots(old) T0、target(old) T5000、robots(new) T5000、target(new) T10000
    expect(h.startTimes).toEqual([0, 5_000, 5_000, 10_000]);
    // old host 内 robots→target 间隔 5000；new host 内 robots→target 间隔 5000
    expect(h.startTimes[1]! - h.startTimes[0]!).toBe(5_000);
    expect(h.startTimes[3]! - h.startTimes[2]!).toBe(5_000);
    // 跨 host（old target T5000 → new robots T5000）零阻塞
    expect(h.startTimes[2]!).toBe(5_000);
  });

  it('地址重试（conn-error → retry-next）同 host 相邻地址 socket ≥5000ms', async () => {
    const clock = new FakeClock(0);
    const gate = new HostRequestGate({ clock });
    const lookup = async (): Promise<{ address: string; family: 4 | 6 }[]> => [
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.35', family: 4 },
    ];
    const h = gateHarness(clock, gate, { lookup });
    const p = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush(); // robots T0
    expect(h.captured.length).toBe(1);
    clock.advanceBy(5_000); // target addr1 T5000
    await flush();
    expect(h.captured.length).toBe(2);
    h.targets()[0]!.error('ECONNREFUSED'); // → retry-next → addr2
    await flush();
    clock.advanceBy(5_000); // addr2 gate 间隔
    await flush();
    expect(h.captured.length).toBe(3);
    h.targets()[1]!.respond(200, {}, 'ok');
    const r = await p;
    expect(r.kind).toBe('ok');
    expect(h.startTimes).toEqual([0, 5_000, 10_000]);
    expect(h.startTimes[2]! - h.startTimes[1]!).toBe(5_000);
  });

  it('未注入 hostGate → D3 独立行为（socket 起点零 5s 约束，零 gate 调用）', async () => {
    const clock = new FakeClock(0);
    const h = createHarness({ clock });
    const p = h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush(); // robots socket 立即（无 gate 等待）
    clock.advanceBy(1);
    await flush(); // target socket 立即（无 5s 等待）
    expect(h.captured.length).toBe(2);
    h.targets()[0]!.respond(200, {}, 'ok');
    const r = await p;
    expect(r.kind).toBe('ok');
    // 未注入 gate 时行为与既有 D3 完全一致（robots+target 无需 5s 时钟推进即可完成）
  });
});
