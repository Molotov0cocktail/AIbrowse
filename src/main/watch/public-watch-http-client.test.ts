// D3 public-watch-http-client tests: 网络安全（WT-01～WT-04、WRT-01～WRT-05/WRT-19）、
// 条件请求/压缩/超时/重定向，全部经安全工厂注入的受控 lookup/transport/Clock 验证，零真实网络。
// raw transport/client、constructor 与任意 URL test seam 均不导出；测试只经
// createPublicWatchHttpStack(...) 注入依赖并观察 target-gated 窄能力。
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import { gzipSync } from 'node:zlib';
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
  type RobotsGatePort,
  type WatchIncomingLike,
  type WatchRequestFactory,
  type WatchRequestLike,
  type WatchRequestOptions,
} from './public-watch-http-client';

// ---------------------------------------------------------------------------
// 测试 transport seam：捕获请求选项，由测试控制响应
// ---------------------------------------------------------------------------

class FakeIncoming extends EventEmitter implements WatchIncomingLike {
  statusCode = 200;
  statusMessage = 'OK';
  headers: Record<string, string | string[] | undefined> = {};
  destroyed = false;
  resume(): void {}
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeRequest extends EventEmitter implements WatchRequestLike {
  setTimeout(ms: number): unknown {
    void ms;
    return this;
  }
  end(): void {}
  abort(): void {
    this.emit('error', Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
  }
  destroy(error?: Error): void {
    this.emit('error', error ?? new Error('destroyed'));
  }
}

interface CapturedRequest {
  options: WatchRequestOptions;
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
 */
function createHarness(
  opts: {
    lookup?: (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;
    clock?: FakeClock;
    timeoutMs?: number;
    autoRobots?: boolean;
    robots?: RobotsGatePort | null;
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
    robots: opts.robots,
  });
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

  it('robots gate 异常 → fail-closed unavailable（不假定允许）', async () => {
    const h = createHarness({
      robots: {
        checkAllowed: async () => {
          throw new Error('gate-boom');
        },
      },
    });
    const r = await h.stack.target.get({ url: 'https://example.com/feed', purpose: 'feed' });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
    expect(h.captured.length).toBe(0);
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
  it('模块公开 surface 不包含 raw client、constructor 或任意 URL fetch seam', () => {
    const surface = watchClientModule as unknown as Record<string, unknown>;
    expect(typeof surface.createPublicWatchHttpStack).toBe('function');
    expect(surface.PublicWatchHttpClient).toBeUndefined();
    expect(surface.PublicWatchHttpSeams).toBeUndefined();
    expect(surface.RobotsPolicy).toBeUndefined();
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

  it('缺 RobotsGate 的 page/feed/discovery 零 DNS、零 request、零 socket（fail-closed）', async () => {
    const h = createHarness({ robots: null });
    for (const purpose of ['feed', 'page', 'discovery'] as const) {
      const r = await h.stack.target.get({ url: 'https://example.com/x', purpose });
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('unavailable');
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
    if (r.kind === 'failed') expect(r.health).toBe('unavailable'); // budget_exceeded → robots unavailable
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
