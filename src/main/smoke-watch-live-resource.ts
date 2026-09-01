// Sixth Stage D10: live resource probe over product-owned Watch resources.
// The probe owns each temporary resource, observes its actual registry state,
// and reports only after the bounded cleanup window has elapsed.

import type {
  WatchLiveResourcePort,
  WatchResourceBatteryObservation,
  WatchResourceMetricSample,
} from './smoke-watch-live-runner';
import { MIN_LIVE_RESOURCE_OBSERVATION_MS } from './smoke-watch-live-runner';
import type { WatchTaskTabWorkspace } from './watch/watch-task-tab-workspace';

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('resource probe aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('resource probe aborted'));
      },
      { once: true },
    );
  });
}

export interface ProductWatchRuntimeResourceProbe {
  isAvailable: () => boolean;
  metrics: () => Omit<WatchResourceMetricSample, 'observedAtMs'>;
  battery?: () => WatchResourceBatteryObservation;
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
        const sampleMetrics = (): WatchResourceMetricSample => ({
          observedAtMs: Date.now(),
          ...runtime.metrics(),
        });
        const resourceMetricTrend: WatchResourceMetricSample[] = [sampleMetrics()];
        const measurementStartedAtMs = resourceMetricTrend[0].observedAtMs;
        await wait(MIN_LIVE_RESOURCE_OBSERVATION_MS, signal);
        resourceMetricTrend.push(sampleMetrics());
        const measurementEndedAtMs = resourceMetricTrend.at(-1)!.observedAtMs;
        const drainStartedAtMs = Date.now();
        await runtime.shutdown();
        const residualObservedAtMs: number[] = [];
        const residualTrend: ReturnType<ProductWatchRuntimeResourceProbe['residuals']>[] = [];
        for (let index = 0; index < 3; index += 1) {
          if (index > 0) await wait(100, signal);
          residualObservedAtMs.push(Date.now());
          residualTrend.push(runtime.residuals());
        }
        const drainEndedAtMs = residualObservedAtMs.at(-1)!;
        const batteryObservation =
          runtime.battery?.() ??
          ({
            status: 'condition-unavailable',
            reason: '生产运行时未提供电池采样接口',
            samples: [],
          } satisfies WatchResourceBatteryObservation);
        return {
          httpClass: 'Watch 生产运行时排水后资源指标与残留有界观察完成',
          errorCode:
            batteryObservation.status === 'condition-unavailable'
              ? 'condition-unavailable'
              : undefined,
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
