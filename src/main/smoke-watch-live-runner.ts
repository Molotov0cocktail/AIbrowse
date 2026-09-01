// Sixth Stage D10: bounded live Watch scenario runner.
// Ports are injected so the default smoke remains offline and deterministic.

import {
  classifyWatchLiveFailure,
  validateWatchLiveExecution,
  validateWatchLiveLedger,
  validateWatchLiveManifest,
  WATCH_LIVE_SCENARIO_MANIFEST,
  type WatchLiveLedgerEntry,
  type WatchLiveResourceObservation,
  type WatchLiveResultKind,
  type WatchLiveScenario,
} from './smoke-watch-live';

export interface WatchLivePublicPort {
  run(
    scenario: WatchLiveScenario,
    signal: AbortSignal,
  ): Promise<{
    requestCount: number;
    status?: number;
    httpClass: string;
    errorCode?: string;
  }>;
}

export interface WatchLiveProviderPort {
  credentialAvailable(): boolean | Promise<boolean>;
  runOnce(
    scenario: WatchLiveScenario,
    signal: AbortSignal,
  ): Promise<{
    requestCount: number;
    status?: number;
    httpClass: string;
    errorCode?: string;
    providerState?: string;
  }>;
}

export interface WatchLiveWindowsPort {
  isWindows: boolean;
  isPackaged: boolean;
  probe(
    scenario: WatchLiveScenario,
    signal: AbortSignal,
  ): Promise<{
    httpClass: string;
    classification: 'pass' | 'condition-unavailable' | 'product-defect';
    errorCode?: string;
  }>;
}

export interface WatchResourceMetricSample {
  observedAtMs: number;
  rssBytes: number;
  heapUsedBytes: number;
  cpuUserMicros: number;
  cpuSystemMicros: number;
}

export interface WatchResourceBatterySample {
  observedAtMs: number;
  chargePercent?: number;
  onBatteryPower?: boolean;
}

export interface WatchResourceBatteryObservation {
  status: 'observed' | 'condition-unavailable';
  reason?: string;
  samples: readonly WatchResourceBatterySample[];
}

export interface WatchLiveResourcePort {
  probe(
    scenario: WatchLiveScenario,
    signal: AbortSignal,
  ): Promise<{
    httpClass: string;
    errorCode?: string;
    observedForMs?: number;
    drainStartedAtMs?: number;
    drainEndedAtMs?: number;
    drainObservedForMs?: number;
    residualObservedAtMs?: readonly number[];
    samples?: number;
    residuals?: {
      servers: number;
      timers: number;
      databases: number;
      taskTabs: number;
      children: number;
      tempDirs: number;
    };
    residualTrend?: readonly {
      servers: number;
      timers: number;
      databases: number;
      taskTabs: number;
      children: number;
      tempDirs: number;
    }[];
    resourceMetrics?: WatchResourceMetricSample;
    resourceMetricTrend?: readonly WatchResourceMetricSample[];
    batteryObservation?: WatchResourceBatteryObservation;
  }>;
}

export interface WatchLiveRunnerOptions {
  publicPort?: WatchLivePublicPort;
  providerPort?: WatchLiveProviderPort;
  windowsPort?: WatchLiveWindowsPort;
  resourcePort?: WatchLiveResourcePort;
  manifest?: readonly WatchLiveScenario[];
  signal?: AbortSignal;
}

export interface WatchLiveRunnerReport {
  ok: boolean;
  manifestErrors: string[];
  executionErrors: string[];
  ledgerErrors: string[];
  entries: readonly WatchLiveLedgerEntry[];
}

function makeController(parent: AbortSignal | undefined): AbortController {
  const controller = new AbortController();
  if (parent?.aborted === true) controller.abort(parent.reason);
  else parent?.addEventListener('abort', () => controller.abort(parent.reason), { once: true });
  return controller;
}

function resultKind(input: {
  scenarioKind?: WatchLiveScenario['kind'];
  status?: number;
  errorCode?: string;
  credentialAvailable?: boolean;
  packaged?: boolean;
  windows?: boolean;
}): WatchLiveResultKind {
  return classifyWatchLiveFailure(input);
}

export async function runWatchLiveScenarios(
  options: WatchLiveRunnerOptions = {},
): Promise<WatchLiveRunnerReport> {
  const manifest = options.manifest ?? WATCH_LIVE_SCENARIO_MANIFEST;
  const manifestErrors = validateWatchLiveManifest(manifest);
  if (manifestErrors.length > 0) {
    return { ok: false, manifestErrors, executionErrors: [], ledgerErrors: [], entries: [] };
  }
  const controller = makeController(options.signal);
  const entries: WatchLiveLedgerEntry[] = [];
  for (const scenario of manifest) {
    try {
      if (scenario.kind === 'public-network') {
        if (options.publicPort === undefined) {
          entries.push({
            scenario: scenario.id,
            requestCount: 0,
            resultKind: 'not-run',
            httpClass: '未提供公共网络端口',
            purpose: scenario.purpose,
          });
          continue;
        }
        if (scenario.url === undefined) {
          entries.push({
            scenario: scenario.id,
            requestCount: 0,
            resultKind: 'failed-fixture',
            httpClass: '公网目标缺失',
            purpose: scenario.purpose,
          });
          continue;
        }
        const result = await options.publicPort.run(scenario, controller.signal);
        const resultKindValue: WatchLiveResultKind =
          result.status !== undefined &&
          result.status >= 200 &&
          result.status < 300 &&
          result.requestCount < 1
            ? 'failed-product'
            : resultKind({ ...result, scenarioKind: scenario.kind });
        entries.push({
          scenario: scenario.id,
          requestCount: result.requestCount,
          resultKind: resultKindValue,
          httpClass: result.httpClass,
          purpose: scenario.purpose,
        });
        continue;
      }
      if (scenario.kind === 'provider') {
        if (
          options.providerPort === undefined ||
          !(await Promise.resolve(options.providerPort.credentialAvailable()))
        ) {
          entries.push({
            scenario: scenario.id,
            requestCount: 0,
            resultKind: 'skipped-credential-unavailable',
            httpClass: '凭据不可用',
            purpose: scenario.purpose,
          });
          continue;
        }
        const result = await options.providerPort.runOnce(scenario, controller.signal);
        const providerStateMissingOrFailed =
          result.status !== undefined &&
          result.status >= 200 &&
          result.status < 300 &&
          result.requestCount === scenario.maxRequests &&
          result.providerState !== 'succeeded';
        entries.push({
          scenario: scenario.id,
          requestCount: result.requestCount,
          resultKind: providerStateMissingOrFailed
            ? 'failed-product'
            : resultKind({ ...result, scenarioKind: scenario.kind }),
          httpClass: result.httpClass,
          purpose: scenario.purpose,
        });
        continue;
      }
      if (scenario.kind === 'windows') {
        if (options.windowsPort === undefined) {
          entries.push({
            scenario: scenario.id,
            requestCount: 0,
            resultKind: 'not-run',
            httpClass: '未提供 Windows 端口',
            purpose: scenario.purpose,
            classification: 'condition-unavailable',
          });
        } else if (!options.windowsPort.isWindows) {
          entries.push({
            scenario: scenario.id,
            requestCount: 0,
            resultKind: 'skipped-not-windows',
            httpClass: '非 Windows',
            purpose: scenario.purpose,
            classification: 'condition-unavailable',
          });
        } else if (!options.windowsPort.isPackaged) {
          entries.push({
            scenario: scenario.id,
            requestCount: 0,
            resultKind: 'skipped-not-packaged',
            httpClass: '未打包',
            purpose: scenario.purpose,
            classification: 'condition-unavailable',
          });
        } else {
          const result = await options.windowsPort.probe(scenario, controller.signal);
          entries.push({
            scenario: scenario.id,
            requestCount: 0,
            resultKind:
              result.classification === 'condition-unavailable'
                ? 'skipped-windows-condition'
                : result.classification === 'pass'
                  ? 'pass'
                  : 'failed-product',
            httpClass: result.httpClass,
            purpose: scenario.purpose,
            classification: result.classification,
          });
        }
        continue;
      }
      if (options.resourcePort === undefined) {
        entries.push({
          scenario: scenario.id,
          requestCount: 0,
          resultKind: 'not-run',
          httpClass: '未提供资源端口',
          purpose: scenario.purpose,
        });
      } else {
        const result = await options.resourcePort.probe(scenario, controller.signal);
        const observedForMs = result.observedForMs;
        const sampleCount = result.samples;
        const metricTrend = result.resourceMetricTrend;
        const metricFields = [
          'rssBytes',
          'heapUsedBytes',
          'cpuUserMicros',
          'cpuSystemMicros',
        ] as const;
        const validMetricSample = (sample: WatchResourceMetricSample): boolean =>
          Number.isSafeInteger(sample.observedAtMs) &&
          metricFields.every((field) => Number.isSafeInteger(sample[field]) && sample[field] >= 0);
        const metricTimestampsAreMonotonic =
          metricTrend !== undefined &&
          metricTrend.every(
            (sample, index) =>
              index === 0 || sample.observedAtMs > metricTrend[index - 1]!.observedAtMs,
          );
        const metricSpan =
          metricTrend === undefined || metricTrend.length < 2
            ? undefined
            : metricTrend.at(-1)!.observedAtMs - metricTrend[0]!.observedAtMs;
        const metricTrendKind =
          metricTrend !== undefined && metricTrend.length >= 2
            ? metricFields.some((field) => metricTrend[0]![field] !== metricTrend.at(-1)![field])
              ? 'changed'
              : 'stable'
            : 'stable';
        const battery = result.batteryObservation;
        const batteryTimestampsAreMonotonic =
          battery !== undefined &&
          battery.samples.every(
            (sample, index) =>
              Number.isSafeInteger(sample.observedAtMs) &&
              (index === 0 || sample.observedAtMs > battery.samples[index - 1]!.observedAtMs),
          );
        const batterySamplesHaveValue =
          battery !== undefined &&
          battery.samples.every(
            (sample) =>
              (sample.chargePercent !== undefined &&
                Number.isSafeInteger(sample.chargePercent) &&
                sample.chargePercent >= 0 &&
                sample.chargePercent <= 100) ||
              typeof sample.onBatteryPower === 'boolean',
          );
        const batterySpan =
          battery === undefined || battery.samples.length < 2
            ? undefined
            : battery.samples.at(-1)!.observedAtMs - battery.samples[0]!.observedAtMs;
        const residualTimestampsAreMonotonic =
          result.residualObservedAtMs !== undefined &&
          result.residualObservedAtMs.every(
            (timestamp, index) =>
              Number.isSafeInteger(timestamp) &&
              (index === 0 || timestamp > result.residualObservedAtMs![index - 1]!),
          );
        const residualsAreWellFormed =
          result.residuals !== undefined &&
          result.residualTrend !== undefined &&
          result.residualTrend.length >= 2 &&
          [result.residuals, ...result.residualTrend].every((residuals) =>
            Object.values(residuals).every((value) => Number.isSafeInteger(value) && value >= 0),
          );
        const residualsAreValidAndZero =
          result.residuals !== undefined &&
          result.residualTrend !== undefined &&
          residualsAreWellFormed &&
          [result.residuals, ...result.residualTrend].every((residuals) =>
            Object.values(residuals).every((value) => value === 0),
          );
        const measurementStartedAtMs = metricTrend?.[0]?.observedAtMs;
        const measurementEndedAtMs = metricTrend?.at(-1)?.observedAtMs;
        const batteryStartedAtMs = battery?.samples[0]?.observedAtMs;
        const batteryEndedAtMs = battery?.samples.at(-1)?.observedAtMs;
        const resourceObservation: WatchLiveResourceObservation | undefined =
          Number.isSafeInteger(result.observedForMs) &&
          Number.isSafeInteger(result.drainStartedAtMs) &&
          Number.isSafeInteger(result.drainEndedAtMs) &&
          Number.isSafeInteger(result.drainObservedForMs) &&
          result.residualObservedAtMs !== undefined &&
          result.resourceMetricTrend !== undefined &&
          result.batteryObservation !== undefined
            ? {
                measurementStartedAtMs: result.resourceMetricTrend[0]?.observedAtMs ?? -1,
                measurementEndedAtMs: result.resourceMetricTrend.at(-1)?.observedAtMs ?? -1,
                measurementWindowMs: result.observedForMs!,
                ...(batteryStartedAtMs === undefined
                  ? {}
                  : { batteryStartedAtMs, batteryEndedAtMs }),
                drainStartedAtMs: result.drainStartedAtMs!,
                drainEndedAtMs: result.drainEndedAtMs!,
                drainWindowMs: result.drainObservedForMs!,
                metricSampleCount: result.resourceMetricTrend.length,
                metricTrend: metricTrendKind,
                residualSampleCount: result.residualObservedAtMs.length,
                batteryStatus: result.batteryObservation.status,
                batterySampleCount: result.batteryObservation.samples.length,
                batteryReason: result.batteryObservation.reason,
              }
            : undefined;
        const resourceCoreEvidenceIsWellFormed =
          Number.isSafeInteger(observedForMs) &&
          (observedForMs ?? -1) > 0 &&
          Number.isSafeInteger(sampleCount) &&
          (sampleCount ?? -1) >= 2 &&
          metricTrend !== undefined &&
          metricTrend.length === sampleCount &&
          metricTrend.length >= 2 &&
          metricTimestampsAreMonotonic &&
          metricSpan === observedForMs &&
          measurementStartedAtMs !== undefined &&
          measurementEndedAtMs !== undefined &&
          result.resourceMetrics !== undefined &&
          validMetricSample(result.resourceMetrics) &&
          validMetricSample(metricTrend[0]!) &&
          validMetricSample(metricTrend.at(-1)!) &&
          metricTrendKind === 'changed' &&
          Number.isSafeInteger(result.drainStartedAtMs) &&
          Number.isSafeInteger(result.drainEndedAtMs) &&
          Number.isSafeInteger(result.drainObservedForMs) &&
          measurementEndedAtMs <= result.drainStartedAtMs! &&
          result.drainEndedAtMs! >= result.drainStartedAtMs! &&
          result.drainObservedForMs === result.drainEndedAtMs! - result.drainStartedAtMs! &&
          result.drainObservedForMs! >= 0 &&
          result.residualObservedAtMs !== undefined &&
          result.residualObservedAtMs.length === result.residualTrend?.length &&
          result.residualObservedAtMs.length >= 2 &&
          residualTimestampsAreMonotonic &&
          result.residualObservedAtMs.every(
            (timestamp) =>
              timestamp >= result.drainStartedAtMs! && timestamp <= result.drainEndedAtMs!,
          ) &&
          result.residuals !== undefined &&
          result.residualTrend !== undefined &&
          result.residualTrend.length >= 2 &&
          residualsAreWellFormed &&
          [result.resourceMetrics, ...metricTrend].every((metrics) =>
            Object.values(metrics).every((value) => Number.isSafeInteger(value) && value >= 0),
          ) &&
          [result.resourceMetrics, ...metricTrend].some((metrics) =>
            metricFields.some((field) => metrics[field] > 0),
          ) &&
          resourceObservation !== undefined;
        const batteryEvidenceIsWellFormed =
          battery?.status === 'condition-unavailable'
            ? battery.reason !== undefined && battery.reason.trim() !== ''
            : battery?.status === 'observed' &&
              battery.samples.length >= 2 &&
              batteryTimestampsAreMonotonic &&
              batteryStartedAtMs !== undefined &&
              batteryEndedAtMs !== undefined &&
              batteryStartedAtMs >= measurementStartedAtMs! &&
              batteryEndedAtMs <= measurementEndedAtMs! &&
              batterySamplesHaveValue &&
              (batterySpan ?? -1) === metricSpan;
        const resourceEvidenceIsWellFormed =
          resourceCoreEvidenceIsWellFormed && batteryEvidenceIsWellFormed;
        const noResourceEvidence =
          result.observedForMs === undefined &&
          result.residuals === undefined &&
          result.resourceMetricTrend === undefined &&
          result.batteryObservation === undefined;
        entries.push({
          scenario: scenario.id,
          requestCount: 0,
          resultKind:
            !residualsAreValidAndZero && !noResourceEvidence
              ? 'failed-product'
              : noResourceEvidence && result.errorCode === 'not-run'
                ? 'not-run'
                : resourceEvidenceIsWellFormed
                  ? 'not-run'
                  : 'failed-product',
          httpClass: result.httpClass,
          purpose: scenario.purpose,
          resourceObservation,
        });
      }
    } catch {
      const failureKind =
        scenario.kind === 'public-network'
          ? 'failed-network'
          : scenario.kind === 'provider'
            ? 'failed-provider'
            : 'failed-product';
      entries.push({
        scenario: scenario.id,
        requestCount: 0,
        resultKind: failureKind,
        httpClass: 'runner exception',
        purpose: scenario.purpose,
      });
    }
  }
  const executionErrors = validateWatchLiveExecution(
    manifest,
    entries.map((entry) => entry.scenario),
  );
  const ledgerErrors = validateWatchLiveLedger(entries, manifest);
  return {
    ok: executionErrors.length === 0 && ledgerErrors.length === 0,
    manifestErrors,
    executionErrors,
    ledgerErrors,
    entries,
  };
}
