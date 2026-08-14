// A4 search.web 工具测试（红→绿先写）：工具常量（name/description/schema 程序常量）、
// executor 经注入 SearchProvider 执行（ctx.searchProvider 优先——冒烟/A5 注入点）、
// 结果序列化为纯文本行（标题/网址/摘要——不可信数据零指令性/富文本特权，不暴露
// documentId/内部 tabId/快照正文/调试字段）、失败与取消诚实映射闭合枚举
// （search-failed；aborted 由外层归一为 execution-failed）、经既有 ToolExecutor 管线
// 每次调用恰好一条审计 + L0 自动决策 + 4000 字符确定性截断附 warning。
// 契约源：doc/stage3/detailed-design.md §4.2/§6/§8.4 + threat-model §3.2/§3.4。
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfirmManager } from '../confirm-manager';
import type { AuditEntry } from '../audit-log';
import type { SearchProvider, SearchResult } from '../search/search-provider';
import { TOOL_BASE_RISK } from '../permission/permission-policy';
import { ToolExecutor, SEARCH_TOOL_CONTENT_MAX } from './tool-executor';
import { registerTool, resetToolRegistry, listTools } from './tool-registry';
import type { ToolExecutionContext } from './tool-types';
import { createSearchTool, formatSearchResults, SEARCH_TOOL_NAME } from './search-tool';

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: '示例结果',
    url: 'https://example.com/page',
    snippet: '',
    source: 'bing',
    ...overrides,
  };
}

function fakeProvider(
  behavior: () => Promise<{
    ok: boolean;
    results: SearchResult[];
    errorCode?: 'search-failed' | 'aborted';
    warnings?: string[];
  }>,
): SearchProvider & { calls: Array<{ query: string }> } {
  const calls: Array<{ query: string }> = [];
  return {
    id: 'bing',
    calls,
    search: async (query: string) => {
      calls.push({ query });
      return behavior();
    },
  };
}

const signal = new AbortController().signal;
const ctxFor = (searchProvider?: SearchProvider): ToolExecutionContext => ({
  browser: fakeBrowserStub(),
  runId: 'test-run',
  searchProvider,
});

// search.web 不触碰 BrowserController（只经 SearchProvider）——stub 仅满足 ctx 形状
function fakeBrowserStub(): ToolExecutionContext['browser'] {
  return {
    createTab: async () => ({ id: 't', title: '', url: '', active: true, state: 'idle' }),
    closeTab: async () => false,
    activateTab: async () => false,
    navigate: async () => false,
    goBack: async () => false,
    goForward: async () => false,
    reload: async () => false,
    getTabs: async () => [],
    getActiveTab: async () => null,
    getPageSnapshot: async () => null,
    clickElement: async () => ({ ok: false, reason: '未接线', errorCode: 'execution-failed' }),
    fillElement: async () => ({ ok: false, reason: '未接线', errorCode: 'execution-failed' }),
    scrollTab: async () => ({ ok: false, reason: '未接线' }),
    dispose: () => {},
  };
}

describe('search.web 工具定义（程序常量）', () => {
  it('name/description/schema/paramRules 为常量：仅 {query}、非空、baseRisk=L0 与权限矩阵一致', () => {
    const provider = fakeProvider(async () => ({ ok: true, results: [] }));
    const def = createSearchTool(provider);
    expect(def.name).toBe(SEARCH_TOOL_NAME);
    expect(SEARCH_TOOL_NAME).toBe('search.web');
    expect(typeof def.description).toBe('string');
    expect(def.description.length).toBeGreaterThan(0);
    expect(Object.keys(def.parameters.properties)).toEqual(['query']);
    expect(def.parameters.required).toEqual(['query']);
    expect(def.parameters.properties.query.type).toBe('string');
    expect(def.paramRules?.query.nonEmpty).toBe(true);
    expect(def.baseRisk).toBe(0);
    expect(def.baseRisk).toBe(TOOL_BASE_RISK['search.web']);

    // 模型可见 schema（listTools 序列化）不含任何内部字段
    resetToolRegistry();
    registerTool(def);
    const [listed] = listTools();
    expect(JSON.stringify(listed)).not.toContain('documentId');
    expect(JSON.stringify(listed)).not.toContain('tabId');
    expect(JSON.stringify(listed)).not.toContain('executor');
    expect(listed.function.parameters.required).toEqual(['query']);
  });
});

describe('formatSearchResults 序列化', () => {
  it('标题/网址/摘要纯文本行；空摘要省略行；空结果明确提示', () => {
    const text = formatSearchResults([
      makeResult({ title: '甲', url: 'https://example.com/a', snippet: '摘要甲' }),
      makeResult({ title: '乙', url: 'https://example.com/b' }),
    ]);
    expect(text).toContain('共 2 条搜索结果');
    expect(text).toContain('1. 甲');
    expect(text).toContain('网址：https://example.com/a');
    expect(text).toContain('摘要：摘要甲');
    expect(text).toContain('2. 乙');
    expect(text).not.toContain('网址：https://example.com/b\n   摘要：');
    expect(formatSearchResults([])).toBe('未找到搜索结果');
  });
});

describe('search.web executor', () => {
  it('成功：经注入 SearchProvider 执行，返回序列化结果与 provider warnings 透传', async () => {
    const provider = fakeProvider(async () => ({
      ok: true,
      results: [makeResult({ title: '真结果', url: 'https://example.com/x', snippet: '摘要' })],
      warnings: ['扁平快照无法可靠关联每条结果的摘要文本，摘要留空'],
    }));
    const def = createSearchTool(provider);
    const r = await def.executor({ id: 'c1', args: { query: '测试' } }, ctxFor(provider), signal);
    expect(r.ok).toBe(true);
    expect(r.content).toContain('真结果');
    expect(r.content).toContain('https://example.com/x');
    expect(r.warnings).toContain('扁平快照无法可靠关联每条结果的摘要文本，摘要留空');
    expect(provider.calls).toEqual([{ query: '测试' }]);
  });

  it('ctx.searchProvider 优先于注册注入（冒烟受控夹具/A5 注入点），并透传 query', async () => {
    const registered = fakeProvider(async () => ({
      ok: true,
      results: [makeResult({ title: '注册注入' })],
    }));
    const ctxOverride = fakeProvider(async () => ({
      ok: true,
      results: [makeResult({ title: 'ctx 注入', url: 'https://override.example/' })],
    }));
    const def = createSearchTool(registered);
    const r = await def.executor({ id: 'c1', args: { query: 'q' } }, ctxFor(ctxOverride), signal);
    expect(r.content).toContain('ctx 注入');
    expect(registered.calls).toEqual([]); // 注册注入未被调用
    expect(ctxOverride.calls).toEqual([{ query: 'q' }]);
  });

  it('provider 失败 → ok:false + search-failed，错误内容含程序化中文说明（不伪装成功）', async () => {
    const provider = fakeProvider(async () => ({
      ok: false,
      results: [],
      errorCode: 'search-failed',
      warnings: ['等待搜索结果页就绪超时'],
    }));
    const def = createSearchTool(provider);
    const r = await def.executor({ id: 'c1', args: { query: 'q' } }, ctxFor(provider), signal);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('search-failed');
    expect(r.content).toContain('搜索失败');
    expect(r.content).toContain('等待搜索结果页就绪超时');
  });

  it('provider aborted / 外层信号中止 → ok:false + execution-failed（取消语义由外层归一）', async () => {
    const provider = fakeProvider(async () => ({ ok: false, results: [], errorCode: 'aborted' }));
    const def = createSearchTool(provider);
    const r = await def.executor({ id: 'c1', args: { query: 'q' } }, ctxFor(provider), signal);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('execution-failed');
    expect(r.content).toContain('取消');
  });

  it('合法空结果 → ok:true + 「未找到搜索结果」明确提示（非错误）', async () => {
    const provider = fakeProvider(async () => ({ ok: true, results: [] }));
    const def = createSearchTool(provider);
    const r = await def.executor({ id: 'c1', args: { query: 'q' } }, ctxFor(provider), signal);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('未找到搜索结果');
  });
});

describe('search.web 经 ToolExecutor 管线（校验→权限→审计→截断）', () => {
  let audits: AuditEntry[];

  beforeEach(() => {
    audits = [];
    resetToolRegistry();
    registerTool(
      createSearchTool(
        fakeProvider(async () => ({
          ok: true,
          results: [makeResult({ title: '管线结果', url: 'https://pipeline.example/' })],
        })),
      ),
    );
  });

  function makeExecutor(): { executor: ToolExecutor; ctx: ToolExecutionContext } {
    return {
      executor: new ToolExecutor(new ConfirmManager(), (entry) => {
        audits.push(entry);
      }),
      ctx: { browser: fakeBrowserStub(), runId: 'test-run' },
    };
  }

  it('L0 自动执行：decision=auto，每次调用恰好一条审计，审计含 query 摘要', async () => {
    const { executor, ctx } = makeExecutor();
    const r = await executor.execute(
      { id: 't1', name: 'search.web', arguments: '{"query":"electron 文档"}' },
      ctx,
      signal,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('管线结果');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tool: 'search.web', decision: 'auto', ok: true });
    expect(audits[0].argsSummary).toContain('query:electron 文档');
  });

  it('query 校验：空串/超 500 字符/缺失/未知键/类型不符 → invalid-args，Provider 零调用', async () => {
    const { executor, ctx } = makeExecutor();
    const cases: Array<{ args: string; expectOk: boolean }> = [
      { args: '{"query":""}', expectOk: false },
      { args: '{"query":"   "}', expectOk: false },
      { args: `{"query":"${'x'.repeat(501)}"}`, expectOk: false },
      { args: '{}', expectOk: false },
      { args: '{"query":"q","tabId":"00000000-0000-4000-8000-000000000000"}', expectOk: false },
      { args: '{"query":42}', expectOk: false },
    ];
    for (const c of cases) {
      const r = await executor.execute(
        { id: 't', name: 'search.web', arguments: c.args },
        ctx,
        signal,
      );
      expect(r.ok, c.args.slice(0, 40)).toBe(false);
      expect(r.errorCode, c.args.slice(0, 40)).toBe('invalid-args');
    }
    expect(audits).toHaveLength(cases.length);
    for (const a of audits) expect(a.decision).toBe('invalid');
  });

  it('query 恰好 500 字符通过校验；结果超 4000 字符经管线确定性截断 + 截断 warning', async () => {
    const { executor, ctx } = makeExecutor();
    const ok500 = await executor.execute(
      { id: 't1', name: 'search.web', arguments: `{"query":"${'q'.repeat(500)}"}` },
      ctx,
      signal,
    );
    expect(ok500.ok).toBe(true);
    // 审计参数摘要：search.web 查询串全量记录（T-03 外发审查可追溯，决议 #32）
    expect(audits[audits.length - 1].argsSummary).toContain('q'.repeat(500));

    // 大量长结果 → 序列化内容远超 4000 → 确定性截断（含标记）+ warning
    const many = fakeProvider(async () => ({
      ok: true,
      results: Array.from({ length: 60 }, (_, i) =>
        makeResult({
          title: `结果 ${i}：${'很长的标题内容'.repeat(8)}`,
          url: `https://example.com/page/${i}`,
        }),
      ),
    }));
    resetToolRegistry();
    registerTool(createSearchTool(many));
    const r = await executor.execute(
      { id: 't2', name: 'search.web', arguments: '{"query":"long"}' },
      ctx,
      signal,
    );
    expect(r.ok).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(SEARCH_TOOL_CONTENT_MAX);
    expect(r.content).toContain('…[已截断]');
    expect(r.warnings?.some((w) => w.includes('截断'))).toBe(true);
  });
});
