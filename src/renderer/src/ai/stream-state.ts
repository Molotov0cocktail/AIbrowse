// Pure streaming-state reducer for the AI panel (unit-tested; zero React/Electron deps).
// Contract: doc/stage2/detailed-design.md §8.1/§8.3 — delta 逐块追加（不聚合）、turn-done
// 终态恰好一次（complete 全文 / aborted 保留部分 / error 保留部分+错误文案）、requestId
// 不匹配的事件按竞态残留忽略。状态机不可变更新，useStream 以 useReducer 接入。
import type {
  ConversationMessage,
  NormalizedProviderError,
} from '../../../shared/types/conversation';

export interface StreamState {
  requestId: string | null; // 在途生成（null = 空闲）
  sessionId: string | null; // 在途生成所属会话（ChatView 据此决定是否展示该气泡）
  text: string; // 已累计回答文本（turn-done 后为终态全文）
  status: 'idle' | 'streaming' | 'done';
  doneStatus: ConversationMessage['status'] | null; // 收敛后的终态标记
  errorMessage: string | null; // ask 同步拒绝 / 终态错误文案（下次 start 清空）
}

export type StreamEvent =
  | { type: 'start'; requestId: string; sessionId: string }
  | { type: 'chunk'; requestId: string; delta: string }
  | {
      type: 'turn-done';
      requestId: string;
      message: ConversationMessage;
      error: NormalizedProviderError | null;
    }
  | { type: 'rejected'; message: string }; // ask 同步拒绝（busy/not-found/参数无效）

export const INITIAL_STREAM_STATE: StreamState = {
  requestId: null,
  sessionId: null,
  text: '',
  status: 'idle',
  doneStatus: null,
  errorMessage: null,
};

export function reduceStream(state: StreamState, event: StreamEvent): StreamState {
  switch (event.type) {
    case 'start':
      // 新一轮生成：重置上一轮终态/错误文案
      return {
        requestId: event.requestId,
        sessionId: event.sessionId,
        text: '',
        status: 'streaming',
        doneStatus: null,
        errorMessage: null,
      };
    case 'chunk':
      // 竞态残留（requestId 不匹配 / 已终态）→ 忽略，不污染当前轮文本
      if (state.status !== 'streaming' || state.requestId !== event.requestId) return state;
      return { ...state, text: state.text + event.delta };
    case 'turn-done':
      if (state.requestId !== event.requestId) return state; // 他轮/他会话终态 → 忽略
      return {
        ...state,
        text: event.message.content, // 终态全文为准（aborted/error 保留部分，§8.3）
        status: 'done',
        doneStatus: event.message.status,
        errorMessage: event.error?.message ?? null,
      };
    case 'rejected':
      // 在途时到达的拒绝为竞态残留（每会话单在途），忽略
      if (state.status === 'streaming') return state;
      return { ...state, errorMessage: event.message };
  }
}
