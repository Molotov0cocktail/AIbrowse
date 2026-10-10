import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { MIGRATION_V1 } from '../../src/main/sources/db/migrations';
import { openPrivateStagingDatabase } from '../../src/main/storage/staging-sqlite';
import { inspectSources } from './physical-sources512/inspect';
import { padPrivateFixture } from './physical-capacity/padding';
import { backupOwnedFixture } from './physical-capacity/backup';

const evidence = join(process.cwd(), 'log/stage7-e2/sources512-independent-review-001');
mkdirSync(evidence, { recursive: true });
const id = '00000000-0000-4000-8000-000000000001';
const group = '00000000-0000-4000-8000-000000000002';
const tag1 = '00000000-0000-4000-8000-000000000003';
const tag2 = '00000000-0000-4000-8000-000000000004';
const journal = '00000000-0000-4000-8000-000000000005';
const time = '2026-10-01T00:00:00.000Z';

// Every business table is nonempty. The original constructor tests use only Sources.
function fixture() {
  const root = mkdtempSync(join(evidence, 'small-'));
  const path = join(root, 'sources.db');
  const fresh = new DatabaseSync(path);
  fresh.exec('PRAGMA user_version=1');
  fresh.close();
  const { db } = openPrivateStagingDatabase(path, 'sources');
  for (const sql of MIGRATION_V1.statements) db.exec(sql);
  db.prepare('INSERT INTO source_groups VALUES(?,?,?,NULL)').run(group, '分组', time);
  const tags = db.prepare('INSERT INTO source_tags VALUES(?,?,?)');
  tags.run(tag1, '标签甲', time);
  tags.run(tag2, '标签乙', time);
  db.prepare(
    `INSERT INTO sources(id,scope,canonical_key,url,name,group_id,trust_verification,created_at,updated_at,last_used_at,last_usage_outcome)
      VALUES(?,'page','https://example.test/','https://example.test/','独立哨兵',?,'asserted',?,?,?,'reachable')`,
  ).run(id, group, time, time, time);
  db.prepare('INSERT INTO source_tag_links VALUES(?,?)').run(id, tag1);
  db.prepare("INSERT INTO usage_events VALUES(?,'reachable',?)").run(id, time);
  const row = db.prepare('SELECT * FROM sources').get();
  db.prepare('INSERT INTO change_journal VALUES(?,?,?,?,?,?,?,?,?,?)').run(
    journal,
    'run-original',
    'tool-original',
    'agent-change-set',
    JSON.stringify({ [id]: { row: null, tags: [] } }),
    JSON.stringify({ [id]: { row, tags: ['标签甲'] } }),
    JSON.stringify([id]),
    'a'.repeat(64),
    JSON.stringify([{ opIndex: 0, ok: true, sourceId: id }]),
    time,
  );
  expect(statSync(path).size).toBeLessThanOrEqual(1024 ** 2);
  return { db, path, root };
}

it.each([
  'source-value',
  'source-rowid',
  'group',
  'tag',
  'link',
  'journal-run',
  'journal-tool',
  'journal-json-bytes',
  'usage',
])('六表同计数合法变化仍被稳定摘要识别：%s', (kind) => {
  const { db } = fixture();
  try {
    const before = inspectSources(db, () => {});
    expect(before.semantic.counts).toEqual({
      sources: 1,
      groups: 1,
      tags: 2,
      tagLinks: 1,
      journal: 1,
      usage: 1,
    });
    switch (kind) {
      case 'source-value':
        db.prepare('UPDATE sources SET name=?').run('变化哨兵');
        break;
      case 'source-rowid':
        db.exec('UPDATE sources SET rowid=100');
        break;
      case 'group':
        db.prepare('UPDATE source_groups SET name=?').run('变化分组');
        break;
      case 'tag':
        db.prepare('UPDATE source_tags SET name=? WHERE id=?').run('变化标签', tag1);
        break;
      case 'link':
        db.prepare('UPDATE source_tag_links SET tag_id=?').run(tag2);
        break;
      case 'journal-run':
        db.prepare('UPDATE change_journal SET run_id=?').run('run-changed');
        break;
      case 'journal-tool':
        db.prepare('UPDATE change_journal SET tool_call_id=?').run('tool-changed');
        break;
      case 'journal-json-bytes':
        db.exec("UPDATE change_journal SET before_payload=' '||before_payload");
        break;
      case 'usage':
        db.exec(
          "UPDATE usage_events SET outcome='unknown'; UPDATE sources SET last_usage_outcome='unknown'",
        );
        break;
    }
    const after = inspectSources(db, () => {});
    expect(after.semantic).toEqual(before.semantic);
    expect(after.schemaSha256).toBe(before.schemaSha256);
    expect(after.dataSha256).not.toBe(before.dataSha256);
  } finally {
    db.close();
  }
});

it.each(['trigger', 'view', 'column', 'version', 'journal-json', 'link-orphan', 'usage-mismatch'])(
  '独立敌手输入拒绝：%s',
  (kind) => {
    const { db } = fixture();
    try {
      inspectSources(db, () => {});
      switch (kind) {
        case 'trigger':
          db.exec('CREATE TRIGGER unexpected AFTER UPDATE ON sources BEGIN SELECT 1; END');
          break;
        case 'view':
          db.exec('CREATE VIEW unexpected AS SELECT * FROM sources');
          break;
        case 'column':
          db.exec('ALTER TABLE sources ADD COLUMN unexpected TEXT');
          break;
        case 'version':
          db.exec('PRAGMA user_version=0');
          break;
        case 'journal-json':
          db.prepare('UPDATE change_journal SET after_payload=?').run('{}');
          break;
        case 'link-orphan':
          db.exec('PRAGMA foreign_keys=OFF');
          db.prepare('UPDATE source_tag_links SET tag_id=?').run(journal);
          break;
        case 'usage-mismatch':
          db.exec("UPDATE usage_events SET outcome='blocked'");
          break;
      }
      expect(() => inspectSources(db, () => {})).toThrow();
    } finally {
      db.close();
    }
  },
);

it('非空六表扩页与真实SQLite backup保持全部业务，原件与失败证据保留', async () => {
  const { db, path, root } = fixture();
  const before = inspectSources(db, () => {});
  padPrivateFixture(db, 1024 ** 2, () => {});
  const after = inspectSources(db, () => {});
  expect(after.dataSha256).toBe(before.dataSha256);
  expect(after.schemaSha256).toBe(before.schemaSha256);
  db.close();
  const target = join(root, 'backup.db');
  const proof = await backupOwnedFixture(path, target, 1024 ** 2, () => {});
  expect(proof.finalAbsent).toBe(true);
  expect(proof.continuousPeakVerified).toBe(false);
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
  expect(statSync(path).size).toBe(1024 ** 2);
  expect(statSync(target).size).toBe(1024 ** 2);
});

it('扩页事务中的停止回滚保持所有业务，不生成伪成功', () => {
  const { db, path } = fixture();
  try {
    const before = inspectSources(db, () => {});
    expect(() =>
      padPrivateFixture(db, 1024 ** 2, () => {
        if (db.isTransaction) throw new Error('独立中断哨兵');
      }),
    ).toThrow('独立中断哨兵');
    expect(db.isTransaction).toBe(false);
    expect(inspectSources(db, () => {})).toEqual(before);
    expect(statSync(path).size).toBeLessThanOrEqual(1024 ** 2);
  } finally {
    db.close();
  }
});
