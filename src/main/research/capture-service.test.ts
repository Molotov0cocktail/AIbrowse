// C4 capture-service tests（决议 #124–#128）：Tab 生命周期零双导航、ready/L0–L3/
// 页面关闭映射、重试矩阵、finally release、failed Capture sentinel、CaptureContent
// 规范化与 60k 预算/哈希覆盖、contentHash 确定性、正文零持久化（记录不含正文）。
// 纯 node 环境：Workspace/浏览器全部为注入替身（零 Electron）。
import { describe, expect, it } from 'vitest';
import type { PageSnapshot, TabInfo } from '../../shared/types/browser';
import type { SourceCandidate } from '../../shared/types/research';
import { MAX_PAGE_CAPTURE_CHARS } from '../../shared/types/research';
import { normalizeSnapshot } from '../browser/snapshot-normalize';
import {
  buildCaptureContent,
  CAPTURE_EMPTY_CONTENT_HASH,
  CAPTURE_SENTINEL_DOCUMENT_ID,
  CAPTURE_SENTINEL_TAB_ID,
  CaptureService,
  normalizeCaptureText,
  sha256hex,
  type CaptureReadResult,
} from './capture-service';
import type {
  AcquireResult,
  CheckTabResult,
  ReleaseResult,
  WorkspaceErrorCode,
} from './research-workspace';

const TASK_ID = 'task-00000000-0000-4000-8000-000000000001';
const CANDIDATE_ID = 'cand-00000000-0000-4000-8000-000000000001';
const CAPTURED_AT_MS = Date.parse('2026-08-16T08:30:00.000Z');
const ISO_AT = '2026-08-16T08:30:00.000Z';

function makeCandidate(over: Partial<SourceCandidate> = {}): SourceCandidate {
  return {
    id: CANDIDATE_ID,
    url: 'https://example.com/article',
    displayUrl: 'https://example.com/article',
    title: '候选标题',
    canonicalKey: 'https://example.com/article',
    scope: 'page',
    discoveredVia: ['search'],
    sourceId: null,
    trust: null,
    priority: null,
    lastUsedAt: null,
    note: null,
    sortKey:
      '03|00000|9|~~~~~~~~~~~~~~~~~~~~~~~~|1|https://example.com/article|cand-00000000-0000-4000-8000-000000000001',
    ...over,
  };
}

function makeSnapshot(over: Partial<PageSnapshot> = {}): PageSnapshot {
  const { meta: overMeta, buttons: overButtons, ...rest } = over;
  return {
    url: 'https://example.com/article',
    title: '文章标题',
    visibleText: '第一段正文内容。第二段正文内容。',
    headings: [
      { level: 1, text: '主标题' },
      { level: 2, text: '小节' },
    ],
    links: [
      { id: 'el-1', text: '示例链接', href: 'https://example.com/other' },
      { id: 'el-2', text: '第二个链接', href: '/relative' },
    ],
    tables: [
      {
        headers: ['名称', '价格'],
        rows: [
          ['甲', '100'],
          ['乙', '200'],
        ],
      },
    ],
    buttons: overButtons ?? [],
    ...rest,
    meta: {
      capturedAt: CAPTURED_AT_MS,
      documentId: 7,
      readyState: 'complete',
      degraded: 'none',
      warnings: [],
      ...(overMeta ?? {}),
    },
  };
}

function makeTab(id: string, state: TabInfo['state'] = 'ready'): TabInfo {
  return { id, title: '页面', url: 'https://example.com/article', active: false, state };
}

function makeLease(tabId: string) {
  return { taskId: TASK_ID, tabId, url: 'https://example.com/article' };
}

function okAcquire(tabId: string): AcquireResult {
  return { ok: true, lease: makeLease(tabId) };
}

function failAcquire(code: WorkspaceErrorCode, reason: string): AcquireResult {
  return { ok: false, errorCode: code, reason };
}

function aliveCheck(tabId: string): CheckTabResult {
  return { ok: true, status: 'alive', lease: makeLease(tabId) };
}

function closedCheck(): CheckTabResult {
  return { ok: true, status: 'closed-by-user' };
}

function failCheck(code: WorkspaceErrorCode, reason: string): CheckTabResult {
  return { ok: false, errorCode: code, reason };
}

function okRelease(closed = true): ReleaseResult {
  return { ok: true, closed };
}

function failRelease(code: WorkspaceErrorCode, reason: string): ReleaseResult {
  return { ok: false, errorCode: code, reason };
}

interface FakeWorkspaceState {
  acquireResults: AcquireResult[];
  checkResults: CheckTabResult[];
  releaseResults: ReleaseResult[];
}

// Workspace 注入替身：精确记录每次 acquire/checkTab/release 调用与参数
class FakeWorkspace {
  readonly taskId = TASK_ID;
  acquireCalls: string[] = [];
  checkCalls: string[] = [];
  releaseCalls: string[] = [];
  private tabCounter = 1;

  constructor(private readonly state: FakeWorkspaceState) {}

  acquire(url: string): Promise<AcquireResult> {
    this.acquireCalls.push(url);
    const next = this.state.acquireResults.shift();
    if (next !== undefined) return Promise.resolve(next);
    return Promise.resolve(okAcquire(`tab-${this.tabCounter++}`));
  }

  checkTab(tabId: string): Promise<CheckTabResult> {
    this.checkCalls.push(tabId);
    const next = this.state.checkResults.shift();
    if (next !== undefined) return Promise.resolve(next);
    return Promise.resolve(aliveCheck(tabId));
  }

  release(tabId: string): Promise<ReleaseResult> {
    this.releaseCalls.push(tabId);
    const next = this.state.releaseResults.shift();
    if (next !== undefined) return Promise.resolve(next);
    return Promise.resolve(okRelease());
  }
}

interface FakeBrowserState {
  tabs: TabInfo[];
  snapshotFor?: (tabId: string) => PageSnapshot | null;
  getTabsError?: Error;
  snapshotError?: Error;
}

// 浏览器最小端口替身：仅 getTabs/getPageSnapshot（零 navigate 结构保证——
// CaptureBrowserPort 类型不含导航方法）
class FakeBrowser {
  getTabsCalls = 0;
  snapshotCalls: string[] = [];

  constructor(private readonly state: FakeBrowserState) {}

  async getTabs(): Promise<TabInfo[]> {
    this.getTabsCalls += 1;
    if (this.state.getTabsError !== undefined) throw this.state.getTabsError;
    return this.state.tabs;
  }

  async getPageSnapshot(tabId: string): Promise<PageSnapshot | null> {
    this.snapshotCalls.push(tabId);
    if (this.state.snapshotError !== undefined) throw this.state.snapshotError;
    if (this.state.snapshotFor === undefined) return makeSnapshot();
    return this.state.snapshotFor(tabId);
  }
}

interface Harness {
  workspace: FakeWorkspace;
  browser: FakeBrowser;
  service: CaptureService;
  wsState: FakeWorkspaceState;
  browserState: FakeBrowserState;
  ids: string[];
  read: (candidate?: SourceCandidate) => Promise<CaptureReadResult>;
}

function makeHarness(
  over: {
    ws?: Partial<FakeWorkspaceState>;
    browser?: Partial<FakeBrowserState>;
    signal?: AbortSignal;
  } = {},
): Harness {
  const wsState: FakeWorkspaceState = {
    acquireResults: over.ws?.acquireResults ?? [],
    checkResults: over.ws?.checkResults ?? [],
    releaseResults: over.ws?.releaseResults ?? [],
  };
  const browserState: FakeBrowserState = {
    tabs: over.browser?.tabs ?? [],
    snapshotFor: over.browser?.snapshotFor,
    getTabsError: over.browser?.getTabsError,
    snapshotError: over.browser?.snapshotError,
  };
  const workspace = new FakeWorkspace(wsState);
  const browser = new FakeBrowser(browserState);
  const ids: string[] = [];
  let n = 1;
  // 时钟随轮询推进：sleep 每次 +50ms（timeout 路径 15s 内收敛；ready/error/
  // missing 路径与时间无关）
  let clock = CAPTURED_AT_MS;
  const service = new CaptureService({
    workspace,
    browser,
    now: () => clock,
    nowIso: () => ISO_AT,
    sleep: () => {
      clock += 50;
      return Promise.resolve();
    },
    createCaptureId: () => {
      const id = `capture-${n++}`;
      ids.push(id);
      return id;
    },
  });
  return {
    workspace,
    browser,
    service,
    wsState,
    browserState,
    ids,
    read: (candidate = makeCandidate()) =>
      service.read(candidate, over.signal ?? new AbortController().signal),
  };
}

function withReadyTab(harness: Harness, tabId = 'tab-1'): void {
  // 幂等追加（多次调用共存多个 task Tab：tab-1、tab-2…）
  if (!harness.browserState.tabs.some((t) => t.id === 'user-tab')) {
    harness.browserState.tabs.push(makeTab('user-tab'));
  }
  if (!harness.browserState.tabs.some((t) => t.id === tabId)) {
    harness.browserState.tabs.push(makeTab(tabId));
  }
}

// ---------- 编排（注入替身） ----------

describe('CaptureService.read 编排', () => {
  it('L0 成功：acquire 已加载（零二次 navigate）→ ready → checkTab → snapshot → checkTab → finally release', async () => {
    const h = makeHarness();
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // acquire 恰好一次、URL 为候选规范展示值（createTab 已开始加载，本层零导航）
    expect(h.workspace.acquireCalls).toEqual(['https://example.com/article']);
    // 浏览器最小端口只有 getTabs/getPageSnapshot——结构上不存在 navigate/loadURL
    expect('navigate' in h.browser).toBe(false);
    expect('loadURL' in h.browser).toBe(false);
    expect(h.browser.snapshotCalls).toEqual(['tab-1']);
    // 读前 checkTab + 快照后二次 checkTab
    expect(h.workspace.checkCalls).toEqual(['tab-1', 'tab-1']);
    // finally release 恰好一次
    expect(h.workspace.releaseCalls).toEqual(['tab-1']);
    // attempts 恰一次成功 capture；capture === attempts[0]
    expect(result.attempts).toHaveLength(1);
    expect(result.capture).toBe(result.attempts[0]);
    expect(result.attempts[0]?.failed).toBe(false);
    // 主进程盖章字段
    expect(result.capture.url).toBe('https://example.com/article');
    expect(result.capture.title).toBe('文章标题');
    expect(result.capture.accessTime).toBe(ISO_AT);
    expect(result.capture.documentId).toBe('7');
    expect(result.capture.tabId).toBe('tab-1');
    expect(result.capture.taskId).toBe(TASK_ID);
    expect(result.capture.candidateId).toBe(CANDIDATE_ID);
    // 内容绑定同一 captureId
    expect(result.content.captureId).toBe(result.capture.captureId);
    expect(result.capture.contentHash).toBe(sha256hex(result.content.canonicalText));
    expect(result.warnings).toEqual([]);
  });

  it('L1 partial → 成功并附降级 warning', async () => {
    const h = makeHarness({
      browser: {
        snapshotFor: () =>
          makeSnapshot({
            meta: {
              ...makeSnapshot().meta,
              degraded: 'partial',
              warnings: ['跳过 1 个 iframe（其中 1 个跨域）'],
            },
          }),
      },
    });
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => w.includes('降级'))).toBe(true);
  });

  it('L2 main-process-only → snapshot-degraded，重试一次后成功（attempts 2 个 capture）', async () => {
    let n = 0;
    const h = makeHarness({
      browser: {
        snapshotFor: () => {
          n += 1;
          if (n === 1) {
            return makeSnapshot({
              meta: { ...makeSnapshot().meta, degraded: 'main-process-only' },
            });
          }
          return makeSnapshot();
        },
      },
    });
    withReadyTab(h, 'tab-1');
    withReadyTab(h, 'tab-2'); // 第二次尝试的 ready 状态（FakeWorkspace 依次分配 tab-1/tab-2）
    const result = await h.read();
    expect(result.ok).toBe(true);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.failed).toBe(true);
    expect(result.attempts[0]?.failureReason).toBe('snapshot-degraded');
    // 重试产生新 captureId 与新 tabId
    expect(result.attempts[0]?.captureId).not.toBe(result.attempts[1]?.captureId);
    expect(result.attempts[0]?.tabId).toBe('tab-1');
    expect(result.attempts[1]?.tabId).toBe('tab-2');
    expect(h.workspace.acquireCalls).toHaveLength(2);
    expect(h.workspace.releaseCalls).toEqual(['tab-1', 'tab-2']);
  });

  it('两次 L2 → ok:false snapshot-degraded，attempts 2 个（每次尝试 finally release）', async () => {
    const h = makeHarness({
      browser: {
        snapshotFor: () =>
          makeSnapshot({ meta: { ...makeSnapshot().meta, degraded: 'main-process-only' } }),
      },
    });
    withReadyTab(h, 'tab-1');
    withReadyTab(h, 'tab-2');
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('snapshot-degraded');
    expect(result.attempts).toHaveLength(2);
    expect(h.workspace.releaseCalls).toEqual(['tab-1', 'tab-2']);
  });

  it('ready 轮询 error → page-load-failed（可重试）', async () => {
    const h = makeHarness();
    h.browserState.tabs = [makeTab('tab-1', 'error'), makeTab('tab-2', 'error')];
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('page-load-failed');
    expect(result.attempts).toHaveLength(2); // 重试一次
    expect(h.workspace.acquireCalls).toHaveLength(2);
  });

  it('error 后翻回 ready（Chromium 错误页完成加载，决议 #131 实证）→ 快照 chrome-error:// → page-load-failed（可重试）', async () => {
    // Chromium 加载失败后错误页自身 finish-load 把状态从 error 翻回 ready
    // （翻转窗口 <50ms 轮询间隔——error 立即失败路径捕捉不到）；兜底判定 =
    // 快照 url 为 chrome-error://chromewebdata/（title 为失败 URL、集合全空）
    const sequence: Array<TabInfo['state']> = ['loading', 'ready', 'loading', 'ready'];
    let polls = 0;
    const h = makeHarness({
      browser: {
        snapshotFor: () =>
          makeSnapshot({
            url: 'chrome-error://chromewebdata/',
            title: 'https://example.com/article',
            visibleText: '',
            headings: [],
            links: [],
            tables: [],
          }),
      },
    });
    h.browserState.tabs = [makeTab('tab-1', 'loading'), makeTab('tab-2', 'loading')];
    // 每次 getTabs 轮询按序列循环推进状态（每次尝试独立经历 loading→ready）
    const originalGetTabs = h.browser.getTabs.bind(h.browser);
    h.browser.getTabs = async () => {
      polls += 1;
      const state = sequence[(polls - 1) % sequence.length]!;
      h.browserState.tabs = h.browserState.tabs.map((t) => ({ ...t, state }));
      return originalGetTabs();
    };
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('page-load-failed');
    expect(result.attempts).toHaveLength(2); // 可重试一次（网络抖动可能恢复）
  });

  it('错误页判定不是重定向判定：其余非法快照 URL 仍映射 http-scheme-rejected（不重试）', async () => {
    const h = makeHarness({
      browser: { snapshotFor: () => makeSnapshot({ url: 'aibrowse-smoke://evil/' }) },
    });
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('http-scheme-rejected');
    expect(result.attempts).toHaveLength(1);
  });

  it('Tab 从列表消失（用户提前关闭）→ tab-closed-by-user（不重试）', async () => {
    const h = makeHarness();
    h.browserState.tabs = [makeTab('user-tab')]; // task tab 不存在
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('tab-closed-by-user');
    expect(result.attempts).toHaveLength(1);
    expect(h.workspace.acquireCalls).toHaveLength(1);
  });

  it('ready 超时 → timeout（可重试）；两次超时 → ok:false timeout', async () => {
    const h = makeHarness();
    h.browserState.tabs = [makeTab('tab-1', 'loading'), makeTab('tab-2', 'loading')]; // 永远 loading
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('timeout');
    expect(result.attempts).toHaveLength(2);
    expect(h.workspace.acquireCalls).toHaveLength(2);
  });

  it('轮询中 abort → aborted（不重试）', async () => {
    const controller = new AbortController();
    const h = makeHarness({ signal: controller.signal });
    h.browserState.tabs = [makeTab('tab-1', 'loading')];
    controller.abort();
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('aborted');
    expect(result.attempts).toHaveLength(1);
  });

  it('acquire 前已 abort → aborted（不重试，acquire 返回 tab-create-aborted）', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = makeHarness({
      signal: controller.signal,
      ws: { acquireResults: [failAcquire('tab-create-aborted', '创建前已取消')] },
    });
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('aborted');
    expect(result.attempts).toHaveLength(1);
  });

  it('读前 checkTab closed-by-user → tab-closed-by-user（不重试）', async () => {
    const h = makeHarness({ ws: { checkResults: [closedCheck()] } });
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('tab-closed-by-user');
    expect(result.attempts).toHaveLength(1);
  });

  it('getPageSnapshot=null 且 checkTab 已关闭 → tab-closed-by-user（不重试）', async () => {
    const h = makeHarness({
      browser: { snapshotFor: () => null },
      ws: { checkResults: [aliveCheck('tab-1'), closedCheck()] }, // 读前 alive、快照后 closed
    });
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('tab-closed-by-user');
    expect(result.attempts).toHaveLength(1);
  });

  it('getPageSnapshot=null 且 Tab 存活 → snapshot-degraded（可重试）', async () => {
    const h = makeHarness({
      browser: { snapshotFor: () => null },
    });
    withReadyTab(h, 'tab-1');
    withReadyTab(h, 'tab-2');
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('snapshot-degraded');
    expect(result.attempts).toHaveLength(2);
  });

  it('快照期间用户关闭（snapshot 返回后二次 checkTab=closed）→ tab-closed-by-user', async () => {
    const h = makeHarness({
      ws: { checkResults: [aliveCheck('tab-1'), closedCheck()] },
    });
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('tab-closed-by-user');
  });

  it('成功接纳前 signal abort → aborted（不重试）', async () => {
    const controller = new AbortController();
    const h = makeHarness({ signal: controller.signal });
    withReadyTab(h);
    // 快照完成后、二次 checkTab 前中止：sleep 注入在轮询后触发中止
    const resultPromise = h.read();
    controller.abort();
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('aborted');
    expect(result.attempts).toHaveLength(1);
  });

  it('acquire invalid-url → http-scheme-rejected（不重试，sentinel capture）', async () => {
    const h = makeHarness({
      ws: { acquireResults: [failAcquire('invalid-url', 'URL 无效')] },
    });
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('http-scheme-rejected');
    expect(result.attempts).toHaveLength(1);
  });

  it('候选 URL 前置非法（javascript:）→ http-scheme-rejected、零 acquire、sentinel capture', async () => {
    const h = makeHarness();
    const result = await h.read(
      makeCandidate({ url: 'javascript:alert(1)', displayUrl: 'javascript:alert(1)' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('http-scheme-rejected');
    expect(h.workspace.acquireCalls).toHaveLength(0);
    expect(result.attempts).toHaveLength(1);
    const cap = result.attempts[0]!;
    expect(cap.failed).toBe(true);
    expect(cap.tabId).toBe(CAPTURE_SENTINEL_TAB_ID);
    expect(cap.documentId).toBe(CAPTURE_SENTINEL_DOCUMENT_ID);
    expect(cap.url).toBe('javascript:alert(1)'); // 已校验候选展示值（该场景为展示值原样）
  });

  it('redirect 后最终 URL 取实际快照（合法 http 重定向），capturedAt/documentId 主进程盖章', async () => {
    const h = makeHarness({
      browser: {
        snapshotFor: () => makeSnapshot({ url: 'https://example.com/final', title: '最终页' }),
      },
    });
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capture.url).toBe('https://example.com/final');
    expect(result.capture.title).toBe('最终页');
    expect(result.capture.accessTime).toBe(ISO_AT);
    expect(result.capture.documentId).toBe('7');
    // 字段路径 page.url 来自实际快照
    expect(result.content.fields['page.url']).toBe('https://example.com/final');
  });

  it('redirect 非法目标（userinfo/非 http）→ http-scheme-rejected（不重试）', async () => {
    const h = makeHarness({
      browser: { snapshotFor: () => makeSnapshot({ url: 'aibrowse-smoke://evil/' }) },
    });
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('http-scheme-rejected');
    expect(result.attempts).toHaveLength(1);
  });

  it('非法 capturedAt（NaN/越界）→ snapshot-degraded（可重试）', async () => {
    const h = makeHarness({
      browser: {
        snapshotFor: () =>
          makeSnapshot({ meta: { ...makeSnapshot().meta, capturedAt: Number.NaN } }),
      },
    });
    withReadyTab(h, 'tab-1');
    withReadyTab(h, 'tab-2');
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('snapshot-degraded');
    expect(result.attempts).toHaveLength(2);
  });

  it('非法 documentId（负数/非整数/字符串）→ snapshot-degraded', async () => {
    for (const bad of [-1, 1.5, '7' as unknown as number]) {
      const h = makeHarness({
        browser: {
          snapshotFor: () => makeSnapshot({ meta: { ...makeSnapshot().meta, documentId: bad } }),
        },
      });
      withReadyTab(h, 'tab-1');
      withReadyTab(h, 'tab-2');
      const result = await h.read();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failureReason).toBe('snapshot-degraded');
    }
  });

  it('acquire cleanup-failed → 失败 + warning（不含 URL/正文）+ 不重试（不创建更多 Tab）', async () => {
    const h = makeHarness({
      ws: { acquireResults: [failAcquire('cleanup-failed', '关闭任务标签页失败（创建已取消）')] },
    });
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toHaveLength(1);
    expect(h.workspace.acquireCalls).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThan(0);
    for (const w of result.warnings) {
      expect(w.includes('https://example.com/article')).toBe(false);
      expect(w.includes('第一段正文')).toBe(false);
    }
  });

  it('checkTab 异常（workspace-internal）→ page-load-failed（可重试）', async () => {
    const h = makeHarness({
      ws: {
        checkResults: [
          failCheck('workspace-internal', '读取标签页状态失败'),
          failCheck('workspace-internal', '读取标签页状态失败'),
        ],
      },
    });
    withReadyTab(h, 'tab-1');
    withReadyTab(h, 'tab-2');
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('page-load-failed');
    expect(result.attempts).toHaveLength(2);
  });

  it('browser.getTabs 抛异常（轮询中）→ page-load-failed（可重试）', async () => {
    const h = makeHarness({ browser: { getTabsError: new Error('boom') } });
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('page-load-failed');
    expect(result.attempts).toHaveLength(2);
  });

  it('browser.getPageSnapshot 抛异常 → page-load-failed（可重试）', async () => {
    const h = makeHarness({ browser: { snapshotError: new Error('boom') } });
    withReadyTab(h, 'tab-1');
    withReadyTab(h, 'tab-2');
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('page-load-failed');
    expect(result.attempts).toHaveLength(2);
  });

  it('workspace.acquire 抛异常 → 归一 page-load-failed（可重试，零未处理 rejection）', async () => {
    const h = makeHarness({
      ws: { acquireResults: [failAcquire('workspace-internal', '标签页创建异常')] }, // 第二次尝试也失败
    });
    const original = h.workspace.acquire.bind(h.workspace);
    let thrown = false;
    h.workspace.acquire = (url) => {
      if (!thrown) {
        thrown = true;
        return Promise.reject(new Error('boom'));
      }
      return original(url);
    };
    const result = await h.read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureReason).toBe('page-load-failed');
    expect(result.attempts).toHaveLength(2);
  });

  it('release 返回 cleanup-failed 且内容已成功捕获 → ok:true + 安全 warning（不丢弃 Capture）', async () => {
    const h = makeHarness({
      ws: { releaseResults: [failRelease('cleanup-failed', '关闭任务标签页失败')] },
    });
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.length).toBeGreaterThan(0);
    for (const w of result.warnings) {
      expect(w.includes('https://example.com/article')).toBe(false);
      expect(w.includes('第一段正文')).toBe(false);
    }
  });

  it('release 抛异常 且尝试失败 → ok:false + warning + 不重试（不继续创建更多 Tab）', async () => {
    const h = makeHarness({
      ws: { releaseResults: [failRelease('cleanup-failed', '关闭任务标签页异常')] },
      browser: {
        snapshotFor: () =>
          makeSnapshot({ meta: { ...makeSnapshot().meta, degraded: 'main-process-only' } }),
      },
    });
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(1); // 不重试
    expect(h.workspace.acquireCalls).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('release 抛异常（fake 直接 reject）→ 安全处理零未处理 rejection', async () => {
    const h = makeHarness();
    h.workspace.release = () => Promise.reject(new Error('release boom'));
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true); // 内容已捕获：不丢弃
    if (!result.ok) return;
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('失败 sentinel（决议 #126）：Tab 未分配/快照不存在时五字段确定性', async () => {
    // acquire 失败（Tab 未分配）→ tabId/documentId sentinel
    const h1 = makeHarness({
      ws: { acquireResults: [failAcquire('workspace-internal', '标签页创建异常')] },
    });
    const r1 = await h1.read();
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    const unallocated = r1.attempts.find((a) => a.failed)!;
    expect(unallocated.tabId).toBe(CAPTURE_SENTINEL_TAB_ID);
    expect(unallocated.documentId).toBe(CAPTURE_SENTINEL_DOCUMENT_ID);
    expect(unallocated.contentHash).toBe(CAPTURE_EMPTY_CONTENT_HASH);
    expect(unallocated.summary).toEqual({
      sectionCount: 0,
      tableCount: 0,
      headingCount: 0,
      charCount: 0,
    });
    expect(unallocated.url).toBe('https://example.com/article'); // 已校验候选展示值
    expect(unallocated.title).toBe('候选标题');
    expect(unallocated.accessTime).toBe(ISO_AT); // 注入主进程时钟
    expect(unallocated.failed).toBe(true);
    expect(unallocated.failureReason).not.toBeNull();
    // 失败 capture 的正文标记零出现（零正文持久化：记录本身不含正文）
    expect(JSON.stringify(unallocated)).not.toContain('第一段正文');

    // ready error（Tab 已分配但无快照）→ tabId 为实际精确 id、documentId 仍为 sentinel
    const h2 = makeHarness();
    h2.browserState.tabs = [makeTab('tab-1', 'error')];
    const r2 = await h2.read();
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    const allocated = r2.attempts.find((a) => a.failed)!;
    expect(allocated.tabId).toBe('tab-1');
    expect(allocated.documentId).toBe(CAPTURE_SENTINEL_DOCUMENT_ID);
    expect(allocated.contentHash).toBe(CAPTURE_EMPTY_CONTENT_HASH);
    expect(allocated.failed).toBe(true);
  });

  it('每次尝试独立 captureId（注入工厂逐次调用）；成功 capture 的 contentHash 确定性', async () => {
    const h = makeHarness();
    withReadyTab(h, 'tab-1');
    withReadyTab(h, 'tab-2');
    const r1 = await h.read();
    const r2 = await h.read();
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.capture.captureId).not.toBe(r2.capture.captureId);
    expect(r1.capture.contentHash).toBe(r2.capture.contentHash); // 同内容 → 同哈希
    expect(h.ids).toEqual([r1.capture.captureId, r2.capture.captureId]);
  });

  it('成功 Capture 元数据不含正文/快照内容（正文零落盘：只有哈希 + 摘要）', async () => {
    const h = makeHarness();
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.capture);
    expect(serialized).not.toContain('第一段正文内容');
    expect(serialized).not.toContain('visibleText');
    expect(serialized).not.toContain('canonicalText');
    expect(serialized).toContain(result.capture.contentHash);
  });
});

// ---------- CaptureContent 纯函数（决议 #128） ----------

describe('buildCaptureContent 规范化/预算/哈希覆盖', () => {
  it('规范化：NFC/trim/控制字符/bidi 清除/连续空白折叠', () => {
    // NFC：e + 组合重音 → 预组合；bidi/控制/零宽剔除；\t 与多空格折叠；首尾 trim
    expect(normalizeCaptureText('café')).toBe('café');
    expect(normalizeCaptureText('‮邪恶‬  \t 多  空白 ​⁦ ')).toBe('邪恶 多 空白');
    expect(normalizeCaptureText('  \t  前后空白  \n ')).toBe('前后空白');
  });

  it('输入零修改（冻结快照不可变）', () => {
    const snapshot = makeSnapshot();
    const frozen = JSON.parse(JSON.stringify(snapshot)) as PageSnapshot;
    const content = buildCaptureContent(frozen, 'cap-1');
    expect(frozen).toEqual(makeSnapshot()); // 深度比较：快照未被修改
    expect(content.captureId).toBe('cap-1');
  });

  it('canonicalText 来源顺序固定：visibleText → headings → tables → links → fields', () => {
    const content = buildCaptureContent(makeSnapshot(), 'cap-1');
    const idxText = content.canonicalText.indexOf('[text]');
    const idxHeading = content.canonicalText.indexOf('[heading]');
    const idxTable = content.canonicalText.indexOf('[table]');
    const idxLink = content.canonicalText.indexOf('[link]');
    const idxField = content.canonicalText.indexOf('[field]');
    expect(idxText).toBeGreaterThanOrEqual(0);
    expect(idxHeading).toBeGreaterThan(idxText);
    expect(idxTable).toBeGreaterThan(idxHeading);
    expect(idxLink).toBeGreaterThan(idxTable);
    expect(idxField).toBeGreaterThan(idxLink);
  });

  it('textSections 非空且独立规范化；所有 section 值进入 canonicalText（哈希覆盖）', () => {
    const content = buildCaptureContent(makeSnapshot(), 'cap-1');
    expect(content.textSections.length).toBeGreaterThan(0);
    for (const section of content.textSections) {
      expect(section.trim()).not.toBe('');
      expect(section).toBe(normalizeCaptureText(section)); // 幂等（已规范化）
      expect(content.canonicalText.includes(section)).toBe(true);
    }
    // summary 与内容一致
    expect(content.textSections.length).toBe(
      1 /* text */ + 2 /* headings */ + 1 /* table */ + 2 /* links */,
    );
  });

  it('表格保留为表头 + 数据行（不含 header 行）；单元格值全部进入 canonicalText', () => {
    const content = buildCaptureContent(makeSnapshot(), 'cap-1');
    expect(content.tables).toHaveLength(1);
    const table = content.tables[0]!;
    expect(table.headers).toEqual(['名称', '价格']);
    expect(table.rows).toEqual([
      ['甲', '100'],
      ['乙', '200'],
    ]);
    for (const row of table.rows) {
      for (const cell of row) {
        expect(content.canonicalText.includes(cell)).toBe(true);
      }
    }
  });

  it('fields 闭合白名单：page.url/page.title/headings[0].text/links[0].text/links[0].href + 固定索引表格路径；全部进入 canonicalText', () => {
    const content = buildCaptureContent(makeSnapshot(), 'cap-1');
    expect(content.fields['page.url']).toBe('https://example.com/article');
    expect(content.fields['page.title']).toBe('文章标题');
    expect(content.fields['headings[0].text']).toBe('主标题');
    expect(content.fields['links[0].text']).toBe('示例链接');
    expect(content.fields['links[0].href']).toBe('https://example.com/other');
    expect(content.fields['tables[0].cell[1][2]']).toBeUndefined(); // col 2 不存在
    expect(content.fields['tables[0].cell[0][1]']).toBe('100');
    expect(content.fields['tables[0].cell[1][0]']).toBe('乙');
    for (const value of Object.values(content.fields)) {
      expect(content.canonicalText.includes(value)).toBe(true);
    }
  });

  it('60k 预算：charCount ≤ MAX_PAGE_CAPTURE_CHARS 且 canonicalText 长度一致；超预算条目与后续全部丢弃', () => {
    const bigText = '长'.repeat(70_000);
    const snapshot = makeSnapshot({
      visibleText: bigText,
      tables: [makeSnapshot().tables![0]!, { headers: ['后表头'], rows: [['后单元格']] }],
    });
    const content = buildCaptureContent(snapshot, 'cap-1');
    expect(content.canonicalText.length).toBeLessThanOrEqual(MAX_PAGE_CAPTURE_CHARS);
    expect(content.canonicalText.length).toBe(MAX_PAGE_CAPTURE_CHARS);
    // 后续表格（未进入预算）零保留
    expect(content.tables).toHaveLength(0);
    // 未进入哈希的字段零保留（tables 路径字段全无）
    for (const key of Object.keys(content.fields)) {
      expect(key.startsWith('tables[')).toBe(false);
    }
    // 正文标记（超出预算部分）零出现
    expect(content.canonicalText).not.toContain('后表头');
  });

  it('60k 边界不拆 surrogate pair（canonicalText 不以 high surrogate 结尾）', () => {
    // 标签 '[text] ' 长 7；使预算边界恰落在 '𝄞' 的 high surrogate 后一位
    const prefix = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 2); // 59991
    const snapshot = makeSnapshot({ visibleText: prefix + '𝄞' + '尾' });
    const content = buildCaptureContent(snapshot, 'cap-1');
    expect(content.canonicalText.length).toBeLessThanOrEqual(MAX_PAGE_CAPTURE_CHARS);
    const last = content.canonicalText.charCodeAt(content.canonicalText.length - 1);
    const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;
    expect(isHighSurrogate).toBe(false);
  });

  it('预算耗尽后 textSections 每项都是 canonicalText 的连续子串（未哈希内容不进入 textSections）', () => {
    const bigText = '长'.repeat(70_000);
    const snapshot = makeSnapshot({
      visibleText: bigText,
      headings: [
        { level: 1, text: '预算内标题' },
        { level: 2, text: '预算外标题' },
      ],
      links: [
        { id: 'el-1', text: '预算内链接', href: 'https://example.com/in' },
        { id: 'el-2', text: '预算外链接', href: 'https://example.com/out' },
      ],
    });
    const content = buildCaptureContent(snapshot, 'cap-1');
    // 每个 textSection 必须是 canonicalText 的连续子串
    for (const section of content.textSections) {
      expect(content.canonicalText.includes(section)).toBe(true);
    }
    // 预算外 heading 不应出现在 textSections 中
    expect(content.textSections.some((s) => s.includes('预算外标题'))).toBe(false);
    // 预算外链接文本不应出现在 textSections 中
    expect(content.textSections.some((s) => s.includes('预算外链接'))).toBe(false);
    // canonicalText 长度 ≤ 预算
    expect(content.canonicalText.length).toBeLessThanOrEqual(MAX_PAGE_CAPTURE_CHARS);
  });

  it('heading 预算边界：预算在 heading 行内耗尽时该 heading 不进入 textSections、零 fragment、canonical 可小于 60k', () => {
    // 预算 = 60000；[text] 标签长 7；正文填至 59994，余 6 字节
    // [heading] 完整\n = 13 字节 > 6 → 原子拒绝：零 fragment（不再写 `[head` 残缺行）、
    // 不登记 section、不计数；canonical 停在 [text] 完整写入处 59994
    const prefix = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 6); // 59986
    const snapshot = makeSnapshot({
      visibleText: prefix,
      headings: [{ level: 1, text: '完整' }],
      tables: [],
      links: [],
    });
    const content = buildCaptureContent(snapshot, 'cap-1');
    // 完整 heading 文本不应出现在 textSections 中
    expect(content.textSections.some((s) => s.includes('完整'))).toBe(false);
    // 不存在空 section
    expect(content.textSections.some((s) => s === '')).toBe(false);
    // 原子拒绝零写入残缺 fragment：canonical 停在 [text] 完整行（59986+8=59994）
    expect(content.canonicalText).not.toContain('[heading]');
    expect(content.canonicalText.length).toBe(MAX_PAGE_CAPTURE_CHARS - 6);
  });

  it('link 预算边界：预算在 link 行内耗尽时该 link 不进入 textSections、零 fragment', () => {
    const prefix = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 6); // 59986
    const snapshot = makeSnapshot({
      visibleText: prefix,
      headings: [],
      tables: [],
      links: [{ id: 'el-1', text: '链接文本', href: 'https://example.com/link' }],
    });
    const content = buildCaptureContent(snapshot, 'cap-1');
    expect(content.textSections.some((s) => s.includes('链接文本'))).toBe(false);
    // 原子拒绝零写入残缺 fragment
    expect(content.canonicalText).not.toContain('[link]');
    expect(content.canonicalText.length).toBe(MAX_PAGE_CAPTURE_CHARS - 6);
  });

  it('link 标签子串碰撞防御：text="link" 且预算仅够标签前缀时，textSections 不得登记、零 fragment', () => {
    // 预算 = 60000；[text] 标签长 7；正文填至 59995，余 5 字节
    // [link] link url\n = 34 字节 > 5 → 原子拒绝：不写残缺 `[link`（旧 added.includes('link')
    // 会误匹配标签前缀）、零 fragment、零登记
    const prefix = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 5); // 59987
    const snapshot = makeSnapshot({
      visibleText: prefix,
      headings: [],
      tables: [],
      links: [{ id: 'el-1', text: 'link', href: 'https://example.com/x' }],
    });
    const content = buildCaptureContent(snapshot, 'cap-1');
    // link 文本 "link" 只是标签前缀的一部分，不是来源 payload，不得进入 textSections
    expect(content.textSections.some((s) => s === 'link')).toBe(false);
    expect(content.textSections.some((s) => s.includes('link'))).toBe(false);
    // 原子拒绝零写入残缺 fragment
    expect(content.canonicalText).not.toContain('[link]');
    expect(content.canonicalText.length).toBe(MAX_PAGE_CAPTURE_CHARS - 5);
  });

  it('field 部分写入原子性：field 行截断时该 field 不登记、零 fragment', () => {
    // 预算 = 60000；[text] 标签 7 字节；正文填至 59988，余 12 字节
    // 无 heading/table/link 干扰，field 行是下一个条目
    // [field] page.url=https://example.com/article\n = 45 字节 > 12 → 原子拒绝：
    // 零 fragment（不再写 `[field] page.` 残缺行）、零 fields entry；
    // canonical 停在 [text] 完整写入处（59980+8=59988）
    const prefix = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 12); // 59980
    const snapshot = makeSnapshot({
      visibleText: prefix,
      headings: [],
      tables: [],
      links: [],
    });
    const content = buildCaptureContent(snapshot, 'cap-1');
    // 原子拒绝 → 零写入残缺 fragment → fields 不登记
    expect('page.url' in content.fields).toBe(false);
    expect('page.title' in content.fields).toBe(false);
    // 原子拒绝零写入残缺 fragment：canonical 不含 [field] 标签
    expect(content.canonicalText).not.toContain('[field]');
    expect(content.canonicalText.length).toBe(MAX_PAGE_CAPTURE_CHARS - 12);
  });

  it('field 恰好装满：field 行完整写入时该 field 正确登记', () => {
    // 预算 = 60000；[text] 标签 7 字节；正文填至 59953，余 47 字节
    // [field] page.url=https://example.com/article\n = 47 字节 → 刚好放下
    // [field] page.title=文章标题\n = 23 字节 → 总和 70 > 47，放不下
    const prefix = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 47); // 59945
    const snapshot = makeSnapshot({
      visibleText: prefix,
      headings: [],
      tables: [],
      links: [],
    });
    const content = buildCaptureContent(snapshot, 'cap-1');
    expect('page.url' in content.fields).toBe(true);
    expect(content.fields['page.url']).toBe('https://example.com/article');
    // page.title 行写不下，不登记
    expect('page.title' in content.fields).toBe(false);
    expect(content.canonicalText.length).toBeLessThanOrEqual(MAX_PAGE_CAPTURE_CHARS);
  });

  it('heading 仅标签、部分 payload、完整 payload 缺换行的边界均不产生空或部分 section', () => {
    // 场景 A：仅标签（[heading] 开头 10 字节，无 payload）
    const prefix10 = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 0); // 59992
    const snapA = makeSnapshot({
      visibleText: prefix10,
      headings: [{ level: 1, text: '仅标签' }],
      tables: [],
      links: [],
    });
    const contentA = buildCaptureContent(snapA, 'cap-a');
    expect(contentA.textSections.some((s) => s === '')).toBe(false);
    expect(contentA.textSections.some((s) => s.includes('仅标签'))).toBe(false);

    // 场景 B：部分 payload ([heading] 标题\n = 13 字节，剩余 12 字节刚够标签+1 字符)
    const prefix11 = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 12); // 59980
    const snapB = makeSnapshot({
      visibleText: prefix11,
      headings: [{ level: 1, text: '标题' }],
      tables: [],
      links: [],
    });
    const contentB = buildCaptureContent(snapB, 'cap-b');
    // 截断为 `[heading] 标`（12 字节），非完整行 → 不进入 textSections
    expect(contentB.textSections.some((s) => s.includes('标题'))).toBe(false);
    expect(contentB.textSections.some((s) => s === '')).toBe(false);

    // 场景 C：完整 payload 恰写满 ([heading] 标题\n = 13 字节)
    const prefix12 = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 13); // 59979
    const snapC = makeSnapshot({
      visibleText: prefix12,
      headings: [{ level: 1, text: '标题' }],
      tables: [],
      links: [],
    });
    const contentC = buildCaptureContent(snapC, 'cap-c');
    expect(contentC.textSections.some((s) => s === '标题')).toBe(true);
    expect(contentC.textSections.some((s) => s === '')).toBe(false);
  });

  it('table 原子保留：装不下整表时整个丢弃，不多不少一字符时整表保留', () => {
    // 场景 A：装不下（差 1 字节）
    const table = makeSnapshot().tables![0]!;
    const tableSection = normalizeCaptureText(
      `${table.headers.join('|')} | ${table.rows.map((r) => r.join('|')).join(' | ')}`,
    );
    const tableLine = `[table] ${tableSection}\n`; // 长度动态计算（真实 serialized，禁止硬编码漂移）
    const prefixTooBig = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - (tableLine.length - 1)); // 差 1 字节装不下
    const snapA = makeSnapshot({
      visibleText: prefixTooBig,
      tables: [table],
      headings: [],
      links: [],
    });
    const contentA = buildCaptureContent(snapA, 'cap-a');
    expect(contentA.tables).toHaveLength(0);

    // 场景 B：恰好装满
    const prefixJust = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - tableLine.length); // 59968
    const snapB = makeSnapshot({
      visibleText: prefixJust,
      tables: [table],
      headings: [],
      links: [],
    });
    const contentB = buildCaptureContent(snapB, 'cap-b');
    expect(contentB.tables).toHaveLength(1);
    expect(contentB.tables[0]!.headers).toEqual(table.headers);
  });

  it('field 在标签/key/=/value/换行各位置截断的精确矩阵（基于真实 serialized 长度 45）', () => {
    // [field] page.url=https://example.com/article\n = 45 字节
    // 截断位置：5（标签中）、8（标签完无 key）、12（key 中）、16（key 完无 =）、
    // 17（= 完无 value）、18（value 中）、44（value 完无 newline）→ 全不登记
    for (const remaining of [5, 8, 12, 16, 17, 18, 44]) {
      const prefix = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - remaining);
      const snap = makeSnapshot({
        visibleText: prefix,
        headings: [],
        tables: [],
        links: [],
      });
      const content = buildCaptureContent(snap, 'cap-r' + String(remaining));
      expect('page.url' in content.fields).toBe(false);
      expect('page.title' in content.fields).toBe(false);
    }
    // 精确容纳（remaining = 45）→ 登记 page.url；page.title 行（24 字节）放不下
    const prefix45 = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 45);
    const snap45 = makeSnapshot({
      visibleText: prefix45,
      headings: [],
      tables: [],
      links: [],
    });
    const content45 = buildCaptureContent(snap45, 'cap-r45');
    expect('page.url' in content45.fields).toBe(true);
    expect(content45.fields['page.url']).toBe('https://example.com/article');
    expect('page.title' in content45.fields).toBe(false);
  });

  it('所有条目类型在预算边界上的综合验证：textSections/tables/fields 全部在 canonicalText 哈希内', () => {
    // 预算 = 60000；[text] 7 字节；正文填至 59990，余 10 字节
    const prefix = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 10); // 59982
    const snapshot = makeSnapshot({
      visibleText: prefix,
      headings: [
        { level: 1, text: '标题' }, // [heading] 标题\n = 13 > 10 → 部分写入，不计数
      ],
      tables: [],
      links: [],
    });
    const content = buildCaptureContent(snapshot, 'cap-1');
    // 所有 textSections 都是 canonicalText 连续子串
    for (const section of content.textSections) {
      expect(content.canonicalText.includes(section)).toBe(true);
    }
    // 所有 tables 的值都在 canonicalText 中
    for (const table of content.tables) {
      for (const h of table.headers) {
        expect(content.canonicalText.includes(h)).toBe(true);
      }
      for (const row of table.rows) {
        for (const cell of row) {
          expect(content.canonicalText.includes(cell)).toBe(true);
        }
      }
    }
    // 所有 fields 的值都在 canonicalText 中
    for (const value of Object.values(content.fields)) {
      expect(content.canonicalText.includes(value)).toBe(true);
    }
    expect(content.canonicalText.length).toBeLessThanOrEqual(MAX_PAGE_CAPTURE_CHARS);
  });

  it('contentHash 确定性：同输入同输出；输入不同哈希不同', () => {
    const a = buildCaptureContent(makeSnapshot(), 'cap-a');
    const b = buildCaptureContent(makeSnapshot(), 'cap-b');
    expect(sha256hex(a.canonicalText)).toBe(sha256hex(b.canonicalText));
    const c = buildCaptureContent(makeSnapshot({ title: '另一标题' }), 'cap-c');
    expect(sha256hex(c.canonicalText)).not.toBe(sha256hex(a.canonicalText));
  });

  it('CAPTURE_EMPTY_CONTENT_HASH = SHA-256(UTF-8 空串) 前 32 小写 hex（编译期常量）', () => {
    expect(CAPTURE_EMPTY_CONTENT_HASH).toBe(sha256hex(''));
    expect(CAPTURE_EMPTY_CONTENT_HASH).toMatch(/^[0-9a-f]{32}$/);
  });

  it('summary 语义（决议 #128）：tableCount = 表格数量（非单元格）；headingCount 从真实接纳记录产生；charCount = canonicalText.length', () => {
    const content = buildCaptureContent(makeSnapshot(), 'cap-1');
    expect(content.textSections.length).toBe(1 + 2 + 1 + 2);
    expect(content.tables.length).toBe(1); // 1 个表格，不是 6 个单元格
    expect(content.canonicalText.length).toBeGreaterThan(0);
    // summary 由内部 build result 一次性构造（不手工传入 headingCount 数字、
    // 不调用独立 summary helper）——见 C4 Replan「summary 来源真实 service build facts」
    // describe 中的真实 CaptureService.read() 断言。buildCaptureContent 返回精确五字段，
    // 不携带 headingCount。
    expect('headingCount' in content).toBe(false);
  });
});

// ---------- 统一 admission 不变量（第三轮修复红态 oracle） ----------
//
// 不变量：任何暴露给 EvidenceValidator 或 summary 的结构化值，只有在代表它的
// 完整 serialization unit 已经被预算完整接纳时，才能登记。
// visibleText 例外：契约允许部分截断，但暴露值必须与实际已经进入 canonicalText
// 的 payload 精确一致（不因缺换行而删除真实 payload 字符、surrogate-safe）。

describe('统一 admission 不变量：visibleText 截断暴露值与 canonicalText 精确一致', () => {
  it('V1 截断缺换行时暴露值保留全部已进入 hash 的 payload（不删真实字符）', () => {
    // visible = 'x'*59992 + 'Z' (59993 chars)；line = '[text] ' + visible + '\n' = 60001 > 60000
    // 截断为 '[text] ' + visible (60000, 无 \n)；旧 slice(7,-1) 删除 'Z' → 暴露值缺末字符
    const visible = 'x'.repeat(59992) + 'Z';
    const snapshot = makeSnapshot({ visibleText: visible, headings: [], tables: [], links: [] });
    const content = buildCaptureContent(snapshot, 'cap-v1');
    expect(content.canonicalText).toBe('[text] ' + visible);
    expect(content.canonicalText.length).toBe(MAX_PAGE_CAPTURE_CHARS);
    expect(content.textSections).toHaveLength(1);
    // 暴露值 = 实际进入 canonicalText 的 payload（含末尾 'Z'）
    expect(content.textSections[0]).toBe(visible);
    // 暴露值必须是 canonicalText 的连续子串
    expect(content.canonicalText.includes(content.textSections[0]!)).toBe(true);
  });

  it('V2 精确容纳（含换行）时暴露值 = 完整 visible payload', () => {
    // visible = 'x'*59992 (59992 chars)；line = 7 + 59992 + 1 = 60000 = exact fit
    const visible = 'x'.repeat(59992);
    const snapshot = makeSnapshot({ visibleText: visible, headings: [], tables: [], links: [] });
    const content = buildCaptureContent(snapshot, 'cap-v2');
    expect(content.canonicalText).toBe('[text] ' + visible + '\n');
    expect(content.canonicalText.length).toBe(MAX_PAGE_CAPTURE_CHARS);
    expect(content.textSections).toHaveLength(1);
    expect(content.textSections[0]).toBe(visible);
  });

  it('V3 截断落在完整 surrogate pair 之后时暴露值不拆 pair（不以 unpaired high 结尾）', () => {
    // visible = 'x'*59991 + '𝄞' (59991 + 2 = 59993 chars)；line = 60001 > 60000
    // 截断为 '[text] ' + visible (60000, 末尾是完整 surrogate pair d834/dd1e, 无 \n)
    // 旧 slice(7,-1) 删除 low surrogate dd1e → 暴露值以 unpaired high d834 结尾
    const visible = 'x'.repeat(59991) + '𝄞';
    const snapshot = makeSnapshot({ visibleText: visible, headings: [], tables: [], links: [] });
    const content = buildCaptureContent(snapshot, 'cap-v3');
    expect(content.canonicalText).toBe('[text] ' + visible);
    expect(content.canonicalText.length).toBe(MAX_PAGE_CAPTURE_CHARS);
    expect(content.textSections).toHaveLength(1);
    expect(content.textSections[0]).toBe(visible);
    // 暴露值末尾不是 unpaired high surrogate
    const last = content.textSections[0]!.charCodeAt(content.textSections[0]!.length - 1);
    const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;
    expect(isHighSurrogate).toBe(false);
  });

  it('V4 截断落在 surrogate pair 中间时回退，暴露值 = 实际保留的 payload', () => {
    // visible = 'x'*59992 + '𝄞' (59994 chars)；line = 60002 > 60000
    // charAt(59999) = high surrogate d834 → 回退 1 → 截断为 '[text] ' + 'x'*59992 (59999 chars)
    // surrogate pair 整体排除（不拆分）；暴露值 = 'x'*59992
    const visible = 'x'.repeat(59992) + '𝄞';
    const snapshot = makeSnapshot({ visibleText: visible, headings: [], tables: [], links: [] });
    const content = buildCaptureContent(snapshot, 'cap-v4');
    expect(content.canonicalText).toBe('[text] ' + 'x'.repeat(59992));
    expect(content.canonicalText.length).toBe(59999);
    // canonicalText 不含 surrogate pair
    expect(content.canonicalText.includes('𝄞')).toBe(false);
    expect(content.textSections).toHaveLength(1);
    expect(content.textSections[0]).toBe('x'.repeat(59992));
  });
});

describe('统一 admission 不变量：heading 精确预算矩阵', () => {
  // [heading] Foo\n = 14 字节；[text] 前缀 7 字节 + \n 后缀 1 字节
  // 各 remaining 值对应截断位置
  it('H2 仅标签（remaining=9）：不登记、无空 section', () => {
    const prefix = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 9); // 59983
    const snapshot = makeSnapshot({
      visibleText: prefix,
      headings: [{ level: 1, text: 'Foo' }],
      tables: [],
      links: [],
    });
    const content = buildCaptureContent(snapshot, 'cap-h2');
    expect(content.textSections.some((s) => s.includes('Foo'))).toBe(false);
    expect(content.textSections.some((s) => s === '')).toBe(false);
  });

  it('H3 标签 + 部分 payload（remaining=12）：不登记', () => {
    const prefix = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 12); // 59980
    const snapshot = makeSnapshot({
      visibleText: prefix,
      headings: [{ level: 1, text: 'Foo' }],
      tables: [],
      links: [],
    });
    const content = buildCaptureContent(snapshot, 'cap-h3');
    expect(content.textSections.some((s) => s.includes('Foo'))).toBe(false);
    expect(content.textSections.some((s) => s === '')).toBe(false);
  });

  it('H4 标签 + 完整 payload 缺换行（remaining=13）：不登记', () => {
    const prefix = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 13); // 59979
    const snapshot = makeSnapshot({
      visibleText: prefix,
      headings: [{ level: 1, text: 'Foo' }],
      tables: [],
      links: [],
    });
    const content = buildCaptureContent(snapshot, 'cap-h4');
    expect(content.textSections.some((s) => s === 'Foo')).toBe(false);
    expect(content.textSections.some((s) => s === '')).toBe(false);
  });

  it('H5 精确容纳（remaining=14, 含换行）：登记 text', () => {
    const prefix = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 14); // 59978
    const snapshot = makeSnapshot({
      visibleText: prefix,
      headings: [{ level: 1, text: 'Foo' }],
      tables: [],
      links: [],
    });
    const content = buildCaptureContent(snapshot, 'cap-h5');
    expect(content.textSections).toContain('Foo');
  });

  it('H6 重复 heading：两个相同 text 均完整接纳 → headingCount=2（经 CaptureService 真实路径）', async () => {
    const h = makeHarness({
      browser: {
        snapshotFor: () =>
          makeSnapshot({
            visibleText: '',
            headings: [
              { level: 1, text: 'Foo' },
              { level: 1, text: 'Foo' },
            ],
            tables: [],
            links: [],
          }),
      },
    });
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.textSections).toEqual(['Foo', 'Foo']);
    expect(result.capture.summary.headingCount).toBe(2);
  });
});

describe('统一 admission 不变量：link 原子接纳', () => {
  // [link] link https://example.com/x\n = 7 + 4 + 1 + 21 + 1 = 34 字节
  it('L1 link 行 URL 截断时不登记 text（原子接纳，不用 includes 子串匹配）', () => {
    // remaining = 30 < 34 → 截断为 '[link] link https://example.'
    // 旧 added.includes('[link] link') = true → 误登记
    // 修复 added === line = false → 不登记
    const prefix = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 30); // 59962
    const snapshot = makeSnapshot({
      visibleText: prefix,
      headings: [],
      tables: [],
      links: [{ id: 'el-1', text: 'link', href: 'https://example.com/x' }],
    });
    const content = buildCaptureContent(snapshot, 'cap-l1');
    expect(content.textSections.some((s) => s === 'link')).toBe(false);
  });

  it('L2 link 行精确容纳时登记 text', () => {
    // remaining = 34 = exact fit（[link] link https://example.com/x\n = 34 字节）
    const prefix = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 34); // 59958
    const snapshot = makeSnapshot({
      visibleText: prefix,
      headings: [],
      tables: [],
      links: [{ id: 'el-1', text: 'link', href: 'https://example.com/x' }],
    });
    const content = buildCaptureContent(snapshot, 'cap-l2');
    expect(content.textSections).toContain('link');
  });
});

describe('统一 admission 不变量：headingCount 从真实接纳记录产生（不经子串扫描）', () => {
  it('S1 visibleText 含 [heading] Foo 字面但 heading 行未进入预算 → headingCount=0（经 CaptureService 真实路径）', async () => {
    // visible = 'x'*59980 + '[heading] Foo' (59993 chars)
    // line = '[text] ' + visible + '\n' = 60001 > 60000 → 截断为 '[text] ' + visible (60000, 无 \n)
    // heading 行 [heading] Foo\n (14) 因 exhausted 不进入 canonicalText
    // 但 canonicalText 中 visible 部分含 '[heading] Foo' 字面 → 旧 includes 误判 headingCount=1
    // 修复后 headingCount=0（从真实接纳记录产生）
    const visible = 'x'.repeat(59980) + '[heading] Foo';
    const h = makeHarness({
      browser: {
        snapshotFor: () =>
          makeSnapshot({
            visibleText: visible,
            headings: [{ level: 1, text: 'Foo' }],
            tables: [],
            links: [],
          }),
      },
    });
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // heading 行未进入 canonicalText
    expect(result.content.canonicalText).not.toContain('[heading] Foo\n');
    // headingCount 从真实接纳记录产生 = 0
    expect(result.capture.summary.headingCount).toBe(0);
    // textSections 也不含 'Foo'
    expect(result.content.textSections.some((s) => s === 'Foo')).toBe(false);
  });

  it('S2 正常场景 headingCount 从真实接纳记录产生（经 CaptureService 真实路径，不手工传入数字）', async () => {
    const h = makeHarness();
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // makeSnapshot 有 2 个 heading（主标题、小节），均进入预算
    expect(result.capture.summary.headingCount).toBe(2);
    expect(result.content.textSections).toContain('主标题');
    expect(result.content.textSections).toContain('小节');
  });

  it('S3 部分 heading 进入预算时 headingCount 只反映完整接纳的 heading 数（经 CaptureService 真实路径）', async () => {
    // 预算只够第一个 heading（[heading] Foo\n = 14），第二个 heading 行因 exhausted 不进入
    const prefix = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 14); // 59978
    const h = makeHarness({
      browser: {
        snapshotFor: () =>
          makeSnapshot({
            visibleText: prefix,
            headings: [
              { level: 1, text: 'Foo' }, // [heading] Foo\n = 14, exact fit → 接纳
              { level: 2, text: 'Bar' }, // exhausted → 不接纳
            ],
            tables: [],
            links: [],
          }),
      },
    });
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capture.summary.headingCount).toBe(1);
    expect(result.content.textSections).toContain('Foo');
    expect(result.content.textSections.some((s) => s === 'Bar')).toBe(false);
  });
});

// ---------- C4 Replan 红态 oracle（统一 admission 模型） ----------
//
// 这些测试在 baseline 56ea5c 上必须真实失败：区分旧「通用 append + slice/includes
// 分散判断」结构与新「闭合 AdmissionResult 驱动 canonical 写入/projection/stats」模型。
// 全部走真实 CaptureService.read()（summary/public shape 不许直接调用 helper、不传期望数）。

describe('C4 Replan：运行时 public shape 精确五字段', () => {
  it('R-PUBLIC Object.keys/spread/JSON 均精确五字段，无 headingCount/stats 泄漏', async () => {
    const h = makeHarness();
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = result.content;
    const five = ['captureId', 'canonicalText', 'textSections', 'tables', 'fields'];
    expect(Object.keys(content)).toEqual(five);
    expect(Object.keys({ ...content })).toEqual(five);
    expect(Object.keys(JSON.parse(JSON.stringify(content)))).toEqual(five);
    expect('headingCount' in content).toBe(false);
    expect('stats' in content).toBe(false);
    const json = JSON.stringify(content);
    expect(json).not.toContain('headingCount');
    expect(json).not.toContain('stats');
  });
});

describe('C4 Replan：空/纯空白结构 eligibility（真实 normalize 路径）', () => {
  function normalizedWithTables(
    tables: unknown[],
    extra: Record<string, unknown> = {},
  ): PageSnapshot {
    return normalizeSnapshot(
      {
        ok: true,
        url: 'https://example.com/article',
        title: '文章标题',
        visibleText: '',
        headings: [],
        links: [],
        buttons: [],
        tables,
        ...extra,
      },
      { url: 'https://example.com/article', title: '文章标题', documentId: 7 },
    );
  }

  it("R-EMPTY-TABLE 空白单表头 headers:['  '], rows:[] → 全零投影、无空 section", async () => {
    const h = makeHarness({
      browser: { snapshotFor: () => normalizedWithTables([{ headers: ['  '], rows: [] }]) },
    });
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.textSections).toEqual([]);
    expect(result.content.tables).toEqual([]);
    expect(result.capture.summary.sectionCount).toBe(0);
    expect(result.capture.summary.tableCount).toBe(0);
    expect(result.content.canonicalText).not.toContain('[table]');
    expect(result.content.textSections.some((s) => s === '')).toBe(false);
    for (const key of Object.keys(result.content.fields)) {
      expect(key.startsWith('tables[')).toBe(false);
    }
  });

  it('R-TABLE-INDEX 空表被跳过 → 有效表为 tables[0]，字段路径紧凑无空洞', async () => {
    const h = makeHarness({
      browser: {
        snapshotFor: () =>
          normalizedWithTables([
            { headers: ['  '], rows: [] },
            { headers: ['A', 'B'], rows: [['1', '2']] },
          ]),
      },
    });
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.tables).toHaveLength(1);
    expect(result.content.tables[0]!.headers).toEqual(['A', 'B']);
    expect(result.content.fields['tables[0].cell[0][0]']).toBe('1');
    expect('tables[1]' in result.content.fields).toBe(false);
  });

  it('R-EMPTY-CELL 有意义表格中空 row/cell：几何保留、空 cell 不上 fields', async () => {
    const h = makeHarness({
      browser: {
        snapshotFor: () =>
          normalizedWithTables([
            {
              headers: ['A', 'B'],
              rows: [
                ['x', ''],
                ['', 'y'],
              ],
            },
          ]),
      },
    });
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.tables).toHaveLength(1);
    expect(result.content.tables[0]!.rows).toEqual([
      ['x', ''],
      ['', 'y'],
    ]);
    expect(result.content.fields['tables[0].cell[0][0]']).toBe('x');
    expect('tables[0].cell[0][1]' in result.content.fields).toBe(false);
    expect('tables[0].cell[1][0]' in result.content.fields).toBe(false);
    expect(result.content.fields['tables[0].cell[1][1]']).toBe('y');
  });
});

describe('C4 Replan：原子拒绝零 canonical fragment（不足则零写入并停止后续）', () => {
  it('R-ATOMIC-HEADING heading one-short → 零 fragment、canonical 可小于 60k、停止后续', async () => {
    const prefix = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 6); // remaining=6
    const h = makeHarness({
      browser: {
        snapshotFor: () =>
          makeSnapshot({
            visibleText: prefix,
            headings: [{ level: 1, text: '完整' }],
            tables: [],
            links: [],
          }),
      },
    });
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.canonicalText).toContain('[text]');
    expect(result.content.canonicalText).not.toContain('[heading]');
    expect(result.content.canonicalText.length).toBeLessThan(MAX_PAGE_CAPTURE_CHARS);
    expect(result.content.textSections.some((s) => s.includes('完整'))).toBe(false);
    expect(result.capture.summary.headingCount).toBe(0);
    expect(result.content.canonicalText).not.toContain('[field]'); // 后续 unit 全停
  });

  it('R-ATOMIC-LINK link 行 one-short → 零 fragment、零 projection', async () => {
    const prefix = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 30); // remaining=30, link line=34
    const h = makeHarness({
      browser: {
        snapshotFor: () =>
          makeSnapshot({
            visibleText: prefix,
            headings: [],
            tables: [],
            links: [{ id: 'el-1', text: 'link', href: 'https://example.com/x' }],
          }),
      },
    });
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.canonicalText).not.toContain('[link]');
    expect(result.content.canonicalText.length).toBeLessThan(MAX_PAGE_CAPTURE_CHARS);
    expect(result.content.textSections.some((s) => s === 'link')).toBe(false);
  });

  it('R-ATOMIC-FIELD field 行 one-short → 零 fragment、零 fields entry', async () => {
    const prefix = 'x'.repeat(MAX_PAGE_CAPTURE_CHARS - 7 - 1 - 44); // remaining=44, field line=45
    const h = makeHarness({
      browser: {
        snapshotFor: () =>
          makeSnapshot({
            visibleText: prefix,
            headings: [],
            tables: [],
            links: [],
          }),
      },
    });
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.canonicalText).not.toContain('[field]');
    expect(result.content.canonicalText.length).toBeLessThan(MAX_PAGE_CAPTURE_CHARS);
    expect('page.url' in result.content.fields).toBe(false);
    expect('page.title' in result.content.fields).toBe(false);
  });
});

describe('C4 Replan：summary 来源真实 service build facts', () => {
  it('R-SUMMARY 正常路径 section/table/heading/char 全部来自真实 content', async () => {
    const h = makeHarness();
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capture.summary.sectionCount).toBe(result.content.textSections.length);
    expect(result.capture.summary.tableCount).toBe(result.content.tables.length);
    expect(result.capture.summary.charCount).toBe(result.content.canonicalText.length);
    // headingCount 只能来自内部接纳记录（makeSnapshot 2 个 heading 完整接纳）
    expect(result.capture.summary.headingCount).toBe(2);
  });

  it('R-SUMMARY-EMPTY 全空快照 → summary 全零、零空 section', async () => {
    const h = makeHarness({
      browser: {
        snapshotFor: () =>
          makeSnapshot({
            visibleText: '',
            headings: [],
            links: [],
            tables: [],
            title: '',
          }),
      },
    });
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.textSections).toEqual([]);
    expect(result.content.tables).toEqual([]);
    expect(result.capture.summary.sectionCount).toBe(0);
    expect(result.capture.summary.tableCount).toBe(0);
    expect(result.capture.summary.headingCount).toBe(0);
  });
});

describe('C4 Replan：contentHash 只对最终 canonicalText 计算', () => {
  it('R-HASH 混合结构 contentHash === sha256hex(canonicalText)', async () => {
    const h = makeHarness();
    withReadyTab(h);
    const result = await h.read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capture.contentHash).toBe(sha256hex(result.content.canonicalText));
  });
});
