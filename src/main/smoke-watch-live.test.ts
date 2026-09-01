import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyWatchLiveFailure,
  validateWatchLiveExecution,
  validateWatchLiveLedger,
  validateWatchLiveManifest,
  WATCH_LIVE_SCENARIO_MANIFEST,
} from './smoke-watch-live';
import { runWatchLiveScenarios } from './smoke-watch-live-runner';
import { createProductWatchResourcePort } from './smoke-watch-live-resource';

describe('D10 bounded live Watch scenarios', () => {
  it('manifest 与失败分类有界且可解释', () => {
    expect(validateWatchLiveManifest()).toEqual([]);
    expect(WATCH_LIVE_SCENARIO_MANIFEST).toHaveLength(6);
    expect(classifyWatchLiveFailure({ credentialAvailable: false })).toBe(
      'skipped-credential-unavailable',
    );
    expect(classifyWatchLiveFailure({ status: 503 })).toBe('failed-network');
    expect(classifyWatchLiveFailure({ errorCode: 'product-defect' })).toBe('failed-product');
    expect(classifyWatchLiveFailure({ scenarioKind: 'public-network', status: 403 })).toBe(
      'failed-network',
    );
    expect(classifyWatchLiveFailure({ scenarioKind: 'provider', status: 403 })).toBe(
      'failed-provider',
    );
  });

  it('默认不触网，仍为每个场景生成一次台账', async () => {
    const report = await runWatchLiveScenarios();
    expect(report.ok).toBe(false);
    expect(report.entries).toHaveLength(6);
    expect(
      report.entries.find((entry) => entry.scenario === 'wl-provider-digest')?.resultKind,
    ).toBe('skipped-credential-unavailable');
    expect(
      report.entries.find((entry) => entry.scenario === 'wl-windows-notification'),
    ).toMatchObject({
      resultKind: 'not-run',
      classification: 'condition-unavailable',
    });
    expect(
      validateWatchLiveExecution(
        WATCH_LIVE_SCENARIO_MANIFEST,
        report.entries.map((entry) => entry.scenario),
      ),
    ).toEqual([]);
    expect(validateWatchLiveLedger(report.entries)).toEqual(
      expect.arrayContaining([
        'wl-public-rss：真实场景未实际运行',
        'wl-robots：真实场景未实际运行',
        'wl-redirect：真实场景未实际运行',
        'wl-resource-probe：真实场景未实际运行',
      ]),
    );
  });

  it('公网成功但请求台账为零时不得 PASS', async () => {
    const report = await runWatchLiveScenarios({
      publicPort: {
        run: async () => ({ requestCount: 0, status: 200, httpClass: '2xx' }),
      },
      resourcePort: {
        probe: async () => ({ httpClass: 'resource-probe' }),
      },
    });
    expect(report.ok).toBe(false);
    expect(report.entries.find((entry) => entry.scenario === 'wl-public-rss')).toMatchObject({
      resultKind: 'failed-product',
    });
  });

  it('生产 live 装配必须提供真实资源端口并经过非零观察窗口', async () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    expect(source).toContain('resourcePort: createProductWatchResourcePort(watchWorkspace');
    const result = await createProductWatchResourcePort(null).probe(
      WATCH_LIVE_SCENARIO_MANIFEST.find((scenario) => scenario.kind === 'resource')!,
      new AbortController().signal,
    );
    expect(result.errorCode).toBe('not-run');
  }, 5_000);

  it('已打包 Windows 的产品缺陷不得降级成条件跳过', async () => {
    const windows = WATCH_LIVE_SCENARIO_MANIFEST.find((scenario) => scenario.kind === 'windows')!;
    const report = await runWatchLiveScenarios({
      manifest: [windows],
      windowsPort: {
        isWindows: true,
        isPackaged: true,
        probe: async () =>
          ({
            httpClass: 'notification sink failed',
            errorCode: 'product-defect',
            classification: 'product-defect',
          }) as never,
      },
    });
    expect(report.ok).toBe(false);
    expect(report.entries[0]?.resultKind).toBe('failed-product');
  });

  it('缺少真实资源指标时不得把零残留结构当作 live PASS', async () => {
    const resource = WATCH_LIVE_SCENARIO_MANIFEST.find((scenario) => scenario.kind === 'resource')!;
    const report = await runWatchLiveScenarios({
      manifest: [resource],
      resourcePort: {
        probe: async () => ({
          httpClass: 'zero residual fixture',
          observedForMs: 100,
          samples: 2,
          residuals: {
            servers: 0,
            timers: 0,
            databases: 0,
            taskTabs: 0,
            children: 0,
            tempDirs: 0,
          },
          residualTrend: [
            { servers: 0, timers: 0, databases: 0, taskTabs: 0, children: 0, tempDirs: 0 },
            { servers: 0, timers: 0, databases: 0, taskTabs: 0, children: 0, tempDirs: 0 },
          ],
        }),
      },
    });
    expect(report.ok).toBe(false);
  });

  it('资源指标全为零时不得伪造 live PASS', async () => {
    const resource = WATCH_LIVE_SCENARIO_MANIFEST.find((scenario) => scenario.kind === 'resource')!;
    const zero = {
      rssBytes: 0,
      heapUsedBytes: 0,
      cpuUserMicros: 0,
      cpuSystemMicros: 0,
    };
    const residuals = {
      servers: 0,
      timers: 0,
      databases: 0,
      taskTabs: 0,
      children: 0,
      tempDirs: 0,
    };
    const report = await runWatchLiveScenarios({
      manifest: [resource],
      resourcePort: {
        probe: async () => ({
          httpClass: 'zero metrics fixture',
          observedForMs: 100,
          samples: 2,
          residuals,
          residualTrend: [residuals, residuals],
          resourceMetrics: zero,
          resourceMetricTrend: [zero, zero],
        }),
      },
    });
    expect(report.ok).toBe(false);
    expect(report.entries[0]?.resultKind).toBe('failed-product');
  });

  it('拒绝重复执行和超过请求上限', () => {
    const duplicate = validateWatchLiveExecution(WATCH_LIVE_SCENARIO_MANIFEST, [
      'wl-public-rss',
      'wl-public-rss',
    ]);
    expect(duplicate.some((error) => error.includes('重复执行'))).toBe(true);
    const over = validateWatchLiveLedger([
      {
        scenario: 'wl-public-rss',
        requestCount: 3,
        resultKind: 'pass',
        httpClass: '2xx',
        purpose: 'fixture',
      },
    ]);
    expect(over.some((error) => error.includes('超过请求上限'))).toBe(true);
  });

  it('Provider 成功必须有且仅有一次真实请求，Windows 缺少端口不得静默通过', () => {
    const errors = validateWatchLiveLedger([
      {
        scenario: 'wl-public-rss',
        requestCount: 1,
        resultKind: 'pass',
        httpClass: '200',
        purpose: 'rss',
      },
      {
        scenario: 'wl-robots',
        requestCount: 1,
        resultKind: 'pass',
        httpClass: '200',
        purpose: 'robots',
      },
      {
        scenario: 'wl-redirect',
        requestCount: 1,
        resultKind: 'pass',
        httpClass: '200',
        purpose: 'redirect',
      },
      {
        scenario: 'wl-provider-digest',
        requestCount: 0,
        resultKind: 'pass',
        httpClass: 'Provider stream complete',
        purpose: 'provider',
      },
      {
        scenario: 'wl-windows-notification',
        requestCount: 0,
        resultKind: 'not-run',
        httpClass: '未提供 Windows 端口',
        purpose: 'windows',
      },
      {
        scenario: 'wl-resource-probe',
        requestCount: 0,
        resultKind: 'pass',
        httpClass: 'zero-residuals',
        purpose: 'resource',
      },
    ]);
    expect(errors).toEqual(
      expect.arrayContaining([
        'wl-provider-digest：Provider PASS 必须恰好一次真实请求',
        'wl-windows-notification：Windows 未运行必须明确标记条件不可用',
      ]),
    );
  });

  it('Provider 2xx 请求但缺少成功 artifact 状态时不得 PASS', async () => {
    const provider = WATCH_LIVE_SCENARIO_MANIFEST.find((scenario) => scenario.kind === 'provider')!;
    const report = await runWatchLiveScenarios({
      manifest: [provider],
      providerPort: {
        credentialAvailable: () => true,
        runOnce: async () => ({
          requestCount: provider.maxRequests,
          status: 200,
          httpClass: 'provider request returned 2xx',
        }),
      },
    });
    expect(report.ok).toBe(false);
    expect(report.entries[0]?.resultKind).toBe('failed-product');
  });

  it('D10 通知捕获仅可在 smoke 路径启用', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    const capture = source.indexOf('watchD10NotificationCapture.push(notification)');
    expect(capture).toBeGreaterThanOrEqual(0);
    const callback = source.slice(source.lastIndexOf('watchNotifications =', capture), capture);
    expect(callback).toContain('if (SMOKE_MODE)');
  });

  it('注入端口时每个真实类别只执行一次并记录成功分类', async () => {
    const calls = new Map<string, number>();
    const count = (id: string): void => {
      calls.set(id, (calls.get(id) ?? 0) + 1);
    };
    const report = await runWatchLiveScenarios({
      publicPort: {
        run: async (scenario) => {
          count(scenario.id);
          return { requestCount: scenario.maxRequests, status: 200, httpClass: '2xx' };
        },
      },
      providerPort: {
        credentialAvailable: () => true,
        runOnce: async (scenario) => {
          count(scenario.id);
          return {
            requestCount: scenario.maxRequests,
            status: 200,
            httpClass: '2xx',
            providerState: 'succeeded',
          };
        },
      },
      windowsPort: {
        isWindows: true,
        isPackaged: true,
        probe: async (scenario) => {
          count(scenario.id);
          return { httpClass: 'qualified', classification: 'pass' };
        },
      },
      resourcePort: {
        probe: async (scenario) => {
          count(scenario.id);
          return {
            httpClass: 'zero-residuals',
            observedForMs: 1,
            samples: 2,
            residuals: {
              servers: 0,
              timers: 0,
              databases: 0,
              taskTabs: 0,
              children: 0,
              tempDirs: 0,
            },
            residualTrend: [
              {
                servers: 0,
                timers: 0,
                databases: 0,
                taskTabs: 0,
                children: 0,
                tempDirs: 0,
              },
              {
                servers: 0,
                timers: 0,
                databases: 0,
                taskTabs: 0,
                children: 0,
                tempDirs: 0,
              },
            ],
            resourceMetrics: {
              rssBytes: 1,
              heapUsedBytes: 1,
              cpuUserMicros: 1,
              cpuSystemMicros: 1,
            },
            resourceMetricTrend: [
              { rssBytes: 1, heapUsedBytes: 1, cpuUserMicros: 1, cpuSystemMicros: 1 },
              { rssBytes: 1, heapUsedBytes: 1, cpuUserMicros: 1, cpuSystemMicros: 1 },
            ],
          };
        },
      },
    });
    expect(report.ok).toBe(true);
    expect(report.entries.every((entry) => entry.resultKind === 'pass')).toBe(true);
    expect([...calls.values()].every((value) => value === 1)).toBe(true);
    expect(validateWatchLiveLedger(report.entries)).toEqual([]);
  });
});
