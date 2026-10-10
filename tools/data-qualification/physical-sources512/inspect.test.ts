import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { MIGRATION_V1 } from '../../../src/main/sources/db/migrations';
import { openPrivateStagingDatabase } from '../../../src/main/storage/staging-sqlite';
import { padPrivateFixture } from '../physical-capacity/padding';
import { backupOwnedFixture } from '../physical-capacity/backup';
import { inspectSources } from './inspect';

const evidence = join(process.cwd(), 'log/stage7-e2/sources512-constructor-001');
mkdirSync(evidence, { recursive: true });
function fixture() {
  const root = mkdtempSync(join(evidence, 'small-'));
  const path = join(root, 'sources.db');
  const created = new DatabaseSync(path);
  created.exec('PRAGMA user_version=1');
  created.close();
  const { db } = openPrivateStagingDatabase(path, 'sources');
  for (const sql of MIGRATION_V1.statements) db.exec(sql);
  db.exec('PRAGMA user_version=1');
  db.prepare(
    `INSERT INTO sources(id,scope,canonical_key,url,name,created_at,updated_at,trust_verification)
    VALUES(?,?,?,?,?,?,?,'asserted')`,
  ).run(
    '00000000-0000-4000-8000-000000000001',
    'page',
    'https://example.test/a',
    'https://example.test/a',
    '合成哨兵',
    '2026-10-01T00:00:00.000Z',
    '2026-10-01T00:00:00.000Z',
  );
  return { db, path, root };
}

it('≤1MiBSources小库扩页及独立backup保持schema/版本/完整业务摘要', async () => {
  const { db, path, root } = fixture();
  const before = inspectSources(db, () => {});
  expect(before.semantic.counts.sources).toBe(1);
  const padding = padPrivateFixture(db, 1024 ** 2, () => {});
  const after = inspectSources(db, () => {});
  expect(after.schemaSha256).toBe(before.schemaSha256);
  expect(after.dataSha256).toBe(before.dataSha256);
  expect(after.userVersion).toBe(before.userVersion);
  expect(after.semantic).toEqual(before.semantic);
  expect(after.pageSize * after.pageCount).toBe(1024 ** 2);
  expect(after.freelistCount).toBe(padding.freelistCount);
  db.close();
  expect(statSync(path).size).toBe(1024 ** 2);
  const target = join(root, 'sources-backup.db');
  const journal = await backupOwnedFixture(path, target, 1024 ** 2, () => {});
  expect(journal.finalAbsent).toBe(true);
  expect(journal.continuousPeakVerified).toBe(false);
  const restored = new DatabaseSync(target, {
    readOnly: true,
    allowExtension: false,
    defensive: true,
  });
  try {
    expect(inspectSources(restored, () => {})).toEqual(after);
  } finally {
    restored.close();
  }
  expect(statSync(target).size).toBe(1024 ** 2);
});

it('合法同计数业务值变化仍改变摘要，读回不只计数', () => {
  const { db } = fixture();
  try {
    const before = inspectSources(db, () => {});
    db.prepare('UPDATE sources SET name=?').run('另一个合法哨兵');
    const after = inspectSources(db, () => {});
    expect(after.semantic).toEqual(before.semantic);
    expect(after.dataSha256).not.toBe(before.dataSha256);
  } finally {
    db.close();
  }
});

it.each(['schema', 'version', 'semantic', 'foreign-key'])('拒绝%s变化', (kind) => {
  const { db } = fixture();
  try {
    if (kind === 'schema') db.exec('CREATE TABLE unexpected(value)');
    if (kind === 'version') db.exec('PRAGMA user_version=2');
    if (kind === 'semantic') db.prepare('UPDATE sources SET id=?').run('bad-id');
    if (kind === 'foreign-key') {
      db.exec('PRAGMA foreign_keys=OFF');
      db.prepare('UPDATE sources SET group_id=?').run('00000000-0000-4000-8000-000000000002');
    }
    expect(() => inspectSources(db, () => {})).toThrow();
  } finally {
    db.close();
  }
});

it('截止检查异常原样向外传递，调用方仍持有连接', () => {
  const { db } = fixture();
  try {
    expect(() =>
      inspectSources(db, () => {
        throw new Error('固定截止');
      }),
    ).toThrow('固定截止');
    expect(db.isOpen).toBe(true);
  } finally {
    db.close();
  }
});
