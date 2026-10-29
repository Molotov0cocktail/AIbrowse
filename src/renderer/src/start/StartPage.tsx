import { useEffect, useState } from 'react';
import type {
  BrowserHistoryEntry,
  BrowserLibraryStatus,
} from '../../../shared/types/browser-library';
import type { WatchStatusDto } from '../../../shared/types/watch-ipc';
import { Icon } from '../ui/Icon';
import { startWatchItems, type StartWatchItem } from './start-page-state';
import './start-page.css';

interface StartPageProps {
  libraryState: BrowserLibraryStatus['state'] | null;
  onNavigate(input: string): Promise<boolean>;
  onOpenHistory(): void;
  onOpenBookmarks(): void;
  onOpenWatch(): void;
  onOpenAi(): void;
}

export function StartPage({
  libraryState,
  onNavigate,
  onOpenHistory,
  onOpenBookmarks,
  onOpenWatch,
  onOpenAi,
}: StartPageProps) {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<BrowserHistoryEntry[] | null>(null);
  const [rules, setRules] = useState<StartWatchItem[] | null>(null);
  const [status, setStatus] = useState<WatchStatusDto | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [watchError, setWatchError] = useState(false);
  const [navigationError, setNavigationError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    setHistory(null);
    setHistoryError(false);
    if (libraryState === null || libraryState === 'initializing') return;
    if (libraryState !== 'available') {
      setHistoryError(true);
      return;
    }
    void window.aibrowse.browserLibrary
      .listHistory({ query: '', cursor: null, limit: 6 })
      .then((result) => {
        if (!current) return;
        if (result.ok) setHistory(result.value.items);
        else setHistoryError(true);
      })
      .catch(() => {
        if (current) setHistoryError(true);
      });
    return () => {
      current = false;
    };
  }, [libraryState]);

  useEffect(() => {
    let current = true;
    let version = 0;
    const refresh = (): void => {
      const request = ++version;
      void Promise.all([
        window.aibrowse.watch.getStatus(),
        window.aibrowse.watch.listRules({
          page: 1,
          pageSize: 4,
          filter: { state: null, sourceId: null },
        }),
      ])
        .then(([nextStatus, nextRules]) => {
          if (!current || request !== version) return;
          const parsed = nextRules.ok ? startWatchItems(nextRules.value) : null;
          if (!nextStatus.ok || nextStatus.value.mode !== 'available' || parsed === null) {
            setWatchError(true);
            setRules(null);
            setStatus(null);
            return;
          }
          setWatchError(false);
          setStatus(nextStatus.value);
          setRules(parsed);
        })
        .catch(() => {
          if (current && request === version) setWatchError(true);
        });
    };
    const unsubscribe = window.aibrowse.watch.subscribe((push) => {
      if (push.type === 'status') refresh();
    });
    refresh();
    return () => {
      current = false;
      version++;
      unsubscribe();
    };
  }, []);

  const navigate = (value: string): void => {
    if (busy || value.trim() === '') return;
    setBusy(true);
    setNavigationError(false);
    void onNavigate(value.trim())
      .then((ok) => setNavigationError(!ok))
      .catch(() => setNavigationError(true))
      .finally(() => setBusy(false));
  };

  return (
    <div className="start-page">
      <div className="start-page-inner">
        <header className="start-hero">
          <div className="start-brand">
            <span className="start-brand-mark">
              <Icon name="sparkles" size={22} />
            </span>
            <span>
              AIbrowse <span className="start-brand-divider">/</span> 你的信息工作台
            </span>
          </div>
          <h1>从这里，发现新线索</h1>
          <p>继续上次的阅读，或开始一次新的探索。</p>
          <form
            className="start-search"
            onSubmit={(event) => {
              event.preventDefault();
              navigate(input);
            }}
          >
            <Icon name="search" size={21} />
            <input
              aria-label="搜索或输入网址"
              placeholder="搜索内容，或输入网址"
              value={input}
              maxLength={8192}
              onChange={(event) => setInput(event.currentTarget.value)}
            />
            <button type="submit" disabled={busy || input.trim() === ''} aria-label="前往">
              <Icon name="arrow-right" size={20} />
            </button>
          </form>
          {navigationError && <p role="alert">无法打开，请检查地址后重试</p>}
        </header>
        <nav className="start-shortcuts" aria-label="快捷入口">
          <button type="button" onClick={onOpenBookmarks}>
            <Icon name="bookmark" size={20} />
            <span>
              我的书签<small>按分组整理收藏</small>
            </span>
            <Icon name="chevron-right" />
          </button>
          <button type="button" onClick={onOpenAi}>
            <Icon name="sparkles" size={20} />
            <span>
              AI 共读<small>与助手一起探索</small>
            </span>
            <Icon name="chevron-right" />
          </button>
          <button type="button" onClick={onOpenWatch}>
            <Icon name="activity" size={20} />
            <span>
              监视工作台<small>关注信息的变化</small>
            </span>
            <Icon name="chevron-right" />
          </button>
        </nav>
        <div className="start-widgets">
          <section className="start-widget" aria-labelledby="start-history-heading">
            <header>
              <h2 id="start-history-heading">
                <Icon name="clock" />
                最近浏览
              </h2>
              <button type="button" onClick={onOpenHistory}>
                全部历史 <Icon name="arrow-right" size={14} />
              </button>
            </header>
            {historyError ? (
              <p className="start-empty" role="status">
                浏览历史暂不可用，可在本地数据设置中检查。
              </p>
            ) : history === null ? (
              <p className="start-empty">正在读取最近浏览…</p>
            ) : history.length === 0 ? (
              <div className="start-empty">
                <Icon name="globe" size={28} />
                <strong>下一次发现，从一次浏览开始</strong>
                <span>访问过的网页会出现在这里，方便随时继续。</span>
              </div>
            ) : (
              <ul className="start-recent-list">
                {history.map((item) => (
                  <li key={item.id}>
                    <button type="button" disabled={busy} onClick={() => navigate(item.url)}>
                      <span className="start-item-icon">
                        <Icon name="globe" />
                      </span>
                      <span className="start-item-text">
                        <strong>{item.title.trim() || item.url}</strong>
                        <small>{new URL(item.url).hostname}</small>
                      </span>
                      <Icon name="arrow-right" size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="start-widget" aria-labelledby="start-watch-heading">
            <header>
              <h2 id="start-watch-heading">
                <Icon name="activity" />
                监视任务
              </h2>
              <button type="button" onClick={onOpenWatch}>
                工作台 <Icon name="arrow-right" size={14} />
              </button>
            </header>
            {watchError ? (
              <p className="start-empty" role="status">
                监视服务暂不可用，请在工作台查看。
              </p>
            ) : rules === null ? (
              <p className="start-empty">正在读取监视任务…</p>
            ) : (
              <>
                {status !== null && (
                  <div className="start-watch-stats">
                    <span>
                      <b>{status.ruleCount}</b> 项任务
                    </span>
                    <span>
                      <b>{status.unreadCount}</b> 条未读
                    </span>
                  </div>
                )}
                {rules.length === 0 ? (
                  <div className="start-empty">
                    <Icon name="activity" size={28} />
                    <strong>把值得关注的信息留在视野里</strong>
                    <span>添加网页或订阅源，在这里查看监视状态。</span>
                    <button type="button" onClick={onOpenWatch}>
                      设置监视任务
                    </button>
                  </div>
                ) : (
                  <ul className="start-watch-list">
                    {rules.map((rule) => (
                      <li key={rule.id}>
                        <button type="button" onClick={onOpenWatch}>
                          <span className={`start-status-dot is-${rule.health}`} />
                          <strong>{rule.sourceName || '监视任务'}</strong>
                          <small>
                            {rule.state === 'paused'
                              ? '已暂停'
                              : rule.health === 'degraded'
                                ? '需留意'
                                : '监视中'}
                          </small>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            <footer>监视仅在应用运行期间执行</footer>
          </section>
        </div>
        <footer className="start-footer">
          <Icon name="shield" size={14} />
          历史保存在本机 · 起始页不会自动打开历史网页
        </footer>
      </div>
    </div>
  );
}
