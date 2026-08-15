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
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

// Deterministic calendar helpers（决议 #116 二次补修）：日历字段合法性不得依赖
// Date.parse 自动回滚判定。
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(month: number, leapYear: boolean): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return leapYear ? 29 : 28;
    default:
      return 0;
  }
}

// 决议 #116：now 的 ISO 8601 输入有效性约束（确定性纯函数）。调用方仅
// ResearchService.nowIso 与 research-store 装配（恒 new Date(ms).toISOString()）。
// 注：此处用 String.match 而非正则对象的 exec 方法——语义相同，且本模块零
// SQL，避免 SRT-12 静态审计的 SQL 形态误报（审计白名单无需为此放宽）。
export function isIso8601Timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.match(ISO_8601_TIMESTAMP_RE);
  if (match === null) return false;
  const [, y, mo, d, h, mi, s, ms, zone] = match;
  // 决议 #116 二次补修：先做确定性日历字段校验（年月日时分秒 + 偏移边界），
  // 不依赖 Date.parse 自动回滚判定日历合法性。偏移形态的值级往返对已成功解析
  // 的时间近似恒真，无法甄别 JS 日期回滚（2026-02-30+08:00 →
  // 2026-03-01T16:00:00.000Z）；24:00 与闰秒 60 不属既有语法范围。日历字段
  // 判定为纯范围判定、不参与本地时区（下方 Date 仅作可解析/往返纵深，不参与
  // 字段判定）。
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(month, isLeapYear(year))) return false;
  if (Number(h) > 23) return false;
  if (Number(mi) > 59) return false;
  if (Number(s) > 59) return false;
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    // 既有偏移格式边界保持（Date.parse 实测接受 ±HH:MM 且 HH≤23、MM≤59；
    // ±24:00 / +14:60 为 NaN）——不收缩、不扩张
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  if (zone === 'Z') {
    // Z 形态做字符串级日历往返校验（拒绝 2026-02-30 等 JS 回滚形态）；
    // 毫秒位补齐至 .sss 后与 toISOString 恒等
    const normalized = `${y}-${mo}-${d}T${h}:${mi}:${s}.${(ms ?? '').padEnd(3, '0')}Z`;
    return new Date(parsed).toISOString() === normalized;
  }
  // 偏移形态：值级往返（纵深防御——日历合法性已由上方确定性字段校验保证）
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
