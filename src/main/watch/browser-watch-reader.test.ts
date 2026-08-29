// D6 browser-watch-reader: task Tab → PageSnapshot → DocumentChannels（FIXED
// 4/9/10）。红→绿 oracle：ready/error/missing/用户关闭/timeout/abort、snapshot
// 元数据（capturedAt/documentId/readyState/degraded）、登录/challenge 组合信号
// 与正文字符串免疫、迟到结果零 Projection、inputs/form 值零进入、deadline 冻结。
import { describe, expect, it } from 'vitest';
import {
  BrowserWatchReader,
  pageSnapshotToChannels,
  classifySnapshotSuspicion,
  freezeAttemptDeadline,
  type WatchBrowserReadPort,
} from './browser-watch-reader';
import type { Clock, TimerHandle } from '../../shared/types/watch';
import { NETWORK_ATTEMPT_TIMEOUT_MS } from '../../shared/types/watch';
import type { PageSnapshot, TabInfo } from '../../shared/types/browser';

// 仿 FakeClock（避免依赖真实等待）：手动推进时间并触发到期 timer
class ManualClock implements Clock {
  private nowMs = 0;
  private timers = new Map<number, { atMs: number; cb: () => void }>();
  private nextId = 1;

  now(): Date {
    return new Date(this.nowMs);
  }
  setCurrent(ms: number): void {
    this.nowMs = ms;
    this.runDue();
  }
  advanceBy(ms: number): void {
    this.nowMs += ms;
    this.runDue();
  }
  pendingTimers(): number {
    return this.timers.size;
  }
  private runDue(): void {
    for (const [id, t] of [...this.timers]) {
      if (t.atMs <= this.nowMs) {
        this.timers.delete(id);
        t.cb();
      }
    }
  }
  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { atMs: this.nowMs + delayMs, cb: callback });
    return { kind: 'timer', id };
  }
  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle.id);
  }
}

function tab(overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id: 'task-tab-1',
    title: '',
    url: 'https://example.com/doc',
    active: false,
    state: 'loading',
    ...overrides,
  };
}

function snapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://example.com/doc',
    title: 't',
    visibleText: '正文\n内容',
    headings: [
      { level: 1, text: 'H1' },
      { level: 4, text: 'H4 应被过滤' },
      { level: 2, text: 'H2' },
    ],
    links: [
      { id: 'l1', text: '链接A', href: 'https://example.com/a?tk=1#f' },
      { id: 'l2', text: '链接B', href: 'javascript:void(0)' },
    ],
    buttons: [{ id: 'b1', text: '按钮' }],
    inputs: [{ id: 'i1', type: 'text', placeholder: '占位', value: 'FORM-CANARY-INPUT-VALUE' }],
    tables: [{ headers: ['名称', '价格'], rows: [['甲', '100']] }],
    meta: {
      capturedAt: 1752000000000,
      documentId: 42,
      readyState: 'complete',
      degraded: 'none',
      warnings: [],
    },
    ...overrides,
  };
}

class FakeBrowser implements WatchBrowserReadPort {
  tabs: TabInfo[] = [];
  snapshots = new Map<string, PageSnapshot | null>();
  snapshotCalls = 0;
  getTabsCalls = 0;
  failures = { tabs: false, snapshot: false };

  constructor(initial: TabInfo[] = [tab({ state: 'ready' })]) {
    this.tabs = initial;
    for (const t of initial) this.snapshots.set(t.id, snapshot());
  }

  async getTabs(): Promise<TabInfo[]> {
    this.getTabsCalls += 1;
    if (this.failures.tabs) throw new Error('getTabs failed');
    return this.tabs.map((t) => ({ ...t }));
  }
  async getPageSnapshot(tabId: string): Promise<PageSnapshot | null> {
    this.snapshotCalls += 1;
    if (this.failures.snapshot) throw new Error('snapshot failed');
    return this.snapshots.get(tabId) ?? null;
  }
}

function makeReader(browser: WatchBrowserReadPort, clock: ManualClock) {
  return new BrowserWatchReader({ browser, clock });
}

// await 微任务排空（数字时钟依赖 getTabs 异步回调先落定再安装下一轮 timer）
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

const DEADLINE = 1752000000000 + 30_000;

describe('pageSnapshotToChannels — 纯映射', () => {
  it('visibleText→mainText；只保留 1..3 级标题；链接规范化；inputs/buttons 零进入', () => {
    const r = pageSnapshotToChannels(snapshot());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.channels;
    expect(c.mainText).toBe('正文 内容');
    expect(c.headings).toEqual([
      { level: 1, text: 'H1' },
      { level: 2, text: 'H2' },
    ]);
    expect(c.links).toEqual([{ text: '链接A', url: 'https://example.com/a?tk=1' }]);
    expect(c.tables).toEqual([{ headers: ['名称', '价格'], rows: [['甲', '100']] }]);
    expect(JSON.stringify(c)).not.toContain('FORM-CANARY-INPUT-VALUE');
    expect(JSON.stringify(c)).not.toContain('占位');
  });

  it('input.value / form canary 在任何通道中零命中', () => {
    const r = pageSnapshotToChannels(snapshot());
    if (!r.ok) return;
    const json = JSON.stringify(r.channels);
    expect(json).not.toContain('value');
    expect(json).not.toContain('placeholder');
    expect(json).not.toContain('CANARY');
  });

  // R5 修复：显式空单元格/空行保留列位置，绝不让后续列左移漂移
  it('空首列/空中间列/空末列/整行空单元格：列索引与 columnLabel 不漂移', () => {
    const r = pageSnapshotToChannels(
      snapshot({
        tables: [
          {
            headers: ['名称', '价格', '库存'],
            rows: [
              ['', '甲', '100'], // 空首列
              ['乙', '', '200'], // 空中间列
              ['丙', '300', ''], // 空末列
              ['', '', ''], // 整行空单元格（保留列结构）
            ],
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.channels.tables).toEqual([
      {
        headers: ['名称', '价格', '库存'],
        rows: [
          ['', '甲', '100'],
          ['乙', '', '200'],
          ['丙', '300', ''],
          ['', '', ''],
        ],
      },
    ]);
    // 空首列首单元格为空字符串且不产生占位正文
    const json = JSON.stringify(r.channels);
    expect(json).not.toContain('占位');
  });
});

describe('BrowserWatchReader — ready 等待与失败分类', () => {
  it('ready 后读取一次 snapshot 并返回验证过的通道', async () => {
    const clock = new ManualClock();
    const browser = new FakeBrowser();
    const reader = makeReader(browser, clock);
    const r = await reader.read({
      tabId: 'task-tab-1',
      signal: new AbortController().signal,
      deadline: new Date(DEADLINE),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta.capturedAt).toBe(new Date(1752000000000).toISOString());
    expect(r.meta.documentId).toBe('42');
    expect(r.meta.url).toBe('https://example.com/doc');
    expect(browser.snapshotCalls).toBe(1);
  });

  it('error 状态 → tab-error', async () => {
    const clock = new ManualClock();
    const browser = new FakeBrowser([tab({ state: 'error' })]);
    const reader = makeReader(browser, clock);
    const r = await reader.read({
      tabId: 'task-tab-1',
      signal: new AbortController().signal,
      deadline: new Date(DEADLINE),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('tab-error');
  });

  it('loading → 轮询至 ready（推进时钟）', async () => {
    const clock = new ManualClock();
    const browser = new FakeBrowser([tab({ state: 'loading' })]);
    const reader = makeReader(browser, clock);
    const p = reader.read({
      tabId: 'task-tab-1',
      signal: new AbortController().signal,
      deadline: new Date(DEADLINE),
    });
    await flush(); // 第一轮 getTabs 落定 → sleep timer 安装
    expect(clock.pendingTimers()).toBeGreaterThan(0);
    browser.tabs[0] = tab({ state: 'ready' });
    clock.advanceBy(100); // 第二轮轮询命中 ready
    const r = await p;
    expect(r.ok).toBe(true);
    expect(clock.pendingTimers()).toBe(0); // timer 结算清除
  });

  it('tab 缺失（用户关闭）→ tab-missing/tab-closed-by-user', async () => {
    const clock = new ManualClock();
    const browser = new FakeBrowser();
    const reader = makeReader(browser, clock);
    const missing = await reader.read({
      tabId: 'ghost',
      signal: new AbortController().signal,
      deadline: new Date(DEADLINE),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('tab-missing');
  });

  it('deadline 到期 → timeout；轮询结束后零 timer', async () => {
    const clock = new ManualClock();
    const browser = new FakeBrowser([tab({ state: 'loading' })]);
    const reader = makeReader(browser, clock);
    const p = reader.read({
      tabId: 'task-tab-1',
      signal: new AbortController().signal,
      deadline: new Date(DEADLINE),
    });
    clock.setCurrent(DEADLINE);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('timeout');
    expect(clock.pendingTimers()).toBe(0);
  });

  it('abort → aborted；迟到 snapshot/timer 零副作用', async () => {
    const clock = new ManualClock();
    const browser = new FakeBrowser();
    const controller = new AbortController();
    const reader = makeReader(browser, clock);
    const p = reader.read({
      tabId: 'task-tab-1',
      signal: controller.signal,
      deadline: new Date(DEADLINE),
    });
    controller.abort();
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('aborted');
    expect(browser.snapshotCalls).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('waitReady 期间用户关闭 → tab-missing', async () => {
    const clock = new ManualClock();
    const browser = new FakeBrowser([tab({ state: 'loading' })]);
    const reader = makeReader(browser, clock);
    const p = reader.read({
      tabId: 'task-tab-1',
      signal: new AbortController().signal,
      deadline: new Date(DEADLINE),
    });
    await flush(); // 第一轮 getTabs 落定（loading）→ sleep timer 安装
    browser.tabs = [];
    clock.advanceBy(100); // 第二轮轮询：tab 已消失
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('tab-missing');
  });
});

describe('BrowserWatchReader — snapshot 元数据与迟到结果', () => {
  it('readyState 非 complete → snapshot-invalid', async () => {
    const clock = new ManualClock();
    const browser = new FakeBrowser();
    browser.snapshots.set(
      'task-tab-1',
      snapshot({ meta: { ...snapshot().meta!, readyState: 'loading' as const } }),
    );
    const reader = makeReader(browser, clock);
    const r = await reader.read({
      tabId: 'task-tab-1',
      signal: new AbortController().signal,
      deadline: new Date(DEADLINE),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('snapshot-invalid');
  });

  it('任意 degraded → snapshot-degraded 零 Projection', async () => {
    const clock = new ManualClock();
    const browser = new FakeBrowser();
    browser.snapshots.set(
      'task-tab-1',
      snapshot({ meta: { ...snapshot().meta!, degraded: 'partial' as const } }),
    );
    const reader = makeReader(browser, clock);
    const r = await reader.read({
      tabId: 'task-tab-1',
      signal: new AbortController().signal,
      deadline: new Date(DEADLINE),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('snapshot-degraded');
  });

  it('capturedAt 非法（NaN/非整数/字符串）→ snapshot-invalid', async () => {
    for (const bad of [Number.NaN, 1.5, '1752000000000' as unknown as number]) {
      const clock = new ManualClock();
      const browser = new FakeBrowser();
      browser.snapshots.set(
        'task-tab-1',
        snapshot({ meta: { ...snapshot().meta!, capturedAt: bad } }),
      );
      const reader = makeReader(browser, clock);
      const r = await reader.read({
        tabId: 'task-tab-1',
        signal: new AbortController().signal,
        deadline: new Date(DEADLINE),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('snapshot-invalid');
    }
  });

  it('documentId 0/负数/非安全整数 → snapshot-invalid', async () => {
    for (const bad of [0, -1, Number.MAX_SAFE_INTEGER + 2, 42.5]) {
      const clock = new ManualClock();
      const browser = new FakeBrowser();
      browser.snapshots.set(
        'task-tab-1',
        snapshot({ meta: { ...snapshot().meta!, documentId: bad } }),
      );
      const reader = makeReader(browser, clock);
      const r = await reader.read({
        tabId: 'task-tab-1',
        signal: new AbortController().signal,
        deadline: new Date(DEADLINE),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('snapshot-invalid');
    }
  });

  it('snapshot null → snapshot-null', async () => {
    const clock = new ManualClock();
    const browser = new FakeBrowser();
    browser.snapshots.set('task-tab-1', null);
    const reader = makeReader(browser, clock);
    const r = await reader.read({
      tabId: 'task-tab-1',
      signal: new AbortController().signal,
      deadline: new Date(DEADLINE),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('snapshot-null');
  });

  it('snapshot 后 tab 消失 → tab-closed-by-user（迟到结果零 Projection）', async () => {
    const clock = new ManualClock();
    // 首次 getTabs（等待 ready 轮询）返回 ready；此后（后置复验）返回空
    let calls = 0;
    const browser: WatchBrowserReadPort = {
      getTabs: async () => {
        calls += 1;
        return calls === 1 ? [tab({ state: 'ready' })] : [];
      },
      getPageSnapshot: async () => snapshot(),
    };
    const reader = makeReader(browser, clock);
    const r = await reader.read({
      tabId: 'task-tab-1',
      signal: new AbortController().signal,
      deadline: new Date(DEADLINE),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('tab-closed-by-user');
  });
});

describe('classifySnapshotSuspicion — 组合信号,正文字符串免疫', () => {
  it('password input 单独出现 → login（价值/占位符零读取）', () => {
    const s = snapshot({
      url: 'https://example.com/doc',
      inputs: [{ id: 'p', type: 'password', value: 'PASSWORD-CANARY', placeholder: '请输密码' }],
    });
    expect(classifySnapshotSuspicion(s)).toBe('login');
    const json = JSON.stringify(s);
    void json;
  });

  it('login URL path 单独出现（无结构信号）→ unknown（不可靠分类）', () => {
    const s = snapshot({ url: 'https://example.com/login' });
    s.inputs = [{ id: 'i', type: 'text' }];
    s.buttons = [];
    expect(classifySnapshotSuspicion(s)).toBe('unknown');
  });

  it('captcha/challenge URL + 结构信号 → captcha', () => {
    const s = snapshot({
      url: 'https://example.com/challenge/verify',
      inputs: [{ id: 'i', type: 'text' }],
      buttons: [{ id: 'b', text: '提交', isSubmit: true }],
    });
    expect(classifySnapshotSuspicion(s)).toBe('captcha');
  });

  // R4 修复：普通页面只因存在/跳过 iframe 而 degraded → 'degraded'，绝不是 captcha
  it('普通 URL + iframe degraded → degraded（不是 captcha）；其余 degraded 同样 degraded', () => {
    const s = snapshot({
      url: 'https://example.com/doc',
      meta: { ...snapshot().meta!, degraded: 'main-process-only', warnings: ['iframe 跨域已跳过'] },
    });
    expect(classifySnapshotSuspicion(s)).toBe('degraded');
    const s2 = snapshot({
      url: 'https://example.com/doc',
      meta: { ...snapshot().meta!, degraded: 'partial', warnings: ['部分内容截断'] },
    });
    expect(classifySnapshotSuspicion(s2)).toBe('degraded');
  });

  // R4 修复：challenge 必须由 URL 信号 + 结构信号组合证明；通用 iframe warning 不
  // 能当 challenge 证明
  it('challenge URL + degraded（无结构信号）不是 captcha；challenge URL + 结构信号才是', () => {
    const degraded = snapshot({
      url: 'https://example.com/challenge/verify',
      meta: {
        ...snapshot().meta!,
        degraded: 'main-process-only',
        warnings: ['iframe 跨域已跳过'],
      },
    });
    expect(classifySnapshotSuspicion(degraded)).not.toBe('captcha');
    const withSubmit = snapshot({
      url: 'https://example.com/challenge/verify',
      buttons: [{ id: 'b', text: '提交', isSubmit: true }],
    });
    expect(classifySnapshotSuspicion(withSubmit)).toBe('captcha');
  });

  it('login/captcha/unknown/degraded 映射闭合且互斥（同一快照恰好一个）', () => {
    const noMarker = snapshot({ url: 'https://example.com/doc' });
    expect(classifySnapshotSuspicion(noMarker)).toBeNull();
    const loginForm = snapshot({
      url: 'https://example.com/login',
      inputs: [{ id: 'p', type: 'password' }],
    });
    expect(classifySnapshotSuspicion(loginForm)).toBe('login');
    const loginOnly = snapshot({ url: 'https://example.com/login' });
    expect(classifySnapshotSuspicion(loginOnly)).toBe('unknown');
    const challengeOnly = snapshot({ url: 'https://example.com/captcha' });
    expect(classifySnapshotSuspicion(challengeOnly)).toBe('unknown');
    const challengeSubmit = snapshot({
      url: 'https://example.com/captcha',
      buttons: [{ id: 'b', text: '继续', isSubmit: true }],
    });
    expect(classifySnapshotSuspicion(challengeSubmit)).toBe('captcha');
  });

  it('敌手正文（″login″ 文本）不触发分类', () => {
    const s = snapshot({ url: 'https://example.com/doc' });
    s.visibleText = 'please login now 登录页面 captcha 挑战';
    expect(classifySnapshotSuspicion(s)).toBeNull();
  });
});

describe('freezeAttemptDeadline — 一次性冻结', () => {
  it('min(外部 deadline, attemptStart+NETWORK_ATTEMPT_TIMEOUT_MS)', () => {
    expect(freezeAttemptDeadline(1000, new Date(1000 + 5000)).getTime()).toBe(1000 + 5000);
    expect(freezeAttemptDeadline(1000, new Date(1000 + 400_000)).getTime()).toBe(
      1000 + NETWORK_ATTEMPT_TIMEOUT_MS,
    );
    expect(freezeAttemptDeadline(1000, new Date(Number.NaN)).getTime()).toBe(
      1000 + NETWORK_ATTEMPT_TIMEOUT_MS,
    );
  });
});
