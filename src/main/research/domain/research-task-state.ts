// Fifth Stage C1: research task state machine — pure functions, zero Electron
// imports (detailed-design §3.1/§3.2, adjudications #105/#106/#116). All events
// carry an injected `now` ISO string for determinism; `now` is validated as an
// ISO 8601 timestamp input-validity constraint (adjudication #116: any
// non-ISO-8601 shape — garbage, invalid calendar dates, missing timezone — is
// an illegal payload and the event is a no-op); illegal events and illegal
// payloads safely return a copy of the input task (never throw); terminal
// states are immutable except for `start` (single-ownership guard, A5
// adjudication #33 pattern). `start` resets run fields on restart (stats
// zeroed, run timestamps/error/result cleared, phase='planning') — the old
// run's child rows are cleaned by a Service-layer transaction (#106).
import {
  RESEARCH_ERROR_CODES,
  RESEARCH_PHASES,
  type ResearchErrorCode,
  type ResearchPhase,
  type ResearchTask,
  type ResearchTaskStats,
} from '../../../shared/types/research';

// 决议 #116：ISO 8601 时间戳形状（含可选毫秒；Z 或 ±HH:MM 时区）
const ISO_8601_TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

// 决议 #116：now 的 ISO 8601 输入有效性约束（确定性纯函数）。调用方仅
// ResearchService.nowIso 与 research-store 装配（恒 new Date(ms).toISOString()）。
// 注：此处用 String.match 而非正则对象的 exec 方法——语义相同，且本模块零
// SQL，避免 SRT-12 静态审计的 SQL 形态误报（审计白名单无需为此放宽）。
export function isIso8601Timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.match(ISO_8601_TIMESTAMP_RE);
  if (match === null) return false;
  const [, core, ms, zone] = match;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  if (zone === 'Z') {
    // Z 形态做字符串级日历往返校验（拒绝 2026-02-30 等 JS 回滚形态）；
    // 毫秒位补齐至 .sss 后与 toISOString 恒等
    const normalized = `${core}.${(ms ?? '').padEnd(3, '0')}Z`;
    return new Date(parsed).toISOString() === normalized;
  }
  // 偏移形态：Date.parse 值级往返（toISOString 归一化为 Z——值相等即同一时刻）
  return Date.parse(new Date(parsed).toISOString()) === parsed;
}

export type ResearchTaskEvent =
  | { kind: 'start'; now: string }
  | { kind: 'phase'; phase: ResearchPhase; now: string }
  | { kind: 'finish-done'; resultId: string; now: string }
  | { kind: 'finish-error'; errorCode: ResearchErrorCode; now: string }
  | { kind: 'finish-budget'; now: string }
  | { kind: 'stop'; now: string }
  | { kind: 'mark-interrupted'; now: string };

export const ZERO_TASK_STATS: ResearchTaskStats = {
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

// 决议 #105：终态集合（completed/failed/cancelled/interrupted）——除 start 外不可变
export function isTerminalStatus(status: ResearchTask['status']): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  );
}

// 决议 #105：start 合法状态 = created/cancelled/failed/interrupted
// （completed 不可 start——Result 已持久化，重新研究 = 新建任务）
export function canStart(status: ResearchTask['status']): boolean {
  return (
    status === 'created' ||
    status === 'cancelled' ||
    status === 'failed' ||
    status === 'interrupted'
  );
}

function isValidNow(now: string): boolean {
  // 决议 #116：ISO 8601 时间戳为输入有效性约束（非仅查非空）
  return isIso8601Timestamp(now);
}

function isValidPhase(value: unknown): value is ResearchPhase {
  return typeof value === 'string' && (RESEARCH_PHASES as readonly string[]).includes(value);
}

function isValidErrorCode(value: unknown): value is ResearchErrorCode {
  return typeof value === 'string' && (RESEARCH_ERROR_CODES as readonly string[]).includes(value);
}

export function transitionTask(task: ResearchTask, event: ResearchTaskEvent): ResearchTask {
  // 未知/非法事件安全返回任务副本（不抛异常）；非法载荷同样零变化
  switch (event.kind) {
    case 'start':
      return handleStart(task, event.now);
    case 'phase':
      return handlePhase(task, event);
    case 'finish-done':
      return handleFinishDone(task, event);
    case 'finish-error':
      return handleFinishError(task, event);
    case 'finish-budget':
      return handleFinishBudget(task, event.now);
    case 'stop':
      return handleStop(task, event.now);
    case 'mark-interrupted':
      return handleMarkInterrupted(task, event.now);
    default:
      return { ...task };
  }
}

function handleStart(task: ResearchTask, now: string): ResearchTask {
  if (!isValidNow(now)) return { ...task };
  if (!canStart(task.status)) return { ...task }; // running/completed 零变化（互斥前置在 Service 层）
  // 决议 #106（纯函数部分）：restart 重置全部 run 字段；created 首次 start 同样走
  // 该重置（stats 初始即零，语义幂等）
  return {
    ...task,
    status: 'running',
    phase: 'planning',
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    interruptedAt: null,
    errorCode: null,
    resultId: null,
    stats: { ...ZERO_TASK_STATS },
  };
}

function handlePhase(
  task: ResearchTask,
  event: { phase: ResearchPhase; now: string },
): ResearchTask {
  if (!isValidNow(event.now)) return { ...task };
  if (!isValidPhase(event.phase)) return { ...task };
  if (task.status !== 'running') return { ...task };
  return { ...task, phase: event.phase, updatedAt: event.now };
}

function handleFinishDone(
  task: ResearchTask,
  event: { resultId: string; now: string },
): ResearchTask {
  if (!isValidNow(event.now)) return { ...task };
  if (typeof event.resultId !== 'string' || event.resultId.trim() === '') return { ...task };
  if (task.status !== 'running') return { ...task };
  return {
    ...task,
    status: 'completed',
    phase: null,
    resultId: event.resultId,
    finishedAt: event.now,
    updatedAt: event.now,
  };
}

function handleFinishError(
  task: ResearchTask,
  event: { errorCode: ResearchErrorCode; now: string },
): ResearchTask {
  if (!isValidNow(event.now)) return { ...task };
  if (!isValidErrorCode(event.errorCode)) return { ...task };
  if (task.status !== 'running') return { ...task };
  return {
    ...task,
    status: 'failed',
    phase: null,
    errorCode: event.errorCode,
    finishedAt: event.now,
    updatedAt: event.now,
  };
}

function handleFinishBudget(task: ResearchTask, now: string): ResearchTask {
  if (!isValidNow(now)) return { ...task };
  if (task.status !== 'running') return { ...task };
  return {
    ...task,
    status: 'failed',
    phase: null,
    errorCode: 'research-budget-exhausted',
    finishedAt: now,
    updatedAt: now,
  };
}

function handleStop(task: ResearchTask, now: string): ResearchTask {
  if (!isValidNow(now)) return { ...task };
  if (task.status !== 'running') return { ...task };
  return {
    ...task,
    status: 'cancelled',
    phase: null,
    finishedAt: now,
    updatedAt: now,
  };
}

function handleMarkInterrupted(task: ResearchTask, now: string): ResearchTask {
  if (!isValidNow(now)) return { ...task };
  if (task.status !== 'running') return { ...task };
  return {
    ...task,
    status: 'interrupted',
    phase: null,
    interruptedAt: now,
    updatedAt: now,
  };
}
