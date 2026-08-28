// D4 backup 前缀参数化测试（Sources 行为恒等 + Watch 独立命名/目录隔离）：
// - buildBackupNamePattern 前缀转义（正则元字符不可能成为匹配语义）；
// - watch 命名与 sources 命名互不匹配（prune 隔离）；
// - createConsistentBackup 以 watch 前缀 + 独立目录产出严格命名备份；
// - 非法前缀 fail-closed 抛错；Sources 缺省调用零变化（既有 backup.test.ts
//   37 用例零改动全绿）。
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BACKUP_NAME_PATTERN,
  buildBackupFileName,
  buildBackupNamePattern,
  createConsistentBackup,
  parseBackupTimestamp,
  pruneBackups,
  validateBackupTarget,
} from './backup';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-backup-prefix-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const WATCH_PATTERN = buildBackupNamePattern('watch-backup-');

describe('备份命名前缀参数化（D4；Sources 恒等）', () => {
  it('sources 缺省命名与模式恒等（既有行为零变化）', () => {
    const name = buildBackupFileName(1, Date.UTC(2026, 7, 28, 0, 0, 0), () => 'abcd1234');
    expect(name.startsWith('sources-backup-2026-08-28T00-00-00')).toBe(true);
    expect(BACKUP_NAME_PATTERN.test(name)).toBe(true);
    expect(parseBackupTimestamp(name)).toBe(Date.UTC(2026, 7, 28, 0, 0, 0));
    const target = validateBackupTarget(join(root, 'backups'), name);
    expect(target.ok).toBe(true);
  });

  it('watch 前缀命名 + 独立模式互不匹配（prune 隔离）', () => {
    const watchName = buildBackupFileName(
      0,
      Date.UTC(2026, 7, 28, 0, 0, 0),
      () => 'abcd1234',
      'watch-backup-',
    );
    expect(watchName.startsWith('watch-backup-')).toBe(true);
    expect(WATCH_PATTERN.test(watchName)).toBe(true);
    expect(BACKUP_NAME_PATTERN.test(watchName)).toBe(false); // Sources 模式不匹配
    expect(parseBackupTimestamp(watchName, WATCH_PATTERN)).toBe(Date.UTC(2026, 7, 28, 0, 0, 0));
    // watch 模式不匹配 sources 名
    const sourcesName = buildBackupFileName(0, Date.UTC(2026, 7, 28, 0, 0, 0), () => 'abcd1234');
    expect(WATCH_PATTERN.test(sourcesName)).toBe(false);
  });

  it('前缀正则元字符被转义（不可能构造匹配语义）', () => {
    expect(() => buildBackupNamePattern('wat.ch-backup-')).toThrow();
    expect(() => buildBackupNamePattern('../../etc')).toThrow();
    expect(() => buildBackupNamePattern('my-watch-backup-')).toThrow(); // 前缀为 <[a-z0-9]+>-backup- 精确形态
    expect(() => buildBackupFileName(1, Date.now(), undefined, 'bad')).toThrow();
    // 合法形态仍可用
    expect(buildBackupNamePattern('watch-backup-') instanceof RegExp).toBe(true);
  });

  it('pruneBackups 按注入模式隔离：watch 目录只清 watch 命名', () => {
    const dir = join(root, 'prune-watch');
    mkdirSync(dir, { recursive: true });
    const watchName = buildBackupFileName(
      0,
      Date.UTC(2026, 0, 1, 0, 0, 0),
      () => 'deadbeef',
      'watch-backup-',
    );
    const target = validateBackupTarget(dir, watchName, WATCH_PATTERN);
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    writeFileSync(target.path, 'x');
    const sourcesOnly = join(dir, 'sources-backup-2026-01-01T00-00-00-000Z-v0-ffffffff.db');
    writeFileSync(sourcesOnly, 'x');
    const result = pruneBackups(dir, {
      keepCount: 5,
      maxAgeMs: 30 * 24 * 60 * 60 * 1000,
      nowMs: Date.now(),
      namePattern: WATCH_PATTERN,
    });
    // 年龄 2026-01-01 → 超过 30 天 → 清理；sources 命名不匹配模式 → 保留
    expect(result.removed.length).toBe(1);
    expect(result.removed[0]).toContain('watch-backup-');
    expect(existsSync(sourcesOnly)).toBe(true);
  });

  it('createConsistentBackup 以 watch 前缀 + 独立目录产出严格命名备份', () => {
    const watchDir = join(root, 'watch-data');
    mkdirSync(watchDir, { recursive: true });
    const dbPath = join(watchDir, 'watch.db');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA user_version = 0');
    db.close();
    const result = createConsistentBackup(
      dbPath,
      join(watchDir, 'backups'),
      0,
      () => Date.UTC(2026, 7, 28, 0, 0, 0),
      () => 'beef0001',
      { namePrefix: 'watch-backup-', parentLabel: '监控' },
    );
    expect(result.ok).toBe(true);
    expect(result.backupPath).not.toBeNull();
    const issuedName = result.backupPath!.slice(result.backupPath!.lastIndexOf('\\') + 1);
    expect(issuedName.startsWith('watch-backup-')).toBe(true);
    expect(WATCH_PATTERN.test(issuedName)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D4-R：Watch 备份 100 MiB 集合预算（detailed-design §10.2：备份也受 100 MiB
// 与最多 5 份/30 天边界）——数量/期限/字节三边界组合，删除顺序确定性。
// Sources 缺省调用不传 maxTotalBytes → 行为恒等（既有 backup.test.ts 37 用例零改动）。
// ---------------------------------------------------------------------------

const MAX_BACKUP_BUDGET = 104_857_600; // 100 MiB（与 MAX_WATCH_DB_BYTES 同值）

describe('Watch 备份 100 MiB 集合预算（§10.2）', () => {
  function makeSparse(dir: string, name: string, size: number): void {
    const path = join(dir, name);
    const fd = openSync(path, 'w');
    closeSync(fd);
    truncateSync(path, size); // 稀疏文件：lstat.size 精确、创建极快
  }

  const nameAt = (ts: string, hex: string) => `watch-backup-${ts}-v1-${hex}.db`;
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 7, 28, 0, 0, 0);

  it('==100 MiB 恰好全部保留；+1 byte 删最旧（确定性顺序）', () => {
    const dir = mkdtempSync(join(root, 'budget-eq-'));
    const older = nameAt('2026-08-27T00-00-00-000Z', '000000a1');
    const newer = nameAt('2026-08-28T00-00-00-000Z', '000000b1');
    makeSparse(dir, older, MAX_BACKUP_BUDGET / 2);
    makeSparse(dir, newer, MAX_BACKUP_BUDGET / 2);
    let result = pruneBackups(dir, {
      keepCount: 5,
      maxAgeMs: 30 * DAY,
      nowMs: NOW,
      namePattern: WATCH_PATTERN,
      maxTotalBytes: MAX_BACKUP_BUDGET,
    });
    expect(result.removed).toEqual([]);
    expect(result.kept.length).toBe(2);
    // +1 byte：集合超预算 → 删最旧（older），新文件保留
    const extra = nameAt('2026-08-28T01-00-00-000Z', '000000c1');
    makeSparse(dir, extra, 1);
    result = pruneBackups(dir, {
      keepCount: 5,
      maxAgeMs: 30 * DAY,
      nowMs: NOW,
      namePattern: WATCH_PATTERN,
      maxTotalBytes: MAX_BACKUP_BUDGET,
    });
    expect(result.removed).toEqual([older]);
    expect(existsSync(join(dir, newer))).toBe(true);
    expect(existsSync(join(dir, extra))).toBe(true);
  });

  it('与 max 5/30 天组合：先数量后预算、删除顺序确定性（最旧优先）', () => {
    const dir = mkdtempSync(join(root, 'budget-combo-'));
    const names = [1, 2, 3, 4, 5, 6].map((i) =>
      nameAt(`2026-08-2${i}T00-00-00-000Z`, `000000${i}1`),
    );
    // 6 份 × 30 MiB = 180 MiB；max 5 → 数量规则删最旧 t1；预算再删 t2/t3 → 保留 3 份 90 MiB
    for (const n of names) makeSparse(dir, n, 30 * 1024 * 1024);
    const result = pruneBackups(dir, {
      keepCount: 5,
      maxAgeMs: 30 * DAY,
      nowMs: NOW,
      namePattern: WATCH_PATTERN,
      maxTotalBytes: MAX_BACKUP_BUDGET,
    });
    expect(result.removed).toEqual([names[0], names[1], names[2]]);
    expect(result.kept).toEqual([names[3], names[4], names[5]]);
    for (const n of result.kept) expect(existsSync(join(dir, n))).toBe(true);
    for (const n of result.removed) expect(existsSync(join(dir, n))).toBe(false);
  });

  it('30 天期限与预算组合：超龄先删，再按预算删最旧', () => {
    const dir = mkdtempSync(join(root, 'budget-age-'));
    // 40 天前的两份（各 60 MiB，超龄）+ 今天一份 60 MiB → 超龄先删；预算 100 MiB 内保留今天
    const expiredA = nameAt('2026-07-18T00-00-00-000Z', '000000e1');
    const expiredB = nameAt('2026-07-19T00-00-00-000Z', '000000e2');
    const fresh = nameAt('2026-08-28T00-00-00-000Z', '000000f1');
    makeSparse(dir, expiredA, 60 * 1024 * 1024);
    makeSparse(dir, expiredB, 60 * 1024 * 1024);
    makeSparse(dir, fresh, 60 * 1024 * 1024);
    const result = pruneBackups(dir, {
      keepCount: 5,
      maxAgeMs: 30 * DAY,
      nowMs: NOW,
      namePattern: WATCH_PATTERN,
      maxTotalBytes: MAX_BACKUP_BUDGET,
    });
    expect(result.removed).toEqual([expiredA, expiredB]);
    expect(existsSync(join(dir, fresh))).toBe(true);
  });

  it('无关文件/非链接语义：不匹配命名与目录条目零删除零计数', () => {
    const dir = mkdtempSync(join(root, 'budget-unrelated-'));
    const target = nameAt('2026-08-27T00-00-00-000Z', '000000a1');
    makeSparse(dir, target, MAX_BACKUP_BUDGET);
    makeSparse(dir, 'unrelated.bin', 200 * 1024 * 1024); // 无关文件不参与预算
    const result = pruneBackups(dir, {
      keepCount: 5,
      maxAgeMs: 30 * DAY,
      nowMs: NOW,
      namePattern: WATCH_PATTERN,
      maxTotalBytes: MAX_BACKUP_BUDGET,
    });
    expect(result.removed).toEqual([]); // 100 MiB == 预算：匹配文件保留
    expect(existsSync(join(dir, 'unrelated.bin'))).toBe(true);
  });

  it('非法 maxTotalBytes（NaN/负数/非整数）→ 安全空结果零删除', () => {
    const dir = mkdtempSync(join(root, 'budget-invalid-'));
    const target = nameAt('2026-08-27T00-00-00-000Z', '000000a1');
    makeSparse(dir, target, 1);
    for (const bad of [Number.NaN, -1, 1.5]) {
      const result = pruneBackups(dir, {
        keepCount: 5,
        maxAgeMs: 30 * DAY,
        nowMs: NOW,
        namePattern: WATCH_PATTERN,
        maxTotalBytes: bad,
      });
      expect(result.removed).toEqual([]);
      expect(existsSync(join(dir, target))).toBe(true);
    }
  });

  it('Sources 缺省（不传 maxTotalBytes）行为恒等：仅数量/期限生效', () => {
    const dir = mkdtempSync(join(root, 'budget-sources-'));
    const names = [1, 2, 3, 4, 5, 6].map((i) =>
      buildBackupFileName(0, Date.UTC(2026, 7, 28 - (i - 1), 0, 0, 0), () => 'abcd1234'),
    );
    for (const n of names) makeSparse(dir, n, 1);
    const result = pruneBackups(dir, {
      keepCount: 5,
      maxAgeMs: 30 * DAY,
      nowMs: NOW,
    });
    // 无字节预算：仅数量规则删最旧 1 份（其余 5 份保留，无论大小）
    expect(result.removed).toEqual([names[5]]);
    expect(result.kept.length).toBe(5);
  });
});
