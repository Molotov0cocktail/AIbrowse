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
const context = { requestId: 'synthetic', providerId: 'openai-compatible', model: 'synthetic' };
const request = { ...context, system: 'synthetic', messages: [] };
const frame = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\r\n\r\n`;
async function collect(events: AsyncIterable<ProviderEvent>) {
  const result: ProviderEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
async function* bytes(chunks: string[]) {
  for (const chunk of chunks) yield Buffer.from(chunk);
}
async function provider() {
  const root = mkdtempSync(join(tmpdir(), 'aibrowse-provider-adversarial-'));
  roots.push(root);
  const credentials = new SecureCredentialStoreImpl(root, {
    isAvailable: () => true,
    encrypt: (text) => Buffer.from(text).toString('base64'),
    decrypt: (text) => Buffer.from(text, 'base64').toString(),
  });
  await credentials.set(context.providerId, 'synthetic-secret');
  const configs = new ConfigStore(root, credentials);
  const guard = new CredentialTargetGuard({
    configStore: configs,
    credentials,
    confirm: async () => true,
  });
  expect(
    await guard.updateConfig(
      { providerId: context.providerId, model: context.model, baseUrl: 'https://synthetic.test' },
      { isCurrent: () => true },
    ),
  ).toBe(true);
  return new OpenAICompatibleProvider(configs.get(context.providerId)!, credentials, {
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

describe('Provider SSE 真实协议反例（零外部请求）', () => {
  it('任意 CRLF 分块边界与完整帧具有相同输出', async () => {
    const text = frame({ content: 'OK' }, 'stop') + 'data: [DONE]\r\n\r\n';
    const expected = await collect(streamSseBody(bytes([text]), context));
    for (let i = 1; i < text.length; i++) {
      expect(
        await collect(streamSseBody(bytes([text.slice(0, i), text.slice(i)]), context)),
      ).toEqual(expected);
    }
    expect(await collect(streamSseBody(bytes([...text]), context))).toEqual(expected);
  });

  it.each(['length', 'content_filter', 'insufficient_system_resource', 'unknown'])(
    '非成功原因 %s 不能变成 done 或工具执行',
    async (reason) => {
      const tool = {
        tool_calls: [{ index: 0, id: 'c1', function: { name: 'browser_read', arguments: '{}' } }],
      };
      const events = await collect(
        streamSseBody(
          bytes([frame(tool), frame({ content: 'partial' }, reason), 'data: [DONE]\r\n\r\n']),
          context,
        ),
      );
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'provider-error' } });
      expect(events.some((event) => event.type === 'done' || event.type === 'toolCalls')).toBe(
        false,
      );
    },
  );

  it('消费者提前结束会取消底层 SSE ReadableStream', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(frame({ content: 'OK' })));
      },
      cancel,
    });
    for await (const event of streamSseBody(body, context)) {
      expect(event.type).toBe('delta');
      break;
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});

describe('Provider HTTP 响应读取与取消预算', () => {
  it.each([true, false])('仅前缀内上下文指征参与分类（前缀内=%s）', async (withinPrefix) => {
    const client = await provider();
    const text = withinPrefix
      ? 'maximum context synthetic-private'
      : `${'x'.repeat(8192)}maximum context synthetic-private`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(text, { status: 400 })),
    );
    const events = await collect(client.stream(request, new AbortController().signal));
    expect(events).toMatchObject([
      { type: 'error', error: { code: withinPrefix ? 'context-too-long' : 'provider-error' } },
    ]);
    expect(JSON.stringify(events)).not.toContain('synthetic-private');
  });

  it('提前停止消费生产适配器会取消响应并移除超时定时器', async () => {
    const client = await provider();
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(frame({ content: 'OK' })));
      },
      cancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body)),
    );
    for await (const event of client.stream(request, new AbortController().signal)) {
      expect(event.type).toBe('delta');
      break;
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([200, 400])('HTTP %s 响应读取中用户取消仍归类 aborted', async (status) => {
    const client = await provider();
    const external = new AbortController();
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init.signal!.addEventListener(
              'abort',
              () => controller.error(new Error('synthetic abort')),
              { once: true },
            );
          },
        });
        return new Response(body, { status });
      }),
    );
    const task = collect(client.stream(request, external.signal));
    await vi.advanceTimersByTimeAsync(1);
    external.abort();
    expect(await task).toMatchObject([{ type: 'error', error: { code: 'aborted' } }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 422, 401, 500])('HTTP %s 错误只读取有界前缀并取消余下响应', async (status) => {
    const client = await provider();
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(Buffer.alloc(1024, 120));
        if (pulls === 100) controller.close();
      },
      cancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status })),
    );
    const events = await collect(client.stream(request, new AbortController().signal));
    expect(events.at(-1)?.type).toBe('error');
    expect(pulls).toBeLessThanOrEqual(status === 400 || status === 422 ? 9 : 1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it.each([200, 400])('HTTP %s 响应头后首块静默触发 idle 而非 total', async (status) => {
    const client = await provider();
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init.signal!.addEventListener(
              'abort',
              () => controller.error(new Error('synthetic abort')),
              { once: true },
            );
          },
        });
        return new Response(body, { status });
      }),
    );
    const events: ProviderEvent[] = [];
    const task = (async () => {
      for await (const event of client.stream(request, new AbortController().signal))
        events.push(event);
    })();
    await vi.advanceTimersByTimeAsync(61);
    expect(events).toMatchObject([{ type: 'error', error: { code: 'timeout' } }]);
    await vi.advanceTimersByTimeAsync(300);
    await task;
  });
});
