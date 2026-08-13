import { useEffect, useRef } from 'react';
import { DebugPanel } from './browser/DebugPanel';
import { TabBar } from './browser/TabBar';
import { Toolbar } from './browser/Toolbar';
import { useContentBounds } from './browser/useContentBounds';
import { useTabsState } from './browser/useTabsState';

// 浏览器 chrome（T3）：顶部工具栏 + 标签栏为渲染层 UI，主内容区由主进程
// WebContentsView 按上报 bounds 覆盖渲染真实网页（design §6）。
// 所有浏览器操作经 window.aibrowse bridge → BrowserController（分层纪律）。
export default function App() {
  const tabsState = useTabsState();
  const chromeRef = useRef<HTMLElement>(null);
  useContentBounds(chromeRef);
  const addressBarRef = useRef<HTMLInputElement>(null);

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
      <header className="chrome" ref={chromeRef}>
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
          addressBarRef={addressBarRef}
        />
        <TabBar
          tabs={tabsState?.tabs ?? []}
          activeTabId={tabsState?.activeTabId ?? null}
          onActivate={(tabId) => void window.aibrowse.tabs.activate(tabId)}
          onClose={(tabId) => void window.aibrowse.tabs.close(tabId)}
        />
        {/* 调试面板在 chrome 容器内：高度变化会被 ResizeObserver 测量并上报 bounds（§6） */}
        <DebugPanel activeTabId={tabsState?.activeTabId ?? null} />
      </header>
      {/* 主内容区：WebContentsView 由主进程按 bounds 覆盖在此区域之上 */}
      <main className="content-area" />
    </div>
  );
}
