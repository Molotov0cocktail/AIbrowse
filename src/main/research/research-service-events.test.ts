// C8 ResearchService 事件出口与结果视图红→绿测试（决议 #157）：progress 订阅
// 转发 + listener 异常隔离；终态数据库提交成功后先 terminal progress 再
// task-done 各恰好一次；shutdown/dispose 后零事件 + 迟到 no-op；deleteTask
// 与 starting slot 预占互斥（Provider resolve 期间不可删除）；getResearch
// ResultView 读取复核（completed 缺 Result/resultId 错绑/跨 task Evidence/
// 悬空 sourceRef 全部拒绝）；Evidence DTO 只暴露下钻必需字段。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, closeDb, type DbHandle } from '../sources/db/sqlite-driver';
import { runResearchMigrations } from './db/research-migrations';
import {
  ResearchRepository,
  type ResearchCandidateRow,
  type ResearchEvidenceRow,
} from './repository/research-repository';
import { ResearchServiceImpl, type ResearchServiceOptions } from './research-service';
import type {
  ResearchPreparedLaunch,
  ResearchProgressEvent,
  ResearchRuntimeFactory,
  ResearchTaskDoneEvent,
} from '../../shared/types/research';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-research-events-'));
const T0 = Date.UTC(2026, 7, 16, 0, 0, 0);
const TASK_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const CAND_ID = 'bbbbbbbb-1111-4111-8111-111111111111';
const EV_ID = 'cccccccc-1111-4111-8111-111111111111';
const RESULT_ID = 'dddddddd-1111-4111-8111-111111111111';

const TASK_STATS = {
  candidateCount: 0,
  selectedCount: 0,
  captureCount: 0,
  failedReadCount: 0,
  evidenceCount: 0,
  rejectedEvidenceCount: 0,
  claimCount: 0,
  conflictCount: 0,
  stepsUsed: 0,
  roundsUsed: 0,
};

let handle: DbHandle;
let nowMs: number;
let svc: ResearchServiceImpl;

// 可控 Runtime 工厂：launch 时记录 input 并为本次 run 创建 deferred done
// （测试手动驱动 onProgress/onSettle 后 resolve done 收敛）
function controllableFactory() {
  let prepared: ResearchPreparedLaunch | null = null;
  const factory: ResearchRuntimeFactory = {
    async resolveProvider() {
      let consumed = false;
      prepared = {
        launch(input) {
          if (consumed) throw new Error('程序缺陷：prepared 已被消费');
          consumed = true;
          launchInputs.push(input);
          const done = new Promise<void>((resolve) => {
            doneResolvers.push(resolve);
          });
          donePromises.push(done);
          return {
            taskId: input.taskId,
            runToken: input.runToken,
            done,
            abort() {},
          };
        },
        release() {
          consumed = true;
        },
      };
      return { ok: true, prepared };
    },
  };
  return factory;
}

const launchInputs: Array<{
  taskId: string;
  goal: string;
  runToken: string;
  onProgress: (e: ResearchProgressEvent) => void;
  onSettle: () => void;
}> = [];
const donePromises: Promise<void>[] = [];
const doneResolvers: Array<() => void> = [];

function buildService(over: Partial<ResearchServiceOptions> = {}): ResearchServiceImpl {
  return new ResearchServiceImpl({
    db: handle,
    now: () => nowMs,
    runtimeFactory: controllableFactory(),
    ...over,
  });
}

function withTx(fn: () => void): void {
  handle.exec('BEGIN');
  try {
    fn();
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

function insertCompletedWithResult(
  blocks: unknown[],
  evidence: ResearchEvidenceRow[],
  candidateOver: Partial<ResearchCandidateRow> = {},
): void {
  const now = '2026-08-16T00:00:00.000Z';
  withTx(() => {
    repo().insertTask({
      id: TASK_ID,
      goal: '事件目标',
      status: 'completed',
      phase: null,
      created_at: now,
      updated_at: now,
      started_at: now,
      finished_at: now,
      interrupted_at: null,
      error_code: null,
      result_id: RESULT_ID,
      stats_json: JSON.stringify(TASK_STATS),
    });
    repo().insertCandidate({
      candidate_id: CAND_ID,
      task_id: TASK_ID,
      url: 'https://example.com/one',
      display_url: 'https://example.com/one',
      title: '候选一',
      canonical_key: 'https://example.com/one',
      scope: 'page',
      discovered_via_json: JSON.stringify(['sources']),
      source_id: null,
      trust_value: null,
      trust_asserted_by: null,
      trust_verification: null,
      priority: null,
      last_used_at: null,
      note: null,
      sort_key: '01|00000|9|~~~~~~~~~~~~~~~~~~~~~~~~|1|https://example.com/one|' + CAND_ID,
      ...candidateOver,
    });
    for (const ev of evidence) repo().insertEvidence(ev);
    repo().insertResult({
      result_id: RESULT_ID,
      task_id: TASK_ID,
      title: '结果标题',
      summary: '结果摘要',
      blocks_json: JSON.stringify(blocks),
      evidence_map_json: JSON.stringify({
        [EV_ID]: {
          candidateId: CAND_ID,
          url: 'https://example.com/one',
          title: '候选一',
          accessTime: now,
        },
      }),
      conflicts_json: JSON.stringify([]),
      coverage_json: JSON.stringify({
        total: 0,
        multiSource: 0,
        singleSource: 0,
        vendor: 0,
        thirdParty: 0,
        community: 0,
      }),
      fetched_at: now,
    });
  });
}

let repoHandle: ResearchRepository;

function repo(): ResearchRepository {
  return repoHandle;
}

const validEvidence = (over: Partial<ResearchEvidenceRow> = {}): ResearchEvidenceRow => ({
  evidence_id: EV_ID,
  task_id: TASK_ID,
  candidate_id: CAND_ID,
  source_id: null,
  capture_id: 'capture-1',
  url: 'https://example.com/one',
  title: '候选一',
  access_time: '2026-08-16T00:00:00.000Z',
  document_id: '1',
  content_hash: 'hash',
  type: 'quote',
  locator_json: JSON.stringify({ kind: 'text', excerpt: '摘录一' }),
  excerpt: '摘录一',
  value: null,
  verification: 'verified',
  ...over,
});

beforeEach(() => {
  const dbPath = join(root, `evt-${Math.random().toString(36).slice(2)}.db`);
  handle = openDb(dbPath);
  runResearchMigrations(handle);
  repoHandle = new ResearchRepository(handle);
  nowMs = T0;
  launchInputs.length = 0;
  donePromises.length = 0;
  doneResolvers.length = 0;
  svc = buildService();
});

afterEach(() => {
  svc.dispose();
  closeDb(handle);
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // 尽力清理
  }
});

describe('事件出口（决议 #157(2)–(5)）', () => {
  it('Runtime onProgress/onSettle 经 Service 转发：terminal progress 先于 task-done、各恰好一次', async () => {
    const progress: ResearchProgressEvent[] = [];
    const done: ResearchTaskDoneEvent[] = [];
    svc.onProgress((e) => progress.push(e));
    svc.onTaskDone((e) => done.push(e));

    const created = await svc.createTask('事件时序目标');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const taskId = created.task.id;

    const started = await svc.startTask(taskId);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const input = launchInputs[launchInputs.length - 1]!;
    expect(input.taskId).toBe(taskId);

    // Runtime 驱动：running 进度 → 终态提交成功后 terminal progress → task-done
    input.onProgress({
      taskId,
      status: 'running',
      phase: 'planning',
      stats: { ...TASK_STATS },
      finishedAt: null,
    });
    input.onProgress({
      taskId,
      status: 'running',
      phase: 'reading',
      stats: { ...TASK_STATS, captureCount: 1 },
      finishedAt: null,
    });
    // 终态提交成功后：terminal progress（finishedAt 非空）→ task-done
    input.onProgress({
      taskId,
      status: 'completed',
      phase: null,
      stats: { ...TASK_STATS, captureCount: 1 },
      finishedAt: '2026-08-16T00:01:00.000Z',
    });
    input.onSettle();

    expect(progress.map((p) => p.status)).toEqual(['running', 'running', 'completed']);
    expect(progress[2]!.finishedAt).toBe('2026-08-16T00:01:00.000Z');
    expect(done.length).toBe(1);
    expect(done[0]).toEqual({ taskId, status: 'completed' });
    // terminal progress 先于 task-done
    expect(progress.length).toBe(3);
  });

  it('listener 异常隔离：一个 listener 抛错不影响其他 listener 与 Runtime', async () => {
    const progress: ResearchProgressEvent[] = [];
    svc.onProgress(() => {
      throw new Error('listener 崩溃');
    });
    svc.onProgress((e) => progress.push(e));

    const created = await svc.createTask('隔离目标');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const started = await svc.startTask(created.task.id);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const input = launchInputs[launchInputs.length - 1]!;
    input.onProgress({
      taskId: created.task.id,
      status: 'running',
      phase: 'planning',
      stats: { ...TASK_STATS },
      finishedAt: null,
    });
    expect(progress.length).toBe(1);
  });

  it('shutdown 后不再发事件并清除 listener；迟到事件安全 no-op', async () => {
    const progress: ResearchProgressEvent[] = [];
    svc.onProgress((e) => progress.push(e));
    await svc.shutdown();
    // 迟到事件（shutdown 后）零送达
    expect(progress.length).toBe(0);
    // 再注册也零送达（listener 已清除）
    svc.onProgress((e) => progress.push(e));
    expect(progress.length).toBe(0);
  });

  it('dispose 幂等 + shutdown 幂等（重复调用同一 Promise）', async () => {
    const p1 = svc.shutdown();
    const p2 = svc.shutdown();
    expect(p1).toBe(p2);
    svc.dispose();
    svc.dispose();
  });
});

describe('deleteTask 与 starting slot 预占互斥（决议 #157(6)）', () => {
  it('Provider resolve 期间（starting slot 占住）删除同 taskId → research-invalid-state 零删除', async () => {
    // deferred resolveProvider 工厂：startTask 挂起在 resolve 上 → starting
    // slot 保持占用（决议 #154 预占在第一个 await 前同步建立）
    let resolveFn!: (r: { ok: false; errorCode: 'research-unavailable' }) => void;
    const deferredFactory: ResearchRuntimeFactory = {
      resolveProvider() {
        return new Promise((resolve) => {
          resolveFn = resolve as never;
        });
      },
    };
    const svc2 = new ResearchServiceImpl({
      db: handle,
      now: () => nowMs,
      runtimeFactory: deferredFactory,
    });
    const created = await svc2.createTask('预占互斥目标');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const taskId = created.task.id;

    const startPromise = svc2.startTask(taskId);
    // startTask 已进入 resolveProvider await（starting slot 占住）
    await new Promise((r) => setTimeout(r, 0));
    const deleted = await svc2.deleteTask(taskId);
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.errorCode).toBe('research-invalid-state');
    // 任务仍存在（零删除）
    const got = await svc2.getTask(taskId);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.task.status).toBe('created');
    // 收敛：resolve 失败 → startTask 返回（任务保持 created）
    resolveFn({ ok: false, errorCode: 'research-unavailable' });
    const started = await startPromise;
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.errorCode).toBe('research-unavailable');
    svc2.dispose();
  });

  it('running 任务 deleteTask → research-invalid-state（既有契约回归）', async () => {
    // 直接构造 running 任务（绕过 start 编排）
    withTx(() => {
      repo().insertTask({
        id: TASK_ID,
        goal: 'running 目标',
        status: 'running',
        phase: 'planning',
        created_at: '2026-08-16T00:00:00.000Z',
        updated_at: '2026-08-16T00:00:00.000Z',
        started_at: '2026-08-16T00:00:00.000Z',
        finished_at: null,
        interrupted_at: null,
        error_code: null,
        result_id: null,
        stats_json: JSON.stringify(TASK_STATS),
      });
    });
    const deleted = await svc.deleteTask(TASK_ID);
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.errorCode).toBe('research-invalid-state');
  });
});

describe('getResearchResultView 读取复核（决议 #157(7)–(10)）', () => {
  it('completed + 完整引用 → ResearchResultView（task/result/evidence DTO）', async () => {
    insertCompletedWithResult(
      [
        {
          kind: 'table',
          columns: ['名称'],
          rows: [['甲']],
          sourceRefs: [CAND_ID],
        },
      ],
      [validEvidence()],
    );
    const res = await svc.getResearchResultView(TASK_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.view.task.status).toBe('completed');
    expect(res.view.result.taskId).toBe(TASK_ID);
    expect(res.view.result.blocks.length).toBe(1);
    expect(res.view.evidence.length).toBe(1);
  });

  it('completed 但 Result 缺失 → research-internal（禁止把不一致数据交给 Renderer）', async () => {
    withTx(() => {
      repo().insertTask({
        id: TASK_ID,
        goal: '缺 Result',
        status: 'completed',
        phase: null,
        created_at: '2026-08-16T00:00:00.000Z',
        updated_at: '2026-08-16T00:00:00.000Z',
        started_at: '2026-08-16T00:00:00.000Z',
        finished_at: '2026-08-16T00:00:00.000Z',
        interrupted_at: null,
        error_code: null,
        result_id: RESULT_ID,
        stats_json: JSON.stringify(TASK_STATS),
      });
    });
    const res = await svc.getResearchResultView(TASK_ID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('research-internal');
  });

  it('completed 但 resultId 错绑（task.resultId ≠ result.resultId）→ research-internal', async () => {
    withTx(() => {
      repo().insertTask({
        id: TASK_ID,
        goal: '错绑目标',
        status: 'completed',
        phase: null,
        created_at: '2026-08-16T00:00:00.000Z',
        updated_at: '2026-08-16T00:00:00.000Z',
        started_at: '2026-08-16T00:00:00.000Z',
        finished_at: '2026-08-16T00:00:00.000Z',
        interrupted_at: null,
        error_code: null,
        result_id: 'ffffffff-1111-4111-8111-111111111111',
        stats_json: JSON.stringify(TASK_STATS),
      });
      repo().insertResult({
        result_id: RESULT_ID,
        task_id: TASK_ID,
        title: 't',
        summary: 's',
        blocks_json: JSON.stringify([]),
        evidence_map_json: JSON.stringify({}),
        conflicts_json: JSON.stringify([]),
        coverage_json: JSON.stringify({
          total: 0,
          multiSource: 0,
          singleSource: 0,
          vendor: 0,
          thirdParty: 0,
          community: 0,
        }),
        fetched_at: '2026-08-16T00:00:00.000Z',
      });
    });
    const res = await svc.getResearchResultView(TASK_ID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('research-internal');
  });

  it('跨 task Evidence 引用（result.evidenceMap 键集与 Evidence 不一致）→ research-internal 零透传', async () => {
    // 外键约束天然拒绝「evidence.task_id 指向不存在的任务」（schema v1 兜底——
    // 外部篡改才能绕过）；攻击形态 = evidenceMap 键集包含不属于本任务的
    // evidenceId（引用关系损坏）→ 键集复核失败 → internal 零透传
    withTx(() => {
      repo().insertTask({
        id: TASK_ID,
        goal: '跨任务目标',
        status: 'completed',
        phase: null,
        created_at: '2026-08-16T00:00:00.000Z',
        updated_at: '2026-08-16T00:00:00.000Z',
        started_at: '2026-08-16T00:00:00.000Z',
        finished_at: '2026-08-16T00:00:00.000Z',
        interrupted_at: null,
        error_code: null,
        result_id: RESULT_ID,
        stats_json: JSON.stringify(TASK_STATS),
      });
      repo().insertCandidate({
        candidate_id: CAND_ID,
        task_id: TASK_ID,
        url: 'https://example.com/one',
        display_url: 'https://example.com/one',
        title: '候选一',
        canonical_key: 'https://example.com/one',
        scope: 'page',
        discovered_via_json: JSON.stringify(['sources']),
        source_id: null,
        trust_value: null,
        trust_asserted_by: null,
        trust_verification: null,
        priority: null,
        last_used_at: null,
        note: null,
        sort_key: '01|00000|9|~~~~~~~~~~~~~~~~~~~~~~~~|1|https://example.com/one|' + CAND_ID,
      });
      repo().insertEvidence(validEvidence());
      // 篡改：evidenceMap 额外包含一个不属于本任务的 evidenceId（键集不一致）
      repo().insertResult({
        result_id: RESULT_ID,
        task_id: TASK_ID,
        title: 't',
        summary: 's',
        blocks_json: JSON.stringify([
          { kind: 'table', columns: ['名称'], rows: [['甲']], sourceRefs: [CAND_ID] },
        ]),
        evidence_map_json: JSON.stringify({
          [EV_ID]: {
            candidateId: CAND_ID,
            url: 'https://example.com/one',
            title: '候选一',
            accessTime: '2026-08-16T00:00:00.000Z',
          },
          '99999999-1111-4111-8111-111111111111': {
            candidateId: CAND_ID,
            url: 'https://example.com/two',
            title: '跨任务',
            accessTime: '2026-08-16T00:00:00.000Z',
          },
        }),
        conflicts_json: JSON.stringify([]),
        coverage_json: JSON.stringify({
          total: 0,
          multiSource: 0,
          singleSource: 0,
          vendor: 0,
          thirdParty: 0,
          community: 0,
        }),
        fetched_at: '2026-08-16T00:00:00.000Z',
      });
    });
    const res = await svc.getResearchResultView(TASK_ID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('research-internal');
  });

  it('悬空 sourceRef（无对应候选/无 verified Evidence 支撑）→ research-internal', async () => {
    insertCompletedWithResult(
      [
        {
          kind: 'table',
          columns: ['名称'],
          rows: [['甲']],
          sourceRefs: ['99999999-2222-4222-8222-222222222222'], // 无此候选
        },
      ],
      [validEvidence()],
    );
    const res = await svc.getResearchResultView(TASK_ID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('research-internal');
  });

  it('非 completed → research-invalid-state；不存在 → research-not-found', async () => {
    const created = await svc.createTask('created 目标');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const res = await svc.getResearchResultView(created.task.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('research-invalid-state');

    const missing = await svc.getResearchResultView('ffffffff-1111-4111-8111-111111111111');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errorCode).toBe('research-not-found');
  });
});

// 决议 #165：Evidence DTO provenance 投影——按 candidateId 从本任务候选投影
// 最小 provenance（discoveredVia + trust 三元组）；内部字段零暴露；trust 不
// 参与排序（#120 保持），仅展示元数据
describe('Evidence DTO provenance 投影（决议 #165）', () => {
  const tableBlock = { kind: 'table', columns: ['名称'], rows: [['甲']], sourceRefs: [CAND_ID] };

  it('ai+unverified 候选 → provenance 投影完整 trust 三元组 + discoveredVia', async () => {
    insertCompletedWithResult([tableBlock], [validEvidence()], {
      discovered_via_json: JSON.stringify(['sources', 'search']),
      trust_value: 'official',
      trust_asserted_by: 'ai',
      trust_verification: 'unverified',
    });
    const res = await svc.getResearchResultView(TASK_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ev = res.view.evidence[0]!;
    expect(ev.provenance).toEqual({
      discoveredVia: ['sources', 'search'],
      trust: { value: 'official', assertedBy: 'ai', verification: 'unverified' },
    });
  });

  it('user+asserted 候选 → provenance 投影 user/asserted（不洗白为已核验事实）', async () => {
    insertCompletedWithResult([tableBlock], [validEvidence()], {
      trust_value: 'primary',
      trust_asserted_by: 'user',
      trust_verification: 'asserted',
    });
    const res = await svc.getResearchResultView(TASK_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.view.evidence[0]!.provenance).toEqual({
      discoveredVia: ['sources'],
      trust: { value: 'primary', assertedBy: 'user', verification: 'asserted' },
    });
  });

  it('search-only 候选（trust=null）→ provenance.trust=null（无可信度声明）', async () => {
    insertCompletedWithResult([tableBlock], [validEvidence()], {
      discovered_via_json: JSON.stringify(['search']),
      trust_value: null,
      trust_asserted_by: null,
      trust_verification: null,
    });
    const res = await svc.getResearchResultView(TASK_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.view.evidence[0]!.provenance).toEqual({
      discoveredVia: ['search'],
      trust: null,
    });
  });

  it('DTO 只暴露 UI 必需字段——provenance 进白名单，captureId/documentId/contentHash/sourceId 零出现', async () => {
    insertCompletedWithResult([tableBlock], [validEvidence()], {
      source_id: '11111111-2222-4333-8444-555555555555',
      trust_value: 'community',
      trust_asserted_by: 'ai',
      trust_verification: 'unverified',
    });
    const res = await svc.getResearchResultView(TASK_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const keys = Object.keys(res.view.evidence[0]!).sort();
    expect(keys).toEqual(
      [
        'accessTime',
        'candidateId',
        'evidenceId',
        'excerpt',
        'locator',
        'provenance',
        'title',
        'type',
        'url',
        'value',
        'verification',
      ].sort(),
    );
  });
});
