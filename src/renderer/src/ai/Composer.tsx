import { useState } from 'react';
import type { KeyboardEvent } from 'react';

interface ComposerProps {
  disabled: boolean; // 无当前会话 → 禁用发送
  streaming: boolean; // 在途生成 → 显示「中止」按钮
  errorMessage: string | null; // ask 同步拒绝（busy/not-found/参数无效）
  onSend: (question: string) => void;
  onAbort: () => void;
}

// 输入区（§11.3）：textarea，Enter 发送 / Shift+Enter 换行；生成中显示「中止」按钮。
// 发送由 AiPanel 经 bridge 调用 conversation.ask（question 长度由 main 侧按 §4.1 截断）。
export function Composer({ disabled, streaming, errorMessage, onSend, onAbort }: ComposerProps) {
  const [draft, setDraft] = useState('');

  const submit = (): void => {
    const question = draft.trim();
    if (question === '' || disabled || streaming) return;
    onSend(question);
    setDraft('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault(); // Enter 发送；Shift+Enter 走默认换行
      submit();
    }
  };

  return (
    <div className="ai-composer">
      {errorMessage !== null && <div className="ai-error-line">{errorMessage}</div>}
      <textarea
        className="ai-composer-textarea"
        rows={3}
        placeholder={disabled ? '请先新建或选择会话' : '输入问题（Enter 发送，Shift+Enter 换行）'}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="ai-composer-actions">
        {streaming ? (
          <button type="button" className="ai-abort" onClick={onAbort}>
            中止
          </button>
        ) : (
          <button
            type="button"
            className="ai-send"
            disabled={disabled || draft.trim() === ''}
            onClick={submit}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}
