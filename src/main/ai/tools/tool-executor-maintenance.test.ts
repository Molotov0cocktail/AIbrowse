import { afterEach, expect, it, vi } from 'vitest';
import { ToolExecutor } from './tool-executor';
import { ConfirmManager } from '../confirm-manager';
import { registerTool, resetToolRegistry } from './tool-registry';
import type { BrowserController } from '../../browser/browser-controller';
import type { TabInfo } from '../../../shared/types/browser';
import type { ConfirmSummaryHookResult } from './tool-types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
afterEach(() => resetToolRegistry());

it.each(['hook', 'browser'] as const)(
  '取消期间%s摘要迟到时不建立新L2，且原执行返回唯一拒绝审计',
  async (kind) => {
    const gate = deferred<ConfirmSummaryHookResult>();
    const tabGate = deferred<TabInfo | null>();
    const entered = deferred<void>();
    const run = vi.fn(async ({ id }: { id: string }) => ({
      toolCallId: id,
      ok: true as const,
      content: '不应执行',
    }));
    registerTool({
      name: 'source_apply_changes',
      description: '合成变更',
      baseRisk: 2,
      parameters: { properties: {}, required: [] },
      executor: run,
      ...(kind === 'hook'
        ? {
            confirmSummary: () => {
              entered.resolve();
              return gate.promise;
            },
          }
        : {}),
    });
    const manager = new ConfirmManager();
    const pending = vi.fn();
    manager.addPendingChangeListener(pending);
    const controller = new AbortController();
    const audit = vi.fn();
    const executor = new ToolExecutor(manager, audit);
    const operation = executor.execute(
      { id: 'call', name: 'source_apply_changes', arguments: '{}' },
      {
        runId: 'run',
        browser: {
          getActiveTab: () => {
            entered.resolve();
            return tabGate.promise;
          },
          getTabs: async () => [],
        } as unknown as BrowserController,
      },
      controller.signal,
    );
    await entered.promise;
    controller.abort();
    manager.cancelAll('run');
    gate.resolve({ ok: true, summary: { detail: '迟到确认摘要' } });
    tabGate.resolve(null);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    try {
      expect(pending).not.toHaveBeenCalled();
    } finally {
      manager.cancelAll('run');
    }
    expect(await operation).toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledOnce();
  },
);
