// BrowserController: 浏览器能力的统一入口 —— UI 与未来 AI Tool Layer 只能经它操作浏览器.
// Contract source: doc/detailed-design.md §2.1/§4/§5/§6（定稿，T1）.
// 分层方向（不可反向）：UI → BrowserController → TabManager / SessionManager → Electron APIs.
// 失败语义（§4）：参数/状态问题安全返回 false/null，不抛异常；仅未预期内部异常 reject。

import type { BaseWindow, Rectangle } from 'electron';
import type { PageSnapshot, TabInfo, TabsState } from '../../shared/types/browser';
import type { ContentBounds } from '../../shared/types/ipc';
import { logInfo, logWarn } from '../logger';
import { PageReader } from './page-reader';
import type { SessionManager } from './session-manager';
import { TabManager, type TabEntry } from './tab-manager';
import { selectNextActive } from './tab-state';

export interface BrowserController {
  createTab(url?: string): Promise<TabInfo>;
  closeTab(tabId: string): Promise<boolean>;
  activateTab(tabId: string): Promise<boolean>;
  navigate(tabId: string, url: string): Promise<boolean>;
  goBack(tabId: string): Promise<boolean>;
  goForward(tabId: string): Promise<boolean>;
  reload(tabId: string): Promise<boolean>;
  getTabs(): Promise<TabInfo[]>;
  getActiveTab(): Promise<TabInfo | null>;
  getPageSnapshot(tabId: string): Promise<PageSnapshot | null>;
  dispose(): void; // 窗口关闭前全量清理（销毁全部 view 与监听器，不触发「最后 Tab 自动新建」）
}

export interface BrowserControllerOptions {
  ownerWindow: BaseWindow; // contentView 挂载点 + 兜底 bounds 来源
  sessionManager: SessionManager; // 持久 Session（§7，多 Profile 预留）
  getFallbackBounds: () => Rectangle; // chrome 高度上报前按窗口内容区兜底（§6）
  onTabsStateChanged?: (state: TabsState) => void; // tabs:updated 全量推送出口
}

// 接口与实现分名：契约接口名保留为 BrowserController（§2.1 定稿），
// 避免类/接口同名声明合并（@typescript-eslint/no-unsafe-declaration-merging）
export class BrowserControllerImpl implements BrowserController {
  private readonly tabManager: TabManager;
  private readonly pageReader: PageReader;
  private activeTabId: string | null = null;
  private lastContentBounds: Rectangle | null = null;
  private disposed = false;

  constructor(private readonly options: BrowserControllerOptions) {
    this.tabManager = new TabManager({
      ownerWindow: options.ownerWindow,
      session: options.sessionManager.getSession(),
      onChanged: () => this.pushState(),
    });
    this.pageReader = new PageReader();
  }

  async createTab(url?: string): Promise<TabInfo> {
    this.assertAlive();
    let target = url ?? 'about:blank';
    if (target === '') {
      // §2.1：URL 无效不失败，创建空白 Tab + warn（规范化通常已在 IPC handler 完成）
      logWarn('browser', 'createTab 收到空 URL，创建空白标签页');
      target = 'about:blank';
    }
    const entry = this.tabManager.createTab(target);
    this.activeTabId = entry.info.id;
    this.applyActiveVisual();
    // 状态机（§5）：idle --loadURL--> loading --> ready，事件驱动；此处仅记录加载异常
    entry.view.webContents.loadURL(target).catch((err: unknown) => {
      logWarn('browser', `加载失败（tabId=${entry.info.id}，url=${target}）`, err);
    });
    logInfo('browser', `已创建标签页（tabId=${entry.info.id}，url=${target}）`);
    this.pushState();
    return this.toTabInfo(entry, true);
  }

  async closeTab(tabId: string): Promise<boolean> {
    if (this.disposed) return false;
    const entry = this.tabManager.get(tabId);
    if (entry === undefined) {
      logWarn('browser', `closeTab 未知 tabId=${tabId}`);
      return false;
    }
    // §5：selectNextActive 基于关闭前的完整列表计算右邻/左邻（含被关闭的 Tab 本身）
    const tabsBeforeClose = this.tabManager.list().map((e) => e.info);
    const closedActive = this.activeTabId === tabId;
    this.tabManager.closeTab(tabId); // 移除条目 + removeChildView + close + 逐一移除监听器（§6）
    logInfo('browser', `已关闭标签页（tabId=${tabId}）`);
    if (closedActive) {
      const nextId = selectNextActive(tabsBeforeClose, this.activeTabId, tabId);
      if (nextId !== null) {
        this.activeTabId = nextId;
        this.applyActiveVisual();
      } else {
        // 最后 Tab 策略（§5）：窗口常驻不退出，自动新建空白 Tab（dispose 路径不走本方法）
        this.activeTabId = null;
        logInfo('browser', '已关闭最后一个标签页，自动新建空白标签页');
        void this.createTab();
        return true;
      }
    }
    this.pushState();
    return true;
  }

  async activateTab(tabId: string): Promise<boolean> {
    if (this.disposed) return false;
    if (this.tabManager.get(tabId) === undefined) {
      logWarn('browser', `activateTab 未知 tabId=${tabId}`);
      return false;
    }
    if (this.activeTabId === tabId) return true; // 幂等
    this.activeTabId = tabId;
    this.applyActiveVisual();
    this.pushState();
    return true;
  }

  async navigate(tabId: string, url: string): Promise<boolean> {
    if (this.disposed) return false;
    if (url === '') {
      logWarn('browser', `navigate 收到空 URL（tabId=${tabId}）`);
      return false;
    }
    const entry = this.tabManager.get(tabId);
    if (entry === undefined) {
      logWarn('browser', `navigate 未知 tabId=${tabId}`);
      return false;
    }
    try {
      // loadURL 在主框架加载完成时 resolve；失败（含被新导航取代）时 reject → false
      await entry.view.webContents.loadURL(url);
      return true;
    } catch (err) {
      logWarn('browser', `navigate 失败（tabId=${tabId}，url=${url}）`, err);
      return false;
    }
  }

  async goBack(tabId: string): Promise<boolean> {
    const entry = this.guardNavigation('goBack', tabId);
    if (entry === null) return false;
    const history = entry.view.webContents.navigationHistory;
    if (!history.canGoBack()) {
      logWarn('browser', `goBack 无后退历史（tabId=${tabId}）`);
      return false;
    }
    history.goBack();
    return true;
  }

  async goForward(tabId: string): Promise<boolean> {
    const entry = this.guardNavigation('goForward', tabId);
    if (entry === null) return false;
    const history = entry.view.webContents.navigationHistory;
    if (!history.canGoForward()) {
      logWarn('browser', `goForward 无前进历史（tabId=${tabId}）`);
      return false;
    }
    history.goForward();
    return true;
  }

  async reload(tabId: string): Promise<boolean> {
    const entry = this.guardNavigation('reload', tabId);
    if (entry === null) return false;
    entry.view.webContents.reload();
    return true;
  }

  async getTabs(): Promise<TabInfo[]> {
    return this.tabManager.list().map((e) => this.toTabInfo(e, e.info.id === this.activeTabId));
  }

  async getActiveTab(): Promise<TabInfo | null> {
    if (this.activeTabId === null) return null;
    const entry = this.tabManager.get(this.activeTabId);
    return entry === undefined ? null : this.toTabInfo(entry, true);
  }

  async getPageSnapshot(tabId: string): Promise<PageSnapshot | null> {
    const entry = this.tabManager.get(tabId);
    if (entry === undefined) return null; // L3：tab 不存在
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return null; // L3：webContents 已销毁
    // L0–L2 由 PageReader 编排（§8.1/§8.5）：注入只读采集脚本 + normalize 校验 + 降级阶梯
    return this.pageReader.snapshot(wc);
  }

  dispose(): void {
    if (this.disposed) return; // 幂等（§2.1）：before-quit 与窗口 closed 可能重复调用
    this.disposed = true;
    const tabCount = this.tabManager.list().length;
    this.tabManager.dispose(); // 全量清理，不走最后 Tab 策略
    this.activeTabId = null;
    this.lastContentBounds = null;
    logInfo('browser', `dispose 完成（已清理 ${tabCount} 个标签页）`);
  }

  // UI 上报内容区 bounds（§6 ui:content-bounds 通道；T3 渲染层 ResizeObserver 接入）
  setContentBounds(bounds: ContentBounds): void {
    if (
      !Number.isFinite(bounds.x) ||
      !Number.isFinite(bounds.y) ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height) ||
      bounds.x < 0 ||
      bounds.y < 0 ||
      bounds.width <= 0 ||
      bounds.height <= 0
    ) {
      logWarn('browser', `忽略非法内容区 bounds：${JSON.stringify(bounds)}`);
      return;
    }
    this.lastContentBounds = bounds;
    if (this.activeTabId !== null) {
      this.tabManager.get(this.activeTabId)?.view.setBounds(bounds);
    }
  }

  // 活动 Tab 可见 + 应用最新 bounds + 聚焦；其余全部不可见（§6：不用 removeChildView）
  private applyActiveVisual(): void {
    if (this.activeTabId === null) return;
    const bounds = this.lastContentBounds ?? this.options.getFallbackBounds();
    for (const entry of this.tabManager.list()) {
      const isActive = entry.info.id === this.activeTabId;
      entry.view.setVisible(isActive);
      if (isActive) {
        entry.view.setBounds(bounds);
        entry.view.webContents.focus();
      }
    }
  }

  private guardNavigation(method: string, tabId: string): TabEntry | null {
    if (this.disposed) return null;
    const entry = this.tabManager.get(tabId);
    if (entry === undefined) logWarn('browser', `${method} 未知 tabId=${tabId}`);
    return entry ?? null;
  }

  private toTabInfo(entry: TabEntry, active: boolean): TabInfo {
    return { ...entry.info, active };
  }

  private pushState(): void {
    if (this.disposed) return;
    this.options.onTabsStateChanged?.({
      tabs: this.tabManager.list().map((e) => this.toTabInfo(e, e.info.id === this.activeTabId)),
      activeTabId: this.activeTabId,
    });
  }

  private assertAlive(): void {
    if (this.disposed) {
      // dispose 后创建标签页属未预期内部调用（IPC 层已通过 sender 校验拦截），契约豁免 reject
      throw new Error('BrowserController 已销毁，无法创建标签页');
    }
  }
}
