// Fifth Stage C3: Source selection pure functions (detailed-design §4,
// adjudications #120–#123). Zero Electron imports, zero I/O, zero logging:
// mergeCandidates merges the Sources + Search candidate feeds with
// deterministic ordering; buildCandidateSortKey encodes the full order into
// an ASCII sortKey (JavaScript binary < order === SQLite BINARY order —
// ResearchRepository lists candidates by `ORDER BY sort_key ASC,
// candidate_id ASC`, §9.1); selectCandidates crops a bounded top-N.
//
// Discovery tiers (#120 — this is a source-selection order, NOT a
// trust/quality score): tier 1 = source-search (preserves the SourceService
// input order, adjudication #61 total order); tier 2 = group-list (priority
// desc, lastUsedAt desc, scope/canonicalKey/id); tier 3 = web-search
// (preserves the SearchProvider result order; trust/priority/lastUsedAt/note
// are always null — no trust assertion is fabricated). trust triples are
// provenance metadata only and never change the base order (FT-07: a
// favorite/priority/note is never laundered into a verified fact;
// user+asserted ≠ program-verified; ai+unverified always shows unverified).
//
// candidateIds are pre-assigned by the future C5 main-process caller (#122):
// this module never generates ids and rejects invalid/duplicate ids
// fail-closed. Same-identity Sources+Search merges keep the Sources entry's
// candidateId; the unused Search candidateId is safely discarded.
//
// Hostile input: per-entry malformed data only increments droppedCount
// (no URL/note/title bodies are ever logged — this module does not log);
// top-level malformed structure or invalid/duplicate candidateIds fail the
// whole merge closed. Input arrays/objects are never mutated.
import { isIso8601Timestamp } from './domain/research-task-state';
import { isUuidShape, stripControlChars } from '../sources/domain/source-change-set';
import { normalizeSourceUrl } from '../sources/domain/source-canonical';
import type { SearchResult } from '../ai/search/search-provider';
import {
  MAX_CANDIDATE_NOTE_CHARS,
  MAX_CANDIDATE_TITLE_CHARS,
  MAX_SELECTED_SOURCES,
  MAX_SOURCE_CANDIDATES,
  type CandidateOrigin,
  type SourceCandidate,
  type SourceTrustValue,
} from '../../shared/types/research';
import type {
  SourceListItem,
  SourceScope,
  SourceSearchItem,
  SourceTrust,
} from '../../shared/types/sources';

// ---------- 输入契约（决议 #122，§4.1） ----------

export type SourcesCandidateFeed =
  | {
      kind: 'source-search';
      entries: readonly { candidateId: string; item: SourceSearchItem }[];
    }
  | {
      kind: 'group-list';
      entries: readonly { candidateId: string; item: SourceListItem }[];
    };

export interface WebSearchCandidateEntry {
  candidateId: string;
  result: SearchResult;
}

export interface MergeCandidatesInput {
  sources: SourcesCandidateFeed | null; // null = 无 Sources 候选（合法输入）
  search: readonly WebSearchCandidateEntry[];
}

export type CandidateMergeErrorCode = 'candidate-invalid-input' | 'candidate-id-conflict';

export type MergeCandidatesResult =
  | { ok: true; candidates: SourceCandidate[]; droppedCount: number }
  | { ok: false; errorCode: CandidateMergeErrorCode; reason: string };

export interface CandidateSortKeyInput {
  tier: 1 | 2 | 3;
  inputRank: number; // source-search/web-search 原输入 rank；group-list 用固定值
  priority: number | null;
  lastUsedAt: string | null;
  scope: SourceScope;
  canonicalKey: string;
  candidateId: string;
}

// ---------- 常量与形状校验 ----------

const TIER_SOURCE_SEARCH = 1;
const TIER_GROUP_LIST = 2;
const TIER_WEB_SEARCH = 3;

// 决议 #122：小写 RFC 4122 UUID 形状（version 4 / variant 位，与主进程
// randomUUID 输出一致；大写形态拒绝——fail-closed）
const UUID_V4_LOWER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const RANK_ENCODE_MAX = 99999; // RRRRR 五位；输入有界（≤20 条）不可达，防御性 clamp
const RANK_GROUP_LIST_FIXED = 99999;
const NULL_TIME_SENTINEL = '~~~~~~~~~~~~~~~~~~~~~~~~'; // 24 个 ~（决议 #123）

const NOTE_LABEL_USER = '用户备注：';
const NOTE_LABEL_AI = 'AI 备注：';

const TRUST_VALUES: ReadonlySet<string> = new Set<SourceTrustValue>([
  'official',
  'primary',
  'secondary',
  'community',
  'unknown',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLowerV4Uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_LOWER_RE.test(value);
}

function failInput(reason: string): MergeCandidatesResult {
  return { ok: false, errorCode: 'candidate-invalid-input', reason };
}

// ---------- 文本清洗与有界截断（不拆 surrogate pair） ----------

// 与 B2/B3 同族：控制/bidi 剔除 + NFC + trim（决议 #121）
function cleanText(text: string): string {
  return stripControlChars(text).normalize('NFC').trim();
}

// 截断点不得落在 UTF-16 surrogate pair 中间；输入中的孤立代理一并剔除
function truncateNoSurrogate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  while (end > 0) {
    const cp = text.charCodeAt(end - 1);
    if (cp >= 0xdc00 && cp <= 0xdfff) {
      const prev = text.charCodeAt(end - 2);
      if (prev >= 0xd800 && prev <= 0xdbff) break; // 完整 pair 结尾，安全
      end -= 1; // 孤立低位代理，剔除
    } else if (cp >= 0xd800 && cp <= 0xdbff) {
      end -= 1; // 高位代理结尾（pair 被拆或孤立），剔除
    } else {
      break;
    }
  }
  return text.slice(0, end);
}

// ---------- provenance 与字段校验（§4.3 安全降级） ----------

// 仅接受 user+asserted / ai+unverified 且 value 为合法枚举；其余畸形整体 null
function normalizeTrust(raw: unknown): SourceTrust | null {
  if (!isRecord(raw)) return null;
  const { value, assertedBy, verification } = raw;
  if (
    typeof value !== 'string' ||
    !TRUST_VALUES.has(value) ||
    typeof assertedBy !== 'string' ||
    typeof verification !== 'string'
  ) {
    return null;
  }
  const validPair =
    (assertedBy === 'user' && verification === 'asserted') ||
    (assertedBy === 'ai' && verification === 'unverified');
  if (!validPair) return null;
  return {
    value: value as SourceTrustValue,
    assertedBy: assertedBy as SourceTrust['assertedBy'],
    verification: verification as SourceTrust['verification'],
  };
}

function normalizePriority(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 5 ? raw : null;
}

// 非法（非 ISO 8601 / 回滚日期 / 不可解析）→ null；合法原样保留字段值
function normalizeLastUsedAt(raw: unknown): string | null {
  if (!isIso8601Timestamp(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : raw;
}

// ---------- note 映射（决议 #121，§4.4） ----------

function buildCandidateNote(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const userText = typeof raw.userNote === 'string' ? cleanText(raw.userNote) : '';
  const aiText = typeof raw.aiNote === 'string' ? cleanText(raw.aiNote) : '';
  const userPart = userText !== '' ? `${NOTE_LABEL_USER}${userText}` : null;
  const aiPart = aiText !== '' ? `${NOTE_LABEL_AI}${aiText}` : null;
  if (userPart === null && aiPart === null) return null;
  const joined = [userPart, aiPart].filter((p): p is string => p !== null).join('\n');
  if (joined.length <= MAX_CANDIDATE_NOTE_CHARS) return joined;
  // 逐段分配预算（标签、换行、正文共同计入上限）：用户段优先；AI 段需至少
  // 「AI 备注：」+ 1 字符正文（且连接换行 1 字符计入），否则整体丢弃
  // （不得留下无正文的作者标签）
  const kept: string[] = [];
  let remaining = MAX_CANDIDATE_NOTE_CHARS;
  if (userPart !== null) {
    const u = truncateNoSurrogate(userPart, remaining);
    kept.push(u);
    remaining -= u.length;
  }
  if (aiPart !== null) {
    const budget = remaining - (kept.length > 0 ? 1 : 0); // 连接换行计入
    if (budget >= NOTE_LABEL_AI.length + 1) {
      kept.push(truncateNoSurrogate(aiPart, budget));
    }
  }
  return kept.join('\n');
}

// ---------- sortKey 编码（决议 #123，§4.5） ----------

// ISO 时间 → UTC toISOString → 每个数字 d 替换为 9−d（反向时间字典序，
// 新时间排前）；null/非法 → 固定长度 sentinel（恒排最后）
function encodeTime(iso: string): string {
  if (!isIso8601Timestamp(iso)) return NULL_TIME_SENTINEL;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return NULL_TIME_SENTINEL;
  const utc = new Date(ms).toISOString();
  let out = '';
  for (const ch of utc) {
    out += ch >= '0' && ch <= '9' ? String(9 - (ch.charCodeAt(0) - 48)) : ch;
  }
  return out;
}

// TT|RRRRR|P|IIIIIIIIIIIIIIIIIIIIIIII|S|canonicalKey|candidateId——
// 全 ASCII：JS 二元 < 比较与 SQLite BINARY 排序一致（不得 localeCompare）
export function buildCandidateSortKey(input: CandidateSortKeyInput): string {
  const tierCode = input.tier === 1 ? '01' : input.tier === 2 ? '02' : '03';
  const rank =
    Number.isInteger(input.inputRank) && input.inputRank >= 0
      ? Math.min(input.inputRank, RANK_ENCODE_MAX)
      : RANK_ENCODE_MAX;
  const rankCode = String(rank).padStart(5, '0');
  const priorityCode =
    typeof input.priority === 'number' &&
    Number.isInteger(input.priority) &&
    input.priority >= 1 &&
    input.priority <= 5
      ? String(6 - input.priority) // 5→'1' 排最前；1→'5'
      : '9';
  const timeCode = encodeTime(input.lastUsedAt ?? '');
  const scopeCode = input.scope === 'origin' ? '0' : '1';
  return `${tierCode}|${rankCode}|${priorityCode}|${timeCode}|${scopeCode}|${input.canonicalKey}|${input.candidateId}`;
}

// ---------- 候选构造与合并 ----------

interface PendingCandidate {
  candidateId: string;
  tier: 1 | 2 | 3;
  inputRank: number;
  url: string;
  displayUrl: string;
  canonicalKey: string;
  scope: SourceScope;
  title: string; // 清洗截断后；'' = 无（后续兜底 Search title → host）
  sourceId: string | null;
  trust: SourceTrust | null;
  priority: number | null;
  lastUsedAt: string | null;
  note: string | null;
}

interface CandidateSlot {
  pending: PendingCandidate;
  fromSources: boolean;
  viaSearch: boolean;
}

function mergeIdentityKey(scope: SourceScope, canonicalKey: string): string {
  return `${scope}\0${canonicalKey}`;
}

function fallbackTitleHost(canonicalKey: string): string {
  try {
    return truncateNoSurrogate(new URL(canonicalKey).host, MAX_CANDIDATE_TITLE_CHARS);
  } catch {
    return ''; // canonicalKey 恒为 normalizeSourceUrl 输出；防御性兜底
  }
}

function titleFromSources(raw: unknown): string {
  return typeof raw === 'string'
    ? truncateNoSurrogate(cleanText(raw), MAX_CANDIDATE_TITLE_CHARS)
    : '';
}

// Sources 条目 → PendingCandidate；单条畸形安全返回 null（仅计 droppedCount）
function buildFromSourceItem(
  candidateId: string,
  item: Record<string, unknown>,
  kind: 'source-search' | 'group-list',
  index: number,
): PendingCandidate | null {
  const scope = item.scope;
  if (scope !== 'origin' && scope !== 'page') return null;
  const url = item.url;
  if (typeof url !== 'string') return null;
  const normalized = normalizeSourceUrl(url, scope);
  if (!normalized.ok) return null;
  // 身份键必须与重算一致（§4.1/§4.3）
  if (item.canonicalKey !== normalized.canonicalKey) return null;
  // 纵深防御：disabled / blocked 对 agent 视角不可见（§4.3）
  if (item.enabled === false || item.shareMode === 'blocked') return null;
  if (!isUuidShape(item.id)) return null; // sourceId 非法 → 条目丢弃
  return {
    candidateId,
    tier: kind === 'source-search' ? TIER_SOURCE_SEARCH : TIER_GROUP_LIST,
    inputRank: kind === 'source-search' ? index : RANK_GROUP_LIST_FIXED,
    url,
    displayUrl: normalized.displayUrl,
    canonicalKey: normalized.canonicalKey,
    scope,
    title: titleFromSources(item.name),
    sourceId: item.id,
    trust: normalizeTrust(item.trust),
    priority: normalizePriority(item.priority),
    lastUsedAt: normalizeLastUsedAt(item.lastUsedAt),
    // 决议 #121：note 仅 source-search 路径映射；group-list 恒 null
    note: kind === 'source-search' ? buildCandidateNote(item.note) : null,
  };
}

// Search 条目 → PendingCandidate（scope 恒 'page'）；单条畸形安全返回 null
function buildFromSearchResult(
  candidateId: string,
  result: Record<string, unknown>,
  index: number,
): PendingCandidate | null {
  const url = result.url;
  if (typeof url !== 'string') return null;
  const normalized = normalizeSourceUrl(url, 'page');
  if (!normalized.ok) return null;
  return {
    candidateId,
    tier: TIER_WEB_SEARCH,
    inputRank: index,
    url,
    displayUrl: normalized.displayUrl,
    canonicalKey: normalized.canonicalKey,
    scope: 'page',
    title: titleFromSources(result.title),
    sourceId: null,
    trust: null,
    priority: null,
    lastUsedAt: null,
    note: null,
  };
}

function finalizeCandidate(
  pending: PendingCandidate,
  discoveredVia: CandidateOrigin[],
): SourceCandidate {
  return {
    id: pending.candidateId,
    url: pending.url,
    displayUrl: pending.displayUrl,
    title: pending.title !== '' ? pending.title : fallbackTitleHost(pending.canonicalKey),
    canonicalKey: pending.canonicalKey,
    scope: pending.scope,
    discoveredVia,
    sourceId: pending.sourceId,
    trust: pending.trust,
    priority: pending.priority,
    lastUsedAt: pending.lastUsedAt,
    note: pending.note,
    sortKey: buildCandidateSortKey({
      tier: pending.tier,
      inputRank: pending.inputRank,
      priority: pending.priority,
      lastUsedAt: pending.lastUsedAt,
      scope: pending.scope,
      canonicalKey: pending.canonicalKey,
      candidateId: pending.candidateId,
    }),
  };
}

// 与 SQLite `ORDER BY sort_key ASC, candidate_id ASC` 一致（§9.1）
function compareCandidates(a: SourceCandidate, b: SourceCandidate): number {
  if (a.sortKey < b.sortKey) return -1;
  if (a.sortKey > b.sortKey) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------- mergeCandidates ----------

export function mergeCandidates(input: MergeCandidatesInput): MergeCandidatesResult {
  // ---- 顶层结构校验（fail-closed；reason 不含 URL/note/标题正文）----
  if (!isRecord(input)) return failInput('输入必须是对象');
  const { sources, search } = input;
  if (!Array.isArray(search)) return failInput('search 必须是数组');
  if (sources !== null && sources !== undefined) {
    if (!isRecord(sources)) return failInput('sources 结构非法');
    if (sources.kind !== 'source-search' && sources.kind !== 'group-list') {
      return failInput('sources.kind 非法');
    }
    if (!Array.isArray(sources.entries)) return failInput('sources.entries 必须是数组');
  }
  const sourceEntries: readonly unknown[] =
    sources === null || sources === undefined
      ? []
      : (sources as { entries: readonly unknown[] }).entries;
  const searchEntries: unknown[] = search;

  // ---- candidateId 全局校验 + 条目形状（决议 #122/§4.3：非法 → invalid-input；
  // 重复 → conflict；条目缺 item/result → 整次 fail-closed）----
  const seenIds = new Set<string>();
  const checkEntry = (entry: unknown, needItem: boolean): MergeCandidatesResult | null => {
    if (!isRecord(entry)) return failInput('候选条目结构非法');
    const candidateId = entry.candidateId;
    if (!isLowerV4Uuid(candidateId)) {
      return failInput('candidateId 必须是小写 RFC 4122 UUID');
    }
    if (seenIds.has(candidateId)) {
      return { ok: false, errorCode: 'candidate-id-conflict', reason: 'candidateId 在输入中重复' };
    }
    seenIds.add(candidateId);
    const payload = needItem ? entry.item : entry.result;
    if (!isRecord(payload)) {
      return failInput(needItem ? 'Sources 条目缺 item' : 'Search 条目缺 result');
    }
    return null;
  };
  for (const entry of sourceEntries) {
    const err = checkEntry(entry, true);
    if (err !== null) return err;
  }
  for (const entry of searchEntries) {
    const err = checkEntry(entry, false);
    if (err !== null) return err;
  }

  let dropped = 0;
  const slots = new Map<string, CandidateSlot>();
  const kind =
    sources === null || sources === undefined
      ? null
      : (sources as { kind: 'source-search' | 'group-list' }).kind;

  // ---- Sources 阶段（tier 1/2；条目形状已由 checkEntry 保证）----
  if (sources !== null && sources !== undefined && kind !== null) {
    sourceEntries.forEach((entry, index) => {
      const record = entry as Record<string, unknown>;
      const pending = buildFromSourceItem(
        record.candidateId as string,
        record.item as Record<string, unknown>,
        kind,
        index,
      );
      if (pending === null) {
        dropped += 1;
        return;
      }
      const key = mergeIdentityKey(pending.scope, pending.canonicalKey);
      if (slots.has(key)) {
        dropped += 1; // 同 feed 同身份重复：保留 rank 更前（先到达）者
        return;
      }
      slots.set(key, { pending, fromSources: true, viaSearch: false });
    });
  }

  // ---- Search 阶段（合并或 tier 3；条目形状已由 checkEntry 保证）----
  searchEntries.forEach((entry, index) => {
    const record = entry as Record<string, unknown>;
    const pending = buildFromSearchResult(
      record.candidateId as string,
      record.result as Record<string, unknown>,
      index,
    );
    if (pending === null) {
      dropped += 1;
      return;
    }
    const key = mergeIdentityKey(pending.scope, pending.canonicalKey);
    const slot = slots.get(key);
    if (slot !== undefined) {
      if (slot.viaSearch) {
        dropped += 1; // 同身份 Search 重复
        return;
      }
      // 同身份合并（决策 D6）：Sources 档位与字段保持不变；未采用的
      // Search candidateId 安全丢弃；discoveredVia 固定规范顺序
      slot.viaSearch = true;
      if (slot.pending.title === '') {
        slot.pending.title = pending.title;
      }
      return;
    }
    slots.set(key, { pending, fromSources: false, viaSearch: true });
  });

  // ---- 排序与有界裁剪（§4.6：24 上限，超出计入 droppedCount）----
  const candidates = [...slots.values()]
    .map((slot) =>
      finalizeCandidate(
        slot.pending,
        slot.fromSources ? (slot.viaSearch ? ['sources', 'search'] : ['sources']) : ['search'],
      ),
    )
    .sort(compareCandidates);
  const total = candidates.length;
  const cropped = candidates.slice(0, MAX_SOURCE_CANDIDATES);
  dropped += total - cropped.length;
  return { ok: true, candidates: cropped, droppedCount: dropped };
}

// ---------- selectCandidates（选定 ≤8，副本排序零修改输入） ----------

export function selectCandidates(candidates: readonly SourceCandidate[]): SourceCandidate[] {
  if (!Array.isArray(candidates)) return [];
  const sorted = [...candidates].sort(compareCandidates);
  return sorted.slice(0, MAX_SELECTED_SOURCES);
}
