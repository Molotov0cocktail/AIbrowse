import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentLoop } from './agent-loop';
import { ConfirmManager } from '../confirm-manager';
import { FAKE_PROVIDER_METADATA } from '../provider/fake-provider';
import type { LLMProvider } from '../provider/llm-provider';
import type { ProviderEvent } from '../../../shared/types/conversation';
import type { BrowserController } from '../../browser/browser-controller';
import { registerTool, resetToolRegistry } from '../tools/tool-registry';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function loop(resolve: () => Promise<LLMProvider | null>, audit = vi.fn()) {
  return new AgentLoop({
    requestId: 'run',
    model: 'synthetic',
    goalMessage: { role: 'user', content: '合成目标' },
    replayMessages: [],
    tools: [],
    providerResolver: resolve,
    confirmManager: new ConfirmManager(),
    browser: {} as BrowserController,
    audit,
  });
}
async function verifyPendingDrain(agent: AgentLoop, release: () => void) {
  let drained = false;
  const drain = agent.waitForIdle().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  release();
  await drain;
  expect(drained).toBe(true);
}
afterEach(() => resetToolRegistry());

describe('Agent 原始操作排水独立于交互终态', () => {
  it('取消立即返回，但维护等待原始providerResolver', async () => {
    const provider = deferred<LLMProvider | null>();
    const agent = loop(() => provider.promise);
    const controller = new AbortController();
    const running = agent.run(controller.signal);
    controller.abort();
    expect((await running).status).toBe('cancelled');
    await verifyPendingDrain(agent, () => provider.resolve(null));
  });

  it('取消立即返回，但维护等待不响应abort的原始stream及iterator清理', async () => {
    const entered = deferred<void>();
    const body = deferred<void>();
    const cleanup = deferred<void>();
    const cleaning = deferred<void>();
    const provider: LLMProvider = {
      metadata: FAKE_PROVIDER_METADATA,
      async *stream(): AsyncIterable<ProviderEvent> {
        entered.resolve();
        try {
          await body.promise;
          yield { type: 'delta', text: '迟到文本' };
        } finally {
          cleaning.resolve();
          await cleanup.promise;
        }
      },
    };
    const agent = loop(async () => provider);
    const controller = new AbortController();
    const running = agent.run(controller.signal);
    await entered.promise;
    controller.abort();
    expect((await running).status).toBe('cancelled');
    body.resolve();
    await cleaning.promise;
    await verifyPendingDrain(agent, () => cleanup.resolve());
  });

  it('取消立即返回，但维护等待ToolExecutor真正结束及唯一审计', async () => {
    const audit = vi.fn();
    const entered = deferred<void>();
    const execution = deferred<void>();
    registerTool({
      name: 'browser_get_tabs',
      description: '合成工具',
      baseRisk: 0,
      parameters: { properties: {}, required: [] },
      executor: async ({ id }) => {
        entered.resolve();
        await execution.promise;
        return { toolCallId: id, ok: true, content: '合成结果' };
      },
    });
    const provider: LLMProvider = {
      metadata: FAKE_PROVIDER_METADATA,
      async *stream(): AsyncIterable<ProviderEvent> {
        yield {
          type: 'toolCalls',
          toolCalls: [{ id: 'call', name: 'browser_get_tabs', arguments: '{}' }],
        };
        yield { type: 'done' };
      },
    };
    const agent = loop(async () => provider, audit);
    const controller = new AbortController();
    const running = agent.run(controller.signal);
    await entered.promise;
    controller.abort();
    expect((await running).status).toBe('cancelled');
    expect(audit).not.toHaveBeenCalled();
    await verifyPendingDrain(agent, () => execution.resolve());
    expect(audit).toHaveBeenCalledOnce();
  });
});
