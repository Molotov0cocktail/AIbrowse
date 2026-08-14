import { useEffect, useRef } from 'react';
import type { ConversationMessage } from '../../../shared/types/conversation';
import { AGENT_RUN_STATUS_LABELS, TOOL_DECISION_LABELS, TOOL_ERROR_LABELS } from './agent-display';
import { ERROR_CODE_LABELS } from './error-labels';
import { CitationCard } from './CitationCard';
import type { StreamState } from './stream-state';

interface ChatViewProps {
  history: ConversationMessage[];
  stream: StreamState;
  currentSessionId: string | null;
  agentActive: boolean; // 当前会话 Agent run 进行中（流式气泡标记过程性输出）
}

// 消息流（§8.1/§11.3 + A6 §11.2）：delta 追加的气泡由 useStream 状态渲染（仅当前会话
// 在途时展示）；终态消息由 useConversation 历史收敛。回答纯文本 pre-wrap 渲染——不引入
// Markdown 库；Agent 轮次文本为过程性输出，状态栏相位给出确定性标记；ToolStep 消息
// （ConversationStore v2 持久化 role='tool'）渲染为紧凑条目——只使用持久化的
// contentPreview/decision/errorCode，不显示 UNTRUSTED_TOOL_RESULT 包装原文/完整
// ToolResult/fill 值；assistant agentRun 消息展示 run 终态标记（run.status 权威文案）。
export function ChatView({ history, stream, currentSessionId, agentActive }: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // 新内容到达即滚到底部（简单跟随，无动画——面板不做动画，§11.2）
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [history, stream.text, stream.status]);

  const streamingVisible =
    stream.status === 'streaming' &&
    stream.sessionId === currentSessionId &&
    stream.sessionId !== null;

  return (
    <div className="ai-messages" ref={scrollRef}>
      {history.length === 0 && !streamingVisible && (
        <p className="ai-empty-hint">输入问题或任务目标，与 AI 助手协作</p>
      )}
      {history.map((message) => {
        if (message.role === 'tool') {
          return <ToolStepItem key={message.id} message={message} />;
        }
        return (
          <div key={message.id} className={`ai-message ai-message-${message.role}`}>
            {message.role === 'user' && message.contextSource !== undefined && (
              <CitationCard source={message.contextSource} />
            )}
            <div className="ai-message-content">{message.content}</div>
            {message.role === 'assistant' && message.agentRun !== undefined && (
              <div className={`ai-status ai-agent-run ai-agent-run-${message.agentRun.status}`}>
                任务{AGENT_RUN_STATUS_LABELS[message.agentRun.status]}（{message.agentRun.stepsUsed}
                /{message.agentRun.maxSteps} 步）
              </div>
            )}
            {message.role === 'assistant' && message.status === 'aborted' && (
              <div className="ai-status ai-status-aborted">已中止</div>
            )}
            {message.role === 'assistant' && message.status === 'error' && (
              <div className="ai-status ai-status-error">
                {message.errorCode !== undefined
                  ? (ERROR_CODE_LABELS[message.errorCode] ?? '生成失败')
                  : '生成失败'}
              </div>
            )}
          </div>
        );
      })}
      {streamingVisible && (
        <div className="ai-message ai-message-assistant">
          <div className="ai-message-content ai-message-streaming">
            {stream.text === '' ? '…' : stream.text}
          </div>
          {agentActive && <div className="ai-status ai-agent-process">任务进行中（过程输出）</div>}
        </div>
      )}
    </div>
  );
}

// ToolStep v2 持久化消息紧凑条目（A6，§11.2）：只渲染持久化精简字段——
// contentPreview（fill 值已脱敏为「（已输入 N 字符）」）/decision 六值/errorCode；
// 不展开 UNTRUSTED_TOOL_RESULT 包装原文/完整 ToolResult/fill 值/内部能力参数。
function ToolStepItem({ message }: { message: ConversationMessage }) {
  const step = message.toolStep;
  if (step === undefined) return null; // v1/畸形消息由 store 解析层丢弃，此处防御
  const failure =
    !step.ok ||
    step.decision === 'denied' ||
    step.decision === 'forbidden' ||
    step.decision === 'invalid';
  return (
    <div className="ai-message ai-message-tool" data-tool-step-id={step.toolCallId}>
      <div className="ai-tool-step-line">
        <span className="ai-tool-step-name">{step.name}</span>
        <span
          className={`ai-tool-step-decision ai-decision-${step.decision}${failure ? ' ai-decision-failure' : ''}`}
        >
          {TOOL_DECISION_LABELS[step.decision]}
        </span>
      </div>
      {step.errorCode !== undefined && (
        <div className="ai-tool-step-error">
          {TOOL_ERROR_LABELS[step.errorCode] ?? step.errorCode}
        </div>
      )}
      <div className="ai-tool-step-preview">{step.contentPreview}</div>
    </div>
  );
}
