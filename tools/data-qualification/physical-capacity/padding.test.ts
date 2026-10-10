import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { padPrivateFixture } from './padding';

const evidence = join(process.cwd(), 'log/stage7-e2/physical-capacity-fixture-implementation-001');
mkdirSync(evidence, { recursive: true });
const marker = '固定业务哨兵，不得改变';
function fixture(pageSize: number) {
  const root = mkdtempSync(join(evidence, 'small-'));
  const path = join(root, 'fixture.db');
  const db = new DatabaseSync(path, { allowExtension: false, defensive: true });
  db.exec(`PRAGMA page_size=${pageSize}; PRAGMA auto_vacuum=NONE; PRAGMA user_version=7;`);
  db.exec('CREATE TABLE business(id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
  db.prepare('INSERT INTO business(value) VALUES (?)').run(marker);
  return { root, path, db };
}

it.each([512, 4096, 65536])(
  '页大小%d的合法小库精确扩到1MiB，关闭重开保持业务和schema',
  (pageSize) => {
    const { path, db } = fixture(pageSize);
    const before = db
      .prepare('SELECT name,type,tbl_name,sql FROM sqlite_schema ORDER BY name')
      .all();
    const result = padPrivateFixture(db, 1024 ** 2, () => {});
    expect(result.targetBytes).toBe(1024 ** 2);
    expect(result.pageCount * result.pageSize).toBe(1024 ** 2);
    expect(result.bulkSteps).toBeLessThanOrEqual(512);
    expect(result.tailSteps).toBeLessThanOrEqual(1);
    expect(result.freelistCount).toBeGreaterThan(0);
    expect(db.prepare('SELECT value FROM business').get()?.value).toBe(marker);
    expect(
      db.prepare('SELECT name,type,tbl_name,sql FROM sqlite_schema ORDER BY name').all(),
    ).toEqual(before);
    db.close();
    expect(statSync(path).size).toBe(1024 ** 2);
    const reopened = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      expect(reopened.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
      expect(reopened.prepare('PRAGMA user_version').get()?.user_version).toBe(7);
      expect(reopened.prepare('SELECT value FROM business').get()?.value).toBe(marker);
    } finally {
      reopened.close();
    }
  },
);

it('已有freelist和恰好目标长度均保持合法，禁止在满足目标时重写', () => {
  const { db } = fixture(4096);
  db.exec(
    'CREATE TABLE released(payload BLOB); INSERT INTO released VALUES(zeroblob(131072)); DROP TABLE released;',
  );
  expect(Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count)).toBeGreaterThan(0);
  padPrivateFixture(db, 512 * 1024, () => {});
  const before = db.prepare('PRAGMA schema_version').get()?.schema_version;
  expect(padPrivateFixture(db, 512 * 1024, () => {}).bulkSteps).toBe(0);
  expect(db.prepare('PRAGMA schema_version').get()?.schema_version).toBe(before);
  expect(db.prepare('SELECT value FROM business').get()?.value).toBe(marker);
  db.close();
});

it('不接受非整页、变小、过大或非NONE auto_vacuum，拒绝时不建立scratch', () => {
  const { db } = fixture(4096);
  const before = db.prepare('SELECT name FROM sqlite_schema ORDER BY name').all();
  for (const target of [100, 4096, 512 * 1024 ** 2 + 4096, Number.NaN]) {
    expect(() => padPrivateFixture(db, target, () => {})).toThrow();
    expect(db.prepare('SELECT name FROM sqlite_schema ORDER BY name').all()).toEqual(before);
  }
  db.close();
  const root = mkdtempSync(join(evidence, 'auto-'));
  const vacuum = new DatabaseSync(join(root, 'fixture.db'));
  vacuum.exec('PRAGMA auto_vacuum=FULL; CREATE TABLE business(value);');
  expect(() => padPrivateFixture(vacuum, 512 * 1024, () => {})).toThrow();
  vacuum.close();
});

it('期限检查失败保留现场，调用方仍拥有句柄，不吞错或自动重试', () => {
  const { db } = fixture(4096);
  const before = db.prepare('SELECT name,type,tbl_name,sql FROM sqlite_schema ORDER BY name').all();
  let checks = 0;
  expect(() =>
    padPrivateFixture(db, 512 * 1024, () => {
      if (++checks === 50) throw new Error('固定截止');
    }),
  ).toThrow('固定截止');
  expect(db.isOpen).toBe(true);
  expect(db.isTransaction).toBe(false);
  expect(
    db.prepare('SELECT name,type,tbl_name,sql FROM sqlite_schema ORDER BY name').all(),
  ).toEqual(before);
  expect(db.prepare('SELECT value FROM business').get()?.value).toBe(marker);
  db.close();
});

it('scratch名称碰撞和调用方已有事务都拒绝，不能回滚调用方事务', () => {
  const { db } = fixture(4096);
  db.exec('CREATE TABLE aibrowse_qualification_bulk(value TEXT);');
  expect(() => padPrivateFixture(db, 512 * 1024, () => {})).toThrow();
  db.exec('DROP TABLE aibrowse_qualification_bulk; BEGIN IMMEDIATE;');
  expect(() => padPrivateFixture(db, 512 * 1024, () => {})).toThrow();
  expect(db.isTransaction).toBe(true);
  db.exec('ROLLBACK');
  db.close();
});

it('BEGIN成功后的期限检查抛错也结算自有事务，保留原schema与业务', () => {
  const { db } = fixture(4096);
  const before = db.prepare('SELECT name,type,tbl_name,sql FROM sqlite_schema ORDER BY name').all();
  let injected = false;
  try {
    expect(() =>
      padPrivateFixture(db, 512 * 1024, () => {
        if (db.isTransaction && !injected) {
          injected = true;
          throw new Error('BEGIN后截止');
        }
      }),
    ).toThrow('BEGIN后截止');
    expect(injected).toBe(true);
    expect(db.isOpen).toBe(true);
    expect(db.isTransaction).toBe(false);
    expect(
      db.prepare('SELECT name,type,tbl_name,sql FROM sqlite_schema ORDER BY name').all(),
    ).toEqual(before);
    expect(db.prepare('SELECT value FROM business').get()?.value).toBe(marker);
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
});
