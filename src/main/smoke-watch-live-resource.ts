// Sixth Stage D10: live resource probe over product-owned Watch resources.
// The probe owns each temporary resource, observes its actual registry state,
// and reports only after the bounded cleanup window has elapsed.

import type {
  WatchLiveResourcePort,
  WatchResourceBatteryObservation,
  WatchResourceBatterySample,
  WatchResourceMetricSample,
} from './smoke-watch-live-runner';
import type { WatchTaskTabWorkspace } from './watch/watch-task-tab-workspace';

const RESOURCE_SAMPLE_INTERVAL_MS = 100;

export interface ProductWatchResourceTiming {
  monotonicNow: () => number;
  utcNow: () => Date;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const DEFAULT_RESOURCE_TIMING: ProductWatchResourceTiming = {
  monotonicNow: () => performance.now(),
  utcNow: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface MonotonicProbeClock {
  elapsedMs: () => number;
  read: () => { rawMs: number; elapsedMs: number };
}

function createMonotonicProbeClock(timing: ProductWatchResourceTiming): MonotonicProbeClock {
  let origin: number | undefined;
  let previous: number | undefined;
  const read = (): { rawMs: number; elapsedMs: number } => {
    const current = timing.monotonicNow();
    if (
      !Number.isFinite(current) ||
      current < 0 ||
      current > Number.MAX_SAFE_INTEGER ||
      (previous !== undefined && current < previous)
    ) {
      throw new Error('resource probe monotonic clock invalid');
    }
    previous = current;
    origin ??= current;
    const elapsed = Math.floor(current - origin);
    if (!Number.isSafeInteger(elapsed) || elapsed < 0) {
      throw new Error('resource probe monotonic elapsed invalid');
    }
    return { rawMs: current, elapsedMs: elapsed };
  };
  return {
    read,
    elapsedMs: () => read().elapsedMs,
  };
}

function wait(
  ms: number,
  signal: AbortSignal,
  clock: MonotonicProbeClock,
  timing: ProductWatchResourceTiming,
): Promise<void> {
  let startedAt: { rawMs: number; elapsedMs: number };
  try {
    startedAt = clock.read();
  } catch (error) {
    return Promise.reject(error);
  }
  const rawDeadline = startedAt.rawMs + ms;
  const publishedDeadline = startedAt.elapsedMs + ms;
  if (
    !Number.isFinite(rawDeadline) ||
    rawDeadline > Number.MAX_SAFE_INTEGER ||
    rawDeadline <= startedAt.rawMs ||
    !Number.isSafeInteger(publishedDeadline) ||
    publishedDeadline <= startedAt.elapsedMs
  ) {
    return Promise.reject(new Error('resource probe deadline invalid'));
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('resource probe aborted'));
      return;
    }
    let settled = false;
    let timer: unknown;
    const cleanup = (): void => {
      let cleanupError: unknown;
      const activeTimer = timer;
      timer = undefined;
      if (activeTimer !== undefined) {
        try {
          timing.clearTimeout(activeTimer);
        } catch (error) {
          cleanupError = error;
        }
      }
      try {
        signal.removeEventListener('abort', onAbort);
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError !== undefined) throw cleanupError;
    };
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      try {
        cleanup();
      } catch (cleanupError) {
        reject(cleanupError);
        return;
      }
      if (error === undefined) resolve();
      else reject(error);
    };
    function onAbort(): void {
      settle(new Error('resource probe aborted'));
    }
    const schedule = (delayMs: number): void => {
      try {
        timer = timing.setTimeout(onTimer, Math.ceil(delayMs));
      } catch (error) {
        settle(error);
      }
    };
    function onTimer(): void {
      if (settled) return;
      timer = undefined;
      try {
        const current = clock.read();
        const rawRemainingMs = rawDeadline - current.rawMs;
        const publishedRemainingMs = publishedDeadline - current.elapsedMs;
        if (rawRemainingMs > 0 || publishedRemainingMs > 0) {
          schedule(Math.max(rawRemainingMs, publishedRemainingMs));
          return;
        }
        settle();
      } catch (error) {
        settle(error);
      }
    }
    try {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      schedule(ms);
    } catch (error) {
      settle(error);
    }
  });
}

export interface ProductWatchRuntimeResourceProbe {
  isAvailable: () => boolean;
  metrics: () => Omit<WatchResourceMetricSample, 'observedAtMs'>;
  battery?: () =>
    | { status: 'observed'; chargePercent?: number; onBatteryPower?: boolean }
    | { status: 'condition-unavailable'; reason: string };
  shutdown: () => Promise<void>;
  residuals: () => {
    servers: number;
    timers: number;
    databases: number;
    taskTabs: number;
    children: number;
    tempDirs: number;
  };
}

export function createProductWatchResourcePort(
  _workspace: WatchTaskTabWorkspace | null,
  runtime?: ProductWatchRuntimeResourceProbe,
  timing: ProductWatchResourceTiming = DEFAULT_RESOURCE_TIMING,
): WatchLiveResourcePort {
  return {
    async probe(_scenario, signal) {
      if (runtime === undefined) {
        return {
          httpClass: '缺少 Watch 生产运行时观察器，真实资源场景未运行',
          errorCode: 'not-run',
        };
      }
      if (!runtime.isAvailable()) {
        return {
          httpClass: 'Watch 生产运行时不可用',
          errorCode: 'product-defect',
          residuals: runtime.residuals(),
        };
      }
      try {
        const clock = createMonotonicProbeClock(timing);
        let previousUtcMs: number | undefined;
        let wallClockRollbackObserved = false;
        const readUtc = (): string => {
          const reading = timing.utcNow();
          if (!(reading instanceof Date) || !Number.isFinite(reading.getTime())) {
            throw new Error('resource probe UTC clock invalid');
          }
          const readingMs = reading.getTime();
          if (previousUtcMs !== undefined && readingMs < previousUtcMs) {
            wallClockRollbackObserved = true;
          }
          previousUtcMs = readingMs;
          return reading.toISOString();
        };
        const metricObservedAtUtc: string[] = [];
        const sampleMetrics = (): WatchResourceMetricSample => {
          const observedAtMs = clock.elapsedMs();
          metricObservedAtUtc.push(readUtc());
          return {
            observedAtMs,
            ...runtime.metrics(),
          };
        };
        const resourceMetricTrend: WatchResourceMetricSample[] = [sampleMetrics()];
        const measurementStartedAtMs = resourceMetricTrend[0].observedAtMs;
        const batterySamples: WatchResourceBatterySample[] = [];
        const batteryObservedAtUtc: string[] = [];
        let batteryStatus: WatchResourceBatteryObservation['status'] = 'condition-unavailable';
        let batteryReason = '生产运行时未提供电池采样接口';
        const sampleBattery = (observedAtMs: number, observedAtUtc: string): void => {
          const reading = runtime.battery?.();
          if (reading === undefined) return;
          if (reading.status === 'condition-unavailable') {
            batteryReason = reading.reason;
            return;
          }
          batteryStatus = 'observed';
          batterySamples.push({
            observedAtMs,
            chargePercent: reading.chargePercent,
            onBatteryPower: reading.onBatteryPower,
          });
          batteryObservedAtUtc.push(observedAtUtc);
        };
        sampleBattery(resourceMetricTrend[0].observedAtMs, metricObservedAtUtc[0]!);
        await wait(RESOURCE_SAMPLE_INTERVAL_MS, signal, clock, timing);
        resourceMetricTrend.push(sampleMetrics());
        sampleBattery(resourceMetricTrend[1].observedAtMs, metricObservedAtUtc[1]!);
        const measurementEndedAtMs = resourceMetricTrend.at(-1)!.observedAtMs;
        const drainStartedAtMs = clock.elapsedMs();
        const drainStartedAtUtc = readUtc();
        await runtime.shutdown();
        const residualObservedAtMs: number[] = [];
        const residualObservedAtUtc: string[] = [];
        const residualTrend: ReturnType<ProductWatchRuntimeResourceProbe['residuals']>[] = [];
        for (let index = 0; index < 3; index += 1) {
          if (index > 0) await wait(RESOURCE_SAMPLE_INTERVAL_MS, signal, clock, timing);
          residualObservedAtMs.push(clock.elapsedMs());
          residualObservedAtUtc.push(readUtc());
          residualTrend.push(runtime.residuals());
        }
        const drainEndedAtMs = residualObservedAtMs.at(-1)!;
        const batteryObservation: WatchResourceBatteryObservation = {
          status: batteryStatus,
          reason: batteryStatus === 'condition-unavailable' ? batteryReason : undefined,
          samples: batterySamples,
        };
        return {
          httpClass: 'Watch 生产运行时排水后资源指标与残留有界观察完成',
          errorCode:
            batteryObservation.status === 'condition-unavailable'
              ? 'condition-unavailable'
              : 'observation-insufficient',
          observedForMs: measurementEndedAtMs - measurementStartedAtMs,
          drainStartedAtMs,
          drainEndedAtMs,
          drainObservedForMs: drainEndedAtMs - drainStartedAtMs,
          residualObservedAtMs,
          samples: resourceMetricTrend.length,
          residuals: residualTrend.at(-1),
          residualTrend,
          resourceMetrics: resourceMetricTrend.at(-1),
          resourceMetricTrend,
          batteryObservation,
          clockAudit: {
            metricObservedAtUtc,
            batteryObservedAtUtc,
            drainStartedAtUtc,
            residualObservedAtUtc,
            wallClockRollbackObserved,
          },
        };
      } catch {
        return {
          httpClass: 'Watch 生产运行时资源观察/排水失败',
          errorCode: 'product-defect',
          residuals: runtime.residuals(),
        };
      }
    },
  };
}
