import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import { expect, it, vi } from 'vitest';
import { ConversationServiceImpl } from '../../src/main/ai/conversation-service';
import { ConversationStore } from '../../src/main/ai/conversation-store';
import { ConfigStore } from '../../src/main/ai/config-store';
import type { SecureCredentialStore } from '../../src/main/ai/credential-store';
import { ConfirmManager } from '../../src/main/ai/confirm-manager';
import { FakeProvider, FAKE_PROVIDER_METADATA } from '../../src/main/ai/provider/fake-provider';
import { registerProviderFactory } from '../../src/main/ai/provider/llm-provider';
import type { LLMProvider } from '../../src/main/ai/provider/llm-provider';
import type { BrowserController } from '../../src/main/browser/browser-controller';
import { PageReader } from '../../src/main/browser/page-reader';
import { MaintenanceAdmission } from '../../src/main/storage/maintenance-admission';
import { RuntimeShutdown } from '../../src/main/storage/runtime-shutdown';
import type { AgentRunDoneEvent } from '../../src/shared/types/agent';
import type { ProviderEvent } from '../../src/shared/types/conversation';
import type { TabInfo } from '../../src/shared/types/browser';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
const credentials: SecureCredentialStore = {
  isAvailable: () => true,
  has: async () => false,
  get: async () => null,
  set: async () => false,
  delete: async () => false,
};
function stores() {
  const root = mkdtempSync(join(tmpdir(), 'shutdown-diagnostic-'));
  return { store: new ConversationStore(root), configStore: new ConfigStore(root, credentials) };
}

it('真实PageReader等待传输原Promise时，preview租约可同时保留main和conversation排水', async () => {
  const leaf = deferred<unknown>();
  const entered = deferred<void>();
  let leafSettled = false;
  void leaf.promise.then(() => (leafSettled = true));
  const webContents = {
    getURL: () => 'https://example.test/',
    getTitle: () => '合成标题',
    isDestroyed: () => false,
    isCrashed: () => false,
    isLoadingMainFrame: () => false,
    executeJavaScriptInIsolatedWorld: () => {
      entered.resolve();
      return leaf.promise;
    },
  } as unknown as WebContents;
  const reader = new PageReader();
  const service = new ConversationServiceImpl({
    ...stores(),
    credentials,
    browser: {
      getActiveTab: async () => ({ id: 'tab' }) as TabInfo,
      getPageSnapshot: async () => (await reader.snapshot(webContents, 1)).snapshot,
    },
  });
  const admission = new MaintenanceAdmission();
  const release = admission.enter();
  if (release === null) throw new Error('夹具未准入');
  const preview = service.previewContext();
  void preview.then(release, release);
  await entered.promise;
  const close = vi.fn();
  const shutdown = new RuntimeShutdown({
    roots: [admission],
    producers: [service],
    waitForUsage: async () => {},
    cleanupWorkspace: async () => ({ ok: true, retainedCount: 0 }),
    closeResources: close,
  });
  const drained = shutdown.shutdown();
  await flush();
  expect(shutdown.getPending()).toEqual({ roots: [0], producers: [0] });
  expect(service.getPendingOperationCounts()).toEqual({ ask: 0, agentAsk: 0, previewContext: 1 });
  expect(leafSettled).toBe(false);
  expect(close).not.toHaveBeenCalled();
  leaf.resolve(null);
  await expect(preview).rejects.toThrow();
  await drained;
  expect(leafSettled).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
  expect(service.getPendingOperationCounts()).toEqual({ ask: 0, agentAsk: 0, previewContext: 0 });
});

it('Agent终态且abort已找不到inFlight时，原Provider尾部仍可阻止conversation排水', async () => {
  registerProviderFactory({ kind: 'shutdown-diagnostic', create: () => new FakeProvider({}) });
  const entered = deferred<void>();
  const leaf = deferred<void>();
  const terminal = deferred<AgentRunDoneEvent>();
  let finalized = false;
  const provider: LLMProvider = {
    metadata: FAKE_PROVIDER_METADATA,
    async *stream(): AsyncGenerator<ProviderEvent> {
      entered.resolve();
      try {
        await leaf.promise;
        yield { type: 'done' };
      } finally {
        finalized = true;
      }
    },
  };
  const persisted = stores();
  persisted.configStore.set({
    providerId: 'shutdown-diagnostic',
    baseUrl: 'https://example.test',
    model: 'synthetic',
  });
  const browser = { getActiveTab: async () => null, getPageSnapshot: async () => null };
  const service = new ConversationServiceImpl({
    ...persisted,
    credentials,
    browser,
    resolveProviderFn: async () => provider,
    agent: {
      browser: browser as unknown as BrowserController,
      confirmManager: new ConfirmManager(),
      audit() {},
    },
    onAgentRunDone: terminal.resolve,
  });
  const session = await service.createSession();
  if (session === null) throw new Error('夹具会话未创建');
  const result = await service.agentAsk({ sessionId: session.id, goal: '合成问题' });
  if (!result.ok) throw new Error('夹具请求未准入');
  await entered.promise;
  expect(service.abort(result.requestId)).toBe(true);
  await terminal.promise;
  await flush();
  expect(service.abort(result.requestId)).toBe(false);
  expect(service.getPendingOperationCounts()).toEqual({ ask: 0, agentAsk: 1, previewContext: 0 });
  let drained = false;
  const draining = service.drainBeforeClose().then(() => (drained = true));
  await flush();
  expect(finalized).toBe(false);
  expect(drained).toBe(false);
  leaf.resolve();
  await draining;
  expect(finalized).toBe(true);
  expect(service.getPendingOperationCounts()).toEqual({ ask: 0, agentAsk: 0, previewContext: 0 });
});
