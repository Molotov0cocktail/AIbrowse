// Sixth Stage D10: bounded live Watch scenario runner.
// Ports are injected so the default smoke remains offline and deterministic.

import {
  classifyWatchLiveFailure,
  validateWatchLiveExecution,
  validateWatchLiveLedger,
  validateWatchLiveManifest,
  WATCH_LIVE_SCENARIO_MANIFEST,
  type WatchLiveLedgerEntry,
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
  credentialAvailable(): boolean;
  runOnce(
    scenario: WatchLiveScenario,
    signal: AbortSignal,
  ): Promise<{
    requestCount: number;
    status?: number;
    httpClass: string;
    errorCode?: string;
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
    errorCode?: string;
  }>;
}

export interface WatchLiveResourcePort {
  probe(
    scenario: WatchLiveScenario,
    signal: AbortSignal,
  ): Promise<{
    httpClass: string;
    errorCode?: string;
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
        const result = await options.publicPort.run(scenario, controller.signal);
        entries.push({
          scenario: scenario.id,
          requestCount: result.requestCount,
          resultKind: resultKind(result),
          httpClass: result.httpClass,
          purpose: scenario.purpose,
        });
        continue;
      }
      if (scenario.kind === 'provider') {
        if (options.providerPort === undefined || !options.providerPort.credentialAvailable()) {
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
        entries.push({
          scenario: scenario.id,
          requestCount: result.requestCount,
          resultKind: resultKind(result),
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
          });
        } else if (!options.windowsPort.isWindows) {
          entries.push({
            scenario: scenario.id,
            requestCount: 0,
            resultKind: 'skipped-not-windows',
            httpClass: '非 Windows',
            purpose: scenario.purpose,
          });
        } else if (!options.windowsPort.isPackaged) {
          entries.push({
            scenario: scenario.id,
            requestCount: 0,
            resultKind: 'skipped-not-packaged',
            httpClass: '未打包',
            purpose: scenario.purpose,
          });
        } else {
          const result = await options.windowsPort.probe(scenario, controller.signal);
          entries.push({
            scenario: scenario.id,
            requestCount: 0,
            resultKind: resultKind({
              status: result.errorCode === undefined ? 200 : undefined,
              errorCode: result.errorCode,
            }),
            httpClass: result.httpClass,
            purpose: scenario.purpose,
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
        entries.push({
          scenario: scenario.id,
          requestCount: 0,
          resultKind: resultKind({
            status: result.errorCode === undefined ? 200 : undefined,
            errorCode: result.errorCode,
          }),
          httpClass: result.httpClass,
          purpose: scenario.purpose,
        });
      }
    } catch {
      entries.push({
        scenario: scenario.id,
        requestCount: 0,
        resultKind: 'failed-product',
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
