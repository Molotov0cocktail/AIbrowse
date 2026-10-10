import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as sqlite from 'node:sqlite';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { createDatasetScope } from './dataset-layout';
import { runTransferPipeline, type TransferPipelineOptions } from './transfer-pipeline';
import { MIGRATIONS } from '../sources/db/migrations';
import { RESEARCH_MIGRATIONS } from '../research/db/research-migrations';
import { WATCH_MIGRATIONS } from '../watch/db/watch-migrations';
import { ZERO_TASK_STATS } from '../research/domain/research-task-state';
import { computeSourceLocatorFingerprint } from '../../shared/watch/watch-rule-state';
import {
  BACKUP_IDS,
  BACKUP_FILES,
  readBackupContainer,
  writeBackupContainer,
} from './backup-container';
import { fingerprintPath } from './dataset-layout';
import type { RegisteredTransferInput } from './transfer-registration';
import { serializeDigestArtifact } from '../../shared/watch/digest-validator';
import { WatchRepository } from '../watch/repository/watch-repository';
const opened: DatabaseSync[] = [];
vi.mock('node:sqlite', async (original) => ({
  ...(await original<typeof import('node:sqlite')>()),
}));
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of opened.splice(0)) if (db.isOpen) db.close();
});
const root = fs.mkdtempSync(join(tmpdir(), 'transfer-pipeline-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
it.each(['-wal', '-shm', '-journal'])(
  'rejects a late orphan sidecar %s for an initially absent database',
  async (suffix) => {
    const options = await fixture();
    const domain = join(options.scope.userDataRoot, 'sources');
    fs.mkdirSync(domain);
    options.enterPhase = async (phase) => {
      if (phase === 'conversations')
        fs.writeFileSync(join(domain, `sources.db${suffix}`), 'recovery-data');
    };
    await expect(runTransferPipeline(options)).rejects.toThrow('原件和现场已保留');
    expect(fs.readFileSync(join(domain, `sources.db${suffix}`), 'utf8')).toBe('recovery-data');
  },
);
async function fixture(
  action: 'backup' | 'restore' | 'migrate' = 'backup',
): Promise<TransferPipelineOptions> {
  const userDataRoot = fs.mkdtempSync(join(root, 'profile-'));
  const operationId = randomUUID();
  const scope = await createDatasetScope(
    {
      userDataRoot,
      operationId: operationId.replaceAll('-', ''),
      generation: randomUUID().replaceAll('-', ''),
      purpose: action,
    },
    { check() {}, requireRollbackSpace() {} },
  );
  return {
    job: { operationId, snapshotId: randomUUID(), action },
    scope,
    productVersion: '0.1.0',
    selectedInput: null,
    control: { signal: new AbortController().signal, deadline: performance.now() + 10000 },
    enterPhase: async () => {},
    nowIso: '2026-10-04T00:00:00.000Z',
  };
}
it('creates a verified backup from an initially empty profile without creating live stores', async () => {
  const options = await fixture();
  await expect(runTransferPipeline(options)).resolves.toHaveProperty('backup.sha256');
  expect(fs.existsSync(join(options.scope.operationRoot, 'output.aibak'))).toBe(true);
  expect(fs.existsSync(join(options.scope.userDataRoot, 'sources'))).toBe(false);
});
it('does not start SQLite work until the main process grants its phase', async () => {
  const options = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  options.enterPhase = () =>
    new Promise<void>((resolve) => {
      release = resolve;
      entered();
    });
  const pending = runTransferPipeline(options);
  await entry;
  expect(fs.readdirSync(join(options.scope.operationRoot, 'work'))).toEqual([]);
  options.control.signal.throwIfAborted();
  release();
  options.enterPhase = async () => {};
  await expect(pending).resolves.toHaveProperty('manifest');
});
function open(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  opened.push(db);
  return db;
}
function live(
  options: TransferPipelineOptions,
  domain: 'sources' | 'research' | 'watch',
  wal = false,
): DatabaseSync {
  const directory = join(options.scope.userDataRoot, domain);
  fs.mkdirSync(directory);
  const db = open(join(directory, `${domain}.db`));
  if (wal) db.exec('PRAGMA journal_mode=WAL');
  for (const step of domain === 'sources'
    ? MIGRATIONS
    : domain === 'research'
      ? RESEARCH_MIGRATIONS
      : WATCH_MIGRATIONS) {
    for (const sql of step.statements) db.exec(sql);
    db.exec(`PRAGMA user_version=${step.version}`);
  }
  return db;
}
function registered(path: string): RegisteredTransferInput {
  const stat = fs.lstatSync(path, { bigint: true });
  return {
    path,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}
function sum(path: string): string {
  return createHash('sha256').update(fs.readFileSync(path)).digest('hex');
}
const sourceId = '11111111-1111-4111-8111-111111111111';
function sourceRow(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO sources(id,scope,canonical_key,url,name,trust_verification,created_at,updated_at) VALUES(?,'page','https://example.com/','https://example.com/','合成信源','asserted',?,?)`,
  ).run(sourceId, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
}
function researchRow(db: DatabaseSync): void {
  db.prepare('INSERT INTO research_tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
    sourceId,
    '研究',
    'running',
    'reading',
    '2026-10-01T00:00:00.000Z',
    '2026-10-01T00:00:00.000Z',
    '2026-10-01T00:00:00.000Z',
    null,
    null,
    null,
    null,
    JSON.stringify(ZERO_TASK_STATS),
  );
}
function watchRow(db: DatabaseSync): void {
  const target = {
    type: 'page',
    pageUrl: 'https://example.com/',
    regions: [{ kind: 'main-text', label: '正文' }],
    sessionConsent: {
      version: 1,
      origin: 'https://example.com',
      grantedAt: '2026-10-01T00:00:00.000Z',
    },
  };
  db.prepare(
    `INSERT INTO watch_rules(id,source_id,kind,state,desired_enabled,muted,access_mode,schedule_json,target_json,notification_level,source_locator_fingerprint,created_at,updated_at) VALUES('rule',?,'page','enabled',1,0,'session',?,?,'normal',?,?,?)`,
  ).run(
    sourceId,
    JSON.stringify({ kind: 'interval', intervalMinutes: 60 }),
    JSON.stringify(target),
    computeSourceLocatorFingerprint({
      sourceId,
      scope: 'page',
      canonicalKey: 'https://example.com/',
      kind: 'page',
      canonicalTargetUrl: 'https://example.com/',
    }),
    '2026-10-01T00:00:00.000Z',
    '2026-10-01T00:00:00.000Z',
  );
  db.prepare(
    `INSERT INTO watch_runs VALUES ('run','rule','request','running','manual',NULL,?,NULL,NULL,NULL,'{}')`,
  ).run('2026-10-01T00:00:00.000Z');
}
function claimedDigest(db: DatabaseSync): void {
  const now = '2026-10-01T00:00:00.000Z';
  const later = '2026-10-02T00:00:00.000Z';
  const period = { fromExclusive: now, toInclusive: later };
  const stats = { changed: 1, failed: 0, unchanged: 0 };
  const pair = {
    itemId: 'item',
    fieldKey: 'main-text:0',
    label: '正文',
    before: { kind: 'absent' },
    after: {
      kind: 'present',
      excerpt: '变化',
      valueHash: createHash('sha256').update('变化').digest('hex'),
      normalizedBytes: 6,
      truncated: false,
    },
    beforeCapturedAt: now,
    afterCapturedAt: now,
    beforeFinalUrl: 'https://example.com/',
    afterFinalUrl: 'https://example.com/',
    beforeDocumentId: null,
    afterDocumentId: null,
    feedItemKey: null,
  };
  db.prepare(
    "INSERT INTO watch_events VALUES ('event','rule',?,'added','normal','idem','fp',?,?,1,NULL)",
  ).run(sourceId, now, now);
  db.prepare(
    "INSERT INTO watch_event_observations VALUES ('v2:event','event',0,'idem','fp','added',?,0,1)",
  ).run(now);
  db.prepare(
    "INSERT INTO watch_event_items VALUES ('event-0','event',0,'v2:event',0,'item','main-text:0','正文',?,?,?,?,'https://example.com/','https://example.com/',NULL,NULL,NULL)",
  ).run(JSON.stringify(pair.before), JSON.stringify(pair.after), now, now);
  db.exec('UPDATE digest_change_state SET last_sequence=1');
  db.prepare("INSERT INTO digest_change_journal VALUES (1,'v2:event','event',?,?,'active')").run(
    sourceId,
    now,
  );
  db.prepare(
    "INSERT INTO digest_schedules(id,version,source_ids_json,schedule_json,ai_enabled,cursor_sequence,state,next_due_at,created_at,updated_at) VALUES('schedule',1,?,?,1,1,'active',?,?,?)",
  ).run(
    JSON.stringify([sourceId]),
    JSON.stringify({ kind: 'daily', localTime: '09:00', timeZone: 'Asia/Shanghai' }),
    later,
    now,
    now,
  );
  db.prepare(
    "INSERT INTO digest_runs(id,schedule_id,request_key,logical_date,lower_sequence,upper_sequence,next_sequence,period_json,run_stats_json,state,created_at,finished_at) VALUES('digest-run','schedule','digest-request','2026-10-02',0,1,1,?,?,'completed',?,?)",
  ).run(JSON.stringify(period), JSON.stringify(stats), now, later);
  const facts = JSON.stringify({
    schemaVersion: 1,
    scheduleId: 'schedule',
    digestRunId: 'digest-run',
    batchIndex: 0,
    period,
    eventCount: 1,
    runStats: stats,
    events: [
      {
        eventId: 'event',
        ruleId: 'rule',
        sourceId,
        eventKind: 'added',
        importance: 'normal',
        firstIncludedAt: now,
        lastIncludedAt: now,
        observationCount: 1,
        itemCount: 1,
      },
    ],
    evidenceMap: { event: [pair] },
    referenceStates: { event: 'active' },
    fetchedAt: later,
  });
  const hash = createHash('sha256').update(facts).digest('hex');
  db.prepare(
    "INSERT INTO watch_digests(id,schedule_id,run_id,batch_index,first_sequence,last_sequence,facts_json,facts_hash,facts_revision,byte_length,provider_state,claimed_at,claimed_facts_revision,claimed_facts_hash,created_at) VALUES('digest','schedule','digest-run',0,1,1,?,?,1,?,'claimed',?,1,?,?)",
  ).run(facts, hash, serializeDigestArtifact(facts, null).byteLength, later, hash, now);
  db.exec("INSERT INTO digest_event_refs VALUES('digest','event','active')");
}
it.each(['restore', 'migrate'] as const)(
  'prevents old Digest and pending notification replay after %s',
  async (action) => {
    const origin = await fixture(action === 'restore' ? 'backup' : 'migrate');
    sourceRow(live(origin, 'sources'));
    const watch = live(origin, 'watch');
    watchRow(watch);
    claimedDigest(watch);
    watch.exec("UPDATE digest_runs SET state='running',finished_at=NULL");
    for (const state of ['pending', 'uncertain', 'sent']) {
      const subject = state === 'sent' ? 'digest' : 'event';
      const channel = state === 'uncertain' ? 'in-app' : 'windows';
      watch.prepare('INSERT INTO notification_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
        state,
        subject === 'event' ? 'rule' : null,
        subject,
        subject,
        channel,
        `${channel}|${subject}|${subject}|1`,
        JSON.stringify({
          eventKind: subject === 'event' ? 'added' : 'digest',
          importance: 'normal',
          itemCount: 1,
        }),
        state,
        state === 'pending' ? 0 : 2,
        '2026-10-02T00:00:00.000Z',
        '2026-10-02T00:00:00.000Z',
      );
    }
    let options = origin;
    if (action === 'restore') {
      await runTransferPipeline(origin);
      options = await fixture('restore');
      options.job = { ...options.job, snapshotId: origin.job.snapshotId };
      options.selectedInput = registered(join(origin.scope.operationRoot, 'output.aibak'));
    }
    await runTransferPipeline(options);
    const result = open(join(options.scope.operationRoot, 'work/watch.db'));
    expect(result.prepare('SELECT state,cursor_sequence FROM digest_schedules').get()).toEqual({
      state: 'paused',
      cursor_sequence: 1,
    });
    expect(result.prepare('SELECT state,next_sequence FROM digest_runs').get()).toEqual({
      state: 'running',
      next_sequence: 1,
    });
    expect(
      result.prepare('SELECT id,state,attempts FROM notification_outbox ORDER BY id').all(),
    ).toEqual([
      { id: 'pending', state: 'failed', attempts: 0 },
      { id: 'sent', state: 'sent', attempts: 2 },
      { id: 'uncertain', state: 'uncertain', attempts: 2 },
    ]);
    expect(watch.prepare('SELECT state FROM digest_schedules').get()?.state).toBe('active');
    expect(
      watch.prepare("SELECT state FROM notification_outbox WHERE id='pending'").get()?.state,
    ).toBe('pending');
  },
);
it('rolls back Watch normalization and rejects the pipeline when notification normalization fails', async () => {
  const options = await fixture('migrate');
  sourceRow(live(options, 'sources'));
  const watch = live(options, 'watch');
  watchRow(watch);
  claimedDigest(watch);
  watch.exec("UPDATE digest_runs SET state='running',finished_at=NULL");
  vi.spyOn(WatchRepository.prototype, 'failPendingNotificationsForTransfer').mockImplementation(
    () => {
      throw new Error('private SQL failure');
    },
  );
  await expect(runTransferPipeline(options)).rejects.toThrow('数据维护校验失败');
  const work = open(join(options.scope.operationRoot, 'work/watch.db'));
  expect(work.prepare('SELECT state FROM digest_schedules').get()?.state).toBe('active');
  expect(work.prepare('SELECT status FROM watch_runs').get()?.status).toBe('running');
  expect(work.prepare('SELECT provider_state FROM watch_digests').get()?.provider_state).toBe(
    'claimed',
  );
});
it('backs up real committed WAL data without changing original DB or WAL bytes', async () => {
  const options = await fixture();
  const db = live(options, 'sources', true);
  sourceRow(db);
  const path = join(options.scope.userDataRoot, 'sources', 'sources.db');
  const before = [sum(path), sum(path + '-wal')];
  const result = await runTransferPipeline(options);
  expect([sum(path), sum(path + '-wal')]).toEqual(before);
  expect(
    open(join(options.scope.operationRoot, 'raw', 'sources.db'))
      .prepare('SELECT name FROM sources')
      .get()?.name,
  ).toBe('合成信源');
  const work = open(join(options.scope.operationRoot, 'work', 'sources.db'));
  expect(
    work.prepare("SELECT rowid FROM sources_fts WHERE sources_fts MATCH '合成信源'").all(),
  ).toHaveLength(1);
  expect(result.backup?.sha256).toBe(sum(join(options.scope.operationRoot, 'output.aibak')));
  expect(fs.existsSync(join(options.scope.operationRoot, 'work', 'conversations'))).toBe(false);
  expect(result.manifest.members[3].sha256).toBe(
    sum(join(options.scope.operationRoot, 'work', 'conversations.bin')),
  );
});
it('restores into new work members, normalizes external action state, and leaves live files untouched', async () => {
  const backupOptions = await fixture();
  sourceRow(live(backupOptions, 'sources'));
  researchRow(live(backupOptions, 'research'));
  const originalWatch = live(backupOptions, 'watch');
  watchRow(originalWatch);
  claimedDigest(originalWatch);
  const conversationDirectory = join(backupOptions.scope.userDataRoot, 'conversations');
  fs.mkdirSync(conversationDirectory);
  fs.writeFileSync(
    join(conversationDirectory, 'index.json'),
    JSON.stringify({
      version: 1,
      sessions: [{ id: sourceId, title: '保留', createdAt: 1, updatedAt: 2, ephemeral: false }],
    }),
  );
  await runTransferPipeline(backupOptions);
  const options = await fixture('restore');
  options.job = { ...options.job, snapshotId: backupOptions.job.snapshotId };
  options.selectedInput = registered(join(backupOptions.scope.operationRoot, 'output.aibak'));
  const phases: string[] = [];
  options.enterPhase = async (phase) => {
    phases.push(phase);
  };
  const liveSentinel = join(options.scope.userDataRoot, 'sources');
  fs.mkdirSync(liveSentinel);
  fs.writeFileSync(join(liveSentinel, 'sources.db'), '原数据库哨兵');
  const result = await runTransferPipeline(options);
  expect(phases).toEqual(['containerIo', 'sqlite', 'conversations']);
  expect(fs.readFileSync(join(liveSentinel, 'sources.db'), 'utf8')).toBe('原数据库哨兵');
  expect(result.backup).toBeNull();
  const research = open(join(options.scope.operationRoot, 'work', 'research.db'));
  expect(research.prepare('SELECT status FROM research_tasks').get()?.status).toBe('interrupted');
  const watch = open(join(options.scope.operationRoot, 'work', 'watch.db'));
  expect(watch.prepare('SELECT status FROM watch_runs').get()?.status).toBe('interrupted');
  expect(
    watch.prepare('SELECT provider_state,provider_result_code FROM watch_digests').get(),
  ).toMatchObject({ provider_state: 'uncertain', provider_result_code: 'uncertain-after-restart' });
  expect(
    originalWatch.prepare('SELECT provider_state FROM watch_digests').get()?.provider_state,
  ).toBe('claimed');
  expect(
    JSON.parse(String(watch.prepare('SELECT target_json FROM watch_rules').get()?.target_json))
      .sessionConsent,
  ).toBeNull();
  const tree = await fingerprintPath(
    options.scope,
    join(options.scope.operationRoot, 'work', 'conversations'),
    { check() {}, requireRollbackSpace() {} },
    'register',
  );
  expect(result.manifest.members[3]).toMatchObject(tree!);
  expect(
    open(join(backupOptions.scope.operationRoot, 'raw', 'research.db'))
      .prepare('SELECT status FROM research_tasks')
      .get()?.status,
  ).toBe('running');
});
it('uses explicit absent wire members but generates closed empty current work stores on restore', async () => {
  const backupOptions = await fixture();
  await runTransferPipeline(backupOptions);
  const inputPath = join(backupOptions.scope.operationRoot, 'output.aibak');
  const decoded = readBackupContainer({
    inputPath,
    stagingDirectory: join(root, randomUUID()),
    control: backupOptions.control,
  });
  expect(decoded.manifest.members.every((member) => member.present === false)).toBe(true);
  const options = await fixture('restore');
  options.job = { ...options.job, snapshotId: backupOptions.job.snapshotId };
  options.selectedInput = registered(inputPath);
  const result = await runTransferPipeline(options);
  expect(result.manifest.members.every((member) => member.present)).toBe(true);
  for (const domain of ['sources', 'research', 'watch'])
    expect(
      open(join(options.scope.operationRoot, 'work', `${domain}.db`))
        .prepare('PRAGMA user_version')
        .get()?.user_version,
    ).toBe(domain === 'watch' ? 5 : 1);
});
it('migrates historical empty schemas without overwriting the source or creating a backup output', async () => {
  const options = await fixture('migrate');
  fs.mkdirSync(join(options.scope.userDataRoot, 'sources'));
  const source = join(options.scope.userDataRoot, 'sources', 'sources.db');
  const old = open(source);
  old.exec('PRAGMA user_version=0');
  old.close();
  const before = sum(source);
  const phases: string[] = [];
  options.enterPhase = async (phase) => {
    phases.push(phase);
  };
  const result = await runTransferPipeline(options);
  expect(phases).toEqual(['sqlite', 'conversations']);
  expect(result.backup).toBeNull();
  expect(sum(source)).toBe(before);
  expect(fs.existsSync(join(options.scope.operationRoot, 'output.aibak'))).toBe(false);
});
it.each(['schema', 'future-version', 'semantics', 'cross'] as const)(
  'refuses %s defects and preserves source and failed staging',
  async (kind) => {
    const options = await fixture('migrate');
    const source = live(options, 'sources');
    sourceRow(source);
    if (kind === 'schema') source.exec('CREATE TABLE extra(secret TEXT)');
    if (kind === 'future-version') source.exec('PRAGMA user_version=999');
    if (kind === 'semantics') source.exec("UPDATE sources SET canonical_key='mismatch'");
    if (kind === 'cross') {
      watchRow(live(options, 'watch'));
      source.exec('DELETE FROM sources');
    }
    const path = join(options.scope.userDataRoot, 'sources', 'sources.db');
    const before = sum(path);
    await expect(runTransferPipeline(options)).rejects.toThrow('数据维护校验失败');
    expect(sum(path)).toBe(before);
    expect(fs.existsSync(join(options.scope.operationRoot, 'raw', 'sources.db'))).toBe(true);
    expect(fs.existsSync(join(options.scope.operationRoot, 'work', 'sources.db'))).toBe(true);
  },
);
it('refuses an existing work file without overwriting it', async () => {
  const options = await fixture();
  const file = join(options.scope.operationRoot, 'work', 'sources.db');
  fs.writeFileSync(file, '保留');
  await expect(runTransferPipeline(options)).rejects.toThrow();
  expect(fs.readFileSync(file, 'utf8')).toBe('保留');
});
it('rejects a selected container changed after main-process registration', async () => {
  const options = await fixture('restore');
  const file = join(root, randomUUID());
  fs.writeFileSync(file, '合成');
  options.selectedInput = registered(file);
  fs.appendFileSync(file, '变更');
  await expect(runTransferPipeline(options)).rejects.toThrow();
  expect(fs.readdirSync(join(options.scope.operationRoot, 'raw'))).toEqual([]);
});
it('cancels at the phase grant without starting that phase', async () => {
  const options = await fixture();
  const abort = new AbortController();
  options.control = { ...options.control, signal: abort.signal };
  options.enterPhase = async () => {
    abort.abort();
  };
  await expect(runTransferPipeline(options)).rejects.toMatchObject({ code: 'cancelled' });
  expect(fs.readdirSync(join(options.scope.operationRoot, 'work'))).toEqual([]);
});
it('rejects a wire-declared schema version that disagrees with the actual safe schema', async () => {
  const backupOptions = await fixture();
  sourceRow(live(backupOptions, 'sources'));
  await runTransferPipeline(backupOptions);
  const snapshotDirectory = join(backupOptions.scope.operationRoot, 'work');
  const outputPath = join(root, randomUUID());
  const files = Object.fromEntries(
    BACKUP_IDS.map((id) => [
      id,
      id === 'sources'
        ? {
            path: join(snapshotDirectory, BACKUP_FILES[id]),
            schemaVersion: 0,
            snapshotId: backupOptions.job.snapshotId,
          }
        : null,
    ]),
  ) as Parameters<typeof writeBackupContainer>[0]['files'];
  writeBackupContainer({
    snapshotDirectory,
    files,
    outputPath,
    snapshotId: backupOptions.job.snapshotId,
    productVersion: '0.1.0',
    control: backupOptions.control,
  });
  const options = await fixture('restore');
  options.job = { ...options.job, snapshotId: backupOptions.job.snapshotId };
  options.selectedInput = registered(outputPath);
  await expect(runTransferPipeline(options)).rejects.toMatchObject({ code: 'validation' });
});
it('rejects a linked live domain even when the linked directory has no database', async () => {
  const options = await fixture();
  const other = fs.mkdtempSync(join(root, 'foreign-'));
  fs.symlinkSync(other, join(options.scope.userDataRoot, 'sources'), 'junction');
  await expect(runTransferPipeline(options)).rejects.toThrow();
  expect(fs.readdirSync(other)).toEqual([]);
});
it('does not create a backup when a known Conversation field is invalid', async () => {
  const options = await fixture();
  const source = join(options.scope.userDataRoot, 'conversations');
  fs.mkdirSync(source);
  const index = JSON.stringify({
    version: 1,
    sessions: [{ id: sourceId, title: 123, createdAt: 1, updatedAt: 2, ephemeral: false }],
  });
  fs.writeFileSync(join(source, 'index.json'), index);
  await expect(runTransferPipeline(options)).rejects.toThrow();
  expect(fs.readFileSync(join(source, 'index.json'), 'utf8')).toBe(index);
  expect(fs.existsSync(join(options.scope.operationRoot, 'output.aibak'))).toBe(false);
});
it('refuses work DB changes after their SQLite phase receipts were established', async () => {
  const options = await fixture();
  options.enterPhase = async (phase) => {
    if (phase === 'conversations')
      fs.appendFileSync(join(options.scope.operationRoot, 'work', 'sources.db'), '变更');
  };
  await expect(runTransferPipeline(options)).rejects.toThrow();
  expect(fs.existsSync(join(options.scope.operationRoot, 'work', 'sources.db'))).toBe(true);
});
it('detects source Conversation changes during the later container phase', async () => {
  const options = await fixture();
  const source = join(options.scope.userDataRoot, 'conversations');
  fs.mkdirSync(source);
  const index = join(source, 'index.json');
  fs.writeFileSync(index, JSON.stringify({ version: 1, sessions: [] }));
  options.enterPhase = async (phase) => {
    if (phase === 'containerIo') fs.appendFileSync(index, ' ');
  };
  await expect(runTransferPipeline(options)).rejects.toThrow();
  expect(fs.readFileSync(index, 'utf8').endsWith(' ')).toBe(true);
});
it('rejects a mismatched snapshot without substituting the new data generation', async () => {
  const saved = await fixture();
  await runTransferPipeline(saved);
  const options = await fixture('restore');
  options.selectedInput = registered(join(saved.scope.operationRoot, 'output.aibak'));
  expect(options.scope.generation).not.toBe(saved.job.snapshotId.replaceAll('-', ''));
  await expect(runTransferPipeline(options)).rejects.toMatchObject({ code: 'validation' });
});
it('cooperatively cancels a real native SQLite backup at its bounded progress callback', async () => {
  const options = await fixture();
  const source = live(options, 'sources');
  sourceRow(source);
  source.prepare('UPDATE sources SET user_note=?').run('x'.repeat(1024 * 1024));
  const path = join(options.scope.userDataRoot, 'sources', 'sources.db');
  const before = sum(path);
  const abort = new AbortController();
  options.control = { ...options.control, signal: abort.signal };
  const actual = sqlite.backup;
  let progress = 0;
  vi.spyOn(sqlite, 'backup').mockImplementation((db, target, settings) =>
    actual(db, target, {
      ...settings,
      progress: (info) => {
        progress++;
        abort.abort();
        settings?.progress?.(info);
      },
    }),
  );
  await expect(runTransferPipeline(options)).rejects.toMatchObject({ code: 'cancelled' });
  expect(progress).toBeGreaterThan(0);
  expect(sum(path)).toBe(before);
  expect(fs.existsSync(join(options.scope.operationRoot, 'raw', 'sources.db'))).toBe(true);
});
it('attempts to close every private work handle when one close reports failure', async () => {
  const options = await fixture();
  const actual = DatabaseSync.prototype.close;
  const closed: string[] = [];
  vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
    const location = this.location()?.replaceAll('/', '\\');
    actual.call(this);
    if (location?.includes('\\work\\')) {
      closed.push(location);
      if (location.endsWith('watch.db')) throw new Error('private close detail');
    }
  });
  await expect(runTransferPipeline(options)).rejects.toMatchObject({
    code: 'io',
    message: '数据维护校验失败，原件和现场已保留',
  });
  expect(closed).toHaveLength(3);
  expect(fs.existsSync(join(options.scope.operationRoot, 'output.aibak'))).toBe(false);
});
it.each(['-wal', '-shm', '-journal'])(
  'rejects a multiply linked live %s sidecar before native snapshot access',
  async (suffix) => {
    const options = await fixture();
    live(options, 'sources');
    const foreign = join(root, randomUUID());
    fs.writeFileSync(foreign, '外部哨兵');
    fs.linkSync(foreign, join(options.scope.userDataRoot, 'sources', 'sources.db') + suffix);
    await expect(runTransferPipeline(options)).rejects.toThrow();
    expect(fs.readFileSync(foreign, 'utf8')).toBe('外部哨兵');
    expect(fs.readdirSync(join(options.scope.operationRoot, 'raw'))).toEqual([]);
  },
);
