import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMProvider } from '../ai/provider/llm-provider';
import type { ProviderEvent } from '../../shared/types/conversation';
import type { ChangeEvidencePair, WatchRule } from '../../shared/types/watch';
import { FakeClock } from '../../shared/watch/clock';
import { openDb, type DbHandle } from '../sources/db/sqlite-driver';
import { runWatchMigrations } from './db/watch-migrations';
import { DigestScheduler } from './digest-scheduler';
import { DigestService } from './digest-service';
import { WatchRepository } from './repository/watch-repository';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-digest-maintenance-'));
const created = '2026-10-03T00:00:00.000Z';
const due = '2026-10-04T01:00:00.000Z';
const nextDue = '2026-10-05T01:00:00.000Z';
const hash = 'a'.repeat(64);
let handle: DbHandle;
let repository: WatchRepository;

beforeEach(() => {
  handle = openDb(join(root, `${randomUUID()}.db`));
  runWatchMigrations(handle);
  repository = new WatchRepository(handle);
});
afterEach(() => repository.dispose());
afterAll(() => rmSync(root, { recursive: true, force: true }));

function rule(): WatchRule {
  return {
    id: 'rule-1',
    version: 1,
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
    showDetails: false,
    sourceRowVersion: 1,
    sourceLocatorFingerprint: hash,
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

function evidence(): ChangeEvidencePair {
  return {
    itemId: 'item-1',
    fieldKey: 'title',
    label: '标题',
    before: { kind: 'absent' },
    after: {
      kind: 'present',
      excerpt: '合成变化',
      valueHash: hash,
      normalizedBytes: 12,
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

function prepare(): void {
  expect(repository.insertRule(rule())).toEqual({ ok: true });
  expect(
    repository.createDigestSchedule({
      id: 'digest-1',
      sourceIds: ['source-1'],
      localTime: '09:00',
      timeZone: 'Asia/Shanghai',
      aiEnabled: true,
      nextDueAt: due,
      nowIso: created,
    }),
  ).toEqual({ ok: true });
  expect(
    repository.writeEventTransaction({
      event: {
        id: 'event-1',
        ruleId: 'rule-1',
        sourceId: 'source-1',
        eventKind: 'added',
        importance: 'normal',
        idempotencyKey: 'maintenance-event-1',
        changeFingerprint: hash,
        firstObservedAt: created,
        lastObservedAt: created,
        itemCount: 1,
        readAt: null,
      },
      items: [evidence()],
      identity: {
        sourceId: 'source-1',
        expectedSourceLocatorFingerprint: hash,
        expectedBaselineVersion: null,
      },
    }),
  ).toEqual({ ok: true });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value) => resolve(value),
  };
}

function provider(stream: LLMProvider['stream']): LLMProvider {
  return {
    metadata: {
      id: 'maintenance-provider',
      label: '维护测试',
      streaming: true,
      supportsToolCalling: false,
      defaultContextLimitTokens: 4096,
    },
    stream,
  };
}

function makeService(options: {
  resolve: () => Promise<{ provider: LLMProvider; model: string } | null>;
  sharing?: () => Promise<
    readonly {
      sourceId: string;
      shareMode: 'full';
      displayName: string;
      canonicalUrl: string;
    }[]
  >;
}): { service: DigestService; scheduler: DigestScheduler; clock: FakeClock } {
  const clock = new FakeClock(Date.parse(due));
  const scheduler = new DigestScheduler(clock, () => undefined);
  const service = new DigestService({
    repository,
    clock,
    provider: { resolve: options.resolve },
    sharing: {
      get:
        options.sharing ??
        (async () => [
          {
            sourceId: 'source-1',
            shareMode: 'full' as const,
            displayName: '来源',
            canonicalUrl: 'https://example.com',
          },
        ]),
    },
    scheduleControl: scheduler,
  });
  return { service, scheduler, clock };
}

function start(service: DigestService): Promise<{ ok: boolean; nextDueAt: string | null }> {
  return service.handleDue({
    scheduleId: 'digest-1',
    expectedNextDueAt: due,
    logicalDate: '2026-10-04',
  });
}

describe('E2 Digest maintenance drain', () => {
  it('waits a late provider resolve, creates no claim after pause, and rebuilds from the consumed nextDue', async () => {
    prepare();
    const resolved = deferred<{ provider: LLMProvider; model: string } | null>();
    let resolveCalls = 0;
    let streamCalls = 0;
    const fake = provider(() => {
      streamCalls += 1;
      return (async function* (): AsyncIterable<ProviderEvent> {
        yield { type: 'done' };
      })();
    });
    const { service, scheduler } = makeService({
      resolve: () => {
        resolveCalls += 1;
        return resolved.promise;
      },
    });
    const run = start(service);
    for (let index = 0; index < 20 && resolveCalls === 0; index += 1) await Promise.resolve();
    expect(resolveCalls).toBe(1);

    expect(service.pauseForMaintenance(1)).toBe(true);
    expect(service.pauseForMaintenance(1)).toBe(true);
    await expect(service.drainForMaintenance(2)).rejects.toThrow('维护世代不可用');
    let drained = false;
    const ownedDrain = service.drainForMaintenance(1);
    expect(service.drainForMaintenance(1)).toBe(ownedDrain);
    const drain = ownedDrain.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(service.resumeAfterMaintenance(1)).toBe(false);
    resolved.resolve({ provider: fake, model: 'fake' });
    await drain;
    expect((await run).ok).toBe(false);
    expect(streamCalls).toBe(0);
    expect(repository.listDigestArtifactsBySchedule('digest-1')[0]?.providerState).toBe('pending');
    expect(service.resumeAfterMaintenance(2)).toBe(false);
    expect(service.prepareResumeAfterMaintenance(1)).toBe(true);
    expect(service.resumeAfterMaintenance(1)).toBe(true);
    expect(scheduler.size).toBe(1);
    expect(repository.getDigestSchedule('digest-1')?.nextDueAt).toBe(nextDue);
    expect(service.pauseForMaintenance(1)).toBe(false);
  });

  it('waits a late sharing lookup and never claims the pending artifact after admission closes', async () => {
    prepare();
    const sharing = deferred<
      readonly {
        sourceId: string;
        shareMode: 'full';
        displayName: string;
        canonicalUrl: string;
      }[]
    >();
    let sharingCalls = 0;
    let streamCalls = 0;
    const fake = provider(() => {
      streamCalls += 1;
      return (async function* (): AsyncIterable<ProviderEvent> {
        yield { type: 'done' };
      })();
    });
    const { service } = makeService({
      resolve: async () => ({ provider: fake, model: 'fake' }),
      sharing: () => {
        sharingCalls += 1;
        return sharing.promise;
      },
    });
    const run = start(service);
    for (let index = 0; index < 20 && sharingCalls === 0; index += 1) await Promise.resolve();
    expect(sharingCalls).toBe(1);
    expect(service.pauseForMaintenance(3)).toBe(true);
    const drain = service.drainForMaintenance(3);
    sharing.resolve([
      {
        sourceId: 'source-1',
        shareMode: 'full',
        displayName: '来源',
        canonicalUrl: 'https://example.com',
      },
    ]);
    await drain;
    expect((await run).ok).toBe(false);
    expect(streamCalls).toBe(0);
    expect(repository.listDigestArtifactsBySchedule('digest-1')[0]?.providerState).toBe('pending');
  });

  it('aborts a claimed provider stream and waits for the failed/aborted terminal write', async () => {
    prepare();
    let streamStarted!: () => void;
    const entered = new Promise<void>((resolve) => {
      streamStarted = resolve;
    });
    const serviceHolder: { current: DigestService | null } = { current: null };
    const observed: {
      signal?: AbortSignal;
      abortReentry?: Promise<{ ok: boolean; nextDueAt: string | null }>;
    } = {};
    const fake = provider((_request, signal) =>
      (async function* (): AsyncIterable<ProviderEvent> {
        observed.signal = signal;
        streamStarted();
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                observed.abortReentry = serviceHolder.current!.handleDue({
                  scheduleId: 'digest-1',
                  expectedNextDueAt: nextDue,
                  logicalDate: '2026-10-05',
                });
                resolve();
              },
              { once: true },
            );
          });
        }
        yield {
          type: 'error',
          error: {
            code: 'aborted',
            message: '已取消',
            retryable: false,
            providerId: 'maintenance-provider',
            model: 'fake',
            requestId: 'digest-1',
          },
        };
      })(),
    );
    const { service } = makeService({
      resolve: async () => ({ provider: fake, model: 'fake' }),
    });
    serviceHolder.current = service;
    const run = start(service);
    await entered;
    expect(repository.listDigestArtifactsBySchedule('digest-1')[0]?.providerState).toBe('claimed');
    expect(service.pauseForMaintenance(5)).toBe(true);
    expect(observed.signal?.aborted).toBe(false);
    await service.drainForMaintenance(5);
    expect(observed.signal?.aborted).toBe(true);
    expect(await observed.abortReentry).toEqual({ ok: false, nextDueAt: null });
    expect((await run).ok).toBe(false);
    expect(repository.listDigestArtifactsBySchedule('digest-1')[0]).toMatchObject({
      providerState: 'failed',
      providerResultCode: 'aborted',
    });
    expect(service.prepareResumeAfterMaintenance(5)).toBe(true);
    expect(service.resumeAfterMaintenance(5)).toBe(true);
  });

  it('latches a provider terminal-write failure that happened before maintenance', async () => {
    prepare();
    let providerCalls = 0;
    const fake = provider(() => {
      providerCalls += 1;
      return (async function* (): AsyncIterable<ProviderEvent> {
        yield { type: 'done' };
      })();
    });
    const { service } = makeService({
      resolve: async () => ({ provider: fake, model: 'fake' }),
    });
    const finish = vi
      .spyOn(repository, 'finishClaimedDigest')
      .mockReturnValue({ ok: false, code: 'store-unavailable' });
    await expect(start(service)).rejects.toThrow('终态写入失败');
    expect(providerCalls).toBe(1);
    expect(finish).toHaveBeenCalledOnce();
    expect(repository.listDigestArtifactsBySchedule('digest-1')[0]?.providerState).toBe('claimed');

    expect(service.pauseForMaintenance(6)).toBe(true);
    await expect(service.drainForMaintenance(6)).rejects.toThrow('维护排水期间状态已改变');
    expect(service.prepareResumeAfterMaintenance(6)).toBe(false);
    expect(service.resumeAfterMaintenance(6)).toBe(false);
    expect(providerCalls).toBe(1);
  });

  it('blocks resume when a claimed provider terminal write fails during maintenance drain', async () => {
    prepare();
    const release = deferred<void>();
    const entered = deferred<void>();
    let providerCalls = 0;
    const fake = provider(() => {
      providerCalls += 1;
      return (async function* (): AsyncIterable<ProviderEvent> {
        entered.resolve();
        await release.promise;
        yield { type: 'done' };
      })();
    });
    const { service } = makeService({
      resolve: async () => ({ provider: fake, model: 'fake' }),
    });
    vi.spyOn(repository, 'finishClaimedDigest').mockReturnValue({
      ok: false,
      code: 'store-unavailable',
    });
    const run = start(service);
    await entered.promise;
    expect(service.pauseForMaintenance(7)).toBe(true);
    const drain = service.drainForMaintenance(7);
    release.resolve();
    await expect(run).rejects.toThrow('终态写入失败');
    await expect(drain).rejects.toThrow('维护排水期间状态已改变');
    expect(service.prepareResumeAfterMaintenance(7)).toBe(false);
    expect(service.resumeAfterMaintenance(7)).toBe(false);
    expect(providerCalls).toBe(1);
    expect(repository.listDigestArtifactsBySchedule('digest-1')[0]?.providerState).toBe('claimed');
  });
});
