import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { ConversationServiceImpl } from './conversation-service';
import { ConversationStore } from './conversation-store';
import { ConfigStore } from './config-store';
import type { SecureCredentialStore } from './credential-store';
import type { ProviderEvent, TurnDoneEvent } from '../../shared/types/conversation';
import { FakeProvider, FAKE_PROVIDER_METADATA } from './provider/fake-provider';
import { registerProviderFactory, type LLMProvider } from './provider/llm-provider';

const root = mkdtempSync(join(tmpdir(), 'conversation-shutdown-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const credentials: SecureCredentialStore = {
  isAvailable: () => true,
  has: async () => true,
  get: async () => null,
  set: async () => false,
  delete: async () => false,
};
registerProviderFactory({ kind: 'fake-shutdown', create: () => new FakeProvider({}) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup(provider: LLMProvider | null) {
  const dir = join(root, crypto.randomUUID());
  const store = new ConversationStore(dir);
  const configStore = new ConfigStore(dir, credentials);
  configStore.set({
    providerId: 'fake-shutdown',
    baseUrl: 'https://example.com',
    model: 'synthetic',
  });
  const terminal = deferred<TurnDoneEvent>();
  const service = new ConversationServiceImpl({
    store,
    configStore,
    credentials,
    resolveProviderFn: async () => provider,
    browser: { getActiveTab: async () => null, getPageSnapshot: async () => null },
    onTurnDone: terminal.resolve,
  });
  return { service, store, terminal };
}

it('begin同步封闭准入但不取消，drain随后取消并等待原始stream和终态写', async () => {
  const entered = deferred<AbortSignal>();
  const work = deferred<void>();
  const provider: LLMProvider = {
    metadata: FAKE_PROVIDER_METADATA,
    async *stream(_request, signal): AsyncIterable<ProviderEvent> {
      entered.resolve(signal);
      await work.promise;
      yield { type: 'done' };
    },
  };
  const { service, store, terminal } = setup(provider);
  const session = await service.createSession();
  if (session === null) throw new Error('夹具失败');
  await service.ask({ sessionId: session.id, question: '合成退出' });
  const signal = await entered.promise;
  let nestedDrain: Promise<void> | undefined;
  signal.addEventListener(
    'abort',
    () => {
      nestedDrain = service.drainBeforeClose();
    },
    { once: true },
  );
  service.beginShutdown();
  service.beginShutdown();
  expect(signal.aborted).toBe(false);
  expect(await service.createSession()).toBeNull();
  expect(await service.ask({ sessionId: session.id, question: '禁止准入' })).toMatchObject({
    ok: false,
  });
  const drain = service.drainBeforeClose();
  expect(nestedDrain).toBe(drain);
  expect(service.drainBeforeClose()).toBe(drain);
  expect(signal.aborted).toBe(true);
  let drained = false;
  void drain.then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  work.resolve();
  await drain;
  expect((await terminal.promise).status).toBe('aborted');
  expect(store.loadMessages(session.id)).toHaveLength(2);
  await service.shutdown();
});

it('持久化失败不能通过drainBeforeClose或shutdown伪称排水完成', async () => {
  const { service, store } = setup(null);
  vi.spyOn(store, 'saveSessions').mockReturnValue(false);
  expect(await service.createSession()).toBeNull();
  await expect(service.drainBeforeClose()).rejects.toThrow();
  await expect(service.shutdown()).rejects.toThrow();
});

it('维护prepared后begin永久拒绝恢复', async () => {
  const { service } = setup(null);
  service.pauseForMaintenance(1);
  await service.drainForMaintenance(1);
  expect(service.prepareResumeAfterMaintenance(1)).toBe(true);
  service.beginShutdown();
  expect(service.prepareResumeAfterMaintenance(1)).toBe(false);
  expect(service.resumeAfterMaintenance(1)).toBe(false);
  expect(service.pauseForMaintenance(2)).toBe(false);
  await service.drainBeforeClose();
  await service.shutdown();
});
