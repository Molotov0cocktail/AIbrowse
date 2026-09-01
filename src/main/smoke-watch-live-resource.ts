// Sixth Stage D10: live resource probe over product-owned Watch resources.
// The probe owns each temporary resource, observes its actual registry state,
// and reports only after the bounded cleanup window has elapsed.

import type { WatchLiveResourcePort, WatchResourceMetricSample } from './smoke-watch-live-runner';
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
  metrics: () => WatchResourceMetricSample;
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
      const observedAt = Date.now();
      try {
        const resourceMetricTrend: WatchResourceMetricSample[] = [runtime.metrics()];
        await wait(100, signal);
        resourceMetricTrend.push(runtime.metrics());
        await runtime.shutdown();
        const samples = 3;
        const residualTrend: ReturnType<ProductWatchRuntimeResourceProbe['residuals']>[] = [];
        for (let index = 0; index < samples; index += 1) {
          if (index > 0) await wait(100, signal);
          residualTrend.push(runtime.residuals());
        }
        return {
          httpClass: 'Watch 生产运行时排水后资源指标与残留有界观察完成',
          observedForMs: Date.now() - observedAt,
          samples,
          residuals: residualTrend.at(-1),
          residualTrend,
          resourceMetrics: resourceMetricTrend.at(-1),
          resourceMetricTrend,
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
