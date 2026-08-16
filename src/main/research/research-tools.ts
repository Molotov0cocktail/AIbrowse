// Fifth Stage C5: the Research-owned six-tool set (adjudication #132).
// Compile-time fixed collection: names/wire shape/base parameter shape match
// the registry's same-named tools (asserted by tests; the runtime never
// imports the registry) — but descriptions and executors are Research-owned
// (different semantics: browser_open reads only candidate-collection URLs via
// CaptureService; browser_read reads only this run's in-memory capture
// contents). Research tool calls never flow through ToolRegistry/ToolExecutor/
// the permission chain/ConfirmManager. Unknown/out-of-subset tools and
// invalid arguments yield safe tool results (never execute, never throw).
// Tool-result serialization is bounded (RESEARCH_TOOL_RESULT_CONTENT_MAX) and
// only ever enters model-replay messages (never logs/UI/persistence).
import { truncateWithMark } from './domain/research-budget';
import type { ProviderTool } from '../../shared/types/conversation';
import {
  RESEARCH_TOOL_NAMES,
  RESEARCH_TOOL_RESULT_CONTENT_MAX,
  type ResearchToolName,
} from '../../shared/types/research';

export interface ResearchToolDefinition {
  name: ResearchToolName;
  description: string;
  parameters: ProviderTool['function']['parameters'];
}

// Research 专属描述（语义与注册表同名工具不同——决议 #132(1)）
const DESCRIPTIONS: Record<ResearchToolName, string> = {
  browser_open:
    '读取研究任务候选来源之一：url 必须是本任务候选集合中的地址（经任务专属标签页读取并记录，读取后自动释放标签页）',
  browser_read:
    '查看本任务已捕获网页的受控内容摘录（tabId 为读取时分配的标签页 id；仅本任务本次运行内已捕获的内容可用）',
  search_web: '用联网搜索补充候选来源（返回结果标题与地址）',
  source_search: '在你的信源库中检索相关信源（返回条目 id/名称/地址）',
  source_list: '列出信源库条目（仅启用条目；可指定分组）',
  source_get: '查看单个信源的详情',
};

// 参数基础形状与注册表同名工具一致（决议 #132(1)——测试交叉断言）
export const RESEARCH_TOOL_DEFINITIONS: readonly ResearchToolDefinition[] = [
  {
    name: 'browser_open',
    description: DESCRIPTIONS.browser_open,
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http/https 地址（本任务候选集合内）' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_read',
    description: DESCRIPTIONS.browser_read,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: '标签页 id（可选；本任务本次运行内已捕获）' },
      },
      required: [],
    },
  },
  {
    name: 'search_web',
    description: DESCRIPTIONS.search_web,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词' } },
      required: ['query'],
    },
  },
  {
    name: 'source_search',
    description: DESCRIPTIONS.source_search,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '检索关键词（1–500 字符）' } },
      required: ['query'],
    },
  },
  {
    name: 'source_list',
    description: DESCRIPTIONS.source_list,
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'number', description: '页码（从 0 开始）' },
        pageSize: { type: 'number', description: '每页条数（1–20，缺省 20）' },
        groupId: { type: 'string', description: '按分组 ID 过滤（可选）' },
        enabledOnly: { type: 'boolean', description: '仅列出启用条目（Research 恒启用）' },
      },
      required: ['page'],
    },
  },
  {
    name: 'source_get',
    description: DESCRIPTIONS.source_get,
    parameters: {
      type: 'object',
      properties: { sourceId: { type: 'string', description: '信源 ID（UUID）' } },
      required: ['sourceId'],
    },
  },
];

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function listResearchTools(): ProviderTool[] {
  // 每次全新对象（序列化只从本模块编译期常量派生——决议 #132(1)）
  return RESEARCH_TOOL_DEFINITIONS.map((def) => ({
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: {
        type: 'object',
        properties: { ...def.parameters.properties },
        required: [...def.parameters.required],
      },
    },
  }));
}

export type ResearchToolArgsResult =
  { ok: true; args: Record<string, unknown> } | { ok: false; reason: string };

function fail(reason: string): ResearchToolArgsResult {
  return { ok: false, reason };
}

function isNonEmptyString(value: unknown, maxLen: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maxLen;
}

function isUuidShape(value: unknown): value is string {
  return typeof value === 'string' && UUID_SHAPE.test(value);
}

// 参数白名单校验（Research 专属；安全返回不抛异常——决议 #132(3)）
export function validateResearchToolArgs(
  name: string,
  rawArguments: string,
): ResearchToolArgsResult {
  if (!(RESEARCH_TOOL_NAMES as readonly string[]).includes(name)) {
    return fail('未知工具');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return fail('参数 JSON 解析失败');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('参数必须是 JSON 对象');
  }
  const args = parsed as Record<string, unknown>;
  const keys = Object.keys(args);
  switch (name as ResearchToolName) {
    case 'browser_open': {
      if (keys.length !== 1 || !('url' in args)) return fail('url 必填');
      if (!isNonEmptyString(args.url, 2048)) return fail('url 必须是非空字符串（≤2048）');
      return { ok: true, args: { url: args.url } };
    }
    case 'browser_read': {
      if (keys.length === 0) return { ok: true, args: {} };
      if (keys.length !== 1 || !('tabId' in args)) return fail('仅接受 tabId');
      if (typeof args.tabId !== 'string' || args.tabId === '')
        return fail('tabId 必须是非空字符串');
      return { ok: true, args: { tabId: args.tabId } };
    }
    case 'search_web': {
      if (keys.length !== 1 || !('query' in args)) return fail('query 必填');
      if (!isNonEmptyString(args.query, 500)) return fail('query 必须是非空字符串（≤500）');
      return { ok: true, args: { query: args.query } };
    }
    case 'source_search': {
      if (keys.length !== 1 || !('query' in args)) return fail('query 必填');
      if (!isNonEmptyString(args.query, 500)) return fail('query 必须是非空字符串（≤500）');
      return { ok: true, args: { query: args.query } };
    }
    case 'source_list': {
      if (!('page' in args)) return fail('page 必填');
      if (!Number.isInteger(args.page) || (args.page as number) < 0)
        return fail('page 必须是非负整数');
      const out: Record<string, unknown> = { page: args.page };
      if ('pageSize' in args) {
        if (
          !Number.isInteger(args.pageSize) ||
          (args.pageSize as number) < 1 ||
          (args.pageSize as number) > 20
        ) {
          return fail('pageSize 必须是 1–20 整数');
        }
        out.pageSize = args.pageSize;
      }
      if ('groupId' in args) {
        if (typeof args.groupId !== 'string' || args.groupId === '')
          return fail('groupId 必须是非空字符串');
        out.groupId = args.groupId;
      }
      if ('enabledOnly' in args) {
        // Research 专属收紧（决议 #133(5)：group-list enabledOnly=true 恒启用）
        if (args.enabledOnly !== true) return fail('enabledOnly 在 Research 中恒为 true');
        out.enabledOnly = true;
      }
      if (Object.keys(out).length !== keys.length) return fail('未知字段');
      return { ok: true, args: out };
    }
    case 'source_get': {
      if (keys.length !== 1 || !('sourceId' in args)) return fail('sourceId 必填');
      if (!isUuidShape(args.sourceId)) return fail('sourceId 必须是 UUID 形状');
      return { ok: true, args: { sourceId: args.sourceId } };
    }
    default:
      return fail('未知工具');
  }
}

// 安全工具结果序列化（决议 #132(6)）：有界截断 + 标记；只进模型回放消息
export interface ResearchToolResultShape {
  ok: boolean;
  content?: string;
  error?: string;
}

export function serializeResearchToolResult(result: ResearchToolResultShape): string {
  const content =
    typeof result.content === 'string'
      ? truncateWithMark(result.content, RESEARCH_TOOL_RESULT_CONTENT_MAX).text
      : undefined;
  const error = typeof result.error === 'string' ? result.error.slice(0, 64) : undefined;
  const shape: Record<string, unknown> = { ok: result.ok === true };
  if (content !== undefined) shape.content = content;
  if (error !== undefined) shape.error = error;
  return JSON.stringify(shape);
}
