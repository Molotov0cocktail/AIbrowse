import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createCountsController, readCounts } from './counts-worker-core';
import { EXPECTED_COUNTS } from './counts';
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('init之前零数据IO且过期后晚init不能启动', async () => {
  vi.useFakeTimers();
  const work = vi.fn(async () => EXPECTED_COUNTS),
    exit = vi.fn();
  let time = 0;
  const controller = createCountsController('fixed', { work, send() {}, exit, now: () => time });
  await Promise.resolve();
  expect(work).not.toHaveBeenCalled();
  time = 10000;
  await vi.advanceTimersByTimeAsync(10000);
  controller.receive(JSON.stringify({ version: 1, operationId: 'fixed', remainingMs: 10000 }));
  await Promise.resolve();
  expect(work).not.toHaveBeenCalled();
  expect(exit).toHaveBeenCalledExactlyOnceWith(2);
});
it('实际readonly三库顺序查询六计数不改原件', () => {
  const root = mkdtempSync(join(tmpdir(), 'counts-readonly-'));
  roots.push(root);
  for (const [file, tables] of [
    ['sources', [['sources', 5000]]],
    ['research', [['research_tasks', 30]]],
    [
      'watch',
      [
        ['watch_rules', 200],
        ['watch_events', 2800],
        ['watch_event_items', 8400],
        ['watch_digests', 1030],
      ],
    ],
  ] as const) {
    const db = new DatabaseSync(join(root, file + '.db'));
    for (const [table, count] of tables)
      db.exec(
        `CREATE TABLE ${table}(id INTEGER); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${count}) INSERT INTO ${table} SELECT x FROM n`,
      );
    db.close();
  }
  const hash = () =>
    ['sources', 'research', 'watch'].map((name) =>
      createHash('sha256')
        .update(readFileSync(join(root, name + '.db')))
        .digest('hex'),
    );
  const before = hash();
  expect(readCounts(root, () => {})).toEqual(EXPECTED_COUNTS);
  expect(hash()).toEqual(before);
  const changed = new DatabaseSync(join(root, 'watch.db'));
  changed.exec('DROP TABLE watch_digests');
  changed.close();
  expect(() => readCounts(root, () => {})).toThrow();
  const afterFailure = new DatabaseSync(join(root, 'watch.db'));
  afterFailure.exec('CREATE TABLE closed_after_error(id INTEGER)');
  afterFailure.close();
});
