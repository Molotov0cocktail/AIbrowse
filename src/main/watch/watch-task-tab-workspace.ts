// Sixth Stage D6: WatchTaskTabWorkspace —— Session run 精确 task-tab 所有权
//（detailed-design §4.3/§8.1、threat-model WT-11/WT-12、FIXED DECISIONS 8）。
// 参考 ResearchWorkspace（C2）已验证模式，但单独实现 Watch 语义（零 Electron
// import；只经窄 Browser 端口）。
//
// 状态机：open → create-in-flight → provisional-owned → owned → releasing。
// 语义要点：
// - 新 tabId 在确认不属于 tabsBefore 后立即 provisional 登记，再检查 abort/
//   后置快照；create 返回空 id 或既有 id：零登记、零关闭、unavailable（失败）；
// - stop/abort/shutdown（closing/drain）期间拒绝新 acquire；已开始 create
//   必须落定、验证所有权并清理；
// - 焦点恢复三态：未切换→恢复 activeBefore；用户已切换→零 activate；
//   activeBefore 已关闭→不创建替代、不猜焦点；恢复失败先精确清理 task Tab
//   并失败（焦点处理完成前不读取页面由 Router 时序保证）；
// - release（attempt 收尾）：closeTab=true/已消失 → 确认清理并移除所有权；
//   closeTab=false/抛错 → ownership 保留、调用 onCleanupFailure（装配层接
//   WatchLifecycleCoordinator.markUnavailable）、当前 attempt 零 Projection；
//   用户主动关闭 task Tab：从 ownership 移除但当前 attempt 失败；
// - cleanupAll() 并发调用共享同一 drain Promise；失败 ownership 不丢失，
//   后续调用可重试；全部 owned/provisional/in-flight 事实只在内存。
import type { TabInfo } from '../../shared/types/browser';
import type { SourceScope } from '../../shared/types/sources';
import { normalizeSourceUrl } from '../sources/domain/source-canonical';
import { logInfo, logWarn } from '../logger';

export type WatchWorkspaceErrorCode =
  | 'invalid-url'
  | 'workspace-busy'
  | 'tab-create-aborted'
  | 'tab-create-failed'
  | 'tab-closed-by-user'
  | 'tab-restore-focus-failed'
  | 'cleanup-failed'
  | 'workspace-internal';

export interface WatchTaskTabLease {
  tabId: string;
  url: string; // normalizeSourceUrl(page) displayUrl
}

export type WatchTaskTabAcquireResult =
  | { ok: true; lease: WatchTaskTabLease; warnings?: string[] }
  | { ok: false; errorCode: WatchWorkspaceErrorCode; reason: string };

export type WatchTaskTabReleaseResult =
  | { ok: true; userClosed: boolean; warnings?: string[] } // userClosed=true=已被用户关闭，零动作
  | { ok: false; errorCode: Extract<WatchWorkspaceErrorCode, 'cleanup-failed'>; reason: string };

export type WatchCleanupAllResult =
  | { ok: true; closedCount: number; retainedCount: number; warnings?: string[] }
  | {
      ok: false;
      errorCode: Extract<WatchWorkspaceErrorCode, 'cleanup-failed'>;
      reason: string;
      closedCount: number;
      retainedCount: number;
    };

// BrowserController 最小结构端口（BrowserControllerImpl 结构兼容；产品契约不变，
// Workspace 方法白名单不可扩大）
export interface WatchTaskTabBrowser {
  createTab(url: string): Promise<TabInfo>;
  closeTab(tabId: string): Promise<boolean>;
  activateTab(tabId: string): Promise<boolean>;
  getTabs(): Promise<TabInfo[]>;
  getActiveTab(): Promise<TabInfo | null>;
}

export interface WatchTaskTabWorkspaceOptions {
  browser: WatchTaskTabBrowser;
  /** closeTab=false/抛错（清理事实失败）时回调；装配层接 WatchLifecycleCoordinator.markUnavailable。 */
  onCleanupFailure?: () => void;
}

interface FocusOutcome {
  errorCode: Exclude<WatchWorkspaceErrorCode, 'cleanup-failed'> | null;
  reason: string;
  warning: string | null;
}

function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export class WatchTaskTabWorkspace {
  private readonly browser: WatchTaskTabBrowser;
  private readonly onCleanupFailure: () => void;
  private readonly owned = new Set<string>();
  private readonly ownedUrls = new Map<string, string>();
  private inFlightCount = 0;
  private closing = false;
  private drainWaiters: Array<() => void> = [];
  private drainPromise: Promise<WatchCleanupAllResult> | null = null;

  constructor(options: WatchTaskTabWorkspaceOptions) {
    this.browser = options.browser;
    this.onCleanupFailure = options.onCleanupFailure ?? (() => {});
  }

  isOwned(tabId: string): boolean {
    return typeof tabId === 'string' && this.owned.has(tabId);
  }

  getOwnedTabIds(): readonly string[] {
    return [...this.owned];
  }

  getOwnedCount(): number {
    return this.owned.size;
  }

  // -------------------------------------------------------------------------
  // acquire：open → create-in-flight → provisional-owned → owned
  // -------------------------------------------------------------------------

  async acquire(url: string, signal: AbortSignal): Promise<WatchTaskTabAcquireResult> {
    const norm = normalizeSourceUrl(url, 'page' as SourceScope);
    if (!norm.ok) {
      return { ok: false, errorCode: 'invalid-url', reason: norm.reason };
    }
    if (this.closing) {
      return {
        ok: false,
        errorCode: 'workspace-busy',
        reason: '工作区正在清理/排水，拒绝新建任务标签页',
      };
    }
    if (signal.aborted) {
      return { ok: false, errorCode: 'tab-create-aborted', reason: '创建前已取消' };
    }
    this.inFlightCount += 1;
    try {
      let tabsBefore: Set<string>;
      let activeBefore: string | null;
      try {
        const tabs = await this.browser.getTabs();
        tabsBefore = new Set(tabs.map((t) => t.id));
        activeBefore = (await this.browser.getActiveTab())?.id ?? null;
      } catch (err) {
        logWarn('watch', '读取标签页状态失败（未创建任务标签页）', err);
        return { ok: false, errorCode: 'workspace-internal', reason: '读取标签页状态失败' };
      }

      if (signal.aborted) {
        return { ok: false, errorCode: 'tab-create-aborted', reason: '创建前已取消' };
      }

      let newTabId: string | null = null;
      try {
        const tab = await this.browser.createTab(norm.displayUrl);
        // 所有权证明优先于取消分类：空 id / 既有 id → 零登记、零关闭、失败
        if (typeof tab.id !== 'string' || tab.id === '' || tabsBefore.has(tab.id)) {
          logWarn('watch', 'createTab 返回非法或既有 tabId，放弃登记（零关闭）');
          return {
            ok: false,
            errorCode: 'tab-create-failed',
            reason: '标签页创建异常（返回非法/既有标签页）',
          };
        }
        newTabId = tab.id;
        this.owned.add(newTabId);
        this.ownedUrls.set(newTabId, norm.displayUrl);

        if (signal.aborted) {
          // create 期间终止 → 精确清理（确认关闭才移除所有权）
          const closed = await this.tryCloseOwned(newTabId);
          if (!closed.ok) {
            return {
              ok: false,
              errorCode: 'cleanup-failed',
              reason: '关闭任务标签页失败（创建已取消）',
            };
          }
          return { ok: false, errorCode: 'tab-create-aborted', reason: '创建期间已取消' };
        }
        // 创建后存在性确认：getTabs 明确确认已消失 → 移除所有权（用户关闭）
        const tabsNow = await this.browser.getTabs();
        if (!tabsNow.some((t) => t.id === newTabId)) {
          this.owned.delete(newTabId);
          this.ownedUrls.delete(newTabId);
          return { ok: false, errorCode: 'tab-closed-by-user', reason: '标签页创建后已被用户关闭' };
        }
        // 焦点恢复三态（处理后才能读取页面——Router 时序保证）
        const focus = await this.restoreFocus(newTabId, activeBefore, tabsNow);
        if (focus.errorCode !== null) {
          const closed = await this.tryCloseOwned(newTabId);
          if (!closed.ok) {
            return {
              ok: false,
              errorCode: 'cleanup-failed',
              reason: '关闭任务标签页失败（焦点恢复失败）',
            };
          }
          return { ok: false, errorCode: focus.errorCode, reason: focus.reason };
        }
        logInfo(
          'watch',
          `任务标签页已创建（host=${urlHost(norm.displayUrl)}）`, // §13：零 tabId 入日志
        );
        const warnings = focus.warning === null ? undefined : [focus.warning];
        const lease: WatchTaskTabLease = { tabId: newTabId, url: norm.displayUrl };
        return warnings === undefined ? { ok: true, lease } : { ok: true, lease, warnings };
      } catch (err) {
        logWarn('watch', `任务标签页创建异常（host=${urlHost(norm.displayUrl)}）`, err);
        if (newTabId !== null) {
          const closed = await this.tryCloseOwned(newTabId);
          if (!closed.ok) {
            return {
              ok: false,
              errorCode: 'cleanup-failed',
              reason: '关闭任务标签页失败（创建异常清理）',
            };
          }
        }
        return { ok: false, errorCode: 'workspace-internal', reason: '标签页创建异常' };
      }
    } finally {
      this.inFlightCount -= 1;
      if (this.inFlightCount === 0 && this.drainWaiters.length > 0) {
        const waiters = this.drainWaiters;
        this.drainWaiters = [];
        for (const waiter of waiters) waiter();
      }
    }
  }

  // 焦点恢复（三态；activeBefore 已关闭 → 不重建、不猜焦点、warning 登记）
  private async restoreFocus(
    newTabId: string,
    activeBefore: string | null,
    tabsNow: TabInfo[],
  ): Promise<FocusOutcome> {
    const activeNow = tabsNow.find((t) => t.active);
    let activeTabIsTask = false;
    if (activeNow !== undefined && activeNow.id === newTabId) activeTabIsTask = true;
    // 用户已在 create 窗口切换 → 零 activate（不抢焦点）
    if (!activeTabIsTask) {
      return { errorCode: null, reason: '', warning: null };
    }
    if (activeBefore === null) {
      return { errorCode: null, reason: '', warning: '焦点恢复：创建前无活动标签页（未恢复）' };
    }
    if (!tabsNow.some((t) => t.id === activeBefore)) {
      // 原 active Tab 已关闭：不创建替代、不猜焦点
      return {
        errorCode: null,
        reason: '',
        warning: '焦点恢复：原活动标签页已关闭（不重建、不猜焦点）',
      };
    }
    try {
      const restored = await this.browser.activateTab(activeBefore);
      if (!restored) {
        return {
          errorCode: 'tab-restore-focus-failed',
          reason: '恢复原活动标签页失败',
          warning: null,
        };
      }
    } catch {
      return {
        errorCode: 'tab-restore-focus-failed',
        reason: '恢复原活动标签页异常',
        warning: null,
      };
    }
    return { errorCode: null, reason: '', warning: null };
  }

  // -------------------------------------------------------------------------
  // release：attempt 收尾的精确清理（确认关闭才移除所有权）
  // -------------------------------------------------------------------------

  /**
   * attempt 最后一步：关闭精确 tabId。用户已关闭 → 移除所有权并如实报告
   * userClosed；closeTab=false/抛错 → ownership 保留、onCleanupFailure、
   * cleanup-failed（当前 attempt 零 Projection）。
   */
  async release(tabId: string): Promise<WatchTaskTabReleaseResult> {
    if (typeof tabId !== 'string' || !this.owned.has(tabId)) {
      return { ok: true, userClosed: false }; // 幂等（未持有/已清理）
    }
    // 用户可能已在读取期间关闭：getTabs 显式确认
    try {
      const tabs = await this.browser.getTabs();
      if (!tabs.some((t) => t.id === tabId)) {
        this.owned.delete(tabId);
        this.ownedUrls.delete(tabId);
        return { ok: true, userClosed: true, warnings: ['任务标签页在读取期间被用户关闭'] };
      }
    } catch {
      // getTabs 失败：继续尝试 closeTab（失败按 cleanup-failed 处理，不丢所有权）
    }
    return this.tryCloseOwned(tabId);
  }

  // closeTab 事实语义：true → 移除所有权；false/抛错 → 保留 + onCleanupFailure
  private async tryCloseOwned(tabId: string): Promise<WatchTaskTabReleaseResult> {
    let closeOk: boolean;
    try {
      closeOk = await this.browser.closeTab(tabId);
    } catch {
      closeOk = false;
    }
    if (closeOk) {
      this.owned.delete(tabId);
      this.ownedUrls.delete(tabId);
      return { ok: true, userClosed: false };
    }
    // 清理事实失败：不冒充已清理；ownership 保留供 cleanupAll/shutdown 重试
    //（§13：零 tabId 入日志）
    logWarn('watch', '任务标签页关闭失败（ownership 保留，Watch 不可用）');
    try {
      this.onCleanupFailure();
    } catch {
      // 回调失败不掩盖原结果
    }
    return {
      ok: false,
      errorCode: 'cleanup-failed',
      reason: '关闭任务标签页失败（未确认清理；Watch 已标记不可用）',
    };
  }

  // -------------------------------------------------------------------------
  // cleanupAll：并发共享 drain；失败 ownership 保留可重试
  // -------------------------------------------------------------------------

  async cleanupAll(): Promise<WatchCleanupAllResult> {
    if (this.drainPromise !== null) {
      return this.drainPromise;
    }
    this.closing = true;
    const drain = this.performCleanupAll();
    this.drainPromise = drain;
    try {
      return await drain;
    } finally {
      this.drainPromise = null;
      this.closing = false;
    }
  }

  private async performCleanupAll(): Promise<WatchCleanupAllResult> {
    // 等待 in-flight create 落定（已开始 create 必须落定、验证所有权并清理）
    while (this.inFlightCount > 0) {
      await new Promise<void>((resolve) => {
        this.drainWaiters.push(resolve);
      });
    }
    const targets = [...this.owned];
    let closedCount = 0;
    let retainedCount = 0;
    for (const tabId of targets) {
      const result = await this.tryCloseOwned(tabId);
      if (result.ok) closedCount += 1;
      else retainedCount += 1;
    }
    if (retainedCount > 0) {
      return {
        ok: false,
        errorCode: 'cleanup-failed',
        reason: `${retainedCount} 个任务标签页未能确认关闭（所有权保留，可重试）`,
        closedCount,
        retainedCount,
      };
    }
    return { ok: true, closedCount, retainedCount: 0 };
  }

  /** 观测（测试/诊断）：当前 in-flight acquire 槽数。 */
  getInFlightCount(): number {
    return this.inFlightCount;
  }
}
