import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type {
  ConversationMessage,
  ConversationSession,
  TurnDoneEvent,
} from '../../../shared/types/conversation';
import { reduceHistory } from './history-events';

// 会话状态管理（§11.3）：会话列表/当前会话/历史镜像。初始列出会话并选中最新一条
// （无会话时保持空——由用户显式「新建会话」，不自动创建）；ask 时乐观追加 user 消息
// （引用链先于生成落地，失败时追溯卡片依然可见）；turn-done 补全 contextSource 并
// 追加终态 assistant 消息（非当前会话的终态忽略——重新选中时 getHistory 返回磁盘真值）。
export interface UseConversationResult {
  sessions: ConversationSession[];
  currentSessionId: string | null;
  history: ConversationMessage[];
  refreshSessions: () => Promise<void>;
  createSession: () => Promise<void>;
  selectSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  setCurrentEphemeral: (ephemeral: boolean) => Promise<void>;
  noteQuestionAsked: (message: ConversationMessage) => void;
  // A6：重新拉取当前会话磁盘真值（Agent run 终态后刷新——含全部轮次与 ToolStep 消息；
  // reduceHistory 按消息 id 去重防御与 turn-done 事件的竞态）
  refreshHistory: () => Promise<void>;
}

export function useConversation(): UseConversationResult {
  const [sessions, setSessions] = useState<ConversationSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [history, dispatchHistory] = useReducer(reduceHistory, []);
  // 事件回调需要读最新 currentSessionId（闭包外置，避免重复订阅）
  const currentRef = useRef<string | null>(null);
  currentRef.current = currentSessionId;

  const refreshSessions = useCallback(async (): Promise<void> => {
    const list = await window.aibrowse.conversation.list();
    setSessions(list);
  }, []);

  // 初始：列出会话 → 选中最新一条并加载历史
  useEffect(() => {
    void (async () => {
      const list = await window.aibrowse.conversation.list();
      setSessions(list);
      const first = list[0] ?? null;
      if (first !== null) {
        setCurrentSessionId(first.id);
        currentRef.current = first.id;
        const messages = await window.aibrowse.conversation.getHistory(first.id);
        dispatchHistory({ type: 'replace', messages: messages ?? [] });
      }
    })();
  }, []);

  // turn-done 收敛（非当前会话忽略；当前会话 → 补 contextSource + 追加终态消息）
  useEffect(() => {
    const unsubscribe = window.aibrowse.conversation.onTurnDone((e: TurnDoneEvent) => {
      if (e.sessionId !== currentRef.current) return;
      dispatchHistory({ type: 'turn-done', message: e.message, contextSource: e.contextSource });
    });
    return unsubscribe;
  }, []);

  const selectSession = useCallback(async (sessionId: string): Promise<void> => {
    if (sessionId === currentRef.current) return;
    setCurrentSessionId(sessionId);
    currentRef.current = sessionId;
    const messages = await window.aibrowse.conversation.getHistory(sessionId);
    dispatchHistory({ type: 'replace', messages: messages ?? [] });
  }, []);

  const createSession = useCallback(async (): Promise<void> => {
    const created = await window.aibrowse.conversation.create();
    if (created === null) return; // 决议 #19：达 50 会话上限拒绝新建（无提示通道，静默保持）
    await refreshSessions();
    await selectSession(created.id);
  }, [refreshSessions, selectSession]);

  const deleteSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const removed = await window.aibrowse.conversation.remove(sessionId);
      if (!removed) return;
      const list = await window.aibrowse.conversation.list(); // 单次拉取：更新列表 + 决定下一选中
      setSessions(list);
      if (sessionId === currentRef.current) {
        const next = list[0] ?? null;
        if (next === null) {
          setCurrentSessionId(null);
          currentRef.current = null;
          dispatchHistory({ type: 'replace', messages: [] });
        } else {
          await selectSession(next.id);
        }
      }
    },
    [selectSession],
  );

  const setCurrentEphemeral = useCallback(
    async (ephemeral: boolean): Promise<void> => {
      const sessionId = currentRef.current;
      if (sessionId === null) return;
      const ok = await window.aibrowse.conversation.setEphemeral(sessionId, ephemeral);
      if (ok) await refreshSessions();
    },
    [refreshSessions],
  );

  const noteQuestionAsked = useCallback((message: ConversationMessage): void => {
    dispatchHistory({ type: 'append-user', message });
  }, []);

  const refreshHistory = useCallback(async (): Promise<void> => {
    const sessionId = currentRef.current;
    if (sessionId === null) return;
    const messages = await window.aibrowse.conversation.getHistory(sessionId);
    if (currentRef.current === sessionId) {
      dispatchHistory({ type: 'replace', messages: messages ?? [] });
    }
  }, []);

  return {
    sessions,
    currentSessionId,
    history,
    refreshSessions,
    createSession,
    selectSession,
    deleteSession,
    setCurrentEphemeral,
    noteQuestionAsked,
    refreshHistory,
  };
}
