import { app, utilityProcess } from 'electron';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigStore } from '../../../src/main/ai/config-store';
import type { SecureCredentialStore } from '../../../src/main/ai/credential-store';
import { registerProviderFactory } from '../../../src/main/ai/provider/llm-provider';
import type { ConversationServiceImpl } from '../../../src/main/ai/conversation-service';
import type { ConversationStore } from '../../../src/main/ai/conversation-store';
import type { ResearchServiceImpl } from '../../../src/main/research/research-service';
import type { ResearchRuntimeFactory } from '../../../src/shared/types/research';
import type {
  SourceUsageTracker,
  SourceUsageWriter,
} from '../../../src/main/sources/usage/usage-tracker';
import type { WatchRepository } from '../../../src/main/watch/repository/watch-repository';
import type { WatchRunCoordinator } from '../../../src/main/watch/watch-run-coordinator';
import type { DigestService } from '../../../src/main/watch/digest-service';
import type { WatchPreviewService } from '../../../src/main/watch/watch-preview-service';
import type { WatchExportService } from '../../../src/main/watch/watch-export-service';
import type { WatchNotificationService } from '../../../src/main/watch/watch-notification-service';
import type { WatchAcquisitionService } from '../../../src/main/watch/watch-acquisition-service';
import type {
  MaintenanceCoordinator,
  MaintenanceTicket,
} from '../../../src/main/storage/maintenance-coordinator';
import { denseEvidence } from '../envelope-fixtures';
import { fixtureId, sourceInput } from '../fixtures';
import { BUDGET, assertFact, validateUiPhase, type UiPhase, type UiSample } from './contract';
import {
  ControlledProvider,
  Hold,
  KIND,
  Latch,
  ObservedPromise,
  enteredBeforeDone,
  observeMethod,
} from './controls';
import { isPing, isSample } from './ui-protocol';
import { ScanOperation } from './protocol';
import { diskCensus } from './disk';

export interface ActualRuntime {
  maintenance: MaintenanceCoordinator;
  conversation: ConversationServiceImpl;
  research: ResearchServiceImpl;
  watch: WatchRunCoordinator;
  repository: WatchRepository;
  digest: DigestService;
  preview: WatchPreviewService;
  exporter: WatchExportService;
  notifications: WatchNotificationService;
  usage: SourceUsageTracker;
  runRoot<T>(work: () => T | Promise<T>): Promise<T>;
  shutdown(): Promise<void>;
}
let current: RuntimeQualification | null = null;
export function runtimeQualification(): RuntimeQualification {
  assertFact(current !== null, '专属资格入口尚未初始化');
  return current;
}
export function initializeRuntimeQualification(root: string): void {
  assertFact(current === null, '资格入口重复初始化');
  current = new RuntimeQualification(root);
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ActiveObservations {
  chat: ObservedPromise;
  agent: ObservedPromise;
  research: ObservedPromise;
  watch: ObservedPromise;
  watchOrchestration: ObservedPromise;
  digest: ObservedPromise;
  preview: ObservedPromise;
  exporter: ObservedPromise;
  usage: ObservedPromise;
}
export function activeOriginals(observations: ActiveObservations): ObservedPromise[] {
  return [
    observations.chat,
    observations.agent,
    observations.research,
    observations.watch,
    observations.watchOrchestration,
    observations.digest,
    observations.preview,
    observations.exporter,
    observations.usage,
  ];
}
export const ACTIVE_LEAF_NAMES = [
  'chatProvider',
  'agentProvider',
  'researchProvider',
  'digestProvider',
  'watchAcquisition',
  'previewAcquisition',
  'exportDialog',
  'sourceUsageWriter',
] as const;
export type ActiveHolds = Record<(typeof ACTIVE_LEAF_NAMES)[number], Hold>;
export function activeDrainSnapshot(
  maintenance: ReturnType<MaintenanceCoordinator['status']>,
  holds: ActiveHolds,
  originals: ActiveObservations,
) {
  return {
    at: performance.now(),
    maintenance,
    leaves: ACTIVE_LEAF_NAMES.map((name) => ({ name, ...holds[name].snapshot() })),
    originals: Object.entries(originals).map(([name, value]) => ({
      name,
      pending: value.pending(),
      settledAt: value.settledAt,
      rejected: value.rejected,
    })),
  };
}
export function assertActiveHold(snapshot: ReturnType<typeof activeDrainSnapshot>): void {
  assertFact(
    snapshot.maintenance.phase === 'draining' &&
      snapshot.leaves.length === ACTIVE_LEAF_NAMES.length &&
      snapshot.leaves.every((value) => value.pending),
    '人工保持期间叶操作或维护提前结束',
  );
}
export function assertOriginalsDrainedBeforeReady(
  originals: readonly ObservedPromise[],
  readyAt: number,
): void {
  assertFact(
    originals.every(
      (item) => item.settledAt !== null && item.settledAt <= readyAt && !item.rejected,
    ),
    '原操作未成功排水',
  );
}

class RuntimeQualification {
  private readonly startedAt = performance.now();
  private readonly deadline = this.startedAt + BUDGET.applicationMs;
  private readonly chat = new ControlledProvider();
  private readonly agent = new ControlledProvider(true);
  private readonly research = new ControlledProvider();
  private readonly digest = new ControlledProvider();
  private readonly watchHold = new Hold();
  private readonly previewHold = new Hold();
  private readonly exportHold = new Hold();
  private readonly usageHold = new Hold();
  private readonly chatPromise = new ObservedPromise();
  private readonly agentPromise = new ObservedPromise();
  private readonly researchPromise = new ObservedPromise();
  private readonly usagePromise = new ObservedPromise();
  private readonly watchPromise = new ObservedPromise();
  private readonly watchOrchestration = new ObservedPromise();
  private readonly uiReady = new Latch();
  private readonly uiSamples: UiSample[] = [];
  private readonly uiEvidence: object[] = [];
  private uiOverall: object | null = null;
  private readonly writes: object[] = [];
  private previousPing = 0;
  private pendingPing: number | null = null;
  private uiFailed = false;
  private providerCount = 0;
  private attached = false;
  private observations: object[] = [];
  constructor(private readonly root: string) {
    writeFileSync(
      join(root, 'runtime', 'report.json'),
      JSON.stringify({
        version: 1,
        completed: false,
        productE2Pass: false,
        failure: '资格尚未完成',
        budget: BUDGET,
      }),
    );
    this.trace('entry.ready');
  }
  private trace(name: string, facts: object = {}): void {
    appendFileSync(
      join(this.root, 'runtime', 'events.jsonl'),
      JSON.stringify({ name, at: performance.now(), ...facts }) + '\n',
    );
  }
  async configure(config: ConfigStore, credentials: SecureCredentialStore): Promise<void> {
    const providers = [this.chat, this.agent, this.research];
    registerProviderFactory({
      kind: KIND,
      create: () => {
        const provider = providers[this.providerCount++];
        assertFact(provider !== undefined, '固定 Provider 创建次数改变');
        return provider;
      },
    });
    assertFact(
      config.set({ providerId: KIND, baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic' }),
      '合成 Provider 配置失败',
    );
    assertFact(
      await credentials.set(KIND, 'synthetic-nonsecret-qualification-token'),
      '合成凭据写入失败',
    );
  }
  factory(factory: ResearchRuntimeFactory): ResearchRuntimeFactory {
    return {
      resolveProvider: async () => {
        const result = await factory.resolveProvider();
        if (!result.ok) return result;
        return {
          ok: true,
          prepared: {
            release: () => result.prepared.release(),
            launch: (input) => {
              const handle = result.prepared.launch(input);
              this.researchPromise.track(handle.done);
              return handle;
            },
          },
        };
      },
    };
  }
  store(store: ConversationStore): ConversationStore {
    const save = store.saveMessages.bind(store);
    store.saveMessages = (id, messages) => {
      const ok = save(id, messages);
      this.writes.push({
        id,
        at: performance.now(),
        ok,
        statuses: messages.filter((m) => m.role === 'assistant').map((m) => m.status),
      });
      return ok;
    };
    return store;
  }
  usageWriter(writer: SourceUsageWriter): SourceUsageWriter {
    return (id, outcome) =>
      this.usagePromise.track(
        (async () => {
          await this.usageHold.wait();
          await writer(id, outcome);
        })(),
      );
  }
  acquisition(service: WatchAcquisitionService): WatchAcquisitionService {
    service.run = (input) => {
      const hold = input.rule.sourceId === fixtureId(0) ? this.watchHold : this.previewHold;
      assertFact(
        [fixtureId(0), fixtureId(1)].includes(input.rule.sourceId),
        '固定 acquisition 身份改变',
      );
      const original = (async (): ReturnType<WatchAcquisitionService['run']> => {
        await hold.wait(input.signal);
        assertFact(input.signal.aborted, 'acquisition 未取消便被释放');
        return {
          ok: false,
          health: 'interrupted',
          retryable: false,
          retryAfterSeconds: null,
          disposition: 'aborted',
        };
      })();
      return hold === this.watchHold ? this.watchPromise.track(original) : original;
    };
    return service;
  }
  digestProvider() {
    return { provider: this.digest, model: 'synthetic' };
  }
  async saveDialog(): Promise<null> {
    await this.exportHold.wait();
    return null;
  }
  ping(payload: unknown): number {
    if (
      !isPing(payload) ||
      payload.sequence !== this.previousPing + 1 ||
      this.pendingPing !== null
    ) {
      this.uiFailed = true;
      throw new Error('资格 UI 帧无效');
    }
    this.pendingPing = payload.sequence;
    this.previousPing = payload.sequence;
    return payload.sequence;
  }
  sample(payload: unknown): boolean {
    if (!isSample(payload) || payload.sequence !== this.pendingPing) {
      this.uiFailed = true;
      return false;
    }
    this.pendingPing = null;
    this.uiSamples.push({
      sequence: payload.sequence,
      observedAt: performance.now(),
      roundTripMs: payload.roundTripMs,
    });
    if (this.uiSamples.length >= 6) this.uiReady.release();
    return true;
  }
  private async phase<T>(name: UiPhase, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    this.trace('phase.start', { phase: name });
    const result = await work();
    const workFinished = performance.now();
    await delay(Math.max(0, BUDGET.uiPhaseMs + 60 - (workFinished - started)));
    const finished = performance.now();
    this.observations.push({ phase: `disk-${name}`, at: finished, ...diskCensus(this.root) });
    const samples = this.uiSamples.filter(
      (sample) => sample.observedAt >= started && sample.observedAt <= finished,
    );
    const oracle = validateUiPhase(started, finished, samples);
    this.uiEvidence.push({ name, started, workFinished, finished, samples, oracle });
    assertFact(!this.uiFailed && oracle.ok, '实际 UI 响应阈值未通过');
    this.trace('phase.end', { phase: name, sampleCount: samples.length });
    return result;
  }
  private async acquire(runtime: ActualRuntime): Promise<MaintenanceTicket> {
    const begin = performance.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const ready = await Promise.race([
      runtime.maintenance.acquire(this.deadline),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const operation = runtime.maintenance.status().operationId;
          if (operation !== null) runtime.maintenance.cancel(operation);
          reject(new Error('维护 ready 超过固定 20 秒'));
        }, BUDGET.maintenanceMs);
      }),
    ]).finally(() => clearTimeout(timeout));
    assertFact(ready.ok && runtime.maintenance.isQuiescent(ready.ticket), '实际维护未获得静默许可');
    this.observations.push({
      phase: 'acquire-ready',
      durationMs: performance.now() - begin,
      generation: ready.ticket.generation,
    });
    return ready.ticket;
  }
  private async scan(): Promise<object> {
    const operation = new ScanOperation(this.root.split(/[\\/]/).at(-1)!.slice('runtime-'.length));
    const started = performance.now();
    const child = utilityProcess.fork(join(this.root, 'utility', 'worker.cjs'), [], {
      serviceName: 'AIbrowse E2 固定语义资格',
      stdio: 'pipe',
      env: {
        SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        TEMP: join(this.root, 'runtime'),
        TMP: join(this.root, 'runtime'),
      },
    });
    child.stdout?.on('data', (value: Buffer) => {
      if (value.length > 0) {
        operation.fail('protocol');
        child.kill();
      }
    });
    let diagnosticBytes = 0;
    child.stderr?.on('data', (value: Buffer) => {
      diagnosticBytes += value.length;
      if (diagnosticBytes > 8192) {
        operation.fail('protocol');
        child.kill();
      } else appendFileSync(join(this.root, 'runtime', 'utility-stderr.txt'), value);
    });
    let killAt: number | null = null;
    const timer = setTimeout(() => {
      const cancel = operation.send('cancel');
      if (cancel !== null) child.postMessage(cancel);
      killAt = performance.now();
      child.kill();
    }, BUDGET.utilityMs);
    await new Promise<void>((resolve) => {
      child.on('message', (raw: unknown) => {
        const frame = operation.receive(raw);
        if (frame?.kind === 'stage')
          this.trace('utility.stage', { stage: frame.stage, elapsedMs: frame.elapsedMs });
        if (operation.failure !== null) {
          killAt ??= performance.now();
          child.kill();
        }
      });
      child.once('exit', (code) => {
        operation.confirmExit(code);
        resolve();
      });
      child.once('spawn', () => {
        const init = operation.send('init');
        if (init !== null) child.postMessage(init);
        else child.kill();
      });
    });
    clearTimeout(timer);
    const evidence = {
      elapsedMs: performance.now() - started,
      killToExitMs: killAt === null ? null : performance.now() - killAt,
      result: operation.result,
      accepted: operation.accepted(),
      exited: operation.exited,
      frames: operation.budget.count,
      bytes: operation.budget.bytes,
      late: operation.late,
      failure: operation.failure,
    };
    this.observations.push({ phase: 'utility', ...evidence });
    assertFact(operation.accepted(), '实际 utility 语义资格失败');
    return evidence;
  }
  private releaseAll(): void {
    for (const hold of [
      this.chat.hold,
      this.agent.hold,
      this.research.hold,
      this.digest.hold,
      this.watchHold,
      this.previewHold,
      this.exportHold,
      this.usageHold,
    ])
      hold.release.release();
  }
  async run(runtime: ActualRuntime): Promise<void> {
    assertFact(!this.attached, '实际 main 装配重复');
    this.attached = true;
    let completed = false;
    let failure: string | null = null;
    try {
      await this.uiReady.promise;
      const idle = await this.phase('idle-maintenance', () => this.acquire(runtime));
      await this.phase('utility', () => this.scan());
      assertFact(runtime.maintenance.resume(idle), 'idle 同代恢复失败');
      await this.active(runtime);
      await this.phase('resumed', async () => {
        assertFact(runtime.maintenance.status().phase === 'idle', '维护未恢复');
        assertFact(
          (await runtime.runRoot(() => runtime.conversation.listSessions())).length === 50,
          '恢复后实际根入口不可用',
        );
      });
      const uiStartedAt = this.uiSamples[0]!.observedAt;
      const uiFinishedAt = performance.now();
      const uiOracle = validateUiPhase(uiStartedAt, uiFinishedAt, this.uiSamples);
      this.uiOverall = {
        startedAt: uiStartedAt,
        finishedAt: uiFinishedAt,
        samples: this.uiSamples.slice(),
        oracle: uiOracle,
      };
      assertFact(!this.uiFailed && uiOracle.ok, '实际 UI 全程或相间响应阈值未通过');
      completed = true;
    } catch (error) {
      failure = error instanceof Error ? error.message : '固定资格失败';
      this.trace('qualification.failed', { failure });
    } finally {
      this.releaseAll();
      try {
        await runtime.shutdown();
        this.trace('shutdown.complete');
      } catch {
        completed = false;
        failure = '实际退出排水失败，句柄保留直到 Job 收口';
      }
      writeFileSync(
        join(this.root, 'runtime', 'report.json'),
        JSON.stringify(
          {
            version: 1,
            completed,
            productE2Pass: false,
            failure,
            durationMs: performance.now() - this.startedAt,
            budget: BUDGET,
            observations: this.observations,
            ui: this.uiEvidence,
            uiOverall: this.uiOverall,
            writes: this.writes,
            providerCount: this.providerCount,
          },
          null,
          2,
        ),
      );
      if (failure !== '实际退出排水失败，句柄保留直到 Job 收口') app.exit(completed ? 0 : 2);
    }
  }
  private async active(runtime: ActualRuntime): Promise<void> {
    observeMethod(runtime.conversation, 'runAsk', this.chatPromise);
    observeMethod(runtime.conversation, 'runAgentRun', this.agentPromise);
    assertFact(
      (
        await runtime.runRoot(() =>
          runtime.conversation.ask({ sessionId: fixtureId(1), question: '固定离线维护共读' }),
        )
      ).ok,
      '实际共读启动失败',
    );
    await enteredBeforeDone(this.chat.hold.entered.promise, this.chatPromise);
    assertFact(
      (
        await runtime.runRoot(() =>
          runtime.conversation.agentAsk({
            sessionId: fixtureId(2),
            goal: '固定离线维护 Source 工具',
          }),
        )
      ).ok,
      '实际 Agent 启动失败',
    );
    await enteredBeforeDone(this.agent.hold.entered.promise, this.agentPromise);
    const task = await runtime.runRoot(() => runtime.research.createTask('固定离线维护研究'));
    assertFact(task.ok, '实际 Research 创建失败');
    assertFact(
      (await runtime.runRoot(() => runtime.research.startTask(task.task.id))).ok,
      '实际 Research 启动失败',
    );
    await enteredBeforeDone(this.research.hold.entered.promise, this.researchPromise);
    const repo = runtime.repository;
    observeMethod(runtime.watch, 'executeRun', this.watchOrchestration);
    repo.dbHandle
      .prepare(
        "UPDATE watch_rules SET state='enabled',pause_reason=NULL,desired_enabled=1 WHERE id=?",
      )
      .run(fixtureId(0));
    const run = await runtime.runRoot(() =>
      runtime.watch.manualRun(fixtureId(0), 'runtime-qualification-manual'),
    );
    assertFact(run.ok, '实际 Watch 启动失败');
    await enteredBeforeDone(this.watchHold.entered.promise, this.watchOrchestration);
    const preview = new ObservedPromise();
    preview.track(
      runtime.runRoot(() =>
        runtime.preview.previewFeed({ mode: 'source', sourceId: fixtureId(1) }),
      ),
    );
    await enteredBeforeDone(this.previewHold.entered.promise, preview);
    const exporter = new ObservedPromise();
    exporter.track(
      runtime.runRoot(() => runtime.exporter.exportEventsCsv({ sourceId: fixtureId(0) })),
    );
    await enteredBeforeDone(this.exportHold.entered.promise, exporter);
    const due = new Date().toISOString();
    assertFact(
      repo.createDigestSchedule({
        id: 'runtime-qualification-digest',
        sourceIds: [fixtureId(0)],
        localTime: '09:00',
        timeZone: 'Asia/Shanghai',
        aiEnabled: true,
        nextDueAt: due,
        nowIso: new Date(Date.parse(due) - 1000).toISOString(),
      }).ok,
      '固定 Digest schedule 创建失败',
    );
    const rule = repo.getRule(fixtureId(0));
    assertFact(rule !== null, '实际 Rule 缺失');
    const eventId = fixtureId(900000);
    assertFact(
      repo.writeEventTransaction({
        event: {
          id: eventId,
          ruleId: rule.id,
          sourceId: rule.sourceId,
          eventKind: 'changed',
          importance: 'normal',
          idempotencyKey: 'runtime-qualification-event',
          changeFingerprint: 'a'.repeat(64),
          firstObservedAt: due,
          lastObservedAt: due,
          itemCount: 1,
          readAt: null,
        },
        items: [denseEvidence(0, 16)],
        identity: {
          sourceId: rule.sourceId,
          expectedSourceLocatorFingerprint: rule.sourceLocatorFingerprint,
          expectedBaselineVersion: null,
        },
        outbox: [
          {
            id: 'runtime-qualification-notification',
            ruleId: rule.id,
            subjectType: 'event',
            subjectId: eventId,
            channel: 'in-app',
            dedupeKey: 'runtime-qualification-notification',
            privacyJson: '{"eventKind":"changed","importance":"normal","itemCount":1}',
            createdAt: due,
          },
        ],
      }).ok,
      '固定真实 Event 写入失败',
    );
    await runtime.runRoot(() => runtime.notifications.drain());
    const notification = repo.dbHandle
      .prepare(
        "SELECT state FROM notification_outbox WHERE id='runtime-qualification-notification'",
      )
      .get() as { state: unknown } | undefined;
    assertFact(
      notification?.state === 'sent' || notification?.state === 'failed',
      '通知真实终态缺失',
    );
    const digest = new ObservedPromise();
    digest.track(
      runtime.runRoot(() =>
        runtime.digest.handleDue({
          scheduleId: 'runtime-qualification-digest',
          expectedNextDueAt: due,
          logicalDate: due.slice(0, 10),
        }),
      ),
    );
    await enteredBeforeDone(this.digest.hold.entered.promise, digest);
    const usage = runtime.usage.bridge('runtime-qualification-usage');
    await runtime.runRoot(() => {
      usage.recordSearchHits([
        { sourceId: fixtureId(3), scope: 'page', canonicalKey: sourceInput(3).url },
      ]);
      usage.onBrowserOpen(sourceInput(3).url, true);
      usage.clearRun();
    });
    await this.usageHold.entered.promise;
    const namedOriginals: ActiveObservations = {
      chat: this.chatPromise,
      agent: this.agentPromise,
      research: this.researchPromise,
      watch: this.watchPromise,
      watchOrchestration: this.watchOrchestration,
      digest,
      preview,
      exporter,
      usage: this.usagePromise,
    };
    const originals = activeOriginals(namedOriginals);
    const heldLeaves: ActiveHolds = {
      chatProvider: this.chat.hold,
      agentProvider: this.agent.hold,
      researchProvider: this.research.hold,
      digestProvider: this.digest.hold,
      watchAcquisition: this.watchHold,
      previewAcquisition: this.previewHold,
      exportDialog: this.exportHold,
      sourceUsageWriter: this.usageHold,
    };
    const recordDrainState = (checkpoint: 'held' | 'ready') => {
      const snapshot = activeDrainSnapshot(
        runtime.maintenance.status(),
        heldLeaves,
        namedOriginals,
      );
      this.observations.push({ phase: 'active-drain-state', checkpoint, ...snapshot });
      this.trace('active-drain.state', { checkpoint, ...snapshot });
      return snapshot;
    };
    const ticket = await this.phase('active-maintenance', async () => {
      const start = performance.now();
      const acquired = this.acquire(runtime);
      await delay(1000);
      assertActiveHold(recordDrainState('held'));
      const releasedAt = performance.now();
      this.releaseAll();
      const ready = await acquired;
      const readyAt = performance.now();
      recordDrainState('ready');
      assertOriginalsDrainedBeforeReady(originals, readyAt);
      await Promise.all(originals.map((item) => item.promise));
      assertFact(
        [
          this.chat.hold,
          this.agent.hold,
          this.research.hold,
          this.digest.hold,
          this.watchHold,
          this.previewHold,
        ].every((hold) => hold.aborted),
        '取消未到达原异步端口',
      );
      const messages = (id: number) =>
        JSON.parse(
          readFileSync(
            join(this.root, 'runtime', 'profile', 'conversations', `${fixtureId(id)}.json`),
            'utf8',
          ),
        ) as {
          messages: Array<{
            role: string;
            status: string;
            agentRun?: { status: string };
            toolStep?: { name: string; ok: boolean };
          }>;
        };
      assertFact(
        messages(1).messages.some((item) => item.role === 'assistant' && item.status === 'aborted'),
        '共读 aborted 未落盘',
      );
      const agent = messages(2).messages;
      assertFact(
        agent.some((item) => item.agentRun?.status === 'cancelled') &&
          agent.some((item) => item.toolStep?.name === 'source_list' && item.toolStep.ok),
        'Agent 工具或取消终态未落盘',
      );
      // Read repository facts while all product admissions remain closed.
      const researchRow = new (await import('node:sqlite')).DatabaseSync(
        join(this.root, 'runtime', 'profile', 'research', 'research.db'),
        { readOnly: true },
      );
      try {
        assertFact(
          researchRow.prepare('SELECT status FROM research_tasks WHERE id=?').get(task.task.id)
            ?.status === 'cancelled',
          'Research 取消未落盘',
        );
      } finally {
        researchRow.close();
      }
      assertFact(
        repo.getRun(run.runId)?.status === 'interrupted' &&
          this.watchOrchestration.settledAt !== null &&
          !this.watchOrchestration.rejected,
        'Watch 维护中断终态或原编排未收敛',
      );
      assertFact(
        repo
          .listDigestArtifactsBySchedule('runtime-qualification-digest')
          .some(
            (value) => value.providerState === 'failed' && value.providerResultCode === 'aborted',
          ),
        'Digest aborted 未落盘',
      );
      const sourceDb = new (await import('node:sqlite')).DatabaseSync(
        join(this.root, 'runtime', 'profile', 'sources', 'sources.db'),
        { readOnly: true },
      );
      try {
        assertFact(
          sourceDb.prepare('SELECT last_usage_outcome FROM sources WHERE id=?').get(fixtureId(3))
            ?.last_usage_outcome === 'reachable',
          'usage 尾部未落盘',
        );
      } finally {
        sourceDb.close();
      }
      this.observations.push({
        phase: 'active-drain',
        pendingBefore: originals.length,
        artificialHoldMs: releasedAt - start,
        readyAt,
        naturalTailMs: readyAt - releasedAt,
        originalSettledAt: originals.map((item) => item.settledAt),
        notificationState: notification.state,
        researchPrunedOldTasks: 1,
        watchAddedEvents: 1,
      });
      return ready;
    });
    assertFact(runtime.maintenance.resume(ticket), 'active 同代恢复失败');
  }
}
