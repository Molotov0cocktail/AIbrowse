// backup unit tests (B7): storage-operations module — read-only probing, VACUUM
// INTO consistent backup (adjudication #87 frozen approach), integrity/foreign-key
// checks and bounded retention pruning (adjudication #89: strict naming, regular
// files only, keep newest 5, drop older than 30 days, never touch the original DB
// or unrelated files). Test-only probe SQL is confined to this file (adjudication
// #47 spirit). Real node:sqlite under system Node (Vitest node env).
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// readFileSync 计数包装（行为透传；B7 安全加固断言「头部探测不整库读入」用）。
// vi.spyOn 对 ESM 命名空间不可用（Cannot redefine property），改用模块级 mock。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
import {
  BACKUP_KEEP_COUNT,
  BACKUP_MAX_AGE_MS,
  BACKUP_NAME_PATTERN,
  buildBackupFileName,
  checkDbIntegrity,
  createConsistentBackup,
  createConsistentBackupAt,
  probeDbFile,
  pruneBackups,
  quickCheckDb,
  validateBackupTarget,
} from './backup';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-backup-'));

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_MS = Date.UTC(2026, 7, 15, 0, 0, 0);

// 建立 WAL 活跃且带数据的库（含中文/引号内容），供备份一致性断言
function makeWalDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE legacy (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  db.prepare('INSERT INTO legacy(k, v) VALUES (?, ?)').run('a', "中文'引号");
  db.prepare('INSERT INTO legacy(k, v) VALUES (?, ?)').run('b', 'second');
  db.close();
}

function backupCount(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((n) => BACKUP_NAME_PATTERN.test(n)).length;
}

function readVersion(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

function readLegacyRows(path: string): { k: string; v: string }[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT k, v FROM legacy ORDER BY k').all() as {
      k: string;
      v: string;
    }[];
  } finally {
    db.close();
  }
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------- 1. 只读探测（启动顺序契约：先探测版本/完整性，不修改原库） ----------

describe('probeDbFile — 只读探测矩阵（不修改原库）', () => {
  it('文件缺失 → missing（新库创建路径）', () => {
    expect(probeDbFile(join(root, 'nope.db'))).toEqual({
      state: 'missing',
      userVersion: null,
      reason: null,
    });
  });

  it('正常 v0 库 → ok + userVersion 回读；探测前后文件字节不变', () => {
    const dbPath = join(root, 'probe-ok.db');
    makeWalDb(dbPath);
    const before = statSync(dbPath).size;
    const probe = probeDbFile(dbPath);
    expect(probe).toEqual({ state: 'ok', userVersion: 0, reason: null });
    expect(statSync(dbPath).size).toBe(before); // 探测不得写主文件
  });

  it('坏 magic（垃圾字节）→ bad-magic，文件保留', () => {
    const dbPath = join(root, 'probe-magic.db');
    writeFileSync(dbPath, Buffer.from('this is definitely not a sqlite database file'));
    expect(probeDbFile(dbPath)).toMatchObject({ state: 'bad-magic', userVersion: null });
    expect(existsSync(dbPath)).toBe(true);
  });

  it('空文件（截断形态）→ bad-magic，文件保留', () => {
    const dbPath = join(root, 'probe-empty.db');
    writeFileSync(dbPath, Buffer.alloc(0));
    expect(probeDbFile(dbPath)).toMatchObject({ state: 'bad-magic', userVersion: null });
    expect(existsSync(dbPath)).toBe(true);
  });

  it('截断库（magic 完好但无法打开）→ unopenable，文件保留', () => {
    const src = join(root, 'probe-src.db');
    makeWalDb(src);
    const bytes = new Uint8Array(readFileSync(src));
    const dbPath = join(root, 'probe-trunc.db');
    writeFileSync(dbPath, bytes.subarray(0, 512));
    expect(probeDbFile(dbPath)).toMatchObject({ state: 'unopenable', userVersion: null });
    expect(existsSync(dbPath)).toBe(true);
  });

  it('路径为目录 → not-a-file（环境配置类，调用方按不可用处理而非恢复态）', () => {
    const dirPath = join(root, 'probe-dir.db');
    mkdirSync(dirPath);
    expect(probeDbFile(dirPath)).toMatchObject({ state: 'not-a-file', userVersion: null });
  });
});

describe('quickCheckDb / checkDbIntegrity — 完整性探测', () => {
  it('健康库 → ok；外键违例 → 检出', () => {
    const dbPath = join(root, 'check-ok.db');
    makeWalDb(dbPath);
    expect(quickCheckDb(dbPath).ok).toBe(true);
    const healthy = checkDbIntegrity(dbPath);
    expect(healthy.ok).toBe(true);
    expect(healthy.integrity).toBe('ok');
    expect(healthy.foreignKeyViolations).toBe(0);
  });

  it('外键违例行 → foreignKeyViolations > 0 且 ok=false（迁移后检查会拒绝覆盖）', () => {
    const dbPath = join(root, 'check-fk.db');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(
      'CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE child (pid TEXT REFERENCES parent(id))',
    );
    db.prepare('INSERT INTO child (pid) VALUES (?)').run('ghost');
    db.close();
    const result = checkDbIntegrity(dbPath);
    expect(result.ok).toBe(false);
    expect(result.foreignKeyViolations).toBe(1);
  });
});

// ---------- 2. VACUUM INTO 一致性备份（决议 #87 冻结方案） ----------

describe('createConsistentBackup — WAL 活跃一致性备份', () => {
  it('WAL 活跃库 → 备份成功：严格命名 + 可打开 + 数据完整 + integrity ok + user_version 匹配', () => {
    const dbPath = join(root, 'backup-wal.db');
    makeWalDb(dbPath);
    const backupsDir = join(root, 'backups-wal');
    const result = createConsistentBackup(dbPath, backupsDir, 0, () => BASE_MS);
    expect(result.ok, result.reason ?? '').toBe(true);
    expect(result.backupPath).not.toBeNull();
    expect(BACKUP_NAME_PATTERN.test(result.backupPath!.split(/[\\/]/).pop()!)).toBe(true);
    expect(readVersion(result.backupPath!)).toBe(0);
    expect(readLegacyRows(result.backupPath!)).toEqual([
      { k: 'a', v: "中文'引号" },
      { k: 'b', v: 'second' },
    ]);
    const integrity = checkDbIntegrity(result.backupPath!);
    expect(integrity.ok).toBe(true);
  });

  it('目标碰撞（目标已存在）→ fail-closed 拒绝且已有文件不被删除/覆盖', () => {
    const dbPath = join(root, 'backup-collide.db');
    makeWalDb(dbPath);
    const backupsDir = join(root, 'backups-collide');
    mkdirSync(backupsDir, { recursive: true });
    const name = buildBackupFileName(0, BASE_MS);
    const target = join(backupsDir, name);
    writeFileSync(target, 'garbage-not-a-database');
    const result = createConsistentBackupAt(dbPath, target, 0);
    expect(result.ok).toBe(false);
    expect(result.backupPath).toBeNull();
    expect(readFileSync(target, 'utf8')).toBe('garbage-not-a-database'); // 绝不删除/覆盖
  });

  it('版本不匹配（备份内容 user_version ≠ 预期）→ 失败且删除损坏备份', () => {
    const dbPath = join(root, 'backup-ver.db');
    makeWalDb(dbPath);
    const backupsDir = join(root, 'backups-ver');
    const result = createConsistentBackup(dbPath, backupsDir, 5, () => BASE_MS); // 预期 5 实际 0
    expect(result.ok).toBe(false);
    expect(result.backupPath).toBeNull();
    expect(backupCount(backupsDir)).toBe(0); // 部分备份已清理，零残留
  });

  it('路径校验：非严格命名/相对路径/穿越 → 拒绝', () => {
    const dbPath = join(root, 'backup-val.db');
    makeWalDb(dbPath);
    expect(validateBackupTarget(join(root, 'bk'), 'evil.db').ok).toBe(false);
    expect(validateBackupTarget(join(root, 'bk'), '../outside.db').ok).toBe(false);
    expect(
      validateBackupTarget(join(root, 'bk'), 'sources-backup-2026-08-15T00-00-00Z-v0-00000000.db'),
    ).toEqual({
      ok: true,
      path: join(root, 'bk', 'sources-backup-2026-08-15T00-00-00Z-v0-00000000.db'),
    });
    expect(validateBackupTarget(join(root, 'bk'), 'sources-backup-X-v1-00000000.db').ok).toBe(
      false,
    );
  });

  it('源库不存在 → 失败（reason 非空，不抛异常）', () => {
    const result = createConsistentBackup(
      join(root, 'no-such.db'),
      join(root, 'bk-missing'),
      0,
      () => BASE_MS,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).not.toBeNull();
  });
});

// ---------- 3. 有界保留清理（决议 #89） ----------

describe('pruneBackups — 严格命名 + 普通文件 + 5/30 天上界', () => {
  // 生成严格命名的备份夹具（内容可为垃圾——清理只按名字与时间判定）
  function makeBackup(dir: string, ts: number, version = 1): string {
    const name = buildBackupFileName(version, ts);
    const path = join(dir, name);
    writeFileSync(path, 'fixture');
    return path;
  }

  it('5 个全部新 → 全保留；6 个 → 删最旧 1 个（5 上界）', () => {
    const dir = join(root, 'prune-5');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i += 1) makeBackup(dir, BASE_MS + i * 1000);
    expect(pruneBackups(dir, { nowMs: BASE_MS + 10 * DAY_MS }).removed).toHaveLength(0);
    expect(backupCount(dir)).toBe(5);
    const oldest = makeBackup(dir, BASE_MS - 1000); // 第 6 个，最旧
    const oldestName = oldest.split(/[\\/]/).pop()!;
    const result = pruneBackups(dir, { nowMs: BASE_MS + 10 * DAY_MS });
    expect(result.removed).toEqual([oldestName]);
    expect(backupCount(dir)).toBe(5);
  });

  it('30 天上界：31 天前删除、29 天前保留（即使总数 < 5）', () => {
    const dir = join(root, 'prune-30');
    mkdirSync(dir, { recursive: true });
    const old = makeBackup(dir, BASE_MS - 31 * DAY_MS);
    const oldName = old.split(/[\\/]/).pop()!;
    const young = makeBackup(dir, BASE_MS - 29 * DAY_MS);
    const result = pruneBackups(dir, { nowMs: BASE_MS });
    expect(result.removed).toEqual([oldName]);
    expect(existsSync(young)).toBe(true);
    expect(backupCount(dir)).toBe(1);
  });

  it('边界：恰好 30 天 → 保留（超过 30 天才清理）', () => {
    const dir = join(root, 'prune-boundary');
    mkdirSync(dir, { recursive: true });
    const exact = makeBackup(dir, BASE_MS - 30 * DAY_MS);
    const result = pruneBackups(dir, { nowMs: BASE_MS });
    expect(result.removed).toHaveLength(0);
    expect(existsSync(exact)).toBe(true);
  });

  it('非严格命名/目录/符号链接/无关文件一律不动；绝不删除原库', () => {
    const dir = join(root, 'prune-unrelated');
    mkdirSync(dir, { recursive: true });
    makeBackup(dir, BASE_MS - 40 * DAY_MS); // 会被清理的合法旧备份
    writeFileSync(join(dir, 'notes.txt'), 'keep');
    writeFileSync(join(dir, 'sources-backup-WEIRD.db'), 'keep'); // 名字不符
    writeFileSync(join(dir, 'sources.db'), 'original'); // 原库形态（绝不删除）
    mkdirSync(join(dir, 'subdir-backup'));
    let symlinkSkipped = false;
    try {
      symlinkSync(join(dir, 'notes.txt'), join(dir, 'link.db'));
    } catch {
      symlinkSkipped = true; // Windows 无权限创建符号链接时如实跳过该夹具
    }
    pruneBackups(dir, { nowMs: BASE_MS });
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
    expect(existsSync(join(dir, 'sources-backup-WEIRD.db'))).toBe(true);
    expect(existsSync(join(dir, 'sources.db'))).toBe(true);
    expect(lstatSync(join(dir, 'subdir-backup')).isDirectory()).toBe(true);
    if (!symlinkSkipped) {
      expect(existsSync(join(dir, 'link.db'))).toBe(true);
      expect(existsSync(join(dir, 'notes.txt'))).toBe(true); // 链接目标未被误删
    }
    expect(backupCount(dir)).toBe(0); // 仅严格命名的旧备份被清理
  });

  it('目标 backups 目录不存在 → 安全空结果（不抛异常）', () => {
    expect(pruneBackups(join(root, 'prune-none'), { nowMs: BASE_MS })).toEqual({
      removed: [],
      kept: [],
    });
  });

  it('排序确定性：同名时间戳按全名排序（8-hex 后缀收尾）', () => {
    const dir = join(root, 'prune-sort');
    mkdirSync(dir, { recursive: true });
    const sameTime = Array.from({ length: 6 }, (_, i) => makeBackup(dir, BASE_MS + i));
    const result = pruneBackups(dir, { nowMs: BASE_MS + 10 * DAY_MS });
    expect(result.removed).toEqual([sameTime[0]!.split(/[\\/]/).pop()!]); // 删除最旧（最小后缀）
    expect(result.kept).toHaveLength(BACKUP_KEEP_COUNT);
  });
});

// ---------- 4. 常量契约 ----------

describe('backup 常量与命名', () => {
  it('BACKUP_KEEP_COUNT = 5；BACKUP_MAX_AGE_MS = 30 天；命名可解析时间', () => {
    expect(BACKUP_KEEP_COUNT).toBe(5);
    expect(BACKUP_MAX_AGE_MS).toBe(30 * DAY_MS);
    const name = buildBackupFileName(1, BASE_MS);
    expect(BACKUP_NAME_PATTERN.test(name)).toBe(true);
    expect(name).toContain('-v1-');
    expect(name.endsWith('.db')).toBe(true);
  });
});

// ---------- 5. B7 安全加固（2026-08-15 事故恢复审查，红→绿）----------
// 头部固定 16 字节读取（不整库读入内存）/ 目标碰撞 fail-closed（不删除已有文件）/
// 目录 symlink/junction 越界拒绝 / 备份不写源库 / 保留清理参数边界验证。

describe('probeDbFile — 头部固定 16 字节读取（大库无界内存红线）', () => {
  it('探测仅读取固定 16 字节头：readFileSync 零调用', () => {
    const dbPath = join(root, 'probe-header.db');
    makeWalDb(dbPath);
    const readFileMock = vi.mocked(readFileSync);
    readFileMock.mockClear();
    const probe = probeDbFile(dbPath);
    expect(probe.state).toBe('ok');
    expect(readFileMock).not.toHaveBeenCalled(); // 绝不整库读入内存
  });

  it('稀疏大文件（1 GiB 坏头）→ bad-magic 快速返回，不整库读入', () => {
    const dbPath = join(root, 'probe-sparse.db');
    writeFileSync(dbPath, Buffer.alloc(0));
    const fd = openSync(dbPath, 'w');
    try {
      ftruncateSync(fd, 1024 * 1024 * 1024); // 稀疏 1 GiB（不实际分配磁盘）
    } finally {
      closeSync(fd);
    }
    expect(probeDbFile(dbPath)).toMatchObject({ state: 'bad-magic', userVersion: null });
    expect(existsSync(dbPath)).toBe(true); // 探测不得修改/删除原文件
  });
});

describe('createConsistentBackup — 碰撞 fail-closed 与目录链接/越界拒绝', () => {
  it('目标名碰撞（注入随机后缀先碰撞后变化）→ 生成新名成功；已存在文件不被删除/覆盖', () => {
    const dbPath = join(root, 'backup-rename.db');
    makeWalDb(dbPath);
    const backupsDir = join(root, 'backup-rename-bk');
    mkdirSync(backupsDir, { recursive: true });
    const ts = new Date(BASE_MS).toISOString().replace(/[:.]/g, '-');
    const collideHex = 'a1b2c3d4';
    const freshHex = '5e6f7a8b';
    const collideName = `sources-backup-${ts}-v0-${collideHex}.db`;
    writeFileSync(join(backupsDir, collideName), 'existing-valid-backup-bytes');
    const hexes = [collideHex, freshHex];
    const result = createConsistentBackup(
      dbPath,
      backupsDir,
      0,
      () => BASE_MS,
      () => hexes.shift()!,
    );
    expect(result.ok, result.reason ?? '').toBe(true);
    expect(readFileSync(join(backupsDir, collideName), 'utf8')).toBe('existing-valid-backup-bytes');
    expect(result.backupPath).toBe(join(backupsDir, `sources-backup-${ts}-v0-${freshHex}.db`));
    expect(backupCount(backupsDir)).toBe(2); // 预置文件 + 新备份并存
  });

  it('目标名持续碰撞（注入后缀恒碰撞）→ fail-closed 失败且预置文件不动', () => {
    const dbPath = join(root, 'backup-fc-retry.db');
    makeWalDb(dbPath);
    const backupsDir = join(root, 'backup-fc-retry-bk');
    mkdirSync(backupsDir, { recursive: true });
    const ts = new Date(BASE_MS).toISOString().replace(/[:.]/g, '-');
    const collideHex = 'a1b2c3d4';
    const collideName = `sources-backup-${ts}-v0-${collideHex}.db`;
    writeFileSync(join(backupsDir, collideName), 'existing');
    const result = createConsistentBackup(
      dbPath,
      backupsDir,
      0,
      () => BASE_MS,
      () => collideHex,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).not.toBeNull();
    expect(readFileSync(join(backupsDir, collideName), 'utf8')).toBe('existing');
    expect(backupCount(backupsDir)).toBe(1); // 仅预置文件，零覆盖零残留
  });

  it('backups 目录为 junction（指向外部目录）→ 拒绝；链接目标零写入、链接形态保留', () => {
    const dbPath = join(root, 'backup-junc.db');
    makeWalDb(dbPath);
    // 链接目标必须在源库目录（root）之外——独立 TEMP 子目录
    const outside = mkdtempSync(join(tmpdir(), 'aibrowse-backup-junc-outside-'));
    const junctionDir = join(root, 'backup-junc-link');
    let skipped = false;
    try {
      symlinkSync(outside, junctionDir, 'junction');
    } catch {
      skipped = true; // 无权限创建 junction 的环境如实跳过该夹具
    }
    try {
      if (!skipped) {
        const result = createConsistentBackup(dbPath, junctionDir, 0, () => BASE_MS);
        expect(result.ok).toBe(false);
        expect(result.reason).not.toBeNull();
        expect(readdirSync(outside)).toHaveLength(0); // 链接目标零写入
        expect(lstatSync(junctionDir).isSymbolicLink()).toBe(true); // 链接形态原样保留
      }
    } finally {
      // junction 必须显式清理（rmdirSync 删除 reparse point 本身，不触碰目标内容）
      try {
        rmdirSync(junctionDir);
      } catch {
        // 未创建（skipped）或已清理
      }
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('backups 目录位于源库目录外（普通目录）→ 拒绝（目标必须位于预期 Sources 目录内）', () => {
    const dbPath = join(root, 'backup-outside.db');
    makeWalDb(dbPath);
    const outsideRoot = mkdtempSync(join(tmpdir(), 'aibrowse-backup-outside-'));
    try {
      const result = createConsistentBackup(dbPath, join(outsideRoot, 'backups'), 0, () => BASE_MS);
      expect(result.ok).toBe(false);
      expect(result.reason).not.toBeNull();
      expect(existsSync(join(outsideRoot, 'backups'))).toBe(false); // 目录零创建
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('备份过程不修改源库主文件（WAL 活跃库字节恒等）', () => {
    const dbPath = join(root, 'backup-byte.db');
    makeWalDb(dbPath);
    const hashBefore = createHash('sha256').update(readFileSync(dbPath)).digest('hex');
    const result = createConsistentBackup(dbPath, join(root, 'backup-byte-bk'), 0, () => BASE_MS);
    expect(result.ok, result.reason ?? '').toBe(true);
    expect(createHash('sha256').update(readFileSync(dbPath)).digest('hex')).toBe(hashBefore);
  });
});

describe('pruneBackups — 参数边界验证（非有限/负值 → 安全空结果零删除）', () => {
  function makePruneBackup(dir: string, ts: number): string {
    const name = buildBackupFileName(1, ts);
    const path = join(dir, name);
    writeFileSync(path, 'fixture');
    return path;
  }

  it('keepCount=NaN / -1 / 1.5 / Infinity、maxAgeMs=-1 / Infinity、nowMs=NaN → 零删除零处理', () => {
    const dir = join(root, 'prune-invalid');
    mkdirSync(dir, { recursive: true });
    makePruneBackup(dir, BASE_MS - 40 * DAY_MS); // 正常清理下必然被删的旧备份
    makePruneBackup(dir, BASE_MS - 41 * DAY_MS);
    const cases: Array<Record<string, number>> = [
      { keepCount: Number.NaN },
      { keepCount: -1 },
      { keepCount: 1.5 },
      { keepCount: Number.POSITIVE_INFINITY },
      { maxAgeMs: -1 },
      { maxAgeMs: Number.POSITIVE_INFINITY },
      { nowMs: Number.NaN },
    ];
    for (const opts of cases) {
      const result = pruneBackups(dir, opts);
      expect(result.removed).toEqual([]);
      expect(result.kept).toEqual([]);
      expect(backupCount(dir)).toBe(2); // 全部文件原样保留
    }
  });

  it('backups 目录为 junction → 安全空结果（绝不跟随链接枚举/删除链接目标内文件）', () => {
    const outside = mkdtempSync(join(tmpdir(), 'aibrowse-prune-junc-outside-'));
    const name = buildBackupFileName(1, BASE_MS - 40 * DAY_MS);
    writeFileSync(join(outside, name), 'keep');
    const junctionDir = join(root, 'prune-junc-link');
    let skipped = false;
    try {
      symlinkSync(outside, junctionDir, 'junction');
    } catch {
      skipped = true;
    }
    try {
      if (!skipped) {
        const result = pruneBackups(junctionDir, { nowMs: BASE_MS });
        expect(result.removed).toEqual([]);
        expect(existsSync(join(outside, name))).toBe(true); // 链接目标内文件不动
      }
    } finally {
      try {
        rmdirSync(junctionDir); // 显式删除链接本身
      } catch {
        // 未创建或已清理
      }
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('sourcesDir 提供时：backups 目录真实路径越界 → 安全空结果零删除', () => {
    const dir = join(root, 'prune-outside');
    mkdirSync(dir, { recursive: true });
    const name = buildBackupFileName(1, BASE_MS - 40 * DAY_MS);
    writeFileSync(join(dir, name), 'keep');
    const outsideRoot = mkdtempSync(join(tmpdir(), 'aibrowse-prune-outside-'));
    try {
      const result = pruneBackups(dir, {
        nowMs: BASE_MS,
        sourcesDir: join(outsideRoot, 'sources'),
      });
      expect(result.removed).toEqual([]);
      expect(existsSync(join(dir, name))).toBe(true);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});
