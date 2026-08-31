import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../shared/watch/clock';
import type { ChangeEvidencePair, WatchRule } from '../../shared/types/watch';
import { FakeProvider } from '../ai/provider/fake-provider';
import { openDb, type DbHandle } from '../sources/db/sqlite-driver';
import { runWatchMigrations } from './db/watch-migrations';
import { DigestService } from './digest-service';
import { WatchRepository } from './repository/watch-repository';
import { openWatchStore } from './watch-store';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-digest-service-'));
const created = '2026-08-28T00:00:00.000Z';
const due = '2026-08-29T01:00:00.000Z';
const hex = 'a'.repeat(64);
let handle: DbHandle;
let repo: WatchRepository;

beforeEach(() => {
  handle = openDb(join(root, `${randomUUID()}.db`));
  runWatchMigrations(handle);
  repo = new WatchRepository(handle);
});
afterEach(() => repo.dispose());
afterAll(() => rmSync(root, { recursive: true, force: true }));

function rule(): WatchRule {
  return {
    id: 'rule-1',
    sourceId: 'source-1',
    kind: 'feed',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'public',
    schedule: { kind: 'interval', intervalMinutes: 60 },
    target: { type: 'feed', feedUrl: 'https://example.com/feed', format: 'rss2' },
    condition: null,
    notificationLevel: 'normal',
    sourceRowVersion: 1,
    sourceLocatorFingerprint: hex,
    nextDueAt: null,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: created,
    updatedAt: created,
  };
}

function item(label: string): ChangeEvidencePair {
  return {
    itemId: label,
    fieldKey: 'title',
    label,
    before: { kind: 'absent' },
    after: {
      kind: 'present',
      excerpt: label,
      valueHash: hex,
      normalizedBytes: label.length,
      truncated: false,
    },
    beforeCapturedAt: created,
    afterCapturedAt: created,
    beforeFinalUrl: 'https://example.com/a',
    afterFinalUrl: 'https://example.com/a',
    beforeDocumentId: null,
    afterDocumentId: null,
    feedItemKey: null,
  };
}

function prepare(count: number, aiEnabled = false): void {
  expect(
    repo.createDigestSchedule({
      id: 'schedule-1',
      sourceIds: ['source-1'],
      localTime: '09:00',
      timeZone: 'Asia/Shanghai',
      aiEnabled,
      nextDueAt: due,
      nowIso: created,
    }),
  ).toEqual({ ok: true });
  const watchRule = rule();
  expect(repo.insertRule(watchRule)).toEqual({ ok: true });
  for (let index = 0; index < count; index += 1) {
    const eventId = `event-${String(index).padStart(3, '0')}`;
    expect(
      repo.writeEventTransaction({
        event: {
          id: eventId,
          ruleId: watchRule.id,
          sourceId: watchRule.sourceId,
          eventKind: 'added',
          importance: 'normal',
          idempotencyKey: `idem-${eventId}`,
          changeFingerprint: hex,
          firstObservedAt: new Date(Date.parse(created) + index).toISOString(),
          lastObservedAt: new Date(Date.parse(created) + index).toISOString(),
          itemCount: 1,
          readAt: null,
        },
        items: [item(eventId)],
        identity: {
          sourceId: watchRule.sourceId,
          expectedSourceLocatorFingerprint: hex,
          expectedBaselineVersion: null,
        },
      }),
    ).toEqual({ ok: true });
  }
}

function service(provider: FakeProvider | null = null, repository = repo): DigestService {
  return new DigestService({
    repository,
    clock: new FakeClock(Date.parse(due)),
    sharing: {
      get: async () => [
        {
          sourceId: 'source-1',
          shareMode: 'full',
          displayName: '来源',
          canonicalUrl: 'https://example.com',
        },
      ],
    },
    provider: { resolve: async () => (provider === null ? null : { provider, model: 'fake' }) },
  });
}

describe('DigestService frozen cycle', () => {
  it('runStats 精确映射全部终态并使用 (fromExclusive, toInclusive] 期间', () => {
    prepare(1);
    const insert = handle.prepare(
      `INSERT INTO watch_runs(id,rule_id,request_key,status,trigger,scheduled_for,
      started_at,finished_at,outcome_json,health_json,response_metadata_json)
      VALUES(?,?,?,?,'manual',NULL,?,?,?,?,NULL)`,
    );
    const outcomes = [
      { kind: 'changed-unmatched', changeFingerprint: hex },
      { kind: 'event-created', eventId: 'event-created' },
      { kind: 'event-coalesced', eventId: 'event-coalesced' },
      { kind: 'unchanged' },
      { kind: 'baseline-established', auditId: 'audit-1' },
      { kind: 'event-deduplicated', eventId: 'event-deduplicated' },
      { kind: 'failed', health: 'unavailable', retryable: true },
      { kind: 'aborted', reason: 'shutdown' },
    ] as const;
    outcomes.forEach((outcome, index) => {
      const finishedAt = index === outcomes.length - 1 ? due : `2026-08-28T12:00:0${index}.000Z`;
      insert.run(
        `stats-${index}`,
        'rule-1',
        `stats-key-${index}`,
        'finished',
        created,
        finishedAt,
        JSON.stringify(outcome),
        null,
      );
    });
    insert.run(
      'stats-interrupted',
      'rule-1',
      'stats-key-interrupted',
      'interrupted',
      created,
      '2026-08-28T13:00:00.000Z',
      null,
      null,
    );
    insert.run(
      'stats-lower-excluded',
      'rule-1',
      'stats-key-lower-excluded',
      'finished',
      created,
      created,
      JSON.stringify({ kind: 'event-created', eventId: 'excluded-lower' }),
      null,
    );
    insert.run(
      'stats-after-upper-excluded',
      'rule-1',
      'stats-key-after-upper-excluded',
      'finished',
      created,
      '2026-08-29T01:00:00.001Z',
      JSON.stringify({ kind: 'failed', health: 'unavailable', retryable: true }),
      null,
    );
    for (const status of ['queued', 'running'] as const) {
      insert.run(
        `stats-${status}`,
        'rule-1',
        `stats-key-${status}`,
        status,
        status === 'running' ? created : null,
        null,
        null,
        null,
      );
    }

    const schedule = repo.getDigestSchedule('schedule-1')!;
    const reserved = repo.reserveDigestRun({
      scheduleId: schedule.id,
      expectedVersion: schedule.version,
      expectedNextDueAt: due,
      expectedLastConsumedScheduledFor: null,
      expectedLastDailyLocalDate: null,
      runId: 'run-stats',
      requestKey: 'run-stats-key',
      logicalDate: '2026-08-29',
      nextDueAt: '2026-08-30T01:00:00.000Z',
      nowIso: due,
    });

    expect(reserved).toMatchObject({
      ok: true,
      run: { runStats: { changed: 3, unchanged: 3, failed: 3 } },
    });
  });

  it.each([
    [49, [49]],
    [50, [50]],
    [51, [50, 1]],
    [100, [50, 50]],
    [101, [50, 50, 1]],
    [120, [50, 50, 20]],
  ])('%i Event greedy 分批且 cursor 完整推进', async (count, expected) => {
    prepare(count);
    expect(
      await service().handleDue({
        scheduleId: 'schedule-1',
        expectedNextDueAt: due,
        logicalDate: '2026-08-29',
      }),
    ).toMatchObject({ ok: true });
    const rows = handle
      .prepare('SELECT batch_index, facts_json FROM watch_digests ORDER BY batch_index')
      .all() as Array<{ batch_index: number; facts_json: string }>;
    expect(rows.map((row) => JSON.parse(row.facts_json).eventCount)).toEqual(expected);
    expect(rows.map((row) => row.batch_index)).toEqual(expected.map((_, index) => index));
    expect(repo.getDigestSchedule('schedule-1')!.cursorSequence).toBe(count);
    expect(repo.getNonterminalDigestRun('schedule-1')).toBeNull();
  });

  it('claim-before-call 后只调用一次，canonical 输出成功写回且 request 无 tools', async () => {
    prepare(1, true);
    const raw = '{"sections":[{"eventIds":["event-000"],"explanation":"确定性变化"}]}';
    const fake = new FakeProvider({ chunks: [raw] });
    expect(
      await service(fake).handleDue({
        scheduleId: 'schedule-1',
        expectedNextDueAt: due,
        logicalDate: '2026-08-29',
      }),
    ).toMatchObject({ ok: true });
    expect(fake.getRequests()).toHaveLength(1);
    expect(fake.getLastRequest()).not.toHaveProperty('tools');
    const row = handle
      .prepare('SELECT provider_state,provider_result_code,explanation_json FROM watch_digests')
      .get();
    expect(row).toEqual({
      provider_state: 'succeeded',
      provider_result_code: 'success',
      explanation_json: raw,
    });
    expect(repo.deleteEventWithScrub('event-000', '2026-08-29T01:01:00.000Z')).toEqual({
      ok: true,
    });
    const scrubbed = handle
      .prepare(
        'SELECT facts_json,facts_revision,explanation_json,provider_state FROM watch_digests',
      )
      .get() as Record<string, unknown>;
    const facts = JSON.parse(String(scrubbed.facts_json));
    expect(facts.evidenceMap).not.toHaveProperty('event-000');
    expect(facts.referenceStates['event-000']).toBe('user-deleted');
    expect(scrubbed).toMatchObject({
      facts_revision: 2,
      explanation_json: null,
      provider_state: 'succeeded',
    });
    expect(handle.prepare('SELECT status FROM digest_event_refs').get()).toEqual({
      status: 'user-deleted',
    });
  });

  it.each([
    ['timeout', new FakeProvider({ error: { code: 'timeout' } }), 'failed', 'timeout'],
    [
      'hostile whitespace',
      new FakeProvider({ chunks: [' {"sections":[]}'] }),
      'failed',
      'invalid-output',
    ],
    [
      'reasoning',
      new FakeProvider({ chunks: [{ kind: 'reasoning', text: 'secret' }] }),
      'failed',
      'invalid-output',
    ],
  ])('Provider %s claim 后唯一终态映射', async (_label, fake, state, code) => {
    prepare(1, true);
    await service(fake).handleDue({
      scheduleId: 'schedule-1',
      expectedNextDueAt: due,
      logicalDate: '2026-08-29',
    });
    expect(fake.getRequests()).toHaveLength(1);
    expect(
      handle
        .prepare('SELECT provider_state,provider_result_code,explanation_json FROM watch_digests')
        .get(),
    ).toEqual({
      provider_state: state,
      provider_result_code: code,
      explanation_json: null,
    });
  });

  it('missing Key skipped 且零 Provider 调用', async () => {
    prepare(1, true);
    await service().handleDue({
      scheduleId: 'schedule-1',
      expectedNextDueAt: due,
      logicalDate: '2026-08-29',
    });
    expect(
      handle.prepare('SELECT provider_state,provider_result_code FROM watch_digests').get(),
    ).toEqual({
      provider_state: 'skipped',
      provider_result_code: 'key-unavailable',
    });
  });

  it('blocked-only 零名称/URL/Event 请求并 skipped no-visible-events', async () => {
    prepare(1, true);
    const fake = new FakeProvider({ chunks: ['SHOULD_NOT_RUN'] });
    const digest = new DigestService({
      repository: repo,
      clock: new FakeClock(Date.parse(due)),
      sharing: {
        get: async () => [
          {
            sourceId: 'source-1',
            shareMode: 'blocked',
            displayName: 'BLOCKED_NAME',
            canonicalUrl: 'https://blocked.invalid',
          },
        ],
      },
      provider: { resolve: async () => ({ provider: fake, model: 'fake' }) },
    });
    await digest.handleDue({
      scheduleId: 'schedule-1',
      expectedNextDueAt: due,
      logicalDate: '2026-08-29',
    });
    expect(fake.getRequests()).toHaveLength(0);
    expect(
      handle.prepare('SELECT provider_state,provider_result_code FROM watch_digests').get(),
    ).toEqual({
      provider_state: 'skipped',
      provider_result_code: 'no-visible-events',
    });
  });

  it('完整 canonical ProviderRequest 超预算时 skipped request-budget 且零调用', async () => {
    prepare(50, true);
    const fake = new FakeProvider({ chunks: ['SHOULD_NOT_RUN'] });
    const digest = new DigestService({
      repository: repo,
      clock: new FakeClock(Date.parse(due)),
      sharing: {
        get: async () => [
          {
            sourceId: 'source-1',
            shareMode: 'metadata',
            displayName: '名'.repeat(200),
            canonicalUrl: `https://example.com/${'x'.repeat(3_000)}`,
          },
        ],
      },
      provider: { resolve: async () => ({ provider: fake, model: 'fake' }) },
    });
    await digest.handleDue({
      scheduleId: 'schedule-1',
      expectedNextDueAt: due,
      logicalDate: '2026-08-29',
    });
    expect(fake.getRequests()).toHaveLength(0);
    expect(
      handle.prepare('SELECT provider_state,provider_result_code FROM watch_digests').get(),
    ).toEqual({
      provider_state: 'skipped',
      provider_result_code: 'request-budget',
    });
  });

  it('claimed artifact scrub 原子终结 aborted，迟到写回 CAS 被拒绝', async () => {
    prepare(1);
    expect(
      await service().handleDue({
        scheduleId: 'schedule-1',
        expectedNextDueAt: due,
        logicalDate: '2026-08-29',
      }),
    ).toMatchObject({ ok: true });
    const id = (handle.prepare('SELECT id FROM watch_digests').get() as { id: string }).id;
    handle
      .prepare(
        `UPDATE watch_digests SET provider_state='pending',provider_result_code=NULL,
      provider_finished_at=NULL WHERE id=?`,
      )
      .run(id);
    const claimed = repo.claimDigestProvider(id, '2026-08-29T01:00:30.000Z')!;
    expect(repo.deleteEventWithScrub('event-000', '2026-08-29T01:01:00.000Z')).toEqual({
      ok: true,
    });
    expect(
      handle
        .prepare('SELECT provider_state,provider_result_code,facts_revision FROM watch_digests')
        .get(),
    ).toEqual({
      provider_state: 'failed',
      provider_result_code: 'aborted',
      facts_revision: 2,
    });
    expect(
      repo.finishClaimedDigest({
        id,
        factsRevision: claimed.factsRevision,
        factsHash: claimed.factsHash,
        state: 'succeeded',
        code: 'success',
        explanationJson: '{"sections":[{"eventIds":["event-000"],"explanation":"迟到"}]}',
        nowIso: '2026-08-29T01:02:00.000Z',
      }),
    ).toEqual({ ok: false, code: 'run-state-conflict' });
  });

  it('claimed 跨启动恢复为 uncertain 且不回 pending', async () => {
    prepare(1);
    await service().handleDue({
      scheduleId: 'schedule-1',
      expectedNextDueAt: due,
      logicalDate: '2026-08-29',
    });
    const id = (handle.prepare('SELECT id FROM watch_digests').get() as { id: string }).id;
    handle
      .prepare(
        `UPDATE watch_digests SET provider_state='pending',provider_result_code=NULL,
      provider_finished_at=NULL WHERE id=?`,
      )
      .run(id);
    expect(repo.claimDigestProvider(id, '2026-08-29T01:00:30.000Z')).not.toBeNull();
    const dbPath = handle.path;
    repo.dispose();
    const reopened = openWatchStore({
      dbPath,
      backupsDir: join(root, 'restart-backups'),
      nowMs: () => Date.parse('2026-08-29T01:01:00.000Z'),
    });
    expect(reopened.mode).toBe('normal');
    if (reopened.mode !== 'normal') return;
    repo = reopened.repo;
    handle = repo.dbHandle;
    expect(
      handle.prepare('SELECT provider_state,provider_result_code FROM watch_digests').get(),
    ).toEqual({
      provider_state: 'uncertain',
      provider_result_code: 'uncertain-after-restart',
    });
  });

  it('budget_exceeded 持久化且显式容量复验后从原 frozen cycle 恢复', async () => {
    prepare(1);
    const tight = new WatchRepository(handle, { maxDbBytes: repo.estimateLogicalBytes() + 1 });
    expect(
      await service(null, tight).handleDue({
        scheduleId: 'schedule-1',
        expectedNextDueAt: due,
        logicalDate: '2026-08-29',
      }),
    ).toMatchObject({ ok: false });
    const blocked = repo.getNonterminalDigestRun('schedule-1')!;
    expect(blocked.state).toBe('budget_exceeded');
    const roomy = new WatchRepository(handle);
    expect(roomy.retryDigestRunBudget(blocked.id)).toEqual({ ok: true });
    await service(null, roomy).resumeActiveCycles();
    expect(repo.getNonterminalDigestRun('schedule-1')).toBeNull();
    expect(handle.prepare('SELECT COUNT(*) AS n FROM watch_digests').get()).toEqual({ n: 1 });
  });

  it('pause 保留非终态 cycle、resume 后恢复；delete 只级联 Digest 不删 Event/journal', async () => {
    prepare(1);
    const schedule = repo.getDigestSchedule('schedule-1')!;
    const reserved = repo.reserveDigestRun({
      scheduleId: schedule.id,
      expectedVersion: schedule.version,
      expectedNextDueAt: due,
      expectedLastConsumedScheduledFor: null,
      expectedLastDailyLocalDate: null,
      runId: 'run-pause',
      requestKey: 'pause-key',
      logicalDate: '2026-08-29',
      nextDueAt: '2026-08-30T01:00:00.000Z',
      nowIso: due,
    });
    expect(reserved.ok).toBe(true);
    const afterReserve = repo.getDigestSchedule(schedule.id)!;
    expect(
      repo.pauseDigestSchedule(schedule.id, afterReserve.version, '2026-08-29T01:00:01.000Z'),
    ).toEqual({ ok: true });
    const idempotentlyPaused = repo.getDigestSchedule(schedule.id)!;
    expect(
      repo.pauseDigestSchedule(schedule.id, idempotentlyPaused.version, '2026-08-29T01:00:01.500Z'),
    ).toEqual({ ok: true });
    expect(repo.getDigestSchedule(schedule.id)?.version).toBe(idempotentlyPaused.version);
    await service().resumeActiveCycles();
    expect(repo.getNonterminalDigestRun(schedule.id)?.id).toBe('run-pause');
    const paused = repo.getDigestSchedule(schedule.id)!;
    expect(
      repo.resumeDigestSchedule(schedule.id, paused.version, '2026-08-29T01:00:02.000Z'),
    ).toEqual({ ok: true });
    await service().resumeActiveCycles();
    const active = repo.getDigestSchedule(schedule.id)!;
    expect(repo.deleteDigestSchedule(schedule.id, active.version)).toEqual({ ok: true });
    expect(handle.prepare('SELECT COUNT(*) AS n FROM watch_events').get()).toEqual({ n: 1 });
    expect(handle.prepare('SELECT COUNT(*) AS n FROM digest_change_journal').get()).toEqual({
      n: 1,
    });
    expect(handle.prepare('SELECT COUNT(*) AS n FROM watch_digests').get()).toEqual({ n: 0 });
  });

  it('reset 使用 journal high-water，关闭 AI 会把 pending artifact 终结为 disabled', () => {
    prepare(1, true);
    const schedule = repo.getDigestSchedule('schedule-1')!;
    expect(
      repo.resetDigestSchedule({
        id: schedule.id,
        expectedVersion: schedule.version,
        sourceIds: ['source-1'],
        localTime: '09:00',
        timeZone: 'Asia/Shanghai',
        nextDueAt: '2026-08-30T01:00:00.000Z',
        nowIso: '2026-08-29T01:00:01.000Z',
      }),
    ).toEqual({ ok: true });
    const reset = repo.getDigestSchedule(schedule.id)!;
    expect(reset.cursorSequence).toBe(1);

    const facts = JSON.stringify({
      schemaVersion: 1,
      artifactId: 'artifact-ai-toggle',
      scheduleId: schedule.id,
      runId: 'run-ai-toggle',
      period: { fromExclusive: created, toInclusive: due },
      runStats: { changed: 1, unchanged: 0, failed: 0 },
      eventCount: 1,
      items: [
        {
          eventId: 'event-000',
          sourceId: 'source-1',
          eventKind: 'created',
          importance: 'normal',
          firstObservedAt: created,
          lastObservedAt: created,
          observationCount: 1,
          evidence: [item('event-000')],
        },
      ],
    });
    handle
      .prepare(
        `INSERT INTO digest_runs(id,schedule_id,request_key,logical_date,lower_sequence,
        upper_sequence,next_sequence,period_json,run_stats_json,state,blocked_at,
        blocked_required_bytes,blocked_available_bytes,created_at,finished_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'run-ai-toggle',
        schedule.id,
        'request-ai-toggle',
        '2026-08-29',
        0,
        1,
        1,
        JSON.stringify({ fromExclusive: created, toInclusive: due }),
        JSON.stringify({ changed: 1, unchanged: 0, failed: 0 }),
        'completed',
        null,
        null,
        null,
        due,
        due,
      );
    handle
      .prepare(
        `INSERT INTO watch_digests(id,schedule_id,run_id,batch_index,first_sequence,last_sequence,
        facts_json,facts_hash,facts_revision,explanation_json,byte_length,provider_state,
        provider_result_code,claimed_facts_revision,claimed_facts_hash,claimed_at,
        provider_finished_at,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'artifact-ai-toggle',
        schedule.id,
        'run-ai-toggle',
        0,
        1,
        1,
        facts,
        createHash('sha256').update(facts).digest('hex'),
        1,
        null,
        Buffer.byteLength(facts, 'utf8'),
        'pending',
        null,
        null,
        null,
        null,
        null,
        due,
      );
    expect(
      repo.setDigestScheduleAiEnabled(
        schedule.id,
        reset.version,
        false,
        '2026-08-29T01:00:02.000Z',
      ),
    ).toEqual({ ok: true });
    expect(
      handle.prepare('SELECT provider_state,provider_result_code FROM watch_digests').get(),
    ).toEqual({ provider_state: 'disabled', provider_result_code: 'disabled' });
  });

  it('preview 单 batch/hasMore/nextPreviewSequence 且零正式状态副作用', () => {
    prepare(51);
    const digest = service();
    const first = digest.preview({
      previewId: 'p1',
      sourceIds: ['source-1'],
      fromExclusive: '2026-08-27T00:00:00.000Z',
      toInclusive: due,
    });
    expect(first?.facts?.eventCount).toBe(50);
    expect(first).toMatchObject({ hasMore: true, nextPreviewSequence: 50 });
    const second = digest.preview({
      previewId: 'p1',
      sourceIds: ['source-1'],
      afterSequence: 50,
      fromExclusive: '2026-08-27T00:00:00.000Z',
      toInclusive: due,
    });
    expect(second?.facts?.eventCount).toBe(1);
    expect(second).toMatchObject({ hasMore: false, nextPreviewSequence: 51 });
    expect(handle.prepare('SELECT COUNT(*) AS n FROM digest_runs').get()).toEqual({ n: 0 });
    expect(handle.prepare('SELECT COUNT(*) AS n FROM watch_digests').get()).toEqual({ n: 0 });
    expect(repo.getDigestSchedule('schedule-1')?.cursorSequence).toBe(0);
  });
});
