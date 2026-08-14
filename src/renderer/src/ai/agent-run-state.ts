// Agent 运行状态纯 reducer（A6，unit-tested；零 React/Electron 依赖）。契约源：
// doc/stage3/detailed-design.md §11.2 + 用户开工要求（事件充分性核查结论）：
// - 状态按 sessionId 键控（多会话并行 run 互不串扰；切换会话不丢后台 run、不串状态）；
// - 事件按 requestId 校验（旧 run/错误会话事件忽略）；run-done 幂等；
// - 终态后迟到 status/step/confirm 一律忽略（不得把终态改回 running）；
// - starting 状态事件可先于本地 start 到达（agentAsk 同步段发出）——作为程序事实收养 run；
// - 新 run 不继承旧 run 的 pending/steps/终止理由；step 按 toolCallId 去重；
// - 确认作废（confirm-resolved）与 run 终态收敛；停止按钮为「正在停止」非终态。
// 全部事件字段来自主进程确定性运行事实——本模块不做任何本地猜测/补全。
import type {
  AgentConfirmRequest,
  AgentConfirmOutcome,
  AgentRunDoneEvent,
  AgentRunSummary,
  AgentStatusEvent,
  AgentStatusPhase,
  AgentStepEvent,
} from '../../../shared/types/agent';
import type { ConversationMessage } from '../../../shared/types/conversation';

export type AgentRunUiStatus = 'idle' | 'running' | 'stopping' | 'terminal';

export interface AgentRunEntry {
  sessionId: string;
  requestId: string | null; // null = 尚未建立（仅 rejected 文案条目）
  status: AgentRunUiStatus;
  phase: AgentStatusPhase | null; // 最近一次状态相位（程序事实）
  toolName: string | null; // executing/waiting-confirm 的当前工具名
  stepsUsed: number; // 最近一次携带的 A5 实际计数（starting 恒 0）
  maxSteps: number;
  confirmOutcome: AgentConfirmOutcome | null; // 最近一次确认决议（approve/deny/cancelled）
  pendingConfirm: AgentConfirmRequest | null; // 全局唯一 pending（ConfirmManager 单 pending）
  steps: AgentStepEvent[]; // 渐进追加（toolCallId 去重）
  terminal: AgentRunSummary | null; // run-done 后：权威终止理由（run.status）
  terminalMessage: ConversationMessage | null; // run-done 携带的终态 assistant 消息（finalText）
  errorMessage: string | null; // agentAsk 同步拒绝文案 / 终态归一化错误文案
}

export interface AgentRunsState {
  runs: Record<string, AgentRunEntry>;
}

export const INITIAL_AGENT_RUNS_STATE: AgentRunsState = { runs: {} };

export type AgentRunEvent =
  | { type: 'start'; sessionId: string; requestId: string } // agentAsk ok 后本地登记
  | { type: 'rejected'; sessionId: string; message: string } // agentAsk 同步拒绝（busy/not-found/internal）
  | { type: 'stop-requested'; sessionId: string } // 用户点击停止（UI 事实；非终态）
  | { type: 'status'; event: AgentStatusEvent }
  | { type: 'step'; event: AgentStepEvent }
  | { type: 'confirm'; event: AgentConfirmRequest }
  | { type: 'run-done'; event: AgentRunDoneEvent };

function freshEntry(sessionId: string, requestId: string): AgentRunEntry {
  return {
    sessionId,
    requestId,
    status: 'running',
    phase: null,
    toolName: null,
    stepsUsed: 0,
    maxSteps: 0,
    confirmOutcome: null,
    pendingConfirm: null,
    steps: [],
    terminal: null,
    terminalMessage: null,
    errorMessage: null,
  };
}

function idleEntry(sessionId: string, errorMessage: string): AgentRunEntry {
  return {
    ...freshEntry(sessionId, ''),
    requestId: null,
    status: 'idle',
    errorMessage,
  };
}

// 状态事件合并：携带字段覆盖（未携带字段保留最近一次权威值——confirm-resolved 不携带
// 计数时 UI 保留最近计数，不猜测）
function applyStatus(entry: AgentRunEntry, e: AgentStatusEvent): AgentRunEntry {
  const next: AgentRunEntry = {
    ...entry,
    phase: e.phase,
    ...(e.toolName !== undefined ? { toolName: e.toolName } : {}),
    ...(e.stepsUsed !== undefined ? { stepsUsed: e.stepsUsed } : {}),
    ...(e.maxSteps !== undefined ? { maxSteps: e.maxSteps } : {}),
  };
  if (e.phase === 'confirm-resolved') {
    next.pendingConfirm = null; // 决议/作废 → 确认框自动关闭
    if (e.confirmOutcome !== undefined) next.confirmOutcome = e.confirmOutcome;
  }
  return next;
}

export function reduceAgentRuns(state: AgentRunsState, event: AgentRunEvent): AgentRunsState {
  switch (event.type) {
    case 'start': {
      const existing = state.runs[event.sessionId];
      if (existing !== undefined && existing.requestId === event.requestId) return state; // 幂等
      return {
        runs: {
          ...state.runs,
          [event.sessionId]: freshEntry(event.sessionId, event.requestId),
        },
      };
    }
    case 'rejected': {
      const existing = state.runs[event.sessionId];
      // 在途时到达的拒绝为竞态残留（每会话单在途），忽略；否则记录失败文案
      if (
        existing !== undefined &&
        (existing.status === 'running' || existing.status === 'stopping')
      ) {
        return state;
      }
      return {
        runs: { ...state.runs, [event.sessionId]: idleEntry(event.sessionId, event.message) },
      };
    }
    case 'status': {
      const e = event.event;
      const existing = state.runs[e.sessionId];
      if (e.phase === 'starting') {
        // run 已启动是程序事实（先于本地 start 到达）→ 收养/重建（终态后 = 新 run）
        if (
          existing !== undefined &&
          existing.status === 'running' &&
          existing.requestId !== e.requestId
        ) {
          return state; // 每会话单在途：running 中出现异 requestId 的 starting 属异常，防御忽略
        }
        return {
          runs: {
            ...state.runs,
            [e.sessionId]: applyStatus(freshEntry(e.sessionId, e.requestId), e),
          },
        };
      }
      if (existing === undefined) return state; // 未知会话的非 starting 状态 → 忽略
      if (existing.status === 'terminal') return state; // 终态后迟到状态 → 忽略（不得改回 running）
      if (existing.requestId !== null && e.requestId !== existing.requestId) return state; // 旧 run
      return { runs: { ...state.runs, [e.sessionId]: applyStatus(existing, e) } };
    }
    case 'step': {
      const e = event.event;
      const existing = state.runs[e.sessionId];
      if (existing === undefined) return state;
      if (existing.status === 'terminal') return state; // 终态后迟到 step → 忽略
      if (existing.requestId !== null && e.requestId !== existing.requestId) return state; // 旧 run
      if (existing.steps.some((s) => s.step.toolCallId === e.step.toolCallId)) return state; // id 去重
      const pendingConfirm =
        existing.pendingConfirm !== null && existing.pendingConfirm.toolCallId === e.step.toolCallId
          ? null // 纵深防御：步骤完成其确认请求时同步清空
          : existing.pendingConfirm;
      return {
        runs: {
          ...state.runs,
          [e.sessionId]: { ...existing, pendingConfirm, steps: [...existing.steps, e] },
        },
      };
    }
    case 'confirm': {
      const e = event.event;
      const existing = state.runs[e.sessionId];
      if (existing === undefined) return state;
      if (existing.status === 'terminal') return state; // 终态后迟到 confirm → 忽略
      if (existing.requestId !== null && e.requestId !== existing.requestId) return state; // 旧 run
      return {
        runs: {
          ...state.runs,
          [e.sessionId]: {
            ...existing,
            phase: 'waiting-confirm',
            toolName: e.toolName,
            pendingConfirm: e,
          },
        },
      };
    }
    case 'stop-requested': {
      const existing = state.runs[event.sessionId];
      // 只在活动 run 可停止：running → stopping（「正在停止」非终态；双击/终态/空闲忽略）
      if (existing === undefined || existing.status !== 'running') return state;
      return {
        runs: { ...state.runs, [event.sessionId]: { ...existing, status: 'stopping' } },
      };
    }
    case 'run-done': {
      const e = event.event;
      const existing = state.runs[e.sessionId];
      if (existing === undefined) return state;
      if (existing.status === 'terminal') return state; // run-done 幂等（重复/迟到达忽略）
      if (existing.requestId !== null && e.requestId !== existing.requestId) return state; // 旧 run 终态
      return {
        runs: {
          ...state.runs,
          [e.sessionId]: {
            ...existing,
            status: 'terminal',
            phase: null,
            toolName: null,
            pendingConfirm: null, // 终态收敛：确认作废自动关闭
            confirmOutcome: null,
            terminal: e.run,
            terminalMessage: e.message,
            errorMessage: e.error?.message ?? null,
          },
        },
      };
    }
  }
}

// 当前会话的运行条目（会话切换后后台 run 的状态不串到当前会话——按 sessionId 精确选取）
export function runForSession(
  state: AgentRunsState,
  sessionId: string | null,
): AgentRunEntry | null {
  if (sessionId === null) return null;
  return state.runs[sessionId] ?? null;
}

// 全局确认请求（ConfirmManager 单 pending 的确定性事实）：确认 UI 全局跟随精确 pending
// ——不因切换会话/模式/折叠面板而不可访问（安全要求：L2 确认必须可达）。
export function globalPendingRequest(state: AgentRunsState): AgentConfirmRequest | null {
  for (const key of Object.keys(state.runs)) {
    const entry = state.runs[key];
    if (entry !== undefined && entry.pendingConfirm !== null) return entry.pendingConfirm;
  }
  return null;
}
