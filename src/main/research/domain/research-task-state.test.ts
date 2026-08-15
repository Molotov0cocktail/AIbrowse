// C1 research-task-state tests: the full §3.1 transition matrix (adjudications
// #105/#106) — legal/illegal event grid, injected-now determinism, terminal
// immutability (single ownership), restart semantics (stats reset on the pure
// function; run-data cleanup is a Service-layer transaction), late events after
// terminal states, and invalid event payloads safely returning task copies.
import { describe, expect, it } from 'vitest';
import { isIso8601Timestamp, transitionTask } from './research-task-state';
import type { ResearchPhase, ResearchTask } from '../../../shared/types/research';

const T0 = '2026-08-16T00:00:00.000Z';
const T1 = '2026-08-16T00:01:00.000Z';
const T2 = '2026-08-16T00:02:00.000Z';
const RESULT_ID = '22222222-2222-4222-8222-222222222222';

function makeTask(over: Partial<ResearchTask> = {}): ResearchTask {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    goal: '比较主流模型能力',
    status: 'created',
    phase: null,
    createdAt: T0,
    updatedAt: T0,
    startedAt: null,
    finishedAt: null,
    interruptedAt: null,
    errorCode: null,
    resultId: null,
    stats: {
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
    },
    ...over,
  };
}

const nonzeroStats: ResearchTask['stats'] = {
  candidateCount: 5,
  selectedCount: 3,
  captureCount: 4,
  failedReadCount: 1,
  evidenceCount: 2,
  rejectedEvidenceCount: 1,
  claimCount: 2,
  conflictCount: 1,
  stepsUsed: 7,
  roundsUsed: 3,
};

function runningTask(over: Partial<ResearchTask> = {}): ResearchTask {
  return makeTask({
    status: 'running',
    phase: 'reading',
    startedAt: T1,
    stats: nonzeroStats,
    ...over,
  });
}

describe('start 事件（决议 #105：created/cancelled/failed/interrupted 合法）', () => {
  it('created + start → running（phase=planning、startedAt=now、stats 保持）', () => {
    const task = makeTask();
    const next = transitionTask(task, { kind: 'start', now: T1 });
    expect(next).not.toBe(task);
    expect(next.status).toBe('running');
    expect(next.phase).toBe('planning');
    expect(next.startedAt).toBe(T1);
    expect(next.updatedAt).toBe(T1);
    expect(next.finishedAt).toBeNull();
    expect(next.errorCode).toBeNull();
    expect(next.stats).toEqual(task.stats);
    expect(task.status).toBe('created'); // 输入不可变
  });

  it.each(['cancelled', 'failed', 'interrupted'] as const)(
    '%s + start → running 且 reset 全部 run 字段（决议 #106 纯函数部分）',
    (status) => {
      const task = makeTask({
        status,
        phase: status === 'interrupted' ? null : 'reading',
        startedAt: T1,
        finishedAt: status === 'interrupted' ? null : T1,
        interruptedAt: status === 'interrupted' ? T1 : null,
        errorCode: status === 'failed' ? 'research-internal' : null,
        resultId: null,
        stats: nonzeroStats,
      });
      const next = transitionTask(task, { kind: 'start', now: T2 });
      expect(next.status).toBe('running');
      expect(next.phase).toBe('planning');
      expect(next.startedAt).toBe(T2);
      expect(next.updatedAt).toBe(T2);
      expect(next.finishedAt).toBeNull();
      expect(next.interruptedAt).toBeNull();
      expect(next.errorCode).toBeNull();
      expect(next.resultId).toBeNull();
      expect(next.stats).toEqual({
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
      });
    },
  );

  it('running + start → 零变化（互斥前置在 Service 层回注错误码）', () => {
    const task = runningTask();
    const next = transitionTask(task, { kind: 'start', now: T2 });
    expect(next).toEqual(task);
  });

  it('completed + start → 零变化（Result 已持久化，重新研究 = 新建任务）', () => {
    const task = makeTask({
      status: 'completed',
      phase: null,
      startedAt: T0,
      finishedAt: T1,
      resultId: RESULT_ID,
      stats: nonzeroStats,
    });
    const next = transitionTask(task, { kind: 'start', now: T2 });
    expect(next).toEqual(task);
  });

  it('start 的 now 非法（空串/非串）→ 零变化', () => {
    const task = makeTask();
    expect(transitionTask(task, { kind: 'start', now: '' })).toEqual(task);
    expect(transitionTask(task, { kind: 'start', now: 123 as unknown as string })).toEqual(task);
  });
});

describe('now 形状契约（决议 #116：ISO 8601 为输入有效性约束）', () => {
  it.each([
    '', // 空串
    '   ', // 纯空白
    '2026-08-16', // 仅日期（无时间）
    '2026-08-16T00:01', // 无秒
    '2026-08-16 00:01:00Z', // 空格分隔（非 ISO T）
    '2026-08-16T00:01:00', // 无时区
    '20260816T000100Z', // 紧凑格式
    '2026-08-16T00:01:00+8:00', // 偏移未补零
    'not-a-time', // 垃圾字符串
    '2026-13-45T99:99:99.999Z', // 非法日期（月份越界）
    '2026-02-30T00:00:00.000Z', // 非法日历日期（JS 回滚形态）
    '2026-08-16T00:01:00.000', // 毫秒但无时区
    'Tue, 16 Aug 2026 00:00:00 GMT', // RFC 形状
    '💥💥💥', // 任意非空垃圾
  ])('非法 now「%s」→ 全部事件零变化（不得静默接受）', (bad) => {
    const created = makeTask();
    const running = runningTask();
    expect(transitionTask(created, { kind: 'start', now: bad })).toEqual(created);
    expect(transitionTask(running, { kind: 'phase', phase: 'reading', now: bad })).toEqual(running);
    expect(transitionTask(running, { kind: 'finish-done', resultId: RESULT_ID, now: bad })).toEqual(
      running,
    );
    expect(
      transitionTask(running, { kind: 'finish-error', errorCode: 'research-timeout', now: bad }),
    ).toEqual(running);
    expect(transitionTask(running, { kind: 'finish-budget', now: bad })).toEqual(running);
    expect(transitionTask(running, { kind: 'stop', now: bad })).toEqual(running);
    expect(transitionTask(running, { kind: 'mark-interrupted', now: bad })).toEqual(running);
  });

  it.each(['2026-08-16T00:01:00.000Z', '2026-08-16T00:01:00Z', '2026-08-16T08:01:00+08:00'])(
    '合法 ISO 时间「%s」→ 事件正常迁移（now 原样注入）',
    (now) => {
      const next = transitionTask(makeTask(), { kind: 'start', now });
      expect(next.status).toBe('running');
      expect(next.startedAt).toBe(now);
      expect(next.updatedAt).toBe(now);
    },
  );

  it('isIso8601Timestamp 直接调用矩阵（合法/非法/非串）', () => {
    expect(isIso8601Timestamp('2026-08-16T00:01:00.000Z')).toBe(true);
    expect(isIso8601Timestamp('2026-08-16T00:01:00Z')).toBe(true);
    expect(isIso8601Timestamp('2026-08-16T08:01:00+08:00')).toBe(true);
    expect(isIso8601Timestamp('2026-08-16T00:01:00.5Z')).toBe(true);
    expect(isIso8601Timestamp('')).toBe(false);
    expect(isIso8601Timestamp('2026-08-16')).toBe(false);
    expect(isIso8601Timestamp('2026-02-30T00:00:00.000Z')).toBe(false);
    expect(isIso8601Timestamp('2026-13-45T99:99:99.999Z')).toBe(false);
    expect(isIso8601Timestamp(null)).toBe(false);
    expect(isIso8601Timestamp(42)).toBe(false);
    expect(isIso8601Timestamp(undefined)).toBe(false);
  });
});

describe('决议 #116 二次补修：偏移形态日历回滚拒绝（2026-08-16）', () => {
  it.each([
    // Offset-form calendar rollover — the value-level Date.parse round-trip is
    // nearly always true for successfully parsed timestamps, so it cannot
    // detect JS date rollover (e.g. 2026-02-30+08:00 → 2026-03-01T16:00:00.000Z)
    '2026-02-30T00:00:00+08:00', // 2 月 30 日（偏移回滚）
    '2026-04-31T12:00:00-05:00', // 4 月 31 日（偏移回滚）
    '2025-02-29T00:00:00Z', // 非闰年 2 月 29 日（Z 形态）
    '2025-02-29T00:00:00+08:00', // 非闰年 2 月 29 日（偏移形态）
    '2026-00-15T00:00:00Z', // 月 00
    '2026-13-01T00:00:00Z', // 月 13
    '2026-13-01T00:00:00+08:00', // 月越界（偏移形态）
    '2026-01-00T00:00:00Z', // 日 00
    '2026-01-32T00:00:00Z', // 日 32
    '2026-06-31T00:00:00Z', // 30 天月 31 日（Z 形态）
    '2026-06-31T00:00:00+08:00', // 30 天月 31 日（偏移回滚）
    '2026-09-31T12:00:00-05:00', // 30 天月 31 日（偏移回滚）
    '2026-11-31T00:00:00Z', // 30 天月 31 日（Z 形态）
    '2026-08-16T24:00:00Z', // 24:00（不属既有语法范围）
    '2026-08-16T24:00:00+08:00', // 24:00 偏移形态（值级往返恒真放行）
    '2026-08-16T23:60:00Z', // 分 60
    '2026-08-16T23:60:00+08:00', // 分 60（偏移形态）
    '2026-08-16T23:59:60Z', // 秒 60（闰秒不属既有语法范围）
    '2026-08-16T23:59:60+08:00', // 秒 60（偏移形态）
    '2026-08-16T12:00:00+24:00', // 偏移小时越界
    '2026-08-16T12:00:00-24:00', // 偏移小时越界（负）
    '2026-08-16T12:00:00+14:60', // 偏移分钟越界
    '2026-08-16T12:00:00-14:60', // 偏移分钟越界（负）
  ])('非法偏移日期「%s」：isIso8601Timestamp=false 且全部事件零变化', (bad) => {
    expect(isIso8601Timestamp(bad)).toBe(false);
    const created = makeTask();
    const running = runningTask();
    expect(transitionTask(created, { kind: 'start', now: bad })).toEqual(created);
    expect(transitionTask(running, { kind: 'phase', phase: 'reading', now: bad })).toEqual(running);
    expect(transitionTask(running, { kind: 'finish-done', resultId: RESULT_ID, now: bad })).toEqual(
      running,
    );
    expect(
      transitionTask(running, { kind: 'finish-error', errorCode: 'research-timeout', now: bad }),
    ).toEqual(running);
    expect(transitionTask(running, { kind: 'finish-budget', now: bad })).toEqual(running);
    expect(transitionTask(running, { kind: 'stop', now: bad })).toEqual(running);
    expect(transitionTask(running, { kind: 'mark-interrupted', now: bad })).toEqual(running);
  });

  it.each([
    '2024-02-29T00:00:00Z', // 闰年 2 月末（Z 形态）
    '2024-02-29T23:59:59.999+08:00', // 闰年 2 月末（偏移 + 3 位毫秒）
    '2026-04-30T00:00:00Z', // 4 月末
    '2026-12-31T12:00:00-05:00', // 12 月末（负偏移）
    '2026-01-31T00:00:00+14:00', // 1 月末（+14:00）
    '2026-08-16T00:01:00Z', // 无毫秒 Z
    '2026-08-16T00:01:00.1Z', // 1 位毫秒
    '2026-08-16T00:01:00.12Z', // 2 位毫秒
    '2026-08-16T00:01:00.123Z', // 3 位毫秒
    '2026-08-16T08:01:00+08:00', // 正偏移
    '2026-08-16T00:01:00-05:00', // 负偏移
    '2026-08-16T00:01:00+00:00', // 显式零偏移
    '2026-08-16T00:01:00-00:00', // 负零偏移（Date.parse 既有接受形态）
    '2026-08-16T23:59:59+23:59', // 偏移小时既有接受上界（实测 Date.parse 可解析）
    '2026-08-16T23:59:59-23:59', // 偏移小时既有接受下界
    '2026-08-16T00:00:00.000Z', // 调用方 toISOString 恒产出形态
  ])('合法 ISO 时间「%s」→ isIso8601Timestamp=true', (ok) => {
    expect(isIso8601Timestamp(ok)).toBe(true);
  });

  it('合法偏移形态 → 事件正常迁移（now 原样注入，不依赖本地时区）', () => {
    const now = '2024-02-29T00:00:00+08:00';
    const next = transitionTask(makeTask(), { kind: 'start', now });
    expect(next.status).toBe('running');
    expect(next.startedAt).toBe(now);
    expect(next.updatedAt).toBe(now);
  });

  it('真实调用方 toISOString 输出形态恒通过（Service.nowIso/store 装配契约）', () => {
    const now = new Date(1723766400000).toISOString(); // 2024-08-16T00:00:00.000Z（UTC 确定性）
    expect(isIso8601Timestamp(now)).toBe(true);
    const next = transitionTask(makeTask(), { kind: 'start', now });
    expect(next.status).toBe('running');
    expect(next.startedAt).toBe(now);
  });
});

describe('running 内事件', () => {
  it.each<ResearchPhase>(['planning', 'reading', 'verifying', 'synthesizing'])(
    'phase → %s 合法（updatedAt=now、其余不变）',
    (phase) => {
      const task = runningTask({ phase: 'planning' });
      const next = transitionTask(task, { kind: 'phase', phase, now: T2 });
      expect(next.status).toBe('running');
      expect(next.phase).toBe(phase);
      expect(next.updatedAt).toBe(T2);
      expect(next.startedAt).toBe(T1);
      expect(next.stats).toEqual(nonzeroStats);
    },
  );

  it('phase 事件非法相位 → 零变化', () => {
    const task = runningTask();
    expect(
      transitionTask(task, { kind: 'phase', phase: 'nope' as unknown as ResearchPhase, now: T2 }),
    ).toEqual(task);
  });

  it('finish-done → completed（resultId/finishedAt 记录）', () => {
    const task = runningTask();
    const next = transitionTask(task, { kind: 'finish-done', resultId: RESULT_ID, now: T2 });
    expect(next.status).toBe('completed');
    expect(next.phase).toBeNull();
    expect(next.resultId).toBe(RESULT_ID);
    expect(next.finishedAt).toBe(T2);
    expect(next.updatedAt).toBe(T2);
  });

  it('finish-done 空 resultId → 零变化', () => {
    const task = runningTask();
    expect(transitionTask(task, { kind: 'finish-done', resultId: '', now: T2 })).toEqual(task);
    expect(transitionTask(task, { kind: 'finish-done', resultId: '   ', now: T2 })).toEqual(task);
  });

  it('finish-error → failed（errorCode 记录、Evidence 保留语义不动行数据）', () => {
    const task = runningTask();
    const next = transitionTask(task, {
      kind: 'finish-error',
      errorCode: 'research-sources-unavailable',
      now: T2,
    });
    expect(next.status).toBe('failed');
    expect(next.phase).toBeNull();
    expect(next.errorCode).toBe('research-sources-unavailable');
    expect(next.finishedAt).toBe(T2);
    expect(next.updatedAt).toBe(T2);
  });

  it('finish-error 非法错误码 → 零变化', () => {
    const task = runningTask();
    expect(
      transitionTask(task, {
        kind: 'finish-error',
        errorCode: 'not-a-code' as unknown as never,
        now: T2,
      }),
    ).toEqual(task);
  });

  it('finish-budget → failed（errorCode=research-budget-exhausted）', () => {
    const task = runningTask();
    const next = transitionTask(task, { kind: 'finish-budget', now: T2 });
    expect(next.status).toBe('failed');
    expect(next.errorCode).toBe('research-budget-exhausted');
    expect(next.finishedAt).toBe(T2);
  });

  it('stop → cancelled（finishedAt=now；无 Result）', () => {
    const task = runningTask();
    const next = transitionTask(task, { kind: 'stop', now: T2 });
    expect(next.status).toBe('cancelled');
    expect(next.phase).toBeNull();
    expect(next.resultId).toBeNull();
    expect(next.finishedAt).toBe(T2);
    expect(next.updatedAt).toBe(T2);
  });

  it('mark-interrupted → interrupted（phase=null、interruptedAt=now）', () => {
    const task = runningTask();
    const next = transitionTask(task, { kind: 'mark-interrupted', now: T2 });
    expect(next.status).toBe('interrupted');
    expect(next.phase).toBeNull();
    expect(next.interruptedAt).toBe(T2);
    expect(next.finishedAt).toBeNull();
    expect(next.updatedAt).toBe(T2);
  });
});

describe('终态单一所有权（决议 #33 模式）：迟到事件零变化', () => {
  const terminal: Array<[ResearchTask['status'], ResearchTask]> = [
    ['completed', makeTask({ status: 'completed', phase: null, finishedAt: T1 })],
    [
      'failed',
      makeTask({ status: 'failed', phase: null, finishedAt: T1, errorCode: 'research-internal' }),
    ],
    ['cancelled', makeTask({ status: 'cancelled', phase: null, finishedAt: T1 })],
  ];
  it.each(terminal)('%s 后 phase/finish/stop/mark-interrupted 全部零变化', (_label, task) => {
    expect(transitionTask(task, { kind: 'phase', phase: 'reading', now: T2 })).toEqual(task);
    expect(transitionTask(task, { kind: 'finish-done', resultId: RESULT_ID, now: T2 })).toEqual(
      task,
    );
    expect(
      transitionTask(task, { kind: 'finish-error', errorCode: 'research-internal', now: T2 }),
    ).toEqual(task);
    expect(transitionTask(task, { kind: 'finish-budget', now: T2 })).toEqual(task);
    expect(transitionTask(task, { kind: 'stop', now: T2 })).toEqual(task);
    expect(transitionTask(task, { kind: 'mark-interrupted', now: T2 })).toEqual(task);
  });

  it('interrupted 后除 start 外零变化（不自动续跑）', () => {
    const task = makeTask({ status: 'interrupted', phase: null, interruptedAt: T1 });
    expect(transitionTask(task, { kind: 'phase', phase: 'reading', now: T2 })).toEqual(task);
    expect(transitionTask(task, { kind: 'stop', now: T2 })).toEqual(task);
    expect(transitionTask(task, { kind: 'mark-interrupted', now: T2 })).toEqual(task);
  });

  it('cancelled + start → running（重新开始 = 新 run）', () => {
    const task = makeTask({
      status: 'cancelled',
      phase: null,
      startedAt: T0,
      finishedAt: T1,
      stats: nonzeroStats,
    });
    const next = transitionTask(task, { kind: 'start', now: T2 });
    expect(next.status).toBe('running');
    expect(next.stats.evidenceCount).toBe(0);
  });
});

describe('非 running 状态上的 running 专属事件', () => {
  it('created 上 phase/finish/stop/mark-interrupted 零变化', () => {
    const task = makeTask();
    expect(transitionTask(task, { kind: 'phase', phase: 'reading', now: T1 })).toEqual(task);
    expect(transitionTask(task, { kind: 'finish-done', resultId: RESULT_ID, now: T1 })).toEqual(
      task,
    );
    expect(transitionTask(task, { kind: 'stop', now: T1 })).toEqual(task);
    expect(transitionTask(task, { kind: 'mark-interrupted', now: T1 })).toEqual(task);
  });

  it('未知事件 kind → 零变化（安全返回副本不抛异常）', () => {
    const task = runningTask();
    expect(
      transitionTask(task, { kind: 'explode' } as unknown as Parameters<typeof transitionTask>[1]),
    ).toEqual(task);
  });
});

describe('确定性：同输入同输出（now 由调用方注入）', () => {
  it('相同 task + 相同 event 两次迁移结果全等', () => {
    const task = runningTask();
    const a = transitionTask(task, { kind: 'stop', now: T2 });
    const b = transitionTask(runningTask(), { kind: 'stop', now: T2 });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
