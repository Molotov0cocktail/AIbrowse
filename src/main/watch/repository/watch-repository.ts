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
  type WatchHealthSnapshot,
  type WatchRule,
  type WatchRunOutcome,
} from '../../../shared/types/watch';
import { validateFeedTarget, validatePageTarget } from '../../../shared/watch/watch-targets';
import {
  transitionRuleState,
  validateWatchSchedule,
  type HealthPauseReason,
} from '../../../shared/watch/watch-rule-state';
import { utf8ByteLength } from '../../../shared/watch/watch-budget';
import {
  WATCH_AUDIT_KINDS,
  WATCH_AUDIT_REASON_CODES,
  type WatchAuditKind,
  type WatchAuditReasonCode,
} from '../db/watch-migrations';
import {
  validateAffectedRuleStateMap,
  validateBaselineRow,
  validateChangeEvidencePair,
  validateEventRow,
  validateIntentRow,
  validateRuleRow,
  validateRunRow,
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
  | { ok: true; runId: string; reused?: boolean }
  | { ok: false; code: WatchErrorCode };

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
   final_url, captured_at, document_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const SQL_UPDATE_BASELINE_CAS = `UPDATE watch_baselines
  SET version = ?, projection_type = ?, projection_json = ?, content_hash = ?, byte_length = ?,
      final_url = ?, captured_at = ?, document_id = ?
  WHERE rule_id = ? AND version = ?`;
const SQL_SELECT_BASELINE = `SELECT rule_id, version, projection_type, projection_json,
  content_hash, byte_length, final_url, captured_at, document_id
  FROM watch_baselines WHERE rule_id = ?`;
const SQL_UPDATE_RULE_BASELINE_VERSION =
  'UPDATE watch_rules SET baseline_version = ?, updated_at = ? WHERE id = ?';

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
const SQL_INSERT_EVENT_ITEM = `INSERT INTO watch_event_items
  (id, event_id, sequence, item_id, field_key, label, before_value_json, after_value_json,
   before_captured_at, after_captured_at, before_final_url, after_final_url,
   before_document_id, after_document_id, feed_item_key)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const SQL_SELECT_EVENT_ITEMS = `SELECT id, event_id, sequence, item_id, field_key, label,
  before_value_json, after_value_json, before_captured_at, after_captured_at,
  before_final_url, after_final_url, before_document_id, after_document_id, feed_item_key
  FROM watch_event_items WHERE event_id = ? ORDER BY sequence ASC, id ASC`;
const SQL_MARK_EVENTS_READ = 'UPDATE watch_events SET read_at = ? WHERE id = ?';
const SQL_DELETE_EVENT = 'DELETE FROM watch_events WHERE id = ?';
const SQL_DELETE_EVENT_OUTBOX = `DELETE FROM notification_outbox
  WHERE subject_type = 'event' AND subject_id = ?`;
const SQL_MARK_REFS_EXPIRED_FOR_EVENT = `UPDATE digest_event_refs
  SET status = 'expired' WHERE event_id = ? AND status = 'active'`;
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

// 启动完整性/JSON 形状/预算扫描（§10.2 步骤 4；store 编排、SQL 仍在本模块）
const SQL_SELECT_ALL_BASELINES = `SELECT rule_id, version, projection_type, projection_json,
  content_hash, byte_length, final_url, captured_at, document_id FROM watch_baselines`;
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
const SQL_SELECT_ALL_INTENTS = `SELECT mutation_id, source_id, operation,
  before_projection_json, after_projection_json, affected_rule_state_json, state,
  created_at, updated_at FROM source_cleanup_intents`;
const SQL_SELECT_ALL_SCHEDULES = `SELECT id, source_ids_json, schedule_json, ai_enabled,
  cursor_json, state, created_at, updated_at, last_checked_at FROM digest_schedules`;
const SQL_SELECT_ALL_DIGESTS = `SELECT id, schedule_id, facts_json, explanation_json,
  byte_length, created_at FROM watch_digests`;
const SQL_SELECT_ALL_DIGEST_REFS = `SELECT digest_id, event_id, status FROM digest_event_refs`;
const SQL_SELECT_ALL_OUTBOX = `SELECT id, rule_id, subject_type, subject_id, channel,
  dedupe_key, privacy_json, state, attempts, created_at, updated_at
  FROM notification_outbox`;

const SQL_INSERT_DIGEST_REF = `INSERT INTO digest_event_refs (digest_id, event_id, status)
  VALUES (?, ?, ?)`;
const SQL_SELECT_DIGEST_REFS = `SELECT digest_id, event_id, status FROM digest_event_refs
  ORDER BY digest_id ASC, event_id ASC`;

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
    + LENGTH(CAST(COALESCE(document_id,'') AS BLOB)) + 16)
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
    + LENGTH(CAST(item_id AS BLOB)) + LENGTH(CAST(field_key AS BLOB))
    + LENGTH(CAST(label AS BLOB)) + LENGTH(CAST(before_value_json AS BLOB))
    + LENGTH(CAST(after_value_json AS BLOB)) + LENGTH(CAST(before_captured_at AS BLOB))
    + LENGTH(CAST(after_captured_at AS BLOB)) + LENGTH(CAST(before_final_url AS BLOB))
    + LENGTH(CAST(after_final_url AS BLOB))
    + LENGTH(CAST(COALESCE(before_document_id,'') AS BLOB))
    + LENGTH(CAST(COALESCE(after_document_id,'') AS BLOB))
    + LENGTH(CAST(COALESCE(feed_item_key,'') AS BLOB)) + 8)
    FROM watch_event_items), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB))
    + LENGTH(CAST(source_ids_json AS BLOB)) + LENGTH(CAST(schedule_json AS BLOB))
    + LENGTH(CAST(COALESCE(cursor_json,'') AS BLOB))
    + LENGTH(CAST(state AS BLOB)) + LENGTH(CAST(created_at AS BLOB))
    + LENGTH(CAST(updated_at AS BLOB))
    + LENGTH(CAST(COALESCE(last_checked_at,'') AS BLOB)) + 8)
    FROM digest_schedules), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB))
    + LENGTH(CAST(schedule_id AS BLOB)) + LENGTH(CAST(facts_json AS BLOB))
    + LENGTH(CAST(COALESCE(explanation_json,'') AS BLOB))
    + LENGTH(CAST(created_at AS BLOB)) + 8) FROM watch_digests), 0)
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
      return { ok: false, code: this.translate(err).code };
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
        this.handle.prepare(SQL_MARK_REFS_EXPIRED_FOR_EVENT).run(row.id);
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
  }): WatchResult {
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
          | { state: string }
          | undefined;
        if (ruleRow === undefined) return { ok: false, code: 'rule-not-found' as const };
        if (ruleRow.state !== 'enabled') {
          return { ok: false, code: 'rule-state-conflict' as const };
        }
        const active = this.handle.prepare(SQL_SELECT_ACTIVE_RUN_BY_RULE).get(input.ruleId) as
          | { id: string }
          | undefined;
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
    try {
      withTransaction(this.handle, () => {
        const nowIso = this.nowIso();
        const transition = this.transitionRun(input.runId, 'running', {
          status: 'finished',
          finishedAt: nowIso,
          outcome: input.outcome,
          health: input.health,
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
            | { state: string }
            | undefined;
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
        for (let i = 0; i < input.items.length; i += 1) {
          const item = input.items[i]!;
          this.handle
            .prepare(SQL_INSERT_EVENT_ITEM)
            .run(
              `${input.event.id}-${i}`,
              input.event.id,
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
        const sourceIds = this.parseJson(row['source_ids_json']);
        if (!Array.isArray(sourceIds) || !sourceIds.every((x) => typeof x === 'string')) {
          return { ok: false, reason: 'DigestSchedule source_ids 非法' };
        }
        const schedule = this.parseJson(row['schedule_json']);
        if (schedule === null || !validateWatchSchedule(schedule).ok) {
          return { ok: false, reason: 'DigestSchedule schedule 非法' };
        }
        if (row['cursor_json'] !== null && this.parseJson(row['cursor_json']) === null) {
          return { ok: false, reason: 'DigestSchedule cursor 非法' };
        }
      }
      for (const row of this.handle.prepare(SQL_SELECT_ALL_DIGESTS).all() as unknown[]) {
        if (!isPlainRecord(row)) return { ok: false, reason: 'Digest 行形状非法' };
        if (this.parseJson(row['facts_json']) === null)
          return { ok: false, reason: 'Digest facts 非法' };
        if (row['explanation_json'] !== null && this.parseJson(row['explanation_json']) === null) {
          return { ok: false, reason: 'Digest explanation 非法' };
        }
      }
      for (const row of this.handle.prepare(SQL_SELECT_ALL_DIGEST_REFS).all() as unknown[]) {
        if (!isPlainRecord(row)) return { ok: false, reason: 'DigestRef 行形状非法' };
        if (!isIn(row['status'], ['active', 'expired', 'user-deleted'] as const)) {
          return { ok: false, reason: 'DigestRef 状态非法' };
        }
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
            const refs = this.handle.prepare(SQL_MARK_REFS_EXPIRED_FOR_EVENT).run(id);
            expiredRefs += Number(refs.changes);
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
          this.handle.prepare(SQL_MARK_REFS_EXPIRED_FOR_EVENT).run(row.id);
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
