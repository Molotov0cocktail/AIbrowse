import { EventEmitter } from 'node:events';
import type { DownloadItem, Session, WebContents, WebFrameMain } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdmDownloadInterceptor, type IdmDownloadLease } from './idm-download-interceptor';
import type { IdmDownloadMetadata } from './idm-native-service';

const fixtures: IdmDownloadInterceptor[] = [];
afterEach(() => {
  for (const item of fixtures) item.dispose();
  fixtures.length = 0;
});
function fixture(
  readFallback?: ConstructorParameters<typeof IdmDownloadInterceptor>[0]['readFallback'],
) {
  const session = new EventEmitter();
  let capture: ((details: Electron.OnSendHeadersListenerDetails) => void) | null = null;
  let ended: ((details: { id: number }) => void) | null = null;
  let received:
    | ((
        details: Electron.OnHeadersReceivedListenerDetails,
        callback: (response: Electron.HeadersReceivedResponse) => void,
      ) => void)
    | null = null;
  const webRequest = {
    onHeadersReceived: vi.fn((filter: unknown, callback?: typeof received) => {
      received = filter === null ? null : (callback ?? null);
    }),
    onCompleted: vi.fn((filter: unknown, callback?: (details: { id: number }) => void) => {
      ended = filter === null ? null : (callback ?? null);
    }),
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
  let userFrame = true;
  let now = 0;
  let epoch = 0;
  let lease: IdmDownloadLease = { token: 'one', isCurrent: () => live && epoch === 0 };
  const send = vi.fn<
    (metadata: IdmDownloadMetadata, guard: () => boolean) => Promise<{ ok: true }>
  >(async () => ({
    ok: true as const,
  }));
  const onResult = vi.fn();
  const interceptor = new IdmDownloadInterceptor({
    session: nativeSession,
    service: { send },
    getCaptureContext: () => (eligible ? lease : null),
    consumeDownloadLease: () => (eligible ? lease : null),
    isUserDownloadFrame: () => userFrame,
    onResult,
    now: () => now,
    readFallback,
  });
  fixtures.push(interceptor);
  const url = 'https://download.example/file.zip';
  function response(overrides: Partial<Electron.OnHeadersReceivedListenerDetails> = {}) {
    const callback = vi.fn();
    received?.(
      {
        id: 1,
        url,
        method: 'GET',
        webContentsId: 8,
        frame,
        resourceType: 'mainFrame',
        referrer: '',
        timestamp: 1,
        statusCode: 200,
        statusLine: 'HTTP/1.1 200 OK',
        responseHeaders: { 'Content-Type': ['application/octet-stream'] },
        ...overrides,
      },
      callback,
    );
    expect(callback).toHaveBeenCalledWith({});
  }
  function headers(overrides: Partial<Electron.OnSendHeadersListenerDetails> = {}, ready = true) {
    const details: Electron.OnSendHeadersListenerDetails = {
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
    };
    capture?.(details);
    if (ready) response({ id: details.id, url: details.url, resourceType: details.resourceType });
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
    response,
    download,
    interceptor,
    setLive: (value: boolean) => {
      live = value;
    },
    setEligible: (value: boolean) => {
      eligible = value;
    },
    setUserFrame: (value: boolean) => {
      userFrame = value;
    },
    setNow: (value: number) => {
      now = value;
    },
    nextGesture: () => {
      epoch++;
      const currentEpoch = epoch;
      lease = { token: `next-${epoch}`, isCurrent: () => live && epoch === currentEpoch };
    },
    requestEnded: (id: number) => ended?.({ id }),
  };
}

describe('IDM 当前下载请求元数据隔离', () => {
  it('同步捕获已取消下载，仅交接实际发送Cookie/Referer/UA与原生文件名', async () => {
    const f = fixture();
    f.headers();
    f.download();
    expect(f.send).toHaveBeenCalledWith(
      {
        url: 'https://download.example/file.zip',
        cookie: 'sid=one',
        referer: 'https://origin.example/',
        userAgent: 'AIbrowse',
        filename: 'file.zip',
      },
      expect.any(Function),
    );
    f.setLive(false);
    expect(f.send.mock.calls[0]?.[1]()).toBe(false);
    await vi.waitFor(() => expect(f.onResult).toHaveBeenCalled());
    expect(f.onResult).toHaveBeenCalledWith({ ok: true });
  });
  it('重定向仅使用最终跳实际头，不携带上一域Cookie或来源', () => {
    const f = fixture();
    f.headers({
      url: 'https://origin.example/start',
      requestHeaders: { Cookie: 'private=first', 'User-Agent': 'Initial' },
    });
    f.headers({ requestHeaders: { 'User-Agent': 'Final' } });
    f.download({
      getURLChain: () => ['https://origin.example/start', 'https://download.example/file.zip'],
    });
    expect(f.send.mock.calls[0]?.[0]).toMatchObject({
      cookie: '',
      referer: '',
      userAgent: 'Final',
    });
  });
  it('用户/AI/任务页无主进程许可时不捕获也不交接', () => {
    const f = fixture();
    f.setEligible(false);
    f.headers();
    f.setEligible(true);
    f.download();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('任务页面身份即使误获capture lease也不建立任何请求候选', () => {
    const f = fixture();
    f.setUserFrame(false);
    f.headers();
    f.setUserFrame(true);
    f.download();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('原生事件缺User-Agent时不将不完整Cookie观察误认为匿名请求', () => {
    const f = fixture();
    f.headers();
    f.headers({ id: 2, requestHeaders: {} });
    f.download();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('拒绝事件缺Frame时不会借用同URL旧请求的Cookie', () => {
    const f = fixture();
    f.headers();
    f.headers({ id: 2, frame: null });
    f.download();
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each(['POST', 'PUT', 'HEAD'])('拒绝不能原样重放的%s下载', (method) => {
    const f = fixture();
    f.headers({ method });
    f.download();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.onResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });
  it.each<Record<string, string>>([
    { Authorization: 'Basic secret' },
    { Cookie: 'secret\r\nInjected:x' },
    { Cookie: 'one', cookie: 'two' },
    { Referer: 'https://u:p@example.com/' },
  ])('拒绝未支持认证/敌手头 %j', (requestHeaders) => {
    const f = fixture();
    f.headers({ requestHeaders });
    f.download();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('相同URL并发请求的关联多义时拒绝，避免选错Cookie', () => {
    const f = fixture();
    f.headers();
    f.headers({ id: 2, requestHeaders: { Cookie: 'sid=two' } });
    f.download();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('拒绝另一Frame、另一WebContents或未出现的最终URL', () => {
    const f = fixture();
    f.headers();
    f.download({}, {} as WebFrameMain);
    expect(f.send).not.toHaveBeenCalled();
    f.headers({ webContentsId: 9 });
    f.download();
    expect(f.send).not.toHaveBeenCalled();
    f.headers();
    f.download({ getURL: () => 'https://other.example/file.zip' });
    expect(f.send).not.toHaveBeenCalled();
  });
  it('拒绝链末尾不符、非HTTP链及超过20跳', () => {
    for (const chain of [
      ['https://other.example/'],
      ['file:///secret', 'https://download.example/file.zip'],
      Array<string>(21).fill('https://download.example/file.zip'),
    ]) {
      const f = fixture();
      f.headers();
      f.download({ getURLChain: () => chain });
      expect(f.send).not.toHaveBeenCalled();
    }
  });
  it('消费清除Cookie、过期或撤销上下文不得重用', () => {
    const f = fixture();
    f.headers();
    f.download();
    f.download();
    expect(f.send).toHaveBeenCalledOnce();
    f.headers();
    f.setNow(10001);
    f.download();
    expect(f.send).toHaveBeenCalledOnce();
    f.setNow(0);
    f.headers();
    f.setLive(false);
    f.download();
    expect(f.send).toHaveBeenCalledOnce();
  });
  it('记录满时拒绝新增，dispose移除自己的监听和实际头观察', () => {
    const f = fixture();
    for (let id = 1; id <= 9; id++) f.headers({ id, url: `https://example.com/${id}` });
    f.download({
      getURL: () => 'https://example.com/9',
      getURLChain: () => ['https://example.com/9'],
    });
    expect(f.send).not.toHaveBeenCalled();
    f.interceptor.dispose();
    expect(f.session.listenerCount('will-download')).toBe(0);
    expect(f.webRequest.onSendHeaders).toHaveBeenLastCalledWith(null);
  });
  it('下载item异常仍保持取消且不启动服务', () => {
    const f = fixture();
    f.headers();
    f.download({
      getFilename: () => {
        throw new Error('native disposed');
      },
    });
    expect(f.send).not.toHaveBeenCalled();
  });
  it('请求超过10秒仍在途，不得借后续同URL点击的新Cookie', () => {
    const f = fixture();
    f.headers();
    f.setNow(20000);
    f.nextGesture();
    f.headers({ id: 2, requestHeaders: { Cookie: 'new=two', 'User-Agent': 'Browser' } });
    f.download();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('普通HTML响应明确终结后不再与新点击混淆', () => {
    const f = fixture();
    f.headers();
    f.response({ responseHeaders: { 'Content-Type': ['text/html; charset=utf-8'] } });
    f.nextGesture();
    f.headers({ id: 2, requestHeaders: { Cookie: 'new=two', 'User-Agent': 'Browser' } });
    f.requestEnded(1);
    f.download();
    expect(f.send.mock.calls[0]?.[0].cookie).toBe('new=two');
  });
  it('HTML attachment不能因completed事件提前遗忘身份', () => {
    const f = fixture();
    f.headers();
    f.response({
      responseHeaders: {
        'Content-Type': ['text/html'],
        'Content-Disposition': ['attachment; filename="file.html"'],
      },
    });
    f.requestEnded(1);
    f.nextGesture();
    f.headers({ id: 2 });
    f.download();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('无敏感身份账本饱和后不能靠时间或新点击遗忘在途歧义', () => {
    const f = fixture();
    f.setEligible(false);
    for (let id = 1; id <= 257; id++) f.headers({ id, url: `https://example.com/${id}` }, false);
    f.setNow(20000);
    f.nextGesture();
    f.setEligible(true);
    f.headers({ id: 258 });
    f.download();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('普通下载completed先于will时仍保留唯一响应身份', () => {
    const f = fixture();
    f.headers();
    f.requestEnded(1);
    f.download();
    expect(f.send).toHaveBeenCalledOnce();
  });
  it('无许可下载取消后退休唯一响应，后续新点击可重新交接', () => {
    const f = fixture();
    f.setEligible(false);
    f.headers();
    f.download();
    f.nextGesture();
    f.setEligible(true);
    f.headers({ id: 2, requestHeaders: { Cookie: 'new=two', 'User-Agent': 'Browser' } });
    f.download();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0]?.[0].cookie).toBe('new=two');
  });
  it('不支持POST取消后退休唯一响应，不阻挡后续GET点击', () => {
    const f = fixture();
    f.headers({ method: 'POST' });
    f.download();
    expect(f.send).not.toHaveBeenCalled();
    f.nextGesture();
    f.headers({ id: 2 });
    f.download();
    expect(f.send).toHaveBeenCalledOnce();
  });
  it('未响应的旧请求不阻挡新响应，但旧响应迟到不能借当前Cookie', () => {
    const f = fixture();
    f.headers({}, false);
    f.nextGesture();
    f.headers({ id: 2, requestHeaders: { Cookie: 'new=two', 'User-Agent': 'Browser' } });
    f.download();
    expect(f.send.mock.calls[0]?.[0].cookie).toBe('new=two');
    f.response();
    f.download();
    expect(f.send).toHaveBeenCalledOnce();
  });
  it('仅发送请求未收到响应不能关联DownloadItem', () => {
    const f = fixture();
    f.headers({}, false);
    f.download();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('POST重定向为GET也不得重放原请求', () => {
    const f = fixture();
    f.headers({ method: 'POST', url: 'https://download.example/start' }, false);
    f.response({ statusCode: 302, url: 'https://download.example/start' });
    f.headers();
    f.download({
      getURLChain: () => ['https://download.example/start', 'https://download.example/file.zip'],
    });
    expect(f.send).not.toHaveBeenCalled();
  });
  it('只有空头other工厂进入私有fallback，传原生referrer而不补页面URL', async () => {
    const read = vi.fn(async () => ({ cookie: 'HttpOnly=one', referer: '', userAgent: 'Browser' }));
    const f = fixture(read);
    f.headers({ resourceType: 'other', requestHeaders: {}, referrer: '' });
    f.download();
    await Promise.resolve();
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ referrer: '', frame: f.frame, webContents: f.wc }),
    );
    expect(f.send.mock.calls[0]?.[0]).toMatchObject({
      cookie: 'HttpOnly=one',
      referer: '',
      userAgent: 'Browser',
    });
  });
  it('fallback期间许可撤销时不传登录信息给服务', async () => {
    const f = fixture(async () => {
      f.setLive(false);
      return { cookie: 'secret=one', referer: '', userAgent: 'Browser' };
    });
    f.headers({ resourceType: 'other', requestHeaders: {} });
    f.download();
    await Promise.resolve();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('无许可起始请求即使重定向发生在新点击之后也不能继承该点击', () => {
    const f = fixture();
    f.setEligible(false);
    f.headers({ url: 'https://origin.example/start' });
    f.setEligible(true);
    f.nextGesture();
    f.headers();
    f.download();
    expect(f.send).not.toHaveBeenCalled();
  });
});
