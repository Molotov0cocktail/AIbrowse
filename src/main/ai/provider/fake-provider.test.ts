// FakeProvider tests: deterministic script (chunks / delays / error injection / abort)
// + getLastRequest capture for smoke assertions.
// Contract source: doc/stage2/detailed-design.md §3.3; A1 工具脚本：
// doc/stage3/detailed-design.md §3.2.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_PROVIDER_METADATA, FakeProvider } from './fake-provider';
import type { ProviderEvent } from '../../../shared/types/conversation';
import type { ProviderRequest, ProviderTool } from '../../../shared/types/conversation';

// F-1 修复（2026-08-14）：node:timers/promises 的 setTimeout 被本文件级 mock 替换为
// 手动控制的 Promise——延迟语义改为确定性验证，消除真实墙钟断言（≥30ms）在并行
// 负载下的间歇失败（验收期实测 ~17% 失败率，实测值 29.86ms < 30ms）。
// 断言语义不弱化：仍校验 provider 按脚本配置的完整延迟值调用 sleep（30/20 毫秒原样
// 传入）、延迟推进前流输出未完成、推进到约定延迟后才继续，以及等待延迟期间
// abort 立即生效（中止感知语义，与真实适配器一致的 Promise.race 路径）。
const { sleepMock } = vi.hoisted(() => ({
  sleepMock: vi.fn<(ms: number) => Promise<void>>(),
}));

vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: sleepMock };
});

beforeEach(() => {
  sleepMock.mockReset();
  // 缺省立即推进：仅断言事件顺序（不断言延迟）的用例携带 delayMs 时按 0 延迟推进
  sleepMock.mockResolvedValue(undefined);
});

const REQUEST: ProviderRequest = {
  requestId: 'req-1',
  model: 'fake-model',
  system: 'sys',
  messages: [{ role: 'user', content: '你好' }],
};

async function collect(
  provider: FakeProvider,
  request: ProviderRequest,
  signal: AbortSignal = new AbortController().signal,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(request, signal)) {
    events.push(event);
  }
  return events;
}

describe('FakeProvider — 确定性分块', () => {
  it('默认脚本逐块产出 delta 并以 done 收尾（无 usage）', async () => {
    const events = await collect(new FakeProvider(), REQUEST);
    const deltas = events
      .filter((e) => e.type === 'delta')
      .map((e) => (e.type === 'delta' ? e.text : ''));
    expect(deltas).toEqual(['你好，', '这是来自 FakeProvider 的', '确定性回答。']);
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });

  it('自定义脚本（字符串/延迟块混用）顺序产出 + usage 透传', async () => {
    const provider = new FakeProvider({
      chunks: ['第一块', { text: '第二块', delayMs: 5 }],
      usage: { inputTokens: 10, outputTokens: 3 },
    });
    const events = await collect(provider, REQUEST);
    expect(events).toEqual([
      { type: 'delta', text: '第一块' },
      { type: 'delta', text: '第二块' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 3 } },
    ]);
  });

  it('同脚本两次运行事件序列完全一致（确定性）', async () => {
    const script = { chunks: ['a', 'b', 'c'], usage: { outputTokens: 1 } };
    const run1 = await collect(new FakeProvider(script), REQUEST);
    const run2 = await collect(new FakeProvider(script), REQUEST);
    expect(run1).toEqual(run2);
  });

  it('延迟块实际等待（可用于中止/超时场景编排）', async () => {
    const provider = new FakeProvider({ chunks: [{ text: 'x', delayMs: 30 }] });
    let advanceDelay!: () => void;
    sleepMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          advanceDelay = resolve;
        }),
    );
    const eventsPromise = collect(provider, REQUEST);
    // 流已运行到延迟块：sleep 以脚本配置的完整延迟值调用（30ms 阈值语义不弱化）
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).toHaveBeenCalledWith(30);
    let settled = false;
    void eventsPromise.then(() => {
      settled = true;
    });
    await Promise.resolve(); // 微任务排空：延迟推进前流不得产出任何事件
    expect(settled).toBe(false);
    advanceDelay(); // 推进到约定延迟后才继续
    const events = await eventsPromise;
    expect(events).toEqual([{ type: 'delta', text: 'x' }, { type: 'done' }]);
  });

  it('metadata：streaming=true / supportsToolCalling=true（A1 校准为真实值）/ id=fake', () => {
    expect(FAKE_PROVIDER_METADATA.id).toBe('fake');
    expect(FAKE_PROVIDER_METADATA.streaming).toBe(true);
    expect(FAKE_PROVIDER_METADATA.supportsToolCalling).toBe(true);
    const provider = new FakeProvider();
    expect(provider.metadata).toEqual(FAKE_PROVIDER_METADATA);
  });
});

describe('FakeProvider — 工具脚本（A1，doc/stage3/detailed-design.md §3.2）', () => {
  const TOOL_CALLS = [
    { id: 'call-1', name: 'browser_read', arguments: '{"tabId":null}' },
    { id: 'call-2', name: 'browser_find', arguments: '{"text":"安全"}' },
  ];
  const TOOLS: ProviderTool[] = [
    {
      type: 'function',
      function: {
        name: 'browser_read',
        description: '读取页面',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ];
  const TOOL_REQUEST: ProviderRequest = {
    ...REQUEST,
    tools: TOOLS,
  };

  it('toolCalls 块整组一步产出（text → toolCalls → text → done，顺序确定）', async () => {
    const provider = new FakeProvider({
      chunks: [
        { text: '开始。' },
        { kind: 'toolCalls', toolCalls: TOOL_CALLS },
        { text: '工具结果已收到。' },
      ],
    });
    const events = await collect(provider, TOOL_REQUEST);
    expect(events).toEqual([
      { type: 'delta', text: '开始。' },
      { type: 'toolCalls', toolCalls: TOOL_CALLS },
      { type: 'delta', text: '工具结果已收到。' },
      { type: 'done' },
    ]);
  });

  it('toolCalls 块支持 delayMs（延迟后产出，可用于中止场景编排）', async () => {
    const provider = new FakeProvider({
      chunks: [{ kind: 'toolCalls', toolCalls: TOOL_CALLS, delayMs: 20 }],
    });
    let advanceDelay!: () => void;
    sleepMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          advanceDelay = resolve;
        }),
    );
    const eventsPromise = collect(provider, TOOL_REQUEST);
    // sleep 以脚本配置的完整延迟值调用（20ms 语义不弱化）；推进前 toolCalls 不得产出
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).toHaveBeenCalledWith(20);
    let settled = false;
    void eventsPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    advanceDelay();
    const events = await eventsPromise;
    expect(events).toEqual([{ type: 'toolCalls', toolCalls: TOOL_CALLS }, { type: 'done' }]);
  });

  it('同脚本两次运行事件序列完全一致（含 toolCalls，确定性）', async () => {
    const script = {
      chunks: [{ text: 'a' }, { kind: 'toolCalls' as const, toolCalls: TOOL_CALLS }, { text: 'b' }],
    };
    const run1 = await collect(new FakeProvider(script), TOOL_REQUEST);
    const run2 = await collect(new FakeProvider(script), TOOL_REQUEST);
    expect(run1).toEqual(run2);
  });

  it('getLastRequest 完整保留 tools 字段（恒等引用，供冒烟断言）', async () => {
    const provider = new FakeProvider({ chunks: [] });
    await collect(provider, TOOL_REQUEST);
    expect(provider.getLastRequest()?.tools).toBe(TOOLS);
  });

  it('toolCalls 块前 abort → aborted 错误终结，不产出 toolCalls/done', async () => {
    const provider = new FakeProvider({
      chunks: [{ text: '第一块' }, { kind: 'toolCalls', toolCalls: TOOL_CALLS, delayMs: 10 }],
    });
    const controller = new AbortController();
    const events: ProviderEvent[] = [];
    for await (const event of provider.stream(TOOL_REQUEST, controller.signal)) {
      events.push(event);
      if (event.type === 'delta') controller.abort();
    }
    expect(events).toEqual([
      { type: 'delta', text: '第一块' },
      { type: 'error', error: expect.objectContaining({ code: 'aborted' }) },
    ]);
  });
});

describe('FakeProvider — 错误注入', () => {
  it('httpStatus=401 → 单一 error 事件（invalid-key），无 delta/done', async () => {
    const events = await collect(new FakeProvider({ error: { httpStatus: 401 } }), REQUEST);
    expect(events).toHaveLength(1);
    const only = events[0];
    expect(only.type).toBe('error');
    if (only.type === 'error') {
      expect(only.error.code).toBe('invalid-key');
      expect(only.error.requestId).toBe('req-1');
      expect(only.error.model).toBe('fake-model');
    }
  });

  it('code=timeout → timeout 错误', async () => {
    const events = await collect(new FakeProvider({ error: { code: 'timeout' } }), REQUEST);
    expect(events).toHaveLength(1);
    const only = events[0];
    expect(only.type === 'error' && only.error.code).toBe('timeout');
  });

  it('code=rate-limit → rate-limit（经状态码矩阵归一）', async () => {
    const events = await collect(new FakeProvider({ error: { code: 'rate-limit' } }), REQUEST);
    const only = events[0];
    expect(only.type === 'error' && only.error.code).toBe('rate-limit');
  });

  it('无 code/status → provider-error 兜底', async () => {
    const events = await collect(new FakeProvider({ error: {} }), REQUEST);
    const only = events[0];
    expect(only.type === 'error' && only.error.code).toBe('provider-error');
  });
});

describe('FakeProvider — 中止语义（§8.3）', () => {
  it('中途 abort → 已产出块保留 + aborted 错误终结，无 done、无后续块', async () => {
    const provider = new FakeProvider({
      chunks: ['第一块', { text: '第二块', delayMs: 10 }, '第三块'],
    });
    const controller = new AbortController();
    const events: ProviderEvent[] = [];
    for await (const event of provider.stream(REQUEST, controller.signal)) {
      events.push(event);
      if (event.type === 'delta' && event.text === '第一块') controller.abort();
    }
    expect(events).toEqual([
      { type: 'delta', text: '第一块' },
      { type: 'error', error: expect.objectContaining({ code: 'aborted' }) },
    ]);
  });
});

describe('FakeProvider — getLastRequest（冒烟断言用）', () => {
  it('流式调用前为 null，调用后记录完整请求', async () => {
    const provider = new FakeProvider();
    expect(provider.getLastRequest()).toBeNull();
    await collect(provider, REQUEST);
    expect(provider.getLastRequest()).toEqual(REQUEST);
  });

  it('连续调用记录最后一次请求', async () => {
    const provider = new FakeProvider();
    await collect(provider, REQUEST);
    await collect(provider, { ...REQUEST, requestId: 'req-2' });
    expect(provider.getLastRequest()?.requestId).toBe('req-2');
  });
});

// ---------- A5：多轮 agent 脚本（rounds 每轮消费） + getRequests 全量请求 ----------

describe('FakeProvider — 多轮脚本（A5 rounds 扩展）', () => {
  it('每次 stream 调用消费下一轮脚本；耗尽回退 chunks', async () => {
    const provider = new FakeProvider({
      rounds: [
        [{ kind: 'toolCalls', toolCalls: [{ id: 'c1', name: 'browser_read', arguments: '{}' }] }],
        [{ text: '最终回答' }],
      ],
      chunks: ['回退块'],
    });
    const round1 = await collect(provider, REQUEST);
    expect(round1[0]).toEqual({
      type: 'toolCalls',
      toolCalls: [{ id: 'c1', name: 'browser_read', arguments: '{}' }],
    });
    expect(round1.at(-1)).toEqual({ type: 'done' });
    const round2 = await collect(provider, REQUEST);
    expect(round2).toEqual([{ type: 'delta', text: '最终回答' }, { type: 'done' }]);
    const round3 = await collect(provider, REQUEST);
    expect(round3[0]).toEqual({ type: 'delta', text: '回退块' }); // 耗尽 → 回退 chunks
  });

  it('未提供 rounds 时行为不变（chunks 每轮重复）', async () => {
    const provider = new FakeProvider({ chunks: ['固定'] });
    const a = await collect(provider, REQUEST);
    const b = await collect(provider, REQUEST);
    expect(a).toEqual(b);
  });

  it('rounds 内 delayMs 感知中止（abort 等待中的 sleep 即停，无泄漏悬挂）', async () => {
    const controller = new AbortController();
    const provider = new FakeProvider({
      rounds: [[{ text: 'x', delayMs: 60_000 }]],
    });
    // sleep 永不自行完成：流只能经 abort 通道结束（确定性验证中止感知语义——
    // 与真实适配器一致的 Promise.race 路径，不依赖真实墙钟等待）
    sleepMock.mockImplementationOnce(() => new Promise<void>(() => {}));
    const promise = (async () => {
      const events: ProviderEvent[] = [];
      for await (const event of provider.stream(REQUEST, controller.signal)) {
        events.push(event);
      }
      return events;
    })();
    // 流已进入延迟等待（sleep 以 60000ms 调用），此时中止必须立即终结
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).toHaveBeenCalledWith(60_000);
    controller.abort();
    const events = await promise;
    expect(events).toEqual([
      { type: 'error', error: expect.objectContaining({ code: 'aborted' }) },
    ]);
  });

  it('getRequests 记录全部请求（按调用序）', async () => {
    const provider = new FakeProvider();
    expect(provider.getRequests()).toEqual([]);
    await collect(provider, REQUEST);
    await collect(provider, { ...REQUEST, requestId: 'req-2' });
    expect(provider.getRequests().map((r) => r.requestId)).toEqual(['req-1', 'req-2']);
    expect(provider.getLastRequest()?.requestId).toBe('req-2');
  });
});

describe('reasoning 脚本块（A7 补验校准：thinking 模式离线确定性驱动）', () => {
  it('reasoning 块按脚本顺序产出 reasoning 事件（不产出 delta 文本、不混入后续正文）', async () => {
    const provider = new FakeProvider({
      chunks: [
        { kind: 'reasoning', text: '步骤一' },
        { kind: 'reasoning', text: '步骤二' },
        { text: '最终回答' },
      ],
    });
    const events = await collect(provider, REQUEST);
    expect(events).toEqual([
      { type: 'reasoning', text: '步骤一' },
      { type: 'reasoning', text: '步骤二' },
      { type: 'delta', text: '最终回答' },
      { type: 'done', usage: undefined },
    ]);
  });
});
