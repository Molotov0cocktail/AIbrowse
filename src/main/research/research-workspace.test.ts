// C2 research-workspace tests (detailed-design §10/§10.1, adjudication #118):
// precise tabId ownership via a fully offline Fake BrowserController with
// controllable promises — legal URL create + exact-id registration + lease
// taskId binding; illegal URL zero-create matrix; adversarial createTab
// returning an existing user tab; user tab vs task tab with identical
// url/title; cross-task lease / raw tabId not-owned; concurrency ceiling
// (4th acquire rejected before createTab); deferred create + cleanupAll race
// (zero task-tab leak); abort before / during create; focus restoration
// three-state (restore / user-switched / activeBefore closed); user-closed
// task tab → checkTab closed-by-user; release idempotence (success / repeat /
// already-closed); closeTab false / throw; cleanupAll multi-tab / partial
// failure / repeated; acquire rejected after cleanup; user tab set invariant;
// unexpected errors safe-return (zero unhandled rejection); deterministic
// outcomes + zero Electron import; MAX_RESEARCH_TABS single source of truth.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { TabInfo } from '../../shared/types/browser';
import { MAX_RESEARCH_TABS } from '../../shared/types/research';
import { ResearchWorkspace, type ResearchWorkspaceBrowser } from './research-workspace';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let taskSeq = 0;

// Fake BrowserController（完全离线、可控 Promise）：createTab 记录调用并返回
// pending promise，测试显式 completeCreate 控制「创建完成」时刻（默认行为
// 对齐真实契约：新 Tab 入表 + 自动激活）。全部行为注入点覆盖敌手与异常路径。
class FakeBrowser implements ResearchWorkspaceBrowser {
  readonly tabs = new Map<string, TabInfo>();
  activeId: string | null = null;
  readonly createLog: string[] = [];
  readonly closeLog: string[] = [];
  readonly activateLog: string[] = [];
  private readonly pending: Array<{ url: string; d: Deferred<TabInfo> }> = [];
  // 行为注入点
  manualCreate = false; // true = createTab 挂起等待 completeCreate（时序用例）
  createOverride: ((url: string) => TabInfo) | null = null;
  closeResult: ((tabId: string) => boolean) | null = null;
  closeThrow: Error | null = null;
  activateResult: ((tabId: string) => boolean) | null = null;
  getTabsError: Error | null = null;
  getActiveError: Error | null = null;

  constructor(userTabs: Array<Pick<TabInfo, 'id'> & Partial<TabInfo>> = []) {
    for (const t of userTabs) {
      this.tabs.set(t.id, {
        id: t.id,
        title: t.title ?? '',
        url: t.url ?? 'https://user.example/',
        state: t.state ?? 'ready',
        active: false,
      });
    }
    this.activeId = userTabs[0]?.id ?? null;
  }

  private makeTab(url: string): TabInfo {
    const tab: TabInfo = {
      id: `task-tab-${++taskSeq}`,
      title: '',
      url,
      state: 'idle',
      active: true,
    };
    this.tabs.set(tab.id, tab);
    this.activeId = tab.id; // createTab 自动激活新 Tab（真实契约）
    return tab;
  }

  createTab(url: string): Promise<TabInfo> {
    this.createLog.push(url);
    if (this.createOverride !== null) {
      return Promise.resolve(this.createOverride(url));
    }
    if (!this.manualCreate) {
      return Promise.resolve(this.makeTab(url)); // 默认：立即创建 + 激活
    }
    const d = deferred<TabInfo>();
    this.pending.push({ url, d });
    return d.promise;
  }

  completeCreate(index = 0): TabInfo {
    const entry = this.pending[index];
    if (entry === undefined) throw new Error('没有待完成的 createTab 调用');
    const tab = this.makeTab(entry.url);
    entry.d.resolve(tab);
    return tab;
  }

  // 敌手夹具（决议 #119 矩阵）：以指定 TabInfo 完成 pending createTab——
  // 不触碰 tabs 表/activeId（模拟敌手实现返回既有 Tab 或任意对象）
  completeCreateWithTab(tab: TabInfo, index = 0): void {
    const entry = this.pending[index];
    if (entry === undefined) throw new Error('没有待完成的 createTab 调用');
    entry.d.resolve(tab);
  }

  pendingCreateCount(): number {
    return this.pending.length;
  }

  // 确定性微任务轮询：等待 in-flight acquire 到达 createTab（manualCreate 挂起）
  async waitForPending(count: number): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      if (this.pending.length >= count) return;
      await Promise.resolve();
    }
    throw new Error(`pending create 未达到预期（${this.pending.length} < ${count}）`);
  }

  async closeTab(tabId: string): Promise<boolean> {
    if (this.closeThrow !== null) throw this.closeThrow;
    this.closeLog.push(tabId);
    const ok = this.closeResult === null ? true : this.closeResult(tabId);
    if (ok) {
      this.tabs.delete(tabId);
      if (this.activeId === tabId) this.activeId = null;
    }
    return ok;
  }

  async activateTab(tabId: string): Promise<boolean> {
    this.activateLog.push(tabId);
    const ok = this.activateResult === null ? this.tabs.has(tabId) : this.activateResult(tabId);
    if (ok) this.activeId = tabId;
    return ok;
  }

  async getTabs(): Promise<TabInfo[]> {
    if (this.getTabsError !== null) throw this.getTabsError;
    return [...this.tabs.values()].map((t) => ({ ...t }));
  }

  async getActiveTab(): Promise<TabInfo | null> {
    if (this.getActiveError !== null) throw this.getActiveError;
    if (this.activeId === null) return null;
    const t = this.tabs.get(this.activeId);
    return t === undefined ? null : { ...t, active: true };
  }
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

function userTabIds(fake: FakeBrowser): string[] {
  return [...fake.tabs.keys()].filter((id) => !id.startsWith('task-tab-')).sort();
}

function taskTabIds(fake: FakeBrowser): string[] {
  return [...fake.tabs.keys()].filter((id) => id.startsWith('task-tab-')).sort();
}

const USER_TABS = [{ id: 'U1', url: 'https://user.example/page', title: '用户页面' }];

// 清理：每用例后复位静态计数器（保持用例间确定性）
afterEach(() => {
  taskSeq = 0;
});

describe('1. 合法 URL 创建：精确 id 登记 + Lease taskId 绑定', () => {
  it('创建成功 → lease 绑定 taskId/精确 tabId/规范化 URL，所有权集合仅含该 id', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('task-1', fake);
    const result = await ws.acquire('https://example.com/article/1', freshSignal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lease.taskId).toBe('task-1');
    expect(result.lease.tabId).toMatch(/^task-tab-\d+$/);
    expect(result.lease.url).toBe('https://example.com/article/1');
    expect(ws.isOwned(result.lease.tabId)).toBe(true);
    expect(ws.getOwnedTabIds()).toEqual([result.lease.tabId]);
    // 用户 Tab 原样
    expect(userTabIds(fake)).toEqual(['U1']);
    // 新 Tab 确实被创建（fake 表内存在）
    expect(fake.tabs.has(result.lease.tabId)).toBe(true);
  });

  it('同一实例多次创建 → 所有权集合精确累加，不推断其他 Tab', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('task-1', fake);
    const r1 = await ws.acquire('https://a.example/', freshSignal());
    const r2 = await ws.acquire('https://b.example/', freshSignal());
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect([...ws.getOwnedTabIds()].sort()).toEqual([r1.lease.tabId, r2.lease.tabId].sort());
    expect(userTabIds(fake)).toEqual(['U1']);
  });
});

describe('2. URL 边界：非法 URL 零 create', () => {
  const BAD_URLS: string[] = [
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'file:///C:/windows/system32/x',
    'about:blank',
    'https://user:pass@example.com/x',
    'https://example.com/\u0007control',
    `https://example.com/${'x'.repeat(2100)}`,
    '',
    '不是 URL',
    'ftp://example.com/file',
    'chrome://settings',
  ];

  for (const bad of BAD_URLS) {
    it(`拒绝（${bad.length > 40 ? `${bad.slice(0, 40)}…` : bad}）→ invalid-url 且零 createTab`, async () => {
      const fake = new FakeBrowser(USER_TABS);
      const ws = new ResearchWorkspace('task-1', fake);
      const result = await ws.acquire(bad, freshSignal());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errorCode).toBe('invalid-url');
      expect(fake.createLog).toEqual([]);
      expect(ws.getOwnedTabIds()).toEqual([]);
      expect(userTabIds(fake)).toEqual(['U1']);
    });
  }
});

describe('3. 敌手 createTab 返回已存在用户 Tab', () => {
  it('返回既有用户 Tab → tab-create-failed、零关闭、零所有权', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('task-1', fake);
    const u1 = fake.tabs.get('U1')!;
    fake.createOverride = () => u1;
    const result = await ws.acquire('https://example.com/x', freshSignal());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('tab-create-failed');
    expect(fake.closeLog).toEqual([]);
    expect(ws.getOwnedTabIds()).toEqual([]);
    expect(userTabIds(fake)).toEqual(['U1']); // 用户 Tab 原样保留
  });
});

describe('4. 用户 Tab 与 task Tab 同 URL/同标题', () => {
  it('只关闭精确 owned id，同形用户 Tab 零触碰', async () => {
    const fake = new FakeBrowser([{ id: 'U1', url: 'https://same.example/x', title: '相同标题' }]);
    const ws = new ResearchWorkspace('task-1', fake);
    const result = await ws.acquire('https://same.example/x', freshSignal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const taskTab = fake.tabs.get(result.lease.tabId)!;
    taskTab.title = '相同标题'; // 同 URL 同标题
    const release = await ws.release(result.lease.tabId);
    expect(release.ok).toBe(true);
    expect(fake.closeLog).toEqual([result.lease.tabId]);
    expect(userTabIds(fake)).toEqual(['U1']);
    expect(taskTabIds(fake)).toEqual([]);
  });
});

describe('5. 跨任务 Lease / 伪造 tabId → not-owned 零关闭', () => {
  it('另一 Workspace 实例的 owned tabId → not-owned；未知 raw tabId → not-owned', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const wsA = new ResearchWorkspace('task-a', fake);
    const wsB = new ResearchWorkspace('task-b', fake);
    const lease = await wsA.acquire('https://example.com/x', freshSignal());
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    // 跨任务引用（task-b 持有 task-a 的 lease）
    const cross = await wsB.release(lease.lease.tabId);
    expect(cross).toEqual({ ok: false, errorCode: 'not-owned', reason: expect.any(String) });
    expect(fake.closeLog).toEqual([]); // 零关闭动作
    // 伪造 raw tabId
    const forged = await wsA.release('bogus-tab-id');
    expect(forged.ok).toBe(false);
    if (forged.ok) return;
    expect(forged.errorCode).toBe('not-owned');
    // checkTab 同样拒绝
    const checkCross = await wsB.checkTab(lease.lease.tabId);
    expect(checkCross.ok).toBe(false);
    if (checkCross.ok) return;
    expect(checkCross.errorCode).toBe('not-owned');
    // 双方集合不变
    expect(wsA.getOwnedTabIds()).toEqual([lease.lease.tabId]);
    expect(wsB.getOwnedTabIds()).toEqual([]);
    expect(fake.tabs.has(lease.lease.tabId)).toBe(true);
  });
});

describe('6. 并发上限：3 个成功、第 4 个在 create 前确定性拒绝', () => {
  it(`并发 ${MAX_RESEARCH_TABS} 个 acquire 各自预留槽位，第 ${MAX_RESEARCH_TABS + 1} 个零 createTab`, async () => {
    const fake = new FakeBrowser(USER_TABS);
    fake.manualCreate = true;
    const ws = new ResearchWorkspace('task-1', fake);
    const p1 = ws.acquire('https://a.example/', freshSignal());
    const p2 = ws.acquire('https://b.example/', freshSignal());
    const p3 = ws.acquire('https://c.example/', freshSignal());
    await fake.waitForPending(MAX_RESEARCH_TABS); // 三个都到达 createTab（挂起）
    expect(fake.createLog.length).toBe(MAX_RESEARCH_TABS);
    // 第 4 次必须在调用 createTab 前拒绝（createLog 恒为 3）
    const p4 = ws.acquire('https://d.example/', freshSignal());
    const r4 = await p4;
    expect(r4.ok).toBe(false);
    if (r4.ok) return;
    expect(r4.errorCode).toBe('tab-limit');
    expect(fake.createLog.length).toBe(MAX_RESEARCH_TABS);
    expect(fake.pendingCreateCount()).toBe(MAX_RESEARCH_TABS);
    // 依次完成三个创建 → 全部成功
    for (let i = 0; i < MAX_RESEARCH_TABS; i += 1) fake.completeCreate(i);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect([r1.ok, r2.ok, r3.ok]).toEqual([true, true, true]);
    expect(ws.getOwnedTabIds().length).toBe(MAX_RESEARCH_TABS);
  });
});

describe('7. deferred create + cleanupAll 竞态：零 task Tab 泄漏', () => {
  it('cleanupAll 等待 in-flight create 落定后精确关闭全部新 Tab', async () => {
    const fake = new FakeBrowser(USER_TABS);
    fake.manualCreate = true;
    const ws = new ResearchWorkspace('task-1', fake);
    const p1 = ws.acquire('https://a.example/', freshSignal());
    const p2 = ws.acquire('https://b.example/', freshSignal());
    await fake.waitForPending(2); // 两个 acquire 到达 createTab（pending）
    // cleanupAll 与两个 in-flight create 并发
    const cleanup = ws.cleanupAll();
    const tab1 = fake.completeCreate(0);
    const tab2 = fake.completeCreate(1);
    const [r1, r2, c] = await Promise.all([p1, p2, cleanup]);
    expect([r1.ok, r2.ok]).toEqual([true, true]);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.closedCount).toBe(2);
    // 零泄漏后置条件：task Tab 全部消失、用户 Tab 恒在
    expect(taskTabIds(fake)).toEqual([]);
    expect(userTabIds(fake)).toEqual(['U1']);
    expect(fake.closeLog.sort()).toEqual([tab1.id, tab2.id].sort());
    expect(ws.getOwnedTabIds()).toEqual([]);
  });
});

describe('8. AbortSignal：create 前与 create 期间', () => {
  it('create 前已终止 → 零 createTab、tab-create-aborted', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('task-1', fake);
    const controller = new AbortController();
    controller.abort();
    const result = await ws.acquire('https://example.com/x', controller.signal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('tab-create-aborted');
    expect(fake.createLog).toEqual([]);
    expect(fake.closeLog).toEqual([]);
    expect(userTabIds(fake)).toEqual(['U1']);
  });

  it('create 期间终止 → 创建完成后精确清理新 Tab 再返回 aborted', async () => {
    const fake = new FakeBrowser(USER_TABS);
    fake.manualCreate = true;
    const ws = new ResearchWorkspace('task-1', fake);
    const controller = new AbortController();
    const p = ws.acquire('https://example.com/x', controller.signal);
    await fake.waitForPending(1); // 到达 createTab（pending）
    controller.abort(); // create 期间终止
    const tab = fake.completeCreate(0);
    const result = await p;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('tab-create-aborted');
    expect(fake.closeLog).toEqual([tab.id]); // 精确关闭本次创建的 id
    expect(taskTabIds(fake)).toEqual([]); // 零泄漏
    expect(userTabIds(fake)).toEqual(['U1']);
    expect(ws.getOwnedTabIds()).toEqual([]);
  });
});

describe('9. 焦点恢复：create 自动激活后恢复 activeBefore', () => {
  it('创建完成后活动 Tab 仍是新 Tab → activateTab(activeBefore) 恰一次', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('task-1', fake);
    const result = await ws.acquire('https://example.com/x', freshSignal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fake.activateLog).toEqual(['U1']);
    expect(fake.activeId).toBe('U1');
    expect(result.warnings).toBeUndefined();
  });
});

describe('10. 焦点恢复：用户已切换其他 Tab → 零 activate', () => {
  it('创建期间用户切到 U2 → 不抢回焦点', async () => {
    const fake = new FakeBrowser([{ id: 'U1' }, { id: 'U2', url: 'https://u2.example/' }]);
    fake.manualCreate = true;
    const ws = new ResearchWorkspace('task-1', fake);
    const p = ws.acquire('https://example.com/x', freshSignal());
    await fake.waitForPending(1); // 到达 createTab（pending）
    fake.completeCreate(0);
    fake.activeId = 'U2'; // 用户在创建完成后立即切换
    const result = await p;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fake.activateLog).toEqual([]); // 零 activate
    expect(fake.activeId).toBe('U2'); // 不抢回
  });
});

describe('11. 焦点恢复：activeBefore 已关闭 → 不重建不激活 + warning', () => {
  it('activeBefore 从快照消失 → 零 activate、lease 成功、中文 warning', async () => {
    const fake = new FakeBrowser(USER_TABS);
    fake.manualCreate = true;
    const ws = new ResearchWorkspace('task-1', fake);
    const p = ws.acquire('https://example.com/x', freshSignal());
    await fake.waitForPending(1); // 到达 createTab（pending）
    fake.completeCreate(0);
    fake.tabs.delete('U1'); // 用户关闭原活动 Tab
    const result = await p;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fake.activateLog).toEqual([]);
    expect(result.warnings?.length).toBe(1);
    expect(result.warnings?.[0]).toContain('原活动');
    // task Tab 保留（所有权不变），不重建任何 Tab
    expect(fake.tabs.has(result.lease.tabId)).toBe(true);
    expect(ws.getOwnedTabIds()).toEqual([result.lease.tabId]);
  });
});

describe('12. 用户手动关闭 task Tab → checkTab tab-closed-by-user', () => {
  it('owned tab 从快照消失 → 移除所有权集合 + closed-by-user', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('task-1', fake);
    const lease = await ws.acquire('https://example.com/x', freshSignal());
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    const alive = await ws.checkTab(lease.lease.tabId);
    expect(alive).toEqual({
      ok: true,
      status: 'alive',
      lease: { taskId: 'task-1', tabId: lease.lease.tabId, url: 'https://example.com/x' },
    });
    fake.tabs.delete(lease.lease.tabId); // 用户关闭 task Tab
    const closed = await ws.checkTab(lease.lease.tabId);
    expect(closed).toEqual({ ok: true, status: 'closed-by-user' });
    expect(ws.isOwned(lease.lease.tabId)).toBe(false); // 已从所有权集合移除
    expect(ws.getOwnedTabIds()).toEqual([]);
    // 再次 checkTab → not-owned（已移除）
    const again = await ws.checkTab(lease.lease.tabId);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.errorCode).toBe('not-owned');
    expect(fake.closeLog).toEqual([]); // 零关闭动作
  });
});

describe('13. release：成功 / 重复 release / 已关闭 release', () => {
  it('release 成功 → closed:true 精确关闭；重复 → not-owned；已关闭 → closed:false 零动作', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('task-1', fake);
    const r1 = await ws.acquire('https://a.example/', freshSignal());
    const r2 = await ws.acquire('https://b.example/', freshSignal());
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    // 成功 release
    const rel1 = await ws.release(r1.lease.tabId);
    expect(rel1).toEqual({ ok: true, closed: true });
    expect(fake.closeLog).toEqual([r1.lease.tabId]);
    expect(fake.tabs.has(r1.lease.tabId)).toBe(false);
    // 重复 release → not-owned、零关闭动作
    const repeat = await ws.release(r1.lease.tabId);
    expect(repeat).toEqual({ ok: false, errorCode: 'not-owned', reason: expect.any(String) });
    expect(fake.closeLog).toEqual([r1.lease.tabId]);
    // 已关闭 release（用户先关）
    fake.tabs.delete(r2.lease.tabId);
    const rel2 = await ws.release(r2.lease.tabId);
    expect(rel2).toEqual({ ok: true, closed: false });
    expect(fake.closeLog).toEqual([r1.lease.tabId]); // 零 closeTab 增量
    expect(ws.getOwnedTabIds()).toEqual([]);
    expect(userTabIds(fake)).toEqual(['U1']);
  });
});

describe('14. closeTab false / 抛错：不误报已清理', () => {
  it('closeTab 返回 false → cleanup-failed、所有权保留、可重试', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('task-1', fake);
    const lease = await ws.acquire('https://example.com/x', freshSignal());
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    fake.closeResult = () => false;
    const result = await ws.release(lease.lease.tabId);
    expect(result).toEqual({ ok: false, errorCode: 'cleanup-failed', reason: expect.any(String) });
    expect(fake.tabs.has(lease.lease.tabId)).toBe(true);
    expect(ws.getOwnedTabIds()).toEqual([lease.lease.tabId]); // 保留所有权可重试
    // 恢复后重试成功
    fake.closeResult = null;
    const retry = await ws.release(lease.lease.tabId);
    expect(retry).toEqual({ ok: true, closed: true });
    expect(taskTabIds(fake)).toEqual([]);
  });

  it('closeTab 抛错 → cleanup-failed 安全返回、不抛穿', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('task-1', fake);
    const lease = await ws.acquire('https://example.com/x', freshSignal());
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    fake.closeThrow = new Error('boom');
    const result = await ws.release(lease.lease.tabId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('cleanup-failed');
    expect(ws.getOwnedTabIds()).toEqual([lease.lease.tabId]);
  });
});

describe('15. cleanupAll：多 Tab / 部分关闭失败 / 重复 cleanup', () => {
  it('部分失败 → closedCount 如实、失败 Tab 保留可重试、重复 cleanup 不重复关闭', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('task-1', fake);
    const r1 = await ws.acquire('https://a.example/', freshSignal());
    const r2 = await ws.acquire('https://b.example/', freshSignal());
    const r3 = await ws.acquire('https://c.example/', freshSignal());
    expect(r1.ok && r2.ok && r3.ok).toBe(true);
    if (!r1.ok || !r2.ok || !r3.ok) return;
    fake.closeResult = (tabId) => tabId !== r2.lease.tabId; // 仅 tab2 关闭失败
    const first = await ws.cleanupAll();
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.errorCode).toBe('cleanup-failed');
    expect(first.closedCount).toBe(2);
    expect(ws.getOwnedTabIds()).toEqual([r2.lease.tabId]); // 失败 Tab 保留
    expect(fake.tabs.has(r2.lease.tabId)).toBe(true);
    // 恢复后重复 cleanup：只关闭剩余的 tab2，不重复关闭已清理的 tab1/tab3
    fake.closeResult = null;
    const second = await ws.cleanupAll();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.closedCount).toBe(1);
    const closed = fake.closeLog.filter((id) => id === r2.lease.tabId).length;
    expect(closed).toBe(2); // 第一次失败尝试 + 第二次成功
    expect(fake.closeLog.filter((id) => id === r1.lease.tabId).length).toBe(1);
    expect(fake.closeLog.filter((id) => id === r3.lease.tabId).length).toBe(1);
    // 第三次 cleanup：幂等
    const third = await ws.cleanupAll();
    expect(third).toEqual({ ok: true, closedCount: 0, skippedCount: 0 });
    expect(taskTabIds(fake)).toEqual([]);
  });
});

describe('16. cleanup 后 acquire 拒绝', () => {
  it('cleanupAll 之后 acquire → workspace-busy、零 createTab', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('task-1', fake);
    await ws.cleanupAll();
    const result = await ws.acquire('https://example.com/x', freshSignal());
    expect(result).toEqual({ ok: false, errorCode: 'workspace-busy', reason: expect.any(String) });
    expect(fake.createLog).toEqual([]);
    // release/checkTab 在 cleanup 后仍安全（not-owned）
    expect(await ws.release('anything')).toMatchObject({ ok: false, errorCode: 'not-owned' });
    expect(await ws.checkTab('anything')).toMatchObject({ ok: false, errorCode: 'not-owned' });
  });
});

describe('17. 清理前后用户 Tab id 集合完全一致', () => {
  it('多任务 Tab 清理后用户 Tab 集合逐 id 恒等', async () => {
    const fake = new FakeBrowser([
      { id: 'U1', url: 'https://u1.example/', title: '甲' },
      { id: 'U2', url: 'https://u2.example/', title: '乙' },
    ]);
    const before = userTabIds(fake);
    const ws = new ResearchWorkspace('task-1', fake);
    for (const url of ['https://a.example/', 'https://b.example/', 'https://c.example/']) {
      const r = await ws.acquire(url, freshSignal());
      expect(r.ok).toBe(true);
    }
    expect(taskTabIds(fake).length).toBe(3);
    const cleanup = await ws.cleanupAll();
    expect(cleanup.ok).toBe(true);
    expect(userTabIds(fake)).toEqual(before);
    // 用户 Tab 的字段（URL/标题）也不被改动
    expect(fake.tabs.get('U1')?.url).toBe('https://u1.example/');
    expect(fake.tabs.get('U1')?.title).toBe('甲');
  });
});

describe('18. 未预期异常：全部安全返回、零未处理 rejection', () => {
  it('getTabs 抛错 → acquire/checkTab/cleanupAll 安全返回 workspace-internal', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('task-1', fake);
    fake.getTabsError = new Error('tabs boom');
    const acquire = await ws.acquire('https://example.com/x', freshSignal());
    expect(acquire).toMatchObject({ ok: false, errorCode: 'workspace-internal' });
    // checkTab（非 owned → not-owned 不触碰 getTabs；先造一个 owned）
    fake.getTabsError = null;
    const lease = await ws.acquire('https://example.com/x', freshSignal());
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    fake.getTabsError = new Error('tabs boom');
    const check = await ws.checkTab(lease.lease.tabId);
    expect(check).toMatchObject({ ok: false, errorCode: 'workspace-internal' });
    const cleanup = await ws.cleanupAll();
    expect(cleanup).toMatchObject({ ok: false, errorCode: 'workspace-internal', closedCount: 0 });
  });

  it('getActiveTab 抛错 → acquire 安全返回 workspace-internal、零 create', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('task-1', fake);
    fake.getActiveError = new Error('active boom');
    const result = await ws.acquire('https://example.com/x', freshSignal());
    expect(result).toMatchObject({ ok: false, errorCode: 'workspace-internal' });
    expect(fake.createLog).toEqual([]);
    expect(userTabIds(fake)).toEqual(['U1']);
  });

  it('焦点恢复阶段 activateTab 异常 → 安全返回并精确关闭新 Tab', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('task-1', fake);
    fake.activateResult = () => {
      throw new Error('activate boom');
    };
    const result = await ws.acquire('https://example.com/x', freshSignal());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('tab-restore-focus-failed');
    expect(taskTabIds(fake)).toEqual([]); // 新 Tab 已精确关闭
    expect(userTabIds(fake)).toEqual(['U1']);
    expect(ws.getOwnedTabIds()).toEqual([]);
  });

  it('activateTab 返回 false（activeBefore 仍在）→ tab-restore-focus-failed + 精确关闭新 Tab', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('task-1', fake);
    fake.activateResult = () => false;
    const result = await ws.acquire('https://example.com/x', freshSignal());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('tab-restore-focus-failed');
    expect(taskTabIds(fake)).toEqual([]);
    expect(userTabIds(fake)).toEqual(['U1']);
  });

  it('release 阶段 getTabs 抛错 → cleanup-failed 安全返回', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('task-1', fake);
    const lease = await ws.acquire('https://example.com/x', freshSignal());
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    fake.getTabsError = new Error('tabs boom');
    const result = await ws.release(lease.lease.tabId);
    expect(result).toMatchObject({ ok: false, errorCode: 'cleanup-failed' });
  });
});

describe('19. 确定性与隔离：同输入同事件结果一致、零 Electron import', () => {
  it('同一场景运行两遍 → 结果深层一致（确定性）', async () => {
    const run = async (): Promise<unknown> => {
      taskSeq = 0; // 复位 id 计数器保证两遍结果可比较
      const fake = new FakeBrowser(USER_TABS);
      const ws = new ResearchWorkspace('task-1', fake);
      const r1 = await ws.acquire('https://a.example/', freshSignal());
      const r2 = await ws.acquire('https://b.example/', freshSignal());
      const rel = r1.ok ? await ws.release(r1.lease.tabId) : null;
      const cleanup = await ws.cleanupAll();
      return {
        r1: r1.ok ? { lease: r1.lease, warnings: r1.warnings ?? null } : r1,
        r2: r2.ok ? { lease: r2.lease, warnings: r2.warnings ?? null } : r2,
        rel,
        cleanup,
        userTabs: userTabIds(fake),
        activateLog: fake.activateLog,
        closeLog: fake.closeLog,
      };
    };
    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
  });

  it('模块源码零 Electron import（静态断言）', () => {
    const source = readFileSync(new URL('./research-workspace.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/electron/);
    expect(source).not.toMatch(/node:child_process|child_process/);
  });
});

describe('20. MAX_RESEARCH_TABS 单一事实源', () => {
  it('实现只从 shared/types/research.ts 引用上限常量，无魔法数字', () => {
    const source = readFileSync(new URL('./research-workspace.ts', import.meta.url), 'utf8');
    expect(source).toContain('MAX_RESEARCH_TABS');
    expect(source).not.toMatch(/MAX_RESEARCH_TABS\s*=\s*\d/); // 无重定义
    expect(source).toContain("from '../../shared/types/research'");
  });
});

describe('非法 taskId：构造不抛异常、全部操作安全返回', () => {
  it('空串 taskId → acquire/release/checkTab/cleanupAll 全部 invalid-task-id', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('', fake);
    expect(ws.taskId).toBe('');
    expect(ws.getOwnedTabIds()).toEqual([]);
    const acquire = await ws.acquire('https://example.com/x', freshSignal());
    expect(acquire).toMatchObject({ ok: false, errorCode: 'invalid-task-id' });
    expect(fake.createLog).toEqual([]);
    const release = await ws.release('task-tab-1');
    expect(release).toMatchObject({ ok: false, errorCode: 'invalid-task-id' });
    const check = await ws.checkTab('task-tab-1');
    expect(check).toMatchObject({ ok: false, errorCode: 'invalid-task-id' });
    const cleanup = await ws.cleanupAll();
    expect(cleanup).toMatchObject({ ok: false, errorCode: 'invalid-task-id', closedCount: 0 });
    expect(fake.closeLog).toEqual([]);
    expect(userTabIds(fake)).toEqual(['U1']);
  });
});

// 决议 #119 矩阵（先红后修）：所有权验证优先（即使已 aborted 也绝不关闭
// tabsBefore 中的既有 Tab）+ provisional ownership（全新精确 id 先登记后清理）+
// 清理事实语义（确认关闭才移除所有权；closeTab false/抛错 → cleanup-failed +
// 所有权保留 + cleanupAll 可精确重试）。
describe('21. 决议 #119：所有权验证优先 + provisional 清理事实语义', () => {
  it('A. create 期间 abort 后 createTab 返回既有用户 Tab → tab-create-failed、零关闭、U1 逐字段恒等', async () => {
    const fake = new FakeBrowser([
      { id: 'U1', url: 'https://user.example/page', title: '用户页面' },
    ]);
    fake.manualCreate = true;
    const ws = new ResearchWorkspace('task-1', fake);
    const controller = new AbortController();
    const p = ws.acquire('https://example.com/x', controller.signal);
    await fake.waitForPending(1); // 基线 getTabs 已完成、createTab pending
    controller.abort(); // create 期间终止
    const u1Before = { ...fake.tabs.get('U1')! }; // U1 完整快照（id/url/title/state/active）
    fake.completeCreateWithTab({ ...u1Before }); // 敌手：返回 tabsBefore 中已存在的用户 Tab
    const result = await p;
    expect(result).toMatchObject({ ok: false, errorCode: 'tab-create-failed' });
    expect(fake.closeLog).toEqual([]); // 零关闭动作（即使已 aborted）
    expect(ws.getOwnedTabIds()).toEqual([]); // 零登记
    expect(fake.tabs.get('U1')).toEqual(u1Before); // U1 逐字段恒等（不按 URL/标题/位置/活动推断）
    expect(userTabIds(fake)).toEqual(['U1']);
  });

  it('B. abort + closeTab=false → cleanup-failed、provisional 保留、cleanupAll 精确补清理零泄漏', async () => {
    const fake = new FakeBrowser(USER_TABS);
    fake.manualCreate = true;
    const ws = new ResearchWorkspace('task-1', fake);
    const controller = new AbortController();
    const p = ws.acquire('https://example.com/x', controller.signal);
    await fake.waitForPending(1);
    controller.abort();
    fake.closeResult = () => false; // 清理失败
    const tab = fake.completeCreate(0); // 全新 task Tab
    const result = await p;
    expect(result).toMatchObject({ ok: false, errorCode: 'cleanup-failed' });
    expect(ws.getOwnedTabIds()).toEqual([tab.id]); // 所有权保留（不误报已清理）
    expect(fake.tabs.has(tab.id)).toBe(true); // Tab 仍存在但不再失联
    expect(userTabIds(fake)).toEqual(['U1']);
    // 恢复 closeTab 后 cleanupAll 只针对该精确 id 重试
    fake.closeResult = null;
    const cleanup = await ws.cleanupAll();
    expect(cleanup.ok).toBe(true);
    if (!cleanup.ok) return;
    expect(cleanup.closedCount).toBe(1);
    expect(cleanup.skippedCount).toBe(0);
    expect(fake.closeLog.filter((id) => id === tab.id).length).toBe(2); // 失败尝试 + 补清理
    expect(taskTabIds(fake)).toEqual([]); // 最终 task Tab 零泄漏
    expect(userTabIds(fake)).toEqual(['U1']);
    expect(ws.getOwnedTabIds()).toEqual([]);
  });

  it('C. abort + closeTab 抛错 → cleanup-failed、所有权保留、cleanupAll 补清理、零未处理 rejection', async () => {
    const fake = new FakeBrowser(USER_TABS);
    fake.manualCreate = true;
    const ws = new ResearchWorkspace('task-1', fake);
    const controller = new AbortController();
    const p = ws.acquire('https://example.com/x', controller.signal);
    await fake.waitForPending(1);
    controller.abort();
    fake.closeThrow = new Error('close boom');
    const tab = fake.completeCreate(0);
    const result = await p;
    expect(result).toMatchObject({ ok: false, errorCode: 'cleanup-failed' });
    expect(ws.getOwnedTabIds()).toEqual([tab.id]);
    expect(fake.tabs.has(tab.id)).toBe(true);
    expect(userTabIds(fake)).toEqual(['U1']);
    fake.closeThrow = null;
    const cleanup = await ws.cleanupAll();
    expect(cleanup.ok).toBe(true);
    if (!cleanup.ok) return;
    expect(cleanup.closedCount).toBe(1);
    expect(taskTabIds(fake)).toEqual([]);
    expect(userTabIds(fake)).toEqual(['U1']);
    expect(ws.getOwnedTabIds()).toEqual([]);
  });

  it('D. activateTab=false + closeTab=false → cleanup-failed、所有权保留、cleanupAll 重试成功、用户 Tab 零触碰', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('task-1', fake);
    fake.activateResult = () => false; // 焦点恢复失败
    fake.closeResult = () => false; // 清理失败
    const result = await ws.acquire('https://example.com/x', freshSignal());
    expect(result).toMatchObject({ ok: false, errorCode: 'cleanup-failed' });
    const owned = ws.getOwnedTabIds();
    expect(owned.length).toBe(1);
    const newId = owned[0];
    expect(fake.tabs.has(newId)).toBe(true); // 清理失败 Tab 仍存在但所有权保留
    expect(userTabIds(fake)).toEqual(['U1']);
    // 恢复 closeTab 后 cleanupAll 只关闭该精确 id
    fake.closeResult = null;
    const cleanup = await ws.cleanupAll();
    expect(cleanup.ok).toBe(true);
    if (!cleanup.ok) return;
    expect(cleanup.closedCount).toBe(1);
    expect(fake.closeLog.filter((id) => id === newId).length).toBe(2);
    expect(taskTabIds(fake)).toEqual([]);
    expect(userTabIds(fake)).toEqual(['U1']);
    expect(ws.getOwnedTabIds()).toEqual([]);
  });

  it('E. activateTab 抛错 + closeTab 抛错 → cleanup-failed、所有权保留、重试成功、零未处理 rejection', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('task-1', fake);
    fake.activateResult = () => {
      throw new Error('activate boom');
    };
    fake.closeThrow = new Error('close boom');
    const result = await ws.acquire('https://example.com/x', freshSignal());
    expect(result).toMatchObject({ ok: false, errorCode: 'cleanup-failed' });
    const owned = ws.getOwnedTabIds();
    expect(owned.length).toBe(1);
    expect(fake.tabs.has(owned[0])).toBe(true);
    expect(userTabIds(fake)).toEqual(['U1']);
    fake.closeThrow = null;
    const cleanup = await ws.cleanupAll();
    expect(cleanup.ok).toBe(true);
    if (!cleanup.ok) return;
    expect(cleanup.closedCount).toBe(1);
    expect(taskTabIds(fake)).toEqual([]);
    expect(userTabIds(fake)).toEqual(['U1']);
    expect(ws.getOwnedTabIds()).toEqual([]);
  });

  it('F1. 创建后 getTabs 抛错 + closeTab=false → cleanup-failed、provisional 由 cleanupAll 重试（不成为未登记泄漏）', async () => {
    const fake = new FakeBrowser(USER_TABS);
    fake.manualCreate = true;
    const ws = new ResearchWorkspace('task-1', fake);
    const p = ws.acquire('https://example.com/x', freshSignal());
    await fake.waitForPending(1); // 基线 getTabs 已完成、createTab pending
    fake.getTabsError = new Error('tabs boom'); // 仅创建后 getTabs 抛错
    fake.closeResult = () => false;
    const tab = fake.completeCreate(0);
    const result = await p;
    expect(result).toMatchObject({ ok: false, errorCode: 'cleanup-failed' });
    expect(ws.getOwnedTabIds()).toEqual([tab.id]);
    expect(fake.tabs.has(tab.id)).toBe(true);
    expect(userTabIds(fake)).toEqual(['U1']);
    // 恢复后 cleanupAll 补清理
    fake.getTabsError = null;
    fake.closeResult = null;
    const cleanup = await ws.cleanupAll();
    expect(cleanup.ok).toBe(true);
    if (!cleanup.ok) return;
    expect(cleanup.closedCount).toBe(1);
    expect(taskTabIds(fake)).toEqual([]);
    expect(userTabIds(fake)).toEqual(['U1']);
    expect(ws.getOwnedTabIds()).toEqual([]);
  });

  it('F2. 创建后 getTabs 抛错 + closeTab 抛错 → cleanup-failed、可重试、零未处理 rejection', async () => {
    const fake = new FakeBrowser(USER_TABS);
    fake.manualCreate = true;
    const ws = new ResearchWorkspace('task-1', fake);
    const p = ws.acquire('https://example.com/x', freshSignal());
    await fake.waitForPending(1);
    fake.getTabsError = new Error('tabs boom');
    fake.closeThrow = new Error('close boom');
    const tab = fake.completeCreate(0);
    const result = await p;
    expect(result).toMatchObject({ ok: false, errorCode: 'cleanup-failed' });
    expect(ws.getOwnedTabIds()).toEqual([tab.id]);
    expect(fake.tabs.has(tab.id)).toBe(true);
    expect(userTabIds(fake)).toEqual(['U1']);
    fake.getTabsError = null;
    fake.closeThrow = null;
    const cleanup = await ws.cleanupAll();
    expect(cleanup.ok).toBe(true);
    if (!cleanup.ok) return;
    expect(cleanup.closedCount).toBe(1);
    expect(taskTabIds(fake)).toEqual([]);
    expect(userTabIds(fake)).toEqual(['U1']);
    expect(ws.getOwnedTabIds()).toEqual([]);
  });

  it('G1. 对照：abort + 清理成功 → 仍返回 tab-create-aborted、精确关闭零泄漏', async () => {
    const fake = new FakeBrowser(USER_TABS);
    fake.manualCreate = true;
    const ws = new ResearchWorkspace('task-1', fake);
    const controller = new AbortController();
    const p = ws.acquire('https://example.com/x', controller.signal);
    await fake.waitForPending(1);
    controller.abort();
    const tab = fake.completeCreate(0);
    const result = await p;
    expect(result).toMatchObject({ ok: false, errorCode: 'tab-create-aborted' });
    expect(fake.closeLog).toEqual([tab.id]); // 只关闭本次创建的精确 id
    expect(taskTabIds(fake)).toEqual([]);
    expect(userTabIds(fake)).toEqual(['U1']);
    expect(ws.getOwnedTabIds()).toEqual([]);
  });

  it('G2. 对照：焦点恢复失败 + 清理成功 → 仍返回 tab-restore-focus-failed、精确关闭', async () => {
    const fake = new FakeBrowser(USER_TABS);
    const ws = new ResearchWorkspace('task-1', fake);
    fake.activateResult = () => false;
    const result = await ws.acquire('https://example.com/x', freshSignal());
    expect(result).toMatchObject({ ok: false, errorCode: 'tab-restore-focus-failed' });
    expect(taskTabIds(fake)).toEqual([]);
    expect(userTabIds(fake)).toEqual(['U1']);
    expect(ws.getOwnedTabIds()).toEqual([]);
  });
});
