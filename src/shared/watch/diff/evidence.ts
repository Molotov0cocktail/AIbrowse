// D7 shared evidence: 双侧 typed Evidence 构造与 URL 安全投影（detailed-design
// §9.3、#S6-046）。纯函数、零 IO、零依赖（分层纪律）。
//
// 契约要点：
// - Feed：EvidenceValue.present 只消费 FeedField.valueHash（截断前完整规范化值 SHA-256），
//   excerpt=FeedField.text、truncated=FeedField.truncated、normalizedBytes=
//   FeedField.originalBytes；禁止对已截断 excerpt 重算哈希冒充完整值哈希。
// - Page：PageProjectionField.value 完整持有（无字段级截断），valueHash=SHA-256(utf8(value))、
//   normalizedBytes=utf8ByteLength(value)；excerpt 取完整规范化值前
//   MAX_EVIDENCE_VALUE_BYTES UTF-8 字节（不拆 surrogate）并标 truncated。
// - URL 安全投影：scheme://host[:port]/path（去 fragment/query）；Cookie/表单/认证零进入。
// - 身份派生：Feed itemId=FeedItem.identity 且 feedItemKey 同值；Page link 字段 itemId 取
//   canonical URL，其余字段取 fieldKey；Page feedItemKey 恒 null。
import { createHash } from 'node:crypto';
import {
  MAX_EVIDENCE_VALUE_BYTES,
  MAX_FEED_FIELD_BYTES,
  type ChangeEvidencePair,
  type EvidenceValue,
  type FeedField,
  type PageProjectionField,
} from '../../types/watch';
import { truncateUtf8, utf8ByteLength } from '../watch-budget';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// URL 安全投影（§9.3：scheme://host[:port]/path，去 fragment/query；仅 http/https、
// 无 userinfo；非法 → null，调用方按 security_rejected 处理）
// ---------------------------------------------------------------------------

export function evidenceSafeUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  parsed.hash = '';
  parsed.search = '';
  return parsed.href;
}

// ---------------------------------------------------------------------------
// Feed Evidence（#S6-046：只消费 FeedField.valueHash）
// ---------------------------------------------------------------------------

/** Feed 字段 → 双侧 present Evidence；只消费截断前 valueHash，禁止重算。 */
export function feedFieldEvidence(field: FeedField): Extract<EvidenceValue, { kind: 'present' }> {
  return {
    kind: 'present',
    excerpt: field.text,
    valueHash: field.valueHash,
    normalizedBytes: field.originalBytes,
    truncated: field.truncated,
  };
}

// ---------------------------------------------------------------------------
// Page Evidence（valueHash/normalizedBytes 由投影值确定性计算；excerpt 有界截断）
// ---------------------------------------------------------------------------

/**
 * Page 投影字段 value → present Evidence。value 为字段的规范化文本（link 字段用
 * text）；valueHash=SHA-256(utf8(value))，normalizedBytes=utf8ByteLength(value)，
 * excerpt 取前 MAX_EVIDENCE_VALUE_BYTES UTF-8 字节并标 truncated。
 */
export function pageValueEvidence(value: string): Extract<EvidenceValue, { kind: 'present' }> {
  const normalizedBytes = utf8ByteLength(value);
  const valueHash = sha256Hex(value);
  const excerpt = truncateUtf8(value, MAX_EVIDENCE_VALUE_BYTES);
  return {
    kind: 'present',
    excerpt: excerpt.text,
    valueHash,
    normalizedBytes,
    truncated: excerpt.truncated,
  };
}

// ---------------------------------------------------------------------------
// 身份派生（§9.3）
// ---------------------------------------------------------------------------

export function feedIdentityOf(identity: string): { itemId: string; feedItemKey: string | null } {
  return { itemId: identity, feedItemKey: identity };
}

/**
 * Page 字段 itemId：link 字段取 canonical URL，其余字段取 fieldKey；feedItemKey 恒 null。
 * canonical URL 非法 → null（调用方跳过该 link pair，视为无法形成合规证据）。
 */
export function pageItemIdOf(field: PageProjectionField): string | null {
  if (field.kind === 'link') {
    return evidenceSafeUrl(field.url);
  }
  return field.fieldKey;
}

// ---------------------------------------------------------------------------
// 双侧 pair 构造辅助（新增/删除/修改统一进入 ChangeEvidencePair）
// ---------------------------------------------------------------------------

export interface PairContext {
  beforeCapturedAt: string;
  afterCapturedAt: string;
  beforeFinalUrl: string;
  afterFinalUrl: string;
  beforeDocumentId: string | null;
  afterDocumentId: string | null;
}

/** URL 投影失败 → null（调用方按 fail-closed 处理：无法形成合规 pair）。 */
export function pairFinalUrls(
  before: string,
  after: string,
): { before: string; after: string } | null {
  const b = evidenceSafeUrl(before);
  const a = evidenceSafeUrl(after);
  if (b === null || a === null) return null;
  return { before: b, after: a };
}

// ---------------------------------------------------------------------------
// Feed/Page projection JSON 持久化验证（#S6-046/#S6-054/#S6-056）：
// 读回校验要求 canonical 重新编码后 JSON、UTF-8 byteLength 与 SHA-256 分别
// 逐字节/逐值恒等；Feed 每个 FeedField 必须携带 valueHash（v2 旧形态无 valueHash
// 读回校验失败 → fail-closed，不静默改写）。
// ---------------------------------------------------------------------------

const FEED_FIELD_HASH_HEX = /^[0-9a-f]{64}$/;

function isValidFeedField(raw: unknown): boolean {
  if (!isPlainRecord(raw)) return false;
  if (!exactOwnKeys(raw, ['text', 'truncated', 'originalBytes', 'valueHash'])) return false;
  const text = raw['text'];
  const truncated = raw['truncated'];
  const originalBytes = raw['originalBytes'];
  const valueHash = raw['valueHash'];
  if (typeof text !== 'string') return false;
  if (typeof truncated !== 'boolean') return false;
  if (typeof originalBytes !== 'number' || !Number.isInteger(originalBytes) || originalBytes < 0) {
    return false;
  }
  // #S6-046：valueHash 只接受 64 hex（截断前完整规范化值哈希）
  if (typeof valueHash !== 'string' || !FEED_FIELD_HASH_HEX.test(valueHash)) return false;
  // 不变式：truncated=false 时 utf8(text)==originalBytes 且可重算 valueHash；
  // truncated=true 时 utf8(text)<=MAX_FEED_FIELD_BYTES 且 originalBytes>utf8(text)
  const bytes = utf8ByteLength(text);
  if (!truncated) {
    if (bytes !== originalBytes) return false;
    if (sha256Hex(text) !== valueHash) return false;
  } else {
    if (bytes > MAX_FEED_FIELD_BYTES) return false;
    if (originalBytes <= bytes) return false;
  }
  return true;
}

function isValidFeedItem(raw: unknown): boolean {
  if (!isPlainRecord(raw)) return false;
  if (
    !exactOwnKeys(raw, [
      'identity',
      'identityKind',
      'title',
      'link',
      'summary',
      'publishedAt',
      'updatedAt',
      'author',
    ])
  ) {
    return false;
  }
  const identity = raw['identity'];
  const identityKind = raw['identityKind'];
  if (typeof identity !== 'string' || identity === '') return false;
  if (
    identityKind !== 'id' &&
    identityKind !== 'guid' &&
    identityKind !== 'link' &&
    identityKind !== 'composite'
  ) {
    return false;
  }
  if (!isValidFeedField(raw['title'])) return false;
  if (!isValidFeedField(raw['link'])) return false;
  if (!isValidFeedField(raw['summary'])) return false;
  if (raw['publishedAt'] !== null && !isValidFeedField(raw['publishedAt'])) return false;
  if (raw['updatedAt'] !== null && !isValidFeedField(raw['updatedAt'])) return false;
  if (!isValidFeedField(raw['author'])) return false;
  return true;
}

export function isValidFeedProjectionValue(raw: unknown): boolean {
  if (!isPlainRecord(raw)) return false;
  if (
    !exactOwnKeys(raw, [
      'type',
      'format',
      'title',
      'description',
      'siteUrl',
      'feedUrl',
      'items',
      'itemsTruncated',
    ])
  ) {
    return false;
  }
  if (raw['type'] !== 'feed') return false;
  if (raw['format'] !== 'rss2' && raw['format'] !== 'atom') return false;
  if (!isValidFeedField(raw['title'])) return false;
  if (!isValidFeedField(raw['description'])) return false;
  if (!isValidFeedField(raw['siteUrl'])) return false;
  if (!isValidFeedField(raw['feedUrl'])) return false;
  if (typeof raw['itemsTruncated'] !== 'boolean') return false;
  if (!Array.isArray(raw['items'])) return false;
  for (const item of raw['items']) {
    if (!isValidFeedItem(item)) return false;
  }
  return true;
}

/** PageProjectionValue 读回形状验证（字段目录闭合；字段值为规范化文本）。 */
export function isValidPageProjectionValue(raw: unknown): boolean {
  if (!isPlainRecord(raw)) return false;
  if (!exactOwnKeys(raw, ['type', 'fields'])) return false;
  if (raw['type'] !== 'page') return false;
  if (!Array.isArray(raw['fields'])) return false;
  for (const f of raw['fields']) {
    if (!isPlainRecord(f)) return false;
    if (!exactOwnKeys(f, ['fieldKey', 'regionIndex', 'kind', 'label', 'value'])) return false;
    if (typeof f['fieldKey'] !== 'string' || f['fieldKey'] === '') return false;
    if (
      typeof f['regionIndex'] !== 'number' ||
      !Number.isInteger(f['regionIndex']) ||
      f['regionIndex'] < 0
    ) {
      return false;
    }
    if (
      f['kind'] !== 'main-text' &&
      f['kind'] !== 'heading' &&
      f['kind'] !== 'table-header' &&
      f['kind'] !== 'table-cell' &&
      f['kind'] !== 'link'
    ) {
      return false;
    }
    if (typeof f['label'] !== 'string' || f['label'] === '') return false;
    if (typeof f['value'] !== 'string') return false;
  }
  return true;
}

export function isPlainRecord(raw: unknown): raw is Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  try {
    return Object.getPrototypeOf(raw) === Object.prototype;
  } catch {
    return false;
  }
}

export function exactOwnKeys(raw: Record<string, unknown>, expected: readonly string[]): boolean {
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(raw);
  } catch {
    return false;
  }
  if (keys.length !== expected.length) return false;
  const set = new Set<string>(expected);
  for (const k of keys) {
    if (typeof k !== 'string' || !set.has(k)) return false;
  }
  return true;
}

export function makeEvidencePair(input: {
  itemId: string;
  fieldKey: string;
  label: string;
  before: EvidenceValue;
  after: EvidenceValue;
  feedItemKey: string | null;
  context: PairContext;
}): ChangeEvidencePair | null {
  const urls = pairFinalUrls(input.context.beforeFinalUrl, input.context.afterFinalUrl);
  if (urls === null) return null;
  if (input.itemId === '' || input.fieldKey === '' || input.label === '') return null;
  return {
    itemId: input.itemId,
    fieldKey: input.fieldKey,
    label: input.label,
    before: input.before,
    after: input.after,
    beforeCapturedAt: input.context.beforeCapturedAt,
    afterCapturedAt: input.context.afterCapturedAt,
    beforeFinalUrl: urls.before,
    afterFinalUrl: urls.after,
    beforeDocumentId: input.context.beforeDocumentId,
    afterDocumentId: input.context.afterDocumentId,
    feedItemKey: input.feedItemKey,
  };
}
