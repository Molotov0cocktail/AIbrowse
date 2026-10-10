import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../shared/watch/clock';
import type { SecureCredentialStore } from '../ai/credential-store';
import { ConfigStore } from '../ai/config-store';
import { ConversationStore } from '../ai/conversation-store';
import { ConversationServiceImpl } from '../ai/conversation-service';
import { ResearchServiceImpl } from '../research/research-service';
import { runResearchMigrations } from '../research/db/research-migrations';
import { openDb } from '../sources/db/sqlite-driver';
import { runMigrations } from '../sources/db/migrations';
import { SourceServiceImpl } from '../sources/source-service';
import { SourceUsageTracker } from '../sources/usage/usage-tracker';
import { SourcesIpcAdmission } from '../sources/source-ipc';
import { runWatchMigrations } from '../watch/db/watch-migrations';
import { WatchRepository } from '../watch/repository/watch-repository';
import { WatchLifecycleCoordinator } from '../watch/watch-lifecycle-coordinator';
import { WatchRunCoordinator } from '../watch/watch-run-coordinator';
import { WatchScheduler } from '../watch/watch-scheduler';
import { HostRequestGate } from '../watch/host-request-gate';
import { WatchProcessingServiceImpl } from '../watch/watch-processing-service';
import { DigestScheduler } from '../watch/digest-scheduler';
import { DigestService } from '../watch/digest-service';
import { WatchIpcAdmission } from '../watch/ipc-admission';
import { WatchPreviewService } from '../watch/watch-preview-service';
import { WatchPreviewStore } from '../watch/watch-preview-store';
import { WatchExportService } from '../watch/watch-export-service';
import { WatchQueryService } from '../watch/watch-query-service';
import { WatchNotificationService } from '../watch/watch-notification-service';
import { WatchTaskTabWorkspace } from '../watch/watch-task-tab-workspace';
import { SessionGrantStore } from '../watch/session-grant-store';
import { MaintenanceAdmission } from './maintenance-admission';
import { createRuntimeMaintenance, runWithMaintenanceAdmission } from './runtime-maintenance';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

function fixture(now?: () => number, expectConversationFailure = false) {
  const dir = mkdtempSync(join(tmpdir(), 'aibrowse-runtime-maintenance-'));
  const sourceDb = openDb(join(dir, 'sources.db'));
  const researchDb = openDb(join(dir, 'research.db'));
  const watchDb = openDb(join(dir, 'watch.db'));
  runMigrations(sourceDb);
  runResearchMigrations(researchDb);
  runWatchMigrations(watchDb);
  const repo = new WatchRepository(watchDb);
  const lifecycle = new WatchLifecycleCoordinator();
  const sources = new SourceServiceImpl({ db: sourceDb, observer: lifecycle });
  lifecycle.bind(repo, (id) => sources.getSourceWatchProjection(id));
  const credentials: SecureCredentialStore = {
    isAvailable: () => true,
    set: async () => false,
    get: async () => null,
    has: async () => false,
    delete: async () => false,
  };
  const store = new ConversationStore(dir);
  const snapshot = deferred<null>();
  const conversation = new ConversationServiceImpl({
    store,
    configStore: new ConfigStore(dir, credentials),
    credentials,
    browser: { getActiveTab: () => snapshot.promise, getPageSnapshot: async () => null },
  });
  const research = new ResearchServiceImpl({ db: researchDb });
  const clock = new FakeClock(Date.parse('2026-10-04T00:00:00Z'));
  const hostGate = new HostRequestGate({ clock });
  const scheduler = new WatchScheduler({ clock, onDue: () => undefined });
  const acquire = vi.fn(async () => ({
    ok: false as const,
    health: 'dependency_unavailable' as const,
    retryable: false,
    retryAfterSeconds: null,
    disposition: 'dependency' as const,
  }));
  const watch = new WatchRunCoordinator({
    repo,
    revalidator: lifecycle,
    acquisition: { run: acquire },
    processing: new WatchProcessingServiceImpl({ repo, clock }),
    hostGate,
    scheduler,
    clock,
  });
  watch.start();
  const digestScheduler = new DigestScheduler(clock, () => undefined);
  const provider = vi.fn(async () => null);
  const digest = new DigestService({
    repository: repo,
    clock,
    sharing: { get: async () => [] },
    provider: { resolve: provider },
    scheduleControl: digestScheduler,
  });
  const grants = new SessionGrantStore();
  const previews = new WatchPreviewStore();
  const preview = new WatchPreviewService({
    store: previews,
    source: (id) => sources.getSourceWatchProjection(id),
    acquisition: () => null,
    discoveryTarget: () => null,
    browser: () => null,
    reader: () => null,
    grants: () => grants,
  });
  const selected = deferred<string | null>();
  const write = vi.fn(async () => undefined);
  const query = new WatchQueryService(
    () => repo,
    () => watch.getState(),
    () => ({
      windowsNotification: 'unavailable',
      windowsReason: 'not-packaged',
    }),
  );
  const exporter = new WatchExportService(query, { showSaveDialog: () => selected.promise, write });
  const deliver = vi.fn(() => true);
  const notifications = new WatchNotificationService(
    () => repo,
    deliver,
    () => undefined,
  );
  const workspace = new WatchTaskTabWorkspace({
    browser: {
      createTab: async () => {
        throw new Error('夹具不创建任务标签页');
      },
      closeTab: async () => false,
      activateTab: async () => false,
      getTabs: async () => [],
      getActiveTab: async () => null,
    },
  });
  const usageReady = deferred<void>();
  const usage = new SourceUsageTracker(async (id, outcome) => {
    await usageReady.promise;
    await sources.recordUsage(id, outcome);
  });
  const rootAdmission = new MaintenanceAdmission();
  const sourceIpcAdmission = new SourcesIpcAdmission();
  const researchIpcAdmission = new MaintenanceAdmission();
  const watchIpcAdmission = new WatchIpcAdmission();
  const coordinator = createRuntimeMaintenance({
    rootAdmission,
    sourceIpcAdmission,
    researchIpcAdmission,
    watchIpcAdmission,
    conversation,
    research,
    watch,
    digest,
    preview,
    exporter,
    notifications,
    windowsNotifications: null,
    sources,
    usage,
    workspace,
    lifecycle,
    now,
  });
  cleanups.push(async () => {
    snapshot.resolve(null);
    usageReady.resolve();
    selected.resolve(null);
    coordinator.shutdown();
    rootAdmission.beginShutdown();
    await rootAdmission.drain();
    if (expectConversationFailure)
      await expect(conversation.shutdown()).rejects.toThrow('会话排水失败');
    else await conversation.shutdown();
    await research.shutdown();
    await watch.stop();
    scheduler.stop();
    digest.dispose();
    digestScheduler.stop();
    usage.dispose();
    lifecycle.dispose();
    sources.dispose();
    repo.dispose();
    hostGate.clear();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    coordinator,
    sources,
    rootAdmission,
    sourceIpcAdmission,
    researchIpcAdmission,
    watchIpcAdmission,
    conversation,
    store,
    snapshot,
    sourceDb,
    researchDb,
    watchDb,
    usage,
    usageReady,
    workspace,
    lifecycle,
    selected,
    exporter,
    write,
    acquire,
    provider,
    deliver,
    digest,
  };
}

describe('同数据世代生产维护装配', () => {
  it('显式原代恢复等待真实usage尾部，重新seal与协调后才打开原service图', async () => {
    const f = fixture(() => 0);
    const added = await f.sources.addManual({ scope: 'page', url: 'https://example.com/' });
    if (!added.ok) throw new Error('夹具信源创建失败');
    const bridge = f.usage.bridge('synthetic-original-recovery');
    bridge.recordSearchHits([
      { sourceId: added.source.id, scope: 'page', canonicalKey: 'https://example.com/' },
    ]);
    bridge.onBrowserOpen('https://example.com/', true);
    bridge.clearRun();
    const entered = deferred<void>();
    const wait = f.usage.waitForIdle.bind(f.usage);
    const usageWait = vi.spyOn(f.usage, 'waitForIdle').mockImplementation(async () => {
      entered.resolve();
      await wait();
    });
    const seal = vi.spyOn(f.sources, 'sealForMaintenance');
    const reconcile = vi.spyOn(f.lifecycle, 'reconcileForMaintenance');
    const pending = f.coordinator.acquire(10_000);
    await entered.promise;
    const operationId = f.coordinator.status().operationId!;
    f.coordinator.cancel(operationId);
    const receipt = await pending;
    const request = { operationId, originalAbsoluteDeadline: 10_000, isCurrent: () => true };
    expect((await f.coordinator.recoverOriginal(request)).ok).toBe(false);
    expect(seal).not.toHaveBeenCalled();
    f.usageReady.resolve();
    await f.coordinator.waitForIdle();
    const recovered = await f.coordinator.recoverOriginal(request);
    expect(recovered.ok).toBe(true);
    expect(receipt).toEqual({ ok: false, reason: 'cancelled' });
    expect(usageWait).toHaveBeenCalledTimes(2);
    expect(seal).toHaveBeenCalledExactlyOnceWith(1);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(f.rootAdmission.isOpen()).toBe(true);
    expect(f.sourceIpcAdmission.isOpen()).toBe(true);
    expect(f.researchIpcAdmission.isOpen()).toBe(true);
    expect(f.sources.getSourceWatchProjection(added.source.id).status).toBe('found');
    expect(await f.conversation.createSession()).not.toBeNull();
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.provider).not.toHaveBeenCalled();
  });

  it('ready撤销后以新ticket重新执行既有late Source协调，旧票据永不恢复', async () => {
    const f = fixture(() => 0);
    const seal = vi.spyOn(f.sources, 'sealForMaintenance');
    const reconcile = vi.spyOn(f.lifecycle, 'reconcileForMaintenance');
    const initial = await f.coordinator.acquire(10_000);
    if (!initial.ok) throw new Error('夹具静止失败');
    f.coordinator.cancel(initial.ticket.operationId);
    const recovered = await f.coordinator.recoverOriginal({
      operationId: initial.ticket.operationId,
      originalAbsoluteDeadline: 10_000,
      isCurrent: () => true,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.ticket.operationId).not.toBe(initial.ticket.operationId);
    expect(recovered.ticket.generation).toBe(initial.ticket.generation);
    expect(seal).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(f.coordinator.resume(initial.ticket)).toBe(false);
    expect(f.coordinator.isQuiescent(initial.ticket)).toBe(false);
    expect(f.rootAdmission.isOpen()).toBe(true);
  });

  it('真实Conversation服务保持持久化失败，same-data proof不能清除失败封闭', async () => {
    const f = fixture(() => 0, true);
    vi.spyOn(f.store, 'saveSessions').mockReturnValue(false);
    expect(await f.conversation.createSession()).toBeNull();
    expect(await f.coordinator.acquire(10_000)).toEqual({
      ok: false,
      reason: 'participant-failed',
    });
    await f.coordinator.waitForIdle();
    expect(
      await f.coordinator.recoverOriginal({
        operationId: f.coordinator.status().operationId!,
        originalAbsoluteDeadline: 10_000,
        isCurrent: () => true,
      }),
    ).toEqual({ ok: false, reason: 'participant-failed' });
    await f.coordinator.waitForIdle();
    expect(f.rootAdmission.isOpen()).toBe(false);
    expect(await f.conversation.createSession()).toBeNull();
  });

  it('根退出后的真实 usage 写入仍先于 Source seal，三库保持打开且可连续两轮恢复', async () => {
    const f = fixture();
    const added = await f.sources.addManual({ scope: 'page', url: 'https://example.com/' });
    if (!added.ok) throw new Error('夹具信源创建失败');
    const ready = deferred<void>();
    const started = deferred<void>();
    const root = runWithMaintenanceAdmission(f.rootAdmission, async (current) => {
      await ready.promise;
      expect(current()).toBe(false);
      const bridge = f.usage.bridge('synthetic-run');
      bridge.recordSearchHits([
        { sourceId: added.source.id, scope: 'page', canonicalKey: 'https://example.com/' },
      ]);
      bridge.onBrowserOpen('https://example.com/', true);
      bridge.clearRun();
      started.resolve();
    });
    const pending = f.coordinator.acquire(performance.now() + 10_000);
    expect(f.rootAdmission.isOpen()).toBe(false);
    ready.resolve();
    await root;
    await started.promise;
    expect(f.coordinator.status().phase).toBe('draining');
    expect(f.sources.getSourceWatchProjection(added.source.id).status).toBe('found');
    f.usageReady.resolve();
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(f.sources.getSourceWatchProjection(added.source.id).status).toBe('unavailable');
    expect([f.sourceDb.isOpen, f.researchDb.isOpen, f.watchDb.isOpen]).toEqual([true, true, true]);
    expect(f.coordinator.isQuiescent(result.ticket)).toBe(true);
    expect(f.coordinator.resume(result.ticket)).toBe(true);
    expect(f.sources.getSourceWatchProjection(added.source.id).status).toBe('found');
    const second = await f.coordinator.acquire(performance.now() + 10_000);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(f.coordinator.resume(result.ticket)).toBe(false);
    expect(f.coordinator.resume(second.ticket)).toBe(true);
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it('真实会话快照与导出对话框各自阻止静止，旧对话框零写入', async () => {
    const f = fixture();
    const session = await f.conversation.createSession();
    if (session === null) throw new Error('夹具会话创建失败');
    await f.conversation.ask({ sessionId: session.id, question: '合成问题' });
    const exporting = f.exporter.exportEventsCsv({});
    const pending = f.coordinator.acquire(performance.now() + 10_000);
    f.snapshot.resolve(null);
    await f.conversation.drainForMaintenance(1);
    expect(f.store.loadMessages(session.id)).toHaveLength(2);
    expect(f.coordinator.status().phase).toBe('draining');
    f.selected.resolve('synthetic.csv');
    expect(await exporting).toEqual({ ok: false, errorCode: 'cancelled' });
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(f.write).not.toHaveBeenCalled();
  });

  it.each(['retained', 'reconcile'] as const)(
    '本地 %s 失败不授 permit、不关库、不恢复根',
    async (failure) => {
      const f = fixture();
      if (failure === 'retained')
        vi.spyOn(f.workspace, 'cleanupAll').mockResolvedValue({
          ok: true,
          closedCount: 0,
          retainedCount: 1,
        });
      else
        vi.spyOn(f.lifecycle, 'reconcileForMaintenance').mockReturnValue({
          ok: false,
          reason: '合成协调失败',
        });
      expect(await f.coordinator.acquire(performance.now() + 10_000)).toEqual({
        ok: false,
        reason: 'reconcile-failed',
      });
      expect(f.rootAdmission.isOpen()).toBe(false);
      expect([f.sourceDb.isOpen, f.researchDb.isOpen, f.watchDb.isOpen]).toEqual([
        true,
        true,
        true,
      ]);
    },
  );

  it('关闭先于异步根首个 await，迟到 quickAdd 续体不重入，shutdown 永久覆盖恢复', async () => {
    const f = fixture();
    const pendingTab = deferred<void>();
    const write = vi.fn();
    let captured: (() => boolean) | null = null;
    const root = runWithMaintenanceAdmission(f.rootAdmission, async (current) => {
      captured = current;
      await pendingTab.promise;
      if (current()) write();
    });
    const pending = f.coordinator.acquire(performance.now() + 10_000);
    await expect(runWithMaintenanceAdmission(f.rootAdmission, write)).rejects.toThrow(
      '数据维护期间',
    );
    pendingTab.resolve();
    await root;
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(write).not.toHaveBeenCalled();
    if (!result.ok) return;
    f.coordinator.shutdown();
    f.rootAdmission.beginShutdown();
    expect(f.coordinator.resume(result.ticket)).toBe(false);
    expect(captured!()).toBe(false);
  });

  it('usage 等待跨过绝对 deadline 后不再清理任务标签页或 seal Source', async () => {
    let now = 10;
    const f = fixture(() => now);
    const added = await f.sources.addManual({ scope: 'page', url: 'https://example.com/' });
    if (!added.ok) throw new Error('夹具信源创建失败');
    const bridge = f.usage.bridge('synthetic-deadline');
    bridge.recordSearchHits([
      { sourceId: added.source.id, scope: 'page', canonicalKey: 'https://example.com/' },
    ]);
    bridge.onBrowserOpen('https://example.com/', true);
    bridge.clearRun();
    const cleanup = vi.spyOn(f.workspace, 'cleanupAll');
    const seal = vi.spyOn(f.sources, 'sealForMaintenance');
    const waiting = deferred<void>();
    const originalWait = f.usage.waitForIdle.bind(f.usage);
    vi.spyOn(f.usage, 'waitForIdle').mockImplementation(async () => {
      waiting.resolve();
      await originalWait();
    });
    const pending = f.coordinator.acquire(1_000);
    await waiting.promise;
    now = 1_001;
    f.usageReady.resolve();
    expect(await pending).toEqual({ ok: false, reason: 'deadline' });
    expect(cleanup).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
    expect(f.rootAdmission.isOpen()).toBe(false);
  });

  it('一个域恢复提交失败后 root 仍关闭，重新 arm 的后台不能进入新根', async () => {
    const f = fixture();
    const result = await f.coordinator.acquire(performance.now() + 10_000);
    if (!result.ok) throw new Error('夹具静止失败');
    vi.spyOn(f.digest, 'resumeAfterMaintenance').mockReturnValue(false);
    expect(f.coordinator.resume(result.ticket)).toBe(false);
    const claim = vi.fn();
    await expect(runWithMaintenanceAdmission(f.rootAdmission, claim)).rejects.toThrow(
      '数据维护期间',
    );
    expect(claim).not.toHaveBeenCalled();
    expect(f.coordinator.status().reason).toBe('resume-failed');
  });
});
