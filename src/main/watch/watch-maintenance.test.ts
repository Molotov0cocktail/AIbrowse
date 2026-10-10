import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../shared/watch/clock';
import type {
  Clock,
  TimerHandle,
  WatchAcquisitionResult,
  WatchProcessingService,
  WatchRule,
} from '../../shared/types/watch';
import { openDb } from '../sources/db/sqlite-driver';
import { runWatchMigrations } from './db/watch-migrations';
import { DigestScheduler } from './digest-scheduler';
import { HostRequestGate } from './host-request-gate';
import { WatchRepository } from './repository/watch-repository';
import {
  WatchRunCoordinator,
  type SchedulerPort,
  type WatchAcquisitionPort,
} from './watch-run-coordinator';
import { computeJitterMs, WatchScheduler } from './watch-scheduler';

const tempRoot = mkdtempSync(join(tmpdir(), 'aibrowse-watch-maintenance-'));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

class StickyClock implements Clock {
  private current = 0;
  readonly callbacks: Array<() => void> = [];

  now(): Date {
    return new Date(this.current);
  }

  setNow(value: number): void {
    this.current = value;
  }

  setTimeout(callback: () => void): TimerHandle {
    const id = this.callbacks.length;
    this.callbacks.push(callback);
    return { kind: 'timer', id };
  }

  clearTimeout(): void {
    // Retain callbacks to model an already queued timer.
  }
}

function watchRule(now: string): WatchRule {
  return {
    id: randomUUID(),
    version: 1,
    sourceId: 'source-1',
    kind: 'feed',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'public',
    schedule: { kind: 'interval', intervalMinutes: 15 },
    target: { type: 'feed', feedUrl: 'https://example.com/rss.xml', format: 'rss2' },
    condition: null,
    notificationLevel: 'normal',
    showDetails: false,
    sourceRowVersion: 1,
    sourceLocatorFingerprint: 'a'.repeat(64),
    nextDueAt: now,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: now,
    updatedAt: now,
  };
}

class MaintenanceWatchScheduler implements SchedulerPort {
  paused: number | null = null;
  drained = false;
  prepared = false;
  prepareFails = false;
  stopped = false;
  rebuilt: Array<{ ruleId: string; effectiveDueAt: number }> = [];
  initialize(): void {}
  upsert(): void {}
  remove(): void {}
  stop(): void {
    this.stopped = true;
  }
  pauseForMaintenance(generation: number): boolean {
    if (this.paused !== null) return this.paused === generation;
    this.paused = generation;
    this.drained = false;
    this.prepared = false;
    return true;
  }
  drainForMaintenance(generation: number): Promise<void> {
    if (this.paused !== generation) return Promise.reject(new Error('wrong generation'));
    this.drained = true;
    return Promise.resolve();
  }
  prepareResumeAfterMaintenance(
    generation: number,
    entries: readonly { ruleId: string; effectiveDueAt: number }[],
  ): boolean {
    if (this.stopped || this.prepareFails || this.paused !== generation || !this.drained)
      return false;
    this.rebuilt = [...entries];
    this.prepared = true;
    return true;
  }
  resumeAfterMaintenance(generation: number): boolean {
    if (this.stopped || this.paused !== generation || !this.drained || !this.prepared) return false;
    this.paused = null;
    this.drained = false;
    this.prepared = false;
    return true;
  }
}

function makeCoordinator(input: {
  repository: WatchRepository;
  clock: Clock;
  hostGate: HostRequestGate;
  rule: WatchRule;
  acquisition: WatchAcquisitionPort['run'];
}): WatchRunCoordinator {
  return new WatchRunCoordinator({
    repo: input.repository,
    revalidator: {
      revalidateRuleSource: () => ({
        status: 'ok',
        rowVersion: 1,
        sourceAfterAcquisition: {
          sourceId: input.rule.sourceId,
          rowVersion: 1,
          enabled: true,
          deletedAt: null,
          scope: 'page',
          canonicalKey: 'https://example.com/doc',
        },
      }),
    },
    acquisition: { run: input.acquisition },
    processing: {
      prepareAcquisition: () => ({
        ok: true,
        baselineHint: { kind: 'none', expectedBaselineVersion: 0 },
      }),
      process: () => ({ ok: false, code: 'store-unavailable', terminalWritten: false }),
    },
    hostGate: input.hostGate,
    scheduler: new MaintenanceWatchScheduler(),
    clock: input.clock,
  });
}

describe('E2 maintenance scheduler admission', () => {
  it('WatchScheduler pause synchronously rejects a late timer and same-generation drain gates resume', async () => {
    const clock = new FakeClock(0);
    const onDue = vi.fn();
    const scheduler = new WatchScheduler({ clock, onDue });
    scheduler.initialize([{ ruleId: 'watch-1', effectiveDueAt: 10 }]);

    expect(scheduler.pauseForMaintenance(1)).toBe(true);
    expect(scheduler.pauseForMaintenance(1)).toBe(true);
    await expect(scheduler.drainForMaintenance(2)).rejects.toThrow('维护世代不可用');
    clock.advanceTo(10);
    expect(onDue).not.toHaveBeenCalled();
    expect(scheduler.resumeAfterMaintenance(1)).toBe(false);

    await scheduler.drainForMaintenance(1);
    expect(scheduler.resumeAfterMaintenance(2)).toBe(false);
    expect(
      scheduler.prepareResumeAfterMaintenance(1, [{ ruleId: 'watch-1', effectiveDueAt: 10 }]),
    ).toBe(true);
    expect(scheduler.resumeAfterMaintenance(1)).toBe(true);
    clock.advanceBy(0);
    expect(onDue).toHaveBeenCalledTimes(1);

    scheduler.stop();
    expect(scheduler.pauseForMaintenance(2)).toBe(false);
    expect(scheduler.resumeAfterMaintenance(2)).toBe(false);
  });

  it('DigestScheduler keeps the consumed queue identity while paused and resumes only after drain', async () => {
    const clock = new FakeClock(0);
    const onDue = vi.fn();
    const scheduler = new DigestScheduler(clock, onDue);
    scheduler.initialize([
      {
        scheduleId: 'digest-1',
        expectedNextDueAt: new Date(10).toISOString(),
        timeZone: 'UTC',
      },
    ]);

    expect(scheduler.pauseForMaintenance(7)).toBe(true);
    clock.advanceTo(10);
    expect(onDue).not.toHaveBeenCalled();
    expect(scheduler.resumeAfterMaintenance(7)).toBe(false);

    await scheduler.drainForMaintenance(7);
    expect(scheduler.resumeAfterMaintenance(8)).toBe(false);
    expect(
      scheduler.prepareResumeAfterMaintenance(7, [
        {
          scheduleId: 'digest-1',
          expectedNextDueAt: new Date(10).toISOString(),
          timeZone: 'UTC',
        },
      ]),
    ).toBe(true);
    expect(scheduler.resumeAfterMaintenance(7)).toBe(true);
    clock.advanceBy(0);
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it('old queued timer epochs cannot consume rebuilt Watch or Digest schedules', async () => {
    const watchClock = new StickyClock();
    const watchDue = vi.fn();
    const watch = new WatchScheduler({ clock: watchClock, onDue: watchDue });
    watch.initialize([{ ruleId: 'watch-old-timer', effectiveDueAt: 10 }]);
    expect(watch.pauseForMaintenance(11)).toBe(true);
    await watch.drainForMaintenance(11);
    expect(
      watch.prepareResumeAfterMaintenance(11, [{ ruleId: 'watch-old-timer', effectiveDueAt: 10 }]),
    ).toBe(true);
    expect(watch.resumeAfterMaintenance(11)).toBe(true);
    watchClock.setNow(10);
    watchClock.callbacks[0]!();
    expect(watchDue).not.toHaveBeenCalled();
    expect(watch.size).toBe(1);
    watchClock.callbacks.at(-1)!();
    expect(watchDue).toHaveBeenCalledTimes(1);

    const digestClock = new StickyClock();
    const digestDue = vi.fn();
    const digest = new DigestScheduler(digestClock, digestDue);
    const digestEntry = {
      scheduleId: 'digest-old-timer',
      expectedNextDueAt: new Date(10).toISOString(),
      timeZone: 'UTC',
    };
    digest.initialize([digestEntry]);
    expect(digest.pauseForMaintenance(12)).toBe(true);
    await digest.drainForMaintenance(12);
    expect(digest.prepareResumeAfterMaintenance(12, [digestEntry])).toBe(true);
    expect(digest.resumeAfterMaintenance(12)).toBe(true);
    digestClock.setNow(10);
    digestClock.callbacks[0]!();
    expect(digestDue).not.toHaveBeenCalled();
    expect(digest.size).toBe(1);
    digestClock.callbacks.at(-1)!();
    expect(digestDue).toHaveBeenCalledTimes(1);
  });

  it('prepare failures and permanent stop keep scheduler admission closed', async () => {
    const clock = new FakeClock(0);
    const watch = new WatchScheduler({ clock, onDue: () => undefined });
    expect(watch.pauseForMaintenance(20)).toBe(true);
    await watch.drainForMaintenance(20);
    expect(
      watch.prepareResumeAfterMaintenance(20, [
        { ruleId: 'duplicate', effectiveDueAt: 1 },
        { ruleId: 'duplicate', effectiveDueAt: 2 },
      ]),
    ).toBe(false);
    expect(watch.resumeAfterMaintenance(20)).toBe(false);
    expect(watch.prepareResumeAfterMaintenance(20, [{ ruleId: 'valid', effectiveDueAt: 1 }])).toBe(
      true,
    );
    watch.stop();
    expect(watch.resumeAfterMaintenance(20)).toBe(false);

    const digest = new DigestScheduler(clock, () => undefined);
    expect(digest.pauseForMaintenance(21)).toBe(true);
    await digest.drainForMaintenance(21);
    expect(
      digest.prepareResumeAfterMaintenance(21, [
        { scheduleId: 'invalid', expectedNextDueAt: 'not-a-date', timeZone: 'UTC' },
      ]),
    ).toBe(false);
    expect(digest.resumeAfterMaintenance(21)).toBe(false);
    expect(
      digest.prepareResumeAfterMaintenance(21, [
        {
          scheduleId: 'valid',
          expectedNextDueAt: new Date(1).toISOString(),
          timeZone: 'UTC',
        },
      ]),
    ).toBe(true);
    digest.stop();
    expect(digest.resumeAfterMaintenance(21)).toBe(false);
  });

  it('Coordinator drain owns the original acquisition promise and terminalizes the reserved row without clearing host history', async () => {
    const handle = openDb(join(tempRoot, `${randomUUID()}.db`));
    runWatchMigrations(handle);
    const repository = new WatchRepository(handle);
    const clock = new FakeClock(Date.parse('2026-10-04T00:00:00.000Z'));
    const now = clock.now().toISOString();
    const rule = watchRule(now);
    expect(repository.insertRule(rule)).toEqual({ ok: true });
    const scheduler = new MaintenanceWatchScheduler();
    const hostGate = new HostRequestGate({ clock, gapMs: 0 });
    const hostKey = 'example.com:443';
    expect(await hostGate.acquire(hostKey)).toEqual({ ok: true });
    const registeredAt = hostGate.lastStartedAt(hostKey);
    let release!: (result: WatchAcquisitionResult) => void;
    let entered!: () => void;
    let runId: string | null = null;
    let abortReentry: ReturnType<WatchRunCoordinator['manualRun']> | null = null;
    const acquisitionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const acquisition: WatchAcquisitionPort = {
      run: (input) => {
        runId = input.runId;
        entered();
        input.signal.addEventListener(
          'abort',
          () => {
            abortReentry = coordinator.manualRun(rule.id, 'abort-reentry');
          },
          { once: true },
        );
        return new Promise<WatchAcquisitionResult>((resolve) => {
          release = resolve;
        });
      },
    };
    const processing: WatchProcessingService = {
      prepareAcquisition: () => ({
        ok: true,
        baselineHint: { kind: 'none', expectedBaselineVersion: 0 },
      }),
      process: () => ({ ok: false, code: 'store-unavailable', terminalWritten: false }),
    };
    const coordinator = new WatchRunCoordinator({
      repo: repository,
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
            canonicalKey: 'https://example.com/doc',
          },
        }),
      },
      acquisition,
      processing,
      hostGate,
      scheduler,
      clock,
    });
    try {
      coordinator.start();
      coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
      for (let index = 0; index < 12 && runId === null; index += 1) {
        await Promise.resolve();
        clock.advanceBy(1000);
        await Promise.resolve();
      }
      expect(runId).not.toBeNull();
      await acquisitionEntered;
      expect(repository.getRun(runId!)?.status).toBe('running');

      expect(coordinator.pauseForMaintenance(1)).toBe(true);
      expect(coordinator.pauseForMaintenance(1)).toBe(true);
      expect(abortReentry).toBeNull();
      await expect(coordinator.drainForMaintenance(2)).rejects.toThrow('维护世代不可用');
      expect(coordinator.manualRun(rule.id, 'late-manual')).toEqual({
        ok: false,
        reason: 'stopped',
      });
      let drained = false;
      const ownedDrain = coordinator.drainForMaintenance(1);
      expect(abortReentry).toEqual({ ok: false, reason: 'stopped' });
      expect(coordinator.drainForMaintenance(1)).toBe(ownedDrain);
      const drain = ownedDrain.then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      expect(coordinator.resumeAfterMaintenance(1)).toBe(false);

      release({
        ok: false,
        health: 'unavailable',
        retryable: false,
        retryAfterSeconds: null,
        disposition: 'network',
      });
      await drain;
      expect(repository.getRun(runId!)?.status).toBe('interrupted');
      expect(hostGate.lastStartedAt(hostKey)).toBe(registeredAt);
      expect(coordinator.resumeAfterMaintenance(2)).toBe(false);
      scheduler.prepareFails = true;
      expect(coordinator.prepareResumeAfterMaintenance(1)).toBe(false);
      expect(coordinator.manualRun(rule.id, 'prepare-failed')).toEqual({
        ok: false,
        reason: 'stopped',
      });
      scheduler.prepareFails = false;
      expect(coordinator.prepareResumeAfterMaintenance(1)).toBe(true);
      expect(coordinator.resumeAfterMaintenance(1)).toBe(true);
      expect(scheduler.rebuilt).toEqual([
        {
          ruleId: rule.id,
          effectiveDueAt: Date.parse(repository.getRule(rule.id)!.nextDueAt!),
        },
      ]);
      expect(coordinator.pauseForMaintenance(1)).toBe(false);
    } finally {
      repository.dispose();
    }
  });

  it('blocks a new acquisition when maintenance closes after a successful host-gate wait', async () => {
    const handle = openDb(join(tempRoot, `${randomUUID()}.db`));
    runWatchMigrations(handle);
    const repository = new WatchRepository(handle);
    const clock = new FakeClock(0);
    const rule = watchRule(clock.now().toISOString());
    expect(repository.insertRule(rule)).toEqual({ ok: true });
    const hostGate = new HostRequestGate({ clock, gapMs: 1_000 });
    expect(await hostGate.acquire('example.com:443')).toEqual({ ok: true });
    const acquisition = vi.fn(async (): Promise<WatchAcquisitionResult> => ({
      ok: false,
      health: 'unavailable',
      retryable: false,
      retryAfterSeconds: null,
      disposition: 'network',
    }));
    const coordinator = makeCoordinator({ repository, clock, hostGate, rule, acquisition });
    try {
      coordinator.start();
      coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
      expect(acquisition).not.toHaveBeenCalled();
      clock.advanceBy(1_000);
      expect(acquisition).not.toHaveBeenCalled();
      expect(coordinator.pauseForMaintenance(2)).toBe(true);
      await coordinator.drainForMaintenance(2);
      expect(acquisition).not.toHaveBeenCalled();
    } finally {
      repository.dispose();
    }
  });

  it('blocks a new acquisition when maintenance closes after successful jitter', async () => {
    const handle = openDb(join(tempRoot, `${randomUUID()}.db`));
    runWatchMigrations(handle);
    const repository = new WatchRepository(handle);
    const clock = new FakeClock(Date.parse('2026-10-04T00:00:00.000Z'));
    const rule = watchRule(clock.now().toISOString());
    rule.id = '00000000-0000-4000-8000-000000000123';
    expect(repository.insertRule(rule)).toEqual({ ok: true });
    const jitter = computeJitterMs({
      ruleId: rule.id,
      hostKey: 'example.com:443',
      seed: clock.now().toISOString(),
    });
    expect(jitter).toBeGreaterThan(0);
    const acquisition = vi.fn(async (): Promise<WatchAcquisitionResult> => ({
      ok: false,
      health: 'unavailable',
      retryable: false,
      retryAfterSeconds: null,
      disposition: 'network',
    }));
    const coordinator = makeCoordinator({
      repository,
      clock,
      hostGate: new HostRequestGate({ clock, gapMs: 0 }),
      rule,
      acquisition,
    });
    try {
      coordinator.start();
      coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
      expect(acquisition).not.toHaveBeenCalled();
      clock.advanceBy(jitter);
      expect(acquisition).not.toHaveBeenCalled();
      expect(coordinator.pauseForMaintenance(3)).toBe(true);
      await coordinator.drainForMaintenance(3);
      expect(acquisition).not.toHaveBeenCalled();
    } finally {
      repository.dispose();
    }
  });

  it('ignores an old pending-wake callback after resume without replacing the new timer owner', async () => {
    const handle = openDb(join(tempRoot, `${randomUUID()}.db`));
    runWatchMigrations(handle);
    const repository = new WatchRepository(handle);
    const clock = new StickyClock();
    const rule = watchRule(clock.now().toISOString());
    rule.backoffUntil = new Date(1_000).toISOString();
    expect(repository.insertRule(rule)).toEqual({ ok: true });
    const coordinator = makeCoordinator({
      repository,
      clock,
      hostGate: new HostRequestGate({ clock, gapMs: 0 }),
      rule,
      acquisition: async () => ({
        ok: false,
        health: 'unavailable',
        retryable: false,
        retryAfterSeconds: null,
        disposition: 'network',
      }),
    });
    try {
      coordinator.start();
      expect(coordinator.manualRun(rule.id, 'before-maintenance').ok).toBe(true);
      const oldCallback = clock.callbacks.at(-1)!;
      expect(coordinator.pauseForMaintenance(4)).toBe(true);
      await coordinator.drainForMaintenance(4);
      expect(coordinator.prepareResumeAfterMaintenance(4)).toBe(true);
      expect(coordinator.resumeAfterMaintenance(4)).toBe(true);
      expect(coordinator.manualRun(rule.id, 'after-maintenance').ok).toBe(true);
      const callbackCount = clock.callbacks.length;
      oldCallback();
      expect(clock.callbacks.length).toBe(callbackCount);
    } finally {
      await coordinator.stop();
      repository.dispose();
    }
  });

  it('permanent stop shares one promise and waits for the original acquisition leaf to settle', async () => {
    const handle = openDb(join(tempRoot, `${randomUUID()}.db`));
    runWatchMigrations(handle);
    const repository = new WatchRepository(handle);
    const clock = new FakeClock(Date.parse('2026-10-04T00:00:00.000Z'));
    const rule = watchRule(clock.now().toISOString());
    expect(repository.insertRule(rule)).toEqual({ ok: true });
    let release!: (result: WatchAcquisitionResult) => void;
    let entered!: () => void;
    let aborted = false;
    let acquisitionCalls = 0;
    const acquisitionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const coordinator = makeCoordinator({
      repository,
      clock,
      hostGate: new HostRequestGate({ clock, gapMs: 0 }),
      rule,
      acquisition: (input) => {
        acquisitionCalls += 1;
        entered();
        input.signal.addEventListener('abort', () => (aborted = true), { once: true });
        return new Promise<WatchAcquisitionResult>((resolve) => {
          release = resolve;
        });
      },
    });
    try {
      coordinator.start();
      coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
      for (let index = 0; index < 12; index += 1) {
        await Promise.resolve();
        clock.advanceBy(1_000);
      }
      await acquisitionEntered;
      coordinator.beginShutdown();
      coordinator.beginShutdown();
      expect(coordinator.manualRun(rule.id, 'after-begin-shutdown')).toEqual({
        ok: false,
        reason: 'stopped',
      });
      coordinator.handleDue([{ ruleId: rule.id, trigger: 'scheduled' }]);
      await Promise.resolve();
      expect(acquisitionCalls).toBe(1);
      expect(aborted).toBe(false);
      expect(coordinator.pauseForMaintenance(20)).toBe(false);
      expect(coordinator.prepareResumeAfterMaintenance(20)).toBe(false);
      expect(coordinator.resumeAfterMaintenance(20)).toBe(false);
      const first = coordinator.stop();
      expect(coordinator.stop()).toBe(first);
      let settled = false;
      void first.then(() => (settled = true));
      await Promise.resolve();
      expect(aborted).toBe(true);
      expect(settled).toBe(false);
      release({
        ok: false,
        health: 'unavailable',
        retryable: false,
        retryAfterSeconds: null,
        disposition: 'network',
      });
      await first;
      expect(settled).toBe(true);
      expect(coordinator.activeRunCount()).toBe(0);
      expect(coordinator.pendingRunCount()).toBe(0);
    } finally {
      repository.dispose();
    }
  });

  it('beginShutdown permanently blocks a maintenance resume that was already prepared', async () => {
    const handle = openDb(join(tempRoot, `${randomUUID()}.db`));
    runWatchMigrations(handle);
    const repository = new WatchRepository(handle);
    const clock = new FakeClock(Date.parse('2026-10-04T00:00:00.000Z'));
    const rule = watchRule(clock.now().toISOString());
    expect(repository.insertRule(rule)).toEqual({ ok: true });
    const coordinator = makeCoordinator({
      repository,
      clock,
      hostGate: new HostRequestGate({ clock, gapMs: 0 }),
      rule,
      acquisition: async () => ({
        ok: false,
        health: 'unavailable',
        retryable: false,
        retryAfterSeconds: null,
        disposition: 'network',
      }),
    });
    try {
      coordinator.start();
      expect(coordinator.pauseForMaintenance(21)).toBe(true);
      await coordinator.drainForMaintenance(21);
      expect(coordinator.prepareResumeAfterMaintenance(21)).toBe(true);
      coordinator.beginShutdown();
      expect(coordinator.prepareResumeAfterMaintenance(21)).toBe(false);
      expect(coordinator.resumeAfterMaintenance(21)).toBe(false);
      await coordinator.stop();
    } finally {
      repository.dispose();
    }
  });
});
