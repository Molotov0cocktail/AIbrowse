import { useState } from 'react';
import type { ConversationSession } from '../../../shared/types/conversation';
import { useConversation } from './useConversation';
import { useStream } from './useStream';
import { ChatView } from './ChatView';
import { Composer } from './Composer';
import { ContextBadge } from './ContextBadge';
import { ProviderSettings } from './ProviderSettings';

interface AiPanelProps {
  onCollapse: () => void;
}

// AI 侧栏（§11.1/§11.3）：header（新建/会话列表/删除/不保存开关/设置/收起）+
// ContextBadge + ChatView + Composer。面板定宽 380px、默认收起、不持久化、无拖拽/动画
// （App 层控制开/关状态，§11.2）；回答纯文本渲染（ChatView 内 pre-wrap，无 Markdown 库）。
export function AiPanel({ onCollapse }: AiPanelProps) {
  const {
    sessions,
    currentSessionId,
    history,
    createSession,
    selectSession,
    deleteSession,
    setCurrentEphemeral,
    noteQuestionAsked,
  } = useConversation();
  const { stream, startStreaming, rejectStream } = useStream();
  const [showSettings, setShowSettings] = useState(false);

  const currentSession = sessions.find((session) => session.id === currentSessionId) ?? null;

  const send = (question: string): void => {
    if (currentSessionId === null) return;
    void window.aibrowse.conversation.ask(currentSessionId, question).then((result) => {
      if (result.ok) {
        startStreaming(result.requestId, currentSessionId);
        // 乐观追加 user 消息（引用链先于生成落地——生成失败时追溯卡片依然可见；
        // contextSource 由 turn-done 补全，§6.1）
        noteQuestionAsked({
          id: crypto.randomUUID(),
          role: 'user',
          content: question,
          createdAt: Date.now(),
          status: 'complete',
        });
      } else {
        rejectStream(result.error.message);
      }
    });
  };

  const abort = (): void => {
    if (stream.status === 'streaming' && stream.requestId !== null) {
      void window.aibrowse.conversation.abort(stream.requestId);
    }
  };

  return (
    <aside className="ai-panel">
      <div className="ai-panel-header">
        <span className="ai-panel-title">AI 共读助手</span>
        <button type="button" className="ai-new-session" onClick={() => void createSession()}>
          新建会话
        </button>
        <button type="button" className="ai-settings-open" onClick={() => setShowSettings(true)}>
          设置
        </button>
        <button
          type="button"
          className="ai-collapse"
          aria-label="收起 AI 面板"
          onClick={onCollapse}
        >
          收起
        </button>
      </div>

      {showSettings ? (
        <ProviderSettings onClose={() => setShowSettings(false)} />
      ) : (
        <>
          <SessionList
            sessions={sessions}
            currentSessionId={currentSessionId}
            currentEphemeral={currentSession?.ephemeral ?? false}
            onSelect={(id) => void selectSession(id)}
            onDelete={(id) => void deleteSession(id)}
            onToggleEphemeral={(ephemeral) => void setCurrentEphemeral(ephemeral)}
          />
          <ContextBadge />
          <ChatView history={history} stream={stream} currentSessionId={currentSessionId} />
          <Composer
            disabled={currentSessionId === null}
            streaming={stream.status === 'streaming'}
            errorMessage={stream.errorMessage}
            onSend={send}
            onAbort={abort}
          />
        </>
      )}
    </aside>
  );
}

interface SessionListProps {
  sessions: ConversationSession[];
  currentSessionId: string | null;
  currentEphemeral: boolean;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onToggleEphemeral: (ephemeral: boolean) => void;
}

// 会话列表（§11.3）：切换/删除/「不保存」开关。列表顺序 = list() 返回（新→旧，
// 服务端契约），渲染层不重排。
function SessionList({
  sessions,
  currentSessionId,
  currentEphemeral,
  onSelect,
  onDelete,
  onToggleEphemeral,
}: SessionListProps) {
  if (sessions.length === 0) {
    return <div className="ai-session-list ai-session-empty">暂无会话，点击「新建会话」开始</div>;
  }
  return (
    <div className="ai-session-list">
      {sessions.map((session) => {
        const active = session.id === currentSessionId;
        return (
          <div key={session.id} className={`ai-session-item${active ? ' active' : ''}`}>
            <button type="button" className="ai-session-title" onClick={() => onSelect(session.id)}>
              {session.title}
            </button>
            {session.ephemeral && <span className="ai-session-flag">不保存</span>}
            {active && (
              <button
                type="button"
                className="ai-session-ephemeral"
                aria-label={currentEphemeral ? '改为保存' : '改为不保存'}
                onClick={() => onToggleEphemeral(!currentEphemeral)}
              >
                {currentEphemeral ? '改为保存' : '不保存'}
              </button>
            )}
            <button
              type="button"
              className="ai-session-delete"
              aria-label="删除会话"
              onClick={() => onDelete(session.id)}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
