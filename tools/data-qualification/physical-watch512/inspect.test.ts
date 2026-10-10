import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openPrivateStagingDatabase } from '../../../src/main/storage/staging-sqlite';
import { createSmallFixture } from '../product-restore-fixtures/seed';
import { padPrivateFixture } from '../physical-capacity/padding';
import { backupOwnedFixture } from '../physical-capacity/backup';
import { inspectWatch } from './inspect';

const evidence = join(process.cwd(), 'log/stage7-e2/watch512-constructor-001');
mkdirSync(evidence, { recursive: true });
function fixture() {
  const root = mkdtempSync(join(evidence, 'small-'));
  const profile = join(root, 'profile');
  createSmallFixture(profile, 'H');
  const path = join(profile, 'watch/watch.db');
  expect(statSync(path).size).toBeLessThan(1024 ** 2);
  const { db } = openPrivateStagingDatabase(path, 'watch');
  return { db, path, root: join(profile, 'watch') };
}

it('小Watch历史集合扩至1MiB后独立backup保留十五表、schema与业务关系', async () => {
  const { db, path, root } = fixture();
  let after: ReturnType<typeof inspectWatch>;
  try {
    const before = inspectWatch(db, () => {});
    expect(before.semantic.counts.watch_rules).toBe(1);
    expect(Object.keys(before.semantic.counts)).toHaveLength(15);
    const padding = padPrivateFixture(db, 1024 ** 2, () => {});
    after = inspectWatch(db, () => {});
    expect(after.schemaSha256).toBe(before.schemaSha256);
    expect(after.dataSha256).toBe(before.dataSha256);
    expect(after.userVersion).toBe(before.userVersion);
    expect(after.semantic).toEqual(before.semantic);
    expect(after.pageSize * after.pageCount).toBe(1024 ** 2);
    expect(after.freelistCount).toBe(padding.freelistCount);
  } finally {
    db.close();
  }
  expect(statSync(path).size).toBe(1024 ** 2);
  const target = join(root, 'watch-backup.db');
  const journal = await backupOwnedFixture(path, target, 1024 ** 2, () => {});
  expect(journal.finalAbsent).toBe(true);
  expect(journal.continuousPeakVerified).toBe(false);
  const restored = new DatabaseSync(target, {
    readOnly: true,
    allowExtension: false,
    defensive: true,
  });
  try {
    expect(inspectWatch(restored, () => {})).toEqual(after);
  } finally {
    restored.close();
  }
  expect(statSync(target).size).toBe(1024 ** 2);
});

it.each([
  'UPDATE watch_rules SET updated_at=created_at',
  'UPDATE watch_rules SET rowid=rowid+100',
  'UPDATE notification_outbox SET updated_at=created_at',
])('合法同计数变化仍由完整内容摘要区分：%s', (sql) => {
  const { db } = fixture();
  try {
    const before = inspectWatch(db, () => {});
    // The first timestamp assignments use an explicit later valid value below.
    if (sql.includes('updated_at'))
      db.prepare(sql.replace('created_at', '?')).run('2026-10-10T02:00:00.000Z');
    else db.exec(sql);
    const after = inspectWatch(db, () => {});
    expect(after.semantic.counts).toEqual(before.semantic.counts);
    expect(after.dataSha256).not.toBe(before.dataSha256);
  } finally {
    db.close();
  }
});

it.each(['schema', 'version', 'semantic', 'foreign-key'])('拒绝%s漂移', (kind) => {
  const { db } = fixture();
  try {
    if (kind === 'schema') db.exec('CREATE TABLE unexpected(value)');
    if (kind === 'version') db.exec('PRAGMA user_version=999');
    if (kind === 'semantic') {
      db.exec('PRAGMA ignore_check_constraints=ON');
      db.exec("UPDATE watch_rules SET state='unknown'");
      db.exec('PRAGMA ignore_check_constraints=OFF');
    }
    if (kind === 'foreign-key') {
      db.exec('PRAGMA foreign_keys=OFF');
      db.exec("UPDATE watch_runs SET rule_id='00000000-0000-4000-8000-000000000999'");
    }
    expect(() => inspectWatch(db, () => {})).toThrow();
  } finally {
    db.close();
  }
});

it('扩页中断回滚，原schema和全部业务投影保持', () => {
  const { db } = fixture();
  try {
    const before = inspectWatch(db, () => {});
    let checks = 0;
    expect(() =>
      padPrivateFixture(db, 1024 ** 2, () => {
        if (++checks === 3) throw new Error('受控停止');
      }),
    ).toThrow('受控停止');
    const after = inspectWatch(db, () => {});
    expect(after.schemaSha256).toBe(before.schemaSha256);
    expect(after.dataSha256).toBe(before.dataSha256);
    expect(after.semantic).toEqual(before.semantic);
    expect(db.isOpen).toBe(true);
  } finally {
    db.close();
  }
});
