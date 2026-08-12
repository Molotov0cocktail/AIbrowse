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
  addressBarRef: Ref<HTMLInputElement>;
}

// 顶部工具栏（First_stage §六）：后退/前进/刷新/地址栏/新建标签页。
// 导航动作由 App 统一以活动 Tab 为对象调用 bridge（UI → BrowserController 分层）。
export function Toolbar({
  activeTab,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onCreateTab,
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
