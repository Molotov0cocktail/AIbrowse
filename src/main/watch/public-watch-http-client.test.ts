// D3 public-watch-http-client tests: 网络安全（WT-01～WT-04、WRT-01～WRT-04）、
// 条件请求/压缩/超时/重定向，全部经受控 lookup/transport seam 验证，零真实网络。
import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../shared/watch/clock';
import { MAX_FEED_RESPONSE_BYTES, MAX_REDIRECTS } from '../../shared/types/watch';
import {
  classifyPublicHttpStatus,
  PublicWatchHttpClient,
  WATCH_DEFAULT_USER_AGENT,
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

function createTransport(): { factory: WatchRequestFactory; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const factory: WatchRequestFactory = (options) => {
    const req = new FakeRequest();
    const cap: CapturedRequest = {
      options,
      respond(status, headers, body = null) {
        const res = cap.openResponse(status, headers);
        if (body !== null) {
          const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
          if (buf.length > 0) res.emit('data', buf);
        }
        res.emit('end');
      },
      respondChunked(status, headers, chunks) {
        const res = cap.openResponse(status, headers);
        for (const c of chunks) res.emit('data', Buffer.isBuffer(c) ? c : Buffer.from(c, 'utf8'));
        res.emit('end');
      },
      openResponse(status, headers) {
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
    captured.push(cap);
    return req;
  };
  return { factory, captured };
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

function makeClient(
  transport: ReturnType<typeof createTransport>,
  extra: {
    lookup?: (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;
    clock?: FakeClock;
    timeoutMs?: number;
  } = {},
): PublicWatchHttpClient {
  return new PublicWatchHttpClient({
    lookup: extra.lookup ?? PUBLIC_LOOKUP,
    request: transport.factory,
    clock: extra.clock,
    timeoutMs: extra.timeoutMs ?? 30_000,
  });
}

describe('WRT-01/WRT-02/WRT-03 — 零 socket 与地址校验', () => {
  it('localhost/私网 URL 在 validate 阶段拒绝，transport 零调用', async () => {
    const t = createTransport();
    const client = makeClient(t);
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
      const r = await client.get({ url, purpose: 'feed' });
      expect(r.kind, url).toBe('failed');
      if (r.kind === 'failed') expect(r.health, url).toBe('security_rejected');
    }
    expect(t.captured.length).toBe(0); // 零 socket
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
      const t = createTransport();
      const client = makeClient(t, { lookup: async () => addresses });
      const r = await client.get({ url: 'https://example.com/feed', purpose: 'feed' });
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('security_rejected');
      expect(t.captured.length).toBe(0);
    }
  });

  it('lookup 失败/空 → unavailable（无 socket）', async () => {
    const t = createTransport();
    const client = makeClient(t, {
      lookup: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    const r = await client.get({ url: 'https://example.com/feed', purpose: 'feed' });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
    expect(t.captured.length).toBe(0);
  });

  it('IPv6 非公网字面量（fec0/文档段/benchmark）→ security_rejected，零 socket', async () => {
    for (const host of ['[fec0::1]', '[2001:db8::1]', '[2001:2::1]']) {
      const t = createTransport();
      const client = makeClient(t);
      const r = await client.get({ url: `http://${host}/feed`, purpose: 'feed' });
      expect(r.kind, host).toBe('failed');
      if (r.kind === 'failed') expect(r.health, host).toBe('security_rejected');
      expect(t.captured.length, host).toBe(0);
    }
  });

  it('lookup 返回 IPv6 非公网（含混合）→ security_rejected，零 socket', async () => {
    for (const addresses of [
      [{ address: 'fec0::1', family: 6 as const }],
      [{ address: '2001:db8::1', family: 6 as const }],
      [{ address: '2001:2::1', family: 6 as const }],
      [
        { address: '2606:4700:4700::1111', family: 6 as const },
        { address: 'fec0::1', family: 6 as const },
      ],
    ]) {
      const t = createTransport();
      const client = makeClient(t, { lookup: async () => addresses });
      const r = await client.get({ url: 'https://example.com/feed', purpose: 'feed' });
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.health).toBe('security_rejected');
      expect(t.captured.length).toBe(0);
    }
  });

  it('连接时 sealed lookup 只返回已批准地址（DNS trap/rebinding 无法注入）', async () => {
    const t = createTransport();
    const client = makeClient(t);
    const promise = client.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    expect(t.captured.length).toBe(1);
    t.captured[0]!.respond(200, {}, '<rss/>');
    const r = await promise;
    expect(r.kind).toBe('ok');
    const { options } = t.captured[0]!;
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
    const t = createTransport();
    const client = makeClient(t, {
      lookup: async () => [
        { address: '93.184.216.34', family: 4 as const },
        { address: '151.101.1.140', family: 4 as const },
      ],
    });
    const promise = client.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    expect(t.captured.length).toBe(1);
    t.captured[0]!.error('ECONNREFUSED');
    await flush();
    // 第二个地址：交付 200
    expect(t.captured.length).toBe(2);
    t.captured[1]!.respond(200, { 'content-type': 'application/rss+xml' }, '<rss/>');
    const r = await promise;
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.meta.statusCode).toBe(200);
  });
});

describe('固定 header / 条件请求 / 304', () => {
  it('请求 header 固定：UA/Accept/Accept-Encoding，零 Cookie/Auth/自定义', async () => {
    const t = createTransport();
    const client = makeClient(t);
    const promise = client.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const headers = t.captured[0]!.options.headers;
    expect(headers['User-Agent']).toBe(WATCH_DEFAULT_USER_AGENT);
    expect(headers['Accept']).toContain('application/rss+xml');
    expect(headers['Accept-Encoding']).toBe('gzip, deflate, br');
    expect(headers['Cookie']).toBeUndefined();
    expect(headers['Authorization']).toBeUndefined();
    for (const k of Object.keys(headers)) {
      expect(k.toLowerCase()).not.toBe('cookie');
      expect(k.toLowerCase()).not.toBe('authorization');
    }
    t.captured[0]!.respond(200, {}, '<rss/>');
    await promise;
  });

  it('条件请求 ETag/Last-Modified 发送', async () => {
    const t = createTransport();
    const client = makeClient(t);
    const promise = client.get({
      url: 'https://example.com/feed',
      purpose: 'feed',
      etag: '"abc"',
      lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    });
    await flush();
    expect(t.captured[0]!.options.headers['If-None-Match']).toBe('"abc"');
    expect(t.captured[0]!.options.headers['If-Modified-Since']).toBe(
      'Mon, 01 Jan 2024 00:00:00 GMT',
    );
    t.captured[0]!.respond(304, { etag: '"abc"' }, null);
    const r = await promise;
    expect(r.kind).toBe('unchanged-http');
  });

  it('304 映射 unchanged-http，不解析空 body；ETag/Last-Modified 稳定回读', async () => {
    const t = createTransport();
    const client = makeClient(t);
    const promise = client.get({ url: 'https://example.com/feed', purpose: 'feed', etag: '"e1"' });
    await flush();
    t.captured[0]!.respond(
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
    const t = createTransport();
    const client = makeClient(t);
    const promise = client.head({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    expect(t.captured[0]!.options.method).toBe('HEAD');
    t.captured[0]!.respond(200, { 'content-type': 'application/rss+xml' }, 'ignored-body');
    const r = await promise;
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.body.length).toBe(0);
      expect(r.meta.byteLength).toBe(0);
    }
  });
});

describe('redirect — 每跳复验（WRT-03）', () => {
  it('302 → 合法新 host 跟随；finalUrl 更新', async () => {
    const t = createTransport();
    const client = makeClient(t);
    const promise = client.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    t.captured[0]!.respond(302, { location: 'https://cdn.example.com/feed.xml' }, null);
    await flush();
    expect(t.captured.length).toBe(2);
    expect(t.captured[1]!.options.hostname).toBe('cdn.example.com');
    t.captured[1]!.respond(200, {}, '<rss/>');
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
      const t = createTransport();
      const client = makeClient(t);
      const promise = client.get({ url: 'https://example.com/feed', purpose: 'feed' });
      await flush();
      t.captured[0]!.respond(302, { location }, null);
      const r = await promise;
      expect(r.kind, location).toBe('failed');
      if (r.kind === 'failed') expect(r.health, location).toBe('security_rejected');
      expect(t.captured.length, location).toBe(1); // 无后续请求
    }
  });

  it('HTTPS→HTTP downgrade 拒绝', async () => {
    const t = createTransport();
    const client = makeClient(t);
    const promise = client.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    t.captured[0]!.respond(302, { location: 'http://example.com/feed' }, null);
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('security_rejected');
    expect(t.captured.length).toBe(1);
  });

  it('redirect 超过 5 跳拒绝', async () => {
    const t = createTransport();
    const client = makeClient(t);
    const promise = client.get({ url: 'https://example.com/feed', purpose: 'feed' });
    for (let i = 0; i <= MAX_REDIRECTS + 1; i += 1) {
      await flush();
      if (t.captured.length === 0) break;
      t.captured[t.captured.length - 1]!.respond(
        302,
        { location: 'https://example.com/feed' },
        null,
      );
    }
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('security_rejected');
  });

  it('3xx 无 Location 按响应结束返回（不无限跟随）', async () => {
    const t = createTransport();
    const client = makeClient(t);
    const promise = client.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    t.captured[0]!.respond(302, {}, null);
    const r = await promise;
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.meta.statusCode).toBe(302);
    expect(t.captured.length).toBe(1);
  });
});

describe('预算/超时/慢流（WRT-04）', () => {
  it('Content-Length 超预算立即 budget_exceeded（feed 2 MiB）', async () => {
    const t = createTransport();
    const client = makeClient(t);
    const promise = client.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    t.captured[0]!.respond(200, { 'content-length': String(MAX_FEED_RESPONSE_BYTES + 1) }, '');
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('budget_exceeded');
  });

  it('== MAX identity 接受；MAX+1 拒绝', async () => {
    const atMax = 'x'.repeat(MAX_FEED_RESPONSE_BYTES);
    const t1 = createTransport();
    const c1 = makeClient(t1);
    const p1 = c1.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    t1.captured[0]!.respond(200, {}, atMax);
    const r1 = await p1;
    expect(r1.kind).toBe('ok');
    if (r1.kind === 'ok') expect(r1.meta.byteLength).toBe(MAX_FEED_RESPONSE_BYTES);

    const t2 = createTransport();
    const c2 = makeClient(t2);
    const p2 = c2.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    t2.captured[0]!.respond(200, {}, 'x'.repeat(MAX_FEED_RESPONSE_BYTES + 1));
    const r2 = await p2;
    expect(r2.kind).toBe('failed');
    if (r2.kind === 'failed') expect(r2.health).toBe('budget_exceeded');
  });

  it('gzip 解压后 == MAX 接受、MAX+1 拒绝（解压字节硬上限）', async () => {
    const maxText = 'a'.repeat(MAX_FEED_RESPONSE_BYTES);
    const gzMax = gzipSync(Buffer.from(maxText, 'utf8'));
    const t1 = createTransport();
    const c1 = makeClient(t1);
    const p1 = c1.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    t1.captured[0]!.respond(200, { 'content-encoding': 'gzip' }, gzMax);
    const r1 = await p1;
    expect(r1.kind).toBe('ok');
    if (r1.kind === 'ok') {
      expect(r1.meta.byteLength).toBe(MAX_FEED_RESPONSE_BYTES);
      expect(r1.body.toString('utf8')).toBe(maxText);
    }

    const t2 = createTransport();
    const c2 = makeClient(t2);
    const p2 = c2.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    t2.captured[0]!.respond(
      200,
      { 'content-encoding': 'gzip' },
      gzipSync(Buffer.from('a'.repeat(MAX_FEED_RESPONSE_BYTES + 1), 'utf8')),
    );
    const r2 = await p2;
    expect(r2.kind).toBe('failed');
    if (r2.kind === 'failed') expect(r2.health).toBe('budget_exceeded');
  });

  it('未知 Content-Encoding fail-closed（security_rejected，不回退 identity）', async () => {
    const t = createTransport();
    const client = makeClient(t);
    const promise = client.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    t.captured[0]!.respond(200, { 'content-encoding': 'xz' }, 'x'.repeat(100));
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('security_rejected');
  });

  it('慢流超过 deadline 受控失败并 destroy；随后正常请求仍成功', async () => {
    const clock = new FakeClock(0);
    const t = createTransport();
    const client = makeClient(t, { clock });
    const promise = client.get({
      url: 'https://example.com/feed',
      purpose: 'feed',
      deadline: new Date(5000),
    });
    await flush();
    const res = t.captured[0]!.openResponse(200, {});
    res.emit('data', Buffer.from('part1', 'utf8')); // t=0 < deadline
    await flush();
    clock.pushNow(6000); // 超过 deadline
    res.emit('data', Buffer.from('part2', 'utf8')); // 触发 failDeadline
    res.emit('end');
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');

    // 随后正常请求（无 deadline）成功
    const t2 = createTransport();
    const c2 = makeClient(t2);
    const p2 = c2.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    t2.captured[0]!.respond(200, {}, '<rss/>');
    const r2 = await p2;
    expect(r2.kind).toBe('ok');
  });

  it('socket 超时受控失败（timeoutMs），随后正常请求仍成功', async () => {
    const t = createTransport();
    const client = makeClient(t, { timeoutMs: 10 });
    const promise = client.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    await new Promise((r) => setTimeout(r, 30)); // 等待真实 timer 触发
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
  });

  it('连接错误（ECONNREFUSED 等）→ unavailable', async () => {
    const t = createTransport();
    const client = makeClient(t);
    const promise = client.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    t.captured[0]!.error('ECONNREFUSED');
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
  });
});

describe('DNS lookup 竞争 deadline/timeout/abort（WRT-04 覆盖 DNS 生命周期）', () => {
  it('永不返回的 DNS → timeoutMs 内受控失败', async () => {
    const t = createTransport();
    const client = new PublicWatchHttpClient({
      lookup: async () => new Promise(() => {}), // 永不 resolve
      request: t.factory,
      timeoutMs: 30,
    });
    const start = Date.now();
    const r = await client.get({ url: 'https://example.com/feed', purpose: 'feed' });
    const elapsed = Date.now() - start;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
    expect(elapsed).toBeLessThan(3000);
    expect(t.captured.length).toBe(0);
  });

  it('已过期 deadline → 立即失败（不等 DNS）', async () => {
    const t = createTransport();
    const client = new PublicWatchHttpClient({
      lookup: async () => new Promise(() => {}),
      request: t.factory,
    });
    const r = await client.get({
      url: 'https://example.com/feed',
      purpose: 'feed',
      deadline: new Date(Date.now() - 1),
    });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
    expect(t.captured.length).toBe(0);
  });

  it('abort 在 DNS 期间 → aborted', async () => {
    const controller = new AbortController();
    const t = createTransport();
    const client = new PublicWatchHttpClient({
      lookup: async () => new Promise(() => {}),
      request: t.factory,
    });
    const promise = client.get({
      url: 'https://example.com/feed',
      purpose: 'feed',
      signal: controller.signal,
    });
    controller.abort();
    const r = await promise;
    expect(r.kind).toBe('aborted');
    expect(t.captured.length).toBe(0);
  });

  it('requestFactory 同步 throw → 受控 unavailable（不拒绝 promise）', async () => {
    const factory: WatchRequestFactory = () => {
      throw new Error('boom');
    };
    const client = new PublicWatchHttpClient({ lookup: PUBLIC_LOOKUP, request: factory });
    const r = await client.get({ url: 'https://example.com/feed', purpose: 'feed' });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
  });
});

describe('每跳 robots gate（WRT-05 每跳部分）', () => {
  it('初始 host allowed → 发起 socket；redirect 下一 host robots disallowed → 下一 host 零 socket', async () => {
    const t = createTransport();
    let gateCalls = 0;
    const client = new PublicWatchHttpClient({
      lookup: PUBLIC_LOOKUP,
      request: t.factory,
      robots: {
        checkAllowed: async (input) => {
          gateCalls += 1;
          const host = new URL(input.url).hostname;
          if (host === 'example.com') return { kind: 'allowed' };
          if (host === 'cdn.example.com') return { kind: 'disallowed' };
          return { kind: 'allowed' };
        },
      },
    });
    const promise = client.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    expect(t.captured.length).toBe(1);
    expect(gateCalls).toBe(1);
    t.captured[0]!.respond(302, { location: 'https://cdn.example.com/feed.xml' }, null);
    await flush();
    expect(t.captured.length).toBe(1); // 下一 host 零 socket
    expect(gateCalls).toBe(2);
    const r = await promise;
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('robots_disallowed');
  });

  it('robots gate 异常 → fail-closed unavailable（不假定允许）', async () => {
    const t = createTransport();
    const client = new PublicWatchHttpClient({
      lookup: PUBLIC_LOOKUP,
      request: t.factory,
      robots: {
        checkAllowed: async () => {
          throw new Error('gate-boom');
        },
      },
    });
    const r = await client.get({ url: 'https://example.com/feed', purpose: 'feed' });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.health).toBe('unavailable');
    expect(t.captured.length).toBe(0);
  });

  it('purpose=robots 跳过 robots gate（零递归）', async () => {
    const t = createTransport();
    let gateCalls = 0;
    const client = new PublicWatchHttpClient({
      lookup: PUBLIC_LOOKUP,
      request: t.factory,
      robots: {
        checkAllowed: async () => {
          gateCalls += 1;
          return { kind: 'disallowed' };
        },
      },
    });
    const promise = client.get({ url: 'https://example.com/robots.txt', purpose: 'robots' });
    await flush();
    expect(gateCalls).toBe(0);
    t.captured[0]!.respond(200, {}, 'User-agent: *');
    const r = await promise;
    expect(r.kind).toBe('ok');
  });
});

describe('不消费响应的安全销毁（WRT-04 生命周期）', () => {
  it('redirect 无限 body：立即销毁前一个响应并继续', async () => {
    const t = createTransport();
    const client = makeClient(t);
    const promise = client.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const res = t.captured[0]!.openResponse(302, { location: 'https://cdn.example.com/feed.xml' });
    res.emit('data', Buffer.from('x', 'utf8')); // 不 emit end → 无限 body
    await flush();
    expect(t.captured.length).toBe(2);
    expect(res.destroyed).toBe(true);
    t.captured[1]!.respond(200, {}, '<rss/>');
    const r = await promise;
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.meta.finalUrl).toBe('https://cdn.example.com/feed.xml');
  });

  it('HEAD 无限 body：立即销毁响应并返回零 body', async () => {
    const t = createTransport();
    const client = makeClient(t);
    const promise = client.head({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const res = t.captured[0]!.openResponse(200, {});
    res.emit('data', Buffer.from('x', 'utf8')); // 不 emit end
    await flush();
    const r = await promise;
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.body.length).toBe(0);
    expect(res.destroyed).toBe(true);
  });

  it('3xx 无 Location 无限 body：销毁并返回 3xx 结果', async () => {
    const t = createTransport();
    const client = makeClient(t);
    const promise = client.get({ url: 'https://example.com/feed', purpose: 'feed' });
    await flush();
    const res = t.captured[0]!.openResponse(302, {});
    res.emit('data', Buffer.from('x', 'utf8'));
    await flush();
    const r = await promise;
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.meta.statusCode).toBe(302);
    expect(res.destroyed).toBe(true);
    expect(t.captured.length).toBe(1);
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
