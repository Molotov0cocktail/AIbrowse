import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWatchD10OfflineScenario, runWatchResourceProbe } from './smoke-watch-runner';
import { openDb, closeDb } from './sources/db/sqlite-driver';
import { runWatchMigrations } from './watch/db/watch-migrations';
import { WatchRepository } from './watch/repository/watch-repository';
import { WatchNotificationService } from './watch/watch-notification-service';

describe('D10 product-path runner', () => {
  it('reads product-generated surfaces and executes the cohesive pipeline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aibrowse-d10-runner-test-'));
    const log = join(root, 'aibrowse-2026-09-01.log');
    const sharedDir = join(root, 'shared');
    mkdirSync(sharedDir, { recursive: true });
    const sharedDb = openDb(join(sharedDir, 'watch.db'));
    runWatchMigrations(sharedDb);
    const sharedRepository = new WatchRepository(sharedDb);
    const observedNotifications: unknown[] = [];
    const productNotifications = new WatchNotificationService(
      () => sharedRepository,
      (notification) => {
        observedNotifications.push(notification);
        return true;
      },
      () => undefined,
      'in-app',
      () => 'D10 test source',
    );
    writeFileSync(log, 'D10 product-path log\n', 'utf8');
    try {
      const report = await runWatchD10OfflineScenario({
        logFile: log,
        auditEntries: [],
        rendererDom: async (identity) => ({
          html: `<main class="watch-workspace" data-watch-view="digests">${identity?.eventId ?? ''}</main>`,
          selectedDigestId: identity?.digestId ?? '',
        }),
        watchRepository: () => sharedRepository,
        watchNotification: {
          drain: () => productNotifications.drain(),
          values: () => observedNotifications,
        },
        resourceDurationMs: 20,
        resourceSamples: 2,
      });
      expect(report.scanSource).toBe('product-pipeline');
      expect(report.wrtOutcomes).toHaveLength(19);
      expect(report.wrtOutcomes.map((outcome) => outcome.id)).toEqual(
        Array.from({ length: 19 }, (_, index) => `WRT-${String(index + 1).padStart(2, '0')}`),
      );
      expect(report.wrtOutcomes.every((outcome) => outcome.ok)).toBe(true);
      expect(report.wrtOutcomes.every((outcome) => outcome.detail.trim() !== '')).toBe(true);
      expect(report.wrtAggregation).toEqual({ ok: true, failures: [] });
      expect(report.scanVerdicts).toHaveLength(8 * 11);
      expect(report.scanSurfaceSources).toHaveLength(11);
      expect(report.scanIngressEvidence).toHaveLength(8);
      expect(report.scanIngressEvidence.every((item) => item.bytes > 0)).toBe(true);
      expect(
        report.scanSurfaceSources.every((item) => item.bytes >= 0 && item.source !== 'unknown'),
      ).toBe(true);
      expect(report.scanReadFailures).toEqual([]);
      expect(report.cohesiveOk).toBe(true);
      expect(observedNotifications.length).toBeGreaterThan(0);
      expect(report.stageEvidence).toHaveLength(18);
      expect(
        report.stageEvidence
          .filter((item) => item.evidenceKind === 'honest-limit')
          .every((item) => item.status === 'condition-not-run'),
      ).toBe(true);
      expect(report.stageEvidence.every((item) => item.status !== undefined)).toBe(true);
      expect(report.stageEvidenceFailures).toEqual([]);
      expect(report.scanSummary).toEqual({ ok: true, failures: [] });
      expect(report.resourceProbe.ok).toBe(true);
      expect(sharedRepository.listRules()).toEqual([]);
    } finally {
      sharedRepository.dispose();
      closeDb(sharedDb);
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
