import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS } from '../../../src/main/sources/db/migrations';
import { RESEARCH_MIGRATIONS } from '../../../src/main/research/db/research-migrations';
import { WATCH_MIGRATIONS } from '../../../src/main/watch/db/watch-migrations';
import type { DbHandle } from '../../../src/main/sources/db/sqlite-driver';
import {
  validateSourceTransfer,
  normalizeAndVerifySourceIndex,
} from '../../../src/main/sources/repository/source-transfer-validation';
import { validateResearchTransfer } from '../../../src/main/research/repository/research-transfer-validation';
import { validateWatchTransferDatabase } from '../../../src/main/watch/repository/watch-transfer-validation';
import {
  validateTransferSchema,
  historicalWatchMigrationSteps,
} from '../../../src/main/storage/transfer-schema';
import { buildCandidateSortKey } from '../../../src/main/research/source-selector';
import { canonicalizeDigestFacts } from '../../../src/shared/watch/digest-facts';
import { serializeDigestArtifact } from '../../../src/shared/watch/digest-validator';
import type { DigestFacts } from '../../../src/shared/types/watch';
import { appendSources, fixtureId, populateWatch, STAMP } from '../fixtures';
import {
  appendDenseDigest,
  appendDenseEvent,
  insertDenseResearch,
  prepareDigestParents,
} from '../envelope-fixtures';
import { exactSession, fiftyIndex } from '../projection/samples';
import { FIXTURE, assertFact } from './contract';

const schemas = {
  sources: MIGRATIONS,
  research: RESEARCH_MIGRATIONS,
  watch: WATCH_MIGRATIONS,
} as const;

function handle(db: DatabaseSync, path: string): DbHandle {
  return {
    path,
    isOpen: true,
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

function apply(
  db: DatabaseSync,
  steps: readonly { version: number; statements: readonly string[] }[],
) {
  for (const step of steps) {
    for (const statement of step.statements) db.exec(statement);
    db.exec(`PRAGMA user_version=${step.version}`);
  }
}

// Corrections apply only to freshly generated synthetic records. No row or saved
// text is dropped; source fixtures and former measurement artifacts stay intact.
export function seedSources(db: DatabaseSync, count: number): void {
  appendSources(db, 0, count);
  // Legacy size fixtures used SQL defaults; the manual Service writes asserted.
  db.exec("UPDATE sources SET trust_verification='asserted'");
}

export function seedResearch(db: DatabaseSync, count: number): void {
  db.exec('BEGIN');
  try {
    for (let index = 0; index < count; index++) {
      insertDenseResearch(handle(db, ''), index);
      const key = buildCandidateSortKey({
        tier: 3,
        inputRank: 0,
        priority: null,
        lastUsedAt: null,
        scope: 'page',
        canonicalKey: 'https://example.invalid/',
        candidateId: fixtureId(1000 + index),
      });
      db.prepare(
        'UPDATE research_candidates SET sort_key=?,discovered_via_json=? WHERE candidate_id=?',
      ).run(key, '["search"]', fixtureId(1000 + index));
      const oldHash = createHash('sha256').update('合成证据').digest('hex');
      const contentHash = oldHash.slice(0, 32);
      db.prepare('UPDATE research_captures SET content_hash=? WHERE task_id=?').run(
        contentHash,
        fixtureId(index),
      );
      db.prepare('UPDATE research_evidence SET content_hash=? WHERE task_id=?').run(
        contentHash,
        fixtureId(index),
      );
      db.prepare(
        'UPDATE research_results SET evidence_map_json=replace(evidence_map_json,?,?) WHERE task_id=?',
      ).run(oldHash, contentHash, fixtureId(index));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function seedWatch(db: DatabaseSync, eventCount: number, digestCount: number): void {
  populateWatch(db);
  const wrapped = handle(db, '');
  db.exec('BEGIN');
  try {
    for (let index = 0; index < eventCount; index++) appendDenseEvent(wrapped, index);
    prepareDigestParents(wrapped, eventCount);
    for (let index = 0; index < digestCount; index++) appendDenseDigest(wrapped, index);
    db.exec(
      "UPDATE digest_schedules SET state='paused',cursor_sequence=(SELECT next_sequence FROM digest_runs WHERE id='qualification-run') WHERE id='qualification-schedule'",
    );
    for (const row of db.prepare('SELECT id,facts_json FROM watch_digests').iterate()) {
      const facts = JSON.parse(String(row.facts_json)) as DigestFacts;
      facts.runStats = { changed: eventCount, failed: 0, unchanged: 0 };
      const canonical = canonicalizeDigestFacts(facts);
      assertFact(canonical.ok, '合成Digest规范化失败');
      db.prepare('UPDATE watch_digests SET facts_json=?,facts_hash=?,byte_length=? WHERE id=?').run(
        canonical.json,
        canonical.hash,
        serializeDigestArtifact(canonical.json, null).byteLength,
        row.id!,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function prepareFixtures(root: string): object {
  mkdirSync(root);
  const evidence: object[] = [];
  for (const domain of ['sources', 'research', 'watch'] as const) {
    const directory = join(root, domain);
    mkdirSync(directory);
    const file = join(directory, `${domain}.db`);
    const db = new DatabaseSync(file, { allowExtension: false });
    try {
      apply(db, schemas[domain]);
      if (domain === 'sources') seedSources(db, FIXTURE.sources);
      else if (domain === 'research') seedResearch(db, FIXTURE.researchTasks);
      else seedWatch(db, FIXTURE.watchEvents, FIXTURE.watchDigests);
      assertFact(validateTransferSchema(db, domain).ok, '合成fixture schema未通过');
      const scan =
        domain === 'sources'
          ? validateSourceTransfer(db)
          : domain === 'research'
            ? validateResearchTransfer(db)
            : validateWatchTransferDatabase(db);
      assertFact(scan.ok, `合成${domain}语义失败：${JSON.stringify(scan)}`);
      if (domain === 'sources') assertFact(normalizeAndVerifySourceIndex(db).ok, '合成FTS失败');
      evidence.push({ domain, scan, bytes: statSync(file).size });
    } finally {
      db.close();
    }
  }
  const conversationDirectory = join(root, 'conversations');
  mkdirSync(conversationDirectory);
  const index = fiftyIndex();
  const text = JSON.stringify(exactSession());
  assertFact(Buffer.byteLength(text) === FIXTURE.denseSessionBytes, '64MiB夹具长度变化');
  writeFileSync(join(conversationDirectory, 'index.json'), JSON.stringify(index));
  for (const [offset, session] of index.sessions.entries())
    writeFileSync(
      join(conversationDirectory, `${session.id}.json`),
      offset === 0 ? text : '{"version":2,"messages":[]}',
    );
  const history = join(root, 'history');
  mkdirSync(history);
  let count = 0;
  for (const domain of ['sources', 'research', 'watch'] as const) {
    const variants =
      domain === 'watch' ? (['current', 'historical'] as const) : (['current'] as const);
    for (const variant of variants) {
      const steps = variant === 'historical' ? historicalWatchMigrationSteps() : schemas[domain];
      for (let prefix = variant === 'historical' ? 3 : 0; prefix <= steps.length; prefix++) {
        const db = new DatabaseSync(join(history, `${domain}-${variant}-${prefix}.db`), {
          allowExtension: false,
        });
        try {
          apply(db, steps.slice(0, prefix));
          assertFact(validateTransferSchema(db, domain).ok, '历史fixture schema未通过');
        } finally {
          db.close();
        }
        count++;
      }
    }
  }
  assertFact(count === FIXTURE.migrationCases, '历史前缀集合改变，需要重定测量');
  return {
    evidence,
    migrationCases: count,
    stamp: STAMP,
    denseSessionBytes: Buffer.byteLength(text),
    denseSessionSha256: createHash('sha256').update(text).digest('hex'),
  };
}
