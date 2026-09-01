import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyWatchLiveFailure,
  describeWatchLiveLedger,
  validateWatchLiveExecution,
  validateWatchLiveLedger,
  validateWatchLiveManifest,
  WATCH_LIVE_SCENARIO_MANIFEST,
} from './smoke-watch-live';
import { runWatchLiveScenarios } from './smoke-watch-live-runner';
import { createProductWatchResourcePort } from './smoke-watch-live-resource';

const COMPLETE_RESOURCE_RESULT = {
  httpClass: 'complete resource evidence fixture',
  observedForMs: 1_000,
  drainStartedAtMs: 2_000,
  drainEndedAtMs: 2_200,
  drainObservedForMs: 200,
  residualObservedAtMs: [2_000, 2_200],
  samples: 2,
  residuals: { servers: 0, timers: 0, databases: 0, taskTabs: 0, children: 0, tempDirs: 0 },
  residualTrend: [
    { servers: 0, timers: 0, databases: 0, taskTabs: 0, children: 0, tempDirs: 0 },
    { servers: 0, timers: 0, databases: 0, taskTabs: 0, children: 0, tempDirs: 0 },
  ],
  resourceMetrics: {
    observedAtMs: 2_000,
    rssBytes: 2,
    heapUsedBytes: 2,
    cpuUserMicros: 2,
    cpuSystemMicros: 2,
  },
  resourceMetricTrend: [
    { observedAtMs: 1_000, rssBytes: 1, heapUsedBytes: 1, cpuUserMicros: 1, cpuSystemMicros: 1 },
    { observedAtMs: 2_000, rssBytes: 2, heapUsedBytes: 2, cpuUserMicros: 2, cpuSystemMicros: 2 },
  ],
  batteryObservation: {
    status: 'observed' as const,
    samples: [
      { observedAtMs: 1_000, chargePercent: 80, onBatteryPower: false },
      { observedAtMs: 2_000, chargePercent: 79, onBatteryPower: true },
    ],
  },
};

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

  it('生产资源端口把测量窗口与排水窗口分开并保留真实时间戳', async () => {
    let metricsCalls = 0;
    let shutdownCalled = false;
    const resource = WATCH_LIVE_SCENARIO_MANIFEST.find((scenario) => scenario.kind === 'resource')!;
    const result = await createProductWatchResourcePort(null, {
      isAvailable: () => true,
      metrics: () => {
        metricsCalls += 1;
        return {
          rssBytes: 10 + metricsCalls,
          heapUsedBytes: 20 + metricsCalls,
          cpuUserMicros: 30 + metricsCalls,
          cpuSystemMicros: 40 + metricsCalls,
        };
      },
      battery: () => ({
        status: 'observed' as const,
        chargePercent: metricsCalls === 1 ? 80 : 79,
        onBatteryPower: metricsCalls !== 1,
      }),
      shutdown: async () => {
        shutdownCalled = true;
      },
      residuals: () => {
        expect(shutdownCalled).toBe(true);
        return { servers: 0, timers: 0, databases: 0, taskTabs: 0, children: 0, tempDirs: 0 };
      },
    }).probe(resource, new AbortController().signal);

    expect(result.errorCode).toBe('observation-insufficient');
    expect(result.observedForMs).toBeGreaterThanOrEqual(100);
    expect(result.drainObservedForMs).toBeGreaterThanOrEqual(0);
    expect(result.resourceMetricTrend).toHaveLength(2);
    expect(result.resourceMetricTrend![0]!.observedAtMs).toBeLessThan(
      result.resourceMetricTrend![1]!.observedAtMs,
    );
    expect(result.residualObservedAtMs).toHaveLength(3);
    expect(result.residualObservedAtMs![0]).toBeGreaterThanOrEqual(result.drainStartedAtMs!);
    expect(result.batteryObservation?.status).toBe('observed');
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
      observedAtMs: 0,
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

  it('资源观察窗口过短时不得伪造 live PASS', async () => {
    const resource = WATCH_LIVE_SCENARIO_MANIFEST.find((scenario) => scenario.kind === 'resource')!;
    const metrics = {
      observedAtMs: 0,
      rssBytes: 1,
      heapUsedBytes: 1,
      cpuUserMicros: 1,
      cpuSystemMicros: 1,
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
          httpClass: 'short observation fixture',
          observedForMs: 1,
          samples: 2,
          residuals,
          residualTrend: [residuals, residuals],
          resourceMetrics: metrics,
          resourceMetricTrend: [metrics, metrics],
        }),
      },
    });
    expect(report.ok).toBe(false);
    expect(report.entries[0]?.resultKind).toBe('failed-product');
  });

  it('短时重复指标即使正数也不得满足长时资源观察', async () => {
    const resource = WATCH_LIVE_SCENARIO_MANIFEST.find((scenario) => scenario.kind === 'resource')!;
    const metrics = {
      observedAtMs: 0,
      rssBytes: 1,
      heapUsedBytes: 1,
      cpuUserMicros: 1,
      cpuSystemMicros: 1,
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
          httpClass: 'short repeated metrics fixture',
          observedForMs: 100,
          samples: 2,
          residuals,
          residualTrend: [residuals, residuals],
          resourceMetrics: metrics,
          resourceMetricTrend: [metrics, metrics],
        }),
      },
    });
    expect(report.ok).toBe(false);
    expect(report.entries[0]?.resultKind).toBe('failed-product');
  });

  it('缺少电池趋势或明确条件证据时不得汇总为资源 PASS', async () => {
    const resource = WATCH_LIVE_SCENARIO_MANIFEST.find((scenario) => scenario.kind === 'resource')!;
    const metrics = {
      observedAtMs: 0,
      rssBytes: 1,
      heapUsedBytes: 2,
      cpuUserMicros: 3,
      cpuSystemMicros: 4,
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
          httpClass: 'missing battery evidence fixture',
          observedForMs: 1_000,
          samples: 2,
          residuals,
          residualTrend: [residuals, residuals],
          resourceMetrics: metrics,
          resourceMetricTrend: [metrics, { ...metrics, heapUsedBytes: 5 }],
        }),
      },
    });
    expect(report.ok).toBe(false);
    expect(report.entries[0]?.resultKind).toBe('failed-product');
  });

  it('shutdown 后的排水窗口不得虚增测量窗口', async () => {
    const resource = WATCH_LIVE_SCENARIO_MANIFEST.find((scenario) => scenario.kind === 'resource')!;
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
          httpClass: 'drain-inflated measurement fixture',
          observedForMs: 10_000,
          drainStartedAtMs: 1_000,
          drainEndedAtMs: 10_000,
          drainObservedForMs: 9_000,
          residualObservedAtMs: [9_900, 10_000],
          samples: 2,
          residuals,
          residualTrend: [residuals, residuals],
          resourceMetrics: {
            observedAtMs: 1_000,
            rssBytes: 1,
            heapUsedBytes: 1,
            cpuUserMicros: 1,
            cpuSystemMicros: 1,
          },
          resourceMetricTrend: [
            {
              observedAtMs: 0,
              rssBytes: 1,
              heapUsedBytes: 1,
              cpuUserMicros: 1,
              cpuSystemMicros: 1,
            },
            {
              observedAtMs: 1_000,
              rssBytes: 2,
              heapUsedBytes: 2,
              cpuUserMicros: 2,
              cpuSystemMicros: 2,
            },
          ],
          batteryObservation: {
            status: 'observed' as const,
            samples: [
              { observedAtMs: 0, chargePercent: 80 },
              { observedAtMs: 1_000, chargePercent: 79 },
            ],
          },
        }),
      },
    });
    expect(report.ok).toBe(false);
    expect(report.entries[0]?.resultKind).toBe('failed-product');
  });

  it('测量与排水窗口重叠时不得 PASS', async () => {
    const resource = WATCH_LIVE_SCENARIO_MANIFEST.find((scenario) => scenario.kind === 'resource')!;
    const report = await runWatchLiveScenarios({
      manifest: [resource],
      resourcePort: {
        probe: async () => ({
          ...COMPLETE_RESOURCE_RESULT,
          drainStartedAtMs: 1_500,
          drainEndedAtMs: 1_700,
          drainObservedForMs: 200,
          residualObservedAtMs: [1_500, 1_700],
        }),
      },
    });
    expect(report.ok).toBe(false);
    expect(report.entries[0]?.resultKind).toBe('failed-product');
  });

  it('残留样本时间戳越出排水窗口时不得 PASS', async () => {
    const resource = WATCH_LIVE_SCENARIO_MANIFEST.find((scenario) => scenario.kind === 'resource')!;
    const report = await runWatchLiveScenarios({
      manifest: [resource],
      resourcePort: {
        probe: async () => ({
          ...COMPLETE_RESOURCE_RESULT,
          residualObservedAtMs: [2_000, 2_300],
        }),
      },
    });
    expect(report.ok).toBe(false);
    expect(report.entries[0]?.resultKind).toBe('failed-product');
  });

  it('电池样本时间戳越出测量窗口时不得 PASS', async () => {
    const resource = WATCH_LIVE_SCENARIO_MANIFEST.find((scenario) => scenario.kind === 'resource')!;
    const report = await runWatchLiveScenarios({
      manifest: [resource],
      resourcePort: {
        probe: async () => ({
          ...COMPLETE_RESOURCE_RESULT,
          batteryObservation: {
            status: 'observed' as const,
            samples: [
              { observedAtMs: 900, chargePercent: 80 },
              { observedAtMs: 2_100, chargePercent: 79 },
            ],
          },
        }),
      },
    });
    expect(report.ok).toBe(false);
    expect(report.entries[0]?.resultKind).toBe('failed-product');
  });

  it('条件不可用不得掩盖非零残留', async () => {
    const resource = WATCH_LIVE_SCENARIO_MANIFEST.find((scenario) => scenario.kind === 'resource')!;
    const report = await runWatchLiveScenarios({
      manifest: [resource],
      resourcePort: {
        probe: async () => ({
          ...COMPLETE_RESOURCE_RESULT,
          errorCode: 'condition-unavailable',
          residuals: { ...COMPLETE_RESOURCE_RESULT.residuals, servers: 1 },
          residualTrend: [
            { ...COMPLETE_RESOURCE_RESULT.residuals, servers: 1 },
            { ...COMPLETE_RESOURCE_RESULT.residuals, servers: 1 },
          ],
          batteryObservation: {
            status: 'condition-unavailable' as const,
            reason: 'battery condition unavailable',
            samples: [],
          },
        }),
      },
    });
    expect(report.ok).toBe(false);
    expect(report.entries[0]?.resultKind).toBe('failed-product');
  });

  it('恰好一秒和两个变化样本没有正式长时资格时只能 not-run', async () => {
    const resource = WATCH_LIVE_SCENARIO_MANIFEST.find((scenario) => scenario.kind === 'resource')!;
    const report = await runWatchLiveScenarios({
      manifest: [resource],
      resourcePort: { probe: async () => ({ ...COMPLETE_RESOURCE_RESULT }) },
    });
    expect(report.ok).toBe(false);
    expect(report.entries[0]?.resultKind).toBe('not-run');
  });

  it('电池条件明确不可用且其余资源正常时记录 not-run', async () => {
    const resource = WATCH_LIVE_SCENARIO_MANIFEST.find((scenario) => scenario.kind === 'resource')!;
    const report = await runWatchLiveScenarios({
      manifest: [resource],
      resourcePort: {
        probe: async () => ({
          ...COMPLETE_RESOURCE_RESULT,
          errorCode: 'condition-unavailable',
          batteryObservation: {
            status: 'condition-unavailable' as const,
            reason: 'battery condition unavailable',
            samples: [],
          },
        }),
      },
    });
    expect(report.ok).toBe(false);
    expect(report.entries[0]?.resultKind).toBe('not-run');
  });

  it('资源 PASS 台账必须保留时长、样本数、趋势和电池状态', () => {
    const resource = WATCH_LIVE_SCENARIO_MANIFEST.find((scenario) => scenario.kind === 'resource')!;
    const entry = {
      scenario: resource.id,
      requestCount: 0,
      resultKind: 'pass' as const,
      httpClass: 'qualified resource observation',
      purpose: resource.purpose,
      resourceObservation: {
        measurementStartedAtMs: 1_000,
        measurementEndedAtMs: 2_000,
        measurementWindowMs: 1_000,
        batteryStartedAtMs: 1_000,
        batteryEndedAtMs: 2_000,
        drainStartedAtMs: 2_000,
        drainEndedAtMs: 2_200,
        drainWindowMs: 200,
        metricSampleCount: 2,
        metricTrend: 'changed' as const,
        residualSampleCount: 2,
        batteryStatus: 'observed' as const,
        batterySampleCount: 2,
      },
    };
    expect(validateWatchLiveLedger([entry])).toEqual(
      expect.arrayContaining(['wl-resource-probe：当前未提供正式长时资格，不能报告 PASS']),
    );
    const description = describeWatchLiveLedger([entry]);
    expect(description).toContain('测量 1000ms/2 样本');
    expect(description).toContain('排水 200ms');
    expect(description).toContain('指标changed');
    expect(description).toContain('电池observed/2 样本');
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
            errorCode: 'observation-insufficient',
            observedForMs: 1_000,
            drainStartedAtMs: 2_000,
            drainEndedAtMs: 2_200,
            drainObservedForMs: 200,
            residualObservedAtMs: [2_100, 2_200],
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
              observedAtMs: 1_000,
              rssBytes: 1,
              heapUsedBytes: 1,
              cpuUserMicros: 1,
              cpuSystemMicros: 1,
            },
            resourceMetricTrend: [
              {
                observedAtMs: 1_000,
                rssBytes: 1,
                heapUsedBytes: 1,
                cpuUserMicros: 1,
                cpuSystemMicros: 1,
              },
              {
                observedAtMs: 2_000,
                rssBytes: 2,
                heapUsedBytes: 2,
                cpuUserMicros: 2,
                cpuSystemMicros: 2,
              },
            ],
            batteryObservation: {
              status: 'observed',
              samples: [
                { observedAtMs: 1_000, chargePercent: 80, onBatteryPower: false },
                { observedAtMs: 2_000, chargePercent: 79, onBatteryPower: true },
              ],
            },
          };
        },
      },
    });
    expect(report.ok).toBe(false);
    expect(
      report.entries
        .filter((entry) => entry.scenario !== 'wl-resource-probe')
        .every((entry) => entry.resultKind === 'pass'),
    ).toBe(true);
    expect(report.entries.find((entry) => entry.scenario === 'wl-resource-probe')).toMatchObject({
      resultKind: 'not-run',
    });
    expect([...calls.values()].every((value) => value === 1)).toBe(true);
    expect(validateWatchLiveLedger(report.entries)).toEqual(
      expect.arrayContaining(['wl-resource-probe：真实场景未实际运行']),
    );
  });
});
