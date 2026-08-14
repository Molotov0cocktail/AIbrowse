// A4 search.web 工具：executor 只经注入 SearchProvider 执行（不 import Electron、
// 不触碰 BrowserController——搜索走独立 Provider 通道）；ctx.searchProvider 优先于
// 注册注入（冒烟受控夹具与 A5 AgentLoop 的注入点，设计 §4.1「browser 能力 + search」
// 的 search 落点）。契约源：doc/stage3/detailed-design.md §4.2/§6/§8.4 +
// threat-model §3.2/§3.4（外发审查：查询串全量进入审计与可见性 UI——审计层记录）。
//
// 结果序列化：标题/网址/摘要纯文本行——SearchProvider 返回的内容在后续阶段一律属于
// 不可信 Tool Result（A5 UNTRUSTED_TOOL_RESULT 块），本层不赋予任何指令性或富文本
// 特权；不暴露 documentId/内部 tabId/页面快照正文/调试字段。错误诚实映射闭合枚举：
// provider 失败 → search-failed（工具错误永不以 ok:true 出现）；aborted（provider 或
// 外层信号）由本层归一为 execution-failed（ToolResultErrorCode 闭合枚举无 aborted，
// 取消语义由 A5 循环层结构化输出——与既有 runTool 预检取消路径同语义）。
import type { SearchProvider, SearchResult } from '../search/search-provider';
import type { ToolDefinition, ToolExecutorFn } from './tool-types';

export const SEARCH_TOOL_NAME = 'search.web';

// 工具名/description/schema 为程序常量（模型/网页无通道修改，threat-model T-06）
export const SEARCH_TOOL_DESCRIPTION =
  '搜索网页（Bing 搜索结果页），返回最多 10 条结果（标题/网址/摘要）';

// 结果序列化（纯文本行，确定性）：空结果明确提示（非错误）
export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return '未找到搜索结果';
  const lines = [`共 ${results.length} 条搜索结果：`];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   网址：${r.url}`);
    if (r.snippet !== '') lines.push(`   摘要：${r.snippet}`);
  });
  return lines.join('\n');
}

// 装配工厂：searchProvider 为注册注入（生产装配传 BingSearchProvider）；
// executor 执行时 ctx.searchProvider 优先（冒烟受控夹具/A5 注入点）。
export function createSearchTool(searchProvider: SearchProvider): ToolDefinition {
  const executor: ToolExecutorFn = async ({ id, args }, ctx, signal) => {
    const provider = ctx.searchProvider ?? searchProvider;
    const res = await provider.search(String(args.query), signal); // 校验层已保证 string
    if (!res.ok) {
      if (res.errorCode === 'aborted' || signal.aborted) {
        return {
          toolCallId: id,
          ok: false,
          content: '搜索已取消（任务中止）',
          errorCode: 'execution-failed',
        };
      }
      const reason =
        res.warnings !== undefined && res.warnings.length > 0 ? res.warnings[0] : '搜索引擎无响应';
      return {
        toolCallId: id,
        ok: false,
        content: `搜索失败：${reason}`,
        errorCode: 'search-failed',
      };
    }
    const warnings =
      res.warnings !== undefined && res.warnings.length > 0 ? res.warnings : undefined;
    return {
      toolCallId: id,
      ok: true,
      content: formatSearchResults(res.results),
      ...(warnings !== undefined ? { warnings } : {}),
    };
  };
  return {
    name: SEARCH_TOOL_NAME,
    description: SEARCH_TOOL_DESCRIPTION,
    parameters: {
      properties: {
        query: { type: 'string', description: '搜索关键词（1–500 字符）' },
      },
      required: ['query'],
    },
    paramRules: { query: { nonEmpty: true } }, // 长度上限走注册表字符串默认 500（同源）
    baseRisk: 0, // §7.1 矩阵：search.web L0 自动（查询串全量审计+可见）
    executor,
  };
}
