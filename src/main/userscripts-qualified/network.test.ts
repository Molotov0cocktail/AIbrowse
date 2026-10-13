import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, RequestOptions } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  QualifiedScriptNetwork,
  QualifiedScriptNetworkError,
  type QualifiedScriptNetworkDependencies,
  type QualifiedScriptRequest,
} from './network';

class FakeRequest extends EventEmitter {
  ended = false;
  destroyed = false;
  timeout = 0;

  setTimeout(timeout: number, listener: () => void): this {
    this.timeout = timeout;
    this.once('fake-timeout', listener);
    return this;
  }

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

class FakeResponse extends EventEmitter {
  destroyed = false;

  constructor(
    readonly statusCode: number | undefined,
    readonly statusMessage: string,
    readonly headers: IncomingHttpHeaders,
    readonly rawHeaders: string[],
  ) {
    super();
  }

  destroy(): void {
    this.destroyed = true;
  }
}

interface Capture {
  options: RequestOptions;
  request: FakeRequest;
  respond(
    status: number,
    headers?: IncomingHttpHeaders,
    body?: Buffer | string | null,
    statusText?: string,
    rawHeaders?: string[],
  ): FakeResponse;
}

const PUBLIC = [{ address: '93.184.216.34', family: 4 as const }];

function harness(
  options: {
    lookup?: QualifiedScriptNetworkDependencies['lookup'];
    timeoutMs?: number;
  } = {},
): { network: QualifiedScriptNetwork; captures: Capture[] } {
  const captures: Capture[] = [];
  const transport: NonNullable<QualifiedScriptNetworkDependencies['transport']> = (
    requestOptions,
    onResponse,
  ) => {
    const request = new FakeRequest();
    const capture: Capture = {
      options: requestOptions,
      request,
      respond(status, headers = {}, body = '', statusText = 'OK', rawHeaders) {
        const effectiveRaw =
          rawHeaders ?? Object.entries(headers).flatMap(([name, value]) => [name, String(value)]);
        const response = new FakeResponse(status, statusText, headers, effectiveRaw);
        onResponse(response as never);
        if (body !== null) {
          if (body !== '') response.emit('data', body);
          response.emit('end');
        }
        return response;
      },
    };
    captures.push(capture);
    return request as never;
  };
  return {
    network: new QualifiedScriptNetwork({
      lookup: options.lookup ?? (async () => PUBLIC),
      transport,
      timeoutMs: options.timeoutMs,
    }),
    captures,
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: 'QualifiedScriptNetworkError',
    code,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('request admission and headers', () => {
  it('sends only GET/HEAD and the two explicit optional headers', async () => {
    for (const method of ['GET', 'HEAD'] as const) {
      const h = harness();
      const promise = h.network.request({
        url: 'https://example.com/file.js?x=1#ignored',
        method,
        headers: { Accept: 'text/javascript, */*;q=0.1', Referer: 'https://origin.com/page' },
      });
      await flush();
      expect(h.captures).toHaveLength(1);
      expect(h.captures[0]!.options).toMatchObject({
        protocol: 'https:',
        hostname: 'example.com',
        port: 443,
        method,
        path: '/file.js?x=1',
        headers: {
          Accept: 'text/javascript, */*;q=0.1',
          Referer: 'https://origin.com/page',
        },
        agent: false,
      });
      expect(h.captures[0]!.options.headers).not.toHaveProperty('Cookie');
      expect(h.captures[0]!.options.headers).not.toHaveProperty('Authorization');
      h.captures[0]!.respond(200, { 'x-safe': 'yes' }, method === 'HEAD' ? 'ignored' : '正文');
      await expect(promise).resolves.toEqual({
        status: 200,
        statusText: 'OK',
        finalUrl: 'https://example.com/file.js?x=1',
        responseText: method === 'HEAD' ? '' : '正文',
        responseHeaders: 'x-safe: yes',
      });
    }
  });

  it.each([
    { url: 'https://example.com', method: 'POST' },
    { url: 'https://example.com', method: 'GET', body: 'secret' },
    { url: 'https://example.com', method: 'GET', headers: { Cookie: 'secret' } },
    { url: 'https://example.com', method: 'GET', headers: { Accept: 'x\r\ny: z' } },
  ])('rejects a non-closed request shape %#', async (input) => {
    const h = harness();
    await expectCode(
      h.network.request(input as unknown as QualifiedScriptRequest),
      'invalid-request',
    );
    expect(h.captures).toEqual([]);
  });

  it('treats empty or failed DNS resolution as unavailable with zero transport', async () => {
    for (const lookup of [
      async () => [],
      async () => {
        throw new Error('private resolver detail');
      },
    ]) {
      const h = harness({ lookup });
      await expectCode(
        h.network.request({ url: 'https://example.com/a', method: 'GET' }),
        'unavailable',
      );
      expect(h.captures).toEqual([]);
    }
  });

  it('applies the HTTP(S) security policy to Referer', async () => {
    const h = harness();
    await expectCode(
      h.network.request({
        url: 'https://example.com',
        method: 'GET',
        headers: { Referer: 'file:///secret' },
      }),
      'security-rejected',
    );
    expect(h.captures).toEqual([]);
  });

  it('rejects hostile objects without leaking their values', async () => {
    const h = harness();
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('https://secret.example/body-canary');
        },
      },
    );
    const error = await h.network
      .request(hostile as QualifiedScriptRequest)
      .catch((value) => value);
    expect(error).toBeInstanceOf(QualifiedScriptNetworkError);
    expect(error).toMatchObject({ code: 'invalid-request', message: '脚本网络请求格式无效' });
    expect(String(error)).not.toContain('secret.example');
  });
});

describe('URL, forbidden host and DNS policy', () => {
  it.each([
    'http://localhost/a',
    'http://127.0.0.1/a',
    'https://user:pass@example.com/a',
    'https://example.com:8443/a',
    'https://example.com/a b',
    'https://example.com/a\u0000b',
    'file:///secret',
    'example.com/a',
  ])('rejects unsafe URL %s before transport', async (url) => {
    const h = harness({
      lookup: async (hostname) =>
        hostname === '127.0.0.1' ? [{ address: hostname, family: 4 }] : PUBLIC,
    });
    await expectCode(h.network.request({ url, method: 'GET' }), 'security-rejected');
    expect(h.captures).toEqual([]);
  });

  it.each(['https://www.iflyrec.com/a', 'https://WWW.IFLYREC.COM/a', 'https://www.iflyrec.com./a'])(
    'blocks the compiled forbidden host after normalization: %s',
    async (url) => {
      const h = harness();
      await expectCode(h.network.request({ url, method: 'GET' }), 'forbidden-host');
      expect(h.captures).toEqual([]);
    },
  );

  it.each([
    { answers: [{ address: '10.0.0.1', family: 4 as const }] },
    { answers: [{ address: '127.0.0.1', family: 4 as const }] },
    { answers: [{ address: '169.254.169.254', family: 4 as const }] },
    { answers: [{ address: '::1', family: 6 as const }] },
    { answers: [{ address: 'fe80::1', family: 6 as const }] },
    { answers: [PUBLIC[0]!, { address: '192.168.1.1', family: 4 as const }] },
    { answers: [{ address: '93.184.216.34', family: 6 as const }] },
  ])('rejects non-public, mixed or family-mismatched DNS answers %#', async ({ answers }) => {
    const h = harness({ lookup: async () => answers });
    await expectCode(
      h.network.request({ url: 'https://example.com/a', method: 'GET' }),
      'security-rejected',
    );
    expect(h.captures).toEqual([]);
  });

  it('pins the approved address into transport lookup and rejects a hostname switch', async () => {
    const h = harness();
    const promise = h.network.request({ url: 'https://example.com/a', method: 'GET' });
    await flush();
    const lookup = h.captures[0]!.options.lookup as unknown as (
      hostname: string,
      options: { all?: boolean },
      callback: (error: NodeJS.ErrnoException | null, address: unknown, family?: number) => void,
    ) => void;
    const single = vi.fn();
    lookup('example.com', { all: false }, single);
    expect(single).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    const all = vi.fn();
    lookup('example.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, PUBLIC);
    const switched = vi.fn();
    lookup('attacker.com', { all: false }, switched);
    expect(switched.mock.calls[0]![0]).toMatchObject({ code: 'EACCES' });
    h.captures[0]!.respond(200, {}, 'ok');
    await expect(promise).resolves.toHaveProperty('responseText', 'ok');
  });
});

describe('redirect, body and response bounds', () => {
  it('revalidates each redirect and returns the final normalized URL', async () => {
    const lookedUp: string[] = [];
    const h = harness({
      lookup: async (hostname) => {
        lookedUp.push(hostname);
        return PUBLIC;
      },
    });
    const promise = h.network.request({ url: 'https://example.com/a', method: 'GET' });
    await flush();
    h.captures[0]!.respond(302, { location: 'https://cdn.example.com/b#x' });
    await flush();
    h.captures[1]!.respond(200, {}, 'done');
    await expect(promise).resolves.toMatchObject({
      finalUrl: 'https://cdn.example.com/b',
      responseText: 'done',
    });
    expect(lookedUp).toEqual(['example.com', 'cdn.example.com']);
  });

  it.each([
    'http://example.com/downgrade',
    'http://127.0.0.1/private',
    'https://WWW.IFLYREC.COM./forbidden',
    'https://example.com/space here',
  ])('rejects an unsafe redirect without a second transport: %s', async (location) => {
    const h = harness();
    const promise = h.network.request({ url: 'https://example.com/a', method: 'GET' });
    await flush();
    h.captures[0]!.respond(302, { location });
    await expect(promise).rejects.toBeInstanceOf(QualifiedScriptNetworkError);
    expect(h.captures).toHaveLength(1);
  });

  it('rechecks DNS on redirect and blocks a private answer before the next transport', async () => {
    const h = harness({
      lookup: async (hostname) =>
        hostname === 'private.example.org' ? [{ address: '10.0.0.8', family: 4 }] : PUBLIC,
    });
    const promise = h.network.request({ url: 'https://example.com/a', method: 'GET' });
    await flush();
    h.captures[0]!.respond(302, { location: 'https://private.example.org/next' });
    await expectCode(promise, 'security-rejected');
    expect(h.captures).toHaveLength(1);
  });

  it('rejects the sixth redirect', async () => {
    const h = harness();
    const promise = h.network.request({ url: 'https://example.com/a', method: 'GET' });
    for (let index = 0; index < 6; index += 1) {
      await flush();
      h.captures[index]!.respond(302, { location: `/r${index}` });
    }
    await expectCode(promise, 'security-rejected');
    expect(h.captures).toHaveLength(6);
  });

  it('accepts exactly 4 MiB and rejects the next byte or oversized Content-Length', async () => {
    const exact = harness();
    const accepted = exact.network.request({ url: 'https://example.com/a', method: 'GET' });
    await flush();
    exact.captures[0]!.respond(200, {}, Buffer.alloc(4 * 1024 * 1024, 0x61));
    await expect(accepted).resolves.toHaveProperty('responseText');

    const overflow = harness();
    const rejected = overflow.network.request({ url: 'https://example.com/a', method: 'GET' });
    await flush();
    const response = overflow.captures[0]!.respond(
      200,
      {},
      Buffer.alloc(4 * 1024 * 1024 + 1, 0x61),
    );
    await expectCode(rejected, 'response-too-large');
    expect(response.destroyed).toBe(true);

    const declared = harness();
    const early = declared.network.request({ url: 'https://example.com/a', method: 'GET' });
    await flush();
    const declaredResponse = declared.captures[0]!.respond(
      200,
      { 'content-length': String(4 * 1024 * 1024 + 1) },
      null,
    );
    await expectCode(early, 'response-too-large');
    expect(declaredResponse.destroyed).toBe(true);
  });

  it('rejects invalid UTF-8 and hostile response metadata', async () => {
    const invalidUtf8 = harness();
    const body = invalidUtf8.network.request({ url: 'https://example.com/a', method: 'GET' });
    await flush();
    invalidUtf8.captures[0]!.respond(200, {}, Buffer.from([0xc3, 0x28]));
    await expectCode(body, 'invalid-response');

    const headers = harness();
    const metadata = headers.network.request({ url: 'https://example.com/a', method: 'GET' });
    await flush();
    headers.captures[0]!.respond(200, {}, 'ok', 'OK', ['x-test', 'safe\r\nforged: yes']);
    await expectCode(metadata, 'invalid-response');
  });

  it('filters remote final-URL forgery, cookies and authentication challenges', async () => {
    const h = harness();
    const promise = h.network.request({ url: 'https://example.com/a', method: 'GET' });
    await flush();
    h.captures[0]!.respond(200, {}, 'ok', 'OK', [
      'X-Safe',
      'visible',
      'TM-FinalURL',
      'https://attacker.example/',
      'tm-finalurlAIBrowse',
      'https://attacker.example/forged',
      'Set-Cookie',
      'session=secret',
      'WWW-Authenticate',
      'Bearer realm="secret"',
      'Proxy-Authentication-Info',
      'nextnonce="secret"',
    ]);
    await expect(promise).resolves.toMatchObject({
      finalUrl: 'https://example.com/a',
      responseHeaders: 'X-Safe: visible',
    });
  });
});

describe('deadline, concurrency, cancellation and disposal', () => {
  it('caps an injected timeout at ten seconds and aborts a hanging DNS lookup', async () => {
    vi.useFakeTimers();
    const h = harness({ lookup: async () => new Promise(() => {}), timeoutMs: 60_000 });
    const promise = h.network.request({ url: 'https://example.com/a', method: 'GET' });
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expectCode(promise, 'timeout');
  });

  it('limits global concurrency to four and releases slots after cancellation', async () => {
    const h = harness({ lookup: async () => new Promise(() => {}) });
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const active = controllers.map((controller) =>
      h.network
        .request({ url: 'https://example.com/a', method: 'GET' }, controller.signal)
        .catch((error) => error),
    );
    await expectCode(
      h.network.request({ url: 'https://example.com/fifth', method: 'GET' }),
      'busy',
    );
    for (const controller of controllers) controller.abort();
    const results = await Promise.all(active);
    expect(results.every((error) => error.code === 'aborted')).toBe(true);
  });

  it('destroys active transport on abort and dispose, which is idempotent', async () => {
    const external = harness();
    const controller = new AbortController();
    const cancelled = external.network.request(
      { url: 'https://example.com/a', method: 'GET' },
      controller.signal,
    );
    await flush();
    controller.abort();
    await expectCode(cancelled, 'aborted');
    expect(external.captures[0]!.request.destroyed).toBe(true);

    const closing = harness();
    const pending = closing.network.request({ url: 'https://example.com/a', method: 'GET' });
    await flush();
    closing.network.dispose();
    closing.network.dispose();
    await expectCode(pending, 'closed');
    expect(closing.captures[0]!.request.destroyed).toBe(true);
    await expectCode(
      closing.network.request({ url: 'https://example.com/b', method: 'GET' }),
      'closed',
    );
  });

  it('rejects an already aborted signal before DNS or transport', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expectCode(
      h.network.request({ url: 'https://example.com/a', method: 'GET' }, controller.signal),
      'aborted',
    );
    expect(h.captures).toEqual([]);
  });

  it('maps transport and DNS failures to static errors without URL or body content', async () => {
    const dnsFailure = harness({
      lookup: async () => {
        throw new Error('https://secret.example/path body-canary');
      },
    });
    const error = await dnsFailure.network
      .request({ url: 'https://example.com/a', method: 'GET' })
      .catch((value) => value);
    expect(error).toMatchObject({ code: 'unavailable', message: '脚本网络请求失败' });
    expect(String(error)).not.toMatch(/secret\.example|body-canary/u);

    const transportFailure = harness();
    const request = transportFailure.network.request({
      url: 'https://example.com/private-query?token=secret',
      method: 'GET',
    });
    await flush();
    transportFailure.captures[0]!.request.emit(
      'error',
      new Error('https://secret.example body-canary'),
    );
    const transportError = await request.catch((value) => value);
    expect(transportError).toMatchObject({ code: 'unavailable', message: '脚本网络请求失败' });
    expect(String(transportError)).not.toMatch(/secret\.example|body-canary|private-query/u);
  });
});
