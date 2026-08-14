// FakeProvider tests: deterministic script (chunks / delays / error injection / abort)
// + getLastRequest capture for smoke assertions.
// Contract source: doc/stage2/detailed-design.md §3.3; A1 工具脚本：
// doc/stage3/detailed-design.md §3.2.
import { describe, expect, it } from 'vitest';
import { FAKE_PROVIDER_METADATA, FakeProvider } from './fake-provider';
import type { ProviderEvent } from '../../../shared/types/conversation';
import type { ProviderRequest, ProviderTool } from '../../../shared/types/conversation';

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
    const started = performance.now();
    await collect(provider, REQUEST);
    expect(performance.now() - started).toBeGreaterThanOrEqual(30);
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
    { id: 'call-1', name: 'browser.read', arguments: '{"tabId":null}' },
    { id: 'call-2', name: 'browser.find', arguments: '{"text":"安全"}' },
  ];
  const TOOLS: ProviderTool[] = [
    {
      type: 'function',
      function: {
        name: 'browser.read',
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
    const started = performance.now();
    await collect(provider, TOOL_REQUEST);
    expect(performance.now() - started).toBeGreaterThanOrEqual(20);
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
