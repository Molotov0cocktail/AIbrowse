import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigStore } from '../../../src/main/ai/config-store';
import type { SecureCredentialStore } from '../../../src/main/ai/credential-store';
import { ConversationServiceImpl } from '../../../src/main/ai/conversation-service';
import { ConversationStore } from '../../../src/main/ai/conversation-store';
import { registerProviderFactory } from '../../../src/main/ai/provider/llm-provider';
import type { ConversationMessage } from '../../../src/shared/types/conversation';
import { openResearchStore } from '../../../src/main/research/research-store';
import { createProductionResearchRuntimeFactory } from '../../../src/main/research/research-runtime-factory';
import { ResearchRepository } from '../../../src/main/research/repository/research-repository';
import { openDb, closeDb } from '../../../src/main/sources/db/sqlite-driver';
import { runWatchMigrations } from '../../../src/main/watch/db/watch-migrations';
import { WatchRepository } from '../../../src/main/watch/repository/watch-repository';
import {
  WatchRunCoordinator,
  type WatchAcquisitionPort,
} from '../../../src/main/watch/watch-run-coordinator';
import { WatchProcessingServiceImpl } from '../../../src/main/watch/watch-processing-service';
import { HostRequestGate } from '../../../src/main/watch/host-request-gate';
import { createSystemClock } from '../../../src/shared/watch/clock';
import { computeSourceLocatorFingerprint } from '../../../src/shared/watch/watch-rule-state';
import type { WatchAcquisitionResult, WatchRule } from '../../../src/shared/types/watch';
import { BUDGET, assertFact, legacyReturnedBeforeDrain, type DrainObservation } from './contract';
import {
  DelayedProvider,
  Latch,
  PromiseObservation,
  PROVIDER_KIND,
  observeConversationRun,
  waitForProviderEntry,
  type Trace,
} from './controls';

const credentials: SecureCredentialStore = {
  isAvailable: () => true,
  has: async (kind) => kind === PROVIDER_KIND,
  get: async () => {
    throw new Error('资格不得读取凭据');
  },
  set: async () => {
    throw new Error('资格不得写入凭据');
  },
  delete: async () => {
    throw new Error('资格不得删除凭据');
  },
};

function configure(root: string, provider: DelayedProvider): ConfigStore {
  registerProviderFactory({ kind: PROVIDER_KIND, create: () => provider });
  const config = new ConfigStore(root, credentials);
  assertFact(
    config.set({
      providerId: PROVIDER_KIND,
      baseUrl: 'https://synthetic.invalid/',
      model: 'synthetic',
    }),
    '合成配置写入失败',
  );
  return config;
}

export interface CaseEvidence extends DrainObservation {
  name: 'conversation' | 'research' | 'watch';
  observedEarlyReturn: boolean;
  abortObserved: boolean;
  releaseAt: number;
  returnToSettleMs: number;
  terminalStatus: string;
  persistedAfterReturn: boolean;
  outstanding: number;
}

function finish(
  value: Omit<CaseEvidence, 'observedEarlyReturn' | 'returnToSettleMs'>,
): CaseEvidence {
  assertFact(value.actualSettledAt !== null, '原操作未确认结束');
  const observedEarlyReturn = legacyReturnedBeforeDrain(value);
  assertFact(observedEarlyReturn, '预设提前返回反例未出现，停止并诊断，不迁就观测修改 oracle');
  assertFact(value.abortObserved && value.outstanding === 0, '取消或实际排水未确认');
  return {
    ...value,
    observedEarlyReturn,
    returnToSettleMs: value.actualSettledAt - value.methodReturnedAt,
  };
}

export async function conversationCase(root: string, trace: Trace): Promise<CaseEvidence> {
  const provider = new DelayedProvider();
  const actual = new PromiseObservation();
  const writes: Array<{ at: number; terminal: boolean; ok: boolean }> = [];
  class ObservedStore extends ConversationStore {
    override saveMessages(id: string, messages: ConversationMessage[]): boolean {
      const ok = super.saveMessages(id, messages);
      const terminal = messages.some((message) => message.role === 'assistant');
      writes.push({ at: performance.now(), terminal, ok });
      trace('conversation.saveMessages', { terminal, ok });
      return ok;
    }
  }
  const store = new ObservedStore(root);
  const service = new ConversationServiceImpl({
    store,
    configStore: configure(root, provider),
    credentials,
    browser: { getActiveTab: async () => null, getPageSnapshot: async () => null },
    resolveProviderFn: async () => provider,
    onTurnDone: (event) => trace('conversation.turnDone', { status: event.status }),
  });
  observeConversationRun(service, actual);
  try {
    const session = await service.createSession();
    assertFact(session !== null, '合成会话创建失败');
    assertFact(
      (await service.ask({ sessionId: session.id, question: '固定合成排水问题' })).ok,
      '合成会话启动失败',
    );
    await provider.entered.promise;
    trace('conversation.providerEntered');
    service.dispose();
    const methodReturnedAt = performance.now();
    const pendingAtReturn = actual.pending;
    const terminalAtReturn = store
      .loadMessages(session.id)
      .some((message) => message.role === 'assistant');
    trace('conversation.disposeReturned', { pending: pendingAtReturn, terminalAtReturn });
    await delay(BUDGET.holdAfterReturnMs);
    const pendingAfterHold = actual.pending;
    const releaseAt = performance.now();
    trace('conversation.providerReleased', { pendingAfterHold });
    provider.release.release();
    await actual.promise;
    await provider.ended.promise;
    trace('conversation.actualPromiseSettled', { settledAt: actual.settledAt });
    const terminal = store.loadMessages(session.id).find((message) => message.role === 'assistant');
    const persistedAfterReturn = writes.some(
      (write) => write.ok && write.terminal && write.at > methodReturnedAt,
    );
    assertFact(
      !terminalAtReturn && terminal?.status === 'aborted' && persistedAfterReturn,
      '会话终态写入反例未证实',
    );
    return finish({
      name: 'conversation',
      methodReturnedAt,
      pendingAtReturn,
      pendingAfterHold,
      actualSettledAt: actual.settledAt,
      terminalAtReturn,
      terminalAfterRelease: terminal !== undefined,
      abortObserved: provider.aborted,
      releaseAt,
      terminalStatus: terminal.status,
      persistedAfterReturn,
      outstanding: actual.pending,
    });
  } finally {
    service.dispose();
    provider.release.release();
    if (actual.promise !== null) await actual.promise;
  }
}

export async function researchCase(root: string, trace: Trace): Promise<CaseEvidence> {
  const provider = new DelayedProvider();
  const actual = new PromiseObservation();
  let groupCalls = 0;
  const dbPath = join(root, 'research.db');
  const configStore = configure(root, provider);
  const outcome = openResearchStore({
    dbPath,
    buildRuntimeFactory(db) {
      const factory = createProductionResearchRuntimeFactory({
        db,
        configStore,
        credentials,
        browser: {
          createTab: async () => {
            throw new Error('固定取消场景不得创建 Tab');
          },
          closeTab: async () => {
            throw new Error('固定取消场景不得关闭 Tab');
          },
          activateTab: async () => false,
          getTabs: async () => [],
          getActiveTab: async () => null,
          getPageSnapshot: async () => null,
        },
        sourceService: {
          getState: () => ({ mode: 'normal' }),
          search: async () => {
            throw new Error('固定取消场景不得检索 Sources');
          },
          list: async () => {
            throw new Error('固定取消场景不得枚举 Sources');
          },
          listGroups: async (options) => {
            assertFact(
              ++groupCalls === 1 && options.page === 0 && options.pageSize === 20,
              '固定研究准备只允许一次首页空分组读取',
            );
            trace('research.listGroups', {
              calls: groupCalls,
              page: options.page,
              pageSize: options.pageSize,
            });
            return { ok: true, page: 0, pageSize: 20, total: 0, groups: [] };
          },
          get: async () => {
            throw new Error('固定取消场景不得读取 Sources');
          },
        },
        searchProvider: {
          id: 'synthetic',
          search: async () => {
            throw new Error('资格不得联网搜索');
          },
        },
      });
      return {
        async resolveProvider() {
          trace('research.resolveProviderStarted');
          const resolved = await factory.resolveProvider();
          trace('research.resolveProviderFinished', {
            ok: resolved.ok,
            errorCode: resolved.ok ? null : resolved.errorCode,
          });
          if (!resolved.ok) return resolved;
          return {
            ok: true,
            prepared: {
              release: () => resolved.prepared.release(),
              launch(input) {
                trace('research.runtimeLaunch');
                const handle = resolved.prepared.launch(input);
                actual.track(handle.done);
                void handle.done.then(
                  () => trace('research.runtimeDone', { rejected: false }),
                  () => trace('research.runtimeDone', { rejected: true }),
                );
                return handle;
              },
            },
          };
        },
      };
    },
  });
  assertFact(outcome.mode === 'normal', '真实合成 Research SQLite 初始化失败');
  const service = outcome.service;
  const reader = openDb(dbPath);
  const repository = new ResearchRepository(reader);
  try {
    const created = await service.createTask('固定合成研究排水问题');
    assertFact(created.ok, '合成 Research 创建失败');
    trace('research.taskCreated');
    const started = await service.startTask(created.task.id);
    trace('research.startReturned', { ok: started.ok, pending: actual.pending });
    assertFact(started.ok, '生产 Research 工厂启动失败');
    assertFact(actual.promise !== null, 'Research 启动未产生可观察的真实 runtime Promise');
    try {
      await waitForProviderEntry(provider.entered.promise, actual.promise);
      assertFact(actual.pending === 1, 'Research Provider 进入时 runtime 已提前结束');
      assertFact(groupCalls === 1, 'Research Provider 前未完成固定空分组准备');
    } catch (error) {
      const task = repository.getTaskById(created.task.id);
      trace('research.providerEntryRejected', {
        status: task?.status ?? 'missing',
        errorCode: task?.errorCode ?? null,
        pending: actual.pending,
        groupCalls,
        stepsUsed: task?.stats.stepsUsed ?? null,
        roundsUsed: task?.stats.roundsUsed ?? null,
      });
      throw error;
    }
    trace('research.providerEntered', { groupCalls });
    const stopped = await service.stopTask(created.task.id);
    const methodReturnedAt = performance.now();
    assertFact(stopped.ok, 'Research stop 未接受取消');
    const pendingAtReturn = actual.pending;
    const atReturn = repository.getTaskById(created.task.id);
    const terminalAtReturn = atReturn?.status === 'cancelled';
    trace('research.stopReturned', {
      pending: pendingAtReturn,
      status: atReturn?.status ?? 'missing',
    });
    await delay(BUDGET.holdAfterReturnMs);
    const pendingAfterHold = actual.pending;
    const releaseAt = performance.now();
    trace('research.providerReleased', { pendingAfterHold });
    provider.release.release();
    await actual.promise;
    await provider.ended.promise;
    trace('research.actualPromiseSettled', { settledAt: actual.settledAt });
    const terminal = repository.getTaskById(created.task.id);
    trace('research.sqliteTerminalRead', { status: terminal?.status ?? 'missing' });
    assertFact(
      atReturn?.status === 'running' && terminal?.status === 'cancelled',
      'Research 真实 SQLite 终态写入反例未证实',
    );
    return finish({
      name: 'research',
      methodReturnedAt,
      pendingAtReturn,
      pendingAfterHold,
      actualSettledAt: actual.settledAt,
      terminalAtReturn,
      terminalAfterRelease: terminal.status === 'cancelled',
      abortObserved: provider.aborted,
      releaseAt,
      terminalStatus: terminal.status,
      persistedAfterReturn: true,
      outstanding: actual.pending,
    });
  } finally {
    provider.release.release();
    await service.shutdown();
    closeDb(reader);
  }
}

function fixedRule(): WatchRule {
  const now = new Date().toISOString();
  const sourceId = '11111111-1111-4111-8111-111111111111';
  const canonicalKey = 'https://synthetic.invalid/doc';
  const feedUrl = 'https://synthetic.invalid/feed.xml';
  return {
    id: '22222222-2222-4222-8222-222222222222',
    version: 1,
    sourceId,
    kind: 'feed',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'public',
    schedule: { kind: 'interval', intervalMinutes: 15 },
    target: { type: 'feed', feedUrl, format: 'rss2' },
    condition: null,
    notificationLevel: 'normal',
    showDetails: false,
    sourceRowVersion: 1,
    sourceLocatorFingerprint: computeSourceLocatorFingerprint({
      sourceId,
      scope: 'page',
      canonicalKey,
      kind: 'feed',
      canonicalTargetUrl: feedUrl,
    }),
    nextDueAt: now,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export async function watchCase(root: string, trace: Trace): Promise<CaseEvidence> {
  const db = openDb(join(root, 'watch.db'));
  runWatchMigrations(db);
  const repo = new WatchRepository(db);
  const rule = fixedRule();
  assertFact(repo.insertRule(rule).ok, '合成 Watch 规则写入失败');
  const actual = new PromiseObservation();
  const release = new Latch();
  let aborted = false;
  const clock = createSystemClock();
  const acquisition: WatchAcquisitionPort = {
    run(input) {
      const operation = (async (): Promise<WatchAcquisitionResult> => {
        const onAbort = () => {
          aborted = true;
        };
        input.signal.addEventListener('abort', onAbort, { once: true });
        try {
          await release.promise;
          assertFact(input.signal.aborted, '采集释放前未收到取消');
          return {
            ok: false,
            health: 'interrupted',
            retryable: false,
            retryAfterSeconds: null,
            disposition: 'network',
          };
        } finally {
          input.signal.removeEventListener('abort', onAbort);
        }
      })();
      return actual.track(operation);
    },
  };
  const coordinator = new WatchRunCoordinator({
    repo,
    clock,
    acquisition,
    hostGate: new HostRequestGate({ clock }),
    processing: new WatchProcessingServiceImpl({ repo, clock }),
    scheduler: { initialize: () => {}, upsert: () => {}, remove: () => {}, stop: () => {} },
    revalidator: {
      revalidateRuleSource: () => ({
        status: 'ok',
        rowVersion: 1,
        sourceAfterAcquisition: {
          sourceId: rule.sourceId,
          rowVersion: 1,
          enabled: true,
          deletedAt: null,
          scope: 'page',
          canonicalKey: 'https://synthetic.invalid/doc',
        },
      }),
    },
  });
  try {
    coordinator.start();
    const started = coordinator.manualRun(rule.id, 'fixed-drain-request');
    assertFact(started.ok, '真实 Watch 编排器启动失败');
    await actual.entered.promise;
    trace('watch.acquisitionEntered');
    await coordinator.stop();
    const methodReturnedAt = performance.now();
    const pendingAtReturn = actual.pending;
    const before = repo.getRun(started.runId);
    const terminalAtReturn = before?.status === 'finished';
    trace('watch.stopReturned', {
      pending: pendingAtReturn,
      coordinatorActive: coordinator.activeRunCount(),
      status: before?.status ?? 'missing',
    });
    await delay(BUDGET.holdAfterReturnMs);
    const pendingAfterHold = actual.pending;
    const releaseAt = performance.now();
    trace('watch.acquisitionReleased', { pendingAfterHold });
    release.release();
    await actual.promise;
    trace('watch.actualPromiseSettled', { settledAt: actual.settledAt });
    const after = repo.getRun(started.runId);
    const terminalAfterRelease = after?.status === 'finished';
    assertFact(
      coordinator.activeRunCount() === 0 &&
        before?.status === 'running' &&
        after?.status === 'running',
      'Watch 原操作与取消竞争的预设边界未证实',
    );
    return finish({
      name: 'watch',
      methodReturnedAt,
      pendingAtReturn,
      pendingAfterHold,
      actualSettledAt: actual.settledAt,
      terminalAtReturn,
      terminalAfterRelease,
      abortObserved: aborted,
      releaseAt,
      terminalStatus: after.status,
      persistedAfterReturn: false,
      outstanding: actual.pending,
    });
  } finally {
    release.release();
    await coordinator.stop();
    if (actual.promise !== null) await actual.promise;
    repo.dispose();
  }
}
