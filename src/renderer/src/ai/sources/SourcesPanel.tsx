import { useEffect, useState } from 'react';
import type { SourceListItem, SourceView } from '../../../../shared/types/sources';
import { useSourcesPanel, type SourcesGroupFilter } from './useSourcesPanel';
import { HardDeleteDialog } from './HardDeleteDialog';
import { SourceAddForm } from './SourceAddForm';
import { SourceDetailForm } from './SourceDetailForm';
import {
  QUICK_ADD_RELATED_TITLE,
  describeSourcesState,
  shareModeLabel,
  sourcesStateAdvice,
  trustFullLabel,
} from './sources-display';

// Sources 面板（B5，决议 #68/#74/#78）：与 AiPanel 并列切换（App 级 sidePanel
// 'ai'|'sources' 互斥；App 级 Agent ConfirmDialog 不受面板切换影响）。恢复态/
// 不可用态显示中文原因 + 建议并禁用全部写入口（canWrite 消费）；本地明文边界
// 如实说明（「备注与网址以明文保存在本机」）；note/name/tag 全部 React 纯文本
// 渲染（无 dangerouslySetInnerHTML/Markdown/富文本）。
interface SourcesPanelProps {
  onCollapse: () => void;
}

export function SourcesPanel({ onCollapse }: SourcesPanelProps) {
  const panel = useSourcesPanel();
  const [showAddForm, setShowAddForm] = useState(false);
  const [hardDeleteTarget, setHardDeleteTarget] = useState<{
    source: SourceView;
    token: string;
  } | null>(null);

  // 详情对象被刷新/删除后，对话框目标可能已失效：目标 id 不在当前详情时自动关闭
  useEffect(() => {
    if (
      hardDeleteTarget !== null &&
      (panel.detail === null || panel.detail.id !== hardDeleteTarget.source.id)
    ) {
      setHardDeleteTarget(null);
    }
  }, [panel.detail, hardDeleteTarget]);

  const busy = panel.pendingOp !== null;

  const openHardDelete = (source: SourceView): void => {
    void panel.prepareHardDelete(source.id).then((res) => {
      if (res.ok) setHardDeleteTarget({ source, token: res.token });
    });
  };

  const confirmHardDelete = (): void => {
    if (hardDeleteTarget === null) return;
    const target = hardDeleteTarget;
    setHardDeleteTarget(null); // 确认一次提交即关闭（双击受控）
    void panel.hardDelete(target.source.id, target.token);
  };

  const totalPages =
    panel.list !== null && panel.list.ok
      ? Math.max(1, Math.ceil(panel.list.total / panel.list.pageSize))
      : 1;

  return (
    <aside className="sources-panel">
      <div className="sources-panel-header">
        <span className="sources-panel-title">信源</span>
        <button
          type="button"
          className="sources-quick-add"
          disabled={busy || !panel.canWrite}
          onClick={() => void panel.quickAdd()}
        >
          快速添加当前页
        </button>
        <button
          type="button"
          className="sources-add-open"
          disabled={busy || !panel.canWrite}
          onClick={() => setShowAddForm(true)}
        >
          添加
        </button>
        <button
          type="button"
          className="sources-refresh"
          aria-label="刷新信源列表"
          onClick={() => panel.refreshAll()}
        >
          刷新
        </button>
        {/* B7 决议 #91：FTS 诊断性 rebuild——仅 normal 状态可触发（canWrite 门控 +
            main 适配器门控双保险）；重复点击由 write 互斥受控 */}
        <button
          type="button"
          className="sources-rebuild-index"
          disabled={busy || !panel.canWrite}
          onClick={() => void panel.rebuildIndex()}
        >
          重建索引
        </button>
        <button
          type="button"
          className="sources-collapse"
          aria-label="收起信源面板"
          onClick={onCollapse}
        >
          收起
        </button>
      </div>

      {/* 决议 #74：恢复态/不可用态中文原因 + 建议；写入口全部禁用（canWrite） */}
      {panel.state !== null && describeSourcesState(panel.state) !== null && (
        <div className="sources-state-banner">
          <div className="sources-state-reason">{describeSourcesState(panel.state)}</div>
          <div className="sources-state-advice">{sourcesStateAdvice(panel.state)}</div>
        </div>
      )}

      {/* 本地明文边界如实说明（§11/Fourth_stage §3.6） */}
      <div className="sources-plaintext-note">
        说明：信源的网址、分组、标签与备注以明文保存在本机（依赖操作系统用户权限保护，不承诺静态加密）。
      </div>

      {panel.quickAddMessage !== null && (
        <div className="sources-quick-add-message">
          {panel.quickAddMessage}
          {panel.quickAddRelated.length > 0 && (
            <div className="sources-related">
              <span className="sources-related-title">{QUICK_ADD_RELATED_TITLE}</span>
              <ul className="sources-related-list">
                {panel.quickAddRelated.map((item) => (
                  <li key={item.id} className="sources-related-item">
                    {item.name}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {panel.notice !== null && <div className="sources-notice">{panel.notice}</div>}

      {showAddForm ? (
        <SourceAddForm
          canWrite={panel.canWrite}
          pendingOp={panel.pendingOp}
          onSubmit={(input) => {
            void panel.add(input).then(() => {
              setShowAddForm(false);
            });
          }}
          onCancel={() => setShowAddForm(false)}
        />
      ) : panel.detail !== null ? (
        <>
          <SourceDetailForm
            key={`${panel.detail.id}:${panel.detail.version}`} // 版本变化重挂载：表单与最新数据同步（保存/冲突刷新后不残留旧草稿）
            source={panel.detail}
            pendingOp={panel.pendingOp}
            canWrite={panel.canWrite}
            onSave={(payload) => void panel.update(payload)}
            onToggleEnabled={() =>
              void (
                panel.detail !== null &&
                (panel.detail.enabled
                  ? panel.disable(panel.detail.id, panel.detail.version)
                  : panel.restore(panel.detail.id, panel.detail.version))
              )
            }
            onDelete={() => openHardDelete(panel.detail!)}
            onBack={() => panel.closeDetail()}
          />
          <UndoList panel={panel} />
        </>
      ) : (
        <>
          <div className="sources-toolbar">
            <span className="sources-view-switch" role="group" aria-label="信源视图">
              <button
                type="button"
                className={`sources-view-browse${!panel.searchMode ? ' active' : ''}`}
                onClick={() => panel.setSearchMode(false)}
              >
                浏览
              </button>
              <button
                type="button"
                className={`sources-view-search${panel.searchMode ? ' active' : ''}`}
                onClick={() => panel.setSearchMode(true)}
              >
                搜索
              </button>
            </span>
            {panel.searchMode ? (
              <input
                type="text"
                className="sources-search-input"
                placeholder="按名称/网址/标签/分组/备注搜索"
                value={panel.searchQuery}
                onChange={(e) => panel.setSearchQuery(e.target.value)}
              />
            ) : (
              <select
                className="sources-group-filter"
                aria-label="分组筛选"
                value={filterKey(panel.groupFilter)}
                onChange={(e) => panel.setGroupFilter(parseFilter(e.target.value, panel))}
              >
                <option value="all">全部分组</option>
                <option value="ungrouped">未分组</option>
                {panel.groups !== null &&
                  panel.groups.ok &&
                  panel.groups.groups.map((g) => (
                    <option key={g.id} value={`group:${g.id}`}>
                      {g.name}
                    </option>
                  ))}
              </select>
            )}
          </div>
          {panel.searchMode ? (
            <SearchResults panel={panel} onOpen={(id) => panel.openDetail(id)} />
          ) : (
            <SourceList panel={panel} onOpen={(id) => panel.openDetail(id)} />
          )}
          {!panel.searchMode && (
            <div className="sources-pagination">
              <button
                type="button"
                className="sources-prev"
                disabled={panel.page === 0}
                onClick={() => panel.setPage(Math.max(0, panel.page - 1))}
              >
                上一页
              </button>
              <span className="sources-page-info">
                {panel.page + 1}/{totalPages}（共{' '}
                {panel.list !== null && panel.list.ok ? panel.list.total : 0} 条）
              </span>
              <button
                type="button"
                className="sources-next"
                disabled={panel.page + 1 >= totalPages}
                onClick={() => panel.setPage(panel.page + 1)}
              >
                下一页
              </button>
            </div>
          )}
          <UndoList panel={panel} />
        </>
      )}

      {hardDeleteTarget !== null && (
        <div className="sources-dialog-overlay">
          <HardDeleteDialog
            sourceName={hardDeleteTarget.source.name}
            pending={busy}
            onCancel={() => setHardDeleteTarget(null)}
            onConfirm={confirmHardDelete}
          />
        </div>
      )}
    </aside>
  );
}

// 分组筛选值编码（select 值 ↔ filter 状态映射）
function filterKey(filter: SourcesGroupFilter): string {
  return filter.kind === 'all'
    ? 'all'
    : filter.kind === 'ungrouped'
      ? 'ungrouped'
      : `group:${filter.groupId}`;
}

function parseFilter(key: string, panel: ReturnType<typeof useSourcesPanel>): SourcesGroupFilter {
  if (key === 'ungrouped') return { kind: 'ungrouped' };
  if (key.startsWith('group:')) {
    const groupId = key.slice('group:'.length);
    const group =
      panel.groups !== null && panel.groups.ok
        ? panel.groups.groups.find((g) => g.id === groupId)
        : undefined;
    return { kind: 'group', groupId, groupName: group?.name ?? '' };
  }
  return { kind: 'all' };
}

function SourceList({
  panel,
  onOpen,
}: {
  panel: ReturnType<typeof useSourcesPanel>;
  onOpen: (id: string) => void;
}) {
  const items: SourceListItem[] = panel.list !== null && panel.list.ok ? panel.list.items : [];
  if (panel.list !== null && !panel.list.ok) {
    return <div className="sources-list-empty">信源数据暂不可用</div>;
  }
  if (items.length === 0) {
    return <div className="sources-list-empty">暂无信源（可用「快速添加当前页」收藏当前网页）</div>;
  }
  return (
    <div className="sources-list">
      {items.map((item) => (
        <div key={item.id} className={`sources-item${item.enabled ? '' : ' disabled'}`}>
          <button type="button" className="sources-item-name" onClick={() => onOpen(item.id)}>
            {item.name}
          </button>
          <div className="sources-item-url">{item.url}</div>
          <div className="sources-item-meta">
            {item.groupName !== null && <span className="sources-badge">{item.groupName}</span>}
            <span className="sources-badge">{shareModeLabel(item.shareMode)}</span>
            <span className="sources-badge">{trustFullLabel(item.trust)}</span>
            {!item.enabled && <span className="sources-badge">已禁用</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function SearchResults({
  panel,
  onOpen,
}: {
  panel: ReturnType<typeof useSourcesPanel>;
  onOpen: (id: string) => void;
}) {
  if (panel.searchQuery.trim() === '' || panel.searchResult === null) {
    return <div className="sources-list-empty">输入关键词搜索信源</div>;
  }
  if (!panel.searchResult.ok) {
    return <div className="sources-list-empty">搜索失败（信源数据暂不可用）</div>;
  }
  if (panel.searchResult.results.length === 0) {
    return <div className="sources-list-empty">未找到匹配的信源</div>;
  }
  return (
    <div className="sources-list">
      {panel.searchResult.results.map((item) => (
        <div key={item.id} className={`sources-item${item.enabled ? '' : ' disabled'}`}>
          <button type="button" className="sources-item-name" onClick={() => onOpen(item.id)}>
            {item.name}
          </button>
          <div className="sources-item-url">{item.url}</div>
          <div className="sources-item-meta">
            {item.groupName !== null && <span className="sources-badge">{item.groupName}</span>}
            <span className="sources-badge">{shareModeLabel(item.shareMode)}</span>
            <span className="sources-badge">{trustFullLabel(item.trust)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function UndoList({ panel }: { panel: ReturnType<typeof useSourcesPanel> }) {
  if (!panel.canWrite) return null; // 恢复态/不可用态：Undo 为写操作，不展示入口
  if (panel.undoable.length === 0) return null;
  return (
    <div className="sources-undo-list">
      <div className="sources-undo-title">最近变更（可撤销）</div>
      {panel.undoable.map((change) => (
        <div key={change.idempotencyKey} className="sources-undo-item">
          <span className="sources-undo-summary">{change.summary}</span>
          <button
            type="button"
            className="sources-undo-btn"
            disabled={panel.pendingOp !== null}
            onClick={() => void panel.undo(change.idempotencyKey)}
          >
            撤销
          </button>
        </div>
      ))}
    </div>
  );
}
