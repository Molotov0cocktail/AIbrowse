// B6 usage 接线测试（红→绿；决议 #79/#81）。契约源：doc/stage4/detailed-design.md
// §11 + high-level-design §4.4 + 决议 Q10：
// - SourceSearchHintStore：每个 AgentLoop/run 独立（runId 键控 + run 级 bridge 闭包）、
//   确定性有界（MAX_HINTS_PER_RUN，FIFO 淘汰最旧）、按 sourceId 去重（首现保持）、
//   跨 run 隔离；禁止全局共享、后台巡检（零 timer）与网络请求（模块零 fetch/网络 import）。
// - browser_open 比对：同一 run 的 hints 经 normalizeSourceUrl 分别匹配 origin/page
//   canonicalKey（fragment/默认端口等规范化变体命中；query 差异不命中）；一个 URL
//   同时匹配 origin/page 命中 → 全部去重命中逐一记录；无关 URL、先 open 后 search、
//   跨 run、取消/终态后清空 → 零记录。
// - usage 写入：成功 → reachable、执行失败 → unreachable；写入失败仅脱敏告警并安全
//   no-op（绝不抛出、绝不改变 browser_open 的 ToolResult/权限/Agent 终态）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceUsageHit } from '../../../shared/types/sources';
import { MAX_HINTS_PER_RUN, SourceSearchHintStore, SourceUsageTracker } from './usage-tracker';

// 管线告警路径会 logWarn——单测环境避免向 CWD 写日志文件（与 tool-executor.test 同款）
vi.mock('../../logger', () => ({
  logDebug: () => {},
  logInfo: () => {},
  logWarn: () => {},
  logError: () => {},
}));

function hit(sourceId: string, scope: 'origin' | 'page', canonicalKey: string): SourceUsageHit {
  return { sourceId, scope, canonicalKey };
}

describe('SourceSearchHintStore（每 run 独立/有界/去重，决议 Q10）', () => {
  let store: SourceSearchHintStore;

  beforeEach(() => {
    store = new SourceSearchHintStore();
  });

  afterEach(() => {
    store.dispose();
  });

  it('page 命中：同 run 内 open 规范化 URL 精确匹配（fragment 变体命中——page 键去 fragment）', () => {
    store.recordHits('r1', [hit('s1', 'page', 'https://example.com/path')]);
    expect(store.matchOpenUrl('r1', 'https://example.com/path#section')).toEqual([
      hit('s1', 'page', 'https://example.com/path'),
    ]);
    // 默认端口变体（https://…:443 → 去除）
    store.recordHits('r1', [hit('s2', 'page', 'https://example.org/page')]);
    expect(store.matchOpenUrl('r1', 'https://example.org:443/page')).toEqual([
      hit('s2', 'page', 'https://example.org/page'),
    ]);
  });

  it('origin 命中：任意路径/query/fragment 变体均命中 origin 键', () => {
    store.recordHits('r1', [hit('s1', 'origin', 'https://example.com')]);
    expect(store.matchOpenUrl('r1', 'https://example.com/any/path?q=1#f')).toEqual([
      hit('s1', 'origin', 'https://example.com'),
    ]);
  });

  it('query 差异不命中（保守规范化保留 query——不同 query 是不同 page 身份）', () => {
    store.recordHits('r1', [hit('s1', 'page', 'https://example.com/p?utm_source=a')]);
    expect(store.matchOpenUrl('r1', 'https://example.com/p?utm_source=b')).toEqual([]);
  });

  it('一个 URL 同时匹配已命中的 origin/page Source → 全部去重命中', () => {
    store.recordHits('r1', [
      hit('s-origin', 'origin', 'https://example.com'),
      hit('s-page', 'page', 'https://example.com/path'),
    ]);
    expect(store.matchOpenUrl('r1', 'https://example.com/path#f')).toEqual([
      hit('s-origin', 'origin', 'https://example.com'),
      hit('s-page', 'page', 'https://example.com/path'),
    ]);
  });

  it('无关 URL 不命中（同 origin 不同 page、不同 origin）', () => {
    store.recordHits('r1', [hit('s1', 'page', 'https://example.com/a')]);
    expect(store.matchOpenUrl('r1', 'https://example.com/b')).toEqual([]);
    expect(store.matchOpenUrl('r1', 'https://other.example/a')).toEqual([]);
  });

  it('先 open 后 search：未登记前 open 零命中', () => {
    expect(store.matchOpenUrl('r1', 'https://example.com/a')).toEqual([]);
    store.recordHits('r1', [hit('s1', 'page', 'https://example.com/a')]);
    // 登记后同一 URL 命中——登记时刻决定语义（open 回调在登记后发生才记录）
    expect(store.matchOpenUrl('r1', 'https://example.com/a')).toEqual([
      hit('s1', 'page', 'https://example.com/a'),
    ]);
  });

  it('跨 run 隔离：run A 登记的 hints 对 run B 不可见；clearRun 清空', () => {
    store.recordHits('rA', [hit('s1', 'page', 'https://example.com/a')]);
    expect(store.matchOpenUrl('rB', 'https://example.com/a')).toEqual([]);
    store.clearRun('rA');
    expect(store.matchOpenUrl('rA', 'https://example.com/a')).toEqual([]);
    expect(store.matchOpenUrl('rB', 'https://example.com/a')).toEqual([]);
  });

  it('按 sourceId 去重：重复登记保持首现（一次 open 只记录一次）', () => {
    store.recordHits('r1', [hit('s1', 'page', 'https://example.com/a')]);
    store.recordHits('r1', [hit('s1', 'page', 'https://example.com/a')]);
    expect(store.matchOpenUrl('r1', 'https://example.com/a')).toEqual([
      hit('s1', 'page', 'https://example.com/a'),
    ]);
  });

  it('有界：超过 MAX_HINTS_PER_RUN 时 FIFO 淘汰最旧（确定性上界）', () => {
    const hits: SourceUsageHit[] = [];
    for (let i = 0; i < MAX_HINTS_PER_RUN + 10; i += 1) {
      hits.push(hit(`s${i}`, 'page', `https://example.com/p-${i}`));
    }
    store.recordHits('r1', hits);
    // 最旧的 10 个已被淘汰；最新登记仍命中
    expect(store.matchOpenUrl('r1', 'https://example.com/p-0')).toEqual([]);
    expect(store.matchOpenUrl('r1', `https://example.com/p-${MAX_HINTS_PER_RUN + 9}`)).toEqual([
      hit(`s${MAX_HINTS_PER_RUN + 9}`, 'page', `https://example.com/p-${MAX_HINTS_PER_RUN + 9}`),
    ]);
  });

  it('规范化失败（userinfo/非 http）与无关 URL 零命中、不抛异常', () => {
    store.recordHits('r1', [hit('s1', 'page', 'https://example.com/a')]);
    expect(store.matchOpenUrl('r1', 'https://user:pw@example.com/a')).toEqual([]);
    expect(store.matchOpenUrl('r1', 'javascript:alert(1)')).toEqual([]);
    expect(store.matchOpenUrl('r1', 'not a url')).toEqual([]);
    expect(store.matchOpenUrl('r1', '')).toEqual([]);
  });

  it('零后台巡检：任何操作后无 timer 残留（无 setInterval/setTimeout 调用）', () => {
    vi.useFakeTimers();
    try {
      store.recordHits('r1', [hit('s1', 'page', 'https://example.com/a')]);
      store.matchOpenUrl('r1', 'https://example.com/a');
      store.clearRun('r1');
      store.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose 后全部 run 清空（幂等安全）', () => {
    store.recordHits('r1', [hit('s1', 'page', 'https://example.com/a')]);
    store.dispose();
    expect(store.matchOpenUrl('r1', 'https://example.com/a')).toEqual([]);
    store.dispose(); // 幂等
  });
});

describe('SourceUsageTracker（run 级 bridge + usage 写入安全 no-op）', () => {
  it('同 run：search 命中 → open 成功记录 reachable；open 失败记录 unreachable；全部命中逐一记录', async () => {
    const writes: Array<{ sourceId: string; outcome: string }> = [];
    const tracker = new SourceUsageTracker(async (sourceId, outcome) => {
      writes.push({ sourceId, outcome });
    });
    const bridge = tracker.bridge('r1');
    bridge.recordSearchHits([
      hit('s-origin', 'origin', 'https://example.com'),
      hit('s-page', 'page', 'https://example.com/path'),
    ]);
    bridge.onBrowserOpen('https://example.com/path#f', true);
    await Promise.resolve(); // async 写入微任务冲刷
    expect(writes).toEqual([
      { sourceId: 's-origin', outcome: 'reachable' },
      { sourceId: 's-page', outcome: 'reachable' },
    ]);
    // 执行失败且 URL 命中 origin 命中 → unreachable（失败同样记录命中条目）
    bridge.onBrowserOpen('https://example.com/fail-page', false);
    await Promise.resolve();
    expect(writes).toEqual([
      { sourceId: 's-origin', outcome: 'reachable' },
      { sourceId: 's-page', outcome: 'reachable' },
      { sourceId: 's-origin', outcome: 'unreachable' },
    ]);
    bridge.clearRun();
    tracker.dispose();
  });

  it('无关 URL / 先 open 后 search / 跨 run → 零写入', async () => {
    const writes: Array<{ sourceId: string }> = [];
    const tracker = new SourceUsageTracker(async (sourceId) => {
      writes.push({ sourceId });
    });
    const bridgeA = tracker.bridge('rA');
    bridgeA.onBrowserOpen('https://example.com/a', true); // 先 open 后 search
    bridgeA.recordSearchHits([hit('s1', 'page', 'https://example.com/a')]);
    bridgeA.onBrowserOpen('https://unrelated.example/a', true); // 无关 URL
    const bridgeB = tracker.bridge('rB'); // 跨 run
    bridgeB.onBrowserOpen('https://example.com/a', true);
    await Promise.resolve();
    expect(writes).toEqual([]);
    // 同 run 命中后才写入
    bridgeA.onBrowserOpen('https://example.com/a', true);
    await Promise.resolve();
    expect(writes).toEqual([{ sourceId: 's1' }]);
    tracker.dispose();
  });

  it('取消/终态后清空 hints：clearRun 后迟到 open 回调零写入', async () => {
    const writes: string[] = [];
    const tracker = new SourceUsageTracker(async (sourceId) => {
      writes.push(sourceId);
    });
    const bridge = tracker.bridge('r1');
    bridge.recordSearchHits([hit('s1', 'page', 'https://example.com/a')]);
    bridge.clearRun(); // AgentLoop 终态调用
    bridge.onBrowserOpen('https://example.com/a', true); // 迟到工具结果
    await Promise.resolve();
    expect(writes).toEqual([]);
    tracker.dispose();
  });

  it('写入失败（同步抛异常）仅脱敏告警并安全 no-op：不抛给调用方', async () => {
    const tracker = new SourceUsageTracker(() => {
      throw new Error('db 损坏');
    });
    const bridge = tracker.bridge('r1');
    bridge.recordSearchHits([hit('s1', 'page', 'https://example.com/a')]);
    expect(() => bridge.onBrowserOpen('https://example.com/a', true)).not.toThrow();
    tracker.dispose();
  });

  it('写入失败（异步 reject）被内部捕获：无 unhandledRejection、不影响后续写入', async () => {
    const writes: string[] = [];
    const tracker = new SourceUsageTracker((sourceId) => {
      if (sourceId === 'bad') return Promise.reject(new Error('唯一约束冲突'));
      writes.push(sourceId);
      return Promise.resolve();
    });
    const bridge = tracker.bridge('r1');
    bridge.recordSearchHits([
      hit('bad', 'page', 'https://example.com/bad'),
      hit('ok', 'page', 'https://example.com/ok'),
    ]);
    bridge.onBrowserOpen('https://example.com/bad', true);
    bridge.onBrowserOpen('https://example.com/ok', true);
    await new Promise((resolve) => setTimeout(resolve, 0)); // 微任务冲刷（vitest 自动捕获 unhandledRejection）
    expect(writes).toEqual(['ok']);
    tracker.dispose();
  });

  it('无 writer（无 SourceService）→ 零写入零抛出', () => {
    const tracker = new SourceUsageTracker(null);
    const bridge = tracker.bridge('r1');
    bridge.recordSearchHits([hit('s1', 'page', 'https://example.com/a')]);
    expect(() => bridge.onBrowserOpen('https://example.com/a', true)).not.toThrow();
    tracker.dispose();
  });

  it('bridge 按 run 绑定：run 级闭包无 runId 参数（模型/工具无通道跨 run）', async () => {
    const writes: Array<{ sourceId: string }> = [];
    const tracker = new SourceUsageTracker(async (sourceId) => {
      writes.push({ sourceId });
    });
    const bridgeA = tracker.bridge('rA');
    const bridgeB = tracker.bridge('rB');
    bridgeA.recordSearchHits([hit('sa', 'page', 'https://a.example/x')]);
    bridgeB.recordSearchHits([hit('sb', 'page', 'https://b.example/x')]);
    bridgeA.onBrowserOpen('https://b.example/x', true); // A 无 b 命中 → 零写入
    bridgeB.onBrowserOpen('https://b.example/x', true);
    await Promise.resolve();
    expect(writes).toEqual([{ sourceId: 'sb' }]);
    tracker.dispose();
  });
});
