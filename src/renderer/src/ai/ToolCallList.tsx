import { useState } from 'react';
import type { AgentStepEvent } from '../../../shared/types/agent';
import { TOOL_DECISION_LABELS, TOOL_ERROR_LABELS } from './agent-display';

interface ToolCallListProps {
  steps: AgentStepEvent[]; // 事件顺序渐进追加（reducer 已按 toolCallId 去重）
}

// 本次 run 的工具调用条目（A6，§11.2）：按事件顺序渐进追加；每步展示工具名、安全参数
// 摘要（主进程审计同源生成，渲染层不解析 arguments）、结果摘要、decision/errorCode。
// 六值 ToolStepDecision 含 invalid；失败/denied/forbidden/invalid 以失败样式呈现，
// 不可被颜色或文案伪装成成功；fill 原文与内部能力参数永不渲染（argsSummary 已脱敏）。
export function ToolCallList({ steps }: ToolCallListProps) {
  const [collapsed, setCollapsed] = useState(false);
  if (steps.length === 0) return null;
  return (
    <div className="ai-tool-calls">
      <div className="ai-tool-calls-header">
        <span>工具调用（{steps.length}）</span>
        <button
          type="button"
          className="ai-tool-calls-toggle"
          aria-label={collapsed ? '展开工具调用列表' : '折叠工具调用列表'}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? '展开' : '折叠'}
        </button>
      </div>
      {!collapsed && (
        <ol className="ai-tool-call-items">
          {steps.map(({ step, argsSummary }) => {
            const failure =
              !step.ok ||
              step.decision === 'denied' ||
              step.decision === 'forbidden' ||
              step.decision === 'invalid';
            return (
              <li
                key={step.toolCallId}
                className="ai-tool-call-item"
                data-tool-call-id={step.toolCallId}
              >
                <div className="ai-tool-call-line">
                  <span className="ai-tool-call-name">{step.name}</span>
                  <span
                    className={`ai-tool-call-decision ai-decision-${step.decision}${failure ? ' ai-decision-failure' : ''}`}
                  >
                    {TOOL_DECISION_LABELS[step.decision]}
                  </span>
                  <span className={`ai-tool-call-ok${failure ? ' ai-tool-call-ok-failure' : ''}`}>
                    {step.ok ? '成功' : '失败'}
                  </span>
                </div>
                <div className="ai-tool-call-args">{argsSummary}</div>
                {step.errorCode !== undefined && (
                  <div className="ai-tool-call-error">
                    {TOOL_ERROR_LABELS[step.errorCode] ?? step.errorCode}
                  </div>
                )}
                <div className="ai-tool-call-preview" title={step.contentPreview}>
                  {step.contentPreview}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
