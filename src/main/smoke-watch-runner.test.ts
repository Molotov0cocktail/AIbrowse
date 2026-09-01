import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWatchD10OfflineScenario, runWatchResourceProbe } from './smoke-watch-runner';

describe('D10 product-path runner', () => {
  it('reads product-generated surfaces and executes the cohesive pipeline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aibrowse-d10-runner-test-'));
    const log = join(root, 'aibrowse-2026-09-01.log');
    writeFileSync(log, 'D10 product-path log\n', 'utf8');
    try {
      const report = await runWatchD10OfflineScenario({
        logFile: log,
        auditEntries: [],
        rendererDom: async () => '<main data-route="watch"></main>',
        resourceDurationMs: 20,
        resourceSamples: 2,
      });
      expect(report.scanSource).toBe('product-pipeline');
      expect(report.scanVerdicts).toHaveLength(8 * 11);
      expect(report.scanSurfaceSources).toHaveLength(11);
      expect(
        report.scanSurfaceSources.every((item) => item.bytes >= 0 && item.source !== 'unknown'),
      ).toBe(true);
      expect(report.scanReadFailures).toEqual([]);
      expect(report.cohesiveOk).toBe(true);
      expect(report.stageEvidence).toHaveLength(18);
      expect(report.stageEvidenceFailures).toEqual([]);
      expect(report.scanSummary).toEqual({ ok: true, failures: [] });
      expect(report.resourceProbe.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('资源 oracle 缺观察器或零观察窗口时 fail-closed', async () => {
    await expect(runWatchResourceProbe()).rejects.toThrow('缺少产品所有权观察器');
    await expect(
      runWatchResourceProbe({
        durationMs: 0,
        samples: 2,
        observe: () => ({
          residualServers: 0,
          residualTimers: 0,
          residualDatabases: 0,
          residualTaskTabs: 0,
          residualChildren: 0,
          residualTempDirs: 0,
        }),
      }),
    ).rejects.toThrow('duration');
  });
});
