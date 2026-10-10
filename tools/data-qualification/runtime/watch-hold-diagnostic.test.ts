import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../../src/shared/watch/clock';
import type { WatchRule } from '../../../src/shared/types/watch';
import { openDb } from '../../../src/main/sources/db/sqlite-driver';
import { runWatchMigrations } from '../../../src/main/watch/db/watch-migrations';
import { WatchRepository } from '../../../src/main/watch/repository/watch-repository';
import { WatchRunCoordinator } from '../../../src/main/watch/watch-run-coordinator';
import { WatchScheduler } from '../../../src/main/watch/watch-scheduler';
import { HostRequestGate } from '../../../src/main/watch/host-request-gate';
import { MaintenanceCoordinator } from '../../../src/main/storage/maintenance-coordinator';
import { Hold, ObservedPromise, observeMethod } from './controls';
import {
  assertOriginalsDrainedBeforeReady,
  activeDrainSnapshot,
  assertActiveHold,
  ACTIVE_LEAF_NAMES,
  type ActiveHolds,
  type ActiveObservations,
} from './harness';

vi.mock('electron', () => ({ app: {}, utilityProcess: {} }));

async function flushUntil(done: () => boolean): Promise<void> {
  for (let i = 0; i < 64 && !done(); i++) await Promise.resolve();
  expect(done()).toBe(true);
}

function setup(earlyReadyMutation: boolean) {
  const db = openDb(':memory:');
  runWatchMigrations(db);
  const repo = new WatchRepository(db);
  const clock = new FakeClock(Date.parse('2026-10-04T00:00:00Z'));
  const stamp = clock.now().toISOString();
  const rule: WatchRule = {
    id: '00000000-0000-4000-8000-000000000001',
    version: 1,
    sourceId: '00000000-0000-4000-8000-000000000002',
    kind: 'feed',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'public',
    schedule: { kind: 'interval', intervalMinutes: 15 },
    target: { type: 'feed', feedUrl: 'https://example.test/rss.xml', format: 'rss2' },
    condition: null,
    notificationLevel: 'normal',
    showDetails: false,
    sourceRowVersion: 1,
    sourceLocatorFingerprint: 'a'.repeat(64),
    nextDueAt: stamp,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: stamp,
    updatedAt: stamp,
  };
  expect(repo.insertRule(rule)).toEqual({ ok: true });
  const hold = new Hold();
  const leaf = new ObservedPromise();
  const outer = new ObservedPromise();
  const scheduler = new WatchScheduler({ clock, onDue: () => {} });
  const coordinator = new WatchRunCoordinator({
    repo,
    clock,
    scheduler,
    hostGate: new HostRequestGate({ clock, gapMs: 0 }),
    revalidator: {
      revalidateRuleSource: () => ({
        status: 'ok',
        rowVersion: 1,
        sourceAfterAcquisition: {
          sourceId: rule.sourceId,
          rowVersion: 1,
          enabled: true,
          deletedAt: null,
          scope: 'page',
          canonicalKey: 'https://example.test/rss.xml',
        },
      }),
    },
    acquisition: {
      run: (input) =>
        leaf.track(
          (async () => {
            await hold.wait(input.signal);
            return {
              ok: false as const,
              health: 'interrupted' as const,
              retryable: false,
              retryAfterSeconds: null,
              disposition: 'aborted' as const,
            };
          })(),
        ),
    },
    processing: {
      prepareAcquisition: () => ({
        ok: true,
        baselineHint: { kind: 'none', expectedBaselineVersion: 0 },
      }),
      process: () => ({ ok: false, code: 'store-unavailable', terminalWritten: false }),
    },
  });
  observeMethod(coordinator, 'executeRun', outer);
  let realDrain: Promise<void> | null = null;
  const maintenance = new MaintenanceCoordinator(
    [
      {
        pauseForMaintenance: (g) => coordinator.pauseForMaintenance(g),
        drainForMaintenance: (g) => {
          realDrain = coordinator.drainForMaintenance(g);
          // Negative control: falsely declare the domain drained after only its
          // cancellation-aware outer operation, omitting the real acquisition.
          return earlyReadyMutation ? outer.promise!.then(() => {}) : realDrain;
        },
        prepareResumeAfterMaintenance: (g) => coordinator.prepareResumeAfterMaintenance(g),
        resumeAfterMaintenance: (g) => coordinator.resumeAfterMaintenance(g),
      },
    ],
    async () => {},
  );
  return {
    clock,
    repo,
    coordinator,
    maintenance,
    hold,
    leaf,
    outer,
    rule,
    realDrain: () => realDrain,
  };
}

describe('Watch 人工hold与原编排终态的诊断区分', () => {
  it.each([false, true])(
    '早ready变异=%s：原executeRun可先结束，但原采集决定真实排水',
    async (mutant) => {
      const f = setup(mutant);
      const leaves = Object.fromEntries(
        ACTIVE_LEAF_NAMES.map((name) => [name, name === 'watchAcquisition' ? f.hold : new Hold()]),
      ) as ActiveHolds;
      const heldPromises = ACTIVE_LEAF_NAMES.filter((name) => name !== 'watchAcquisition').map(
        (name) => leaves[name].wait(),
      );
      try {
        f.coordinator.start();
        const run = f.coordinator.manualRun(f.rule.id, 'diagnostic-run');
        expect(run.ok).toBe(true);
        for (let tick = 0; tick < 12 && f.leaf.promise === null; tick++) {
          await Promise.resolve();
          f.clock.advanceBy(1000);
          await Promise.resolve();
        }
        expect(f.leaf.promise).not.toBeNull();
        expect(f.leaf.pending() && f.outer.pending()).toBe(true);
        const acquired = f.maintenance.acquire(performance.now() + 5000);
        await flushUntil(() => f.outer.settledAt !== null);
        if (mutant) await flushUntil(() => f.maintenance.status().phase === 'ready');
        const snapshot = {
          phase: f.maintenance.status().phase,
          watchAcquisition: {
            pending: f.leaf.pending(),
            settledAt: f.leaf.settledAt,
            rejected: f.leaf.rejected,
          },
          watchExecuteRun: {
            pending: f.outer.pending(),
            settledAt: f.outer.settledAt,
            rejected: f.outer.rejected,
          },
          abortReachedAcquisition: f.hold.aborted,
        };
        console.log(JSON.stringify({ diagnostic: '原采集与外层编排', mutant, ...snapshot }));
        expect(snapshot.watchAcquisition.pending).toBe(true);
        expect(snapshot.watchExecuteRun.pending).toBe(false);
        expect(snapshot.watchExecuteRun.rejected).toBe(false);
        expect(snapshot.abortReachedAcquisition).toBe(true);
        // The current harness conjunction rejects both states, and therefore
        // cannot distinguish legal cancellation from a genuinely early ready.
        expect([f.leaf, f.outer].every((value) => value.pending())).toBe(false);
        expect(snapshot.phase).toBe(mutant ? 'ready' : 'draining');
        const originals: ActiveObservations = {
          chat: new ObservedPromise(),
          agent: new ObservedPromise(),
          research: new ObservedPromise(),
          digest: new ObservedPromise(),
          watch: f.leaf,
          watchOrchestration: f.outer,
          preview: new ObservedPromise(),
          exporter: new ObservedPromise(),
          usage: new ObservedPromise(),
        };
        const named = activeDrainSnapshot(f.maintenance.status(), leaves, originals);
        expect(named.leaves).toHaveLength(8);
        expect(named.leaves.every((value) => value.pending)).toBe(true);
        if (mutant) expect(() => assertActiveHold(named)).toThrow();
        else expect(() => assertActiveHold(named)).not.toThrow();
        expect(() =>
          assertOriginalsDrainedBeforeReady([f.leaf, f.outer], performance.now()),
        ).toThrow();
        f.hold.release.release();
        const result = await acquired;
        await f.realDrain();
        expect(result.ok).toBe(true);
        expect(() =>
          assertOriginalsDrainedBeforeReady([f.leaf, f.outer], performance.now()),
        ).not.toThrow();
        if (run.ok) expect(f.repo.getRun(run.runId)?.status).toBe('interrupted');
      } finally {
        for (const name of ACTIVE_LEAF_NAMES) leaves[name].release.release();
        await Promise.all(heldPromises);
        f.hold.release.release();
        await f.coordinator.stop();
        f.repo.dispose();
      }
    },
  );
  it.each(ACTIVE_LEAF_NAMES)(
    'rejects early settled leaf %s while outer observations are still pending',
    async (name) => {
      const leaves = Object.fromEntries(
        ACTIVE_LEAF_NAMES.map((key) => [key, new Hold()]),
      ) as ActiveHolds;
      const waits = ACTIVE_LEAF_NAMES.map((key) => leaves[key].wait());
      const originals = {} as ActiveObservations;
      for (const key of [
        'chat',
        'agent',
        'research',
        'watch',
        'watchOrchestration',
        'digest',
        'preview',
        'exporter',
        'usage',
      ] as const) {
        const value = new ObservedPromise();
        value.promise = new Promise(() => {});
        originals[key] = value;
      }
      const status = {
        phase: 'draining' as const,
        operationId: 'fixed',
        pending: true,
        reason: null,
      };
      try {
        expect(() =>
          assertActiveHold(activeDrainSnapshot(status, leaves, originals)),
        ).not.toThrow();
        leaves[name].release.release();
        await waits[ACTIVE_LEAF_NAMES.indexOf(name)];
        const snapshot = activeDrainSnapshot(status, leaves, originals);
        expect(snapshot.leaves.find((value) => value.name === name)).toMatchObject({
          pending: false,
        });
        expect(() => assertActiveHold(snapshot)).toThrow();
      } finally {
        for (const key of ACTIVE_LEAF_NAMES) leaves[key].release.release();
        await Promise.all(waits);
      }
    },
  );
});
