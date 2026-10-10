import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIGRATION_V1 } from '../db/migrations';
import { SourceServiceImpl } from '../source-service';
import type { SourceChangeSet } from '../../../shared/types/sources';
import {
  normalizeAndVerifySourceIndex,
  SOURCE_TRANSFER_SNAPSHOT_BYTES,
  SOURCE_TRANSFER_RESULT_BYTES,
  SOURCE_TRANSFER_IDS_BYTES,
  validateSourceTransfer,
} from './source-transfer-validation';

const NOW = Date.UTC(2026, 9, 1);
let db: DatabaseSync;
let service: SourceServiceImpl;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const sql of MIGRATION_V1.statements) db.exec(sql);
  service = new SourceServiceImpl({
    db: {
      path: ':memory:',
      get isOpen() {
        return db.isOpen;
      },
      prepare(sql) {
        return db.prepare(sql);
      },
      exec(sql) {
        db.exec(sql);
      },
      close() {
        db.close();
      },
    },
    now: () => NOW,
  });
});
afterEach(() => service.dispose());

async function agent() {
  const result = await service.applyChangeSet(
    {
      ops: [
        {
          kind: 'add',
          scope: 'page',
          url: 'https://agent.test/a',
          name: 'Agent A',
          tags: ['one'],
          aiNote: 'first',
        },
        {
          kind: 'add',
          scope: 'origin',
          url: 'https://agent.test/b',
          name: 'Agent B',
          trust: { value: 'official', assertedBy: 'ai' },
        },
      ],
    },
    { runId: 'run-' + 'x'.repeat(1000), toolCallId: 'call-' + 'y'.repeat(1000) },
  );
  if (!result.ok) throw new Error('Agent合成夹具失败');
  return result;
}

async function seed() {
  const added = await service.addManual({
    scope: 'page',
    url: 'https://example.test/path',
    name: 'Source name',
    groupName: 'Group',
    tags: ['alpha', 'beta'],
    userNote: 'PRIVATE_NOTE',
    aiNote: 'AI note',
  });
  if (!added.ok) throw new Error('合成夹具失败');
  await service.recordUsage(added.source.id, 'unknown');
  return added;
}

describe('Sources transfer semantic scan', () => {
  it('checks oversized journal bytes before selecting any business values', async () => {
    await seed();
    db.prepare('UPDATE change_journal SET after_payload=?').run(
      ' '.repeat(SOURCE_TRANSFER_SNAPSHOT_BYTES + 1),
    );
    const spy = vi.spyOn(db, 'prepare');
    expect(validateSourceTransfer(db)).toMatchObject({ ok: false, code: 'budget-exceeded' });
    expect(spy).not.toHaveBeenCalledWith('SELECT * FROM sources');
    expect(spy).not.toHaveBeenCalledWith('SELECT * FROM change_journal');
    spy.mockRestore();
  });
  it('checks oversized referenced IDs before a related source query can materialize them', async () => {
    await seed();
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare('UPDATE source_tag_links SET source_id=?').run('x'.repeat(100000));
    const spy = vi.spyOn(db, 'prepare');
    expect(validateSourceTransfer(db)).toMatchObject({ ok: false, code: 'budget-exceeded' });
    expect(spy).not.toHaveBeenCalledWith('SELECT * FROM sources');
    spy.mockRestore();
  });
  it('accepts empty and actual Service-created business rows without changing them', async () => {
    expect(validateSourceTransfer(db)).toMatchObject({
      ok: true,
      fts: 'rebuild-required',
      counts: { sources: 0, journal: 0 },
    });
    await seed();
    const before = db.prepare('SELECT * FROM sources').get();
    expect(validateSourceTransfer(db)).toMatchObject({
      ok: true,
      counts: { sources: 1, groups: 1, tags: 2, tagLinks: 2, journal: 1, usage: 1 },
    });
    expect(db.prepare('SELECT * FROM sources').get()).toEqual(before);
  });

  it.each([
    ['unknown scope', "PRAGMA ignore_check_constraints=ON; UPDATE sources SET scope='secret'"],
    ['nonbinary enabled', 'UPDATE sources SET enabled=2'],
    ['soft delete inconsistency', 'UPDATE sources SET enabled=0'],
    ['bad canonical', "UPDATE sources SET canonical_key='https://different.test/'"],
    ['unsafe URL', "UPDATE sources SET url='javascript:secret'"],
    ['trust pair', "UPDATE sources SET trust_asserted_by='ai'"],
    ['note over budget', "UPDATE sources SET user_note=replace(hex(zeroblob(1001)),'0','x')"],
    ['invalid version', 'UPDATE sources SET version=0'],
    ['bad date', "UPDATE sources SET updated_at='2026-02-30T00:00:00.000Z'"],
    ['missing group', 'DELETE FROM source_groups'],
    ['missing tag', 'DELETE FROM source_tags'],
    ['link missing source', 'DELETE FROM sources'],
    ['usage mismatch', "UPDATE usage_events SET outcome='reachable'"],
    ['usage missing', 'DELETE FROM usage_events'],
    ['group unknown field type', 'UPDATE source_groups SET name=zeroblob(1)'],
    ['tag blank', "UPDATE source_tags SET name=' ' WHERE name='alpha'"],
    ['bad journal JSON', "UPDATE change_journal SET before_payload='secret-invalid'"],
    ['journal missing sourceIds', "UPDATE change_journal SET source_ids='[]'"],
    ['manual hidden replay', "UPDATE change_journal SET result_payload='[]'"],
    ['manual hidden run', "UPDATE change_journal SET run_id='secret'"],
  ])('rejects %s with fixed non-body diagnostics', async (_label, sql) => {
    await seed();
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec(sql);
    const result = validateSourceTransfer(db);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toMatch(/secret|PRIVATE|example|Changed|ghost/);
  });

  it.each([
    ['missing postings', "INSERT INTO sources_fts(sources_fts) VALUES('delete-all')"],
    ['stale posting text', "UPDATE sources SET name='Changed name'"],
    [
      'extra ghost posting',
      "INSERT INTO sources_fts(rowid,name,url,user_note,ai_note) VALUES(999,'ghost','','','')",
    ],
  ])('requires staging normalization for %s', async (_label, sql) => {
    await seed();
    db.exec(sql);
    const business = db.prepare('SELECT * FROM sources').all();
    expect(validateSourceTransfer(db)).toMatchObject({ ok: true, fts: 'rebuild-required' });
    expect(normalizeAndVerifySourceIndex(db)).toEqual({ ok: true, sourceCount: 1 });
    expect(db.prepare('SELECT * FROM sources').all()).toEqual(business);
    expect(
      db.prepare("SELECT rowid FROM sources_fts WHERE sources_fts MATCH 'ghost'").all(),
    ).toEqual([]);
    expect(
      db.prepare("SELECT rowid FROM sources_fts WHERE sources_fts MATCH 'PRIVATE_NOTE'").all(),
    ).toHaveLength(1);
  });

  it('keeps missing FTS schema a staging failure rather than a false success', async () => {
    await seed();
    db.exec('DROP TABLE sources_fts');
    expect(normalizeAndVerifySourceIndex(db)).toMatchObject({ ok: false });
    expect(db.prepare('SELECT count(*) AS n FROM sources').get()).toEqual({ n: 1 });
  });

  it('leaves a read-only source untouched while rebuilding a distinct private staging copy', async () => {
    await seed();
    db.exec("INSERT INTO sources_fts(sources_fts) VALUES('delete-all')");
    const sourceRows = db.prepare('SELECT * FROM sources').all();
    const sourceShadow = db.prepare('SELECT * FROM sources_fts_data').all();
    const sourceJournal = db.prepare('SELECT * FROM change_journal').all();
    const changes = db.prepare('SELECT total_changes() AS n').get();
    const staging = new DatabaseSync(':memory:');
    try {
      for (const sql of MIGRATION_V1.statements) staging.exec(sql);
      for (const row of db.prepare('SELECT * FROM source_groups').iterate()) {
        staging.prepare('INSERT INTO source_groups VALUES (?, ?, ?, ?)').run(...Object.values(row));
      }
      for (const row of sourceRows)
        staging
          .prepare(
            'INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(...Object.values(row));
      db.exec('PRAGMA query_only=ON');
      expect(validateSourceTransfer(db)).toMatchObject({ ok: true, fts: 'rebuild-required' });
      expect(normalizeAndVerifySourceIndex(staging)).toEqual({ ok: true, sourceCount: 1 });
      expect(
        staging
          .prepare("SELECT rowid FROM sources_fts WHERE sources_fts MATCH 'PRIVATE_NOTE'")
          .all(),
      ).toHaveLength(1);
      expect(
        db.prepare("SELECT rowid FROM sources_fts WHERE sources_fts MATCH 'PRIVATE_NOTE'").all(),
      ).toEqual([]);
      expect(db.prepare('SELECT * FROM sources').all()).toEqual(sourceRows);
      expect(db.prepare('SELECT * FROM sources_fts_data').all()).toEqual(sourceShadow);
      expect(db.prepare('SELECT * FROM change_journal').all()).toEqual(sourceJournal);
      expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    } finally {
      staging.close();
    }
  });

  it('rolls back a rebuild when the actual FTS integrity command fails', async () => {
    await seed();
    db.exec("INSERT INTO sources_fts(sources_fts) VALUES('delete-all')");
    const shadow = db.prepare('SELECT * FROM sources_fts_data').all();
    const rows = db.prepare('SELECT * FROM sources').all();
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (sql === "INSERT INTO sources_fts(sources_fts,rank) VALUES('integrity-check',1)")
        throw new Error('PRIVATE_FAULT');
      return prepare(sql);
    });
    expect(normalizeAndVerifySourceIndex(db)).toEqual({ ok: false, code: 'fts-invalid' });
    spy.mockRestore();
    expect(db.prepare('SELECT * FROM sources_fts_data').all()).toEqual(shadow);
    expect(db.prepare('SELECT * FROM sources').all()).toEqual(rows);
  });

  it('handles corrupt derived FTS blobs without modifying business data', async () => {
    await seed();
    const rows = db.prepare('SELECT * FROM sources').all();
    db.enableDefensive(false);
    db.exec("UPDATE sources_fts_data SET block=x'00'");
    db.enableDefensive(true);
    expect(() =>
      db.prepare("INSERT INTO sources_fts(sources_fts,rank) VALUES('integrity-check',1)").run(),
    ).toThrow();
    expect(validateSourceTransfer(db)).toMatchObject({ ok: true, fts: 'rebuild-required' });
    const result = normalizeAndVerifySourceIndex(db);
    if (result.ok) {
      expect(result.sourceCount).toBe(1);
      expect(
        db.prepare("SELECT rowid FROM sources_fts WHERE sources_fts MATCH 'PRIVATE_NOTE'").all(),
      ).toHaveLength(1);
    } else expect(result).toEqual({ ok: false, code: 'fts-invalid' });
    expect(db.prepare('SELECT * FROM sources').all()).toEqual(rows);
  });

  it('does not silently rebuild a caller-protected read-only connection', async () => {
    await seed();
    const before = db.prepare('SELECT * FROM sources_fts_data').all();
    db.exec('PRAGMA query_only=ON');
    expect(normalizeAndVerifySourceIndex(db)).toEqual({ ok: false, code: 'fts-invalid' });
    expect(db.prepare('SELECT * FROM sources_fts_data').all()).toEqual(before);
  });

  it('enforces 20 tags per live Source without a global Sources count limit', async () => {
    const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    const added = await service.addManual({ scope: 'page', url: 'https://tags.test/', tags });
    if (!added.ok) throw new Error('夹具失败');
    expect(validateSourceTransfer(db)).toMatchObject({
      ok: true,
      counts: { tags: 20, tagLinks: 20 },
    });
    const id = '11111111-1111-4111-8111-111111111111';
    db.prepare('INSERT INTO source_tags VALUES (?, ?, ?)').run(
      id,
      'extra',
      new Date(NOW).toISOString(),
    );
    db.prepare('INSERT INTO source_tag_links VALUES (?, ?)').run(added.source.id, id);
    expect(validateSourceTransfer(db)).toMatchObject({ ok: false, code: 'budget-exceeded' });
  });

  it('accepts real agent replay and a hard-delete split retaining historical result IDs', async () => {
    const added = await agent();
    expect(validateSourceTransfer(db)).toMatchObject({
      ok: true,
      counts: { sources: 2, journal: 1 },
    });
    const removed = added.results[0]!.sourceId!;
    const deleted = await service.hardDeleteManual(
      removed,
      service.issueDeleteConfirmToken(removed),
    );
    expect(deleted.ok).toBe(true);
    expect(validateSourceTransfer(db)).toMatchObject({
      ok: true,
      counts: { sources: 1, journal: 1 },
    });
    const replay = await service.applyChangeSet(
      {
        ops: [
          {
            kind: 'add',
            scope: 'page',
            url: 'https://agent.test/a',
            name: 'Agent A',
            tags: ['one'],
            aiNote: 'first',
          },
          {
            kind: 'add',
            scope: 'origin',
            url: 'https://agent.test/b',
            name: 'Agent B',
            trust: { value: 'official', assertedBy: 'ai' },
          },
        ],
      },
      { runId: 'run-' + 'x'.repeat(1000), toolCallId: 'call-' + 'y'.repeat(1000) },
    );
    expect(replay).toEqual(added);
  });

  it.each([
    ['missing run', 'UPDATE change_journal SET run_id=NULL'],
    ['unknown hash', "UPDATE change_journal SET request_fingerprint='secret'"],
    ['missing result', 'UPDATE change_journal SET result_payload=NULL'],
    [
      'negative op index',
      "UPDATE change_journal SET result_payload=json_set(result_payload,'$[0].opIndex',-1)",
    ],
    [
      'failed result',
      "UPDATE change_journal SET result_payload=json_set(result_payload,'$[0].ok',json('false'))",
    ],
    [
      'unknown result field',
      "UPDATE change_journal SET result_payload=json_set(result_payload,'$[0].private','secret')",
    ],
    [
      'missing replay id',
      "UPDATE change_journal SET result_payload=json_remove(result_payload,'$[0].sourceId')",
    ],
    ['empty result', "UPDATE change_journal SET result_payload='[]'"],
  ])('rejects invalid agent replay %s', async (_name, sql) => {
    await agent();
    db.exec(sql);
    expect(validateSourceTransfer(db)).toMatchObject({ ok: false, table: 'journal' });
  });

  it('preserves stale snapshots after later edits and later usage changes', async () => {
    const added = await seed();
    const changed = await service.updateManual(added.source.id, { name: 'new name' }, 1);
    expect(changed.ok).toBe(true);
    await service.recordUsage(added.source.id, 'reachable');
    expect(validateSourceTransfer(db)).toMatchObject({ ok: true, counts: { journal: 2 } });
    expect((await service.undoChange(added.idempotencyKey)).ok).toBe(false);
  });

  it('preserves old journal entries without applying a new wall-clock expiry gate', async () => {
    await seed();
    const entry = db.prepare('SELECT after_payload FROM change_journal').get();
    const parsed = JSON.parse(entry!.after_payload as string) as Record<
      string,
      { row: Record<string, unknown> }
    >;
    const old = '2020-01-01T00:00:00.000Z';
    for (const value of Object.values(parsed)) {
      value.row.created_at = old;
      value.row.updated_at = old;
    }
    db.prepare('UPDATE change_journal SET applied_at=?,after_payload=?').run(
      old,
      JSON.stringify(parsed),
    );
    expect(validateSourceTransfer(db)).toMatchObject({ ok: true });
  });

  it('accepts a complete 20-op maximum-field snapshot without a smaller JSON cap', async () => {
    const ops: SourceChangeSet['ops'] = Array.from({ length: 20 }, (_, index) => ({
      kind: 'add',
      scope: 'page',
      url: `https://max.test/${index}/` + '汉'.repeat(2000),
      name: 'x'.repeat(200),
      userNote: '\ud800'.repeat(2000),
      aiNote: '\ud800'.repeat(2000),
      tags: Array.from(
        { length: 20 },
        (_, tag) => String(tag).padStart(2, '0') + '\ud800'.repeat(30),
      ),
    }));
    const added = await service.applyChangeSet({ ops }, { runId: 'max', toolCallId: 'max' });
    expect(added.ok).toBe(true);
    const size = db
      .prepare('SELECT length(CAST(after_payload AS BLOB)) AS bytes FROM change_journal')
      .get()?.bytes;
    expect(size).toBeGreaterThan(500000);
    expect(size).toBeLessThan(SOURCE_TRANSFER_SNAPSHOT_BYTES);
    expect(validateSourceTransfer(db)).toMatchObject({
      ok: true,
      counts: { sources: 20, journal: 1, tagLinks: 400 },
    });
  });

  it('keeps the 100-entry retained journal boundary without modifying input', async () => {
    const added = await seed();
    for (let version = 1; version < 100; version++) {
      expect(
        (await service.updateManual(added.source.id, { priority: (version % 5) + 1 }, version)).ok,
      ).toBe(true);
    }
    expect(validateSourceTransfer(db)).toMatchObject({ ok: true, counts: { journal: 100 } });
    db.prepare(
      'INSERT INTO change_journal SELECT ?,run_id,tool_call_id,change_type,before_payload,after_payload,source_ids,request_fingerprint,result_payload,applied_at FROM change_journal LIMIT 1',
    ).run('11111111-1111-4111-8111-111111111111');
    expect(validateSourceTransfer(db)).toMatchObject({
      ok: false,
      code: 'budget-exceeded',
      table: 'journal',
    });
    expect(db.prepare('SELECT count(*) AS n FROM change_journal').get()).toEqual({ n: 101 });
  });

  it.each([
    [
      'snapshot unknown field',
      (snapshot: Record<string, unknown>) => {
        snapshot.secret = 1;
      },
    ],
    [
      'snapshot missing row',
      (snapshot: Record<string, unknown>) => {
        delete snapshot.row;
      },
    ],
    [
      'snapshot unknown row field',
      (snapshot: Record<string, unknown>) => {
        (snapshot.row as Record<string, unknown>).secret = 1;
      },
    ],
    [
      'snapshot duplicate tags',
      (snapshot: Record<string, unknown>) => {
        snapshot.tags = ['alpha', 'alpha'];
      },
    ],
    [
      'snapshot overlong tag',
      (snapshot: Record<string, unknown>) => {
        snapshot.tags = ['x'.repeat(33)];
      },
    ],
    [
      'snapshot wrong id',
      (snapshot: Record<string, unknown>) => {
        (snapshot.row as Record<string, unknown>).id = '11111111-1111-4111-8111-111111111111';
      },
    ],
    [
      'snapshot absent after row',
      (snapshot: Record<string, unknown>) => {
        snapshot.row = null;
        snapshot.tags = [];
      },
    ],
    [
      'snapshot wrong creation version',
      (snapshot: Record<string, unknown>) => {
        (snapshot.row as Record<string, unknown>).version = 2;
      },
    ],
  ])('rejects %s', async (_label, mutate) => {
    const added = await seed();
    const raw = db.prepare('SELECT after_payload FROM change_journal').get()!
      .after_payload as string;
    const map = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    mutate(map[added.source.id]!);
    db.prepare('UPDATE change_journal SET after_payload=?').run(JSON.stringify(map));
    expect(validateSourceTransfer(db)).toMatchObject({ ok: false, table: 'journal' });
  });

  it('does not mistake a historical snapshot for a live Source foreign key', async () => {
    await seed();
    db.exec('DELETE FROM source_tag_links; DELETE FROM usage_events; DELETE FROM sources');
    expect(validateSourceTransfer(db)).toMatchObject({
      ok: true,
      counts: { sources: 0, journal: 1 },
    });
  });

  it('distinguishes absent usage from a persisted unknown observation', async () => {
    const added = await service.addManual({ scope: 'page', url: 'https://unused.test/' });
    if (!added.ok) throw new Error('夹具失败');
    expect(validateSourceTransfer(db)).toMatchObject({ ok: true, counts: { usage: 0 } });
    await service.recordUsage(added.source.id, 'unknown');
    expect(validateSourceTransfer(db)).toMatchObject({ ok: true, counts: { usage: 1 } });
    db.exec('UPDATE sources SET last_usage_outcome=NULL');
    expect(validateSourceTransfer(db)).toMatchObject({ ok: false });
  });

  it.each([
    ['before', 'UPDATE change_journal SET before_payload=?', SOURCE_TRANSFER_SNAPSHOT_BYTES],
    ['after', 'UPDATE change_journal SET after_payload=?', SOURCE_TRANSFER_SNAPSHOT_BYTES],
    ['result', 'UPDATE change_journal SET result_payload=?', SOURCE_TRANSFER_RESULT_BYTES],
    ['ids', 'UPDATE change_journal SET source_ids=?', SOURCE_TRANSFER_IDS_BYTES],
  ] as const)('checks %s JSON byte budget before parsing', async (_name, sql, limit) => {
    await agent();
    db.prepare(sql).run(' '.repeat(limit + 1));
    expect(validateSourceTransfer(db)).toMatchObject({
      ok: false,
      code: 'budget-exceeded',
      table: 'journal',
    });
  });

  it('rejects deep JSON and duplicate decoded keys without returning the offending payload', async () => {
    await seed();
    for (const raw of [
      '['.repeat(17) + '0' + ']'.repeat(17),
      '{"secret":null,"\\u0073ecret":null}',
    ]) {
      db.prepare('UPDATE change_journal SET before_payload=?').run(raw);
      const result = validateSourceTransfer(db);
      expect(result).toMatchObject({ ok: false, table: 'journal' });
      expect(JSON.stringify(result)).not.toContain('secret');
    }
  });

  it('checks every field in saved Undo snapshots', async () => {
    const added = await seed();
    const raw = db.prepare('SELECT after_payload FROM change_journal').get()?.after_payload;
    if (typeof raw !== 'string') throw new Error('夹具缺失');
    const snapshot: Record<string, { row: Record<string, unknown>; tags: string[] }> =
      JSON.parse(raw);
    snapshot[added.source.id]!.row.share_mode = 'secret';
    db.prepare('UPDATE change_journal SET after_payload=?').run(JSON.stringify(snapshot));
    expect(validateSourceTransfer(db)).toMatchObject({ ok: false });
  });

  it.each(['https://example.test/', 'https://例子.测试/'])(
    'preserves a 2048-unit Unicode URL with prefix %s after serialization',
    async (prefix) => {
      const added = await service.addManual({
        scope: 'page',
        url: prefix + '汉'.repeat(2048 - prefix.length),
        name: 'Unicode',
      });
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      expect(added.source.url.length).toBeGreaterThan(2048);
      expect(Buffer.byteLength(added.source.url, 'utf8')).toBeLessThanOrEqual(9 * 2048);
      expect(validateSourceTransfer(db)).toMatchObject({ ok: true });
    },
  );

  it('validates unbounded historical run and tool IDs through their presence only', async () => {
    await agent();
    db.prepare('UPDATE change_journal SET run_id=?,tool_call_id=?').run(
      'r'.repeat(100000),
      't'.repeat(100000),
    );
    expect(validateSourceTransfer(db)).toMatchObject({ ok: true });
    expect(
      db.prepare('SELECT length(run_id) AS r,length(tool_call_id) AS t FROM change_journal').get(),
    ).toEqual({ r: 100000, t: 100000 });
  });
});
