// Fifth Stage C5: strict ResearchPlan parsing (adjudication #133). Every
// model field is untrusted input: allowlist/type/length/count validation;
// groupId may only reference groups the program supplied in the round-1
// context; selectedCandidateIds may only reference the already-merged
// candidate collection (the model may never reinvent URLs or bypass
// provenance). Query vs selection stage semantics; the deterministic safe
// default plan references no model output at all. Never throws.
import { stripControlChars } from '../sources/domain/source-change-set';
import { truncateWithMark } from './domain/research-budget';
import { isUuidShape } from '../sources/domain/source-change-set';
import type { ResearchPlan, SourceCandidate } from '../../shared/types/research';
import { MAX_PLAN_WEB_QUERIES, MAX_SELECTED_SOURCES } from '../../shared/types/research';

export interface PlanGroupRef {
  groupId: string;
  name: string;
}

const SEARCH_QUERY_MAX = 500;
const UUID_V4_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ParsePlanContext {
  stage: 'query' | 'selection';
  groups?: readonly PlanGroupRef[]; // query 阶段：程序提供的 group 集合
  candidates?: readonly SourceCandidate[]; // selection 阶段：已合并候选集合
}

export type ParsePlanResult = { ok: true; plan: ResearchPlan } | { ok: false; reason: string };

// 清洗：NFC + trim + 控制/bidi 剔除（复用 Sources 同族清洗）后非空才合法
function cleanQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = stripControlChars(raw).trim();
  if (cleaned === '' || cleaned.length > SEARCH_QUERY_MAX) return null;
  return cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseStringArray(raw: unknown, maxItems: number, maxLen: number): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > maxItems) return null;
  const out: string[] = [];
  for (const item of raw) {
    const cleaned = cleanQuery(item);
    if (cleaned === null || cleaned.length > maxLen) return null;
    out.push(cleaned);
  }
  return out;
}

function parseSelectionIds(raw: unknown, candidates: readonly SourceCandidate[]): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_SELECTED_SOURCES) return null;
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !UUID_V4_SHAPE.test(item)) return null;
    if (!candidates.some((c) => c.id === item)) return null; // 只能引用已合并候选
    if (ids.includes(item)) return null; // 重复拒绝
    ids.push(item);
  }
  return ids;
}

// 严格白名单解析（决议 #133(3)）——所有模型字段视为不可信输入
export function parseResearchPlan(raw: string, ctx: ParsePlanContext): ParsePlanResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: '计划 JSON 解析失败' };
  }
  if (!isRecord(parsed)) return { ok: false, reason: '计划必须是 JSON 对象' };

  if (ctx.stage === 'selection') {
    // 轮 2（选择意图）：只读 selectedCandidateIds；其余字段忽略
    const ids = parseSelectionIds(parsed.selectedCandidateIds, ctx.candidates ?? []);
    if (ids === null) {
      return {
        ok: false,
        reason: 'selectedCandidateIds 只能引用已合并候选集合（小写 v4 UUID、无重复、≤8 条）',
      };
    }
    return {
      ok: true,
      plan: {
        sourceMode: 'search',
        sourceQuery: '',
        groupId: null,
        webQueries: [],
        selectedCandidateIds: ids,
      },
    };
  }

  // 轮 1（候选查询计划）：未知字段拒绝
  const allowed = new Set([
    'sourceMode',
    'sourceQuery',
    'groupId',
    'webQueries',
    'selectedCandidateIds',
  ]);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) return { ok: false, reason: `未知字段：${key}` };
  }

  const sourceMode = parsed.sourceMode;
  if (sourceMode !== 'search' && sourceMode !== 'group') {
    return { ok: false, reason: 'sourceMode 必须是 search 或 group' };
  }
  const webQueries = parseStringArray(parsed.webQueries, MAX_PLAN_WEB_QUERIES, SEARCH_QUERY_MAX);
  if (webQueries === null) {
    return {
      ok: false,
      reason: `webQueries 最多 ${MAX_PLAN_WEB_QUERIES} 项，每项非空 ≤${SEARCH_QUERY_MAX} 字符`,
    };
  }
  // 轮 1 的 selectedCandidateIds 必须空/缺省（引用的候选集合尚不存在）
  const selection = parsed.selectedCandidateIds;
  if (selection !== undefined && !(Array.isArray(selection) && selection.length === 0)) {
    return { ok: false, reason: '候选查询阶段不得引用候选集合' };
  }

  if (sourceMode === 'search') {
    const sourceQuery = cleanQuery(parsed.sourceQuery);
    if (sourceQuery === null) {
      return { ok: false, reason: `sourceQuery 必须是非空字符串（≤${SEARCH_QUERY_MAX} 字符）` };
    }
    if (parsed.groupId !== undefined && parsed.groupId !== null) {
      return { ok: false, reason: 'search 模式不得携带 groupId' };
    }
    return {
      ok: true,
      plan: {
        sourceMode: 'search',
        sourceQuery,
        groupId: null,
        webQueries,
        selectedCandidateIds: [],
      },
    };
  }

  // group 模式
  if (parsed.sourceQuery !== undefined && parsed.sourceQuery !== '') {
    return { ok: false, reason: 'group 模式不得携带 sourceQuery' };
  }
  const groupId = parsed.groupId;
  if (typeof groupId !== 'string' || groupId === '') {
    return { ok: false, reason: 'group 模式必须提供 groupId' };
  }
  const groups = ctx.groups ?? [];
  if (!groups.some((g) => g.groupId === groupId)) {
    return { ok: false, reason: 'groupId 不在程序提供的分组集合中' };
  }
  return {
    ok: true,
    plan: { sourceMode: 'group', sourceQuery: '', groupId, webQueries, selectedCandidateIds: [] },
  };
}

// 安全默认计划（决议 #133(7)）：不引用模型任何输出——goal 确定性截断 500 +
// 零 web 查询 + 零选择（Sources-only 合法降级语义）
export function buildDefaultPlan(goal: string): ResearchPlan {
  const query = truncateWithMark(
    typeof goal === 'string' ? goal : '',
    SEARCH_QUERY_MAX,
  ).text.trim();
  return {
    sourceMode: 'search',
    sourceQuery: query,
    groupId: null,
    webQueries: [],
    selectedCandidateIds: [],
  };
}

// candidateId 预分配形状校验（决议 #133(4)）：小写 RFC 4122 v4 UUID
export function isLowercaseV4Uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_SHAPE.test(value);
}

// 防御性导出：isUuidShape 供工具参数校验复用（Sources 同源语义）
export { isUuidShape };
