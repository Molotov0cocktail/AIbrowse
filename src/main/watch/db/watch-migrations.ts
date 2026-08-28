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
// - 外键打开；删除 Rule CASCADE baseline/runs/events/outbox，audits 用
//   SET NULL（级联删除审计需在 Rule 消失后存活）；Event CASCADE items；
// - digest_event_refs.event_id 无外键：§10.1「Digest 对 Event 使用 tombstone
//   状态而非丢失引用真实性」——Event 行删除后 ref 必须保留并置 expired，
//   外键 CASCADE/RESTRICT 都无法承载该语义（注释记录，非遗漏）；
// - watch_runs.status 为 D5 reservation 前向兼容列（queued/running/interrupted/
//   finished）——§3.3 WatchRun DTO 无 status，schema v1 补充承载（FIXED
//   DECISION 9）；outcome_json/health_json 经共享 validator 读回二次校验。
import { runMigrations, type MigrationStep } from '../../sources/db/migrations';
import type { DbHandle } from '../../sources/db/sqlite-driver';

export type { MigrationStep } from '../../sources/db/migrations';

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
  rule_id TEXT REFERENCES watch_rules(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('lifecycle-pause','lifecycle-cascade','reconciliation')),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('source-disabled','source-deleted','source-changed','hard-delete','undo-source-removed','complete','aborted')),
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

export const WATCH_MIGRATIONS: readonly MigrationStep[] = [WATCH_MIGRATION_V1];

// 薄封装：固定使用 Watch 独立迁移列表（引擎复用 B1 冻结模式）
export function runWatchMigrations(handle: DbHandle): ReturnType<typeof runMigrations> {
  return runMigrations(handle, WATCH_MIGRATIONS);
}
