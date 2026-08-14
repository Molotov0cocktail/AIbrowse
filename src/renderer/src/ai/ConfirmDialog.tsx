import { useEffect, useRef, useState } from 'react';
import type { AgentConfirmRequest } from '../../../shared/types/agent';
import { sanitizeConfirmText, toolActionLabel } from './agent-display';

interface ConfirmDialogProps {
  pending: AgentConfirmRequest | null; // 全局唯一 pending（ConfirmManager 单 pending 事实）
  onDecide: (toolCallId: string, approve: boolean) => Promise<boolean>;
}

// L2 确认对话框（A6，§11.2 + threat-model §3.3/§5 + 强制核查三信任边界）：
// - 只展示确定性事实：工具名/动作类型/目标 URL/权限原因为程序常量；elementText 为
//   「页面提供的目标文本（不可信）」——纯文本渲染（无 dangerouslySetInnerHTML/Markdown/
//   富文本解析），经 sanitizeConfirmText 剔除控制字符/双向控制符并截断，原始值不进 DOM 属性；
// - 「拒绝」默认高亮 + 默认焦点：Enter 只激活焦点按钮（默认拒绝），不存在未明确聚焦
//   允许按钮时批准；Escape = 拒绝；approve 只对精确 toolCallId 生效一次（main 幂等），
//   提交后按钮立即禁用；无「始终允许/本次会话全部允许/自动批准」；
// - pending 作废（run 取消/超时/终结/决议）由 reducer 清空 → 本组件自动关闭；
//   confirmTool 返回 false 时显示「该确认已失效」，绝不显示「已允许」。
export function ConfirmDialog({ pending, onDecide }: ConfirmDialogProps) {
  const [submitted, setSubmitted] = useState(false);
  const [failed, setFailed] = useState(false);
  const denyRef = useRef<HTMLButtonElement>(null);

  // pending 变化时重置提交态（新请求可正常决议）
  useEffect(() => {
    setSubmitted(false);
    setFailed(false);
  }, [pending?.toolCallId]);

  // 拒绝为默认焦点（Enter 默认拒绝）
  useEffect(() => {
    if (pending !== null && !submitted) denyRef.current?.focus();
  }, [pending, submitted]);

  if (pending === null) return null;

  const decide = (approve: boolean): void => {
    if (submitted) return;
    setSubmitted(true);
    void onDecide(pending.toolCallId, approve).then((ok) => {
      if (!ok) setFailed(true); // 迟到/已终结决议：不显示「已允许」，标记已失效
    });
  };

  return (
    <div className="ai-confirm-overlay" role="presentation">
      <div className="ai-confirm-dialog" role="dialog" aria-modal="true" aria-label="工具执行确认">
        <h3 className="ai-confirm-title">需要你的确认</h3>
        <div className="ai-confirm-body">
          <div className="ai-confirm-line">
            <span className="ai-confirm-label">工具</span>
            <span className="ai-confirm-value">{pending.toolName}</span>
          </div>
          <div className="ai-confirm-line">
            <span className="ai-confirm-label">动作</span>
            <span className="ai-confirm-value">{toolActionLabel(pending.toolName)}</span>
          </div>
          {pending.summary.url !== undefined && pending.summary.url !== '' && (
            <div className="ai-confirm-line">
              <span className="ai-confirm-label">目标站点</span>
              <span className="ai-confirm-value ai-confirm-url">
                {sanitizeConfirmText(pending.summary.url, 300)}
              </span>
            </div>
          )}
          {pending.summary.elementText !== undefined && pending.summary.elementText !== '' && (
            <div className="ai-confirm-line">
              <span className="ai-confirm-label">目标元素</span>
              <span className="ai-confirm-value ai-confirm-element-text">
                {sanitizeConfirmText(pending.summary.elementText)}
              </span>
              <span className="ai-confirm-source">（页面提供，仅供参考）</span>
            </div>
          )}
          <div className="ai-confirm-line">
            <span className="ai-confirm-label">原因</span>
            <span className="ai-confirm-value">
              {sanitizeConfirmText(pending.summary.detail, 200)}
            </span>
          </div>
        </div>
        {failed && (
          <div className="ai-confirm-failed">该确认已失效（可能已被拒绝或任务已结束）</div>
        )}
        <div
          className="ai-confirm-actions"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              decide(false);
            }
          }}
        >
          <button
            type="button"
            ref={denyRef}
            className="ai-confirm-deny"
            disabled={submitted}
            onClick={() => decide(false)}
          >
            拒绝
          </button>
          <button
            type="button"
            className="ai-confirm-approve"
            disabled={submitted}
            onClick={() => decide(true)}
          >
            允许一次
          </button>
        </div>
      </div>
    </div>
  );
}
