import { describe, expect, it } from 'vitest';
import {
  classifyWatchLiveFailure,
  validateWatchLiveExecution,
  validateWatchLiveLedger,
  validateWatchLiveManifest,
  WATCH_LIVE_SCENARIO_MANIFEST,
} from './smoke-watch-live';
import { runWatchLiveScenarios } from './smoke-watch-live-runner';

describe('D10 bounded live Watch scenarios', () => {
  it('manifest 与失败分类有界且可解释', () => {
    expect(validateWatchLiveManifest()).toEqual([]);
    expect(WATCH_LIVE_SCENARIO_MANIFEST).toHaveLength(6);
    expect(classifyWatchLiveFailure({ credentialAvailable: false })).toBe(
      'skipped-credential-unavailable',
    );
    expect(classifyWatchLiveFailure({ status: 503 })).toBe('failed-network');
    expect(classifyWatchLiveFailure({ errorCode: 'product-defect' })).toBe('failed-product');
  });

  it('默认不触网，仍为每个场景生成一次台账', async () => {
    const report = await runWatchLiveScenarios();
    expect(report.ok).toBe(false);
    expect(report.entries).toHaveLength(6);
    expect(
      report.entries.find((entry) => entry.scenario === 'wl-provider-digest')?.resultKind,
    ).toBe('skipped-credential-unavailable');
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
          return { requestCount: scenario.maxRequests, status: 200, httpClass: '2xx' };
        },
      },
      windowsPort: {
        isWindows: true,
        isPackaged: true,
        probe: async (scenario) => {
          count(scenario.id);
          return { httpClass: 'qualified' };
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
