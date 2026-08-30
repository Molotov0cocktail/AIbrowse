// D7 shared event-validator: 双侧 Evidence/Event/响应元数据严格验证 + 幂等键/指纹/
// reversal 纯函数（detailed-design §9.3/§9.4、#S6-047～#S6-051、§8.1/#S6-058）。
// 纯函数、零 IO、零依赖（分层纪律；shared 可被 main 复用，禁止反向依赖）。
//
// 契约要点：
// - validateEvidenceValue/validateChangeEvidencePair 为 exact own-key 严格验证
//   （与 watch-row-validation 同族；本模块为共享事实源，D7 Processing 消费）；
// - idempotencyKey：SHA-256(utf8("watch-event-idem-v1\0"+ruleId+"\0"+baselineVersion
//   十进制+"\0"+newProjectionHash+"\0"+conditionVersion))（#S6-050）；观察级 UNIQUE；
// - conditionVersion="none" 或条件 canonical JSON（固定键序）的 SHA-256；
// - changeFingerprint：pair 级 kind 先行，元组按 UTF-8 字节序排序、\0 连接；
// - pairKind：before=absent/after=present→added；before=present/after=absent→removed；
//   双侧 present→changed；命中 reversal 镜像→reversal；
// - reversal 镜像（#S6-048）：P.before≡Q.after 且 P.after≡Q.before（absent↔absent；
//   present 按 valueHash 相等）；不搜索更早历史；
// - Event kind 聚合：全 added/removed/changed/reversal，其余 mixed；
// - WatchRunResponseMetadata exact-key 验证（schemaVersion=1、http 可空、warnings 闭合
//   排序去重、整体 UTF-8 ≤ MAX_RUN_RESPONSE_META_BYTES）。
import {
  MAX_EVIDENCE_VALUE_BYTES,
  MAX_RUN_RESPONSE_META_BYTES,
  WATCH_EVENT_KINDS,
  type ChangeEvidencePair,
  type CombineMode,
  type ConditionPredicate,
  type ConditionWarningCode,
  type ConditionalResponseMetadata,
  type EvidenceValue,
  type StructuredCondition,
  type WatchEvent,
  type WatchEventKind,
  type WatchNotificationLevel,
  type WatchRunResponseMetadata,
} from '../types/watch';
import { utf8ByteLength } from './watch-budget';
import { sha256Hex } from './diff/evidence';

// ---------------------------------------------------------------------------
// 严格形状验证（exact own-key + own-data；getter/原型链/未来字段 fail-closed）
// ---------------------------------------------------------------------------

function isPlainRecord(raw: unknown): raw is Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  try {
    return Object.getPrototypeOf(raw) === Object.prototype;
  } catch {
    return false;
  }
}

function exactOwnKeys(raw: Record<string, unknown>, expected: readonly string[]): boolean {
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

function isIn<T extends string>(value: unknown, list: readonly T[]): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

function isIsoString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

export function validateEvidenceValue(raw: unknown): EvidenceValue | null {
  if (!isPlainRecord(raw)) return null;
  const kind = raw['kind'];
  if (kind === 'absent') {
    if (!exactOwnKeys(raw, ['kind'])) return null;
    return { kind: 'absent' };
  }
  if (kind !== 'present') return null;
  if (!exactOwnKeys(raw, ['kind', 'excerpt', 'valueHash', 'normalizedBytes', 'truncated'])) {
    return null;
  }
  const excerpt = raw['excerpt'];
  const valueHash = raw['valueHash'];
  const normalizedBytes = raw['normalizedBytes'];
  const truncated = raw['truncated'];
  if (typeof excerpt !== 'string' || utf8ByteLength(excerpt) > MAX_EVIDENCE_VALUE_BYTES) {
    return null;
  }
  if (typeof valueHash !== 'string' || valueHash.length === 0 || valueHash.length > 128) {
    return null;
  }
  if (
    typeof normalizedBytes !== 'number' ||
    !Number.isInteger(normalizedBytes) ||
    normalizedBytes < 0
  ) {
    return null;
  }
  if (typeof truncated !== 'boolean') return null;
  return { kind: 'present', excerpt, valueHash, normalizedBytes, truncated };
}

export function validateChangeEvidencePair(raw: unknown): ChangeEvidencePair | null {
  if (!isPlainRecord(raw)) return null;
  const expected = [
    'itemId',
    'fieldKey',
    'label',
    'before',
    'after',
    'beforeCapturedAt',
    'afterCapturedAt',
    'beforeFinalUrl',
    'afterFinalUrl',
    'beforeDocumentId',
    'afterDocumentId',
    'feedItemKey',
  ];
  if (!exactOwnKeys(raw, expected)) return null;
  const itemId = raw['itemId'];
  const fieldKey = raw['fieldKey'];
  const label = raw['label'];
  const before = validateEvidenceValue(raw['before']);
  const after = validateEvidenceValue(raw['after']);
  if (typeof itemId !== 'string' || itemId.length === 0 || itemId.length > 500) return null;
  if (typeof fieldKey !== 'string' || fieldKey.length === 0 || fieldKey.length > 200) return null;
  if (typeof label !== 'string' || label.length === 0 || label.length > 200) return null;
  if (before === null || after === null) return null;
  const beforeCapturedAt = raw['beforeCapturedAt'];
  const afterCapturedAt = raw['afterCapturedAt'];
  const beforeFinalUrl = raw['beforeFinalUrl'];
  const afterFinalUrl = raw['afterFinalUrl'];
  const beforeDocumentId = raw['beforeDocumentId'];
  const afterDocumentId = raw['afterDocumentId'];
  const feedItemKey = raw['feedItemKey'];
  if (!isIsoString(beforeCapturedAt) || !isIsoString(afterCapturedAt)) return null;
  if (
    typeof beforeFinalUrl !== 'string' ||
    beforeFinalUrl.length === 0 ||
    beforeFinalUrl.length > 2048 ||
    typeof afterFinalUrl !== 'string' ||
    afterFinalUrl.length === 0 ||
    afterFinalUrl.length > 2048
  ) {
    return null;
  }
  if (beforeDocumentId !== null && typeof beforeDocumentId !== 'string') return null;
  if (afterDocumentId !== null && typeof afterDocumentId !== 'string') return null;
  if (feedItemKey !== null && typeof feedItemKey !== 'string') return null;
  return {
    itemId,
    fieldKey,
    label,
    before,
    after,
    beforeCapturedAt,
    afterCapturedAt,
    beforeFinalUrl,
    afterFinalUrl,
    beforeDocumentId,
    afterDocumentId,
    feedItemKey,
  };
}

export function validateWatchEventShape(raw: unknown): WatchEvent | null {
  if (!isPlainRecord(raw)) return null;
  const expected = [
    'id',
    'ruleId',
    'sourceId',
    'eventKind',
    'importance',
    'idempotencyKey',
    'changeFingerprint',
    'firstObservedAt',
    'lastObservedAt',
    'itemCount',
    'readAt',
  ];
  if (!exactOwnKeys(raw, expected)) return null;
  const id = raw['id'];
  const ruleId = raw['ruleId'];
  const sourceId = raw['sourceId'];
  const eventKind = raw['eventKind'];
  const importance = raw['importance'];
  const idempotencyKey = raw['idempotencyKey'];
  const changeFingerprint = raw['changeFingerprint'];
  const firstObservedAt = raw['firstObservedAt'];
  const lastObservedAt = raw['lastObservedAt'];
  const itemCount = raw['itemCount'];
  const readAt = raw['readAt'];
  if (
    typeof id !== 'string' ||
    id === '' ||
    typeof ruleId !== 'string' ||
    ruleId === '' ||
    typeof sourceId !== 'string' ||
    sourceId === '' ||
    typeof idempotencyKey !== 'string' ||
    idempotencyKey === '' ||
    typeof changeFingerprint !== 'string' ||
    changeFingerprint === ''
  ) {
    return null;
  }
  if (!isIn(eventKind, WATCH_EVENT_KINDS)) return null;
  if (importance !== 'normal' && importance !== 'important') return null;
  if (typeof itemCount !== 'number' || !Number.isInteger(itemCount) || itemCount < 1) return null;
  if (!isIsoString(firstObservedAt) || !isIsoString(lastObservedAt)) return null;
  if (readAt !== null && !isIsoString(readAt)) return null;
  return {
    id,
    ruleId,
    sourceId,
    eventKind: eventKind as WatchEventKind,
    importance: importance as WatchNotificationLevel,
    idempotencyKey,
    changeFingerprint,
    firstObservedAt,
    lastObservedAt,
    itemCount,
    readAt,
  };
}

// ---------------------------------------------------------------------------
// conditionVersion（#S6-050）：条件 canonical JSON（固定键序）SHA-256；null → "none"
// ---------------------------------------------------------------------------

function canonicalPredicateJson(p: ConditionPredicate): string {
  return JSON.stringify({
    fieldKey: p.fieldKey,
    operator: p.operator,
    operand: p.operand,
    caseSensitive: p.caseSensitive,
  });
}

function canonicalConditionJson(condition: StructuredCondition): string {
  return JSON.stringify({
    version: condition.version,
    combine: condition.combine as CombineMode,
    predicates: condition.predicates.map(canonicalPredicateJson),
  });
}

export function computeConditionVersion(condition: StructuredCondition | null): string {
  if (condition === null) return 'none';
  return sha256Hex(canonicalConditionJson(condition));
}

// ---------------------------------------------------------------------------
// idempotencyKey / changeFingerprint（#S6-050 固定向量）
// ---------------------------------------------------------------------------

export function computeIdempotencyKey(input: {
  ruleId: string;
  baselineVersion: number;
  newProjectionHash: string;
  conditionVersion: string;
}): string {
  const raw =
    'watch-event-idem-v1\u0000' +
    input.ruleId +
    '\u0000' +
    String(input.baselineVersion) +
    '\u0000' +
    input.newProjectionHash +
    '\u0000' +
    input.conditionVersion;
  return sha256Hex(raw);
}

export type PairKind = 'added' | 'removed' | 'changed' | 'reversal';

/** pair 级 kind 先行（#S6-050）：不含 reversal（reversal 需最近对镜像判定）。 */
export function basePairKind(
  pair: ChangeEvidencePair,
): Extract<PairKind, 'added' | 'removed' | 'changed'> {
  if (pair.before.kind === 'absent' && pair.after.kind === 'present') return 'added';
  if (pair.before.kind === 'present' && pair.after.kind === 'absent') return 'removed';
  return 'changed';
}

/** token = "absent" 或 "p:" + valueHash（#S6-050）。 */
function evidenceToken(value: EvidenceValue): string {
  return value.kind === 'absent' ? 'absent' : `p:${value.valueHash}`;
}

/**
 * changeFingerprint（#S6-050）：pair 级 kind 先行（含 reversal）；元组
 * (itemKey, fieldKey, pairKind, beforeToken, afterToken) 按 UTF-8 字节序排序后
 * 以 \0 连接。itemKey 取 pair.itemId（Feed itemId=identity、Page link=canonical URL）。
 */
export function computeChangeFingerprint(
  tuples: ReadonlyArray<{
    itemKey: string;
    fieldKey: string;
    pairKind: PairKind;
    before: EvidenceValue;
    after: EvidenceValue;
  }>,
): string {
  const encoded = tuples.map(
    (t) =>
      `${t.itemKey}\u0001${t.fieldKey}\u0001${t.pairKind}\u0001${evidenceToken(t.before)}\u0001${evidenceToken(t.after)}`,
  );
  encoded.sort((a, b) => {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return Buffer.compare(ba, bb);
  });
  return sha256Hex(`watch-change-fp-v1\u0000${encoded.join('\u0000')}`);
}

// ---------------------------------------------------------------------------
// reversal 镜像（#S6-048）：P 为 reversal 当且仅当 P.before≡Q.after 且 P.after≡Q.before
// ---------------------------------------------------------------------------

export function evidenceEquals(a: EvidenceValue, b: EvidenceValue): boolean {
  if (a.kind === 'absent' || b.kind === 'absent') return a.kind === b.kind;
  return a.valueHash === b.valueHash;
}

export function isReversalPair(
  pair: Pick<ChangeEvidencePair, 'before' | 'after'>,
  q: Pick<ChangeEvidencePair, 'before' | 'after'> | null,
): boolean {
  if (q === null) return false; // 无历史对必不是 reversal
  return evidenceEquals(pair.before, q.after) && evidenceEquals(pair.after, q.before);
}

// ---------------------------------------------------------------------------
// Event kind 聚合（#S6-049）：全 added/removed/changed/reversal，其余 mixed
// ---------------------------------------------------------------------------

export function aggregateEventKind(kinds: readonly PairKind[]): WatchEventKind {
  if (kinds.length === 0) return 'mixed';
  const all = (k: PairKind): boolean => kinds.every((x) => x === k);
  if (all('added')) return 'added';
  if (all('removed')) return 'removed';
  if (all('changed')) return 'changed';
  if (all('reversal')) return 'reversal';
  return 'mixed';
}

// ---------------------------------------------------------------------------
// ChangeSet 构造（§5 求值输入；Condition 字段目录由 Processing 提供）
// ---------------------------------------------------------------------------

export type ChangeFieldValue = { kind: 'present'; value: string | number } | { kind: 'absent' };

export interface ChangeFieldForCondition {
  fieldKey: string;
  before: ChangeFieldValue;
  after: ChangeFieldValue;
}

export interface StructuredChangeSetForCondition {
  eventKind: WatchEventKind;
  fields: ChangeFieldForCondition[];
}

function changeValueOf(value: EvidenceValue): ChangeFieldValue {
  if (value.kind === 'absent') return { kind: 'absent' };
  return { kind: 'present', value: value.excerpt };
}

/** 由双侧 pair 构造 ChangeSet（每 pair 一条 ChangeField；同 fieldKey 多 pair 保留）。 */
export function buildChangeSet(
  eventKind: WatchEventKind,
  pairs: readonly ChangeEvidencePair[],
): StructuredChangeSetForCondition {
  return {
    eventKind,
    fields: pairs.map((p) => ({
      fieldKey: p.fieldKey,
      before: changeValueOf(p.before),
      after: changeValueOf(p.after),
    })),
  };
}

// ---------------------------------------------------------------------------
// WatchRunResponseMetadata exact-key 验证（§8.1/#S6-058）
// ---------------------------------------------------------------------------

const WARNING_ORDER: readonly ConditionWarningCode[] = [
  'field-absent',
  'numeric-value-unavailable',
  'operator-not-applicable',
];

export function validateRunResponseMetadata(raw: unknown): WatchRunResponseMetadata | null {
  if (!isPlainRecord(raw)) return null;
  if (!exactOwnKeys(raw, ['schemaVersion', 'http', 'conditionWarnings'])) return null;
  if (raw['schemaVersion'] !== 1) return null;
  const http = raw['http'];
  if (http !== null) {
    if (!isPlainRecord(http)) return null;
    if (!exactOwnKeys(http, ['httpStatus', 'etag', 'lastModified', 'warnings'])) return null;
    const httpStatus = http['httpStatus'];
    const etag = http['etag'];
    const lastModified = http['lastModified'];
    const warnings = http['warnings'];
    if (httpStatus !== 200 && httpStatus !== 304) return null;
    if (etag !== null && typeof etag !== 'string') return null;
    if (lastModified !== null && typeof lastModified !== 'string') return null;
    if (!Array.isArray(warnings)) return null;
    const allowed = new Set<ConditionalResponseMetadata['warnings'][number]>([
      'etag-oversize',
      'last-modified-oversize',
    ]);
    const seen = new Set<string>();
    for (const w of warnings) {
      if (typeof w !== 'string' || !allowed.has(w as never)) return null;
      if (seen.has(w)) return null; // 去重
      seen.add(w);
    }
    // 编译期顺序
    const ordered = [...warnings].sort((a, b) => {
      const order = ['etag-oversize', 'last-modified-oversize'];
      return order.indexOf(a as string) - order.indexOf(b as string);
    });
    for (let i = 0; i < ordered.length; i += 1) {
      if (ordered[i] !== warnings[i]) return null;
    }
  }
  const conditionWarnings = raw['conditionWarnings'];
  if (!Array.isArray(conditionWarnings)) return null;
  const allowedWarnings = new Set<ConditionWarningCode>(WARNING_ORDER);
  const seenWarnings = new Set<string>();
  let lastWarningIdx = -1;
  for (const w of conditionWarnings) {
    if (typeof w !== 'string' || !allowedWarnings.has(w as never)) return null;
    if (seenWarnings.has(w)) return null; // 去重
    seenWarnings.add(w);
    const idx = WARNING_ORDER.indexOf(w as ConditionWarningCode);
    if (idx < lastWarningIdx) return null; // 必须按编译期顺序非降序
    lastWarningIdx = idx;
  }
  const serialized = JSON.stringify({ schemaVersion: 1, http, conditionWarnings });
  if (utf8ByteLength(serialized) > MAX_RUN_RESPONSE_META_BYTES) return null;
  return {
    schemaVersion: 1,
    http: http as WatchRunResponseMetadata['http'],
    conditionWarnings: [...conditionWarnings] as ConditionWarningCode[],
  };
}
