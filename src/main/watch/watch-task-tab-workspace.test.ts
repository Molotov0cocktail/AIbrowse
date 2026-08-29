// D6 watch-task-tab-workspace: Session run 精确 task-tab 所有权（FIXED 8）。
// 红→绿 oracle：敌手 create 返回既有 id 零登记零关闭、provisional ownership、
// create 期间 abort/stop/shutdown 落定后先证明所有权再清理、焦点三态、
// 用户关闭、close false/throw 保留 ownership + markUnavailable、cleanupAll
// 并发共享 drain、用户 Tab 恒等。
import { describe, expect, it } from 'vitest';
import { WatchTaskTabWorkspace, type WatchTaskTabBrowser } from './watch-task-tab-workspace';
import type { TabInfo } from '../../shared/types/browser';

function tab(id: string, overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    title: '',
    url: 'https://example.com/doc',
    active: false,
    state: 'ready',
    ...overrides,
  };
}

class FakeBrowser implements WatchTaskTabBrowser {
  tabs: TabInfo[] = [tab('user-1', { active: true }), tab('user-2')];
  createCalls = 0;
  closeCalls: string[] = [];
  activateCalls: string[] = [];
  failures = {
    createThrow: false,
    createReturnExisting: false,
    createReturnEmpty: false,
    closeFalse: false,
    closeThrow: false,
    activateFalse: false,
    activateThrow: false,
  };
  createDelay: (() => Promise<void>) | null = null;

  async createTab(url: string): Promise<TabInfo> {
    this.createCalls += 1;
    if (this.createDelay !== null) await this.createDelay();
    if (this.failures.createThrow) throw new Error('create failed');
    if (this.failures.createReturnEmpty) return { ...tab(''), url };
    if (this.failures.createReturnExisting) return { ...tab('user-1'), url };
    const id = `task-${this.createCalls}`;
    // createTab 会激活新 Tab（BrowserController 语义）：旧 active 全部解除
    this.tabs = [
      ...this.tabs.map((t) => ({ ...t, active: false })),
      tab(id, { url, active: true }),
    ];
    return { ...tab(id, { url, active: true }) };
  }
  async closeTab(tabId: string): Promise<boolean> {
    this.closeCalls.push(tabId);
    if (this.failures.closeFalse) return false;
    if (this.failures.closeThrow) throw new Error('close failed');
    this.tabs = this.tabs.filter((t) => t.id !== tabId);
    return true;
  }
  async activateTab(tabId: string): Promise<boolean> {
    this.activateCalls.push(tabId);
    if (this.failures.activateFalse) return false;
    if (this.failures.activateThrow) throw new Error('activate failed');
    return true;
  }
  async getTabs(): Promise<TabInfo[]> {
    return this.tabs.map((t) => ({ ...t }));
  }
  async getActiveTab(): Promise<TabInfo | null> {
    return this.tabs.find((t) => t.active) ?? null;
  }
}

function makeWorkspace(browser: FakeBrowser, onCleanupFailure: () => void = () => {}) {
  return new WatchTaskTabWorkspace({ browser, onCleanupFailure });
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('WatchTaskTabWorkspace — 所有权证明', () => {
  it('正常 acquire：新 id provisional 登记 → owned；报告 lease', async () => {
    const browser = new FakeBrowser();
    const ws = makeWorkspace(browser);
    const r = await ws.acquire('https://example.com/doc', new AbortController().signal);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ws.isOwned(r.lease.tabId)).toBe(true);
    expect(ws.getOwnedCount()).toBe(1);
  });

  it('非法 URL → invalid-url 零 create', async () => {
    const browser = new FakeBrowser();
    const ws = makeWorkspace(browser);
    const r = await ws.acquire('javascript:alert(1)', new AbortController().signal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('invalid-url');
    expect(browser.createCalls).toBe(0);
  });

  it('closing/drain 期间拒绝新 acquire（workspace-busy），不影响在途 create 落定', async () => {
    const browser = new FakeBrowser();
    const ws = makeWorkspace(browser);
    let releaseCreate: (() => void) | null = null;
    browser.createDelay = () =>
      new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
    const p1 = ws.acquire('https://example.com/a', new AbortController().signal);
    await flush();
    const p2 = ws.cleanupAll();
    await flush();
    const r2 = await ws.acquire('https://example.com/b', new AbortController().signal);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errorCode).toBe('workspace-busy');
    releaseCreate!();
    await p1;
    await p2;
  });

  it('敌手 create 返回既有用户 id：零登记、零关闭（用户 Tab 永不关闭）', async () => {
    const browser = new FakeBrowser();
    browser.failures.createReturnExisting = true;
    const ws = makeWorkspace(browser);
    const r = await ws.acquire('https://example.com/doc', new AbortController().signal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('tab-create-failed');
    expect(ws.getOwnedCount()).toBe(0);
    expect(browser.closeCalls).toEqual([]);
    expect(browser.tabs.some((t) => t.id === 'user-1')).toBe(true);
  });

  it('敌手 create 返回空 id：零登记、零关闭', async () => {
    const browser = new FakeBrowser();
    browser.failures.createReturnEmpty = true;
    const ws = makeWorkspace(browser);
    const r = await ws.acquire('https://example.com/doc', new AbortController().signal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('tab-create-failed');
    expect(ws.getOwnedCount()).toBe(0);
    expect(browser.closeCalls).toEqual([]);
  });

  it('create 期间 abort：落定后先证明所有权再精确清理；清理确认才移除所有权', async () => {
    const browser = new FakeBrowser();
    const ws = makeWorkspace(browser);
    let releaseCreate: (() => void) | null = null;
    browser.createDelay = () =>
      new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
    const controller = new AbortController();
    const p = ws.acquire('https://example.com/a', controller.signal);
    await flush();
    controller.abort();
    // abort 时 create 尚未落定：provisional 所有权必须在新 id 出现后登记
    const tabCountBefore = ws.getOwnedCount();
    releaseCreate!();
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('tab-create-aborted');
    expect(browser.closeCalls.length).toBe(1); // 精确关闭刚创建的 tab
    expect(ws.getOwnedCount()).toBe(0);
    void tabCountBefore;
  });

  it('创建后已被用户关闭 → tab-closed-by-user 且所有权移除', async () => {
    const browser = new FakeBrowser();
    const ws = makeWorkspace(browser);
    const originalCreate = browser.createTab.bind(browser);
    browser.createTab = async (url) => {
      const t = await originalCreate(url);
      browser.tabs = browser.tabs.filter((x) => x.id !== t.id); // 模拟创建即被关
      return t;
    };
    const r = await ws.acquire('https://example.com/a', new AbortController().signal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('tab-closed-by-user');
    expect(ws.getOwnedCount()).toBe(0);
  });
});

describe('WatchTaskTabWorkspace — 焦点恢复三态', () => {
  it('未切换：恢复 activeBefore；用户已切换：零 activate；原 active 关闭：不重建', async () => {
    const browser = new FakeBrowser();
    const ws = makeWorkspace(browser);
    await ws.acquire('https://example.com/a', new AbortController().signal);
    expect(browser.activateCalls).toEqual(['user-1']); // 未切换 → 恢复原活动 Tab

    const browser2 = new FakeBrowser();
    const ws2 = makeWorkspace(browser2);
    const originalCreate2 = browser2.createTab.bind(browser2);
    browser2.createTab = async (url) => {
      const t = await originalCreate2(url);
      // create 自动激活新 Tab 后用户立即切到另一个用户 Tab（create 窗口内切换）
      browser2.tabs = browser2.tabs.map((x) =>
        x.id === t.id ? { ...x, active: false } : x.id === 'user-2' ? { ...x, active: true } : x,
      );
      return t;
    };
    const r2 = await ws2.acquire('https://example.com/a', new AbortController().signal);
    expect(r2.ok).toBe(true);
    expect(browser2.activateCalls).toEqual([]); // 已切换 → 零抢焦点

    const browser3 = new FakeBrowser();
    browser3.tabs = [tab('user-2'), tab('dead-1', { active: true })];
    const ws3 = makeWorkspace(browser3);
    // activeBefore(dead-1) 在 create 后已关闭：不重建、不猜焦点，仅 warning
    const originalCreate3 = browser3.createTab.bind(browser3);
    browser3.createTab = async (url) => {
      const t = await originalCreate3(url);
      browser3.tabs = browser3.tabs.filter((x) => x.id !== 'dead-1');
      return t;
    };
    const r3 = await ws3.acquire('https://example.com/a', new AbortController().signal);
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.warnings?.some((w) => w.includes('已关闭'))).toBe(true);
    expect(browser3.activateCalls).toEqual([]); // 不重建、不猜焦点
  });

  it('activateTab 失败/抛错 → 精确关闭新 Tab + tab-restore-focus-failed', async () => {
    for (const kind of ['activateFalse', 'activateThrow'] as const) {
      const browser = new FakeBrowser();
      browser.failures[kind] = true;
      const ws = makeWorkspace(browser);
      const r = await ws.acquire('https://example.com/a', new AbortController().signal);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errorCode).toBe('tab-restore-focus-failed');
      expect(browser.closeCalls.length).toBe(1);
      expect(ws.getOwnedCount()).toBe(0);
    }
  });

  // R3 修复：getTabs 显示 task active 后，fresh getActiveTab 阶段用户已切到另一
  // 用户 Tab → 零 activate（不得基于陈旧 getTabs 快照恢复焦点）
  it('getTabs 显示 task active，但 fresh getActiveTab 显示用户已切换 → 零 activate', async () => {
    const browser = new FakeBrowser();
    let activeCalls = 0;
    const originalGetActive = browser.getActiveTab.bind(browser);
    browser.getActiveTab = async () => {
      activeCalls += 1;
      if (activeCalls === 1) return originalGetActive(); // create 前：user-1 active
      return { ...tab('user-2', { active: true }) }; // fresh 决策时刻：用户已切到 user-2
    };
    const ws = makeWorkspace(browser);
    const r = await ws.acquire('https://example.com/a', new AbortController().signal);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(browser.activateCalls).toEqual([]); // 零抢焦点
    expect(ws.isOwned(r.lease.tabId)).toBe(true); // task Tab 保持 owned（等待 release）
    await ws.release(r.lease.tabId);
  });

  // R3 修复：fresh getActiveTab 抛错 → fail-closed，attempt 失败且只关闭精确
  // owned task Tab（用户 Tab 零关闭）
  it('fresh getActiveTab 抛错 → attempt 失败且只关闭精确 owned task Tab', async () => {
    const browser = new FakeBrowser();
    let activeCalls = 0;
    browser.getActiveTab = async () => {
      activeCalls += 1;
      if (activeCalls === 1) return { ...tab('user-1', { active: true }) };
      throw new Error('fresh getActiveTab 失败');
    };
    const ws = makeWorkspace(browser);
    const r = await ws.acquire('https://example.com/a', new AbortController().signal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('tab-restore-focus-failed');
    expect(browser.closeCalls.length).toBe(1);
    expect(browser.closeCalls[0]).toMatch(/^task-/); // 只关闭精确 owned task Tab
    expect(ws.getOwnedCount()).toBe(0);
    expect(browser.tabs.some((t) => t.id === 'user-1')).toBe(true); // 用户 Tab 零关闭
    expect(browser.tabs.some((t) => t.id === 'user-2')).toBe(true);
  });
});

describe('WatchTaskTabWorkspace — release 与 close false/throw', () => {
  it('release 成功关闭并移除所有权；用户已关闭 → userClosed=true 零动作', async () => {
    const browser = new FakeBrowser();
    const ws = makeWorkspace(browser);
    const a = await ws.acquire('https://example.com/a', new AbortController().signal);
    if (!a.ok) return;
    const r = await ws.release(a.lease.tabId);
    expect(r.ok).toBe(true);
    expect(ws.getOwnedCount()).toBe(0);

    const b = await ws.acquire('https://example.com/b', new AbortController().signal);
    if (!b.ok) return;
    browser.tabs = browser.tabs.filter((t) => t.id !== b.lease.tabId); // 用户关闭
    const r2 = await ws.release(b.lease.tabId);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.userClosed).toBe(true);
    expect(ws.getOwnedCount()).toBe(0);
  });

  it('closeTab=false：ownership 保留、onCleanupFailure 调用、attempt cleanup-failed', async () => {
    let unavailable = 0;
    const browser = new FakeBrowser();
    browser.failures.closeFalse = true;
    const ws = makeWorkspace(browser, () => {
      unavailable += 1;
    });
    const a = await ws.acquire('https://example.com/a', new AbortController().signal);
    if (!a.ok) return;
    const r = await ws.release(a.lease.tabId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('cleanup-failed');
    expect(ws.isOwned(a.lease.tabId)).toBe(true); // 所有权保留
    expect(unavailable).toBe(1); // Watch 已标记不可用
  });

  it('closeTab 抛错：同 closeTab=false（保留 ownership + markUnavailable）', async () => {
    let unavailable = 0;
    const browser = new FakeBrowser();
    browser.failures.closeThrow = true;
    const ws = makeWorkspace(browser, () => {
      unavailable += 1;
    });
    const a = await ws.acquire('https://example.com/a', new AbortController().signal);
    if (!a.ok) return;
    const r = await ws.release(a.lease.tabId);
    expect(r.ok).toBe(false);
    expect(ws.isOwned(a.lease.tabId)).toBe(true);
    expect(unavailable).toBe(1);
  });
});

describe('WatchTaskTabWorkspace — cleanupAll 与 drain', () => {
  it('cleanupAll 关闭全部 owned；失败保留并可重试', async () => {
    const browser = new FakeBrowser();
    const ws = makeWorkspace(browser);
    const a = await ws.acquire('https://example.com/a', new AbortController().signal);
    const b = await ws.acquire('https://example.com/b', new AbortController().signal);
    if (!a.ok || !b.ok) return;
    browser.failures.closeFalse = true;
    const r = await ws.cleanupAll();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retainedCount).toBeGreaterThan(0);
    // 修复后重试：全部关闭
    browser.failures.closeFalse = false;
    const r2 = await ws.cleanupAll();
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.closedCount).toBe(2);
    expect(ws.getOwnedCount()).toBe(0);
  });

  it('cleanupAll 并发调用共享同一 drain Promise', async () => {
    const browser = new FakeBrowser();
    const ws = makeWorkspace(browser);
    let releaseCreate: (() => void) | null = null;
    browser.createDelay = () =>
      new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
    const pAcquire = ws.acquire('https://example.com/a', new AbortController().signal);
    await flush();
    const p1 = ws.cleanupAll();
    const p2 = ws.cleanupAll(); // 并发：共享 drain
    releaseCreate!();
    await pAcquire;
    const r1 = await p1;
    const r2 = await p2;
    expect(r1).toEqual(r2); // 共享同一结果
  });

  it('用户 Tab 集合恒等：attempt 前后 user-1/user-2 原样保留', async () => {
    const browser = new FakeBrowser();
    const before = JSON.stringify(
      browser.tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })),
    );
    const ws = makeWorkspace(browser);
    const a = await ws.acquire('https://example.com/a', new AbortController().signal);
    if (!a.ok) return;
    await ws.release(a.lease.tabId);
    const after = JSON.stringify(
      browser.tabs
        .filter((t) => t.id !== a.lease.tabId)
        .map((t) => ({ id: t.id, url: t.url, title: t.title })),
    );
    expect(after).toBe(before);
  });
});
