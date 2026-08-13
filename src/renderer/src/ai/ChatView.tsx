import { useEffect, useRef } from 'react';
import type { ConversationMessage } from '../../../shared/types/conversation';
import type { StreamState } from './stream-state';
import { ERROR_CODE_LABELS } from './error-labels';
import { CitationCard } from './CitationCard';

interface ChatViewProps {
  history: ConversationMessage[];
  stream: StreamState;
  currentSessionId: string | null;
}

// 消息流（§8.1/§11.3）：delta 追加的气泡由 useStream 状态渲染（仅当前会话在途时展示）；
// 终态消息由 useConversation 历史收敛。回答纯文本 pre-wrap 渲染——不引入 Markdown 库
// （非目标）；aborted/error 按状态标记（已中止/错误文案）。
export function ChatView({ history, stream, currentSessionId }: ChatViewProps) {
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
        <p className="ai-empty-hint">输入问题，围绕当前网页与 AI 对话</p>
      )}
      {history.map((message) => (
        <div key={message.id} className={`ai-message ai-message-${message.role}`}>
          {message.role === 'user' && message.contextSource !== undefined && (
            <CitationCard source={message.contextSource} />
          )}
          <div className="ai-message-content">{message.content}</div>
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
      ))}
      {streamingVisible && (
        <div className="ai-message ai-message-assistant">
          <div className="ai-message-content ai-message-streaming">
            {stream.text === '' ? '…' : stream.text}
          </div>
        </div>
      )}
    </div>
  );
}
