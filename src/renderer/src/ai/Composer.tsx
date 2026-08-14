import { useState } from 'react';
import type { KeyboardEvent } from 'react';

interface ComposerProps {
  disabled: boolean; // 无当前会话 → 禁用发送
  busy: boolean; // 同一会话在途（共读流式或 Agent run）→ 禁用发送（每会话单在途互斥）
  showAbort: boolean; // 显示中止/停止按钮
  abortLabel: '中止' | '停止'; // 共读=中止；Agent run=停止
  note: string | null; // 附加提示（如任务模式下共读回答生成中）
  errorMessage: string | null; // ask/agentAsk 同步拒绝（busy/not-found/参数无效）
  onSend: (text: string) => void;
  onAbort: () => void;
}

// 输入区（§11.3 + A6 §11.2）：textarea，Enter 发送 / Shift+Enter 换行；对话与任务模式
// 共用同一输入框（发送走不同通道）；在途时显示「中止」（共读流）/「停止」（Agent run）
// 按钮。发送由 AiPanel 经 bridge 调用 conversation.ask/agentAsk（长度由 main 侧截断）。
// 同一会话 busy 时发送禁用（主进程每会话单在途 + UI 侧互斥双保险）。
export function Composer({
  disabled,
  busy,
  showAbort,
  abortLabel,
  note,
  errorMessage,
  onSend,
  onAbort,
}: ComposerProps) {
  const [draft, setDraft] = useState('');

  const submit = (): void => {
    const text = draft.trim();
    if (text === '' || disabled || busy) return;
    onSend(text);
    setDraft('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault(); // Enter 发送；Shift+Enter 走默认换行
      submit();
    }
  };

  const placeholder = disabled
    ? '请先新建或选择会话'
    : '输入问题或任务目标（Enter 发送，Shift+Enter 换行）';

  return (
    <div className="ai-composer">
      {errorMessage !== null && <div className="ai-error-line">{errorMessage}</div>}
      <textarea
        className="ai-composer-textarea"
        rows={3}
        placeholder={placeholder}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="ai-composer-actions">
        {showAbort ? (
          <button type="button" className="ai-abort" onClick={onAbort}>
            {abortLabel}
          </button>
        ) : (
          <button
            type="button"
            className="ai-send"
            disabled={disabled || busy || draft.trim() === ''}
            onClick={submit}
          >
            发送
          </button>
        )}
      </div>
      {note !== null && <div className="ai-composer-note">{note}</div>}
    </div>
  );
}
