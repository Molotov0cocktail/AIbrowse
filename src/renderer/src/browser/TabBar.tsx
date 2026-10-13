import type { TabGroupInfo, TabInfo } from '../../../shared/types/browser';
import { buildTabBarLayout } from './tab-group-layout';
import './tab-groups.css';

interface TabBarProps {
  tabs: TabInfo[];
  activeTabId: string | null;
  groups?: TabGroupInfo[];
  userTabIds?: string[];
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReload: (tabId: string) => void;
  onToggleGroup?: (group: TabGroupInfo) => void;
  onEditGroup?: (groupId: string) => void;
  onEditTabGroup?: (tabId: string) => void;
}

// 标签栏：显示标题（空标题兜底「新标签页」）、切换、关闭；活动 Tab 高亮，
// 加载中显示 spinner、加载失败红色标记（当前 Tab 状态明确可见，First_stage §六）。
export function TabBar({
  tabs,
  activeTabId,
  groups,
  userTabIds,
  onActivate,
  onClose,
  onReload,
  onToggleGroup,
  onEditGroup,
  onEditTabGroup,
}: TabBarProps) {
  const layout = buildTabBarLayout(tabs, groups, userTabIds, activeTabId);
  const visibleTabs = layout.flatMap((item) => (item.kind === 'tab' ? [item.tab] : []));
  const editableTabs = userTabIds === undefined ? null : new Set(userTabIds);

  return (
    <div className="tab-bar" role="tablist" aria-label="标签栏">
      {layout.map((item) => {
        if (item.kind === 'group') {
          const { group } = item;
          return (
            <div
              key={`group-${group.id}`}
              className={`tab-group-header tab-group-color-${group.color}`}
              role="presentation"
            >
              <button
                type="button"
                className="tab-group-toggle"
                aria-expanded={!group.collapsed}
                aria-label={`${group.collapsed ? '展开' : '折叠'}分组 ${group.name}`}
                title={`${group.collapsed ? '展开' : '折叠'}分组`}
                onClick={() => onToggleGroup?.(group)}
              >
                <span className="tab-group-dot" aria-hidden="true" />
                <span className="tab-group-name">{group.name}</span>
                <span aria-hidden="true">{group.collapsed ? '›' : '⌄'}</span>
              </button>
              <button
                type="button"
                className="tab-group-edit"
                aria-label={`编辑分组 ${group.name}`}
                title="编辑分组"
                onClick={() => onEditGroup?.(group.id)}
              >
                ⋯
              </button>
            </div>
          );
        }

        const { tab } = item;
        const index = visibleTabs.findIndex((visible) => visible.id === tab.id);
        const label = tab.title !== '' ? tab.title : '新标签页';
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeTabId}
            tabIndex={tab.id === activeTabId ? 0 : -1}
            className={`tab${tab.id === activeTabId ? ' active' : ''}${tab.state === 'error' ? ' error' : ''}`}
            title={tab.title !== '' ? `${tab.title}\n${tab.url}` : tab.url}
            onClick={() => onActivate(tab.id)}
            onContextMenu={(event) => {
              if (editableTabs?.has(tab.id) !== true || onEditTabGroup === undefined) return;
              event.preventDefault();
              onEditTabGroup(tab.id);
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onActivate(tab.id);
                return;
              }
              const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
              if (offset === 0 || visibleTabs.length < 2) return;
              event.preventDefault();
              const nextIndex = (index + offset + visibleTabs.length) % visibleTabs.length;
              onActivate(visibleTabs[nextIndex]!.id);
              const tabElements =
                event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
              tabElements?.[nextIndex]?.focus();
            }}
          >
            {tab.state === 'loading' && <span className="spinner" aria-label="加载中" />}
            {tab.state === 'error' && (
              <span
                className="error-dot"
                aria-label={
                  tab.failure === 'renderer-gone' ? '网页已崩溃，其他标签页保留' : '网页加载失败'
                }
              />
            )}
            <span className="tab-title">{label}</span>
            {tab.state === 'error' && (
              <button
                type="button"
                title={
                  tab.failure === 'renderer-gone'
                    ? '网页已崩溃，其他标签页保留；本页未提交的表单可能丢失，点击重新加载'
                    : '网页未能加载，请检查网络或地址后重新加载'
                }
                aria-label={`重新加载标签页 ${label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onReload(tab.id);
                }}
              >
                重新加载
              </button>
            )}
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
