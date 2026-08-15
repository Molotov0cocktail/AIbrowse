// A2 首批 8 个只读/导航工具：executor 只经构造注入的 BrowserController 接口执行
// （不 import Electron、不直连 webContents——Agent 架构纪律）；browser_read 每次
// 实时采集 getPageSnapshot（禁止复用缓存快照——Second_stage 防串页契约的 Agent 侧延续）。
// 契约源：doc/stage3/detailed-design.md §4.2/§8.4；BrowserController 失败语义
// （false/null）安全映射为 execution-failed（管线层归一，不抛异常）。
import type { PageSnapshot, TabInfo } from '../../../shared/types/browser';
import { TRUNCATION_MARK } from '../context-budget';
import { logWarn } from '../../logger';
import { READ_TOOL_CONTENT_MAX } from './tool-executor';
import type { ToolDefinition, ToolExecutorFn, ToolExecutionContext } from './tool-types';

// 章节条目上限（§4.2 read 序列化：fillWebContentSections 风格、独立 budget）
const READ_SECTION_LIMITS = {
  headings: 20,
  tables: 5,
  tableRows: 10,
  links: 30,
  buttons: 20,
  inputs: 20,
} as const;

function ok(
  toolCallId: string,
  content: string,
  warnings?: string[],
): {
  toolCallId: string;
  ok: true;
  content: string;
  warnings?: string[];
} {
  return warnings === undefined
    ? { toolCallId, ok: true, content }
    : { toolCallId, ok: true, content, warnings };
}

function fail(
  toolCallId: string,
  content: string,
): {
  toolCallId: string;
  ok: false;
  content: string;
  errorCode: 'execution-failed';
} {
  return { toolCallId, ok: false, content, errorCode: 'execution-failed' };
}

// tabId 缺省语义在工具层解析（§5.3 注）：活动 Tab id 由 executor 注入
async function resolveTabId(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string | null> {
  if (typeof args.tabId === 'string') return args.tabId;
  return (await ctx.browser.getActiveTab())?.id ?? null;
}

function tabLine(t: TabInfo): string {
  const title = t.title !== '' ? `「${t.title}」` : '（无标题）';
  return `- ${t.id} ${t.active ? '【活动】' : ''}${title} ${t.url} (${t.state})`;
}

// read 快照章节化序列化：固定顺序（可见文本→标题→表格→链接→按钮→输入）+ 各节条目上限
// + 总预算确定性截断（含 elementId，供 A3 find/click 后续引用）。纯函数零环境依赖。
export function serializeSnapshotForTool(
  snapshot: PageSnapshot,
  budget: number,
): { content: string; warnings: string[] } {
  const lines: string[] = [];
  lines.push(`页面「${snapshot.title !== '' ? snapshot.title : '（无标题）'}」${snapshot.url}`);
  if (snapshot.visibleText !== undefined && snapshot.visibleText !== '') {
    lines.push(`可见文本：${snapshot.visibleText}`);
  }
  if (snapshot.headings.length > 0) {
    const shown = snapshot.headings.slice(0, READ_SECTION_LIMITS.headings);
    lines.push(`标题（${shown.length}/${snapshot.headings.length} 条）：`);
    for (const h of shown) lines.push(`- h${h.level} ${h.text}`);
  }
  if (snapshot.tables !== undefined && snapshot.tables.length > 0) {
    const shown = snapshot.tables.slice(0, READ_SECTION_LIMITS.tables);
    lines.push(`表格（${shown.length}/${snapshot.tables.length} 个）：`);
    shown.forEach((table, i) => {
      lines.push(`表 ${i + 1}：${table.headers.join(' | ')}`);
      for (const row of table.rows.slice(0, READ_SECTION_LIMITS.tableRows)) {
        lines.push(`  ${row.join(' | ')}`);
      }
    });
  }
  if (snapshot.links.length > 0) {
    const shown = snapshot.links.slice(0, READ_SECTION_LIMITS.links);
    lines.push(`链接（${shown.length}/${snapshot.links.length} 条）：`);
    for (const link of shown) lines.push(`- [${link.id}] ${link.text}（${link.href}）`);
  }
  if (snapshot.buttons.length > 0) {
    const shown = snapshot.buttons.slice(0, READ_SECTION_LIMITS.buttons);
    lines.push(`按钮（${shown.length}/${snapshot.buttons.length} 条）：`);
    for (const b of shown) lines.push(`- [${b.id}] ${b.text}`);
  }
  if (snapshot.inputs !== undefined && snapshot.inputs.length > 0) {
    const shown = snapshot.inputs.slice(0, READ_SECTION_LIMITS.inputs);
    lines.push(`输入（${shown.length}/${snapshot.inputs.length} 条）：`);
    for (const input of shown) {
      const extra =
        input.placeholder !== undefined && input.placeholder !== ''
          ? ` placeholder=${input.placeholder}`
          : '';
      lines.push(`- [${input.id}] type=${input.type}${extra}`);
    }
  }
  const joined = lines.join('\n');
  if (joined.length <= budget) return { content: joined, warnings: [] };
  return {
    content: joined.slice(0, budget - TRUNCATION_MARK.length) + TRUNCATION_MARK,
    warnings: ['工具结果超过长度预算，已确定性截断'],
  };
}

const getTabs: ToolExecutorFn = async ({ id }, ctx) => {
  const tabs = await ctx.browser.getTabs();
  if (tabs.length === 0) return ok(id, '当前没有标签页');
  return ok(id, `共 ${tabs.length} 个标签页：\n${tabs.map(tabLine).join('\n')}`);
};

const getActiveTab: ToolExecutorFn = async ({ id }, ctx) => {
  const tab = await ctx.browser.getActiveTab();
  if (tab === null) return ok(id, '当前没有活动标签页');
  return ok(id, tabLine(tab));
};

const read: ToolExecutorFn = async ({ id, args }, ctx) => {
  const tabId = await resolveTabId(args, ctx);
  if (tabId === null) return fail(id, '没有活动标签页，无法读取页面');
  const snapshot = await ctx.browser.getPageSnapshot(tabId); // 实时采集，不复用缓存快照
  if (snapshot === null) return fail(id, '页面快照不可用（标签页不存在或页面不可读）');
  ctx.recordSnapshot?.(tabId, snapshot); // A3：登记点击语义来源（世代随快照绑定；未接线不影响）
  const serialized = serializeSnapshotForTool(snapshot, READ_TOOL_CONTENT_MAX);
  return ok(id, serialized.content, serialized.warnings);
};

const open: ToolExecutorFn = async ({ id, args }, ctx) => {
  const url = String(args.url); // 校验已保证 string；scheme 已由权限层 gate（L3）
  // B6（决议 #79/#81）：执行后经 ctx.sourceUsage.onBrowserOpen 与同一 run 的
  // source_search 结构化命中比对写 usage（成功 → reachable、执行失败 → unreachable）。
  // 无关 URL/先 open 后 search/跨 run/终态后（hints 已清空）→ 零写入；桥内部对
  // 写入失败安全 no-op——本回调绝不改变 ToolResult（Task Tab 保留语义不变）。
  try {
    const tab = await ctx.browser.createTab(url);
    notifyOpen(ctx, id, url, true);
    // 任务 Tab 保留（用户可见结果），由用户关闭（决议 #11/#28）
    return ok(id, `已打开新标签页：${tabLine(tab)}`);
  } catch (err) {
    notifyOpen(ctx, id, url, false);
    throw err; // 管线归一 execution-failed（审计恰好一条保持）
  }
};

// B6（决议 #79/#81）：usage 比对回调的纵深防御——桥契约本身不抛异常（写入失败在
// tracker 内部安全 no-op），此处再兜底：即使装配异常也不得改变 browser_open 的
// ToolResult/权限/Agent 终态（脱敏告警仅含 toolCallId，无 URL/note/query）。
function notifyOpen(ctx: ToolExecutionContext, toolCallId: string, url: string, ok: boolean): void {
  try {
    ctx.sourceUsage?.onBrowserOpen(url, ok);
  } catch (err) {
    logWarn(
      'browser-tools',
      `sourceUsage 回调异常（已忽略，不影响工具结果；toolCallId=${toolCallId}）`,
      err,
    );
  }
}

const navigate: ToolExecutorFn = async ({ id, args }, ctx) => {
  const tabId = await resolveTabId(args, ctx);
  if (tabId === null) return fail(id, '没有活动标签页，无法导航');
  const url = String(args.url);
  const done = await ctx.browser.navigate(tabId, url);
  return done ? ok(id, `已导航到：${url}`) : fail(id, '导航失败（标签页不存在或不可导航）');
};

const back: ToolExecutorFn = async ({ id, args }, ctx) => {
  const tabId = await resolveTabId(args, ctx);
  if (tabId === null) return fail(id, '没有活动标签页，无法后退');
  return (await ctx.browser.goBack(tabId))
    ? ok(id, '已后退')
    : fail(id, '后退失败（标签页不存在或无法后退）');
};

const forward: ToolExecutorFn = async ({ id, args }, ctx) => {
  const tabId = await resolveTabId(args, ctx);
  if (tabId === null) return fail(id, '没有活动标签页，无法前进');
  return (await ctx.browser.goForward(tabId))
    ? ok(id, '已前进')
    : fail(id, '前进失败（标签页不存在或无法前进）');
};

const reload: ToolExecutorFn = async ({ id, args }, ctx) => {
  const tabId = await resolveTabId(args, ctx);
  if (tabId === null) return fail(id, '没有活动标签页，无法刷新');
  return (await ctx.browser.reload(tabId))
    ? ok(id, '已刷新')
    : fail(id, '刷新失败（标签页不存在或不可刷新）');
};

// A2 首批 8 个只读/导航工具（§4.2）；A3 增 find/scroll/click/fill、A4 增 search_web。
// baseRisk 与 permission-policy TOOL_BASE_RISK 矩阵一致（单测交叉断言防漂移）。
export const BROWSER_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'browser_get_tabs',
    description: '列出所有标签页（id/标题/URL/是否活动/加载状态）',
    parameters: { properties: {}, required: [] },
    baseRisk: 0,
    executor: getTabs,
  },
  {
    name: 'browser_get_active_tab',
    description: '获取当前活动标签页信息',
    parameters: { properties: {}, required: [] },
    baseRisk: 0,
    executor: getActiveTab,
  },
  {
    name: 'browser_read',
    description: '实时读取标签页内容快照（缺省活动标签页；页面刷新后需重新读取）',
    parameters: {
      properties: { tabId: { type: 'string', description: '标签页 id（可选，缺省为活动标签页）' } },
      required: [],
    },
    baseRisk: 0,
    executor: read,
  },
  {
    name: 'browser_open',
    description: '在新标签页打开 http/https 网页（标签页保留，由用户关闭）',
    parameters: {
      properties: { url: { type: 'string', description: 'http/https 地址' } },
      required: ['url'],
    },
    baseRisk: 1,
    executor: open,
  },
  {
    name: 'browser_navigate',
    description: '导航指定标签页到新地址（http/https，缺省活动标签页）',
    parameters: {
      properties: {
        url: { type: 'string', description: 'http/https 地址' },
        tabId: { type: 'string', description: '标签页 id（可选，缺省为活动标签页）' },
      },
      required: ['url'],
    },
    baseRisk: 1,
    executor: navigate,
  },
  {
    name: 'browser_back',
    description: '后退指定标签页（缺省活动标签页）',
    parameters: {
      properties: { tabId: { type: 'string', description: '标签页 id（可选，缺省为活动标签页）' } },
      required: [],
    },
    baseRisk: 1,
    executor: back,
  },
  {
    name: 'browser_forward',
    description: '前进指定标签页（缺省活动标签页）',
    parameters: {
      properties: { tabId: { type: 'string', description: '标签页 id（可选，缺省为活动标签页）' } },
      required: [],
    },
    baseRisk: 1,
    executor: forward,
  },
  {
    name: 'browser_reload',
    description: '刷新指定标签页（缺省活动标签页）',
    parameters: {
      properties: { tabId: { type: 'string', description: '标签页 id（可选，缺省为活动标签页）' } },
      required: [],
    },
    baseRisk: 1,
    executor: reload,
  },
];
