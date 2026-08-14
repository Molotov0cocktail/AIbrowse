// A2 首批 8 个只读/导航工具测试：executor 只经构造注入的 BrowserController 接口执行
// （不 import Electron、不直连 webContents）；browser.read 每次实时采集
// （getPageSnapshot 逐次调用，不复用缓存快照——防串页契约）；结果确定性序列化与截断；
// BrowserController 失败语义（false/null）安全映射为 execution-failed。
// 契约源：doc/stage3/detailed-design.md §4.2/§8.4 + Second_stage 防串页纪律。
import { describe, expect, it } from 'vitest';
import type { BrowserController } from '../../browser/browser-controller';
import type { PageSnapshot, TabInfo } from '../../../shared/types/browser';
import { TOOL_BASE_RISK } from '../permission/permission-policy';
import type { ToolExecutionContext } from './tool-types';
import { BROWSER_TOOL_DEFINITIONS, serializeSnapshotForTool } from './browser-tools';

function fakeBrowser(overrides: Partial<BrowserController> = {}): BrowserController {
  return {
    createTab: async () => ({
      id: 't-new',
      title: '',
      url: 'about:blank',
      active: true,
      state: 'idle',
    }),
    closeTab: async () => false,
    activateTab: async () => false,
    navigate: async () => false,
    goBack: async () => false,
    goForward: async () => false,
    reload: async () => false,
    getTabs: async () => [],
    getActiveTab: async () => null,
    getPageSnapshot: async () => null,
    dispose: () => {},
    ...overrides,
  };
}

function makeTab(overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id: 't1',
    title: '示例页',
    url: 'https://example.com/',
    active: false,
    state: 'ready',
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://example.com/',
    title: '示例',
    headings: [],
    links: [],
    buttons: [],
    meta: { capturedAt: 1, readyState: 'complete', degraded: 'none', warnings: [] },
    ...overrides,
  };
}

function toolDef(name: string) {
  const def = BROWSER_TOOL_DEFINITIONS.find((d) => d.name === name);
  if (def === undefined) throw new Error(`未找到工具定义：${name}`);
  return def;
}

const ctxFor = (browser: BrowserController): ToolExecutionContext => ({
  browser,
  runId: 'test-run',
});
const signal = new AbortController().signal;

describe('A2 首批 8 工具定义', () => {
  it('恰好 8 个、全部只读/导航；无交互（find/scroll/click/fill）与搜索工具（A3/A4 红线）', () => {
    const names = BROWSER_TOOL_DEFINITIONS.map((d) => d.name).sort();
    expect(names).toEqual([
      'browser.back',
      'browser.forward',
      'browser.get_active_tab',
      'browser.get_tabs',
      'browser.navigate',
      'browser.open',
      'browser.read',
      'browser.reload',
    ]);
    for (const forbidden of [
      'browser.find',
      'browser.scroll',
      'browser.click',
      'browser.fill',
      'search.web',
    ]) {
      expect(
        BROWSER_TOOL_DEFINITIONS.some((d) => d.name === forbidden),
        forbidden,
      ).toBe(false);
    }
  });

  it('baseRisk 与 §7.1 权限矩阵常量一致（单一事实源交叉验证）', () => {
    for (const d of BROWSER_TOOL_DEFINITIONS) {
      expect(d.baseRisk, d.name).toBe(TOOL_BASE_RISK[d.name]);
    }
  });
});

describe('browser.get_tabs / get_active_tab', () => {
  it('get_tabs 经注入 BrowserController.getTabs 输出确定性摘要（含 id/标题/URL/活动/状态）', async () => {
    const tabs = [
      makeTab({ id: 'a-1', title: '甲', active: true }),
      makeTab({ id: 'b-2', title: '', url: 'about:blank', state: 'loading' }),
    ];
    const browser = fakeBrowser({ getTabs: async () => tabs });
    const r = await toolDef('browser.get_tabs').executor(
      { id: 'c1', args: {} },
      ctxFor(browser),
      signal,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('共 2 个标签页');
    expect(r.content).toContain('a-1');
    expect(r.content).toContain('b-2');
    expect(r.content).toContain('甲');
    expect(r.content).toContain('loading');
    expect(r.content).toContain('https://example.com/');
  });

  it('get_tabs 空结果 → ok 空说明（空 ≠ 失败，Third_stage.md §8 语义）', async () => {
    const r = await toolDef('browser.get_tabs').executor(
      { id: 'c1', args: {} },
      ctxFor(fakeBrowser()),
      signal,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('没有标签页');
  });

  it('get_active_tab 摘要含 id/标题/URL/状态；null → ok 空说明', async () => {
    const r = await toolDef('browser.get_active_tab').executor(
      { id: 'c1', args: {} },
      ctxFor(fakeBrowser({ getActiveTab: async () => makeTab({ id: 'act-1', active: true }) })),
      signal,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('act-1');
    expect(r.content).toContain('示例页');
    const empty = await toolDef('browser.get_active_tab').executor(
      { id: 'c2', args: {} },
      ctxFor(fakeBrowser()),
      signal,
    );
    expect(empty.ok).toBe(true);
    expect(empty.content).toContain('没有活动标签页');
  });
});

describe('browser.read（实时采集）', () => {
  it('缺省 tabId 解析为活动 Tab；每次调用实时 getPageSnapshot（不复用缓存）', async () => {
    let calls = 0;
    const browser = fakeBrowser({
      getActiveTab: async () => makeTab({ id: 'act-1' }),
      getPageSnapshot: async (tabId) => {
        calls += 1;
        return makeSnapshot({ url: `https://x/${tabId}` });
      },
    });
    const d = toolDef('browser.read');
    const r1 = await d.executor({ id: 'c1', args: {} }, ctxFor(browser), signal);
    const r2 = await d.executor({ id: 'c2', args: {} }, ctxFor(browser), signal);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(calls).toBe(2);
    expect(r1.content).toContain('https://x/act-1');
    expect(r2.content).toContain('https://x/act-1');
  });

  it('显式 tabId 直接传递；快照 null（L3）→ execution-failed', async () => {
    let gotTabId = '';
    const browser = fakeBrowser({
      getPageSnapshot: async (tabId) => {
        gotTabId = tabId;
        return null;
      },
    });
    const r = await toolDef('browser.read').executor(
      { id: 'c1', args: { tabId: 't-9' } },
      ctxFor(browser),
      signal,
    );
    expect(gotTabId).toBe('t-9');
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('execution-failed');
  });

  it('无活动 Tab → execution-failed 且不调用 getPageSnapshot', async () => {
    let calls = 0;
    const browser = fakeBrowser({
      getPageSnapshot: async () => {
        calls += 1;
        return null;
      },
    });
    const r = await toolDef('browser.read').executor(
      { id: 'c1', args: {} },
      ctxFor(browser),
      signal,
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('execution-failed');
    expect(calls).toBe(0);
  });
});

describe('serializeSnapshotForTool（确定性序列化 + 独立预算）', () => {
  it('章节按固定顺序输出（可见文本→标题→表格→链接→按钮→输入），含 elementId', () => {
    const snap = makeSnapshot({
      visibleText: '正文内容',
      headings: [{ level: 2, text: '标题甲' }],
      links: [{ id: 'el-3', text: '链接甲', href: 'https://example.com/a' }],
      buttons: [{ id: 'el-5', text: '按钮甲' }],
      inputs: [{ id: 'el-8', type: 'text', placeholder: '搜索' }],
      tables: [{ headers: ['A', 'B'], rows: [['1', '2']] }],
    });
    const { content } = serializeSnapshotForTool(snap, 8000);
    const order = ['可见文本', '标题', '表格', '链接', '按钮', '输入'].map((m) =>
      content.indexOf(m),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(content).toContain('el-3');
    expect(content).toContain('el-5');
    expect(content).toContain('el-8');
    expect(content).toContain('https://example.com/a');
  });

  it('超预算确定性截断：总长 ≤ 预算、带截断标记与 warnings', () => {
    const snap = makeSnapshot({ visibleText: '长'.repeat(10000) });
    const { content, warnings } = serializeSnapshotForTool(snap, 8000);
    expect(content.length).toBeLessThanOrEqual(8000);
    expect(content.endsWith('…[已截断]')).toBe(true);
    expect(warnings.join()).toContain('已确定性截断');
  });

  it('同一快照两次序列化结果恒等（确定性）', () => {
    const snap = makeSnapshot({
      visibleText: 'x'.repeat(300),
      links: [{ id: 'el-1', text: 'L', href: 'https://x/' }],
    });
    expect(serializeSnapshotForTool(snap, 8000)).toEqual(serializeSnapshotForTool(snap, 8000));
  });

  it('章节条目上限生效（链接 30/按钮 20/输入 20/标题 20）', () => {
    const snap = makeSnapshot({
      headings: Array.from({ length: 25 }, (_, i) => ({ level: 2, text: `H${i}` })),
      links: Array.from({ length: 50 }, (_, i) => ({
        id: `el-${i + 1}`,
        text: `L${i}`,
        href: 'https://x/',
      })),
      buttons: Array.from({ length: 25 }, (_, i) => ({ id: `el-b${i + 1}`, text: `B${i}` })),
      inputs: Array.from({ length: 25 }, (_, i) => ({ id: `el-i${i + 1}`, type: 'text' })),
    });
    const { content } = serializeSnapshotForTool(snap, 8000);
    expect(content).toContain('20/25');
    expect(content).toContain('30/50');
    expect(content).toContain('20/25 条');
    expect(content).not.toContain('el-31');
    expect(content).not.toContain('L49');
  });
});

describe('browser.open / navigate / back / forward / reload', () => {
  it('open 经 createTab 执行并报告新 Tab；Tab 保留（不关闭，决议 #28）', async () => {
    let created: string | undefined;
    let closed = false;
    const browser = fakeBrowser({
      createTab: async (url) => {
        created = url;
        return makeTab({ id: 'n-1', url: url ?? '' });
      },
      closeTab: async () => {
        closed = true;
        return true;
      },
    });
    const r = await toolDef('browser.open').executor(
      { id: 'c1', args: { url: 'https://example.com/' } },
      ctxFor(browser),
      signal,
    );
    expect(created).toBe('https://example.com/');
    expect(closed).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.content).toContain('n-1');
  });

  it('navigate：缺省 tabId 用活动 Tab；true → ok、false → execution-failed', async () => {
    const calls: Array<[string, string]> = [];
    const browser = fakeBrowser({
      getActiveTab: async () => makeTab({ id: 'act-1' }),
      navigate: async (tabId, url) => {
        calls.push([tabId, url]);
        return true;
      },
    });
    const r = await toolDef('browser.navigate').executor(
      { id: 'c1', args: { url: 'https://b.example/' } },
      ctxFor(browser),
      signal,
    );
    expect(calls).toEqual([['act-1', 'https://b.example/']]);
    expect(r.ok).toBe(true);
    const bad = await toolDef('browser.navigate').executor(
      { id: 'c2', args: { url: 'https://x/' } },
      ctxFor(fakeBrowser({ getActiveTab: async () => makeTab(), navigate: async () => false })),
      signal,
    );
    expect(bad.ok).toBe(false);
    expect(bad.errorCode).toBe('execution-failed');
  });

  it('navigate 无活动 Tab → execution-failed（不调用 navigate）', async () => {
    let called = false;
    const browser = fakeBrowser({
      navigate: async () => {
        called = true;
        return true;
      },
    });
    const r = await toolDef('browser.navigate').executor(
      { id: 'c1', args: { url: 'https://x/' } },
      ctxFor(browser),
      signal,
    );
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('back/forward/reload：tabId 传递、true → ok 说明、false → execution-failed', async () => {
    const seen: Array<[string, string]> = [];
    const okBrowser = fakeBrowser({
      goBack: async (t) => {
        seen.push(['back', t]);
        return true;
      },
      goForward: async () => true,
      reload: async () => true,
    });
    const rBack = await toolDef('browser.back').executor(
      { id: 'c1', args: { tabId: 't-9' } },
      ctxFor(okBrowser),
      signal,
    );
    expect(seen).toEqual([['back', 't-9']]);
    expect(rBack.ok).toBe(true);
    const badBrowser = fakeBrowser({
      getActiveTab: async () => makeTab(),
      goBack: async () => false,
      goForward: async () => false,
      reload: async () => false,
    });
    for (const name of ['browser.back', 'browser.forward', 'browser.reload']) {
      const r = await toolDef(name).executor({ id: 'c1', args: {} }, ctxFor(badBrowser), signal);
      expect(r.ok, name).toBe(false);
      expect(r.errorCode, name).toBe('execution-failed');
    }
  });

  it('back 无活动 Tab → execution-failed（不调用 goBack）', async () => {
    let called = false;
    const browser = fakeBrowser({
      goBack: async () => {
        called = true;
        return true;
      },
    });
    const r = await toolDef('browser.back').executor(
      { id: 'c1', args: {} },
      ctxFor(browser),
      signal,
    );
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });
});
