import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabInfo } from '../../../shared/types/browser';
import type { SourceWatchProjection } from '../../../shared/types/watch';
import { openWatchDb } from '../db/watch-driver';
import { runWatchMigrations } from '../db/watch-migrations';
import { WatchRepository } from '../repository/watch-repository';
import { WatchProcessingServiceImpl } from '../watch-processing-service';
import { WatchRunCoordinator } from '../watch-run-coordinator';
import { WatchScheduler } from '../watch-scheduler';
import { HostRequestGate } from '../host-request-gate';
import { WatchTaskTabWorkspace, type WatchTaskTabBrowser } from '../watch-task-tab-workspace';
import { QualificationAcquisitionPort } from './acquisition';
import { createQualificationRules, getQualificationRun } from './manifest';
import { QualificationRegistry } from './registry';
import { QualificationPausableClock } from './pausable-clock';
import { QualificationQpcClock, formatQpcTicks } from './qpc';
import { QualificationRoundReleaseGate } from './round-release-gate';
import type { QualificationRegistryEvent } from './native-contract';

const M0 = Date.parse('2026-09-07T00:30:00.000Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(M0 - 1_440_000);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function fixture(indices: number[]) {
  const trace: { kind: 'register' | 'unregister'; event: QualificationRegistryEvent }[] = [];
  const fail = (code: string): never => {
    throw new Error(code);
  };
  const registry = new QualificationRegistry((kind, event) => trace.push({ kind, event }), fail);
  const qpc = new QualificationQpcClock(
    {
      readQpc: () => ({ ticks: formatQpcTicks(BigInt(Date.now()) * 1000n), frequency: 1_000_000 }),
    },
    1_000_000,
    formatQpcTicks(BigInt(Date.now()) * 1000n),
    Date.now(),
  );
  const clocks = new QualificationPausableClock(qpc, registry);
  const db = openWatchDb(':memory:', {}, registry);
  runWatchMigrations(db);
  const repo = new WatchRepository(db);
  const rules = createQualificationRules(M0).filter((rule, index) => {
    void rule;
    return indices.includes(index);
  });
  for (const rule of rules) expect(repo.insertRule(rule).ok).toBe(true);
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
  const rounds = new QualificationRoundReleaseGate(M0, repo, registry, qpc, () => true, fail);
  const gate = new HostRequestGate({
    clock: clocks.forOwner('host-gate'),
    onGrant: (host, at, waited) => rounds.grant(host, at, waited),
  });
  const tabs = new Map<string, TabInfo>();
  let serial = 0;
  const owned = new Map<string, string>();
  const browser: WatchTaskTabBrowser = {
    createTab: async (url) => {
      const info: TabInfo = {
        id: `unit-${++serial}`,
        url,
        title: '',
        state: 'ready',
        active: true,
      };
      tabs.set(info.id, info);
      return info;
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
        onEntered: (runId, observedAt) => rounds.processingEntered(runId, observedAt),
        onDuplicateTerminalAttempt: () => rounds.duplicateTerminalAttempt(),
      },
    }),
    hostGate: gate,
    scheduler,
    clock: clocks.forOwner('coordinator'),
    observer: rounds,
  });
  return { trace, registry, clocks, repo, rounds, coordinator, scheduler, workspace, tabs, gate };
}

describe('资格固定负载真实Coordinator/HostGate/Processing/SQLite模块验证（无Electron资格声称）', () => {
  it.each([
    [0, 1, 2, 3],
    [80, 81, 82, 83],
  ])('初始化四host真实grant瞬时释放而四个slot持续28秒：%j', async (...indices) => {
    const h = fixture(indices);
    try {
      h.coordinator.start();
      for (const index of indices) {
        const plan = getQualificationRun(index, 'initialization', null, M0);
        expect(h.coordinator.manualRun(plan.entry.ruleId, plan.requestId!).ok).toBe(true);
      }
      await vi.advanceTimersByTimeAsync(600);
      expect(h.coordinator.activeRunCount()).toBe(4);
      expect(
        h.registry.snapshot().find((row) => row.registry === 'host-grant')?.identities,
      ).toEqual([]);
      expect(
        h.trace.filter((row) => row.kind === 'register' && row.event.registry === 'host-grant'),
      ).toHaveLength(4);
      for (const row of h.trace)
        if (row.event.registry === 'host-grant') expect(row.event.detail.attemptOrdinal).toBe(1);
      expect(h.workspace.getOwnedCount()).toBe(indices[0] === 80 ? 4 : 0);
      await vi.advanceTimersByTimeAsync(28_900);
      expect(h.coordinator.activeRunCount()).toBe(0);
      expect(h.workspace.getOwnedCount()).toBe(0);
      for (const index of indices)
        expect(
          h.repo.getBaseline(getQualificationRun(index, 'initialization', null, M0).entry.ruleId)
            ?.version,
        ).toBe(1);
      expect(
        h.trace.filter(
          (row) => row.kind === 'unregister' && row.event.registry === 'coordinator-slot',
        ),
      ).toHaveLength(4);
      await h.coordinator.stop();
      h.scheduler.stop();
      h.gate.clear();
      h.repo.dispose();
      expect(h.registry.snapshot().every((row) => row.identities.length === 0)).toBe(true);
    } finally {
      h.repo.dispose();
    }
  });

  it('未有初始化终态便消费measurement reservation会拒绝，不降低release或重写scheduledFor', () => {
    const h = fixture([0]);
    try {
      const plan = getQualificationRun(0, 'measurement', 0, M0);
      expect(() =>
        h.rounds.release({
          ruleId: plan.entry.ruleId,
          runId: 'test',
          trigger: 'scheduled',
          requestKey: plan.requestKey,
          scheduledFor: plan.scheduledFor,
          hostKey: plan.entry.hostKey,
          earliestStartMs: M0,
        }),
      ).toThrow('run-ordinal-mismatch');
    } finally {
      h.repo.dispose();
    }
  });

  it.each(['entry', 'writer'] as const)('实际QPC时钟越过独立500ms处理预算立即失败：%s', (stage) => {
    const h = fixture([0]);
    const plan = getQualificationRun(0, 'initialization', null, M0);
    const task = {
      ruleId: plan.entry.ruleId,
      runId: 'deadline-unit',
      trigger: 'manual' as const,
      requestKey: plan.requestKey,
      scheduledFor: null,
      hostKey: plan.entry.hostKey,
      earliestStartMs: Date.now(),
    };
    try {
      h.rounds.release(task);
      h.rounds.timing.begin(task.runId);
      vi.setSystemTime(Date.now() + 28_000);
      h.rounds.acquired(task);
      h.rounds.revalidated(task);
      if (stage === 'writer') h.rounds.processingEntered(task.runId, new Date().toISOString());
      vi.setSystemTime(Date.now() + 501);
      expect(() =>
        stage === 'entry'
          ? h.rounds.processingEntered(task.runId, new Date().toISOString())
          : h.rounds.processed(task),
      ).toThrow(stage === 'entry' ? 'processing-entry-deadline' : 'processing-writer-deadline');
    } finally {
      h.repo.dispose();
    }
  });

  it('stop时仍有真实Workspace owned Tab，清理沿该owner谱系关闭并排空', async () => {
    const h = fixture([80]);
    try {
      const lease = await h.workspace.acquire(
        getQualificationRun(80, 'initialization', null, M0).entry.targetUrl,
        new AbortController().signal,
      );
      expect(lease.ok).toBe(true);
      const owner = h.registry.snapshot().find((row) => row.registry === 'task-tab')!
        .identities[0]!;
      expect(h.tabs.size).toBe(1);
      h.registry.closeAdmission();
      const cleanup = await h.registry.track(() => h.workspace.cleanupAll(), owner);
      expect(cleanup.ok).toBe(true);
      expect(h.tabs.size).toBe(0);
      expect(h.workspace.getOwnedCount()).toBe(0);
      h.repo.dispose();
      expect(h.registry.snapshot().every((row) => row.identities.length === 0)).toBe(true);
    } finally {
      h.repo.dispose();
    }
  });
});
