// Offline synthetic qualification only. These are samples, not historical maxima.
import { createHash } from 'node:crypto';
import type { DbHandle } from '../../src/main/sources/db/sqlite-driver';
import type { ChangeEvidencePair } from '../../src/shared/types/watch';
import { buildDigestFacts, canonicalizeDigestFacts } from '../../src/shared/watch/digest-facts';
import { serializeDigestArtifact } from '../../src/shared/watch/digest-validator';
import { fixtureId, researchRows, STAMP } from './fixtures';
import {
  ResearchRepository,
  rowToCandidate,
  rowToEvidence,
} from '../../src/main/research/repository/research-repository';
import { validate } from '../../src/main/research/result-validator';

export function denseResearchRows(index: number) {
  const rows = researchRows(index);
  rows.result.blocks_json = JSON.stringify([
    {
      kind: 'table',
      columns: Array.from({ length: 20 }, (_, i) => `字段${i}`),
      rows: Array.from({ length: 200 }, () => Array.from({ length: 20 }, () => '界'.repeat(39))),
      sourceRefs: [fixtureId(1000 + index)],
    },
    { kind: 'uncertain', text: '合成容量测量', reason: '无外部证据' },
  ]);
  return rows;
}

export function insertDenseResearch(db: DbHandle, index: number): number {
  const rows = denseResearchRows(index);
  const candidate = {
    candidate_id: fixtureId(1000 + index),
    task_id: rows.task.id,
    url: 'https://example.invalid/',
    display_url: 'https://example.invalid/',
    title: '合成来源',
    canonical_key: 'https://example.invalid/',
    scope: 'page' as const,
    discovered_via_json: '["sources"]',
    source_id: null,
    trust_value: null,
    trust_asserted_by: null,
    trust_verification: null,
    priority: null,
    last_used_at: null,
    note: null,
    sort_key: '1',
  };
  const capture = {
    capture_id: fixtureId(2000 + index),
    task_id: rows.task.id,
    candidate_id: candidate.candidate_id,
    tab_id: fixtureId(3000 + index),
    url: candidate.url,
    title: candidate.title,
    access_time: STAMP,
    document_id: '1',
    content_hash: hash('合成证据'),
    summary_json: '{"sectionCount":1,"tableCount":0,"headingCount":1,"charCount":4}',
    failed: 0,
    failure_reason: null,
  };
  const evidence = {
    evidence_id: fixtureId(4000 + index),
    task_id: rows.task.id,
    candidate_id: candidate.candidate_id,
    source_id: null,
    capture_id: capture.capture_id,
    url: candidate.url,
    title: candidate.title,
    access_time: STAMP,
    document_id: '1',
    content_hash: capture.content_hash,
    type: 'quote' as const,
    locator_json: '{"kind":"text","excerpt":"合成证据"}',
    excerpt: '合成证据',
    value: null,
    verification: 'verified' as const,
  };
  const checked = validate(
    {
      title: rows.result.title,
      summary: rows.result.summary,
      blocks: JSON.parse(rows.result.blocks_json) as unknown,
    },
    {
      taskId: rows.task.id,
      candidates: [rowToCandidate(candidate)!],
      evidence: [rowToEvidence(evidence)!],
      claims: [],
      conflicts: [],
      verificationState: 'verified',
      now: STAMP,
      createId: () => rows.result.result_id,
    },
  );
  if (!checked.ok) throw new Error(`合成Research结果未通过校验：${checked.reasons.join('；')}`);
  rows.result.evidence_map_json = JSON.stringify(checked.result.evidenceMap);
  rows.task.stats_json = JSON.stringify({
    candidateCount: 1,
    selectedCount: 1,
    captureCount: 1,
    failedReadCount: 0,
    evidenceCount: 1,
    rejectedEvidenceCount: 0,
    claimCount: 0,
    conflictCount: 0,
    stepsUsed: 1,
    roundsUsed: 1,
  });
  const repo = new ResearchRepository(db);
  repo.insertTask(rows.task);
  repo.insertCandidate(candidate);
  repo.insertCapture(capture);
  repo.insertEvidence(evidence);
  repo.insertResult(rows.result);
  return repo.computeTaskPersistedBytes(rows.task.id);
}

export function denseEvidence(index: number, bytes = 4096): ChangeEvidencePair {
  const before = 'a'.repeat(bytes);
  const after = 'b'.repeat(bytes);
  return {
    itemId: `item-${index}`,
    fieldKey: 'title',
    label: '标题',
    before: {
      kind: 'present',
      excerpt: before,
      valueHash: hash(before),
      normalizedBytes: bytes,
      truncated: false,
    },
    after: {
      kind: 'present',
      excerpt: after,
      valueHash: hash(after),
      normalizedBytes: bytes,
      truncated: false,
    },
    beforeCapturedAt: STAMP,
    afterCapturedAt: STAMP,
    beforeFinalUrl: 'https://example.invalid/',
    afterFinalUrl: 'https://example.invalid/',
    beforeDocumentId: null,
    afterDocumentId: null,
    feedItemKey: `item-${index}`,
  };
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function appendDenseEvent(db: DbHandle, index: number, bytes = 4096): void {
  const eventId = fixtureId(1000 + index);
  const ruleId = fixtureId(index % 200);
  const observationId = fixtureId(100000 + index);
  const items = Array.from({ length: 3 }, (_, i) => denseEvidence(i, bytes));
  db.prepare(
    `INSERT INTO watch_events
    (id,rule_id,source_id,event_kind,importance,idempotency_key,change_fingerprint,
    first_observed_at,last_observed_at,item_count,read_at)
    VALUES (?,?,?,'changed','normal',?,?,?, ?,3,NULL)`,
  ).run(eventId, ruleId, ruleId, eventId, hash(eventId), STAMP, STAMP);
  db.prepare(
    `INSERT INTO watch_event_observations
    (id,event_id,sequence,idempotency_key,change_fingerprint,event_kind,observed_at,first_item_sequence,item_count)
    VALUES (?,?,0,?,?,'changed',?,0,3)`,
  ).run(observationId, eventId, eventId, hash(eventId), STAMP);
  const itemStatement = db.prepare(`INSERT INTO watch_event_items
    (id,event_id,sequence,observation_id,observation_item_sequence,item_id,field_key,label,
    before_value_json,after_value_json,before_captured_at,after_captured_at,before_final_url,
    after_final_url,before_document_id,after_document_id,feed_item_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  items.forEach((item, i) =>
    itemStatement.run(
      fixtureId(200000 + index * 3 + i),
      eventId,
      i,
      observationId,
      i,
      item.itemId,
      item.fieldKey,
      item.label,
      JSON.stringify(item.before),
      JSON.stringify(item.after),
      item.beforeCapturedAt,
      item.afterCapturedAt,
      item.beforeFinalUrl,
      item.afterFinalUrl,
      item.beforeDocumentId,
      item.afterDocumentId,
      item.feedItemKey,
    ),
  );
  db.prepare(
    `INSERT INTO digest_change_journal
    (sequence,observation_id,event_id,source_id,observed_at,status) VALUES (?,?,?,?,?,'active')`,
  ).run(index + 1, observationId, eventId, ruleId, STAMP);
  db.prepare('UPDATE digest_change_state SET last_sequence = ? WHERE id = 1').run(index + 1);
}

export function prepareDigestParents(db: DbHandle, eventCount: number): void {
  const period = JSON.stringify({ fromExclusive: '2026-10-03T00:00:00.000Z', toInclusive: STAMP });
  const stats = JSON.stringify({ changed: eventCount, failed: 0, unchanged: 0 });
  db.prepare(
    `INSERT INTO digest_schedules
    (id,version,source_ids_json,schedule_json,ai_enabled,cursor_sequence,state,next_due_at,created_at,updated_at)
    VALUES ('qualification-schedule',1,?,?,0,?,'active',?,?,?)`,
  ).run(
    JSON.stringify(Array.from({ length: 100 }, (_, i) => fixtureId(i))),
    JSON.stringify({ kind: 'daily', localTime: '09:00', timeZone: 'Asia/Shanghai' }),
    0,
    STAMP,
    STAMP,
    STAMP,
  );
  db.prepare(
    `INSERT INTO digest_runs
    (id,schedule_id,request_key,logical_date,lower_sequence,upper_sequence,next_sequence,
    period_json,run_stats_json,state,created_at,finished_at)
    VALUES ('qualification-run','qualification-schedule','qualification-request','2026-10-04',0,?,0,?,?,'running',?,NULL)`,
  ).run(eventCount, period, stats, STAMP);
}

export function appendDenseDigest(db: DbHandle, index: number, bytes = 4096): void {
  // Only the first 100 of 200 sources belong to this schedule.
  const eventIndex = Math.floor(index / 100) * 200 + (index % 100);
  const eventId = fixtureId(1000 + eventIndex);
  const facts = buildDigestFacts({
    scheduleId: 'qualification-schedule',
    digestRunId: 'qualification-run',
    batchIndex: index,
    period: { fromExclusive: '2026-10-03T00:00:00.000Z', toInclusive: STAMP },
    runStats: { changed: 1, failed: 0, unchanged: 0 },
    fetchedAt: STAMP,
    observations: [
      {
        sequence: eventIndex + 1,
        eventId,
        ruleId: fixtureId(eventIndex % 200),
        sourceId: fixtureId(eventIndex % 200),
        eventKind: 'changed',
        importance: 'normal',
        observedAt: STAMP,
        items: Array.from({ length: 3 }, (_, i) => denseEvidence(i, bytes)),
      },
    ],
  });
  if (facts === null) throw new Error('合成Digest事实未通过真实校验');
  const canonical = canonicalizeDigestFacts(facts);
  if (!canonical.ok) throw new Error('合成Digest规范化失败');
  const digestId = fixtureId(500000 + index);
  db.prepare(
    `INSERT INTO watch_digests
    (id,schedule_id,run_id,batch_index,first_sequence,last_sequence,facts_json,facts_hash,
    facts_revision,byte_length,provider_state,provider_result_code,provider_finished_at,created_at)
    VALUES (?,'qualification-schedule','qualification-run',?,?,?,?,?,1,?,'disabled','disabled',?,?)`,
  ).run(
    digestId,
    index,
    index > 0 && index % 100 === 0 ? eventIndex - 99 : eventIndex + 1,
    eventIndex + 1,
    canonical.json,
    canonical.hash,
    serializeDigestArtifact(canonical.json, null).byteLength,
    STAMP,
    STAMP,
  );
  db.prepare("INSERT INTO digest_event_refs VALUES (?,?,'active')").run(digestId, eventId);
  db.prepare("UPDATE digest_runs SET next_sequence = ? WHERE id = 'qualification-run'").run(
    eventIndex + 1,
  );
}

export function projectedConversationFixture(content: string, callCount: number) {
  // Known persisted fields only. Counts/text sizes are qualification inputs, not claimed limits.
  return {
    version: 2,
    messages: Array.from({ length: 200 }, (_, index) => ({
      id: fixtureId(index),
      role: 'assistant' as const,
      content,
      createdAt: 0,
      status: 'complete' as const,
      toolCalls: Array.from({ length: callCount }, (_, i) => ({
        id: `call-${i}`,
        name: 'browser_read',
        arguments: '{}',
      })),
      agentRun: {
        requestId: fixtureId(300),
        sessionId: fixtureId(301),
        status: 'done' as const,
        stepsUsed: 12,
        maxSteps: 12,
        finalText: content,
        toolStepCount: 12,
      },
    })),
  };
}

export function proposedFixedProtocolEnvelope() {
  // Candidate protocol: four fixed logical members; Conversation is one stream member.
  const members = ['sources', 'research', 'watch', 'conversations'].map((id) => ({
    id,
    present: true,
    schemaVersion: 999999,
    length: Number.MAX_SAFE_INTEGER,
    sha256: 'f'.repeat(64),
  }));
  return {
    manifest: {
      formatVersion: 1,
      productVersion: '9'.repeat(64),
      snapshotId: fixtureId(0),
      members,
    },
    result: {
      operationId: fixtureId(0),
      phase: 'validated',
      members: members.map((member) => ({
        id: member.id,
        length: member.length,
        sha256: member.sha256,
        rows: Number.MAX_SAFE_INTEGER,
      })),
      errorCode: null,
    },
  };
}
