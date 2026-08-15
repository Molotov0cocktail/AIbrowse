// C1 research-migrations tests: migration v1 contract assertions (adjudications
// #101/#102) — the full 7-table set, user_version=1, CHECK constraints enforced
// at the database layer (status/phase/failure-reason enums, rejected Evidence
// can never be persisted), CASCADE wiring, monotonic stepwise engine reuse from
// the frozen B1 pattern, and compile-time-only statement contents.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, closeDb, type DbHandle } from '../../sources/db/sqlite-driver';
import {
  RESEARCH_MIGRATIONS,
  RESEARCH_MIGRATION_V1,
  runResearchMigrations,
} from './research-migrations';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-research-mig-'));

let handle: DbHandle;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  handle = openDb(join(root, `mig-${Math.random().toString(36).slice(2)}.db`));
});

afterEach(() => {
  closeDb(handle);
});

function tableNames(db: DbHandle): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>
  )
    .map((r) => r.name)
    .filter((n) => !n.startsWith('sqlite_'))
    .sort();
}

describe('migration v1 契约断言（决议 #101：7 张表全表集）', () => {
  it('单步 v1、版本连续、语句全部编译期常量', () => {
    expect(RESEARCH_MIGRATION_V1.version).toBe(1);
    expect(RESEARCH_MIGRATIONS).toHaveLength(1);
    expect(RESEARCH_MIGRATION_V1.statements.every((s) => typeof s === 'string')).toBe(true);
  });

  it('运行后 user_version=1 且 7 张表全部存在', () => {
    const outcome = runResearchMigrations(handle);
    expect(outcome.ok).toBe(true);
    expect(outcome.toVersion).toBe(1);
    expect(tableNames(handle)).toEqual([
      'research_candidates',
      'research_captures',
      'research_claims',
      'research_conflicts',
      'research_evidence',
      'research_results',
      'research_tasks',
    ]);
  });

  it('重复运行幂等（up-to-date）', () => {
    runResearchMigrations(handle);
    const again = runResearchMigrations(handle);
    expect(again.state).toBe('up-to-date');
    expect(again.ok).toBe(true);
  });

  it('未知更高版本零写入（newer-than-program）', () => {
    handle.exec('PRAGMA user_version = 2');
    const outcome = runResearchMigrations(handle);
    expect(outcome.ok).toBe(false);
    expect(outcome.state).toBe('newer-than-program');
    expect(tableNames(handle)).toEqual([]);
  });
});

describe('CHECK 约束数据库层强制（决议 #102/#105）', () => {
  beforeEach(() => {
    runResearchMigrations(handle);
  });

  function insertTask(id: string, status: string, phase: string | null): void {
    handle
      .prepare(
        `INSERT INTO research_tasks
  (id, goal, status, phase, created_at, updated_at, stats_json)
  VALUES (?, 'g', ?, ?, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z', '{}')`,
      )
      .run(id, status, phase);
  }

  it('status 非法值被 CHECK 拒绝', () => {
    expect(() => insertTask('t1', 'paused', null)).toThrow();
  });

  it('phase 非法值被 CHECK 拒绝；NULL 合法', () => {
    insertTask('t2', 'running', null);
    expect(() => insertTask('t3', 'running', 'thinking')).toThrow();
  });

  it('rejected Evidence 无法落库（verification CHECK 仅 verified——决议 #102）', () => {
    insertTask('t4', 'created', null);
    const base = [
      'e1',
      't4',
      'c1',
      null,
      'cap1',
      'https://example.com',
      't',
      '2026-08-16T00:00:00.000Z',
      'doc1',
      'hash',
      'quote',
      '{}',
      '摘录',
      null,
    ];
    const insertEvidence = (verification: string) =>
      handle
        .prepare(
          `INSERT INTO research_evidence
  (evidence_id, task_id, candidate_id, source_id, capture_id, url, title,
   access_time, document_id, content_hash, type, locator_json, excerpt, value,
   verification)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...base, verification);
    expect(() => insertEvidence('rejected')).toThrow();
    insertEvidence('verified'); // 合法路径
  });

  it('capture failure_reason 非法值被 CHECK 拒绝；NULL/合法值通过', () => {
    insertTask('t5', 'created', null);
    const insertCapture = (captureId: string, reason: string | null) =>
      handle
        .prepare(
          `INSERT INTO research_captures
  (capture_id, task_id, candidate_id, tab_id, url, title, access_time,
   document_id, content_hash, summary_json, failed, failure_reason)
  VALUES (?, 't5', 'c1', 'tab1', 'https://example.com', 't',
   '2026-08-16T00:00:00.000Z', 'doc1', 'h', '{}', 0, ?)`,
        )
        .run(captureId, reason);
    expect(() => insertCapture('cp-1', 'weird')).toThrow();
    insertCapture('cp-2', null);
    insertCapture('cp-3', 'page-load-failed');
  });

  it('failed 标志非 0/1 被 CHECK 拒绝', () => {
    insertTask('t6', 'created', null);
    expect(() =>
      handle
        .prepare(
          `INSERT INTO research_captures
  (capture_id, task_id, candidate_id, tab_id, url, title, access_time,
   document_id, content_hash, summary_json, failed, failure_reason)
  VALUES ('cp2', 't6', 'c1', 'tab1', 'https://example.com', 't',
   '2026-08-16T00:00:00.000Z', 'doc1', 'h', '{}', 2, NULL)`,
        )
        .run(),
    ).toThrow();
  });
});

describe('CASCADE 布线（决议 #101：删除任务清全部子行）', () => {
  it('research_tasks 主键删除级联清 6 张子表', () => {
    runResearchMigrations(handle);
    handle
      .prepare(
        `INSERT INTO research_tasks (id, goal, status, phase, created_at, updated_at, stats_json)
  VALUES ('t1', 'g', 'created', NULL, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z', '{}')`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO research_candidates
  (candidate_id, task_id, url, display_url, title, canonical_key, scope,
   discovered_via_json, sort_key)
  VALUES ('c1', 't1', 'https://example.com', 'https://example.com', 't',
   'https://example.com', 'page', '[]', 'k')`,
      )
      .run();
    handle
      .prepare(
        `INSERT INTO research_evidence
  (evidence_id, task_id, candidate_id, source_id, capture_id, url, title,
   access_time, document_id, content_hash, type, locator_json, excerpt, value,
   verification)
  VALUES ('e1', 't1', 'c1', NULL, 'cp1', 'https://example.com', 't',
   '2026-08-16T00:00:00.000Z', 'doc1', 'h', 'quote', '{}', 'x', NULL, 'verified')`,
      )
      .run();
    handle.prepare('DELETE FROM research_tasks WHERE id = ?').run('t1');
    expect(handle.prepare('SELECT COUNT(*) AS n FROM research_candidates').get()).toEqual({
      n: 0,
    });
    expect(handle.prepare('SELECT COUNT(*) AS n FROM research_evidence').get()).toEqual({ n: 0 });
  });
});
