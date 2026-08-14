import { useTabsState } from '../browser/useTabsState';
import { describeAgentStatus } from './agent-display';
import type { AgentRunEntry } from './agent-run-state';

interface AgentStatusBarProps {
  entry: AgentRunEntry | null;
}

// Agent 状态栏（A6，§11.2 + Third_stage.md §4）：只显示确定性事实——状态相位/当前工具/
// stepsUsed/maxSteps 来自主进程状态事件；当前页面来自既有可信 Tab 状态订阅
// （tabs:updated 全量推送），不从模型文本提取。不展示模型思维过程；「正在停止」为
// UI 事实（run-done 到达前不伪装 cancelled）。
export function AgentStatusBar({ entry }: AgentStatusBarProps) {
  const tabsState = useTabsState(); // 既有可信订阅（preload eventRelay，可多监听者）
  const activeTab =
    tabsState === null
      ? null
      : (tabsState.tabs.find((t) => t.id === tabsState.activeTabId) ?? null);
  const statusText = entry === null ? '暂无任务' : describeAgentStatus(entry);
  const pageLabel =
    activeTab === null || activeTab.title === '' ? '（无页面）' : ` · ${activeTab.title}`;
  return (
    <div className="ai-agent-status" data-agent-status={entry?.status ?? 'idle'}>
      <span className="ai-agent-status-text">{statusText}</span>
      <span className="ai-agent-status-page" title={activeTab?.url ?? undefined}>
        {pageLabel}
      </span>
    </div>
  );
}
