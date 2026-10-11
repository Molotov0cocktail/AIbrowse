import type { Ref } from 'react';
import type { TabInfo } from '../../../shared/types/browser';
import { AddressBar } from './AddressBar';
import { Icon } from '../ui/Icon';

interface ToolbarProps {
  activeTab: TabInfo | null;
  onNavigate: (input: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onCreateTab: () => void;
  onToggleAiPanel: () => void;
  onToggleSourcesPanel: () => void; // B5：信源面板开关（与 AI 面板互斥，决议 #68）
  onToggleResearchPanel: () => void; // C8 决议 #163(1)：研究面板（三态互斥）
  onToggleDiagnostics: () => void;
  onOpenWatch: () => void;
  onWatchCurrentPage: () => void;
  addressBarRef: Ref<HTMLInputElement>;
  activePanel?: 'ai' | 'sources' | 'research' | 'diagnostics' | null;
  watchActive?: boolean;
}

// 顶部工具栏（First_stage §六）：后退/前进/刷新/地址栏/新建标签页 + AI 侧栏开关（S4）。
// 导航动作由 App 统一以活动 Tab 为对象调用 bridge（UI → BrowserController 分层）。
export function Toolbar({
  activeTab,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onCreateTab,
  onToggleAiPanel,
  onToggleSourcesPanel,
  onToggleResearchPanel,
  onToggleDiagnostics,
  onOpenWatch,
  onWatchCurrentPage,
  addressBarRef,
  activePanel = null,
  watchActive = false,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      <div className="nav-controls" role="group" aria-label="网页导航">
        <button
          type="button"
          className="nav-button"
          aria-label="后退"
          title="后退"
          onClick={onBack}
        >
          <Icon name="arrow-left" />
          <span className="toolbar-label">后退</span>
        </button>
        <button
          type="button"
          className="nav-button"
          aria-label="前进"
          title="前进"
          onClick={onForward}
        >
          <Icon name="arrow-right" />
          <span className="toolbar-label">前进</span>
        </button>
        <button
          type="button"
          className="nav-button"
          aria-label="刷新"
          title="刷新"
          onClick={onReload}
        >
          <Icon name="refresh" />
          <span className="toolbar-label">刷新</span>
        </button>
      </div>
      <div className="address-field">
        <Icon name="globe" />
        <AddressBar ref={addressBarRef} activeTab={activeTab} onNavigate={onNavigate} />
      </div>
      <div className="page-actions" role="group" aria-label="当前网页操作">
        <button
          type="button"
          className="nav-button watch-current"
          aria-label="监控此页"
          title="监控此页"
          onClick={onWatchCurrentPage}
        >
          <Icon name="activity" />
          <span className="toolbar-label">监控此页</span>
        </button>
        <button
          type="button"
          className="nav-button new-tab"
          aria-label="新建标签页"
          title="新建标签页"
          onClick={onCreateTab}
        >
          <Icon name="plus" />
          <span className="toolbar-label">新建标签页</span>
        </button>
      </div>
      <nav className="workspace-nav" aria-label="工作区">
        <button
          type="button"
          className="nav-button ai-toggle"
          aria-label="AI 侧栏"
          title="AI 侧栏"
          onClick={onToggleAiPanel}
          aria-pressed={activePanel === 'ai'}
        >
          <Icon name="sparkles" />
          <span className="toolbar-label">AI</span>
        </button>
        <button
          type="button"
          className="nav-button sources-toggle"
          aria-label="信源面板"
          title="信源面板"
          onClick={onToggleSourcesPanel}
          aria-pressed={activePanel === 'sources'}
        >
          <Icon name="bookmark" />
          <span className="toolbar-label">信源</span>
        </button>
        <button
          type="button"
          className="nav-button research-toggle"
          aria-label="研究面板"
          title="研究面板"
          onClick={onToggleResearchPanel}
          aria-pressed={activePanel === 'research'}
        >
          <Icon name="research" />
          <span className="toolbar-label">研究</span>
        </button>
        <button
          type="button"
          className="nav-button watch-open"
          aria-label="监控工作区"
          title="监控工作区"
          onClick={onOpenWatch}
          aria-pressed={watchActive}
        >
          <Icon name="activity" />
          <span className="toolbar-label">监控</span>
        </button>
        <button
          type="button"
          className="nav-button"
          aria-label="诊断信息"
          title="诊断信息"
          onClick={onToggleDiagnostics}
          aria-pressed={activePanel === 'diagnostics'}
        >
          <Icon name="settings" />
          <span className="toolbar-label">诊断</span>
        </button>
      </nav>
    </div>
  );
}
