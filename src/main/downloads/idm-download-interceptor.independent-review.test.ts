import { EventEmitter } from 'node:events';
import type { DownloadItem, Session, WebContents, WebFrameMain } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { IdmDownloadInterceptor, type IdmDownloadLease } from './idm-download-interceptor';
import type { IdmDownloadMetadata } from './idm-native-service';

const fixtures: IdmDownloadInterceptor[] = [];
afterEach(() => {
  for (const item of fixtures) item.dispose();
  fixtures.length = 0;
});
function fixture() {
  const session = new EventEmitter();
  let capture: ((details: Electron.OnSendHeadersListenerDetails) => void) | null = null;
  let received:
    | ((
        details: Electron.OnHeadersReceivedListenerDetails,
        callback: (response: Electron.HeadersReceivedResponse) => void,
      ) => void)
    | null = null;
  const webRequest = {
    onHeadersReceived: vi.fn((_filter: unknown, callback?: typeof received) => {
      received = callback ?? null;
    }),
    onCompleted: vi.fn(),
    onErrorOccurred: vi.fn(),
    onSendHeaders: vi.fn(
      (filter: unknown, callback?: (details: Electron.OnSendHeadersListenerDetails) => void) => {
        capture = filter === null ? null : (callback ?? null);
      },
    ),
  };
  const nativeSession = Object.assign(session, { webRequest }) as unknown as Session;
  const frame = { routingId: 3, processId: 4 } as WebFrameMain;
  const wc = { id: 8 } as WebContents;
  let live = true;
  let eligible = true;
  let now = 0;
  const lease: IdmDownloadLease = { token: 'one', isCurrent: () => live };
  let activeLease = lease;
  const send = vi.fn<
    (metadata: IdmDownloadMetadata, guard: () => boolean) => Promise<{ ok: true }>
  >(async () => ({
    ok: true as const,
  }));
  const onResult = vi.fn();
  const interceptor = new IdmDownloadInterceptor({
    session: nativeSession,
    isUserDownloadFrame: (id, target) => id === wc.id && target === frame,
    service: { send },
    getCaptureContext: () => (eligible ? activeLease : null),
    consumeDownloadLease: () => (eligible ? activeLease : null),
    onResult,
    now: () => now,
  });
  fixtures.push(interceptor);
  const url = 'https://download.example/file.zip';
  function headers(overrides: Partial<Electron.OnSendHeadersListenerDetails> = {}) {
    capture?.({
      id: 1,
      url,
      method: 'GET',
      webContentsId: 8,
      frame,
      resourceType: 'mainFrame',
      referrer: 'https://not-used.example/private',
      timestamp: 1,
      requestHeaders: {
        Cookie: 'sid=one',
        Referer: 'https://origin.example/',
        'User-Agent': 'AIbrowse',
      },
      ...overrides,
    });
    received?.(
      {
        id: 1,
        url,
        resourceType: 'mainFrame',
        statusCode: 200,
        statusLine: 'HTTP/1.1 200 OK',
        responseHeaders: { 'Content-Type': ['application/octet-stream'] },
        ...overrides,
      } as Electron.OnHeadersReceivedListenerDetails,
      () => {},
    );
  }
  function download(overrides: Partial<DownloadItem> = {}, downloadFrame = frame) {
    const preventDefault = vi.fn();
    session.emit(
      'will-download',
      { preventDefault },
      {
        getURL: () => url,
        getURLChain: () => [url],
        getFilename: () => 'file.zip',
        hasUserGesture: () => true,
        getInitiatorOrigin: () => 'https://origin.example',
        ...overrides,
      },
      wc,
      downloadFrame,
    );
    expect(preventDefault).toHaveBeenCalledOnce();
  }
  return {
    session,
    webRequest,
    frame,
    wc,
    lease,
    send,
    onResult,
    headers,
    download,
    interceptor,
    nextGesture: () => {
      live = false;
      activeLease = { token: 'two', isCurrent: () => true };
    },
    setLive: (value: boolean) => {
      live = value;
    },
    setEligible: (value: boolean) => {
      eligible = value;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

it('独审：同URL第二请求因Authorization拒绝时不得借用第一请求Cookie', () => {
  const f = fixture();
  f.headers();
  f.headers({ id: 2, requestHeaders: { Authorization: 'Bearer unrelated', Cookie: 'sid=two' } });
  f.download();
  expect(f.send).not.toHaveBeenCalled();
});
it('独审：容量溢出的同URL请求不得借用已存请求Cookie', () => {
  const f = fixture();
  f.headers();
  for (let id = 2; id <= 8; id++) f.headers({ id, url: `https://example.com/${id}` });
  f.headers({ id: 9, requestHeaders: { Cookie: 'sid=overflow' } });
  f.download();
  expect(f.send).not.toHaveBeenCalled();
});
it('独审：同URL第二请求头格式拒绝时不得借用已存Cookie', () => {
  const f = fixture();
  f.headers();
  f.headers({ id: 2, requestHeaders: { Cookie: 'a'.repeat(16385) } });
  f.download();
  expect(f.send).not.toHaveBeenCalled();
});

it('独审：更换手势后仍在途的同URL旧请求不得误配新请求Cookie', () => {
  const f = fixture();
  f.headers();
  f.nextGesture();
  f.headers({ id: 2, requestHeaders: { Cookie: 'sid=two', 'User-Agent': 'AIbrowse' } });
  // The old request can complete after the new click; DownloadItem has no request id.
  f.download();
  expect(f.send).not.toHaveBeenCalled();
});

it('独审：夹具响应已就绪的唯一合法请求确实交接，避免拒绝测试空通过', () => {
  const f = fixture();
  f.headers();
  f.download();
  expect(f.send).toHaveBeenCalledOnce();
});
