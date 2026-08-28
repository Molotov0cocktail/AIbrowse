// D4 backup 前缀参数化测试（Sources 行为恒等 + Watch 独立命名/目录隔离）：
// - buildBackupNamePattern 前缀转义（正则元字符不可能成为匹配语义）；
// - watch 命名与 sources 命名互不匹配（prune 隔离）；
// - createConsistentBackup 以 watch 前缀 + 独立目录产出严格命名备份；
// - 非法前缀 fail-closed 抛错；Sources 缺省调用零变化（既有 backup.test.ts
//   37 用例零改动全绿）。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
