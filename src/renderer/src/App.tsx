import { useEffect, useRef, useState } from 'react';
import { AiPanel } from './ai/AiPanel';
import { ConfirmDialog } from './ai/ConfirmDialog';
import { SourcesPanel } from './ai/sources/SourcesPanel';
import { globalPendingRequest } from './ai/agent-run-state';
import { useAgent } from './ai/useAgent';
import { DebugPanel } from './browser/DebugPanel';
import { TabBar } from './browser/TabBar';
import { TabGroupEditor } from './browser/TabGroupEditor';
import { Toolbar } from './browser/Toolbar';
import { useContentBounds } from './browser/useContentBounds';
import { useTabsState } from './browser/useTabsState';
import { ResearchPanel } from './research/ResearchPanel';
import { ResultView } from './research/ResultView';
import { TableView } from './research/TableView';
import { useResearch } from './research/use-research';
import { isSafeMarkdownUrl } from '../../shared/markdown/markdown-url';
import type { ResearchResultView } from '../../shared/types/research';
import type { TableViewState } from '../../shared/research/table-utils';
import { WatchWorkspace } from './watch/WatchWorkspace';
import type { InAppNotificationDto } from '../../shared/types/watch-ipc';
import { useLocalData } from './storage/useLocalData';
import { DiagnosticPanel } from './diagnostics/DiagnosticPanel';
import { useAppearance } from './ui/useAppearance';
import { SettingsPage, type SettingsSection } from './settings/SettingsPage';
import { BrowserLibraryPage, type BrowserLibraryMode } from './browser-library/BrowserLibraryPage';
import { useBrowserLibraryStatus } from './browser-library/useBrowserLibraryStatus';
import type { BrowserBookmark } from '../../shared/types/browser-library';
import { StartPage } from './start/StartPage';
import { isStartPageTab } from './start/start-page-state';
import './browser-library/bookmark-groups.css';

// 浏览器 chrome（T3）+ AI 侧栏停靠（S4，design §11.1）+ Agent 确认对话框（A6 §11.2，
// App 级全局挂载）：顶部工具栏 + 标签栏为渲染层 UI，主内容区由主进程 WebContentsView
// 按上报 bounds 覆盖渲染真实网页（§11.2：useContentBounds 测量内容容器两维矩形——
// 面板开/关、窗口缩放、DebugPanel 收起都经同一路径更新 bounds）。
// 所有浏览器操作经 window.aibrowse bridge → BrowserController（分层纪律）。
// useAgent 在 App 级：ConfirmDialog 全局跟随精确 pending（ConfirmManager 单 pending
// 事实）——不因切换会话/模式/折叠面板而不可访问（L2 确认必须可达）。
// C8 决议 #163(1)/#158(6)：sidePanel 三态互斥 'ai'|'sources'|'research'|null；
// 非 browser viewMode 经
// ui.setBrowserContentVisible(false) 隐藏全部 WebContentsView（原生视图覆盖 DOM，
// 仅 React 切 viewMode 不够），React 结果画布独立滚动；返回浏览/创建激活 Tab/
// 从结果打开来源后恢复 browser 模式。
export default function App() {
  const tabsState = useTabsState();
  const contentRef = useRef<HTMLDivElement>(null);
  useContentBounds(contentRef);
  const addressBarRef = useRef<HTMLInputElement>(null);
  const [sidePanel, setSidePanel] = useState<'ai' | 'sources' | 'research' | 'diagnostics' | null>(
    null,
  );
  const [debugOpen, setDebugOpen] = useState(false);
  const [viewMode, setViewMode] = useState<
    'browser' | 'research-result' | 'watch' | 'settings' | 'library'
  >(__WATCH_QUALIFICATION__ ? 'watch' : 'browser');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [libraryMode, setLibraryMode] = useState<BrowserLibraryMode>('history');
  const [currentBookmark, setCurrentBookmark] = useState<BrowserBookmark | null>(null);
  const [libraryNotice, setLibraryNotice] = useState<string | null>(null);
  const [groupEditorTabId, setGroupEditorTabId] = useState<string | null>(null);
  const [groupEditorIssue, setGroupEditorIssue] = useState<string | null>(null);
  const [watchTargetUrl, setWatchTargetUrl] = useState<string | null>(null);
  const [watchNotice, setWatchNotice] = useState<InAppNotificationDto | null>(null);
  const [watchUnreadCount, setWatchUnreadCount] = useState(0);
  const [watchFocus, setWatchFocus] = useState<{ type: 'event' | 'digest'; id: string } | null>(
    null,
  );
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const viewModeRef = useRef(viewMode);
  const agent = useAgent();
  const research = useResearch();
  const appearance = useAppearance();
  const localData = useLocalData();
  const libraryStatus = useBrowserLibraryStatus();
  const browserDataIssue =
    libraryStatus !== null && libraryStatus.state === 'storage-error'
      ? '浏览数据保存或读取失败，部分新访问可能未保存；请检查本地数据'
      : libraryStatus !== null && libraryStatus.state === 'unavailable'
        ? '浏览数据暂不可用，请检查本地数据'
        : null;
  const pendingConfirm = globalPendingRequest(agent.agentState);

  useEffect(() => {
    // 渲染进程就绪即通知主进程（冒烟自检模式依赖此信号）；订阅先于此注册
    // （useTabsState 的 effect 声明在前，先于本 effect 执行）
    window.aibrowse.notifyRendererReady();
  }, []);

  useEffect(() => {
    viewModeRef.current = viewMode;
    if (viewMode === 'watch') setWatchNotice(null);
    if (viewMode !== 'browser') {
      setGroupEditorTabId(null);
      setGroupEditorIssue(null);
    }
  }, [viewMode]);

  useEffect(
    () =>
      window.aibrowse.watch.subscribe((push) => {
        if (push.type === 'status') setWatchUnreadCount(push.status.unreadCount);
        else if (push.type === 'activation') {
          setWatchTargetUrl(null);
          setSidePanel(null);
          setWatchFocus({ type: push.subjectType, id: push.subjectId });
          setViewMode('watch');
          setWatchNotice(null);
        } else if (viewModeRef.current !== 'watch') setWatchNotice(push.notification);
      }),
    [],
  );

  // 决议 #163(4)：删除当前画布任务 → 清空结果画布并切回 browser 模式
  useEffect(() => {
    if (research.state.resultCanvasCleared) {
      research.consumeCanvasCleared(); // 消费标记（避免重复触发）
      setViewMode('browser');
      setSelectedCandidateId(null);
      setCanvasError(null);
    }
  }, [research.state.resultCanvasCleared]);

  const activeTab =
    tabsState === null
      ? null
      : (tabsState.tabs.find((t) => t.id === tabsState.activeTabId) ?? null);
  const showStartPage = viewMode === 'browser' && isStartPageTab(activeTab, tabsState);

  useEffect(() => {
    window.aibrowse.ui.setBrowserContentVisible(viewMode === 'browser' && !showStartPage);
  }, [viewMode, showStartPage]);

  const refreshCurrentBookmark = (): void => {
    void window.aibrowse.browserLibrary
      .getCurrentBookmark()
      .then((result) => setCurrentBookmark(result.ok ? result.value : null))
      .catch(() => setCurrentBookmark(null));
  };

  useEffect(() => {
    refreshCurrentBookmark();
  }, [activeTab?.id, activeTab?.url]);

  const withActiveTab = (action: (tabId: string) => Promise<boolean>): void => {
    if (activeTab !== null) void action(activeTab.id);
  };

  const returnToBrowser = (): void => {
    setViewMode('browser');
    setSelectedCandidateId(null);
    setCanvasError(null);
  };

  const openTabGroupEditor = (tabId: string): void => {
    returnToBrowser();
    setGroupEditorIssue(null);
    setGroupEditorTabId(tabId);
  };

  const runTabGroupAction = (action: Promise<boolean>): void => {
    setGroupEditorIssue(null);
    void action
      .then((ok) => {
        if (!ok) setGroupEditorIssue('分组操作未完成，请刷新后重试');
      })
      .catch(() => setGroupEditorIssue('分组操作未完成，请刷新后重试'));
  };

  const openSettings = (section: SettingsSection): void => {
    setGroupEditorTabId(null);
    setGroupEditorIssue(null);
    setSettingsSection(section);
    setSidePanel(null);
    setDebugOpen(false);
    setViewMode('settings');
  };

  const openLibrary = (mode: BrowserLibraryMode): void => {
    setGroupEditorTabId(null);
    setGroupEditorIssue(null);
    setLibraryMode(mode);
    setSidePanel(null);
    setDebugOpen(false);
    setViewMode('library');
  };

  const toggleCurrentBookmark = (): void => {
    setLibraryNotice(null);
    const action =
      currentBookmark === null
        ? window.aibrowse.browserLibrary.addCurrentBookmark()
        : window.aibrowse.browserLibrary.removeBookmark(currentBookmark.id);
    void action
      .then((result) => {
        if (!result.ok) {
          setLibraryNotice('书签操作未完成，请稍后重试');
          return;
        }
        refreshCurrentBookmark();
      })
      .catch(() => setLibraryNotice('书签操作未完成，请稍后重试'));
  };

  const runBrowserAction = (action: (tabId: string) => Promise<boolean>): void => {
    returnToBrowser();
    withActiveTab(action);
  };

  // 决议 #159(5)：打开 Markdown/Evidence URL——先经 shared URL 白名单（仅绝对
  // http/https 无 userinfo），再调用既有 window.aibrowse.tabs.create(url)（主进程
  // 再次规范化）；创建成功后切回 browser 模式；失败留在结果页 + 固定中文错误；
  // 禁止覆盖用户当前 Tab、禁止 renderer 直接调用 Electron
  const openSafeUrl = (url: string): void => {
    if (!isSafeMarkdownUrl(url)) {
      setCanvasError('无法打开该链接（仅支持 http/https 地址）');
      return;
    }
    void window.aibrowse.tabs.create(url).then((tab) => {
      if (tab !== null) {
        setViewMode('browser');
        setCanvasError(null);
      } else {
        setCanvasError('打开链接失败，请重试');
      }
    });
  };

  // 结果画布：TableView 包装（表格块使用交互组件；其余块 ResultView 渲染）
  const renderResultCanvas = (view: ResearchResultView): React.ReactNode => {
    const result = view.result;
    return (
      <div className="research-canvas">
        <div className="research-canvas-header">
          <button
            type="button"
            className="research-canvas-back"
            onClick={() => {
              setViewMode('browser');
              setSelectedCandidateId(null);
              setCanvasError(null);
            }}
          >
            ← 返回浏览
          </button>
          <span className="research-canvas-title">
            {result.title}（任务 {result.taskId.slice(0, 8)}）
          </span>
        </div>
        {canvasError !== null && <div className="research-canvas-error">{canvasError}</div>}
        <div className="research-canvas-body">
          {result.blocks.map((block, i) =>
            block.kind === 'table' ? (
              <TableView
                key={i}
                columns={block.columns}
                rows={block.rows}
                sourceRefs={block.sourceRefs}
                onSelectSource={(candidateId) => setSelectedCandidateId(candidateId)}
                onCopy={(viewState: TableViewState) =>
                  window.aibrowse.research.copyTable({
                    taskId: result.taskId,
                    tableBlockIndex: i,
                    view: viewState,
                  })
                }
                onExportCsv={(viewState: TableViewState) =>
                  research.exportCsv({
                    taskId: result.taskId,
                    tableBlockIndex: i,
                    view: {
                      sort: viewState.sort,
                      filter: viewState.filter,
                    },
                  })
                }
              />
            ) : null,
          )}
          <ResultView
            result={result}
            evidence={view.evidence}
            selectedCandidateId={selectedCandidateId}
            onSelectSource={(candidateId) => setSelectedCandidateId(candidateId)}
            onCloseEvidence={() => setSelectedCandidateId(null)}
            onOpenUrl={openSafeUrl}
            skipTableBlocks
          />
        </div>
      </div>
    );
  };

  return (
    <div className="app">
      <header className="chrome">
        <div className="tab-strip-row">
          <div className="tab-cluster">
            <TabBar
              tabs={tabsState?.tabs ?? []}
              activeTabId={tabsState?.activeTabId ?? null}
              groups={tabsState?.groups}
              userTabIds={tabsState?.userTabIds}
              onActivate={(tabId) => {
                returnToBrowser();
                void window.aibrowse.tabs.activate(tabId);
              }}
              onClose={(tabId) => void window.aibrowse.tabs.close(tabId)}
              onReload={(tabId) => {
                returnToBrowser();
                void window.aibrowse.nav.reload(tabId);
              }}
              onToggleGroup={(group) =>
                runTabGroupAction(
                  window.aibrowse.tabs.updateGroup({
                    groupId: group.id,
                    name: group.name,
                    color: group.color,
                    collapsed: !group.collapsed,
                  }),
                )
              }
              onEditGroup={(groupId) => {
                const group = tabsState?.groups?.find((candidate) => candidate.id === groupId);
                const editableIds = new Set(tabsState?.userTabIds ?? []);
                const tabId =
                  group?.tabIds.find(
                    (candidate) =>
                      candidate === tabsState?.activeTabId && editableIds.has(candidate),
                  ) ?? group?.tabIds.find((candidate) => editableIds.has(candidate));
                if (tabId !== undefined) openTabGroupEditor(tabId);
              }}
              onEditTabGroup={openTabGroupEditor}
            />
            <button
              type="button"
              className="tab-group-editor-trigger"
              aria-label="标签分组"
              title={
                tabsState?.activeTabId !== null &&
                tabsState?.activeTabId !== undefined &&
                tabsState?.userTabIds?.includes(tabsState.activeTabId) === true
                  ? '管理当前标签的分组'
                  : '当前标签不能分组'
              }
              disabled={
                tabsState?.activeTabId === null ||
                tabsState?.activeTabId === undefined ||
                tabsState?.userTabIds?.includes(tabsState.activeTabId) !== true
              }
              onClick={() => {
                if (tabsState?.activeTabId !== null && tabsState?.activeTabId !== undefined) {
                  openTabGroupEditor(tabsState.activeTabId);
                }
              }}
            >
              ▦
            </button>
            <button
              type="button"
              className="new-tab-button"
              aria-label="新建标签页"
              title="新建标签页"
              onClick={() => {
                setGroupEditorTabId(null);
                void window.aibrowse.tabs.create().then(() => {
                  returnToBrowser();
                  addressBarRef.current?.focus();
                });
              }}
            >
              ＋
            </button>
          </div>
          <div className="titlebar-drag-space" aria-hidden="true" />
        </div>
        <Toolbar
          activePanel={sidePanel}
          watchActive={viewMode === 'watch'}
          activeTab={activeTab}
          onNavigate={(input) =>
            runBrowserAction((tabId) => window.aibrowse.nav.navigate(tabId, input))
          }
          onBack={() => runBrowserAction((tabId) => window.aibrowse.nav.back(tabId))}
          onForward={() => runBrowserAction((tabId) => window.aibrowse.nav.forward(tabId))}
          onReload={() => runBrowserAction((tabId) => window.aibrowse.nav.reload(tabId))}
          onToggleAiPanel={() => setSidePanel((p) => (p === 'ai' ? null : 'ai'))}
          onToggleSourcesPanel={() => setSidePanel((p) => (p === 'sources' ? null : 'sources'))}
          onToggleResearchPanel={() => {
            const opening = sidePanel !== 'research';
            setSidePanel(opening ? 'research' : null);
            if (opening) void research.refreshList(1);
          }}
          onOpenWatch={() => {
            setGroupEditorTabId(null);
            setGroupEditorIssue(null);
            setSidePanel(null);
            setWatchFocus(null);
            setWatchTargetUrl(null);
            setViewMode('watch');
          }}
          onOpenHistory={() => openLibrary('history')}
          onOpenBookmarks={() => openLibrary('bookmarks')}
          onOpenSettings={() => openSettings('general')}
          onOpenTools={() => openSettings('extensions')}
          onToggleBookmark={toggleCurrentBookmark}
          bookmarked={currentBookmark !== null}
          addressBarRef={addressBarRef}
        />
        {groupEditorTabId !== null &&
          tabsState?.groups !== undefined &&
          tabsState.userTabIds !== undefined && (
            <TabGroupEditor
              tabs={tabsState.tabs}
              groups={tabsState.groups}
              userTabIds={tabsState.userTabIds}
              selectedTabId={groupEditorTabId}
              issue={groupEditorIssue}
              onClose={() => {
                setGroupEditorTabId(null);
                setGroupEditorIssue(null);
              }}
              onSelectTab={openTabGroupEditor}
              onCreate={(payload) => runTabGroupAction(window.aibrowse.tabs.createGroup(payload))}
              onUpdate={(payload) => runTabGroupAction(window.aibrowse.tabs.updateGroup(payload))}
              onSetGroup={(payload) => runTabGroupAction(window.aibrowse.tabs.setGroup(payload))}
              onUngroup={(groupId) => runTabGroupAction(window.aibrowse.tabs.ungroup(groupId))}
            />
          )}
        {debugOpen && (
          <DebugPanel
            activeTabId={tabsState?.activeTabId ?? null}
            onClose={() => setDebugOpen(false)}
          />
        )}
      </header>
      {/* 内容行：内容容器（WebContentsView 覆盖区）+ 面板停靠（C8 决议 #163(1)：
          AI/Sources/Research 三态互斥，380px 同模式） */}
      <div className="main-row">
        <main className="content-area" ref={contentRef}>
          {/* C8 决议 #158(6)：research-result 模式 → React 结果画布（独立滚动）；
              browser 模式 → 空容器（WebContentsView 覆盖） */}
          {viewMode === 'research-result' && research.state.resultView !== null ? (
            renderResultCanvas(research.state.resultView)
          ) : viewMode === 'watch' ? (
            <WatchWorkspace
              key={watchTargetUrl ?? 'watch-home'}
              initialUrl={watchTargetUrl}
              currentPageUrl={tabsState?.tabs.find((tab) => tab.id === tabsState.activeTabId)?.url}
              focusSubject={watchFocus}
              onBack={() => setViewMode('browser')}
            />
          ) : viewMode === 'settings' ? (
            <SettingsPage
              section={settingsSection}
              onSectionChange={setSettingsSection}
              onBack={returnToBrowser}
              appearance={appearance}
              localData={localData}
              browserDataIssue={browserDataIssue}
              onOpenDiagnostics={() => {
                setViewMode('browser');
                setSidePanel('diagnostics');
              }}
              onOpenPageDebug={() => {
                setViewMode('browser');
                setDebugOpen(true);
              }}
              onWatchCurrentPage={() => {
                const active = tabsState?.tabs.find((tab) => tab.id === tabsState.activeTabId);
                if (active === undefined || !isSafeMarkdownUrl(active.url)) {
                  setLibraryNotice('请先打开要监控的 http 或 https 网页');
                  return;
                }
                setWatchTargetUrl(active.url);
                setWatchFocus(null);
                setViewMode('watch');
              }}
            />
          ) : viewMode === 'library' ? (
            <BrowserLibraryPage
              mode={libraryMode}
              onModeChange={setLibraryMode}
              onBack={returnToBrowser}
              onOpenUrl={(url) => {
                void window.aibrowse.tabs
                  .create(url)
                  .then((tab) => {
                    if (tab !== null) returnToBrowser();
                    else setLibraryNotice('无法打开该地址，请稍后重试');
                  })
                  .catch(() => setLibraryNotice('无法打开该地址，请稍后重试'));
              }}
              onBookmarksChanged={refreshCurrentBookmark}
            />
          ) : showStartPage ? (
            <StartPage
              key={activeTab?.id}
              libraryState={libraryStatus?.state ?? null}
              onNavigate={async (input) =>
                activeTab !== null && window.aibrowse.nav.navigate(activeTab.id, input)
              }
              onOpenHistory={() => openLibrary('history')}
              onOpenBookmarks={() => openLibrary('bookmarks')}
              onOpenWatch={() => {
                setSidePanel(null);
                setWatchFocus(null);
                setWatchTargetUrl(null);
                setViewMode('watch');
              }}
              onOpenAi={() => setSidePanel('ai')}
            />
          ) : null}
        </main>
        {sidePanel === 'ai' && (
          <AiPanel
            onCollapse={() => setSidePanel(null)}
            onOpenSettings={() => openSettings('ai')}
            agent={agent}
          />
        )}
        {sidePanel === 'sources' && (
          <SourcesPanel
            onCollapse={() => setSidePanel(null)}
            onCreateWatch={(sourceId) => {
              void window.aibrowse.sources
                .get({ sourceId })
                .then((result) => {
                  if (!result.ok) {
                    setLibraryNotice('无法读取该信源的网址，请刷新后重试');
                    return;
                  }
                  setWatchTargetUrl(result.source.url);
                  setWatchFocus(null);
                  setSidePanel(null);
                  setViewMode('watch');
                })
                .catch(() => setLibraryNotice('监控入口暂不可用，请稍后重试'));
            }}
          />
        )}
        {sidePanel === 'research' && (
          <ResearchPanel
            research={research}
            onCollapse={() => setSidePanel(null)}
            onOpenResult={(taskId) => {
              void research.openResult(taskId).then(() => setViewMode('research-result'));
            }}
          />
        )}
        {sidePanel === 'diagnostics' && <DiagnosticPanel onClose={() => setSidePanel(null)} />}
      </div>
      {/* L2 确认对话框（App 级全局，独立于面板挂载——切换/折叠面板不遮断确认）：
          deny 默认高亮/焦点；pending 作废自动关闭 */}
      <ConfirmDialog pending={pendingConfirm} onDecide={agent.confirmTool} />
      {viewMode !== 'watch' && watchUnreadCount > 0 && (
        <button
          type="button"
          className="watch-global-badge"
          aria-label={`监控未读 ${watchUnreadCount}`}
          onClick={() => {
            setWatchFocus(null);
            setViewMode('watch');
          }}
        >
          监控未读 {watchUnreadCount}
        </button>
      )}
      {watchNotice !== null && viewMode !== 'watch' && (
        <button
          type="button"
          className="watch-global-toast"
          onClick={() => {
            setWatchFocus({ type: watchNotice.subjectType, id: watchNotice.subjectId });
            setViewMode('watch');
            setWatchNotice(null);
          }}
        >
          {watchNotice.body}
        </button>
      )}
      {(localData.issue !== null || browserDataIssue !== null) && (
        <button type="button" className="data-global-alert" onClick={() => openSettings('data')}>
          {localData.issue ?? browserDataIssue}
        </button>
      )}
      {libraryNotice !== null && (
        <button
          type="button"
          className="library-global-toast"
          onClick={() => setLibraryNotice(null)}
        >
          {libraryNotice}
        </button>
      )}
    </div>
  );
}
