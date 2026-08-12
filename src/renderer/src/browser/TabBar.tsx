import type { TabInfo } from '../../../shared/types/browser';

interface TabBarProps {
  tabs: TabInfo[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
}

// 标签栏：显示标题（空标题兜底「新标签页」）、切换、关闭；活动 Tab 高亮，
// 加载中显示 spinner、加载失败红色标记（当前 Tab 状态明确可见，First_stage §六）。
export function TabBar({ tabs, activeTabId, onActivate, onClose }: TabBarProps) {
  return (
    <div className="tab-bar" role="tablist" aria-label="标签栏">
      {tabs.map((tab) => {
        const label = tab.title !== '' ? tab.title : '新标签页';
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeTabId}
            className={`tab${tab.id === activeTabId ? ' active' : ''}${tab.state === 'error' ? ' error' : ''}`}
            title={tab.title !== '' ? `${tab.title}\n${tab.url}` : tab.url}
            onClick={() => onActivate(tab.id)}
          >
            {tab.state === 'loading' && <span className="spinner" aria-label="加载中" />}
            {tab.state === 'error' && <span className="error-dot" aria-label="加载失败" />}
            <span className="tab-title">{label}</span>
            <button
              type="button"
              className="tab-close"
              aria-label={`关闭标签页 ${label}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
