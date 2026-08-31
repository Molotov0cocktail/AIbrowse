// D4 watch-migrations tests: schema v1 契约断言（detailed-design §10.1）——
// 11 表全表集、索引、外键、CHECK、UNIQUE、user_version=1、注入串仅作数据、
// CASCADE/SET NULL 布线、未知更高版本零写入、重复运行幂等。真实 node:sqlite。
// D5 #S6-044：追加 v2 契约断言（watch_audits CHECK 扩展，FIXED 14/15/17）——
// 恰 3 处机械校准：列表长度 1→2、新库 toVersion 1→2、future-probe 常量 2→3。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, closeDb, type DbHandle } from '../../sources/db/sqlite-driver';
import { runMigrations } from '../../sources/db/migrations';
import {
  WATCH_AUDIT_KINDS,
  WATCH_AUDIT_REASON_CODES,
  WATCH_MIGRATIONS,
  WATCH_MIGRATION_V1,
  WATCH_MIGRATION_V2,
  WATCH_MIGRATION_V3,
  runWatchMigrations,
} from './watch-migrations';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-watch-mig-'));

let handle: DbHandle;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  handle = openDb(join(root, `mig-${Math.random().toString(36).slice(2)}.db`));
});

afterEach(() => {
  closeDb(handle);
});

function tableNames(db: DbHandle): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>
  )
    .map((r) => r.name)
    .filter((n) => !n.startsWith('sqlite_'))
    .sort();
}

function indexNames(db: DbHandle): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
      name: string;
    }>
  )
    .map((r) => r.name)
    .filter((n) => !n.startsWith('sqlite_'))
    .sort();
}

// 最小合法 rule 行（migration 测试直插 SQL，不经 Repository——仅验证 schema）
function insertRule(db: DbHandle, id: string, kind = 'feed'): void {
  db.prepare(
    `INSERT INTO watch_rules
  (id, source_id, kind, state, pause_reason, desired_enabled, muted, access_mode,
   schedule_json, target_json, condition_json, notification_level,
   source_row_version, source_locator_fingerprint, next_due_at,
   last_consumed_scheduled_for, last_daily_local_date, consecutive_failures,
   backoff_until, baseline_version, created_at, updated_at)
  VALUES (?, 'src-1', ?, 'enabled', NULL, 1, 0, 'public',
   '{"kind":"interval","intervalMinutes":60}',
   '{"type":"feed","feedUrl":"https://example.com/rss.xml","format":"rss2"}',
   NULL, 'normal', 1,
   '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
   NULL, NULL, NULL, 0, NULL, 0,
   '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`,
  ).run(id, kind);
}

describe('migration v1 契约断言（§10.1：11 张表；D7 v3 +1 = 12 张表）', () => {
  it('v1+v2+v3 三级、版本连续、语句全部编译期常量', () => {
    expect(WATCH_MIGRATION_V1.version).toBe(1);
    expect(WATCH_MIGRATION_V2.version).toBe(2);
    expect(WATCH_MIGRATIONS).toHaveLength(3);
    expect(WATCH_MIGRATIONS.map((s) => s.version)).toEqual([1, 2, 3]);
    expect(
      WATCH_MIGRATION_V1.statements.every((s) => typeof s === 'string') &&
        WATCH_MIGRATION_V2.statements.every((s) => typeof s === 'string') &&
        WATCH_MIGRATION_V3.statements.every((s) => typeof s === 'string'),
    ).toBe(true);
    // R3-3：v3 语句数 21（含 watch_baselines_v3 的条件 validator CHECK 内嵌）——
    // M0-9 逐语句失败注入按此固定语句数全部切点执行
    expect(WATCH_MIGRATION_V3.statements).toHaveLength(21);
  });

  it('运行后 user_version=3 且 12 张表全部存在（D7 新增 watch_event_observations）', () => {
    const outcome = runWatchMigrations(handle);
    expect(outcome.ok).toBe(true);
    expect(outcome.toVersion).toBe(3);
    expect(tableNames(handle)).toEqual([
      'digest_event_refs',
      'digest_schedules',
      'notification_outbox',
      'source_cleanup_intents',
      'watch_audits',
      'watch_baselines',
      'watch_digests',
      'watch_event_items',
      'watch_event_observations',
      'watch_events',
      'watch_rules',
      'watch_runs',
    ]);
  });

  it('全部契约索引存在（D7 +2：observations_event / items_item）', () => {
    runWatchMigrations(handle);
    expect(indexNames(handle)).toEqual([
      'idx_notification_outbox_rule',
      'idx_notification_outbox_subject',
      'idx_source_cleanup_intents_source',
      'idx_watch_audits_rule',
      'idx_watch_digests_schedule',
      'idx_watch_event_items_event',
      'idx_watch_event_items_item',
      'idx_watch_event_observations_event',
      'idx_watch_events_rule',
      'idx_watch_events_source',
      'idx_watch_rules_source',
      'idx_watch_rules_state_due',
      'idx_watch_runs_rule',
      'idx_watch_runs_status',
    ]);
  });

  it('重复运行幂等（up-to-date）', () => {
    runWatchMigrations(handle);
    const again = runWatchMigrations(handle);
    expect(again.state).toBe('up-to-date');
    expect(again.ok).toBe(true);
  });

  it('未知更高版本零写入（newer-than-program；latest=3 → 4 为未来版本）', () => {
    handle.exec('PRAGMA user_version = 4');
    const outcome = runWatchMigrations(handle);
    expect(outcome.ok).toBe(false);
    expect(outcome.state).toBe('newer-than-program');
    expect(tableNames(handle)).toEqual([]);
  });
});

describe('CHECK 约束数据库层强制（§10.1 枚举列）', () => {
  beforeEach(() => {
    runWatchMigrations(handle);
  });

  it('watch_rules state/kind/access_mode 非法值被 CHECK 拒绝', () => {
    const insertState = (state: string) =>
      handle
        .prepare(
          `INSERT INTO watch_rules (id, source_id, kind, state, desired_enabled, muted,
   access_mode, schedule_json, target_json, notification_level,
   source_row_version, source_locator_fingerprint, consecutive_failures,
   baseline_version, created_at, updated_at)
  VALUES ('r1','s1','feed',?,1,0,'public','{"kind":"interval","intervalMinutes":60}',
   '{"type":"feed","feedUrl":"https://example.com/rss.xml","format":"rss2"}',
   'normal',1,'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',0,0,
   '2026-08-28T00:00:00.000Z','2026-08-28T00:00:00.000Z')`,
        )
        .run(state);
    expect(() => insertState('bogus')).toThrow();
    insertState('deleted');
    expect(() =>
      handle
        .prepare(
          `INSERT INTO watch_rules (id, source_id, kind, state, desired_enabled, muted,
   access_mode, schedule_json, target_json, notification_level,
   source_row_version, source_locator_fingerprint, consecutive_failures,
   baseline_version, created_at, updated_at)
  VALUES ('r2','s1','session','enabled',1,0,'public','{"kind":"interval","intervalMinutes":60}',
   '{}','normal',1,'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',0,0,
   '2026-08-28T00:00:00.000Z','2026-08-28T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow();
  });

  it('source_locator_fingerprint 必须 64 hex（长度 CHECK）', () => {
    expect(() =>
      handle
        .prepare(
          `INSERT INTO watch_rules (id, source_id, kind, state, desired_enabled, muted,
   access_mode, schedule_json, target_json, notification_level,
   source_row_version, source_locator_fingerprint, consecutive_failures,
   baseline_version, created_at, updated_at)
  VALUES ('r1','s1','feed','enabled',1,0,'public','{"kind":"interval","intervalMinutes":60}',
   '{"type":"feed","feedUrl":"https://example.com/rss.xml","format":"rss2"}',
   'normal',1,'short',0,0,'2026-08-28T00:00:00.000Z','2026-08-28T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow();
  });

  it('watch_runs status/trigger 非法值被 CHECK 拒绝', () => {
    insertRule(handle, 'r1');
    const insertRun = (id: string, key: string, status: string, trigger: string) =>
      handle
        .prepare(
          `INSERT INTO watch_runs (id, rule_id, request_key, status, trigger)
  VALUES (?, 'r1', ?, ?, ?)`,
        )
        .run(id, key, status, trigger);
    expect(() => insertRun('run-x', 'kx', 'weird', 'scheduled')).toThrow();
    expect(() => insertRun('run-y', 'ky', 'queued', 'cron')).toThrow();
    insertRun('run1', 'k1', 'queued', 'scheduled');
    insertRun('run2', 'k2', 'interrupted', 'catch-up');
    insertRun('run3', 'k3', 'finished', 'manual');
  });

  it('watch_audits kind/reason_code 非法值被 CHECK 拒绝；baseline 审计类型放行', () => {
    let seq = 0;
    const insertAudit = (kind: string, reasonCode: string) =>
      handle
        .prepare(
          `INSERT INTO watch_audits (id, rule_id, kind, reason_code, created_at)
  VALUES (?, NULL, ?, ?, '2026-08-28T00:00:00.000Z')`,
        )
        .run(`a-${seq++}`, kind, reasonCode);
    expect(() => insertAudit('other', 'complete')).toThrow();
    expect(() => insertAudit('reconciliation', 'other')).toThrow();
    insertAudit('reconciliation', 'complete');
    // §9.1：首次成功只写 Baseline + baseline-established audit；手动 rebaseline 记录原因
    insertAudit('baseline-established', 'baseline-established');
    insertAudit('rebaseline', 'rebaseline');
  });

  it('watch_events event_kind/importance 非法值被 CHECK 拒绝', () => {
    insertRule(handle, 'r1');
    const insertEvent = (kind: string, importance: string) =>
      handle
        .prepare(
          `INSERT INTO watch_events (id, rule_id, source_id, event_kind, importance,
   idempotency_key, change_fingerprint, first_observed_at, last_observed_at, item_count)
  VALUES ('e1','r1','s1',?,?, 'ik1','fp1','2026-08-28T00:00:00.000Z',
   '2026-08-28T00:00:00.000Z', 1)`,
        )
        .run(kind, importance);
    expect(() => insertEvent('weird', 'normal')).toThrow();
    expect(() => insertEvent('added', 'critical')).toThrow();
    insertEvent('mixed', 'important');
  });

  it('watch_baselines byte_length 上限 CHECK（≤65536）', () => {
    insertRule(handle, 'r1');
    expect(() =>
      handle
        .prepare(
          `INSERT INTO watch_baselines (rule_id, version, projection_type, projection_json,
   content_hash, byte_length, final_url, captured_at)
  VALUES ('r1', 1, 'feed', '{}', 'h', 65537, 'https://example.com', '2026-08-28T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow();
  });

  // R3-3：schema v3 watch_baselines 条件 validator 纵深 CHECK——非 null 值 BLOB 字节
  // ≤1024（多字节按 bytes 判定）、projection_type='page' 时两列恒 null。直接 SQL 敌手
  // 测试证明数据库层拒绝超限字段与 Page 非 null。
  it('R3-3 watch_baselines 条件 validator CHECK：超限字段（1024 接受/1025 拒绝）', () => {
    insertRule(handle, 'r1');
    const etag1024 = 'a'.repeat(1024);
    handle
      .prepare(
        `INSERT INTO watch_baselines (rule_id, version, projection_type, projection_json,
   content_hash, byte_length, final_url, captured_at, conditional_etag)
  VALUES ('r1', 1, 'feed', '{}', 'h', 2, 'https://example.com', '2026-08-28T00:00:00.000Z', ?)`,
      )
      .run(etag1024);
    insertRule(handle, 'r2');
    expect(() =>
      handle
        .prepare(
          `INSERT INTO watch_baselines (rule_id, version, projection_type, projection_json,
   content_hash, byte_length, final_url, captured_at, conditional_etag)
  VALUES ('r2', 1, 'feed', '{}', 'h', 2, 'https://example.com', '2026-08-28T00:00:00.000Z', ?)`,
        )
        .run('a'.repeat(1025)),
    ).toThrow();
    // 多字节：342×3=1026 字节超限被 CHECK 拒绝（LENGTH(CAST(... AS BLOB)) 按字节）
    insertRule(handle, 'r3');
    expect(() =>
      handle
        .prepare(
          `INSERT INTO watch_baselines (rule_id, version, projection_type, projection_json,
   content_hash, byte_length, final_url, captured_at, conditional_last_modified)
  VALUES ('r3', 1, 'feed', '{}', 'h', 2, 'https://example.com', '2026-08-28T00:00:00.000Z', ?)`,
        )
        .run('你'.repeat(342)),
    ).toThrow();
    // 341×3+1=1024 字节接受
    insertRule(handle, 'r4');
    handle
      .prepare(
        `INSERT INTO watch_baselines (rule_id, version, projection_type, projection_json,
   content_hash, byte_length, final_url, captured_at, conditional_last_modified)
  VALUES ('r4', 1, 'feed', '{}', 'h', 2, 'https://example.com', '2026-08-28T00:00:00.000Z', ?)`,
      )
      .run('你'.repeat(341) + 'a');
  });

  it('R3-3 watch_baselines 条件 validator CHECK：page 两列恒 null（直接 SQL 拒绝非 null）', () => {
    insertRule(handle, 'p1', 'page');
    expect(() =>
      handle
        .prepare(
          `INSERT INTO watch_baselines (rule_id, version, projection_type, projection_json,
   content_hash, byte_length, final_url, captured_at, conditional_etag)
  VALUES ('p1', 1, 'page', '{"type":"page","fields":[]}', 'h', 30, 'https://example.com',
   '2026-08-28T00:00:00.000Z', '"x"')`,
        )
        .run(),
    ).toThrow();
    insertRule(handle, 'p2', 'page');
    expect(() =>
      handle
        .prepare(
          `INSERT INTO watch_baselines (rule_id, version, projection_type, projection_json,
   content_hash, byte_length, final_url, captured_at, conditional_last_modified)
  VALUES ('p2', 1, 'page', '{"type":"page","fields":[]}', 'h', 30, 'https://example.com',
   '2026-08-28T00:00:00.000Z', 'x')`,
        )
        .run(),
    ).toThrow();
    // page 两列均 null 接受
    insertRule(handle, 'p3', 'page');
    handle
      .prepare(
        `INSERT INTO watch_baselines (rule_id, version, projection_type, projection_json,
   content_hash, byte_length, final_url, captured_at)
  VALUES ('p3', 1, 'page', '{"type":"page","fields":[]}', 'h', 30, 'https://example.com',
   '2026-08-28T00:00:00.000Z')`,
      )
      .run();
  });

  it('source_cleanup_intents operation/state 非法值被 CHECK 拒绝', () => {
    const insertIntent = (operation: string, state: string) =>
      handle
        .prepare(
          `INSERT INTO source_cleanup_intents (mutation_id, source_id, operation,
   before_projection_json, after_projection_json, affected_rule_state_json,
   state, created_at, updated_at)
  VALUES ('m1','s1',?, NULL, NULL, '{}', ?, '2026-08-28T00:00:00.000Z',
   '2026-08-28T00:00:00.000Z')`,
        )
        .run(operation, state);
    expect(() => insertIntent('purge', 'prepared')).toThrow();
    expect(() => insertIntent('update', 'committed')).toThrow();
    insertIntent('hard-delete', 'source-committed');
  });

  it('digest_event_refs status 非法值被 CHECK 拒绝', () => {
    handle
      .prepare(
        `INSERT INTO digest_schedules (id, source_ids_json, schedule_json, ai_enabled, state,
   created_at, updated_at)
  VALUES ('ds1','[]','{"kind":"daily","localTime":"09:00","timeZone":"Asia/Shanghai"}',1,
   'active','2026-08-28T00:00:00.000Z','2026-08-28T00:00:00.000Z')`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO watch_digests (id, schedule_id, facts_json, byte_length, created_at)
  VALUES ('d1','ds1','{}',2,'2026-08-28T00:00:00.000Z')`,
      )
      .run();
    expect(() =>
      handle
        .prepare(
          `INSERT INTO digest_event_refs (digest_id, event_id, status)
  VALUES ('d1','e1','weird')`,
        )
        .run(),
    ).toThrow();
    handle
      .prepare(
        `INSERT INTO digest_event_refs (digest_id, event_id, status)
  VALUES ('d1','e1','active')`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO digest_event_refs (digest_id, event_id, status)
  VALUES ('d1','e2','expired')`,
      )
      .run();
  });

  it('notification_outbox subject_type/channel/state 非法值被 CHECK 拒绝', () => {
    const insertOutbox = (subjectType: string, channel: string, state: string) =>
      handle
        .prepare(
          `INSERT INTO notification_outbox (id, subject_type, subject_id, channel, dedupe_key,
   privacy_json, state, attempts, created_at, updated_at)
  VALUES ('o1',?, 's1', ?, 'dk1', '{}', ?, 0, '2026-08-28T00:00:00.000Z',
   '2026-08-28T00:00:00.000Z')`,
        )
        .run(subjectType, channel, state);
    expect(() => insertOutbox('rule', 'in-app', 'pending')).toThrow();
    expect(() => insertOutbox('event', 'email', 'pending')).toThrow();
    expect(() => insertOutbox('event', 'in-app', 'done')).toThrow();
    insertOutbox('digest', 'windows', 'uncertain');
  });
});

describe('外键与 UNIQUE（§10.1：外键打开）', () => {
  beforeEach(() => {
    runWatchMigrations(handle);
  });

  it('watch_runs.rule_id 外键拒绝不存在的规则', () => {
    expect(() =>
      handle
        .prepare(
          `INSERT INTO watch_runs (id, rule_id, request_key, status, trigger)
  VALUES ('run1','ghost','k1','queued','scheduled')`,
        )
        .run(),
    ).toThrow();
  });

  it('request_key/idempotency_key/dedupe_key UNIQUE 约束生效', () => {
    insertRule(handle, 'r1');
    const insertRun = (id: string, key: string) =>
      handle
        .prepare(
          `INSERT INTO watch_runs (id, rule_id, request_key, status, trigger)
  VALUES (?, 'r1', ?, 'queued', 'scheduled')`,
        )
        .run(id, key);
    insertRun('run1', 'k1');
    expect(() => insertRun('run2', 'k1')).toThrow();
  });

  it('删除 Rule CASCADE baselines/runs/events/outbox/audits（§10.1）', () => {
    insertRule(handle, 'r1');
    handle
      .prepare(
        `INSERT INTO watch_baselines (rule_id, version, projection_type, projection_json,
   content_hash, byte_length, final_url, captured_at)
   VALUES ('r1',1,'feed','{}','h',2,'https://example.com','2026-08-28T00:00:00.000Z')`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO watch_runs (id, rule_id, request_key, status, trigger)
   VALUES ('run1','r1','k1','queued','scheduled')`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO watch_events (id, rule_id, source_id, event_kind, importance,
   idempotency_key, change_fingerprint, first_observed_at, last_observed_at, item_count)
   VALUES ('e1','r1','s1','added','normal','ik1','fp1','2026-08-28T00:00:00.000Z',
    '2026-08-28T00:00:00.000Z',1)`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO watch_event_observations (id, event_id, sequence, idempotency_key,
   change_fingerprint, event_kind, observed_at, first_item_sequence, item_count)
   VALUES ('obs1','e1',0,'ik1','fp1','added','2026-08-28T00:00:00.000Z',0,1)`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO watch_event_items (id, event_id, sequence, observation_id,
   observation_item_sequence, item_id, field_key, label,
   before_value_json, after_value_json, before_captured_at, after_captured_at,
   before_final_url, after_final_url)
   VALUES ('i1','e1',0,'obs1',0,'it1','title','标题','{"kind":"absent"}',
    '{"kind":"present","excerpt":"新","valueHash":"h","normalizedBytes":3,"truncated":false}',
    '2026-08-28T00:00:00.000Z','2026-08-28T00:00:00.000Z',
    'https://example.com','https://example.com')`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO notification_outbox (id, rule_id, subject_type, subject_id, channel,
   dedupe_key, privacy_json, state, attempts, created_at, updated_at)
   VALUES ('o1','r1','event','e1','in-app','dk1','{}','pending',0,
    '2026-08-28T00:00:00.000Z','2026-08-28T00:00:00.000Z')`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO watch_audits (id, rule_id, kind, reason_code, created_at)
   VALUES ('a1','r1','lifecycle-pause','source-disabled','2026-08-28T00:00:00.000Z')`,
      )
      .run();
    handle.prepare('DELETE FROM watch_rules WHERE id = ?').run('r1');
    const count = (table: string): unknown =>
      handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    expect(count('watch_baselines')).toEqual({ n: 0 });
    expect(count('watch_runs')).toEqual({ n: 0 });
    expect(count('watch_events')).toEqual({ n: 0 });
    expect(count('watch_event_items')).toEqual({ n: 0 });
    expect(count('notification_outbox')).toEqual({ n: 0 });
    // audits CASCADE：与规则绑定生命周期审计随规则删除；级联删除审计以 rule_id=null 存活
    expect(count('watch_audits')).toEqual({ n: 0 });
  });

  it('watch_audits rule_id 为 NULL 的审计在规则删除后存活（级联审计可追溯载体）', () => {
    insertRule(handle, 'r1');
    handle
      .prepare(
        `INSERT INTO watch_audits (id, rule_id, kind, reason_code, created_at)
   VALUES ('a-null', NULL, 'lifecycle-cascade','hard-delete','2026-08-28T00:00:00.000Z')`,
      )
      .run();
    handle.prepare('DELETE FROM watch_rules WHERE id = ?').run('r1');
    expect(handle.prepare('SELECT COUNT(*) AS n FROM watch_audits').get()).toEqual({ n: 1 });
  });

  it('Event CASCADE items；digest_event_refs.event_id 无外键（tombstone 存活）', () => {
    insertRule(handle, 'r1');
    handle
      .prepare(
        `INSERT INTO watch_events (id, rule_id, source_id, event_kind, importance,
   idempotency_key, change_fingerprint, first_observed_at, last_observed_at, item_count)
  VALUES ('e1','r1','s1','added','normal','ik1','fp1','2026-08-28T00:00:00.000Z',
   '2026-08-28T00:00:00.000Z',1)`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO watch_event_observations (id, event_id, sequence, idempotency_key,
   change_fingerprint, event_kind, observed_at, first_item_sequence, item_count)
  VALUES ('obs1','e1',0,'ik1','fp1','added','2026-08-28T00:00:00.000Z',0,1)`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO watch_event_items (id, event_id, sequence, observation_id,
   observation_item_sequence, item_id, field_key, label,
   before_value_json, after_value_json, before_captured_at, after_captured_at,
   before_final_url, after_final_url)
  VALUES ('i1','e1',0,'obs1',0,'it1','title','标题','{"kind":"absent"}','{"kind":"absent"}',
   '2026-08-28T00:00:00.000Z','2026-08-28T00:00:00.000Z',
   'https://example.com','https://example.com')`,
      )
      .run();
    handle.prepare('DELETE FROM watch_events WHERE id = ?').run('e1');
    expect(handle.prepare('SELECT COUNT(*) AS n FROM watch_event_items').get()).toEqual({
      n: 0,
    });
    expect(handle.prepare('SELECT COUNT(*) AS n FROM watch_event_observations').get()).toEqual({
      n: 0,
    });
    // digest ref 无外键：Event 删除后 ref 行仍存在（由 Repository 置 expired）
    handle
      .prepare(
        `INSERT INTO digest_schedules (id, source_ids_json, schedule_json, ai_enabled, state,
   created_at, updated_at)
  VALUES ('ds1','[]','{"kind":"daily","localTime":"09:00","timeZone":"Asia/Shanghai"}',1,
   'active','2026-08-28T00:00:00.000Z','2026-08-28T00:00:00.000Z')`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO watch_digests (id, schedule_id, facts_json, byte_length, created_at)
  VALUES ('d1','ds1','{}',2,'2026-08-28T00:00:00.000Z')`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO digest_event_refs (digest_id, event_id, status)
  VALUES ('d1','e1','active')`,
      )
      .run();
    handle.prepare('DELETE FROM watch_events WHERE id = ?').run('e1');
    expect(
      handle.prepare('SELECT COUNT(*) AS n FROM digest_event_refs WHERE event_id = ?').get('e1'),
    ).toEqual({ n: 1 });
  });
});

describe('SQL 注入串仅作数据（§10.1 参数绑定）', () => {
  it('敌手串（DROP/表名/分号）经参数绑定只落为字段值', () => {
    runWatchMigrations(handle);
    const injection = "'; DROP TABLE watch_rules;--";
    handle
      .prepare(
        `INSERT INTO watch_rules (id, source_id, kind, state, desired_enabled, muted,
   access_mode, schedule_json, target_json, notification_level,
   source_row_version, source_locator_fingerprint, consecutive_failures,
   baseline_version, created_at, updated_at)
  VALUES (?, ?, 'feed','enabled',1,0,'public','{"kind":"interval","intervalMinutes":60}',
   ?, 'normal',1,'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',0,0,
   '2026-08-28T00:00:00.000Z','2026-08-28T00:00:00.000Z')`,
      )
      .run('inj-1', injection, injection);
    const row = handle
      .prepare('SELECT source_id, target_json FROM watch_rules WHERE id = ?')
      .get('inj-1') as { source_id: string; target_json: string };
    expect(row.source_id).toBe(injection);
    expect(row.target_json).toBe(injection);
    expect(tableNames(handle).length).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// D5 #S6-044 M0：schema v2（watch_audits CHECK 扩展；FIXED 14/15）——
// 重建结构、单一事实源白名单、CHECK 放行/拒绝矩阵、索引/级联重建陷阱。
// ---------------------------------------------------------------------------

// 从 sqlite_master.sql 中解析表定义的 CHECK IN (...) 值集合（纯测试工具）。
function checkValuesFromTableSql(sql: string, column: string): string[] {
  const columnStart = sql.indexOf(`${column} TEXT NOT NULL CHECK`);
  const check = sql.slice(columnStart);
  const inIdx = check.indexOf('IN (');
  if (inIdx === -1) throw new Error('CHECK IN 解析失败');
  const open = inIdx + 'IN ('.length - 1;
  const close = check.indexOf(')', open);
  if (open === -1 || close === -1 || close <= open) throw new Error('CHECK IN 解析失败');
  return check
    .slice(open + 1, close)
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''));
}

describe('migration v2 契约断言（#S6-044 FIXED 14/15：watch_audits CHECK 扩展）', () => {
  it('v2 以表重建扩展 CHECK：新建 _v2 → 复制 → DROP → RENAME → 重建索引', () => {
    const stmts = WATCH_MIGRATION_V2.statements;
    expect(stmts.length).toBe(5);
    expect(stmts[0]).toMatch(/CREATE TABLE watch_audits_v2/);
    expect(stmts[1]).toMatch(/INSERT INTO watch_audits_v2/);
    expect(stmts[2]).toMatch(/DROP TABLE watch_audits/);
    expect(stmts[3]).toMatch(/ALTER TABLE watch_audits_v2 RENAME TO watch_audits/);
    expect(stmts[4]).toMatch(/CREATE INDEX idx_watch_audits_rule/);
    // 重建仅触碰 watch_audits：不得包含其它表的 CREATE/DROP（防越界）
    for (const s of stmts) {
      expect(s).not.toMatch(/CREATE TABLE (?!watch_audits_v2)/);
      expect(s).not.toMatch(/DROP TABLE (?!watch_audits)/);
    }
  });

  it('审计编码单一事实源：kind=6、reason=24（D7 v3 追加），与 v3 生成的 CHECK 逐值一致', () => {
    expect(WATCH_AUDIT_KINDS).toEqual([
      'lifecycle-pause',
      'lifecycle-cascade',
      'reconciliation',
      'baseline-established',
      'rebaseline',
      'run',
    ]);
    expect(WATCH_AUDIT_REASON_CODES).toEqual([
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
      'changed-unmatched',
      'event-created',
      'event-coalesced',
      'event-deduplicated',
      'condition-error',
    ]);
    runWatchMigrations(handle);
    const sql = handle
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='watch_audits'")
      .get() as { sql: string };
    const kindCheck = checkValuesFromTableSql(sql.sql, 'kind');
    const reasonCheck = checkValuesFromTableSql(sql.sql, 'reason_code');
    // 单一事实源：DB CHECK 顺序与顺序必须与 TS 常量数组一致（防双写漂移）
    expect(kindCheck).toEqual([...WATCH_AUDIT_KINDS]);
    expect(reasonCheck).toEqual([...WATCH_AUDIT_REASON_CODES]);
  });

  it('v1 库插入新码 → CHECK 拒绝（冲突红态锚点）；v2 库白名单全放行、集合外拒绝', () => {
    // v1 锚点：只跑 v1，新码（run/unchanged）被 v1 冻结 CHECK 拒绝
    runMigrations(handle, [WATCH_MIGRATION_V1]);
    const insertV1 = (kind: string, reason: string): void => {
      handle
        .prepare(
          `INSERT INTO watch_audits (id, rule_id, kind, reason_code, created_at)
           VALUES ('a-x', NULL, ?, ?, '2026-08-28T00:00:00.000Z')`,
        )
        .run(kind, reason);
    };
    expect(() => insertV1('run', 'unchanged')).toThrow();
    expect(() => insertV1('lifecycle-pause', 'login-required')).toThrow();
    // 升级到 v2
    closeDb(handle);
    handle = openDb(handle.path);
    runWatchMigrations(handle);
    let seq = 0;
    const insertAudit = (kind: string, reason: string): void => {
      handle
        .prepare(
          `INSERT INTO watch_audits (id, rule_id, kind, reason_code, created_at)
           VALUES (?, NULL, ?, ?, '2026-08-28T00:00:00.000Z')`,
        )
        .run(`a-${seq++}`, kind, reason);
    };
    // 全部 6 kind × 19 reason 白名单值放行（CHECK 逐列独立验证）
    for (const kind of WATCH_AUDIT_KINDS) {
      for (const reason of WATCH_AUDIT_REASON_CODES) {
        insertAudit(kind, reason);
      }
    }
    // 集合外值（含 'other'/空串/大小写变体）拒绝
    expect(() => insertAudit('other', 'complete')).toThrow();
    expect(() => insertAudit('reconciliation', 'other')).toThrow();
    expect(() => insertAudit('', 'complete')).toThrow();
    expect(() => insertAudit('run', '')).toThrow();
    expect(() => insertAudit('RUN', 'unchanged')).toThrow();
    expect(() => insertAudit('run', 'Unavailable')).toThrow();
  });

  it('v3 后 14 索引恒等；重建后删除 Rule → 审计级联删除、rule_id=NULL 孤儿审计存活', () => {
    runWatchMigrations(handle);
    expect(indexNames(handle)).toEqual([
      'idx_notification_outbox_rule',
      'idx_notification_outbox_subject',
      'idx_source_cleanup_intents_source',
      'idx_watch_audits_rule',
      'idx_watch_digests_schedule',
      'idx_watch_event_items_event',
      'idx_watch_event_items_item',
      'idx_watch_event_observations_event',
      'idx_watch_events_rule',
      'idx_watch_events_source',
      'idx_watch_rules_source',
      'idx_watch_rules_state_due',
      'idx_watch_runs_rule',
      'idx_watch_runs_status',
    ]);
    insertRule(handle, 'r1');
    handle
      .prepare(
        `INSERT INTO watch_audits (id, rule_id, kind, reason_code, created_at)
         VALUES ('a-rule','r1','lifecycle-pause','source-disabled','2026-08-28T00:00:00.000Z')`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO watch_audits (id, rule_id, kind, reason_code, created_at)
         VALUES ('a-null', NULL, 'lifecycle-cascade','hard-delete','2026-08-28T00:00:00.000Z')`,
      )
      .run();
    handle.prepare('DELETE FROM watch_rules WHERE id = ?').run('r1');
    expect(handle.prepare('SELECT COUNT(*) AS n FROM watch_audits').get()).toEqual({ n: 1 });
    expect(handle.prepare("SELECT id FROM watch_audits WHERE id = 'a-null'").get()).toEqual({
      id: 'a-null',
    });
  });
});
