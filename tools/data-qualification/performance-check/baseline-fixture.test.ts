import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  capturePersistence,
  capturePersistenceCopy,
  prepareBaselineSources,
  verifyStartupAudits,
} from './baseline-fixture';
import { createSmallFixture } from '../product-restore-fixtures/seed';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('performance four-domain seed', () => {
  it('启动审计逐行绑定唯一真实进程，拒绝丢失、增加、越窗及内容篡改', () => {
    const window = {
      startedAt: Date.parse('2026-10-10T00:00:00.000Z'),
      endedAt: Date.parse('2026-10-10T00:01:00.000Z'),
    };
    const audit = {
      id: '00000000-0000-4000-8000-000000000001',
      rule_id: null,
      kind: 'reconciliation',
      reason_code: 'complete',
      created_at: '2026-10-10T00:00:01.000Z',
    };
    expect(() => verifyStartupAudits([audit], [window])).not.toThrow();
    for (const rows of [
      [],
      [audit, audit],
      [{ ...audit, reason_code: 'failed' }],
      [{ ...audit, kind: 'other' }],
      [{ ...audit, rule_id: audit.id }],
      [{ ...audit, extra: 1 }],
      [{ ...audit, created_at: '2026-10-10T00:02:00.000Z' }],
    ])
      expect(() => verifyStartupAudits(rows, [window])).toThrow();
    expect(() =>
      verifyStartupAudits(
        [audit, { ...audit, id: '00000000-0000-4000-8000-000000000002' }],
        [window, window],
      ),
    ).toThrow();
  });
  it('layers exactly 5000 Sources over fixture A and captures every fixed table', () => {
    const profile = mkdtempSync(join(tmpdir(), 'aibrowse-performance-seed-parent-'));
    roots.push(profile);
    rmSync(profile, { recursive: true });
    createSmallFixture(profile, 'A');
    expect(prepareBaselineSources(profile, true).sources).toBe(5_000);
    const receipt = capturePersistence(profile);
    expect(receipt.version).toBe(1);
    expect(receipt.tables['sources.sources']).toMatchObject({ rows: 5_000 });
    expect(receipt.tables['research.research_tasks']).toMatchObject({ rows: 1 });
    expect(receipt.tables['watch.watch_rules']).toMatchObject({ rows: 1 });
    expect(receipt.conversations.files).toHaveLength(2);
    expect(Object.keys(receipt.tables)).toHaveLength(28);
  });

  it('inspects a fixed copy without creating SQLite sidecars in the original profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'aibrowse-performance-copy-'));
    roots.push(root);
    const profile = join(root, 'profile');
    createSmallFixture(profile, 'A');
    prepareBaselineSources(profile, true);
    const inspection = join(root, 'inspection');
    const receipt = capturePersistenceCopy(profile, inspection);
    expect(receipt.tables['sources.sources']).toMatchObject({ rows: 5_000 });
    for (const domain of ['sources', 'research', 'watch']) {
      expect(readdirSync(join(profile, domain))).toEqual([`${domain}.db`]);
      expect(existsSync(join(profile, domain, `${domain}.db-wal`))).toBe(false);
      expect(existsSync(join(profile, domain, `${domain}.db-shm`))).toBe(false);
    }
    expect(() => capturePersistenceCopy(profile, inspection)).toThrow();
  });
});

describe('performance baseline Sources fixture', () => {
  it('creates exactly 5000 searchable synthetic rows and refuses reuse', () => {
    const profile = mkdtempSync(join(tmpdir(), 'aibrowse-performance-'));
    roots.push(profile);
    const receipt = prepareBaselineSources(profile);
    expect(receipt).toMatchObject({ version: 1, sources: 5_000 });
    expect(receipt.queryTokens).toHaveLength(10);
    expect(receipt.digest).toMatch(/^[a-f0-9]{64}$/u);

    const db = new DatabaseSync(join(profile, 'sources', 'sources.db'), {
      readOnly: true,
      allowExtension: false,
    });
    try {
      expect(db.prepare('SELECT count(*) AS count FROM sources').get()).toEqual({ count: 5_000 });
      expect(
        db
          .prepare(
            "SELECT count(*) AS count FROM sources_fts WHERE sources_fts MATCH 'PERF_QUERY_7'",
          )
          .get(),
      ).toEqual({ count: 500 });
    } finally {
      db.close();
    }
    expect(() => prepareBaselineSources(profile)).toThrow();
  });
});
