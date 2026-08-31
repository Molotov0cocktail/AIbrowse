import { useEffect, useRef, useState } from 'react';
import { AiPanel } from './ai/AiPanel';
import { ConfirmDialog } from './ai/ConfirmDialog';
import { SourcesPanel } from './ai/sources/SourcesPanel';
import { globalPendingRequest } from './ai/agent-run-state';
import { useAgent } from './ai/useAgent';
import { DebugPanel } from './browser/DebugPanel';
import { TabBar } from './browser/TabBar';
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

// 浏览器 chrome（T3）+ AI 侧栏停靠（S4，design §11.1）+ Agent 确认对话框（A6 §11.2，
// App 级全局挂载）：顶部工具栏 + 标签栏为渲染层 UI，主内容区由主进程 WebContentsView
// 按上报 bounds 覆盖渲染真实网页（§11.2：useContentBounds 测量内容容器两维矩形——
// 面板开/关、窗口缩放、DebugPanel 收起都经同一路径更新 bounds）。
// 所有浏览器操作经 window.aibrowse bridge → BrowserController（分层纪律）。
// useAgent 在 App 级：ConfirmDialog 全局跟随精确 pending（ConfirmManager 单 pending
// 事实）——不因切换会话/模式/折叠面板而不可访问（L2 确认必须可达）。
// C8 决议 #163(1)/#158(6)：sidePanel 三态互斥 'ai'|'sources'|'research'|null；
// viewMode 'browser'|'research-result'——research-result 时经
// ui.setBrowserContentVisible(false) 隐藏全部 WebContentsView（原生视图覆盖 DOM，
// 仅 React 切 viewMode 不够），React 结果画布独立滚动；返回浏览/创建激活 Tab/
// 从结果打开来源后恢复 browser 模式。
export default function App() {
  const tabsState = useTabsState();
  const contentRef = useRef<HTMLDivElement>(null);
  useContentBounds(contentRef);
  const addressBarRef = useRef<HTMLInputElement>(null);
  const [sidePanel, setSidePanel] = useState<'ai' | 'sources' | 'research' | null>(null);
  const [viewMode, setViewMode] = useState<'browser' | 'research-result' | 'watch'>('browser');
  const [watchSourceId, setWatchSourceId] = useState<string | null>(null);
  const [watchNotice, setWatchNotice] = useState<InAppNotificationDto | null>(null);
  const [watchFocus, setWatchFocus] = useState<{ type: 'event' | 'digest'; id: string } | null>(
    null,
  );
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const agent = useAgent();
  const research = useResearch();
  const pendingConfirm = globalPendingRequest(agent.agentState);

  useEffect(() => {
    // 渲染进程就绪即通知主进程（冒烟自检模式依赖此信号）；订阅先于此注册
    // （useTabsState 的 effect 声明在前，先于本 effect 执行）
    window.aibrowse.notifyRendererReady();
  }, []);

  useEffect(
    () =>
      window.aibrowse.watch.subscribe((push) => {
        if (push.type === 'notification') setWatchNotice(push.notification);
      }),
    [],
  );

  // C8 决议 #158(6)：viewMode → WebContentsView 可见性（受控 UI send 通道）
  useEffect(() => {
    window.aibrowse.ui.setBrowserContentVisible(viewMode === 'browser');
  }, [viewMode]);

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

  const withActiveTab = (action: (tabId: string) => Promise<boolean>): void => {
    if (activeTab !== null) void action(activeTab.id);
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
        <Toolbar
          activeTab={activeTab}
          onNavigate={(input) =>
            withActiveTab((tabId) => window.aibrowse.nav.navigate(tabId, input))
          }
          onBack={() => withActiveTab((tabId) => window.aibrowse.nav.back(tabId))}
          onForward={() => withActiveTab((tabId) => window.aibrowse.nav.forward(tabId))}
          onReload={() => withActiveTab((tabId) => window.aibrowse.nav.reload(tabId))}
          onCreateTab={() => {
            void window.aibrowse.tabs.create().then(() => {
              addressBarRef.current?.focus(); // 新标签页聚焦地址栏，便于直接输入
            });
          }}
          onToggleAiPanel={() => setSidePanel((p) => (p === 'ai' ? null : 'ai'))}
          onToggleSourcesPanel={() => setSidePanel((p) => (p === 'sources' ? null : 'sources'))}
          onToggleResearchPanel={() => setSidePanel((p) => (p === 'research' ? null : 'research'))}
          onOpenWatch={() => {
            setSidePanel(null);
            setViewMode('watch');
          }}
          onWatchCurrentPage={() => {
            void window.aibrowse.sources.quickAdd().then((result) => {
              if (result.status === 'added') setWatchSourceId(result.source.id);
              else if (result.status === 'duplicate') setWatchSourceId(result.existing.id);
              else return;
              setSidePanel(null);
              setViewMode('watch');
            });
          }}
          addressBarRef={addressBarRef}
        />
        <TabBar
          tabs={tabsState?.tabs ?? []}
          activeTabId={tabsState?.activeTabId ?? null}
          onActivate={(tabId) => void window.aibrowse.tabs.activate(tabId)}
          onClose={(tabId) => void window.aibrowse.tabs.close(tabId)}
        />
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
              initialSourceId={watchSourceId}
              focusSubject={watchFocus}
              onBack={() => setViewMode('browser')}
            />
          ) : null}
        </main>
        {sidePanel === 'ai' && <AiPanel onCollapse={() => setSidePanel(null)} agent={agent} />}
        {sidePanel === 'sources' && (
          <SourcesPanel
            onCollapse={() => setSidePanel(null)}
            onCreateWatch={(sourceId) => {
              setWatchSourceId(sourceId);
              setSidePanel(null);
              setViewMode('watch');
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
      </div>
      {/* 调试面板在底部通栏：高度变化被内容容器的 ResizeObserver 测量并上报 bounds（§11.2） */}
      <DebugPanel activeTabId={tabsState?.activeTabId ?? null} />
      {/* L2 确认对话框（App 级全局，独立于面板挂载——切换/折叠面板不遮断确认）：
          deny 默认高亮/焦点；pending 作废自动关闭 */}
      <ConfirmDialog pending={pendingConfirm} onDecide={agent.confirmTool} />
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
    </div>
  );
}
