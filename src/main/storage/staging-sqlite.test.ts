import { DatabaseSync } from 'node:sqlite';
import {
  copyFileSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openPrivateStagingDatabase, STAGING_DATABASE_LIMITS } from './staging-sqlite';
import { normalizeTransferSchema } from './transfer-schema';
import { normalizeAndVerifySourceIndex } from '../sources/repository/source-transfer-validation';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-staging-sqlite-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let serial = 0;
function file(): string {
  const path = join(root, `${serial++}.db`);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version = 0');
  db.close();
  return path;
}

describe('私有staging SQLite固定配置', () => {
  it('拒绝不存在的文件而不创建，拒绝目录和多硬链接', () => {
    const missing = join(root, 'missing.db');
    expect(() => openPrivateStagingDatabase(missing, 'sources')).toThrow();
    expect(readdirSync(root)).not.toContain('missing.db');
    expect(() => openPrivateStagingDatabase(root, 'sources')).toThrow();
    const original = file();
    const alias = join(root, 'alias.db');
    linkSync(original, alias);
    expect(() => openPrivateStagingDatabase(alias, 'sources')).toThrow();
  });

  it('逐库回读安全配置，实际编译期迁移可执行，原输入字节不变', () => {
    for (const domain of ['sources', 'research', 'watch'] as const) {
      const original = file();
      const originalBytes = readFileSync(original);
      const staging = join(root, `${domain}.db`);
      copyFileSync(original, staging);
      const observer = new DatabaseSync(':memory:');
      const previousHeapLimit = observer.prepare('PRAGMA hard_heap_limit').get()?.hard_heap_limit;
      observer.close();
      const { db, settings } = openPrivateStagingDatabase(staging, domain);
      try {
        expect(db.prepare('PRAGMA hard_heap_limit').get()?.hard_heap_limit).toBe(previousHeapLimit);
        expect(settings).toMatchObject({
          journalMode: 'memory',
          tempStore: 2,
          trustedSchema: 0,
          foreignKeys: 1,
          cacheSize: -8192,
          heapEnforcement: 'not-guaranteed',
          maxPageCount: Math.floor(STAGING_DATABASE_LIMITS[domain] / settings.pageSize),
        });
        expect(settings.compileOptions.length).toBeGreaterThan(0);
        expect(settings.memoryStatusDefault).toBe(
          settings.compileOptions.includes('DEFAULT_MEMSTATUS=0')
            ? 0
            : settings.compileOptions.includes('DEFAULT_MEMSTATUS=1')
              ? 1
              : 'unknown',
        );
        expect(normalizeTransferSchema(db, domain).ok).toBe(true);
        expect(() => db.enableLoadExtension(true)).toThrow();
        db.exec('PRAGMA writable_schema = ON');
        expect(db.prepare('PRAGMA writable_schema').get()?.writable_schema).toBe(0);
        if (domain === 'sources') {
          db.prepare(
            `INSERT INTO sources(id,scope,canonical_key,url,name,created_at,updated_at)
            VALUES('s','page','https://example.com/','https://example.com/','示例信源','2026-10-04','2026-10-04')`,
          ).run();
          expect(normalizeAndVerifySourceIndex(db)).toEqual({ ok: true, sourceCount: 1 });
        }
      } finally {
        db.close();
      }
      expect(readFileSync(original)).toEqual(originalBytes);
      expect(readdirSync(root).filter((name) => name.startsWith(`${domain}.db-`))).toEqual([]);
    }
  });

  it('小型SQLITE_FULL反例保持原件并回滚失败写入', () => {
    const staging = file();
    const { db } = openPrivateStagingDatabase(staging, 'research');
    try {
      db.exec('CREATE TABLE quota_test(value BLOB); PRAGMA max_page_count = 4');
      expect(() => db.prepare('INSERT INTO quota_test VALUES(zeroblob(65536))').run()).toThrow();
      expect(db.prepare('SELECT count(*) AS count FROM quota_test').get()?.count).toBe(0);
      expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('拒绝未封闭WAL副本且不修改原文件或附属文件', () => {
    const staging = file();
    const before = readFileSync(staging);
    const sidecar = `${staging}-wal`;
    writeFileSync(sidecar, '未封闭的事务');
    expect(() => openPrivateStagingDatabase(staging, 'sources')).toThrow();
    expect(readFileSync(staging)).toEqual(before);
    expect(readFileSync(sidecar, 'utf8')).toBe('未封闭的事务');
  });

  it('页大小改变时仍从固定字节配额推导页数', () => {
    for (const size of [512, 65536]) {
      const staging = file();
      const setup = new DatabaseSync(staging);
      setup.exec(`PRAGMA page_size = ${size}; VACUUM`);
      setup.close();
      const { db, settings } = openPrivateStagingDatabase(staging, 'watch');
      try {
        expect(settings.pageSize).toBe(size);
        expect(settings.maxPageCount * size).toBe(STAGING_DATABASE_LIMITS.watch);
      } finally {
        db.close();
      }
    }
  });
});
