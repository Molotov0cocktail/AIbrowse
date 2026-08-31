import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../shared/watch/clock';
import { buildDigestFacts } from '../../shared/watch/digest-facts';
import { serializeDigestArtifact } from '../../shared/watch/digest-validator';
import type { ChangeEvidencePair, WatchRule } from '../../shared/types/watch';
import { FakeProvider } from '../ai/provider/fake-provider';
import { openDb, type DbHandle } from '../sources/db/sqlite-driver';
import { runWatchMigrations } from './db/watch-migrations';
import { DigestService, type DigestScheduleControlPort } from './digest-service';
import { DigestScheduler } from './digest-scheduler';
import { WatchRepository } from './repository/watch-repository';
import { openWatchStore } from './watch-store';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-digest-service-'));
const created = '2026-08-28T00:00:00.000Z';
const due = '2026-08-29T01:00:00.000Z';
const hex = 'a'.repeat(64);
let handle: DbHandle;
let repo: WatchRepository;

const noopScheduleControl: DigestScheduleControlPort = {
  upsert: () => undefined,
  remove: () => undefined,
};

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

function prepare(count: number, aiEnabled = false, targetRepo = repo): void {
  expect(
    targetRepo.createDigestSchedule({
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
  expect(targetRepo.insertRule(watchRule)).toEqual({ ok: true });
  for (let index = 0; index < count; index += 1) {
    const eventId = `event-${String(index).padStart(3, '0')}`;
    expect(
      targetRepo.writeEventTransaction({
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

function seedClockRollbackCycle(): {
  run: NonNullable<ReturnType<WatchRepository['getDigestRun']>>;
  facts: NonNullable<ReturnType<typeof buildDigestFacts>>;
  oldEventId: string;
  realNow: string;
  futureAudit: string;
} {
  const realNow = '2026-08-29T01:00:00.000Z';
  const futureAudit = '2026-09-01T01:00:00.000Z';
  const oldEventId = 'rollback-safe-event';
  const watchRule = rule();
  expect(repo.insertRule(watchRule)).toEqual({ ok: true });
  const write = (eventId: string, observedAt: string) =>
    repo.writeEventTransaction({
      event: {
        id: eventId,
        ruleId: watchRule.id,
        sourceId: watchRule.sourceId,
        eventKind: 'added' as const,
        importance: 'normal' as const,
        idempotencyKey: `idem-${eventId}`,
        changeFingerprint: hex,
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        itemCount: 1,
        readAt: null,
      },
      items: [item(eventId)],
      identity: {
        sourceId: watchRule.sourceId,
        expectedSourceLocatorFingerprint: hex,
        expectedBaselineVersion: null,
      },
    });
  expect(write(oldEventId, '2026-06-01T01:00:00.000Z')).toEqual({ ok: true });
  expect(
    repo.createDigestSchedule({
      id: 'rollback-schedule',
      sourceIds: ['source-1'],
      localTime: '09:00',
      timeZone: 'Asia/Shanghai',
      nextDueAt: due,
      nowIso: created,
    }),
  ).toEqual({ ok: true });
  expect(write('rollback-current-event', created)).toEqual({ ok: true });
  const schedule = repo.getDigestSchedule('rollback-schedule')!;
  const reserved = repo.reserveDigestRun({
    scheduleId: schedule.id,
    expectedVersion: schedule.version,
    expectedNextDueAt: schedule.nextDueAt,
    expectedLastConsumedScheduledFor: null,
    expectedLastDailyLocalDate: null,
    runId: 'rollback-run',
    requestKey: 'rollback-key',
    logicalDate: '2026-08-29',
    nextDueAt: '2026-08-30T01:00:00.000Z',
    nowIso: futureAudit,
  });
  expect(reserved.ok).toBe(true);
  if (!reserved.ok) throw new Error('reservation failed');
  const observation = repo
    .readDigestJournalSlice(reserved.run.id)!
    .find((entry) => entry.observation !== null)?.observation;
  if (observation === null || observation === undefined) throw new Error('observation missing');
  const facts = buildDigestFacts({
    scheduleId: schedule.id,
    digestRunId: reserved.run.id,
    batchIndex: 0,
    period: reserved.run.period,
    runStats: reserved.run.runStats,
    observations: [observation],
    fetchedAt: reserved.run.period.toInclusive,
  });
  if (facts === null) throw new Error('facts missing');
  return { run: reserved.run, facts, oldEventId, realNow, futureAudit };
}

function service(
  provider: FakeProvider | null = null,
  repository = repo,
  scheduleControl?: DigestScheduleControlPort,
): DigestService {
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
    scheduleControl: scheduleControl ?? noopScheduleControl,
  });
}

function deferredSignal(): {
  entered: Promise<void>;
  release: () => void;
  wait: Promise<void>;
  markEntered: () => void;
} {
  let markEntered!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      markEntered = resolve;
    }),
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    markEntered: () => markEntered(),
    release: () => release(),
  };
}

class RecordingScheduleControl implements DigestScheduleControlPort {
  readonly entries = new Map<
    string,
    { scheduleId: string; expectedNextDueAt: string; timeZone: string }
  >();
  upserts = 0;
  removes = 0;

  upsert(entry: { scheduleId: string; expectedNextDueAt: string; timeZone: string }): void {
    this.upserts += 1;
    this.entries.set(entry.scheduleId, { ...entry });
  }

  remove(scheduleId: string): void {
    this.removes += 1;
    this.entries.delete(scheduleId);
  }
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
      scheduleControl: noopScheduleControl,
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
      scheduleControl: noopScheduleControl,
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

  it.each(['sharing', 'provider'] as const)(
    'shutdown 等待 deferred %s 准备，释放后零 claim/零 stream',
    async (gap) => {
      prepare(1, true);
      const fake = new FakeProvider({ chunks: ['SHOULD_NOT_RUN'] });
      let release!: () => void;
      const deferred = new Promise<void>((resolve) => {
        release = resolve;
      });
      const digest = new DigestService({
        repository: repo,
        clock: new FakeClock(Date.parse(due)),
        sharing: {
          get: async () => {
            if (gap === 'sharing') await deferred;
            return [
              {
                sourceId: 'source-1',
                shareMode: 'full',
                displayName: '来源',
                canonicalUrl: 'https://example.com',
              },
            ];
          },
        },
        provider: {
          resolve: async () => {
            if (gap === 'provider') await deferred;
            return { provider: fake, model: 'fake' };
          },
        },
        scheduleControl: noopScheduleControl,
      });
      const handling = digest.handleDue({
        scheduleId: 'schedule-1',
        expectedNextDueAt: due,
        logicalDate: '2026-08-29',
      });
      await Promise.resolve();
      await Promise.resolve();
      digest.stopAdmission();
      digest.abort();
      let drained = false;
      const draining = digest.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      release();
      await Promise.all([handling, draining]);
      expect(fake.getRequests()).toHaveLength(0);
      expect(
        handle
          .prepare("SELECT COUNT(*) AS n FROM watch_digests WHERE provider_state='claimed'")
          .get(),
      ).toEqual({ n: 0 });
    },
  );

  it.each(['sharing', 'provider'] as const)(
    'deferred %s 准备期间 pause：零 claim/stream，resume 后恰好一次',
    async (gap) => {
      prepare(1, true);
      const gate = deferredSignal();
      const raw = '{"sections":[{"eventIds":["event-000"],"explanation":"恢复"}]}';
      const fake = new FakeProvider({ chunks: [raw] });
      const digest = new DigestService({
        repository: repo,
        clock: new FakeClock(Date.parse(due)),
        sharing: {
          get: async () => {
            if (gap === 'sharing') {
              gate.markEntered();
              await gate.wait;
            }
            return [
              {
                sourceId: 'source-1',
                shareMode: 'full',
                displayName: '来源',
                canonicalUrl: 'https://example.com',
              },
            ];
          },
        },
        provider: {
          resolve: async () => {
            if (gap === 'provider') {
              gate.markEntered();
              await gate.wait;
            }
            return { provider: fake, model: 'fake' };
          },
        },
        scheduleControl: noopScheduleControl,
      });
      const handling = digest.handleDue({
        scheduleId: 'schedule-1',
        expectedNextDueAt: due,
        logicalDate: '2026-08-29',
      });
      await gate.entered;
      const active = repo.getDigestSchedule('schedule-1')!;
      expect(digest.pause(active.id, active.version)).toEqual({ ok: true });
      gate.release();
      await handling;
      expect(fake.getRequests()).toHaveLength(0);
      expect(handle.prepare('SELECT provider_state FROM watch_digests').get()).toEqual({
        provider_state: 'pending',
      });
      const paused = repo.getDigestSchedule('schedule-1')!;
      expect(await digest.resume(paused.id, paused.version)).toEqual({ ok: true });
      expect(fake.getRequests()).toHaveLength(1);
      expect(
        handle.prepare('SELECT provider_state,provider_result_code FROM watch_digests').get(),
      ).toEqual({ provider_state: 'succeeded', provider_result_code: 'success' });
    },
  );

  it('provider.resolve 期间关闭 AI：零 claim/stream，并以当前状态合法终结 disabled', async () => {
    prepare(1, true);
    const gate = deferredSignal();
    const fake = new FakeProvider({
      chunks: ['{"sections":[{"eventIds":["event-000"],"explanation":"不得调用"}]}'],
    });
    const digest = new DigestService({
      repository: repo,
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
      provider: {
        resolve: async () => {
          gate.markEntered();
          await gate.wait;
          return { provider: fake, model: 'fake' };
        },
      },
      scheduleControl: noopScheduleControl,
    });
    const handling = digest.handleDue({
      scheduleId: 'schedule-1',
      expectedNextDueAt: due,
      logicalDate: '2026-08-29',
    });
    await gate.entered;
    const schedule = repo.getDigestSchedule('schedule-1')!;
    expect(digest.setAiEnabled(schedule.id, schedule.version, false)).toEqual({ ok: true });
    gate.release();
    await handling;
    expect(fake.getRequests()).toHaveLength(0);
    expect(
      handle.prepare('SELECT provider_state,provider_result_code FROM watch_digests').get(),
    ).toEqual({ provider_state: 'disabled', provider_result_code: 'disabled' });
  });

  it('provider.resolve 期间 shareMode 收紧为 blocked：最终投影零泄露且零调用', async () => {
    prepare(1, true);
    const gate = deferredSignal();
    const fake = new FakeProvider({ chunks: ['SHOULD_NOT_RUN'] });
    let shareMode: 'full' | 'blocked' = 'full';
    const digest = new DigestService({
      repository: repo,
      clock: new FakeClock(Date.parse(due)),
      sharing: {
        get: async () => [
          {
            sourceId: 'source-1',
            shareMode,
            displayName: 'FULL_NAME_CANARY',
            canonicalUrl: 'https://full-canary.invalid',
          },
        ],
      },
      provider: {
        resolve: async () => {
          gate.markEntered();
          await gate.wait;
          return { provider: fake, model: 'fake' };
        },
      },
      scheduleControl: noopScheduleControl,
    });
    const handling = digest.handleDue({
      scheduleId: 'schedule-1',
      expectedNextDueAt: due,
      logicalDate: '2026-08-29',
    });
    await gate.entered;
    shareMode = 'blocked';
    gate.release();
    await handling;
    expect(fake.getRequests()).toHaveLength(0);
    expect(JSON.stringify(fake.getRequests())).not.toMatch(
      /FULL_NAME_CANARY|full-canary|event-000/,
    );
    expect(
      handle.prepare('SELECT provider_state,provider_result_code FROM watch_digests').get(),
    ).toEqual({ provider_state: 'skipped', provider_result_code: 'no-visible-events' });
  });

  it.each([['provider', 1] as const, ['sharing', 2] as const])(
    '%s 准备期间 scrub：请求只绑定剩余事实，claim revision/hash 与请求版本恒等',
    async (gap, count) => {
      prepare(count, true);
      const gate = deferredSignal();
      const remainingId = count === 1 ? null : 'event-001';
      const fake = new FakeProvider({
        chunks:
          remainingId === null
            ? ['SHOULD_NOT_RUN']
            : [`{"sections":[{"eventIds":["${remainingId}"],"explanation":"仅剩余事实"}]}`],
      });
      const digest = new DigestService({
        repository: repo,
        clock: new FakeClock(Date.parse(due)),
        sharing: {
          get: async () => {
            if (gap === 'sharing') {
              gate.markEntered();
              await gate.wait;
            }
            return [
              {
                sourceId: 'source-1',
                shareMode: 'full',
                displayName: '来源',
                canonicalUrl: 'https://example.com',
              },
            ];
          },
        },
        provider: {
          resolve: async () => {
            if (gap === 'provider') {
              gate.markEntered();
              await gate.wait;
            }
            return { provider: fake, model: 'fake' };
          },
        },
        scheduleControl: noopScheduleControl,
      });
      const handling = digest.handleDue({
        scheduleId: 'schedule-1',
        expectedNextDueAt: due,
        logicalDate: '2026-08-29',
      });
      await gate.entered;
      expect(repo.deleteEventWithScrub('event-000', due)).toEqual({ ok: true });
      gate.release();
      await handling;
      const requests = fake.getRequests();
      expect(JSON.stringify(requests)).not.toMatch(/event-000|idem-event-000/);
      if (remainingId === null) {
        expect(requests).toHaveLength(0);
        expect(
          handle.prepare('SELECT provider_state,provider_result_code FROM watch_digests').get(),
        ).toEqual({ provider_state: 'skipped', provider_result_code: 'no-visible-events' });
      } else {
        expect(requests).toHaveLength(1);
        expect(JSON.stringify(requests[0])).toContain(remainingId);
        const row = handle
          .prepare(
            `SELECT facts_revision,facts_hash,claimed_facts_revision,claimed_facts_hash,
              explanation_json FROM watch_digests`,
          )
          .get() as Record<string, unknown>;
        expect(row.claimed_facts_revision).toBe(row.facts_revision);
        expect(row.claimed_facts_hash).toBe(row.facts_hash);
        expect(String(row.explanation_json)).not.toContain('event-000');
      }
    },
  );

  it('claimed artifact scrub 原子终结 aborted，迟到写回 CAS 被拒绝', async () => {
    prepare(1, true);
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
    const pending = repo.getDigestArtifact(id)!;
    const claimed = repo.claimDigestProvider({
      id,
      scheduleId: pending.scheduleId,
      factsRevision: pending.factsRevision,
      factsHash: pending.factsHash,
      nowIso: '2026-08-29T01:00:30.000Z',
    })!;
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

  it('Repository claim 事务拒绝 paused、AI 关闭及 expected facts/schedule 不匹配', async () => {
    prepare(1, true);
    const gate = deferredSignal();
    const digest = new DigestService({
      repository: repo,
      clock: new FakeClock(Date.parse(due)),
      sharing: { get: async () => [] },
      provider: {
        resolve: async () => {
          gate.markEntered();
          await gate.wait;
          return { provider: new FakeProvider({ chunks: [] }), model: 'fake' };
        },
      },
      scheduleControl: noopScheduleControl,
    });
    const handling = digest.handleDue({
      scheduleId: 'schedule-1',
      expectedNextDueAt: due,
      logicalDate: '2026-08-29',
    });
    await gate.entered;
    digest.stopAdmission();
    gate.release();
    await handling;
    const artifact = repo.listDigestArtifactsBySchedule('schedule-1')[0]!;
    const claim = (
      overrides: Partial<Parameters<WatchRepository['claimDigestProvider']>[0]> = {},
    ) =>
      repo.claimDigestProvider({
        id: artifact.id,
        scheduleId: artifact.scheduleId,
        factsRevision: artifact.factsRevision,
        factsHash: artifact.factsHash,
        nowIso: due,
        ...overrides,
      });
    expect(claim({ scheduleId: 'wrong-schedule' })).toBeNull();
    expect(claim({ factsRevision: artifact.factsRevision + 1 })).toBeNull();
    expect(claim({ factsHash: 'b'.repeat(64) })).toBeNull();

    let schedule = repo.getDigestSchedule('schedule-1')!;
    expect(repo.pauseDigestSchedule(schedule.id, schedule.version, due)).toEqual({ ok: true });
    expect(claim()).toBeNull();
    schedule = repo.getDigestSchedule('schedule-1')!;
    expect(repo.resumeDigestSchedule(schedule.id, schedule.version, due)).toEqual({ ok: true });
    schedule = repo.getDigestSchedule('schedule-1')!;
    expect(repo.setDigestScheduleAiEnabled(schedule.id, schedule.version, false, due)).toEqual({
      ok: true,
    });
    handle
      .prepare(
        `UPDATE watch_digests SET provider_state='pending',provider_result_code=NULL,
          provider_finished_at=NULL WHERE id=?`,
      )
      .run(artifact.id);
    expect(claim()).toBeNull();
    schedule = repo.getDigestSchedule('schedule-1')!;
    expect(repo.setDigestScheduleAiEnabled(schedule.id, schedule.version, true, due)).toEqual({
      ok: true,
    });
    expect(claim()).toMatchObject({ providerState: 'claimed' });
    expect(
      handle
        .prepare('SELECT claimed_facts_revision,claimed_facts_hash FROM watch_digests WHERE id=?')
        .get(artifact.id),
    ).toEqual({
      claimed_facts_revision: artifact.factsRevision,
      claimed_facts_hash: artifact.factsHash,
    });
  });

  it('claimed 跨启动恢复为 uncertain 且不回 pending', async () => {
    prepare(1, true);
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
    const pending = repo.getDigestArtifact(id)!;
    expect(
      repo.claimDigestProvider({
        id,
        scheduleId: pending.scheduleId,
        factsRevision: pending.factsRevision,
        factsHash: pending.factsHash,
        nowIso: '2026-08-29T01:00:30.000Z',
      }),
    ).not.toBeNull();
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

  it('active running 跨启动保留 frozen cursor，并在 Scheduler 前恢复完成', async () => {
    prepare(1);
    const schedule = repo.getDigestSchedule('schedule-1')!;
    const reserved = repo.reserveDigestRun({
      scheduleId: schedule.id,
      expectedVersion: schedule.version,
      expectedNextDueAt: due,
      expectedLastConsumedScheduledFor: null,
      expectedLastDailyLocalDate: null,
      runId: 'run-restart-active',
      requestKey: 'restart-active-key',
      logicalDate: '2026-08-29',
      nextDueAt: '2026-08-30T01:00:00.000Z',
      nowIso: due,
    });
    expect(reserved.ok).toBe(true);
    const dbPath = handle.path;
    repo.dispose();
    const reopened = openWatchStore({
      dbPath,
      backupsDir: join(root, 'restart-active-backups'),
      nowMs: () => Date.parse('2026-08-29T01:01:00.000Z'),
    });
    expect(reopened.mode).toBe('normal');
    if (reopened.mode !== 'normal') return;
    repo = reopened.repo;
    handle = repo.dbHandle;
    expect(repo.getDigestRun('run-restart-active')).toMatchObject({
      state: 'running',
      nextSequence: 0,
      upperSequence: 1,
    });
    await service().resumeActiveCycles();
    expect(repo.getDigestRun('run-restart-active')).toMatchObject({
      state: 'completed',
      nextSequence: 1,
    });
  });

  it('active running 恢复时容量仍不足合法转 budget_exceeded，不误判 Store unavailable 或入 heap', async () => {
    prepare(1);
    const schedule = repo.getDigestSchedule('schedule-1')!;
    const reserved = repo.reserveDigestRun({
      scheduleId: schedule.id,
      expectedVersion: schedule.version,
      expectedNextDueAt: due,
      expectedLastConsumedScheduledFor: null,
      expectedLastDailyLocalDate: null,
      runId: 'run-recovery-blocked',
      requestKey: 'recovery-blocked-key',
      logicalDate: '2026-08-29',
      nextDueAt: '2026-08-30T01:00:00.000Z',
      nowIso: due,
    });
    expect(reserved.ok).toBe(true);
    const control = new RecordingScheduleControl();
    const tight = new WatchRepository(handle, { maxDbBytes: repo.estimateLogicalBytes() + 1 });
    const digest = service(null, tight, control);
    await expect(digest.resumeActiveCycles()).resolves.toBeUndefined();
    expect(tight.getDigestRun('run-recovery-blocked')).toMatchObject({
      state: 'budget_exceeded',
      nextSequence: 0,
    });
    expect(control.entries.size).toBe(0);
  });

  it('budget_exceeded 持久化且显式容量复验后从原 frozen cycle 恢复', async () => {
    prepare(1);
    const tight = new WatchRepository(handle, { maxDbBytes: repo.estimateLogicalBytes() + 1 });
    const control = new RecordingScheduleControl();
    const tightService = service(null, tight, control);
    expect(
      await tightService.handleDue({
        scheduleId: 'schedule-1',
        expectedNextDueAt: due,
        logicalDate: '2026-08-29',
      }),
    ).toMatchObject({ ok: false });
    const blocked = repo.getNonterminalDigestRun('schedule-1')!;
    expect(blocked.state).toBe('budget_exceeded');
    expect(blocked.blockedRequiredBytes).toBeGreaterThan(blocked.blockedAvailableBytes!);
    expect(blocked.blockedAt).not.toBeNull();
    expect(service(null, tight).getSchedule('schedule-1')?.runs[0]).toMatchObject({
      state: 'budget_exceeded',
      blockedAt: blocked.blockedAt,
      blockedRequiredBytes: blocked.blockedRequiredBytes,
      blockedAvailableBytes: blocked.blockedAvailableBytes,
      createdAt: due,
      finishedAt: null,
    });
    expect(await tightService.retryBudget(blocked.id)).toEqual({
      ok: false,
      code: 'db-budget-exceeded',
    });
    expect(control.entries.size).toBe(0);
    const stillBlocked = repo.getDigestRun(blocked.id)!;
    expect(stillBlocked).toMatchObject({ state: 'budget_exceeded', nextSequence: 0 });
    expect(stillBlocked.blockedRequiredBytes).toBeGreaterThan(stillBlocked.blockedAvailableBytes!);
    expect(repo.getDigestSchedule('schedule-1')?.cursorSequence).toBe(0);
    const roomy = new WatchRepository(handle);
    expect(await service(null, roomy).retryBudget(blocked.id)).toEqual({ ok: true });
    expect(repo.getNonterminalDigestRun('schedule-1')).toBeNull();
    expect(handle.prepare('SELECT COUNT(*) AS n FROM watch_digests').get()).toEqual({ n: 1 });
  });

  it('active budget_exceeded 启动重建同一候选并容量恢复', async () => {
    prepare(1);
    const tight = new WatchRepository(handle, { maxDbBytes: repo.estimateLogicalBytes() + 1 });
    await service(null, tight).handleDue({
      scheduleId: 'schedule-1',
      expectedNextDueAt: due,
      logicalDate: '2026-08-29',
    });
    const runId = repo.getNonterminalDigestRun('schedule-1')!.id;
    const dbPath = handle.path;
    repo.dispose();
    const reopened = openWatchStore({
      dbPath,
      backupsDir: join(root, 'restart-budget-backups'),
      nowMs: () => Date.parse('2026-08-29T01:02:00.000Z'),
    });
    expect(reopened.mode).toBe('normal');
    if (reopened.mode !== 'normal') return;
    repo = reopened.repo;
    handle = repo.dbHandle;
    expect(repo.getDigestRun(runId)?.state).toBe('running');
    await service().resumeActiveCycles();
    expect(repo.getDigestRun(runId)?.state).toBe('completed');
  });

  it('paused budget_exceeded 启动原样休眠，Service resume 才容量复验', async () => {
    prepare(1);
    const tight = new WatchRepository(handle, { maxDbBytes: repo.estimateLogicalBytes() + 1 });
    await service(null, tight).handleDue({
      scheduleId: 'schedule-1',
      expectedNextDueAt: due,
      logicalDate: '2026-08-29',
    });
    const runId = repo.getNonterminalDigestRun('schedule-1')!.id;
    const schedule = repo.getDigestSchedule('schedule-1')!;
    expect(repo.pauseDigestSchedule(schedule.id, schedule.version, due)).toEqual({ ok: true });
    const dbPath = handle.path;
    repo.dispose();
    const reopened = openWatchStore({
      dbPath,
      backupsDir: join(root, 'restart-paused-budget-backups'),
      nowMs: () => Date.parse('2026-08-29T01:02:00.000Z'),
    });
    expect(reopened.mode).toBe('normal');
    if (reopened.mode !== 'normal') return;
    repo = reopened.repo;
    handle = repo.dbHandle;
    expect(repo.getDigestRun(runId)?.state).toBe('budget_exceeded');
    const paused = repo.getDigestSchedule('schedule-1')!;
    expect(await service().resume(paused.id, paused.version)).toEqual({ ok: true });
    expect(repo.getDigestRun(runId)?.state).toBe('completed');
  });

  it('完整 Digest+refs+cursor 写集 available==required 成功，少 1 byte 原子阻塞', () => {
    const seed = (maxDbBytes?: number) => {
      const db = openDb(join(root, `${randomUUID()}.db`));
      runWatchMigrations(db);
      const wide = new WatchRepository(db);
      prepare(1, false, wide);
      const schedule = wide.getDigestSchedule('schedule-1')!;
      const reserved = wide.reserveDigestRun({
        scheduleId: schedule.id,
        expectedVersion: schedule.version,
        expectedNextDueAt: due,
        expectedLastConsumedScheduledFor: null,
        expectedLastDailyLocalDate: null,
        runId: '00000000-0000-4000-8000-000000000001',
        requestKey: 'budget-boundary',
        logicalDate: '2026-08-29',
        nextDueAt: '2026-08-30T01:00:00.000Z',
        nowIso: due,
      });
      expect(reserved.ok).toBe(true);
      if (!reserved.ok) throw new Error('seed failed');
      const journal = wide.readDigestJournalSlice(reserved.run.id)!;
      const observation = journal.find((entry) => entry.observation !== null)?.observation;
      if (observation === null || observation === undefined) throw new Error('observation missing');
      const facts = buildDigestFacts({
        scheduleId: schedule.id,
        digestRunId: reserved.run.id,
        batchIndex: 0,
        period: reserved.run.period,
        runStats: reserved.run.runStats,
        observations: [observation],
        fetchedAt: reserved.run.period.toInclusive,
      })!;
      return {
        db,
        repo: new WatchRepository(db, { maxDbBytes: maxDbBytes ?? Number.MAX_SAFE_INTEGER }),
        run: reserved.run,
        facts,
        beforeBytes: wide.estimateLogicalBytes(),
      };
    };
    const write = (s: ReturnType<typeof seed>) =>
      s.repo.commitDigestBatch({
        artifactId: '00000000-0000-4000-8000-000000000002',
        run: s.run,
        expectedNextSequence: 0,
        firstSequence: 1,
        lastSequence: 1,
        facts: s.facts,
        createdAt: due,
        aiEnabled: false,
      });

    const measured = seed();
    expect(write(measured)).toEqual({ ok: true });
    const required = measured.repo.estimateLogicalBytes() - measured.beforeBytes;
    expect(required).toBe(1_418);
    measured.db.close();

    const exact = seed();
    const exactRepo = new WatchRepository(exact.db, {
      maxDbBytes: exact.beforeBytes + required,
    });
    exact.repo = exactRepo;
    expect(write(exact)).toEqual({ ok: true });
    expect(exactRepo.estimateLogicalBytes()).toBeLessThanOrEqual(exact.beforeBytes + required);
    exact.db.close();

    const short = seed();
    const shortRepo = new WatchRepository(short.db, {
      maxDbBytes: short.beforeBytes + required - 1,
    });
    short.repo = shortRepo;
    expect(write(short)).toEqual({
      ok: false,
      code: 'db-budget-exceeded',
      requiredBytes: required,
      availableBytes: required - 1,
    });
    expect(short.db.prepare('SELECT COUNT(*) AS n FROM watch_digests').get()).toEqual({ n: 0 });
    expect(shortRepo.getDigestRun(short.run.id)).toMatchObject({
      state: 'budget_exceeded',
      nextSequence: 0,
    });
    expect(shortRepo.getDigestSchedule('schedule-1')?.cursorSequence).toBe(0);
    expect(short.db.prepare('SELECT COUNT(*) AS n FROM watch_events').get()).toEqual({ n: 1 });
    short.db.close();
  });

  it.each(['batch', 'retry', 'resume', 'cleanup-failure'] as const)(
    '%s：Digest 写事务清理、重建候选与 frozen 水位保护',
    async (mode) => {
      const db = openDb(join(root, `${randomUUID()}-${mode}.db`));
      runWatchMigrations(db);
      const wide = new WatchRepository(db);
      const watchRule = rule();
      expect(wide.insertRule(watchRule)).toEqual({ ok: true });
      const oldPair = item('old-event');
      oldPair.after = {
        kind: 'present',
        excerpt: '旧'.repeat(1_200),
        valueHash: hex,
        normalizedBytes: 3_600,
        truncated: false,
      };
      const writeEvent = (eventId: string, pair: ChangeEvidencePair, observedAt: string) =>
        wide.writeEventTransaction({
          event: {
            id: eventId,
            ruleId: watchRule.id,
            sourceId: watchRule.sourceId,
            eventKind: 'added' as const,
            importance: 'normal' as const,
            idempotencyKey: `idem-${eventId}`,
            changeFingerprint: hex,
            firstObservedAt: observedAt,
            lastObservedAt: observedAt,
            itemCount: 1,
            readAt: observedAt,
          },
          items: [pair],
          identity: {
            sourceId: watchRule.sourceId,
            expectedSourceLocatorFingerprint: hex,
            expectedBaselineVersion: null,
          },
        });
      expect(writeEvent('old-safe-event', oldPair, created)).toEqual({ ok: true });
      expect(
        wide.createDigestSchedule({
          id: 'cleanup-schedule',
          sourceIds: ['source-1'],
          localTime: '09:00',
          timeZone: 'Asia/Shanghai',
          nextDueAt: due,
          nowIso: created,
        }),
      ).toEqual({ ok: true });
      expect(
        writeEvent('current-frozen-event', item('current'), '2026-08-28T00:00:01.000Z'),
      ).toEqual({
        ok: true,
      });
      if (mode === 'retry' || mode === 'resume') {
        expect(
          wide.createDigestSchedule({
            id: 'watermark-protector',
            sourceIds: ['source-1'],
            localTime: '10:00',
            timeZone: 'Asia/Shanghai',
            nextDueAt: '2026-08-29T02:00:00.000Z',
            nowIso: created,
          }),
        ).toEqual({ ok: true });
        db.prepare(
          "UPDATE digest_schedules SET cursor_sequence=0 WHERE id='watermark-protector'",
        ).run();
      }
      const schedule = wide.getDigestSchedule('cleanup-schedule')!;
      const reserved = wide.reserveDigestRun({
        scheduleId: schedule.id,
        expectedVersion: schedule.version,
        expectedNextDueAt: schedule.nextDueAt,
        expectedLastConsumedScheduledFor: null,
        expectedLastDailyLocalDate: null,
        runId: `cleanup-run-${mode}`,
        requestKey: `cleanup-key-${mode}`,
        logicalDate: '2026-08-29',
        nextDueAt: '2026-08-30T01:00:00.000Z',
        nowIso: due,
      });
      expect(reserved.ok).toBe(true);
      if (!reserved.ok) return;
      const journal = wide.readDigestJournalSlice(reserved.run.id)!;
      const observation = journal.find((entry) => entry.observation !== null)?.observation;
      if (observation === null || observation === undefined) throw new Error('candidate missing');
      const facts = buildDigestFacts({
        scheduleId: schedule.id,
        digestRunId: reserved.run.id,
        batchIndex: 0,
        period: reserved.run.period,
        runStats: reserved.run.runStats,
        observations: [observation],
        fetchedAt: reserved.run.period.toInclusive,
      })!;
      const beforeBytes = wide.estimateLogicalBytes();
      const tight = new WatchRepository(db, { maxDbBytes: beforeBytes + 1 });
      const commit = () =>
        tight.commitDigestBatch({
          artifactId: `cleanup-artifact-${mode}`,
          run: reserved.run,
          expectedNextSequence: reserved.run.nextSequence,
          firstSequence: reserved.run.nextSequence + 1,
          lastSequence: reserved.run.upperSequence,
          facts,
          createdAt: due,
          aiEnabled: false,
        });
      if (mode === 'cleanup-failure') {
        db.exec(`CREATE TRIGGER fail_digest_cleanup BEFORE DELETE ON watch_events
          WHEN OLD.id='old-safe-event' BEGIN SELECT RAISE(ABORT,'cleanup failed'); END`);
        expect(commit()).toEqual({ ok: false, code: 'store-unavailable' });
        expect(tight.getEvent('old-safe-event')).not.toBeNull();
        expect(tight.getEvent('current-frozen-event')).not.toBeNull();
        expect(tight.getDigestRun(reserved.run.id)).toMatchObject({
          state: 'running',
          nextSequence: 1,
        });
        expect(tight.getDigestSchedule(schedule.id)?.cursorSequence).toBe(1);
        expect(db.prepare('SELECT COUNT(*) AS n FROM watch_digests').get()).toEqual({ n: 0 });
        tight.dispose();
        return;
      }
      if (mode === 'batch') {
        expect(commit()).toEqual({ ok: true });
      } else {
        const blocked = commit();
        expect(blocked).toMatchObject({
          ok: false,
          code: 'db-budget-exceeded',
          availableBytes: 1,
        });
        expect(tight.getEvent('old-safe-event')).not.toBeNull();
        const protector = tight.getDigestSchedule('watermark-protector')!;
        expect(tight.deleteDigestSchedule(protector.id, protector.version)).toEqual({ ok: true });
        if (mode === 'retry') {
          expect(await service(null, tight).retryBudget(reserved.run.id)).toEqual({ ok: true });
        } else {
          const activeSchedule = tight.getDigestSchedule(schedule.id)!;
          expect(tight.pauseDigestSchedule(schedule.id, activeSchedule.version, due)).toEqual({
            ok: true,
          });
          const paused = tight.getDigestSchedule(schedule.id)!;
          expect(await service(null, tight).resume(schedule.id, paused.version)).toEqual({
            ok: true,
          });
        }
      }
      expect(tight.getEvent('old-safe-event')).toBeNull();
      expect(tight.getEvent('current-frozen-event')).not.toBeNull();
      expect(tight.getDigestSchedule(schedule.id)?.cursorSequence).toBe(2);
      tight.dispose();
    },
  );

  it('Clock 回拨不回拨 schedule.updated 与 run.blocked 审计时间', () => {
    prepare(1);
    const schedule = repo.getDigestSchedule('schedule-1')!;
    const reserved = repo.reserveDigestRun({
      scheduleId: schedule.id,
      expectedVersion: schedule.version,
      expectedNextDueAt: due,
      expectedLastConsumedScheduledFor: null,
      expectedLastDailyLocalDate: null,
      runId: 'run-clock-rollback',
      requestKey: 'clock-rollback',
      logicalDate: '2026-08-29',
      nextDueAt: '2026-08-30T01:00:00.000Z',
      nowIso: due,
    });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(repo.markDigestRunBudgetExceeded(reserved.run.id, 2, 1, created)).toEqual({ ok: true });
    expect(repo.getDigestRun(reserved.run.id)).toMatchObject({ blockedAt: due, createdAt: due });
    const afterReserve = repo.getDigestSchedule(schedule.id)!;
    expect(repo.pauseDigestSchedule(schedule.id, afterReserve.version, created)).toEqual({
      ok: true,
    });
    expect(repo.getDigestSchedule(schedule.id)?.updatedAt).toBe(due);
  });

  it('Clock 回拨时 batch 年龄保留使用真实 now，schedule 审计时间仍单调', () => {
    const seeded = seedClockRollbackCycle();
    expect(
      repo.commitDigestBatch({
        artifactId: 'rollback-artifact',
        run: seeded.run,
        expectedNextSequence: seeded.run.nextSequence,
        firstSequence: seeded.run.nextSequence + 1,
        lastSequence: seeded.run.upperSequence,
        facts: seeded.facts,
        createdAt: seeded.realNow,
        aiEnabled: false,
      }),
    ).toEqual({ ok: true });
    expect(repo.getEvent(seeded.oldEventId)).not.toBeNull();
    expect(repo.getDigestSchedule('rollback-schedule')?.updatedAt).toBe(seeded.futureAudit);
  });

  it('Clock 回拨时 budget retry 年龄保留使用真实 now，blockedAt 仍单调', () => {
    const seeded = seedClockRollbackCycle();
    expect(repo.markDigestRunBudgetExceeded(seeded.run.id, 2, 1, seeded.futureAudit)).toEqual({
      ok: true,
    });
    expect(repo.revalidateDigestRunBudget(seeded.run.id, seeded.realNow)).toEqual({
      ok: true,
      state: 'running',
    });
    expect(repo.getEvent(seeded.oldEventId)).not.toBeNull();
    expect(repo.getDigestRun(seeded.run.id)?.blockedAt).toBeNull();
    expect(repo.getDigestSchedule('rollback-schedule')?.updatedAt).toBe(seeded.futureAudit);
  });

  it('Clock 回拨不回拨 provider.claimed/finished 审计时间', async () => {
    prepare(1, true);
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const digest = new DigestService({
      repository: repo,
      clock: new FakeClock(Date.parse(due)),
      sharing: {
        get: async () => [],
      },
      provider: {
        resolve: async () => {
          await deferred;
          return { provider: new FakeProvider({ chunks: [] }), model: 'fake' };
        },
      },
      scheduleControl: noopScheduleControl,
    });
    const handling = digest.handleDue({
      scheduleId: 'schedule-1',
      expectedNextDueAt: due,
      logicalDate: '2026-08-29',
    });
    await Promise.resolve();
    digest.stopAdmission();
    release();
    await handling;
    const artifactId = (handle.prepare('SELECT id FROM watch_digests').get() as { id: string }).id;
    const claimedAt = '2026-08-29T03:00:00.000Z';
    const pending = repo.getDigestArtifact(artifactId)!;
    const claimed = repo.claimDigestProvider({
      id: artifactId,
      scheduleId: pending.scheduleId,
      factsRevision: pending.factsRevision,
      factsHash: pending.factsHash,
      nowIso: claimedAt,
    })!;
    expect(claimed.claimedAt).toBe(claimedAt);
    expect(
      repo.finishClaimedDigest({
        id: claimed.id,
        factsRevision: claimed.factsRevision,
        factsHash: claimed.factsHash,
        state: 'failed',
        code: 'aborted',
        explanationJson: null,
        nowIso: created,
      }),
    ).toEqual({ ok: true });
    expect(repo.getDigestArtifact(artifactId)?.providerFinishedAt).toBe(claimedAt);
  });

  it('Clock 回拨不回拨 run.finished 审计时间', () => {
    prepare(0);
    const schedule = repo.getDigestSchedule('schedule-1')!;
    const reserved = repo.reserveDigestRun({
      scheduleId: schedule.id,
      expectedVersion: schedule.version,
      expectedNextDueAt: due,
      expectedLastConsumedScheduledFor: null,
      expectedLastDailyLocalDate: null,
      runId: 'run-finish-rollback',
      requestKey: 'finish-rollback',
      logicalDate: '2026-08-29',
      nextDueAt: '2026-08-30T01:00:00.000Z',
      nowIso: due,
    });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(repo.completeDigestRun(reserved.run, created)).toEqual({ ok: true });
    expect(repo.getDigestRun(reserved.run.id)).toMatchObject({
      state: 'completed',
      createdAt: due,
      finishedAt: due,
    });
    expect(repo.getDigestSchedule(schedule.id)?.updatedAt).toBe(due);
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

  it('Service 独占动作执行 CAS，安全查询 DTO 完整暴露 run 阻塞与时间字段', async () => {
    prepare(1);
    const digest = service();
    const initial = repo.getDigestSchedule('schedule-1')!;
    expect(digest.pause(initial.id, initial.version)).toEqual({ ok: true });
    const paused = repo.getDigestSchedule(initial.id)!;
    expect(digest.pause(paused.id, initial.version)).toEqual({
      ok: false,
      code: 'rule-state-conflict',
    });
    expect(await digest.resume(paused.id, paused.version)).toEqual({ ok: true });
    const active = repo.getDigestSchedule(initial.id)!;
    expect(digest.setAiEnabled(active.id, active.version, true)).toEqual({ ok: true });
    const dto = digest.getSchedule(initial.id)!;
    expect(dto.schedule).toMatchObject({ id: initial.id, state: 'active', aiEnabled: true });
    expect(dto.runs).toEqual([]);
    expect(dto.artifacts).toEqual([]);
    expect(digest.listSchedules()).toHaveLength(1);
    const updated = repo.getDigestSchedule(initial.id)!;
    expect(digest.delete(updated.id, updated.version)).toEqual({ ok: true });
    expect(digest.getSchedule(initial.id)).toBeNull();
  });

  it('create/pause/resume/delete 由 Service 闭合 due heap，删除 CAS 失败恢复 active 条目', async () => {
    const control = new RecordingScheduleControl();
    const digest = new DigestService({
      repository: repo,
      clock: new FakeClock(Date.parse(created)),
      sharing: { get: async () => [] },
      provider: { resolve: async () => null },
      membership: {
        resolve: async () => ({
          status: 'ok',
          members: [
            {
              sourceId: 'source-1',
              displayName: '来源',
              canonicalUrl: 'https://example.com',
            },
          ],
        }),
      },
      scheduleControl: control,
    });
    expect(
      await digest.createSchedule({
        id: 'service-heap',
        selector: { sourceIds: ['source-1'] },
        localTime: '09:00',
        timeZone: 'Asia/Shanghai',
      }),
    ).toEqual({ ok: true });
    expect(control.entries.size).toBe(1);
    const initial = repo.getDigestSchedule('service-heap')!;
    expect(digest.pause(initial.id, initial.version)).toEqual({ ok: true });
    expect(control.entries.size).toBe(0);
    const paused = repo.getDigestSchedule(initial.id)!;
    expect(digest.pause(paused.id, paused.version)).toEqual({ ok: true });
    expect(repo.getDigestSchedule(paused.id)?.version).toBe(paused.version);
    expect(await digest.resume(paused.id, paused.version)).toEqual({ ok: true });
    expect(control.entries.size).toBe(1);
    const active = repo.getDigestSchedule(paused.id)!;
    expect(digest.delete(active.id, active.version - 1)).toEqual({
      ok: false,
      code: 'rule-state-conflict',
    });
    expect(control.entries.size).toBe(1);
    expect(digest.delete(active.id, active.version)).toEqual({ ok: true });
    expect(control.entries.size).toBe(0);
    digest.stopAdmission();
    const upsertsAtStop = control.upserts;
    expect(
      await digest.createSchedule({
        id: 'after-stop',
        selector: { sourceIds: ['source-1'] },
        localTime: '09:00',
        timeZone: 'Asia/Shanghai',
      }),
    ).toEqual({ ok: false });
    expect(control.upserts).toBe(upsertsAtStop);
  });

  it('真实 DigestScheduler：运行期 create 自动到期，pause 零执行，跨 due resume 仅一次 catch-up', async () => {
    const clock = new FakeClock(Date.parse(created));
    let dueCalls = 0;
    const digestHolder: { current: DigestService | null } = { current: null };
    const scheduler = new DigestScheduler(clock, (entry) => {
      dueCalls += 1;
      void digestHolder.current?.handleDue(entry);
    });
    const digest = new DigestService({
      repository: repo,
      clock,
      sharing: { get: async () => [] },
      provider: { resolve: async () => null },
      membership: {
        resolve: async () => ({
          status: 'ok',
          members: [
            {
              sourceId: 'source-1',
              displayName: '来源',
              canonicalUrl: 'https://example.com',
            },
          ],
        }),
      },
      scheduleControl: scheduler,
    });
    digestHolder.current = digest;
    expect(
      await digest.createSchedule({
        id: 'runtime-create',
        selector: { sourceIds: ['source-1'] },
        localTime: '09:00',
        timeZone: 'Asia/Shanghai',
      }),
    ).toEqual({ ok: true });
    expect(scheduler.size).toBe(1);
    const active = repo.getDigestSchedule('runtime-create')!;
    expect(digest.pause(active.id, active.version)).toEqual({ ok: true });
    expect(scheduler.size).toBe(0);
    clock.advanceTo(Date.parse(active.nextDueAt) + 60_000);
    await Promise.resolve();
    expect(dueCalls).toBe(0);
    const paused = repo.getDigestSchedule(active.id)!;
    expect(await digest.resume(paused.id, paused.version)).toEqual({ ok: true });
    clock.advanceBy(0);
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(dueCalls).toBe(1);
    expect(repo.listDigestRunsBySchedule(active.id)).toHaveLength(1);
    expect(scheduler.size).toBe(1);
    scheduler.stop();
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
        serializeDigestArtifact(facts, null).byteLength,
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
