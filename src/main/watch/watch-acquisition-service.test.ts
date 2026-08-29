// D6 watch-acquisition-service: public/session 严格路由（FIXED 9/10/11/12）。
// 红→绿 oracle：D3 通道复用零回退、HostRequestGate-before-create、final
// origin/locator、login/captcha/challenge 组合信号、每 attempt 全新 task Tab、
// cleanup 失败零 Projection、public script/iframe/canary 零执行零请求、
// D6 成功绝不伪装为 D5 `{ok:true}→unchanged`（编译期红线）。
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  PageAcquisitionRouter,
  sessionHostKey,
  type PageAcquisitionInput,
  type PageAcquisitionResult,
} from './watch-acquisition-service';
import { computeTableHeaderFingerprint } from './page-projector';
import { createPublicWatchHttpStack } from './public-watch-http-client';
import type {
  WatchRequestLike,
  WatchIncomingLike,
  WatchRequestOptions,
} from './public-watch-http-client';
import { HostRequestGate } from './host-request-gate';
import { WatchTaskTabWorkspace, type WatchTaskTabBrowser } from './watch-task-tab-workspace';
import { BrowserWatchReader, type WatchBrowserReadPort } from './browser-watch-reader';
import type { Clock, TimerHandle, PageTarget, WatchAccessMode } from '../../shared/types/watch';
import type { TabInfo, PageSnapshot } from '../../shared/types/browser';

// ---------------------------------------------------------------------------
// 数字时钟（同 browser-watch-reader.test 的 ManualClock 语义）
// ---------------------------------------------------------------------------

class ManualClock implements Clock {
  private nowMs = 0;
  private timers = new Map<number, { atMs: number; cb: () => void }>();
  private nextId = 1;

  now(): Date {
    return new Date(this.nowMs);
  }
  setCurrent(ms: number): void {
    this.nowMs = ms;
    this.runDue();
  }
  advanceBy(ms: number): void {
    this.nowMs += ms;
    this.runDue();
  }
  pendingTimers(): number {
    return this.timers.size;
  }
  private runDue(): void {
    for (const [id, t] of [...this.timers]) {
      if (t.atMs <= this.nowMs) {
        this.timers.delete(id);
        t.cb();
      }
    }
  }
  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { atMs: this.nowMs + delayMs, cb: callback });
    return { kind: 'timer', id };
  }
  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle.id);
  }
}

// ---------------------------------------------------------------------------
// 会话浏览器 fake（同时满足 Workspace 与 Reader 最小端口）
// ---------------------------------------------------------------------------

class SessionFakeBrowser implements WatchTaskTabBrowser, WatchBrowserReadPort {
  tabs: TabInfo[] = [this.tab('user-1', { active: true })];
  snapshots = new Map<string, PageSnapshot>();
  createCalls = 0;
  closeCalls: string[] = [];
  failures = { closeFalse: false, createThrow: false };
  pendingTaskSnapshot: PageSnapshot | null = null;

  private tab(id: string, overrides: Partial<TabInfo> = {}): TabInfo {
    return {
      id,
      title: '',
      url: 'https://example.com/doc',
      active: false,
      state: 'ready',
      ...overrides,
    };
  }

  private defaultTaskSnapshot(url: string): PageSnapshot {
    return {
      url,
      title: 't',
      visibleText: '正文',
      headings: [{ level: 1, text: 'H1' }],
      links: [{ id: 'l', text: 'L', href: `${url}#x` }],
      buttons: [],
      inputs: [],
      tables: [{ headers: ['名称', '价格'], rows: [['甲', '100']] }],
      meta: {
        capturedAt: 1752000000000,
        documentId: 42,
        readyState: 'complete',
        degraded: 'none',
        warnings: [],
      },
    };
  }

  /** 预置下一次 createTab 的 task 快照（模拟页面内容/URL/结构信号）。 */
  setTaskSnapshot(snapshot: Partial<PageSnapshot> & { url?: string }): void {
    const url = snapshot.url ?? 'https://example.com/doc';
    this.pendingTaskSnapshot = { ...this.defaultTaskSnapshot(url), ...snapshot, url };
  }

  async createTab(url: string): Promise<TabInfo> {
    if (this.failures.createThrow) throw new Error('create failed');
    this.createCalls += 1;
    const id = `task-${this.createCalls}`;
    this.tabs = [
      ...this.tabs.map((t) => ({ ...t, active: false })),
      this.tab(id, { url, active: true }),
    ];
    this.snapshots.set(id, this.pendingTaskSnapshot ?? this.defaultTaskSnapshot(url));
    this.pendingTaskSnapshot = null;
    return { id, title: '', url, active: true, state: 'ready' };
  }
  async closeTab(tabId: string): Promise<boolean> {
    this.closeCalls.push(tabId);
    if (this.failures.closeFalse) return false;
    this.tabs = this.tabs.filter((t) => t.id !== tabId);
    return true;
  }
  async activateTab(tabId: string): Promise<boolean> {
    this.tabs = this.tabs.map((t) => ({ ...t, active: t.id === tabId }));
    return true;
  }
  async getTabs(): Promise<TabInfo[]> {
    return this.tabs.map((t) => ({ ...t }));
  }
  async getActiveTab(): Promise<TabInfo | null> {
    return this.tabs.find((t) => t.active) ?? null;
  }
  async getPageSnapshot(tabId: string): Promise<PageSnapshot | null> {
    return this.snapshots.get(tabId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// 公开传输 fake（createPublicWatchHttpStack 受控 seam；零真实网络）
// ---------------------------------------------------------------------------

interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

class FakeIncoming extends EventEmitter implements WatchIncomingLike {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | string[] | undefined>;
  constructor(response: FakeResponse) {
    super();
    this.statusCode = response.status;
    this.statusMessage = 'MSG';
    this.headers = { ...response.headers };
    if (response.body.length > 0) {
      process.nextTick(() => this.emit('data', response.body));
    }
    process.nextTick(() => this.emit('end'));
  }
  resume?(): void {}
  destroy?(): void {}
}

class FakeRequest extends EventEmitter implements WatchRequestLike {
  constructor(
    private readonly options: WatchRequestOptions,
    private readonly handler: (options: WatchRequestOptions) => FakeResponse,
  ) {
    super();
  }
  setTimeout() {}
  end(): void {
    process.nextTick(() => {
      const response = this.handler(this.options);
      this.emit('response', new FakeIncoming(response));
    });
  }
  abort(): void {}
  destroy(): void {}
}

function makePublicHarness(clock: Clock, handler: (options: WatchRequestOptions) => FakeResponse) {
  const seen: Array<{ method: string; path: string }> = [];
  const stack = createPublicWatchHttpStack({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: (options) => {
      seen.push({ method: options.method, path: options.path });
      return new FakeRequest(options, handler) as unknown as WatchRequestLike;
    },
    clock,
  });
  return { stack, seen };
}

function pageHtml(body: string): Buffer {
  return Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>t</title></head>
<body><main><h1>主标题</h1><p>${body}</p><table><tr><th>名称</th><th>价格</th></tr><tr><td>甲</td><td>100</td></tr></table>
<a href="https://example.com/b?tk=SECRET#f">链接</a></main></body></html>`);
}

// ---------------------------------------------------------------------------
// Router harness
// ---------------------------------------------------------------------------

const NOW = 1752000000000;

function makeSessionTarget(overrides: Partial<PageTarget> = {}): PageTarget {
  return {
    type: 'page',
    pageUrl: 'https://example.com/doc',
    regions: [
      { kind: 'main-text', label: '正文' },
      { kind: 'headings', label: '标题', levels: [1] },
      {
        kind: 'table',
        label: '表',
        headerFingerprint: computeTableHeaderFingerprint(['名称', '价格']) ?? '',
        occurrence: 0,
      },
    ],
    sessionConsent: {
      version: 1,
      origin: 'https://example.com',
      grantedAt: '2026-08-29T00:00:00.000Z',
    },
    ...overrides,
  };
}

function makeInput(overrides: Partial<PageAcquisitionInput> = {}): PageAcquisitionInput {
  return {
    target: makeSessionTarget(),
    accessMode: 'session' as WatchAccessMode,
    ruleId: 'rule-1',
    sourceId: 'src-1',
    sourceLocatorFingerprint: 'fp-1',
    signal: new AbortController().signal,
    deadline: new Date(NOW + 90_000),
    ...overrides,
  };
}

function makeHarness() {
  const clock = new ManualClock();
  clock.setCurrent(NOW);
  const hostGate = new HostRequestGate({ clock });
  const browser = new SessionFakeBrowser();
  const workspace = new WatchTaskTabWorkspace({ browser });
  const reader = new BrowserWatchReader({ browser, clock });
  const router = new PageAcquisitionRouter({
    publicTarget: makePublicHarness(clock, () => ({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: pageHtml('公开正文'),
    })).stack.target,
    workspace,
    reader,
    hostGate,
    clock,
  });
  return { clock, hostGate, browser, workspace, router };
}

// 编译期红线：D6 成功类型绝不等于 D5 `{ok:true}`（被 Coordinator 误判 unchanged）
// ------------------------------------------------------------------------
// @ts-expect-error — PageAcquisitionResult 没有裸 `{ok:true}` 形态
const _neverOkTrue: PageAcquisitionResult = { ok: true };
void _neverOkTrue;

describe('sessionHostKey', () => {
  it('host:effectivePort 键形状与 public 注册表一致；任意端口允许', () => {
    expect(sessionHostKey('http://example.com/')).toBe('example.com:80');
    expect(sessionHostKey('https://example.com:443/')).toBe('example.com:443');
    expect(sessionHostKey('http://127.0.0.1:8765/')).toBe('127.0.0.1:8765');
    expect(sessionHostKey('ftp://example.com/')).toBeNull();
    expect(sessionHostKey('https://user@example.com/')).toBeNull();
  });
});

describe('PageAcquisitionRouter — session 成功路径', () => {
  it('consent+gate+全新 task Tab+快照→Projection；release 精确一次', async () => {
    const { browser, workspace, router } = makeHarness();
    const r = await router.run(makeInput());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.accessMode).toBe('session');
    expect(r.expectedSourceLocatorFingerprint).toBe('fp-1');
    expect(r.projection.documentId).toBe('42');
    expect(r.projection.capturedAt).toBe(new Date(1752000000000).toISOString());
    expect(r.projection.value.fields[0]).toMatchObject({ kind: 'main-text', fieldKey: 'r0:main' });
    expect(r.projection.finalUrl).not.toContain('?');
    expect(workspace.getOwnedCount()).toBe(0);
    expect(browser.createCalls).toBe(1);
    expect(browser.closeCalls.length).toBe(1);
  });

  it('每 attempt 全新 task Tab（retry 必须新建，绝不复用）', async () => {
    const { browser, router, clock } = makeHarness();
    const a = await router.run(makeInput());
    expect(a.ok).toBe(true);
    // 5 秒 host gap：第二次 attempt 推进时钟越过 MIN_HOST_REQUEST_GAP_MS
    clock.advanceBy(6_000);
    const b = await router.run(makeInput());
    expect(b.ok).toBe(true);
    expect(browser.createCalls).toBe(2);
  });

  it('gate 在 createTab 前取得（hostKey 已登记）', async () => {
    const { hostGate, router } = makeHarness();
    const r = await router.run(makeInput());
    expect(r.ok).toBe(true);
    expect(hostGate.lastStartedAt('example.com:443')).not.toBeNull();
  });

  it('final URL 跨 origin → security_rejected origin-mismatch；task Tab 已清理', async () => {
    const { browser, router } = makeHarness();
    browser.setTaskSnapshot({ url: 'https://evil.example/doc' });
    const r = await router.run(makeInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.health).toBe('security_rejected');
      expect(r.disposition).toBe('origin-mismatch');
    }
    expect(browser.closeCalls.length).toBe(1);
  });

  it('同 origin 但 locator 改变 → parse_changed source-changed（零自动改 Rule）', async () => {
    const { browser, router } = makeHarness();
    browser.setTaskSnapshot({ url: 'https://example.com/moved' });
    const r = await router.run(makeInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.health).toBe('parse_changed');
      expect(r.disposition).toBe('source-changed');
    }
  });

  it('session 页面链接的 sameOriginOnly 以最终页 origin 判定', async () => {
    const { router } = makeHarness();
    const target = makeSessionTarget({
      regions: [{ kind: 'links', label: '链接', sameOriginOnly: true }],
    });
    const r = await router.run(makeInput({ target }));
    expect(r.ok).toBe(true);
  });
});

describe('PageAcquisitionRouter — session 授权与登录/挑战', () => {
  it('consent 缺失 → login_required consent-missing，零 create', async () => {
    const { browser, router } = makeHarness();
    const r = await router.run(makeInput({ target: makeSessionTarget({ sessionConsent: null }) }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.health).toBe('login_required');
      expect(r.disposition).toBe('consent-missing');
    }
    expect(browser.createCalls).toBe(0);
  });

  it('consent/pageUrl origin 不一致 → login_required consent-mismatch，零 create', async () => {
    const { browser, router } = makeHarness();
    const r = await router.run(
      makeInput({
        target: makeSessionTarget({
          sessionConsent: {
            version: 1,
            origin: 'https://other.example',
            grantedAt: '2026-08-29T00:00:00.000Z',
          },
        }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('login_required');
    expect(browser.createCalls).toBe(0);
  });

  it('password input 结构信号 → login_required（即使快照内容完整）', async () => {
    const { browser, router } = makeHarness();
    browser.setTaskSnapshot({
      inputs: [{ id: 'p', type: 'password', placeholder: '密码', value: 'PASSWORD-CANARY' }],
    });
    const r = await router.run(makeInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.health).toBe('login_required');
      expect(r.disposition).toBe('login');
    }
  });

  it('captcha/challenge URL + 结构信号 → captcha', async () => {
    const { browser, router } = makeHarness();
    browser.setTaskSnapshot({
      url: 'https://example.com/challenge/verify',
      buttons: [{ id: 'b', text: '提交', isSubmit: true }],
    });
    const r = await router.run(makeInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.health).toBe('captcha');
      expect(r.disposition).toBe('captcha');
    }
  });

  it('login URL path 单独出现（无结构信号）→ unavailable suspicious', async () => {
    const { browser, router } = makeHarness();
    browser.setTaskSnapshot({ url: 'https://example.com/login', inputs: [], buttons: [] });
    const r = await router.run(makeInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.health).toBe('unavailable');
      expect(r.disposition).toBe('suspicious');
      expect(r.retryable).toBe(true);
    }
  });

  it('Chromium 错误页 final URL → unavailable tab-error', async () => {
    const { browser, router } = makeHarness();
    browser.setTaskSnapshot({ url: 'chrome-error://chromewebdata/' });
    const r = await router.run(makeInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.disposition).toBe('tab-error');
      expect(r.health).toBe('unavailable');
    }
  });

  // R4 修复：普通页面只因 iframe 降级 → 保守 unavailable（零 Projection/Baseline），
  // 不再是 captcha
  it('degraded snapshot（iframe 降级）→ unavailable snapshot-invalid，不再是 captcha', async () => {
    const { browser, router } = makeHarness();
    browser.setTaskSnapshot({
      meta: {
        capturedAt: 1752000000000,
        documentId: 42,
        readyState: 'complete',
        degraded: 'main-process-only',
        warnings: ['iframe 跨域已跳过'],
      },
    });
    const r = await router.run(makeInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.health).toBe('unavailable'); // 保守 unavailable
      expect(r.disposition).toBe('snapshot-invalid');
    }
  });
});

describe('PageAcquisitionRouter — session 失败清理与所有权', () => {
  it('closeTab=false → dependency_unavailable cleanup-failed；ownership 保留；零 Projection', async () => {
    let unavailable = 0;
    const clock = new ManualClock();
    clock.setCurrent(NOW);
    const browser = new SessionFakeBrowser();
    const workspace = new WatchTaskTabWorkspace({
      browser,
      onCleanupFailure: () => {
        unavailable += 1;
      },
    });
    const reader = new BrowserWatchReader({ browser, clock });
    const router = new PageAcquisitionRouter({
      publicTarget: makePublicHarness(clock, () => ({
        status: 200,
        headers: {},
        body: Buffer.from('<html></html>'),
      })).stack.target,
      workspace,
      reader,
      hostGate: new HostRequestGate({ clock }),
      clock,
    });
    browser.failures.closeFalse = true;
    const r = await router.run(makeInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.health).toBe('dependency_unavailable');
      expect(r.disposition).toBe('cleanup-failed');
    }
    expect(workspace.getOwnedCount()).toBe(1); // 所有权保留
    expect(unavailable).toBe(1);
    browser.failures.closeFalse = false;
    const clean = await workspace.cleanupAll();
    expect(clean.ok).toBe(true);
    expect(workspace.getOwnedCount()).toBe(0);
  });

  it('reader timeout → unavailable timeout；task Tab 精确清理', async () => {
    const clock = new ManualClock();
    clock.setCurrent(NOW);
    const browser = new SessionFakeBrowser();
    const originalCreate = browser.createTab.bind(browser);
    browser.createTab = async (url) => {
      const t = await originalCreate(url);
      browser.tabs = browser.tabs.map((x) =>
        x.id === t.id ? { ...x, state: 'loading' as const } : x,
      );
      return t;
    };
    const workspace = new WatchTaskTabWorkspace({ browser });
    const reader = new BrowserWatchReader({ browser, clock });
    const router = new PageAcquisitionRouter({
      publicTarget: makePublicHarness(clock, () => ({
        status: 200,
        headers: {},
        body: Buffer.from('<html></html>'),
      })).stack.target,
      workspace,
      reader,
      hostGate: new HostRequestGate({ clock }),
      clock,
    });
    const p = router.run(makeInput());
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    await sleep(20); // 让第一轮轮询落定（loading → 安装 sleep timer）
    clock.setCurrent(NOW + 90_000); // 越过 deadline
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.health).toBe('unavailable');
      expect(r.disposition).toBe('timeout');
    }
    expect(clock.pendingTimers()).toBe(0);
    expect(workspace.getOwnedCount()).toBe(0); // 失败后已清理
  });

  it('abort 后迟到快照零 Projection；封闭无泄漏', async () => {
    const clock = new ManualClock();
    clock.setCurrent(NOW);
    const browser = new SessionFakeBrowser();
    const workspace = new WatchTaskTabWorkspace({ browser, onCleanupFailure: () => {} });
    const controller = new AbortController();
    let releaseCreate: (() => void) | null = null;
    const originalCreate = browser.createTab.bind(browser);
    browser.createTab = async (url) => {
      await new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      return originalCreate(url);
    };
    const reader = new BrowserWatchReader({ browser, clock });
    const router = new PageAcquisitionRouter({
      publicTarget: makePublicHarness(clock, () => ({
        status: 200,
        headers: {},
        body: Buffer.from('<html></html>'),
      })).stack.target,
      workspace,
      reader,
      hostGate: new HostRequestGate({ clock }),
      clock,
    });
    const p = router.run(makeInput({ signal: controller.signal }));
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    releaseCreate!();
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.health).toBe('unavailable');
      expect(r.disposition).toBe('aborted');
    }
    expect(workspace.getOwnedCount()).toBe(0);
  });
});

describe('PageAcquisitionRouter — public 路径（D3 安全工厂）', () => {
  it('成功：robots(404)+page 恰两请求；script/iframe/canary 零执行零请求', async () => {
    const clock = new ManualClock();
    clock.setCurrent(NOW);
    const handler = (options: WatchRequestOptions): FakeResponse => {
      if (options.path === '/robots.txt') {
        return { status: 404, headers: {}, body: Buffer.from('') };
      }
      const withCanary = Buffer.concat([
        Buffer.from(
          '<script src="https://evil.example/x.js"></script><iframe src="http://evil.example/f"></iframe><img src="https://evil.example/i.png"><link rel="stylesheet" href="https://evil.example/s.css">',
        ),
        pageHtml('公开正文'),
      ]);
      return {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: withCanary,
      };
    };
    const { stack, seen } = makePublicHarness(clock, handler);
    const router = new PageAcquisitionRouter({
      publicTarget: stack.target,
      workspace: new WatchTaskTabWorkspace({ browser: new SessionFakeBrowser() }),
      reader: new BrowserWatchReader({ browser: new SessionFakeBrowser(), clock }),
      hostGate: new HostRequestGate({ clock }),
      clock,
    });
    const r = await router.run(
      makeInput({
        accessMode: 'public',
        target: {
          type: 'page',
          pageUrl: 'https://example.com/doc?tk=QUERY-CANARY#frag',
          regions: [{ kind: 'main-text', label: '正文' }],
          sessionConsent: null,
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.accessMode).toBe('public');
    expect(r.projection.documentId).toBeNull();
    expect(r.projection.finalUrl).toBe('https://example.com/doc'); // query 不进入投影
    expect(JSON.stringify(r.projection)).not.toContain('QUERY-CANARY');
    expect(JSON.stringify(r.projection)).not.toContain('evil.example');
    expect(JSON.stringify(r.projection)).not.toContain('<script');
    // 零脚本/零子资源：只有 robots 初始 + 目标页两个请求
    expect(seen.map((s) => s.path).sort()).toEqual(['/doc?tk=QUERY-CANARY', '/robots.txt']);
  });

  it('HTTP 404 → parse_changed；500 → unavailable retryable + retryAfter；429 → retryAfter', async () => {
    for (const [status, retryAfter, errorCode, retryable] of [
      [404, null, 'parse_changed', false],
      [500, null, 'unavailable', true],
      [429, '7', 'unavailable', true],
    ] as const) {
      const clock = new ManualClock();
      clock.setCurrent(NOW);
      const { stack } = makePublicHarness(clock, (options) => {
        if (options.path === '/robots.txt') {
          return { status: 404, headers: {}, body: Buffer.from('') };
        }
        const headers: Record<string, string> =
          retryAfter === null ? {} : { 'retry-after': retryAfter };
        return { status, headers, body: Buffer.from('<html></html>') };
      });
      const router = new PageAcquisitionRouter({
        publicTarget: stack.target,
        workspace: new WatchTaskTabWorkspace({ browser: new SessionFakeBrowser() }),
        reader: new BrowserWatchReader({ browser: new SessionFakeBrowser(), clock }),
        hostGate: new HostRequestGate({ clock }),
        clock,
      });
      const r = await router.run(
        makeInput({
          accessMode: 'public',
          target: {
            type: 'page',
            pageUrl: 'https://example.com/doc',
            regions: [{ kind: 'main-text', label: '正文' }],
            sessionConsent: null,
          },
        }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.health).toBe(errorCode);
        expect(r.retryable).toBe(retryable);
        if (retryAfter !== null) expect(r.retryAfterSeconds).toBe(7);
      }
    }
  });

  it('robots disallow → robots_disallowed；非 http(s) target → parse_changed', async () => {
    const clock = new ManualClock();
    clock.setCurrent(NOW);
    const { stack } = makePublicHarness(clock, (options) =>
      options.path === '/robots.txt'
        ? {
            status: 200,
            headers: {},
            body: Buffer.from('User-agent: aibrowse\nDisallow: /\n'),
          }
        : { status: 200, headers: {}, body: pageHtml('x') },
    );
    const router = new PageAcquisitionRouter({
      publicTarget: stack.target,
      workspace: new WatchTaskTabWorkspace({ browser: new SessionFakeBrowser() }),
      reader: new BrowserWatchReader({ browser: new SessionFakeBrowser(), clock }),
      hostGate: new HostRequestGate({ clock }),
      clock,
    });
    const r = await router.run(
      makeInput({
        accessMode: 'public',
        target: {
          type: 'page',
          pageUrl: 'https://example.com/doc',
          regions: [{ kind: 'main-text', label: '正文' }],
          sessionConsent: null,
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('robots_disallowed');

    const r2 = await router.run(
      makeInput({
        accessMode: 'public',
        target: {
          type: 'page',
          pageUrl: 'file:///etc/passwd',
          regions: [{ kind: 'main-text', label: '正文' }],
          sessionConsent: null,
        },
      }),
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.health).toBe('parse_changed'); // 页面 target 形状契约
  });

  it('login/challenge path（无结构信号）→ unavailable suspicious', async () => {
    const clock = new ManualClock();
    clock.setCurrent(NOW);
    const { stack } = makePublicHarness(clock, () => ({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: pageHtml('登录页正文 CAPTCHA-WORD'),
    }));
    const router = new PageAcquisitionRouter({
      publicTarget: stack.target,
      workspace: new WatchTaskTabWorkspace({ browser: new SessionFakeBrowser() }),
      reader: new BrowserWatchReader({ browser: new SessionFakeBrowser(), clock }),
      hostGate: new HostRequestGate({ clock }),
      clock,
    });
    const r = await router.run(
      makeInput({
        accessMode: 'public',
        target: {
          type: 'page',
          pageUrl: 'https://example.com/login',
          regions: [{ kind: 'main-text', label: '正文' }],
          sessionConsent: null,
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.health).toBe('unavailable');
      expect(r.disposition).toBe('suspicious');
    }
  });

  it('公开路径零自动回退 Session：无 consent 且无 task Tab 创建', async () => {
    const clock = new ManualClock();
    clock.setCurrent(NOW);
    const { stack, seen } = makePublicHarness(clock, () => ({
      status: 200,
      headers: {},
      body: pageHtml('公开内容'),
    }));
    const browser = new SessionFakeBrowser();
    const router = new PageAcquisitionRouter({
      publicTarget: stack.target,
      workspace: new WatchTaskTabWorkspace({ browser }),
      reader: new BrowserWatchReader({ browser, clock }),
      hostGate: new HostRequestGate({ clock }),
      clock,
    });
    const r = await router.run(
      makeInput({
        accessMode: 'public',
        target: {
          type: 'page',
          pageUrl: 'https://example.com/doc',
          regions: [{ kind: 'main-text', label: '正文' }],
          sessionConsent: null,
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(browser.createCalls).toBe(0);
    expect(seen.length).toBe(2); // robots + page；无 session 回退
  });
});
