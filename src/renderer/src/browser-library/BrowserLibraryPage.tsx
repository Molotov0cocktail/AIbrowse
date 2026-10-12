import { useEffect, useRef, useState } from 'react';
import type {
  BrowserBookmark,
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
          : await window.aibrowse.browserLibrary.listBookmarks(request);
      if (version !== requestVersion.current) return;
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
      if (!isHistory(item)) onBookmarksChanged();
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
    } catch {
      applyForCurrentLibraryView(viewEpoch.current, startedEpoch, () =>
        setError('书签修改未完成，请稍后重试'),
      );
    }
  };

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
          : '书签独立于 Sources；AI 无法读取或管理书签。'}
      </p>
      {error !== null && (
        <p role="alert" className="library-error">
          {error}
        </p>
      )}
      {!loading && items.length === 0 && error === null && (
        <div className="library-empty">{mode === 'history' ? '暂无浏览历史' : '暂无书签'}</div>
      )}
      <ul className="library-list">
        {items.map((item) => (
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
                <button type="button" onClick={() => void saveBookmark()}>
                  保存
                </button>
                <button type="button" onClick={() => setEditing(null)}>
                  取消
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="library-item-main"
                  onClick={() => onOpenUrl(item.url)}
                >
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
        ))}
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
