import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../src/main/ai/config-store';
import { SecureCredentialStoreImpl } from '../../src/main/ai/credential-store';
import { CredentialTargetGuard } from '../../src/main/ai/credential-target-guard';
import {
  OpenAICompatibleProvider,
  streamSseBody,
} from '../../src/main/ai/provider/openai-compatible';
import type { ProviderEvent } from '../../src/shared/types/conversation';

const roots: string[] = [];
const context = { requestId: 'review-only', providerId: 'openai-compatible', model: 'synthetic' };
const request = { ...context, system: 'synthetic', messages: [] };
const frame = (delta: object, reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason: reason }] })}\r\n\r\n`;
const tool = {
  tool_calls: [{ index: 0, id: 'r1', function: { name: 'browser_read', arguments: '{}' } }],
};

async function collect(source: AsyncIterable<ProviderEvent>) {
  const events: ProviderEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

async function* oneByteAtATime(text: string) {
  for (const byte of Buffer.from(text)) yield Uint8Array.of(byte);
}

async function provider() {
  const root = mkdtempSync(join(tmpdir(), 'aibrowse-provider-independent-'));
  roots.push(root);
  const store = new SecureCredentialStoreImpl(root, {
    isAvailable: () => true,
    encrypt: (text) => Buffer.from(text).toString('base64'),
    decrypt: (text) => Buffer.from(text, 'base64').toString(),
  });
  await store.set(context.providerId, 'synthetic-only');
  const configStore = new ConfigStore(root, store);
  const guard = new CredentialTargetGuard({
    configStore,
    credentials: store,
    confirm: async () => true,
  });
  expect(
    await guard.updateConfig(
      { providerId: context.providerId, model: context.model, baseUrl: 'https://synthetic.test' },
      { isCurrent: () => true },
    ),
  ).toBe(true);
  return new OpenAICompatibleProvider(configStore.get(context.providerId)!, store, {
    connectMs: 15,
    idleMs: 60,
    totalMs: 300,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('独立审查：Provider 分块、终态和生命周期', () => {
  it('逐字节拆分 UTF-8 与 CRLF 后 reasoning、正文和工具仍隔离并完整结束', async () => {
    const events = await collect(
      streamSseBody(
        oneByteAtATime(
          frame({ reasoning_content: '内部思考🧪' }) +
            frame({ content: '可见正文中🧪文' }) +
            frame(tool, 'tool_calls') +
            'data: [DONE]\r\n\r\n',
        ),
        context,
      ),
    );
    expect(events).toEqual([
      { type: 'reasoning', text: '内部思考🧪' },
      { type: 'delta', text: '可见正文中🧪文' },
      { type: 'toolCalls', toolCalls: [{ id: 'r1', name: 'browser_read', arguments: '{}' }] },
      { type: 'done', usage: undefined },
    ]);
  });

  it.each([{}, { reasoning_content: 'private' }, tool, { content: 'partial', ...tool }])(
    '各类同帧非成功收尾均不产出工具或成功终态：%j',
    async (delta) => {
      const events = await collect(streamSseBody(oneByteAtATime(frame(delta, 'length')), context));
      expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
      expect(events.some((event) => event.type === 'done' || event.type === 'toolCalls')).toBe(
        false,
      );
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'provider-error' } });
    },
  );

  it('显式成功终态取消未完响应、释放 reader 和外部监听器，清除全部定时器', async () => {
    const client = await provider();
    vi.useFakeTimers();
    const external = new AbortController();
    const removed = vi.spyOn(external.signal, 'removeEventListener');
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(frame({ content: 'OK' }, 'stop') + 'data: [DONE]\n\n'));
      },
      cancel,
    });
    const transportSignals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init: RequestInit) => {
        transportSignals.push(init.signal!);
        return new Response(body);
      }),
    );
    const events = await collect(client.stream(request, external.signal));
    expect(events.map((event) => event.type)).toEqual(['delta', 'done']);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(transportSignals[0]?.aborted).toBe(true);
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('错误体第 2000 字符之后的上下文标记不参与分类', async () => {
    const client = await provider();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(`${'x'.repeat(2000)}maximum context`, { status: 422 })),
    );
    expect(await collect(client.stream(request, new AbortController().signal))).toMatchObject([
      { type: 'error', error: { code: 'provider-error' } },
    ]);
  });

  it('HTTP 422 每块重置 idle，后续静默触发 timeout 并释放流', async () => {
    const client = await provider();
    vi.useFakeTimers();
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init: RequestInit) => {
        init.signal!.addEventListener(
          'abort',
          () => bodyController?.error(new Error('synthetic abort')),
          { once: true },
        );
        return new Response(body, { status: 422 });
      }),
    );
    const events: ProviderEvent[] = [];
    const pending = (async () => {
      for await (const event of client.stream(request, new AbortController().signal))
        events.push(event);
    })();
    await vi.advanceTimersByTimeAsync(40);
    bodyController?.enqueue(Buffer.from('part'));
    await vi.advanceTimersByTimeAsync(40);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(21);
    await pending;
    expect(events).toMatchObject([{ type: 'error', error: { code: 'timeout' } }]);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
