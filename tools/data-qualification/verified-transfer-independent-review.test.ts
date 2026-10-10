import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import {
  openVerifiedTransferDb,
  requireVerifiedTransferHandle,
} from '../../src/main/sources/db/sqlite-driver';

const root = join(process.cwd(), 'log/stage7-e2/independent-verified-transfer-review-001');
mkdirSync(root, { recursive: true });
function fixture() {
  const directory = mkdtempSync(join(root, 'fixture-'));
  const path = join(directory, 'health.db');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('原始合成数据')");
  db.close();
  return { directory, path, before: createHash('sha256').update(readFileSync(path)).digest('hex') };
}
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

it('惰性prepare在执行前不编译会关闭query_only的PRAGMA', () => {
  const f = fixture();
  const owned = openVerifiedTransferDb(f.path);
  try {
    const pragma = owned.handle.prepare('PRAGMA query_only = OFF');
    expect(owned.handle.prepare('PRAGMA query_only').get()).toEqual({ query_only: 1 });
    expect(() => pragma.get()).toThrow();
    expect(() => pragma.all()).toThrow();
    expect(() => pragma.run()).toThrow();
    expect(owned.handle.prepare('PRAGMA query_only').get()).toEqual({ query_only: 1 });
    expect(digest(f.path)).toBe(f.before);
    expect(readdirSync(f.directory)).toEqual(['health.db']);
  } finally {
    owned.handle.close();
  }
});

it.each(['get', 'all'] as const)('WITH DML的%s不能越过SQLite query_only', (method) => {
  const f = fixture();
  const owned = openVerifiedTransferDb(f.path);
  try {
    const write = owned.handle.prepare(
      'WITH selected AS (SELECT value FROM probe) DELETE FROM probe WHERE value IN (SELECT value FROM selected) RETURNING value',
    );
    expect(() => write[method]()).toThrow();
    expect(owned.handle.prepare('SELECT value FROM probe').all()).toEqual([
      { value: '原始合成数据' },
    ]);
    expect(digest(f.path)).toBe(f.before);
  } finally {
    owned.handle.close();
  }
});

it('SELECT前缀的pragma表函数、多语句及扩展尝试不能解除只读或创建附属文件', () => {
  const f = fixture();
  const owned = openVerifiedTransferDb(f.path);
  try {
    for (const sql of [
      'SELECT * FROM pragma_query_only(0)',
      "SELECT * FROM pragma_journal_mode('wal')",
      'SELECT * FROM pragma_foreign_keys(0)',
      'SELECT 1; PRAGMA query_only=OFF',
      "SELECT load_extension('aibrowse-independent-missing-extension')",
    ]) {
      try {
        owned.handle.prepare(sql).all();
      } catch {
        /* Rejection or an inert SELECT is acceptable. */
      }
      expect(owned.handle.prepare('PRAGMA query_only').get()).toEqual({ query_only: 1 });
      expect(owned.handle.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
      expect(digest(f.path)).toBe(f.before);
      expect(readdirSync(f.directory)).toEqual(['health.db']);
    }
  } finally {
    owned.handle.close();
  }
});

it('句柄关闭后旧statement和激活闭包均失效，另一连接不能借用其许可', () => {
  const f = fixture();
  const first = openVerifiedTransferDb(f.path);
  const second = openVerifiedTransferDb(f.path);
  const read = first.handle.prepare('SELECT value FROM probe');
  read.get();
  first.handle.close();
  try {
    expect(() => read.get()).toThrow();
    expect(() => first.activateWrites()).toThrow();
    expect(() => requireVerifiedTransferHandle(first.handle, f.path)).toThrow();
    expect(() => requireVerifiedTransferHandle({ ...second.handle }, f.path)).toThrow();
    expect(() => second.handle.exec('DELETE FROM probe')).toThrow();
    second.activateWrites();
    expect(() => requireVerifiedTransferHandle(second.handle, f.path)).toThrow();
    second.handle.prepare('INSERT INTO probe VALUES (?)').run('提交后合成数据');
    expect(second.handle.prepare('SELECT count(*) AS n FROM probe').get()).toEqual({ n: 2 });
    expect(second.handle.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
  } finally {
    second.handle.close();
  }
});
