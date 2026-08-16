import type { Ref } from 'react';
import type { TabInfo } from '../../../shared/types/browser';
import { AddressBar } from './AddressBar';

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
  addressBarRef: Ref<HTMLInputElement>;
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
  addressBarRef,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      <button type="button" className="nav-button" aria-label="后退" title="后退" onClick={onBack}>
        ←
      </button>
      <button
        type="button"
        className="nav-button"
        aria-label="前进"
        title="前进"
        onClick={onForward}
      >
        →
      </button>
      <button
        type="button"
        className="nav-button"
        aria-label="刷新"
        title="刷新"
        onClick={onReload}
      >
        ↻
      </button>
      <AddressBar ref={addressBarRef} activeTab={activeTab} onNavigate={onNavigate} />
      <button
        type="button"
        className="nav-button ai-toggle"
        aria-label="AI 侧栏"
        title="AI 侧栏"
        onClick={onToggleAiPanel}
      >
        AI
      </button>
      <button
        type="button"
        className="nav-button sources-toggle"
        aria-label="信源面板"
        title="信源面板"
        onClick={onToggleSourcesPanel}
      >
        信源
      </button>
      <button
        type="button"
        className="nav-button research-toggle"
        aria-label="研究面板"
        title="研究面板"
        onClick={onToggleResearchPanel}
      >
        研究
      </button>
      <button
        type="button"
        className="nav-button new-tab"
        aria-label="新建标签页"
        title="新建标签页"
        onClick={onCreateTab}
      >
        ＋
      </button>
    </div>
  );
}
