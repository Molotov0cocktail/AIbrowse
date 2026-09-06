import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  createProductWatchResourcePort,
  type ProductWatchResourceTiming,
  type ProductWatchRuntimeResourceProbe,
} from './smoke-watch-live-resource';
import { runWatchLiveScenarios, type WatchLiveResourcePort } from './smoke-watch-live-runner';
import { validateWatchLiveLedger, WATCH_LIVE_SCENARIO_MANIFEST } from './smoke-watch-live';

interface ControlledTimer {
  active: boolean;
  callback: () => void;
  delayMs: number;
}

class ControlledResourceTiming implements ProductWatchResourceTiming {
  monotonicMs = 0;
  readonly scheduled: ControlledTimer[] = [];
  readonly firedCallbacks: Array<() => void> = [];
  throwOnSet = false;
  throwOnClear = false;
  private readonly utcReadings: Date[];

  constructor(utcReadings: readonly number[] = [1_000, 1_100, 1_100, 1_100, 1_200, 1_300]) {
    this.utcReadings = utcReadings.map((value) => new Date(value));
  }

  monotonicNow = (): number => this.monotonicMs;

  utcNow = (): Date => {
    const reading = this.utcReadings.shift();
    return reading === undefined ? new Date(Number.NaN) : new Date(reading.getTime());
  };

  setTimeout = (callback: () => void, delayMs: number): unknown => {
    if (this.throwOnSet) throw new Error('timer set failed');
    const timer = { active: true, callback, delayMs };
    this.scheduled.push(timer);
    return timer;
  };

  clearTimeout = (handle: unknown): void => {
    const timer = handle as ControlledTimer;
    timer.active = false;
    if (this.throwOnClear) throw new Error('timer clear failed');
  };

  get pendingTimerCount(): number {
    return this.scheduled.filter((timer) => timer.active).length;
  }

  get requestedDelays(): number[] {
    return this.scheduled.map((timer) => timer.delayMs);
  }

  fireNextAt(monotonicMs: number): () => void {
    this.monotonicMs = monotonicMs;
    const timer = this.scheduled.find((candidate) => candidate.active);
    if (timer === undefined) throw new Error('no active timer');
    timer.active = false;
    this.firedCallbacks.push(timer.callback);
    timer.callback();
    return timer.callback;
  }
}

function createRuntime(
  options: {
    shutdown?: () => Promise<void>;
    battery?: ProductWatchRuntimeResourceProbe['battery'];
  } = {},
): {
  runtime: ProductWatchRuntimeResourceProbe;
  calls: { metrics: number; residuals: number; shutdown: number };
} {
  const calls = { metrics: 0, residuals: 0, shutdown: 0 };
  return {
    calls,
    runtime: {
      isAvailable: () => true,
      metrics: () => {
        calls.metrics += 1;
        return {
          rssBytes: 10 + calls.metrics,
          heapUsedBytes: 20 + calls.metrics,
          cpuUserMicros: 30 + calls.metrics,
          cpuSystemMicros: 40 + calls.metrics,
        };
      },
      battery:
        options.battery ??
        (() => ({
          status: 'observed' as const,
          chargePercent: calls.metrics === 1 ? 80 : 79,
          onBatteryPower: calls.metrics !== 1,
        })),
      shutdown: async () => {
        calls.shutdown += 1;
        await options.shutdown?.();
      },
      residuals: () => {
        calls.residuals += 1;
        return { servers: 0, timers: 0, databases: 0, taskTabs: 0, children: 0, tempDirs: 0 };
      },
    },
  };
}

const RESOURCE_SCENARIO = WATCH_LIVE_SCENARIO_MANIFEST.find(
  (scenario) => scenario.kind === 'resource',
)!;

function startProbe(
  timing: ControlledResourceTiming,
  runtime: ProductWatchRuntimeResourceProbe,
  signal: AbortSignal = new AbortController().signal,
) {
  return createProductWatchResourcePort(null, runtime, timing).probe(RESOURCE_SCENARIO, signal);
}

async function flushAsyncContinuation(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

async function fireTimers(
  timing: ControlledResourceTiming,
  samples: readonly number[],
): Promise<void> {
  for (const sample of samples) {
    timing.fireNextAt(sample);
    await flushAsyncContinuation();
  }
}

async function completeProbe(
  timing: ControlledResourceTiming,
  pending: ReturnType<typeof startProbe>,
  samples: readonly [number, number, number] = [100, 200, 300],
) {
  await fireTimers(timing, samples);
  return pending;
}

describe('D10 H2 production Watch resource timing', () => {
  it.each([99, 99.999])(
    'does not sample or shut down after an early %dms timer wake',
    async (early) => {
      const timing = new ControlledResourceTiming();
      const { runtime, calls } = createRuntime();
      const controller = new AbortController();
      const pending = startProbe(timing, runtime, controller.signal);

      expect(calls).toMatchObject({ metrics: 1, shutdown: 0 });
      expect(timing.pendingTimerCount).toBe(1);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

      timing.fireNextAt(early);
      await flushAsyncContinuation();
      expect(calls).toMatchObject({ metrics: 1, shutdown: 0 });
      expect(timing.pendingTimerCount).toBe(1);
      expect(timing.requestedDelays).toEqual([100, 1]);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

      timing.fireNextAt(100);
      await flushAsyncContinuation();
      expect(calls).toMatchObject({ metrics: 2, shutdown: 1, residuals: 1 });
      await fireTimers(timing, [200, 300]);
      const result = await pending;
      expect(result.observedForMs).toBe(100);
    },
  );

  it('waits past a fractional raw deadline until the published window reaches 100ms', async () => {
    const timing = new ControlledResourceTiming();
    timing.monotonicMs = 123.45;
    const { runtime, calls } = createRuntime();
    const pending = startProbe(timing, runtime);

    timing.fireNextAt(223.45);
    await flushAsyncContinuation();
    expect(calls).toMatchObject({ metrics: 1, shutdown: 0 });
    expect(timing.pendingTimerCount).toBe(1);
    expect(timing.requestedDelays).toEqual([100, 1]);

    timing.fireNextAt(224.45);
    await flushAsyncContinuation();
    expect(calls).toMatchObject({ metrics: 2, shutdown: 1, residuals: 1 });
    await fireTimers(timing, [324.45, 424.45]);
    const result = await pending;

    expect(result.observedForMs).toBeGreaterThanOrEqual(100);
    expect(result.resourceMetricTrend?.map((sample) => sample.observedAtMs)).toEqual([0, 100]);
    expect(result.drainStartedAtMs).toBe(100);
    expect(result.residualObservedAtMs).toEqual([100, 201, 301]);
    expect(result.drainObservedForMs).toBe(201);
  });

  it('records the actual monotonic span when a timer wakes late', async () => {
    const timing = new ControlledResourceTiming();
    const { runtime } = createRuntime();
    const pending = startProbe(timing, runtime);

    await fireTimers(timing, [137.75, 237.75, 337.75]);
    const result = await pending;

    expect(result.observedForMs).toBe(137);
    expect(result.resourceMetricTrend?.map((sample) => sample.observedAtMs)).toEqual([0, 137]);
  });

  it.each([
    { name: 'rollback', utc: [1_000, 900, 800, 700, 600, 500], rollback: true },
    {
      name: 'jump forward',
      utc: [1_000, 9_000, 10_000, 11_000, 12_000, 13_000],
      rollback: false,
    },
    {
      name: 'static',
      utc: [1_000, 1_000, 1_000, 1_000, 1_000, 1_000],
      rollback: false,
    },
  ])('keeps durations monotonic across a UTC $name', async ({ utc, rollback }) => {
    const timing = new ControlledResourceTiming(utc);
    const { runtime } = createRuntime();
    const result = await completeProbe(timing, startProbe(timing, runtime));

    expect(result.observedForMs).toBe(100);
    expect(result.drainObservedForMs).toBe(200);
    expect(result.clockAudit?.wallClockRollbackObserved).toBe(rollback);
    expect(result.clockAudit?.metricObservedAtUtc).toEqual(
      utc.slice(0, 2).map((value) => new Date(value).toISOString()),
    );
    expect(result.clockAudit?.batteryObservedAtUtc).toEqual(
      utc.slice(0, 2).map((value) => new Date(value).toISOString()),
    );
  });

  it('attributes a controlled shutdown delay only to the drain window', async () => {
    let releaseShutdown: (() => void) | undefined;
    const timing = new ControlledResourceTiming();
    const { runtime, calls } = createRuntime({
      shutdown: () =>
        new Promise<void>((resolve) => {
          releaseShutdown = resolve;
        }),
    });
    const pending = startProbe(timing, runtime);

    timing.fireNextAt(100);
    await flushAsyncContinuation();
    expect(calls).toMatchObject({ metrics: 2, shutdown: 1, residuals: 0 });
    expect(timing.pendingTimerCount).toBe(0);

    timing.monotonicMs = 250;
    releaseShutdown!();
    await flushAsyncContinuation();
    expect(calls.residuals).toBe(1);
    await fireTimers(timing, [350, 450]);
    const result = await pending;

    expect(result.observedForMs).toBe(100);
    expect(result.drainStartedAtMs).toBe(100);
    expect(result.residualObservedAtMs).toEqual([250, 350, 450]);
    expect(result.drainObservedForMs).toBe(350);
    expect(calls.shutdown).toBe(1);
  });

  it('does not retain a timer or listener for an initially aborted signal', async () => {
    const timing = new ControlledResourceTiming();
    const { runtime, calls } = createRuntime();
    const controller = new AbortController();
    controller.abort('initial');

    const result = await startProbe(timing, runtime, controller.signal);

    expect(result.errorCode).toBe('product-defect');
    expect(calls).toMatchObject({ metrics: 1, shutdown: 0 });
    expect(timing.pendingTimerCount).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('cleans a pending wait and ignores its late callback after abort', async () => {
    const timing = new ControlledResourceTiming();
    const { runtime, calls } = createRuntime();
    const controller = new AbortController();
    const pending = startProbe(timing, runtime, controller.signal);
    const callback = timing.scheduled[0]!.callback;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

    controller.abort('waiting');
    const result = await pending;
    callback();
    await flushAsyncContinuation();

    expect(result.errorCode).toBe('product-defect');
    expect(calls).toMatchObject({ metrics: 1, shutdown: 0 });
    expect(timing.pendingTimerCount).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('keeps one listener across early wakes and cleans it on abort', async () => {
    const timing = new ControlledResourceTiming();
    const { runtime, calls } = createRuntime();
    const controller = new AbortController();
    const pending = startProbe(timing, runtime, controller.signal);

    const earlyCallback = timing.fireNextAt(99);
    await flushAsyncContinuation();
    const replacementCallback = timing.scheduled.find((timer) => timer.active)!.callback;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

    controller.abort('after-early-wake');
    const result = await pending;
    earlyCallback();
    replacementCallback();
    await flushAsyncContinuation();

    expect(result.errorCode).toBe('product-defect');
    expect(calls).toMatchObject({ metrics: 1, shutdown: 0 });
    expect(timing.pendingTimerCount).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('cleans successful waits and ignores abort and timer callbacks after completion', async () => {
    const timing = new ControlledResourceTiming();
    const { runtime, calls } = createRuntime();
    const controller = new AbortController();
    const pending = startProbe(timing, runtime, controller.signal);
    const result = await completeProbe(timing, pending);
    const callsAfterSuccess = { ...calls };

    controller.abort('after-success');
    for (const callback of timing.firedCallbacks) callback();
    await flushAsyncContinuation();

    expect(result.errorCode).toBe('observation-insufficient');
    expect(calls).toEqual(callsAfterSuccess);
    expect(calls).toEqual({ metrics: 2, residuals: 3, shutdown: 1 });
    expect(timing.pendingTimerCount).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it.each([
    { name: 'non-finite', initial: Number.NaN, metricCalls: 0 },
    { name: 'out-of-range', initial: Number.MAX_SAFE_INTEGER + 1, metricCalls: 0 },
    { name: 'deadline overflow', initial: Number.MAX_SAFE_INTEGER - 50, metricCalls: 1 },
  ])('fails closed for a $name monotonic source', async ({ initial, metricCalls }) => {
    const timing = new ControlledResourceTiming();
    timing.monotonicMs = initial;
    const { runtime, calls } = createRuntime();

    const result = await startProbe(timing, runtime);

    expect(result.errorCode).toBe('product-defect');
    expect(calls.metrics).toBe(metricCalls);
    expect(timing.pendingTimerCount).toBe(0);
  });

  it('fails closed when the monotonic source moves backward while waiting', async () => {
    const timing = new ControlledResourceTiming();
    const { runtime, calls } = createRuntime();
    const controller = new AbortController();
    const pending = startProbe(timing, runtime, controller.signal);

    timing.fireNextAt(-1);
    const result = await pending;

    expect(result.errorCode).toBe('product-defect');
    expect(calls).toMatchObject({ metrics: 1, shutdown: 0 });
    expect(timing.pendingTimerCount).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it.each(['set', 'clear'] as const)(
    'contains a timer %s failure and removes the listener',
    async (failure) => {
      const timing = new ControlledResourceTiming();
      timing.throwOnSet = failure === 'set';
      timing.throwOnClear = failure === 'clear';
      const { runtime } = createRuntime();
      const controller = new AbortController();
      const pending = startProbe(timing, runtime, controller.signal);
      if (failure === 'clear') controller.abort('clear-failure');

      const result = await pending;

      expect(result.errorCode).toBe('product-defect');
      expect(timing.pendingTimerCount).toBe(0);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    },
  );

  it('fails closed for invalid UTC without consulting it for elapsed time', async () => {
    const timing = new ControlledResourceTiming([Number.NaN]);
    const { runtime, calls } = createRuntime();

    const result = await startProbe(timing, runtime);

    expect(result.errorCode).toBe('product-defect');
    expect(calls.metrics).toBe(0);
    expect(timing.pendingTimerCount).toBe(0);
  });

  it('preserves UTC audit through the actual resource port, runner, and ledger', async () => {
    const timing = new ControlledResourceTiming([1_000, 900, 900, 900, 1_000, 1_100]);
    const { runtime } = createRuntime();
    const resourcePort = createProductWatchResourcePort(null, runtime, timing);
    const pendingReport = runWatchLiveScenarios({ manifest: [RESOURCE_SCENARIO], resourcePort });

    await fireTimers(timing, [100, 200, 300]);
    const report = await pendingReport;

    expect(report.entries[0]).toMatchObject({
      resultKind: 'not-run',
      resourceObservation: {
        measurementWindowMs: 100,
        drainWindowMs: 200,
        clockAudit: {
          metricObservedAtUtc: ['1970-01-01T00:00:01.000Z', '1970-01-01T00:00:00.900Z'],
          wallClockRollbackObserved: true,
        },
      },
    });
    expect(report.ledgerErrors).toEqual(['wl-resource-probe：真实场景未实际运行']);
  });

  it.each([
    {
      name: 'missing UTC audit',
      change: (result: Awaited<ReturnType<WatchLiveResourcePort['probe']>>) => ({
        ...result,
        clockAudit: undefined,
      }),
    },
    {
      name: 'non-canonical UTC',
      change: (result: Awaited<ReturnType<WatchLiveResourcePort['probe']>>) => ({
        ...result,
        clockAudit: {
          ...result.clockAudit!,
          metricObservedAtUtc: ['2026-09-06T00:00:00Z', '2026-09-06T00:00:00.100Z'],
        },
      }),
    },
    {
      name: 'UTC sample count mismatch',
      change: (result: Awaited<ReturnType<WatchLiveResourcePort['probe']>>) => ({
        ...result,
        clockAudit: {
          ...result.clockAudit!,
          residualObservedAtUtc: result.clockAudit!.residualObservedAtUtc.slice(1),
        },
      }),
    },
  ])('rejects $name as complete resource evidence', async ({ change }) => {
    const timing = new ControlledResourceTiming();
    const { runtime } = createRuntime();
    const validResult = await completeProbe(timing, startProbe(timing, runtime));
    const report = await runWatchLiveScenarios({
      manifest: [RESOURCE_SCENARIO],
      resourcePort: { probe: async () => change(validResult) },
    });

    expect(report.entries[0]?.resultKind).toBe('failed-product');
    expect(report.ledgerErrors).toContain('wl-resource-probe：产品路径失败，不得报告 live PASS');
  });

  it('makes the ledger reject an invalid UTC audit even when other evidence is complete', async () => {
    const timing = new ControlledResourceTiming();
    const { runtime } = createRuntime();
    const validResult = await completeProbe(timing, startProbe(timing, runtime));
    const report = await runWatchLiveScenarios({
      manifest: [RESOURCE_SCENARIO],
      resourcePort: { probe: async () => validResult },
    });
    const observation = report.entries[0]!.resourceObservation!;
    const errors = validateWatchLiveLedger([
      {
        ...report.entries[0]!,
        resultKind: 'pass',
        resourceObservation: {
          ...observation,
          clockAudit: { ...observation.clockAudit, wallClockRollbackObserved: true },
        },
      },
    ]);

    expect(errors).toContain('wl-resource-probe：资源观察证据不完整或不可信');
  });
});
