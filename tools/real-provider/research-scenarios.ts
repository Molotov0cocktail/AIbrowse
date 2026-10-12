import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LLMProvider } from '../../src/main/ai/provider/llm-provider';
import type { BrowserControllerImpl } from '../../src/main/browser/browser-controller';
import { CaptureService } from '../../src/main/research/capture-service';
import { ZERO_TASK_STATS } from '../../src/main/research/domain/research-task-state';
import { runResearchMigrations } from '../../src/main/research/db/research-migrations';
import { ResearchRepository } from '../../src/main/research/repository/research-repository';
import { validateResearchTransfer } from '../../src/main/research/repository/research-transfer-validation';
import { ResearchRuntime } from '../../src/main/research/research-runtime';
import { createRepositoryPersistence } from '../../src/main/research/research-runtime-persistence';
import { ResearchWorkspace } from '../../src/main/research/research-workspace';
import { RESEARCH_RESULT_VALIDATION_PORT } from '../../src/main/research/result-validator';
import { RESEARCH_SYNTHESIS_PORT } from '../../src/main/research/synthesis/claim-model';
import { RESEARCH_PROMPTS_PORT } from '../../src/main/research/synthesis/research-prompts';
import { openDb, closeDb } from '../../src/main/sources/db/sqlite-driver';
import { runMigrations } from '../../src/main/sources/db/migrations';
import { SourceServiceImpl } from '../../src/main/sources/source-service';
import type { NormalizedErrorCode } from '../../src/shared/types/conversation';
import type { ResearchPhase, ResearchTaskStatus } from '../../src/shared/types/research';

const SCENARIO_DEADLINE_MS = 240_000;
const MAX_STREAM_CALLS = 16;

interface PhaseCounts {
  streamCalls: number;
  completedStreams: number;
  incompleteStreams: number;
  providerErrors: number;
  providerThrows: number;
  providerBudgetRejects: number;
  toolCalls: number;
}

function blankPhaseCounts(): PhaseCounts {
  return {
    streamCalls: 0,
    completedStreams: 0,
    incompleteStreams: 0,
    providerErrors: 0,
    providerThrows: 0,
    providerBudgetRejects: 0,
    toolCalls: 0,
  };
}

type CheckName =
  | 'sourceStoreEmpty'
  | 'twoGoalCandidates'
  | 'capturesPerSource'
  | 'evidencePerSource'
  | 'claimsLinked'
  | 'resultLinked'
  | 'ownershipIsolated'
  | 'transferValid'
  | 'cleanupComplete'
  | 'withinProviderBudget';

export interface ResearchScenariosReport {
  passed: boolean;
  taskStatus: string;
  taskErrorCode: string | null;
  setupErrorCode: 'invalid-origin' | 'internal-exception' | null;
  counts: {
    streamCalls: number;
    completedStreams: number;
    incompleteStreams: number;
    providerErrors: number;
    providerThrows: number;
    providerBudgetRejects: number;
    toolCalls: number;
    textChars: number;
    reasoningChars: number;
    sourceRows: number;
    searchCalls: number;
    candidates: number;
    captures: number;
    successfulCaptures: number;
    evidence: number;
    claims: number;
    conflicts: number;
    results: number;
    failedReads: number;
    rejectedEvidence: number;
    stepsUsed: number;
    roundsUsed: number;
  };
  providerErrorCodes: Partial<Record<NormalizedErrorCode, number>>;
  captureFailureCodes: Record<string, number>;
  phases: Record<ResearchPhase, PhaseCounts>;
  transitions: Array<{
    status: ResearchTaskStatus;
    phase: ResearchPhase | null;
    streamCalls: number;
    stepsUsed: number;
    roundsUsed: number;
  }>;
  validation: Array<{
    stage: 'verification' | 'result-parse' | 'result-validation';
    streamCalls: number;
    ok: boolean;
    reasons: string[];
  }>;
  checks: Record<CheckName, boolean>;
  modelEchoVerified: false;
}

function blankReport(): ResearchScenariosReport {
  return {
    passed: false,
    taskStatus: 'missing',
    taskErrorCode: null,
    setupErrorCode: null,
    counts: {
      streamCalls: 0,
      completedStreams: 0,
      incompleteStreams: 0,
      providerErrors: 0,
      providerThrows: 0,
      providerBudgetRejects: 0,
      toolCalls: 0,
      textChars: 0,
      reasoningChars: 0,
      sourceRows: -1,
      searchCalls: 0,
      candidates: 0,
      captures: 0,
      successfulCaptures: 0,
      evidence: 0,
      claims: 0,
      conflicts: 0,
      results: 0,
      failedReads: 0,
      rejectedEvidence: 0,
      stepsUsed: 0,
      roundsUsed: 0,
    },
    providerErrorCodes: {},
    captureFailureCodes: {},
    phases: {
      planning: blankPhaseCounts(),
      reading: blankPhaseCounts(),
      verifying: blankPhaseCounts(),
      synthesizing: blankPhaseCounts(),
    },
    transitions: [],
    validation: [],
    checks: {
      sourceStoreEmpty: false,
      twoGoalCandidates: false,
      capturesPerSource: false,
      evidencePerSource: false,
      claimsLinked: false,
      resultLinked: false,
      ownershipIsolated: false,
      transferValid: false,
      cleanupComplete: false,
      withinProviderBudget: true,
    },
    // Provider APIs do not expose an independently trustworthy actual-model echo.
    modelEchoVerified: false,
  };
}

function sameTabs(
  before: Awaited<ReturnType<BrowserControllerImpl['getTabs']>>,
  after: Awaited<ReturnType<BrowserControllerImpl['getTabs']>>,
): boolean {
  return (
    before.length === after.length &&
    before.every((tab) =>
      after.some(
        (item) => item.id === tab.id && item.url === tab.url && item.active === tab.active,
      ),
    )
  );
}

/**
 * Runs a bounded real-provider Research scenario over two local synthetic pages.
 * The report deliberately contains only codes, counts and structural booleans.
 */
export async function runResearchScenarios(
  controller: BrowserControllerImpl,
  origin: string,
  root: string,
  provider: LLMProvider,
  model: string,
): Promise<ResearchScenariosReport> {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'research-scenarios-'));
  const reportPath = join(directory, 'report.json');
  const report = blankReport();
  const save = (): void => writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  let sourceDb: ReturnType<typeof openDb> | null = null;
  let sourceService: SourceServiceImpl | null = null;
  let researchDb: ReturnType<typeof openDb> | null = null;
  let workspace: ResearchWorkspace | null = null;
  try {
    const parsedOrigin = new URL(origin);
    if (
      parsedOrigin.protocol !== 'http:' ||
      parsedOrigin.hostname !== '127.0.0.1' ||
      parsedOrigin.origin !== origin
    ) {
      report.setupErrorCode = 'invalid-origin';
      return report;
    }

    sourceDb = openDb(join(directory, 'sources.db'));
    researchDb = openDb(join(directory, 'research.db'));
    runMigrations(sourceDb);
    runResearchMigrations(researchDb);
    sourceService = new SourceServiceImpl({ db: sourceDb });
    const repository = new ResearchRepository(researchDb);
    const taskId = randomUUID();
    const timestamp = new Date().toISOString();
    const urls = [`${origin}/a`, `${origin}/b`] as const;
    const goal =
      `先调用一次 source_list 核对当前信源库为空，然后仅比较显式目标 ${urls[0]} 与 ${urls[1]}。` +
      '提取两页可由原文验证的价格和日期事实；不要调用 search_web，不要假定它们是现实世界资料。';
    repository.insertTask({
      id: taskId,
      goal,
      status: 'running',
      phase: 'planning',
      created_at: timestamp,
      updated_at: timestamp,
      started_at: timestamp,
      finished_at: null,
      interrupted_at: null,
      error_code: null,
      result_id: null,
      stats_json: JSON.stringify(ZERO_TASK_STATS),
    });

    const beforeTabs = await controller.getTabs();
    workspace = new ResearchWorkspace(taskId, controller);
    let currentPhase: ResearchPhase = 'planning';
    const boundedProvider: LLMProvider = {
      metadata: provider.metadata,
      async *stream(request, signal) {
        const phaseCounts = report.phases[currentPhase];
        if (report.counts.streamCalls >= MAX_STREAM_CALLS) {
          report.counts.providerBudgetRejects += 1;
          phaseCounts.providerBudgetRejects += 1;
          report.checks.withinProviderBudget = false;
          save();
          throw new Error('研究真实场景 Provider 调用预算已耗尽');
        }
        report.counts.streamCalls += 1;
        phaseCounts.streamCalls += 1;
        let completed = false;
        try {
          for await (const event of provider.stream(request, signal)) {
            if (event.type === 'delta') report.counts.textChars += event.text.length;
            if (event.type === 'reasoning') report.counts.reasoningChars += event.text.length;
            if (event.type === 'toolCalls') {
              report.counts.toolCalls += event.toolCalls.length;
              phaseCounts.toolCalls += event.toolCalls.length;
            }
            if (event.type === 'error') {
              report.counts.providerErrors += 1;
              phaseCounts.providerErrors += 1;
              report.providerErrorCodes[event.error.code] =
                (report.providerErrorCodes[event.error.code] ?? 0) + 1;
            }
            if (event.type === 'done') completed = true;
            yield event;
          }
        } catch (error) {
          report.counts.providerThrows += 1;
          phaseCounts.providerThrows += 1;
          throw error;
        } finally {
          if (completed) {
            report.counts.completedStreams += 1;
            phaseCounts.completedStreams += 1;
          } else {
            report.counts.incompleteStreams += 1;
            phaseCounts.incompleteStreams += 1;
          }
          save();
        }
      },
    };

    const searchProvider = {
      id: 'empty-research-scenario',
      search: async () => {
        report.counts.searchCalls += 1;
        return { ok: true as const, results: [] };
      },
    };
    const runtime = new ResearchRuntime({
      taskId,
      goal,
      runToken: randomUUID(),
      model,
      provider: boundedProvider,
      sourceService,
      searchProvider,
      captureService: new CaptureService({ workspace, browser: controller }),
      persistence: createRepositoryPersistence(researchDb, taskId),
      prompts: RESEARCH_PROMPTS_PORT,
      synthesis: {
        processVerification(raw, context) {
          const outcome = RESEARCH_SYNTHESIS_PORT.processVerification(raw, context);
          // These port reasons were audited: static messages only, with no input echo.
          report.validation.push({
            stage: 'verification',
            streamCalls: report.counts.streamCalls,
            ok: outcome.ok,
            reasons: outcome.ok ? [] : [outcome.reason],
          });
          save();
          return outcome;
        },
        parseResultDraft(raw) {
          const outcome = RESEARCH_SYNTHESIS_PORT.parseResultDraft(raw);
          report.validation.push({
            stage: 'result-parse',
            streamCalls: report.counts.streamCalls,
            ok: outcome.ok,
            reasons: outcome.ok ? [] : [outcome.reason],
          });
          save();
          return outcome;
        },
      },
      resultValidation: {
        validate(draft, context) {
          const outcome = RESEARCH_RESULT_VALIDATION_PORT.validate(draft, context);
          // Validator paths contain program indexes; reasons contain constants, never values.
          report.validation.push({
            stage: 'result-validation',
            streamCalls: report.counts.streamCalls,
            ok: outcome.ok,
            reasons: outcome.ok ? [] : [...outcome.reasons],
          });
          save();
          return outcome;
        },
      },
      onProgress(event) {
        if (event.phase !== null) currentPhase = event.phase;
        const previous = report.transitions.at(-1);
        if (previous?.status !== event.status || previous.phase !== event.phase) {
          report.transitions.push({
            status: event.status,
            phase: event.phase,
            streamCalls: report.counts.streamCalls,
            stepsUsed: event.stats.stepsUsed,
            roundsUsed: event.stats.roundsUsed,
          });
        }
        report.taskStatus = event.status;
        save();
      },
      stopSignal: new AbortController().signal,
      deadlineMs: SCENARIO_DEADLINE_MS,
    });
    await runtime.run();

    const cleanup = await workspace.cleanupAll();
    report.checks.cleanupComplete = cleanup.ok && workspace.getOwnedTabIds().length === 0;
    const afterTabs = await controller.getTabs();
    report.checks.ownershipIsolated =
      report.checks.cleanupComplete && sameTabs(beforeTabs, afterTabs);

    const task = repository.getTaskById(taskId);
    const candidates = repository.listCandidatesByTask(taskId);
    const captures = repository.listCapturesByTask(taskId);
    const evidence = repository.listEvidenceByTask(taskId);
    const claims = repository.listClaimsByTask(taskId);
    const conflicts = repository.listConflictsByTask(taskId);
    const result = repository.getResultByTaskId(taskId);
    const sourceList = await sourceService.list({ page: 0, audience: 'user' });

    report.taskStatus = task?.status ?? 'missing';
    report.taskErrorCode = task?.errorCode ?? null;
    report.counts.sourceRows = sourceList.ok ? sourceList.total : -1;
    report.counts.candidates = candidates.length;
    report.counts.captures = captures.length;
    report.counts.successfulCaptures = captures.filter((capture) => !capture.failed).length;
    report.counts.evidence = evidence.length;
    report.counts.claims = claims.length;
    report.counts.conflicts = conflicts.length;
    report.counts.results = result === null ? 0 : 1;
    report.counts.failedReads = task?.stats.failedReadCount ?? 0;
    report.counts.rejectedEvidence = task?.stats.rejectedEvidenceCount ?? 0;
    report.counts.stepsUsed = task?.stats.stepsUsed ?? 0;
    report.counts.roundsUsed = task?.stats.roundsUsed ?? 0;
    for (const capture of captures) {
      if (capture.failureReason !== null) {
        report.captureFailureCodes[capture.failureReason] =
          (report.captureFailureCodes[capture.failureReason] ?? 0) + 1;
      }
    }

    report.checks.sourceStoreEmpty = report.counts.sourceRows === 0;
    const candidateByUrl = new Map(
      candidates.map((candidate) => [candidate.displayUrl, candidate]),
    );
    report.checks.twoGoalCandidates =
      candidates.length === 2 &&
      urls.every((url) => {
        const candidate = candidateByUrl.get(url);
        return (
          candidate !== undefined &&
          candidate.sourceId === null &&
          candidate.discoveredVia.includes('goal-url')
        );
      });
    report.checks.capturesPerSource =
      report.checks.twoGoalCandidates &&
      urls.every((url) => {
        const candidate = candidateByUrl.get(url);
        return (
          candidate !== undefined &&
          captures.some(
            (capture) => capture.candidateId === candidate.id && capture.failed === false,
          )
        );
      });
    report.checks.evidencePerSource =
      report.checks.twoGoalCandidates &&
      urls.every((url) => {
        const candidate = candidateByUrl.get(url);
        return (
          candidate !== undefined &&
          evidence.some(
            (item) => item.candidateId === candidate.id && item.verification === 'verified',
          )
        );
      });
    const evidenceIds = new Set(evidence.map((item) => item.evidenceId));
    report.checks.claimsLinked =
      claims.length > 0 &&
      claims.every(
        (claim) =>
          claim.evidenceIds.length > 0 && claim.evidenceIds.every((id) => evidenceIds.has(id)),
      );
    report.checks.resultLinked =
      result !== null &&
      result.taskId === taskId &&
      result.resultId === task?.resultId &&
      Object.keys(result.evidenceMap).length === evidence.length &&
      evidence.every(
        (item) => result.evidenceMap[item.evidenceId]?.candidateId === item.candidateId,
      );

    const saved = new DatabaseSync(join(directory, 'research.db'), { readOnly: true });
    try {
      report.checks.transferValid = validateResearchTransfer(saved).ok;
    } finally {
      saved.close();
    }
    report.checks.withinProviderBudget =
      report.checks.withinProviderBudget && report.counts.streamCalls <= MAX_STREAM_CALLS;
    report.passed =
      task?.status === 'completed' && Object.values(report.checks).every((value) => value);
    return report;
  } catch {
    report.setupErrorCode = 'internal-exception';
    return report;
  } finally {
    if (workspace !== null) {
      try {
        const cleanup = await workspace.cleanupAll();
        report.checks.cleanupComplete = cleanup.ok && workspace.getOwnedTabIds().length === 0;
      } catch {
        report.checks.cleanupComplete = false;
      }
    }
    if (sourceService !== null) sourceService.dispose();
    else if (sourceDb !== null) closeDb(sourceDb);
    if (researchDb !== null) closeDb(researchDb);
    save();
  }
}
