import { useEffect, useState } from 'react';
import type { ConversationSession } from '../../../shared/types/conversation';
import { AgentStatusBar } from './AgentStatusBar';
import { ToolCallList } from './ToolCallList';
import { runForSession } from './agent-run-state';
import { useConversation } from './useConversation';
import type { UseAgentResult } from './useAgent';
import { useStream } from './useStream';
import { ChatView } from './ChatView';
import { Composer } from './Composer';
import { ContextBadge } from './ContextBadge';
import { ProviderSettings } from './ProviderSettings';

interface AiPanelProps {
  onCollapse: () => void;
  agent: UseAgentResult; // App 级 useAgent（确认对话框全局挂载需要同一状态源）
}

type PanelMode = 'chat' | 'task';

// AI 侧栏（§11.1/§11.3 + A6 §11.2）：header + 模式切换（对话/任务——仅渲染层状态，
// 不持久化）+ ContextBadge + ChatView + Composer。任务模式：AgentStatusBar +
// ToolCallList + 同一 textarea 发送走 agentAsk；停止按钮用 agentAsk 返回的真实
// requestId 调 abort（「正在停止」非终态）。共读 Composer 行为不变；模式切换/面板
// 折叠/会话切换不静默取消正在运行的 Agent（确认对话框在 App 级全局挂载，pending
// 不因切换而不可访问）。
export function AiPanel({ onCollapse, agent }: AiPanelProps) {
  const {
    sessions,
    currentSessionId,
    history,
    createSession,
    selectSession,
    deleteSession,
    setCurrentEphemeral,
    noteQuestionAsked,
    refreshHistory,
  } = useConversation();
  const { stream, startStreaming, rejectStream } = useStream();
  const [showSettings, setShowSettings] = useState(false);
  const [mode, setMode] = useState<PanelMode>('chat');

  const currentSession = sessions.find((session) => session.id === currentSessionId) ?? null;
  const agentEntry = runForSession(agent.agentState, currentSessionId);
  const agentActive =
    agentEntry !== null && (agentEntry.status === 'running' || agentEntry.status === 'stopping');
  const chatStreaming = stream.status === 'streaming' && stream.sessionId === currentSessionId;

  // Agent run 终态后刷新历史镜像（磁盘真值含全部轮次与 ToolStep 消息；reduceHistory
  // 按消息 id 去重防御与 turn-done 的竞态——不重复 assistant 气泡）
  const terminalRequest = agentEntry?.status === 'terminal' ? agentEntry.requestId : null;
  useEffect(() => {
    if (terminalRequest === null) return;
    void refreshHistory();
  }, [terminalRequest, refreshHistory]);

  const sendChat = (question: string): void => {
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

  const sendTask = (goal: string): void => {
    if (currentSessionId === null) return;
    // 任务模式发送：goal 校验/截断由 main 侧执行；reducer 记录同步拒绝文案。
    // Agent 的流式 delta 走既有 conversation:stream-chunk 通道（全部轮次过程性输出，
    // turn-done 收敛为终态全文 finalText——与共读同一 stream-state 纪律）
    void agent.startTask(currentSessionId, goal).then((result) => {
      if (result.ok) {
        startStreaming(result.requestId, currentSessionId);
        // 乐观追加 goal user 消息（与共读同纪律：引用链先于生成落地）
        noteQuestionAsked({
          id: crypto.randomUUID(),
          role: 'user',
          content: goal,
          createdAt: Date.now(),
          status: 'complete',
        });
      }
    });
  };

  const abortChat = (): void => {
    if (stream.status === 'streaming' && stream.requestId !== null) {
      void window.aibrowse.conversation.abort(stream.requestId);
    }
  };

  const stopTask = (): void => {
    if (agentEntry !== null && agentEntry.requestId !== null && agentActive) {
      agent.stopRun(agentEntry.sessionId, agentEntry.requestId);
    }
  };

  return (
    <aside className="ai-panel">
      <div className="ai-panel-header">
        <span className="ai-panel-title">AI 共读助手</span>
        <span className="ai-mode-switch" role="group" aria-label="AI 模式">
          <button
            type="button"
            className={`ai-mode-chat${mode === 'chat' ? ' active' : ''}`}
            onClick={() => setMode('chat')}
          >
            对话
          </button>
          <button
            type="button"
            className={`ai-mode-task${mode === 'task' ? ' active' : ''}`}
            onClick={() => setMode('task')}
          >
            任务
          </button>
        </span>
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
          {mode === 'task' && (
            <>
              <AgentStatusBar entry={agentEntry} />
              <ToolCallList steps={agentEntry?.steps ?? []} />
            </>
          )}
          <ChatView
            history={history}
            stream={stream}
            currentSessionId={currentSessionId}
            agentActive={agentActive}
          />
          <Composer
            disabled={currentSessionId === null}
            // 同一会话 busy 时不能重复发起共读或 Agent（主进程每会话单在途 + UI 侧禁用）
            busy={chatStreaming || agentActive}
            // Agent run 进行中显示「停止」；仅共读流时显示「中止」；Agent 进行中在对话
            // 模式不显示中止按钮（停止入口在任务模式——不静默取消 Agent）
            showAbort={agentActive || chatStreaming}
            abortLabel={agentActive ? '停止' : '中止'}
            note={
              mode === 'task' && chatStreaming && !agentActive ? '共读回答生成中，请稍候' : null
            }
            errorMessage={
              mode === 'task' ? (agentEntry?.errorMessage ?? null) : stream.errorMessage
            }
            onSend={mode === 'task' ? sendTask : sendChat}
            onAbort={agentActive ? stopTask : abortChat}
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
