// Fourth Stage B2: change set structure validation + deterministic fingerprint
// (detailed-design §7.2 + adjudication #52). Pure functions, zero Electron imports,
// safe-fail on any malformed input. Confirmation-diff wording and Tool wiring are B4.
// Channel rules: AI (model) may only assert 'ai' (verification always 'unverified')
// and may never set shareMode 'blocked'; manual (user UI) channel is always
// user-asserted and may set 'blocked'.
import { createHash } from 'node:crypto';
import {
  SOURCE_URL_MAX_LENGTH,
  containsUrlControlChar,
  defaultSourceName,
  normalizeSourceUrl,
} from './source-canonical';
import type {
  SourceErrorCode,
  SourceScope,
  SourceShareMode,
  SourceTrust,
  SourceTrustValue,
} from '../../../shared/types/sources';

export const CHANGE_SET_MAX_OPS = 20;
export const SOURCE_NAME_MAX_LENGTH = 200;
export const SOURCE_TAG_MAX_LENGTH = 32;
export const SOURCE_TAGS_MAX_COUNT = 20;
export const SOURCE_GROUP_NAME_MAX_LENGTH = 64;
export const SOURCE_NOTE_MAX_LENGTH = 2000;
export const SOURCE_SEARCH_QUERY_MAX_LENGTH = 500;
export const SOURCE_PRIORITY_MIN = 1;
export const SOURCE_PRIORITY_MAX = 5;
export const SOURCE_DEFAULT_PRIORITY = 3;

// 主进程 randomUUID 形态（小写、版本 4 变体）
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidShape(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

const TRUST_VALUES: readonly SourceTrustValue[] = [
  'official',
  'primary',
  'secondary',
  'community',
  'unknown',
];
const SHARE_MODES: readonly SourceShareMode[] = ['full', 'metadata', 'blocked'];
const SCOPES: readonly SourceScope[] = ['origin', 'page'];

export type Channel = 'ai' | 'manual';

export interface NormalizedPatch {
  name?: string;
  url?: string; // 展示 URL（保留 fragment；canonicalKey 由 service 按实际 scope 计算）
  groupName?: string | null; // null = 移出分组（'' 归一为 null）
  tags?: string[];
  priority?: number;
  shareMode?: SourceShareMode;
  userNote?: string;
  aiNote?: string;
  trust?: SourceTrust;
}

export type NormalizedAddOp = {
  kind: 'add';
  scope: SourceScope;
  url: string; // 展示 URL（保留 fragment）
  canonicalKey: string;
  name: string;
  groupName: string | null;
  tags: string[];
  priority: number;
  shareMode: SourceShareMode;
  userNote: string;
  aiNote: string;
  trust: SourceTrust;
};

export type NormalizedUpdateOp = {
  kind: 'update';
  sourceId: string;
  expectedVersion: number;
  patch: NormalizedPatch;
};

export type NormalizedChangeOp =
  | NormalizedAddOp
  | NormalizedUpdateOp
  | { kind: 'disable' | 'restore'; sourceId: string; expectedVersion: number };

export interface NormalizedManualAdd {
  kind: 'add';
  scope: SourceScope;
  url: string;
  canonicalKey: string;
  name: string;
  groupName: string | null;
  tags: string[];
  priority: number;
  shareMode: SourceShareMode;
  userNote: string;
  aiNote: string;
  trust: SourceTrust;
}

export interface ChangeSetValidation {
  ok: boolean;
  errorCode: SourceErrorCode | null;
  reason: string | null; // 中文，日志用（不携带 note/URL 原文）
  ops: NormalizedChangeOp[]; // ok=true 时为规范化 ops（与输入对齐）
  opErrors: (SourceErrorCode | null)[]; // 与输入 ops 对齐（ok=false 时逐项诊断）
}

export interface ManualAddValidation {
  ok: boolean;
  errorCode: SourceErrorCode | null;
  reason: string | null;
  input: NormalizedManualAdd | null;
}

export interface ManualPatchValidation {
  ok: boolean;
  errorCode: SourceErrorCode | null;
  reason: string | null;
  patch: NormalizedPatch | null;
}

// --- 字符串规范化（对齐 logger 家族码点剔除规则；\t 保留） ---

export function stripControlChars(text: string): string {
  // 剔除全部 C0（仅保留 \t）/DEL/NEL/零宽/bidi/行段分隔符/BOM——对齐 logger 家族；
  // \n/\r 一并剔除（name/note 为单行字段，折叠为直接剔除，确定性）
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const strip =
      (cp <= 0x1f && cp !== 0x09) || // C0 除 \t
      cp === 0x7f || // DEL
      cp === 0x85 || // NEL
      (cp >= 0x200b && cp <= 0x200f) || // 零宽 + 双向控制符
      (cp >= 0x2028 && cp <= 0x202e) || // 行段分隔符 + 双向嵌入
      cp === 0x2060 || // 词连接符
      cp === 0xfeff; // BOM
    if (!strip) out += ch;
  }
  return out;
}

const stripNfcTrim = (text: string): string => stripControlChars(text).normalize('NFC').trim();

interface FieldError {
  code: SourceErrorCode;
  reason: string;
}

const fail = (reason: string, code: SourceErrorCode = 'source-invalid-change'): FieldError => ({
  code,
  reason,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFieldError(value: unknown): value is FieldError {
  return (
    isRecord(value) && typeof value['reason'] === 'string' && typeof value['code'] === 'string'
  );
}

function checkKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(obj).every((k) => allowed.includes(k));
}

function normalizeTrust(raw: unknown, channel: Channel): SourceTrust | FieldError {
  if (raw === undefined) {
    return channel === 'ai'
      ? { value: 'unknown', assertedBy: 'ai', verification: 'unverified' }
      : { value: 'unknown', assertedBy: 'user', verification: 'asserted' };
  }
  if (!isRecord(raw)) return fail('trust 必须为对象');
  if (channel === 'manual') {
    if (!checkKeys(raw, ['value'])) return fail('trust 仅允许 value（手工通道）');
    const value = raw['value'];
    if (typeof value !== 'string' || !TRUST_VALUES.includes(value as SourceTrustValue)) {
      return fail('trust.value 非法');
    }
    return { value: value as SourceTrustValue, assertedBy: 'user', verification: 'asserted' };
  }
  // AI 通道：assertedBy 仅 'ai'（缺省 'ai'）；verification 恒 'unverified'
  if (!checkKeys(raw, ['value', 'assertedBy'])) return fail('trust 字段白名单外');
  const value = raw['value'];
  if (typeof value !== 'string' || !TRUST_VALUES.includes(value as SourceTrustValue)) {
    return fail('trust.value 非法');
  }
  const assertedBy = raw['assertedBy'] === undefined ? 'ai' : raw['assertedBy'];
  if (assertedBy !== 'ai') return fail('模型只能断言 assertedBy=ai（SRT-01）');
  return { value: value as SourceTrustValue, assertedBy: 'ai', verification: 'unverified' };
}

function normalizeTags(raw: unknown): string[] | FieldError {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return fail('tags 必须为数组');
  if (raw.length > SOURCE_TAGS_MAX_COUNT) return fail(`tags 超过 ${SOURCE_TAGS_MAX_COUNT} 个上限`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return fail('tag 必须为字符串');
    const tag = stripNfcTrim(item);
    if (tag === '') continue; // 空白 tag 丢弃
    if (tag.length > SOURCE_TAG_MAX_LENGTH)
      return fail(`tag 超过 ${SOURCE_TAG_MAX_LENGTH} 字符上限`);
    if (seen.has(tag)) continue; // NFC 后去重（保持首现）
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function normalizeGroupName(raw: unknown): string | null | FieldError {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return fail('groupName 必须为字符串');
  const name = stripNfcTrim(raw);
  if (name === '') return null; // ''/空白 = 不建组（add）或移出分组（patch）
  if (name.length > SOURCE_GROUP_NAME_MAX_LENGTH) {
    return fail(`group 名超过 ${SOURCE_GROUP_NAME_MAX_LENGTH} 字符上限`);
  }
  return name;
}

function normalizeName(raw: unknown, fallback: () => string): string | FieldError {
  if (raw === undefined) return fallback();
  if (typeof raw !== 'string') return fail('name 必须为字符串');
  const name = stripNfcTrim(raw);
  if (name === '') return fail('name 不能为空');
  if (name.length > SOURCE_NAME_MAX_LENGTH)
    return fail(`name 超过 ${SOURCE_NAME_MAX_LENGTH} 字符上限`);
  return name;
}

function normalizeNote(raw: unknown): string | FieldError {
  if (raw === undefined) return '';
  if (typeof raw !== 'string') return fail('备注必须为字符串');
  const note = stripControlChars(raw);
  return note.length > SOURCE_NOTE_MAX_LENGTH ? note.slice(0, SOURCE_NOTE_MAX_LENGTH) : note;
}

function normalizePriority(raw: unknown): number | FieldError {
  if (raw === undefined) return SOURCE_DEFAULT_PRIORITY;
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < SOURCE_PRIORITY_MIN ||
    raw > SOURCE_PRIORITY_MAX
  ) {
    return fail(`priority 必须为 ${SOURCE_PRIORITY_MIN}–${SOURCE_PRIORITY_MAX} 内整数`);
  }
  return raw;
}

function normalizeShareMode(
  raw: unknown,
  channel: Channel,
): SourceShareMode | undefined | FieldError {
  if (raw === undefined) return undefined; // 调用方按 userNote 决定缺省
  if (typeof raw !== 'string' || !SHARE_MODES.includes(raw as SourceShareMode)) {
    return fail('shareMode 非法');
  }
  if (raw === 'blocked' && channel === 'ai') return fail('模型不能设 blocked（决议 #36）');
  return raw as SourceShareMode;
}

function normalizeSourceId(raw: unknown): string | FieldError {
  if (!isUuidShape(raw)) return fail('sourceId 必须为 UUID 形状');
  return raw;
}

function normalizeExpectedVersion(raw: unknown): number | FieldError {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return fail('expectedVersion 必须为正整数');
  }
  return raw;
}

function normalizeUrlField(raw: unknown): { url: string } | FieldError {
  if (typeof raw !== 'string' || raw.length === 0) return fail('URL 必须为非空字符串');
  if (raw.length > SOURCE_URL_MAX_LENGTH) return fail('URL 超过长度上限');
  if (containsUrlControlChar(raw)) return fail('URL 含控制字符');
  const parsed = normalizeSourceUrl(raw, 'page'); // scheme/userinfo/解析校验与 scope 无关
  return parsed.ok ? { url: parsed.displayUrl } : fail(parsed.reason);
}

// --- 归一化 ---

const ADD_KEYS = [
  'kind',
  'scope',
  'url',
  'name',
  'groupName',
  'tags',
  'priority',
  'shareMode',
  'userNote',
  'aiNote',
  'trust',
] as const;
const PATCH_KEYS = [
  'name',
  'url',
  'groupName',
  'tags',
  'priority',
  'shareMode',
  'userNote',
  'aiNote',
  'trust',
] as const;
const UPDATE_KEYS = ['kind', 'sourceId', 'expectedVersion', 'patch'] as const;
const DISABLE_KEYS = ['kind', 'sourceId', 'expectedVersion'] as const;

function normalizeAddOp(
  raw: Record<string, unknown>,
  channel: Channel,
): NormalizedAddOp | FieldError {
  if (!checkKeys(raw, ADD_KEYS)) return fail('add 含白名单外字段');
  const scope = raw['scope'];
  if (typeof scope !== 'string' || !SCOPES.includes(scope as SourceScope))
    return fail('scope 非法');
  const scopeValue = scope as SourceScope;
  const url = raw['url'];
  if (typeof url !== 'string' || url.length === 0) return fail('url 必填');
  const normalized = normalizeSourceUrl(url, scopeValue);
  if (!normalized.ok) return fail(normalized.reason);
  const userNote = normalizeNote(raw['userNote']);
  if (isFieldError(userNote)) return userNote;
  const aiNote = normalizeNote(raw['aiNote']);
  if (isFieldError(aiNote)) return aiNote;
  const shareModeRaw = normalizeShareMode(raw['shareMode'], channel);
  if (isFieldError(shareModeRaw)) return shareModeRaw;
  const shareMode: SourceShareMode = shareModeRaw ?? (userNote !== '' ? 'full' : 'metadata'); // 缺省规则（决议 #52）
  const name = normalizeName(raw['name'], () => defaultSourceName(url, scopeValue));
  if (isFieldError(name)) return name;
  const groupName = normalizeGroupName(raw['groupName']);
  if (isFieldError(groupName)) return groupName;
  const tags = normalizeTags(raw['tags']);
  if (isFieldError(tags)) return tags;
  const priority = normalizePriority(raw['priority']);
  if (isFieldError(priority)) return priority;
  const trust = normalizeTrust(raw['trust'], channel);
  if (isFieldError(trust)) return trust;
  return {
    kind: 'add',
    scope: scopeValue,
    url: normalized.displayUrl,
    canonicalKey: normalized.canonicalKey,
    name,
    groupName,
    tags,
    priority,
    shareMode,
    userNote,
    aiNote,
    trust,
  };
}

function normalizePatch(
  raw: Record<string, unknown>,
  channel: Channel,
): NormalizedPatch | FieldError {
  if (!checkKeys(raw, PATCH_KEYS)) {
    return fail('patch 含白名单外字段（enabled 不可经 patch，决议 #51）');
  }
  if (Object.keys(raw).length === 0) return fail('patch 不能为空');
  const patch: NormalizedPatch = {};
  if ('name' in raw) {
    const name = normalizeName(raw['name'], () => '');
    if (isFieldError(name)) return name;
    patch.name = name;
  }
  if ('url' in raw) {
    const parsed = normalizeUrlField(raw['url']);
    if (isFieldError(parsed)) return parsed;
    patch.url = parsed.url;
  }
  if ('groupName' in raw) {
    const groupName = normalizeGroupName(raw['groupName']);
    if (isFieldError(groupName)) return groupName;
    patch.groupName = groupName;
  }
  if ('tags' in raw) {
    const tags = normalizeTags(raw['tags']);
    if (isFieldError(tags)) return tags;
    patch.tags = tags;
  }
  if ('priority' in raw) {
    const priority = normalizePriority(raw['priority']);
    if (isFieldError(priority)) return priority;
    patch.priority = priority;
  }
  if ('shareMode' in raw) {
    const shareMode = normalizeShareMode(raw['shareMode'], channel);
    if (isFieldError(shareMode)) return shareMode;
    patch.shareMode = shareMode;
  }
  if ('userNote' in raw) {
    const userNote = normalizeNote(raw['userNote']);
    if (isFieldError(userNote)) return userNote;
    patch.userNote = userNote;
  }
  if ('aiNote' in raw) {
    const aiNote = normalizeNote(raw['aiNote']);
    if (isFieldError(aiNote)) return aiNote;
    patch.aiNote = aiNote;
  }
  if ('trust' in raw) {
    const trust = normalizeTrust(raw['trust'], channel);
    if (isFieldError(trust)) return trust;
    patch.trust = trust;
  }
  return patch;
}

function normalizeUpdateOp(
  raw: Record<string, unknown>,
  channel: Channel,
): NormalizedUpdateOp | FieldError {
  if (!checkKeys(raw, UPDATE_KEYS)) return fail('update 含白名单外字段');
  const sourceId = normalizeSourceId(raw['sourceId']);
  if (isFieldError(sourceId)) return sourceId;
  const expectedVersion = normalizeExpectedVersion(raw['expectedVersion']);
  if (isFieldError(expectedVersion)) return expectedVersion;
  if (!isRecord(raw['patch'])) return fail('patch 必须为对象');
  const patch = normalizePatch(raw['patch'], channel);
  if (isFieldError(patch)) return patch;
  return { kind: 'update', sourceId, expectedVersion, patch };
}

function normalizeDisableRestoreOp(
  raw: Record<string, unknown>,
  kind: 'disable' | 'restore',
): NormalizedChangeOp | FieldError {
  if (!checkKeys(raw, DISABLE_KEYS)) return fail(`${kind} 含白名单外字段`);
  const sourceId = normalizeSourceId(raw['sourceId']);
  if (isFieldError(sourceId)) return sourceId;
  const expectedVersion = normalizeExpectedVersion(raw['expectedVersion']);
  if (isFieldError(expectedVersion)) return expectedVersion;
  return { kind, sourceId, expectedVersion };
}

// --- 顶层校验 ---

export function validateChangeSet(raw: unknown): ChangeSetValidation {
  const empty = (code: SourceErrorCode, reason: string): ChangeSetValidation => ({
    ok: false,
    errorCode: code,
    reason,
    ops: [],
    opErrors: [],
  });
  if (!isRecord(raw)) return empty('source-invalid-change', 'change set 必须为对象');
  const ops = raw['ops'];
  if (!Array.isArray(ops)) return empty('source-invalid-change', 'ops 必须为数组');
  if (ops.length === 0 || ops.length > CHANGE_SET_MAX_OPS) {
    return empty('source-limit', `ops 数量必须为 1–${CHANGE_SET_MAX_OPS}（收到 ${ops.length}）`);
  }
  const normalized: NormalizedChangeOp[] = [];
  const opErrors: (SourceErrorCode | null)[] = [];
  let firstReason: string | null = null;
  let firstCode: SourceErrorCode = 'source-invalid-change';
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    let result: NormalizedChangeOp | FieldError;
    if (!isRecord(op)) {
      result = fail(`第 ${i + 1} 项不是对象`);
    } else {
      const kind = op['kind'];
      if (kind === 'add') result = normalizeAddOp(op, 'ai');
      else if (kind === 'update') result = normalizeUpdateOp(op, 'ai');
      else if (kind === 'disable' || kind === 'restore')
        result = normalizeDisableRestoreOp(op, kind);
      else result = fail(`未知 op kind：${String(kind)}`);
    }
    if (isFieldError(result)) {
      opErrors.push(result.code);
      if (firstReason === null) {
        firstReason = result.reason;
        firstCode = result.code;
      }
      continue;
    }
    opErrors.push(null);
    normalized.push(result);
  }
  if (firstReason !== null) {
    return { ok: false, errorCode: firstCode, reason: firstReason, ops: [], opErrors };
  }
  // 同 set 重复 sourceId（update/disable/restore）→ 整体拒绝（§7.2 冻结）
  const seenIds = new Set<string>();
  for (const op of normalized) {
    if (op.kind !== 'add') {
      if (seenIds.has(op.sourceId)) {
        return {
          ok: false,
          errorCode: 'source-invalid-change',
          reason: '同一 change set 内重复 sourceId',
          ops: [],
          opErrors,
        };
      }
      seenIds.add(op.sourceId);
    }
  }
  return { ok: true, errorCode: null, reason: null, ops: normalized, opErrors };
}

// --- 手工通道 ---

const MANUAL_ADD_KEYS = [
  'scope',
  'url',
  'name',
  'groupName',
  'tags',
  'priority',
  'shareMode',
  'userNote',
  'aiNote',
  'trust',
] as const;

export function validateManualAddInput(raw: unknown): ManualAddValidation {
  const bad = (
    reason: string,
    code: SourceErrorCode = 'source-invalid-change',
  ): ManualAddValidation => ({
    ok: false,
    errorCode: code,
    reason,
    input: null,
  });
  if (!isRecord(raw)) return bad('输入必须为对象');
  if (!checkKeys(raw, MANUAL_ADD_KEYS)) return bad('输入含白名单外字段');
  const result = normalizeAddOp({ kind: 'add', ...raw }, 'manual');
  if (isFieldError(result)) return bad(result.reason, result.code);
  return { ok: true, errorCode: null, reason: null, input: result };
}

export function validateManualPatch(raw: unknown): ManualPatchValidation {
  const bad = (reason: string): ManualPatchValidation => ({
    ok: false,
    errorCode: 'source-invalid-change',
    reason,
    patch: null,
  });
  if (!isRecord(raw)) return bad('patch 必须为对象');
  const patch = normalizePatch(raw, 'manual');
  if (isFieldError(patch)) return bad(patch.reason);
  return { ok: true, errorCode: null, reason: null, patch };
}

// --- 幂等指纹（决议 #53：ops 规范化确定性 SHA-256，node:crypto 零依赖） ---

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function computeChangeSetFingerprint(ops: NormalizedChangeOp[]): string {
  return createHash('sha256').update(stableStringify(ops), 'utf8').digest('hex');
}
