import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { openPrivateStagingDatabase } from '../../src/main/storage/staging-sqlite';
import { createSmallFixture, id, STAMP, url, watchIds } from './product-restore-fixtures/seed';
import { inspectWatch } from './physical-watch512/inspect';
import { padPrivateFixture } from './physical-capacity/padding';
import { backupOwnedFixture } from './physical-capacity/backup';
import { createJournalGuard } from './physical-capacity/journal';
import { fileFact, copyBound } from './full-transfer/io';

const evidenceRoot = join(process.cwd(), 'log/stage7-e2/watch512-independent-review-runs');
mkdirSync(evidenceRoot, { recursive: true });
const evidence = mkdtempSync(join(evidenceRoot, 'run-'));
const noop = () => {};
function fixture() {
  const root = mkdtempSync(join(evidence, 'small-'));
  const profile = join(root, 'profile');
  createSmallFixture(profile, 'H');
  const path = join(profile, 'watch/watch.db');
  const { db } = openPrivateStagingDatabase(path, 'watch');
  const projection = JSON.stringify({ type: 'page', fields: [] });
  const rule = watchIds('H').rule;
  db.exec('UPDATE watch_rules SET baseline_version=1');
  db.prepare("INSERT INTO watch_baselines VALUES (?,1,'page',?,?,?,?,?,NULL,NULL,NULL)").run(
    rule,
    projection,
    createHash('sha256').update(projection).digest('hex'),
    Buffer.byteLength(projection),
    url('H'),
    STAMP,
  );
  db.prepare("INSERT INTO watch_audits VALUES ('independent-audit',?,'run','event-created',?)").run(
    rule,
    STAMP,
  );
  db.prepare(
    "INSERT INTO source_cleanup_intents VALUES ('independent-intent',?,'update',NULL,NULL,'{}','complete',?,?)",
  ).run(id('H'), STAMP, STAMP);
  expect(statSync(path).size).toBeLessThanOrEqual(1024 ** 2);
  return { db, root, path, directory: join(profile, 'watch') };
}

it('独立夹具十五表非空，全部列及rowid变化均拒绝或改变摘要', () => {
  const { db } = fixture();
  const outcomes: { table: string; column: string; rejected: boolean }[] = [];
  try {
    const before = inspectWatch(db, noop);
    expect(Object.keys(before.semantic.counts)).toHaveLength(15);
    expect(Object.values(before.semantic.counts)).toEqual(Array(15).fill(1));
    db.exec('PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON');
    for (const table of Object.keys(before.semantic.counts)) {
      expect(table).toMatch(/^[a-z_]+$/u);
      const row = db.prepare(`SELECT * FROM ${table}`).get();
      expect(row).toBeDefined();
      const columns = Object.keys(row!);
      if (table !== 'digest_event_refs') columns.push('rowid');
      for (const column of columns) {
        expect(column).toMatch(/^[a-z_]+$/u);
        const old =
          column === 'rowid'
            ? db.prepare(`SELECT rowid AS current_rowid FROM ${table}`).get()?.current_rowid
            : row![column];
        const value =
          typeof old === 'number' ? old + 1 : old === null ? '独立篡改' : String(old) + '独立篡改';
        db.exec('SAVEPOINT independent_mutation');
        try {
          db.prepare(`UPDATE ${table} SET ${column}=?`).run(value);
          let after: ReturnType<typeof inspectWatch> | undefined;
          let rejected = false;
          try {
            after = inspectWatch(db, noop);
          } catch {
            rejected = true;
          }
          if (after) {
            expect(after.semantic.counts).toEqual(before.semantic.counts);
            expect(after.dataSha256, `${table}.${column}`).not.toBe(before.dataSha256);
          }
          outcomes.push({ table, column, rejected });
        } finally {
          db.exec('ROLLBACK TO independent_mutation; RELEASE independent_mutation');
        }
      }
    }
    expect(outcomes.filter((entry) => !entry.rejected).length).toBeGreaterThan(15);
    expect(new Set(outcomes.map((entry) => entry.table)).size).toBe(15);
    expect(inspectWatch(db, noop)).toEqual(before);
    writeFileSync(join(evidence, 'column-mutations-001.json'), JSON.stringify(outcomes, null, 2), {
      flag: 'wx',
    });
  } finally {
    db.close();
  }
});

it('合法同计数变化明确保留业务合法性但改变完整摘要', () => {
  const { db } = fixture();
  const statements = [
    'UPDATE watch_rules SET rowid=rowid+100',
    "UPDATE watch_rules SET updated_at='2026-10-10T02:00:00.000Z'",
    "UPDATE watch_baselines SET captured_at='2026-10-10T02:00:00.000Z'",
    "UPDATE watch_runs SET response_metadata_json='{ }'",
    "UPDATE watch_audits SET created_at='2026-10-10T02:00:00.000Z'",
    "UPDATE source_cleanup_intents SET updated_at='2026-10-10T02:00:00.000Z'",
    'UPDATE digest_change_state SET last_sequence=2',
    "UPDATE digest_schedules SET updated_at='2026-10-10T02:00:00.000Z'",
    "UPDATE digest_runs SET request_key='independent-request'",
    "UPDATE watch_digests SET created_at='2026-10-10T00:30:00.000Z'",
    "UPDATE notification_outbox SET updated_at='2026-10-10T02:00:00.000Z'",
  ];
  try {
    const before = inspectWatch(db, noop);
    for (const sql of statements) {
      db.exec('SAVEPOINT independent_legal');
      try {
        db.exec(sql);
        const after = inspectWatch(db, noop);
        expect(after.semantic.counts).toEqual(before.semantic.counts);
        expect(after.dataSha256, sql).not.toBe(before.dataSha256);
      } finally {
        db.exec('ROLLBACK TO independent_legal; RELEASE independent_legal');
      }
    }
  } finally {
    db.close();
  }
});

it('生产关系门拒绝跨表同计数断链和闭合schema漂移', () => {
  const { db } = fixture();
  const statements = [
    'UPDATE watch_baselines SET version=2',
    "UPDATE watch_runs SET rule_id='missing'",
    "UPDATE watch_audits SET rule_id='missing'",
    "UPDATE watch_events SET source_id='missing'",
    "UPDATE watch_event_items SET observation_id='missing'",
    "UPDATE digest_change_journal SET source_id='missing'",
    'UPDATE digest_schedules SET cursor_sequence=2',
    "UPDATE digest_runs SET schedule_id='missing'",
    "UPDATE digest_event_refs SET digest_id='missing'",
    "UPDATE notification_outbox SET rule_id='missing'",
    'CREATE VIEW unexpected AS SELECT id FROM watch_rules',
    'ALTER TABLE watch_rules ADD COLUMN unexpected TEXT',
    'PRAGMA user_version=999',
  ];
  try {
    const before = inspectWatch(db, noop);
    db.exec('PRAGMA foreign_keys=OFF');
    for (const sql of statements) {
      db.exec('SAVEPOINT independent_relation');
      try {
        db.exec(sql);
        expect(() => inspectWatch(db, noop), sql).toThrow();
      } finally {
        db.exec('ROLLBACK TO independent_relation; RELEASE independent_relation');
      }
      expect(inspectWatch(db, noop)).toEqual(before);
    }
  } finally {
    db.close();
  }
});

it('真实小Watch扩页和独立SQLite backup保持十五表全部事实', async () => {
  const { db, path, directory } = fixture();
  let after: ReturnType<typeof inspectWatch>;
  try {
    const before = inspectWatch(db, noop);
    const padded = padPrivateFixture(db, 1024 ** 2, noop);
    after = inspectWatch(db, noop);
    expect(after.schemaSha256).toBe(before.schemaSha256);
    expect(after.dataSha256).toBe(before.dataSha256);
    expect(after.semantic).toEqual(before.semantic);
    expect(after.userVersion).toBe(before.userVersion);
    expect(after.pageCount * after.pageSize).toBe(1024 ** 2);
    expect(after.freelistCount).toBe(padded.freelistCount);
  } finally {
    db.close();
  }
  const target = join(directory, 'watch-backup.db');
  expect(statSync(path).size).toBe(1024 ** 2);
  const journal = await backupOwnedFixture(path, target, 1024 ** 2, noop);
  expect(journal.finalAbsent).toBe(true);
  expect(journal.continuousPeakVerified).toBe(false);
  const restored = new DatabaseSync(target, {
    readOnly: true,
    allowExtension: false,
    defensive: true,
  });
  try {
    expect(inspectWatch(restored, noop)).toEqual(after);
  } finally {
    restored.close();
  }
  expect(statSync(target).size).toBe(1024 ** 2);
});

it('已写scratch事务中的真实停止回滚且原业务与schema不变', () => {
  const { db } = fixture();
  let stoppedInTransaction = false;
  try {
    const before = inspectWatch(db, noop);
    expect(() =>
      padPrivateFixture(db, 1024 ** 2, () => {
        if (
          db.isTransaction &&
          db.prepare("SELECT 1 FROM sqlite_schema WHERE name='aibrowse_qualification_tail'").get()
        ) {
          stoppedInTransaction = true;
          throw new Error('独立事务停止');
        }
      }),
    ).toThrow('独立事务停止');
    expect(stoppedInTransaction).toBe(true);
    expect(db.isTransaction).toBe(false);
    expect(inspectWatch(db, noop)).toEqual(before);
  } finally {
    db.close();
  }
});

it('小文件复制身份失配、backup目标替换均失败且保留现场', () => {
  const { db, path, root } = fixture();
  db.close();
  const targetDirectory = join(root, 'identity');
  mkdirSync(targetDirectory);
  const source = join(targetDirectory, 'source.db');
  copyFileSync(path, source);
  const sourceFact = fileFact(source);
  expect(() =>
    copyBound(
      source,
      join(targetDirectory, 'mismatch.db'),
      Number(sourceFact.size),
      'a'.repeat(64),
      noop,
      { ...sourceFact, ino: 'invalid' },
    ),
  ).toThrow();
  const target = join(targetDirectory, 'backup.db');
  closeSync(openSync(target, 'wx'));
  const guard = createJournalGuard(source, target, Number(sourceFact.size));
  guard.observe();
  renameSync(target, join(targetDirectory, 'original-empty.db'));
  closeSync(openSync(target, 'wx'));
  expect(() => guard.observe()).toThrow();
  expect(() => guard.finish()).toThrow();
  expect(fileFact(source)).toEqual(sourceFact);
});
