// Sixth Stage D4: watch.db migration v1 (detailed-design §10.1, threat-model
// §3.5/WT-21). Independent migration list from Sources/Research databases; the
// stepwise migration engine is reused by import from sources/db/migrations
// (frozen B1 pattern, unmodified). All statements are compile-time constants;
// user/model/web/Source text reaches the database only via WatchRepository
// bound parameters. Migration v1 statements are frozen once committed — schema
// changes may only append later versions.
//
// §10.1 契约对齐：
// - 11 表：watch_rules / watch_baselines / watch_runs / watch_audits /
//   watch_events / watch_event_items / digest_schedules / watch_digests /
//   digest_event_refs / notification_outbox / source_cleanup_intents；
// - 外键打开；删除 Rule CASCADE baseline/runs/audits/events/outbox（audits
//   按 §10.1 同族 CASCADE——级联删除审计由 coordinator 以 rule_id=null 写入
//   才能随级联存活）；Event CASCADE items；
// - digest_event_refs.event_id 无外键：§10.1「Digest 对 Event 使用 tombstone
//   状态而非丢失引用真实性」——Event 行删除后 ref 必须保留并置 expired，
//   外键 CASCADE/RESTRICT 都无法承载该语义（注释记录，非遗漏）；
// - watch_runs.status 为 D5 reservation 前向兼容列（queued/running/interrupted/
//   finished）——§3.3 WatchRun DTO 无 status，schema v1 补充承载（FIXED
//   DECISION 9）；outcome_json/health_json 经共享 validator 读回二次校验。
import { runMigrations, type MigrationStep } from '../../sources/db/migrations';
import type { DbHandle } from '../../sources/db/sqlite-driver';

export type { MigrationStep } from '../../sources/db/migrations';

// ---------------------------------------------------------------------------
// 审计编码单一事实源（#S6-044 FIXED 7/15）：TS 白名单与 DB CHECK 必须 1:1 同源，
// 禁止双写漂移。watch-repository.ts 从本文件导入同一数组；migration 步骤也由本数组
// 生成 CHECK 子句。
//
// v1/v2 语句字节冻结：WATCH_AUDIT_KINDS_V2 / WATCH_AUDIT_REASON_CODES_V2 是 v2 当时
// 的冻结集合（v2 的 watch_audits CHECK 由它们生成，永不因后续扩展变化）。
// D7 #S6-044：schema v3 在同一 migration 事务重建 watch_audits 扩展 reason 集合
// （kind 集合不新增），主数组 WATCH_AUDIT_KINDS / WATCH_AUDIT_REASON_CODES 即为
// v3 完整集合（= V2 冻结集 + D7 追加），v3 CHECK 与 Repository TS 白名单由此派生。
// ---------------------------------------------------------------------------

export const WATCH_AUDIT_KINDS_V2 = [
  'lifecycle-pause',
  'lifecycle-cascade',
  'reconciliation',
  'baseline-established',
  'rebaseline',
  'run',
] as const;

export const WATCH_AUDIT_REASON_CODES_V2 = [
  'source-disabled',
  'source-deleted',
  'source-changed',
  'hard-delete',
  'undo-source-removed',
  'complete',
  'aborted',
  'baseline-established',
  'rebaseline',
  'login-required',
  'captcha',
  'parse-changed',
  'robots-disallowed',
  'security-rejected',
  'dependency-unavailable',
  'unchanged',
  'unavailable',
  'budget-exceeded',
  'interrupted',
] as const;

export const WATCH_AUDIT_KINDS = [...WATCH_AUDIT_KINDS_V2] as const;

// v3 完整集合：v2 冻结集 + D7 #S6-044 追加 reason（kind 集合不新增）。const 元组
// 派生的 WatchAuditKind / WatchAuditReasonCode 保持闭合字面量类型（禁 any）。
export const WATCH_AUDIT_REASON_CODES = [
  ...WATCH_AUDIT_REASON_CODES_V2,
  'changed-unmatched',
  'event-created',
  'event-coalesced',
  'event-deduplicated',
  'condition-error',
] as const;

export type WatchAuditKind = (typeof WATCH_AUDIT_KINDS)[number];
export type WatchAuditReasonCode = (typeof WATCH_AUDIT_REASON_CODES)[number];

// 由单一事实源生成 CHECK 子句（数组为 const，模块加载一次，结果确定；值均为
// 小写 ASCII + 连字符，无单引号转义需求）。V2 冻结集合与 v3 完整集合分开生成，
// 保证 v2 语句字节永久冻结、v3 重建后 CHECK 为完整集合。
function auditKindCheckClause(list: readonly string[] = WATCH_AUDIT_KINDS_V2): string {
  return `kind TEXT NOT NULL CHECK (kind IN (${list.map((k) => `'${k}'`).join(',')}))`;
}

function auditReasonCheckClause(list: readonly string[] = WATCH_AUDIT_REASON_CODES_V2): string {
  return `reason_code TEXT NOT NULL CHECK (reason_code IN (${list
    .map((r) => `'${r}'`)
    .join(',')}))`;
}

export const WATCH_MIGRATION_V1: MigrationStep = {
  version: 1,
  statements: [
    `CREATE TABLE watch_rules (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('feed','page')),
  state TEXT NOT NULL CHECK (state IN ('enabled','paused','deleted')),
  pause_reason TEXT CHECK (pause_reason IN ('user','source-disabled','source-deleted','source-changed','login-required','captcha','parse-changed','robots-disallowed','security-rejected','dependency-unavailable') OR pause_reason IS NULL),
  desired_enabled INTEGER NOT NULL CHECK (desired_enabled IN (0,1)),
  muted INTEGER NOT NULL CHECK (muted IN (0,1)),
  access_mode TEXT NOT NULL CHECK (access_mode IN ('public','session')),
  schedule_json TEXT NOT NULL,
  target_json TEXT NOT NULL,
  condition_json TEXT,
  notification_level TEXT NOT NULL CHECK (notification_level IN ('normal','important')),
  source_row_version INTEGER NOT NULL DEFAULT 1 CHECK (source_row_version >= 1),
  source_locator_fingerprint TEXT NOT NULL CHECK (length(source_locator_fingerprint) = 64),
  next_due_at TEXT,
  last_consumed_scheduled_for TEXT,
  last_daily_local_date TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  backoff_until TEXT,
  baseline_version INTEGER NOT NULL DEFAULT 0 CHECK (baseline_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    'CREATE INDEX idx_watch_rules_source ON watch_rules(source_id)',
    'CREATE INDEX idx_watch_rules_state_due ON watch_rules(state, next_due_at)',
    `CREATE TABLE watch_baselines (
  rule_id TEXT PRIMARY KEY REFERENCES watch_rules(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  projection_type TEXT NOT NULL CHECK (projection_type IN ('feed','page')),
  projection_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0 AND byte_length <= 65536),
  final_url TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  document_id TEXT
)`,
    `CREATE TABLE watch_runs (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES watch_rules(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','interrupted','finished')),
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled','catch-up','manual')),
  scheduled_for TEXT,
  started_at TEXT,
  finished_at TEXT,
  outcome_json TEXT,
  health_json TEXT,
  response_metadata_json TEXT
)`,
    'CREATE INDEX idx_watch_runs_rule ON watch_runs(rule_id)',
    'CREATE INDEX idx_watch_runs_status ON watch_runs(status)',
    `CREATE TABLE watch_audits (
  id TEXT PRIMARY KEY,
  rule_id TEXT REFERENCES watch_rules(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('lifecycle-pause','lifecycle-cascade','reconciliation','baseline-established','rebaseline')),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('source-disabled','source-deleted','source-changed','hard-delete','undo-source-removed','complete','aborted','baseline-established','rebaseline')),
  created_at TEXT NOT NULL
)`,
    'CREATE INDEX idx_watch_audits_rule ON watch_audits(rule_id)',
    `CREATE TABLE watch_events (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES watch_rules(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('added','removed','changed','reversal','mixed')),
  importance TEXT NOT NULL CHECK (importance IN ('normal','important')),
  idempotency_key TEXT NOT NULL UNIQUE,
  change_fingerprint TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK (item_count >= 1),
  read_at TEXT
)`,
    'CREATE INDEX idx_watch_events_rule ON watch_events(rule_id, first_observed_at)',
    'CREATE INDEX idx_watch_events_source ON watch_events(source_id)',
    `CREATE TABLE watch_event_items (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES watch_events(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  item_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  before_value_json TEXT NOT NULL,
  after_value_json TEXT NOT NULL,
  before_captured_at TEXT NOT NULL,
  after_captured_at TEXT NOT NULL,
  before_final_url TEXT NOT NULL,
  after_final_url TEXT NOT NULL,
  before_document_id TEXT,
  after_document_id TEXT,
  feed_item_key TEXT,
  UNIQUE (event_id, sequence)
)`,
    'CREATE INDEX idx_watch_event_items_event ON watch_event_items(event_id)',
    `CREATE TABLE digest_schedules (
  id TEXT PRIMARY KEY,
  source_ids_json TEXT NOT NULL,
  schedule_json TEXT NOT NULL,
  ai_enabled INTEGER NOT NULL CHECK (ai_enabled IN (0,1)),
  cursor_json TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_checked_at TEXT
)`,
    `CREATE TABLE watch_digests (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES digest_schedules(id) ON DELETE CASCADE,
  facts_json TEXT NOT NULL,
  explanation_json TEXT,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0 AND byte_length <= 65536),
  created_at TEXT NOT NULL
)`,
    'CREATE INDEX idx_watch_digests_schedule ON watch_digests(schedule_id)',
    `CREATE TABLE digest_event_refs (
  digest_id TEXT NOT NULL REFERENCES watch_digests(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','expired','user-deleted')),
  PRIMARY KEY (digest_id, event_id)
) WITHOUT ROWID`,
    `CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  rule_id TEXT REFERENCES watch_rules(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('event','digest')),
  subject_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('in-app','windows')),
  dedupe_key TEXT NOT NULL UNIQUE,
  privacy_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','sent','failed','uncertain')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    'CREATE INDEX idx_notification_outbox_subject ON notification_outbox(subject_type, subject_id)',
    'CREATE INDEX idx_notification_outbox_rule ON notification_outbox(rule_id)',
    `CREATE TABLE source_cleanup_intents (
  mutation_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create','update','disable','restore','undo','hard-delete')),
  before_projection_json TEXT,
  after_projection_json TEXT,
  affected_rule_state_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared','source-committed','complete','aborted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
    'CREATE INDEX idx_source_cleanup_intents_source ON source_cleanup_intents(source_id)',
  ],
};

// #S6-044 FIXED 14/15：schema v2——watch_audits CHECK 扩展（kind 6 / reason 19）。
// v1 语句字节冻结；v2 在引擎单事务内以 SQLite 表重建完成：新建 watch_audits_v2
//（列/类型/可空性/rule_id REFERENCES watch_rules(id) ON DELETE CASCADE 完全保持，
// 仅两 CHECK 换新集）→ 显式列清单复制全部行 → DROP 旧表 → RENAME → 重建同名同定义
// 索引。任一步失败由引擎单事务整体回滚（user_version 仍 1、原行完整）。审计码
// 与 Repository TS 白名单 1:1 同源（WATCH_AUDIT_KINDS/WATCH_AUDIT_REASON_CODES）。
export const WATCH_MIGRATION_V2: MigrationStep = {
  version: 2,
  statements: [
    `CREATE TABLE watch_audits_v2 (
  id TEXT PRIMARY KEY,
  rule_id TEXT REFERENCES watch_rules(id) ON DELETE CASCADE,
  ${auditKindCheckClause()},
  ${auditReasonCheckClause()},
  created_at TEXT NOT NULL
)`,
    `INSERT INTO watch_audits_v2 (id, rule_id, kind, reason_code, created_at)
  SELECT id, rule_id, kind, reason_code, created_at FROM watch_audits`,
    'DROP TABLE watch_audits',
    'ALTER TABLE watch_audits_v2 RENAME TO watch_audits',
    'CREATE INDEX idx_watch_audits_rule ON watch_audits(rule_id)',
  ],
};

// ---------------------------------------------------------------------------
// D7 #S6-044/#S6-049/#S6-055/#S6-056 schema v3（引擎单事务，任一语句失败整体回滚）：
// 1. watch_audits 表重建扩展 reason CHECK（kind 集合不新增；v2 全部行显式列复制）；
// 2. watch_baselines 表重建追加两个 nullable 条件 validator 列（v2 原列逐列恒等、
//    新列恒 null，绝不从 Run metadata 回填或猜测）；
// 3. 新增 watch_event_observations（观察级 idempotency_key UNIQUE、UNIQUE(id,event_id)
//    供 items 复合 FK 引用、Event 内 sequence 连续）；
// 4. watch_event_items 表重建：追加 observation_id / observation_item_sequence，
//    以 (observation_id,event_id) 复合 FK 绑定观察所属 Event（禁止退回两个单列 FK），
//    保留 UNIQUE(event_id,sequence) 与新增 UNIQUE(observation_id,observation_item_sequence)；
// 5. 回填前临时 CHECK guard：每个 Event item_count>=1、实际 item 数==item_count、
//    sequence 为无缺口 0..item_count-1（零 item/计数不一致/缺口 → guard INSERT 失败
//    → 整体回滚并保持 v2）；确定性 observation id="v2:"||eventId 冲突 → UNIQUE 失败
//    → 整体回滚（禁止随机 fallback/覆盖）；
// 6. 回填：v2 每个 Event 恰一条 observation（idempotency_key/change_fingerprint/
//    event_kind 逐列取 Event、observed_at=last_observed_at、sequence=0、
//    first_item_sequence=0、item_count 取 Event）；既有 items id 与全部 v2 列恒等，
//    只追加 observation_id 与按原 sequence 相同值的 observation_item_sequence。
// ---------------------------------------------------------------------------
export const WATCH_MIGRATION_V3: MigrationStep = {
  version: 3,
  statements: [
    // 1. watch_audits 重建（reason CHECK 扩展；kind 不新增）
    `CREATE TABLE watch_audits_v3 (
  id TEXT PRIMARY KEY,
  rule_id TEXT REFERENCES watch_rules(id) ON DELETE CASCADE,
  ${auditKindCheckClause(WATCH_AUDIT_KINDS)},
  ${auditReasonCheckClause(WATCH_AUDIT_REASON_CODES)},
  created_at TEXT NOT NULL
)`,
    `INSERT INTO watch_audits_v3 (id, rule_id, kind, reason_code, created_at)
  SELECT id, rule_id, kind, reason_code, created_at FROM watch_audits`,
    'DROP TABLE watch_audits',
    'ALTER TABLE watch_audits_v3 RENAME TO watch_audits',
    'CREATE INDEX idx_watch_audits_rule ON watch_audits(rule_id)',
    // 2. watch_baselines 重建（追加两列 nullable 条件 validator；v2 原列恒等、新列 null；
    //    R3-3 纵深：非 null validator BLOB 字节 ≤1024、projection_type='page' 两列恒 null）
    `CREATE TABLE watch_baselines_v3 (
  rule_id TEXT PRIMARY KEY REFERENCES watch_rules(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  projection_type TEXT NOT NULL CHECK (projection_type IN ('feed','page')),
  projection_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0 AND byte_length <= 65536),
  final_url TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  document_id TEXT,
  conditional_etag TEXT CHECK (conditional_etag IS NULL OR length(CAST(conditional_etag AS BLOB)) <= 1024),
  conditional_last_modified TEXT CHECK (conditional_last_modified IS NULL OR length(CAST(conditional_last_modified AS BLOB)) <= 1024),
  CHECK (projection_type != 'page' OR (conditional_etag IS NULL AND conditional_last_modified IS NULL))
)`,
    `INSERT INTO watch_baselines_v3 (rule_id, version, projection_type, projection_json,
  content_hash, byte_length, final_url, captured_at, document_id)
  SELECT rule_id, version, projection_type, projection_json,
  content_hash, byte_length, final_url, captured_at, document_id FROM watch_baselines`,
    'DROP TABLE watch_baselines',
    'ALTER TABLE watch_baselines_v3 RENAME TO watch_baselines',
    // 3. watch_event_observations 新表
    `CREATE TABLE watch_event_observations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES watch_events(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  change_fingerprint TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('added','removed','changed','reversal','mixed')),
  observed_at TEXT NOT NULL,
  first_item_sequence INTEGER NOT NULL CHECK (first_item_sequence >= 0),
  item_count INTEGER NOT NULL CHECK (item_count >= 1),
  UNIQUE (event_id, sequence),
  UNIQUE (id, event_id)
)`,
    'CREATE INDEX idx_watch_event_observations_event ON watch_event_observations(event_id)',
    // 4. watch_event_items 重建（复合 FK 绑定观察所属 Event）
    `CREATE TABLE watch_event_items_v3 (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  observation_id TEXT NOT NULL,
  observation_item_sequence INTEGER NOT NULL CHECK (observation_item_sequence >= 0),
  item_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  before_value_json TEXT NOT NULL,
  after_value_json TEXT NOT NULL,
  before_captured_at TEXT NOT NULL,
  after_captured_at TEXT NOT NULL,
  before_final_url TEXT NOT NULL,
  after_final_url TEXT NOT NULL,
  before_document_id TEXT,
  after_document_id TEXT,
  feed_item_key TEXT,
  UNIQUE (event_id, sequence),
  UNIQUE (observation_id, observation_item_sequence),
  FOREIGN KEY (observation_id, event_id) REFERENCES watch_event_observations(id, event_id) ON DELETE CASCADE
)`,
    // 5. 回填前临时 CHECK guard（任一违反 → INSERT 失败 → 整体回滚）
    'CREATE TABLE watch_v3_guard (n INTEGER NOT NULL CHECK (n = 0))',
    `INSERT INTO watch_v3_guard (n)
  SELECT COUNT(*) FROM watch_events e
  WHERE e.item_count < 1
     OR (SELECT COUNT(*) FROM watch_event_items i WHERE i.event_id = e.id) <> e.item_count
     OR (SELECT COUNT(DISTINCT sequence) FROM watch_event_items i WHERE i.event_id = e.id) <> e.item_count
     OR (SELECT COALESCE(MAX(sequence), -1) FROM watch_event_items i WHERE i.event_id = e.id) <> e.item_count - 1`,
    // 6a. 回填 observations（每个 Event 恰一条；确定性 id="v2:"||eventId）
    `INSERT INTO watch_event_observations
  (id, event_id, sequence, idempotency_key, change_fingerprint, event_kind,
   observed_at, first_item_sequence, item_count)
  SELECT 'v2:' || id, id, 0, idempotency_key, change_fingerprint, event_kind,
   last_observed_at, 0, item_count FROM watch_events`,
    // 6b. 回填 items（v2 列恒等 + observation_id + observation_item_sequence=原 sequence）
    `INSERT INTO watch_event_items_v3
  (id, event_id, sequence, observation_id, observation_item_sequence,
   item_id, field_key, label, before_value_json, after_value_json,
   before_captured_at, after_captured_at, before_final_url, after_final_url,
   before_document_id, after_document_id, feed_item_key)
  SELECT id, event_id, sequence, 'v2:' || event_id, sequence,
   item_id, field_key, label, before_value_json, after_value_json,
   before_captured_at, after_captured_at, before_final_url, after_final_url,
   before_document_id, after_document_id, feed_item_key FROM watch_event_items`,
    'DROP TABLE watch_v3_guard',
    'DROP TABLE watch_event_items',
    'ALTER TABLE watch_event_items_v3 RENAME TO watch_event_items',
    'CREATE INDEX idx_watch_event_items_event ON watch_event_items(event_id)',
    'CREATE INDEX idx_watch_event_items_item ON watch_event_items(item_id, field_key)',
  ],
};

// D8 #S6-059..#S6-067 schema v4. V1-v3 statements above are byte-frozen.
// The three legacy Digest placeholder tables never had a product write path, so
// migration refuses any non-empty instance instead of guessing JSON shapes.
export const WATCH_MIGRATION_V4: MigrationStep = {
  version: 4,
  statements: [
    'CREATE TABLE watch_v4_digest_guard (n INTEGER NOT NULL CHECK (n = 0))',
    `INSERT INTO watch_v4_digest_guard (n)
  SELECT (SELECT COUNT(*) FROM digest_schedules)
       + (SELECT COUNT(*) FROM watch_digests)
       + (SELECT COUNT(*) FROM digest_event_refs)`,
    'DROP TABLE digest_event_refs',
    'DROP TABLE watch_digests',
    'DROP TABLE digest_schedules',
    `CREATE TABLE digest_change_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
)`,
    'INSERT INTO digest_change_state (id, last_sequence) VALUES (1, 0)',
    `CREATE TABLE digest_change_journal (
  sequence INTEGER PRIMARY KEY CHECK (sequence >= 1),
  observation_id TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','expired','user-deleted'))
)`,
    `INSERT INTO digest_change_journal
  (sequence, observation_id, event_id, source_id, observed_at, status)
  SELECT ROW_NUMBER() OVER (
    ORDER BY o.observed_at ASC, e.first_observed_at ASC, e.id ASC,
      o.sequence ASC, o.id ASC
  ), o.id, o.event_id, e.source_id, o.observed_at, 'active'
  FROM watch_event_observations o
  JOIN watch_events e ON e.id = o.event_id`,
    `UPDATE digest_change_state
  SET last_sequence = COALESCE((SELECT MAX(sequence) FROM digest_change_journal), 0)
  WHERE id = 1`,
    'CREATE INDEX idx_digest_change_journal_event ON digest_change_journal(event_id, sequence)',
    'CREATE INDEX idx_digest_change_journal_source ON digest_change_journal(source_id, sequence)',
    `CREATE TABLE digest_schedules (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version >= 1),
  source_ids_json TEXT NOT NULL,
  schedule_json TEXT NOT NULL,
  ai_enabled INTEGER NOT NULL CHECK (ai_enabled IN (0,1)),
  cursor_sequence INTEGER NOT NULL CHECK (cursor_sequence >= 0),
  state TEXT NOT NULL CHECK (state IN ('active','paused')),
  next_due_at TEXT NOT NULL,
  last_consumed_scheduled_for TEXT,
  last_daily_local_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_checked_at TEXT,
  last_period_json TEXT,
  last_run_stats_json TEXT,
  CHECK (created_at <= updated_at),
  CHECK ((last_consumed_scheduled_for IS NULL) = (last_daily_local_date IS NULL)),
  CHECK ((last_checked_at IS NULL) = (last_period_json IS NULL)
    AND (last_checked_at IS NULL) = (last_run_stats_json IS NULL))
)`,
    'CREATE INDEX idx_digest_schedules_state_due ON digest_schedules(state, next_due_at)',
    `CREATE TABLE digest_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES digest_schedules(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL UNIQUE,
  logical_date TEXT NOT NULL,
  lower_sequence INTEGER NOT NULL CHECK (lower_sequence >= 0),
  upper_sequence INTEGER NOT NULL CHECK (upper_sequence >= lower_sequence),
  next_sequence INTEGER NOT NULL CHECK (next_sequence >= lower_sequence AND next_sequence <= upper_sequence),
  period_json TEXT NOT NULL,
  run_stats_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','budget_exceeded','completed')),
  blocked_at TEXT,
  blocked_required_bytes INTEGER,
  blocked_available_bytes INTEGER,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (schedule_id, logical_date),
  CHECK (
    (state = 'running' AND blocked_at IS NULL AND blocked_required_bytes IS NULL
      AND blocked_available_bytes IS NULL AND finished_at IS NULL)
    OR (state = 'budget_exceeded' AND next_sequence < upper_sequence
      AND blocked_at IS NOT NULL AND blocked_required_bytes IS NOT NULL
      AND blocked_available_bytes IS NOT NULL AND blocked_required_bytes >= 0
      AND blocked_available_bytes >= 0 AND blocked_required_bytes > blocked_available_bytes
      AND finished_at IS NULL)
    OR (state = 'completed' AND next_sequence = upper_sequence
      AND blocked_at IS NULL AND blocked_required_bytes IS NULL
      AND blocked_available_bytes IS NULL AND finished_at IS NOT NULL)
  )
)`,
    `CREATE UNIQUE INDEX idx_digest_runs_nonterminal_schedule
  ON digest_runs(schedule_id) WHERE state IN ('running','budget_exceeded')`,
    `CREATE TABLE watch_digests (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES digest_schedules(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES digest_runs(id) ON DELETE CASCADE,
  batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
  first_sequence INTEGER NOT NULL CHECK (first_sequence >= 1),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= first_sequence),
  facts_json TEXT NOT NULL,
  facts_hash TEXT NOT NULL CHECK (length(facts_hash) = 64 AND facts_hash NOT GLOB '*[^0-9a-f]*'),
  facts_revision INTEGER NOT NULL CHECK (facts_revision >= 1),
  explanation_json TEXT,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0 AND byte_length <= 65536),
  provider_state TEXT NOT NULL CHECK (provider_state IN ('disabled','pending','claimed','succeeded','failed','uncertain','skipped')),
  provider_result_code TEXT CHECK (provider_result_code IN ('disabled','success','provider-error','timeout','aborted','invalid-output','uncertain-after-restart','no-visible-events','request-budget','key-unavailable') OR provider_result_code IS NULL),
  claimed_facts_revision INTEGER,
  claimed_facts_hash TEXT CHECK (claimed_facts_hash IS NULL OR
    (length(claimed_facts_hash) = 64 AND claimed_facts_hash NOT GLOB '*[^0-9a-f]*')),
  claimed_at TEXT,
  provider_finished_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, batch_index),
  CHECK (
    (provider_state = 'disabled' AND provider_result_code = 'disabled'
      AND claimed_at IS NULL AND claimed_facts_revision IS NULL AND claimed_facts_hash IS NULL
      AND provider_finished_at IS NOT NULL AND explanation_json IS NULL)
    OR (provider_state = 'pending' AND provider_result_code IS NULL
      AND claimed_at IS NULL AND claimed_facts_revision IS NULL AND claimed_facts_hash IS NULL
      AND provider_finished_at IS NULL AND explanation_json IS NULL)
    OR (provider_state = 'claimed' AND provider_result_code IS NULL
      AND claimed_at IS NOT NULL AND claimed_facts_revision >= 1 AND length(claimed_facts_hash) = 64
      AND provider_finished_at IS NULL AND explanation_json IS NULL)
    OR (provider_state = 'succeeded' AND provider_result_code = 'success'
      AND claimed_at IS NOT NULL AND claimed_facts_revision >= 1 AND length(claimed_facts_hash) = 64
      AND provider_finished_at IS NOT NULL
      AND (explanation_json IS NOT NULL OR facts_revision > claimed_facts_revision))
    OR (provider_state = 'failed' AND provider_result_code IN ('provider-error','timeout','aborted','invalid-output')
      AND claimed_at IS NOT NULL AND claimed_facts_revision >= 1 AND length(claimed_facts_hash) = 64
      AND provider_finished_at IS NOT NULL AND explanation_json IS NULL)
    OR (provider_state = 'uncertain' AND provider_result_code = 'uncertain-after-restart'
      AND claimed_at IS NOT NULL AND claimed_facts_revision >= 1 AND length(claimed_facts_hash) = 64
      AND provider_finished_at IS NOT NULL AND explanation_json IS NULL)
    OR (provider_state = 'skipped' AND provider_result_code IN ('no-visible-events','request-budget','key-unavailable')
      AND claimed_at IS NULL AND claimed_facts_revision IS NULL AND claimed_facts_hash IS NULL
      AND provider_finished_at IS NOT NULL AND explanation_json IS NULL)
  ),
  CHECK (claimed_facts_revision IS NULL OR facts_revision >= claimed_facts_revision),
  CHECK (claimed_at IS NULL OR created_at <= claimed_at),
  CHECK (provider_finished_at IS NULL OR created_at <= provider_finished_at),
  CHECK (claimed_at IS NULL OR provider_finished_at IS NULL OR claimed_at <= provider_finished_at)
)`,
    'CREATE INDEX idx_watch_digests_schedule ON watch_digests(schedule_id, created_at)',
    `CREATE TABLE digest_event_refs (
  digest_id TEXT NOT NULL REFERENCES watch_digests(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','expired','user-deleted')),
  PRIMARY KEY (digest_id, event_id)
) WITHOUT ROWID`,
    'CREATE INDEX idx_digest_event_refs_event ON digest_event_refs(event_id, status)',
    'DROP TABLE watch_v4_digest_guard',
  ],
};

// D9 schema v5：只追加 Rule 用户配置 CAS 与通知详情 opt-in。V1-v4 字节冻结。
export const WATCH_MIGRATION_V5: MigrationStep = {
  version: 5,
  statements: [
    'ALTER TABLE watch_rules ADD COLUMN rule_version INTEGER NOT NULL DEFAULT 1 CHECK(rule_version >= 1)',
    'ALTER TABLE watch_rules ADD COLUMN notification_show_details INTEGER NOT NULL DEFAULT 0 CHECK(notification_show_details IN (0,1))',
  ],
};

export const WATCH_MIGRATIONS: readonly MigrationStep[] = [
  WATCH_MIGRATION_V1,
  WATCH_MIGRATION_V2,
  WATCH_MIGRATION_V3,
  WATCH_MIGRATION_V4,
  WATCH_MIGRATION_V5,
];

// 薄封装：固定使用 Watch 独立迁移列表（引擎复用 B1 冻结模式）
export function runWatchMigrations(handle: DbHandle): ReturnType<typeof runMigrations> {
  return runMigrations(handle, WATCH_MIGRATIONS);
}
