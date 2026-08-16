// C5 research-runtime-persistence tests (adjudication #137): the narrow
// Runtime persistence port — Runtime never executes SQL; every logical write
// is one transaction (re-verify still running → write rows → sync
// stats/phase/updatedAt → 500k projection checks → whole-rollback on any
// failure); the terminal-reserve invariant (non-terminal writes may never
// consume the budget such that a failed/cancelled terminal row cannot be
// written — task may never be stuck running); Result+completed same
// transaction; failed/cancelled terminal atomicity; stats semantics.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type DbHandle } from '../sources/db/sqlite-driver';
import { runResearchMigrations } from './db/research-migrations';
import {
  RepositoryError,
  ResearchRepository,
  rowToCandidate,
  type ResearchCandidateRow,
} from './repository/research-repository';
import { createRepositoryPersistence, StaleRunError } from './research-runtime-persistence';
import { computeUtf8Bytes } from './domain/research-budget';
import type {
  Claim,
  Conflict,
  ResearchTaskStats,
  SourceCandidate,
  VerifiedEvidence,
} from '../../shared/types/research';
import {
  MAX_EVIDENCE_PER_TASK,
  MAX_TASK_PERSISTED_CHARS,
  MAX_CAPTURES_PER_TASK,
} from '../../shared/types/research';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-research-rp-'));
const T0 = '2026-08-16T00:00:00.000Z';
const T1 = '2026-08-16T00:01:00.000Z';

let handle: DbHandle;
let repo: ResearchRepository;
let taskId: string;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeStats(over: Partial<ResearchTaskStats> = {}): ResearchTaskStats {
  return {
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
    ...over,
  };
}

function seedRunningTask(goal = '比较主流模型能力'): string {
  const id = '11111111-1111-4111-8111-111111111111';
  repo.insertTask({
    id,
    goal,
    status: 'running',
    phase: 'planning',
    created_at: T0,
    updated_at: T0,
    started_at: T0,
    finished_at: null,
    interrupted_at: null,
    error_code: null,
    result_id: null,
    stats_json: JSON.stringify(makeStats()),
  });
  return id;
}

function makeCandidate(candidateId: string): SourceCandidate {
  return {
    id: candidateId,
    url: `https://c.example/${candidateId}`,
    displayUrl: `https://c.example/${candidateId}`,
    title: '候选',
    canonicalKey: `https://c.example/${candidateId}`,
    scope: 'page',
    discoveredVia: ['search'],
    sourceId: null,
    trust: null,
    priority: null,
    lastUsedAt: null,
    note: null,
    sortKey: `03|00000|9|~~~~~~~~~~~~~~~~~~~~~~~~|1|https://c.example/${candidateId}|${candidateId}`,
  };
}

function makeCandidateRow(candidateId: string, _taskIdLocal: string): ResearchCandidateRow {
  return {
    candidate_id: candidateId,
    task_id: _taskIdLocal,
    url: `https://c.example/${candidateId}`,
    display_url: `https://c.example/${candidateId}`,
    title: '候选',
    canonical_key: `https://c.example/${candidateId}`,
    scope: 'page',
    discovered_via_json: JSON.stringify(['search']),
    source_id: null,
    trust_value: null,
    trust_asserted_by: null,
    trust_verification: null,
    priority: null,
    last_used_at: null,
    note: null,
    sort_key: '03|00000|9|~~~~~~~~~~~~~~~~~~~~~~~~|1|https://c.example/',
  };
}

beforeEach(() => {
  handle = openDb(join(root, `rp-${Math.random().toString(36).slice(2)}.db`));
  runResearchMigrations(handle);
  repo = new ResearchRepository(handle);
  taskId = seedRunningTask();
});

afterEach(() => {
  closeDb(handle);
});

describe('commitPhaseHeartbeat：事务内复验 running + phase/updatedAt 原子', () => {
  it('正常心跳：phase 与 updatedAt 同事务更新，stats 同步', () => {
    const p = createRepositoryPersistence(handle, taskId);
    p.commitPhaseHeartbeat('reading', makeStats({ roundsUsed: 1 }));
    const task = p.getTask();
    expect(task).not.toBeNull();
    expect(task!.phase).toBe('reading');
    expect(task!.updatedAt).not.toBe(T0);
    expect(task!.stats.roundsUsed).toBe(1);
  });

  it('任务已终态（非 running）→ StaleRunError 且零写入', () => {
    repo.setTaskCancelled(taskId, { finishedAt: T1, updatedAt: T1, stats: makeStats() });
    const p = createRepositoryPersistence(handle, taskId);
    expect(() => p.commitPhaseHeartbeat('reading', makeStats())).toThrow(StaleRunError);
    expect(repo.getTaskById(taskId)!.phase).toBeNull();
  });

  it('任务不存在 → StaleRunError', () => {
    const p = createRepositoryPersistence(handle, '99999999-9999-4999-8999-999999999999');
    expect(() => p.commitPhaseHeartbeat('reading', makeStats())).toThrow(StaleRunError);
  });
});

describe('commitCandidates/commitSelection：候选持久化 + stats 原子', () => {
  it('候选写入 + stats.candidateCount/selectedCount 同事务（读回恒等）', () => {
    const p = createRepositoryPersistence(handle, taskId);
    p.commitCandidates(
      [makeCandidate('22222222-2222-4222-8222-222222222222')],
      makeStats({ candidateCount: 1, selectedCount: 1, stepsUsed: 2 }),
    );
    const task = repo.getTaskById(taskId)!;
    expect(task.stats.candidateCount).toBe(1);
    expect(task.stats.selectedCount).toBe(1);
    expect(task.stats.stepsUsed).toBe(2);
    expect(repo.listCandidatesByTask(taskId).length).toBe(1);
  });

  it('候选形状非法 → 整体回滚零残留（stats 零变化）', () => {
    const p = createRepositoryPersistence(handle, taskId);
    const bad = {
      ...makeCandidate('22222222-2222-4222-8222-222222222222'),
      discoveredVia: ['evil' as never],
    };
    expect(() => p.commitCandidates([bad], makeStats({ candidateCount: 1 }))).toThrow();
    expect(repo.listCandidatesByTask(taskId).length).toBe(0);
    expect(repo.getTaskById(taskId)!.stats.candidateCount).toBe(0);
  });
});

describe('commitCaptures：attempts 与 stats 精确对应（决议 #137(3)）', () => {
  it('captureCount=attempts 数（含失败）；failedReadCount=失败 attempts 数', () => {
    const p = createRepositoryPersistence(handle, taskId);
    p.commitCaptures(
      [
        {
          captureId: '33333333-3333-4333-8333-333333333333',
          taskId,
          candidateId: '22222222-2222-4222-8222-222222222222',
          tabId: 'tab-1',
          url: 'https://c.example/page',
          title: '页面',
          accessTime: T0,
          documentId: '1',
          contentHash: 'a'.repeat(32),
          summary: { sectionCount: 1, tableCount: 0, headingCount: 1, charCount: 10 },
          failed: false,
          failureReason: null,
        },
        {
          captureId: '44444444-4444-4444-8444-444444444444',
          taskId,
          candidateId: '22222222-2222-4222-8222-222222222222',
          tabId: 'unallocated',
          url: 'https://c.example/page',
          title: '页面',
          accessTime: T0,
          documentId: 'unavailable',
          contentHash: 'a'.repeat(32),
          summary: { sectionCount: 0, tableCount: 0, headingCount: 0, charCount: 0 },
          failed: true,
          failureReason: 'timeout',
        },
      ],
      makeStats({ captureCount: 2, failedReadCount: 1, stepsUsed: 1 }),
    );
    const task = repo.getTaskById(taskId)!;
    expect(task.stats.captureCount).toBe(2);
    expect(task.stats.failedReadCount).toBe(1);
    expect(repo.listCapturesByTask(taskId).length).toBe(2);
  });

  it('Capture 行形状非法 → 整体回滚零残留', () => {
    const p = createRepositoryPersistence(handle, taskId);
    const bad = {
      captureId: '33333333-3333-4333-8333-333333333333',
      taskId,
      candidateId: '22222222-2222-4222-8222-222222222222',
      tabId: 'tab-1',
      url: 'https://c.example/page',
      title: '页面',
      accessTime: T0,
      documentId: '1',
      contentHash: 'a'.repeat(32),
      summary: { sectionCount: -1, tableCount: 0, headingCount: 1, charCount: 10 }, // 负数 → 形状非法
      failed: false,
      failureReason: null,
    };
    expect(() => p.commitCaptures([bad], makeStats({ captureCount: 1 }))).toThrow();
    expect(repo.listCapturesByTask(taskId).length).toBe(0);
  });

  it('上限常量断言：Capture ≤16、Evidence ≤60（决议 #137(4)）', () => {
    expect(MAX_CAPTURES_PER_TASK).toBe(16);
    expect(MAX_EVIDENCE_PER_TASK).toBe(60);
  });
});

describe('commitEvidence：verified 窄类型 + stats 原子（决议 #137(3)(4)）', () => {
  function makeEvidence(evidenceId: string): VerifiedEvidence {
    return {
      evidenceId,
      taskId,
      captureId: '33333333-3333-4333-8333-333333333333',
      candidateId: '22222222-2222-4222-8222-222222222222',
      sourceId: null,
      url: 'https://c.example/page',
      title: '页面',
      accessTime: T0,
      documentId: '1',
      contentHash: 'a'.repeat(32),
      type: 'quote',
      locator: { kind: 'text', excerpt: '摘录' },
      excerpt: '摘录',
      value: null,
      verification: 'verified',
    };
  }

  it('evidence 写入 + stats.evidenceCount/rejectedEvidenceCount 同事务', () => {
    const p = createRepositoryPersistence(handle, taskId);
    p.commitEvidence(
      [makeEvidence('55555555-5555-4555-8555-555555555555')],
      makeStats({ evidenceCount: 1, rejectedEvidenceCount: 2 }),
    );
    const task = repo.getTaskById(taskId)!;
    expect(task.stats.evidenceCount).toBe(1);
    expect(task.stats.rejectedEvidenceCount).toBe(2);
    expect(repo.listEvidenceByTask(taskId).length).toBe(1);
  });

  it('rejected 证据永不落库：写 API 仅 verified 窄类型 + schema CHECK 兜底（决议 #102）', () => {
    // 类型系统拒绝 rejected（VerifiedEvidence 窄类型）；数据库层 CHECK 兜底：
    // 绕过 API 直接插入 verification='rejected' → CHECK 约束失败
    expect(() =>
      handle
        .prepare(
          "INSERT INTO research_evidence (evidence_id, task_id, candidate_id, source_id, capture_id, url, title, access_time, document_id, content_hash, type, locator_json, excerpt, value, verification) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'quote', ?, ?, NULL, 'rejected')",
        )
        .run(
          '99999999-9999-4999-8999-999999999999',
          taskId,
          '22222222-2222-4222-8222-222222222222',
          '33333333-3333-4333-8333-333333333333',
          'https://c.example/page',
          '页面',
          T0,
          '1',
          'a'.repeat(32),
          JSON.stringify({ kind: 'text', excerpt: '摘录' }),
          '摘录',
        ),
    ).toThrow();
    expect(repo.listEvidenceByTask(taskId).length).toBe(0);
  });
});

describe('commitClaimsAndConflicts/commitResultAndComplete：终态原子性（决议 #137(5)）', () => {
  it('Result 插入 + completed 同事务（resultId 关联任务行）', () => {
    const p = createRepositoryPersistence(handle, taskId);
    const result = {
      resultId: '66666666-6666-4666-8666-666666666666',
      taskId,
      title: '结果',
      summary: '摘要',
      blocks: [{ kind: 'markdown' as const, text: '正文' }],
      evidenceMap: {},
      conflicts: [],
      coverage: {
        total: 0,
        multiSource: 0,
        singleSource: 0,
        vendor: 0,
        thirdParty: 0,
        community: 0,
      },
      fetchedAt: T1,
    };
    p.commitResultAndComplete(result, makeStats({ roundsUsed: 5 }));
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('completed');
    expect(task.resultId).toBe('66666666-6666-4666-8666-666666666666');
    expect(task.phase).toBeNull();
    expect(task.finishedAt).not.toBeNull();
    expect(repo.getResultByTaskId(taskId)).not.toBeNull();
    // 终态后再写 → StaleRunError
    expect(() => p.commitPhaseHeartbeat('planning', makeStats())).toThrow(StaleRunError);
  });

  it('Result 形状非法 → 整体回滚：任务保持 running、零 result 行', () => {
    const p = createRepositoryPersistence(handle, taskId);
    const badResult = {
      resultId: '66666666-6666-4666-8666-666666666666',
      taskId,
      title: '结果',
      summary: '摘要',
      blocks: 'not-an-array' as unknown,
      evidenceMap: {},
      conflicts: [],
      coverage: {
        total: 0,
        multiSource: 0,
        singleSource: 0,
        vendor: 0,
        thirdParty: 0,
        community: 0,
      },
      fetchedAt: T1,
    };
    expect(() => p.commitResultAndComplete(badResult as never, makeStats())).toThrow();
    expect(repo.getTaskById(taskId)!.status).toBe('running');
    expect(repo.getResultByTaskId(taskId)).toBeNull();
  });

  it('commitFailed：errorCode + stats + finishedAt 同事务；任务转 failed', () => {
    const p = createRepositoryPersistence(handle, taskId);
    p.commitFailed('research-timeout', makeStats({ roundsUsed: 2 }));
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('failed');
    expect(task.errorCode).toBe('research-timeout');
    expect(task.finishedAt).not.toBeNull();
  });

  it('commitCancelled：cancelled 终态同事务', () => {
    const p = createRepositoryPersistence(handle, taskId);
    p.commitCancelled(makeStats());
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('cancelled');
    expect(task.finishedAt).not.toBeNull();
  });

  it('claims/conflicts 写入 + stats.claimCount/conflictCount 原子', () => {
    const p = createRepositoryPersistence(handle, taskId);
    const claim: Claim = {
      claimId: '77777777-7777-4777-8777-777777777777',
      taskId,
      text: '结论',
      severity: 'medium',
      coverage: 'single-source',
      sourceTypes: ['third-party'],
      evidenceIds: [],
      singleSourceFields: [],
      conflictIds: [],
    };
    const conflict: Conflict = {
      conflictId: '88888888-8888-4888-8888-888888888888',
      taskId,
      topic: '主题',
      positions: [
        { positionText: 'A', sourceRefs: [] },
        { positionText: 'B', sourceRefs: [] },
      ],
      claimIds: [],
      resolved: 'unresolved',
    };
    p.commitClaimsAndConflicts([claim], [conflict], makeStats({ claimCount: 1, conflictCount: 1 }));
    const task = repo.getTaskById(taskId)!;
    expect(task.stats.claimCount).toBe(1);
    expect(task.stats.conflictCount).toBe(1);
    expect(repo.listClaimsByTask(taskId).length).toBe(1);
    expect(repo.listConflictsByTask(taskId).length).toBe(1);
  });

  it('claims/conflicts 形状非法 → 整体回滚（claims/conflicts/stats 零变化）', () => {
    const p = createRepositoryPersistence(handle, taskId);
    const badClaim: Claim = {
      claimId: '77777777-7777-4777-8777-777777777777',
      taskId,
      text: 42 as unknown as string, // 非字符串 → 形状校验必拒
      severity: 'medium',
      coverage: 'single-source',
      sourceTypes: ['third-party'],
      evidenceIds: 'not-an-array' as never, // 非数组 → rowToClaim 形状校验必拒
      singleSourceFields: [],
      conflictIds: [],
    };
    expect(() =>
      p.commitClaimsAndConflicts([badClaim], [], makeStats({ claimCount: 1 })),
    ).toThrow();
    expect(repo.listClaimsByTask(taskId).length).toBe(0);
    expect(repo.getTaskById(taskId)!.stats.claimCount).toBe(0);
  });
});

// 终态预留（决议 #137(2)）：非终态写不能吃满 500k 导致 failed/cancelled 写不下
describe('终态预留：500k 边界（决议 #137(2)）', () => {
  it('estimateWorstTerminalTaskRowBytes 为确定性上界（≥ 任意实际终态行字节）', () => {
    const worst = repo.estimateWorstTerminalTaskRowBytes(taskId);
    expect(worst).toBeGreaterThan(0);
    const p = createRepositoryPersistence(handle, taskId);
    p.commitFailed('research-provider-unavailable', makeStats({ stepsUsed: 64, roundsUsed: 24 }));
    const actual = computeUtf8Bytes(JSON.stringify(repo.getTaskById(taskId)));
    expect(actual).toBeLessThanOrEqual(worst);
    // 确定性
    expect(repo.estimateWorstTerminalTaskRowBytes(taskId)).toBe(worst);
  });

  it('构造接近 500k 的任务：非终态子行插入被终态预留拒绝 → failed 终态仍可落库', () => {
    const id = '12121212-1212-4121-8121-121212121212';
    repo.insertTask({
      id,
      goal: '研'.repeat(2000),
      status: 'running',
      phase: 'reading',
      created_at: T0,
      updated_at: T0,
      started_at: T0,
      finished_at: null,
      interrupted_at: null,
      error_code: null,
      result_id: null,
      stats_json: JSON.stringify(makeStats()),
    });
    const p = createRepositoryPersistence(handle, id);
    const current = repo.computeTaskPersistedBytes(id);
    const worst = repo.estimateWorstTerminalTaskRowBytes(id);
    const room = MAX_TASK_PERSISTED_CHARS - current - worst;
    const big = 'x'.repeat(Math.max(room + 500, 0));
    const cand = makeCandidate('23232323-2323-4232-8232-232323232323');
    const bigCand: SourceCandidate = {
      ...cand,
      url: `https://c.example/${big}`,
      displayUrl: `https://c.example/${big}`,
      title: big,
      canonicalKey: `https://c.example/${big}`,
      sortKey: `03|00000|9|~~~~~~~~~~~~~~~~~~~~~~~~|1|https://c.example/${big}|23232323-2323-4232-8232-232323232323`,
    };
    expect(() => p.commitCandidates([bigCand], makeStats({ candidateCount: 1 }))).toThrow(
      RepositoryError,
    );
    expect(repo.listCandidatesByTask(id).length).toBe(0);
    expect(repo.getTaskById(id)!.status).toBe('running');
    p.commitFailed('research-budget-exhausted', makeStats());
    expect(repo.getTaskById(id)!.status).toBe('failed');
    expect(repo.getTaskById(id)!.errorCode).toBe('research-budget-exhausted');
  });

  it('大行恰好放得下（含终态预留）→ 成功；多一字节即拒绝（二分边界）', async () => {
    let cidSeq = 0;
    const build = (len: number, id: string): SourceCandidate => {
      cidSeq += 1;
      const cid = `89898989-8989-4989-8989-${String(cidSeq).padStart(12, '0')}`;
      const big = 'x'.repeat(len);
      return {
        id: cid,
        url: `https://c.example/${big}`,
        displayUrl: `https://c.example/${big}`,
        title: big,
        canonicalKey: `https://c.example/${big}`,
        scope: 'page',
        discoveredVia: ['search'],
        sourceId: null,
        trust: null,
        priority: null,
        lastUsedAt: null,
        note: null,
        sortKey: `03|00000|9|~~~~~~~~~~~~~~~~~~~~~~~~|1|https://c.example/${big}|${id}`,
      };
    };
    const fits = (len: number, id: string): boolean => {
      repo.insertTask({
        id,
        goal: '研'.repeat(2000),
        status: 'running',
        phase: 'reading',
        created_at: T0,
        updated_at: T0,
        started_at: T0,
        finished_at: null,
        interrupted_at: null,
        error_code: null,
        result_id: null,
        stats_json: JSON.stringify(makeStats()),
      });
      const fp = createRepositoryPersistence(handle, id);
      try {
        fp.commitCandidates([build(len, id)], makeStats({ candidateCount: 1 }));
        return true;
      } catch {
        return false;
      }
    };
    // 二分：找「含终态预留」能放下的最大负载
    let lo = 0;
    let hi = 300000;
    let probe = 0;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      probe += 1;
      const id = `50000000-0000-4000-8000-${String(probe).padStart(12, '0')}`;
      if (fits(mid, id)) lo = mid;
      else hi = mid - 1;
    }
    // 边界断言：lo 成功、lo+3000 失败
    expect(lo).toBeGreaterThan(0);
    expect(fits(lo, '50000000-0000-4000-8000-999999999901')).toBe(true);
    expect(fits(lo + 3000, '50000000-0000-4000-8000-999999999902')).toBe(false);
  });

  it('非终态任务行更新（heartbeat stats）同样受终态预留约束', () => {
    const id = '56565656-5656-4565-8565-565656565656';
    repo.insertTask({
      id,
      goal: '研'.repeat(2000),
      status: 'running',
      phase: 'planning',
      created_at: T0,
      updated_at: T0,
      started_at: T0,
      finished_at: null,
      interrupted_at: null,
      error_code: null,
      result_id: null,
      stats_json: JSON.stringify(makeStats()),
    });
    const p = createRepositoryPersistence(handle, id);
    const current = repo.computeTaskPersistedBytes(id);
    const worst = repo.estimateWorstTerminalTaskRowBytes(id);
    const room = MAX_TASK_PERSISTED_CHARS - current - worst;
    // 巨大 stats 数值（10 位）——若超过预留余量则拒绝且 failed 仍可写
    const hugeStats = makeStats({
      candidateCount: 9999999999,
      selectedCount: 9999999999,
      stepsUsed: 9999999999,
      roundsUsed: 9999999999,
    });
    const statsBytes = computeUtf8Bytes(JSON.stringify(hugeStats));
    const currentStatsBytes = computeUtf8Bytes(JSON.stringify(makeStats()));
    const statsDelta = statsBytes - currentStatsBytes;
    if (statsDelta <= room) {
      p.commitPhaseHeartbeat('reading', hugeStats);
      expect(repo.getTaskById(id)!.stats.roundsUsed).toBe(9999999999);
    } else {
      expect(() => p.commitPhaseHeartbeat('reading', hugeStats)).toThrow();
      p.commitFailed('research-budget-exhausted', makeStats());
      expect(repo.getTaskById(id)!.status).toBe('failed');
    }
  });
});

// 原子回滚（决议 #137(1)：任一步失败整体回滚）
describe('原子回滚矩阵', () => {
  it('candidates 中途失败 → 候选零残留 + stats 零变化', () => {
    const p = createRepositoryPersistence(handle, taskId);
    const good = makeCandidate('99999999-9999-4999-8999-999999999999');
    const bad = { ...good, discoveredVia: ['evil' as never] };
    expect(() => p.commitCandidates([good, bad], makeStats({ candidateCount: 2 }))).toThrow();
    expect(repo.listCandidatesByTask(taskId).length).toBe(0);
    expect(repo.getTaskById(taskId)!.stats.candidateCount).toBe(0);
  });

  it('evidence 中途失败 → 零 evidence + stats 零变化', () => {
    const p = createRepositoryPersistence(handle, taskId);
    const ev: VerifiedEvidence = {
      evidenceId: '55555555-5555-4555-8555-555555555555',
      taskId,
      captureId: '33333333-3333-4333-8333-333333333333',
      candidateId: '22222222-2222-4222-8222-222222222222',
      sourceId: null,
      url: 'https://c.example/page',
      title: '页面',
      accessTime: T0,
      documentId: '1',
      contentHash: 'a'.repeat(32),
      type: 'quote',
      locator: { kind: 'text', excerpt: '摘录' },
      excerpt: '摘录',
      value: null,
      verification: 'verified',
    };
    const badEv = { ...ev, type: 'evil' as never };
    expect(() => p.commitEvidence([ev, badEv], makeStats({ evidenceCount: 2 }))).toThrow();
    expect(repo.listEvidenceByTask(taskId).length).toBe(0);
    expect(repo.getTaskById(taskId)!.stats.evidenceCount).toBe(0);
  });
});

// row 转换出口（C5 公共化）：持久化端口用
describe('rowToCandidate 公共出口', () => {
  it('合法行转换成功；非法 discoveredVia 形状 → null', () => {
    const row = makeCandidateRow('99999999-9999-4999-8999-999999999999', taskId);
    expect(rowToCandidate(row)).not.toBeNull();
    expect(rowToCandidate({ ...row, discovered_via_json: '["evil"]' })).toBeNull();
  });
});
