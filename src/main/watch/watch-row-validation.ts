// Sixth Stage D4: watch.db 行读回二次校验与 JSON 形状校验（main 侧；
// detailed-design §10.1「所有 JSON 读取后再次用共享 validator，非法/未来版本
// 使 Store unavailable」+ §9.3/§9.4/§10.3 域形状）。纯逻辑、零 IO、零网络。
// 边界：
// - 结构/版本/枚举/预算逐项 fail-closed；任何非法输入返回 null/false，绝不抛穿；
// - condition 的 fieldKey 目录成员资格是 D5 创建期语义（目录由目标投影派生、
//   不落库）——本模块只做结构/版本/操作符/操作数形状校验（诚实边界注释）；
// - Evidence 摘录按 MAX_EVIDENCE_VALUE_BYTES 复核存储预算；
// - 时间是 ISO 字符串且 Date.parse 有限（主进程盖章节律）。
import {
  CONDITION_OPERATORS,
  PAUSE_REASONS,
  WATCH_ACCESS_MODES,
  WATCH_EVENT_KINDS,
  WATCH_FAILURE_CODES,
  WATCH_HEALTH_STATES,
  WATCH_NOTIFICATION_LEVELS,
  WATCH_RULE_KINDS,
  WATCH_RULE_STATES,
  WATCH_RUN_TRIGGERS,
  MAX_CONDITIONAL_FIELD_BYTES,
  MAX_DIGEST_BYTES,
  MAX_DIGEST_FACTS_BYTES,
  MAX_EVIDENCE_VALUE_BYTES,
  MAX_RUN_RESPONSE_META_BYTES,
  type ChangeEvidencePair,
  type ConditionWarningCode,
  type EvidenceValue,
  type PauseReason,
  type SourceWatchProjection,
  type StructuredCondition,
  type WatchEvent,
  type WatchHealthSnapshot,
  type WatchRule,
  type WatchRuleState,
  type WatchRunOutcome,
  type WatchSchedule,
  type DigestFacts,
} from '../../shared/types/watch';
import { validateFeedTarget, validatePageTarget } from '../../shared/watch/watch-targets';
import { validateWatchSchedule } from '../../shared/watch/watch-rule-state';
import { utf8ByteLength } from '../../shared/watch/watch-budget';
import { canonicalizeDigestFacts } from '../../shared/watch/digest-facts';
import {
  parseDigestExplanation,
  serializeDigestArtifact,
} from '../../shared/watch/digest-validator';

export type WatchRowErrorCode =
  | 'row-shape-invalid'
  | 'enum-invalid'
  | 'integer-invalid'
  | 'time-invalid'
  | 'json-parse-failed'
  | 'schedule-invalid'
  | 'target-invalid'
  | 'condition-invalid'
  | 'kind-access-mismatch'
  | 'fingerprint-invalid'
  | 'evidence-invalid'
  | 'outcome-invalid'
  | 'health-invalid'
  | 'projection-invalid'
  | 'consistency-invalid';

export interface WatchRowValidation<T> {
  ok: boolean;
  value: T | null;
  reason: WatchRowErrorCode | null;
}

// ---------------------------------------------------------------------------
// 基础判定
// ---------------------------------------------------------------------------

export function parseJsonSafe(text: unknown): unknown | null {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isIsoString(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  return Number.isFinite(Date.parse(value));
}

function isNullableIsoString(value: unknown): value is string | null {
  return value === null || isIsoString(value);
}

function isIn<T extends string>(value: unknown, list: readonly T[]): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

function isInt(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min;
}

const FINGERPRINT_HEX = /^[0-9a-f]{64}$/;

export function isValidLocatorFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_HEX.test(value);
}

// ---------------------------------------------------------------------------
// Evidence（§9.3；D7 将在此基础上建立双侧 EventValidator）
// ---------------------------------------------------------------------------

export function validateEvidenceValue(raw: unknown): EvidenceValue | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  let record: Record<string, unknown>;
  try {
    record = raw as Record<string, unknown>;
    if (Object.getPrototypeOf(record) !== Object.prototype) return null;
  } catch {
    return null;
  }
  const kind = record['kind'];
  if (kind === 'absent') {
    if (Reflect.ownKeys(record).length !== 1) return null;
    return { kind: 'absent' };
  }
  if (kind !== 'present') return null;
  const keys = Reflect.ownKeys(record);
  const expected = ['kind', 'excerpt', 'valueHash', 'normalizedBytes', 'truncated'];
  if (keys.length !== expected.length || !expected.every((k) => keys.includes(k))) return null;
  const excerpt = record['excerpt'];
  const valueHash = record['valueHash'];
  const normalizedBytes = record['normalizedBytes'];
  const truncated = record['truncated'];
  if (typeof excerpt !== 'string') return null;
  if (utf8ByteLength(excerpt) > MAX_EVIDENCE_VALUE_BYTES) return null;
  if (typeof valueHash !== 'string' || valueHash.length === 0 || valueHash.length > 128) {
    return null;
  }
  if (!isInt(normalizedBytes)) return null;
  if (typeof truncated !== 'boolean') return null;
  return { kind: 'present', excerpt, valueHash, normalizedBytes, truncated };
}

export function validateChangeEvidencePair(raw: unknown): ChangeEvidencePair | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  let record: Record<string, unknown>;
  try {
    record = raw as Record<string, unknown>;
    if (Object.getPrototypeOf(record) !== Object.prototype) return null;
  } catch {
    return null;
  }
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
  const keys = Reflect.ownKeys(record);
  if (keys.length !== expected.length || !expected.every((k) => keys.includes(k))) return null;
  const itemId = record['itemId'];
  const fieldKey = record['fieldKey'];
  const label = record['label'];
  const before = validateEvidenceValue(record['before']);
  const after = validateEvidenceValue(record['after']);
  if (typeof itemId !== 'string' || itemId.length === 0 || itemId.length > 500) return null;
  if (typeof fieldKey !== 'string' || fieldKey.length === 0 || fieldKey.length > 200) return null;
  if (typeof label !== 'string' || label.length === 0 || label.length > 200) return null;
  if (before === null || after === null) return null;
  const beforeCapturedAt = record['beforeCapturedAt'];
  const afterCapturedAt = record['afterCapturedAt'];
  const beforeFinalUrl = record['beforeFinalUrl'];
  const afterFinalUrl = record['afterFinalUrl'];
  const beforeDocumentId = record['beforeDocumentId'];
  const afterDocumentId = record['afterDocumentId'];
  const feedItemKey = record['feedItemKey'];
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

// ---------------------------------------------------------------------------
// Condition（存储层结构校验；目录成员资格为 D5 创建期语义——目录不落库）
// ---------------------------------------------------------------------------

const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);
const ARRAY_INDEX_PATTERN = /^\d+$/;

function isValidStoredFieldKey(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  if (DANGEROUS_KEYS.has(value)) return false;
  if (value.includes('*') || value.includes('?')) return false;
  if (ARRAY_INDEX_PATTERN.test(value)) return false;
  if (value.includes('.') || value.includes('[') || value.includes(']')) return false;
  return value.length <= 200;
}

export function validateStoredCondition(raw: unknown): WatchRowValidation<StructuredCondition> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, value: null, reason: 'condition-invalid' };
  }
  let record: Record<string, unknown>;
  try {
    record = raw as Record<string, unknown>;
    if (Object.getPrototypeOf(record) !== Object.prototype) {
      return { ok: false, value: null, reason: 'condition-invalid' };
    }
  } catch {
    return { ok: false, value: null, reason: 'condition-invalid' };
  }
  const keys = Reflect.ownKeys(record);
  if (
    keys.length !== 3 ||
    record['version'] !== 1 ||
    !keys.includes('combine') ||
    !keys.includes('predicates')
  ) {
    return { ok: false, value: null, reason: 'condition-invalid' };
  }
  const combine = record['combine'];
  const predicates = record['predicates'];
  if (combine !== 'all' && combine !== 'any') {
    return { ok: false, value: null, reason: 'condition-invalid' };
  }
  if (!Array.isArray(predicates) || predicates.length < 1 || predicates.length > 10) {
    return { ok: false, value: null, reason: 'condition-invalid' };
  }
  const parsed: StructuredCondition['predicates'] = [];
  for (const p of predicates) {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      return { ok: false, value: null, reason: 'condition-invalid' };
    }
    let pr: Record<string, unknown>;
    try {
      pr = p as Record<string, unknown>;
      if (Object.getPrototypeOf(pr) !== Object.prototype) {
        return { ok: false, value: null, reason: 'condition-invalid' };
      }
    } catch {
      return { ok: false, value: null, reason: 'condition-invalid' };
    }
    const pKeys = Reflect.ownKeys(pr);
    if (
      pKeys.length !== 4 ||
      !pKeys.includes('fieldKey') ||
      !pKeys.includes('operator') ||
      !pKeys.includes('operand') ||
      !pKeys.includes('caseSensitive')
    ) {
      return { ok: false, value: null, reason: 'condition-invalid' };
    }
    if (!isValidStoredFieldKey(pr['fieldKey'])) {
      return { ok: false, value: null, reason: 'condition-invalid' };
    }
    if (!isIn(pr['operator'], CONDITION_OPERATORS)) {
      return { ok: false, value: null, reason: 'condition-invalid' };
    }
    const operand = pr['operand'];
    if (operand !== null) {
      if (typeof operand === 'number') {
        if (!Number.isFinite(operand))
          return { ok: false, value: null, reason: 'condition-invalid' };
      } else if (typeof operand === 'string') {
        if (operand.length === 0 || operand.length > 500) {
          return { ok: false, value: null, reason: 'condition-invalid' };
        }
      } else {
        return { ok: false, value: null, reason: 'condition-invalid' };
      }
    }
    if (typeof pr['caseSensitive'] !== 'boolean') {
      return { ok: false, value: null, reason: 'condition-invalid' };
    }
    parsed.push({
      fieldKey: pr['fieldKey'],
      operator: pr['operator'] as StructuredCondition['predicates'][number]['operator'],
      operand: operand as string | number | null,
      caseSensitive: pr['caseSensitive'],
    });
  }
  return {
    ok: true,
    value: { version: 1, combine: combine as 'all' | 'any', predicates: parsed },
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// Run outcome / health（§3.3）
// ---------------------------------------------------------------------------

export function validateWatchRunOutcome(raw: unknown): WatchRunOutcome | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  let record: Record<string, unknown>;
  try {
    record = raw as Record<string, unknown>;
    if (Object.getPrototypeOf(record) !== Object.prototype) return null;
  } catch {
    return null;
  }
  const kind = record['kind'];
  if (kind === 'baseline-established') {
    const keys = Reflect.ownKeys(record);
    if (keys.length !== 2 || !keys.includes('auditId')) return null;
    if (typeof record['auditId'] !== 'string' || record['auditId'] === '') return null;
    return { kind: 'baseline-established', auditId: record['auditId'] };
  }
  if (kind === 'unchanged') {
    if (Reflect.ownKeys(record).length !== 1) return null;
    return { kind: 'unchanged' };
  }
  if (kind === 'changed-unmatched') {
    const keys = Reflect.ownKeys(record);
    if (keys.length !== 2 || !keys.includes('changeFingerprint')) return null;
    if (typeof record['changeFingerprint'] !== 'string' || record['changeFingerprint'] === '') {
      return null;
    }
    return { kind: 'changed-unmatched', changeFingerprint: record['changeFingerprint'] };
  }
  if (kind === 'event-created' || kind === 'event-coalesced' || kind === 'event-deduplicated') {
    const keys = Reflect.ownKeys(record);
    if (keys.length !== 2 || !keys.includes('eventId')) return null;
    if (typeof record['eventId'] !== 'string' || record['eventId'] === '') return null;
    return { kind, eventId: record['eventId'] };
  }
  if (kind === 'failed') {
    const keys = Reflect.ownKeys(record);
    if (keys.length !== 3 || !keys.includes('health') || !keys.includes('retryable')) return null;
    if (!isIn(record['health'], WATCH_FAILURE_CODES)) return null;
    if (typeof record['retryable'] !== 'boolean') return null;
    return {
      kind: 'failed',
      health: record['health'],
      retryable: record['retryable'],
    };
  }
  if (kind === 'aborted') {
    const keys = Reflect.ownKeys(record);
    if (keys.length !== 2 || !keys.includes('reason')) return null;
    if (!isIn(record['reason'], ['shutdown', 'user', 'superseded'] as const)) return null;
    return { kind: 'aborted', reason: record['reason'] };
  }
  return null; // 未来 kind fail-closed
}

export function validateWatchHealthSnapshot(raw: unknown): WatchHealthSnapshot | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  let record: Record<string, unknown>;
  try {
    record = raw as Record<string, unknown>;
    if (Object.getPrototypeOf(record) !== Object.prototype) return null;
  } catch {
    return null;
  }
  const keys = Reflect.ownKeys(record);
  if (
    keys.length !== 3 ||
    !keys.includes('state') ||
    !keys.includes('acquisition') ||
    !keys.includes('code')
  ) {
    return null;
  }
  if (!isIn(record['state'], WATCH_HEALTH_STATES)) return null;
  if (!isIn(record['acquisition'], ['rss', 'browser'] as const)) return null;
  const code = record['code'];
  if (record['state'] === 'healthy') {
    if (code !== null) return null;
    return { state: 'healthy', acquisition: record['acquisition'], code: null };
  }
  if (!isIn(code, WATCH_FAILURE_CODES)) return null;
  return {
    state: record['state'] as 'degraded' | 'paused',
    acquisition: record['acquisition'],
    code,
  };
}

// ---------------------------------------------------------------------------
// SourceWatchProjection（§10.3；intent before/after JSON）
// ---------------------------------------------------------------------------

export function validateSourceWatchProjection(raw: unknown): SourceWatchProjection | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  let record: Record<string, unknown>;
  try {
    record = raw as Record<string, unknown>;
    if (Object.getPrototypeOf(record) !== Object.prototype) return null;
  } catch {
    return null;
  }
  const expected = ['sourceId', 'rowVersion', 'enabled', 'deletedAt', 'scope', 'canonicalKey'];
  const keys = Reflect.ownKeys(record);
  if (keys.length !== expected.length || !expected.every((k) => keys.includes(k))) return null;
  const sourceId = record['sourceId'];
  const rowVersion = record['rowVersion'];
  const enabled = record['enabled'];
  const deletedAt = record['deletedAt'];
  const scope = record['scope'];
  const canonicalKey = record['canonicalKey'];
  if (typeof sourceId !== 'string' || sourceId === '' || sourceId.length > 100) return null;
  if (!isInt(rowVersion, 1)) return null;
  if (typeof enabled !== 'boolean') return null;
  if (!isNullableIsoString(deletedAt)) return null;
  if (scope !== 'origin' && scope !== 'page') return null;
  if (typeof canonicalKey !== 'string' || canonicalKey === '' || canonicalKey.length > 2048) {
    return null;
  }
  return { sourceId, rowVersion, enabled, deletedAt, scope, canonicalKey };
}

// ---------------------------------------------------------------------------
// intent affected_rule_state（prepare 前状态映射；§10.3）
// ---------------------------------------------------------------------------

export interface AffectedRulePrepareState {
  state: WatchRuleState;
  pauseReason: PauseReason | null;
  desiredEnabled: boolean;
  sourceRowVersion: number;
  sourceLocatorFingerprint: string;
}

export function validateAffectedRuleStateMap(
  raw: unknown,
): Record<string, AffectedRulePrepareState> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  let record: Record<string, unknown>;
  try {
    record = raw as Record<string, unknown>;
    if (Object.getPrototypeOf(record) !== Object.prototype) return null;
  } catch {
    return null;
  }
  const out: Record<string, AffectedRulePrepareState> = {};
  for (const [ruleId, value] of Object.entries(record)) {
    if (ruleId === '' || ruleId.length > 100) return null;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    let state: Record<string, unknown>;
    try {
      state = value as Record<string, unknown>;
      if (Object.getPrototypeOf(state) !== Object.prototype) return null;
    } catch {
      return null;
    }
    const expected = [
      'state',
      'pauseReason',
      'desiredEnabled',
      'sourceRowVersion',
      'sourceLocatorFingerprint',
    ];
    const keys = Reflect.ownKeys(state);
    if (keys.length !== expected.length || !expected.every((k) => keys.includes(k))) return null;
    if (!isIn(state['state'], WATCH_RULE_STATES)) return null;
    if (state['pauseReason'] !== null && !isIn(state['pauseReason'], PAUSE_REASONS)) return null;
    if (typeof state['desiredEnabled'] !== 'boolean') return null;
    if (!isInt(state['sourceRowVersion'], 1)) return null;
    if (!isValidLocatorFingerprint(state['sourceLocatorFingerprint'])) return null;
    out[ruleId] = {
      state: state['state'],
      pauseReason: state['pauseReason'],
      desiredEnabled: state['desiredEnabled'],
      sourceRowVersion: state['sourceRowVersion'],
      sourceLocatorFingerprint: state['sourceLocatorFingerprint'],
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 行（repository SELECT 显式列 → WatchRule）
// ---------------------------------------------------------------------------

export interface WatchRuleRowColumns {
  id: string;
  source_id: string;
  kind: string;
  state: string;
  pause_reason: string | null;
  desired_enabled: number;
  muted: number;
  access_mode: string;
  schedule_json: string;
  target_json: string;
  condition_json: string | null;
  notification_level: string;
  source_row_version: number;
  source_locator_fingerprint: string;
  next_due_at: string | null;
  last_consumed_scheduled_for: string | null;
  last_daily_local_date: string | null;
  consecutive_failures: number;
  backoff_until: string | null;
  baseline_version: number;
  created_at: string;
  updated_at: string;
}

export function validateRuleRow(row: unknown): WatchRowValidation<WatchRule> {
  const r = row as WatchRuleRowColumns | null;
  if (typeof r !== 'object' || r === null) {
    return { ok: false, value: null, reason: 'row-shape-invalid' };
  }
  if (
    typeof r.id !== 'string' ||
    r.id === '' ||
    typeof r.source_id !== 'string' ||
    r.source_id === ''
  ) {
    return { ok: false, value: null, reason: 'row-shape-invalid' };
  }
  if (!isIn(r.kind, WATCH_RULE_KINDS)) return { ok: false, value: null, reason: 'enum-invalid' };
  if (!isIn(r.state, WATCH_RULE_STATES)) return { ok: false, value: null, reason: 'enum-invalid' };
  if (r.pause_reason !== null && !isIn(r.pause_reason, PAUSE_REASONS)) {
    return { ok: false, value: null, reason: 'enum-invalid' };
  }
  if (r.desired_enabled !== 0 && r.desired_enabled !== 1) {
    return { ok: false, value: null, reason: 'enum-invalid' };
  }
  if (r.muted !== 0 && r.muted !== 1) return { ok: false, value: null, reason: 'enum-invalid' };
  if (!isIn(r.access_mode, WATCH_ACCESS_MODES)) {
    return { ok: false, value: null, reason: 'enum-invalid' };
  }
  if (!isIn(r.notification_level, WATCH_NOTIFICATION_LEVELS)) {
    return { ok: false, value: null, reason: 'enum-invalid' };
  }
  if (!isInt(r.source_row_version, 1)) return { ok: false, value: null, reason: 'integer-invalid' };
  if (!isValidLocatorFingerprint(r.source_locator_fingerprint)) {
    return { ok: false, value: null, reason: 'fingerprint-invalid' };
  }
  if (!isInt(r.consecutive_failures)) return { ok: false, value: null, reason: 'integer-invalid' };
  if (!isInt(r.baseline_version)) return { ok: false, value: null, reason: 'integer-invalid' };
  if (
    !isNullableIsoString(r.next_due_at) ||
    !isNullableIsoString(r.last_consumed_scheduled_for) ||
    !isNullableIsoString(r.last_daily_local_date) ||
    !isNullableIsoString(r.backoff_until) ||
    !isIsoString(r.created_at) ||
    !isIsoString(r.updated_at)
  ) {
    return { ok: false, value: null, reason: 'time-invalid' };
  }
  const scheduleRaw = parseJsonSafe(r.schedule_json);
  if (scheduleRaw === null) return { ok: false, value: null, reason: 'json-parse-failed' };
  const schedule = validateWatchSchedule(scheduleRaw);
  if (!schedule.ok) return { ok: false, value: null, reason: 'schedule-invalid' };
  const targetRaw = parseJsonSafe(r.target_json);
  if (targetRaw === null) return { ok: false, value: null, reason: 'json-parse-failed' };
  const feedTarget = validateFeedTarget(targetRaw);
  const pageTarget = validatePageTarget(targetRaw);
  const targetKind = r.kind === 'feed' && feedTarget.ok ? ('feed' as const) : null;
  const targetPage = r.kind === 'page' && pageTarget.ok ? ('page' as const) : null;
  if (targetKind === null && targetPage === null) {
    return { ok: false, value: null, reason: 'target-invalid' };
  }
  // feed 仅 public；session 仅 page（决策 4）
  if (
    (r.kind === 'feed' && r.access_mode !== 'public') ||
    (r.access_mode === 'session' && r.kind !== 'page')
  ) {
    return { ok: false, value: null, reason: 'kind-access-mismatch' };
  }
  let condition: StructuredCondition | null = null;
  if (r.condition_json !== null) {
    const conditionRaw = parseJsonSafe(r.condition_json);
    if (conditionRaw === null) return { ok: false, value: null, reason: 'json-parse-failed' };
    const validated = validateStoredCondition(conditionRaw);
    if (!validated.ok || validated.value === null) {
      return { ok: false, value: null, reason: 'condition-invalid' };
    }
    condition = validated.value;
  }
  // paused 与 pause_reason 一致性（paused 必须有原因；非 paused 原因必须为 null）
  if (r.state === 'paused' && r.pause_reason === null) {
    return { ok: false, value: null, reason: 'consistency-invalid' };
  }
  if (r.state !== 'paused' && r.pause_reason !== null) {
    return { ok: false, value: null, reason: 'consistency-invalid' };
  }
  const target =
    targetKind === 'feed' && feedTarget.ok
      ? feedTarget.target
      : targetPage === 'page' && pageTarget.ok
        ? pageTarget.target
        : null;
  if (target === null) return { ok: false, value: null, reason: 'target-invalid' };
  const rule: WatchRule = {
    id: r.id,
    sourceId: r.source_id,
    kind: r.kind as WatchRule['kind'],
    state: r.state as WatchRuleState,
    pauseReason: r.pause_reason as PauseReason | null,
    desiredEnabled: r.desired_enabled === 1,
    muted: r.muted === 1,
    accessMode: r.access_mode as WatchRule['accessMode'],
    schedule: schedule.schedule as WatchSchedule,
    target,
    condition,
    notificationLevel: r.notification_level as WatchRule['notificationLevel'],
    sourceRowVersion: r.source_row_version,
    sourceLocatorFingerprint: r.source_locator_fingerprint,
    nextDueAt: r.next_due_at,
    lastConsumedScheduledFor: r.last_consumed_scheduled_for,
    lastDailyLocalDate: r.last_daily_local_date,
    consecutiveFailures: r.consecutive_failures,
    backoffUntil: r.backoff_until,
    baselineVersion: r.baseline_version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  return { ok: true, value: rule, reason: null };
}

// ---------------------------------------------------------------------------
// Event 行（§9.4）
// ---------------------------------------------------------------------------

export interface WatchEventRowColumns {
  id: string;
  rule_id: string;
  source_id: string;
  event_kind: string;
  importance: string;
  idempotency_key: string;
  change_fingerprint: string;
  first_observed_at: string;
  last_observed_at: string;
  item_count: number;
  read_at: string | null;
}

export function validateEventRow(row: unknown): WatchRowValidation<WatchEvent> {
  const r = row as WatchEventRowColumns | null;
  if (typeof r !== 'object' || r === null) {
    return { ok: false, value: null, reason: 'row-shape-invalid' };
  }
  if (
    typeof r.id !== 'string' ||
    r.id === '' ||
    typeof r.rule_id !== 'string' ||
    r.rule_id === '' ||
    typeof r.source_id !== 'string' ||
    r.source_id === '' ||
    typeof r.idempotency_key !== 'string' ||
    r.idempotency_key === '' ||
    typeof r.change_fingerprint !== 'string' ||
    r.change_fingerprint === ''
  ) {
    return { ok: false, value: null, reason: 'row-shape-invalid' };
  }
  if (!isIn(r.event_kind, WATCH_EVENT_KINDS))
    return { ok: false, value: null, reason: 'enum-invalid' };
  if (!isIn(r.importance, WATCH_NOTIFICATION_LEVELS)) {
    return { ok: false, value: null, reason: 'enum-invalid' };
  }
  if (!isInt(r.item_count, 1)) return { ok: false, value: null, reason: 'integer-invalid' };
  if (!isIsoString(r.first_observed_at) || !isIsoString(r.last_observed_at)) {
    return { ok: false, value: null, reason: 'time-invalid' };
  }
  if (r.read_at !== null && !isIsoString(r.read_at)) {
    return { ok: false, value: null, reason: 'time-invalid' };
  }
  return {
    ok: true,
    value: {
      id: r.id,
      ruleId: r.rule_id,
      sourceId: r.source_id,
      eventKind: r.event_kind as WatchEvent['eventKind'],
      importance: r.importance as WatchEvent['importance'],
      idempotencyKey: r.idempotency_key,
      changeFingerprint: r.change_fingerprint,
      firstObservedAt: r.first_observed_at,
      lastObservedAt: r.last_observed_at,
      itemCount: r.item_count,
      readAt: r.read_at,
    },
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// Baseline 行 / Run 行
// ---------------------------------------------------------------------------

export interface WatchBaselineRow {
  ruleId: string;
  version: number;
  projectionType: 'feed' | 'page';
  projectionJson: string;
  contentHash: string;
  byteLength: number;
  finalUrl: string;
  capturedAt: string;
  documentId: string | null;
  conditionalEtag: string | null; // D7 #S6-056：Feed Baseline 条件 validator（Page 恒 null）
  conditionalLastModified: string | null;
}

export function validateBaselineRow(row: unknown): WatchRowValidation<WatchBaselineRow> {
  const r = row as WatchBaselineRow | null;
  if (typeof r !== 'object' || r === null) {
    return { ok: false, value: null, reason: 'row-shape-invalid' };
  }
  if (
    typeof r.ruleId !== 'string' ||
    r.ruleId === '' ||
    !isInt(r.version, 1) ||
    (r.projectionType !== 'feed' && r.projectionType !== 'page') ||
    typeof r.projectionJson !== 'string' ||
    typeof r.contentHash !== 'string' ||
    r.contentHash === '' ||
    !isInt(r.byteLength) ||
    typeof r.finalUrl !== 'string' ||
    r.finalUrl === '' ||
    r.finalUrl.length > 2048 ||
    !isIsoString(r.capturedAt) ||
    (r.documentId !== null && typeof r.documentId !== 'string')
  ) {
    return { ok: false, value: null, reason: 'row-shape-invalid' };
  }
  if (parseJsonSafe(r.projectionJson) === null) {
    return { ok: false, value: null, reason: 'json-parse-failed' };
  }
  // #S6-056：条件 validator 列可空；Page Baseline 两列必须均为 null（DB CHECK 纵深，
  // 此处 TS 同样 enforce）；字符串必须 ≤ MAX_CONDITIONAL_FIELD_BYTES（UTF-8 字节）。
  if (r.conditionalEtag !== null && typeof r.conditionalEtag !== 'string') {
    return { ok: false, value: null, reason: 'row-shape-invalid' };
  }
  if (r.conditionalLastModified !== null && typeof r.conditionalLastModified !== 'string') {
    return { ok: false, value: null, reason: 'row-shape-invalid' };
  }
  if (
    r.conditionalEtag !== null &&
    utf8ByteLength(r.conditionalEtag) > MAX_CONDITIONAL_FIELD_BYTES
  ) {
    return { ok: false, value: null, reason: 'row-shape-invalid' };
  }
  if (
    r.conditionalLastModified !== null &&
    utf8ByteLength(r.conditionalLastModified) > MAX_CONDITIONAL_FIELD_BYTES
  ) {
    return { ok: false, value: null, reason: 'row-shape-invalid' };
  }
  if (
    r.projectionType === 'page' &&
    (r.conditionalEtag !== null || r.conditionalLastModified !== null)
  ) {
    return { ok: false, value: null, reason: 'consistency-invalid' };
  }
  return { ok: true, value: r, reason: null };
}

/** R3-3：Baseline 条件 validator 写前 runtime 规则（与 validateBaselineRow 同源）——
 * etag/lastModified 为 string|null 且非 null 时 UTF-8 ≤ MAX_CONDITIONAL_FIELD_BYTES；
 * projectionType='page' 时两列必须均为 null。所有写路径（writeBaseline、
 * applyBaselineInternal、unchanged validator 更新）写前复用，超限 fail-closed。 */
export function validateBaselineValidators(input: {
  projectionType: 'feed' | 'page';
  etag: string | null;
  lastModified: string | null;
}): boolean {
  if (input.etag !== null && typeof input.etag !== 'string') return false;
  if (input.lastModified !== null && typeof input.lastModified !== 'string') return false;
  if (input.etag !== null && utf8ByteLength(input.etag) > MAX_CONDITIONAL_FIELD_BYTES) {
    return false;
  }
  if (
    input.lastModified !== null &&
    utf8ByteLength(input.lastModified) > MAX_CONDITIONAL_FIELD_BYTES
  ) {
    return false;
  }
  if (input.projectionType === 'page' && (input.etag !== null || input.lastModified !== null)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// R3-4：observation id 闭合形状（新写一律 Node randomUUID() 小写 UUID v4；迁移
// 回填精确为 `v2:` + 所属 eventId）。启动扫描只接受：
// - 小写 UUID v4；或
// - `v2:<eventId>` 且 suffix 逐字等于该 observation 所属 Event ID。
// 拒绝任意 v2: suffix、大小写 UUID、非 v4 UUID、`c-<uuid>`、`<event>-obs0`。
// ---------------------------------------------------------------------------

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isValidObservationId(id: string, eventId: string): boolean {
  if (UUID_V4_PATTERN.test(id)) return true;
  if (id.startsWith('v2:')) return id === `v2:${eventId}`;
  return false;
}

/** R3-4：新写 observation id 只接受小写 UUID v4（v2:<eventId> 仅限迁移回填读取）。 */
export function isValidNewObservationId(id: string): boolean {
  return UUID_V4_PATTERN.test(id);
}

// ---------------------------------------------------------------------------
// D8 Digest v4 rows. SQL CHECK owns the scalar matrix; these validators add
// canonical JSON/hash, temporal and cross-column invariants at the read edge.
// ---------------------------------------------------------------------------

function exactOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key, index) => actual[index] === key);
}

function parseCanonicalJson(text: unknown, keys?: readonly string[]): unknown | null {
  if (typeof text !== 'string') return null;
  const parsed = parseJsonSafe(text);
  if (parsed === null || JSON.stringify(parsed) !== text) return null;
  if (keys !== undefined && (!isPlainRecord2(parsed) || !exactOwnKeys(parsed, keys))) return null;
  return parsed;
}

function validPeriod(value: unknown): value is { fromExclusive: string; toInclusive: string } {
  if (!isPlainRecord2(value) || !exactOwnKeys(value, ['fromExclusive', 'toInclusive']))
    return false;
  return (
    isIsoString(value['fromExclusive']) &&
    isIsoString(value['toInclusive']) &&
    value['fromExclusive'] < value['toInclusive']
  );
}

function validRunStats(value: unknown): boolean {
  return (
    isPlainRecord2(value) &&
    exactOwnKeys(value, ['changed', 'failed', 'unchanged']) &&
    isInt(value['changed']) &&
    isInt(value['failed']) &&
    isInt(value['unchanged'])
  );
}

export function validateDigestScheduleRow(row: Record<string, unknown>): boolean {
  const sourceIds = parseCanonicalJson(row['source_ids_json']);
  const schedule = parseCanonicalJson(row['schedule_json']);
  if (
    typeof row['id'] !== 'string' ||
    !isInt(row['version'], 1) ||
    !Array.isArray(sourceIds) ||
    sourceIds.length < 1 ||
    sourceIds.length > 100 ||
    !sourceIds.every((id) => typeof id === 'string' && id.length > 0) ||
    sourceIds.some((id, index) => index > 0 && sourceIds[index - 1]! >= id) ||
    !isPlainRecord2(schedule) ||
    !exactOwnKeys(schedule, ['kind', 'localTime', 'timeZone']) ||
    schedule['kind'] !== 'daily' ||
    !validateWatchSchedule(schedule).ok ||
    !isInt(row['ai_enabled']) ||
    (row['ai_enabled'] !== 0 && row['ai_enabled'] !== 1) ||
    !isInt(row['cursor_sequence']) ||
    !isIn(row['state'], ['active', 'paused'] as const) ||
    !isIsoString(row['next_due_at']) ||
    !isIsoString(row['created_at']) ||
    !isIsoString(row['updated_at']) ||
    row['created_at'] > row['updated_at'] ||
    !isNullableIsoString(row['last_consumed_scheduled_for']) ||
    !isNullableIsoString(row['last_checked_at']) ||
    (row['last_daily_local_date'] !== null &&
      (typeof row['last_daily_local_date'] !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(row['last_daily_local_date'])))
  )
    return false;
  const consumed = row['last_consumed_scheduled_for'] !== null;
  if (consumed !== (row['last_daily_local_date'] !== null)) return false;
  const checked = row['last_checked_at'] !== null;
  if (
    checked !== (row['last_period_json'] !== null) ||
    checked !== (row['last_run_stats_json'] !== null)
  )
    return false;
  if (checked) {
    const period = parseCanonicalJson(row['last_period_json'], ['fromExclusive', 'toInclusive']);
    const stats = parseCanonicalJson(row['last_run_stats_json'], [
      'changed',
      'failed',
      'unchanged',
    ]);
    if (
      !validPeriod(period) ||
      period.toInclusive !== row['last_checked_at'] ||
      !validRunStats(stats)
    )
      return false;
  }
  return true;
}

export function validateDigestRunRow(row: Record<string, unknown>): boolean {
  const period = parseCanonicalJson(row['period_json'], ['fromExclusive', 'toInclusive']);
  const stats = parseCanonicalJson(row['run_stats_json'], ['changed', 'failed', 'unchanged']);
  if (
    typeof row['id'] !== 'string' ||
    typeof row['schedule_id'] !== 'string' ||
    typeof row['request_key'] !== 'string' ||
    typeof row['logical_date'] !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(row['logical_date']) ||
    !isInt(row['lower_sequence']) ||
    !isInt(row['upper_sequence']) ||
    !isInt(row['next_sequence']) ||
    row['lower_sequence'] > row['next_sequence'] ||
    row['next_sequence'] > row['upper_sequence'] ||
    !validPeriod(period) ||
    !validRunStats(stats) ||
    !isIn(row['state'], ['running', 'budget_exceeded', 'completed'] as const) ||
    !isIsoString(row['created_at']) ||
    !isNullableIsoString(row['blocked_at']) ||
    !isNullableIsoString(row['finished_at'])
  )
    return false;
  const state = row['state'];
  if (state === 'running')
    return (
      row['blocked_at'] === null &&
      row['blocked_required_bytes'] === null &&
      row['blocked_available_bytes'] === null &&
      row['finished_at'] === null
    );
  if (state === 'budget_exceeded')
    return (
      row['next_sequence'] < row['upper_sequence'] &&
      isInt(row['blocked_required_bytes']) &&
      isInt(row['blocked_available_bytes']) &&
      row['blocked_required_bytes'] > row['blocked_available_bytes'] &&
      row['blocked_at'] !== null &&
      row['blocked_at'] >= row['created_at'] &&
      row['finished_at'] === null
    );
  return (
    row['next_sequence'] === row['upper_sequence'] &&
    row['blocked_at'] === null &&
    row['blocked_required_bytes'] === null &&
    row['blocked_available_bytes'] === null &&
    row['finished_at'] !== null &&
    row['finished_at'] >= row['created_at']
  );
}

export function validateDigestArtifactRow(row: Record<string, unknown>): boolean {
  if (
    typeof row['id'] !== 'string' ||
    typeof row['schedule_id'] !== 'string' ||
    typeof row['run_id'] !== 'string' ||
    !isInt(row['batch_index']) ||
    !isInt(row['first_sequence'], 1) ||
    !isInt(row['last_sequence'], 1) ||
    row['first_sequence'] > row['last_sequence'] ||
    !isInt(row['facts_revision'], 1) ||
    typeof row['facts_json'] !== 'string' ||
    utf8ByteLength(row['facts_json']) > MAX_DIGEST_FACTS_BYTES ||
    typeof row['facts_hash'] !== 'string' ||
    !FINGERPRINT_HEX.test(row['facts_hash']) ||
    !isInt(row['byte_length']) ||
    row['byte_length'] > MAX_DIGEST_BYTES ||
    !isIsoString(row['created_at']) ||
    !isNullableIsoString(row['claimed_at']) ||
    !isNullableIsoString(row['provider_finished_at'])
  )
    return false;
  const factsValue = parseCanonicalJson(row['facts_json']) as DigestFacts | null;
  if (factsValue === null) return false;
  const canonical = canonicalizeDigestFacts(factsValue);
  if (
    !canonical.ok ||
    canonical.hash !== row['facts_hash'] ||
    factsValue.scheduleId !== row['schedule_id'] ||
    factsValue.digestRunId !== row['run_id'] ||
    factsValue.batchIndex !== row['batch_index']
  )
    return false;
  for (const evidence of Object.values(factsValue.evidenceMap)) {
    if (
      !Array.isArray(evidence) ||
      evidence.some((pair) => validateChangeEvidencePair(pair) === null)
    )
      return false;
  }
  const explanation = row['explanation_json'];
  if (explanation !== null) {
    const visibleIds = factsValue.events
      .filter((event) => factsValue.referenceStates[event.eventId] === 'active')
      .map((event) => event.eventId);
    if (typeof explanation !== 'string' || parseDigestExplanation(explanation, visibleIds) === null)
      return false;
  }
  const artifactEnvelope = serializeDigestArtifact(
    canonical.json,
    explanation === null ? null : (explanation as string),
  );
  if (!artifactEnvelope.withinBudget || row['byte_length'] !== artifactEnvelope.byteLength)
    return false;
  const state = row['provider_state'];
  const result = row['provider_result_code'];
  const claimed =
    row['claimed_at'] !== null &&
    isInt(row['claimed_facts_revision'], 1) &&
    typeof row['claimed_facts_hash'] === 'string' &&
    FINGERPRINT_HEX.test(row['claimed_facts_hash']);
  const finished = row['provider_finished_at'] !== null;
  const factsRevision = row['facts_revision'] as number;
  const claimedRevision = row['claimed_facts_revision'] as number | null;
  const claimedAt = row['claimed_at'] as string | null;
  const providerFinishedAt = row['provider_finished_at'] as string | null;
  if (
    claimed &&
    claimedRevision !== null &&
    (factsRevision < claimedRevision ||
      (factsRevision === claimedRevision && row['facts_hash'] !== row['claimed_facts_hash']))
  )
    return false;
  if (row['claimed_at'] !== null && row['claimed_at'] < row['created_at']) return false;
  if (finished && providerFinishedAt !== null && providerFinishedAt < row['created_at'])
    return false;
  if (
    claimed &&
    finished &&
    providerFinishedAt !== null &&
    claimedAt !== null &&
    providerFinishedAt < claimedAt
  )
    return false;
  if (state === 'pending') return result === null && !claimed && !finished && explanation === null;
  if (state === 'disabled')
    return result === 'disabled' && !claimed && finished && explanation === null;
  if (state === 'claimed') return result === null && claimed && !finished && explanation === null;
  if (state === 'succeeded')
    return (
      result === 'success' &&
      claimed &&
      finished &&
      claimedRevision !== null &&
      (explanation !== null || factsRevision > claimedRevision)
    );
  if (state === 'failed')
    return (
      isIn(result, ['provider-error', 'timeout', 'aborted', 'invalid-output'] as const) &&
      claimed &&
      finished &&
      explanation === null
    );
  if (state === 'uncertain')
    return result === 'uncertain-after-restart' && claimed && finished && explanation === null;
  return (
    state === 'skipped' &&
    isIn(result, ['no-visible-events', 'request-budget', 'key-unavailable'] as const) &&
    !claimed &&
    finished &&
    explanation === null
  );
}

export interface WatchRunRow {
  id: string;
  ruleId: string;
  requestKey: string;
  status: 'queued' | 'running' | 'interrupted' | 'finished';
  trigger: 'scheduled' | 'catch-up' | 'manual';
  scheduledFor: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: WatchRunOutcome | null;
  health: WatchHealthSnapshot | null;
  responseMetadataJson: string | null;
}

export function validateRunRow(row: unknown): WatchRowValidation<WatchRunRow> {
  const r = row as WatchRunRow | null;
  if (typeof r !== 'object' || r === null) {
    return { ok: false, value: null, reason: 'row-shape-invalid' };
  }
  if (
    typeof r.id !== 'string' ||
    r.id === '' ||
    typeof r.ruleId !== 'string' ||
    r.ruleId === '' ||
    typeof r.requestKey !== 'string' ||
    r.requestKey === ''
  ) {
    return { ok: false, value: null, reason: 'row-shape-invalid' };
  }
  if (!isIn(r.status, ['queued', 'running', 'interrupted', 'finished'] as const)) {
    return { ok: false, value: null, reason: 'enum-invalid' };
  }
  if (!isIn(r.trigger, WATCH_RUN_TRIGGERS))
    return { ok: false, value: null, reason: 'enum-invalid' };
  if (
    !isNullableIsoString(r.scheduledFor) ||
    !isNullableIsoString(r.startedAt) ||
    !isNullableIsoString(r.finishedAt)
  ) {
    return { ok: false, value: null, reason: 'time-invalid' };
  }
  const outcome = r.outcome === null ? null : validateWatchRunOutcome(r.outcome);
  if (r.outcome !== null && outcome === null) {
    return { ok: false, value: null, reason: 'outcome-invalid' };
  }
  const health = r.health === null ? null : validateWatchHealthSnapshot(r.health);
  if (r.health !== null && health === null) {
    return { ok: false, value: null, reason: 'health-invalid' };
  }
  if (r.responseMetadataJson !== null && parseJsonSafe(r.responseMetadataJson) === null) {
    return { ok: false, value: null, reason: 'json-parse-failed' };
  }
  return { ok: true, value: { ...r, outcome, health }, reason: null };
}

// ---------------------------------------------------------------------------
// Intent 行（§10.1）
// ---------------------------------------------------------------------------

export type SourceCleanupIntentState = 'prepared' | 'source-committed' | 'complete' | 'aborted';

export interface SourceCleanupIntentRow {
  mutationId: string;
  sourceId: string;
  operation: 'create' | 'update' | 'disable' | 'restore' | 'undo' | 'hard-delete';
  beforeProjection: SourceWatchProjection | null;
  afterProjection: SourceWatchProjection | null;
  affectedRuleState: Record<string, AffectedRulePrepareState>;
  state: SourceCleanupIntentState;
  createdAt: string;
  updatedAt: string;
}

export function validateIntentRow(row: unknown): WatchRowValidation<SourceCleanupIntentRow> {
  const r = row as SourceCleanupIntentRow | null;
  if (typeof r !== 'object' || r === null) {
    return { ok: false, value: null, reason: 'row-shape-invalid' };
  }
  if (
    typeof r.mutationId !== 'string' ||
    r.mutationId === '' ||
    r.mutationId.length > 100 ||
    typeof r.sourceId !== 'string' ||
    r.sourceId === '' ||
    r.sourceId.length > 100
  ) {
    return { ok: false, value: null, reason: 'row-shape-invalid' };
  }
  if (
    !isIn(r.operation, ['create', 'update', 'disable', 'restore', 'undo', 'hard-delete'] as const)
  ) {
    return { ok: false, value: null, reason: 'enum-invalid' };
  }
  if (!isIn(r.state, ['prepared', 'source-committed', 'complete', 'aborted'] as const)) {
    return { ok: false, value: null, reason: 'enum-invalid' };
  }
  if (r.beforeProjection !== null && validateSourceWatchProjection(r.beforeProjection) === null) {
    return { ok: false, value: null, reason: 'projection-invalid' };
  }
  if (r.afterProjection !== null && validateSourceWatchProjection(r.afterProjection) === null) {
    return { ok: false, value: null, reason: 'projection-invalid' };
  }
  const affected = validateAffectedRuleStateMap(r.affectedRuleState);
  if (affected === null) return { ok: false, value: null, reason: 'projection-invalid' };
  if (!isIsoString(r.createdAt) || !isIsoString(r.updatedAt)) {
    return { ok: false, value: null, reason: 'time-invalid' };
  }
  return { ok: true, value: { ...r, affectedRuleState: affected }, reason: null };
}

// ---------------------------------------------------------------------------
// 预算（§10.4）：单 Event 双侧 Evidence 合计 ≤ MAX_EVENT_EVIDENCE_BYTES
// ---------------------------------------------------------------------------

export function computeEventItemsBytes(itemsJson: readonly string[]): number {
  return itemsJson.reduce((sum, item) => sum + utf8ByteLength(item), 0);
}

// ---------------------------------------------------------------------------
// D7 #S6-058：Run response metadata exact-key canonical validator（§8.1）。
// 只接受 `{ schemaVersion:1, http: ConditionalResponseMetadata|null,
// conditionWarnings: ConditionWarningCode[] }`：
// - 非 JSON / 未来 schemaVersion / 额外或缺失 key / 非 canonical key order 拒绝；
// - http 对象 exact-key `{httpStatus, etag, lastModified, warnings}`，httpStatus
//   仅 200|304，etag/lastModified 为 string|null 且各自 UTF-8 ≤
//   MAX_CONDITIONAL_FIELD_BYTES；warnings 数组去重并按 union 声明顺序排序；
// - conditionWarnings 数组去重并按 union 声明顺序排序；
// - 整体 canonical JSON UTF-8 ≤ MAX_RUN_RESPONSE_META_BYTES。
// v2 legacy parseable JSON 只允许读回为 legacy-opaque，本函数一律拒绝
// （新写 API 不接受 legacy-opaque；读取边界由 validateRunRow 保持可解析即可）。
// ---------------------------------------------------------------------------

const CONDITION_WARNING_ORDER: readonly ConditionWarningCode[] = [
  'field-absent',
  'numeric-value-unavailable',
  'operator-not-applicable',
];
const HTTP_WARNING_ORDER: readonly ('etag-oversize' | 'last-modified-oversize')[] = [
  'etag-oversize',
  'last-modified-oversize',
];

/** 数组元素必须全部 ∈ order 且严格按 order 索引递增（天然去重且禁止乱序）。 */
function isCanonicalOrderedStrings(value: unknown, order: readonly string[]): boolean {
  if (!Array.isArray(value)) return false;
  let prevIdx = -1;
  for (const item of value) {
    if (typeof item !== 'string') return false;
    const idx = order.indexOf(item);
    if (idx === -1) return false;
    if (idx <= prevIdx) return false; // 乱序或重复
    prevIdx = idx;
  }
  return true;
}

function isPlainRecord2(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function isCanonicalConditionalResponseMetadata(raw: unknown): boolean {
  if (!isPlainRecord2(raw)) return false;
  const keys = Reflect.ownKeys(raw);
  if (
    keys.length !== 4 ||
    keys[0] !== 'httpStatus' ||
    keys[1] !== 'etag' ||
    keys[2] !== 'lastModified' ||
    keys[3] !== 'warnings'
  ) {
    return false;
  }
  const httpStatus = raw['httpStatus'];
  if (httpStatus !== 200 && httpStatus !== 304) return false;
  const etag = raw['etag'];
  const lastModified = raw['lastModified'];
  if (etag !== null && typeof etag !== 'string') return false;
  if (lastModified !== null && typeof lastModified !== 'string') return false;
  // R3-1：单字段 UTF-8 字节预算（多字节以实际 bytes 判定）
  if (etag !== null && utf8ByteLength(etag) > MAX_CONDITIONAL_FIELD_BYTES) return false;
  if (lastModified !== null && utf8ByteLength(lastModified) > MAX_CONDITIONAL_FIELD_BYTES) {
    return false;
  }
  if (!isCanonicalOrderedStrings(raw['warnings'], HTTP_WARNING_ORDER)) return false;
  // R3-1：warning/字段矛盾拒绝——声明 oversize 时对应字段必须为 null；
  // 非 null 合法字段不得同时声明对应 oversize warning（服务器缺省头部 null+无 warning 合法）。
  const warnings = raw['warnings'] as readonly string[];
  if (warnings.includes('etag-oversize') && etag !== null) return false;
  if (warnings.includes('last-modified-oversize') && lastModified !== null) return false;
  return true;
}

/**
 * 新写边界 canonical 校验（§8.1/#S6-058）。返回 ok 表示该 JSON 可作为
 * WatchRunResponseMetadata 持久化；reason 为中文诊断（零敌手正文回显）。
 */
export function validateRunResponseMetadataJson(json: string | null): {
  ok: boolean;
  reason: string | null;
} {
  if (json === null) return { ok: false, reason: 'Run response metadata 缺失' };
  if (utf8ByteLength(json) > MAX_RUN_RESPONSE_META_BYTES) {
    return { ok: false, reason: 'Run response metadata 超过字节上限' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'Run response metadata 非 JSON' };
  }
  if (!isPlainRecord2(parsed)) return { ok: false, reason: 'Run response metadata 形状非法' };
  const keys = Reflect.ownKeys(parsed);
  if (
    keys.length !== 3 ||
    keys[0] !== 'schemaVersion' ||
    keys[1] !== 'http' ||
    keys[2] !== 'conditionWarnings'
  ) {
    return { ok: false, reason: 'Run response metadata 非 canonical key order' };
  }
  if (parsed['schemaVersion'] !== 1) {
    return { ok: false, reason: 'Run response metadata schemaVersion 非法' };
  }
  const http = parsed['http'];
  if (http !== null && !isCanonicalConditionalResponseMetadata(http)) {
    return { ok: false, reason: 'Run response metadata http 非法' };
  }
  if (!isCanonicalOrderedStrings(parsed['conditionWarnings'], CONDITION_WARNING_ORDER)) {
    return { ok: false, reason: 'Run response metadata conditionWarnings 非法' };
  }
  // R3-1：canonical 编码——重编码必须逐字节等于原始 JSON（拒绝空白/键重排/数字
  // 表示变体等一切非 canonical 编码；键序已由 exact-key 顺序保证，此处兜底正文）。
  if (JSON.stringify(parsed) !== json) {
    return { ok: false, reason: 'Run response metadata 非 canonical 编码' };
  }
  return { ok: true, reason: null };
}
