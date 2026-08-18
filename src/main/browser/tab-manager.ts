// TabManager: WebContentsView 创建/销毁/bounds/事件→TabInfo 的单一登记表.
// Contract source: doc/detailed-design.md §5/§6（Q2 决议，定稿）.
// 依赖方向：仅被 BrowserController 调用，不反向引用 controller（分层纪律）.

import { randomUUID } from 'node:crypto';
import { WebContentsView, type BaseWindow, type Session, type WebContents } from 'electron';
import type { TabInfo } from '../../shared/types/browser';
import { ALLOWED_SCHEME_PATTERN, redactUrlForLog } from '../../shared/url';
import { logError, logWarn } from '../logger';
import { transition } from './tab-state';

// 登记表条目的可变信息；active 由 controller 组装 TabsState 时填充（§2.3 单一事实源）
export type TabEntryInfo = Omit<TabInfo, 'active'>;

export interface TabEntry {
  view: WebContentsView;
  info: TabEntryInfo;
  cleanupFns: Array<() => void>;
  // A3 elementId 生命周期：导航世代计数（主框架 did-navigate 提交时递增）。快照
  // meta.documentId 由此盖章，click/fill 执行前校验世代一致——URL/标题/capturedAt
  // 均不能证明文档身份（同 URL 刷新世代同样递增；页内导航/hash 变化不递增，
  // 文档未重建时旧 elementId 依然有效）。主进程侧可信状态，页面/模型不可读写。
  generation: number;
}

export interface TabManagerOptions {
  ownerWindow: BaseWindow; // contentView 挂载/卸载
  session: Session; // 持久分区会话（SessionManager 提供，§7）
  onChanged: () => void; // 增删/标题/URL/状态变化 → controller 组装并推送 TabsState
}

export class TabManager {
  // Map 追加序 = contentView 子 view 顺序 = z 序（§6 保持稳定）
  private readonly entries = new Map<string, TabEntry>();

  constructor(private readonly options: TabManagerOptions) {}

  createTab(url: string): TabEntry {
    const view = new WebContentsView({
      // 安全基线（§11）：远程网页无 preload、无 Node 集成；显式声明，不依赖默认值
      webPreferences: {
        session: this.options.session,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // 不配置 preload：远程网页不得获得任何 bridge（§3.2 最小权限）
      },
    });
    const info: TabEntryInfo = { id: randomUUID(), title: '', url, state: 'idle' };
    const wc = view.webContents;

    wc.setWindowOpenHandler(({ url: targetUrl }) => {
      logWarn(
        'browser',
        `已拦截 window.open 新窗口请求（tabId=${info.id}）：${redactUrlForLog(targetUrl)}`,
      );
      return { action: 'deny' };
    });

    const cleanupFns = this.wireEvents(wc, info);
    this.options.ownerWindow.contentView.addChildView(view);
    view.setVisible(false); // 可见性由 controller 统一管理（活动 Tab 才可见）
    this.entries.set(info.id, { view, info, cleanupFns, generation: 1 });

    // 防御：正常情况下 closeTab/dispose 先移除条目；此处兜底意外销毁
    wc.once('destroyed', () => {
      if (this.entries.has(info.id)) {
        this.entries.delete(info.id);
        logWarn('browser', `webContents 意外销毁（tabId=${info.id}），已从登记表移除`);
        this.options.onChanged();
      }
    });

    this.options.onChanged();
    return { view, info, cleanupFns, generation: 1 };
  }

  get(tabId: string): TabEntry | undefined {
    return this.entries.get(tabId);
  }

  list(): TabEntry[] {
    return [...this.entries.values()];
  }

  closeTab(tabId: string): boolean {
    const entry = this.entries.get(tabId);
    if (entry === undefined) return false;
    // 顺序（§6）：移除条目 → removeChildView（对非子 view 是 no-op）→ 关闭 → 逐一移除监听器
    this.entries.delete(tabId);
    // 窗口 closed 后 BaseWindow 已销毁，contentView 不可再操作；此时跳过摘除（窗口即将销毁）
    if (!this.options.ownerWindow.isDestroyed()) {
      this.options.ownerWindow.contentView.removeChildView(entry.view);
    }
    if (!entry.view.webContents.isDestroyed()) {
      // 浏览器语义：关闭标签页必须立即生效，不等页面 beforeunload
      entry.view.webContents.close({ waitForBeforeUnload: false });
    }
    entry.cleanupFns.forEach((fn) => fn());
    this.options.onChanged();
    return true;
  }

  dispose(): void {
    for (const tabId of [...this.entries.keys()]) this.closeTab(tabId);
  }

  // 注册全部 webContents 监听器并返回逐一移除的清理函数（生命周期纪律，§5）。
  // 显式逐个注册：类型完全走 Electron 事件签名，关闭标签时一一 removeListener。
  private wireEvents(wc: WebContents, info: TabEntryInfo): Array<() => void> {
    const cleanup: Array<() => void> = [];

    // did-start-loading / did-finish-load 只对应主框架（子框架事件另有 did-frame-* 通道）
    const onStartLoading = (): void => {
      info.state = transition(info.state, { type: 'start-loading', isMainFrame: true });
      this.options.onChanged();
    };
    wc.on('did-start-loading', onStartLoading);
    cleanup.push(() => wc.removeListener('did-start-loading', onStartLoading));

    const onFinishLoad = (): void => {
      info.state = transition(info.state, { type: 'finish-load', isMainFrame: true });
      this.options.onChanged();
    };
    wc.on('did-finish-load', onFinishLoad);
    cleanup.push(() => wc.removeListener('did-finish-load', onFinishLoad));

    const onFailLoad = (
      _e: Electron.Event,
      errorCode: number,
      _desc: string,
      _url: string,
      isMainFrame: boolean,
    ): void => {
      if (isMainFrame && errorCode !== -3) {
        // -3（ERR_ABORTED）为导航竞态，由 transition 统一忽略；这里只记录真实失败
        logWarn('browser', `页面加载失败（tabId=${info.id}，errorCode=${errorCode}）`);
      }
      info.state = transition(info.state, { type: 'fail-load', isMainFrame, errorCode });
      this.options.onChanged();
    };
    wc.on('did-fail-load', onFailLoad);
    cleanup.push(() => wc.removeListener('did-fail-load', onFailLoad));

    const onTitleUpdated = (_e: Electron.Event, title: string): void => {
      info.title = title;
      this.options.onChanged();
    };
    wc.on('page-title-updated', onTitleUpdated);
    cleanup.push(() => wc.removeListener('page-title-updated', onTitleUpdated));

    const onNavigate = (_e: Electron.Event, url: string): void => {
      info.url = url; // 主框架导航提交后的实际 URL（含重定向结果）
      // A3：主框架提交 = 新文档建立（跨 URL 导航与同 URL 刷新均触发；did-navigate
      // 仅主框架、页内导航走 did-navigate-in-page 不触发）→ 导航世代递增，旧 elementId
      // 世代过期（执行前主进程侧校验 → stale-element）。事件触发时条目已登记。
      const entry = this.entries.get(info.id);
      if (entry !== undefined) entry.generation += 1;
      this.options.onChanged();
    };
    wc.on('did-navigate', onNavigate);
    cleanup.push(() => wc.removeListener('did-navigate', onNavigate));

    const onNavigateInPage = (_e: Electron.Event, url: string, isMainFrame: boolean): void => {
      if (!isMainFrame) return; // 仅主框架的页内导航更新 URL
      info.url = url;
      this.options.onChanged();
    };
    wc.on('did-navigate-in-page', onNavigateInPage);
    cleanup.push(() => wc.removeListener('did-navigate-in-page', onNavigateInPage));

    // 导航白名单（§9 + R-02）：仅 http/https/about，其余拦截 + warn。
    // will-navigate 覆盖页面发起导航（含 location.replace）；will-redirect 覆盖服务器重定向
    // （302 目标同样过白名单——程序化 loadURL 遇 302 时唯一拦截点，T5 R-02 加固）。
    const onWillNavigate = (
      details: Electron.Event<Electron.WebContentsWillNavigateEventParams>,
    ): void => {
      if (!ALLOWED_SCHEME_PATTERN.test(details.url)) {
        details.preventDefault();
        logWarn(
          'browser',
          `已拦截非白名单导航（tabId=${info.id}）：${redactUrlForLog(details.url)}`,
        );
      }
    };
    wc.on('will-navigate', onWillNavigate);
    cleanup.push(() => wc.removeListener('will-navigate', onWillNavigate));

    const onWillRedirect = (
      details: Electron.Event<Electron.WebContentsWillRedirectEventParams>,
    ): void => {
      if (!ALLOWED_SCHEME_PATTERN.test(details.url)) {
        details.preventDefault();
        logWarn(
          'browser',
          `已拦截非白名单重定向（tabId=${info.id}）：${redactUrlForLog(details.url)}`,
        );
      }
    };
    wc.on('will-redirect', onWillRedirect);
    cleanup.push(() => wc.removeListener('will-redirect', onWillRedirect));

    const onRenderGone = (): void => {
      // §4：渲染进程退出 → 该 Tab 立即降级为 error（快照走 L2/L3 路径）。
      // 不属于三事件状态机（transition 只覆盖加载事件），按契约直接置 error。
      info.state = 'error';
      logError('browser', `渲染进程退出（tabId=${info.id}）`);
      this.options.onChanged();
    };
    wc.on('render-process-gone', onRenderGone);
    cleanup.push(() => wc.removeListener('render-process-gone', onRenderGone));

    return cleanup;
  }
}
