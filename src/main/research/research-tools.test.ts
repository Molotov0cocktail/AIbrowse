// C5 research-tools tests (adjudication #132): the compile-time six-tool
// set — name/wire/parameter-shape cross-assertion against the registry
// (runtime never imports the registry), Research-owned descriptions and
// executors, strict allowlist argument validation (safe returns, no throws),
// and the bounded safe tool-result serializer (never into logs/UI/persistence).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTool, registerTool, resetToolRegistry } from '../ai/tools/tool-registry';
import { BROWSER_TOOL_DEFINITIONS } from '../ai/tools/browser-tools';
import { INTERACTION_TOOL_DEFINITIONS } from '../ai/tools/interaction-tools';
import { createSearchTool } from '../ai/tools/search-tool';
import { createSourceTools } from '../sources/tools/source-tools';
import {
  RESEARCH_TOOL_NAMES,
  RESEARCH_TOOL_RESULT_CONTENT_MAX,
  type ResearchToolName,
} from '../../shared/types/research';
import {
  RESEARCH_TOOL_DEFINITIONS,
  listResearchTools,
  serializeResearchToolResult,
  validateResearchToolArgs,
} from './research-tools';

// 注册表 17 工具（测试设施：与产品装配同构的最小装配——不 import 生产 index.ts）
const fakeSearchProvider = {
  id: 'fake',
  async search(): Promise<{ ok: boolean; results: never[] }> {
    return { ok: true, results: [] };
  },
};

beforeAll(() => {
  resetToolRegistry();
  for (const def of BROWSER_TOOL_DEFINITIONS) registerTool(def);
  for (const def of INTERACTION_TOOL_DEFINITIONS) registerTool(def);
  registerTool(createSearchTool(fakeSearchProvider));
  for (const def of createSourceTools(null)) registerTool(def);
});

afterAll(() => {
  resetToolRegistry();
});

// 注册表交叉断言（决议 #132(1)）：名称存在 + 参数基础形状逐项一致
describe('六工具集合与注册表交叉断言（决议 #132(1)）', () => {
  it('RESEARCH_TOOL_NAMES 恰为六个编译期固定名称（顺序固定）', () => {
    expect(RESEARCH_TOOL_NAMES).toEqual([
      'browser_open',
      'browser_read',
      'search_web',
      'source_search',
      'source_list',
      'source_get',
    ]);
  });

  it('每个 Research 工具名都在注册表 17 工具中', () => {
    for (const name of RESEARCH_TOOL_NAMES) {
      expect(getTool(name), `注册表应存在 ${name}`).not.toBeNull();
    }
  });

  it('Research 参数基础形状与注册表同名工具一致（属性名/类型/required）', () => {
    for (const name of RESEARCH_TOOL_NAMES) {
      const registered = getTool(name);
      expect(registered).not.toBeNull();
      if (registered === null) return;
      const research = RESEARCH_TOOL_DEFINITIONS.find((d) => d.name === name);
      expect(research).toBeDefined();
      if (research === undefined) return;
      // 基础形状 = 属性名 + 类型（description 为 Research 专属——剥离后比较）
      const strip = (props: Record<string, unknown>): Record<string, unknown> =>
        Object.fromEntries(
          Object.entries(props).map(([k, v]) => [
            k,
            { ...(v as Record<string, unknown>), description: undefined },
          ]),
        );
      expect(strip(research.parameters.properties)).toEqual(
        strip(registered.parameters.properties),
      );
      expect(research.parameters.required).toEqual(registered.parameters.required);
    }
  });

  it('wire 名称全部通过 TOOL_NAME_PATTERN（决议 #35 双闸门语义）', () => {
    for (const name of RESEARCH_TOOL_NAMES) {
      expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  });

  it('listResearchTools 序列化为 ProviderTool 形状（每次新对象、名称按序恒等）', () => {
    const tools = listResearchTools();
    expect(tools.map((t) => t.function.name)).toEqual([...RESEARCH_TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.type).toBe('function');
      expect(typeof tool.function.description).toBe('string');
      expect(tool.function.parameters.type).toBe('object');
    }
    const again = listResearchTools();
    expect(again).not.toBe(tools);
    expect(again[0]).not.toBe(tools[0]);
  });

  it('description 为 Research 专属（与注册表同名工具不同——语义已改）', () => {
    for (const name of RESEARCH_TOOL_NAMES) {
      const registered = getTool(name);
      const research = RESEARCH_TOOL_DEFINITIONS.find((d) => d.name === name);
      if (registered === null || research === undefined) continue;
      expect(research.description).not.toBe(registered.description);
    }
  });

  it('零交互/写工具混入：六工具不含 click/fill/scroll/find/navigate/apply_changes', () => {
    for (const banned of [
      'browser_navigate',
      'browser_back',
      'browser_forward',
      'browser_reload',
      'get_tabs',
      'get_active_tab',
      'find',
      'scroll',
      'click',
      'fill',
      'source_apply_changes',
    ]) {
      expect(RESEARCH_TOOL_NAMES).not.toContain(banned);
    }
  });
});

// 参数校验（Research 专属白名单；安全返回不抛异常）
describe('validateResearchToolArgs：白名单矩阵（决议 #132(3)）', () => {
  it('browser_open：url 必填字符串 ≤2048（http/https 形状由执行层候选匹配承担）', () => {
    expect(validateResearchToolArgs('browser_open', '{"url":"https://a.example/"}').ok).toBe(true);
    for (const bad of ['{}', '{"url":42}', '{"url":""}', '{"url":"https://a.example/","x":1}']) {
      const r = validateResearchToolArgs('browser_open', bad);
      expect(r.ok).toBe(false);
    }
    const r = validateResearchToolArgs('browser_open', `{"url":"${'a'.repeat(3000)}"}`);
    expect(r.ok).toBe(false);
  });

  it('browser_read：tabId 可选字符串', () => {
    expect(validateResearchToolArgs('browser_read', '{}').ok).toBe(true);
    expect(validateResearchToolArgs('browser_read', '{"tabId":"t1"}').ok).toBe(true);
    expect(validateResearchToolArgs('browser_read', '{"tabId":42}').ok).toBe(false);
    expect(validateResearchToolArgs('browser_read', '{"x":1}').ok).toBe(false);
  });

  it('search_web：query 必填非空 ≤500', () => {
    expect(validateResearchToolArgs('search_web', '{"query":"模型对比"}').ok).toBe(true);
    for (const bad of ['{}', '{"query":""}', '{"query":42}']) {
      expect(validateResearchToolArgs('search_web', bad).ok).toBe(false);
    }
    expect(validateResearchToolArgs('search_web', `{"query":"${'长'.repeat(501)}"}`).ok).toBe(
      false,
    );
  });

  it('source_search：query 必填非空 ≤500（注册表形状：仅 query 属性）', () => {
    expect(validateResearchToolArgs('source_search', '{"query":"AI Benchmark"}').ok).toBe(true);
    expect(validateResearchToolArgs('source_search', '{"query":"q","limit":5}').ok).toBe(false);
    expect(validateResearchToolArgs('source_search', '{}').ok).toBe(false);
  });

  it('source_list：page 必填整数 ≥0；pageSize 1–20；groupId 可选串；enabledOnly 仅 true/缺省（Research 硬编码 true）', () => {
    expect(validateResearchToolArgs('source_list', '{"page":0}').ok).toBe(true);
    expect(validateResearchToolArgs('source_list', '{"page":0,"pageSize":20}').ok).toBe(true);
    expect(
      validateResearchToolArgs(
        'source_list',
        '{"page":0,"groupId":"11111111-1111-4111-8111-111111111111"}',
      ).ok,
    ).toBe(true);
    expect(validateResearchToolArgs('source_list', '{"page":0,"enabledOnly":true}').ok).toBe(true);
    // Research 专属收紧：模型不得请求 disabled 条目
    expect(validateResearchToolArgs('source_list', '{"page":0,"enabledOnly":false}').ok).toBe(
      false,
    );
    for (const bad of [
      '{}',
      '{"page":-1}',
      '{"page":1.5}',
      '{"page":"0"}',
      '{"page":0,"pageSize":21}',
    ]) {
      expect(validateResearchToolArgs('source_list', bad).ok).toBe(false);
    }
  });

  it('source_get：sourceId 必填 UUID 形状', () => {
    expect(
      validateResearchToolArgs('source_get', '{"sourceId":"11111111-1111-4111-8111-111111111111"}')
        .ok,
    ).toBe(true);
    for (const bad of ['{}', '{"sourceId":"not-a-uuid"}', '{"sourceId":42}']) {
      expect(validateResearchToolArgs('source_get', bad).ok).toBe(false);
    }
  });

  it('未知工具/子集外工具/非法 JSON/非对象 → 安全失败不抛异常', () => {
    expect(validateResearchToolArgs('browser_navigate', '{"url":"https://a.example/"}').ok).toBe(
      false,
    );
    expect(validateResearchToolArgs('click', '{}').ok).toBe(false);
    expect(validateResearchToolArgs('source_apply_changes', '{"ops":[]}').ok).toBe(false);
    expect(validateResearchToolArgs('browser_open', 'not-json').ok).toBe(false);
    expect(validateResearchToolArgs('browser_open', '[1,2]').ok).toBe(false);
    // 任意垃圾输入零 throw（FT-17）
    for (const junk of [null, undefined, 42, {}, '"str"']) {
      const r = validateResearchToolArgs(junk as unknown as string, junk as unknown as string);
      expect(r.ok).toBe(false);
    }
  });
});

// 安全工具结果序列化（决议 #132(6)）
describe('serializeResearchToolResult：有界安全序列化', () => {
  it('成功结果结构化 JSON 形状（toolCallId 关联由调用方拼接）', () => {
    const out = serializeResearchToolResult({ ok: true, content: '读取成功' });
    expect(JSON.parse(out)).toEqual({ ok: true, content: '读取成功' });
  });

  it('失败结果携带闭合错误码', () => {
    const out = serializeResearchToolResult({ ok: false, error: 'unknown-tool' });
    expect(JSON.parse(out)).toEqual({ ok: false, error: 'unknown-tool' });
  });

  it('超长内容确定性截断 + 标记（总长 ≤ RESEARCH_TOOL_RESULT_CONTENT_MAX）', () => {
    const long = '长'.repeat(RESEARCH_TOOL_RESULT_CONTENT_MAX + 500);
    const out = serializeResearchToolResult({ ok: true, content: long });
    expect(out.length).toBeLessThanOrEqual(RESEARCH_TOOL_RESULT_CONTENT_MAX + 200);
    const parsed = JSON.parse(out) as { ok: boolean; content: string };
    expect(parsed.content.length).toBeLessThanOrEqual(RESEARCH_TOOL_RESULT_CONTENT_MAX);
    expect(parsed.content).toContain('…');
  });

  it('任意垃圾输入不抛异常（非串/undefined）', () => {
    expect(() =>
      serializeResearchToolResult({ ok: true, content: undefined as unknown as string }),
    ).not.toThrow();
  });
});

// 类型收尾：ResearchToolName 与常量集合一致
describe('ResearchToolName 类型契约', () => {
  it('RESEARCH_TOOL_DEFINITIONS 名称集合与常量一一对应', () => {
    const names = RESEARCH_TOOL_DEFINITIONS.map((d) => d.name);
    expect([...names].sort()).toEqual([...RESEARCH_TOOL_NAMES].sort());
    const unique = new Set<ResearchToolName>(names);
    expect(unique.size).toBe(6);
  });
});
