// D2 regression tests: ToolRegistry 17 工具集合与既有 Research 类型契约零回归
// （AGENTS.md §5.3/§5.5、threat-model §3.3）。D2 只改 shared/types/watch.ts 与
// shared/watch/*，不得触碰 Browser/Sources/Research/Agent——本文件对产品装配同构的
// 17 工具注册表与 Research 六工具编译期集合做回归断言（与 research-tools.test.ts
// 同构的最小装配，不 import 生产 index.ts）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listTools, registerTool, resetToolRegistry } from '../../main/ai/tools/tool-registry';
import { BROWSER_TOOL_DEFINITIONS } from '../../main/ai/tools/browser-tools';
import { INTERACTION_TOOL_DEFINITIONS } from '../../main/ai/tools/interaction-tools';
import { createSearchTool } from '../../main/ai/tools/search-tool';
import { createSourceTools } from '../../main/sources/tools/source-tools';
import { RESEARCH_TOOL_NAMES, MAX_SELECTED_SOURCES } from '../types/research';

const fakeSearchProvider = {
  id: 'fake',
  async search(): Promise<{ ok: boolean; results: never[] }> {
    return { ok: true, results: [] };
  },
};

const EXPECTED_17_TOOLS = [
  'browser_back',
  'browser_click',
  'browser_fill',
  'browser_find',
  'browser_forward',
  'browser_get_active_tab',
  'browser_get_tabs',
  'browser_navigate',
  'browser_open',
  'browser_read',
  'browser_reload',
  'browser_scroll',
  'search_web',
  'source_apply_changes',
  'source_get',
  'source_list',
  'source_search',
];

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

describe('ToolRegistry 17 工具集合回归（D2 零回归）', () => {
  it('注册表恰为 17 个工具（8 浏览器 + 4 交互 + 1 搜索 + 4 Source）', () => {
    const tools = listTools();
    expect(tools).toHaveLength(17);
    expect(tools.map((t) => t.function.name).sort()).toEqual([...EXPECTED_17_TOOLS].sort());
  });

  it('Research 六工具编译期集合全部 ∈ 注册表 17 工具（顺序固定）', () => {
    expect(RESEARCH_TOOL_NAMES).toEqual([
      'browser_open',
      'browser_read',
      'search_web',
      'source_search',
      'source_list',
      'source_get',
    ]);
    const names = new Set(listTools().map((t) => t.function.name));
    for (const name of RESEARCH_TOOL_NAMES) {
      expect(names.has(name), `注册表应含 ${name}`).toBe(true);
    }
  });

  it('Research 类型常量保持（派生常量非魔法数字回归）', () => {
    expect(MAX_SELECTED_SOURCES).toBe(8);
    expect(RESEARCH_TOOL_NAMES.length).toBe(6);
  });
});
