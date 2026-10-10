import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { ConversationServiceImpl } from './conversation-service';
import { ConversationStore } from './conversation-store';
import { ConfigStore } from './config-store';
import type { SecureCredentialStore } from './credential-store';
import type { TurnDoneEvent } from '../../shared/types/conversation';
import { RuntimeShutdown } from '../storage/runtime-shutdown';
import { createPartialRecoveryEntry } from '../storage/partial-recovery-entry';
import { FakeProvider } from './provider/fake-provider';
import { registerProviderFactory, type LLMProvider } from './provider/llm-provider';
import { ConfirmManager } from './confirm-manager';
import type { BrowserController } from '../browser/browser-controller';

const root = mkdtempSync(join(tmpdir(), 'conversation-read-shutdown-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const id = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
const credentials: SecureCredentialStore = {
  isAvailable: () => true,
  has: async () => false,
  get: async () => null,
  set: async () => false,
  delete: async () => false,
};
registerProviderFactory({ kind: 'fake-read-shutdown', create: () => new FakeProvider({}) });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(badIndex: boolean, resolveProviderFn?: () => Promise<LLMProvider | null>) {
  const dir = join(root, crypto.randomUUID());
  const store = new ConversationStore(dir);
  mkdirSync(store.dirPath, { recursive: true });
  const indexPath = join(store.dirPath, 'index.json');
  const memberPath = join(store.dirPath, `${id}.json`);
  writeFileSync(
    indexPath,
    badIndex
      ? 'synthetic-broken-index'
      : JSON.stringify({
          version: 1,
          sessions: [{ id, title: '合成会话', createdAt: 1, updatedAt: 1, ephemeral: false }],
        }),
  );
  writeFileSync(memberPath, 'synthetic-broken-member');
  const configStore = new ConfigStore(dir, credentials);
  configStore.set({
    providerId: 'fake-read-shutdown',
    baseUrl: 'https://example.com',
    model: 'synthetic',
  });
  const browser = {
    getActiveTab: vi.fn(async () => null),
    getPageSnapshot: vi.fn(async () => null),
  };
  const terminal = deferred<TurnDoneEvent>();
  const service = new ConversationServiceImpl({
    store,
    configStore,
    credentials,
    browser,
    resolveProviderFn,
    onTurnDone: terminal.resolve,
    agent: {
      browser: {} as BrowserController,
      confirmManager: new ConfirmManager(),
      audit: vi.fn(),
    },
  });
  const closeResources = vi.fn();
  const runtime = new RuntimeShutdown({
    roots: [],
    producers: [service],
    waitForUsage: async () => undefined,
    cleanupWorkspace: async () => ({ ok: true, retainedCount: 0 }),
    closeResources,
  });
  return { service, store, browser, terminal, indexPath, memberPath, runtime, closeResources };
}

it('真实坏索引且零业务操作时，统一退出正常关闭并保留原件', async () => {
  const f = fixture(true);
  expect(f.service.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'invalid' });
  expect(f.service.getPendingOperationCounts()).toEqual({ ask: 0, agentAsk: 0, previewContext: 0 });
  const shutdown = f.runtime.shutdown();
  expect(f.runtime.shutdown()).toBe(shutdown);
  await expect(shutdown).resolves.toBeUndefined();
  expect(f.runtime.getPhase()).toBe('closed');
  expect(f.closeResources).toHaveBeenCalledOnce();
  expect(f.browser.getActiveTab).not.toHaveBeenCalled();
  expect(readFileSync(f.indexPath, 'utf8')).toBe('synthetic-broken-index');
});

it('读取失败拒绝业务和维护恢复，失败维护不污染随后退出', async () => {
  const f = fixture(true);
  expect(await f.service.createSession({ ephemeral: true })).toBeNull();
  expect(await f.service.listSessions()).toEqual([]);
  expect(await f.service.getHistory(id)).toBeNull();
  expect(await f.service.deleteSession(id)).toBe(false);
  expect(await f.service.setEphemeral(id, true)).toBe(false);
  await expect(f.service.previewContext()).rejects.toThrow();
  for (const kind of ['ask', 'agentAsk'] as const) {
    expect(await f.service[kind]({ sessionId: id, question: '合成', goal: '合成' })).toMatchObject({
      ok: false,
      error: { code: 'internal' },
    });
  }
  expect(f.service.pauseForMaintenance(1)).toBe(true);
  await expect(f.service.drainForMaintenance(1)).rejects.toThrow();
  expect(f.service.prepareResumeAfterMaintenance(1)).toBe(false);
  expect(f.service.resumeAfterMaintenance(1)).toBe(false);
  await expect(f.runtime.shutdown()).resolves.toBeUndefined();
  expect(f.closeResources).toHaveBeenCalledOnce();
  expect(readFileSync(f.indexPath, 'utf8')).toBe('synthetic-broken-index');
});

it('懒加载只读失败且无在途写入也允许退出，成员原件不变', async () => {
  const f = fixture(false);
  const before = readFileSync(f.indexPath);
  expect(await f.service.getHistory(id)).toBeNull();
  expect(f.service.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'invalid' });
  expect(await f.service.createSession()).toBeNull();
  await expect(f.runtime.shutdown()).resolves.toBeUndefined();
  expect(f.closeResources).toHaveBeenCalledOnce();
  expect(readFileSync(f.indexPath)).toEqual(before);
  expect(readFileSync(f.memberPath, 'utf8')).toBe('synthetic-broken-member');
});

it('partial确认后先建立gate，坏索引实例正常退出后才请求冷重启', async () => {
  const f = fixture(true);
  const order: string[] = [];
  const partial = createPartialRecoveryEntry({
    assertPartialGraph: () => {
      expect(f.service.getStorageStatus().state).toBe('recovery-required');
    },
    confirmRestart: async () => {
      order.push('confirm');
      return true;
    },
    ensureRecoveryGate: async (context) => {
      context.assertCurrent();
      order.push('gate');
    },
    requestRelaunch: async () => {
      await f.runtime.shutdown();
      expect(f.closeResources).toHaveBeenCalledOnce();
      order.push('relaunch');
      return true;
    },
  });
  expect(await partial.start('restore', { isCurrent: () => true })).toMatchObject({
    state: 'awaiting-restart',
  });
  expect(order).toEqual(['confirm', 'gate', 'relaunch']);
  expect(readFileSync(f.indexPath, 'utf8')).toBe('synthetic-broken-index');
  await partial.drainBeforeClose();
});

it.each(['ask', 'agentAsk'] as const)(
  '%s已提交user后另一个会话读取失败，退出仍等待原工作并锁存终态保存失败',
  async (kind) => {
    const entered = deferred<void>();
    const provider = deferred<LLMProvider | null>();
    const f = fixture(false, () => {
      entered.resolve();
      return provider.promise;
    });
    const active = await f.service.createSession();
    if (active === null) throw new Error('夹具失败');
    expect(
      await f.service[kind]({ sessionId: active.id, question: '合成', goal: '合成' }),
    ).toMatchObject({ ok: true });
    await entered.promise;
    const activePath = join(f.store.dirPath, `${active.id}.json`);
    const committed = readFileSync(activePath);
    expect(await f.service.getHistory(id)).toBeNull();
    const shutdown = f.runtime.shutdown();
    await Promise.resolve();
    expect(f.runtime.getPhase()).toBe('draining');
    expect(f.closeResources).not.toHaveBeenCalled();
    expect(f.service.getPendingOperationCounts()[kind]).toBe(1);
    provider.resolve(null);
    await expect(shutdown).rejects.toMatchObject({ stage: 'drain' });
    expect(await f.terminal.promise).toMatchObject({
      status: 'error',
      error: { code: 'internal' },
    });
    expect(f.service.getPendingOperationCounts()[kind]).toBe(0);
    await expect(f.service.shutdown()).rejects.toThrow();
    expect(f.closeResources).not.toHaveBeenCalled();
    expect(readFileSync(activePath)).toEqual(committed);
    expect(readFileSync(f.memberPath, 'utf8')).toBe('synthetic-broken-member');
  },
);
