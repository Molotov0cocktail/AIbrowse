import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { PageSnapshot, TabInfo } from '../shared/types/browser';
import type { Clock, WatchRule } from '../shared/types/watch';
import { createSystemClock } from '../shared/watch/clock';
import { computeSourceLocatorFingerprint } from '../shared/watch/watch-rule-state';
import type { SourceService } from '../shared/types/sources';
import { SourceServiceImpl, type SourceWatchProjectionProvider } from './sources/source-service';
import { openSourcesStore } from './sources/sources-store';
import { BrowserWatchReader, type WatchBrowserReadPort } from './watch/browser-watch-reader';
import { FeedAcquisitionService } from './watch/feed-acquisition-service';
import { parseDiscoveryCandidates } from './watch/feed-discovery';
import { HostRequestGate } from './watch/host-request-gate';
import {
  createPublicWatchHttpStack,
  type TargetGatedClient,
  type WatchIncomingLike,
  type WatchRequestFactory,
  type WatchRequestLike,
  type WatchRequestOptions,
} from './watch/public-watch-http-client';
import { WatchAcquisitionService, PageAcquisitionRouter } from './watch/watch-acquisition-service';
import { WatchLifecycleCoordinator } from './watch/watch-lifecycle-coordinator';
import { WatchProcessingServiceImpl } from './watch/watch-processing-service';
import type { WatchRepository } from './watch/repository/watch-repository';
import { WatchRunCoordinator } from './watch/watch-run-coordinator';
import { WatchScheduler } from './watch/watch-scheduler';
import { openWatchStore } from './watch/watch-store';
import { WatchTaskTabWorkspace, type WatchTaskTabBrowser } from './watch/watch-task-tab-workspace';
import {
  canonicalH3aManifest,
  H3A_MANIFEST,
  H3A_MANIFEST_CONTENT_HASH,
  type H3aCandidate,
  type H3aBudgetObservation,
  type H3aCandidateEvidence,
  type H3aFeedBudgetDiagnosticReport,
  type H3aReport,
  type H3aRequestLedgerEntry,
  type H3aUsageReceiptEvidence,
  type H3aRunEvidence,
  type H3aScenarioEvidence,
  validateH3aManifest,
  validateH3aFeedBudgetDiagnosticReport,
  validateH3aReport,
} from './smoke-watch-h3a';
import {
  createH3aNasaDiagnosticClaim,
  H3A_NASA_DIAGNOSTIC_ID,
  H3aWorkflowUsageLedger,
  type H3aHistoricalUsageSource,
  type H3aNasaDiagnosticClaim,
} from './smoke-watch-h3a-usage';

interface RequestContext {
  scenarioId: string;
  candidateId: string;
  phase: 'first' | 'second';
}

interface PersistedLedger {
  schemaVersion: 2;
  candidateSha: string;
  buildHash: string;
  manifestHash: string;
  workflowBaseCount: number;
  actualCount: number;
  rejectedCount: number;
  perCandidateCounts: Record<string, number>;
  historicalReceipts: H3aUsageReceiptEvidence[];
  workflowLedgerHash: string;
  entries: H3aRequestLedgerEntry[];
}

export interface H3aCampaignOptions {
  candidateSha: string;
  buildHash: string;
  rootDir: string;
  evidenceDir: string;
  mode: 'production-preview';
  clock?: Clock;
  request?: WatchRequestFactory;
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
  onPoll?: () => void | Promise<void>;
  maxCandidateMs?: number;
  workflowDir?: string;
  historicalUsageSources?: readonly H3aHistoricalUsageSource[];
  requireExistingWorkflow?: boolean;
}

export interface H3aCampaignResult {
  report: H3aReport;
  validationErrors: string[];
  reportPath: string;
  ledgerPath: string;
}

export interface H3aFeedBudgetDiagnosticResult {
  report: H3aFeedBudgetDiagnosticReport;
  validationErrors: string[];
  reportPath: string;
  ledgerPath: string;
  observationsPath: string;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertControlledRoot(rootDir: string): string {
  const resolved = resolve(rootDir);
  if (!isWithin(tmpdir(), resolved) || !basename(resolved).startsWith('aibrowse-h3a-')) {
    throw new Error('H3a 临时根目录不在系统临时目录或命名不合规');
  }
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error('H3a 临时根目录不得是符号链接');
  }
  return resolved;
}

function assertRuntimeMetadata(options: H3aCampaignOptions): void {
  const errors = validateH3aManifest();
  if (errors.length > 0) throw new Error(`H3a manifest 非冻结内容：${errors.join('；')}`);
  if (!/^[0-9a-f]{40}$/.test(options.candidateSha)) throw new Error('H3a candidate SHA 非法');
  if (!/^[0-9a-f]{64}$/.test(options.buildHash)) throw new Error('H3a build hash 非法');
  if (options.mode !== 'production-preview') throw new Error('H3a 仅允许 production preview');
  if (!isAbsolute(options.evidenceDir)) throw new Error('H3a evidenceDir 必须为绝对路径');
}

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
  renameSync(temporary, path);
}

function safeErrorCode(error: Error): string {
  const candidate = 'code' in error && typeof error.code === 'string' ? error.code : error.name;
  return /^[A-Za-z0-9_-]{1,64}$/.test(candidate) ? candidate : 'ERROR';
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function hasExactOwnKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function immutableEvidencePath(evidenceDir: string, prefix: string, startedAt: string): string {
  const token = startedAt.replaceAll(':', '-');
  const base = join(evidenceDir, `${prefix}-${token}.json`);
  if (!existsSync(base)) return base;
  for (let suffix = 2; suffix <= 100; suffix += 1) {
    const candidate = join(evidenceDir, `${prefix}-${token}-${suffix}.json`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`H3a ${prefix} 证据文件序号耗尽`);
}

function nativeRequest(options: WatchRequestOptions): WatchRequestLike {
  const request = options.protocol === 'https:' ? httpsRequest(options) : httpRequest(options);
  return request as unknown as WatchRequestLike;
}

export class H3aRequestBudget {
  private readonly evidenceDir: string;
  private readonly ledgerPath: string;
  private readonly baseRequest: WatchRequestFactory;
  private readonly perCandidateLimits = new Map<string, number>();
  private readonly workflow: H3aWorkflowUsageLedger;
  private readonly requestObjects = new Map<number, WatchRequestLike>();
  private readonly waiters = new Set<() => void>();
  private context: RequestContext | null = null;
  private ledger: PersistedLedger;
  private observerFailure: Error | null = null;

  constructor(options: {
    evidenceDir: string;
    candidateSha: string;
    buildHash: string;
    request?: WatchRequestFactory;
    workflowDir?: string;
    historicalReceipts?: readonly H3aHistoricalUsageSource[];
    requireExistingWorkflow?: boolean;
  }) {
    this.evidenceDir = resolve(options.evidenceDir);
    mkdirSync(this.evidenceDir, { recursive: true });
    this.ledgerPath = join(this.evidenceDir, 'request-ledger.json');
    this.baseRequest = options.request ?? nativeRequest;
    for (const scenario of H3A_MANIFEST.scenarios) {
      for (const candidate of scenario.candidates) {
        this.perCandidateLimits.set(candidate.id, candidate.maxRequests);
      }
    }
    this.workflow = new H3aWorkflowUsageLedger({
      workflowDir: resolve(options.workflowDir ?? join(this.evidenceDir, 'workflow-usage')),
      historicalSources: options.historicalReceipts ?? [],
      requireExisting: options.requireExistingWorkflow,
    });
    const workflow = this.workflow.snapshot;
    const initial: PersistedLedger = {
      schemaVersion: 2,
      candidateSha: options.candidateSha,
      buildHash: options.buildHash,
      manifestHash: H3A_MANIFEST_CONTENT_HASH,
      workflowBaseCount: workflow.actualCount,
      actualCount: workflow.actualCount,
      rejectedCount: workflow.rejectedCount,
      perCandidateCounts: workflow.perCandidateCounts,
      historicalReceipts: workflow.receipts,
      workflowLedgerHash: this.workflowHash(),
      entries: [],
    };
    if (existsSync(this.ledgerPath)) {
      let existing: PersistedLedger;
      try {
        existing = JSON.parse(readFileSync(this.ledgerPath, 'utf8')) as PersistedLedger;
      } catch {
        throw new Error('H3a 既有物理请求 ledger 无法解析');
      }
      if (!this.isValidExistingLedger(existing, initial)) {
        throw new Error('H3a 既有物理请求 ledger 与冻结 campaign 不一致');
      }
      this.ledger = existing;
    } else {
      this.ledger = initial;
      this.persist();
    }
  }

  readonly factory: WatchRequestFactory = (options) => this.create(options);

  setContext(context: RequestContext): void {
    this.context = context;
  }

  clearContext(): void {
    this.context = null;
  }

  currentCandidateId(): string | null {
    return this.context?.candidateId ?? null;
  }

  get snapshot(): PersistedLedger {
    return JSON.parse(JSON.stringify(this.ledger)) as PersistedLedger;
  }

  claimNasaDiagnostic(
    candidateSha: string,
    buildHash: string,
  ): { claim: H3aNasaDiagnosticClaim; claimHash: string; path: string } {
    return createH3aNasaDiagnosticClaim({
      workflow: this.workflow,
      candidateSha,
      buildHash,
      manifestHash: H3A_MANIFEST_CONTENT_HASH,
    });
  }

  countFor(candidateId: string, afterTotalOrdinal = 0): number {
    return this.ledger.entries.filter(
      (entry) => entry.candidateId === candidateId && entry.totalOrdinal > afterTotalOrdinal,
    ).length;
  }

  markBusinessSettled(afterTotalOrdinal: number): void {
    this.assertObserverHealthy();
    const settledAt = new Date().toISOString();
    let changed = false;
    for (const entry of this.ledger.entries) {
      if (entry.totalOrdinal <= afterTotalOrdinal || entry.businessSettledAt !== null) continue;
      const request = this.requestObjects.get(entry.totalOrdinal) as
        (WatchRequestLike & { destroyed?: unknown; writableEnded?: unknown }) | undefined;
      entry.businessSettledAt = settledAt;
      entry.requestDestroyedAtBusinessEnd =
        typeof request?.destroyed === 'boolean' ? request.destroyed : null;
      entry.requestWritableEndedAtBusinessEnd =
        typeof request?.writableEnded === 'boolean' ? request.writableEnded : null;
      changed = true;
    }
    if (changed) this.persistCritical();
  }

  async waitForTransportClose(
    afterTotalOrdinal: number,
    deadlineMono: number,
    onWait?: () => void | Promise<void>,
  ): Promise<boolean> {
    this.assertObserverHealthy();
    const remaining = deadlineMono - performance.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return false;
    if (this.isTransportClosed(afterTotalOrdinal)) return true;
    return new Promise<boolean>((resolveWait, rejectWait) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: boolean, error?: unknown): void => {
        if (settled) return;
        settled = true;
        this.waiters.delete(check);
        if (timer !== null) clearTimeout(timer);
        if (error !== undefined) rejectWait(error);
        else resolveWait(value);
      };
      const check = (): void => {
        try {
          this.assertObserverHealthy();
          const currentRemaining = deadlineMono - performance.now();
          if (!Number.isFinite(currentRemaining) || currentRemaining <= 0) {
            finish(false);
            return;
          }
          if (this.isTransportClosed(afterTotalOrdinal)) finish(true);
        } catch (error) {
          finish(false, error);
        }
      };
      this.waiters.add(check);
      timer = setTimeout(() => finish(false), Math.ceil(remaining));
      Promise.resolve()
        .then(async () => onWait?.())
        .then(check, (error: unknown) => finish(false, error));
      check();
    });
  }

  private persist(): void {
    const workflow = this.workflow.snapshot;
    this.ledger.actualCount = workflow.actualCount;
    this.ledger.rejectedCount = workflow.rejectedCount;
    this.ledger.perCandidateCounts = workflow.perCandidateCounts;
    this.ledger.historicalReceipts = workflow.receipts;
    this.ledger.workflowLedgerHash = this.workflowHash();
    atomicJson(this.ledgerPath, this.ledger);
  }

  private persistCritical(): void {
    try {
      this.persist();
    } catch {
      this.observerFailure ??= codedError(
        'EVIDENCE_WRITE_FAILED',
        'H3a transport observer 证据写入失败',
      );
      throw this.observerFailure;
    }
  }

  private workflowHash(): string {
    return createHash('sha256').update(readFileSync(this.workflow.path)).digest('hex');
  }

  private assertObserverHealthy(): void {
    if (this.observerFailure !== null) throw this.observerFailure;
  }

  private captureObserverMutation(work: () => void): void {
    if (this.observerFailure !== null) return;
    try {
      work();
      this.persist();
    } catch {
      this.observerFailure = codedError(
        'EVIDENCE_WRITE_FAILED',
        'H3a transport observer 证据写入失败',
      );
    }
    for (const waiter of [...this.waiters]) waiter();
  }

  private isTransportClosed(afterTotalOrdinal: number): boolean {
    return this.ledger.entries
      .filter((entry) => entry.totalOrdinal > afterTotalOrdinal)
      .every((entry) => entry.requestClosed && (entry.statusCode === null || entry.responseClosed));
  }

  private isValidExistingLedger(existing: PersistedLedger, initial: PersistedLedger): boolean {
    const workflow = this.workflow.snapshot;
    if (
      existing === null ||
      typeof existing !== 'object' ||
      !hasExactOwnKeys(existing, [
        'schemaVersion',
        'candidateSha',
        'buildHash',
        'manifestHash',
        'workflowBaseCount',
        'actualCount',
        'rejectedCount',
        'perCandidateCounts',
        'historicalReceipts',
        'workflowLedgerHash',
        'entries',
      ]) ||
      existing.schemaVersion !== 2 ||
      existing.candidateSha !== initial.candidateSha ||
      existing.buildHash !== initial.buildHash ||
      existing.manifestHash !== initial.manifestHash ||
      !Number.isSafeInteger(existing.workflowBaseCount) ||
      existing.workflowBaseCount < 0 ||
      !Number.isSafeInteger(existing.actualCount) ||
      existing.actualCount < 0 ||
      existing.actualCount > H3A_MANIFEST.totalMaxRequests ||
      !Number.isSafeInteger(existing.rejectedCount) ||
      existing.rejectedCount < 0 ||
      existing.actualCount !== workflow.actualCount ||
      existing.rejectedCount !== workflow.rejectedCount ||
      JSON.stringify(existing.perCandidateCounts) !== JSON.stringify(workflow.perCandidateCounts) ||
      JSON.stringify(existing.historicalReceipts) !== JSON.stringify(workflow.receipts) ||
      existing.workflowLedgerHash !== this.workflowHash() ||
      !Array.isArray(existing.entries) ||
      existing.workflowBaseCount + existing.entries.length !== existing.actualCount
    ) {
      return false;
    }
    const workflowEntries = workflow.entries.filter(
      (entry) =>
        entry.candidateSha === existing.candidateSha && entry.buildHash === existing.buildHash,
    );
    if (workflowEntries.length !== existing.entries.length) return false;
    for (let index = 0; index < existing.entries.length; index += 1) {
      const entry = existing.entries[index];
      if (entry === null || typeof entry !== 'object') return false;
      const scenario = H3A_MANIFEST.scenarios.find((item) => item.id === entry.scenarioId);
      const frozenCandidate = scenario?.candidates.find((item) => item.id === entry.candidateId);
      const usageEntry = workflowEntries[index];
      if (
        frozenCandidate === undefined ||
        !hasExactOwnKeys(entry, [
          'scenarioId',
          'candidateId',
          'phase',
          'ordinal',
          'totalOrdinal',
          'purposeClass',
          'conditionalRequest',
          'hostClass',
          'startedAt',
          'statusCode',
          'errorCode',
          'timeoutObserved',
          'businessSettledAt',
          'requestDestroyedAtBusinessEnd',
          'requestWritableEndedAtBusinessEnd',
          'requestClosed',
          'requestClosedAt',
          'responseClosed',
          'responseClosedAt',
        ]) ||
        usageEntry === undefined ||
        entry.ordinal !== usageEntry.ordinal ||
        entry.totalOrdinal !== usageEntry.totalOrdinal ||
        entry.scenarioId !== usageEntry.scenarioId ||
        entry.candidateId !== usageEntry.candidateId ||
        entry.phase !== usageEntry.phase ||
        entry.purposeClass !== usageEntry.purposeClass ||
        entry.startedAt !== usageEntry.startedAt ||
        entry.ordinal > frozenCandidate.maxRequests ||
        (entry.phase !== 'first' && entry.phase !== 'second') ||
        (entry.purposeClass !== 'robots' && entry.purposeClass !== 'target') ||
        typeof entry.conditionalRequest !== 'boolean' ||
        entry.hostClass !== entry.candidateId ||
        !Number.isFinite(Date.parse(entry.startedAt)) ||
        new Date(Date.parse(entry.startedAt)).toISOString() !== entry.startedAt ||
        (entry.statusCode !== null &&
          (!Number.isSafeInteger(entry.statusCode) ||
            entry.statusCode < 100 ||
            entry.statusCode > 599)) ||
        (entry.errorCode !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(entry.errorCode)) ||
        typeof entry.timeoutObserved !== 'boolean' ||
        (entry.businessSettledAt !== null &&
          new Date(Date.parse(entry.businessSettledAt)).toISOString() !==
            entry.businessSettledAt) ||
        (entry.requestDestroyedAtBusinessEnd !== null &&
          typeof entry.requestDestroyedAtBusinessEnd !== 'boolean') ||
        (entry.requestWritableEndedAtBusinessEnd !== null &&
          typeof entry.requestWritableEndedAtBusinessEnd !== 'boolean') ||
        typeof entry.requestClosed !== 'boolean' ||
        (entry.requestClosedAt !== null &&
          new Date(Date.parse(entry.requestClosedAt)).toISOString() !== entry.requestClosedAt) ||
        typeof entry.responseClosed !== 'boolean' ||
        (entry.responseClosedAt !== null &&
          new Date(Date.parse(entry.responseClosedAt)).toISOString() !== entry.responseClosedAt) ||
        entry.requestClosed !== (entry.requestClosedAt !== null) ||
        entry.responseClosed !== (entry.responseClosedAt !== null) ||
        !entry.requestClosed ||
        (entry.statusCode !== null && !entry.responseClosed)
      ) {
        return false;
      }
    }
    return true;
  }

  private create(options: WatchRequestOptions): WatchRequestLike {
    this.assertObserverHealthy();
    const context = this.context;
    if (context === null) throw new Error('H3a 请求缺少场景上下文');
    const max = this.perCandidateLimits.get(context.candidateId);
    if (max === undefined) throw new Error('H3a 请求使用非冻结候选');
    const startedAt = new Date().toISOString();
    const purposeClass = options.path === '/robots.txt' ? 'robots' : 'target';
    let reservation: { ordinal: number; totalOrdinal: number };
    try {
      reservation = this.workflow.reserve({
        candidateSha: this.ledger.candidateSha,
        buildHash: this.ledger.buildHash,
        scenarioId: context.scenarioId,
        candidateId: context.candidateId,
        phase: context.phase,
        purposeClass,
        startedAt,
      });
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : null;
      if (code === 'H3A_BUDGET_EXHAUSTED') {
        this.persistCritical();
        throw error;
      }
      this.observerFailure = codedError(
        'WORKFLOW_USAGE_FAILED',
        'H3a workflow usage reservation 失败',
      );
      throw this.observerFailure;
    }
    const entry: H3aRequestLedgerEntry = {
      ...context,
      ordinal: reservation.ordinal,
      totalOrdinal: reservation.totalOrdinal,
      purposeClass,
      conditionalRequest: Object.keys(options.headers).some((key) => {
        const normalized = key.toLowerCase();
        return normalized === 'if-none-match' || normalized === 'if-modified-since';
      }),
      hostClass: context.candidateId,
      startedAt,
      statusCode: null,
      errorCode: null,
      timeoutObserved: false,
      businessSettledAt: null,
      requestDestroyedAtBusinessEnd: null,
      requestWritableEndedAtBusinessEnd: null,
      requestClosed: false,
      requestClosedAt: null,
      responseClosed: false,
      responseClosedAt: null,
    };
    this.ledger.entries.push(entry);
    this.persistCritical();

    let request: WatchRequestLike;
    try {
      request = this.baseRequest(options);
    } catch (error) {
      entry.errorCode = safeErrorCode(error instanceof Error ? error : new Error('request-create'));
      entry.requestClosed = true;
      entry.requestClosedAt = new Date().toISOString();
      this.persistCritical();
      throw error;
    }
    this.requestObjects.set(entry.totalOrdinal, request);
    request.on('response', (response: WatchIncomingLike) => {
      this.captureObserverMutation(() => {
        entry.statusCode = Number.isSafeInteger(response.statusCode) ? response.statusCode : null;
      });
      response.on('close', () => {
        this.captureObserverMutation(() => {
          entry.responseClosed = true;
          entry.responseClosedAt ??= new Date().toISOString();
        });
      });
    });
    request.on('error', (error: Error) => {
      this.captureObserverMutation(() => {
        entry.errorCode = safeErrorCode(error);
      });
    });
    request.on('timeout', () => {
      this.captureObserverMutation(() => {
        entry.timeoutObserved = true;
      });
    });
    request.on('close', () => {
      this.captureObserverMutation(() => {
        entry.requestClosed = true;
        entry.requestClosedAt ??= new Date().toISOString();
      });
    });
    return request;
  }
}

function runEvidence(run: ReturnType<WatchRepository['getRun']>): H3aRunEvidence | null {
  if (run === null || run.status !== 'finished' || run.outcome === null) return null;
  let httpStatus: number | null = null;
  let validatorsPresent = false;
  if (run.responseMetadataJson !== null) {
    try {
      const metadata = JSON.parse(run.responseMetadataJson) as {
        http?: { httpStatus?: unknown; etag?: unknown; lastModified?: unknown } | null;
      };
      if (metadata.http !== null && typeof metadata.http === 'object') {
        httpStatus = Number.isSafeInteger(metadata.http.httpStatus)
          ? (metadata.http.httpStatus as number)
          : null;
        validatorsPresent =
          typeof metadata.http.etag === 'string' || typeof metadata.http.lastModified === 'string';
      }
    } catch {
      return null;
    }
  }
  return {
    runId: run.id,
    status: 'finished',
    outcomeKind: run.outcome.kind,
    healthCode: run.outcome.kind === 'failed' ? run.outcome.health : (run.health?.code ?? null),
    httpStatus,
    validatorsPresent,
  };
}

function failClosedTabBrowser(): WatchTaskTabBrowser {
  const fail = async (): Promise<never> => {
    throw new Error('H3a public-only runner 禁止 Session Tab 能力');
  };
  return {
    createTab: fail,
    closeTab: fail,
    activateTab: fail,
    getTabs: fail,
    getActiveTab: fail,
  };
}

function failClosedReader(): WatchBrowserReadPort {
  return {
    getTabs: async (): Promise<TabInfo[]> => {
      throw new Error('H3a public-only runner 禁止浏览器读取');
    },
    getPageSnapshot: async (): Promise<PageSnapshot | null> => {
      throw new Error('H3a public-only runner 禁止页面会话快照');
    },
  };
}

async function pollTerminal(
  repo: WatchRepository,
  runId: string,
  options: H3aCampaignOptions,
  deadlineMono: number,
): Promise<ReturnType<WatchRepository['getRun']>> {
  while (performance.now() <= deadlineMono) {
    const row = repo.getRun(runId);
    if (row !== null && (row.status === 'finished' || row.status === 'interrupted')) return row;
    await options.onPoll?.();
    await new Promise<void>((resolvePoll) => setTimeout(resolvePoll, 10));
  }
  throw new Error('H3a 候选业务等待超过 180 秒');
}

async function pollCoordinatorIdle(
  coordinator: WatchRunCoordinator,
  options: H3aCampaignOptions,
  deadlineMono: number,
): Promise<void> {
  while (performance.now() <= deadlineMono) {
    if (coordinator.activeRunCount() === 0 && coordinator.pendingRunCount() === 0) return;
    await options.onPoll?.();
    await new Promise<void>((resolvePoll) => setTimeout(resolvePoll, 10));
  }
  throw new Error('H3a 候选 Coordinator 排水超过 180 秒');
}

function candidateSkeleton(candidate: H3aCandidate): H3aCandidateEvidence {
  return {
    candidateId: candidate.id,
    attempted: false,
    result: 'not-needed',
    startedAt: null,
    finishedAt: null,
    sourceReadback: null,
    baselineBeforeVersion: null,
    baselineAfterFirstVersion: null,
    baselineAfterSecondVersion: null,
    baselineAfterFirstValidatorsPresent: null,
    baselineAfterSecondValidatorsPresent: null,
    baselineContentChangedOnSecond: null,
    firstRun: null,
    secondRun: null,
    eventCount: 0,
    typedEvidenceCount: 0,
    typedEvidenceKinds: [],
    auditReasonCodes: [],
    notificationCount: 0,
    noFeedCandidateCount: null,
    backoffUntil: null,
    requestCount: 0,
    failureCode: null,
  };
}

export async function runH3aCampaign(options: H3aCampaignOptions): Promise<H3aCampaignResult> {
  assertRuntimeMetadata(options);
  const rootDir = assertControlledRoot(options.rootDir);
  const evidenceDir = resolve(options.evidenceDir);
  if (isWithin(rootDir, evidenceDir)) throw new Error('H3a evidenceDir 不得位于待清理临时根目录内');
  mkdirSync(evidenceDir, { recursive: true });
  const manifestPath = join(evidenceDir, 'manifest.json');
  const manifestBytes = canonicalH3aManifest();
  if (existsSync(manifestPath)) {
    if (readFileSync(manifestPath, 'utf8') !== manifestBytes) {
      throw new Error('H3a 既有 manifest 字节与冻结内容不一致');
    }
  } else {
    writeFileSync(manifestPath, manifestBytes, { encoding: 'utf8', flag: 'wx' });
  }
  const workflowDir = resolve(options.workflowDir ?? join(evidenceDir, 'workflow-usage'));
  if (isWithin(rootDir, workflowDir)) {
    throw new Error('H3a workflow usage 目录不得位于待清理临时根目录内');
  }
  const budget = new H3aRequestBudget({
    evidenceDir,
    candidateSha: options.candidateSha,
    buildHash: options.buildHash,
    request: options.request,
    workflowDir,
    historicalReceipts: options.historicalUsageSources,
    requireExistingWorkflow: options.requireExistingWorkflow,
  });
  const requestCountBeforeCampaign = budget.snapshot.actualCount;
  const startedAt = new Date().toISOString();
  const campaignStartPath = immutableEvidencePath(evidenceDir, 'campaign-start', startedAt);
  atomicJson(campaignStartPath, {
    schemaVersion: 1,
    candidateSha: options.candidateSha,
    buildHash: options.buildHash,
    manifestHash: H3A_MANIFEST_CONTENT_HASH,
    mode: options.mode,
    startedAt,
    workflowBeforeCount: requestCountBeforeCampaign,
    workflowLedgerHash: budget.snapshot.workflowLedgerHash,
    historicalReceiptIds: budget.snapshot.historicalReceipts.map((receipt) => receipt.id),
  });
  mkdirSync(rootDir, { recursive: true });
  const clock = options.clock ?? createSystemClock();
  const lifecycle = new WatchLifecycleCoordinator({ nowMs: () => clock.now().getTime() });
  let sourceService: (SourceService & SourceWatchProjectionProvider) | null = null;
  let repo: WatchRepository | null = null;
  let coordinator: WatchRunCoordinator | null = null;
  let scheduler: WatchScheduler | null = null;
  let hostGate: HostRequestGate | null = null;
  let workspace: WatchTaskTabWorkspace | null = null;
  let robots: { clearCache(): void } | null = null;
  let sourceClosed: boolean;
  let idempotentDispose: boolean;
  let robotsCleared: boolean;
  let fatalErrorCode: string | null = null;
  const cleanupErrorCodes: string[] = [];
  const pageDiscoveryCounts = new Map<string, number[]>();
  const pageInspectionFailures = new Map<string, string>();
  const scenarios: H3aScenarioEvidence[] = [];
  let lastCandidateDeadlineMono = performance.now() + (options.maxCandidateMs ?? 180_000);

  try {
    const sourcesDir = join(rootDir, 'sources');
    const watchDir = join(rootDir, 'watch');
    mkdirSync(sourcesDir, { recursive: true });
    mkdirSync(watchDir, { recursive: true });
    const sourceOutcome = openSourcesStore({
      dbPath: join(sourcesDir, 'sources.db'),
      backupsDir: join(sourcesDir, 'backups'),
      observer: lifecycle,
      nowMs: () => clock.now().getTime(),
    });
    if (sourceOutcome.mode !== 'normal' || !(sourceOutcome.service instanceof SourceServiceImpl)) {
      throw new Error(`H3a Sources 装配失败：${sourceOutcome.reason ?? '非真实实现'}`);
    }
    sourceService = sourceOutcome.service as SourceService & SourceWatchProjectionProvider;
    const sourceReader = (sourceId: string) => sourceService!.getSourceWatchProjection(sourceId);
    const watchOutcome = openWatchStore({
      dbPath: join(watchDir, 'watch.db'),
      backupsDir: join(watchDir, 'backups'),
      nowMs: () => clock.now().getTime(),
      reconcile: (candidateRepo) => lifecycle.reconcileOnStartup(candidateRepo, sourceReader),
      windowsNotificationsEnabled: false,
    });
    if (watchOutcome.mode !== 'normal') {
      throw new Error(`H3a Watch Store 装配失败：${watchOutcome.reason}`);
    }
    const campaignRepo = watchOutcome.repo;
    repo = campaignRepo;
    lifecycle.bind(campaignRepo, sourceReader);
    hostGate = new HostRequestGate({ clock });
    const publicStack = createPublicWatchHttpStack({
      clock,
      hostGate,
      lookup: options.lookup,
      request: budget.factory,
    });
    robots = publicStack.robots;
    const inspectingTarget: TargetGatedClient = {
      get: async (request) => {
        const result = await publicStack.target.get(request);
        if (
          request.purpose === 'page' &&
          result.kind === 'ok' &&
          result.meta.statusCode >= 200 &&
          result.meta.statusCode < 300
        ) {
          const candidateId = budget.currentCandidateId();
          if (candidateId === null) {
            pageInspectionFailures.set('unknown', 'PAGE_INSPECTION_CONTEXT');
            return result;
          }
          let html: string;
          try {
            html = new TextDecoder('utf-8', { fatal: true }).decode(result.body);
          } catch {
            pageInspectionFailures.set(candidateId, 'PAGE_INSPECTION_UTF8');
            return result;
          }
          const discovery = parseDiscoveryCandidates(html, result.meta.finalUrl);
          if (!discovery.ok) {
            pageInspectionFailures.set(candidateId, 'PAGE_INSPECTION_PARSE');
            return result;
          }
          const counts = pageDiscoveryCounts.get(candidateId) ?? [];
          counts.push(discovery.candidates.length);
          pageDiscoveryCounts.set(candidateId, counts);
        }
        return result;
      },
      head: (request) => publicStack.target.head(request),
    };
    workspace = new WatchTaskTabWorkspace({
      browser: failClosedTabBrowser(),
      onCleanupFailure: () => lifecycle.markUnavailable('H3a Session 工作区清理失败'),
    });
    const reader = new BrowserWatchReader({ browser: failClosedReader(), clock });
    const pageRouter = new PageAcquisitionRouter({
      publicTarget: inspectingTarget,
      workspace,
      reader,
      hostGate,
      clock,
    });
    const acquisition = new WatchAcquisitionService({
      feed: new FeedAcquisitionService({ target: publicStack.target }),
      page: pageRouter,
    });
    const processing = new WatchProcessingServiceImpl({
      repo: campaignRepo,
      clock,
      windowsNotificationsEnabled: false,
    });
    let coordinatorRef: WatchRunCoordinator | null = null;
    scheduler = new WatchScheduler({
      clock,
      onDue: (entries) => coordinatorRef?.handleDue(entries),
    });
    coordinator = new WatchRunCoordinator({
      repo: campaignRepo,
      revalidator: lifecycle,
      acquisition,
      processing,
      hostGate,
      scheduler,
      clock,
    });
    coordinatorRef = coordinator;
    coordinator.start();

    for (const scenario of H3A_MANIFEST.scenarios) {
      const scenarioEvidence: H3aScenarioEvidence = {
        scenarioId: scenario.id,
        kind: scenario.kind,
        result: 'failed',
        selectedCandidateId: null,
        candidates: scenario.candidates.map(candidateSkeleton),
      };
      scenarios.push(scenarioEvidence);
      for (
        let candidateIndex = 0;
        candidateIndex < scenario.candidates.length;
        candidateIndex += 1
      ) {
        const candidate = scenario.candidates[candidateIndex]!;
        const evidence = scenarioEvidence.candidates[candidateIndex]!;
        evidence.attempted = true;
        evidence.result = 'site-failure';
        evidence.startedAt = new Date().toISOString();
        const candidateDeadlineMono = performance.now() + (options.maxCandidateMs ?? 180_000);
        lastCandidateDeadlineMono = candidateDeadlineMono;
        try {
          const added = await sourceService.addManual({
            scope: 'page',
            url: candidate.url,
            name: `H3a ${scenario.id} ${candidate.id}`,
            shareMode: 'blocked',
          });
          if (!added.ok) throw new Error(`H3a Source 创建失败：${added.errorCode}`);
          const sourceProjection = sourceService.getSourceWatchProjection(added.source.id);
          if (sourceProjection.status !== 'found') {
            throw new Error(`H3a Source 读回失败：${sourceProjection.status}`);
          }
          const kind = scenario.kind === 'public-page-no-feed' ? 'page' : 'feed';
          const target: WatchRule['target'] =
            kind === 'page'
              ? {
                  type: 'page',
                  pageUrl: candidate.url,
                  regions: [{ kind: 'main-text', label: '主文档正文' }],
                  sessionConsent: null,
                }
              : { type: 'feed', feedUrl: candidate.url, format: 'rss2' };
          const fingerprint = computeSourceLocatorFingerprint({
            sourceId: sourceProjection.projection.sourceId,
            scope: sourceProjection.projection.scope,
            canonicalKey: sourceProjection.projection.canonicalKey,
            kind,
            canonicalTargetUrl: candidate.url,
          });
          const nowIso = clock.now().toISOString();
          const rule: WatchRule = {
            id: randomUUID(),
            version: 1,
            sourceId: sourceProjection.projection.sourceId,
            kind,
            state: 'enabled',
            pauseReason: null,
            desiredEnabled: true,
            muted: true,
            accessMode: 'public',
            schedule: { kind: 'interval', intervalMinutes: 60 },
            target,
            condition: null,
            notificationLevel: 'normal',
            showDetails: false,
            sourceRowVersion: sourceProjection.projection.rowVersion,
            sourceLocatorFingerprint: fingerprint,
            nextDueAt: new Date(clock.now().getTime() + 86_400_000).toISOString(),
            lastConsumedScheduledFor: null,
            lastDailyLocalDate: null,
            consecutiveFailures: 0,
            backoffUntil: null,
            baselineVersion: 0,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          const inserted = campaignRepo.insertRule(rule);
          if (!inserted.ok) throw new Error(`H3a Rule 创建失败：${inserted.code}`);
          const ruleReadback = campaignRepo.getRule(rule.id);
          evidence.sourceReadback = {
            status: 'ok',
            sourceId: sourceProjection.projection.sourceId,
            ruleId: rule.id,
            rowVersion: sourceProjection.projection.rowVersion,
            enabled: sourceProjection.projection.enabled,
            locatorFingerprintMatched:
              ruleReadback?.sourceLocatorFingerprint === fingerprint &&
              lifecycle.revalidateRuleSource(rule.id).status === 'ok',
          };
          evidence.baselineBeforeVersion = campaignRepo.getBaseline(rule.id)?.version ?? null;
          const firstRequestStart = budget.snapshot.actualCount;
          budget.setContext({ scenarioId: scenario.id, candidateId: candidate.id, phase: 'first' });
          const firstReservation = coordinator.manualRun(rule.id, `h3a:${candidate.id}:first`);
          if (!firstReservation.ok) {
            throw new Error(`H3a 首次 manualRun 拒绝：${firstReservation.reason}`);
          }
          const first = await pollTerminal(
            campaignRepo,
            firstReservation.runId,
            options,
            candidateDeadlineMono,
          );
          await pollCoordinatorIdle(coordinator, options, candidateDeadlineMono);
          budget.clearContext();
          budget.markBusinessSettled(firstRequestStart);
          if (
            !(await budget.waitForTransportClose(
              firstRequestStart,
              candidateDeadlineMono,
              options.onPoll,
            ))
          ) {
            throw codedError(
              'TRANSPORT_CLOSE_TIMEOUT',
              'H3a 首次运行 transport close 超过 candidate 截止',
            );
          }
          evidence.firstRun = runEvidence(first);
          const firstBaseline = campaignRepo.getBaseline(rule.id);
          evidence.baselineAfterFirstVersion = firstBaseline?.version ?? null;
          evidence.baselineAfterFirstValidatorsPresent =
            firstBaseline === null
              ? null
              : firstBaseline.conditionalEtag !== null ||
                firstBaseline.conditionalLastModified !== null;

          if (
            scenario.kind !== 'network-failure' &&
            first?.outcome?.kind === 'baseline-established'
          ) {
            const secondRequestStart = budget.snapshot.actualCount;
            budget.setContext({
              scenarioId: scenario.id,
              candidateId: candidate.id,
              phase: 'second',
            });
            const secondReservation = coordinator.manualRun(rule.id, `h3a:${candidate.id}:second`);
            if (!secondReservation.ok) {
              throw new Error(`H3a 第二次 manualRun 拒绝：${secondReservation.reason}`);
            }
            const second = await pollTerminal(
              campaignRepo,
              secondReservation.runId,
              options,
              candidateDeadlineMono,
            );
            await pollCoordinatorIdle(coordinator, options, candidateDeadlineMono);
            budget.clearContext();
            budget.markBusinessSettled(secondRequestStart);
            if (
              !(await budget.waitForTransportClose(
                secondRequestStart,
                candidateDeadlineMono,
                options.onPoll,
              ))
            ) {
              throw codedError(
                'TRANSPORT_CLOSE_TIMEOUT',
                'H3a 第二次运行 transport close 超过 candidate 截止',
              );
            }
            evidence.secondRun = runEvidence(second);
            const secondBaseline = campaignRepo.getBaseline(rule.id);
            evidence.baselineAfterSecondVersion = secondBaseline?.version ?? null;
            evidence.baselineAfterSecondValidatorsPresent =
              secondBaseline === null
                ? null
                : secondBaseline.conditionalEtag !== null ||
                  secondBaseline.conditionalLastModified !== null;
            evidence.baselineContentChangedOnSecond =
              firstBaseline !== null && secondBaseline !== null
                ? firstBaseline.contentHash !== secondBaseline.contentHash
                : null;
          }

          const events = campaignRepo.listEventsByRule(rule.id);
          const items = events.flatMap((event) => campaignRepo.listEventItems(event.id));
          evidence.eventCount = events.length;
          evidence.typedEvidenceCount = items.length;
          evidence.typedEvidenceKinds = items.map(
            (item) => `${item.before.kind}->${item.after.kind}`,
          );
          evidence.auditReasonCodes = campaignRepo
            .listAudits(1000)
            .filter((audit) => audit.ruleId === rule.id)
            .map((audit) => audit.reasonCode);
          evidence.notificationCount =
            campaignRepo
              .listPendingNotifications('in-app', 50)
              .filter((row) => row.ruleId === rule.id).length +
            campaignRepo
              .listPendingNotifications('windows', 50)
              .filter((row) => row.ruleId === rule.id).length;
          evidence.backoffUntil = campaignRepo.getRule(rule.id)?.backoffUntil ?? null;
          const discoveryCounts = pageDiscoveryCounts.get(candidate.id);
          evidence.noFeedCandidateCount =
            discoveryCounts === undefined
              ? null
              : discoveryCounts.every((count) => count === 0)
                ? 0
                : Math.max(...discoveryCounts);
          evidence.requestCount = budget.countFor(candidate.id, requestCountBeforeCampaign);

          const actualTargetFailure = budget.snapshot.entries.some(
            (entry) =>
              entry.totalOrdinal > requestCountBeforeCampaign &&
              entry.candidateId === candidate.id &&
              entry.purposeClass === 'target' &&
              (entry.statusCode === 503 || entry.errorCode !== null),
          );
          const candidateEntries = budget.snapshot.entries.filter(
            (entry) =>
              entry.totalOrdinal > requestCountBeforeCampaign && entry.candidateId === candidate.id,
          );
          const transportClosed = candidateEntries.every(
            (entry) => entry.requestClosed && (entry.statusCode === null || entry.responseClosed),
          );
          const sourceInvariant =
            evidence.sourceReadback.enabled && evidence.sourceReadback.locatorFingerprintMatched;
          const outcome = evidence.secondRun?.outcomeKind;
          const typedKindsValid = evidence.typedEvidenceKinds.every(
            (kind) =>
              kind === 'present->present' ||
              kind === 'present->absent' ||
              kind === 'absent->present',
          );
          const unchangedInvariant =
            outcome === 'unchanged' &&
            evidence.baselineAfterSecondVersion === evidence.baselineAfterFirstVersion &&
            evidence.baselineContentChangedOnSecond === false &&
            evidence.eventCount === 0 &&
            evidence.typedEvidenceCount === 0 &&
            evidence.auditReasonCodes.includes('unchanged');
          const changedInvariant =
            outcome === 'event-created' &&
            evidence.baselineAfterFirstVersion !== null &&
            evidence.baselineAfterSecondVersion === evidence.baselineAfterFirstVersion + 1 &&
            evidence.baselineContentChangedOnSecond === true &&
            evidence.eventCount === 1 &&
            evidence.typedEvidenceCount > 0 &&
            typedKindsValid &&
            evidence.auditReasonCodes.includes('event-created');
          const successfulProductInvariant =
            sourceInvariant &&
            transportClosed &&
            evidence.notificationCount === 0 &&
            evidence.firstRun?.outcomeKind === 'baseline-established' &&
            evidence.baselineAfterFirstVersion === 1 &&
            evidence.auditReasonCodes.includes('baseline-established') &&
            (unchangedInvariant || changedInvariant);
          const feedSiteInvariant =
            evidence.firstRun?.httpStatus === 200 &&
            (evidence.secondRun?.httpStatus === 200 || evidence.secondRun?.httpStatus === 304) &&
            evidence.baselineAfterFirstValidatorsPresent === true &&
            evidence.baselineAfterSecondValidatorsPresent === true &&
            candidateEntries.some(
              (entry) =>
                entry.phase === 'second' &&
                entry.purposeClass === 'target' &&
                entry.conditionalRequest,
            );
          const pageProductInvariant =
            evidence.baselineAfterFirstValidatorsPresent === false &&
            evidence.baselineAfterSecondValidatorsPresent === false &&
            !candidateEntries.some(
              (entry) => entry.purposeClass === 'target' && entry.conditionalRequest,
            );
          const pageSiteInvariant =
            evidence.firstRun?.httpStatus === 200 &&
            evidence.secondRun?.httpStatus === 200 &&
            evidence.noFeedCandidateCount === 0;
          const failureProductInvariant =
            sourceInvariant &&
            transportClosed &&
            evidence.firstRun?.outcomeKind === 'failed' &&
            evidence.firstRun.healthCode === 'unavailable' &&
            evidence.baselineAfterFirstVersion === null &&
            evidence.baselineAfterSecondVersion === null &&
            evidence.eventCount === 0 &&
            evidence.typedEvidenceCount === 0 &&
            evidence.notificationCount === 0 &&
            evidence.backoffUntil !== null;
          const scenarioPass = (() => {
            if (scenario.kind === 'network-failure') {
              return actualTargetFailure && failureProductInvariant;
            }
            return (
              successfulProductInvariant &&
              (scenario.kind === 'rss-or-atom'
                ? feedSiteInvariant
                : pageProductInvariant && pageSiteInvariant)
            );
          })();
          if (scenarioPass) {
            evidence.result = 'pass';
            scenarioEvidence.result = 'pass';
            scenarioEvidence.selectedCandidateId = candidate.id;
            break;
          }
          const productInvariantBroken =
            !sourceInvariant ||
            !transportClosed ||
            evidence.notificationCount !== 0 ||
            (evidence.firstRun?.outcomeKind === 'baseline-established' &&
              (evidence.baselineAfterFirstVersion !== 1 ||
                !evidence.auditReasonCodes.includes('baseline-established'))) ||
            ((outcome === 'unchanged' || outcome === 'event-created') &&
              !successfulProductInvariant) ||
            (outcome !== undefined &&
              outcome !== 'unchanged' &&
              outcome !== 'event-created' &&
              outcome !== 'failed') ||
            (scenario.kind === 'public-page-no-feed' &&
              evidence.firstRun?.outcomeKind === 'baseline-established' &&
              !pageProductInvariant) ||
            (actualTargetFailure &&
              evidence.firstRun?.outcomeKind === 'failed' &&
              evidence.firstRun.healthCode === 'unavailable' &&
              !failureProductInvariant);
          if (productInvariantBroken) {
            evidence.result = 'product-defect';
            throw codedError('PRODUCT_INVARIANT', 'H3a 产品终态不变量未闭合');
          }
          evidence.failureCode =
            pageInspectionFailures.get(candidate.id) ??
            evidence.firstRun?.healthCode ??
            evidence.firstRun?.outcomeKind ??
            'site';
          if (
            evidence.firstRun?.healthCode === 'security_rejected' ||
            evidence.firstRun?.healthCode === 'budget_exceeded' ||
            evidence.firstRun?.healthCode === 'dependency_unavailable'
          ) {
            evidence.result = 'product-defect';
            throw new Error(`H3a 产品/安全失败：${evidence.firstRun.healthCode}`);
          }
        } catch (error) {
          budget.clearContext();
          evidence.failureCode =
            error instanceof Error ? safeErrorCode(error) : (evidence.failureCode ?? 'ERROR');
          evidence.result = 'product-defect';
          throw error;
        } finally {
          evidence.requestCount = budget.countFor(candidate.id, requestCountBeforeCampaign);
          evidence.finishedAt = new Date().toISOString();
        }
      }
    }
  } catch (error) {
    fatalErrorCode = safeErrorCode(error instanceof Error ? error : new Error('campaign'));
  } finally {
    budget.clearContext();
    const cleanup = async (code: string, work: () => void | Promise<void>): Promise<void> => {
      try {
        await work();
      } catch {
        cleanupErrorCodes.push(code);
      }
    };
    await cleanup('COORDINATOR_STOP_1', async () => coordinator?.stop());
    await cleanup('COORDINATOR_STOP_2', async () => coordinator?.stop());
    await cleanup('TRANSPORT_CLOSE_BARRIER', async () => {
      budget.markBusinessSettled(requestCountBeforeCampaign);
      if (
        !(await budget.waitForTransportClose(
          requestCountBeforeCampaign,
          lastCandidateDeadlineMono,
          options.onPoll,
        ))
      ) {
        throw codedError('TRANSPORT_CLOSE_TIMEOUT', 'H3a 最终 transport close 超过 candidate 截止');
      }
    });
    await cleanup('SCHEDULER_STOP_1', () => scheduler?.stop());
    await cleanup('SCHEDULER_STOP_2', () => scheduler?.stop());
    await cleanup('WORKSPACE_CLEANUP_1', async () => {
      await workspace?.cleanupAll();
    });
    await cleanup('WORKSPACE_CLEANUP_2', async () => {
      await workspace?.cleanupAll();
    });
    await cleanup('ROBOTS_CLEAR_1', () => robots?.clearCache());
    await cleanup('ROBOTS_CLEAR_2', () => robots?.clearCache());
    robotsCleared =
      robots !== null && !cleanupErrorCodes.some((code) => code.startsWith('ROBOTS_'));
    await cleanup('HOST_GATE_CLEAR_1', () => hostGate?.clear());
    await cleanup('HOST_GATE_CLEAR_2', () => hostGate?.clear());
    await cleanup('LIFECYCLE_DISPOSE_1', () => lifecycle.dispose());
    await cleanup('LIFECYCLE_DISPOSE_2', () => lifecycle.dispose());
    await cleanup('WATCH_REPOSITORY_DISPOSE_1', () => repo?.dispose());
    await cleanup('WATCH_REPOSITORY_DISPOSE_2', () => repo?.dispose());
    await cleanup('SOURCE_SERVICE_DISPOSE_1', () => sourceService?.dispose());
    await cleanup('SOURCE_SERVICE_DISPOSE_2', () => sourceService?.dispose());
    sourceClosed =
      sourceService !== null &&
      !cleanupErrorCodes.some((code) => code.startsWith('SOURCE_SERVICE_'));
    await cleanup('ROOT_REMOVE', () => {
      if (existsSync(rootDir)) rmSync(rootDir, { recursive: true, force: false });
    });
    idempotentDispose = cleanupErrorCodes.length === 0;
    if (cleanupErrorCodes.length > 0 && fatalErrorCode === null) {
      fatalErrorCode = 'CLEANUP_FAILED';
    }
  }

  const ledger = budget.snapshot;
  const report: H3aReport = {
    schemaVersion: 1,
    candidateSha: options.candidateSha,
    buildHash: options.buildHash,
    manifestHash: H3A_MANIFEST_CONTENT_HASH,
    mode: options.mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    fatalErrorCode,
    scenarios,
    requests: {
      beforeCount: requestCountBeforeCampaign,
      campaignCount: ledger.actualCount - requestCountBeforeCampaign,
      actualCount: ledger.actualCount,
      rejectedCount: ledger.rejectedCount,
      perCandidateCounts: ledger.perCandidateCounts,
      historicalReceipts: ledger.historicalReceipts,
      workflowLedgerHash: ledger.workflowLedgerHash,
      entries: ledger.entries,
    },
    cleanup: {
      coordinatorActive: coordinator?.activeRunCount() ?? 0,
      coordinatorPending: coordinator?.pendingRunCount() ?? 0,
      schedulerStopped: scheduler?.isStopped ?? true,
      hostGateEntries: hostGate?.size ?? 0,
      openRequests: ledger.entries.filter((entry) => !entry.requestClosed).length,
      openResponses: ledger.entries.filter(
        (entry) => entry.statusCode !== null && !entry.responseClosed,
      ).length,
      robotsCleared,
      watchRepositoryClosed: repo?.isDisposed ?? true,
      sourceServiceClosed: sourceClosed,
      rootRemoved: !existsSync(rootDir),
      idempotentDispose,
      errorCodes: cleanupErrorCodes,
    },
  };
  const validationErrors = validateH3aReport(report);
  const reportPath = immutableEvidencePath(evidenceDir, 'report', startedAt);
  atomicJson(reportPath, { report, validationErrors });
  return {
    report,
    validationErrors,
    reportPath,
    ledgerPath: join(evidenceDir, 'request-ledger.json'),
  };
}

function diagnosticBaseline(
  baseline: ReturnType<WatchRepository['getBaseline']>,
): H3aFeedBudgetDiagnosticReport['baselineBefore'] {
  return baseline === null
    ? null
    : {
        version: baseline.version,
        contentHash: baseline.contentHash,
        validatorsPresent:
          baseline.conditionalEtag !== null || baseline.conditionalLastModified !== null,
      };
}

export async function runH3aFeedBudgetDiagnostic(
  options: H3aCampaignOptions,
): Promise<H3aFeedBudgetDiagnosticResult> {
  assertRuntimeMetadata(options);
  const rootDir = assertControlledRoot(options.rootDir);
  const evidenceDir = resolve(options.evidenceDir);
  if (isWithin(rootDir, evidenceDir)) throw new Error('H3a evidenceDir 不得位于待清理临时根目录内');
  mkdirSync(evidenceDir, { recursive: true });
  const manifestPath = join(evidenceDir, 'manifest.json');
  const manifestBytes = canonicalH3aManifest();
  if (existsSync(manifestPath)) {
    if (readFileSync(manifestPath, 'utf8') !== manifestBytes) {
      throw new Error('NASA 单次诊断既有 manifest 字节与冻结内容不一致');
    }
  } else {
    writeFileSync(manifestPath, manifestBytes, { encoding: 'utf8', flag: 'wx' });
  }
  const scenario = H3A_MANIFEST.scenarios.find((item) => item.id === 'h3a-rss');
  const candidate = scenario?.candidates.find((item) => item.id === 'rss-fallback');
  if (
    scenario === undefined ||
    scenario.kind !== 'rss-or-atom' ||
    candidate === undefined ||
    candidate.url !== 'https://www.nasa.gov/feed/'
  ) {
    throw new Error('NASA 单次诊断冻结 manifest 身份非法');
  }
  const workflowDir = resolve(options.workflowDir ?? join(evidenceDir, 'workflow-usage'));
  if (isWithin(rootDir, workflowDir)) {
    throw new Error('H3a workflow usage 目录不得位于待清理临时根目录内');
  }
  const budget = new H3aRequestBudget({
    evidenceDir,
    candidateSha: options.candidateSha,
    buildHash: options.buildHash,
    request: options.request,
    workflowDir,
    historicalReceipts: options.historicalUsageSources,
    requireExistingWorkflow: true,
  });
  const requestCountBefore = budget.snapshot.actualCount;
  const claimResult = budget.claimNasaDiagnostic(options.candidateSha, options.buildHash);
  const startedAt = new Date().toISOString();
  atomicJson(immutableEvidencePath(evidenceDir, 'diagnostic-start', startedAt), {
    schemaVersion: 1,
    reportKind: 'feed-budget-diagnostic',
    diagnosticId: H3A_NASA_DIAGNOSTIC_ID,
    candidateSha: options.candidateSha,
    buildHash: options.buildHash,
    manifestHash: H3A_MANIFEST_CONTENT_HASH,
    mode: options.mode,
    startedAt,
    workflowBeforeCount: requestCountBefore,
    workflowBeforeHash: claimResult.claim.workflowBeforeHash,
    claimHash: claimResult.claimHash,
  });

  mkdirSync(rootDir, { recursive: true });
  const clock = options.clock ?? createSystemClock();
  const lifecycle = new WatchLifecycleCoordinator({ nowMs: () => clock.now().getTime() });
  let sourceService: (SourceService & SourceWatchProjectionProvider) | null = null;
  let repo: WatchRepository | null = null;
  let coordinator: WatchRunCoordinator | null = null;
  let scheduler: WatchScheduler | null = null;
  let hostGate: HostRequestGate | null = null;
  let workspace: WatchTaskTabWorkspace | null = null;
  let robots: { clearCache(): void } | null = null;
  let sourceClosed: boolean;
  let robotsCleared: boolean;
  let idempotentDispose: boolean;
  let fatalErrorCode: string | null = null;
  const cleanupErrorCodes: string[] = [];
  const budgetObservations: H3aBudgetObservation[] = [];
  let observationOverflow = false;
  const observeBudget = (observation: H3aBudgetObservation): void => {
    if (budgetObservations.length >= 64) {
      observationOverflow = true;
      return;
    }
    budgetObservations.push(observation);
  };
  const candidateDeadlineMono = performance.now() + (options.maxCandidateMs ?? 180_000);
  let sourceReadback: H3aFeedBudgetDiagnosticReport['sourceReadback'] = null;
  let firstRun: H3aRunEvidence | null = null;
  let baselineBefore: H3aFeedBudgetDiagnosticReport['baselineBefore'] = null;
  let baselineAfter: H3aFeedBudgetDiagnosticReport['baselineAfter'] = null;
  let eventCount = 0;
  let typedEvidenceCount = 0;
  let notificationCount = 0;
  let auditReasonCodes: string[] = [];
  let observation: H3aFeedBudgetDiagnosticReport['observation'];

  try {
    const sourcesDir = join(rootDir, 'sources');
    const watchDir = join(rootDir, 'watch');
    mkdirSync(sourcesDir, { recursive: true });
    mkdirSync(watchDir, { recursive: true });
    const sourceOutcome = openSourcesStore({
      dbPath: join(sourcesDir, 'sources.db'),
      backupsDir: join(sourcesDir, 'backups'),
      observer: lifecycle,
      nowMs: () => clock.now().getTime(),
    });
    if (sourceOutcome.mode !== 'normal' || !(sourceOutcome.service instanceof SourceServiceImpl)) {
      throw codedError('SOURCE_ASSEMBLY_FAILED', 'NASA 单次诊断 Sources 装配失败');
    }
    sourceService = sourceOutcome.service as SourceService & SourceWatchProjectionProvider;
    const sourceReader = (sourceId: string) => sourceService!.getSourceWatchProjection(sourceId);
    const watchOutcome = openWatchStore({
      dbPath: join(watchDir, 'watch.db'),
      backupsDir: join(watchDir, 'backups'),
      nowMs: () => clock.now().getTime(),
      reconcile: (candidateRepo) => lifecycle.reconcileOnStartup(candidateRepo, sourceReader),
      windowsNotificationsEnabled: false,
    });
    if (watchOutcome.mode !== 'normal') {
      throw codedError('WATCH_ASSEMBLY_FAILED', 'NASA 单次诊断 Watch Store 装配失败');
    }
    const diagnosticRepo = watchOutcome.repo;
    repo = diagnosticRepo;
    lifecycle.bind(diagnosticRepo, sourceReader);
    hostGate = new HostRequestGate({ clock });
    const publicStack = createPublicWatchHttpStack({
      clock,
      hostGate,
      lookup: options.lookup,
      request: budget.factory,
      observeBudget,
    });
    robots = publicStack.robots;
    workspace = new WatchTaskTabWorkspace({
      browser: failClosedTabBrowser(),
      onCleanupFailure: () => lifecycle.markUnavailable('NASA 单次诊断 Session 工作区清理失败'),
    });
    const pageRouter = new PageAcquisitionRouter({
      publicTarget: publicStack.target,
      workspace,
      reader: new BrowserWatchReader({ browser: failClosedReader(), clock }),
      hostGate,
      clock,
    });
    const acquisition = new WatchAcquisitionService({
      feed: new FeedAcquisitionService({ target: publicStack.target, observeBudget }),
      page: pageRouter,
    });
    const processing = new WatchProcessingServiceImpl({
      repo: diagnosticRepo,
      clock,
      windowsNotificationsEnabled: false,
    });
    let coordinatorRef: WatchRunCoordinator | null = null;
    scheduler = new WatchScheduler({
      clock,
      onDue: (entries) => coordinatorRef?.handleDue(entries),
    });
    coordinator = new WatchRunCoordinator({
      repo: diagnosticRepo,
      revalidator: lifecycle,
      acquisition,
      processing,
      hostGate,
      scheduler,
      clock,
    });
    coordinatorRef = coordinator;
    coordinator.start();

    const added = await sourceService.addManual({
      scope: 'page',
      url: candidate.url,
      name: 'H3a NASA Feed 单次预算诊断',
      shareMode: 'blocked',
    });
    if (!added.ok) throw codedError('SOURCE_CREATE_FAILED', 'NASA 单次诊断 Source 创建失败');
    const sourceProjection = sourceService.getSourceWatchProjection(added.source.id);
    if (sourceProjection.status !== 'found') {
      throw codedError('SOURCE_READBACK_FAILED', 'NASA 单次诊断 Source 读回失败');
    }
    const fingerprint = computeSourceLocatorFingerprint({
      sourceId: sourceProjection.projection.sourceId,
      scope: sourceProjection.projection.scope,
      canonicalKey: sourceProjection.projection.canonicalKey,
      kind: 'feed',
      canonicalTargetUrl: candidate.url,
    });
    const nowIso = clock.now().toISOString();
    const rule: WatchRule = {
      id: randomUUID(),
      version: 1,
      sourceId: sourceProjection.projection.sourceId,
      kind: 'feed',
      state: 'enabled',
      pauseReason: null,
      desiredEnabled: true,
      muted: true,
      accessMode: 'public',
      schedule: { kind: 'interval', intervalMinutes: 60 },
      target: { type: 'feed', feedUrl: candidate.url, format: 'rss2' },
      condition: null,
      notificationLevel: 'normal',
      showDetails: false,
      sourceRowVersion: sourceProjection.projection.rowVersion,
      sourceLocatorFingerprint: fingerprint,
      nextDueAt: new Date(clock.now().getTime() + 86_400_000).toISOString(),
      lastConsumedScheduledFor: null,
      lastDailyLocalDate: null,
      consecutiveFailures: 0,
      backoffUntil: null,
      baselineVersion: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const inserted = diagnosticRepo.insertRule(rule);
    if (!inserted.ok) throw codedError('RULE_CREATE_FAILED', 'NASA 单次诊断 Rule 创建失败');
    const ruleReadback = diagnosticRepo.getRule(rule.id);
    sourceReadback = {
      status: 'ok',
      sourceId: sourceProjection.projection.sourceId,
      ruleId: rule.id,
      rowVersion: sourceProjection.projection.rowVersion,
      enabled: sourceProjection.projection.enabled,
      locatorFingerprintMatched:
        ruleReadback?.sourceLocatorFingerprint === fingerprint &&
        lifecycle.revalidateRuleSource(rule.id).status === 'ok',
    };
    baselineBefore = diagnosticBaseline(diagnosticRepo.getBaseline(rule.id));
    budget.setContext({ scenarioId: scenario.id, candidateId: candidate.id, phase: 'first' });
    const reservation = coordinator.manualRun(rule.id, `h3a:${H3A_NASA_DIAGNOSTIC_ID}:first`);
    if (!reservation.ok) {
      throw codedError('MANUAL_RUN_REJECTED', 'NASA 单次诊断 manualRun 被拒绝');
    }
    const terminal = await pollTerminal(
      diagnosticRepo,
      reservation.runId,
      options,
      candidateDeadlineMono,
    );
    await pollCoordinatorIdle(coordinator, options, candidateDeadlineMono);
    budget.clearContext();
    budget.markBusinessSettled(requestCountBefore);
    if (
      !(await budget.waitForTransportClose(
        requestCountBefore,
        candidateDeadlineMono,
        options.onPoll,
      ))
    ) {
      throw codedError('TRANSPORT_CLOSE_TIMEOUT', 'NASA 单次诊断 transport close 超过截止');
    }
    firstRun = runEvidence(terminal);
    baselineAfter = diagnosticBaseline(diagnosticRepo.getBaseline(rule.id));
    const events = diagnosticRepo.listEventsByRule(rule.id);
    eventCount = events.length;
    typedEvidenceCount = events.flatMap((event) => diagnosticRepo.listEventItems(event.id)).length;
    notificationCount =
      diagnosticRepo.listPendingNotifications('in-app', 50).filter((row) => row.ruleId === rule.id)
        .length +
      diagnosticRepo.listPendingNotifications('windows', 50).filter((row) => row.ruleId === rule.id)
        .length;
    auditReasonCodes = diagnosticRepo
      .listAudits(1000)
      .filter((audit) => audit.ruleId === rule.id)
      .map((audit) => audit.reasonCode);

    const commonInvariant =
      sourceReadback.enabled &&
      sourceReadback.locatorFingerprintMatched &&
      baselineBefore === null &&
      eventCount === 0 &&
      typedEvidenceCount === 0 &&
      notificationCount === 0;
    if (firstRun?.outcomeKind === 'baseline-established') {
      if (
        !commonInvariant ||
        baselineAfter?.version !== 1 ||
        !auditReasonCodes.includes('baseline-established')
      ) {
        throw codedError('PRODUCT_INVARIANT', 'NASA 首次 Baseline 产品不变量未闭合');
      }
      observation = 'baseline-established';
    } else if (firstRun?.outcomeKind === 'failed' && firstRun.healthCode === 'budget_exceeded') {
      if (!commonInvariant || baselineAfter !== null) {
        throw codedError('PRODUCT_INVARIANT', 'NASA budget_exceeded 产品不变量未闭合');
      }
      observation = 'budget-exceeded';
    } else if (firstRun?.outcomeKind === 'failed') {
      if (!commonInvariant || baselineAfter !== null) {
        throw codedError('PRODUCT_INVARIANT', 'NASA 失败产品不变量未闭合');
      }
      observation = 'other-acquisition-failure';
    } else {
      throw codedError('PRODUCT_INVARIANT', 'NASA 单次诊断缺少合法首次 Run 终态');
    }
    if (observationOverflow) {
      throw codedError('OBSERVATION_OVERFLOW', 'NASA 单次诊断预算观察超过固定上限');
    }
  } catch (error) {
    budget.clearContext();
    fatalErrorCode = safeErrorCode(error instanceof Error ? error : new Error('diagnostic'));
    observation = 'product-invariant-violation';
  } finally {
    budget.clearContext();
    const cleanup = async (code: string, work: () => void | Promise<void>): Promise<void> => {
      try {
        await work();
      } catch {
        cleanupErrorCodes.push(code);
      }
    };
    await cleanup('COORDINATOR_STOP_1', async () => coordinator?.stop());
    await cleanup('COORDINATOR_STOP_2', async () => coordinator?.stop());
    await cleanup('TRANSPORT_CLOSE_BARRIER', async () => {
      budget.markBusinessSettled(requestCountBefore);
      if (
        !(await budget.waitForTransportClose(
          requestCountBefore,
          candidateDeadlineMono,
          options.onPoll,
        ))
      ) {
        throw codedError('TRANSPORT_CLOSE_TIMEOUT', 'NASA 单次诊断最终 transport close 超过截止');
      }
    });
    await cleanup('SCHEDULER_STOP_1', () => scheduler?.stop());
    await cleanup('SCHEDULER_STOP_2', () => scheduler?.stop());
    await cleanup('WORKSPACE_CLEANUP_1', async () => {
      await workspace?.cleanupAll();
    });
    await cleanup('WORKSPACE_CLEANUP_2', async () => {
      await workspace?.cleanupAll();
    });
    await cleanup('ROBOTS_CLEAR_1', () => robots?.clearCache());
    await cleanup('ROBOTS_CLEAR_2', () => robots?.clearCache());
    robotsCleared =
      robots !== null && !cleanupErrorCodes.some((code) => code.startsWith('ROBOTS_'));
    await cleanup('HOST_GATE_CLEAR_1', () => hostGate?.clear());
    await cleanup('HOST_GATE_CLEAR_2', () => hostGate?.clear());
    await cleanup('LIFECYCLE_DISPOSE_1', () => lifecycle.dispose());
    await cleanup('LIFECYCLE_DISPOSE_2', () => lifecycle.dispose());
    await cleanup('WATCH_REPOSITORY_DISPOSE_1', () => repo?.dispose());
    await cleanup('WATCH_REPOSITORY_DISPOSE_2', () => repo?.dispose());
    await cleanup('SOURCE_SERVICE_DISPOSE_1', () => sourceService?.dispose());
    await cleanup('SOURCE_SERVICE_DISPOSE_2', () => sourceService?.dispose());
    sourceClosed =
      sourceService !== null &&
      !cleanupErrorCodes.some((code) => code.startsWith('SOURCE_SERVICE_'));
    await cleanup('ROOT_REMOVE', () => {
      if (existsSync(rootDir)) rmSync(rootDir, { recursive: true, force: false });
    });
    idempotentDispose = cleanupErrorCodes.length === 0;
    if (cleanupErrorCodes.length > 0 && fatalErrorCode === null) {
      fatalErrorCode = 'CLEANUP_FAILED';
      observation = 'product-invariant-violation';
    }
  }

  const observationsPath = immutableEvidencePath(evidenceDir, 'budget-observations', startedAt);
  try {
    atomicJson(observationsPath, {
      schemaVersion: 1,
      reportKind: 'feed-budget-diagnostic-observations',
      diagnosticId: H3A_NASA_DIAGNOSTIC_ID,
      candidateSha: options.candidateSha,
      buildHash: options.buildHash,
      manifestHash: H3A_MANIFEST_CONTENT_HASH,
      observations: budgetObservations,
    });
  } catch {
    fatalErrorCode = 'EVIDENCE_WRITE_FAILED';
    observation = 'product-invariant-violation';
  }
  const decisiveBudgetObservation = budgetObservations.some(
    (item) =>
      (item.stage === 'public-http-body' && item.outcome === 'response-too-large') ||
      (item.stage === 'feed-parser' &&
        (item.outcome === 'product-budget' || item.outcome === 'projection-budget')) ||
      (item.stage === 'feed-acquisition' && item.outcome === 'baseline-budget'),
  );
  const executionStatus: H3aFeedBudgetDiagnosticReport['executionStatus'] =
    fatalErrorCode !== null
      ? 'failed'
      : observation === 'baseline-established'
        ? 'recorded'
        : observation === 'budget-exceeded' && decisiveBudgetObservation
          ? 'recorded'
          : 'inconclusive';
  const ledger = budget.snapshot;
  const cleanupEvidence: H3aFeedBudgetDiagnosticReport['cleanup'] = {
    coordinatorActive: coordinator?.activeRunCount() ?? 0,
    coordinatorPending: coordinator?.pendingRunCount() ?? 0,
    schedulerStopped: scheduler?.isStopped ?? true,
    hostGateEntries: hostGate?.size ?? 0,
    openRequests: ledger.entries.filter((entry) => !entry.requestClosed).length,
    openResponses: ledger.entries.filter(
      (entry) => entry.statusCode !== null && !entry.responseClosed,
    ).length,
    robotsCleared,
    watchRepositoryClosed: repo?.isDisposed ?? true,
    sourceServiceClosed: sourceClosed,
    rootRemoved: !existsSync(rootDir),
    idempotentDispose,
    errorCodes: cleanupErrorCodes,
  };
  const report: H3aFeedBudgetDiagnosticReport = {
    reportKind: 'feed-budget-diagnostic',
    schemaVersion: 1,
    diagnosticId: H3A_NASA_DIAGNOSTIC_ID,
    qualification: 'not-evaluated',
    executionStatus,
    observation,
    candidateSha: options.candidateSha,
    buildHash: options.buildHash,
    manifestHash: H3A_MANIFEST_CONTENT_HASH,
    mode: options.mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    fatalErrorCode,
    claim: {
      claimedAt: claimResult.claim.claimedAt,
      claimHash: claimResult.claimHash,
      workflowBeforeHash: claimResult.claim.workflowBeforeHash,
    },
    sourceReadback,
    firstRun,
    baselineBefore,
    baselineAfter,
    eventCount,
    typedEvidenceCount,
    notificationCount,
    auditReasonCodes,
    budgetObservations,
    cumulativeRequests: {
      beforeCount: requestCountBefore,
      diagnosticCount: ledger.actualCount - requestCountBefore,
      actualCount: ledger.actualCount,
      rejectedCount: ledger.rejectedCount,
      perCandidateCounts: ledger.perCandidateCounts,
      workflowBeforeHash: claimResult.claim.workflowBeforeHash,
      workflowAfterHash: ledger.workflowLedgerHash,
      entries: ledger.entries,
    },
    cleanup: cleanupEvidence,
  };
  const validationErrors = validateH3aFeedBudgetDiagnosticReport(report);
  const reportPath = immutableEvidencePath(evidenceDir, 'report', startedAt);
  atomicJson(reportPath, { report, validationErrors });
  return {
    report,
    validationErrors,
    reportPath,
    ledgerPath: join(evidenceDir, 'request-ledger.json'),
    observationsPath,
  };
}
