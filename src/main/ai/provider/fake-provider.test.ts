// FakeProvider tests: deterministic script (chunks / delays / error injection / abort)
// + getLastRequest capture for smoke assertions.
// Contract source: doc/stage2/detailed-design.md §3.3.
import { describe, expect, it } from 'vitest';
import { FAKE_PROVIDER_METADATA, FakeProvider } from './fake-provider';
import type { ProviderEvent } from '../../../shared/types/conversation';
import type { ProviderRequest } from '../../../shared/types/conversation';

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

  it('metadata：streaming=true / supportsToolCalling=false / id=fake', () => {
    expect(FAKE_PROVIDER_METADATA.id).toBe('fake');
    expect(FAKE_PROVIDER_METADATA.streaming).toBe(true);
    expect(FAKE_PROVIDER_METADATA.supportsToolCalling).toBe(false);
    const provider = new FakeProvider();
    expect(provider.metadata).toEqual(FAKE_PROVIDER_METADATA);
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
