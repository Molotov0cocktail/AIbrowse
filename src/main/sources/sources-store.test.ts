// sources-store unit tests (B7): startup assembly matrix — probe → backup →
// stepwise migration → integrity/foreign-key checks → normal | readonly-recovery |
// unavailable (detailed-design §10, adjudications #86–#89). Real node:sqlite under
// system Node; test-only SQL confined to this file. Recovery contract
// (adjudication #39/#52): all reads/writes/undo/usage/rebuild rejected with
// source-unavailable, zero disk writes, browser unaffected (store assembly is
// Sources-local). Migration-failure contract (adjudication #88): the original DB
// path is never replaced/truncated; after rollback user_version/schema/data stay
// logically identical; the pre-migration backup opens and is complete.
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { MigrationStep } from './db/migrations';
import { openSourcesStore, type SourcesStoreOutcome } from './sources-store';
import type { SourceService } from '../../shared/types/sources';
import { BACKUP_NAME_PATTERN } from './db/backup';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-sources-store-'));
const BASE_MS = Date.UTC(2026, 7, 15, 0, 0, 0);

// 旧版本库夹具：user_version=0 + 遗留数据（模拟 v0 → v1 升级路径）
function makeV0Db(path: string): void {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version = 0');
  db.exec('CREATE TABLE legacy_marks (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  db.prepare('INSERT INTO legacy_marks(k, v) VALUES (?, ?)').run('m', '遗留数据');
  db.close();
}

function readVersion(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

function readLegacy(path: string): string | null {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT v FROM legacy_marks WHERE k = 'm'").get() as
      { v: string } | undefined;
    return row === undefined ? null : row.v;
  } catch {
    return null; // 遗留表被迁移移除即不匹配
  } finally {
    db.close();
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function backupNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => BACKUP_NAME_PATTERN.test(n))
    .sort();
}

const okList = async (service: SourceService) =>
  service.list({ page: 0, pageSize: 20, audience: 'user' });

// 判别联合收窄（Vitest expect 不做类型收窄）——断言 mode 后安全取 service
const normalService = (outcome: SourcesStoreOutcome): SourceService => {
  expect(outcome.mode).toBe('normal');
  if (outcome.mode !== 'normal') throw new Error('unreachable');
  return outcome.service;
};
const recoveryService = (outcome: SourcesStoreOutcome): SourceService => {
  expect(outcome.mode).toBe('readonly-recovery');
  if (outcome.mode !== 'readonly-recovery') throw new Error('unreachable');
  return outcome.service;
};

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------- 1. 正常路径 ----------

describe('openSourcesStore — 正常路径', () => {
  it('新库首次创建 → normal；不生成无意义备份（backups 目录不存在或为空）', async () => {
    const dbPath = join(root, 'fresh.db');
    const backupsDir = join(root, 'fresh-backups');
    const outcome = openSourcesStore({ dbPath, backupsDir, nowMs: () => BASE_MS });
    expect(outcome.mode).toBe('normal');
    expect(readVersion(dbPath)).toBe(1); // 新库直接迁移到 v1
    expect(backupNames(backupsDir)).toHaveLength(0);
    const list = await okList(normalService(outcome));
    expect(list.ok).toBe(true);
    outcome.service?.dispose();
  });

  it('v0 → v1：先备份后迁移；备份严格命名且可打开完整；迁移后 normal', async () => {
    const dbPath = join(root, 'migrate.db');
    makeV0Db(dbPath);
    const backupsDir = join(root, 'migrate-backups');
    const outcome = openSourcesStore({ dbPath, backupsDir, nowMs: () => BASE_MS });
    expect(outcome.mode).toBe('normal');
    expect(readVersion(dbPath)).toBe(1);
    const backups = backupNames(backupsDir);
    expect(backups).toHaveLength(1); // 恰好一个迁移前一致性备份
    const backupPath = join(backupsDir, backups[0]!);
    expect(readVersion(backupPath)).toBe(0); // 备份是迁移前版本
    expect(readLegacy(backupPath)).toBe('遗留数据'); // 备份完整（决议 #88 一致性备份）
    const list = await okList(normalService(outcome));
    expect(list.ok).toBe(true);
    outcome.service?.dispose();
  });

  it('当前有效版本（v1）→ normal，不重复迁移、不生成备份', async () => {
    const dbPath = join(root, 'uptodate.db');
    const first = openSourcesStore({
      dbPath,
      backupsDir: join(root, 'uptodate-bk'),
      nowMs: () => BASE_MS,
    });
    expect(first.mode).toBe('normal');
    first.service?.dispose();
    const second = openSourcesStore({
      dbPath,
      backupsDir: join(root, 'uptodate-bk'),
      nowMs: () => BASE_MS,
    });
    expect(second.mode).toBe('normal');
    expect(readVersion(dbPath)).toBe(1);
    expect(backupNames(join(root, 'uptodate-bk'))).toHaveLength(0);
    second.service?.dispose();
  });
});

// ---------- 2. 迁移失败 / 未来版本 / 损坏 → readonly-recovery ----------

describe('openSourcesStore — 迁移失败回滚（决议 #88 原库逻辑恒等）', () => {
  it('注入迁移失败 → readonly-recovery；原库 user_version/数据逻辑恒等；备份存在且完整', async () => {
    const dbPath = join(root, 'mig-fail.db');
    makeV0Db(dbPath);
    const hashBefore = sha256(dbPath);
    const failing: MigrationStep = {
      version: 1,
      statements: ['CREATE TABLE ok_step (x TEXT)', 'THIS IS NOT VALID SQL ((('],
    };
    const backupsDir = join(root, 'mig-fail-backups');
    const outcome = openSourcesStore({
      dbPath,
      backupsDir,
      migrations: [failing],
      nowMs: () => BASE_MS,
    });
    expect(outcome.mode).toBe('readonly-recovery');
    expect(outcome.reason).toContain('迁移');
    // 原库保留且逻辑恒等：版本未变、遗留数据可读
    expect(readVersion(dbPath)).toBe(0);
    expect(readLegacy(dbPath)).toBe('遗留数据');
    // 事务回滚零部分状态：失败语句前成功的建表步骤也一并回滚
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    db.close();
    expect(tables.some((t) => t.name === 'ok_step')).toBe(false);
    // 迁移前一致性备份存在且可打开完整
    const backups = backupNames(backupsDir);
    expect(backups).toHaveLength(1);
    expect(readLegacy(join(backupsDir, backups[0]!))).toBe('遗留数据');
    // 文件路径未被替换/截断（字节恒等——决议 #88 不要求 WAL/SHM 恒等，主文件必须原样）
    expect(sha256(dbPath)).toBe(hashBefore);
    outcome.service?.dispose();
  });

  it('恢复态 service：读写/Undo/usage/rebuild 全拒 + 数据库零变化', async () => {
    const dbPath = join(root, 'mig-fail-reject.db');
    makeV0Db(dbPath);
    const outcome = openSourcesStore({
      dbPath,
      backupsDir: join(root, 'mig-fail-reject-bk'),
      migrations: [{ version: 1, statements: ['INVALID SQL (('] }],
      nowMs: () => BASE_MS,
    });
    expect(outcome.mode).toBe('readonly-recovery');
    const service = recoveryService(outcome);
    const hashBefore = sha256(dbPath);
    // 读入口（决议 #39 一并拒绝）
    expect(await service.list({ page: 0, audience: 'user' })).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    expect(await service.search('x', { audience: 'user' })).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    expect(await service.get('11111111-1111-4111-8111-111111111111', 'user')).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    expect(await service.listGroups({ page: 0 })).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    expect(await service.listUndoable()).toEqual([]);
    // 写入口
    expect(await service.addManual({ scope: 'page', url: 'https://example.com/x' })).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    expect(
      await service.updateManual('11111111-1111-4111-8111-111111111111', { name: 'n' }, 1),
    ).toEqual({ ok: false, errorCode: 'source-unavailable' });
    expect(await service.disableManual('11111111-1111-4111-8111-111111111111', 1)).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    expect(await service.restoreManual('11111111-1111-4111-8111-111111111111', 1)).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    expect(await service.hardDeleteManual('11111111-1111-4111-8111-111111111111', 'tok')).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    expect(
      await service.applyChangeSet(
        { ops: [{ kind: 'add', scope: 'page', url: 'https://example.com/y' }] },
        { runId: 'r', toolCallId: 't' },
      ),
    ).toEqual({ ok: false, idempotencyKey: '', errorCode: 'source-unavailable', results: [] });
    expect(
      await service.previewChangeSet({
        ops: [{ kind: 'add', scope: 'page', url: 'https://example.com/z' }],
      }),
    ).toEqual({ ok: false, opsCount: 0, errorCode: 'source-unavailable' }); // 恢复态门控先于结构统计（B4 既有语义）
    expect(await service.undoChange('k')).toEqual({ ok: false, errorCode: 'source-unavailable' });
    expect(await service.quickAddPage('https://example.com/q')).toEqual({
      status: 'error',
      errorCode: 'source-unavailable',
    });
    // usage 零写入（B6 契约安全 no-op）
    await service.recordUsage('11111111-1111-4111-8111-111111111111', 'reachable');
    // rebuild 拒绝（诊断入口仅 normal 状态）
    const rebuild = await service.rebuildSearchIndex();
    expect(rebuild.ok).toBe(false);
    // 令牌签发放行（hardDelete 门控已拒）或空串均可；仅断言不抛
    expect(typeof service.issueDeleteConfirmToken('11111111-1111-4111-8111-111111111111')).toBe(
      'string',
    );
    // getState 恢复态 + 中文原因
    expect(service.getState().mode).toBe('readonly-recovery');
    expect(service.getState().reason).not.toBeNull();
    // 数据库零变化（全拒后文件字节不变）
    expect(sha256(dbPath)).toBe(hashBefore);
    service.dispose();
    service.dispose(); // 幂等
  });
});

describe('openSourcesStore — 未来版本 / 损坏 / 截断 / 坏 magic → readonly-recovery', () => {
  it('user_version > 程序版本 → readonly-recovery + 零写入（字节恒等）', async () => {
    const dbPath = join(root, 'future.db');
    makeV0Db(dbPath);
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA user_version = 99');
    db.close();
    const hashBefore = sha256(dbPath);
    const outcome = openSourcesStore({
      dbPath,
      backupsDir: join(root, 'future-bk'),
      nowMs: () => BASE_MS,
    });
    expect(outcome.mode).toBe('readonly-recovery');
    expect(outcome.reason).toContain('版本');
    expect(sha256(dbPath)).toBe(hashBefore);
    expect(backupNames(join(root, 'future-bk'))).toHaveLength(0); // 未来版本零备份零写
    expect(await okList(recoveryService(outcome))).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    outcome.service?.dispose();
  });

  it('坏 magic → readonly-recovery；原文件保留（字节不变）', () => {
    const dbPath = join(root, 'badmagic.db');
    writeFileSync(dbPath, 'garbage garbage garbage');
    const hashBefore = sha256(dbPath);
    const outcome = openSourcesStore({
      dbPath,
      backupsDir: join(root, 'badmagic-bk'),
      nowMs: () => BASE_MS,
    });
    expect(outcome.mode).toBe('readonly-recovery');
    expect(sha256(dbPath)).toBe(hashBefore);
    outcome.service?.dispose();
  });

  it('截断库 → readonly-recovery；原文件保留', () => {
    const src = join(root, 'trunc-src.db');
    makeV0Db(src);
    const bytes = new Uint8Array(readFileSync(src));
    const dbPath = join(root, 'trunc.db');
    writeFileSync(dbPath, bytes.subarray(0, 300));
    const hashBefore = sha256(dbPath);
    const outcome = openSourcesStore({
      dbPath,
      backupsDir: join(root, 'trunc-bk'),
      nowMs: () => BASE_MS,
    });
    expect(outcome.mode).toBe('readonly-recovery');
    expect(sha256(dbPath)).toBe(hashBefore);
    outcome.service?.dispose();
  });
});

// ---------- 3. 非恢复性初始化故障 → unavailable ----------

describe('openSourcesStore — 初始化故障 → unavailable（非恢复态）', () => {
  it('dbPath 为目录（无法创建/打开数据库）→ unavailable + service null', () => {
    const dbPath = join(root, 'as-dir.db');
    mkdirSync(dbPath);
    const outcome = openSourcesStore({
      dbPath,
      backupsDir: join(root, 'as-dir-bk'),
      nowMs: () => BASE_MS,
    });
    expect(outcome.mode).toBe('unavailable');
    expect(outcome.service).toBeNull();
    expect(outcome.reason).not.toBeNull();
  });
});

// ---------- 4. B7 安全加固（2026-08-15 事故恢复审查，红→绿）----------
// 备份目录 symlink/junction 越界或位于源库目录外 → 备份失败进恢复态（原库零修改、
// 链接目标零写入）——所有备份目标必须位于预期 Sources 目录内。

describe('openSourcesStore — 备份目录链接/越界 → 备份失败恢复态（原库不动）', () => {
  it('backupsDir 为 junction（指向外部目录）→ readonly-recovery；原库字节不变；链接目标零写入', () => {
    const dbPath = join(root, 'store-junc.db');
    makeV0Db(dbPath);
    const hashBefore = sha256(dbPath);
    // 链接目标必须在源库目录（root）之外——独立 TEMP 子目录
    const outside = mkdtempSync(join(tmpdir(), 'aibrowse-store-junc-outside-'));
    const junctionDir = join(root, 'store-junc-link');
    let skipped = false;
    try {
      symlinkSync(outside, junctionDir, 'junction');
    } catch {
      skipped = true; // 无权限创建 junction 的环境如实跳过该夹具
    }
    try {
      if (!skipped) {
        const outcome = openSourcesStore({
          dbPath,
          backupsDir: junctionDir,
          nowMs: () => BASE_MS,
        });
        expect(outcome.mode).toBe('readonly-recovery');
        expect(outcome.reason).toContain('备份');
        expect(readVersion(dbPath)).toBe(0); // 未迁移
        expect(sha256(dbPath)).toBe(hashBefore); // 原库零修改
        expect(readdirSync(outside)).toHaveLength(0); // 链接目标零写入
        expect(lstatSync(junctionDir).isSymbolicLink()).toBe(true); // 链接形态原样保留
        outcome.service?.dispose();
      }
    } finally {
      try {
        rmdirSync(junctionDir); // 显式删除链接本身（reparse point 不递归）
      } catch {
        // 未创建或已清理
      }
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('backupsDir 位于源库目录外（普通目录）→ readonly-recovery 且原库零修改', () => {
    const dbPath = join(root, 'store-outside.db');
    makeV0Db(dbPath);
    const hashBefore = sha256(dbPath);
    const outsideRoot = mkdtempSync(join(tmpdir(), 'aibrowse-store-outside-'));
    try {
      const outcome = openSourcesStore({
        dbPath,
        backupsDir: join(outsideRoot, 'backups'),
        nowMs: () => BASE_MS,
      });
      expect(outcome.mode).toBe('readonly-recovery');
      expect(outcome.reason).toContain('备份');
      expect(readVersion(dbPath)).toBe(0);
      expect(sha256(dbPath)).toBe(hashBefore);
      expect(existsSync(join(outsideRoot, 'backups'))).toBe(false); // 外部目录零创建
      outcome.service?.dispose();
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});
