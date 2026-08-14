// Fourth Stage B3: source search query construction — pure functions, zero
// Electron/db imports (detailed-design §8.3, adjudications #60/#61/#62).
// - Query normalization: trim + NFC + control/bidi stripping; Unicode code-point
//   counting (adjudication #60).
// - Dispatch: 1 char → exact only; 2 chars → exact + prefix + parameterized
//   substring LIKE (honest delivery of 2-char CJK substring hits — tests must NOT
//   claim trigram natively supports 2-char queries, B1 measured ≥3 only);
//   ≥3 chars → FTS5 trigram main path (only ≥3-char tokens are phrase-wrapped);
//   URL queries (deterministic set: normalizeSourceUrl parses, or http(s)://
//   prefix) → canonicalKey/url exact + prefix.
// - buildFtsQuery: raw query never concatenated into MATCH — per-token phrase
//   wrapping with internal double-quote escaping; quotes/wildcards/FTS operators
//   (AND/OR/NOT/NEAR/*/^/digits) and SQL fragments are data only (ST-04).
// - Match tiers (adjudication #61, strict non-crossable order): exact > prefix >
//   tag/group > name/domain > note; priority/recency only within a tier; final
//   total order by scope + canonicalKey + id.
// - Case semantics mirror SQL (documented honestly): `=`/trigram case-sensitive;
//   LIKE ASCII-case-insensitive (SQLite default) → exact checks case-sensitive,
//   prefix/substring checks ASCII-case-insensitive.
import { stripControlChars } from './source-change-set';
import { normalizeSourceUrl } from './source-canonical';
import type { SourceReadAudience, SourceShareMode } from '../../../shared/types/sources';

export const SEARCH_CANDIDATE_MAX = 200; // 候选行检索上界（SQL LIMIT 编译期常量）
export const SEARCH_NOTE_EXCERPT_MAX = 200; // note 摘录 ≤200 Unicode 码点（§8.2）

export type SearchQueryKind = 'url' | 'short1' | 'short2' | 'fts' | 'like-long';
// url：URL 判定集合（canonicalKey/url 精确+前缀）
// short1：1 字符仅精确（name/url/canonicalKey）
// short2：2 字符精确 + 前缀 + 参数化字面子串（name/url/canonicalKey/tag/group）
// fts：≥3 字符 FTS trigram 主路径（候选含精确/前缀/tag/group，note 经 FTS）
// like-long：≥3 字符且 FTS 不可用/无 FTS token（精确/前缀/tag/group；note 检索
//            不可用——如实登记，决议 #62 降级路径为完整交付实现）

export type SearchMatchTier = 0 | 1 | 2 | 3 | 4; // 精确/前缀/tag-group/name-domain/note

export interface SearchTierInput {
  name: string;
  url: string;
  canonicalKey: string;
  tags: string[];
  groupName: string | null;
  userNote: string;
  aiNote: string;
  shareMode: SourceShareMode;
}

export interface SearchSortableItem {
  tier: SearchMatchTier;
  priority: number;
  lastUsedAt: string | null;
  scope: string; // SourceScope
  canonicalKey: string;
  id: string;
}

export interface NoteExcerpt {
  userNote: string | null; // ≤200 码点截断 + 控制/bidi 剔除（null = 无）
  aiNote: string | null;
}

// --- 查询归一化与分流（决议 #60） ---

export function normalizeSearchQuery(raw: string): string | null {
  // 控制/bidi 剔除 + NFC + trim；归一化后为空 → null（调用方拒绝）
  const normalized = stripControlChars(raw).normalize('NFC').trim();
  return normalized === '' ? null : normalized;
}

export function countUnicodeChars(text: string): number {
  return [...text].length; // 码点计数（代理对算 1）
}

export function classifySearchQuery(query: string): SearchQueryKind {
  // 特殊 URL 查询确定性判定集合：normalizeSourceUrl 可解析（http/https 且无
  // userinfo/控制字符），或 trim 后以 http://、https:// 开头（含解析失败的
  // URL 形态——只作数据，安全不命中）
  if (normalizeSourceUrl(query, 'page').ok) return 'url';
  if (/^https?:\/\//i.test(query)) return 'url';
  const n = countUnicodeChars(query);
  if (n === 1) return 'short1';
  if (n === 2) return 'short2';
  return 'fts';
}

// --- FTS 查询串构造（短语包裹 + 双引号转义，只作数据，ST-04） ---

export function buildFtsQuery(
  raw: string,
): { ok: true; query: string } | { ok: false; reason: string } {
  const tokens = raw.split(/\s+/).filter((t) => t !== '');
  // 仅 ≥3 字符 token 参与短语包裹：1–2 字符 token 在 trigram 下不产生 token，
  // 若保留会使整个 AND 匹配失败（trigram ≥3 语义——如实登记，不声称原生支持）
  const phrases = tokens.filter((t) => [...t].length >= 3).map((t) => `"${t.replace(/"/g, '""')}"`);
  if (phrases.length === 0) {
    return { ok: false, reason: tokens.length === 0 ? 'empty' : 'no-fts-token' };
  }
  return { ok: true, query: phrases.join(' ') };
}

// --- LIKE 模式构造（参数化 ESCAPE '\'；\ % _ 转义，只作数据） ---

export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function likePrefix(text: string): string {
  return `${escapeLikePattern(text)}%`;
}

export function likeSubstring(text: string): string {
  return `%${escapeLikePattern(text)}%`;
}

// --- 确定性档位计算（决议 #61；与候选 SQL 的匹配语义一一对应） ---

const ci = (s: string): string => s.toLowerCase();

function hostOfUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return ''; // 存储 URL 恒为已校验 http/https；防御性兜底
  }
}

export function computeMatchTier(
  input: SearchTierInput,
  query: string,
  kind: SearchQueryKind,
  audience: SourceReadAudience,
): SearchMatchTier | null {
  // null = 该行不构成命中（防御性丢弃：候选 SQL 与档位判定语义分歧时宁缺勿错）
  const { name, url, canonicalKey, tags, groupName, userNote, aiNote, shareMode } = input;
  const exact = (s: string): boolean => s === query; // 与 SQLite =（区分大小写）一致
  const ciPrefix = (s: string): boolean => ci(s).startsWith(ci(query)); // 与 LIKE（ASCII 不区分大小写）一致
  const ciSub = (s: string): boolean => ci(s).includes(ci(query));
  const tagGroupExact = tags.some(exact) || (groupName !== null && exact(groupName));
  const tagGroupSub = tags.some(ciSub) || (groupName !== null && ciSub(groupName));

  if (kind === 'url') {
    if (exact(canonicalKey) || exact(url)) return 0;
    if (ciPrefix(canonicalKey) || ciPrefix(url)) return 1;
    return null;
  }
  if (kind === 'short1') {
    // 1 字符：仅精确匹配（决议 #60——tag/group 不参与）
    if (exact(name) || exact(url) || exact(canonicalKey)) return 0;
    return null;
  }
  if (kind === 'short2') {
    if (exact(name) || exact(url) || exact(canonicalKey) || tagGroupExact) return 0;
    if (ciPrefix(name) || ciPrefix(url) || ciPrefix(canonicalKey)) return 1;
    if (tagGroupSub) return 2;
    if (ciSub(name) || ciSub(hostOfUrl(url)) || ciSub(url)) return 3;
    return null; // note 不参与 2 字符检索（LIKE 降级路径不检索 note）
  }
  // fts / like-long（档位语义一致；like-long 候选集中无仅 note 命中行）
  if (exact(name) || exact(url) || exact(canonicalKey) || tagGroupExact) return 0;
  if (ciPrefix(name) || ciPrefix(url) || ciPrefix(canonicalKey)) return 1;
  if (tagGroupSub) return 2;
  if (ciSub(name) || ciSub(hostOfUrl(url)) || ciSub(url)) return 3;
  // agent 视角：note 仅 full 模式参与命中（metadata 的 note 不共享、不参与，
  // 决议 #58/#59 隐私边界）；user 视角恒参与（UI 检索）
  const noteAllowed = audience === 'user' || shareMode === 'full';
  if (noteAllowed && (ciSub(userNote) || ciSub(aiNote))) return 4;
  return null;
}

// --- 排序全序（决议 #61：档位不可跨档 + 同档内排序 + 三元组收尾） ---

export function compareSearchItems(a: SearchSortableItem, b: SearchSortableItem): number {
  if (a.tier !== b.tier) return a.tier - b.tier; // 精确 > 前缀 > tag/group > name/domain > note
  if (a.priority !== b.priority) return b.priority - a.priority; // 同档内 priority 降序（不得跨档）
  // ISO 8601 UTC 字典序即时间序；''（null）在降序比较中恒排最末
  const la = a.lastUsedAt ?? '';
  const lb = b.lastUsedAt ?? '';
  if (la !== lb) return la < lb ? 1 : -1;
  if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1; // origin < page
  if (a.canonicalKey !== b.canonicalKey) return a.canonicalKey < b.canonicalKey ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// --- 有界 note 摘录（§8.2：≤200 码点 + 控制/bidi 剔除 + 字段分离 provenance） ---

function truncateExcerpt(text: string): string | null {
  const cleaned = stripControlChars(text); // 读取侧防御性清洗（旧数据/损坏数据同样覆盖）
  if (cleaned === '') return null;
  const chars = [...cleaned];
  if (chars.length <= SEARCH_NOTE_EXCERPT_MAX) return cleaned;
  return chars.slice(0, SEARCH_NOTE_EXCERPT_MAX).join('');
}

export function buildNoteExcerpt(userNote: string, aiNote: string): NoteExcerpt | null {
  const u = truncateExcerpt(userNote);
  const a = truncateExcerpt(aiNote);
  if (u === null && a === null) return null;
  return { userNote: u, aiNote: a };
}
