import { app, webContents } from 'electron';
import type { Clock } from '../../../shared/types/watch';
import type { SourceService } from '../../../shared/types/sources';
import type { BrowserControllerImpl } from '../../browser/browser-controller';
import type { WatchRepository } from '../repository/watch-repository';
import type { WatchRunCoordinator, WatchRunObserver } from '../watch-run-coordinator';
import type { WatchScheduler } from '../watch-scheduler';
import type { DigestScheduler } from '../digest-scheduler';
import type { WatchTaskTabWorkspace, WatchTaskTabBrowser } from '../watch-task-tab-workspace';
import type { HostRequestGate } from '../host-request-gate';
import type { InAppNotificationDto } from '../../../shared/types/watch-ipc';
import type { SourceWatchProjectionProvider } from '../../sources/source-service';
import { computeSourceLocatorFingerprint } from '../../../shared/watch/watch-rule-state';
import { validateDigestFacts } from '../../../shared/watch/digest-facts';
import { getAuthenticatedQualificationLaunch, closeQualificationLaunch } from './launch-authority';
import { QualificationQpcClock } from './qpc';
import { QualificationPausableClock, type QualificationTimerOwner } from './pausable-clock';
import { QualificationRegistry } from './registry';
import { QualificationSampler, readNodeActiveResources } from './sampler';
import { QualificationSequencer } from './telemetry';
import {
  createQualificationManifest,
  createQualificationDigestSchedules,
  getQualificationRun,
  getQualificationDigestOracle,
  H3B_DESCRIPTOR_SHA256,
  H3B_EXPANDED_SHA256,
} from './manifest';
import { QualificationRoundReleaseGate } from './round-release-gate';
import { QualificationAcquisitionPort } from './acquisition';
import { readQualificationGpuInfo } from './gpu-info';
import {
  issueQualificationSeedAuthorization,
  type QualificationSeedAuthorization,
  type QualificationSeedPhase,
} from './seed-authorization';

interface QualificationRuntimePorts {
  repo: WatchRepository;
  source: SourceService;
  coordinator: WatchRunCoordinator;
  scheduler: WatchScheduler;
  digestScheduler: DigestScheduler;
  browser: BrowserControllerImpl;
  shutdown(): Promise<void>;
}

interface QualificationSourceSeeder {
  seedWatchResourceQualificationSourcesV1(
    auth: QualificationSeedAuthorization,
    descriptorHash: string,
    expandedHash: string,
    m0Ms: number,
  ): void;
}

export class QualificationRuntime {
  readonly qpc: QualificationQpcClock;
  readonly registry: QualificationRegistry;
  readonly clocks: QualificationPausableClock;
  readonly sequencer: QualificationSequencer;
  readonly paths = getAuthenticatedQualificationLaunch().prepared.paths;
  readonly sampler: QualificationSampler;
  private ports: QualificationRuntimePorts | null = null;
  private rounds: QualificationRoundReleaseGate | null = null;
  private auth: QualificationSeedAuthorization | null = null;
  private m0Ms = 0;
  private frozenAtMs = 0;
  private initialized = false;
  private rendererReady = false;
  private started = false;
  private readonly taskTabs = new Map<
    string,
    { identity: string; tabId: string; webContentsId: number }
  >();
  private readonly notifications: InAppNotificationDto[] = [];
  private createdTaskTabs = 0;
  private stopped = false;
  private seedPhase: QualificationSeedPhase | null = null;
  private assemblyStage:
    | 'stores'
    | 'setup'
    | 'seed-authority'
    | 'seed-sources'
    | 'source-projections'
    | 'seed-rules'
    | 'source-fingerprints'
    | 'attached' = 'stores';

  constructor() {
    const { native, launch, prepared } = getAuthenticatedQualificationLaunch();
    this.qpc = new QualificationQpcClock(
      native,
      launch.identity.qpcFrequency,
      launch.qpcAnchorTicks,
      launch.utcAnchorMs,
    );
    this.sequencer = new QualificationSequencer(
      native,
      launch.capability,
      prepared.qualificationRunId,
      this.fail,
    );
    this.registry = new QualificationRegistry((kind, event) => {
      void this.sequencer.send(kind, event);
    }, this.fail);
    this.clocks = new QualificationPausableClock(this.qpc, this.registry);
    this.sampler = new QualificationSampler(
      this.qpc,
      this.clocks,
      this.registry,
      this.sequencer,
      {
        snapshot: () => ({
          mainHeapUsedBytes: process.memoryUsage().heapUsed,
          nodeActiveByType: readNodeActiveResources(),
          taskTabBindings: [...this.taskTabs.values()].sort(
            (a, b) => Number(a.identity.split(':')[1]) - Number(b.identity.split(':')[1]),
          ),
          watchLogicalDbBytes: this.ports?.repo.estimateLogicalBytes() ?? 0,
          webContentsIds: [...new Set(webContents.getAllWebContents().map((wc) => wc.id))].sort(
            (a, b) => a - b,
          ),
        }),
        closeAdmission: () => {
          this.stopped = true;
        },
        onResumed: (phase, index) => {
          if (!__WATCH_QUALIFICATION_DIAGNOSTIC__ && phase === 'measurement' && index === 0)
            this.seedDigests();
        },
        onBarrierResumed: (pause, resume) => this.rounds?.barrierResumed(pause, resume),
        shutdown: async () => {
          if (!__WATCH_QUALIFICATION_DIAGNOSTIC__) this.verifyFinal();
          else if (__WATCH_QUALIFICATION_LOAD_DIAGNOSTIC__) {
            this.rounds!.verifyLoadDiagnostic();
            if (
              !this.rendererReady ||
              this.createdTaskTabs !== 4 ||
              this.taskTabs.size !== 0 ||
              this.notifications.length !== 0
            )
              this.fail('diagnostic-session-oracle');
          }
          const owner = this.registry.snapshot().find((row) => row.registry === 'watch-store')
            ?.identities[0];
          if (owner === undefined) return this.fail('shutdown-store-owner');
          await this.registry.track(() => this.ports!.shutdown(), owner);
        },
        completed: async () => {
          await closeQualificationLaunch();
          app.quit();
        },
      },
      this.fail,
    );
  }

  readonly fail = (code: string): never => {
    this.stopped = true;
    process.stderr.write(`H3b资格失败：${/^[a-z-]{1,80}$/.test(code) ? code : 'internal'}\n`);
    app.exit(1);
    throw new Error('H3b资格失败');
  };

  assemblyFailure(error: unknown): never {
    process.stderr.write(`H3b装配阶段：${this.assemblyStage}\n`);
    if (error instanceof Error) {
      // Only the build's call-site stack is diagnostic output; omit error text and causes.
      const callSites =
        error.stack
          ?.split('\n')
          .slice(1, 9)
          .filter((line) => line.includes('out\\main\\') || line.includes('out/main/')) ?? [];
      process.stderr.write(callSites.join('\n') + '\n');
    }
    return this.fail('watch-assembly-failed');
  }

  async ready(): Promise<void> {
    await this.sequencer.send('ready', getAuthenticatedQualificationLaunch().launch.identity);
    this.sampler.startHeartbeat();
  }

  clock(owner: QualificationTimerOwner): Clock {
    return this.clocks.forOwner(owner);
  }
  admissionOpen(): boolean {
    return !this.stopped && this.seedPhase === null && this.sampler.isAdmissionOpen();
  }
  isSeedPhaseOpen(phase: QualificationSeedPhase, m0Ms: number): boolean {
    return !this.stopped && this.ports !== null && this.m0Ms === m0Ms && this.seedPhase === phase;
  }
  isRendererReady(): void {
    this.rendererReady = true;
  }

  readonly runObserver: WatchRunObserver = {
    admissionOpen: () => this.admissionOpen(),
    assertMutable: () => this.registry.assertMutable(),
    track: <T>(work: () => Promise<T>) => this.registry.track(work),
    release: (task) => {
      if (this.rounds === null) return this.fail('run-before-seed');
      return this.rounds.release(task);
    },
    enter: (task) => {
      if (this.rounds === null) return this.fail('run-before-seed');
      return this.rounds.enter(task);
    },
    leave: (identity, task) => {
      if (this.rounds === null) return this.fail('run-before-seed');
      this.rounds.leave(identity, task);
    },
    revalidated: (task) => this.rounds!.revalidated(task),
    acquired: (task) => this.rounds!.acquired(task),
    processed: (task) => this.rounds!.processed(task),
    duplicateTerminalAttempt: () => this.registry.increment('duplicateTerminalAttemptTotal'),
  };

  readonly processingObserver = {
    onEntered: (runId: string, observedAt: string): void =>
      this.rounds!.processingEntered(runId, observedAt),
    onDuplicateTerminalAttempt: (): void =>
      this.registry.increment('duplicateTerminalAttemptTotal'),
  };

  readonly grant = (hostKey: string, atMs: number, waitedForGap: boolean): (() => void) => {
    if (this.rounds === null) return this.fail('grant-before-seed');
    return this.rounds.grant(hostKey, atMs, waitedForGap);
  };

  workspaceBrowser(browser: BrowserControllerImpl): WatchTaskTabBrowser {
    const urls = new Set(
      createQualificationManifest()
        .entries.filter((entry) => entry.accessMode === 'session')
        .map((entry) => entry.targetUrl),
    );
    return {
      createTab: (url) => {
        if (!this.admissionOpen() || !urls.has(url)) this.fail('session-target-invalid');
        return this.registry.track(() => browser.createTab('about:blank'));
      },
      closeTab: (id) => this.registry.track(() => browser.closeTab(id)),
      activateTab: (id) => this.registry.track(() => browser.activateTab(id)),
      getTabs: () => this.registry.track(() => browser.getTabs()),
      getActiveTab: () => this.registry.track(() => browser.getActiveTab()),
    };
  }

  workspaceOwnership(
    browser: BrowserControllerImpl,
  ): NonNullable<ConstructorParameters<typeof WatchTaskTabWorkspace>[0]['ownership']> {
    return {
      assertMutable: () => this.registry.assertMutable(),
      own: (tabId) => {
        const webContentsId = browser.getOwnedWebContentsId(tabId);
        if (webContentsId === null || this.taskTabs.has(tabId))
          return this.fail('tab-binding-invalid');
        const identity = this.registry.register({ registry: 'task-tab', detail: null });
        this.taskTabs.set(tabId, { identity, tabId, webContentsId });
        ++this.createdTaskTabs;
      },
      release: (tabId) => {
        const binding = this.taskTabs.get(tabId);
        if (binding === undefined) return this.fail('tab-release-invalid');
        if (browser.getOwnedWebContentsId(tabId) !== null) this.fail('tab-release-unconfirmed');
        this.registry.unregister(binding.identity);
        this.taskTabs.delete(tabId);
      },
      track: <T>(work: () => Promise<T>) => this.registry.track(work),
    };
  }

  createAcquisition(
    gate: HostRequestGate,
    workspace: WatchTaskTabWorkspace,
  ): { run: QualificationAcquisitionPort['run'] } {
    return {
      run: (input) => {
        if (this.rounds === null) return this.fail('acquisition-before-seed');
        return new QualificationAcquisitionPort(
          this.clock('qualification-fixture'),
          gate,
          workspace,
          this.rounds,
          this.registry,
          this.fail,
        ).run(input);
      },
    };
  }

  async attach(ports: QualificationRuntimePorts): Promise<void> {
    if (
      this.ports !== null ||
      ports.repo.listRules().length !== 0 ||
      ports.repo.listDigestSchedules().length !== 0
    )
      this.fail('seed-db-not-empty');
    this.ports = ports;
    this.assemblyStage = 'setup';
    const gpuBegin = this.qpc.readTicks();
    const gpu = await readQualificationGpuInfo(() => app.getGPUInfo('complete'));
    await this.sequencer.send('gpu-info', {
      beginQpcTicks: gpuBegin,
      endQpcTicks: this.qpc.readTicks(),
      ...gpu,
    });
    this.frozenAtMs = this.qpc.now().getTime();
    this.m0Ms = Math.ceil((this.frozenAtMs + 1_440_000) / 60_000) * 60_000;
    const { launch } = getAuthenticatedQualificationLaunch();
    await this.sequencer.send('setup', {
      descriptorSha256: H3B_DESCRIPTOR_SHA256,
      expandedManifestSha256: H3B_EXPANDED_SHA256,
      m0QpcTicks: this.qpc.ticksForUtc(this.m0Ms),
      m0Utc: new Date(this.m0Ms).toISOString(),
      qpcAnchorTicks: launch.qpcAnchorTicks,
      utcAnchorMs: launch.utcAnchorMs,
    });
    if (__WATCH_QUALIFICATION_DIAGNOSTIC__ && !__WATCH_QUALIFICATION_LOAD_DIAGNOSTIC__) return;
    this.seedPhase = 'sources';
    this.assemblyStage = 'seed-authority';
    this.auth = issueQualificationSeedAuthorization(this.m0Ms);
    ports.repo.assertWatchResourceQualificationFreshStoreV1(this.auth);
    const seeder = ports.source as SourceService & QualificationSourceSeeder;
    this.assemblyStage = 'seed-sources';
    seeder.seedWatchResourceQualificationSourcesV1(
      this.auth,
      H3B_DESCRIPTOR_SHA256,
      H3B_EXPANDED_SHA256,
      this.m0Ms,
    );
    const sourceProjection = ports.source as SourceService & SourceWatchProjectionProvider;
    this.assemblyStage = 'source-projections';
    const fixedEntries = createQualificationManifest().entries;
    for (const entry of fixedEntries) {
      const actual = sourceProjection.getSourceWatchProjection(entry.sourceId);
      if (
        actual.status !== 'found' ||
        actual.projection.rowVersion !== 1 ||
        !actual.projection.enabled ||
        actual.projection.deletedAt !== null ||
        actual.projection.scope !== 'page' ||
        actual.projection.canonicalKey !== entry.targetUrl
      )
        this.fail('source-projection-mismatch');
    }
    this.seedPhase = 'rules';
    this.assemblyStage = 'seed-rules';
    ports.repo.seedWatchResourceQualificationRulesV1(
      this.auth,
      H3B_DESCRIPTOR_SHA256,
      H3B_EXPANDED_SHA256,
      this.m0Ms,
    );
    this.assemblyStage = 'source-fingerprints';
    for (const entry of fixedEntries) {
      const actual = sourceProjection.getSourceWatchProjection(entry.sourceId);
      const rule = ports.repo.getRule(entry.ruleId);
      if (
        actual.status !== 'found' ||
        rule === null ||
        rule.sourceLocatorFingerprint !==
          computeSourceLocatorFingerprint({
            ...actual.projection,
            kind: entry.kind,
            canonicalTargetUrl: entry.targetUrl,
          })
      )
        this.fail('source-fingerprint-mismatch');
    }
    this.rounds = new QualificationRoundReleaseGate(
      this.m0Ms,
      ports.repo,
      this.registry,
      this.qpc,
      () => this.admissionOpen(),
      this.fail,
    );
    this.seedPhase = null;
    this.assemblyStage = 'attached';
  }

  start(): void {
    if (this.started || this.ports === null) this.fail('runtime-start-invalid');
    this.started = true;
    if (__WATCH_QUALIFICATION_LOAD_DIAGNOSTIC__) {
      this.sampler.startLoadDiagnostic();
      void this.initializeLoadDiagnostic().catch(() => this.fail('diagnostic-initialization'));
      return;
    }
    if (__WATCH_QUALIFICATION_DIAGNOSTIC__) {
      this.sampler.startDiagnostic();
      return;
    }
    this.sampler.start(this.m0Ms);
    void this.initialize().catch(() => this.fail('initialization-failed'));
  }

  onNotification(notification: InAppNotificationDto): void {
    this.registry.assertMutable();
    this.notifications.push(notification);
    if (notification.subjectType !== 'digest' || this.notifications.length > 2)
      this.fail('notification-mismatch');
  }

  private async initialize(): Promise<void> {
    const ports = this.ports!;
    const start = this.qpc.now().getTime() + 1_000;
    if (start > this.frozenAtMs + 30_000) this.fail('initialization-first-admission-deadline');
    for (let batch = 0; batch < 25; ++batch) {
      const release = start + batch * 31_000;
      await this.delayUntil(release);
      for (let offset = 0; offset < 4; ++offset) {
        const plan = getQualificationRun(batch * 4 + offset, 'initialization', null, this.m0Ms);
        const result = ports.coordinator.manualRun(plan.entry.ruleId, plan.requestId!);
        if (!result.ok || result.reused) this.fail('initialization-admission');
      }
      await this.delayUntil(release + 29_500);
      if (ports.coordinator.activeRunCount() !== 0 || ports.coordinator.pendingRunCount() !== 0)
        this.fail('initialization-deadline');
    }
    if (
      !this.rounds!.phaseComplete('initialization') ||
      this.qpc.now().getTime() > this.m0Ms - 630_000
    )
      this.fail('initialization-window');
    this.seedPhase = 'schedule';
    ports.repo.seedWatchResourceQualificationRuleScheduleV1(
      this.auth!,
      H3B_DESCRIPTOR_SHA256,
      H3B_EXPANDED_SHA256,
      this.m0Ms,
    );
    this.seedPhase = null;
    this.initialized = true;
    await this.delayUntil(this.m0Ms - 600_000);
    if (!this.rendererReady) this.fail('renderer-not-ready');
    ports.scheduler.initialize(
      ports.repo
        .listRules()
        .map((rule) => ({ ruleId: rule.id, effectiveDueAt: Date.parse(rule.nextDueAt!) })),
    );
  }

  private async initializeLoadDiagnostic(): Promise<void> {
    const firstAdmission = this.qpc.now().getTime() + 1_000;
    if (firstAdmission > this.frozenAtMs + 30_000)
      this.fail('initialization-first-admission-deadline');
    await this.delayUntil(firstAdmission);
    for (const index of [80, 81, 82, 83]) {
      const plan = getQualificationRun(index, 'initialization', null, this.m0Ms);
      const result = this.ports!.coordinator.manualRun(plan.entry.ruleId, plan.requestId!);
      if (!result.ok || result.reused) this.fail('diagnostic-initialization-admission');
    }
  }

  private seedDigests(): void {
    if (
      !this.initialized ||
      !this.rounds!.phaseComplete('warmup') ||
      this.qpc.now().getTime() > this.m0Ms + 3_000
    )
      this.fail('digest-seed-window');
    const ports = this.ports!;
    this.seedPhase = 'digests';
    ports.repo.seedWatchResourceQualificationDigestsV1(
      this.auth!,
      H3B_DESCRIPTOR_SHA256,
      H3B_EXPANDED_SHA256,
      this.m0Ms,
    );
    this.seedPhase = null;
    ports.digestScheduler.initialize(
      createQualificationDigestSchedules(this.m0Ms).map((schedule) => ({
        scheduleId: schedule.id,
        expectedNextDueAt: schedule.nextDueAt,
        timeZone: schedule.timeZone,
      })),
    );
    if (this.qpc.now().getTime() > this.m0Ms + 3_000) this.fail('digest-seed-deadline');
  }

  private verifyFinal(): void {
    this.rounds!.verifyFinal();
    if (!this.rendererReady || this.notifications.length !== 2)
      this.fail('renderer-notification-count');
    for (const digest of createQualificationManifest().digests) {
      const schedule = this.ports!.repo.getDigestSchedule(digest.id);
      const artifacts = this.ports!.repo.listDigestArtifactsBySchedule(digest.id);
      const runs = this.ports!.repo.listDigestRunsBySchedule(digest.id);
      const expected = getQualificationDigestOracle(digest.index);
      const stats = schedule?.lastRunStats;
      if (
        artifacts.length !== 1 ||
        runs.length !== 1 ||
        stats === null ||
        stats === undefined ||
        stats.changed !== expected.runStats.changed ||
        stats.unchanged !== expected.runStats.unchanged ||
        stats.failed !== 0
      )
        this.fail('digest-final-oracle');
      const artifact = artifacts[0]!;
      const run = runs[0]!;
      const due = this.m0Ms + digest.dueMinuteOffset * 60_000;
      if (
        !validateDigestFacts(artifact.facts) ||
        artifact.facts.eventCount !== expected.events ||
        artifact.facts.events.reduce((count, event) => count + event.observationCount, 0) !==
          expected.observations ||
        artifact.byteLength > 49_152 ||
        artifact.batchIndex !== 0 ||
        artifact.providerState !== 'disabled' ||
        artifact.explanationJson !== null ||
        run.state !== 'completed' ||
        run.nextSequence !== run.upperSequence ||
        schedule?.cursorSequence !== run.upperSequence ||
        Date.parse(artifact.createdAt) < due ||
        Date.parse(artifact.createdAt) > due + 30_000 ||
        this.notifications.filter((notification) => notification.subjectId === artifact.id)
          .length !== 1
      ) {
        this.fail('digest-facts-oracle');
      }
    }
  }

  private delayUntil(deadline: number): Promise<void> {
    return this.registry.track(
      () =>
        new Promise<void>((resolve) => {
          this.clock('qualification-fixture').setTimeout(
            resolve,
            Math.max(0, deadline - this.qpc.now().getTime()),
          );
        }),
    );
  }
}
