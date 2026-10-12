import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BrowserControllerImpl } from '../../src/main/browser/browser-controller';
import { FakeProvider } from '../../src/main/ai/provider/fake-provider';
import { openDb, closeDb } from '../../src/main/sources/db/sqlite-driver';
import { runMigrations } from '../../src/main/sources/db/migrations';
import { SourceServiceImpl } from '../../src/main/sources/source-service';
import { runResearchMigrations } from '../../src/main/research/db/research-migrations';
import { ResearchRepository } from '../../src/main/research/repository/research-repository';
import { validateResearchTransfer } from '../../src/main/research/repository/research-transfer-validation';
import { ResearchWorkspace } from '../../src/main/research/research-workspace';
import { CaptureService } from '../../src/main/research/capture-service';
import { ResearchRuntime } from '../../src/main/research/research-runtime';
import { createRepositoryPersistence } from '../../src/main/research/research-runtime-persistence';
import { ZERO_TASK_STATS } from '../../src/main/research/domain/research-task-state';
import { RESEARCH_PROMPTS_PORT } from '../../src/main/research/synthesis/research-prompts';
import { RESEARCH_SYNTHESIS_PORT } from '../../src/main/research/synthesis/claim-model';
import { RESEARCH_RESULT_VALIDATION_PORT } from '../../src/main/research/result-validator';

const EXCERPT = '固定短正文用于退出与研究捕获验证。';

/** Real browser/capture/validators with a deterministic offline model and empty Sources. */
export async function runResearchCapture(
  controller: BrowserControllerImpl,
  origin: string,
  root: string,
) {
  const address = new URL(origin);
  if (
    address.protocol !== 'http:' ||
    address.hostname !== '127.0.0.1' ||
    address.origin !== origin
  ) {
    throw new Error('研究验收仅接受固定 loopback origin');
  }
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'research-capture-'));
  const sourceDb = openDb(join(directory, 'sources.db'));
  const researchPath = join(directory, 'research.db');
  const researchDb = openDb(researchPath);
  runMigrations(sourceDb);
  runResearchMigrations(researchDb);
  const sources = new SourceServiceImpl({ db: sourceDb });
  const repository = new ResearchRepository(researchDb);
  const taskId = randomUUID();
  const candidateId = randomUUID();
  const evidenceId = randomUUID();
  const captureId = randomUUID();
  const timestamp = new Date().toISOString();
  const goal = `读取 ${origin}/research，核对固定合成事实。`;
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
  const workspace = new ResearchWorkspace(taskId, controller);
  const before = await controller.getTabs();
  const provider = new FakeProvider({
    rounds: [
      [
        {
          text: JSON.stringify({
            sourceMode: 'search',
            sourceQuery: '固定合成研究',
            groupId: null,
            webQueries: [],
          }),
        },
      ],
      [{ text: JSON.stringify({ selectedCandidateIds: [candidateId] }) }],
      [
        {
          text: JSON.stringify([
            {
              captureId,
              candidateId,
              type: 'quote',
              locator: { kind: 'text', excerpt: EXCERPT },
              excerpt: EXCERPT,
              value: null,
            },
          ]),
        },
      ],
      [
        {
          text: JSON.stringify({
            vendorCandidateIds: [],
            claims: [
              { claimKey: 'synthetic', text: EXCERPT, severity: 'low', evidenceIds: [evidenceId] },
            ],
            conflicts: [],
          }),
        },
      ],
      [
        {
          text: JSON.stringify({
            result: {
              title: '目标网址捕获验收',
              summary: '固定合成页面的单一来源验证',
              blocks: [
                {
                  kind: 'table',
                  columns: ['固定事实'],
                  rows: [[EXCERPT]],
                  sourceRefs: [candidateId],
                },
                {
                  kind: 'uncertain',
                  text: '仅有一个合成来源',
                  reason: '本场不验证真实模型或外部网页',
                },
              ],
            },
          }),
        },
      ],
    ],
  });
  const ids = [candidateId, evidenceId];
  let searchCalls = 0;
  const runtime = new ResearchRuntime({
    taskId,
    goal,
    runToken: randomUUID(),
    model: '固定离线验收模型',
    provider,
    sourceService: sources,
    searchProvider: {
      id: 'empty',
      search: async () => {
        searchCalls += 1;
        return { ok: true, results: [] };
      },
    },
    captureService: new CaptureService({
      workspace,
      browser: controller,
      createCaptureId: () => captureId,
    }),
    persistence: createRepositoryPersistence(researchDb, taskId),
    prompts: RESEARCH_PROMPTS_PORT,
    synthesis: RESEARCH_SYNTHESIS_PORT,
    resultValidation: RESEARCH_RESULT_VALIDATION_PORT,
    createId: () => ids.shift() ?? randomUUID(),
    stopSignal: new AbortController().signal,
    deadlineMs: 60_000,
  });
  try {
    await runtime.run();
    const cleanup = await workspace.cleanupAll();
    const after = await controller.getTabs();
    const task = repository.getTaskById(taskId);
    const candidates = repository.listCandidatesByTask(taskId);
    const captures = repository.listCapturesByTask(taskId);
    const evidence = repository.listEvidenceByTask(taskId);
    const claims = repository.listClaimsByTask(taskId);
    const result = repository.getResultByTaskId(taskId);
    const sourceList = await sources.list({ page: 0, audience: 'user' });
    const unownedTabsPreserved =
      before.length === after.length &&
      before.every((tab) =>
        after.some(
          (item) => item.id === tab.id && item.url === tab.url && item.active === tab.active,
        ),
      );
    const saved = new DatabaseSync(researchPath, { readOnly: true });
    let transferValid = false;
    try {
      transferValid = validateResearchTransfer(saved).ok;
    } finally {
      saved.close();
    }
    const sourceCount = sourceList.ok ? sourceList.total : -1;
    const report = {
      passed:
        task?.status === 'completed' &&
        sourceCount === 0 &&
        searchCalls === 0 &&
        candidates.length === 1 &&
        candidates[0]?.discoveredVia.join(',') === 'goal-url' &&
        candidates[0]?.sourceId === null &&
        captures.length === 1 &&
        captures[0]?.failed === false &&
        evidence.length === 1 &&
        evidence[0]?.excerpt === EXCERPT &&
        evidence[0]?.verification === 'verified' &&
        claims.length === 1 &&
        result?.evidenceMap[evidenceId]?.candidateId === candidateId &&
        transferValid &&
        cleanup.ok &&
        unownedTabsPreserved,
      taskStatus: task?.status ?? 'missing',
      errorCode: task?.errorCode ?? null,
      candidates: candidates.length,
      captures: captures.length,
      evidence: evidence.length,
      claims: claims.length,
      sourceCount,
      searchCalls,
      transferValid,
      unownedTabsPreserved,
      cleanup: cleanup.ok,
      provider: '固定离线模型（真实浏览器与全部生产校验）',
    };
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    return report;
  } finally {
    await workspace.cleanupAll();
    sources.dispose();
    closeDb(researchDb);
  }
}
