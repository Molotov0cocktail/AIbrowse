// A4 SearchProvider 测试（红→绿先写）：解析纯函数矩阵 + Bing 页面实现的生命周期与
// 临时 Tab 所有权语义。契约源：doc/stage3/detailed-design.md §6 + 任务文档 A4。
// 关键安全断言：
//  1. 临时搜索 Tab 以本次调用精确 tabId 独占（不得按位置/标题/URL/活动 Tab 推断所有权）；
//  2. 只关闭本调用成功创建的 tabId；用户/其他流程已关闭 → finally 安全无操作，绝不关闭替代 Tab；
//  3. 创建/等待/快照/解析/取消/超时/异常任何路径经 try/finally 最佳努力清理（不泄漏 Tab/定时器/监听器）；
//  4. 用户仍停留在临时搜索 Tab → 恢复调用前仍存在的活动 Tab；用户已切换 → 不抢回焦点；
//     调用前活动 Tab 已被关闭 → 不重建不激活（沿用 closeTab 正常活动 Tab 策略）；
//  5. 并发调用各自清理自己的 Tab（无进程级「当前搜索 Tab」共享状态）；
//  6. 错误诚实映射：L3/L2/结构无法识别/超时/导航失败/Tab 关闭 → ok:false search-failed
//     （不伪装成功空结果）；合法空结果 → ok:true 空数组 + 明确提示；aborted 由外层归一。
// 测试完全离线：fakeBrowser 状态机 + 注入时钟/睡眠（确定性，无真实计时器依赖）。
import { describe, expect, it } from 'vitest';
import type { BrowserController } from '../../browser/browser-controller';
import type { PageSnapshot, TabInfo } from '../../../shared/types/browser';
import {
  BingSearchProvider,
  buildSearchUrl,
  parseBingSearchResults,
  unwrapBingWrapper,
  SEARCH_QUERY_MAX_LENGTH,
} from './search-provider';

// ---------- 测试夹具 ----------

function makeSnapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://www.bing.com/search?q=x',
    title: 'x - 搜索',
    headings: [],
    links: [],
    buttons: [],
    visibleText: '页面文本。',
    meta: { documentId: 2, capturedAt: 1, readyState: 'complete', degraded: 'none', warnings: [] },
    ...overrides,
  };
}

// 构造 Bing ck/a 包装链接（u=a1 + base64url 编码的真实目标——与实际形态同构）
function wrapUrl(target: string): string {
  return `https://www.bing.com/ck/a?!&&p=x&u=a1${Buffer.from(target, 'utf8').toString('base64url')}`;
}

// 受控结果快照：有机结果 + 包装链接 + 去重重项 + 各类应被过滤的链接
function resultsSnapshot(): PageSnapshot {
  return makeSnapshot({
    links: [
      { id: 'el-0', text: '结果一', href: 'https://example.com/one' },
      { id: 'el-1', text: '结果二', href: 'https://example.com/two' },
      { id: 'el-2', text: '重复项', href: 'https://example.com/one' },
      { id: 'el-3', text: '设置', href: 'https://www.bing.com/account/general' },
      { id: 'el-4', text: '包装结果', href: wrapUrl('https://example.com/wrapped') },
      { id: 'el-5', text: '坏包装', href: 'https://www.bing.com/ck/a?u=a1!!!invalid' },
      { id: 'el-6', text: '危险链接', href: 'javascript:alert(1)' },
      { id: 'el-7', text: 'FTP 链接', href: 'ftp://files.example.com/x' },
      { id: 'el-8', text: '', href: 'https://example.com/empty-title' },
      { id: 'el-9', text: '隐私声明', href: 'https://go.microsoft.com/fwlink/?linkid=123' },
      { id: 'el-10', text: '广告技术原理', href: 'https://example.com/ads' },
    ],
    visibleText: '结果一\n这是一段摘要文本，扁平快照下不应被错误关联给任何结果。\n结果二\n……',
  });
}

// ---------- 解析纯函数矩阵 ----------

describe('parseBingSearchResults 解析矩阵', () => {
  it('正常结果：标题/URL 组装、确定性去重保持首次出现顺序、source 恒为 bing', () => {
    const { results, hasContent } = parseBingSearchResults(resultsSnapshot());
    expect(hasContent).toBe(true);
    expect(results.map((r) => r.title)).toEqual(['结果一', '结果二', '包装结果', '广告技术原理']);
    expect(results.map((r) => r.url)).toEqual([
      'https://example.com/one',
      'https://example.com/two',
      'https://example.com/wrapped',
      'https://example.com/ads',
    ]);
    for (const r of results) expect(r.source).toBe('bing');
  });

  it('非 http/https（javascript:/ftp:/mailto:）全部丢弃并计数警告，不抛异常', () => {
    const snap = makeSnapshot({
      links: [
        { id: 'el-0', text: '好', href: 'https://example.com/ok' },
        { id: 'el-1', text: '坏', href: 'javascript:alert(1)' },
        { id: 'el-2', text: '坏', href: 'ftp://files.example.com/x' },
        { id: 'el-3', text: '坏', href: 'mailto:a@example.com' },
        { id: 'el-4', text: '好', href: 'HTTP://example.com/case' },
      ],
    });
    const { results, warnings } = parseBingSearchResults(snap);
    expect(results.map((r) => r.url)).toEqual([
      'https://example.com/ok',
      'HTTP://example.com/case',
    ]);
    expect(warnings.some((w) => w.includes('非 http/https'))).toBe(true);
  });

  it('畸形 URL（无法解析）安全丢弃，不抛异常', () => {
    const snap = makeSnapshot({
      links: [
        { id: 'el-0', text: '好', href: 'https://example.com/ok' },
        { id: 'el-1', text: '坏', href: 'ht!tp://bad url' },
        { id: 'el-2', text: '坏', href: 'not a url at all' },
        { id: 'el-3', text: '坏', href: 'https://exa mple.com/space' },
      ],
    });
    const { results, warnings } = parseBingSearchResults(snap);
    expect(results.map((r) => r.url)).toEqual(['https://example.com/ok']);
    expect(warnings.some((w) => w.includes('无效链接'))).toBe(true);
  });

  it('Bing 自身链接过滤：bing.com 子域全部丢弃；形似域名（bing.com.evil.com）不误伤', () => {
    const snap = makeSnapshot({
      links: [
        { id: 'el-0', text: '好', href: 'https://example.com/ok' },
        { id: 'el-1', text: '自身', href: 'https://www.bing.com/search?q=again' },
        { id: 'el-2', text: '自身', href: 'https://cn.bing.com/account/general' },
        { id: 'el-3', text: '自身', href: 'https://bing.com/images' },
        { id: 'el-4', text: '伪装', href: 'https://www.bing.com.evil.com/x' },
        { id: 'el-5', text: '好', href: 'https://example.com/other' },
      ],
    });
    const { results, warnings } = parseBingSearchResults(snap);
    expect(results.map((r) => r.url)).toEqual([
      'https://example.com/ok',
      'https://www.bing.com.evil.com/x',
      'https://example.com/other',
    ]);
    expect(warnings.some((w) => w.includes('非结果链接'))).toBe(true);
  });

  it('明确非结果导航标签（设置/登录/隐私/广告控制等，中英双语）确定性丢弃', () => {
    const snap = makeSnapshot({
      links: [
        { id: 'el-0', text: '好', href: 'https://example.com/ok' },
        { id: 'el-1', text: '设置', href: 'https://go.microsoft.com/fwlink/?linkid=1' },
        { id: 'el-2', text: 'Sign in', href: 'https://go.microsoft.com/fwlink/?linkid=2' },
        { id: 'el-3', text: '隐私声明', href: 'https://go.microsoft.com/fwlink/?linkid=3' },
        { id: 'el-4', text: 'Advertise', href: 'https://go.microsoft.com/fwlink/?linkid=4' },
        { id: 'el-5', text: '广告技术原理', href: 'https://example.com/ads-tech' },
      ],
    });
    const { results } = parseBingSearchResults(snap);
    expect(results.map((r) => r.url)).toEqual([
      'https://example.com/ok',
      'https://example.com/ads-tech',
    ]);
  });

  it('ck/a 包装链接：base64url 确定性还原 http/https 目标；非法编码/非 http 目标丢弃', () => {
    const snap = makeSnapshot({
      links: [
        { id: 'el-0', text: '包装', href: wrapUrl('https://example.com/wrapped-target') },
        { id: 'el-1', text: '坏编码', href: 'https://www.bing.com/ck/a?u=a1%00%00garbage' },
        { id: 'el-2', text: '非http', href: wrapUrl('javascript:alert(1)') },
        { id: 'el-3', text: '缺u参数', href: 'https://www.bing.com/ck/a?foo=bar' },
      ],
    });
    const { results, warnings } = parseBingSearchResults(snap);
    expect(results.map((r) => r.url)).toEqual(['https://example.com/wrapped-target']);
    expect(warnings.some((w) => w.includes('非结果链接'))).toBe(true);
  });

  it('最多 10 条：过滤与去重后按首次出现顺序取前 10', () => {
    const links = Array.from({ length: 14 }, (_, i) => ({
      id: `el-${i}`,
      text: `结果 ${i + 1}`,
      href: `https://example.com/r${i + 1}`,
    }));
    const { results } = parseBingSearchResults(makeSnapshot({ links }));
    expect(results).toHaveLength(10);
    expect(results[0].title).toBe('结果 1');
    expect(results[9].title).toBe('结果 10');
  });

  it('title 超 200 字符确定性截断为 200；snippet 恒空串（扁平快照无可靠关联证据）', () => {
    const longTitle = '字'.repeat(250);
    const snap = makeSnapshot({
      links: [{ id: 'el-0', text: longTitle, href: 'https://example.com/long' }],
    });
    const { results, warnings } = parseBingSearchResults(snap);
    expect(results).toHaveLength(1);
    expect(results[0].title).toHaveLength(200);
    expect(results[0].snippet).toBe('');
    expect(warnings.some((w) => w.includes('摘要留空'))).toBe(true);
  });

  it('空 links/无 visibleText：空结果 + hasContent=false（结构无法识别）；不抛异常', () => {
    // 解析层对空结构保持沉默（无丢弃可报告）；「结构无法识别」的 search-failed
    // 判定与中文警告由 Provider 层组合（见生命周期矩阵用例）
    const { results, hasContent, warnings } = parseBingSearchResults(
      makeSnapshot({ links: [], visibleText: undefined }),
    );
    expect(results).toEqual([]);
    expect(hasContent).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('只有自身链接但页面有内容：空结果 + hasContent=true（合法空结果可识别）', () => {
    const { results, hasContent, warnings } = parseBingSearchResults(
      makeSnapshot({
        links: [{ id: 'el-0', text: '设置', href: 'https://www.bing.com/account/general' }],
        visibleText: '没有与此相关的结果。',
      }),
    );
    expect(results).toEqual([]);
    expect(hasContent).toBe(true);
    expect(warnings.some((w) => w.includes('未识别到搜索结果条目'))).toBe(true);
  });

  it('null 快照（L3）：空结果 + hasContent=false，不抛异常', () => {
    const { results, hasContent } = parseBingSearchResults(null);
    expect(results).toEqual([]);
    expect(hasContent).toBe(false);
  });

  it('结构退化（links 缺失/非数组等畸形输入）：安全降级空结果不抛异常', () => {
    const { results } = parseBingSearchResults(
      makeSnapshot({ links: undefined as unknown as PageSnapshot['links'] }),
    );
    expect(results).toEqual([]);
  });
});

describe('unwrapBingWrapper / buildSearchUrl 纯函数', () => {
  it('u=a1 base64url 还原 http/https 目标；非 ck/a 路径与非法形态返回 null', () => {
    expect(unwrapBingWrapper(wrapUrl('https://example.com/target'))).toBe(
      'https://example.com/target',
    );
    expect(unwrapBingWrapper('https://www.bing.com/ck/a?u=a1!!!invalid')).toBe(null);
    expect(unwrapBingWrapper(wrapUrl('javascript:alert(1)'))).toBe(null);
    expect(unwrapBingWrapper('https://www.bing.com/search?q=x')).toBe(null);
    expect(unwrapBingWrapper('https://www.bing.com/ck/a?foo=bar')).toBe(null);
  });

  it('buildSearchUrl 由 base + 安全 URL 编码构造（特殊字符/中文/引号全部编码，无代码拼接）', () => {
    const base = 'https://www.bing.com/search';
    const query = 'a&b=c d?e#f "quoted" 中文';
    expect(buildSearchUrl(query, base)).toBe(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    );
    expect(buildSearchUrl('plain', base)).toBe('https://www.bing.com/search?q=plain');
  });

  it('SEARCH_QUERY_MAX_LENGTH 为 500（与注册表字符串上限同源语义）', () => {
    expect(SEARCH_QUERY_MAX_LENGTH).toBe(500);
  });
});

// ---------- 提供者生命周期矩阵（fakeBrowser 状态机 + 注入时钟，确定性无真实计时器） ----------

interface FakeState {
  tabs: TabInfo[];
  activeId: string | null;
  polls: number;
  closeCalls: string[];
  activateCalls: string[];
  snapshotCalls: string[];
  readyAfterPolls: number;
  errorAtPoll: number | null;
  vanishAtPoll: number | null;
  snapshotResult: PageSnapshot | null;
  createThrows: boolean;
  getTabsThrows: boolean;
  createReturnsExisting: string | null;
}

function makeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    tabs: [
      { id: 't-user', title: '用户页', url: 'https://user.example/', active: true, state: 'ready' },
    ],
    activeId: 't-user',
    polls: 0,
    closeCalls: [],
    activateCalls: [],
    snapshotCalls: [],
    readyAfterPolls: 1,
    errorAtPoll: null,
    vanishAtPoll: null,
    snapshotResult: resultsSnapshot(),
    createThrows: false,
    getTabsThrows: false,
    createReturnsExisting: null,
    ...overrides,
  };
}

function fakeBrowser(st: FakeState): BrowserController {
  return {
    createTab: async (url?: string) => {
      if (st.createThrows) throw new Error('控制器已销毁');
      if (st.createReturnsExisting !== null) {
        const existing = st.tabs.find((t) => t.id === st.createReturnsExisting);
        if (existing === undefined) throw new Error('夹具错误：目标 Tab 不存在');
        return existing; // 敌手/异常实现：createTab 返回已存在 tabId
      }
      const tab: TabInfo = {
        id: `t-search-${st.tabs.length}`,
        title: '',
        url: url ?? 'about:blank',
        active: true,
        state: 'idle',
      };
      st.tabs.push(tab);
      st.activeId = tab.id; // 与真实实现一致：新 Tab 成为活动 Tab
      return tab;
    },
    closeTab: async (tabId: string) => {
      st.closeCalls.push(tabId);
      const i = st.tabs.findIndex((t) => t.id === tabId);
      if (i === -1) return false; // 已被关闭 → 安全无操作（绝不关闭替代 Tab）
      st.tabs.splice(i, 1);
      if (st.activeId === tabId) st.activeId = st.tabs[0]?.id ?? null;
      return true;
    },
    activateTab: async (tabId: string) => {
      st.activateCalls.push(tabId);
      st.activeId = tabId;
      return true;
    },
    getTabs: async () => {
      if (st.getTabsThrows) throw new Error('读取标签页失败');
      st.polls += 1;
      for (const temp of st.tabs.filter((t) => t.id.startsWith('t-search-'))) {
        if (st.vanishAtPoll !== null && st.polls >= st.vanishAtPoll) {
          st.tabs.splice(st.tabs.indexOf(temp), 1); // 用户提前关闭临时 Tab
        } else if (st.errorAtPoll !== null && st.polls >= st.errorAtPoll) {
          temp.state = 'error';
        } else if (st.polls >= st.readyAfterPolls) {
          temp.state = 'ready';
        }
      }
      return st.tabs.map((t) => ({ ...t }));
    },
    getActiveTab: async () =>
      st.activeId === null ? null : (st.tabs.find((t) => t.id === st.activeId) ?? null),
    getPageSnapshot: async (tabId: string) => {
      st.snapshotCalls.push(tabId);
      return st.snapshotResult;
    },
    navigate: async () => false,
    goBack: async () => false,
    goForward: async () => false,
    reload: async () => false,
    clickElement: async () => ({ ok: false, reason: '未接线', errorCode: 'execution-failed' }),
    fillElement: async () => ({ ok: false, reason: '未接线', errorCode: 'execution-failed' }),
    scrollTab: async () => ({ ok: false, reason: '未接线' }),
    dispose: () => {},
  };
}

function makeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function makeProvider(st: FakeState, opts: { timeoutMs?: number; pollIntervalMs?: number } = {}) {
  const clock = makeClock();
  const provider = new BingSearchProvider({
    browser: fakeBrowser(st),
    timeoutMs: opts.timeoutMs ?? 15000,
    pollIntervalMs: opts.pollIntervalMs ?? 50,
    now: clock.now,
    sleep: clock.sleep,
  });
  return { provider, clock };
}

const signal = new AbortController().signal;

describe('BingSearchProvider 生命周期与临时 Tab 所有权', () => {
  it('成功链路：createTab(编码 URL) → 等 ready → 实时快照 → 解析 → 只关闭本调用创建的 tabId', async () => {
    const st = makeState({ readyAfterPolls: 2 });
    const { provider } = makeProvider(st);
    const r = await provider.search('electron 文档', signal);
    expect(r.ok).toBe(true);
    expect(r.results.map((x) => x.title)).toEqual(['结果一', '结果二', '包装结果', '广告技术原理']);
    // 快照只对精确 tempTabId 实时采集
    expect(st.snapshotCalls).toEqual(['t-search-1']);
    // 只关闭本调用创建的 tabId；用户 Tab 完好
    expect(st.closeCalls).toEqual(['t-search-1']);
    expect(st.tabs.map((t) => t.id)).toEqual(['t-user']);
  });

  it('搜索 URL 由既有 SEARCH_ENGINE_URL 默认基准 + encodeURIComponent 构造（注入基准可替换）', async () => {
    const st = makeState();
    const browser = fakeBrowser(st);
    const urls: Array<string | undefined> = [];
    const create = browser.createTab;
    browser.createTab = async (url?: string) => {
      urls.push(url);
      return create(url);
    };
    const clock = makeClock();
    const provider = new BingSearchProvider({
      browser,
      timeoutMs: 15000,
      pollIntervalMs: 50,
      now: clock.now,
      sleep: clock.sleep,
    });
    await provider.search('a&b=c 中文', signal);
    expect(urls[0]).toBe(`https://www.bing.com/search?q=${encodeURIComponent('a&b=c 中文')}`);
  });

  it('用户仍停留在临时搜索 Tab → 恢复调用前仍存在的活动 Tab（先激活后关闭）', async () => {
    const st = makeState();
    const { provider } = makeProvider(st);
    await provider.search('x', signal);
    expect(st.activateCalls).toEqual(['t-user']);
    expect(st.closeCalls).toEqual(['t-search-1']);
    expect(st.activeId).toBe('t-user');
  });

  it('用户已主动切换到其他 Tab → 关闭临时 Tab 但不抢回焦点（无 activateTab）', async () => {
    const st = makeState();
    const browser = fakeBrowser(st);
    // 模拟用户中途切走：getActiveTab 恒返回用户 Tab（activeNow ≠ tempTabId）
    browser.getActiveTab = async () => st.tabs.find((t) => t.id === 't-user') ?? null;
    const clock = makeClock();
    const provider = new BingSearchProvider({
      browser,
      timeoutMs: 15000,
      pollIntervalMs: 50,
      now: clock.now,
      sleep: clock.sleep,
    });
    await provider.search('x', signal);
    expect(st.activateCalls).toEqual([]);
    expect(st.closeCalls).toEqual(['t-search-1']);
    expect(st.tabs.map((t) => t.id)).toEqual(['t-user']);
  });

  it('调用前活动 Tab 已被关闭 → 不重建不激活，沿用 closeTab 正常活动 Tab 策略', async () => {
    const st = makeState();
    // 搜索期间用户关闭了调用前的活动 Tab（关闭后持续不存在——后续 getTabs 一致过滤）
    const browser = fakeBrowser(st);
    const origGetTabs = browser.getTabs;
    let userTabRemoved = false;
    browser.getTabs = async () => {
      const tabs = await origGetTabs();
      if (tabs.length > 1 && !userTabRemoved) userTabRemoved = true;
      return userTabRemoved ? tabs.filter((t) => t.id !== 't-user') : tabs;
    };
    const clock = makeClock();
    const provider = new BingSearchProvider({
      browser,
      timeoutMs: 15000,
      pollIntervalMs: 50,
      now: clock.now,
      sleep: clock.sleep,
    });
    const r = await provider.search('x', signal);
    expect(r.ok).toBe(true);
    expect(st.activateCalls).toEqual([]); // 不得重建/激活已关闭的 Tab
    expect(st.closeCalls).toEqual(['t-search-1']);
  });

  it('临时 Tab 被用户提前关闭 → search-failed；finally 安全无操作，不关闭任何其他 Tab', async () => {
    const st = makeState({ readyAfterPolls: 99, vanishAtPoll: 2 });
    const { provider } = makeProvider(st);
    const r = await provider.search('x', signal);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('search-failed');
    expect(r.warnings?.some((w) => w.includes('已被关闭'))).toBe(true);
    // finally 检测到临时 Tab 已不存在 → 对任何 Tab（含替代 Tab）都不发起关闭
    expect(st.closeCalls).toEqual([]);
    expect(st.tabs.map((t) => t.id)).toEqual(['t-user']);
  });

  it('ready 超时（注入时钟）→ search-failed + finally 清理临时 Tab，快照从未调用', async () => {
    const st = makeState({ readyAfterPolls: 99 });
    const { provider } = makeProvider(st, { timeoutMs: 100, pollIntervalMs: 50 });
    const r = await provider.search('x', signal);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('search-failed');
    expect(r.warnings?.some((w) => w.includes('超时'))).toBe(true);
    expect(st.snapshotCalls).toEqual([]);
    expect(st.closeCalls).toEqual(['t-search-1']);
    expect(st.tabs.map((t) => t.id)).toEqual(['t-user']);
  });

  it('导航失败（Tab 进入 error 态）→ search-failed 快速失败 + 清理', async () => {
    const st = makeState({ errorAtPoll: 1, readyAfterPolls: 99 });
    const { provider } = makeProvider(st);
    const r = await provider.search('x', signal);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('search-failed');
    expect(r.warnings?.some((w) => w.includes('加载失败'))).toBe(true);
    expect(st.closeCalls).toEqual(['t-search-1']);
  });

  it('快照 null（L3）→ search-failed（不伪装成功空结果）+ 清理', async () => {
    const st = makeState({ snapshotResult: null });
    const { provider } = makeProvider(st);
    const r = await provider.search('x', signal);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('search-failed');
    expect(r.warnings?.some((w) => w.includes('快照不可用'))).toBe(true);
    expect(st.closeCalls).toEqual(['t-search-1']);
  });

  it('快照 L2 降级（main-process-only）→ search-failed（采集失败不伪装成空结果）+ 清理', async () => {
    const st = makeState({
      snapshotResult: makeSnapshot({
        links: [],
        visibleText: undefined,
        meta: {
          documentId: 2,
          capturedAt: 1,
          readyState: 'unknown',
          degraded: 'main-process-only',
          warnings: ['页面不可采集'],
        },
      }),
    });
    const { provider } = makeProvider(st);
    const r = await provider.search('x', signal);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('search-failed');
    expect(r.warnings?.some((w) => w.includes('降级'))).toBe(true);
    expect(st.closeCalls).toEqual(['t-search-1']);
  });

  it('页面结构无法识别（空内容快照）→ search-failed；合法空结果（有内容无有机结果）→ ok:true 空数组 + 明确提示', async () => {
    const stEmpty = makeState({
      snapshotResult: makeSnapshot({ links: [], visibleText: undefined }),
    });
    const rEmpty = await makeProvider(stEmpty).provider.search('x', signal);
    expect(rEmpty.ok).toBe(false);
    expect(rEmpty.errorCode).toBe('search-failed');
    expect(rEmpty.results).toEqual([]);

    const stNoResults = makeState({
      snapshotResult: makeSnapshot({
        links: [{ id: 'el-0', text: '设置', href: 'https://www.bing.com/account/general' }],
        visibleText: '没有与此相关的结果。',
      }),
    });
    const rNoResults = await makeProvider(stNoResults).provider.search('x', signal);
    expect(rNoResults.ok).toBe(true);
    expect(rNoResults.results).toEqual([]);
    expect(rNoResults.warnings?.some((w) => w.includes('未找到搜索结果'))).toBe(true);
  });

  it('AbortSignal：开始前触发 → aborted 且不创建 Tab；等待中触发 → aborted + 清理临时 Tab', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const stPre = makeState();
    const rPre = await makeProvider(stPre).provider.search('x', aborted.signal);
    expect(rPre.ok).toBe(false);
    expect(rPre.errorCode).toBe('aborted');
    expect(stPre.tabs.map((t) => t.id)).toEqual(['t-user']); // 未创建

    const stMid = makeState({ readyAfterPolls: 99 });
    const ctl = new AbortController();
    const clock = makeClock();
    let first = true;
    const provider = new BingSearchProvider({
      browser: fakeBrowser(stMid),
      timeoutMs: 15000,
      pollIntervalMs: 50,
      now: clock.now,
      sleep: async (ms: number) => {
        clock.sleep(ms);
        if (first) {
          first = false;
          ctl.abort();
        }
      },
    });
    const rMid = await provider.search('x', ctl.signal);
    expect(rMid.ok).toBe(false);
    expect(rMid.errorCode).toBe('aborted');
    expect(stMid.snapshotCalls).toEqual([]);
    expect(stMid.closeCalls).toEqual(['t-search-1']); // finally 仍清理
    expect(stMid.tabs.map((t) => t.id)).toEqual(['t-user']);
  });

  it('query 校验：空串/空白 → search-failed 不创建 Tab；超 500 字符 → search-failed；非字符串安全拒绝', async () => {
    const st = makeState();
    const { provider } = makeProvider(st);
    const rEmpty = await provider.search('   ', signal);
    expect(rEmpty.ok).toBe(false);
    expect(rEmpty.errorCode).toBe('search-failed');
    const rLong = await provider.search('x'.repeat(501), signal);
    expect(rLong.ok).toBe(false);
    expect(rLong.errorCode).toBe('search-failed');
    const rBad = await provider.search(42 as unknown as string, signal);
    expect(rBad.ok).toBe(false);
    expect(st.tabs.map((t) => t.id)).toEqual(['t-user']); // 任何校验失败都不创建
    expect(st.closeCalls).toEqual([]);
  });

  it('BrowserController 调用失败：createTab 抛异常 → search-failed 不崩溃；getTabs 抛异常 → search-failed', async () => {
    const stCreate = makeState({ createThrows: true });
    const rCreate = await makeProvider(stCreate).provider.search('x', signal);
    expect(rCreate.ok).toBe(false);
    expect(rCreate.errorCode).toBe('search-failed');
    expect(stCreate.closeCalls).toEqual([]); // 未创建 → 无可清理，不误关

    const stTabs = makeState({ getTabsThrows: true });
    const rTabs = await makeProvider(stTabs).provider.search('x', signal);
    expect(rTabs.ok).toBe(false);
    expect(rTabs.errorCode).toBe('search-failed');
  });

  it('所有权：createTab 返回已存在的 tabId（敌手/异常实现）→ 不纳入临时资源管理，绝不关闭该 Tab', async () => {
    const st = makeState({ createReturnsExisting: 't-user' });
    const { provider } = makeProvider(st);
    const r = await provider.search('x', signal);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('search-failed');
    expect(st.closeCalls).toEqual([]); // 用户 Tab 绝不被关闭
    expect(st.tabs.map((t) => t.id)).toEqual(['t-user']);
  });

  it('并发调用：两个 Provider 同时搜索，各自只清理自己创建的 Tab（无共享「当前搜索 Tab」状态）', async () => {
    const st = makeState({ readyAfterPolls: 1 });
    const browser = fakeBrowser(st);
    const clock = makeClock();
    const opts = {
      browser,
      timeoutMs: 15000,
      pollIntervalMs: 50,
      now: clock.now,
      sleep: clock.sleep,
    };
    const p1 = new BingSearchProvider(opts);
    const p2 = new BingSearchProvider(opts);
    const [r1, r2] = await Promise.all([p1.search('甲', signal), p2.search('乙', signal)]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(st.closeCalls.sort()).toEqual(['t-search-1', 't-search-2']); // 各关各的
    expect(st.tabs.map((t) => t.id)).toEqual(['t-user']);
    expect(st.snapshotCalls.sort()).toEqual(['t-search-1', 't-search-2']);
  });

  it('任何路径均不泄漏临时 Tab：成功/失败/超时/取消后 getTabs 中均无临时 Tab 残留', async () => {
    for (const st of [
      makeState({ readyAfterPolls: 1 }),
      makeState({ errorAtPoll: 1, readyAfterPolls: 99 }),
      makeState({ readyAfterPolls: 99, vanishAtPoll: 2 }),
      makeState({ snapshotResult: null }),
    ]) {
      const { provider } = makeProvider(st, { timeoutMs: 100, pollIntervalMs: 50 });
      await provider.search('x', signal);
      expect(st.tabs.some((t) => t.id.startsWith('t-search-'))).toBe(false);
      expect(st.tabs.map((t) => t.id)).toEqual(['t-user']);
    }
  });
});
