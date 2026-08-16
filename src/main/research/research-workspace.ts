// Fifth Stage C2: task-owned Tab workspace (detailed-design §10/§10.1,
// adjudication #118). Precise tabId ownership — only ids returned by this
// workspace's own createTab calls are ever closed; user tabs are never
// touched. Zero Electron imports: browser access goes exclusively through the
// injected ResearchWorkspaceBrowser minimal port (structurally compatible
// with BrowserControllerImpl; the product contract is unchanged).
//
// Concurrency: MAX_RESEARCH_TABS (shared/types/research.ts, single source of
// truth) bounds owned tabs AND in-flight acquire slots together. The slot is
// reserved in the synchronous prefix (before the first await) and released in
// acquire's finally — so the 4th concurrent acquire is deterministically
// rejected before createTab is ever called, and cleanupAll's drain barrier
// waits until every in-flight acquire reached a terminal state (registered
// into the owned set, cleaned itself up, or failed with zero creation).
//
// Focus restoration (createTab auto-activates the new tab — measured contract,
// browser-controller.ts:92): after creation, if the active tab is still the
// new task tab AND activeBefore still exists → activateTab(activeBefore);
// user already switched → never steal focus; activeBefore closed → never
// recreate/activate a guess (success + Chinese warning). activateTab returns
// false while activeBefore exists (unexpected) → the new tab is precisely
// closed and tab-restore-focus-failed is returned — a new tab must not stay
// in the foreground silently while claiming the contract is met.
//
// User-close awareness: BrowserController exposes no tab-event subscription,
// so C2 adds no events/timers/listeners — checkTab() snapshots getTabs
// explicitly (C4 calls it before/after reads); a vanished owned tab is
// removed from the owned set and reported as closed-by-user.
//
// Log discipline: only tabId/taskId and the URL host are logged (zero query
// values).
import type { TabInfo } from '../../shared/types/browser';
import { MAX_RESEARCH_TABS } from '../../shared/types/research';
import { normalizeSourceUrl } from '../sources/domain/source-canonical';
import { logInfo, logWarn } from '../logger';

// 决议 #118：Workspace 局部闭合联合（不扩张 C1 ResearchErrorCode；错误码
// 映射归 C5 Runtime）。
export type WorkspaceErrorCode =
  | 'invalid-task-id'
  | 'invalid-url'
  | 'workspace-busy'
  | 'tab-limit'
  | 'not-owned'
  | 'tab-closed-by-user'
  | 'tab-create-aborted'
  | 'tab-create-failed'
  | 'tab-restore-focus-failed'
  | 'cleanup-failed'
  | 'workspace-internal';

export interface WorkspaceLease {
  taskId: string;
  tabId: string; // 本次 createTab 返回的精确 id
  url: string; // normalizeSourceUrl(url,'page') 的 displayUrl（规范展示 URL）
}

// BrowserController 最小结构端口（BrowserControllerImpl 结构兼容，typecheck
// 保证）；不修改 BrowserController/TabManager 产品契约。
export interface ResearchWorkspaceBrowser {
  createTab(url: string): Promise<TabInfo>;
  closeTab(tabId: string): Promise<boolean>;
  activateTab(tabId: string): Promise<boolean>;
  getTabs(): Promise<TabInfo[]>;
  getActiveTab(): Promise<TabInfo | null>;
}

export type AcquireResult =
  | { ok: true; lease: WorkspaceLease; warnings?: string[] }
  | { ok: false; errorCode: WorkspaceErrorCode; reason: string };

export type ReleaseResult =
  | { ok: true; closed: boolean; warnings?: string[] } // closed=false=已被用户关闭零动作
  | { ok: false; errorCode: WorkspaceErrorCode; reason: string };

export type CleanupAllResult =
  | { ok: true; closedCount: number; skippedCount: number; warnings?: string[] }
  | { ok: false; errorCode: WorkspaceErrorCode; reason: string; closedCount: number };

export type CheckTabResult =
  | { ok: true; status: 'alive'; lease: WorkspaceLease }
  | { ok: true; status: 'closed-by-user'; warnings?: string[] } // 已从所有权集合移除
  | { ok: false; errorCode: WorkspaceErrorCode; reason: string };

// 焦点恢复的确定性结果（内部）：errorCode 非 null = 必须关闭新 Tab 并失败；
// warning 非 null = 成功但如实登记（activeBefore 已关闭，未恢复焦点）。
interface FocusOutcome {
  errorCode: 'tab-restore-focus-failed' | null;
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

export class ResearchWorkspace {
  private readonly browser: ResearchWorkspaceBrowser;
  private readonly invalidTask: boolean;
  private readonly owned = new Set<string>();
  private readonly ownedUrls = new Map<string, string>(); // tabId → 规范展示 URL
  private inFlightCount = 0; // 决议 #118(5)：整个 acquire 生命周期的预留槽
  private closing = false;
  private drainWaiters: Array<() => void> = [];

  constructor(
    public readonly taskId: string,
    browser: ResearchWorkspaceBrowser,
  ) {
    this.browser = browser;
    // 非法 taskId 不抛异常：实例进入 invalid 态，全部操作安全返回 invalid-task-id
    this.invalidTask = typeof taskId !== 'string' || taskId === '';
  }

  // 同步归属检查：跨任务 Lease/伪造 tabId/非本实例 owned → false，零关闭动作
  isOwned(tabId: string): boolean {
    return typeof tabId === 'string' && this.owned.has(tabId);
  }

  getOwnedTabIds(): readonly string[] {
    return [...this.owned];
  }

  async acquire(url: string, signal: AbortSignal): Promise<AcquireResult> {
    if (this.invalidTask) {
      return { ok: false, errorCode: 'invalid-task-id', reason: '任务 ID 无效' };
    }
    // URL 边界（createTab 前）：复用 normalizeSourceUrl 的 http/https、userinfo、
    // 长度 ≤2048、控制字符校验；地址栏「非法输入转搜索」语义不进入 Workspace
    const norm = normalizeSourceUrl(url, 'page');
    if (!norm.ok) {
      return { ok: false, errorCode: 'invalid-url', reason: norm.reason };
    }
    if (this.closing) {
      return {
        ok: false,
        errorCode: 'workspace-busy',
        reason: '工作区正在清理，拒绝新建任务标签页',
      };
    }
    if (signal.aborted) {
      return { ok: false, errorCode: 'tab-create-aborted', reason: '创建前已取消' };
    }
    // 同步段并发槽检查（第一个 await 前）：owned 与 in-flight 预留槽共同计数，
    // 第 4 次并发 acquire 在调用 createTab 前确定性拒绝（决议 #118(5)）
    if (this.owned.size + this.inFlightCount >= MAX_RESEARCH_TABS) {
      return {
        ok: false,
        errorCode: 'tab-limit',
        reason: `并发任务标签页已达上限（${MAX_RESEARCH_TABS}）`,
      };
    }
    this.inFlightCount += 1;
    try {
      // 创建前状态基线（决议 #118(4)）：只读快照，绝不把用户已有 Tab 标记为任务资源
      let tabsBefore: Set<string>;
      let activeBefore: string | null;
      try {
        const tabs = await this.browser.getTabs();
        tabsBefore = new Set(tabs.map((t) => t.id));
        activeBefore = (await this.browser.getActiveTab())?.id ?? null;
      } catch (err) {
        logWarn('research', `读取标签页状态失败（taskId=${this.taskId}），未创建任务标签页`, err);
        return { ok: false, errorCode: 'workspace-internal', reason: '读取标签页状态失败' };
      }

      if (signal.aborted) {
        return { ok: false, errorCode: 'tab-create-aborted', reason: '创建前已取消' };
      }

      let newTabId: string | null = null;
      let registered = false;
      try {
        const tab = await this.browser.createTab(norm.displayUrl);
        if (signal.aborted) {
          // create 期间终止 → 创建完成后精确清理本次创建的 id 再返回 aborted
          await this.closeBestEffort(tab.id);
          return { ok: false, errorCode: 'tab-create-aborted', reason: '创建期间已取消' };
        }
        if (tabsBefore.has(tab.id)) {
          // 敌手/异常实现返回了已存在的 tabId → 不纳入所有权、绝不关闭该 Tab
          logWarn('research', `createTab 返回了已存在的 tabId（tabId=${tab.id}），放弃登记`);
          return {
            ok: false,
            errorCode: 'tab-create-failed',
            reason: '标签页创建异常（返回已存在标签页）',
          };
        }
        newTabId = tab.id;
        // 创建后存在性确认：已消失 → 不登记为存活资源
        const tabsNow = await this.browser.getTabs();
        if (!tabsNow.some((t) => t.id === newTabId)) {
          return { ok: false, errorCode: 'tab-closed-by-user', reason: '标签页创建后已被关闭' };
        }
        // 成功所有权只来自本次 createTab 返回的全新精确 id
        this.owned.add(newTabId);
        this.ownedUrls.set(newTabId, norm.displayUrl);
        registered = true;
        // 焦点恢复（决议 #118(6)）
        const focus = await this.restoreFocus(newTabId, activeBefore, tabsNow);
        if (focus.errorCode !== null) {
          // 不允许新 Tab 无声留在前台：精确关闭并失败
          this.owned.delete(newTabId);
          this.ownedUrls.delete(newTabId);
          registered = false;
          await this.closeBestEffort(newTabId);
          return { ok: false, errorCode: 'tab-restore-focus-failed', reason: focus.reason };
        }
        // 成功日志只记 tabId/taskId/URL host（零 query 值）
        logInfo(
          'research',
          `任务标签页已创建（taskId=${this.taskId}，tabId=${newTabId}，host=${urlHost(norm.displayUrl)}）`,
        );
        const warnings = focus.warning === null ? undefined : [focus.warning];
        const lease: WorkspaceLease = {
          taskId: this.taskId,
          tabId: newTabId,
          url: norm.displayUrl,
        };
        return warnings === undefined ? { ok: true, lease } : { ok: true, lease, warnings };
      } catch (err) {
        logWarn(
          'research',
          `任务标签页创建异常（taskId=${this.taskId}，url=${urlHost(norm.displayUrl)}）`,
          err,
        );
        if (newTabId !== null && !registered) {
          // 已创建但未登记/登记后已撤销 → 精确清理，不触碰用户 Tab
          await this.closeBestEffort(newTabId);
        }
        return { ok: false, errorCode: 'workspace-internal', reason: '标签页创建异常' };
      }
    } finally {
      // 决议 #118(5)/(8)：槽位覆盖整个 acquire 生命周期；drain 屏障在
      // in-flight 归零时唤醒 cleanupAll 等待者
      this.inFlightCount -= 1;
      if (this.inFlightCount === 0 && this.drainWaiters.length > 0) {
        const waiters = this.drainWaiters;
        this.drainWaiters = [];
        for (const waiter of waiters) waiter();
      }
    }
  }

  async checkTab(tabId: string): Promise<CheckTabResult> {
    if (this.invalidTask) {
      return { ok: false, errorCode: 'invalid-task-id', reason: '任务 ID 无效' };
    }
    if (typeof tabId !== 'string' || !this.owned.has(tabId)) {
      return { ok: false, errorCode: 'not-owned', reason: '标签页不属于本任务' };
    }
    const url = this.ownedUrls.get(tabId) ?? '';
    try {
      const tabs = await this.browser.getTabs();
      if (!tabs.some((t) => t.id === tabId)) {
        // 用户手动关闭 task Tab → 从所有权集合移除（零关闭动作）
        this.owned.delete(tabId);
        this.ownedUrls.delete(tabId);
        return { ok: true, status: 'closed-by-user' };
      }
      return { ok: true, status: 'alive', lease: { taskId: this.taskId, tabId, url } };
    } catch (err) {
      logWarn('research', `checkTab 读取标签页状态失败（tabId=${tabId}）`, err);
      return { ok: false, errorCode: 'workspace-internal', reason: '读取标签页状态失败' };
    }
  }

  async release(tabId: string): Promise<ReleaseResult> {
    if (this.invalidTask) {
      return { ok: false, errorCode: 'invalid-task-id', reason: '任务 ID 无效' };
    }
    if (typeof tabId !== 'string' || !this.owned.has(tabId)) {
      return { ok: false, errorCode: 'not-owned', reason: '标签页不属于本任务' };
    }
    try {
      const tabs = await this.browser.getTabs();
      if (!tabs.some((t) => t.id === tabId)) {
        // 已被用户关闭：安全成功、零关闭动作（不关替代 Tab）
        this.owned.delete(tabId);
        this.ownedUrls.delete(tabId);
        return { ok: true, closed: false };
      }
      const ok = await this.browser.closeTab(tabId);
      if (!ok) {
        // 不误报已清理：所有权保留（可重试）
        return { ok: false, errorCode: 'cleanup-failed', reason: '关闭任务标签页失败' };
      }
      this.owned.delete(tabId);
      this.ownedUrls.delete(tabId);
      return { ok: true, closed: true };
    } catch (err) {
      logWarn('research', `release 异常（tabId=${tabId}）`, err);
      return { ok: false, errorCode: 'cleanup-failed', reason: '关闭任务标签页异常' };
    }
  }

  async cleanupAll(): Promise<CleanupAllResult> {
    if (this.invalidTask) {
      return { ok: false, errorCode: 'invalid-task-id', reason: '任务 ID 无效', closedCount: 0 };
    }
    this.closing = true; // cleanup 开始后拒绝新的 acquire（workspace-busy）
    // drain 屏障（决议 #118(8)）：等待全部 in-flight acquire 终态——它们要么
    // 已登记进 owned、要么已自行精确清理、要么失败零创建。等待后 owned 即
    // 完整快照，cleanupAll 返回后零 task Tab 泄漏。
    if (this.inFlightCount > 0) {
      await new Promise<void>((resolve) => {
        this.drainWaiters.push(resolve);
      });
    }
    let closedCount = 0;
    let skippedCount = 0;
    const failures: string[] = [];
    try {
      const tabsNow = await this.browser.getTabs();
      for (const tabId of [...this.owned]) {
        if (!tabsNow.some((t) => t.id === tabId)) {
          // 已被用户关闭：零关闭动作
          this.owned.delete(tabId);
          this.ownedUrls.delete(tabId);
          skippedCount += 1;
          continue;
        }
        try {
          const ok = await this.browser.closeTab(tabId);
          if (!ok) {
            failures.push(tabId); // 所有权保留（可重试），不误报已清理
            continue;
          }
          this.owned.delete(tabId);
          this.ownedUrls.delete(tabId);
          closedCount += 1;
        } catch (err) {
          logWarn('research', `cleanupAll 关闭标签页异常（tabId=${tabId}）`, err);
          failures.push(tabId);
        }
      }
    } catch (err) {
      logWarn('research', `cleanupAll 读取标签页状态失败（taskId=${this.taskId}）`, err);
      return {
        ok: false,
        errorCode: 'workspace-internal',
        reason: '读取标签页状态失败',
        closedCount: 0,
      };
    }
    if (failures.length > 0) {
      return {
        ok: false,
        errorCode: 'cleanup-failed',
        reason: `部分任务标签页清理失败（${failures.length} 个）`,
        closedCount,
      };
    }
    return { ok: true, closedCount, skippedCount };
  }

  // 焦点恢复（决议 #118(6)）：用户未切换且 activeBefore 存在 → 恢复；
  // 用户已切换 → 零 activate；activeBefore 已关闭 → 不重建不激活 + warning。
  private async restoreFocus(
    newTabId: string,
    activeBefore: string | null,
    tabsNow: TabInfo[],
  ): Promise<FocusOutcome> {
    try {
      const activeNow = (await this.browser.getActiveTab())?.id ?? null;
      if (activeNow !== newTabId) {
        return { errorCode: null, reason: '', warning: null }; // 用户已切换 → 不抢回焦点
      }
      if (activeBefore === null) {
        return { errorCode: null, reason: '', warning: null }; // 创建前无活动 Tab
      }
      if (!tabsNow.some((t) => t.id === activeBefore)) {
        // activeBefore 已关闭：不重建、不激活猜测对象（成功 + 如实登记）
        return { errorCode: null, reason: '', warning: '原活动标签页已关闭，未恢复焦点' };
      }
      const ok = await this.browser.activateTab(activeBefore);
      if (!ok) {
        // activeBefore 仍在但激活失败 = 未预期异常（不把新 Tab 无声留在前台）
        return {
          errorCode: 'tab-restore-focus-failed',
          reason: '恢复原活动标签页失败',
          warning: null,
        };
      }
      return { errorCode: null, reason: '', warning: null };
    } catch (err) {
      logWarn('research', `焦点恢复异常（tabId=${newTabId}）`, err);
      return {
        errorCode: 'tab-restore-focus-failed',
        reason: '恢复原活动标签页失败（异常）',
        warning: null,
      };
    }
  }

  // 最佳努力精确清理：吞异常零未处理 rejection；只关闭本次创建的精确 id
  private async closeBestEffort(tabId: string): Promise<void> {
    try {
      await this.browser.closeTab(tabId);
    } catch (err) {
      logWarn('research', `清理任务标签页异常（tabId=${tabId}）`, err);
    }
  }
}
