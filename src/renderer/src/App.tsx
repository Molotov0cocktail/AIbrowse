import { useEffect, useRef, useState } from 'react';
import { AiPanel } from './ai/AiPanel';
import { DebugPanel } from './browser/DebugPanel';
import { TabBar } from './browser/TabBar';
import { Toolbar } from './browser/Toolbar';
import { useContentBounds } from './browser/useContentBounds';
import { useTabsState } from './browser/useTabsState';

// 浏览器 chrome（T3）+ AI 侧栏停靠（S4，design §11.1）：顶部工具栏 + 标签栏为渲染层 UI，
// 主内容区由主进程 WebContentsView 按上报 bounds 覆盖渲染真实网页（§11.2：useContentBounds
// 测量内容容器两维矩形——面板开/关、窗口缩放、DebugPanel 收起都经同一路径更新 bounds）。
// 所有浏览器操作经 window.aibrowse bridge → BrowserController（分层纪律）。
export default function App() {
  const tabsState = useTabsState();
  const contentRef = useRef<HTMLDivElement>(null);
  useContentBounds(contentRef);
  const addressBarRef = useRef<HTMLInputElement>(null);
  // 面板打开状态存渲染层内存：默认收起、不持久化（§11.2）；定宽 380px、无拖拽/动画
  const [aiPanelOpen, setAiPanelOpen] = useState(false);

  useEffect(() => {
    // 渲染进程就绪即通知主进程（冒烟自检模式依赖此信号）；订阅先于此注册
    // （useTabsState 的 effect 声明在前，先于本 effect 执行）
    window.aibrowse.notifyRendererReady();
  }, []);

  const activeTab =
    tabsState === null
      ? null
      : (tabsState.tabs.find((t) => t.id === tabsState.activeTabId) ?? null);

  const withActiveTab = (action: (tabId: string) => Promise<boolean>): void => {
    if (activeTab !== null) void action(activeTab.id);
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
          onToggleAiPanel={() => setAiPanelOpen((open) => !open)}
          addressBarRef={addressBarRef}
        />
        <TabBar
          tabs={tabsState?.tabs ?? []}
          activeTabId={tabsState?.activeTabId ?? null}
          onActivate={(tabId) => void window.aibrowse.tabs.activate(tabId)}
          onClose={(tabId) => void window.aibrowse.tabs.close(tabId)}
        />
      </header>
      {/* 内容行：内容容器（WebContentsView 覆盖区）+ AI 面板停靠（§11.1） */}
      <div className="main-row">
        <main className="content-area" ref={contentRef} />
        {aiPanelOpen && <AiPanel onCollapse={() => setAiPanelOpen(false)} />}
      </div>
      {/* 调试面板在底部通栏：高度变化被内容容器的 ResizeObserver 测量并上报 bounds（§11.2） */}
      <DebugPanel activeTabId={tabsState?.activeTabId ?? null} />
    </div>
  );
}
