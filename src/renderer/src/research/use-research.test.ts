// C8 决议 #163(4)：useResearch/reducer 契约——taskId 键控（其他任务事件不
// 覆盖当前选中任务）；progress running 有界节流/合并（语义变化才刷新）与
// terminal 立即刷新；task-done 触发 task/result/list 重读标记；事件可能早于
// start invoke 返回（安全收敛：事件为主、invoke 结果只补缺）；退订后零
// setState（hook 层保证——reducer 纯函数）；删除当前画布任务清空结果画布；
// start 失败 created 保留进历史；unavailable 中文诊断；全部状态/phase/错误码
// 固定中文映射（零异常/SQL/路径/Provider 原文）。
import { describe, expect, it } from 'vitest';
import type { ResearchTask, ResearchTaskStats } from '../../../shared/types/research';
import {
  INITIAL_RESEARCH_UI_STATE,
  reduceResearchUi,
  type ResearchUiEvent,
  type ResearchUiState,
} from './use-research';

const STATS: ResearchTaskStats = {
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

function makeTask(id: string, status: 'created' | 'running' | 'completed' | 'failed' | 'cancelled'): ResearchTask {
  return {
    id,
    goal: `目标-${id}`,
    status,
    phase: status === 'running' ? 'planning' : null,
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    startedAt: status === 'running' ? '2026-08-16T00:00:00.000Z' : null,
    finishedAt: null,
    interruptedAt: null,
    errorCode: null,
    resultId: null,
    stats: { ...STATS },
  };
}

describe('reduceResearchUi（决议 #163(4)）', () => {
  it('初始状态：无选中、无画布、可用', () => {
    expect(INITIAL_RESEARCH_UI_STATE.selectedTaskId).toBeNull();
    expect(INITIAL_RESEARCH_UI_STATE.task).toBeNull();
    expect(INITIAL_RESEARCH_UI_STATE.resultView).toBeNull();
    expect(INITIAL_RESEARCH_UI_STATE.available).toBe(true);
  });

  it('create→start 顺序：create ok 选中新任务；start 失败（created 保留）→ 历史可见可重启', () => {
    let s: ResearchUiState = INITIAL_RESEARCH_UI_STATE;
    const created = makeTask('t-1', 'created');
    s = reduceResearchUi(s, { kind: 'create-ok', task: created });
    expect(s.selectedTaskId).toBe('t-1');
    expect(s.task?.status).toBe('created');

    // start 失败（research-provider-unavailable）→ created 保留 + 固定中文错误
    s = reduceResearchUi(s, {
      kind: 'invoke-error',
      errorCode: 'research-provider-unavailable',
    });
    expect(s.task?.status).toBe('created');
    expect(s.error).toContain('模型服务');
    // 历史仍含该任务（可重新启动）
    s = reduceResearchUi(s, { kind: 'list-ok', items: [created], page: 1, pageSize: 20, total: 1 });
    expect(s.history.map((t) => t.id)).toContain('t-1');
  });

  it('taskId 键控：其他任务事件不覆盖当前选中任务', () => {
    let s: ResearchUiState = INITIAL_RESEARCH_UI_STATE;
    s = reduceResearchUi(s, { kind: 'create-ok', task: makeTask('t-1', 'created') });
    // 其他任务（t-2）的 progress 事件到达 → 忽略（不改变 selected/task）
    s = reduceResearchUi(s, {
      kind: 'progress',
      event: {
        taskId: 't-2',
        status: 'running',
        phase: 'reading',
        stats: { ...STATS, captureCount: 3 },
        finishedAt: null,
      },
    });
    expect(s.task?.id).toBe('t-1');
    expect(s.phase).toBeNull();
    expect(s.stats?.captureCount ?? 0).toBe(0);
  });

  it('选中任务 progress running 有界节流：语义变化才刷新（同快照合并）', () => {
    let s: ResearchUiState = INITIAL_RESEARCH_UI_STATE;
    s = reduceResearchUi(s, { kind: 'create-ok', task: makeTask('t-1', 'created') });
    const progress = (captureCount: number, phase: 'planning' | 'reading' | null = 'planning') => ({
      taskId: 't-1',
      status: 'running' as const,
      phase,
      stats: { ...STATS, captureCount },
      finishedAt: null,
    });
    s = reduceResearchUi(s, { kind: 'progress', event: progress(0) });
    const firstStats = s.stats;
    // 相同 stats/phase → 合并（不产生新快照）
    s = reduceResearchUi(s, { kind: 'progress', event: progress(0) });
    expect(s.stats).toBe(firstStats);
    // 语义变化 → 刷新
    s = reduceResearchUi(s, { kind: 'progress', event: progress(1) });
    expect(s.stats?.captureCount).toBe(1);
    expect(s.phase).toBe('规划来源');
  });

  it('terminal progress 立即刷新（不节流合并）', () => {
    let s: ResearchUiState = INITIAL_RESEARCH_UI_STATE;
    s = reduceResearchUi(s, { kind: 'create-ok', task: makeTask('t-1', 'created') });
    s = reduceResearchUi(s, {
      kind: 'progress',
      event: {
        taskId: 't-1',
        status: 'completed',
        phase: null,
        stats: { ...STATS },
        finishedAt: '2026-08-16T00:01:00.000Z',
      },
    });
    expect(s.status).toBe('已完成');
    expect(s.finishedAt).toBe('2026-08-16T00:01:00.000Z');
  });

  it('事件早于 start invoke 返回：事件为主、invoke 结果只补缺（不覆盖事件状态）', () => {
    let s: ResearchUiState = INITIAL_RESEARCH_UI_STATE;
    s = reduceResearchUi(s, { kind: 'create-ok', task: makeTask('t-1', 'created') });
    // start invoke 未返回，progress 事件先到（running）
    s = reduceResearchUi(s, {
      kind: 'progress',
      event: {
        taskId: 't-1',
        status: 'running',
        phase: 'planning',
        stats: { ...STATS },
        finishedAt: null,
      },
    });
    expect(s.status).toBe('运行中');
    // 迟到的 start invoke ok（返回 created 快照）→ 不得把 running 覆盖回 created
    s = reduceResearchUi(s, { kind: 'start-ok', task: makeTask('t-1', 'created') });
    expect(s.status).toBe('运行中');
    expect(s.phase).toBe('规划来源');
  });

  it('task-done 触发 task/result/list 重读标记（reloadRequested）', () => {
    let s: ResearchUiState = INITIAL_RESEARCH_UI_STATE;
    s = reduceResearchUi(s, { kind: 'create-ok', task: makeTask('t-1', 'created') });
    s = reduceResearchUi(s, { kind: 'task-done', taskId: 't-1', status: 'completed' });
    expect(s.status).toBe('已完成');
    expect(s.reloadRequested).toBe(true);
    // 消费标记
    s = reduceResearchUi(s, { kind: 'reload-consumed' });
    expect(s.reloadRequested).toBe(false);
  });

  it('task-done 其他任务 → 零影响', () => {
    let s: ResearchUiState = INITIAL_RESEARCH_UI_STATE;
    s = reduceResearchUi(s, { kind: 'create-ok', task: makeTask('t-1', 'created') });
    s = reduceResearchUi(s, { kind: 'task-done', taskId: 't-9', status: 'failed' });
    expect(s.task?.id).toBe('t-1');
    // create-ok 已设「已创建」；其他任务 task-done 零影响（不覆盖）
    expect(s.status).toBe('已创建');
    expect(s.reloadRequested).toBe(false);
  });

  it('删除当前画布任务 → 清空结果画布（task/resultView/selected 全清）', () => {
    let s: ResearchUiState = INITIAL_RESEARCH_UI_STATE;
    const done = { ...makeTask('t-1', 'completed'), resultId: 'r-1' };
    s = reduceResearchUi(s, { kind: 'create-ok', task: done });
    s = reduceResearchUi(s, {
      kind: 'result-ok',
      view: {
        task: done,
        result: {
          resultId: 'r-1',
          taskId: 't-1',
          title: '标题',
          summary: '摘要',
          blocks: [],
          evidenceMap: {},
          conflicts: [],
          coverage: { total: 0, multiSource: 0, singleSource: 0, vendor: 0, thirdParty: 0, community: 0 },
          fetchedAt: '2026-08-16T00:00:00.000Z',
        },
        evidence: [],
      },
    });
    expect(s.resultView).not.toBeNull();
    s = reduceResearchUi(s, { kind: 'delete-ok', taskId: 't-1' });
    expect(s.selectedTaskId).toBeNull();
    expect(s.task).toBeNull();
    expect(s.resultView).toBeNull();
    expect(s.resultCanvasCleared).toBe(true);
  });

  it('删除其他任务 → 当前画布不受影响', () => {
    let s: ResearchUiState = INITIAL_RESEARCH_UI_STATE;
    s = reduceResearchUi(s, { kind: 'create-ok', task: makeTask('t-1', 'created') });
    s = reduceResearchUi(s, { kind: 'delete-ok', taskId: 't-9' });
    expect(s.task?.id).toBe('t-1');
  });

  it('unavailable → 入口禁用状态 + 固定中文诊断（available=false）', () => {
    const s = reduceResearchUi(INITIAL_RESEARCH_UI_STATE, {
      kind: 'unavailable',
      reason: '研究数据库初始化失败（详见日志）',
    });
    expect(s.available).toBe(false);
    expect(s.unavailableReason).toContain('研究数据库初始化失败');
  });

  it('固定中文错误码映射（零原始消息透传）', () => {
    let s: ResearchUiState = INITIAL_RESEARCH_UI_STATE;
    s = reduceResearchUi(s, { kind: 'create-ok', task: makeTask('t-1', 'created') });
    const cases: Array<[string, string]> = [
      ['research-busy', '运行中'],
      ['research-not-found', '不存在'],
      ['research-invalid-state', '状态'],
      ['research-unavailable', '不可用'],
      ['research-sources-unavailable', '信源'],
      ['research-provider-unavailable', '模型服务'],
      ['research-budget-exhausted', '预算'],
      ['research-timeout', '超时'],
      ['research-task-limit', '上限'],
      ['research-internal', '内部'],
      ['research-runtime-unavailable', '运行'],
      ['research-invalid-goal', '目标'],
    ];
    for (const [code, keyword] of cases) {
      const next = reduceResearchUi(s, { kind: 'invoke-error', errorCode: code as never });
      expect(next.error).toContain(keyword);
    }
  });

  it('未知事件/未知错误码安全不抛（防御性）', () => {
    const s = reduceResearchUi(INITIAL_RESEARCH_UI_STATE, {
      kind: 'invoke-error',
      errorCode: 'not-a-real-code' as never,
    });
    expect(s.error).not.toBeNull();
  });

  it('invoke-error 其他任务上下文不影响当前任务', () => {
    let s: ResearchUiState = INITIAL_RESEARCH_UI_STATE;
    s = reduceResearchUi(s, { kind: 'create-ok', task: makeTask('t-1', 'created') });
    s = reduceResearchUi(s, { kind: 'invoke-error', errorCode: 'research-not-found' });
    // error 显示固定诊断（作用于当前操作）
    expect(s.error).toContain('不存在');
  });
});

// 类型完整性：事件判别联合（供 hook 引用）
export type _EventTypeCheck = ResearchUiEvent;
