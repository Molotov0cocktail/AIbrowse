import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../../../src/main/sources/db/migrations';
import { RESEARCH_MIGRATIONS } from '../../../src/main/research/db/research-migrations';
import { WATCH_MIGRATIONS } from '../../../src/main/watch/db/watch-migrations';
import type { DbHandle } from '../../../src/main/sources/db/sqlite-driver';
import { buildCandidateSortKey } from '../../../src/main/research/source-selector';
import { computeSourceLocatorFingerprint } from '../../../src/shared/watch/watch-rule-state';
import { serializeDigestArtifact } from '../../../src/shared/watch/digest-validator';
import { insertDenseResearch } from '../envelope-fixtures';
import { fixtureId } from '../fixtures';

export type Variant = 'A' | 'B' | 'H';
export const STAMP = '2026-10-10T00:00:00.000Z';
export const LATER = '2026-10-10T01:00:00.000Z';
export const LIMIT = 16 * 1024 ** 2;
export const DOMAINS = ['sources', 'research', 'watch'] as const;
export const offsets = { A: 10, B: 20, H: 30 } as const;
export const id = (variant: Variant, offset = 0): string => fixtureId(offsets[variant] + offset);
export const watchIds = (variant: Variant) => ({
  rule: id(variant, 10000),
  watchRun: id(variant, 10001),
  event: id(variant, 10002),
  item: id(variant, 10003),
  schedule: id(variant, 10004),
  digestRun: id(variant, 10005),
  digest: id(variant, 10006),
  notification: id(variant, 10007),
});
export const url = (variant: Variant): string => `https://example.invalid/restore-${variant}/`;
export const marker = (variant: Variant): string => `恢复夹具${variant}`;
export function handle(db: DatabaseSync): DbHandle {
  return {
    path: '',
    get isOpen() {
      return db.isOpen;
    },
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

function research(db: DatabaseSync, variant: Variant): void {
  const n = offsets[variant];
  insertDenseResearch(handle(db), n);
  const oldHash = hash('合成证据');
  const key = buildCandidateSortKey({
    tier: 3,
    inputRank: 0,
    priority: null,
    lastUsedAt: null,
    scope: 'page',
    canonicalKey: 'https://example.invalid/',
    candidateId: id(variant, 1000),
  });
  db.prepare('UPDATE research_candidates SET sort_key=?,discovered_via_json=?').run(
    key,
    '["search"]',
  );
  db.prepare('UPDATE research_captures SET content_hash=?').run(oldHash.slice(0, 32));
  db.prepare('UPDATE research_evidence SET content_hash=?').run(oldHash.slice(0, 32));
  db.prepare('UPDATE research_tasks SET goal=?').run(marker(variant));
  db.prepare(
    'UPDATE research_results SET title=?,summary=?,blocks_json=?,evidence_map_json=replace(evidence_map_json,?,?)',
  ).run(
    marker(variant),
    `${marker(variant)}研究结论`,
    JSON.stringify([
      {
        kind: 'table',
        columns: ['结果'],
        rows: [[marker(variant)]],
        sourceRefs: [id(variant, 1000)],
      },
      { kind: 'uncertain', text: '合成验收', reason: '无外部采集' },
    ]),
    oldHash,
    oldHash.slice(0, 32),
  );
  if (variant === 'H') {
    db.prepare('INSERT INTO research_tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
      id(variant, 50),
      '恢复夹具H未完成研究',
      'running',
      'reading',
      STAMP,
      STAMP,
      STAMP,
      null,
      null,
      null,
      null,
      JSON.stringify({
        candidateCount: 0,
        selectedCount: 0,
        captureCount: 0,
        failedReadCount: 0,
        evidenceCount: 0,
        rejectedEvidenceCount: 0,
        claimCount: 0,
        conflictCount: 0,
        stepsUsed: 0,
        roundsUsed: 0,
      }),
    );
  }
}

function watch(db: DatabaseSync, variant: Variant): void {
  const dangerous = variant === 'H';
  const identity = watchIds(variant);
  const { rule, event, schedule, digest } = identity;
  const observation = id(variant, 5000);
  const run = identity.digestRun;
  const target = {
    type: 'page',
    pageUrl: url(variant),
    regions: [{ kind: 'main-text', label: '正文' }],
    sessionConsent: dangerous
      ? { version: 1, origin: 'https://example.invalid', grantedAt: STAMP }
      : null,
  };
  db.prepare(
    `INSERT INTO watch_rules(id,source_id,kind,state,pause_reason,desired_enabled,muted,access_mode,schedule_json,target_json,notification_level,source_locator_fingerprint,last_consumed_scheduled_for,created_at,updated_at)
    VALUES(?,?,'page',?,?,?,?,?,?,?,'normal',?,?,?,?)`,
  ).run(
    rule,
    id(variant),
    'paused',
    'user',
    0,
    0,
    dangerous ? 'session' : 'public',
    JSON.stringify({ kind: 'interval', intervalMinutes: 60 }),
    JSON.stringify(target),
    computeSourceLocatorFingerprint({
      sourceId: id(variant),
      scope: 'page',
      canonicalKey: url(variant),
      kind: 'page',
      canonicalTargetUrl: url(variant),
    }),
    dangerous ? STAMP : null,
    STAMP,
    STAMP,
  );
  if (!dangerous) return;
  db.prepare(
    `INSERT INTO watch_runs VALUES (?, ?, ?, 'running','scheduled',?,?,NULL,NULL,NULL,'{}')`,
  ).run(identity.watchRun, rule, `${variant}-consumed-slot`, STAMP, STAMP);
  const pair = {
    itemId: 'item',
    fieldKey: 'main-text:0',
    label: '正文',
    before: { kind: 'absent' },
    after: {
      kind: 'present',
      excerpt: marker(variant),
      valueHash: hash(marker(variant)),
      normalizedBytes: Buffer.byteLength(marker(variant)),
      truncated: false,
    },
    beforeCapturedAt: STAMP,
    afterCapturedAt: STAMP,
    beforeFinalUrl: url(variant),
    afterFinalUrl: url(variant),
    beforeDocumentId: null,
    afterDocumentId: null,
    feedItemKey: null,
  };
  db.prepare(`INSERT INTO watch_events VALUES (?, ?, ?, 'added','normal',?,?,?, ?,1,NULL)`).run(
    event,
    rule,
    id(variant),
    `${variant}-event-key`,
    hash(event),
    STAMP,
    STAMP,
  );
  db.prepare(`INSERT INTO watch_event_observations VALUES (?,?,0,?,?,'added',?,0,1)`).run(
    observation,
    event,
    `${variant}-event-key`,
    hash(event),
    STAMP,
  );
  db.prepare(
    `INSERT INTO watch_event_items VALUES (?,?,0,?,0,'item','main-text:0','正文',?,?,?,?,?,?,NULL,NULL,NULL)`,
  ).run(
    identity.item,
    event,
    observation,
    JSON.stringify(pair.before),
    JSON.stringify(pair.after),
    STAMP,
    STAMP,
    url(variant),
    url(variant),
  );
  db.exec('UPDATE digest_change_state SET last_sequence=1');
  db.prepare(`INSERT INTO digest_change_journal VALUES (1,?,?,?,?, 'active')`).run(
    observation,
    event,
    id(variant),
    STAMP,
  );
  db.prepare(
    `INSERT INTO digest_schedules(id,version,source_ids_json,schedule_json,ai_enabled,cursor_sequence,state,next_due_at,last_consumed_scheduled_for,last_daily_local_date,created_at,updated_at) VALUES(?,1,?,?,1,1,'active',?,?,'2026-10-10',?,?)`,
  ).run(
    schedule,
    JSON.stringify([id(variant)]),
    JSON.stringify({ kind: 'daily', localTime: '09:00', timeZone: 'Asia/Shanghai' }),
    LATER,
    STAMP,
    STAMP,
    STAMP,
  );
  const period = { fromExclusive: STAMP, toInclusive: LATER };
  const stats = { changed: 1, failed: 0, unchanged: 0 };
  db.prepare(
    `INSERT INTO digest_runs(id,schedule_id,request_key,logical_date,lower_sequence,upper_sequence,next_sequence,period_json,run_stats_json,state,created_at,finished_at) VALUES(?,?,?,'2026-10-10',0,1,1,?,?,'running',?,NULL)`,
  ).run(
    run,
    schedule,
    `${variant}-digest-request`,
    JSON.stringify(period),
    JSON.stringify(stats),
    STAMP,
  );
  const facts = JSON.stringify({
    schemaVersion: 1,
    scheduleId: schedule,
    digestRunId: run,
    batchIndex: 0,
    period,
    eventCount: 1,
    runStats: stats,
    events: [
      {
        eventId: event,
        ruleId: rule,
        sourceId: id(variant),
        eventKind: 'added',
        importance: 'normal',
        firstIncludedAt: STAMP,
        lastIncludedAt: STAMP,
        observationCount: 1,
        itemCount: 1,
      },
    ],
    evidenceMap: { [event]: [pair] },
    referenceStates: { [event]: 'active' },
    fetchedAt: LATER,
  });
  db.prepare(
    `INSERT INTO watch_digests(id,schedule_id,run_id,batch_index,first_sequence,last_sequence,facts_json,facts_hash,facts_revision,byte_length,provider_state,claimed_at,claimed_facts_revision,claimed_facts_hash,created_at) VALUES(?,?,?,0,1,1,?,?,1,?,'claimed',?,1,?,?)`,
  ).run(
    digest,
    schedule,
    run,
    facts,
    hash(facts),
    serializeDigestArtifact(facts, null).byteLength,
    LATER,
    hash(facts),
    STAMP,
  );
  db.prepare(`INSERT INTO digest_event_refs VALUES (?,?,'active')`).run(digest, event);
  db.prepare('INSERT INTO notification_outbox VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
    identity.notification,
    rule,
    'event',
    event,
    'windows',
    `windows|event|${event}|1`,
    JSON.stringify({ eventKind: 'added', importance: 'normal', itemCount: 1 }),
    'pending',
    0,
    LATER,
    LATER,
  );
}

/** Only creates a new, absent synthetic root. The caller owns its lifecycle. */
export function createSmallFixture(root: string, variant: Variant): void {
  if (!Object.hasOwn(offsets, variant)) throw new Error('夹具版本无效');
  mkdirSync(root);
  const steps = { sources: MIGRATIONS, research: RESEARCH_MIGRATIONS, watch: WATCH_MIGRATIONS };
  for (const domain of DOMAINS) {
    mkdirSync(join(root, domain));
    const db = new DatabaseSync(join(root, domain, `${domain}.db`), { allowExtension: false });
    try {
      for (const migration of steps[domain]) {
        for (const sql of migration.statements) db.exec(sql);
        db.exec(`PRAGMA user_version=${migration.version}`);
      }
      if (domain === 'research') research(db, variant);
      else if (domain === 'watch') watch(db, variant);
      else {
        db.prepare(
          `INSERT INTO sources(id,scope,canonical_key,url,name,trust_verification,created_at,updated_at) VALUES(?,'page',?, ?,?,'asserted',?,?)`,
        ).run(id(variant), url(variant), url(variant), marker(variant), STAMP, STAMP);
        db.exec("INSERT INTO sources_fts(sources_fts) VALUES ('rebuild')");
      }
    } finally {
      db.close();
    }
  }
  mkdirSync(join(root, 'conversations'));
  const sessionId = id(variant, 9000);
  writeFileSync(
    join(root, 'conversations', 'index.json'),
    JSON.stringify({
      version: 1,
      sessions: [
        {
          id: sessionId,
          title: marker(variant),
          createdAt: Date.parse(STAMP),
          updatedAt: Date.parse(LATER),
          ephemeral: false,
        },
      ],
    }),
    { flag: 'wx' },
  );
  writeFileSync(
    join(root, 'conversations', `${sessionId}.json`),
    JSON.stringify({
      version: 2,
      messages: [
        {
          id: id(variant, 9001),
          role: 'user',
          content: `${marker(variant)}问题`,
          createdAt: Date.parse(STAMP),
          status: 'complete',
        },
        {
          id: id(variant, 9002),
          role: 'assistant',
          content: `${marker(variant)}回答`,
          createdAt: Date.parse(LATER),
          status: 'complete',
        },
      ],
    }),
    { flag: 'wx' },
  );
  const files = [
    ...DOMAINS.map((domain) => join(root, domain, `${domain}.db`)),
    join(root, 'conversations', 'index.json'),
    join(root, 'conversations', `${sessionId}.json`),
  ];
  if (files.reduce((total, path) => total + statSync(path).size, 0) > LIMIT)
    throw new Error('小恢复夹具超过16MiB；原件保留');
}
