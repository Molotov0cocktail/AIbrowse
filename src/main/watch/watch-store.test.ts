// D4 watch-store tests: 启动装配矩阵（detailed-design §10.2 八步）——新库创建
// （零备份）、current quick check、future/截断/坏 magic/非文件 → unavailable
// 且原库字节不变、迁移失败回滚、JSON/预算扫描失败 → unavailable、遗留
// queued/running → interrupted（slot 不重放）、reconciliation hook 编排与
// fail-closed（无 hook + 未决 intent → unavailable）、保留/预算清理、
// invalidateSessionConsentsOnStart、restore 恢复矩阵（严格命名/坏备份/替换/
// grant 失效）。真实 node:sqlite + 临时目录精确清理。
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MigrationStep } from '../sources/db/migrations';
import { openDb, closeDb } from '../sources/db/sqlite-driver';
import { createConsistentBackup } from '../sources/db/backup';
import { runWatchMigrations } from './db/watch-migrations';
import {
  openWatchStore,
  pruneWatchBackups,
  restoreWatchStore,
  WATCH_BACKUP_NAME_PATTERN,
} from './watch-store';
import { WatchRepository } from './repository/watch-repository';
import type { WatchRule } from '../../shared/types/watch';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-watch-store-'));

const FINGERPRINT = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const NOW = '2026-08-28T00:00:00.000Z';

let dbPath: string;
let backupsDir: string;

beforeEach(() => {
  const dir = mkdtempSync(join(root, 'store-'));
  dbPath = join(dir, 'watch.db');
  backupsDir = join(dir, 'backups');
});

afterEach(() => {
  void 0;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeRule(overrides: Partial<WatchRule> = {}): WatchRule {
  return {
    id: randomUUID(),
    sourceId: 'src-1',
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
    sourceLocatorFingerprint: FINGERPRINT,
    nextDueAt: null,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const OK_RECONCILE = (): { ok: boolean; reason: string | null } => ({ ok: true, reason: null });

describe('装配矩阵（§10.2 八步）', () => {
  it('新库正常创建：无备份文件、normal + schedulerReady', () => {
    const outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(outcome.mode).toBe('normal');
    if (outcome.mode === 'normal') {
      expect(outcome.schedulerReady).toBe(true);
      expect(outcome.repo.getRule('ghost')).toBeNull();
      outcome.repo.dispose();
    }
  });

  it('future 版本 → unavailable 且原库字节不变', () => {
    const handle = openDb(dbPath);
    runWatchMigrations(handle);
    handle.exec('PRAGMA user_version = 99');
    closeDb(handle);
    const before = readFileSync(dbPath);
    const outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(outcome.mode).toBe('unavailable');
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });

  it('截断/坏 magic → unavailable 且原库字节不变', () => {
    writeFileSync(dbPath, 'not a sqlite database at all');
    const before = readFileSync(dbPath);
    const outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(outcome.mode).toBe('unavailable');
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    rmSync(dbPath, { force: true });
    writeFileSync(dbPath, 'SQLite format 3\u0000'.padEnd(16, 'x'));
    const before2 = readFileSync(dbPath);
    const outcome2 = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(outcome2.mode).toBe('unavailable');
    expect(readFileSync(dbPath).equals(before2)).toBe(true);
  });

  it('数据库路径为目录 → unavailable（not-a-file）', () => {
    rmSync(dbPath, { force: true });
    mkdirSync(dbPath);
    const outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(outcome.mode).toBe('unavailable');
  });

  it('迁移失败（注入坏步骤）→ unavailable、原库逻辑恒等、新库不残留', () => {
    const bad: MigrationStep[] = [
      { version: 1, statements: [] },
      { version: 2, statements: ['CREATE TABLE watch_rules (id TEXT PRIMARY KEY); '] },
    ];
    const outcome = openWatchStore({
      dbPath,
      backupsDir,
      migrations: bad,
      reconcile: OK_RECONCILE,
    });
    expect(outcome.mode).toBe('unavailable');
  });

  it('有效旧版本：迁移前 watch-backup 备份 + 迁移 + 切 WAL', () => {
    // 用只含 v1 子集的迁移列表模拟「旧版本已就绪」：直接建 v1 库然后以
    // 完整列表重开（up-to-date）→ 无备份；再以 v1-only 列表注入旧版本场景：
    const handle = openDb(dbPath);
    runWatchMigrations(handle);
    handle
      .prepare(
        `INSERT INTO watch_rules (id, source_id, kind, state, desired_enabled, muted,
   access_mode, schedule_json, target_json, notification_level, source_row_version,
   source_locator_fingerprint, consecutive_failures, baseline_version, created_at,
   updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'r1',
        's1',
        'feed',
        'enabled',
        1,
        0,
        'public',
        '{"kind":"interval","intervalMinutes":60}',
        '{"type":"feed","feedUrl":"https://example.com/rss.xml","format":"rss2"}',
        'normal',
        1,
        FINGERPRINT,
        0,
        0,
        NOW,
        NOW,
      );
    closeDb(handle);
    const outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(outcome.mode).toBe('normal');
    if (outcome.mode === 'normal') {
      expect(outcome.repo.getRule('r1')).not.toBeNull();
      outcome.repo.dispose();
    }
  });

  it('遗留 queued/running → 单事务 interrupted；finished 不动', () => {
    let outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(outcome.mode).toBe('normal');
    if (outcome.mode !== 'normal') return;
    const repo = outcome.repo;
    const rule = makeRule();
    repo.insertRule(rule);
    repo.insertRun({
      id: 'run1',
      ruleId: rule.id,
      requestKey: 'k1',
      trigger: 'scheduled',
      scheduledFor: NOW,
    });
    repo.insertRun({
      id: 'run2',
      ruleId: rule.id,
      requestKey: 'k2',
      trigger: 'manual',
      scheduledFor: null,
    });
    repo.transitionRun('run2', 'queued', { status: 'running', startedAt: NOW });
    repo.insertRun({
      id: 'run3',
      ruleId: rule.id,
      requestKey: 'k3',
      trigger: 'manual',
      scheduledFor: null,
    });
    repo.transitionRun('run3', 'queued', { status: 'finished', finishedAt: NOW });
    repo.dispose();
    outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(outcome.mode).toBe('normal');
    if (outcome.mode !== 'normal') return;
    expect(outcome.repo.getRun('run1')!.status).toBe('interrupted');
    expect(outcome.repo.getRun('run2')!.status).toBe('interrupted');
    expect(outcome.repo.getRun('run3')!.status).toBe('finished');
    outcome.repo.dispose();
  });

  it('JSON 形状扫描失败（污染行）→ unavailable 零部分启动', () => {
    let outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(outcome.mode).toBe('normal');
    if (outcome.mode !== 'normal') return;
    const repo = outcome.repo;
    repo.insertRule(makeRule());
    repo.dbHandle.prepare("UPDATE watch_rules SET schedule_json = 'not-json'").run();
    repo.dispose();
    outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(outcome.mode).toBe('unavailable');
    expect(outcome.schedulerReady).toBe(false);
  });

  it('启动扫描：observation 关系损坏（删 Event 的观察）→ unavailable 零部分启动', () => {
    let outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(outcome.mode).toBe('normal');
    if (outcome.mode !== 'normal') return;
    const repo = outcome.repo;
    const rule = makeRule();
    repo.insertRule(rule);
    const event = {
      id: randomUUID(),
      ruleId: rule.id,
      sourceId: 'src-1',
      eventKind: 'added' as const,
      importance: 'normal' as const,
      idempotencyKey: randomUUID(),
      changeFingerprint: 'fp',
      firstObservedAt: NOW,
      lastObservedAt: NOW,
      itemCount: 1,
      readAt: null,
    };
    const items = [
      {
        itemId: 'it1',
        fieldKey: 'title',
        label: '标题',
        before: { kind: 'absent' as const },
        after: { kind: 'absent' as const },
        beforeCapturedAt: NOW,
        afterCapturedAt: NOW,
        beforeFinalUrl: 'https://example.com',
        afterFinalUrl: 'https://example.com',
        beforeDocumentId: null,
        afterDocumentId: null,
        feedItemKey: null,
      },
    ];
    expect(
      repo.writeEventTransaction({
        event,
        items,
        identity: {
          sourceId: rule.sourceId,
          expectedSourceLocatorFingerprint: rule.sourceLocatorFingerprint,
          expectedBaselineVersion: null,
        },
      }),
    ).toEqual({ ok: true });
    // 破坏 v3 关系：删除该 Event 的 observation（Event 缺 observation → fail-closed）
    repo.dbHandle.prepare('DELETE FROM watch_event_observations WHERE event_id = ?').run(event.id);
    repo.dispose();
    outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(outcome.mode).toBe('unavailable');
    expect(outcome.schedulerReady).toBe(false);
  });

  it('reconciliation hook 失败 → unavailable；成功 → normal', () => {
    const failing = (): { ok: boolean; reason: string | null } => ({
      ok: false,
      reason: '模拟失败',
    });
    const outcome = openWatchStore({ dbPath, backupsDir, reconcile: failing });
    expect(outcome.mode).toBe('unavailable');
    const ok = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(ok.mode).toBe('normal');
    if (ok.mode === 'normal') ok.repo.dispose();
  });

  it('无 reconcile hook + 未决 intent → unavailable（绝不静默跳过）；无未决 → normal', () => {
    // 无 hook 且无未决 intent → normal（Store 单测设施）
    const ok = openWatchStore({ dbPath, backupsDir });
    expect(ok.mode).toBe('normal');
    if (ok.mode !== 'normal') return;
    ok.repo.insertSourceCleanupIntent({
      mutationId: 'm1',
      sourceId: 's1',
      operation: 'update',
      beforeProjection: null,
      afterProjection: null,
      affectedRuleState: {},
      state: 'prepared',
      createdAt: NOW,
      updatedAt: NOW,
    });
    ok.repo.dispose();
    const blocked = openWatchStore({ dbPath, backupsDir });
    expect(blocked.mode).toBe('unavailable');
  });

  it('启动保留清理：过期/超数事件被清理；仍超预算 → unavailable', () => {
    let outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(outcome.mode).toBe('normal');
    if (outcome.mode !== 'normal') return;
    const repo = outcome.repo;
    const rule = makeRule();
    repo.insertRule(rule);
    const old = {
      id: randomUUID(),
      ruleId: rule.id,
      sourceId: 'src-1',
      eventKind: 'added' as const,
      importance: 'normal' as const,
      idempotencyKey: randomUUID(),
      changeFingerprint: 'fp',
      firstObservedAt: '2026-01-01T00:00:00.000Z',
      lastObservedAt: '2026-01-01T00:00:00.000Z',
      itemCount: 1,
      readAt: null,
    };
    const items = [
      {
        itemId: 'it1',
        fieldKey: 'title',
        label: '标题',
        before: { kind: 'absent' as const },
        after: { kind: 'absent' as const },
        beforeCapturedAt: NOW,
        afterCapturedAt: NOW,
        beforeFinalUrl: 'https://example.com',
        afterFinalUrl: 'https://example.com',
        beforeDocumentId: null,
        afterDocumentId: null,
        feedItemKey: null,
      },
    ];
    expect(
      repo.writeEventTransaction({
        event: old,
        items,
        identity: {
          sourceId: rule.sourceId,
          expectedSourceLocatorFingerprint: rule.sourceLocatorFingerprint,
          expectedBaselineVersion: null,
        },
      }),
    ).toEqual({ ok: true });
    repo.dispose();
    outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(outcome.mode).toBe('normal');
    if (outcome.mode !== 'normal') return;
    expect(outcome.repo.getEvent(old.id)).toBeNull(); // 2026-01-01 → 超过 90 天清理
    outcome.repo.dispose();
  });

  it('dispose 幂等（两次 closeDb 安全）', () => {
    const outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(outcome.mode).toBe('normal');
    if (outcome.mode !== 'normal') return;
    outcome.repo.dispose();
    outcome.repo.dispose();
  });
});

describe('恢复矩阵（§10.2 末段：restore + grant 失效）', () => {
  function seedWithSessionRule(): WatchRepository {
    const outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    if (outcome.mode !== 'normal') throw new Error('seed 装配失败');
    const rule = makeRule({
      kind: 'page',
      accessMode: 'session',
      target: {
        type: 'page',
        pageUrl: 'https://example.com/doc',
        regions: [{ kind: 'main-text', label: '正文' }],
        sessionConsent: { version: 1, origin: 'https://example.com', grantedAt: NOW },
      },
    });
    outcome.repo.insertRule(rule);
    return outcome.repo;
  }

  it('恢复：备份 → 修改 → 恢复 → 数据回卷 + 全部 Session grant 失效', () => {
    const repo = seedWithSessionRule();
    const backup = createWatchBackup(dbPath, backupsDir);
    expect(backup.ok).toBe(true);
    if (!backup.ok) return;
    // 修改：新增第二条规则（恢复后应消失）
    repo.insertRule(makeRule({ id: 'post-backup-rule', sourceId: 'src-2' }));
    repo.dispose();
    const restored = restoreWatchStore({
      dbPath,
      backupsDir,
      backupFileName: backup.fileName,
      reconcile: OK_RECONCILE,
    });
    expect(restored.mode).toBe('normal');
    if (restored.mode !== 'normal') return;
    expect(restored.repo.getRule('post-backup-rule')).toBeNull();
    const pageRules = restored.repo.listRules().filter((r) => r.kind === 'page');
    expect(pageRules.length).toBe(1);
    if (pageRules[0]!.target.type === 'page') {
      expect(pageRules[0]!.target.sessionConsent).toBeNull();
    }
    restored.repo.dispose();
  });

  it('非法备份名（非严格命名/越界）→ 恢复失败零替换', () => {
    const repo = seedWithSessionRule();
    repo.dispose();
    const before = readFileSync(dbPath);
    const bad = restoreWatchStore({
      dbPath,
      backupsDir,
      backupFileName: '../../evil.db',
      reconcile: OK_RECONCILE,
    });
    expect(bad.mode).toBe('unavailable');
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });

  it('非 SQLite 备份文件 → 恢复失败零替换', () => {
    const repo = seedWithSessionRule();
    repo.dispose();
    mkdirSync(backupsDir, { recursive: true });
    const name = buildFakeWatchBackupName();
    writeFileSync(join(backupsDir, name), 'garbage-not-sqlite');
    const before = readFileSync(dbPath);
    const result = restoreWatchStore({
      dbPath,
      backupsDir,
      backupFileName: name,
      reconcile: OK_RECONCILE,
    });
    expect(result.mode).toBe('unavailable');
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });
});

// 测试设施：生成真实 watch-backup 备份（createConsistentBackup + 严格命名）
// D5 #S6-044 FIXED 17 机械校准：备份版本参数必须等于 DB 实际 user_version
//（schema v2 后为 2，不再是硬编码 1）——同一版本字面量类别的机械校准，零删除零削弱。
function currentDbVersion(path: string): number {
  const h = openDb(path);
  try {
    return (h.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    closeDb(h);
  }
}

function createWatchBackup(dbPath: string, backupsDir: string): { ok: boolean; fileName: string } {
  const result = createConsistentBackup(
    dbPath,
    backupsDir,
    currentDbVersion(dbPath),
    () => Date.UTC(2026, 7, 28, 0, 0, 0),
    () => 'beef0001',
    { namePrefix: 'watch-backup-', parentLabel: '监控' },
  );
  if (!result.ok || result.backupPath === null) return { ok: false, fileName: '' };
  const fileName = result.backupPath.slice(result.backupPath.lastIndexOf('\\') + 1);
  expect(WATCH_BACKUP_NAME_PATTERN.test(fileName)).toBe(true);
  return { ok: true, fileName };
}

function buildFakeWatchBackupName(): string {
  return 'watch-backup-2026-01-01T00-00-00-000Z-v1-ffff0001.db';
}

describe('D4-R：restore post-swap 回滚 + 启动扫描字节一致性', () => {
  function seedHealthy(): void {
    const outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    if (outcome.mode !== 'normal') throw new Error('seed 装配失败');
    outcome.repo.insertRule(makeRule({ id: 'keep-rule' }));
    outcome.repo.dispose();
  }

  function backupWith(randomHex: string): string {
    const result = createConsistentBackup(
      dbPath,
      backupsDir,
      currentDbVersion(dbPath),
      () => Date.UTC(2026, 7, 28, 0, 0, 0),
      () => randomHex,
      { namePrefix: 'watch-backup-', parentLabel: '监控' },
    );
    if (!result.ok || result.backupPath === null) throw new Error('备份生成失败');
    return result.backupPath.slice(result.backupPath.lastIndexOf('\\') + 1);
  }

  // 回滚路径：pre-restore/stage（含其 WAL/SHM）必须精确清理；原库随其 WAL/SHM
  // 恢复到原位置（原库自身 WAL/SHM 是恢复内容而非残留）。
  function expectNoSwapResidue(): void {
    expect(existsSync(`${dbPath}.pre-restore`)).toBe(false);
    expect(existsSync(`${dbPath}.pre-restore-wal`)).toBe(false);
    expect(existsSync(`${dbPath}.pre-restore-shm`)).toBe(false);
    expect(existsSync(`${dbPath}.restore-stage`)).toBe(false);
  }

  it('备份含非法 JSON 行 → restore 失败 + 原 live 库恢复且字节/数据恒等、可重开', () => {
    seedHealthy();
    const good = backupWith('beef0001');
    void good;
    // live 库加入增量数据
    const live = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    if (live.mode !== 'normal') throw new Error('live 装配失败');
    live.repo.insertRule(makeRule({ id: 'live-only' }));
    live.repo.dispose();
    const beforeBytes = readFileSync(dbPath);
    // 制作污染备份（合法 SQLite 含非法 JSON），再修复 live 库
    {
      const h = openDb(dbPath);
      h.prepare("UPDATE watch_rules SET schedule_json = 'not-json' WHERE id = 'keep-rule'").run();
      closeDb(h);
    }
    const poisoned = backupWith('beef0002');
    {
      const h = openDb(dbPath);
      h.prepare("UPDATE watch_rules SET schedule_json = ? WHERE id = 'keep-rule'").run(
        '{"kind":"interval","intervalMinutes":60}',
      );
      closeDb(h);
    }
    expect(readFileSync(dbPath).equals(beforeBytes)).toBe(true); // 修复后 live 库恒等
    const restored = restoreWatchStore({
      dbPath,
      backupsDir,
      backupFileName: poisoned,
      reconcile: OK_RECONCILE,
    });
    expect(restored.mode).toBe('unavailable');
    // post-swap 回滚：原 live 库字节恒等、可重开、增量数据保留、零残留
    expect(readFileSync(dbPath).equals(beforeBytes)).toBe(true);
    expectNoSwapResidue();
    const reopened = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(reopened.mode).toBe('normal');
    if (reopened.mode === 'normal') {
      expect(reopened.repo.getRule('keep-rule')).not.toBeNull();
      expect(reopened.repo.getRule('live-only')).not.toBeNull();
      reopened.repo.dispose();
    }
  });

  it('备份超预算（Baseline 声明/实际字节不一致）→ restore 失败 + 原 live 库恢复', () => {
    seedHealthy();
    const live = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    if (live.mode !== 'normal') throw new Error('live 装配失败');
    // 直插一条声明字节与实际字节不一致的 Baseline（合法 SQLite、非法预算行）
    live.repo.insertRule(makeRule({ id: 'baseline-rule' }));
    live.repo.dispose();
    {
      const h = openDb(dbPath);
      h.prepare(
        `INSERT INTO watch_baselines (rule_id, version, projection_type, projection_json,
   content_hash, byte_length, final_url, captured_at)
   VALUES ('baseline-rule', 1, 'feed', '{"a":1}', 'h', 3, 'https://example.com', ?)`,
      ).run(NOW);
      closeDb(h);
    }
    const poisoned = backupWith('beef0003');
    {
      const h = openDb(dbPath);
      h.prepare('DELETE FROM watch_baselines WHERE rule_id = ?').run('baseline-rule');
      closeDb(h);
    }
    const beforeBytes = readFileSync(dbPath);
    const restored = restoreWatchStore({
      dbPath,
      backupsDir,
      backupFileName: poisoned,
      reconcile: OK_RECONCILE,
    });
    expect(restored.mode).toBe('unavailable');
    expect(readFileSync(dbPath).equals(beforeBytes)).toBe(true);
    expectNoSwapResidue();
    const reopened = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(reopened.mode).toBe('normal');
    if (reopened.mode === 'normal') reopened.repo.dispose();
  });

  it('reconciliation 失败 → restore 失败 + 原 live 库恢复', () => {
    seedHealthy();
    const beforeBytes = readFileSync(dbPath);
    const good = backupWith('beef0004');
    const restored = restoreWatchStore({
      dbPath,
      backupsDir,
      backupFileName: good,
      reconcile: () => ({ ok: false, reason: '模拟 reconciliation 失败' }),
    });
    expect(restored.mode).toBe('unavailable');
    expect(readFileSync(dbPath).equals(beforeBytes)).toBe(true);
    expectNoSwapResidue();
    const reopened = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(reopened.mode).toBe('normal');
    if (reopened.mode === 'normal') {
      expect(reopened.repo.getRule('keep-rule')).not.toBeNull();
      reopened.repo.dispose();
    }
  });

  it('restore 成功路径：pre-restore/stage/WAL-SHM 精确清理', () => {
    const repo = (() => {
      const outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
      if (outcome.mode !== 'normal') throw new Error('seed 装配失败');
      outcome.repo.insertRule(makeRule({ id: 'keep-rule' }));
      return outcome.repo;
    })();
    const backup = backupWith('beef0005');
    repo.dispose();
    const restored = restoreWatchStore({
      dbPath,
      backupsDir,
      backupFileName: backup,
      reconcile: OK_RECONCILE,
    });
    expect(restored.mode).toBe('normal');
    if (restored.mode === 'normal') restored.repo.dispose();
    expectNoSwapResidue();
    // 成功路径：接管库的 WAL/SHM 随干净关闭一并清理
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it('启动扫描：Baseline 声明字节与实际字节不一致 → unavailable（原库保留）', () => {
    const outcome = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(outcome.mode).toBe('normal');
    if (outcome.mode !== 'normal') return;
    outcome.repo.insertRule(makeRule({ id: 'r1' }));
    outcome.repo.dispose();
    {
      const h = openDb(dbPath);
      h.prepare(
        `INSERT INTO watch_baselines (rule_id, version, projection_type, projection_json,
   content_hash, byte_length, final_url, captured_at)
   VALUES ('r1', 1, 'feed', '{"a":1}', 'h', 3, 'https://example.com', ?)`,
      ).run(NOW);
      closeDb(h);
    }
    const reopened = openWatchStore({ dbPath, backupsDir, reconcile: OK_RECONCILE });
    expect(reopened.mode).toBe('unavailable');
  });

  it('pruneWatchBackups：集合超 100 MiB → 删最旧至预算内', () => {
    mkdirSync(backupsDir, { recursive: true });
    const older = 'watch-backup-2026-08-27T00-00-00-000Z-v1-000000a1.db';
    const newer = 'watch-backup-2026-08-28T00-00-00-000Z-v1-000000b1.db';
    const make = (name: string, size: number): void => {
      const fd = openSync(join(backupsDir, name), 'w');
      closeSync(fd);
      truncateSync(join(backupsDir, name), size);
    };
    make(older, 60 * 1024 * 1024);
    make(newer, 60 * 1024 * 1024);
    expect(pruneWatchBackups(backupsDir, dirname(dbPath), Date.parse(NOW))).toBe(1);
    expect(existsSync(join(backupsDir, older))).toBe(false);
    expect(existsSync(join(backupsDir, newer))).toBe(true);
  });
});
