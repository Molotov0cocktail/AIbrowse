import { useCallback, useEffect, useReducer } from 'react';
import { INITIAL_STREAM_STATE, reduceStream, type StreamState } from './stream-state';

// 流式状态订阅（§8.1）：requestId → delta 追加 reducer（纯函数可测）+ turn-done 收敛。
// 事件经 preload 白名单订阅（同一通道 preload 内只注册一次 ipcRenderer 监听），
// 卸载时退订；跨会话/跨轮的竞态残留事件由 reducer 忽略。
export interface UseStreamResult {
  stream: StreamState;
  startStreaming: (requestId: string, sessionId: string) => void;
  rejectStream: (message: string) => void;
}

export function useStream(): UseStreamResult {
  const [stream, dispatch] = useReducer(reduceStream, INITIAL_STREAM_STATE);

  useEffect(() => {
    const unsubChunk = window.aibrowse.conversation.onStreamChunk((e) => {
      dispatch({ type: 'chunk', requestId: e.requestId, delta: e.delta });
    });
    const unsubDone = window.aibrowse.conversation.onTurnDone((e) => {
      dispatch({ type: 'turn-done', requestId: e.requestId, message: e.message, error: e.error });
    });
    return () => {
      unsubChunk();
      unsubDone();
    };
  }, []);

  const startStreaming = useCallback((requestId: string, sessionId: string): void => {
    dispatch({ type: 'start', requestId, sessionId });
  }, []);
  const rejectStream = useCallback((message: string): void => {
    dispatch({ type: 'rejected', message });
  }, []);

  return { stream, startStreaming, rejectStream };
}
