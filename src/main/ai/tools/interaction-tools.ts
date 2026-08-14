// A3 四个交互工具（find/scroll/click/fill）：executor 只经构造注入的 BrowserController
// 接口执行（不 import Electron、不直连 webContents——Agent 架构纪律）；find 每次实时
// 采集快照做确定性匹配（无命中是 ok 空结果，非错误）。
// 安全契约（threat-model §3.2/§3.3）：
// - click/fill 的 allowedKind 与 documentId 只能来自 ToolExecutor 权限决策派生的执行参数
//   （call.derived——classifyClickTarget 单一事实源派生、语义 binding 世代随附）；
//   executor 不自行分类，无派生参数时拒绝执行（fail-closed），模型与网页不可写；
// - fill 的结果内容只含标签/类型/长度摘要，输入原文零外泄（审计层另有 len=N 断言）；
// - find/read 成功时经 ctx.recordSnapshot 登记点击语义来源（世代随快照绑定）。
// 契约源：doc/stage3/detailed-design.md §4.2/§5 + threat-model §3.2/§3.3。
import type { PageSnapshot } from '../../../shared/types/browser';
import type { ToolResultErrorCode } from '../../../shared/types/agent';
import type { ToolDefinition, ToolExecutorFn, ToolExecutionContext } from './tool-types';

const FIND_TEXT_MAX = 200;
const FILL_TEXT_MAX = 2000;
const SCROLL_LIMIT = 50000;
// find 命中摘要：围绕关键词的节选（确定性，≤80 字符）
const FIND_SNIPPET_MAX = 80;
// 命中集合条目上限（防单条结果爆炸；超出截断计数，由结果预算二次截断兜底）
const FIND_HITS_MAX = 200;

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
  errorCode: ToolResultErrorCode,
): {
  toolCallId: string;
  ok: false;
  content: string;
  errorCode: ToolResultErrorCode;
} {
  return { toolCallId, ok: false, content, errorCode };
}

// tabId 缺省语义在工具层解析（§5.3 注）：活动 Tab id 由 executor 注入
async function resolveTabId(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string | null> {
  if (typeof args.tabId === 'string') return args.tabId;
  return (await ctx.browser.getActiveTab())?.id ?? null;
}

// ---------- find：快照确定性匹配（纯函数，可单测） ----------

export type FindSection = 'visibleText' | 'headings' | 'links' | 'buttons' | 'inputs';

export interface FindHit {
  section: FindSection;
  text: string; // 命中文本/节选摘要（确定性截断）
  id?: string; // 有 elementId 的章节（links/buttons/inputs）
  extra?: string; // 章节附加信息（links → href）
}

// 围绕首次出现的确定性节选：前缀/后缀省略号标记（避免把整个 visibleText 带进结果）
function snippetAround(text: string, keyword: string): string {
  const index = text.indexOf(keyword);
  if (index < 0) return text.slice(0, FIND_SNIPPET_MAX);
  const start = Math.max(0, index - Math.floor((FIND_SNIPPET_MAX - keyword.length) / 2));
  const piece = text.slice(start, start + FIND_SNIPPET_MAX);
  return `${start > 0 ? '…' : ''}${piece}${start + FIND_SNIPPET_MAX < text.length ? '…' : ''}`;
}

export function findMatches(snapshot: PageSnapshot, text: string): FindHit[] {
  const hits: FindHit[] = [];
  const push = (hit: FindHit): void => {
    if (hits.length < FIND_HITS_MAX) hits.push(hit);
  };
  // 固定章节顺序：visibleText → headings → links → buttons → inputs（确定性）
  if (snapshot.visibleText !== undefined && snapshot.visibleText.includes(text)) {
    push({ section: 'visibleText', text: snippetAround(snapshot.visibleText, text) });
  }
  for (const h of snapshot.headings) {
    if (h.text.includes(text)) push({ section: 'headings', text: h.text });
  }
  for (const link of snapshot.links) {
    if (link.text.includes(text))
      push({ section: 'links', id: link.id, text: link.text, extra: link.href });
  }
  for (const b of snapshot.buttons) {
    if (b.text.includes(text)) push({ section: 'buttons', id: b.id, text: b.text });
  }
  for (const input of snapshot.inputs ?? []) {
    // 匹配 type/placeholder/value 文本（值不进结果，只报命中位置）
    const haystack = `${input.type} ${input.placeholder ?? ''} ${input.value ?? ''}`;
    if (haystack.includes(text)) {
      const label =
        input.placeholder !== undefined && input.placeholder !== ''
          ? `type=${input.type} placeholder=${input.placeholder}`
          : `type=${input.type}`;
      push({ section: 'inputs', id: input.id, text: label });
    }
  }
  return hits;
}

const find: ToolExecutorFn = async ({ id, args }, ctx) => {
  const text = String(args.text);
  const tabId = await resolveTabId(args, ctx);
  if (tabId === null) return fail(id, '没有活动标签页，无法查找', 'execution-failed');
  const snapshot = await ctx.browser.getPageSnapshot(tabId); // 每次实时采集（防串页契约）
  if (snapshot === null)
    return fail(id, '页面快照不可用（标签页不存在或页面不可读）', 'execution-failed');
  ctx.recordSnapshot?.(tabId, snapshot); // 点击语义来源登记（与 read 同源）
  const hits = findMatches(snapshot, text);
  if (hits.length === 0) {
    return ok(id, `未找到「${text}」的匹配（空结果）`);
  }
  const sectionLabel: Record<FindSection, string> = {
    visibleText: '可见文本',
    headings: '标题',
    links: '链接',
    buttons: '按钮',
    inputs: '输入',
  };
  const lines = [`命中 ${hits.length} 条（关键词「${text}」）：`];
  for (const hit of hits) {
    const idPart = hit.id !== undefined ? `[${hit.id}] ` : '';
    const extraPart = hit.extra !== undefined ? `（${hit.extra}）` : '';
    lines.push(`- ${sectionLabel[hit.section]} ${idPart}${hit.text}${extraPart}`);
  }
  return ok(id, lines.join('\n'));
};

// ---------- scroll ----------

const scroll: ToolExecutorFn = async ({ id, args }, ctx) => {
  const dy = Number(args.dy); // 校验层已保证整数 ±50000（paramRules）
  const tabId = await resolveTabId(args, ctx);
  if (tabId === null) return fail(id, '没有活动标签页，无法滚动', 'execution-failed');
  const result = await ctx.browser.scrollTab(tabId, dy);
  if (!result.ok) return fail(id, result.reason ?? '页面滚动失败', 'execution-failed');
  const v = result.viewport;
  return ok(
    id,
    v === undefined
      ? `已滚动（dy=${dy}）`
      : `已滚动（dy=${dy}）：viewport scrollX=${v.scrollX} scrollY=${v.scrollY} width=${v.width} height=${v.height}`,
  );
};

// ---------- click / fill（allowedKind/documentId 只来自权限决策派生） ----------

const click: ToolExecutorFn = async ({ id, args, derived }, ctx) => {
  const elementId = String(args.elementId);
  if (
    derived === undefined ||
    derived.allowedKind === undefined ||
    derived.documentId === undefined
  ) {
    // 纵深防御：无权限决策派生的执行参数（语义缺失本应已在权限层 L3 拒绝）→ fail-closed
    return fail(id, '缺少权限决策派生的执行参数，拒绝执行', 'execution-failed');
  }
  const tabId = await resolveTabId(args, ctx);
  if (tabId === null) return fail(id, '没有活动标签页，无法点击', 'execution-failed');
  const result = await ctx.browser.clickElement(
    tabId,
    elementId,
    derived.allowedKind,
    derived.documentId,
  );
  if (!result.ok) {
    return fail(id, result.reason ?? '点击失败', result.errorCode ?? 'execution-failed');
  }
  const textPart = result.text !== undefined && result.text !== '' ? `「${result.text}」` : '';
  return ok(id, `已点击元素 [${elementId}]（<${result.tag ?? ''}>${textPart}）`);
};

const fill: ToolExecutorFn = async ({ id, args, derived }, ctx) => {
  const elementId = String(args.elementId);
  const text = String(args.text);
  if (derived === undefined || derived.documentId === undefined) {
    return fail(id, '缺少权限决策派生的执行参数，拒绝执行', 'execution-failed');
  }
  const tabId = await resolveTabId(args, ctx);
  if (tabId === null) return fail(id, '没有活动标签页，无法填写', 'execution-failed');
  const result = await ctx.browser.fillElement(tabId, elementId, text, derived.documentId);
  if (!result.ok) {
    return fail(id, result.reason ?? '填写失败', result.errorCode ?? 'execution-failed');
  }
  // 结果只含标签/类型/长度摘要——输入原文零外泄（审计层另有 len=N 断言）
  return ok(
    id,
    `已填写元素 [${elementId}]（<${result.tag ?? ''}> type=${result.type ?? ''}，输入 ${text.length} 个字符）`,
  );
};

// A3 四个交互工具（§4.2）。baseRisk 与 permission-policy TOOL_BASE_RISK 矩阵一致
// （单测交叉断言防漂移）；paramRules 为校验层确定性规则（不进模型可见 schema）。
export const INTERACTION_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'browser_find',
    description:
      '在页面中确定性匹配文本（实时快照；返回命中元素 id/文本/章节位置；无命中返回空结果）',
    parameters: {
      properties: {
        text: { type: 'string', description: '要查找的文本（非空，≤200 字符）' },
        tabId: { type: 'string', description: '标签页 id（可选，缺省为活动标签页）' },
      },
      required: ['text'],
    },
    paramRules: { text: { maxLength: FIND_TEXT_MAX, nonEmpty: true } },
    baseRisk: 0,
    executor: find,
  },
  {
    name: 'browser_scroll',
    description: '纵向滚动页面（dy 为正向下/为负向上，整数，±50000 以内）',
    parameters: {
      properties: {
        dy: { type: 'number', description: '纵向滚动像素（整数，-50000～50000）' },
        tabId: { type: 'string', description: '标签页 id（可选，缺省为活动标签页）' },
      },
      required: ['dy'],
    },
    paramRules: { dy: { integer: true, min: -SCROLL_LIMIT, max: SCROLL_LIMIT } },
    baseRisk: 0,
    executor: scroll,
  },
  {
    name: 'browser_click',
    description:
      '点击页面元素（elementId 来自最近一次 read/find 结果；仅允许链接/展开/折叠控件/复选单选（自动执行）、提交类按钮（需用户确认）；其他目标被拒绝）',
    parameters: {
      properties: {
        elementId: { type: 'string', description: '元素 id（el-N 格式，来自快照结果）' },
        tabId: { type: 'string', description: '标签页 id（可选，缺省为活动标签页）' },
      },
      required: ['elementId'],
    },
    baseRisk: 1,
    riskLift: { submitClick: 2 },
    executor: click,
  },
  {
    name: 'browser_fill',
    description:
      '向输入框填写文本（elementId 来自最近一次 read/find 结果；仅允许普通 input/textarea，密码与文件输入被禁止）',
    parameters: {
      properties: {
        elementId: { type: 'string', description: '元素 id（el-N 格式，来自快照结果）' },
        text: { type: 'string', description: '填写内容（≤2000 字符）' },
        tabId: { type: 'string', description: '标签页 id（可选，缺省为活动标签页）' },
      },
      required: ['elementId', 'text'],
    },
    paramRules: { text: { maxLength: FILL_TEXT_MAX } },
    baseRisk: 1,
    executor: fill,
  },
];
