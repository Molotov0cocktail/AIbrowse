// A3 交互工具测试（红→绿先写）：find 确定性匹配纯函数 + scroll/click/fill executor。
// 关键安全断言：click/fill 的 allowedKind 与 documentId 只能来自 ToolExecutor 权限决策
// 派生的执行参数（call.derived，模型不可见不可写）——executor 不自行分类、无派生参数时
// 拒绝执行；fill 结果与内容不包含输入原文；find 无命中是 ok 空结果（非错误）。
// 契约源：doc/stage3/detailed-design.md §4.2/§5 + threat-model §3.2/§3.3。
import { describe, expect, it, vi } from 'vitest';
import type { BrowserController } from '../../browser/browser-controller';
import type {
  ElementActionResult,
  PageSnapshot,
  ScrollActionResult,
} from '../../../shared/types/browser';
import type { ToolExecutionContext } from './tool-types';
import { findMatches, INTERACTION_TOOL_DEFINITIONS } from './interaction-tools';
import type { ToolExecutorFn } from './tool-types';

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
    getActiveTab: async () => ({
      id: 't1',
      title: '页',
      url: 'https://x/',
      active: true,
      state: 'ready',
    }),
    getPageSnapshot: async () => null,
    clickElement: async () => ({ ok: false, reason: '未接线', errorCode: 'execution-failed' }),
    fillElement: async () => ({ ok: false, reason: '未接线', errorCode: 'execution-failed' }),
    scrollTab: async () => ({ ok: false, reason: '未接线' }),
    dispose: () => {},
    ...overrides,
  };
}

function makeSnapshot(): PageSnapshot {
  return {
    url: 'https://page.example/',
    title: '交互示例页',
    headings: [{ level: 1, text: '安全设置' }],
    links: [
      { id: 'el-0', text: '安全设置', href: 'https://page.example/security' },
      { id: 'el-1', text: '隐私政策', href: 'https://page.example/privacy' },
    ],
    buttons: [{ id: 'el-2', text: '安全中心' }],
    inputs: [{ id: 'el-3', type: 'text', placeholder: '安全搜索' }],
    visibleText: '欢迎来到安全设置页面。',
    meta: {
      capturedAt: 1,
      readyState: 'complete',
      degraded: 'none',
      warnings: [],
      documentId: 3,
    },
  };
}

function toolDef(name: string) {
  const def = INTERACTION_TOOL_DEFINITIONS.find((d) => d.name === name);
  if (def === undefined) throw new Error(`未找到工具定义：${name}`);
  return def;
}

const ctxFor = (
  browser: BrowserController,
  extra: Partial<ToolExecutionContext> = {},
): ToolExecutionContext => ({
  browser,
  runId: 'test-run',
  ...extra,
});
const signal = new AbortController().signal;

describe('A3 交互工具定义（find/scroll/click/fill）', () => {
  it('恰好 4 个；allowedKind 与 documentId 不出现在任何模型可见 schema（模型不可见不可写）', () => {
    const names = INTERACTION_TOOL_DEFINITIONS.map((d) => d.name).sort();
    expect(names).toEqual(['browser.click', 'browser.fill', 'browser.find', 'browser.scroll']);
    for (const def of INTERACTION_TOOL_DEFINITIONS) {
      const schema = JSON.stringify(def.parameters);
      expect(schema).not.toContain('allowedKind');
      expect(schema).not.toContain('documentId');
    }
  });

  it('find/scroll/click/fill 均只经注入的 BrowserController 执行（不 import Electron）', () => {
    const source = INTERACTION_TOOL_DEFINITIONS.map((d) => d.executor.toString()).join('\n');
    expect(source).not.toContain('electron');
    expect(source).not.toContain('webContents');
  });
});

describe('findMatches（确定性匹配纯函数）', () => {
  const snap = makeSnapshot();

  it('多章节命中：visibleText/headings/links/buttons/inputs 固定顺序 + 元素 id 与章节位置', () => {
    const hits = findMatches(snap, '安全');
    expect(hits.map((h) => h.section)).toEqual([
      'visibleText',
      'headings',
      'links',
      'buttons',
      'inputs',
    ]);
    expect(hits[2]).toMatchObject({ section: 'links', id: 'el-0', text: '安全设置' });
    expect(hits[4]).toMatchObject({ section: 'inputs', id: 'el-3' });
  });

  it('无命中 → 空数组（ok 空结果，非错误）', () => {
    expect(findMatches(snap, '不存在的词')).toEqual([]);
  });

  it('确定性：大小写敏感、同一输入同一输出', () => {
    expect(findMatches(snap, '安全')).toEqual(findMatches(snap, '安全'));
    expect(findMatches(snap, 'security')).toEqual([]); // 大小写敏感（中文文本内嵌英文）
  });

  it('inputs 匹配覆盖 type/placeholder/value 文本；visibleText 命中产出节选摘要（≤80 字符）', () => {
    const hits = findMatches(snap, '安全搜索');
    const inputHit = hits.find((h) => h.section === 'inputs');
    expect(inputHit).toMatchObject({ id: 'el-3' });
    const long = makeSnapshot();
    long.visibleText = `前缀${'长'.repeat(200)}关键词后缀`;
    const longHits = findMatches(long, '关键词');
    expect(longHits.length).toBe(1);
    expect(longHits[0]?.text.length).toBeLessThanOrEqual(80);
    expect(longHits[0]?.text).toContain('关键词');
  });
});

describe('browser.find executor（实时快照 + 命中集合 + recordSnapshot 语义登记）', () => {
  it('实时采集快照并登记语义来源；无命中返回 ok 空结果', async () => {
    const snapshotSpy = vi.fn(async () => makeSnapshot());
    const recordSpy = vi.fn();
    const ctx = ctxFor(fakeBrowser({ getPageSnapshot: snapshotSpy }), {
      recordSnapshot: recordSpy,
    });
    const hit = await toolDef('browser.find').executor(
      { id: 'c1', args: { text: '安全' } },
      ctx,
      signal,
    );
    expect(hit.ok).toBe(true);
    expect(hit.content).toContain('[el-0]');
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith('t1', makeSnapshot());
    const miss = await toolDef('browser.find').executor(
      { id: 'c2', args: { text: '不存在' } },
      ctx,
      signal,
    );
    expect(miss.ok).toBe(true);
    expect(miss.content).toContain('未找到');
  });

  it('快照不可用 → execution-failed', async () => {
    const ctx = ctxFor(fakeBrowser({ getPageSnapshot: async () => null }));
    const r = await toolDef('browser.find').executor(
      { id: 'c1', args: { text: 'x' } },
      ctx,
      signal,
    );
    expect(r).toMatchObject({ ok: false, errorCode: 'execution-failed' });
  });
});

describe('browser.scroll executor', () => {
  it('经 BrowserController.scrollTab 执行并返回 viewport 摘要', async () => {
    const scrollSpy = vi.fn(async (): Promise<ScrollActionResult> => ({
      ok: true,
      viewport: { scrollX: 0, scrollY: 100, width: 800, height: 600 },
    }));
    const ctx = ctxFor(fakeBrowser({ scrollTab: scrollSpy }));
    const r = await toolDef('browser.scroll').executor(
      { id: 'c1', args: { dy: 100 } },
      ctx,
      signal,
    );
    expect(r.ok).toBe(true);
    expect(scrollSpy).toHaveBeenCalledWith('t1', 100);
    expect(r.content).toContain('scrollY=100');
  });

  it('滚动失败（安全返回）→ execution-failed + 中文说明', async () => {
    const ctx = ctxFor(
      fakeBrowser({ scrollTab: async () => ({ ok: false, reason: '页面不可用' }) }),
    );
    const r = await toolDef('browser.scroll').executor({ id: 'c1', args: { dy: 1 } }, ctx, signal);
    expect(r).toMatchObject({ ok: false, errorCode: 'execution-failed', content: '页面不可用' });
  });
});

describe('browser.click executor（allowedKind/documentId 只来自权限决策派生）', () => {
  it('无派生执行参数（derived 缺失）→ 拒绝执行，不触碰 BrowserController', async () => {
    const clickSpy = vi.fn(async (): Promise<ElementActionResult> => ({
      ok: true,
      tag: 'a',
      text: 'x',
    }));
    const ctx = ctxFor(fakeBrowser({ clickElement: clickSpy }));
    const executor = toolDef('browser.click').executor as ToolExecutorFn;
    const r = await executor({ id: 'c1', args: { elementId: 'el-0' } }, ctx, signal);
    expect(r).toMatchObject({ ok: false, errorCode: 'execution-failed' });
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('有派生参数 → 原样透传（executor 不自行分类），成功结果含元素摘要', async () => {
    const clickSpy = vi.fn(async (): Promise<ElementActionResult> => ({
      ok: true,
      tag: 'a',
      text: '导航链接',
    }));
    const ctx = ctxFor(fakeBrowser({ clickElement: clickSpy }));
    const executor = toolDef('browser.click').executor as ToolExecutorFn;
    const r = await executor(
      {
        id: 'c1',
        args: { elementId: 'el-0' },
        derived: { allowedKind: 'nav', documentId: 3 },
      },
      ctx,
      signal,
    );
    expect(r.ok).toBe(true);
    expect(clickSpy).toHaveBeenCalledWith('t1', 'el-0', 'nav', 3);
    expect(r.content).toContain('[el-0]');
    expect(r.content).toContain('导航链接');
  });

  it('浏览器侧拒绝（stale-element 等）→ 结构化错误码原样映射，不以 ok:true 出现', async () => {
    const ctx = ctxFor(
      fakeBrowser({
        clickElement: async () => ({
          ok: false,
          errorCode: 'stale-element',
          reason: '元素所属的快照已过期',
        }),
      }),
    );
    const executor = toolDef('browser.click').executor as ToolExecutorFn;
    const r = await executor(
      { id: 'c1', args: { elementId: 'el-0' }, derived: { allowedKind: 'expand', documentId: 3 } },
      ctx,
      signal,
    );
    expect(r).toMatchObject({ ok: false, errorCode: 'stale-element' });
    expect(r.content).toContain('已过期');
  });
});

describe('browser.fill executor（输入原文零外泄）', () => {
  it('经 BrowserController.fillElement 执行（派生 documentId 透传）；结果只含标签/类型/长度', async () => {
    const fillSpy = vi.fn(async (): Promise<ElementActionResult> => ({
      ok: true,
      tag: 'input',
      type: 'text',
    }));
    const ctx = ctxFor(fakeBrowser({ fillElement: fillSpy }));
    const executor = toolDef('browser.fill').executor as ToolExecutorFn;
    const r = await executor(
      {
        id: 'c1',
        args: { elementId: 'el-3', text: '机密输入内容' },
        derived: { documentId: 3 },
      },
      ctx,
      signal,
    );
    expect(r.ok).toBe(true);
    expect(fillSpy).toHaveBeenCalledWith('t1', 'el-3', '机密输入内容', 3);
    expect(r.content).toContain('6 个字符');
    expect(r.content).not.toContain('机密输入内容');
    expect(JSON.stringify(r)).not.toContain('机密输入内容');
  });

  it('无派生 documentId → 拒绝执行（fail-closed）', async () => {
    const fillSpy = vi.fn(async (): Promise<ElementActionResult> => ({
      ok: true,
      tag: 'input',
      type: 'text',
    }));
    const ctx = ctxFor(fakeBrowser({ fillElement: fillSpy }));
    const executor = toolDef('browser.fill').executor as ToolExecutorFn;
    const r = await executor({ id: 'c1', args: { elementId: 'el-3', text: 'x' } }, ctx, signal);
    expect(r).toMatchObject({ ok: false, errorCode: 'execution-failed' });
    expect(fillSpy).not.toHaveBeenCalled();
  });
});
