// Sixth Stage D4: WatchRepository — watch.db 唯一业务 SQL 执行点
// （detailed-design §7/§10、threat-model §3.5、AGENTS §3.4 永久护栏）。
// - 全部业务语句为编译期常量 + 位置参数绑定；无动态表/列/ORDER BY/exec(拼接)；
// - 全部读路径经 watch-row-validation 共享 validator 二次校验（非法/未来版本
//   fail-closed：规则读回返回 null 并脱敏 warn；写路径结构化错误码）；
// - 失败语义：结构化 WatchRepositoryError（rule-not-found / baseline-conflict /
//   duplicate-request-key / duplicate-idempotency / event-budget-exceeded /
//   db-budget-exceeded / …），不抛穿业务层（SQLite 底层错误翻译为 sqlite-error）；
// - 事务边界：带原子性契约的组合写（writeEventTransaction / cascadeDeleteRulesBySource /
//   prune*）自带 withTransaction；单表写（insertRule/transitionRun/insertSourceCleanupIntent）
//   由调用方事务所有（coordinator/Store 组合多表原子）；
// - 预算：单对象（Baseline 64 KiB / Event 双侧 Evidence 32 KiB / Digest 64 KiB）与
//   全库 100 MiB 在写入事务内估算（UTF-8 字节；estimateLogicalBytes 为逻辑字节近似，
//   不含页/索引开销——诚实限制如实披露）。预算参数为构造注入（测试注入小值验证
//   ==/+1 边界；生产缺省 §2 常量）。
import { closeDb, withTransaction, type DbHandle } from '../db/watch-driver';
import { randomUUID } from 'node:crypto';
import { logWarn } from '../../logger';
import {
  MAX_EVENT_EVIDENCE_BYTES,
  MAX_PAGE_PROJECTION_BYTES,
  MAX_WATCH_DB_BYTES,
  PUBLIC_EVENT_RETENTION_DAYS,
  PUBLIC_EVENTS_PER_RULE,
  SESSION_EVENT_RETENTION_DAYS,
  SESSION_EVENTS_PER_RULE,
  type ChangeEvidencePair,
  type WatchEvent,
  type WatchEventKind,
  type WatchHealthSnapshot,
  type WatchRule,
  type WatchRunOutcome,
  type DigestFacts,
  type DigestProviderResultCode,
} from '../../../shared/types/watch';
import { validateFeedTarget, validatePageTarget } from '../../../shared/watch/watch-targets';
import {
  transitionRuleState,
  validateWatchSchedule,
  type HealthPauseReason,
} from '../../../shared/watch/watch-rule-state';
import { utf8ByteLength } from '../../../shared/watch/watch-budget';
import { sha256Hex } from '../../../shared/watch/diff/evidence';
import {
  canonicalizeDigestFacts,
  type DigestObservationSlice,
} from '../../../shared/watch/digest-facts';
import { parseDigestExplanation } from '../../../shared/watch/digest-validator';
import {
  WATCH_AUDIT_KINDS,
  WATCH_AUDIT_REASON_CODES,
  type WatchAuditKind,
  type WatchAuditReasonCode,
} from '../db/watch-migrations';
import {
  validateAffectedRuleStateMap,
  validateBaselineRow,
  validateBaselineValidators,
  validateChangeEvidencePair,
  validateEventRow,
  validateDigestArtifactRow,
  validateDigestRunRow,
  validateDigestScheduleRow,
  validateIntentRow,
  isValidNewObservationId,
  isValidObservationId,
  validateRuleRow,
  validateRunResponseMetadataJson,
  validateRunRow,
  validateWatchRunOutcome,
  validateSourceWatchProjection,
  validateStoredCondition,
  type AffectedRulePrepareState,
  type SourceCleanupIntentRow,
  type SourceCleanupIntentState,
  type WatchBaselineRow,
  type WatchRunRow,
  type WatchRuleRowColumns,
} from '../watch-row-validation';

export type WatchErrorCode =
  | 'rule-not-found'
  | 'rule-state-conflict'
  | 'rule-already-running'
  | 'baseline-conflict'
  | 'baseline-budget-exceeded'
  | 'duplicate-request-key'
  | 'run-not-found'
  | 'run-state-conflict'
  | 'intent-not-found'
  | 'intent-state-conflict'
  | 'duplicate-mutation'
  | 'duplicate-idempotency'
  | 'duplicate-item-sequence'
  | 'duplicate-dedupe'
  | 'duplicate-ref'
  | 'event-budget-exceeded'
  | 'db-budget-exceeded'
  | 'identity-conflict'
  | 'validation-failed'
  | 'event-conflict'
  | 'store-unavailable'
  | 'sqlite-error';

export class WatchRepositoryError extends Error {
  readonly code: WatchErrorCode;

  constructor(code: WatchErrorCode, message: string) {
    super(message);
    this.name = 'WatchRepositoryError';
    this.code = code;
  }
}

// 事务内中止哨兵：组合写事务内任一子写入失败必须回滚整笔（withTransaction 只对
// 异常回滚——返回错误结果会静默 COMMIT 已完成的写入，属数据完整性红线）。
class TxnAbortError extends Error {
  readonly code: WatchErrorCode;

  constructor(code: WatchErrorCode) {
    super('txn-abort');
    this.name = 'TxnAbortError';
    this.code = code;
  }
}

export interface WatchRepositoryOptions {
  maxDbBytes?: number;
  maxEventEvidenceBytes?: number;
  maxBaselineBytes?: number;
}

type OkResult = { ok: true };
export type WatchResult = OkResult | { ok: false; code: WatchErrorCode };

/** reservation 结果（§4.2）：ok 时携带 runId；手动复用当前 run 时 reused=true。 */
export type ReserveRunResult =
  { ok: true; runId: string; reused?: boolean } | { ok: false; code: WatchErrorCode };

export interface StoredDigestSchedule {
  id: string;
  version: number;
  sourceIds: string[];
  localTime: string;
  timeZone: string;
  aiEnabled: boolean;
  cursorSequence: number;
  state: 'active' | 'paused';
  nextDueAt: string;
  lastConsumedScheduledFor: string | null;
  lastDailyLocalDate: string | null;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastPeriod: { fromExclusive: string; toInclusive: string } | null;
  lastRunStats: { changed: number; failed: number; unchanged: number } | null;
}

export interface StoredDigestRun {
  id: string;
  scheduleId: string;
  requestKey: string;
  logicalDate: string;
  lowerSequence: number;
  upperSequence: number;
  nextSequence: number;
  period: { fromExclusive: string; toInclusive: string };
  runStats: { changed: number; failed: number; unchanged: number };
  state: 'running' | 'budget_exceeded' | 'completed';
}

export interface StoredDigestArtifact {
  id: string;
  scheduleId: string;
  runId: string;
  batchIndex: number;
  facts: DigestFacts;
  factsJson: string;
  factsHash: string;
  factsRevision: number;
  providerState: string;
  providerResultCode: string | null;
  explanationJson: string | null;
}

export type DigestJournalSlice =
  | { sequence: number; status: 'skipped'; observation: null }
  | { sequence: number; status: 'expired' | 'user-deleted'; observation: null }
  | { sequence: number; status: 'active'; observation: DigestObservationSlice };

// ---------------------------------------------------------------------------
// 编译期 SQL 常量（全部参数绑定；无动态拼接）
// ---------------------------------------------------------------------------

const SQL_INSERT_RULE = `INSERT INTO watch_rules
  (id, source_id, kind, state, pause_reason, desired_enabled, muted, access_mode,
   schedule_json, target_json, condition_json, notification_level,
   source_row_version, source_locator_fingerprint, next_due_at,
   last_consumed_scheduled_for, last_daily_local_date, consecutive_failures,
   backoff_until, baseline_version, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SQL_RULE_COLUMNS = `SELECT id, source_id, kind, state, pause_reason, desired_enabled,
  muted, access_mode, schedule_json, target_json, condition_json, notification_level,
  source_row_version, source_locator_fingerprint, next_due_at,
  last_consumed_scheduled_for, last_daily_local_date, consecutive_failures,
  backoff_until, baseline_version, created_at, updated_at FROM watch_rules`;

const SQL_SELECT_RULE_BY_ID = `${SQL_RULE_COLUMNS} WHERE id = ?`;
const SQL_SELECT_ALL_RULES = `${SQL_RULE_COLUMNS} ORDER BY created_at ASC, id ASC`;
const SQL_SELECT_RULES_BY_SOURCE = `${SQL_RULE_COLUMNS} WHERE source_id = ? ORDER BY created_at ASC, id ASC`;
const SQL_SELECT_RULE_IDENTITY = `SELECT state, source_id, source_locator_fingerprint, baseline_version
  FROM watch_rules WHERE id = ?`;
const SQL_SELECT_RULE_STATE_FIELDS =
  'SELECT state, pause_reason, source_row_version, source_locator_fingerprint FROM watch_rules WHERE id = ?';
const SQL_SELECT_RULE_EXISTS = 'SELECT 1 AS x FROM watch_rules WHERE id = ?';
const SQL_SELECT_RUN_EXISTS = 'SELECT 1 AS x FROM watch_runs WHERE id = ?';
const SQL_SELECT_INTENT_EXISTS = 'SELECT 1 AS x FROM source_cleanup_intents WHERE mutation_id = ?';
const SQL_SELECT_RULES_ACCESS = 'SELECT id, access_mode FROM watch_rules';
const SQL_DELETE_RULE = 'DELETE FROM watch_rules WHERE id = ?';
const SQL_DELETE_RULES_BY_SOURCE = 'DELETE FROM watch_rules WHERE source_id = ?';
const SQL_UPDATE_RULE_COORDINATION = `UPDATE watch_rules
  SET state = ?, pause_reason = ?, source_row_version = ?, source_locator_fingerprint = ?, updated_at = ?
  WHERE id = ? AND state IS ? AND pause_reason IS ? AND source_row_version = ?
  AND source_locator_fingerprint = ?`;

const SQL_INSERT_BASELINE = `INSERT INTO watch_baselines
  (rule_id, version, projection_type, projection_json, content_hash, byte_length,
   final_url, captured_at, document_id, conditional_etag, conditional_last_modified)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const SQL_UPDATE_BASELINE_CAS = `UPDATE watch_baselines
  SET version = ?, projection_type = ?, projection_json = ?, content_hash = ?, byte_length = ?,
      final_url = ?, captured_at = ?, document_id = ?,
      conditional_etag = ?, conditional_last_modified = ?
  WHERE rule_id = ? AND version = ?`;
const SQL_SELECT_BASELINE = `SELECT rule_id, version, projection_type, projection_json,
  content_hash, byte_length, final_url, captured_at, document_id,
  conditional_etag, conditional_last_modified
  FROM watch_baselines WHERE rule_id = ?`;
const SQL_UPDATE_RULE_BASELINE_VERSION =
  'UPDATE watch_rules SET baseline_version = ?, updated_at = ? WHERE id = ?';

// D7 #S6-057：结果事务 Rule 完整身份 CAS（enabled/desired/unpaused + sourceId/fingerprint/
// baselineVersion）。sourceRowVersion 不参与 CAS；写入必须是单调 max(current, revalidated)
//（#S6-052）。
const SQL_SELECT_RULE_RESULT_IDENTITY = `SELECT state, desired_enabled, pause_reason,
  source_id, source_locator_fingerprint, baseline_version, source_row_version
  FROM watch_rules WHERE id = ?`;
const SQL_UPDATE_RULE_RESULT_ROWVERSION = `UPDATE watch_rules
  SET source_row_version = MAX(source_row_version, ?), updated_at = ?
  WHERE id = ? AND state = 'enabled' AND desired_enabled = 1 AND pause_reason IS NULL
    AND source_id = ? AND source_locator_fingerprint = ?`;

// #S6-056：unchanged（同 hash 200/304）只更新条件 validator（Baseline version/content 不变）
const SQL_UPDATE_BASELINE_VALIDATORS = `UPDATE watch_baselines
  SET conditional_etag = ?, conditional_last_modified = ?
  WHERE rule_id = ? AND version = ?`;

// §8.1：Run response_metadata_json 只作有界诊断记录（不参与条件请求输入）。
// #S6-058 FIXED DECISION 1：metadata 必须随同 Run 终态在同一 CAS UPDATE 写入，
// 不做独立预写 UPDATE（独立预写会在已终态 dedup 重入时产生写入）。

const SQL_INSERT_RUN = `INSERT INTO watch_runs
  (id, rule_id, request_key, status, trigger, scheduled_for)
  VALUES (?, ?, ?, 'queued', ?, ?)`;
const SQL_SELECT_RUN = `SELECT id, rule_id, request_key, status, trigger, scheduled_for,
  started_at, finished_at, outcome_json, health_json, response_metadata_json
  FROM watch_runs WHERE id = ?`;
const SQL_MARK_NON_TERMINAL_INTERRUPTED = `UPDATE watch_runs
  SET status = 'interrupted', finished_at = ?
  WHERE status IN ('queued','running')`;
const SQL_TRANSITION_RUN = `UPDATE watch_runs
  SET status = ?, started_at = ?, finished_at = ?, outcome_json = ?, health_json = ?,
      response_metadata_json = ?
  WHERE id = ? AND status = ?`;

// D5 reservation（§4.2/FIXED DECISIONS 1）：同 Rule 无 queued|running、规则 enabled
// 且 next_due_at 与 expected 未变的 CAS 下，单事务 INSERT queued Run + 消费
// scheduledFor + 推进 nextDueAt（三写全有或全无）。
const SQL_SELECT_ACTIVE_RUN_BY_RULE = `SELECT id FROM watch_runs
  WHERE rule_id = ? AND status IN ('queued','running') ORDER BY id ASC LIMIT 1`;
const SQL_UPDATE_RULE_RESERVATION = `UPDATE watch_rules
  SET last_consumed_scheduled_for = ?, next_due_at = ?, last_daily_local_date = ?, updated_at = ?
  WHERE id = ? AND state = 'enabled' AND next_due_at = ?`;
const SQL_UPDATE_RULE_FAILURE_STATE = `UPDATE watch_rules
  SET consecutive_failures = ?, backoff_until = ?, updated_at = ? WHERE id = ?`;
const SQL_SELECT_RULE_STATE_ONLY = 'SELECT state FROM watch_rules WHERE id = ?';

const SQL_INSERT_AUDIT = `INSERT INTO watch_audits (id, rule_id, kind, reason_code, created_at)
  VALUES (?, ?, ?, ?, ?)`;
const SQL_LIST_AUDITS = `SELECT id, rule_id, kind, reason_code, created_at
  FROM watch_audits ORDER BY created_at ASC, id ASC LIMIT ?`;

const SQL_INSERT_EVENT = `INSERT INTO watch_events
  (id, rule_id, source_id, event_kind, importance, idempotency_key, change_fingerprint,
   first_observed_at, last_observed_at, item_count, read_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`;
const SQL_SELECT_EVENT = `SELECT id, rule_id, source_id, event_kind, importance,
  idempotency_key, change_fingerprint, first_observed_at, last_observed_at, item_count,
  read_at FROM watch_events WHERE id = ?`;
const SQL_SELECT_EVENTS_BY_RULE = `SELECT id, rule_id, source_id, event_kind, importance,
  idempotency_key, change_fingerprint, first_observed_at, last_observed_at, item_count,
  read_at FROM watch_events WHERE rule_id = ? ORDER BY first_observed_at ASC, id ASC`;
// v3：items 绑定 observation（observation_id,event_id 复合 FK），并保留 event 内 sequence
const SQL_INSERT_OBSERVATION = `INSERT INTO watch_event_observations
  (id, event_id, sequence, idempotency_key, change_fingerprint, event_kind,
   observed_at, first_item_sequence, item_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const SQL_NEXT_DIGEST_CHANGE_SEQUENCE = `UPDATE digest_change_state
  SET last_sequence = last_sequence + 1 WHERE id = 1 RETURNING last_sequence`;
const SQL_INSERT_DIGEST_CHANGE = `INSERT INTO digest_change_journal
  (sequence, observation_id, event_id, source_id, observed_at, status)
  VALUES (?, ?, ?, ?, ?, 'active')`;
const SQL_INSERT_EVENT_ITEM = `INSERT INTO watch_event_items
  (id, event_id, sequence, observation_id, observation_item_sequence,
   item_id, field_key, label, before_value_json, after_value_json,
   before_captured_at, after_captured_at, before_final_url, after_final_url,
   before_document_id, after_document_id, feed_item_key)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const SQL_SELECT_EVENT_ITEMS = `SELECT id, event_id, sequence, observation_id,
  observation_item_sequence, item_id, field_key, label,
  before_value_json, after_value_json, before_captured_at, after_captured_at,
  before_final_url, after_final_url, before_document_id, after_document_id, feed_item_key
  FROM watch_event_items WHERE event_id = ? ORDER BY sequence ASC, id ASC`;
const SQL_MARK_EVENTS_READ = 'UPDATE watch_events SET read_at = ? WHERE id = ?';
const SQL_DELETE_EVENT = 'DELETE FROM watch_events WHERE id = ?';
const SQL_DELETE_EVENT_OUTBOX = `DELETE FROM notification_outbox
  WHERE subject_type = 'event' AND subject_id = ?`;
const SQL_MARK_REFS_FOR_EVENT = `UPDATE digest_event_refs SET status = ?
  WHERE event_id = ? AND status = 'active'`;
const SQL_UPDATE_DIGEST_CHANGE_TOMBSTONE = `UPDATE digest_change_journal SET status = ?
  WHERE event_id = ? AND status = 'active'`;
const SQL_SELECT_DIGESTS_BY_EVENT = `SELECT id, facts_json, facts_hash, facts_revision,
  explanation_json, provider_state, provider_result_code, claimed_at, provider_finished_at,
  created_at FROM watch_digests WHERE id IN
  (SELECT digest_id FROM digest_event_refs WHERE event_id = ?)`;
const SQL_SCRUB_DIGEST = `UPDATE watch_digests SET facts_json = ?, facts_hash = ?,
  facts_revision = facts_revision + 1, explanation_json = ?, byte_length = ?,
  provider_state = ?, provider_result_code = ?, provider_finished_at = ?
  WHERE id = ? AND facts_revision = ? AND facts_hash = ?`;
const SQL_INSERT_OUTBOX = `INSERT INTO notification_outbox
  (id, rule_id, subject_type, subject_id, channel, dedupe_key, privacy_json,
   state, attempts, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`;
const SQL_SELECT_EVENTS_FOR_RULE_ORDERED = `SELECT id, first_observed_at, read_at
  FROM watch_events WHERE rule_id = ?
  ORDER BY (read_at IS NULL) ASC, first_observed_at ASC, id ASC`;
const SQL_SELECT_OLDEST_EVENT_GLOBAL = `SELECT id FROM watch_events
  ORDER BY (read_at IS NULL) ASC, first_observed_at ASC, id ASC LIMIT 1`;
const SQL_SELECT_EVENTS_BY_SOURCE = `SELECT e.id FROM watch_events e
  JOIN watch_rules r ON e.rule_id = r.id WHERE r.source_id = ?`;

// D7 §9.4/#S6-047：coalesce 候选 = 该 Rule 最近一个 Event（first_observed_at DESC, id DESC LIMIT 1）
const SQL_SELECT_LATEST_EVENT = `SELECT id, rule_id, source_id, event_kind, importance,
  idempotency_key, change_fingerprint, first_observed_at, last_observed_at, item_count,
  read_at FROM watch_events WHERE rule_id = ?
  ORDER BY first_observed_at DESC, id DESC LIMIT 1`;

// D7 #S6-048：最近已持久化变化对（同 Rule 同 (item_id, field_key)）——
// 按 §10.1 冻结全序：observation.observed_at DESC, event.first_observed_at DESC,
// event.id DESC, observation.sequence DESC, item.sequence DESC, item.id DESC LIMIT 1。
const SQL_SELECT_RECENT_PAIR = `SELECT
  i.id, i.event_id, i.sequence, i.observation_id, i.observation_item_sequence,
  i.item_id, i.field_key, i.label, i.before_value_json, i.after_value_json,
  i.before_captured_at, i.after_captured_at, i.before_final_url, i.after_final_url,
  i.before_document_id, i.after_document_id, i.feed_item_key
  FROM watch_event_items i
  JOIN watch_event_observations o ON o.id = i.observation_id AND o.event_id = i.event_id
  JOIN watch_events e ON e.id = i.event_id
  WHERE e.rule_id = ? AND i.item_id = ? AND i.field_key = ?
  ORDER BY o.observed_at DESC, e.first_observed_at DESC, e.id DESC,
           o.sequence DESC, i.sequence DESC, i.id DESC LIMIT 1`;

// D7 §9.4/#S6-051：观察级 idempotency_key 查询（dedup 判定）
const SQL_SELECT_OBSERVATION_BY_IDEM = `SELECT o.id, o.event_id, o.sequence,
  o.idempotency_key, o.change_fingerprint, o.event_kind, o.observed_at,
  o.first_item_sequence, o.item_count
  FROM watch_event_observations o WHERE o.idempotency_key = ?`;

// D7 coalesce：Event 行更新（CAS 复验 first_observed_at 与 item_count 等于期望值）
const SQL_UPDATE_EVENT_COALESCE = `UPDATE watch_events
  SET event_kind = ?, last_observed_at = ?, item_count = ?
  WHERE id = ? AND first_observed_at = ? AND item_count = ?`;

// 启动完整性/JSON 形状/预算扫描（§10.2 步骤 4；store 编排、SQL 仍在本模块）
const SQL_SELECT_ALL_BASELINES = `SELECT rule_id, version, projection_type, projection_json,
  content_hash, byte_length, final_url, captured_at, document_id,
  conditional_etag, conditional_last_modified FROM watch_baselines`;
const SQL_SELECT_ALL_RUNS = `SELECT id, rule_id, request_key, status, trigger, scheduled_for,
  started_at, finished_at, outcome_json, health_json, response_metadata_json
  FROM watch_runs`;
const SQL_SELECT_ALL_EVENTS = `SELECT id, rule_id, source_id, event_kind, importance,
  idempotency_key, change_fingerprint, first_observed_at, last_observed_at, item_count,
  read_at FROM watch_events`;
const SQL_SELECT_ALL_EVENT_ITEMS = `SELECT event_id, sequence, item_id, field_key, label,
  before_value_json, after_value_json, before_captured_at, after_captured_at,
  before_final_url, after_final_url, before_document_id, after_document_id, feed_item_key
  FROM watch_event_items`;
const SQL_SELECT_ALL_OBSERVATIONS = `SELECT id, event_id, sequence, idempotency_key,
  change_fingerprint, event_kind, observed_at, first_item_sequence, item_count
  FROM watch_event_observations`;
// D7 观察矩阵扫描：需 observation 关系列（observation_id/observation_item_sequence）
const SQL_SELECT_ALL_ITEMS_WITH_OBS = `SELECT event_id, sequence, observation_id,
  observation_item_sequence FROM watch_event_items`;
const SQL_SELECT_ALL_INTENTS = `SELECT mutation_id, source_id, operation,
  before_projection_json, after_projection_json, affected_rule_state_json, state,
  created_at, updated_at FROM source_cleanup_intents`;
const SQL_SELECT_ALL_SCHEDULES = `SELECT id, version, source_ids_json, schedule_json,
  ai_enabled, cursor_sequence, state, next_due_at, last_consumed_scheduled_for,
  last_daily_local_date, created_at, updated_at, last_checked_at, last_period_json,
  last_run_stats_json FROM digest_schedules`;
const SQL_SELECT_ALL_DIGEST_RUNS = `SELECT id, schedule_id, request_key, logical_date,
  lower_sequence, upper_sequence, next_sequence, period_json, run_stats_json, state,
  blocked_at, blocked_required_bytes, blocked_available_bytes, created_at, finished_at
  FROM digest_runs`;
const SQL_SELECT_DIGEST_RUN_BY_ID = `${SQL_SELECT_ALL_DIGEST_RUNS} WHERE id = ?`;
const SQL_SELECT_ALL_DIGESTS = `SELECT id, schedule_id, run_id, batch_index,
  first_sequence, last_sequence, facts_json, facts_hash, facts_revision,
  explanation_json, byte_length, provider_state, provider_result_code,
  claimed_facts_revision, claimed_facts_hash, claimed_at, provider_finished_at,
  created_at FROM watch_digests`;
const SQL_SELECT_ALL_DIGEST_REFS = `SELECT digest_id, event_id, status FROM digest_event_refs`;
const SQL_SELECT_DIGEST_CHANGE_STATE = `SELECT id, last_sequence FROM digest_change_state`;
const SQL_SELECT_ALL_DIGEST_CHANGES = `SELECT sequence, observation_id, event_id, source_id,
  observed_at, status FROM digest_change_journal ORDER BY sequence ASC`;
const SQL_SELECT_ALL_OUTBOX = `SELECT id, rule_id, subject_type, subject_id, channel,
  dedupe_key, privacy_json, state, attempts, created_at, updated_at
  FROM notification_outbox`;

const SQL_INSERT_DIGEST_REF = `INSERT INTO digest_event_refs (digest_id, event_id, status)
  VALUES (?, ?, ?)`;
const SQL_SELECT_DIGEST_REFS = `SELECT digest_id, event_id, status FROM digest_event_refs
  ORDER BY digest_id ASC, event_id ASC`;

const SQL_INSERT_DIGEST_SCHEDULE = `INSERT INTO digest_schedules
  (id, version, source_ids_json, schedule_json, ai_enabled, cursor_sequence, state,
   next_due_at, created_at, updated_at)
  VALUES (?, 1, ?, ?, ?, ?, 'active', ?, ?, ?)`;
const SQL_SELECT_DIGEST_SCHEDULE = `${SQL_SELECT_ALL_SCHEDULES} WHERE id = ?`;
const SQL_SELECT_ACTIVE_DIGEST_SCHEDULES = `${SQL_SELECT_ALL_SCHEDULES}
  WHERE state = 'active' ORDER BY next_due_at ASC, id ASC`;
const SQL_SELECT_NONTERMINAL_DIGEST_RUN = `${SQL_SELECT_ALL_DIGEST_RUNS}
  WHERE schedule_id = ? AND state IN ('running','budget_exceeded') LIMIT 1`;
const SQL_INSERT_DIGEST_RUN = `INSERT INTO digest_runs
  (id, schedule_id, request_key, logical_date, lower_sequence, upper_sequence,
   next_sequence, period_json, run_stats_json, state, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`;
const SQL_RESERVE_DIGEST_SCHEDULE = `UPDATE digest_schedules SET
  version = version + 1, next_due_at = ?, last_consumed_scheduled_for = ?,
  last_daily_local_date = ?, updated_at = ?
  WHERE id = ? AND version = ? AND state = 'active' AND next_due_at = ?
    AND last_consumed_scheduled_for IS ? AND last_daily_local_date IS ?`;
const SQL_SELECT_DIGEST_OBSERVATIONS = `SELECT j.sequence, j.observation_id, j.event_id,
  j.source_id, j.observed_at, j.status, o.event_kind, e.rule_id, e.importance
  FROM digest_change_journal j
  LEFT JOIN watch_event_observations o ON o.id = j.observation_id AND o.event_id = j.event_id
  LEFT JOIN watch_events e ON e.id = j.event_id
  WHERE j.sequence > ? AND j.sequence <= ? ORDER BY j.sequence ASC`;
const SQL_SELECT_ITEMS_BY_OBSERVATION = `SELECT item_id, field_key, label,
  before_value_json, after_value_json, before_captured_at, after_captured_at,
  before_final_url, after_final_url, before_document_id, after_document_id, feed_item_key
  FROM watch_event_items WHERE observation_id = ? ORDER BY observation_item_sequence ASC, id ASC`;
const SQL_INSERT_DIGEST = `INSERT INTO watch_digests
  (id, schedule_id, run_id, batch_index, first_sequence, last_sequence, facts_json,
   facts_hash, facts_revision, explanation_json, byte_length, provider_state,
   provider_result_code, provider_finished_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?)`;
const SQL_UPDATE_DIGEST_RUN_CURSOR = `UPDATE digest_runs SET next_sequence = ?
  WHERE id = ? AND schedule_id = ? AND state = 'running' AND next_sequence = ?
    AND upper_sequence >= ?`;
const SQL_UPDATE_DIGEST_SCHEDULE_CURSOR = `UPDATE digest_schedules SET
  cursor_sequence = ?, version = version + 1, updated_at = ?
  WHERE id = ? AND state = 'active' AND cursor_sequence = ?`;
const SQL_COMPLETE_DIGEST_RUN = `UPDATE digest_runs SET state = 'completed',
  next_sequence = upper_sequence, finished_at = ? WHERE id = ? AND schedule_id = ?
  AND state = 'running' AND next_sequence = ?`;
const SQL_COMPLETE_DIGEST_SCHEDULE = `UPDATE digest_schedules SET
  cursor_sequence = ?, version = version + 1, last_checked_at = ?,
  last_period_json = ?, last_run_stats_json = ?, updated_at = ?
  WHERE id = ? AND state = 'active' AND cursor_sequence = ?`;
const SQL_CLAIM_DIGEST = `UPDATE watch_digests SET provider_state = 'claimed',
  claimed_facts_revision = facts_revision, claimed_facts_hash = facts_hash, claimed_at = ?
  WHERE id = ? AND provider_state = 'pending'`;
const SQL_FINISH_DIGEST_CLAIM = `UPDATE watch_digests SET provider_state = ?,
  provider_result_code = ?, explanation_json = ?, byte_length = ?, provider_finished_at = ?
  WHERE id = ? AND provider_state = 'claimed' AND facts_revision = ? AND facts_hash = ?
    AND claimed_facts_revision = ? AND claimed_facts_hash = ?`;
const SQL_FINISH_DIGEST_PENDING = `UPDATE watch_digests SET provider_state = ?,
  provider_result_code = ?, provider_finished_at = ?
  WHERE id = ? AND provider_state = 'pending'`;
const SQL_RECOVER_CLAIMED_DIGESTS = `UPDATE watch_digests SET provider_state = 'uncertain',
  provider_result_code = 'uncertain-after-restart', explanation_json = NULL,
  provider_finished_at = CASE WHEN claimed_at > ? THEN claimed_at ELSE ? END
  WHERE provider_state = 'claimed'`;
const SQL_SELECT_DIGEST = `${SQL_SELECT_ALL_DIGESTS} WHERE id = ?`;
const SQL_SELECT_DIGEST_IDS_BY_SCHEDULE = `SELECT id FROM watch_digests
  WHERE schedule_id = ? ORDER BY created_at ASC, id ASC`;
const SQL_SELECT_PENDING_DIGEST_IDS_BY_RUN = `SELECT id FROM watch_digests
  WHERE run_id = ? AND provider_state = 'pending' ORDER BY batch_index ASC`;
const SQL_SELECT_NEXT_DIGEST_BATCH_INDEX = `SELECT COALESCE(MAX(batch_index), -1) + 1 AS n
  FROM watch_digests WHERE run_id = ?`;
const SQL_SELECT_FINISHED_RUNS_FOR_DIGEST_STATS = `SELECT w.source_id, r.status, r.finished_at, r.outcome_json
  FROM watch_runs r JOIN watch_rules w ON w.id = r.rule_id
  WHERE r.status IN ('finished','interrupted') AND r.finished_at > ? AND r.finished_at <= ?
  ORDER BY r.finished_at ASC, r.id ASC`;
const SQL_UPDATE_DIGEST_SCHEDULE_STATE = `UPDATE digest_schedules SET state = ?,
  version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND state = ?`;
const SQL_DELETE_DIGEST_SCHEDULE = `DELETE FROM digest_schedules WHERE id = ? AND version = ?`;
const SQL_UPDATE_DIGEST_AI = `UPDATE digest_schedules SET ai_enabled = ?,
  version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND ai_enabled = ?`;
const SQL_DISABLE_PENDING_DIGESTS = `UPDATE watch_digests SET provider_state = 'disabled',
  provider_result_code = 'disabled', provider_finished_at =
    CASE WHEN created_at > ? THEN created_at ELSE ? END
  WHERE schedule_id = ? AND provider_state = 'pending'`;
const SQL_RESET_DIGEST_SCHEDULE = `UPDATE digest_schedules SET source_ids_json = ?,
  schedule_json = ?, cursor_sequence = ?, next_due_at = ?, version = version + 1,
  updated_at = ? WHERE id = ? AND version = ?`;
const SQL_BLOCK_DIGEST_RUN = `UPDATE digest_runs SET state = 'budget_exceeded',
  blocked_at = ?, blocked_required_bytes = ?, blocked_available_bytes = ?
  WHERE id = ? AND state = 'running' AND next_sequence < upper_sequence`;
const SQL_RETRY_DIGEST_RUN = `UPDATE digest_runs SET state = 'running', blocked_at = NULL,
  blocked_required_bytes = NULL, blocked_available_bytes = NULL
  WHERE id = ? AND state = 'budget_exceeded' AND blocked_required_bytes <= ?`;
const SQL_DIGEST_SAFE_WATERMARK = `SELECT COALESCE(MIN(sequence),
  (SELECT last_sequence FROM digest_change_state WHERE id = 1)) AS sequence FROM (
    SELECT cursor_sequence AS sequence FROM digest_schedules
    UNION ALL
    SELECT next_sequence AS sequence FROM digest_runs WHERE state IN ('running','budget_exceeded')
  )`;
const SQL_PRUNE_DIGEST_TOMBSTONES = `DELETE FROM digest_change_journal
  WHERE status IN ('expired','user-deleted') AND sequence <= ?`;

const SQL_INSERT_INTENT = `INSERT INTO source_cleanup_intents
  (mutation_id, source_id, operation, before_projection_json, after_projection_json,
   affected_rule_state_json, state, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const SQL_SELECT_INTENT = `SELECT mutation_id, source_id, operation, before_projection_json,
  after_projection_json, affected_rule_state_json, state, created_at, updated_at
  FROM source_cleanup_intents WHERE mutation_id = ?`;
const SQL_SELECT_INTENTS = `SELECT mutation_id, source_id, operation, before_projection_json,
  after_projection_json, affected_rule_state_json, state, created_at, updated_at
  FROM source_cleanup_intents ORDER BY created_at ASC, mutation_id ASC`;
const SQL_SELECT_PENDING_INTENTS = `SELECT mutation_id, source_id, operation,
  before_projection_json, after_projection_json, affected_rule_state_json, state,
  created_at, updated_at FROM source_cleanup_intents
  WHERE state IN ('prepared','source-committed')
  ORDER BY created_at ASC, mutation_id ASC`;
const SQL_TRANSITION_INTENT = `UPDATE source_cleanup_intents
  SET state = ?, updated_at = ? WHERE mutation_id = ? AND state = ?`;
const SQL_DELETE_RESOLVED_INTENTS = `DELETE FROM source_cleanup_intents
  WHERE state IN ('complete','aborted')`;

const SQL_UPDATE_SESSION_CONSENTS = `UPDATE watch_rules SET target_json = ?, updated_at = ?
  WHERE id = ?`;

// 审计闭合白名单（§3.3/§9.1/§10.1；#S6-044 FIXED 7）：kind/reason 均为编译期枚举，
// 与 schema v2 CHECK 1:1 同源（单一权威常量数组，见 db/watch-migrations.ts），
// 非白名单拒绝。既有 5 kind/9 reason 语义零改动，追加 run kind 与健康/运行终态
// reason 码。
export type { WatchAuditKind, WatchAuditReasonCode } from '../db/watch-migrations';
const AUDIT_KINDS: readonly WatchAuditKind[] = WATCH_AUDIT_KINDS;
const AUDIT_REASON_CODES: readonly WatchAuditReasonCode[] = WATCH_AUDIT_REASON_CODES;

// 全库逻辑字节估算（编译期常量；§10.4 100 MiB 写前估算）：
// 对全部 TEXT 列按 UTF-8 字节求和 + 每行固定整数列近似（8 字节/整数列）。
// 诚实限制：不含 SQLite 页/索引/空闲页开销——实际文件字节 ≥ 该估算（保守方向
// fail-closed：估算只会低估，写前拒绝更严格）。
const SQL_ESTIMATE_LOGICAL_BYTES = `SELECT
  COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(source_id AS BLOB))
    + LENGTH(CAST(kind AS BLOB)) + LENGTH(CAST(state AS BLOB))
    + LENGTH(CAST(COALESCE(pause_reason,'') AS BLOB))
    + LENGTH(CAST(schedule_json AS BLOB)) + LENGTH(CAST(target_json AS BLOB))
    + LENGTH(CAST(COALESCE(condition_json,'') AS BLOB))
    + LENGTH(CAST(notification_level AS BLOB))
    + LENGTH(CAST(source_locator_fingerprint AS BLOB))
    + LENGTH(CAST(COALESCE(next_due_at,'') AS BLOB))
    + LENGTH(CAST(COALESCE(last_consumed_scheduled_for,'') AS BLOB))
    + LENGTH(CAST(COALESCE(last_daily_local_date,'') AS BLOB))
    + LENGTH(CAST(COALESCE(backoff_until,'') AS BLOB))
    + LENGTH(CAST(created_at AS BLOB)) + LENGTH(CAST(updated_at AS BLOB)) + 40)
    FROM watch_rules), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(rule_id AS BLOB))
    + LENGTH(CAST(projection_type AS BLOB)) + LENGTH(CAST(projection_json AS BLOB))
    + LENGTH(CAST(content_hash AS BLOB)) + LENGTH(CAST(final_url AS BLOB))
    + LENGTH(CAST(captured_at AS BLOB))
    + LENGTH(CAST(COALESCE(document_id,'') AS BLOB))
    + LENGTH(CAST(COALESCE(conditional_etag,'') AS BLOB))
    + LENGTH(CAST(COALESCE(conditional_last_modified,'') AS BLOB)) + 16)
    FROM watch_baselines), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(rule_id AS BLOB))
    + LENGTH(CAST(request_key AS BLOB)) + LENGTH(CAST(status AS BLOB))
    + LENGTH(CAST(trigger AS BLOB))
    + LENGTH(CAST(COALESCE(scheduled_for,'') AS BLOB))
    + LENGTH(CAST(COALESCE(started_at,'') AS BLOB))
    + LENGTH(CAST(COALESCE(finished_at,'') AS BLOB))
    + LENGTH(CAST(COALESCE(outcome_json,'') AS BLOB))
    + LENGTH(CAST(COALESCE(health_json,'') AS BLOB))
    + LENGTH(CAST(COALESCE(response_metadata_json,'') AS BLOB)))
    FROM watch_runs), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB))
    + LENGTH(CAST(COALESCE(rule_id,'') AS BLOB)) + LENGTH(CAST(kind AS BLOB))
    + LENGTH(CAST(reason_code AS BLOB)) + LENGTH(CAST(created_at AS BLOB)))
    FROM watch_audits), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(rule_id AS BLOB))
    + LENGTH(CAST(source_id AS BLOB)) + LENGTH(CAST(event_kind AS BLOB))
    + LENGTH(CAST(importance AS BLOB)) + LENGTH(CAST(idempotency_key AS BLOB))
    + LENGTH(CAST(change_fingerprint AS BLOB)) + LENGTH(CAST(first_observed_at AS BLOB))
    + LENGTH(CAST(last_observed_at AS BLOB))
    + LENGTH(CAST(COALESCE(read_at,'') AS BLOB)) + 8)
    FROM watch_events), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(event_id AS BLOB))
    + LENGTH(CAST(observation_id AS BLOB))
    + LENGTH(CAST(item_id AS BLOB)) + LENGTH(CAST(field_key AS BLOB))
    + LENGTH(CAST(label AS BLOB)) + LENGTH(CAST(before_value_json AS BLOB))
    + LENGTH(CAST(after_value_json AS BLOB)) + LENGTH(CAST(before_captured_at AS BLOB))
    + LENGTH(CAST(after_captured_at AS BLOB)) + LENGTH(CAST(before_final_url AS BLOB))
    + LENGTH(CAST(after_final_url AS BLOB))
    + LENGTH(CAST(COALESCE(before_document_id,'') AS BLOB))
    + LENGTH(CAST(COALESCE(after_document_id,'') AS BLOB))
    + LENGTH(CAST(COALESCE(feed_item_key,'') AS BLOB)) + 16)
    FROM watch_event_items), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(event_id AS BLOB))
    + LENGTH(CAST(idempotency_key AS BLOB)) + LENGTH(CAST(change_fingerprint AS BLOB))
    + LENGTH(CAST(event_kind AS BLOB)) + LENGTH(CAST(observed_at AS BLOB)) + 24)
    FROM watch_event_observations), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB))
    + LENGTH(CAST(source_ids_json AS BLOB)) + LENGTH(CAST(schedule_json AS BLOB))
    + LENGTH(CAST(next_due_at AS BLOB))
    + LENGTH(CAST(state AS BLOB)) + LENGTH(CAST(created_at AS BLOB))
    + LENGTH(CAST(updated_at AS BLOB))
    + LENGTH(CAST(COALESCE(last_checked_at,'') AS BLOB))
    + LENGTH(CAST(COALESCE(last_period_json,'') AS BLOB))
    + LENGTH(CAST(COALESCE(last_run_stats_json,'') AS BLOB)) + 24)
    FROM digest_schedules), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(schedule_id AS BLOB))
    + LENGTH(CAST(request_key AS BLOB)) + LENGTH(CAST(logical_date AS BLOB))
    + LENGTH(CAST(period_json AS BLOB)) + LENGTH(CAST(run_stats_json AS BLOB))
    + LENGTH(CAST(state AS BLOB)) + LENGTH(CAST(COALESCE(blocked_at,'') AS BLOB))
    + LENGTH(CAST(created_at AS BLOB)) + LENGTH(CAST(COALESCE(finished_at,'') AS BLOB)) + 48)
    FROM digest_runs), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB))
    + LENGTH(CAST(schedule_id AS BLOB)) + LENGTH(CAST(run_id AS BLOB))
    + LENGTH(CAST(facts_json AS BLOB)) + LENGTH(CAST(facts_hash AS BLOB))
    + LENGTH(CAST(COALESCE(explanation_json,'') AS BLOB))
    + LENGTH(CAST(provider_state AS BLOB))
    + LENGTH(CAST(COALESCE(provider_result_code,'') AS BLOB))
    + LENGTH(CAST(COALESCE(claimed_facts_hash,'') AS BLOB))
    + LENGTH(CAST(COALESCE(claimed_at,'') AS BLOB))
    + LENGTH(CAST(COALESCE(provider_finished_at,'') AS BLOB))
    + LENGTH(CAST(created_at AS BLOB)) + 40) FROM watch_digests), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(observation_id AS BLOB))
    + LENGTH(CAST(event_id AS BLOB)) + LENGTH(CAST(source_id AS BLOB))
    + LENGTH(CAST(observed_at AS BLOB)) + LENGTH(CAST(status AS BLOB)) + 8)
    FROM digest_change_journal), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(digest_id AS BLOB))
    + LENGTH(CAST(event_id AS BLOB)) + LENGTH(CAST(status AS BLOB)))
    FROM digest_event_refs), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB))
    + LENGTH(CAST(COALESCE(rule_id,'') AS BLOB)) + LENGTH(CAST(subject_type AS BLOB))
    + LENGTH(CAST(subject_id AS BLOB)) + LENGTH(CAST(channel AS BLOB))
    + LENGTH(CAST(dedupe_key AS BLOB)) + LENGTH(CAST(privacy_json AS BLOB))
    + LENGTH(CAST(state AS BLOB)) + LENGTH(CAST(created_at AS BLOB))
    + LENGTH(CAST(updated_at AS BLOB)) + 8) FROM notification_outbox), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(mutation_id AS BLOB))
    + LENGTH(CAST(source_id AS BLOB)) + LENGTH(CAST(operation AS BLOB))
    + LENGTH(CAST(COALESCE(before_projection_json,'') AS BLOB))
    + LENGTH(CAST(COALESCE(after_projection_json,'') AS BLOB))
    + LENGTH(CAST(affected_rule_state_json AS BLOB)) + LENGTH(CAST(state AS BLOB))
    + LENGTH(CAST(created_at AS BLOB)) + LENGTH(CAST(updated_at AS BLOB)))
    FROM source_cleanup_intents), 0) AS total`;

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIn<T extends string>(value: unknown, list: readonly T[]): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

export class WatchRepository {
  private readonly handle: DbHandle;
  private readonly maxDbBytes: number;
  private readonly maxEventEvidenceBytes: number;
  private readonly maxBaselineBytes: number;
  private disposed = false;

  constructor(handle: DbHandle, options: WatchRepositoryOptions = {}) {
    this.handle = handle;
    this.maxDbBytes = options.maxDbBytes ?? MAX_WATCH_DB_BYTES;
    this.maxEventEvidenceBytes = options.maxEventEvidenceBytes ?? MAX_EVENT_EVIDENCE_BYTES;
    this.maxBaselineBytes = options.maxBaselineBytes ?? MAX_PAGE_PROJECTION_BYTES;
  }

  get dbHandle(): DbHandle {
    return this.handle;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    closeDb(this.handle);
  }

  private ensureOpen(): void {
    if (this.disposed) throw new WatchRepositoryError('sqlite-error', '数据库连接已关闭');
  }

  private sqlErrorText(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    return `数据库错误：${message}`;
  }

  private translate(err: unknown): WatchRepositoryError {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE constraint failed: watch_runs.request_key')) {
      return new WatchRepositoryError('duplicate-request-key', 'request_key 已存在');
    }
    if (message.includes('UNIQUE constraint failed: watch_events.idempotency_key')) {
      return new WatchRepositoryError('duplicate-idempotency', 'idempotency_key 已存在');
    }
    if (message.includes('UNIQUE constraint failed: source_cleanup_intents.mutation_id')) {
      return new WatchRepositoryError('duplicate-mutation', 'mutation_id 已存在');
    }
    if (message.includes('UNIQUE constraint failed: notification_outbox.dedupe_key')) {
      return new WatchRepositoryError('duplicate-dedupe', 'dedupe_key 已存在');
    }
    if (
      message.includes(
        'UNIQUE constraint failed: watch_event_items.event_id, watch_event_items.sequence',
      )
    ) {
      return new WatchRepositoryError('duplicate-item-sequence', 'event item sequence 冲突');
    }
    if (message.includes('UNIQUE constraint failed: watch_baselines.rule_id')) {
      return new WatchRepositoryError('baseline-conflict', '规则已有 Baseline（期望首个写入）');
    }
    if (
      message.includes(
        'UNIQUE constraint failed: digest_event_refs.digest_id, digest_event_refs.event_id',
      )
    ) {
      return new WatchRepositoryError('duplicate-ref', 'digest_event_refs 复合主键冲突');
    }
    return new WatchRepositoryError('sqlite-error', `数据库错误：${message}`);
  }

  private nowIso(): string {
    return new Date(Date.now()).toISOString();
  }

  // -------------------------------------------------------------------------
  // Rule CRUD + CAS
  // -------------------------------------------------------------------------

  insertRule(rule: WatchRule): WatchResult {
    this.ensureOpen();
    if (rule.state === 'paused' && rule.pauseReason === null) {
      return { ok: false, code: 'validation-failed' };
    }
    if (rule.state !== 'paused' && rule.pauseReason !== null) {
      return { ok: false, code: 'validation-failed' };
    }
    const scheduleValidation = validateWatchSchedule(rule.schedule);
    if (!scheduleValidation.ok) {
      return { ok: false, code: 'validation-failed' };
    }
    const targetValidation =
      rule.kind === 'feed' ? validateFeedTarget(rule.target) : validatePageTarget(rule.target);
    if (!targetValidation.ok) {
      return { ok: false, code: 'validation-failed' };
    }
    if (rule.kind === 'feed' && rule.accessMode !== 'public') {
      return { ok: false, code: 'validation-failed' };
    }
    if (rule.accessMode === 'session' && rule.kind !== 'page') {
      return { ok: false, code: 'validation-failed' };
    }
    if (rule.condition !== null) {
      const condition = validateStoredCondition(rule.condition);
      if (!condition.ok) return { ok: false, code: 'validation-failed' };
    }
    try {
      this.handle
        .prepare(SQL_INSERT_RULE)
        .run(
          rule.id,
          rule.sourceId,
          rule.kind,
          rule.state,
          rule.pauseReason,
          rule.desiredEnabled ? 1 : 0,
          rule.muted ? 1 : 0,
          rule.accessMode,
          JSON.stringify(rule.schedule),
          JSON.stringify(rule.target),
          rule.condition === null ? null : JSON.stringify(rule.condition),
          rule.notificationLevel,
          rule.sourceRowVersion,
          rule.sourceLocatorFingerprint,
          rule.nextDueAt,
          rule.lastConsumedScheduledFor,
          rule.lastDailyLocalDate,
          rule.consecutiveFailures,
          rule.backoffUntil,
          rule.baselineVersion,
          rule.createdAt,
          rule.updatedAt,
        );
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        code: err instanceof TxnAbortError ? err.code : this.translate(err).code,
      };
    }
  }

  // coordinator-facing 读路径（§10.3 fail-closed 契约）：SQL 异常、数据库不可用
  // 或行读回校验失败一律抛 WatchRepositoryError，绝不降级为 null/[]（合法空结果
  // 与 not-found 才返回 null/[]）。调用方（coordinator/store）捕获后回滚并使
  // Watch unavailable。
  getRule(id: string): WatchRule | null {
    this.ensureOpen();
    let row: unknown;
    try {
      row = this.handle.prepare(SQL_SELECT_RULE_BY_ID).get(id);
    } catch (err) {
      throw new WatchRepositoryError('sqlite-error', this.sqlErrorText(err));
    }
    return this.ruleFromRow(row);
  }

  listRules(): WatchRule[] {
    this.ensureOpen();
    let rows: unknown[];
    try {
      rows = this.handle.prepare(SQL_SELECT_ALL_RULES).all() as unknown[];
    } catch (err) {
      throw new WatchRepositoryError('sqlite-error', this.sqlErrorText(err));
    }
    return rows.map((row) => this.ruleFromRow(row)).filter((r): r is WatchRule => r !== null);
  }

  listRulesBySource(sourceId: string): WatchRule[] {
    this.ensureOpen();
    let rows: unknown[];
    try {
      rows = this.handle.prepare(SQL_SELECT_RULES_BY_SOURCE).all(sourceId) as unknown[];
    } catch (err) {
      throw new WatchRepositoryError('sqlite-error', this.sqlErrorText(err));
    }
    return rows.map((row) => this.ruleFromRow(row)).filter((r): r is WatchRule => r !== null);
  }

  private ruleFromRow(row: unknown): WatchRule | null {
    if (row === undefined) return null; // not-found（合法空结果）
    const validated = validateRuleRow(row);
    if (!validated.ok || validated.value === null) {
      logWarn('watch', '规则行读回校验失败（fail-closed 抛错）');
      throw new WatchRepositoryError(
        'sqlite-error',
        `规则行读回校验失败：${validated.reason ?? '未知'}`,
      );
    }
    return validated.value;
  }

  getRuleStateFields(ruleId: string): {
    state: WatchRule['state'];
    pauseReason: WatchRule['pauseReason'];
    sourceRowVersion: number;
    sourceLocatorFingerprint: string;
  } | null {
    this.ensureOpen();
    const row = this.handle.prepare(SQL_SELECT_RULE_STATE_FIELDS).get(ruleId) as
      | {
          state: string;
          pause_reason: string | null;
          source_row_version: number;
          source_locator_fingerprint: string;
        }
      | undefined;
    if (row === undefined) return null;
    return {
      state: row.state as WatchRule['state'],
      pauseReason: row.pause_reason as WatchRule['pauseReason'],
      sourceRowVersion: row.source_row_version,
      sourceLocatorFingerprint: row.source_locator_fingerprint,
    };
  }

  // CAS：仅当当前 state/pauseReason/sourceRowVersion/fingerprint 与 expected
  // 完全一致时更新协调字段（§10.3：prepare/commit/abort 的规则状态写入入口）。
  updateRuleCoordination(
    ruleId: string,
    expected: {
      state: WatchRule['state'];
      pauseReason: WatchRule['pauseReason'];
      sourceRowVersion: number;
      sourceLocatorFingerprint: string;
    },
    patch: {
      state: WatchRule['state'];
      pauseReason: WatchRule['pauseReason'];
      sourceRowVersion: number;
      sourceLocatorFingerprint: string;
    },
    nowIso?: string,
  ): WatchResult {
    this.ensureOpen();
    try {
      const result = this.handle
        .prepare(SQL_UPDATE_RULE_COORDINATION)
        .run(
          patch.state,
          patch.pauseReason,
          patch.sourceRowVersion,
          patch.sourceLocatorFingerprint,
          nowIso ?? this.nowIso(),
          ruleId,
          expected.state,
          expected.pauseReason,
          expected.sourceRowVersion,
          expected.sourceLocatorFingerprint,
        );
      if (Number(result.changes) === 0) {
        const exists = this.handle.prepare(SQL_SELECT_RULE_EXISTS).get(ruleId);
        return exists === undefined
          ? { ok: false, code: 'rule-not-found' }
          : { ok: false, code: 'rule-state-conflict' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, code: this.translate(err).code };
    }
  }

  deleteRule(ruleId: string): WatchResult {
    this.ensureOpen();
    try {
      const result = this.handle.prepare(SQL_DELETE_RULE).run(ruleId);
      return Number(result.changes) === 0 ? { ok: false, code: 'rule-not-found' } : { ok: true };
    } catch (err) {
      return { ok: false, code: this.translate(err).code };
    }
  }

  private scrubEventInternal(
    eventId: string,
    status: 'expired' | 'user-deleted',
    nowIso = this.nowIso(),
  ): number {
    const artifacts = this.handle.prepare(SQL_SELECT_DIGESTS_BY_EVENT).all(eventId) as Array<
      Record<string, unknown>
    >;
    for (const row of artifacts) {
      const facts = this.parseJson(row['facts_json']) as DigestFacts | null;
      if (facts === null || facts.referenceStates[eventId] === undefined)
        throw new TxnAbortError('store-unavailable');
      const nextFacts: DigestFacts = structuredClone(facts);
      nextFacts.referenceStates[eventId] = status;
      delete nextFacts.evidenceMap[eventId];
      const canonical = canonicalizeDigestFacts(nextFacts);
      if (!canonical.ok) throw new TxnAbortError('store-unavailable');
      let explanationJson: string | null = null;
      if (row['explanation_json'] !== null) {
        const explanation = this.parseJson(row['explanation_json']) as {
          sections?: Array<{ eventIds?: string[]; explanation?: string }>;
        } | null;
        if (explanation === null || !Array.isArray(explanation.sections))
          throw new TxnAbortError('store-unavailable');
        const sections = explanation.sections.filter(
          (section) => Array.isArray(section.eventIds) && !section.eventIds.includes(eventId),
        );
        explanationJson = sections.length === 0 ? null : JSON.stringify({ sections });
      }
      const wasClaimed = row['provider_state'] === 'claimed';
      const nextState = wasClaimed ? 'failed' : String(row['provider_state']);
      const nextCode = wasClaimed ? 'aborted' : row['provider_result_code'];
      const previousFinished = row['provider_finished_at'];
      const finishedAt = wasClaimed
        ? typeof row['claimed_at'] === 'string' && row['claimed_at'] > nowIso
          ? row['claimed_at']
          : nowIso
        : previousFinished;
      const byteLength =
        canonical.byteLength + (explanationJson === null ? 0 : utf8ByteLength(explanationJson));
      const updated = this.handle
        .prepare(SQL_SCRUB_DIGEST)
        .run(
          canonical.json,
          canonical.hash,
          explanationJson,
          byteLength,
          nextState,
          nextCode,
          finishedAt,
          row['id'],
          row['facts_revision'],
          row['facts_hash'],
        );
      if (Number(updated.changes) !== 1) throw new TxnAbortError('run-state-conflict');
    }
    this.handle.prepare(SQL_UPDATE_DIGEST_CHANGE_TOMBSTONE).run(status, eventId);
    const refs = this.handle.prepare(SQL_MARK_REFS_FOR_EVENT).run(status, eventId);
    return Number(refs.changes);
  }

  deleteEventWithScrub(eventId: string, nowIso: string): WatchResult {
    this.ensureOpen();
    try {
      return withTransaction(this.handle, () => {
        if (this.handle.prepare(SQL_SELECT_EVENT).get(eventId) === undefined)
          throw new TxnAbortError('event-conflict');
        this.scrubEventInternal(eventId, 'user-deleted', nowIso);
        this.handle.prepare(SQL_DELETE_EVENT_OUTBOX).run(eventId);
        const deleted = this.handle.prepare(SQL_DELETE_EVENT).run(eventId);
        if (Number(deleted.changes) !== 1) throw new TxnAbortError('event-conflict');
        return { ok: true };
      });
    } catch (err) {
      if (err instanceof TxnAbortError) return { ok: false, code: err.code };
      return { ok: false, code: this.translate(err).code };
    }
  }

  // hard-delete/undo-of-add 级联（§10.3 步骤 4）：先标记受影响 Event 的
  // Digest ref=expired 与移除其 outbox，再删除规则（FK CASCADE baseline/runs/
  // events/audits SET NULL）。事务由调用方所有（coordinator 的 commit/
  // reconciliation 均自带事务——嵌套 BEGIN 为安全失败，组合语义必须同事务）。
  // 返回受影响的 Event 数（诊断）。
  cascadeDeleteRulesBySource(sourceId: string): { ok: boolean; deletedEvents: number } {
    this.ensureOpen();
    try {
      const eventRows = this.handle.prepare(SQL_SELECT_EVENTS_BY_SOURCE).all(sourceId) as Array<{
        id: string;
      }>;
      for (const row of eventRows) {
        this.scrubEventInternal(row.id, 'expired');
        this.handle.prepare(SQL_DELETE_EVENT_OUTBOX).run(row.id);
      }
      const result = this.handle.prepare(SQL_DELETE_RULES_BY_SOURCE).run(sourceId);
      void result.changes; // 零行亦合法（规则已在 prepare 后被用户删除/级联）
      return { ok: true, deletedEvents: eventRows.length };
    } catch (err) {
      logWarn('watch', '按 Source 级联删除失败（调用方事务回滚）', err);
      throw err; // 原子语义：让调用方事务回滚（失败不得静默半删）
    }
  }

  // 恢复路径（§10.2 末段）：全部 page Rule 的 sessionConsent 置 null（grant 失效）。
  // 任一 target 非法 → 整体失败（fail-closed，不静默跳过）。
  invalidateAllSessionConsents(): { ok: boolean; count: number } {
    this.ensureOpen();
    try {
      return withTransaction(this.handle, () => {
        const rows = this.handle.prepare(SQL_SELECT_ALL_RULES).all() as unknown[];
        let count = 0;
        const nowIso = this.nowIso();
        for (const row of rows) {
          if (!isPlainRecord(row) || row['kind'] !== 'page') continue;
          const targetRaw = row['target_json'];
          if (typeof targetRaw !== 'string') return { ok: false, count: 0 };
          let target: unknown;
          try {
            target = JSON.parse(targetRaw);
          } catch {
            return { ok: false, count: 0 };
          }
          const validated = validatePageTarget(target);
          if (!validated.ok) return { ok: false, count: 0 };
          if (validated.target.sessionConsent === null) continue;
          const rewritten = JSON.stringify({
            ...validated.target,
            sessionConsent: null,
          });
          this.handle
            .prepare(SQL_UPDATE_SESSION_CONSENTS)
            .run(rewritten, nowIso, row['id'] as string);
          count += 1;
        }
        return { ok: true, count };
      });
    } catch (err) {
      logWarn('watch', 'Session grant 失效写入失败（已整体回滚）', err);
      return { ok: false, count: 0 };
    }
  }

  // -------------------------------------------------------------------------
  // Baseline（§9.1 CAS）
  // -------------------------------------------------------------------------

  writeBaseline(input: {
    ruleId: string;
    expectedBaselineVersion: number | null; // null = 首个（INSERT）
    expectedSourceLocatorFingerprint?: string; // 提供时必须与规则当前 fingerprint 一致
    projectionType: 'feed' | 'page';
    projectionJson: string;
    contentHash: string;
    byteLength: number;
    finalUrl: string;
    capturedAt: string;
    documentId: string | null;
    validators?: { etag: string | null; lastModified: string | null };
  }): WatchResult {
    this.ensureOpen();
    // R6：真实 UTF-8 字节预算——声明字节必须与投影实际字节一致且在上限内，
    // 不信任调用方声明（伪造/不符在写入前拒绝）。
    const actualBytes = utf8ByteLength(input.projectionJson);
    if (
      !Number.isInteger(input.byteLength) ||
      input.byteLength < 0 ||
      input.byteLength > this.maxBaselineBytes
    ) {
      return { ok: false, code: 'baseline-budget-exceeded' };
    }
    if (actualBytes > this.maxBaselineBytes) {
      return { ok: false, code: 'baseline-budget-exceeded' };
    }
    if (input.byteLength !== actualBytes) {
      return { ok: false, code: 'validation-failed' };
    }
    // R3-3：条件 validator 写前 runtime 规则（string|null、≤1024 字节、Page 恒 null）——
    // 超限或 Page 非 null 返回 validation-failed 且事务零写（DB CHECK 纵深在前）。
    if (
      !validateBaselineValidators({
        projectionType: input.projectionType,
        etag: input.validators?.etag ?? null,
        lastModified: input.validators?.lastModified ?? null,
      })
    ) {
      return { ok: false, code: 'validation-failed' };
    }
    try {
      return withTransaction(this.handle, () => {
        // R5：同一事务内规则级身份 CAS——规则存在、未删除、fingerprint（若提供）
        // 与 baselineVersion 均匹配才允许写入。
        const ruleRow = this.handle.prepare(SQL_SELECT_RULE_IDENTITY).get(input.ruleId) as
          | {
              state: string;
              source_id: string;
              source_locator_fingerprint: string;
              baseline_version: number;
            }
          | undefined;
        if (ruleRow === undefined) return { ok: false, code: 'rule-not-found' as const };
        if (ruleRow.state === 'deleted') return { ok: false, code: 'identity-conflict' as const };
        if (
          input.expectedSourceLocatorFingerprint !== undefined &&
          ruleRow.source_locator_fingerprint !== input.expectedSourceLocatorFingerprint
        ) {
          return { ok: false, code: 'identity-conflict' as const };
        }
        // 列值恒为整数 0..N；expected null 表示首个写入（要求当前为 0）
        if (ruleRow.baseline_version !== (input.expectedBaselineVersion ?? 0)) {
          return { ok: false, code: 'baseline-conflict' as const };
        }
        if (this.estimateLogicalBytesInternal() + actualBytes + 200 > this.maxDbBytes) {
          return { ok: false, code: 'db-budget-exceeded' as const };
        }
        return this.applyBaselineInternal(input);
      });
    } catch (err) {
      return { ok: false, code: this.translate(err).code };
    }
  }

  private applyBaselineInternal(input: {
    ruleId: string;
    expectedBaselineVersion: number | null;
    projectionType: 'feed' | 'page';
    projectionJson: string;
    contentHash: string;
    byteLength: number;
    finalUrl: string;
    capturedAt: string;
    documentId: string | null;
    validators?: { etag: string | null; lastModified: string | null };
  }): WatchResult {
    const validators = input.validators ?? { etag: null, lastModified: null };
    // R3-3：applyBaselineInternal 与 writeBaseline 复用同一 runtime 规则（纵深；
    // 事务内任何写点前再次拒绝，超限/Page 非 null → validation-failed 零写）。
    if (
      !validateBaselineValidators({
        projectionType: input.projectionType,
        etag: validators.etag,
        lastModified: validators.lastModified,
      })
    ) {
      return { ok: false, code: 'validation-failed' };
    }
    if (input.expectedBaselineVersion === null) {
      const result = this.handle
        .prepare(SQL_INSERT_BASELINE)
        .run(
          input.ruleId,
          1,
          input.projectionType,
          input.projectionJson,
          input.contentHash,
          input.byteLength,
          input.finalUrl,
          input.capturedAt,
          input.documentId,
          validators.etag,
          validators.lastModified,
        );
      this.handle.prepare(SQL_UPDATE_RULE_BASELINE_VERSION).run(1, this.nowIso(), input.ruleId);
      if (Number(result.changes) === 0) return { ok: false, code: 'baseline-conflict' };
      return { ok: true };
    }
    const nextVersion = input.expectedBaselineVersion + 1;
    const result = this.handle
      .prepare(SQL_UPDATE_BASELINE_CAS)
      .run(
        nextVersion,
        input.projectionType,
        input.projectionJson,
        input.contentHash,
        input.byteLength,
        input.finalUrl,
        input.capturedAt,
        input.documentId,
        validators.etag,
        validators.lastModified,
        input.ruleId,
        input.expectedBaselineVersion,
      );
    if (Number(result.changes) === 0) return { ok: false, code: 'baseline-conflict' };
    this.handle
      .prepare(SQL_UPDATE_RULE_BASELINE_VERSION)
      .run(nextVersion, this.nowIso(), input.ruleId);
    return { ok: true };
  }

  getBaseline(ruleId: string): WatchBaselineRow | null {
    this.ensureOpen();
    try {
      const row = this.handle.prepare(SQL_SELECT_BASELINE).get(ruleId) as unknown;
      if (!isPlainRecord(row)) return null;
      const normalized = {
        ruleId: row['rule_id'] as string,
        version: row['version'] as number,
        projectionType: row['projection_type'] as 'feed' | 'page',
        projectionJson: row['projection_json'] as string,
        contentHash: row['content_hash'] as string,
        byteLength: row['byte_length'] as number,
        finalUrl: row['final_url'] as string,
        capturedAt: row['captured_at'] as string,
        documentId: row['document_id'] as string | null,
        conditionalEtag: row['conditional_etag'] as string | null,
        conditionalLastModified: row['conditional_last_modified'] as string | null,
      };
      const validated = validateBaselineRow(normalized);
      if (!validated.ok || validated.value === null) {
        logWarn('watch', 'Baseline 行读回校验失败（fail-closed 视为不存在）');
        return null;
      }
      return validated.value;
    } catch (err) {
      logWarn('watch', '读取 Baseline 失败（fail-closed 返回 null）', err);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Runs（§4.2/§10.1；status 列 D5 reservation 前向兼容）
  // -------------------------------------------------------------------------

  insertRun(input: {
    id: string;
    ruleId: string;
    requestKey: string;
    trigger: 'scheduled' | 'catch-up' | 'manual';
    scheduledFor: string | null;
  }): WatchResult {
    this.ensureOpen();
    try {
      const exists = this.handle.prepare(SQL_SELECT_RULE_EXISTS).get(input.ruleId);
      if (exists === undefined) return { ok: false, code: 'rule-not-found' };
      this.handle
        .prepare(SQL_INSERT_RUN)
        .run(input.id, input.ruleId, input.requestKey, input.trigger, input.scheduledFor);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: this.translate(err).code };
    }
  }

  transitionRun(
    runId: string,
    expectedStatus: 'queued' | 'running',
    next: {
      status: 'running' | 'finished' | 'interrupted';
      startedAt?: string | null;
      finishedAt?: string | null;
      outcome?: WatchRunOutcome | null;
      health?: WatchHealthSnapshot | null;
      responseMetadataJson?: string | null;
    },
  ): WatchResult {
    this.ensureOpen();
    // R3-2：finished 终态必须携带 canonical WatchRunResponseMetadata——缺失/null/非法
    // 一律 validation-failed 零写（D7 新增 finished Run 不可能写 null）；queued→running
    // 路径保持 metadata=null（提供非 null 同样拒绝）。v2 legacy 读取边界不变。
    if (next.status === 'finished') {
      if (
        next.responseMetadataJson === undefined ||
        next.responseMetadataJson === null ||
        !validateRunResponseMetadataJson(next.responseMetadataJson).ok
      ) {
        return { ok: false, code: 'validation-failed' };
      }
    } else if (next.responseMetadataJson !== undefined && next.responseMetadataJson !== null) {
      return { ok: false, code: 'validation-failed' };
    }
    try {
      const result = this.handle
        .prepare(SQL_TRANSITION_RUN)
        .run(
          next.status,
          next.startedAt ?? null,
          next.finishedAt ?? null,
          next.outcome === undefined || next.outcome === null ? null : JSON.stringify(next.outcome),
          next.health === undefined || next.health === null ? null : JSON.stringify(next.health),
          next.responseMetadataJson ?? null,
          runId,
          expectedStatus,
        );
      if (Number(result.changes) === 0) {
        const exists = this.handle.prepare(SQL_SELECT_RUN_EXISTS).get(runId);
        return exists === undefined
          ? { ok: false, code: 'run-not-found' }
          : { ok: false, code: 'run-state-conflict' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, code: this.translate(err).code };
    }
  }

  // §10.2 步骤 5：启动单事务把遗留 queued/running 原子标 interrupted
  //（已消费 slot 不重放；调用方事务所有，与 reconciliation 同事务组合）。
  markAllNonTerminalInterrupted(nowIso: string): number {
    this.ensureOpen();
    const result = this.handle.prepare(SQL_MARK_NON_TERMINAL_INTERRUPTED).run(nowIso);
    return Number(result.changes);
  }

  getRun(runId: string): WatchRunRow | null {
    this.ensureOpen();
    try {
      const raw = this.handle.prepare(SQL_SELECT_RUN).get(runId) as unknown;
      if (!isPlainRecord(raw)) return null;
      const outcomeRaw = raw['outcome_json'] === null ? null : this.parseJson(raw['outcome_json']);
      const healthRaw = raw['health_json'] === null ? null : this.parseJson(raw['health_json']);
      const normalized = {
        id: raw['id'] as string,
        ruleId: raw['rule_id'] as string,
        requestKey: raw['request_key'] as string,
        status: raw['status'] as WatchRunRow['status'],
        trigger: raw['trigger'] as WatchRunRow['trigger'],
        scheduledFor: raw['scheduled_for'] as string | null,
        startedAt: raw['started_at'] as string | null,
        finishedAt: raw['finished_at'] as string | null,
        outcome: outcomeRaw as WatchRunOutcome | null,
        health: healthRaw as WatchHealthSnapshot | null,
        responseMetadataJson: raw['response_metadata_json'] as string | null,
      };
      const validated = validateRunRow(normalized);
      if (!validated.ok || validated.value === null) {
        logWarn('watch', 'Run 行读回校验失败（fail-closed 视为不存在）');
        return null;
      }
      return validated.value;
    } catch (err) {
      logWarn('watch', '读取 Run 失败（fail-closed 返回 null）', err);
      return null;
    }
  }

  private parseJson(value: unknown): unknown | null {
    if (typeof value !== 'string') return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // D5 reservation/终态（§4.2、FIXED DECISIONS 1/7）：三写单事务原子 + 运行终态+
  // 审计同事务。reservation 提交后任何失败/pause/abort/崩溃不回拨 nextDueAt、
  // 不重放同 requestKey；提交前崩溃三者全无，下次启动只补跑一次。
  // -------------------------------------------------------------------------

  /**
   * 计划 reservation（§4.2 步骤 1–4）：单事务——
   * 1. 复验 Rule enabled、无同 Rule queued|running、next_due_at=expected 未变（CAS）；
   * 2. INSERT queued Run（requestKey、trigger、scheduledFor=消费前 nextDueAt）；
   * 3. 写 last_consumed_scheduled_for=scheduledFor、推进 next_due_at=advanced、
   *    daily 同写 last_daily_local_date=advancedLastDailyLocalDate、updated_at。
   * 三写要么全有要么全无；事务失败时三者均不改变（调用方据此使 Watch unavailable
   * 或按 conflict 跳过——已消费 slot 不重放）。
   */
  reserveScheduledRun(input: {
    ruleId: string;
    runId: string;
    requestKey: string;
    trigger: 'scheduled' | 'catch-up';
    scheduledFor: string;
    expectedNextDueAt: string;
    advancedNextDueAt: string;
    advancedLastDailyLocalDate: string | null;
    nowIso: string;
  }): ReserveRunResult {
    this.ensureOpen();
    try {
      return withTransaction(this.handle, () => {
        const active = this.handle.prepare(SQL_SELECT_ACTIVE_RUN_BY_RULE).get(input.ruleId);
        if (active !== undefined) {
          return { ok: false, code: 'rule-already-running' as const };
        }
        const updated = this.handle
          .prepare(SQL_UPDATE_RULE_RESERVATION)
          .run(
            input.scheduledFor,
            input.advancedNextDueAt,
            input.advancedLastDailyLocalDate,
            input.nowIso,
            input.ruleId,
            input.expectedNextDueAt,
          );
        if (Number(updated.changes) === 0) {
          const exists = this.handle.prepare(SQL_SELECT_RULE_EXISTS).get(input.ruleId);
          if (exists === undefined) return { ok: false, code: 'rule-not-found' as const };
          return { ok: false, code: 'rule-state-conflict' as const };
        }
        this.handle
          .prepare(SQL_INSERT_RUN)
          .run(input.runId, input.ruleId, input.requestKey, input.trigger, input.scheduledFor);
        return { ok: true, runId: input.runId };
      });
    } catch (err) {
      return { ok: false, code: this.translate(err).code };
    }
  }

  /**
   * 手动 reservation（§4.2 末段/FIXED DECISIONS 6）：单事务——
   * 1. 复验 Rule 非 deleted 且 state=enabled（paused/deleted 受控拒绝，不绕安全暂停）；
   * 2. 已有同 Rule queued|running → 返回当前 runId（复用当前 run，零二次排队）；
   * 3. 否则 INSERT queued Run（requestKey=唯一 requestId、trigger='manual'、
   *    scheduledFor=null）。零调度字段写入（不移锚点、不改 lastConsumed/lastDailyLocalDate）。
   */
  reserveManualRun(input: {
    ruleId: string;
    runId: string;
    requestKey: string;
    nowIso: string;
  }): ReserveRunResult {
    this.ensureOpen();
    try {
      return withTransaction(this.handle, () => {
        const ruleRow = this.handle.prepare(SQL_SELECT_RULE_STATE_ONLY).get(input.ruleId) as
          { state: string } | undefined;
        if (ruleRow === undefined) return { ok: false, code: 'rule-not-found' as const };
        if (ruleRow.state !== 'enabled') {
          return { ok: false, code: 'rule-state-conflict' as const };
        }
        const active = this.handle.prepare(SQL_SELECT_ACTIVE_RUN_BY_RULE).get(input.ruleId) as
          { id: string } | undefined;
        if (active !== undefined) {
          return { ok: true, runId: active.id, reused: true };
        }
        this.handle
          .prepare(SQL_INSERT_RUN)
          .run(input.runId, input.ruleId, input.requestKey, 'manual', null);
        return { ok: true, runId: input.runId, reused: false };
      });
    } catch (err) {
      return { ok: false, code: this.translate(err).code };
    }
  }

  /**
   * 运行终态事务（§10.3 步骤 5 结果提交/FIXED DECISIONS 1/7）：单事务——
   * 1. transitionRun(running → finished, outcome/health/finishedAt)；
   * 2. 写规则 consecutive_failures/backoff_until/updated_at；
   * 3. 写 runAudit（kind='run'，reason=调用方映射的闭合码）——每运行终态恰好一条；
   * 4. healthPause 且规则当前 enabled → 经 transitionRuleState 健康暂停 CAS
   *    （state→paused、pauseReason→reason）+ 恰一条 lifecycle-pause 审计；已暂停
   *    重复零审计。
   * 任一失败整体回滚（D4-R 审计事务化纪律）；提交后不回拨/不重放。
   */
  finalizeRun(input: {
    runId: string;
    ruleId: string;
    outcome: WatchRunOutcome;
    health: WatchHealthSnapshot | null;
    consecutiveFailures: number;
    backoffUntil: string | null;
    // R3-2：D7 失败终态（parse_changed/condition_error/acquisition failure/
    // superseded）必须随同一终态 CAS 写入 canonical metadata——必填非 null，
    // 在任何事务写前验证（缺失/null/非法 → validation-failed 零写）。
    responseMetadataJson: string;
    runAudit: {
      id: string;
      reasonCode: WatchAuditReasonCode;
      createdAt: string;
    };
    healthPause?: {
      reason: HealthPauseReason;
      audit: { id: string; createdAt: string };
    };
  }): WatchResult {
    this.ensureOpen();
    if (
      !Number.isInteger(input.consecutiveFailures) ||
      input.consecutiveFailures < 0 ||
      input.consecutiveFailures > 100_000
    ) {
      return { ok: false, code: 'validation-failed' };
    }
    if (input.backoffUntil !== null && !Number.isFinite(Date.parse(input.backoffUntil))) {
      return { ok: false, code: 'validation-failed' };
    }
    // R3-2：新写边界 canonical 校验（必填非 null，写前拒绝）
    if (!validateRunResponseMetadataJson(input.responseMetadataJson).ok) {
      return { ok: false, code: 'validation-failed' };
    }
    try {
      withTransaction(this.handle, () => {
        const nowIso = this.nowIso();
        const transition = this.transitionRun(input.runId, 'running', {
          status: 'finished',
          finishedAt: nowIso,
          outcome: input.outcome,
          health: input.health,
          responseMetadataJson: input.responseMetadataJson,
        });
        if (!transition.ok) throw new TxnAbortError(transition.code);
        const ruleUpdate = this.handle
          .prepare(SQL_UPDATE_RULE_FAILURE_STATE)
          .run(input.consecutiveFailures, input.backoffUntil, nowIso, input.ruleId);
        if (Number(ruleUpdate.changes) === 0) {
          const exists = this.handle.prepare(SQL_SELECT_RULE_EXISTS).get(input.ruleId);
          if (exists === undefined) throw new TxnAbortError('rule-not-found');
          // 规则已删除（级联删除本运行行已发生）：零写入仍为合法终态
        }
        // run 审计（每运行终态恰一条；kind='run'）
        if (!isIn('run', AUDIT_KINDS) || !isIn(input.runAudit.reasonCode, AUDIT_REASON_CODES)) {
          throw new TxnAbortError('validation-failed');
        }
        this.handle
          .prepare(SQL_INSERT_AUDIT)
          .run(
            input.runAudit.id,
            input.ruleId,
            'run',
            input.runAudit.reasonCode,
            input.runAudit.createdAt,
          );
        if (input.healthPause !== undefined) {
          const ruleRow = this.handle.prepare(SQL_SELECT_RULE_STATE_ONLY).get(input.ruleId) as
            { state: string } | undefined;
          // 仅 enabled→paused 迁移写一条健康暂停审计；已暂停/已删除重复零审计。
          // enabled 规则必 desiredEnabled=true（状态机不变量），健康暂停保留用户意图。
          if (ruleRow !== undefined && ruleRow.state === 'enabled') {
            const next = transitionRuleState(
              { state: 'enabled', pauseReason: null, desiredEnabled: true },
              { kind: 'health-pause', reason: input.healthPause.reason },
              { sourceExists: true, sourceEnabled: true, locatorUnchanged: true },
            );
            const current = this.getRuleStateFields(input.ruleId);
            if (current === null) throw new TxnAbortError('rule-not-found');
            const cas = this.updateRuleCoordination(
              input.ruleId,
              {
                state: current.state,
                pauseReason: current.pauseReason,
                sourceRowVersion: current.sourceRowVersion,
                sourceLocatorFingerprint: current.sourceLocatorFingerprint,
              },
              {
                state: next.state,
                pauseReason: next.pauseReason,
                sourceRowVersion: current.sourceRowVersion,
                sourceLocatorFingerprint: current.sourceLocatorFingerprint,
              },
              nowIso,
            );
            if (!cas.ok) throw new TxnAbortError(cas.code);
            if (
              !isIn('lifecycle-pause', AUDIT_KINDS) ||
              !isIn(input.healthPause.reason, AUDIT_REASON_CODES)
            ) {
              throw new TxnAbortError('validation-failed');
            }
            this.handle
              .prepare(SQL_INSERT_AUDIT)
              .run(
                input.healthPause.audit.id,
                input.ruleId,
                'lifecycle-pause',
                input.healthPause.reason,
                input.healthPause.audit.createdAt,
              );
          }
        }
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof TxnAbortError) return { ok: false, code: err.code };
      logWarn('watch', '运行终态事务异常（已整体回滚）', err);
      return { ok: false, code: this.translate(err).code };
    }
  }

  // -------------------------------------------------------------------------
  // Audit（§13；D4 只写生命周期动作：reason 为闭合码、零敌手正文）
  // -------------------------------------------------------------------------

  insertAudit(input: {
    id: string;
    ruleId: string | null;
    kind: WatchAuditKind;
    reasonCode: WatchAuditReasonCode;
    createdAt: string;
  }): WatchResult {
    this.ensureOpen();
    if (!isIn(input.kind, AUDIT_KINDS) || !isIn(input.reasonCode, AUDIT_REASON_CODES)) {
      return { ok: false, code: 'validation-failed' };
    }
    try {
      this.handle
        .prepare(SQL_INSERT_AUDIT)
        .run(input.id, input.ruleId, input.kind, input.reasonCode, input.createdAt);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: this.translate(err).code };
    }
  }

  listAudits(limit = 200): Array<{
    id: string;
    ruleId: string | null;
    kind: string;
    reasonCode: string;
    createdAt: string;
  }> {
    this.ensureOpen();
    try {
      const rows = this.handle.prepare(SQL_LIST_AUDITS).all(Math.min(limit, 1000)) as Array<{
        id: string;
        rule_id: string | null;
        kind: string;
        reason_code: string;
        created_at: string;
      }>;
      return rows.map((r) => ({
        id: r.id,
        ruleId: r.rule_id,
        kind: r.kind,
        reasonCode: r.reason_code,
        createdAt: r.created_at,
      }));
    } catch (err) {
      logWarn('watch', '列出审计失败（fail-closed 返回空列表）', err);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Event + items + Baseline + Run + outbox 单事务原子写（§9.4 末段）
  // -------------------------------------------------------------------------

  writeEventTransaction(input: {
    event: WatchEvent;
    items: ChangeEvidencePair[];
    // R5：单事务完整身份 CAS（必需）——规则存在且未删除、event.sourceId 与规则
    // source_id 一致、当前 fingerprint 与 expected 一致、baselineVersion 一致。
    identity: {
      sourceId: string;
      expectedSourceLocatorFingerprint: string;
      expectedBaselineVersion: number | null;
    };
    baseline?: {
      expectedBaselineVersion: number | null;
      projectionType: 'feed' | 'page';
      projectionJson: string;
      contentHash: string;
      byteLength: number;
      finalUrl: string;
      capturedAt: string;
      documentId: string | null;
    };
    run?: {
      runId: string;
      expectedStatus: 'queued' | 'running';
      outcome: WatchRunOutcome;
      health: WatchHealthSnapshot | null;
      responseMetadataJson: string;
    };
    outbox?: Array<{
      id: string;
      ruleId: string | null;
      subjectType: 'event' | 'digest';
      subjectId: string;
      channel: 'in-app' | 'windows';
      dedupeKey: string;
      privacyJson: string;
      createdAt: string;
    }>;
    audits?: Array<{
      id: string;
      ruleId: string | null;
      kind: WatchAuditKind;
      reasonCode: WatchAuditReasonCode;
      createdAt: string;
    }>;
  }): WatchResult {
    this.ensureOpen();
    if (input.event.itemCount !== input.items.length || input.items.length < 1) {
      return { ok: false, code: 'validation-failed' };
    }
    const serializedItems: string[] = [];
    let itemsBytes = 0;
    let incomingBytes =
      utf8ByteLength(input.event.id) + utf8ByteLength(input.event.idempotencyKey) + 200;
    for (const item of input.items) {
      if (validateChangeEvidencePair(item) === null) {
        return { ok: false, code: 'validation-failed' };
      }
      const json = JSON.stringify(item);
      serializedItems.push(json);
      itemsBytes += utf8ByteLength(json);
      incomingBytes += utf8ByteLength(json) + 60;
    }
    if (itemsBytes > this.maxEventEvidenceBytes) {
      return { ok: false, code: 'event-budget-exceeded' };
    }
    if (input.baseline !== undefined) {
      // R6：投影真实字节预算（声明必须等于实际且在上限内）
      const actualBaselineBytes = utf8ByteLength(input.baseline.projectionJson);
      if (
        !Number.isInteger(input.baseline.byteLength) ||
        input.baseline.byteLength < 0 ||
        input.baseline.byteLength > this.maxBaselineBytes ||
        actualBaselineBytes > this.maxBaselineBytes
      ) {
        return { ok: false, code: 'baseline-budget-exceeded' };
      }
      if (input.baseline.byteLength !== actualBaselineBytes) {
        return { ok: false, code: 'validation-failed' };
      }
      incomingBytes += actualBaselineBytes + 200;
    }
    for (const item of input.outbox ?? []) {
      incomingBytes += utf8ByteLength(item.privacyJson) + utf8ByteLength(item.dedupeKey) + 100;
    }
    for (const audit of input.audits ?? []) {
      if (!isIn(audit.kind, AUDIT_KINDS) || !isIn(audit.reasonCode, AUDIT_REASON_CODES)) {
        return { ok: false, code: 'validation-failed' };
      }
    }
    // R3-2：writeEventTransaction 的可选 Run 终态接口不得绕过 canonical metadata
    // 要求——提供 run 时 responseMetadataJson 必填非 null 且 canonical（写前拒绝）。
    if (
      input.run !== undefined &&
      !validateRunResponseMetadataJson(input.run.responseMetadataJson).ok
    ) {
      return { ok: false, code: 'validation-failed' };
    }
    try {
      withTransaction(this.handle, () => {
        // 身份 CAS 在同一事务内验证（不得以事务外两步拼接冒充原子 CAS）
        const ruleRow = this.handle.prepare(SQL_SELECT_RULE_IDENTITY).get(input.event.ruleId) as
          | {
              state: string;
              source_id: string;
              source_locator_fingerprint: string;
              baseline_version: number;
            }
          | undefined;
        if (ruleRow === undefined) throw new TxnAbortError('rule-not-found');
        if (ruleRow.state === 'deleted') throw new TxnAbortError('identity-conflict');
        if (
          ruleRow.source_id !== input.event.sourceId ||
          ruleRow.source_id !== input.identity.sourceId
        ) {
          throw new TxnAbortError('identity-conflict');
        }
        if (
          ruleRow.source_locator_fingerprint !== input.identity.expectedSourceLocatorFingerprint
        ) {
          throw new TxnAbortError('identity-conflict');
        }
        // 列值恒为整数 0..N；identity 的 null 表示首个写入（要求当前为 0）
        if (ruleRow.baseline_version !== (input.identity.expectedBaselineVersion ?? 0)) {
          throw new TxnAbortError('baseline-conflict');
        }
        if (
          input.baseline !== undefined &&
          input.baseline.expectedBaselineVersion !== input.identity.expectedBaselineVersion
        ) {
          throw new TxnAbortError('validation-failed');
        }
        if (this.estimateLogicalBytesInternal() + incomingBytes > this.maxDbBytes) {
          throw new TxnAbortError('db-budget-exceeded');
        }
        if (input.baseline !== undefined) {
          const baselineResult = this.applyBaselineInternal({
            ...input.baseline,
            ruleId: input.event.ruleId,
          });
          if (!baselineResult.ok) throw new TxnAbortError(baselineResult.code);
        }
        this.handle
          .prepare(SQL_INSERT_EVENT)
          .run(
            input.event.id,
            input.event.ruleId,
            input.event.sourceId,
            input.event.eventKind,
            input.event.importance,
            input.event.idempotencyKey,
            input.event.changeFingerprint,
            input.event.firstObservedAt,
            input.event.lastObservedAt,
            input.event.itemCount,
          );
        // v3：每个 Event 至少一条 observation（本方法固定 sequence=0 首观察）；
        // R3-4：observation.id 必须为 Node randomUUID() 小写 v4 UUID（无 obs0/c- 前后缀）。
        const observationId = randomUUID();
        this.handle
          .prepare(SQL_INSERT_OBSERVATION)
          .run(
            observationId,
            input.event.id,
            0,
            input.event.idempotencyKey,
            input.event.changeFingerprint,
            input.event.eventKind,
            input.event.firstObservedAt,
            0,
            input.event.itemCount,
          );
        this.appendDigestChangeJournal(
          observationId,
          input.event.id,
          input.event.sourceId,
          input.event.firstObservedAt,
        );
        for (let i = 0; i < input.items.length; i += 1) {
          const item = input.items[i]!;
          this.handle
            .prepare(SQL_INSERT_EVENT_ITEM)
            .run(
              `${input.event.id}-${i}`,
              input.event.id,
              i,
              observationId,
              i,
              item.itemId,
              item.fieldKey,
              item.label,
              JSON.stringify(item.before),
              JSON.stringify(item.after),
              item.beforeCapturedAt,
              item.afterCapturedAt,
              item.beforeFinalUrl,
              item.afterFinalUrl,
              item.beforeDocumentId,
              item.afterDocumentId,
              item.feedItemKey,
            );
        }
        if (input.run !== undefined) {
          const runResult = this.transitionRun(input.run.runId, input.run.expectedStatus, {
            status: 'finished',
            finishedAt: this.nowIso(),
            outcome: input.run.outcome,
            health: input.run.health,
            responseMetadataJson: input.run.responseMetadataJson,
          });
          if (!runResult.ok) throw new TxnAbortError(runResult.code);
        }
        for (const item of input.outbox ?? []) {
          this.handle
            .prepare(SQL_INSERT_OUTBOX)
            .run(
              item.id,
              item.ruleId,
              item.subjectType,
              item.subjectId,
              item.channel,
              item.dedupeKey,
              item.privacyJson,
              item.createdAt,
              item.createdAt,
            );
        }
        // 契约要求的审计写入与其余写入同事务；任一失败整体回滚
        for (const audit of input.audits ?? []) {
          this.handle
            .prepare(SQL_INSERT_AUDIT)
            .run(audit.id, audit.ruleId, audit.kind, audit.reasonCode, audit.createdAt);
        }
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof TxnAbortError) return { ok: false, code: err.code };
      logWarn('watch', 'Event 原子事务异常（已整体回滚）', err);
      return { ok: false, code: this.translate(err).code };
    }
  }

  getEvent(eventId: string): WatchEvent | null {
    this.ensureOpen();
    try {
      const row = this.handle.prepare(SQL_SELECT_EVENT).get(eventId) as unknown;
      if (!isPlainRecord(row)) return null;
      const validated = validateEventRow(row);
      if (!validated.ok || validated.value === null) {
        logWarn('watch', 'Event 行读回校验失败（fail-closed 视为不存在）');
        return null;
      }
      return validated.value;
    } catch (err) {
      logWarn('watch', '读取 Event 失败（fail-closed 返回 null）', err);
      return null;
    }
  }

  listEventsByRule(ruleId: string): WatchEvent[] {
    this.ensureOpen();
    try {
      const rows = this.handle.prepare(SQL_SELECT_EVENTS_BY_RULE).all(ruleId) as unknown[];
      const out: WatchEvent[] = [];
      for (const row of rows) {
        const validated = validateEventRow(row);
        if (validated.ok && validated.value !== null) out.push(validated.value);
        else logWarn('watch', 'Event 行读回校验失败（fail-closed 跳过）');
      }
      return out;
    } catch (err) {
      logWarn('watch', '列出 Event 失败（fail-closed 返回空列表）', err);
      return [];
    }
  }

  listEventItems(eventId: string): ChangeEvidencePair[] {
    this.ensureOpen();
    try {
      const rows = this.handle.prepare(SQL_SELECT_EVENT_ITEMS).all(eventId) as Array<{
        before_value_json: string;
        after_value_json: string;
        [key: string]: unknown;
      }>;
      const out: ChangeEvidencePair[] = [];
      for (const row of rows) {
        const before = this.parseJson(row.before_value_json);
        const after = this.parseJson(row.after_value_json);
        const pair = {
          itemId: row['item_id'] as string,
          fieldKey: row['field_key'] as string,
          label: row['label'] as string,
          before,
          after,
          beforeCapturedAt: row['before_captured_at'] as string,
          afterCapturedAt: row['after_captured_at'] as string,
          beforeFinalUrl: row['before_final_url'] as string,
          afterFinalUrl: row['after_final_url'] as string,
          beforeDocumentId: row['before_document_id'] as string | null,
          afterDocumentId: row['after_document_id'] as string | null,
          feedItemKey: row['feed_item_key'] as string | null,
        };
        const validated = validateChangeEvidencePair(pair);
        if (validated === null) {
          logWarn('watch', 'Event item 读回校验失败（fail-closed 跳过）');
          continue;
        }
        out.push(validated);
      }
      return out;
    } catch (err) {
      logWarn('watch', '读取 Event items 失败（fail-closed 返回空列表）', err);
      return [];
    }
  }

  markEventsRead(eventIds: readonly string[], nowIso: string): number {
    this.ensureOpen();
    let count = 0;
    for (const id of eventIds) {
      const result = this.handle.prepare(SQL_MARK_EVENTS_READ).run(nowIso, id);
      count += Number(result.changes);
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Digest refs（D8 写；D4 只提供有界原语 + 清理 tombstone）
  // -------------------------------------------------------------------------

  insertDigestEventRef(input: {
    digestId: string;
    eventId: string;
    status: 'active' | 'expired' | 'user-deleted';
  }): WatchResult {
    this.ensureOpen();
    try {
      this.handle.prepare(SQL_INSERT_DIGEST_REF).run(input.digestId, input.eventId, input.status);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: this.translate(err).code };
    }
  }

  listDigestEventRefs(): Array<{ digestId: string; eventId: string; status: string }> {
    this.ensureOpen();
    try {
      const rows = this.handle.prepare(SQL_SELECT_DIGEST_REFS).all() as Array<{
        digest_id: string;
        event_id: string;
        status: string;
      }>;
      return rows.map((r) => ({ digestId: r.digest_id, eventId: r.event_id, status: r.status }));
    } catch (err) {
      logWarn('watch', '列出 Digest refs 失败（fail-closed 返回空列表）', err);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // source_cleanup_intents（§10.3 状态机）
  // -------------------------------------------------------------------------

  insertSourceCleanupIntent(input: SourceCleanupIntentRow): WatchResult {
    this.ensureOpen();
    if (
      input.beforeProjection !== null &&
      validateSourceWatchProjection(input.beforeProjection) === null
    ) {
      return { ok: false, code: 'validation-failed' };
    }
    if (
      input.afterProjection !== null &&
      validateSourceWatchProjection(input.afterProjection) === null
    ) {
      return { ok: false, code: 'validation-failed' };
    }
    if (validateAffectedRuleStateMap(input.affectedRuleState) === null) {
      return { ok: false, code: 'validation-failed' };
    }
    try {
      this.handle
        .prepare(SQL_INSERT_INTENT)
        .run(
          input.mutationId,
          input.sourceId,
          input.operation,
          input.beforeProjection === null ? null : JSON.stringify(input.beforeProjection),
          input.afterProjection === null ? null : JSON.stringify(input.afterProjection),
          JSON.stringify(input.affectedRuleState),
          input.state,
          input.createdAt,
          input.updatedAt,
        );
      return { ok: true };
    } catch (err) {
      return { ok: false, code: this.translate(err).code };
    }
  }

  // intent 读路径同为 coordinator-facing fail-closed 契约（异常/非法行抛错，
  // 仅 not-found 返回 null、合法空返回 []）。
  getSourceCleanupIntent(mutationId: string): SourceCleanupIntentRow | null {
    this.ensureOpen();
    let raw: unknown;
    try {
      raw = this.handle.prepare(SQL_SELECT_INTENT).get(mutationId) as unknown;
    } catch (err) {
      throw new WatchRepositoryError('sqlite-error', this.sqlErrorText(err));
    }
    return this.intentFromRaw(raw);
  }

  listSourceCleanupIntents(): SourceCleanupIntentRow[] {
    this.ensureOpen();
    let rows: unknown[];
    try {
      rows = this.handle.prepare(SQL_SELECT_INTENTS).all() as unknown[];
    } catch (err) {
      throw new WatchRepositoryError('sqlite-error', this.sqlErrorText(err));
    }
    return rows
      .map((raw) => this.intentFromRaw(raw))
      .filter((i): i is SourceCleanupIntentRow => i !== null);
  }

  listPendingSourceCleanupIntents(): SourceCleanupIntentRow[] {
    this.ensureOpen();
    let rows: unknown[];
    try {
      rows = this.handle.prepare(SQL_SELECT_PENDING_INTENTS).all() as unknown[];
    } catch (err) {
      throw new WatchRepositoryError('sqlite-error', this.sqlErrorText(err));
    }
    return rows
      .map((raw) => this.intentFromRaw(raw))
      .filter((i): i is SourceCleanupIntentRow => i !== null);
  }

  private intentFromRaw(raw: unknown): SourceCleanupIntentRow | null {
    if (raw === undefined) return null; // not-found（合法空结果）
    if (!isPlainRecord(raw)) {
      throw new WatchRepositoryError('sqlite-error', 'intent 行形状非法');
    }
    const beforeRaw =
      raw['before_projection_json'] === null ? null : this.parseJson(raw['before_projection_json']);
    const afterRaw =
      raw['after_projection_json'] === null ? null : this.parseJson(raw['after_projection_json']);
    const affectedRaw = this.parseJson(raw['affected_rule_state_json']);
    const normalized = {
      mutationId: raw['mutation_id'] as string,
      sourceId: raw['source_id'] as string,
      operation: raw['operation'] as SourceCleanupIntentRow['operation'],
      beforeProjection: beforeRaw as SourceCleanupIntentRow['beforeProjection'],
      afterProjection: afterRaw as SourceCleanupIntentRow['afterProjection'],
      affectedRuleState: affectedRaw,
      state: raw['state'] as SourceCleanupIntentState,
      createdAt: raw['created_at'] as string,
      updatedAt: raw['updated_at'] as string,
    };
    const validated = validateIntentRow(normalized);
    if (!validated.ok || validated.value === null) {
      throw new WatchRepositoryError('sqlite-error', 'intent 行读回校验失败');
    }
    return validated.value;
  }

  transitionSourceCleanupIntent(
    mutationId: string,
    expectedState: SourceCleanupIntentState,
    nextState: SourceCleanupIntentState,
    nowIso: string,
  ): WatchResult {
    this.ensureOpen();
    // 状态机（§10.3）：prepared → {source-committed, complete, aborted}；
    // source-committed → {complete, aborted}；终态（complete/aborted）不可离开
    //（幂等重放：重放已解决 intent 得到确定性 conflict，绝不二次级联）。
    const ALLOWED: Readonly<Record<SourceCleanupIntentState, readonly SourceCleanupIntentState[]>> =
      {
        prepared: ['source-committed', 'complete', 'aborted'],
        'source-committed': ['complete', 'aborted'],
        complete: [],
        aborted: [],
      };
    if (!ALLOWED[expectedState].includes(nextState)) {
      return { ok: false, code: 'intent-state-conflict' };
    }
    try {
      const result = this.handle
        .prepare(SQL_TRANSITION_INTENT)
        .run(nextState, nowIso, mutationId, expectedState);
      if (Number(result.changes) === 0) {
        const exists = this.handle.prepare(SQL_SELECT_INTENT_EXISTS).get(mutationId);
        return exists === undefined
          ? { ok: false, code: 'intent-not-found' }
          : { ok: false, code: 'intent-state-conflict' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, code: this.translate(err).code };
    }
  }

  // 启动 reconciliation 全部成功后才删除已解决 intent（§10.2 步骤 6）
  deleteResolvedIntents(): number {
    this.ensureOpen();
    const result = this.handle.prepare(SQL_DELETE_RESOLVED_INTENTS).run();
    return Number(result.changes);
  }

  // -------------------------------------------------------------------------
  // D7 Processing 结果事务层（§8.1/§9.4/#S6-047～#S6-052/#S6-057）：Repository 是
  // 唯一 SQL 点，ProcessingService 只编排。所有结果路径在同一单事务完成——
  // identity/baseline/event conflict 全部零写。
  // -------------------------------------------------------------------------

  // D7 §8.1：Rule 结果身份（含完整状态 CAS 字段）
  getRuleResultIdentity(ruleId: string): {
    state: WatchRule['state'];
    desiredEnabled: boolean;
    pauseReason: WatchRule['pauseReason'];
    sourceId: string;
    sourceLocatorFingerprint: string;
    baselineVersion: number;
    sourceRowVersion: number;
  } | null {
    this.ensureOpen();
    const row = this.handle.prepare(SQL_SELECT_RULE_RESULT_IDENTITY).get(ruleId) as
      | {
          state: string;
          desired_enabled: number;
          pause_reason: string | null;
          source_id: string;
          source_locator_fingerprint: string;
          baseline_version: number;
          source_row_version: number;
        }
      | undefined;
    if (row === undefined) return null;
    return {
      state: row.state as WatchRule['state'],
      desiredEnabled: row.desired_enabled === 1,
      pauseReason: row.pause_reason as WatchRule['pauseReason'],
      sourceId: row.source_id,
      sourceLocatorFingerprint: row.source_locator_fingerprint,
      baselineVersion: row.baseline_version,
      sourceRowVersion: row.source_row_version,
    };
  }

  // #S6-052：单调 rowVersion 更新（max(current, revalidated)）——必须连同完整
  // 状态/身份 CAS 一起执行；locator prepare 只暂停保留旧 fingerprint 时该 CAS 失败
  //（state=paused → 条件不满足 → 0 行 → 调用方整体失败）。
  updateRuleResultRowVersion(input: {
    ruleId: string;
    sourceAfterRevalidationRowVersion: number;
    expectedSourceId: string;
    expectedSourceLocatorFingerprint: string;
    nowIso: string;
  }): WatchResult {
    this.ensureOpen();
    try {
      const result = this.handle
        .prepare(SQL_UPDATE_RULE_RESULT_ROWVERSION)
        .run(
          input.sourceAfterRevalidationRowVersion,
          input.nowIso,
          input.ruleId,
          input.expectedSourceId,
          input.expectedSourceLocatorFingerprint,
        );
      if (Number(result.changes) === 0) {
        const exists = this.handle.prepare(SQL_SELECT_RULE_EXISTS).get(input.ruleId);
        if (exists === undefined) return { ok: false, code: 'rule-not-found' };
        return { ok: false, code: 'identity-conflict' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, code: this.translate(err).code };
    }
  }

  // D7 #S6-048：最近持久化变化对（reversal oracle）
  findRecentPersistedPair(
    ruleId: string,
    itemId: string,
    fieldKey: string,
  ): ChangeEvidencePair | null {
    this.ensureOpen();
    try {
      const row = this.handle
        .prepare(SQL_SELECT_RECENT_PAIR)
        .get(ruleId, itemId, fieldKey) as unknown;
      if (!isPlainRecord(row)) return null;
      const before = this.parseJson(row['before_value_json']);
      const after = this.parseJson(row['after_value_json']);
      const pair: ChangeEvidencePair = {
        itemId: row['item_id'] as string,
        fieldKey: row['field_key'] as string,
        label: row['label'] as string,
        before: before as ChangeEvidencePair['before'],
        after: after as ChangeEvidencePair['after'],
        beforeCapturedAt: row['before_captured_at'] as string,
        afterCapturedAt: row['after_captured_at'] as string,
        beforeFinalUrl: row['before_final_url'] as string,
        afterFinalUrl: row['after_final_url'] as string,
        beforeDocumentId: row['before_document_id'] as string | null,
        afterDocumentId: row['after_document_id'] as string | null,
        feedItemKey: row['feed_item_key'] as string | null,
      };
      return validateChangeEvidencePair(pair);
    } catch (err) {
      logWarn('watch', '读取最近变化对失败（fail-closed 返回 null）', err);
      return null;
    }
  }

  // D7 §9.4/#S6-047：coalesce 候选 = 该 Rule 最近一个 Event
  findLatestEventForCoalesce(ruleId: string): WatchEvent | null {
    this.ensureOpen();
    try {
      const row = this.handle.prepare(SQL_SELECT_LATEST_EVENT).get(ruleId) as unknown;
      if (!isPlainRecord(row)) return null;
      const validated = validateEventRow(row);
      if (!validated.ok || validated.value === null) return null;
      return validated.value;
    } catch (err) {
      logWarn('watch', '读取 coalesce 候选失败（fail-closed 返回 null）', err);
      return null;
    }
  }

  // D7 #S6-051：观察级 idempotency_key 查询（dedup 判定）
  findObservationByIdempotencyKey(idempotencyKey: string): {
    observationId: string;
    eventId: string;
    ruleId: string;
    sourceId: string;
  } | null {
    this.ensureOpen();
    try {
      const row = this.handle.prepare(SQL_SELECT_OBSERVATION_BY_IDEM).get(idempotencyKey) as
        { id: string; event_id: string } | undefined;
      if (row === undefined) return null;
      const eventRow = this.handle.prepare(SQL_SELECT_EVENT).get(row.event_id) as
        { rule_id: string; source_id: string } | undefined;
      if (eventRow === undefined) return null;
      return {
        observationId: row.id,
        eventId: row.event_id,
        ruleId: eventRow.rule_id,
        sourceId: eventRow.source_id,
      };
    } catch (err) {
      logWarn('watch', '查询 observation idempotency_key 失败（fail-closed 返回 null）', err);
      return null;
    }
  }

  /**
   * D7 结果事务（§8.1/#S6-047/#S6-049/#S6-051/#S6-057）：
   * 处理 create / coalesce / dedup / unchanged / changed-unmatched 五类结果，
   * 全程单事务。identity/baseline/event conflict 零结果写入并返回对应 code。
   *
   * - create：Event + observation + items + Baseline + Run 终态 + outbox + audit；
   * - coalesce：observation + items 追加 + Event 行更新 + Baseline + Run 终态 + audit
   *   （CAS 复验 Event first_observed_at/item_count；绝不动 outbox）；
   * - dedup：合法重放 → running Run 终结为 event-deduplicated + 健康恢复 + audit，
   *   零 Event/observation/item/outbox/Baseline 写；已终态重入零写；
   * - unchanged：contentHash 相等 / 304 → 只更新 validator + Run/health/audit +
   *   rowVersion（Baseline version/content 不变）；
   * - changed-unmatched：推进有效新 Baseline + Run=changed-unmatched + 健康恢复 + audit。
   */
  writeEventResult(input: {
    path: 'create' | 'coalesce' | 'dedup' | 'unchanged' | 'changed-unmatched';
    rule: WatchRule;
    runId: string;
    sourceAfterRevalidationRowVersion: number;
    // 结果事务完整身份 CAS（#S6-057：enabled/desired/unpaused + sourceId/fingerprint/
    // baselineVersion；rowVersion 不参与 CAS）。expectedBaselineVersion=null 表示
    // 首个 Baseline（要求当前 baseline_version=0 且无行），否则要求精确等于当前。
    identity: {
      sourceId: string;
      sourceLocatorFingerprint: string;
      expectedBaselineVersion: number | null;
    };
    // create/coalesce/changed-unmatched：新 Baseline（unchanged/dedup 不需要）
    baseline?: {
      projectionType: 'feed' | 'page';
      projectionJson: string;
      contentHash: string;
      byteLength: number;
      finalUrl: string;
      capturedAt: string;
      documentId: string | null;
      validators: { etag: string | null; lastModified: string | null };
    };
    // create：新 Event（含 idempotencyKey/changeFingerprint 首观察值）
    event?: {
      event: WatchEvent;
      items: ChangeEvidencePair[];
      outbox?: Array<{
        id: string;
        dedupeKey: string;
        privacyJson: string;
      }>;
    };
    // coalesce：目标 Event + 追加的观察元数据（idempotencyKey 由 Processing 计算）
    coalesce?: {
      eventId: string;
      expectedFirstObservedAt: string;
      expectedItemCount: number;
      eventKind: WatchEventKind;
      lastObservedAt: string;
      newItemCount: number;
      observationId: string;
      idempotencyKey: string;
      changeFingerprint: string;
      items: ChangeEvidencePair[];
    };
    // dedup：该观察的 idempotencyKey（结果事务内查询并复验 Event/Rule/Source 一致）
    dedupIdempotencyKey?: string;
    // unchanged：validator 提交值（#S6-056：200 缺失/超限清空，304 缺失/超限保留旧值）
    validatorUpdate?: { etag: string | null; lastModified: string | null };
    run: {
      expectedStatus: 'queued' | 'running';
      outcome: WatchRunOutcome;
      health: WatchHealthSnapshot | null;
      responseMetadataJson: string | null;
    };
    audits: Array<{
      id: string;
      reasonCode: WatchAuditReasonCode;
      createdAt: string;
    }>;
  }): WatchResult {
    this.ensureOpen();
    // R2-1：D7 新写结果事务的 finished Run 必须随终态 CAS 持久化 canonical
    // WatchRunResponseMetadata——不接受 null（legacy-opaque 只允许读回）。
    if (
      input.run.responseMetadataJson === null ||
      !validateRunResponseMetadataJson(input.run.responseMetadataJson).ok
    ) {
      return { ok: false, code: 'validation-failed' };
    }
    if (
      input.rule.state !== 'enabled' ||
      !input.rule.desiredEnabled ||
      input.rule.pauseReason !== null
    ) {
      return { ok: false, code: 'identity-conflict' };
    }
    if (
      input.identity.sourceId !== input.rule.sourceId ||
      input.identity.sourceLocatorFingerprint !== input.rule.sourceLocatorFingerprint
    ) {
      return { ok: false, code: 'identity-conflict' };
    }
    if (
      (input.identity.expectedBaselineVersion === null && input.rule.baselineVersion !== 0) ||
      (input.identity.expectedBaselineVersion !== null &&
        input.identity.expectedBaselineVersion !== input.rule.baselineVersion)
    ) {
      return { ok: false, code: 'baseline-conflict' };
    }
    if (
      input.baseline !== undefined &&
      !validateBaselineValidators({
        projectionType: input.baseline.projectionType,
        etag: input.baseline.validators.etag,
        lastModified: input.baseline.validators.lastModified,
      })
    ) {
      return { ok: false, code: 'validation-failed' };
    }
    // R3-3：unchanged validator 更新路径写前复用同一 runtime 规则（Page 恒 null、
    // 非 null ≤1024 字节；超限/Page 非 null → validation-failed 零写）。
    if (
      input.validatorUpdate !== undefined &&
      !validateBaselineValidators({
        projectionType: input.rule.kind === 'page' ? 'page' : 'feed',
        etag: input.validatorUpdate.etag,
        lastModified: input.validatorUpdate.lastModified,
      })
    ) {
      return { ok: false, code: 'validation-failed' };
    }
    try {
      return withTransaction(this.handle, () => {
        // 1. 事务内完整身份 CAS（重新读库，不信任传入 rule 快照）
        const identityRow = this.handle
          .prepare(SQL_SELECT_RULE_RESULT_IDENTITY)
          .get(input.rule.id) as
          | {
              state: string;
              desired_enabled: number;
              pause_reason: string | null;
              source_id: string;
              source_locator_fingerprint: string;
              baseline_version: number;
              source_row_version: number;
            }
          | undefined;
        if (identityRow === undefined) throw new TxnAbortError('rule-not-found');
        if (
          identityRow.state !== 'enabled' ||
          identityRow.desired_enabled !== 1 ||
          identityRow.pause_reason !== null
        ) {
          throw new TxnAbortError('identity-conflict');
        }
        if (
          identityRow.source_id !== input.identity.sourceId ||
          identityRow.source_locator_fingerprint !== input.identity.sourceLocatorFingerprint
        ) {
          throw new TxnAbortError('identity-conflict');
        }

        const nowIso = this.nowIso();
        // FIXED DECISION 1：#S6-058 metadata 随 Run 终态在同一 CAS UPDATE 写入，
        // 不做独立预写 UPDATE（独立预写会在已终态 dedup 重入时产生写入）。

        // 2. dedup（#S6-051）：先做身份 CAS（不做 baselineVersion 提前挡住合法
        //    replay），再查询 observation idempotencyKey 并复验一致。
        if (input.path === 'dedup') {
          if (input.dedupIdempotencyKey === undefined) throw new TxnAbortError('validation-failed');
          const found = this.findObservationByIdempotencyKey(input.dedupIdempotencyKey);
          if (found === null) throw new TxnAbortError('event-conflict');
          if (found.ruleId !== input.rule.id || found.sourceId !== input.rule.sourceId) {
            throw new TxnAbortError('event-conflict');
          }
          // 当前 Baseline version >= expected+1 才合法（后续真实观察已推进则更高，
          // 合法；落后则数据完整性失败 → store-unavailable）。首建（expected=null）
          // 不存在已观察，dedup 不可达——防御分支。
          const expected = input.identity.expectedBaselineVersion;
          if (expected === null || identityRow.baseline_version < expected + 1) {
            throw new TxnAbortError('store-unavailable');
          }
          // running Run 精确终结为 event-deduplicated（已终态重入由 transitionRun 拒绝 → 零写）
          const runResult = this.transitionRun(input.runId, input.run.expectedStatus, {
            status: 'finished',
            finishedAt: nowIso,
            outcome: input.run.outcome,
            health: input.run.health,
            responseMetadataJson: input.run.responseMetadataJson,
          });
          if (!runResult.ok) {
            if (runResult.code === 'run-state-conflict' || runResult.code === 'run-not-found') {
              return { ok: true }; // 已终态重入：零审计/零写入
            }
            throw new TxnAbortError(runResult.code);
          }
          this.writeAuditsInternal(input.audits, input.rule.id, nowIso);
          const rowRes = this.updateRuleResultRowVersion({
            ruleId: input.rule.id,
            sourceAfterRevalidationRowVersion: input.sourceAfterRevalidationRowVersion,
            expectedSourceId: input.identity.sourceId,
            expectedSourceLocatorFingerprint: input.identity.sourceLocatorFingerprint, // 保持当前推进值
            nowIso,
          });
          if (!rowRes.ok) throw new TxnAbortError(rowRes.code);
          return { ok: true };
        }

        // 3. 非 dedup：必须要求当前 baselineVersion 与 expected 一致（#S6-051）；
        //    expected=null 表示首建（当前必须为 0）
        if (
          (input.identity.expectedBaselineVersion === null && identityRow.baseline_version !== 0) ||
          (input.identity.expectedBaselineVersion !== null &&
            identityRow.baseline_version !== input.identity.expectedBaselineVersion)
        ) {
          throw new TxnAbortError('baseline-conflict');
        }

        // 4. create/coalesce/changed-unmatched/unchanged 主体
        if (input.path === 'create' && input.event !== undefined) {
          if (
            input.event.event.itemCount !== input.event.items.length ||
            input.event.items.length < 1
          ) {
            throw new TxnAbortError('validation-failed');
          }
          let itemsBytes = 0;
          for (const item of input.event.items) {
            if (validateChangeEvidencePair(item) === null)
              throw new TxnAbortError('validation-failed');
            itemsBytes += utf8ByteLength(JSON.stringify(item));
          }
          if (itemsBytes > this.maxEventEvidenceBytes)
            throw new TxnAbortError('event-budget-exceeded');
          // FIXED DECISION 7：预算估算必须包含 observation 元数据、Baseline validators、
          // item observation 关系列及结果事务完整新增写集（Baseline/Event/observation/
          // items/outbox/audit/Run metadata）——低估不得绕过 maxDbBytes。
          // R3-4：新 Event 首 observation 使用 Node randomUUID() 小写 UUID v4；预算
          // 必须使用实际 observationId 字节数，不得再假设 `eventId-obs0`。
          const observationId = randomUUID();
          const writeSet = this.estimateResultCreateWriteSet({
            event: input.event.event,
            observationId,
            itemCount: input.event.items.length,
            itemsBytes,
            baseline: input.baseline,
            responseMetadataJson: input.run.responseMetadataJson,
            outbox: input.event.outbox,
            audits: input.audits,
          });
          if (this.estimateLogicalBytesInternal() + writeSet > this.maxDbBytes) {
            throw new TxnAbortError('db-budget-exceeded');
          }
          if (input.baseline !== undefined) {
            const b = this.applyBaselineInternal({
              ruleId: input.rule.id,
              expectedBaselineVersion: input.identity.expectedBaselineVersion,
              projectionType: input.baseline.projectionType,
              projectionJson: input.baseline.projectionJson,
              contentHash: input.baseline.contentHash,
              byteLength: input.baseline.byteLength,
              finalUrl: input.baseline.finalUrl,
              capturedAt: input.baseline.capturedAt,
              documentId: input.baseline.documentId,
              validators: input.baseline.validators,
            });
            if (!b.ok) throw new TxnAbortError(b.code);
          }
          this.handle
            .prepare(SQL_INSERT_EVENT)
            .run(
              input.event.event.id,
              input.event.event.ruleId,
              input.event.event.sourceId,
              input.event.event.eventKind,
              input.event.event.importance,
              input.event.event.idempotencyKey,
              input.event.event.changeFingerprint,
              input.event.event.firstObservedAt,
              input.event.event.lastObservedAt,
              input.event.event.itemCount,
            );
          this.handle
            .prepare(SQL_INSERT_OBSERVATION)
            .run(
              observationId,
              input.event.event.id,
              0,
              input.event.event.idempotencyKey,
              input.event.event.changeFingerprint,
              input.event.event.eventKind,
              input.event.event.firstObservedAt,
              0,
              input.event.event.itemCount,
            );
          this.appendDigestChangeJournal(
            observationId,
            input.event.event.id,
            input.event.event.sourceId,
            input.event.event.firstObservedAt,
          );
          for (let i = 0; i < input.event.items.length; i += 1) {
            const item = input.event.items[i]!;
            this.handle
              .prepare(SQL_INSERT_EVENT_ITEM)
              .run(
                `${input.event.event.id}-${i}`,
                input.event.event.id,
                i,
                observationId,
                i,
                item.itemId,
                item.fieldKey,
                item.label,
                JSON.stringify(item.before),
                JSON.stringify(item.after),
                item.beforeCapturedAt,
                item.afterCapturedAt,
                item.beforeFinalUrl,
                item.afterFinalUrl,
                item.beforeDocumentId,
                item.afterDocumentId,
                item.feedItemKey,
              );
          }
          for (const ob of input.event.outbox ?? []) {
            this.handle
              .prepare(SQL_INSERT_OUTBOX)
              .run(
                ob.id,
                input.rule.id,
                'event',
                input.event.event.id,
                'in-app',
                ob.dedupeKey,
                ob.privacyJson,
                nowIso,
                nowIso,
              );
          }
        } else if (input.path === 'coalesce' && input.coalesce !== undefined) {
          // 合并：observation + items 追加 + Event 行更新；绝不创建/修改 outbox
          if (input.coalesce.items.length < 1) throw new TxnAbortError('validation-failed');
          let itemsBytes = 0;
          for (const item of input.coalesce.items) {
            if (validateChangeEvidencePair(item) === null)
              throw new TxnAbortError('validation-failed');
            itemsBytes += utf8ByteLength(JSON.stringify(item));
          }
          if (itemsBytes > this.maxEventEvidenceBytes)
            throw new TxnAbortError('event-budget-exceeded');
          // R3-4：coalesce 新 observation 必须为小写 UUID v4（拒绝 c-<uuid>/obs0/任意形态）
          if (!isValidNewObservationId(input.coalesce.observationId)) {
            throw new TxnAbortError('validation-failed');
          }
          // R2-2 FIXED DECISION 7：coalesce 必须在任何 Event/Baseline/observation/
          // item/audit/Run mutation 前，于同一事务计算当前逻辑字节 + 完整新增写集
          //（observation 元数据、items observation 关系列、Baseline/validators、
          // Run metadata、audit、Event 行增长）。超限 → db-budget-exceeded 且全部恒等。
          const coalesceWriteSet = this.estimateResultCoalesceWriteSet({
            ruleId: input.rule.id,
            eventId: input.coalesce.eventId,
            observationId: input.coalesce.observationId,
            idempotencyKey: input.coalesce.idempotencyKey,
            changeFingerprint: input.coalesce.changeFingerprint,
            eventKind: input.coalesce.eventKind,
            lastObservedAt: input.coalesce.lastObservedAt,
            newItemCount: input.coalesce.newItemCount,
            itemsBytes,
            itemCount: input.coalesce.items.length,
            baseline: input.baseline,
            responseMetadataJson: input.run.responseMetadataJson!,
            audits: input.audits,
          });
          if (this.estimateLogicalBytesInternal() + coalesceWriteSet > this.maxDbBytes) {
            throw new TxnAbortError('db-budget-exceeded');
          }
          // CAS 复验 Event 存在、first_observed_at 与 item_count 等于期望值
          const updatedEvent = this.handle
            .prepare(SQL_UPDATE_EVENT_COALESCE)
            .run(
              input.coalesce.eventKind,
              input.coalesce.lastObservedAt,
              input.coalesce.newItemCount,
              input.coalesce.eventId,
              input.coalesce.expectedFirstObservedAt,
              input.coalesce.expectedItemCount,
            );
          if (Number(updatedEvent.changes) === 0) {
            const exists = this.handle.prepare(SQL_SELECT_EVENT).get(input.coalesce.eventId);
            if (exists === undefined) throw new TxnAbortError('event-conflict');
            throw new TxnAbortError('event-conflict');
          }
          if (input.baseline !== undefined) {
            const b = this.applyBaselineInternal({
              ruleId: input.rule.id,
              expectedBaselineVersion: input.identity.expectedBaselineVersion,
              projectionType: input.baseline.projectionType,
              projectionJson: input.baseline.projectionJson,
              contentHash: input.baseline.contentHash,
              byteLength: input.baseline.byteLength,
              finalUrl: input.baseline.finalUrl,
              capturedAt: input.baseline.capturedAt,
              documentId: input.baseline.documentId,
              validators: input.baseline.validators,
            });
            if (!b.ok) throw new TxnAbortError(b.code);
          }
          // 新增 observation：sequence = MAX(existing)+1，first_item_sequence = 原 item_count
          const obsSeq = this.nextObservationSequence(input.coalesce.eventId);
          this.handle
            .prepare(SQL_INSERT_OBSERVATION)
            .run(
              input.coalesce.observationId,
              input.coalesce.eventId,
              obsSeq,
              input.coalesce.idempotencyKey,
              input.coalesce.changeFingerprint,
              input.coalesce.eventKind,
              input.coalesce.lastObservedAt,
              input.coalesce.expectedItemCount,
              input.coalesce.items.length,
            );
          this.appendDigestChangeJournal(
            input.coalesce.observationId,
            input.coalesce.eventId,
            input.rule.sourceId,
            input.coalesce.lastObservedAt,
          );
          const eventSeqBase = input.coalesce.expectedItemCount;
          for (let i = 0; i < input.coalesce.items.length; i += 1) {
            const item = input.coalesce.items[i]!;
            this.handle
              .prepare(SQL_INSERT_EVENT_ITEM)
              .run(
                `${input.coalesce.eventId}-${eventSeqBase + i}`,
                input.coalesce.eventId,
                eventSeqBase + i,
                input.coalesce.observationId,
                i,
                item.itemId,
                item.fieldKey,
                item.label,
                JSON.stringify(item.before),
                JSON.stringify(item.after),
                item.beforeCapturedAt,
                item.afterCapturedAt,
                item.beforeFinalUrl,
                item.afterFinalUrl,
                item.beforeDocumentId,
                item.afterDocumentId,
                item.feedItemKey,
              );
          }
        } else if (input.path === 'changed-unmatched') {
          if (input.baseline !== undefined) {
            const b = this.applyBaselineInternal({
              ruleId: input.rule.id,
              expectedBaselineVersion: input.identity.expectedBaselineVersion,
              projectionType: input.baseline.projectionType,
              projectionJson: input.baseline.projectionJson,
              contentHash: input.baseline.contentHash,
              byteLength: input.baseline.byteLength,
              finalUrl: input.baseline.finalUrl,
              capturedAt: input.baseline.capturedAt,
              documentId: input.baseline.documentId,
              validators: input.baseline.validators,
            });
            if (!b.ok) throw new TxnAbortError(b.code);
          }
        } else if (input.path === 'unchanged') {
          // 同 hash 200/304：Baseline version/content 不变，只更新 validator（#S6-056）
          if (input.validatorUpdate !== undefined) {
            const v = this.handle
              .prepare(SQL_UPDATE_BASELINE_VALIDATORS)
              .run(
                input.validatorUpdate.etag,
                input.validatorUpdate.lastModified,
                input.rule.id,
                input.identity.expectedBaselineVersion,
              );
            if (Number(v.changes) === 0) {
              const exists = this.handle.prepare(SQL_SELECT_BASELINE).get(input.rule.id);
              if (exists === undefined) throw new TxnAbortError('baseline-conflict');
              throw new TxnAbortError('baseline-conflict');
            }
          }
        }

        // 5. Run 终态 + audits + rowVersion 单调更新（metadata 随同一 CAS UPDATE 写入）
        const runResult = this.transitionRun(input.runId, input.run.expectedStatus, {
          status: 'finished',
          finishedAt: nowIso,
          outcome: input.run.outcome,
          health: input.run.health,
          responseMetadataJson: input.run.responseMetadataJson,
        });
        if (!runResult.ok) throw new TxnAbortError(runResult.code);
        this.writeAuditsInternal(input.audits, input.rule.id, nowIso);
        const rowRes = this.updateRuleResultRowVersion({
          ruleId: input.rule.id,
          sourceAfterRevalidationRowVersion: input.sourceAfterRevalidationRowVersion,
          expectedSourceId: input.identity.sourceId,
          expectedSourceLocatorFingerprint: input.identity.sourceLocatorFingerprint,
          nowIso,
        });
        if (!rowRes.ok) throw new TxnAbortError(rowRes.code);
        return { ok: true };
      });
    } catch (err) {
      if (err instanceof TxnAbortError) return { ok: false, code: err.code };
      logWarn('watch', 'D7 结果事务异常（已整体回滚）', err);
      return { ok: false, code: this.translate(err).code };
    }
  }

  private nextObservationSequence(eventId: string): number {
    const row = this.handle
      .prepare(
        'SELECT COALESCE(MAX(sequence), -1) AS m FROM watch_event_observations WHERE event_id = ?',
      )
      .get(eventId) as { m: number };
    return Number(row.m) + 1;
  }

  private writeAuditsInternal(
    audits: Array<{ id: string; reasonCode: WatchAuditReasonCode; createdAt: string }>,
    ruleId: string,
    nowIso: string,
  ): void {
    for (const audit of audits) {
      if (!isIn('run', AUDIT_KINDS) || !isIn(audit.reasonCode, AUDIT_REASON_CODES)) {
        throw new TxnAbortError('validation-failed');
      }
      this.handle
        .prepare(SQL_INSERT_AUDIT)
        .run(audit.id, ruleId, 'run', audit.reasonCode, audit.createdAt ?? nowIso);
    }
  }

  // 条件 validator 提交值（#S6-056）：与 Baseline version/contentHash 同身份同事务
  getBaselineValidators(
    ruleId: string,
  ): { etag: string | null; lastModified: string | null } | null {
    const b = this.getBaseline(ruleId);
    if (b === null) return null;
    return { etag: b.conditionalEtag, lastModified: b.conditionalLastModified };
  }

  // -------------------------------------------------------------------------
  // D8 Digest schedules / frozen cycles / artifacts / provider claims
  // -------------------------------------------------------------------------

  createDigestSchedule(input: {
    id: string;
    sourceIds: readonly string[];
    localTime: string;
    timeZone: string;
    aiEnabled?: boolean;
    nextDueAt: string;
    nowIso: string;
  }): WatchResult {
    this.ensureOpen();
    const sourceIds = [...input.sourceIds].sort((a, b) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    );
    const schedule = {
      kind: 'daily' as const,
      localTime: input.localTime,
      timeZone: input.timeZone,
    };
    if (
      input.id === '' ||
      sourceIds.length < 1 ||
      sourceIds.length > 100 ||
      sourceIds.some((id, index) => id === '' || (index > 0 && sourceIds[index - 1] === id)) ||
      !validateWatchSchedule(schedule).ok ||
      !Number.isFinite(Date.parse(input.nextDueAt)) ||
      !Number.isFinite(Date.parse(input.nowIso))
    )
      return { ok: false, code: 'validation-failed' };
    try {
      return withTransaction(this.handle, () => {
        const highWater = this.handle.prepare(SQL_SELECT_DIGEST_CHANGE_STATE).get() as
          { id: number; last_sequence: number } | undefined;
        if (highWater?.id !== 1 || !Number.isSafeInteger(highWater.last_sequence))
          throw new TxnAbortError('store-unavailable');
        this.handle
          .prepare(SQL_INSERT_DIGEST_SCHEDULE)
          .run(
            input.id,
            JSON.stringify(sourceIds),
            JSON.stringify(schedule),
            input.aiEnabled === true ? 1 : 0,
            highWater.last_sequence,
            input.nextDueAt,
            input.nowIso,
            input.nowIso,
          );
        return { ok: true };
      });
    } catch (err) {
      return { ok: false, code: this.translate(err).code };
    }
  }

  getDigestSchedule(id: string): StoredDigestSchedule | null {
    this.ensureOpen();
    const row = this.handle.prepare(SQL_SELECT_DIGEST_SCHEDULE).get(id) as unknown;
    if (!isPlainRecord(row) || !validateDigestScheduleRow(row)) return null;
    const sourceIds = this.parseJson(row['source_ids_json']) as string[];
    const schedule = this.parseJson(row['schedule_json']) as {
      localTime: string;
      timeZone: string;
    };
    return {
      id: row['id'] as string,
      version: row['version'] as number,
      sourceIds: [...sourceIds],
      localTime: schedule.localTime,
      timeZone: schedule.timeZone,
      aiEnabled: row['ai_enabled'] === 1,
      cursorSequence: row['cursor_sequence'] as number,
      state: row['state'] as 'active' | 'paused',
      nextDueAt: row['next_due_at'] as string,
      lastConsumedScheduledFor: row['last_consumed_scheduled_for'] as string | null,
      lastDailyLocalDate: row['last_daily_local_date'] as string | null,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
      lastCheckedAt: row['last_checked_at'] as string | null,
      lastPeriod:
        row['last_period_json'] === null
          ? null
          : (this.parseJson(row['last_period_json']) as StoredDigestSchedule['lastPeriod']),
      lastRunStats:
        row['last_run_stats_json'] === null
          ? null
          : (this.parseJson(row['last_run_stats_json']) as StoredDigestSchedule['lastRunStats']),
    };
  }

  listActiveDigestSchedules(): StoredDigestSchedule[] {
    this.ensureOpen();
    const rows = this.handle.prepare(SQL_SELECT_ACTIVE_DIGEST_SCHEDULES).all() as Array<{
      id: string;
    }>;
    return rows
      .map((row) => this.getDigestSchedule(row.id))
      .filter((row): row is StoredDigestSchedule => row !== null);
  }

  pauseDigestSchedule(id: string, expectedVersion: number, nowIso: string): WatchResult {
    this.ensureOpen();
    const current = this.getDigestSchedule(id);
    if (current === null || current.version !== expectedVersion)
      return { ok: false, code: 'rule-state-conflict' };
    if (current.state === 'paused') return { ok: true };
    const changed = this.handle
      .prepare(SQL_UPDATE_DIGEST_SCHEDULE_STATE)
      .run('paused', nowIso, id, expectedVersion, 'active');
    return Number(changed.changes) === 1
      ? { ok: true }
      : { ok: false, code: 'rule-state-conflict' };
  }

  resumeDigestSchedule(id: string, expectedVersion: number, nowIso: string): WatchResult {
    this.ensureOpen();
    const current = this.getDigestSchedule(id);
    if (current === null || current.version !== expectedVersion)
      return { ok: false, code: 'rule-state-conflict' };
    if (current.state === 'active') return { ok: true };
    const changed = this.handle
      .prepare(SQL_UPDATE_DIGEST_SCHEDULE_STATE)
      .run('active', nowIso, id, expectedVersion, 'paused');
    return Number(changed.changes) === 1
      ? { ok: true }
      : { ok: false, code: 'rule-state-conflict' };
  }

  deleteDigestSchedule(id: string, expectedVersion: number): WatchResult {
    this.ensureOpen();
    const changed = this.handle.prepare(SQL_DELETE_DIGEST_SCHEDULE).run(id, expectedVersion);
    return Number(changed.changes) === 1
      ? { ok: true }
      : { ok: false, code: 'rule-state-conflict' };
  }

  setDigestScheduleAiEnabled(
    id: string,
    expectedVersion: number,
    enabled: boolean,
    nowIso: string,
  ): WatchResult {
    this.ensureOpen();
    const current = this.getDigestSchedule(id);
    if (current === null || current.version !== expectedVersion)
      return { ok: false, code: 'rule-state-conflict' };
    if (current.aiEnabled === enabled) return { ok: true };
    try {
      return withTransaction(this.handle, () => {
        const changed = this.handle
          .prepare(SQL_UPDATE_DIGEST_AI)
          .run(enabled ? 1 : 0, nowIso, id, expectedVersion, current.aiEnabled ? 1 : 0);
        if (Number(changed.changes) !== 1) throw new TxnAbortError('rule-state-conflict');
        if (!enabled) this.handle.prepare(SQL_DISABLE_PENDING_DIGESTS).run(nowIso, nowIso, id);
        return { ok: true };
      });
    } catch (err) {
      return {
        ok: false,
        code: err instanceof TxnAbortError ? err.code : this.translate(err).code,
      };
    }
  }

  resetDigestSchedule(input: {
    id: string;
    expectedVersion: number;
    sourceIds: readonly string[];
    localTime: string;
    timeZone: string;
    nextDueAt: string;
    nowIso: string;
  }): WatchResult {
    this.ensureOpen();
    const sourceIds = [...input.sourceIds].sort((a, b) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    );
    const schedule = {
      kind: 'daily' as const,
      localTime: input.localTime,
      timeZone: input.timeZone,
    };
    if (
      sourceIds.length < 1 ||
      sourceIds.length > 100 ||
      sourceIds.some((id, index) => id === '' || (index > 0 && sourceIds[index - 1] === id)) ||
      !validateWatchSchedule(schedule).ok ||
      !Number.isFinite(Date.parse(input.nextDueAt))
    )
      return { ok: false, code: 'validation-failed' };
    try {
      return withTransaction(this.handle, () => {
        if (this.handle.prepare(SQL_SELECT_NONTERMINAL_DIGEST_RUN).get(input.id) !== undefined)
          throw new TxnAbortError('rule-already-running');
        const highWater = this.handle.prepare(SQL_SELECT_DIGEST_CHANGE_STATE).get() as {
          last_sequence: number;
        };
        const changed = this.handle
          .prepare(SQL_RESET_DIGEST_SCHEDULE)
          .run(
            JSON.stringify(sourceIds),
            JSON.stringify(schedule),
            highWater.last_sequence,
            input.nextDueAt,
            input.nowIso,
            input.id,
            input.expectedVersion,
          );
        if (Number(changed.changes) !== 1) throw new TxnAbortError('rule-state-conflict');
        return { ok: true };
      });
    } catch (err) {
      return {
        ok: false,
        code: err instanceof TxnAbortError ? err.code : this.translate(err).code,
      };
    }
  }

  getNonterminalDigestRun(scheduleId: string): StoredDigestRun | null {
    this.ensureOpen();
    const row = this.handle.prepare(SQL_SELECT_NONTERMINAL_DIGEST_RUN).get(scheduleId) as unknown;
    if (!isPlainRecord(row) || !validateDigestRunRow(row)) return null;
    return {
      id: row['id'] as string,
      scheduleId: row['schedule_id'] as string,
      requestKey: row['request_key'] as string,
      logicalDate: row['logical_date'] as string,
      lowerSequence: row['lower_sequence'] as number,
      upperSequence: row['upper_sequence'] as number,
      nextSequence: row['next_sequence'] as number,
      period: this.parseJson(row['period_json']) as StoredDigestRun['period'],
      runStats: this.parseJson(row['run_stats_json']) as StoredDigestRun['runStats'],
      state: row['state'] as StoredDigestRun['state'],
    };
  }

  getDigestRun(id: string): StoredDigestRun | null {
    this.ensureOpen();
    const row = this.handle.prepare(SQL_SELECT_DIGEST_RUN_BY_ID).get(id) as unknown;
    if (!isPlainRecord(row) || !validateDigestRunRow(row)) return null;
    return {
      id: row['id'] as string,
      scheduleId: row['schedule_id'] as string,
      requestKey: row['request_key'] as string,
      logicalDate: row['logical_date'] as string,
      lowerSequence: row['lower_sequence'] as number,
      upperSequence: row['upper_sequence'] as number,
      nextSequence: row['next_sequence'] as number,
      period: this.parseJson(row['period_json']) as StoredDigestRun['period'],
      runStats: this.parseJson(row['run_stats_json']) as StoredDigestRun['runStats'],
      state: row['state'] as StoredDigestRun['state'],
    };
  }

  remainingDbBudget(): number {
    this.ensureOpen();
    return Math.max(0, this.maxDbBytes - this.estimateLogicalBytesInternal());
  }

  markDigestRunBudgetExceeded(
    runId: string,
    requiredBytes: number,
    availableBytes: number,
    nowIso: string,
  ): WatchResult {
    this.ensureOpen();
    if (
      !Number.isSafeInteger(requiredBytes) ||
      !Number.isSafeInteger(availableBytes) ||
      requiredBytes <= availableBytes ||
      availableBytes < 0
    )
      return { ok: false, code: 'validation-failed' };
    const changed = this.handle
      .prepare(SQL_BLOCK_DIGEST_RUN)
      .run(nowIso, requiredBytes, availableBytes, runId);
    return Number(changed.changes) === 1 ? { ok: true } : { ok: false, code: 'run-state-conflict' };
  }

  retryDigestRunBudget(runId: string): WatchResult {
    this.ensureOpen();
    const changed = this.handle.prepare(SQL_RETRY_DIGEST_RUN).run(runId, this.remainingDbBudget());
    return Number(changed.changes) === 1 ? { ok: true } : { ok: false, code: 'run-state-conflict' };
  }

  reserveDigestRun(input: {
    scheduleId: string;
    expectedVersion: number;
    expectedNextDueAt: string;
    expectedLastConsumedScheduledFor: string | null;
    expectedLastDailyLocalDate: string | null;
    runId: string;
    requestKey: string;
    logicalDate: string;
    nextDueAt: string;
    nowIso: string;
  }): { ok: true; run: StoredDigestRun } | { ok: false; code: WatchErrorCode } {
    this.ensureOpen();
    const schedule = this.getDigestSchedule(input.scheduleId);
    if (
      schedule === null ||
      schedule.version !== input.expectedVersion ||
      schedule.state !== 'active'
    )
      return { ok: false, code: 'run-state-conflict' };
    const period = {
      fromExclusive: schedule.lastCheckedAt ?? schedule.createdAt,
      toInclusive: input.nowIso,
    };
    if (!Number.isFinite(Date.parse(input.nowIso)) || period.fromExclusive >= period.toInclusive)
      return { ok: false, code: 'validation-failed' };
    const sourceIds = new Set(schedule.sourceIds);
    const runStats = { changed: 0, failed: 0, unchanged: 0 };
    const rows = this.handle
      .prepare(SQL_SELECT_FINISHED_RUNS_FOR_DIGEST_STATS)
      .all(period.fromExclusive, period.toInclusive) as Array<{
      source_id: string;
      status: string;
      outcome_json: string | null;
    }>;
    for (const row of rows) {
      if (!sourceIds.has(row.source_id)) continue;
      if (row.status === 'interrupted') {
        runStats.failed += 1;
        continue;
      }
      if (row.outcome_json === null) return { ok: false, code: 'store-unavailable' };
      const outcome = validateWatchRunOutcome(this.parseJson(row.outcome_json));
      if (outcome === null) return { ok: false, code: 'store-unavailable' };
      if (
        outcome.kind === 'changed-unmatched' ||
        outcome.kind === 'event-created' ||
        outcome.kind === 'event-coalesced'
      )
        runStats.changed += 1;
      else if (
        outcome.kind === 'unchanged' ||
        outcome.kind === 'baseline-established' ||
        outcome.kind === 'event-deduplicated'
      )
        runStats.unchanged += 1;
      else runStats.failed += 1;
    }
    try {
      return withTransaction(this.handle, () => {
        if (
          this.handle.prepare(SQL_SELECT_NONTERMINAL_DIGEST_RUN).get(input.scheduleId) !== undefined
        )
          throw new TxnAbortError('rule-already-running');
        const highWater = this.handle.prepare(SQL_SELECT_DIGEST_CHANGE_STATE).get() as {
          last_sequence: number;
        };
        const lower = schedule.cursorSequence;
        const upper = Number(highWater.last_sequence);
        const changed = this.handle
          .prepare(SQL_RESERVE_DIGEST_SCHEDULE)
          .run(
            input.nextDueAt,
            input.expectedNextDueAt,
            input.logicalDate,
            input.nowIso,
            input.scheduleId,
            input.expectedVersion,
            input.expectedNextDueAt,
            input.expectedLastConsumedScheduledFor,
            input.expectedLastDailyLocalDate,
          );
        if (Number(changed.changes) !== 1) throw new TxnAbortError('run-state-conflict');
        this.handle
          .prepare(SQL_INSERT_DIGEST_RUN)
          .run(
            input.runId,
            input.scheduleId,
            input.requestKey,
            input.logicalDate,
            lower,
            upper,
            lower,
            JSON.stringify(period),
            JSON.stringify(runStats),
            input.nowIso,
          );
        return {
          ok: true,
          run: {
            id: input.runId,
            scheduleId: input.scheduleId,
            requestKey: input.requestKey,
            logicalDate: input.logicalDate,
            lowerSequence: lower,
            upperSequence: upper,
            nextSequence: lower,
            period,
            runStats,
            state: 'running',
          },
        };
      });
    } catch (err) {
      return { ok: false, code: this.translate(err).code };
    }
  }

  readDigestJournalSlice(runId: string): DigestJournalSlice[] | null {
    this.ensureOpen();
    const runRow = this.handle.prepare(SQL_SELECT_DIGEST_RUN_BY_ID).get(runId) as unknown;
    if (!isPlainRecord(runRow) || !validateDigestRunRow(runRow)) return null;
    const schedule = this.getDigestSchedule(String(runRow['schedule_id']));
    if (schedule === null) return null;
    return this.readDigestJournalRange(
      schedule.sourceIds,
      Number(runRow['next_sequence']),
      Number(runRow['upper_sequence']),
    );
  }

  readDigestPreviewSlice(input: {
    sourceIds: readonly string[];
    afterSequence: number;
    fromExclusive: string;
    toInclusive: string;
  }): { upperSequence: number; rows: DigestJournalSlice[] } | null {
    this.ensureOpen();
    if (
      !Number.isSafeInteger(input.afterSequence) ||
      input.afterSequence < 0 ||
      !Number.isFinite(Date.parse(input.fromExclusive)) ||
      !Number.isFinite(Date.parse(input.toInclusive)) ||
      input.fromExclusive >= input.toInclusive
    )
      return null;
    const state = this.handle.prepare(SQL_SELECT_DIGEST_CHANGE_STATE).get() as {
      last_sequence: number;
    };
    const rows = this.readDigestJournalRange(
      input.sourceIds,
      input.afterSequence,
      state.last_sequence,
      input.fromExclusive,
      input.toInclusive,
    );
    return rows === null ? null : { upperSequence: state.last_sequence, rows };
  }

  private readDigestJournalRange(
    sourceIds: readonly string[],
    afterSequence: number,
    upperSequence: number,
    fromExclusive?: string,
    toInclusive?: string,
  ): DigestJournalSlice[] | null {
    const allowed = new Set(sourceIds);
    const rows = this.handle
      .prepare(SQL_SELECT_DIGEST_OBSERVATIONS)
      .all(afterSequence, upperSequence) as Array<Record<string, unknown>>;
    const output: DigestJournalSlice[] = [];
    for (const row of rows) {
      const sequence = Number(row['sequence']);
      const inPeriod =
        fromExclusive === undefined ||
        toInclusive === undefined ||
        (String(row['observed_at']) > fromExclusive && String(row['observed_at']) <= toInclusive);
      if (!allowed.has(String(row['source_id'])) || !inPeriod) {
        output.push({ sequence, status: 'skipped', observation: null });
        continue;
      }
      if (row['status'] !== 'active') {
        output.push({
          sequence,
          status: row['status'] === 'user-deleted' ? 'user-deleted' : 'expired',
          observation: null,
        });
        continue;
      }
      if (typeof row['rule_id'] !== 'string' || typeof row['event_kind'] !== 'string') return null;
      const itemRows = this.handle
        .prepare(SQL_SELECT_ITEMS_BY_OBSERVATION)
        .all(row['observation_id']) as Array<Record<string, unknown>>;
      const items: ChangeEvidencePair[] = [];
      for (const item of itemRows) {
        const pair = validateChangeEvidencePair({
          itemId: item['item_id'],
          fieldKey: item['field_key'],
          label: item['label'],
          before: this.parseJson(item['before_value_json']),
          after: this.parseJson(item['after_value_json']),
          beforeCapturedAt: item['before_captured_at'],
          afterCapturedAt: item['after_captured_at'],
          beforeFinalUrl: item['before_final_url'],
          afterFinalUrl: item['after_final_url'],
          beforeDocumentId: item['before_document_id'],
          afterDocumentId: item['after_document_id'],
          feedItemKey: item['feed_item_key'],
        });
        if (pair === null) return null;
        items.push(pair);
      }
      output.push({
        sequence,
        status: 'active',
        observation: {
          sequence,
          eventId: String(row['event_id']),
          ruleId: row['rule_id'],
          sourceId: String(row['source_id']),
          eventKind: row['event_kind'] as WatchEventKind,
          importance: row['importance'] as DigestObservationSlice['importance'],
          observedAt: String(row['observed_at']),
          items,
        },
      });
    }
    return output;
  }

  commitDigestBatch(input: {
    artifactId: string;
    run: StoredDigestRun;
    expectedNextSequence: number;
    firstSequence: number;
    lastSequence: number;
    facts: DigestFacts;
    createdAt: string;
    aiEnabled: boolean;
  }): WatchResult {
    this.ensureOpen();
    const canonical = canonicalizeDigestFacts(input.facts);
    if (
      !canonical.ok ||
      input.firstSequence <= input.expectedNextSequence ||
      input.lastSequence > input.run.upperSequence
    )
      return { ok: false, code: 'validation-failed' };
    const providerState = input.aiEnabled ? 'pending' : 'disabled';
    const providerCode = input.aiEnabled ? null : 'disabled';
    const providerFinishedAt = input.aiEnabled ? null : input.createdAt;
    try {
      return withTransaction(this.handle, () => {
        if (this.estimateLogicalBytesInternal() + canonical.byteLength > this.maxDbBytes)
          throw new TxnAbortError('db-budget-exceeded');
        const batch = this.handle.prepare(SQL_SELECT_NEXT_DIGEST_BATCH_INDEX).get(input.run.id) as {
          n: number;
        };
        this.handle
          .prepare(SQL_INSERT_DIGEST)
          .run(
            input.artifactId,
            input.run.scheduleId,
            input.run.id,
            batch.n,
            input.firstSequence,
            input.lastSequence,
            canonical.json,
            canonical.hash,
            canonical.byteLength,
            providerState,
            providerCode,
            providerFinishedAt,
            input.createdAt,
          );
        for (const event of input.facts.events)
          this.handle.prepare(SQL_INSERT_DIGEST_REF).run(input.artifactId, event.eventId, 'active');
        const runChanged = this.handle
          .prepare(SQL_UPDATE_DIGEST_RUN_CURSOR)
          .run(
            input.lastSequence,
            input.run.id,
            input.run.scheduleId,
            input.expectedNextSequence,
            input.lastSequence,
          );
        const scheduleChanged = this.handle
          .prepare(SQL_UPDATE_DIGEST_SCHEDULE_CURSOR)
          .run(
            input.lastSequence,
            input.createdAt,
            input.run.scheduleId,
            input.expectedNextSequence,
          );
        if (Number(runChanged.changes) !== 1 || Number(scheduleChanged.changes) !== 1)
          throw new TxnAbortError('run-state-conflict');
        return { ok: true };
      });
    } catch (err) {
      return {
        ok: false,
        code: err instanceof TxnAbortError ? err.code : this.translate(err).code,
      };
    }
  }

  completeDigestRun(run: StoredDigestRun, nowIso: string): WatchResult {
    this.ensureOpen();
    try {
      return withTransaction(this.handle, () => {
        const changed = this.handle
          .prepare(SQL_COMPLETE_DIGEST_RUN)
          .run(nowIso, run.id, run.scheduleId, run.nextSequence);
        const schedule = this.handle
          .prepare(SQL_COMPLETE_DIGEST_SCHEDULE)
          .run(
            run.upperSequence,
            run.period.toInclusive,
            JSON.stringify(run.period),
            JSON.stringify(run.runStats),
            nowIso,
            run.scheduleId,
            run.nextSequence,
          );
        if (Number(changed.changes) !== 1 || Number(schedule.changes) !== 1)
          throw new TxnAbortError('run-state-conflict');
        return { ok: true };
      });
    } catch (err) {
      return { ok: false, code: this.translate(err).code };
    }
  }

  getDigestArtifact(id: string): StoredDigestArtifact | null {
    this.ensureOpen();
    const row = this.handle.prepare(SQL_SELECT_DIGEST).get(id) as unknown;
    if (!isPlainRecord(row) || !validateDigestArtifactRow(row)) return null;
    return {
      id: row['id'] as string,
      scheduleId: row['schedule_id'] as string,
      runId: row['run_id'] as string,
      batchIndex: row['batch_index'] as number,
      facts: this.parseJson(row['facts_json']) as DigestFacts,
      factsJson: row['facts_json'] as string,
      factsHash: row['facts_hash'] as string,
      factsRevision: row['facts_revision'] as number,
      providerState: row['provider_state'] as string,
      providerResultCode: row['provider_result_code'] as string | null,
      explanationJson: row['explanation_json'] as string | null,
    };
  }

  listDigestArtifactsBySchedule(scheduleId: string): StoredDigestArtifact[] {
    this.ensureOpen();
    return (
      this.handle.prepare(SQL_SELECT_DIGEST_IDS_BY_SCHEDULE).all(scheduleId) as Array<{
        id: string;
      }>
    )
      .map((row) => this.getDigestArtifact(row.id))
      .filter((row): row is StoredDigestArtifact => row !== null);
  }

  listPendingDigestArtifacts(runId: string): StoredDigestArtifact[] {
    this.ensureOpen();
    return (
      this.handle.prepare(SQL_SELECT_PENDING_DIGEST_IDS_BY_RUN).all(runId) as Array<{ id: string }>
    )
      .map((row) => this.getDigestArtifact(row.id))
      .filter((row): row is StoredDigestArtifact => row !== null);
  }

  nextDigestBatchIndex(runId: string): number {
    this.ensureOpen();
    const row = this.handle.prepare(SQL_SELECT_NEXT_DIGEST_BATCH_INDEX).get(runId) as { n: number };
    return Number(row.n);
  }

  claimDigestProvider(id: string, nowIso: string): StoredDigestArtifact | null {
    this.ensureOpen();
    try {
      return withTransaction(this.handle, () => {
        const changed = this.handle.prepare(SQL_CLAIM_DIGEST).run(nowIso, id);
        if (Number(changed.changes) !== 1) return null;
        return this.getDigestArtifact(id);
      });
    } catch {
      return null;
    }
  }

  finishPendingDigest(
    id: string,
    state: 'disabled' | 'skipped',
    code: 'disabled' | 'no-visible-events' | 'request-budget' | 'key-unavailable',
    nowIso: string,
  ): WatchResult {
    this.ensureOpen();
    const changed = this.handle.prepare(SQL_FINISH_DIGEST_PENDING).run(state, code, nowIso, id);
    return Number(changed.changes) === 1 ? { ok: true } : { ok: false, code: 'run-state-conflict' };
  }

  finishClaimedDigest(input: {
    id: string;
    factsRevision: number;
    factsHash: string;
    state: 'succeeded' | 'failed';
    code: DigestProviderResultCode;
    explanationJson: string | null;
    nowIso: string;
  }): WatchResult {
    this.ensureOpen();
    if (input.state === 'succeeded') {
      const artifact = this.getDigestArtifact(input.id);
      const visible = artifact?.facts.events.map((event) => event.eventId) ?? [];
      if (
        input.code !== 'success' ||
        input.explanationJson === null ||
        parseDigestExplanation(input.explanationJson, visible) === null
      )
        return { ok: false, code: 'validation-failed' };
    } else if (
      !isIn(input.code, ['provider-error', 'timeout', 'aborted', 'invalid-output'] as const) ||
      input.explanationJson !== null
    ) {
      return { ok: false, code: 'validation-failed' };
    }
    const artifact = this.getDigestArtifact(input.id);
    if (artifact === null) return { ok: false, code: 'run-not-found' };
    const bytes =
      utf8ByteLength(artifact.factsJson) +
      (input.explanationJson === null ? 0 : utf8ByteLength(input.explanationJson));
    const changed = this.handle
      .prepare(SQL_FINISH_DIGEST_CLAIM)
      .run(
        input.state,
        input.code,
        input.explanationJson,
        bytes,
        input.nowIso,
        input.id,
        input.factsRevision,
        input.factsHash,
        input.factsRevision,
        input.factsHash,
      );
    return Number(changed.changes) === 1 ? { ok: true } : { ok: false, code: 'run-state-conflict' };
  }

  recoverClaimedDigests(nowIso: string): number {
    this.ensureOpen();
    return Number(this.handle.prepare(SQL_RECOVER_CLAIMED_DIGESTS).run(nowIso, nowIso).changes);
  }

  pruneDigestJournalTombstones(): number {
    this.ensureOpen();
    const row = this.handle.prepare(SQL_DIGEST_SAFE_WATERMARK).get() as { sequence: number };
    return Number(this.handle.prepare(SQL_PRUNE_DIGEST_TOMBSTONES).run(row.sequence).changes);
  }

  // -------------------------------------------------------------------------
  // Retention（§10.4）
  // -------------------------------------------------------------------------

  // 启动完整性/JSON 形状/预算扫描（§10.2 步骤 4）：全部行经共享 validator
  // 二次校验（含 EvidenceValue/Pair、outcome/health、intent 投影与 affected
  // map）；单 Event 双侧 Evidence 合计预算复核；digest/schedule/outbox JSON
  // 可解析性。任一非法 → fail-closed（Store unavailable，原库保留）。
  scanIntegrity(): { ok: boolean; reason: string | null } {
    this.ensureOpen();
    try {
      for (const row of this.handle.prepare(SQL_SELECT_ALL_RULES).all() as unknown[]) {
        if (!validateRuleRow(row).ok) return { ok: false, reason: '规则行读回校验失败' };
      }
      for (const row of this.handle.prepare(SQL_SELECT_ALL_BASELINES).all() as unknown[]) {
        if (!isPlainRecord(row)) return { ok: false, reason: 'Baseline 行形状非法' };
        const normalized = {
          ruleId: row['rule_id'],
          version: row['version'],
          projectionType: row['projection_type'],
          projectionJson: row['projection_json'],
          contentHash: row['content_hash'],
          byteLength: row['byte_length'],
          finalUrl: row['final_url'],
          capturedAt: row['captured_at'],
          documentId: row['document_id'],
          conditionalEtag: row['conditional_etag'],
          conditionalLastModified: row['conditional_last_modified'],
        };
        if (!validateBaselineRow(normalized).ok)
          return { ok: false, reason: 'Baseline 行读回校验失败' };
        // R6：启动读回扫描必须检测「实际字节 / 声明字节 / 上限」三者不一致并 fail-closed
        if (typeof normalized.projectionJson !== 'string') {
          return { ok: false, reason: 'Baseline projection_json 非法' };
        }
        const actualBytes = utf8ByteLength(normalized.projectionJson);
        if (normalized.byteLength !== actualBytes || actualBytes > this.maxBaselineBytes) {
          return { ok: false, reason: 'Baseline 声明字节与实际字节不一致或超上限' };
        }
        // D7 #S6-058：#S6-054 持久化 validator——canonical JSON 必须逐字节等于固定键序
        // 重新编码，contentHash 必须是该字节串的 SHA-256。legacy（非 64-hex 假 hash）
        // 数据保持字节/上限校验兼容；合法 64-hex 一律精确验证（防陈旧/篡改/键重排）。
        if (
          typeof normalized.contentHash === 'string' &&
          /^[0-9a-f]{64}$/.test(normalized.contentHash)
        ) {
          const parsed = this.parseJson(normalized.projectionJson);
          if (parsed === null) return { ok: false, reason: 'Baseline projection_json 非法' };
          const reencoded = JSON.stringify(parsed);
          if (reencoded !== normalized.projectionJson) {
            return { ok: false, reason: 'Baseline canonical JSON 非固定键序编码' };
          }
          if (sha256Hex(reencoded) !== normalized.contentHash) {
            return { ok: false, reason: 'Baseline contentHash 与 canonical 字节不一致' };
          }
        }
      }
      for (const row of this.handle.prepare(SQL_SELECT_ALL_RUNS).all() as unknown[]) {
        if (!isPlainRecord(row)) return { ok: false, reason: 'Run 行形状非法' };
        const normalized = {
          id: row['id'],
          ruleId: row['rule_id'],
          requestKey: row['request_key'],
          status: row['status'],
          trigger: row['trigger'],
          scheduledFor: row['scheduled_for'],
          startedAt: row['started_at'],
          finishedAt: row['finished_at'],
          outcome: row['outcome_json'] === null ? null : this.parseJson(row['outcome_json']),
          health: row['health_json'] === null ? null : this.parseJson(row['health_json']),
          responseMetadataJson: row['response_metadata_json'],
        };
        if (!validateRunRow(normalized).ok) return { ok: false, reason: 'Run 行读回校验失败' };
      }
      const eventRows = this.handle.prepare(SQL_SELECT_ALL_EVENTS).all() as unknown[];
      const itemRows = this.handle.prepare(SQL_SELECT_ALL_EVENT_ITEMS).all() as unknown[];
      const itemBytesByEvent = new Map<string, number>();
      for (const row of eventRows) {
        if (!validateEventRow(row).ok) return { ok: false, reason: 'Event 行读回校验失败' };
      }
      for (const row of itemRows) {
        if (!isPlainRecord(row)) return { ok: false, reason: 'Event item 行形状非法' };
        const eventId = row['event_id'];
        if (typeof eventId !== 'string') return { ok: false, reason: 'Event item 行形状非法' };
        const before = this.parseJson(row['before_value_json']);
        const after = this.parseJson(row['after_value_json']);
        const pair = {
          itemId: row['item_id'],
          fieldKey: row['field_key'],
          label: row['label'],
          before,
          after,
          beforeCapturedAt: row['before_captured_at'],
          afterCapturedAt: row['after_captured_at'],
          beforeFinalUrl: row['before_final_url'],
          afterFinalUrl: row['after_final_url'],
          beforeDocumentId: row['before_document_id'],
          afterDocumentId: row['after_document_id'],
          feedItemKey: row['feed_item_key'],
        };
        if (validateChangeEvidencePair(pair) === null) {
          return { ok: false, reason: 'Event item 读回校验失败' };
        }
        const bytes =
          utf8ByteLength(String(row['before_value_json'])) +
          utf8ByteLength(String(row['after_value_json']));
        itemBytesByEvent.set(eventId, (itemBytesByEvent.get(eventId) ?? 0) + bytes);
      }
      for (const [eventId, bytes] of itemBytesByEvent) {
        if (bytes > this.maxEventEvidenceBytes) {
          return { ok: false, reason: `Event ${eventId} 双侧 Evidence 超过预算` };
        }
      }
      // D7 #S6-055：schema v3 观察关系矩阵（启动读回边界 fail-closed）——
      // 每个 Event ≥1 observation；Event.item_count = Σ observation.item_count = 实际 item 数；
      // observation.sequence / item.sequence / observation_item_sequence 均从 0 连续；
      // 每个 observation 的 first_item_sequence/item_count 精确覆盖连续 item 范围；
      // item 的 observation_id/event_id 归属一致；sequence=0 observation 与 Event
      // 首 idempotency/fingerprint 兼容列一致。
      // v3 前（v2 legacy）库没有 watch_event_observations 表：先探测表存在性，
      // 不存在则跳过该 v3 专属矩阵（迁移后再装配的库必然存在）。
      const obsTableExists =
        this.handle
          .prepare(
            "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='watch_event_observations'",
          )
          .get() !== undefined;
      if (obsTableExists) {
        const obsRows = this.handle.prepare(SQL_SELECT_ALL_OBSERVATIONS).all() as Array<
          Record<string, unknown>
        >;
        const obsItemsRows = this.handle.prepare(SQL_SELECT_ALL_ITEMS_WITH_OBS).all() as Array<
          Record<string, unknown>
        >;
        const obsByEvent = new Map<string, Array<Record<string, unknown>>>();
        for (const o of obsRows) {
          const eid = String(o['event_id'] ?? '');
          const list = obsByEvent.get(eid) ?? [];
          list.push(o);
          obsByEvent.set(eid, list);
        }
        const itemsByEvent = new Map<string, Array<Record<string, unknown>>>();
        for (const i of obsItemsRows) {
          const eid = String(i['event_id'] ?? '');
          const list = itemsByEvent.get(eid) ?? [];
          list.push(i);
          itemsByEvent.set(eid, list);
        }
        // R2-4：#S6-055 启动扫描必须拒绝不属于任何 Event 的 observation/item；每个
        // observation 与 item 都必须被恰好一个合法 Event/observation 消费。不依赖
        // 正常写入时 FK 的约束——即使 FK 关闭写入的孤儿/跨 Event 行也必须在启动时
        // fail-closed（显式关系矩阵；另以 PRAGMA foreign_key_check 纵深防御）。
        const eventIdSet = new Set(
          eventRows
            .filter((e): e is Record<string, unknown> => isPlainRecord(e))
            .map((e) => String(e['id'] ?? '')),
        );
        const obsIdEvent = new Map<string, string>(); // observation id -> event id
        for (const o of obsRows) {
          const oid = String(o['id'] ?? '');
          const oeid = String(o['event_id'] ?? '');
          // R3-4：observation id 闭合形状——小写 UUID v4 或 `v2:<所属 eventId>`；
          // 任意 v2: suffix、大小写/非 v4 UUID、`c-<uuid>`、`<event>-obs0` 一律拒绝。
          if (!isValidObservationId(oid, oeid)) {
            return { ok: false, reason: `observation ${oid} id 形状非法` };
          }
          if (!eventIdSet.has(oeid)) {
            return { ok: false, reason: `observation ${oid} 不属于任何 Event` };
          }
          obsIdEvent.set(oid, oeid);
        }
        for (const i of obsItemsRows) {
          const iid = String(i['id'] ?? '');
          const ieid = String(i['event_id'] ?? '');
          const oid = String(i['observation_id'] ?? '');
          if (!eventIdSet.has(ieid)) {
            return { ok: false, reason: `item ${iid} 不属于任何 Event` };
          }
          // item 必须被恰好一个合法 observation 消费：observation 存在且与 item
          // 同属一个 Event（拒绝跨 Event 错配 / 悬空 observation_id）
          if (!obsIdEvent.has(oid) || obsIdEvent.get(oid) !== ieid) {
            return { ok: false, reason: `item ${iid} 的 observation 关系非法` };
          }
        }
        // 纵深防御：FK 开启连接上的固定 PRAGMA foreign_key_check 拒绝残留违例
        const fkViolations = this.handle.prepare('PRAGMA foreign_key_check').all();
        if (fkViolations.length > 0) {
          return { ok: false, reason: '外键检查发现违例（observation/item 关系损坏）' };
        }
        for (const ev of eventRows) {
          if (!isPlainRecord(ev)) return { ok: false, reason: 'Event 行形状非法' };
          const eventId = String(ev['id'] ?? '');
          const itemCount = Number(ev['item_count']);
          const obs = obsByEvent.get(eventId) ?? [];
          const items = itemsByEvent.get(eventId) ?? [];
          if (obs.length < 1) return { ok: false, reason: `Event ${eventId} 缺 observation` };
          const obsCountSum = obs.reduce((s, o) => s + Number(o['item_count'] ?? 0), 0);
          if (obsCountSum !== itemCount || items.length !== itemCount) {
            return { ok: false, reason: `Event ${eventId} observation/item 计数不一致` };
          }
          const obsSeqs = obs.map((o) => Number(o['sequence'] ?? -1)).sort((a, b) => a - b);
          const itemSeqs = items.map((i) => Number(i['sequence'] ?? -1)).sort((a, b) => a - b);
          for (let s = 0; s < obsSeqs.length; s += 1) {
            if (obsSeqs[s] !== s)
              return { ok: false, reason: `Event ${eventId} observation sequence 缺口` };
          }
          for (let s = 0; s < itemSeqs.length; s += 1) {
            if (itemSeqs[s] !== s)
              return { ok: false, reason: `Event ${eventId} item sequence 缺口` };
          }
          for (const o of obs) {
            const oid = String(o['id'] ?? '');
            const first = Number(o['first_item_sequence'] ?? -1);
            const ocount = Number(o['item_count'] ?? 0);
            const members = items.filter((i) => String(i['observation_id'] ?? '') === oid);
            if (members.length !== ocount) {
              return { ok: false, reason: `observation ${oid} item 范围计数不一致` };
            }
            const memberSeqs = members
              .map((m) => Number(m['sequence'] ?? -1))
              .sort((a, b) => a - b);
            const memberObsSeqs = members
              .map((m) => Number(m['observation_item_sequence'] ?? -1))
              .sort((a, b) => a - b);
            for (let k = 0; k < memberSeqs.length; k += 1) {
              if (memberSeqs[k] !== first + k) {
                return { ok: false, reason: `observation ${oid} 未精确覆盖连续 item 范围` };
              }
              if (memberObsSeqs[k] !== k) {
                return { ok: false, reason: `observation ${oid} observation_item_sequence 缺口` };
              }
            }
          }
          // sequence=0 观察与 Event 首 idempotency/fingerprint 兼容列一致
          const firstObs = obs.find((o) => Number(o['sequence']) === 0);
          if (firstObs === undefined)
            return { ok: false, reason: `Event ${eventId} 缺 sequence=0 observation` };
          if (
            String(firstObs['idempotency_key'] ?? '') !== String(ev['idempotency_key'] ?? '') ||
            String(firstObs['change_fingerprint'] ?? '') !== String(ev['change_fingerprint'] ?? '')
          ) {
            return { ok: false, reason: `Event ${eventId} 首 observation 兼容列不一致` };
          }
        }
      }
      for (const row of this.handle.prepare(SQL_SELECT_ALL_INTENTS).all() as unknown[]) {
        if (!isPlainRecord(row)) return { ok: false, reason: 'intent 行形状非法' };
        const normalized = {
          mutationId: row['mutation_id'],
          sourceId: row['source_id'],
          operation: row['operation'],
          beforeProjection:
            row['before_projection_json'] === null
              ? null
              : this.parseJson(row['before_projection_json']),
          afterProjection:
            row['after_projection_json'] === null
              ? null
              : this.parseJson(row['after_projection_json']),
          affectedRuleState: this.parseJson(row['affected_rule_state_json']),
          state: row['state'],
          createdAt: row['created_at'],
          updatedAt: row['updated_at'],
        };
        if (!validateIntentRow(normalized).ok)
          return { ok: false, reason: 'intent 行读回校验失败' };
      }
      for (const row of this.handle.prepare(SQL_SELECT_ALL_SCHEDULES).all() as unknown[]) {
        if (!isPlainRecord(row)) return { ok: false, reason: 'DigestSchedule 行形状非法' };
        if (!validateDigestScheduleRow(row))
          return { ok: false, reason: 'DigestSchedule 行读回校验失败' };
      }
      const digestRuns = this.handle.prepare(SQL_SELECT_ALL_DIGEST_RUNS).all() as unknown[];
      const runById = new Map<string, Record<string, unknown>>();
      for (const row of digestRuns) {
        if (!isPlainRecord(row) || !validateDigestRunRow(row))
          return { ok: false, reason: 'DigestRun 行读回校验失败' };
        runById.set(String(row['id']), row);
      }
      const factsByDigest = new Map<string, DigestFacts>();
      const artifactsByRun = new Map<string, Array<Record<string, unknown>>>();
      for (const row of this.handle.prepare(SQL_SELECT_ALL_DIGESTS).all() as unknown[]) {
        if (!isPlainRecord(row) || !validateDigestArtifactRow(row))
          return { ok: false, reason: 'Digest 行读回校验失败' };
        const run = runById.get(String(row['run_id']));
        if (
          run === undefined ||
          row['schedule_id'] !== run['schedule_id'] ||
          Number(row['first_sequence']) <= Number(run['lower_sequence']) ||
          Number(row['last_sequence']) > Number(run['upper_sequence']) ||
          Number(row['byte_length']) !==
            utf8ByteLength(String(row['facts_json'])) +
              (row['explanation_json'] === null
                ? 0
                : utf8ByteLength(String(row['explanation_json'])))
        )
          return { ok: false, reason: 'Digest 与 Run/字节关系非法' };
        factsByDigest.set(String(row['id']), this.parseJson(row['facts_json']) as DigestFacts);
        const list = artifactsByRun.get(String(row['run_id'])) ?? [];
        list.push(row);
        artifactsByRun.set(String(row['run_id']), list);
      }
      for (const [runId, artifacts] of artifactsByRun) {
        const run = runById.get(runId)!;
        artifacts.sort((a, b) => Number(a['batch_index']) - Number(b['batch_index']));
        let previous = Number(run['lower_sequence']);
        for (let index = 0; index < artifacts.length; index += 1) {
          const artifact = artifacts[index]!;
          if (artifact['batch_index'] !== index || artifact['first_sequence'] !== previous + 1)
            return { ok: false, reason: 'Digest batch 序号/sequence 不连续' };
          previous = Number(artifact['last_sequence']);
        }
        if (previous > Number(run['next_sequence']))
          return { ok: false, reason: 'Digest artifact 越过 Run cursor' };
      }
      const refsByDigest = new Map<string, Map<string, string>>();
      for (const row of this.handle.prepare(SQL_SELECT_ALL_DIGEST_REFS).all() as unknown[]) {
        if (!isPlainRecord(row)) return { ok: false, reason: 'DigestRef 行形状非法' };
        if (!isIn(row['status'], ['active', 'expired', 'user-deleted'] as const)) {
          return { ok: false, reason: 'DigestRef 状态非法' };
        }
        const refs = refsByDigest.get(String(row['digest_id'])) ?? new Map<string, string>();
        refs.set(String(row['event_id']), String(row['status']));
        refsByDigest.set(String(row['digest_id']), refs);
      }
      for (const [digestId, facts] of factsByDigest) {
        const refs = refsByDigest.get(digestId);
        if (refs === undefined || refs.size !== facts.events.length)
          return { ok: false, reason: 'Digest facts/ref 数量不一致' };
        for (const event of facts.events) {
          if (refs.get(event.eventId) !== facts.referenceStates[event.eventId])
            return { ok: false, reason: 'Digest facts/ref 状态不一致' };
        }
      }
      const state = this.handle.prepare(SQL_SELECT_DIGEST_CHANGE_STATE).all() as unknown[];
      if (
        state.length !== 1 ||
        !isPlainRecord(state[0]) ||
        state[0]['id'] !== 1 ||
        !Number.isSafeInteger(state[0]['last_sequence']) ||
        Number(state[0]['last_sequence']) < 0
      )
        return { ok: false, reason: 'Digest journal high-water 非法' };
      const changes = this.handle.prepare(SQL_SELECT_ALL_DIGEST_CHANGES).all() as unknown[];
      let previousSequence = 0;
      for (const row of changes) {
        if (
          !isPlainRecord(row) ||
          !Number.isSafeInteger(row['sequence']) ||
          Number(row['sequence']) <= previousSequence ||
          Number(row['sequence']) > Number(state[0]['last_sequence']) ||
          typeof row['observation_id'] !== 'string' ||
          typeof row['event_id'] !== 'string' ||
          typeof row['source_id'] !== 'string' ||
          typeof row['observed_at'] !== 'string' ||
          !Number.isFinite(Date.parse(row['observed_at'])) ||
          !isIn(row['status'], ['active', 'expired', 'user-deleted'] as const)
        )
          return { ok: false, reason: 'Digest journal 行非法' };
        previousSequence = Number(row['sequence']);
      }
      const activeObservationIds = new Set(
        changes
          .filter(
            (row): row is Record<string, unknown> =>
              isPlainRecord(row) && row['status'] === 'active',
          )
          .map((row) => String(row['observation_id'])),
      );
      const persistedObservationIds = new Set(
        (
          this.handle.prepare(SQL_SELECT_ALL_OBSERVATIONS).all() as Array<Record<string, unknown>>
        ).map((row) => String(row['id'])),
      );
      if (
        activeObservationIds.size !== persistedObservationIds.size ||
        [...persistedObservationIds].some((id) => !activeObservationIds.has(id))
      )
        return { ok: false, reason: 'Digest active journal 与 observation 不一致' };
      const highWater = Number(state[0]['last_sequence']);
      for (const row of this.handle.prepare(SQL_SELECT_ALL_SCHEDULES).all() as Array<
        Record<string, unknown>
      >) {
        if (Number(row['cursor_sequence']) > highWater)
          return { ok: false, reason: 'Digest schedule cursor 越过 high-water' };
      }
      for (const row of this.handle.prepare(SQL_SELECT_ALL_OUTBOX).all() as unknown[]) {
        if (!isPlainRecord(row)) return { ok: false, reason: 'Outbox 行形状非法' };
        if (this.parseJson(row['privacy_json']) === null) {
          return { ok: false, reason: 'Outbox privacy_json 非法' };
        }
      }
      return { ok: true, reason: null };
    } catch (err) {
      logWarn('watch', '完整性/JSON 形状扫描执行失败（fail-closed）', err);
      return { ok: false, reason: '完整性/JSON 形状扫描执行失败' };
    }
  }

  estimateLogicalBytes(): number {
    this.ensureOpen();
    return this.estimateLogicalBytesInternal();
  }

  // FIXED DECISION 7（#S6-055/#S6-058）：结果事务（create）写前逻辑字节估算——
  // 必须包含 observation 元数据、Baseline validators、item observation 关系列及
  // 新事务写入的 Baseline/Event/observation/items/outbox/audit/Run metadata 等
  // 有界开销，低估不得绕过 maxDbBytes。
  private estimateResultCreateWriteSet(input: {
    event: WatchEvent;
    observationId: string;
    itemCount: number;
    itemsBytes: number;
    baseline?:
      | {
          projectionType: 'feed' | 'page';
          projectionJson: string;
          contentHash: string;
          byteLength: number;
          finalUrl: string;
          capturedAt: string;
          documentId: string | null;
          validators: { etag: string | null; lastModified: string | null };
        }
      | undefined;
    responseMetadataJson: string | null;
    outbox?: Array<{ id: string; dedupeKey: string; privacyJson: string }> | undefined;
    audits: Array<{ id: string; reasonCode: string }>;
  }): number {
    let bytes = 0;
    // Event 行
    bytes +=
      utf8ByteLength(input.event.id) +
      utf8ByteLength(input.event.ruleId) +
      utf8ByteLength(input.event.sourceId) +
      utf8ByteLength(input.event.eventKind) +
      utf8ByteLength(input.event.importance) +
      utf8ByteLength(input.event.idempotencyKey) +
      utf8ByteLength(input.event.changeFingerprint) +
      utf8ByteLength(input.event.firstObservedAt) +
      utf8ByteLength(input.event.lastObservedAt) +
      8;
    // observation 元数据行（id/event_id/sequence/int/idempotency/fingerprint/kind/time/ints）
    bytes +=
      utf8ByteLength(input.observationId) +
      utf8ByteLength(input.event.id) +
      utf8ByteLength(input.event.idempotencyKey) +
      utf8ByteLength(input.event.changeFingerprint) +
      utf8ByteLength(input.event.eventKind) +
      utf8ByteLength(input.event.firstObservedAt) +
      24;
    // items：序列化 JSON + observation 关系列（observation_id / observation_item_sequence / ints）
    bytes += input.itemsBytes;
    bytes += input.itemCount * (utf8ByteLength(input.observationId) + 8 + 8);
    // Baseline + validators（#S6-056：etag/lastModified 同事务计入）
    if (input.baseline !== undefined) {
      bytes +=
        utf8ByteLength(input.baseline.projectionJson) +
        utf8ByteLength(input.baseline.contentHash) +
        utf8ByteLength(input.baseline.finalUrl) +
        utf8ByteLength(input.baseline.capturedAt) +
        utf8ByteLength(input.baseline.documentId ?? '') +
        utf8ByteLength(input.baseline.validators.etag ?? '') +
        utf8ByteLength(input.baseline.validators.lastModified ?? '') +
        utf8ByteLength(input.event.ruleId) +
        16;
    }
    // Run metadata
    bytes += utf8ByteLength(input.responseMetadataJson ?? '');
    // outbox 行（privacy/dedupe/ids/int）
    for (const ob of input.outbox ?? []) {
      bytes +=
        utf8ByteLength(ob.id) +
        utf8ByteLength(ob.dedupeKey) +
        utf8ByteLength(ob.privacyJson) +
        utf8ByteLength(input.event.ruleId) +
        utf8ByteLength(input.event.id) +
        8;
    }
    // audits
    for (const a of input.audits) {
      bytes +=
        utf8ByteLength(a.id) +
        utf8ByteLength(a.reasonCode) +
        utf8ByteLength(input.event.ruleId) +
        8;
    }
    return bytes;
  }

  // R2-2 FIXED DECISION 7（#S6-055/#S6-058）：coalesce 完整新增写集估算——
  // 新增 observation 元数据、items 序列化 JSON + observation 关系列
  //（observation_id/observation_item_sequence/event_id/sequence ints）、
  // Baseline/validators、Run metadata、audit、Event 行增长（event_kind/
  // last_observed_at/item_count 更新）。低估不得绕过 maxDbBytes。
  private estimateResultCoalesceWriteSet(input: {
    ruleId: string;
    eventId: string;
    observationId: string;
    idempotencyKey: string;
    changeFingerprint: string;
    eventKind: string;
    lastObservedAt: string;
    newItemCount: number;
    itemsBytes: number;
    itemCount: number;
    baseline?:
      | {
          projectionType: 'feed' | 'page';
          projectionJson: string;
          contentHash: string;
          byteLength: number;
          finalUrl: string;
          capturedAt: string;
          documentId: string | null;
          validators: { etag: string | null; lastModified: string | null };
        }
      | undefined;
    responseMetadataJson: string;
    audits: Array<{ id: string; reasonCode: string }>;
  }): number {
    let bytes = 0;
    // Event 行增长（event_kind/last_observed_at/item_count 更新）
    bytes += utf8ByteLength(input.eventKind) + utf8ByteLength(input.lastObservedAt) + 8 + 8;
    // 新增 observation 元数据行
    bytes +=
      utf8ByteLength(input.observationId) +
      utf8ByteLength(input.eventId) +
      utf8ByteLength(input.idempotencyKey) +
      utf8ByteLength(input.changeFingerprint) +
      utf8ByteLength(input.eventKind) +
      utf8ByteLength(input.lastObservedAt) +
      24;
    // items：序列化 JSON + observation 关系列（observation_id/event_id/
    // observation_item_sequence/event sequence ints）
    bytes += input.itemsBytes;
    bytes +=
      input.itemCount *
      (utf8ByteLength(input.observationId) + utf8ByteLength(input.eventId) + 8 + 8);
    // Baseline + validators
    if (input.baseline !== undefined) {
      bytes +=
        utf8ByteLength(input.baseline.projectionJson) +
        utf8ByteLength(input.baseline.contentHash) +
        utf8ByteLength(input.baseline.finalUrl) +
        utf8ByteLength(input.baseline.capturedAt) +
        utf8ByteLength(input.baseline.documentId ?? '') +
        utf8ByteLength(input.baseline.validators.etag ?? '') +
        utf8ByteLength(input.baseline.validators.lastModified ?? '') +
        utf8ByteLength(input.ruleId) +
        16;
    }
    // Run metadata
    bytes += utf8ByteLength(input.responseMetadataJson);
    // audits
    for (const a of input.audits) {
      bytes +=
        utf8ByteLength(a.id) + utf8ByteLength(a.reasonCode) + utf8ByteLength(input.ruleId) + 8;
    }
    return bytes;
  }

  private estimateLogicalBytesInternal(): number {
    try {
      const row = this.handle.prepare(SQL_ESTIMATE_LOGICAL_BYTES).get() as {
        total: number | bigint;
      };
      const total = Number(row.total);
      return Number.isFinite(total) && total >= 0 ? total : Number.MAX_SAFE_INTEGER;
    } catch (err) {
      logWarn('watch', '全库字节估算失败（fail-closed 按超限处理）', err);
      return Number.MAX_SAFE_INTEGER;
    }
  }

  private appendDigestChangeJournal(
    observationId: string,
    eventId: string,
    sourceId: string,
    observedAt: string,
  ): number {
    const row = this.handle.prepare(SQL_NEXT_DIGEST_CHANGE_SEQUENCE).get() as
      { last_sequence: number | bigint } | undefined;
    if (row === undefined) throw new TxnAbortError('store-unavailable');
    const sequence = Number(row.last_sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new TxnAbortError('store-unavailable');
    }
    this.handle
      .prepare(SQL_INSERT_DIGEST_CHANGE)
      .run(sequence, observationId, eventId, sourceId, observedAt);
    return sequence;
  }

  // 按规则分级保留：公开 90天/200、登录态 30天/100（== 保留、+1 清理）；
  // 清理顺序「已读最旧 → 未读最旧」；删除前 Digest ref → expired（tombstone），
  // 并移除对应 outbox。自带事务。
  pruneEventsByRuleLimits(nowIso: string): { deleted: number; expiredRefs: number } {
    this.ensureOpen();
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs)) return { deleted: 0, expiredRefs: 0 };
    try {
      return withTransaction(this.handle, () => {
        const rules = this.handle.prepare(SQL_SELECT_RULES_ACCESS).all() as Array<{
          id: string;
          access_mode: string;
        }>;
        let deleted = 0;
        let expiredRefs = 0;
        for (const rule of rules) {
          const days =
            rule.access_mode === 'session'
              ? SESSION_EVENT_RETENTION_DAYS
              : PUBLIC_EVENT_RETENTION_DAYS;
          const cap =
            rule.access_mode === 'session' ? SESSION_EVENTS_PER_RULE : PUBLIC_EVENTS_PER_RULE;
          const cutoff = new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
          const rows = this.handle
            .prepare(SQL_SELECT_EVENTS_FOR_RULE_ORDERED)
            .all(rule.id) as Array<{
            id: string;
            first_observed_at: string;
            read_at: string | null;
          }>;
          const expired = rows.filter((r) => r.first_observed_at < cutoff);
          const withinAge = rows.filter((r) => r.first_observed_at >= cutoff);
          const overflow = withinAge.length > cap ? withinAge.length - cap : 0;
          const deleteIds = [
            ...expired.map((r) => r.id),
            ...withinAge.slice(0, overflow).map((r) => r.id),
          ];
          for (const id of deleteIds) {
            expiredRefs += this.scrubEventInternal(id, 'expired', nowIso);
            this.handle.prepare(SQL_DELETE_EVENT_OUTBOX).run(id);
            const del = this.handle.prepare(SQL_DELETE_EVENT).run(id);
            deleted += Number(del.changes);
          }
        }
        return { deleted, expiredRefs };
      });
    } catch (err) {
      logWarn('watch', '分级保留清理失败（已整体回滚）', err);
      return { deleted: 0, expiredRefs: 0 };
    }
  }

  // 全库 100 MiB：写前由各写事务估算拒绝；启动清理在分级清理后仍超限时
  // 全局按「已读最旧 → 未读最旧」删除 Event 直到回到预算内或无可删。
  // 逐条删除 + 每次重估（== 边界恰好停止，绝不超删）。
  pruneEventsToDbBudget(nowIso: string): { deleted: number; remainingBytes: number } {
    this.ensureOpen();
    void nowIso;
    let deleted = 0;
    try {
      for (;;) {
        const current = this.estimateLogicalBytesInternal();
        if (current <= this.maxDbBytes) {
          return { deleted, remainingBytes: current };
        }
        const row = this.handle.prepare(SQL_SELECT_OLDEST_EVENT_GLOBAL).get() as
          { id: string } | undefined;
        if (row === undefined) {
          return { deleted, remainingBytes: current };
        }
        withTransaction(this.handle, () => {
          this.scrubEventInternal(row.id, 'expired', nowIso);
          this.handle.prepare(SQL_DELETE_EVENT_OUTBOX).run(row.id);
          const del = this.handle.prepare(SQL_DELETE_EVENT).run(row.id);
          deleted += Number(del.changes);
        });
      }
    } catch (err) {
      logWarn('watch', '全库预算清理失败（已整体回滚）', err);
      return { deleted, remainingBytes: this.estimateLogicalBytesInternal() };
    }
  }
}

export type {
  AffectedRulePrepareState,
  SourceCleanupIntentRow,
  SourceCleanupIntentState,
  WatchRunRow,
};
export type { WatchRuleRowColumns };
