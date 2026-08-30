// D5 #S6-044 M0 store 级迁移矩阵（真实 node:sqlite，红→绿）：v1→v2 升级数据恒等、
// 迁移失败注入回滚、未来版本探针、迁移+恢复交互。完全复用 openWatchStore 装配路径
//（watch-store.ts 零改动；只消费新迁移列表）。FIXED 16/17。
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb, closeDb } from '../sources/db/sqlite-driver';
import { runMigrations, type MigrationStep } from '../sources/db/migrations';
import { WATCH_MIGRATION_V1, WATCH_MIGRATION_V2, WATCH_MIGRATION_V3 } from './db/watch-migrations';
import { openWatchStore, restoreWatchStore } from './watch-store';
import { WatchRepository } from './repository/watch-repository';
import { createConsistentBackup } from '../sources/db/backup';
import { computeSourceLocatorFingerprint } from '../../shared/watch/watch-rule-state';
import type { SourceWatchProjection, WatchEvent, WatchRule } from '../../shared/types/watch';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-watch-mig-store-'));
const NOW = '2026-08-28T00:00:00.000Z';

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeRule(sourceId = 'src-1'): WatchRule {
  return {
    id: randomUUID(),
    sourceId,
    kind: 'feed',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'public',
    schedule: { kind: 'interval', intervalMinutes: 60 },
    target: { type: 'feed', feedUrl: 'https://example.com/rss.xml', format: 'rss2' },
    condition: null,
    notificationLevel: 'normal',
    sourceRowVersion: 1,
    sourceLocatorFingerprint: computeSourceLocatorFingerprint({
      sourceId,
      scope: 'page',
      canonicalKey: 'https://example.com/doc',
      kind: 'feed',
      canonicalTargetUrl: 'https://example.com/rss.xml',
    }),
    nextDueAt: null,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeEvent(ruleId: string): WatchEvent {
  return {
    id: randomUUID(),
    ruleId,
    sourceId: 'src-1',
    eventKind: 'added',
    importance: 'normal',
    idempotencyKey: randomUUID(),
    changeFingerprint: 'fp',
    firstObservedAt: NOW,
    lastObservedAt: NOW,
    itemCount: 1,
    readAt: null,
  };
}

function projection(overrides: Partial<SourceWatchProjection> = {}): SourceWatchProjection {
  return {
    sourceId: 'src-1',
    rowVersion: 1,
    enabled: true,
    deletedAt: null,
    scope: 'page',
    canonicalKey: 'https://example.com/doc',
    ...overrides,
  };
}

const OK_RECONCILE = (): { ok: boolean; reason: string | null } => ({ ok: true, reason: null });

// 在 v1 库上以原始 v1 SQL 种子（不依赖 v3 Repository SQL）：rule/baseline/finished
// run/45 审计组合/event+item/intent/outbox。D7：v1 列的 watch_event_items 无
// observation_id（v3 迁移负责追加并回填 observation）。
function seedV1Db(dbPath: string): { rule: WatchRule; event: WatchEvent; mutationId: string } {
  const handle = openDb(dbPath);
  try {
    runMigrations(handle, [WATCH_MIGRATION_V1]);
    const repo = new WatchRepository(handle);
    const rule = makeRule();
    if (!repo.insertRule(rule).ok) throw new Error('seed insertRule 失败');
    // Baseline：v1 表无 conditional validator 列 → 原列插入
    const projectionJson =
      '{"format":"rss2","title":{"text":"t","truncated":false,"originalBytes":1}}';
    handle
      .prepare(
        `INSERT INTO watch_baselines (rule_id, version, projection_type, projection_json,
   content_hash, byte_length, final_url, captured_at, document_id)
   VALUES (?, 1, 'feed', ?, 'h', ?, 'https://example.com', ?, NULL)`,
      )
      .run(rule.id, projectionJson, Buffer.byteLength(projectionJson, 'utf8'), NOW);
    handle.prepare('UPDATE watch_rules SET baseline_version = 1 WHERE id = ?').run(rule.id);
    if (
      !repo.insertRun({
        id: 'run-finished',
        ruleId: rule.id,
        requestKey: 'rk-finished',
        trigger: 'scheduled',
        scheduledFor: NOW,
      }).ok
    ) {
      throw new Error('seed insertRun 失败');
    }
    const trans = repo.transitionRun('run-finished', 'queued', {
      status: 'finished',
      startedAt: NOW,
      finishedAt: NOW,
      outcome: { kind: 'unchanged' },
      health: { state: 'healthy', acquisition: 'rss', code: null },
    });
    if (!trans.ok) throw new Error('seed transitionRun 失败');
    const kinds = [
      'lifecycle-pause',
      'lifecycle-cascade',
      'reconciliation',
      'baseline-established',
      'rebaseline',
    ] as const;
    const reasons = [
      'source-disabled',
      'source-deleted',
      'source-changed',
      'hard-delete',
      'undo-source-removed',
      'complete',
      'aborted',
      'baseline-established',
      'rebaseline',
    ] as const;
    let seq = 0;
    for (const kind of kinds) {
      for (const reason of reasons) {
        const r = repo.insertAudit({
          id: `audit-${seq++}`,
          ruleId: null,
          kind,
          reasonCode: reason,
          createdAt: NOW,
        });
        if (!r.ok) throw new Error('seed insertAudit 失败');
      }
    }
    const event = makeEvent(rule.id);
    // Event + 一个 item（v1 原列）——v3 迁移回填 observation
    handle
      .prepare(
        `INSERT INTO watch_events (id, rule_id, source_id, event_kind, importance,
   idempotency_key, change_fingerprint, first_observed_at, last_observed_at, item_count)
   VALUES (?, ?, 'src-1', 'added', 'normal', ?, 'fp', ?, ?, 1)`,
      )
      .run(event.id, rule.id, event.idempotencyKey, NOW, NOW);
    handle
      .prepare(
        `INSERT INTO watch_event_items (id, event_id, sequence, item_id, field_key, label,
   before_value_json, after_value_json, before_captured_at, after_captured_at,
   before_final_url, after_final_url)
   VALUES ('i1', ?, 0, 'it1', 'title', '标题', '{"kind":"absent"}',
    '{"kind":"present","excerpt":"新","valueHash":"h","normalizedBytes":3,"truncated":false}',
    ?, ?, 'https://example.com', 'https://example.com')`,
      )
      .run(event.id, NOW, NOW);
    handle
      .prepare(
        `INSERT INTO notification_outbox (id, rule_id, subject_type, subject_id, channel,
   dedupe_key, privacy_json, state, attempts, created_at, updated_at)
   VALUES ('ob-1', ?, 'event', ?, 'in-app', 'dk-1', '{}', 'pending', 0, ?, ?)`,
      )
      .run(rule.id, event.id, NOW, NOW);
    const mutationId = randomUUID();
    const i = repo.insertSourceCleanupIntent({
      mutationId,
      sourceId: 'src-1',
      operation: 'disable',
      beforeProjection: projection(),
      afterProjection: projection({ enabled: false }),
      affectedRuleState: {},
      state: 'prepared',
      createdAt: NOW,
      updatedAt: NOW,
    });
    if (!i.ok) throw new Error('seed insertSourceCleanupIntent 失败');
    repo.dispose();
    return { rule, event, mutationId };
  } finally {
    closeDb(handle);
  }
}

describe('D7 #S6-044/#S6-055 M0：v1→v3 store 升级（FIXED 16）', () => {
  it('M0-3 数据恒等：v1 库经 openWatchStore 升至 v3，逐行读回恒等 + v1 备份 + user_version=3', () => {
    const dir = mkdtempSync(join(root, 'identity-'));
    const dbPath = join(dir, 'watch.db');
    const backupsDir = join(dir, 'backups');
    const { rule, event, mutationId } = seedV1Db(dbPath);
    const outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(outcome.mode).toBe('normal');
    if (outcome.mode !== 'normal') return;
    expect(outcome.schedulerReady).toBe(true);
    const repo = outcome.repo;
    // user_version=3（经 repo.dbHandle 只读探测，测试设施）
    expect(
      (repo.dbHandle.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(3);
    // 规则/基线/运行/事件恒等
    const readRule = repo.getRule(rule.id);
    expect(readRule).not.toBeNull();
    expect(readRule!.schedule).toEqual(rule.schedule);
    expect(readRule!.target).toEqual(rule.target);
    expect(readRule!.sourceLocatorFingerprint).toBe(rule.sourceLocatorFingerprint);
    expect(repo.getBaseline(rule.id)!.version).toBe(1);
    const run = repo.getRun('run-finished');
    expect(run!.status).toBe('finished');
    expect(run!.requestKey).toBe('rk-finished');
    expect(run!.trigger).toBe('scheduled');
    expect(run!.outcome).toEqual({ kind: 'unchanged' });
    const readEvent = repo.getEvent(event.id);
    expect(readEvent).not.toBeNull();
    expect(readEvent!.eventKind).toBe('added');
    expect(repo.listEventItems(event.id).length).toBe(1);
    // 45 审计组合读回恒等
    const audits = repo.listAudits(1000);
    expect(audits.length).toBe(45);
    const pairSet = new Set(audits.map((a) => `${a.kind}|${a.reasonCode}`));
    const kinds = [
      'lifecycle-pause',
      'lifecycle-cascade',
      'reconciliation',
      'baseline-established',
      'rebaseline',
    ];
    const reasons = [
      'source-disabled',
      'source-deleted',
      'source-changed',
      'hard-delete',
      'undo-source-removed',
      'complete',
      'aborted',
      'baseline-established',
      'rebaseline',
    ];
    for (const kind of kinds) {
      for (const reason of reasons) {
        expect(pairSet.has(`${kind}|${reason}`)).toBe(true);
      }
    }
    // intent 恒等
    const intent = repo.getSourceCleanupIntent(mutationId);
    expect(intent).not.toBeNull();
    expect(intent!.operation).toBe('disable');
    expect(intent!.state).toBe('prepared');
    // outbox 恒等（测试设施直查）
    const ob = repo.dbHandle
      .prepare('SELECT dedupe_key FROM notification_outbox WHERE id = ?')
      .get('ob-1') as { dedupe_key: string };
    expect(ob.dedupe_key).toBe('dk-1');
    // v1 迁移前备份存在且命名匹配 -v1-
    const backups = readdirSync(backupsDir);
    expect(backups.some((n) => /^watch-backup-.*-v1-.*\.db$/.test(n))).toBe(true);
    repo.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('M0-5 v2 步骤失败注入：逐语句切点 → unavailable、user_version 仍 1、原行完整、备份保留；修复后重开成功', () => {
    const dir = mkdtempSync(join(root, 'fault-'));
    const dbPath = join(dir, 'watch.db');
    const backupsDir = join(dir, 'backups');
    const seeded = seedV1Db(dbPath);
    // 每个语句位置注入一个非法 SQL；引擎单事务整体回滚
    for (let idx = 0; idx < WATCH_MIGRATION_V2.statements.length; idx += 1) {
      const broken: MigrationStep = {
        version: 2,
        statements: WATCH_MIGRATION_V2.statements.map((s, i) =>
          i === idx ? 'THIS IS NOT VALID SQL;' : s,
        ),
      };
      const bad = openWatchStore({
        dbPath,
        backupsDir,
        reconcile: OK_RECONCILE,
        migrations: [WATCH_MIGRATION_V1, broken],
      });
      expect(bad.mode).toBe('unavailable');
      // user_version 仍为 1、规则行完整、备份保留
      const probeHandle = openDb(dbPath);
      try {
        expect(
          (probeHandle.prepare('PRAGMA user_version').get() as { user_version: number })
            .user_version,
        ).toBe(1);
        const row = probeHandle
          .prepare('SELECT COUNT(*) AS n FROM watch_rules WHERE id = ?')
          .get(seeded.rule.id) as { n: number };
        expect(row.n).toBe(1);
      } finally {
        closeDb(probeHandle);
      }
      expect(readdirSync(backupsDir).length).toBeGreaterThan(0);
    }
    // 修复（正确迁移列表）后重开成功
    const fixed = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(fixed.mode).toBe('normal');
    if (fixed.mode === 'normal') fixed.repo.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('M0-6 未来版本 user_version=4 → 零写入 unavailable（latest=3，4 为未来）', () => {
    const dir = mkdtempSync(join(root, 'future-'));
    const dbPath = join(dir, 'watch.db');
    const backupsDir = join(dir, 'backups');
    seedV1Db(dbPath);
    const h = openDb(dbPath);
    h.exec('PRAGMA user_version = 4');
    closeDb(h);
    const before = readFileSync(dbPath);
    const outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(outcome.mode).toBe('unavailable');
    expect(outcome.schedulerReady).toBe(false);
    // 零写入：主库文件字节恒等（-shm/-wal 是测试自身 openDb WAL 残留，非装配写入）
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    const probe = openDb(dbPath);
    try {
      expect(
        (probe.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      ).toBe(4);
    } finally {
      closeDb(probe);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('M0-8 迁移+恢复交互：v1 备份经 restoreWatchStore 自动升至 v3、增量数据消失语义不变', () => {
    const dir = mkdtempSync(join(root, 'restore-'));
    const dbPath = join(dir, 'watch.db');
    const backupsDir = join(dir, 'backups');
    const { rule } = seedV1Db(dbPath);
    // 生成 v1 一致性备份
    const backup = createConsistentBackup(
      dbPath,
      backupsDir,
      1,
      () => Date.UTC(2026, 7, 28, 0, 0, 0),
      () => 'beef0001',
      { namePrefix: 'watch-backup-', parentLabel: '监控' },
    );
    expect(backup.ok && backup.backupPath !== null).toBe(true);
    const backupName = backup.backupPath!.slice(backup.backupPath!.lastIndexOf('\\') + 1);
    // 备份后新增增量规则（以 v1 迁移跑 repository——只插入规则，不触碰 v3 列）
    const extra = makeRule('src-extra');
    const h = openDb(dbPath);
    runMigrations(h, [WATCH_MIGRATION_V1]);
    const repo = new WatchRepository(h);
    expect(repo.insertRule(extra).ok).toBe(true);
    repo.dispose();
    closeDb(h);
    // 恢复 v1 备份 → 重走装配自动迁移到 v3
    const restored = restoreWatchStore({
      dbPath,
      backupsDir,
      backupFileName: backupName,
      reconcile: OK_RECONCILE,
    });
    expect(restored.mode).toBe('normal');
    if (restored.mode !== 'normal') return;
    expect(
      (restored.repo.dbHandle.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version,
    ).toBe(3);
    expect(restored.repo.getRule(extra.id)).toBeNull(); // 增量数据消失
    expect(restored.repo.getRule(rule.id)).not.toBeNull(); // 备份内规则读回
    restored.repo.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('D7-R M0-9 v3 步骤失败注入：每条语句切点 → unavailable、user_version 仍 2、v2 数据/索引恒等、零临时表', () => {
    const dir = mkdtempSync(join(root, 'v3-fault-'));
    const dbPath = join(dir, 'watch.db');
    const backupsDir = join(dir, 'backups');
    const seeded = seedV1Db(dbPath);
    // 基线：以原始迁移引擎直接升到 v2（不经 openWatchStore——v2 无 v3 专属列，
    // scanIntegrity 只在 v3 上运行，因此 v2 基线用 runMigrations 构造）
    const up2 = openDb(dbPath);
    runMigrations(up2, [WATCH_MIGRATION_V1, WATCH_MIGRATION_V2]);
    closeDb(up2);
    expect(readUserVersion(dbPath)).toBe(2);
    const v2TableNames = tableNamesSnapshot(dbPath);
    const v2IndexNames = indexNamesSnapshot(dbPath);
    const v2RuleCount = countRows(dbPath, 'watch_rules');
    const v2EventCount = countRows(dbPath, 'watch_events');
    // R2-3：完整回滚 oracle——sqlite_master name+sql 精确恒等 + 全部 v2 业务表
    // 全部列/行按确定性顺序精确恒等 + 零临时残留（含 watch_event_observations）。
    const v2Master = sqliteMasterSnapshot(dbPath);
    const v2Data = v2BusinessDataSnapshot(dbPath);
    // 每个 v3 语句位置注入非法 SQL；引擎单事务整体回滚 → v2 恒等
    for (let idx = 0; idx < WATCH_MIGRATION_V3.statements.length; idx += 1) {
      const broken: MigrationStep = {
        version: 3,
        statements: WATCH_MIGRATION_V3.statements.map((s, i) =>
          i === idx ? 'THIS IS NOT VALID SQL;' : s,
        ),
      };
      const bad = openWatchStore({
        dbPath,
        backupsDir,
        reconcile: OK_RECONCILE,
        migrations: [WATCH_MIGRATION_V1, WATCH_MIGRATION_V2, broken],
      });
      expect(bad.mode).toBe('unavailable');
      // user_version 仍为 2；v2 表/索引/行恒等；零临时表（watch_v3_guard / *_v3 /
      // watch_event_observations）
      expect(readUserVersion(dbPath)).toBe(2);
      expect(tableNamesSnapshot(dbPath)).toEqual(v2TableNames);
      expect(indexNamesSnapshot(dbPath)).toEqual(v2IndexNames);
      expect(countRows(dbPath, 'watch_rules')).toBe(v2RuleCount);
      expect(countRows(dbPath, 'watch_events')).toBe(v2EventCount);
      // R2-3：schema 与数据完整快照恒等（name+sql / 全部列全部行）
      expect(sqliteMasterSnapshot(dbPath)).toEqual(v2Master);
      expect(v2BusinessDataSnapshot(dbPath)).toEqual(v2Data);
      const probe = openDb(dbPath);
      try {
        const temp = probe
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%v3%' OR name = 'watch_v3_guard' OR name = 'watch_event_observations')",
          )
          .all() as Array<{ name: string }>;
        expect(temp).toEqual([]);
      } finally {
        closeDb(probe);
      }
    }
    // 修复（正确迁移列表）后 v2→v3 重开成功
    const fixed = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(fixed.mode).toBe('normal');
    if (fixed.mode === 'normal') fixed.repo.dispose();
    rmSync(dir, { recursive: true, force: true });
    void seeded;
  });

  it('D7-R M0-10 确定性 v2:<eventId> 回填冲突：observation 建表后回填前植入同 ID → 回填 UNIQUE 失败且整个 v2 库精确回滚', () => {
    const dir = mkdtempSync(join(root, 'v2-conflict-'));
    const dbPath = join(dir, 'watch.db');
    const backupsDir = join(dir, 'backups');
    const seeded = seedV1Db(dbPath);
    const up2 = openDb(dbPath);
    runMigrations(up2, [WATCH_MIGRATION_V1, WATCH_MIGRATION_V2]);
    closeDb(up2);
    expect(readUserVersion(dbPath)).toBe(2);
    const v2Master = sqliteMasterSnapshot(dbPath);
    const v2Data = v2BusinessDataSnapshot(dbPath);
    const eventId = seeded.event.id;
    // 在 observation 建表后、回填 INSERT 前植入同 ID 冲突（id='v2:'||eventId）。
    // 该 INSERT 引用已存在的 Event（FK 合法），但使随后的回填
    // `SELECT 'v2:'||id ... FROM watch_events` 命中 UNIQUE(id) → 整笔迁移回滚。
    const conflictSql =
      `INSERT INTO watch_event_observations (id, event_id, sequence, idempotency_key, ` +
      `change_fingerprint, event_kind, observed_at, first_item_sequence, item_count) ` +
      `VALUES ('v2:${eventId}', '${eventId}', 0, 'ik-conflict', 'fp-conflict', 'added', '${NOW}', 0, 1)`;
    // 回填语句（索引 14）之前注入冲突行；其余语句原样
    const statements = [
      ...WATCH_MIGRATION_V3.statements.slice(0, 14),
      conflictSql,
      ...WATCH_MIGRATION_V3.statements.slice(14),
    ];
    const broken: MigrationStep = { version: 3, statements };
    const bad = openWatchStore({
      dbPath,
      backupsDir,
      reconcile: OK_RECONCILE,
      migrations: [WATCH_MIGRATION_V1, WATCH_MIGRATION_V2, broken],
    });
    expect(bad.mode).toBe('unavailable');
    // 整个 v2 库精确回滚：user_version=2、schema/index name+sql 恒等、全部数据恒等、
    // 零临时残留
    expect(readUserVersion(dbPath)).toBe(2);
    expect(sqliteMasterSnapshot(dbPath)).toEqual(v2Master);
    expect(v2BusinessDataSnapshot(dbPath)).toEqual(v2Data);
    const probe = openDb(dbPath);
    try {
      const temp = probe
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%v3%' OR name = 'watch_v3_guard' OR name = 'watch_event_observations')",
        )
        .all() as Array<{ name: string }>;
      expect(temp).toEqual([]);
    } finally {
      closeDb(probe);
    }
    // 修复（正确迁移列表）后正常升级 v3
    const fixed = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(fixed.mode).toBe('normal');
    if (fixed.mode === 'normal') {
      expect(
        (fixed.repo.dbHandle.prepare('PRAGMA user_version').get() as { user_version: number })
          .user_version,
      ).toBe(3);
      fixed.repo.dispose();
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

// 测试设施：快照 v2 库的表/索引/行数（GOAL 5 v2 回滚 oracle）
function tableNamesSnapshot(dbPath: string): string[] {
  const h = openDb(dbPath);
  try {
    return (
      h.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    )
      .map((r) => r.name)
      .filter((n) => !n.startsWith('sqlite_'))
      .sort();
  } finally {
    closeDb(h);
  }
}

function indexNamesSnapshot(dbPath: string): string[] {
  const h = openDb(dbPath);
  try {
    return (
      h.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
        name: string;
      }>
    )
      .map((r) => r.name)
      .filter((n) => !n.startsWith('sqlite_'))
      .sort();
  } finally {
    closeDb(h);
  }
}

function countRows(dbPath: string, table: string): number {
  const h = openDb(dbPath);
  try {
    const row = h.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return Number(row.n);
  } finally {
    closeDb(h);
  }
}

// R2-3：sqlite_master 完整快照（type+name+sql，确定性排序）——回滚 oracle 比较
// name+sql 精确恒等（表与索引一体）。
function sqliteMasterSnapshot(dbPath: string): Array<{ type: string; name: string; sql: string }> {
  const h = openDb(dbPath);
  try {
    const rows = h
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Array<{ type: string; name: string; sql: string }>;
    return rows.map((r) => ({ type: r.type, name: r.name, sql: r.sql ?? '' }));
  } finally {
    closeDb(h);
  }
}

// R2-3：v2 业务表全部列/全部行按确定性顺序快照。动态 SQL 只允许使用编译期固定
// 表名白名单（不从 sqlite_master 派生表名拼 SQL）。每行序列化后按字节序排序，
// 全列包含（SELECT * 覆盖全部列）。
const V2_BUSINESS_TABLES = [
  'watch_rules',
  'watch_baselines',
  'watch_runs',
  'watch_audits',
  'watch_events',
  'watch_event_items',
  'digest_schedules',
  'watch_digests',
  'digest_event_refs',
  'notification_outbox',
  'source_cleanup_intents',
] as const;

function v2BusinessDataSnapshot(dbPath: string): Record<string, string> {
  const h = openDb(dbPath);
  try {
    const out: Record<string, string> = {};
    for (const table of V2_BUSINESS_TABLES) {
      const rows = h.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
      const serialized = rows
        .map((r) => JSON.stringify(r))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      out[table] = serialized.join('\u0001');
    }
    return out;
  } finally {
    closeDb(h);
  }
}

function readUserVersion(dbPath: string): number {
  const h = openDb(dbPath);
  try {
    return (h.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    closeDb(h);
  }
}
