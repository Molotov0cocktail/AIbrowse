import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { createDatasetScope } from '../../src/main/storage/dataset-layout';
import { runTransferPipeline } from '../../src/main/storage/transfer-pipeline';
import { WATCH_MIGRATIONS } from '../../src/main/watch/db/watch-migrations';
import { WatchRepository } from '../../src/main/watch/repository/watch-repository';
import { DigestService } from '../../src/main/watch/digest-service';
import { FakeClock } from '../../src/shared/watch/clock';
import { validateWatchTransferDatabase } from '../../src/main/watch/repository/watch-transfer-validation';

const opened: DatabaseSync[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) if (db.isOpen) db.close();
  vi.restoreAllMocks();
});
const root = join(process.cwd(), 'log/stage7-e2/independent-transfer-no-replay-review-001');
fs.mkdirSync(root, { recursive: true });
const now = '2026-10-04T00:00:00.000Z';
const before = '2026-10-03T00:00:00.000Z';
function open(path: string) {
  const db = new DatabaseSync(path);
  opened.push(db);
  return db;
}
function service(db: DatabaseSync, path: string) {
  const repository = new WatchRepository({
    path,
    get isOpen() {
      return db.isOpen;
    },
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  });
  const provider = vi.fn(async () => null);
  const digest = new DigestService({
    repository,
    clock: new FakeClock(Date.parse(now)),
    sharing: { get: async () => [] },
    provider: { resolve: provider },
    scheduleControl: { upsert() {}, remove() {} },
  });
  return { repository, provider, digest };
}

it('迁移保留旧running/cursor事实但实际Digest启动不续跑，原active对照确实会推进', async () => {
  const userDataRoot = fs.mkdtempSync(join(root, 'fixture-'));
  const job = { operationId: randomUUID(), snapshotId: randomUUID(), action: 'migrate' as const };
  const scope = await createDatasetScope(
    {
      userDataRoot,
      operationId: job.operationId.replaceAll('-', ''),
      generation: randomUUID().replaceAll('-', ''),
      purpose: job.action,
    },
    { check() {}, requireRollbackSpace() {} },
  );
  fs.mkdirSync(join(userDataRoot, 'watch'));
  const originalPath = join(userDataRoot, 'watch', 'watch.db');
  const original = open(originalPath);
  for (const migration of WATCH_MIGRATIONS) {
    for (const sql of migration.statements) original.exec(sql);
    original.exec(`PRAGMA user_version=${migration.version}`);
  }
  original
    .prepare(
      `INSERT INTO digest_schedules
    (id,version,source_ids_json,schedule_json,ai_enabled,cursor_sequence,state,next_due_at,created_at,updated_at)
    VALUES ('schedule',1,'["11111111-1111-4111-8111-111111111111"]',?,1,0,'active',?,?,?)`,
    )
    .run(
      JSON.stringify({ kind: 'daily', localTime: '09:00', timeZone: 'Asia/Shanghai' }),
      now,
      before,
      before,
    );
  original
    .prepare(
      `INSERT INTO digest_runs
    (id,schedule_id,request_key,logical_date,lower_sequence,upper_sequence,next_sequence,period_json,run_stats_json,state,created_at)
    VALUES ('run','schedule','request','2026-10-03',0,0,0,?,?,'running',?)`,
    )
    .run(
      JSON.stringify({ fromExclusive: before, toInclusive: now }),
      JSON.stringify({ changed: 0, failed: 0, unchanged: 0 }),
      before,
    );
  expect(validateWatchTransferDatabase(original).ok).toBe(true);
  const hash = () => createHash('sha256').update(fs.readFileSync(originalPath)).digest('hex');
  const originalHash = hash();
  await runTransferPipeline({
    job,
    scope,
    productVersion: '0.1.0',
    selectedInput: null,
    control: { signal: new AbortController().signal, deadline: performance.now() + 10000 },
    enterPhase: async () => {},
    nowIso: now,
  });
  expect(hash()).toBe(originalHash);
  const workPath = join(scope.operationRoot, 'work', 'watch.db');
  const work = open(workPath);
  expect(validateWatchTransferDatabase(work).ok).toBe(true);
  expect(work.prepare('SELECT state,cursor_sequence FROM digest_schedules').get()).toEqual({
    state: 'paused',
    cursor_sequence: 0,
  });
  const resumed = service(work, workPath);
  const getRun = vi.spyOn(resumed.repository, 'getNonterminalDigestRun');
  await resumed.digest.resumeActiveCycles();
  expect(getRun).not.toHaveBeenCalled();
  expect(resumed.provider).not.toHaveBeenCalled();
  expect(work.prepare('SELECT state,next_sequence FROM digest_runs').get()).toEqual({
    state: 'running',
    next_sequence: 0,
  });
  const control = service(original, originalPath);
  await control.digest.resumeActiveCycles();
  expect(original.prepare('SELECT state FROM digest_runs').get()).toEqual({ state: 'completed' });
});
