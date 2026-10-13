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
  onToggleAiPanel: () => void;
  onToggleSourcesPanel: () => void; // B5：信源面板开关（与 AI 面板互斥，决议 #68）
  onToggleResearchPanel: () => void; // C8 决议 #163(1)：研究面板（三态互斥）
  onOpenWatch: () => void;
  onOpenHistory: () => void;
  onOpenBookmarks: () => void;
  onOpenSettings: () => void;
  onOpenTools?: () => void;
  onToggleBookmark: () => void;
  addressBarRef: Ref<HTMLInputElement>;
  activePanel?: 'ai' | 'sources' | 'research' | 'diagnostics' | null;
  watchActive?: boolean;
  bookmarked?: boolean;
}

// 顶部工具栏（First_stage §六）：后退/前进/刷新/地址栏/新建标签页 + AI 侧栏开关（S4）。
// 导航动作由 App 统一以活动 Tab 为对象调用 bridge（UI → BrowserController 分层）。
export function Toolbar({
  activeTab,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onToggleAiPanel,
  onToggleSourcesPanel,
  onToggleResearchPanel,
  onOpenWatch,
  onOpenHistory,
  onOpenBookmarks,
  onOpenSettings,
  onOpenTools,
  onToggleBookmark,
  addressBarRef,
  activePanel = null,
  watchActive = false,
  bookmarked = false,
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
        <button
          type="button"
          className={`address-bookmark${bookmarked ? ' saved' : ''}`}
          aria-label={bookmarked ? '移除当前页书签' : '将当前页加入书签'}
          title={bookmarked ? '移除当前页书签' : '将当前页加入书签'}
          onClick={onToggleBookmark}
        >
          <Icon name="bookmark" />
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
          className="nav-button history-open"
          aria-label="历史记录"
          title="历史记录"
          onClick={onOpenHistory}
        >
          <Icon name="clock" />
          <span className="toolbar-label">历史</span>
        </button>
        <button
          type="button"
          className="nav-button bookmarks-open"
          aria-label="书签"
          title="书签"
          onClick={onOpenBookmarks}
        >
          <Icon name="bookmark" />
          <span className="toolbar-label">书签</span>
        </button>
        {onOpenTools && (
          <button
            type="button"
            className="nav-button tools-open"
            aria-label="下载与脚本"
            title="IDM 下载与用户脚本"
            onClick={onOpenTools}
          >
            <Icon name="external-link" />
            <span className="toolbar-label">工具</span>
          </button>
        )}
        <button
          type="button"
          className="nav-button settings-open"
          aria-label="设置"
          title="设置"
          onClick={onOpenSettings}
        >
          <Icon name="settings" />
          <span className="toolbar-label">设置</span>
        </button>
      </nav>
    </div>
  );
}
