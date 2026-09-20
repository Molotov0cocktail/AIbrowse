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
import { DigestService } from '../digest-service';
import { DigestScheduler } from '../digest-scheduler';
import { WatchTaskTabWorkspace, type WatchTaskTabBrowser } from '../watch-task-tab-workspace';
import { QualificationAcquisitionPort } from './acquisition';
import {
  createQualificationRules,
  getQualificationRun,
  H3B_DESCRIPTOR_SHA256,
  H3B_EXPANDED_SHA256,
} from './manifest';
import { QualificationRegistry } from './registry';
import { QualificationPausableClock } from './pausable-clock';
import { QualificationQpcClock, formatQpcTicks } from './qpc';
import { QualificationRoundReleaseGate } from './round-release-gate';
import type { QualificationRegistryEvent } from './native-contract';
import type { QualificationSeedAuthorization } from './seed-authorization';

vi.mock('./seed-authorization', () => ({
  assertQualificationSeedAuthorization: () => {},
  assertQualificationSeedDatabase: () => {},
  completeQualificationSeed: () => {},
}));
const M0 = Date.parse('2026-09-07T00:30:00.000Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(M0 - 1440000);
  vi.stubGlobal('__WATCH_QUALIFICATION__', true);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('资格567次快速完整负载（真实调度/事务，控制时钟与浏览器端口；非Windows资源证据）', () => {
  it('100初始化、67预热和四轮400均走实际Coordinator且命中120任务Tab与双侧Event计数', async () => {
    const trace: { kind: 'register' | 'unregister'; event: QualificationRegistryEvent }[] = [];
    const fail = (code: string): never => {
      throw new Error(code);
    };
    const registry = new QualificationRegistry((kind, event) => trace.push({ kind, event }), fail);
    const qpc = new QualificationQpcClock(
      {
        readQpc: () => ({ ticks: formatQpcTicks(BigInt(Date.now()) * 1000n), frequency: 1000000 }),
      },
      1000000,
      formatQpcTicks(BigInt(Date.now()) * 1000n),
      Date.now(),
    );
    const clocks = new QualificationPausableClock(qpc, registry);
    const db = openWatchDb(':memory:', {}, registry);
    runWatchMigrations(db);
    const repo = new WatchRepository(db);
    const rules = createQualificationRules(M0);
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
          id: `load-${++serial}`,
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
    try {
      coordinator.start();
      for (let batch = 0; batch < 25; batch++) {
        for (let offset = 0; offset < 4; offset++) {
          const plan = getQualificationRun(batch * 4 + offset, 'initialization', null, M0);
          expect(coordinator.manualRun(plan.entry.ruleId, plan.requestId!).ok).toBe(true);
        }
        await vi.advanceTimersByTimeAsync(31000);
        expect(coordinator.activeRunCount()).toBe(0);
      }
      expect(rounds.phaseComplete('initialization')).toBe(true);
      repo.seedWatchResourceQualificationRuleScheduleV1(
        auth,
        H3B_DESCRIPTOR_SHA256,
        H3B_EXPANDED_SHA256,
        M0,
      );
      await vi.advanceTimersByTimeAsync(M0 - 600000 - Date.now());
      scheduler.initialize(
        repo
          .listRules()
          .map((rule) => ({ ruleId: rule.id, effectiveDueAt: Date.parse(rule.nextDueAt!) })),
      );
      await vi.advanceTimersByTimeAsync(600000);
      expect(rounds.phaseComplete('warmup')).toBe(true);
      expect(coordinator.activeRunCount()).toBe(0);
      repo.seedWatchResourceQualificationDigestsV1(
        auth,
        H3B_DESCRIPTOR_SHA256,
        H3B_EXPANDED_SHA256,
        M0,
      );
      expect(repo.listDigestSchedules()).toHaveLength(2);
      const provider = vi.fn(async () => {
        throw new Error('零Provider窗口发生调用');
      });
      const readyAt: number[] = [];
      const digestScheduler = new DigestScheduler(clocks.forOwner('digest-scheduler'), (entry) => {
        void digestService.handleDue(entry).then((result) => {
          expect(result.ok).toBe(true);
        });
      });
      const digestService = new DigestService({
        repository: repo,
        clock: qpc,
        ownership: { track: (work) => registry.track(work), admissionOpen: () => true },
        sharing: {
          get: async () => {
            throw new Error('无AI摘要不应读取Provider投影');
          },
        },
        provider: { resolve: provider },
        scheduleControl: digestScheduler,
        onArtifactReady: () => readyAt.push(Date.now()),
      });
      const digestSchedules = repo
        .listDigestSchedules()
        .sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt));
      digestScheduler.initialize(
        digestSchedules.map((schedule) => ({
          scheduleId: schedule.id,
          expectedNextDueAt: schedule.nextDueAt,
          timeZone: schedule.timeZone,
        })),
      );
      await vi.advanceTimersByTimeAsync(3600000);
      await digestService.drain();
      expect(provider).not.toHaveBeenCalled();
      expect(readyAt).toEqual([M0 + 24 * 60000, M0 + 46 * 60000]);
      for (const [index, schedule] of digestSchedules.entries()) {
        const artifacts = repo.listDigestArtifactsBySchedule(schedule.id);
        const runs = repo.listDigestRunsBySchedule(schedule.id);
        expect(artifacts).toHaveLength(1);
        expect(runs).toHaveLength(1);
        expect(runs[0]?.state).toBe('completed');
        expect(artifacts[0]!.facts.runStats).toEqual(
          index === 0
            ? { changed: 48, unchanged: 52, failed: 0 }
            : { changed: 78, unchanged: 72, failed: 0 },
        );
        expect(artifacts[0]!.facts.eventCount).toBe(index === 0 ? 12 : 26);
        expect(
          artifacts[0]!.facts.events.reduce((sum, event) => sum + event.observationCount, 0),
        ).toBe(index === 0 ? 24 : 39);
        expect(artifacts[0]!.explanationJson).toBeNull();
      }
      digestService.dispose();
      digestScheduler.stop();
      expect(() => rounds.verifyFinal()).not.toThrow();
      const counts = (kind: QualificationRegistryEvent['registry']) =>
        trace.filter((row) => row.kind === 'register' && row.event.registry === kind).length;
      expect(counts('host-grant')).toBe(567);
      expect(counts('coordinator-slot')).toBe(567);
      expect(counts('task-tab')).toBe(120);
      expect(tabs.size).toBe(0);
      expect(repo.listRules().flatMap((rule) => repo.listEventsByRule(rule.id))).toHaveLength(50);
      for (const event of repo.listRules().flatMap((rule) => repo.listEventsByRule(rule.id))) {
        const observations = repo.dbHandle
          .prepare(
            'SELECT event_kind FROM watch_event_observations WHERE event_id = ? ORDER BY sequence',
          )
          .all(event.id);
        const kinds = new Set(
          observations.map((row) => {
            if (typeof row !== 'object' || row === null || !('event_kind' in row))
              throw new Error('观察行缺失类型');
            return row.event_kind;
          }),
        );
        expect(event.eventKind).toBe(kinds.size === 1 ? [...kinds][0] : 'mixed');
      }
      const live = new Map<string, Set<string>>();
      const peaks = new Map<string, number>();
      for (const row of trace) {
        const set = live.get(row.event.registry) ?? new Set<string>();
        live.set(row.event.registry, set);
        if (row.kind === 'register') {
          expect(set.has(row.event.identity)).toBe(false);
          set.add(row.event.identity);
        } else expect(set.delete(row.event.identity)).toBe(true);
        peaks.set(row.event.registry, Math.max(peaks.get(row.event.registry) ?? 0, set.size));
      }
      expect(peaks.get('coordinator-slot')).toBe(4);
      expect(peaks.get('task-tab')).toBe(4);
      expect(peaks.get('host-grant')).toBeLessThanOrEqual(4);
      await coordinator.stop();
      scheduler.stop();
      gate.clear();
      repo.dispose();
      expect(registry.snapshot().every((row) => row.identities.length === 0)).toBe(true);
    } finally {
      if (!repo.isDisposed) repo.dispose();
    }
  }, 20000);
});
