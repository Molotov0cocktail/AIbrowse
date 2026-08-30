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
import { WATCH_MIGRATION_V1, WATCH_MIGRATION_V2 } from './db/watch-migrations';
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
});
