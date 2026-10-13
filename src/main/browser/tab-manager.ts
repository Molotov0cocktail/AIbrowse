// TabManager: WebContentsView 创建/销毁/bounds/事件→TabInfo 的单一登记表.
// Contract source: doc/detailed-design.md §5/§6（Q2 决议，定稿）.
// 依赖方向：仅被 BrowserController 调用，不反向引用 controller（分层纪律）.

import { randomUUID } from 'node:crypto';
import { WebContentsView, type BaseWindow, type Session, type WebContents } from 'electron';
import type { TabInfo } from '../../shared/types/browser';
import { ALLOWED_SCHEME_PATTERN, redactTabIdForLog, redactUrlForLog } from '../../shared/url';
import { logError, logWarn } from '../logger';
import { transition } from './tab-state';
import { NativePopupNavigation } from './native-popup-navigation';
import type {
  BrowserBookmarkInput,
  BrowserVisitTitleUpdate,
} from '../../shared/types/browser-library';

// 登记表条目的可变信息；active 由 controller 组装 TabsState 时填充（§2.3 单一事实源）
export type TabEntryInfo = Omit<TabInfo, 'active'>;

export interface PendingTabLoad {
  serial: number;
  purpose: 'materialize' | 'navigation';
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  promise: Promise<boolean>;
  cancel(): void;
}

export interface TabEntry {
  readonly taskOwned: boolean;
  readonly openedByTabId?: string;
  committedUrl: string | null;
  committedNavigationSerial: number;
  historyVisitId: string | null;
  view: WebContentsView;
  // A destroyed WebContentsView can clear its getter before emitting destroyed.
  // Retain the original reference so teardown never dereferences that getter.
  readonly webContents: WebContents;
  info: TabEntryInfo;
  cleanupFns: Array<() => void>;
  // Document epochs advance on main-document commits and renderer crashes.
  // A3 elementId 生命周期：导航世代计数（主框架 did-navigate 提交时递增）。快照
  // meta.documentId 由此盖章，click/fill 执行前校验世代一致——URL/标题/capturedAt
  // 均不能证明文档身份（同 URL 刷新世代同样递增；页内导航/hash 变化不递增，
  // 文档未重建时旧 elementId 依然有效）。主进程侧可信状态，页面/模型不可读写。
  generation: number;
  // Includes navigation starts before commit; same-document/subframe events do not count.
  navigationSerial: number;
  // An implicit blank tab keeps an unloaded real WebContentsView until its first
  // DOM operation shares one materialization promise. Explicit about:blank loads.
  deferredBlank: boolean;
  loadSerial: number;
  // Retain the latest load promise and terminal state until replacement or disposal.
  // Old waiters follow it, including synchronous failure, without mistaking null for success.
  latestLoad: PendingTabLoad | null;
  popupRoutingAllowed: boolean;
  popupGestureExpiresAt: number;
  popupSuppressionCount: number;
  popupRoutingEpoch: number;
}

export interface CreateTabOptions {
  taskOwned?: boolean;
  deferInitialBlankLoad?: boolean;
  allowUserPopupRouting?: boolean;
}

declare const __RELEASE__: boolean;

export interface TabManagerOptions {
  qualifiedScriptPreload?: string;
  onUserTabCreated?: (webContents: WebContents) => void;
  onNavigationCommitted?: (page: BrowserBookmarkInput) => string | null;
  onVisitTitleChanged?: (visit: BrowserVisitTitleUpdate) => void;
  ownerWindow: BaseWindow; // contentView 挂载/卸载
  session: Session; // 持久分区会话（SessionManager 提供，§7）
  onChanged: () => void; // 增删/标题/URL/状态变化 → controller 组装并推送 TabsState
  isUserTabInteractive?: (tabId: string) => boolean;
  onPopupTabCreated?: (tabId: string, background: boolean) => void;
  onTabCloseRequested?: (tabId: string) => void;
}

export class TabManager {
  // Map 追加序 = contentView 子 view 顺序 = z 序（§6 保持稳定）
  private readonly entries = new Map<string, TabEntry>();

  constructor(private readonly options: TabManagerOptions) {}

  createTab(url: string, options: CreateTabOptions = {}): TabEntry {
    const view = new WebContentsView({
      // Remote pages never load the application bridge. Qualified user-script
      // APIs live only in isolated worlds; task tabs have no preload at all.
      webPreferences: {
        ...this.remoteWebPreferences(),
        ...(options.taskOwned !== true && this.options.qualifiedScriptPreload
          ? { preload: this.options.qualifiedScriptPreload }
          : {}),
      },
    });
    return this.registerTab(url, options, view, view.webContents);
  }

  private remoteWebPreferences(): Electron.WebPreferences {
    return {
      session: this.options.session,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: typeof __RELEASE__ === 'undefined' || !__RELEASE__,
    };
  }

  private registerTab(
    url: string,
    options: CreateTabOptions,
    view: WebContentsView,
    wc: WebContents,
    openedByTabId?: string,
  ): TabEntry {
    const deferredBlank = options.deferInitialBlankLoad === true;
    // An unloaded blank view can display, focus and navigate, so the UI sees ready.
    // Snapshot, reload and scroll first load about:blank to obtain a real document.
    const info: TabEntryInfo = {
      id: randomUUID(),
      title: '',
      url,
      state: deferredBlank ? 'ready' : 'idle',
    };
    const nativeNavigation = new NativePopupNavigation(wc);
    wc.setWindowOpenHandler((details) => {
      // Every handler invocation consumes the matching native dispatch, even
      // when the application policy subsequently rejects the popup.
      const navigationLease = nativeNavigation.take(details);
      const source = this.entries.get(info.id);
      const hasGesture = source !== undefined && source.popupGestureExpiresAt > performance.now();
      if (source !== undefined) source.popupGestureExpiresAt = 0;
      const targetUrl = this.popupTarget(details);
      if (
        source !== undefined &&
        hasGesture &&
        targetUrl !== null &&
        source.popupRoutingAllowed &&
        source.popupSuppressionCount === 0 &&
        this.hasCommittedPopupSource(source) &&
        this.options.isUserTabInteractive?.(info.id) === true
      ) {
        const generation = source.generation;
        const navigationSerial = source.navigationSerial;
        const popupRoutingEpoch = source.popupRoutingEpoch;
        const sourceIsCurrent = (): boolean =>
          this.entries.get(info.id) === source &&
          !wc.isDestroyed() &&
          source.generation === generation &&
          source.navigationSerial === navigationSerial &&
          source.popupRoutingEpoch === popupRoutingEpoch &&
          source.popupSuppressionCount === 0 &&
          this.options.isUserTabInteractive?.(info.id) === true;
        return {
          action: 'allow',
          outlivesOpener: true,
          // Chromium must receive these before it creates the guest renderer.
          overrideBrowserWindowOptions: {
            webPreferences: {
              ...this.remoteWebPreferences(),
              ...(this.options.qualifiedScriptPreload
                ? { preload: this.options.qualifiedScriptPreload }
                : {}),
            },
          },
          createWindow: (nativeOptions) => {
            // Electron passes the native guest at runtime but omits this
            // property from BrowserWindowConstructorOptions' public type.
            const guest = (
              nativeOptions as Electron.BrowserWindowConstructorOptions & {
                webContents?: WebContents;
              }
            ).webContents;
            const sandboxFlags = (
              nativeOptions.webPreferences as
                (Electron.WebPreferences & { openerSandboxFlags?: unknown }) | undefined
            )?.openerSandboxFlags;
            if (
              guest?.isDestroyed() ||
              !sourceIsCurrent() ||
              (guest === undefined && navigationLease === null) ||
              (sandboxFlags !== undefined &&
                (typeof sandboxFlags !== 'number' ||
                  !Number.isSafeInteger(sandboxFlags) ||
                  sandboxFlags < 0 ||
                  sandboxFlags > 0xffffffff)) ||
              (guest === undefined &&
                navigationLease !== null &&
                (sandboxFlags ?? 0) !== navigationLease.sandboxFlags)
            ) {
              // The API requires a WebContents return even after revocation.
              // Never register or navigate a revoked popup.
              const cancelled =
                guest ??
                new WebContentsView({ webPreferences: this.remoteWebPreferences() }).webContents;
              queueMicrotask(() => {
                if (!cancelled.isDestroyed()) cancelled.close({ waitForBeforeUnload: false });
              });
              return cancelled;
            }
            const view = new WebContentsView({
              ...(guest === undefined ? {} : { webContents: guest }),
              webPreferences: {
                ...this.remoteWebPreferences(),
                ...(this.options.qualifiedScriptPreload
                  ? { preload: this.options.qualifiedScriptPreload }
                  : {}),
                ...(sandboxFlags === undefined ? {} : { openerSandboxFlags: sandboxFlags }),
              },
            });
            const child = this.registerTab(
              targetUrl,
              { allowUserPopupRouting: true },
              view,
              view.webContents,
              info.id,
            );
            if (guest === undefined) {
              try {
                if (!sourceIsCurrent() || !navigationLease?.navigate(child.webContents)) {
                  this.closeTab(child.info.id);
                  return child.webContents;
                }
              } catch {
                this.closeTab(child.info.id);
                logWarn('browser', '原生新标签页导航失败');
                return child.webContents;
              }
            }
            this.clearPopupGestures();
            this.options.onPopupTabCreated?.(
              child.info.id,
              details.disposition === 'background-tab',
            );
            return child.webContents;
          },
        };
      }
      logWarn(
        'browser',
        `已拦截 window.open 新窗口请求（tabId=${redactTabIdForLog(info.id)}）：${redactUrlForLog(details.url)}`,
      );
      return { action: 'deny' };
    });

    const cleanupFns = this.wireEvents(wc, info);
    cleanupFns.push(() => nativeNavigation.dispose());
    this.options.ownerWindow.contentView.addChildView(view);
    view.setVisible(false); // 可见性由 controller 统一管理（活动 Tab 才可见）
    const entry: TabEntry = {
      taskOwned: options.taskOwned === true,
      ...(openedByTabId === undefined ? {} : { openedByTabId }),
      committedUrl: null,
      committedNavigationSerial: -1,
      historyVisitId: null,
      view,
      webContents: wc,
      info,
      cleanupFns,
      generation: deferredBlank ? 0 : 1,
      navigationSerial: 0,
      deferredBlank,
      loadSerial: 0,
      latestLoad: null,
      popupRoutingAllowed: options.allowUserPopupRouting === true,
      popupGestureExpiresAt: 0,
      popupSuppressionCount: 0,
      popupRoutingEpoch: 0,
    };
    this.entries.set(info.id, entry);

    // 防御：正常情况下 closeTab/dispose 先移除条目；此处兜底意外销毁
    wc.once('destroyed', () => {
      if (this.entries.has(info.id)) this.requestCloseTab(info.id);
    });

    if (!entry.taskOwned) {
      try {
        this.options.onUserTabCreated?.(wc);
      } catch {
        logWarn('browser', '用户标签页初始化观察失败');
      }
    }
    this.options.onChanged();
    return entry;
  }

  get(tabId: string): TabEntry | undefined {
    return this.entries.get(tabId);
  }

  list(): TabEntry[] {
    return [...this.entries.values()];
  }

  clearPopupGestures(): void {
    for (const entry of this.entries.values()) {
      entry.popupGestureExpiresAt = 0;
      entry.popupRoutingEpoch += 1;
    }
  }

  suppressUserPopups(tabId: string): () => void {
    const entry = this.entries.get(tabId);
    if (entry === undefined) return () => {};
    entry.popupGestureExpiresAt = 0;
    entry.popupRoutingEpoch += 1;
    entry.popupSuppressionCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.popupGestureExpiresAt = 0;
      entry.popupRoutingEpoch += 1;
      entry.popupSuppressionCount -= 1;
    };
  }

  private popupTarget(details: Electron.HandlerDetails): string | null {
    if (
      details.url.length > 8192 ||
      !['default', 'foreground-tab', 'background-tab', 'new-window'].includes(details.disposition)
    )
      return null;
    if (details.url === 'about:blank') return details.postBody === undefined ? details.url : null;
    try {
      const target = new URL(details.url);
      return (target.protocol === 'https:' || target.protocol === 'http:') &&
        target.username === '' &&
        target.password === ''
        ? target.href
        : null;
    } catch {
      return null;
    }
  }

  private hasCommittedPopupSource(source: TabEntry): boolean {
    if (
      source.taskOwned ||
      source.committedUrl === null ||
      source.committedNavigationSerial !== source.navigationSerial
    )
      return false;
    try {
      const origin = new URL(source.committedUrl);
      return (
        (origin.protocol === 'https:' || origin.protocol === 'http:') &&
        origin.username === '' &&
        origin.password === ''
      );
    } catch {
      return false;
    }
  }

  private requestCloseTab(tabId: string): void {
    this.options.onTabCloseRequested?.(tabId);
    // Standalone managers and disposed controllers still release their views.
    if (this.entries.has(tabId)) this.closeTab(tabId);
  }

  closeTab(tabId: string): boolean {
    const entry = this.entries.get(tabId);
    if (entry === undefined) return false;
    // 顺序（§6）：移除条目 → removeChildView（对非子 view 是 no-op）→ 关闭 → 逐一移除监听器
    this.invalidateLoads(entry);
    this.entries.delete(tabId);
    // 窗口 closed 后 BaseWindow 已销毁，contentView 不可再操作；此时跳过摘除（窗口即将销毁）
    if (!this.options.ownerWindow.isDestroyed()) {
      this.options.ownerWindow.contentView.removeChildView(entry.view);
    }
    if (!entry.webContents.isDestroyed()) {
      // 浏览器语义：关闭标签页必须立即生效，不等页面 beforeunload
      entry.webContents.close({ waitForBeforeUnload: false });
    }
    entry.cleanupFns.forEach((fn) => fn());
    this.options.onChanged();
    return true;
  }

  dispose(): void {
    for (const tabId of [...this.entries.keys()]) this.closeTab(tabId);
  }

  private invalidateLoads(entry: TabEntry): void {
    entry.loadSerial += 1;
    entry.latestLoad?.cancel();
    entry.deferredBlank = false;
    entry.latestLoad = null;
  }

  // 注册全部 webContents 监听器并返回逐一移除的清理函数（生命周期纪律，§5）。
  // 显式逐个注册：类型完全走 Electron 事件签名，关闭标签时一一 removeListener。
  private wireEvents(wc: WebContents, info: TabEntryInfo): Array<() => void> {
    const cleanup: Array<() => void> = [];
    const grantPopupGesture = (): void => {
      const entry = this.entries.get(info.id);
      if (
        entry === undefined ||
        !entry.popupRoutingAllowed ||
        entry.popupSuppressionCount !== 0 ||
        this.options.isUserTabInteractive?.(info.id) !== true
      )
        return;
      entry.popupGestureExpiresAt = performance.now() + 1000;
    };
    const clearPopupGesture = (): void => {
      const entry = this.entries.get(info.id);
      if (entry !== undefined) {
        entry.popupGestureExpiresAt = 0;
        entry.popupRoutingEpoch += 1;
      }
    };
    const onMouse = (_event: Electron.Event, mouse: Electron.MouseInputEvent): void => {
      if (mouse.type === 'mouseUp' && (mouse.button === 'left' || mouse.button === 'middle'))
        grantPopupGesture();
    };
    const onInput = (_event: Electron.Event, input: Electron.Input): void => {
      if (
        input.type === 'keyDown' &&
        !input.isAutoRepeat &&
        !input.isComposing &&
        (input.key === 'Enter' || input.key === ' ')
      )
        grantPopupGesture();
    };
    wc.on('before-mouse-event', onMouse);
    wc.on('before-input-event', onInput);
    wc.on('blur', clearPopupGesture);
    cleanup.push(() => wc.removeListener('before-mouse-event', onMouse));
    cleanup.push(() => wc.removeListener('before-input-event', onInput));
    cleanup.push(() => wc.removeListener('blur', clearPopupGesture));
    // A crash retires the document until a new main-document navigation begins.
    // Late load callbacks must not present the dead document as a healthy page.
    let crashed = false;

    // The WebContents spinner also starts for same-document and subframe loads.
    // Those loads have no main-frame did-finish-load and must not strand the tab in loading.
    const onStartLoading = (): void => {
      if (crashed) return;
      info.state = transition(info.state, {
        type: 'start-loading',
        isMainFrame: wc.isLoadingMainFrame(),
      });
      this.options.onChanged();
    };
    wc.on('did-start-loading', onStartLoading);
    cleanup.push(() => wc.removeListener('did-start-loading', onStartLoading));

    // A subframe may already own the spinner when a new main-document navigation
    // begins, so Chromium need not emit another did-start-loading event.
    const onStartNavigation = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ): void => {
      if (!details.isMainFrame || details.isSameDocument) return;
      clearPopupGesture();
      crashed = false;
      delete info.failure;
      const entry = this.entries.get(info.id);
      if (entry !== undefined) {
        entry.navigationSerial += 1;
        entry.historyVisitId = null;
      }
      info.state = transition(info.state, { type: 'start-loading', isMainFrame: true });
      this.options.onChanged();
    };
    wc.on('did-start-navigation', onStartNavigation);
    cleanup.push(() => wc.removeListener('did-start-navigation', onStartNavigation));

    const onFinishLoad = (): void => {
      if (crashed) return;
      delete info.failure;
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
      if (crashed) return;
      if (isMainFrame && errorCode !== -3) {
        info.failure = 'load-failed';
        // -3（ERR_ABORTED）为导航竞态，由 transition 统一忽略；这里只记录真实失败
        logWarn(
          'browser',
          `页面加载失败（tabId=${redactTabIdForLog(info.id)}，errorCode=${errorCode}）`,
        );
      }
      info.state = transition(info.state, { type: 'fail-load', isMainFrame, errorCode });
      this.options.onChanged();
    };
    wc.on('did-fail-load', onFailLoad);
    cleanup.push(() => wc.removeListener('did-fail-load', onFailLoad));

    const onTitleUpdated = (_e: Electron.Event, title: string): void => {
      if (crashed) return;
      info.title = title;
      const entry = this.entries.get(info.id);
      if (entry?.historyVisitId && entry.committedUrl !== null && !entry.taskOwned) {
        try {
          this.options.onVisitTitleChanged?.({
            id: entry.historyVisitId,
            url: entry.committedUrl,
            title,
          });
        } catch {
          logWarn('browser', '浏览历史标题保存失败');
        }
      }
      this.options.onChanged();
    };
    wc.on('page-title-updated', onTitleUpdated);
    cleanup.push(() => wc.removeListener('page-title-updated', onTitleUpdated));

    const onNavigate = (_e: Electron.Event, url: string): void => {
      if (crashed) return;
      info.url = url; // 主框架导航提交后的实际 URL（含重定向结果）
      // A3：主框架提交 = 新文档建立（跨 URL 导航与同 URL 刷新均触发；did-navigate
      // 仅主框架、页内导航走 did-navigate-in-page 不触发）→ 导航世代递增，旧 elementId
      // 世代过期（执行前主进程侧校验 → stale-element）。事件触发时条目已登记。
      const entry = this.entries.get(info.id);
      if (entry !== undefined) {
        entry.generation += 1;
        entry.committedNavigationSerial = entry.navigationSerial;
        info.title = '';
        this.recordCommit(entry, url, '');
      }
      this.options.onChanged();
    };
    wc.on('did-navigate', onNavigate);
    cleanup.push(() => wc.removeListener('did-navigate', onNavigate));

    const onNavigateInPage = (_e: Electron.Event, url: string, isMainFrame: boolean): void => {
      if (crashed) return;
      if (!isMainFrame) return; // 仅主框架的页内导航更新 URL
      info.url = url;
      const entry = this.entries.get(info.id);
      if (entry !== undefined) this.recordCommit(entry, url, info.title);
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
          `已拦截非白名单导航（tabId=${redactTabIdForLog(info.id)}）：${redactUrlForLog(details.url)}`,
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
          `已拦截非白名单重定向（tabId=${redactTabIdForLog(info.id)}）：${redactUrlForLog(details.url)}`,
        );
      }
    };
    wc.on('will-redirect', onWillRedirect);
    cleanup.push(() => wc.removeListener('will-redirect', onWillRedirect));

    const onRenderGone = (): void => {
      clearPopupGesture();
      crashed = true;
      const entry = this.entries.get(info.id);
      if (entry !== undefined) {
        // Retire authorization before resolving cancelled readers or navigations.
        // Keep the user's tab and URL; only an explicit navigation can recover it.
        entry.generation += 1;
        entry.navigationSerial += 1;
        entry.historyVisitId = null;
        this.invalidateLoads(entry);
      }
      info.state = 'error';
      info.failure = 'renderer-gone';
      logError('browser', `渲染进程退出（tabId=${redactTabIdForLog(info.id)}）`);
      this.options.onChanged();
    };
    wc.on('render-process-gone', onRenderGone);
    cleanup.push(() => wc.removeListener('render-process-gone', onRenderGone));

    return cleanup;
  }

  private recordCommit(entry: TabEntry, url: string, title: string): void {
    entry.committedUrl = url;
    entry.historyVisitId = null;
    if (entry.taskOwned || !/^https?:\/\//i.test(url)) return;
    try {
      entry.historyVisitId = this.options.onNavigationCommitted?.({ url, title }) ?? null;
    } catch {
      logWarn('browser', '浏览历史保存失败');
    }
  }
}
