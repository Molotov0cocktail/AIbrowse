import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  BrowserBookmark,
  BrowserBookmarkGroup,
  BrowserHistoryEntry,
  BrowserLibraryCursor,
} from '../../../shared/types/browser-library';
import { Icon } from '../ui/Icon';
import { applyForCurrentLibraryView } from './view-epoch';

export type BrowserLibraryMode = 'history' | 'bookmarks';

interface BrowserLibraryPageProps {
  mode: BrowserLibraryMode;
  onModeChange: (mode: BrowserLibraryMode) => void;
  onBack: () => void;
  onOpenUrl: (url: string) => void;
  onBookmarksChanged: () => void;
}

type LibraryItem = BrowserHistoryEntry | BrowserBookmark;

function fixedError(mode: BrowserLibraryMode): string {
  return mode === 'history' ? '无法读取浏览历史，请稍后重试' : '无法读取书签，请稍后重试';
}

function isHistory(item: LibraryItem): item is BrowserHistoryEntry {
  return 'visitedAt' in item;
}

function displayTitle(item: LibraryItem): string {
  return item.title.trim() === '' ? item.url : item.title;
}

export function BrowserLibraryPage({
  mode,
  onModeChange,
  onBack,
  onOpenUrl,
  onBookmarksChanged,
}: BrowserLibraryPageProps) {
  const [revision, setRevision] = useState(0);
  const [groups, setGroups] = useState<BrowserBookmarkGroup[]>([]);
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<BrowserLibraryCursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [editing, setEditing] = useState<BrowserBookmark | null>(null);
  const requestVersion = useRef(0);
  const viewEpoch = useRef(0);

  const load = async (cursor: BrowserLibraryCursor | null): Promise<void> => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const request = { query, cursor, limit: 50 };
      const result =
        mode === 'history'
          ? await window.aibrowse.browserLibrary.listHistory(request)
          : await window.aibrowse.browserLibrary.listBookmarks({ ...request, groupId: null });
      const groupResult =
        mode === 'bookmarks' ? await window.aibrowse.browserLibrary.listBookmarkGroups() : null;
      if (version !== requestVersion.current) return;
      if (groupResult !== null) {
        if (!groupResult.ok) {
          setError(fixedError(mode));
          return;
        }
        setGroups(groupResult.value);
      }
      if (!result.ok) {
        setError(fixedError(mode));
        return;
      }
      setItems((previous) =>
        cursor === null ? result.value.items : [...previous, ...result.value.items],
      );
      setNextCursor(result.value.nextCursor);
    } catch {
      if (version === requestVersion.current) setError(fixedError(mode));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  };

  useEffect(() => {
    viewEpoch.current++;
    setItems([]);
    setGroups([]);
    setNextCursor(null);
    setConfirmClear(false);
    setEditing(null);
    void load(null);
  }, [mode, query]);

  const deleteItem = async (item: LibraryItem): Promise<void> => {
    const startedEpoch = viewEpoch.current;
    try {
      const result = isHistory(item)
        ? await window.aibrowse.browserLibrary.deleteHistory(item.id)
        : await window.aibrowse.browserLibrary.removeBookmark(item.id);
      if (!result.ok) {
        applyForCurrentLibraryView(viewEpoch.current, startedEpoch, () =>
          setError('删除未完成，请稍后重试'),
        );
        return;
      }
      applyForCurrentLibraryView(viewEpoch.current, startedEpoch, () =>
        setItems((current) => current.filter((candidate) => candidate.id !== item.id)),
      );
      if (!isHistory(item)) {
        onBookmarksChanged();
        applyForCurrentLibraryView(viewEpoch.current, startedEpoch, () => {
          setRevision((value) => value + 1);
          void load(null);
        });
      }
    } catch {
      applyForCurrentLibraryView(viewEpoch.current, startedEpoch, () =>
        setError('删除未完成，请稍后重试'),
      );
    }
  };

  const clearHistory = async (): Promise<void> => {
    const startedEpoch = viewEpoch.current;
    try {
      const result = await window.aibrowse.browserLibrary.clearHistory();
      if (!result.ok) {
        applyForCurrentLibraryView(viewEpoch.current, startedEpoch, () =>
          setError('清空历史记录未完成，请稍后重试'),
        );
        return;
      }
      applyForCurrentLibraryView(viewEpoch.current, startedEpoch, () => {
        setItems([]);
        setNextCursor(null);
        setConfirmClear(false);
      });
    } catch {
      applyForCurrentLibraryView(viewEpoch.current, startedEpoch, () =>
        setError('清空历史记录未完成，请稍后重试'),
      );
    }
  };

  const saveBookmark = async (): Promise<void> => {
    if (editing === null) return;
    const startedEpoch = viewEpoch.current;
    try {
      const result = await window.aibrowse.browserLibrary.updateBookmark({
        id: editing.id,
        url: editing.url,
        title: editing.title,
        groupId: editing.groupId,
      });
      if (!result.ok) {
        applyForCurrentLibraryView(viewEpoch.current, startedEpoch, () =>
          setError('书签修改未完成，请检查地址后重试'),
        );
        return;
      }
      if (result.value === null) {
        applyForCurrentLibraryView(viewEpoch.current, startedEpoch, () =>
          setError('该书签已不存在，请刷新后重试'),
        );
        return;
      }
      const updated = result.value;
      applyForCurrentLibraryView(viewEpoch.current, startedEpoch, () => {
        setItems((current) => current.map((item) => (item.id === editing.id ? updated : item)));
        setEditing(null);
      });
      onBookmarksChanged();
      applyForCurrentLibraryView(viewEpoch.current, startedEpoch, () => {
        setRevision((value) => value + 1);
        void load(null);
      });
    } catch {
      applyForCurrentLibraryView(viewEpoch.current, startedEpoch, () =>
        setError('书签修改未完成，请稍后重试'),
      );
    }
  };

  const renderItem = (item: LibraryItem) => (
    <li key={item.id} className="library-item">
      {editing?.id === item.id && !isHistory(item) ? (
        <div className="bookmark-editor">
          <label>
            <span>名称</span>
            <input
              maxLength={1000}
              value={editing.title}
              onChange={(event) => setEditing({ ...editing, title: event.target.value })}
            />
          </label>
          <label>
            <span>网址</span>
            <input
              maxLength={8192}
              value={editing.url}
              onChange={(event) => setEditing({ ...editing, url: event.target.value })}
            />
          </label>
          <label>
            <span>书签分组</span>
            <select
              value={editing.groupId ?? ''}
              onChange={(event) => setEditing({ ...editing, groupId: event.target.value || null })}
            >
              <option value="">未分组</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void saveBookmark()}>
            保存
          </button>
          <button type="button" onClick={() => setEditing(null)}>
            取消
          </button>
        </div>
      ) : (
        <>
          <button type="button" className="library-item-main" onClick={() => onOpenUrl(item.url)}>
            <span className="library-item-title">{displayTitle(item)}</span>
            <span className="library-item-url">{item.url}</span>
            <time dateTime={isHistory(item) ? item.visitedAt : item.updatedAt}>
              {new Date(isHistory(item) ? item.visitedAt : item.updatedAt).toLocaleString()}
            </time>
          </button>
          {!isHistory(item) && (
            <button type="button" onClick={() => setEditing(item)}>
              编辑
            </button>
          )}
          <button
            type="button"
            aria-label={`删除 ${displayTitle(item)}`}
            onClick={() => void deleteItem(item)}
          >
            删除
          </button>
        </>
      )}
    </li>
  );

  return (
    <div className="browser-library-page">
      <header className="workspace-page-header">
        <button type="button" className="workspace-page-back" onClick={onBack}>
          <Icon name="arrow-left" /> 返回浏览
        </button>
        <h1>浏览资料</h1>
      </header>
      <div className="library-toolbar">
        <div className="library-tabs" role="tablist" aria-label="浏览资料分类">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'history'}
            onClick={() => onModeChange('history')}
          >
            历史记录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'bookmarks'}
            onClick={() => onModeChange('bookmarks')}
          >
            书签
          </button>
        </div>
        <form
          className="library-search"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(queryInput.trim());
          }}
        >
          <Icon name="search" />
          <input
            type="search"
            maxLength={200}
            aria-label={mode === 'history' ? '搜索历史记录' : '搜索书签'}
            placeholder={mode === 'history' ? '搜索标题或网址' : '搜索书签'}
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
          />
          <button type="submit">搜索</button>
        </form>
        {mode === 'history' && !confirmClear && (
          <button type="button" className="danger-text" onClick={() => setConfirmClear(true)}>
            清空历史记录
          </button>
        )}
      </div>
      {confirmClear && (
        <div className="library-confirm" role="alertdialog" aria-label="确认清空历史记录">
          <span>确定清空全部浏览历史？书签和 Sources 不受影响。</span>
          <button type="button" className="danger-button" onClick={() => void clearHistory()}>
            确认清空
          </button>
          <button type="button" onClick={() => setConfirmClear(false)}>
            取消
          </button>
        </div>
      )}
      <p className="library-privacy-note">
        {mode === 'history'
          ? '仅记录普通标签页浏览。记录一直保存在本机，直到你手动删除或清空；后台 Research 和 Watch 任务不记录。'
          : '书签独立于 Sources；AI 无法读取或管理书签。展开分组后可逐个打开，编辑书签可调整分组。'}
      </p>
      {error !== null && (
        <p role="alert" className="library-error">
          {error}
        </p>
      )}
      {!loading && items.length === 0 && groups.length === 0 && error === null && (
        <div className="library-empty">{mode === 'history' ? '暂无浏览历史' : '暂无书签'}</div>
      )}
      <ul className="library-list">
        {mode === 'history' ? (
          items.map(renderItem)
        ) : (
          <>
            {groups.map((group) => (
              <BookmarkGroup
                key={group.id}
                group={group}
                query={query}
                revision={revision}
                renderItem={renderItem}
              />
            ))}
            {items.filter((item) => !isHistory(item) && item.groupId === null).map(renderItem)}
          </>
        )}
      </ul>
      {nextCursor !== null && (
        <button
          type="button"
          className="library-load-more"
          disabled={loading}
          onClick={() => void load(nextCursor)}
        >
          {loading ? '正在加载…' : '加载更多'}
        </button>
      )}
      {loading && items.length === 0 && <div className="library-empty">正在加载…</div>}
    </div>
  );
}

function BookmarkGroup({
  group,
  query,
  revision,
  renderItem,
}: {
  group: BrowserBookmarkGroup;
  query: string;
  revision: number;
  renderItem: (item: LibraryItem) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<BrowserBookmark[]>([]);
  const [cursor, setCursor] = useState<BrowserLibraryCursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const epoch = useRef(0);
  const load = async (next: BrowserLibraryCursor | null): Promise<void> => {
    const current = ++epoch.current;
    setLoading(true);
    setError(false);
    try {
      const result = await window.aibrowse.browserLibrary.listBookmarks({
        groupId: group.id,
        query: group.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? '' : query,
        cursor: next,
        limit: 50,
      });
      if (current !== epoch.current) return;
      if (!result.ok) {
        setError(true);
        return;
      }
      setItems((previous) =>
        next === null ? result.value.items : [...previous, ...result.value.items],
      );
      setCursor(result.value.nextCursor);
    } catch {
      if (current === epoch.current) setError(true);
    } finally {
      if (current === epoch.current) setLoading(false);
    }
  };
  useEffect(() => {
    setItems([]);
    setCursor(null);
    if (open) void load(null);
    return () => {
      epoch.current++;
    };
  }, [open, query, revision, group.id, group.name]);
  return (
    <li className="bookmark-group">
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <span className={`tab-group-dot tab-group-color-${group.color}`} />
          {group.name}
        </summary>
        <ul className="library-list bookmark-group-members">{items.map(renderItem)}</ul>
        {loading && <p role="status">正在加载…</p>}
        {error && (
          <p role="alert">
            无法读取分组{' '}
            <button type="button" onClick={() => void load(null)}>
              重试
            </button>
          </p>
        )}
        {!loading && !error && items.length === 0 && (
          <p className="library-empty">没有匹配的书签</p>
        )}
        {cursor !== null && (
          <button type="button" disabled={loading} onClick={() => void load(cursor)}>
            加载更多组内书签
          </button>
        )}
      </details>
    </li>
  );
}
