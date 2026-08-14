import { useCallback, useEffect, useReducer } from 'react';
import type {
  AgentConfirmRequest,
  AgentRunDoneEvent,
  AgentStatusEvent,
  AgentStepEvent,
} from '../../../shared/types/agent';
import type { AskResult } from '../../../shared/types/conversation';
import { INITIAL_AGENT_RUNS_STATE, reduceAgentRuns, type AgentRunsState } from './agent-run-state';

// Agent 运行状态订阅（A6，§11.2）：纯 reducer（agent-run-state）+ 四个事件通道订阅
// （preload 内同一通道只注册一次 ipcRenderer 监听，卸载时退订——eventRelay 模式）。
// 全部事件字段来自主进程确定性运行事实；本 hook 只做转发与本地 UI 事实（start/stop）。
export interface UseAgentResult {
  agentState: AgentRunsState;
  // 任务模式发送：goal 校验/截断由 main 侧执行；同步拒绝（busy/not-found/internal）
  // 记录为错误文案（在途时到达的拒绝为竞态残留，reducer 忽略）
  startTask: (sessionId: string, goal: string) => Promise<AskResult>;
  // L2 确认决定：approve 只对精确 toolCallId 生效一次（ConfirmManager 幂等保证）
  confirmTool: (toolCallId: string, approve: boolean) => Promise<boolean>;
  // 停止：使用 agentAsk 返回的真实 requestId 调 abort；点击后进入「正在停止」，
  // 收到权威 run-done 后才进入终态（reducer stop-requested → stopping）
  stopRun: (sessionId: string, requestId: string) => void;
}

export function useAgent(): UseAgentResult {
  const [agentState, dispatch] = useReducer(reduceAgentRuns, INITIAL_AGENT_RUNS_STATE);

  useEffect(() => {
    const unsubStep = window.aibrowse.conversation.onAgentStep((e: AgentStepEvent) => {
      dispatch({ type: 'step', event: e });
    });
    const unsubConfirm = window.aibrowse.conversation.onAgentConfirmRequest(
      (e: AgentConfirmRequest) => {
        dispatch({ type: 'confirm', event: e });
      },
    );
    const unsubRunDone = window.aibrowse.conversation.onAgentRunDone((e: AgentRunDoneEvent) => {
      dispatch({ type: 'run-done', event: e });
    });
    const unsubStatus = window.aibrowse.conversation.onAgentStatus((e: AgentStatusEvent) => {
      dispatch({ type: 'status', event: e });
    });
    return () => {
      unsubStep();
      unsubConfirm();
      unsubRunDone();
      unsubStatus();
    };
  }, []);

  const startTask = useCallback(async (sessionId: string, goal: string): Promise<AskResult> => {
    const result = await window.aibrowse.conversation.agentAsk(sessionId, goal);
    if (result.ok) {
      dispatch({ type: 'start', sessionId, requestId: result.requestId });
    } else {
      dispatch({ type: 'rejected', sessionId, message: result.error.message });
    }
    return result;
  }, []);

  const confirmTool = useCallback(
    (toolCallId: string, approve: boolean): Promise<boolean> =>
      window.aibrowse.conversation.confirmTool(toolCallId, approve),
    [],
  );

  const stopRun = useCallback((sessionId: string, requestId: string): void => {
    dispatch({ type: 'stop-requested', sessionId });
    void window.aibrowse.conversation.abort(requestId); // 幂等；无匹配在途 → false 安全忽略
  }, []);

  return { agentState, startTask, confirmTool, stopRun };
}
