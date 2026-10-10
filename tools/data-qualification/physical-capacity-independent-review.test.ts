import { createHash } from 'node:crypto';
import {
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { openPrivateStagingDatabase } from '../../src/main/storage/staging-sqlite';
import * as io from './full-transfer/io';
import { backupOwnedFixture } from './physical-capacity/backup';
import { generationSpace, JOURNAL_BYTES } from './physical-capacity/contract';
import { createJournalGuard } from './physical-capacity/journal';
import { padPrivateFixture } from './physical-capacity/padding';

const evidence = join(
  process.cwd(),
  'log/stage7-e2/physical-journal-repair-independent-review-001',
);
mkdirSync(evidence, { recursive: true });
const noop = () => {};
function small() {
  const directory = mkdtempSync(join(evidence, 'small-'));
  const path = join(directory, 'source.db');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version=19;
    CREATE TABLE parent(id INTEGER PRIMARY KEY, value BLOB);
    CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id), text TEXT);
    CREATE INDEX child_parent ON child(parent_id);
    CREATE VIEW visible AS SELECT id,text FROM child;
    INSERT INTO parent VALUES(1,x'0001ff80');
    INSERT INTO child VALUES(1,1,'原业务中文哨兵');`);
  db.close();
  return { directory, path, target: join(directory, 'backup.db') };
}
function logical(db: DatabaseSync) {
  return {
    schema: db.prepare('SELECT name,type,tbl_name,sql FROM sqlite_schema ORDER BY name').all(),
    parent: db.prepare('SELECT id,hex(value) AS value FROM parent ORDER BY id').all(),
    child: db.prepare('SELECT * FROM child ORDER BY id').all(),
    version: db.prepare('PRAGMA user_version').get(),
    integrity: db.prepare('PRAGMA integrity_check').all(),
    foreign: db.prepare('PRAGMA foreign_key_check').all(),
  };
}
function hash(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

it('独立业务行、索引、视图和外键在生产暂存扩页及关闭后backup中保持', async () => {
  const f = small();
  const { db, settings } = openPrivateStagingDatabase(f.path, 'research');
  const before = logical(db);
  const proof = padPrivateFixture(db, 1024 ** 2, noop);
  expect(logical(db)).toEqual(before);
  expect(settings.journalMode).toBe('memory');
  db.close();
  const originalHash = hash(f.path);
  await backupOwnedFixture(f.path, f.target, 1024 ** 2, noop);
  expect(hash(f.path)).toBe(originalHash);
  const restored = new DatabaseSync(f.target, { readOnly: true });
  try {
    expect(logical(restored)).toEqual(before);
    expect(restored.prepare('PRAGMA page_count').get()?.page_count).toBe(proof.pageCount);
    expect(restored.prepare('PRAGMA freelist_count').get()?.freelist_count).toBe(
      proof.freelistCount,
    );
    expect(statSync(f.path).size).toBe(1024 ** 2);
    expect(statSync(f.target).size).toBe(1024 ** 2);
  } finally {
    restored.close();
  }
});

it('backup实际临时journal由独立采样核预算、观测证明和最终缺席', async () => {
  const f = small();
  const { db } = openPrivateStagingDatabase(f.path, 'research');
  padPrivateFixture(db, 1024 ** 2, noop);
  db.close();
  const seen = new Map<string, number>();
  let checks = 0;
  let journalChecks = 0;
  const proof = await backupOwnedFixture(f.path, f.target, 1024 ** 2, () => {
    checks++;
    for (const name of readdirSync(f.directory)) {
      if (name !== 'source.db' && name !== 'backup.db') {
        journalChecks++;
        seen.set(name, Math.max(seen.get(name) ?? 0, statSync(join(f.directory, name)).size));
      }
    }
  });
  expect([...seen.keys()]).toEqual(['backup.db-journal']);
  expect(proof).toEqual({
    budgetBytes: 134217728,
    maxObservedBytes: seen.get('backup.db-journal'),
    observations: checks,
    journalObservations: journalChecks,
    finalAbsent: true,
    continuousPeakVerified: false,
  });
  expect(proof.maxObservedBytes).toBeGreaterThan(0);
  expect(proof.maxObservedBytes).toBeLessThanOrEqual(JOURNAL_BYTES);
  expect(readdirSync(f.directory).sort()).toEqual(['backup.db', 'source.db']);
  writeFileSync(
    join(f.directory, 'observed-sidecars.json'),
    JSON.stringify({
      targetInitiallyAbsent: true,
      wrapperReservedTargetBytes: 0,
      pageSize: 4096,
      targetBytes: 1024 ** 2,
      sidecars: [...seen].map(([name, maxObservedBytes]) => ({ name, maxObservedBytes })),
      proof,
    }),
  );
});

it.each([
  'source.db-journal',
  'source.db-wal',
  'source.db-shm',
  'backup.db-wal',
  'backup.db-shm',
  'backup.db-unknown',
])('实际backup进度插入%s立即拒绝、关闭自有连接并保留原件', async (name) => {
  const f = small();
  const { db } = openPrivateStagingDatabase(f.path, 'research');
  padPrivateFixture(db, 1024 ** 2, noop);
  db.close();
  const before = hash(f.path);
  const hostile = join(f.directory, name);
  let calls = 0;
  const close = vi.spyOn(DatabaseSync.prototype, 'close');
  try {
    await expect(
      backupOwnedFixture(f.path, f.target, 1024 ** 2, () => {
        if (++calls === 2) writeFileSync(hostile, '独立失败哨兵');
      }),
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  } finally {
    close.mockRestore();
  }
  expect(hash(f.path)).toBe(before);
  expect(readFileSync(hostile, 'utf8')).toBe('独立失败哨兵');
  expect(statSync(f.target).isFile()).toBe(true);
});

it('实际backup关闭后的未知成员也拒绝，不用成功SQLite返回追认', async () => {
  const f = small();
  const bytes = statSync(f.path).size;
  const before = hash(f.path);
  let inserted = false;
  const close = vi.spyOn(DatabaseSync.prototype, 'close');
  try {
    await expect(
      backupOwnedFixture(f.path, f.target, bytes, () => {
        if (close.mock.calls.length === 1) {
          inserted = true;
          writeFileSync(f.target + '-unknown', '关闭后哨兵');
        }
      }),
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
    expect(inserted).toBe(true);
  } finally {
    close.mockRestore();
  }
  expect(hash(f.path)).toBe(before);
  expect(readFileSync(f.target + '-unknown', 'utf8')).toBe('关闭后哨兵');
});

function guardFixture() {
  const f = small();
  closeSync(openSync(f.target, 'wx'));
  const guard = createJournalGuard(f.path, f.target, statSync(f.path).size);
  return { ...f, guard, journal: f.target + '-journal' };
}

it('超J长度由实际guard拒绝并锁存，事实替身不创建大文件', () => {
  const f = guardFixture();
  writeFileSync(f.journal, '小journal');
  const readFact = io.fileFact;
  const spy = vi.spyOn(io, 'fileFact').mockImplementation((path) => {
    const value = readFact(path);
    return path === f.journal ? { ...value, size: String(JOURNAL_BYTES + 1) } : value;
  });
  try {
    expect(() => f.guard.observe()).toThrow();
  } finally {
    spy.mockRestore();
  }
  expect(() => f.guard.finish()).toThrow();
  expect(readFileSync(f.journal, 'utf8')).toBe('小journal');
});

it('journal路径读与短句柄身份不一致时拒绝，原件不删除', () => {
  const f = guardFixture();
  writeFileSync(f.journal, '小journal');
  const readFact = io.fileFact;
  const spy = vi.spyOn(io, 'fileFact').mockImplementation((path) => {
    const value = readFact(path);
    return path === f.journal ? { ...value, ino: '18446744073709551615' } : value;
  });
  try {
    expect(() => f.guard.observe()).toThrow();
  } finally {
    spy.mockRestore();
  }
  expect(() => f.guard.finish()).toThrow();
  expect(readFileSync(f.journal, 'utf8')).toBe('小journal');
});

it('临时journal硬链接拒绝且外部自有哨兵保留', () => {
  const f = guardFixture();
  const outside = join(mkdtempSync(join(evidence, 'outside-')), 'sentinel');
  writeFileSync(outside, '外部自有哨兵');
  linkSync(outside, f.journal);
  expect(() => f.guard.observe()).toThrow();
  expect(readFileSync(outside, 'utf8')).toBe('外部自有哨兵');
  expect(statSync(outside).nlink).toBe(2);
});

it('整个自有目录换身份后不能继续，以移存保留原件', () => {
  const f = guardFixture();
  const archived = f.directory + '-original';
  renameSync(f.directory, archived);
  mkdirSync(f.directory);
  writeFileSync(f.path, readFileSync(join(archived, 'source.db')));
  closeSync(openSync(f.target, 'wx'));
  expect(() => f.guard.observe()).toThrow();
  expect(statSync(join(archived, 'source.db')).isFile()).toBe(true);
  expect(() => f.guard.finish()).toThrow();
});

it('两份库、独立J与工具额分别取整，旧零journal空间不足', () => {
  for (const unit of [1n, 4096n, 65535n, 1048576n]) {
    const ceil = (bytes: bigint) => (bytes / unit + (bytes % unit === 0n ? 0n : 1n)) * unit;
    const old = 2n * ceil(67108864n) + ceil(16777216n) + 1073741824n;
    expect(generationSpace(unit)).toBe(old + ceil(134217728n));
    expect(generationSpace(unit)).toBeGreaterThan(old);
  }
});

it('SQLite真实BEGIN锁冲突不回滚外部事务或修改业务数据', () => {
  const f = small();
  const owner = new DatabaseSync(f.path);
  const contender = new DatabaseSync(f.path, { timeout: 0 });
  const before = logical(owner);
  try {
    owner.exec('BEGIN IMMEDIATE');
    expect(() => padPrivateFixture(contender, 1024 ** 2, noop)).toThrow();
    expect(owner.isTransaction).toBe(true);
    expect(contender.isTransaction).toBe(false);
    expect(logical(owner)).toEqual(before);
  } finally {
    owner.exec('ROLLBACK');
    owner.close();
    contender.close();
  }
});

it('尾段结束后取消由实际事务回滚，既有freelist和业务保留', () => {
  const f = small();
  const { db } = openPrivateStagingDatabase(f.path, 'research');
  db.exec(
    'CREATE TABLE released(value BLOB); INSERT INTO released VALUES(zeroblob(32768)); DROP TABLE released',
  );
  const before = logical(db);
  const pages = db.prepare('PRAGMA page_count').get()?.page_count;
  const free = db.prepare('PRAGMA freelist_count').get()?.freelist_count;
  let cancelled = false;
  try {
    expect(() =>
      padPrivateFixture(db, 1024 ** 2, () => {
        if (
          db.isTransaction &&
          db.prepare('PRAGMA page_count').get()?.page_count === 256 &&
          db.prepare('PRAGMA freelist_count').get()?.freelist_count === 0
        ) {
          cancelled = true;
          throw new Error('独立尾段取消');
        }
      }),
    ).toThrow('独立尾段取消');
    expect(cancelled).toBe(true);
    expect(db.isTransaction).toBe(false);
    expect(logical(db)).toEqual(before);
    expect(db.prepare('PRAGMA page_count').get()?.page_count).toBe(pages);
    expect(db.prepare('PRAGMA freelist_count').get()?.freelist_count).toBe(free);
  } finally {
    db.close();
  }
});
