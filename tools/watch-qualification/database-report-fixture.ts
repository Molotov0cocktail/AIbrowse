import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';
import type { TabInfo } from '../../src/shared/types/browser';
import type { SourceWatchProjection } from '../../src/shared/types/watch';
import { openWatchStore } from '../../src/main/watch/watch-store';
import { WatchProcessingServiceImpl } from '../../src/main/watch/watch-processing-service';
import { WatchRunCoordinator } from '../../src/main/watch/watch-run-coordinator';
import { WatchScheduler } from '../../src/main/watch/watch-scheduler';
import { HostRequestGate } from '../../src/main/watch/host-request-gate';
import { DigestService } from '../../src/main/watch/digest-service';
import { DigestScheduler } from '../../src/main/watch/digest-scheduler';
import { WatchNotificationService } from '../../src/main/watch/watch-notification-service';
import {
  WatchTaskTabWorkspace,
  type WatchTaskTabBrowser,
} from '../../src/main/watch/watch-task-tab-workspace';
import { QualificationAcquisitionPort } from '../../src/main/watch/qualification/acquisition';
import {
  createQualificationRules,
  getQualificationRun,
  H3B_DESCRIPTOR_SHA256,
  H3B_EXPANDED_SHA256,
} from '../../src/main/watch/qualification/manifest';
import { QualificationRegistry } from '../../src/main/watch/qualification/registry';
import { QualificationPausableClock } from '../../src/main/watch/qualification/pausable-clock';
import { QualificationQpcClock, formatQpcTicks } from '../../src/main/watch/qualification/qpc';
import { QualificationRoundReleaseGate } from '../../src/main/watch/qualification/round-release-gate';
import type { QualificationSeedAuthorization } from '../../src/main/watch/qualification/seed-authorization';

/** File-backed form of the product full-load harness; test-only and deterministic. */
export async function populateFormalWatchDatabase(dbPath: string, m0: number): Promise<void> {
  mkdirSync(dirname(dbPath), { recursive: true });
  vi.useFakeTimers();
  vi.setSystemTime(m0 - 1_440_000);
  vi.stubGlobal('__WATCH_QUALIFICATION__', true);
  const fail = (code: string): never => {
    throw new Error(code);
  };
  const registry = new QualificationRegistry(() => {}, fail);
  const qpc = new QualificationQpcClock(
    {
      readQpc: () => ({
        ticks: formatQpcTicks(BigInt(Date.now()) * 1000n),
        frequency: 1_000_000,
      }),
    },
    1_000_000,
    formatQpcTicks(BigInt(Date.now()) * 1000n),
    Date.now(),
  );
  const clocks = new QualificationPausableClock(qpc, registry);
  const store = openWatchStore({
    dbPath,
    backupsDir: join(dirname(dbPath), 'backups'),
    ownership: registry,
    nowMs: () => Date.now(),
    reconcile: () => ({ ok: true, reason: null }),
  });
  if (store.mode !== 'normal') throw new Error('formal fixture store unavailable');
  const repo = store.repo;
  if (
    !repo.insertAudit({
      id: 'fixture-startup-reconciliation',
      ruleId: null,
      kind: 'reconciliation',
      reasonCode: 'complete',
      createdAt: new Date().toISOString(),
    }).ok
  )
    throw new Error('fixture reconciliation audit');
  const rules = createQualificationRules(m0);
  for (const rule of rules) if (!repo.insertRule(rule).ok) throw new Error('fixture rule');
  const sources = new Map<string, SourceWatchProjection>(
    rules.map((rule) => [
      rule.id,
      {
        sourceId: rule.sourceId,
        rowVersion: 1,
        enabled: true,
        deletedAt: null,
        scope: 'page',
        canonicalKey: rule.target.type === 'feed' ? rule.target.feedUrl : rule.target.pageUrl,
      },
    ]),
  );
  const rounds = new QualificationRoundReleaseGate(m0, repo, registry, qpc, () => true, fail);
  const gate = new HostRequestGate({
    clock: clocks.forOwner('host-gate'),
    onGrant: (host, at, waited) => rounds.grant(host, at, waited),
  });
  const tabs = new Map<string, TabInfo>();
  const owned = new Map<string, string>();
  let serial = 0;
  const browser: WatchTaskTabBrowser = {
    createTab: async (url) => {
      const tab: TabInfo = {
        id: `fixture-${++serial}`,
        url,
        title: '',
        state: 'ready',
        active: true,
      };
      tabs.set(tab.id, tab);
      return tab;
    },
    closeTab: async (id) => tabs.delete(id),
    activateTab: async () => true,
    getTabs: async () => [...tabs.values()],
    getActiveTab: async () => null,
  };
  const workspace = new WatchTaskTabWorkspace({
    browser,
    ownership: {
      assertMutable: () => registry.assertMutable(),
      own: (id) => owned.set(id, registry.register({ registry: 'task-tab', detail: null })),
      release: (id) => {
        registry.unregister(owned.get(id)!);
        owned.delete(id);
      },
      track: (create) => registry.track(create),
    },
  });
  const scheduler = new WatchScheduler({
    clock: clocks.forOwner('watch-scheduler'),
    onDue: (entries) => coordinator.handleDue(entries),
  });
  const acquisition = new QualificationAcquisitionPort(
    clocks.forOwner('qualification-fixture'),
    gate,
    workspace,
    rounds,
    registry,
    fail,
  );
  const coordinator = new WatchRunCoordinator({
    repo,
    revalidator: {
      revalidateRuleSource: (id) => ({
        status: 'ok',
        rowVersion: 1,
        sourceAfterAcquisition: sources.get(id)!,
      }),
    },
    acquisition,
    processing: new WatchProcessingServiceImpl({
      repo,
      clock: qpc,
      observer: {
        onEntered: (runId, at) => rounds.processingEntered(runId, at),
        onDuplicateTerminalAttempt: () => registry.increment('duplicateTerminalAttemptTotal'),
      },
    }),
    hostGate: gate,
    scheduler,
    clock: clocks.forOwner('coordinator'),
    observer: rounds,
  });
  const auth = {} as QualificationSeedAuthorization;
  let digestService: DigestService | null = null;
  let digestScheduler: DigestScheduler | null = null;
  try {
    coordinator.start();
    for (let batch = 0; batch < 25; batch++) {
      for (let offset = 0; offset < 4; offset++) {
        const plan = getQualificationRun(batch * 4 + offset, 'initialization', null, m0);
        if (!coordinator.manualRun(plan.entry.ruleId, plan.requestId!).ok)
          throw new Error('fixture init');
      }
      await vi.advanceTimersByTimeAsync(31_000);
    }
    repo.seedWatchResourceQualificationRuleScheduleV1(
      auth,
      H3B_DESCRIPTOR_SHA256,
      H3B_EXPANDED_SHA256,
      m0,
    );
    await vi.advanceTimersByTimeAsync(m0 - 600_000 - Date.now());
    scheduler.initialize(
      repo
        .listRules()
        .map((rule) => ({ ruleId: rule.id, effectiveDueAt: Date.parse(rule.nextDueAt!) })),
    );
    await vi.advanceTimersByTimeAsync(600_000);
    repo.seedWatchResourceQualificationDigestsV1(
      auth,
      H3B_DESCRIPTOR_SHA256,
      H3B_EXPANDED_SHA256,
      m0,
    );
    digestScheduler = new DigestScheduler(clocks.forOwner('digest-scheduler'), (entry) => {
      void digestService!.handleDue(entry);
    });
    const notificationService = new WatchNotificationService(
      () => repo,
      () => true,
      () => undefined,
    );
    digestService = new DigestService({
      repository: repo,
      clock: qpc,
      ownership: { track: (work) => registry.track(work), admissionOpen: () => true },
      sharing: {
        get: async () => {
          throw new Error('provider projection forbidden');
        },
      },
      provider: {
        resolve: async () => {
          throw new Error('provider forbidden');
        },
      },
      scheduleControl: digestScheduler,
      onArtifactReady: () => {
        void notificationService.drain();
      },
    });
    digestScheduler.initialize(
      repo.listDigestSchedules().map((schedule) => ({
        scheduleId: schedule.id,
        expectedNextDueAt: schedule.nextDueAt,
        timeZone: schedule.timeZone,
      })),
    );
    await vi.advanceTimersByTimeAsync(3_600_000);
    await digestService.drain();
    await notificationService.drain();
    digestService.dispose();
    digestScheduler.stop();
    await coordinator.stop();
    scheduler.stop();
    gate.clear();
    repo.dispose();
  } finally {
    try {
      digestService?.dispose();
    } catch {
      /* test cleanup */
    }
    try {
      digestScheduler?.stop();
    } catch {
      /* test cleanup */
    }
    try {
      scheduler.stop();
    } catch {
      /* test cleanup */
    }
    try {
      gate.clear();
    } catch {
      /* test cleanup */
    }
    if (!repo.isDisposed) repo.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
}
