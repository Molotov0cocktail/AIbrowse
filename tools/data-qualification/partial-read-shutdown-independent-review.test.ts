import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ConversationServiceImpl,
  type SnapshotSource,
} from '../../src/main/ai/conversation-service';
import { ConversationStore } from '../../src/main/ai/conversation-store';
import { ConfigStore } from '../../src/main/ai/config-store';
import type { SecureCredentialStore } from '../../src/main/ai/credential-store';
import type { ProviderEvent, TurnDoneEvent } from '../../src/shared/types/conversation';
import { FakeProvider, FAKE_PROVIDER_METADATA } from '../../src/main/ai/provider/fake-provider';
import { registerProviderFactory, type LLMProvider } from '../../src/main/ai/provider/llm-provider';
import { ConfirmManager } from '../../src/main/ai/confirm-manager';
import type { BrowserController } from '../../src/main/browser/browser-controller';
import { RuntimeShutdown } from '../../src/main/storage/runtime-shutdown';
import { createPartialRecoveryEntry } from '../../src/main/storage/partial-recovery-entry';

const evidence = join(process.cwd(), 'log/stage7-e2/partial-read-failure-independent-review-001');
mkdirSync(evidence, { recursive: true });
const root = mkdtempSync(join(evidence, 'cases-'));
const brokenId = '11111111-2222-4333-8444-555555555555';
const credentials: SecureCredentialStore = {
  isAvailable: () => true,
  has: async () => false,
  get: async () => null,
  set: async () => false,
  delete: async () => false,
};
registerProviderFactory({ kind: 'partial-independent', create: () => new FakeProvider({}) });
afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(
  options: {
    badIndex?: boolean;
    readThrows?: boolean;
    browser?: SnapshotSource;
    provider?: LLMProvider;
  } = {},
) {
  const dir = mkdtempSync(join(root, 'case-'));
  const store = new ConversationStore(dir);
  expect(
    store.saveSessions([
      { id: brokenId, title: '独立合成会话', createdAt: 1, updatedAt: 1, ephemeral: false },
    ]),
  ).toBe(true);
  const indexPath = join(store.dirPath, 'index.json');
  const badPath = join(store.dirPath, `${brokenId}.json`);
  writeFileSync(badPath, '独立坏成员原件');
  if (options.badIndex) writeFileSync(indexPath, '独立坏索引原件');
  if (options.readThrows)
    vi.spyOn(store, 'loadSessions').mockImplementationOnce(() => {
      throw new Error('独立读取异常');
    });
  const configStore = new ConfigStore(dir, credentials);
  configStore.set({
    providerId: 'partial-independent',
    baseUrl: 'https://example.com',
    model: 'synthetic',
  });
  const terminal = deferred<TurnDoneEvent>();
  const done = vi.fn((event: TurnDoneEvent) => terminal.resolve(event));
  const chunks = vi.fn();
  const browser = options.browser ?? {
    getActiveTab: vi.fn(async () => null),
    getPageSnapshot: vi.fn(async () => null),
  };
  const service = new ConversationServiceImpl({
    store,
    configStore,
    credentials,
    browser,
    resolveProviderFn: async () => options.provider ?? null,
    onTurnDone: done,
    onStreamChunk: chunks,
    agent: {
      browser: {} as BrowserController,
      confirmManager: new ConfirmManager(),
      audit: vi.fn(),
    },
  });
  const close = vi.fn();
  const runtime = new RuntimeShutdown({
    roots: [],
    producers: [service],
    waitForUsage: async () => undefined,
    cleanupWorkspace: async () => ({ ok: true, retainedCount: 0 }),
    closeResources: close,
  });
  return { service, store, close, runtime, badPath, indexPath, terminal, done, chunks };
}

it.each(['getHistory', 'ask', 'agentAsk', 'deleteSession', 'setEphemeral'] as const)(
  '独立反例：%s同步懒读失败未准入工作，维护拒绝但退出成功',
  async (entry) => {
    const f = fixture();
    const index = readFileSync(f.indexPath);
    if (entry === 'ask')
      expect(await f.service.ask({ sessionId: brokenId, question: '合成' })).toMatchObject({
        ok: false,
      });
    else if (entry === 'agentAsk')
      expect(await f.service.agentAsk({ sessionId: brokenId, goal: '合成' })).toMatchObject({
        ok: false,
      });
    else if (entry === 'setEphemeral')
      expect(await f.service.setEphemeral(brokenId, true)).toBe(false);
    else if (entry === 'deleteSession') expect(await f.service.deleteSession(brokenId)).toBe(false);
    else expect(await f.service.getHistory(brokenId)).toBeNull();
    expect(f.service.getPendingOperationCounts()).toEqual({
      ask: 0,
      agentAsk: 0,
      previewContext: 0,
    });
    expect(f.service.pauseForMaintenance(1)).toBe(true);
    const maintenance = f.service.drainForMaintenance(1);
    expect(f.service.drainForMaintenance(1)).toBe(maintenance);
    await expect(maintenance).rejects.toThrow();
    expect(f.service.prepareResumeAfterMaintenance(1)).toBe(false);
    expect(f.service.resumeAfterMaintenance(1)).toBe(false);
    await expect(f.runtime.shutdown()).resolves.toBeUndefined();
    expect(f.close).toHaveBeenCalledOnce();
    expect(readFileSync(f.indexPath)).toEqual(index);
    expect(readFileSync(f.badPath, 'utf8')).toBe('独立坏成员原件');
  },
);

it('独立反例：Store尚报ready的读取异常仍封闭业务且零写退出成功', async () => {
  const f = fixture({ readThrows: true });
  expect(f.store.getStorageStatus().state).toBe('ready');
  expect(f.service.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'io' });
  expect(await f.service.createSession({ ephemeral: true })).toBeNull();
  expect(await f.service.confirmTool('missing', true)).toBe(false);
  expect(f.service.pauseForMaintenance(1)).toBe(true);
  await expect(f.service.drainForMaintenance(1)).rejects.toThrow();
  await expect(f.runtime.shutdown()).resolves.toBeUndefined();
  expect(f.close).toHaveBeenCalledOnce();
});

it.each(['before-prepare', 'after-prepare'] as const)(
  '独立反例：维护已排水%s再发现坏存储，原世代不得重新开放',
  async (timing) => {
    const f = fixture();
    expect(f.service.pauseForMaintenance(1)).toBe(true);
    await f.service.drainForMaintenance(1);
    if (timing === 'after-prepare') expect(f.service.prepareResumeAfterMaintenance(1)).toBe(true);
    expect(() => f.store.loadMessages(brokenId)).toThrow();
    expect(f.service.prepareResumeAfterMaintenance(1)).toBe(false);
    expect(f.service.resumeAfterMaintenance(1)).toBe(false);
    expect(f.service.pauseForMaintenance(2)).toBe(false);
    expect(await f.service.createSession()).toBeNull();
    await expect(f.runtime.shutdown()).resolves.toBeUndefined();
  },
);

it.each(['resolve', 'reject'] as const)(
  '独立控制：坏读取与预览取消并发，原快照%s前不退休，退出重入共享Promise',
  async (settle) => {
    const entered = deferred<AbortSignal>();
    const pending = deferred<null>();
    const f = fixture({
      browser: {
        getActiveTab: async () => ({
          id: 'owned',
          url: 'https://example.com',
          title: '合成',
          active: true,
          state: 'ready',
        }),
        getPageSnapshot: (_id, signal) => {
          if (!signal) throw new Error('夹具无signal');
          entered.resolve(signal);
          return pending.promise;
        },
      },
    });
    const preview = f.service.previewContext();
    const previewResult = preview.then(
      () => 'resolved',
      () => 'rejected',
    );
    const signal = await entered.promise;
    expect(await f.service.getHistory(brokenId)).toBeNull();
    let nested: Promise<void> | null = null;
    signal.addEventListener(
      'abort',
      () => {
        nested = f.service.shutdown();
      },
      { once: true },
    );
    const shutdown = f.service.shutdown();
    expect(nested).toBe(shutdown);
    expect(f.service.drainBeforeClose()).toBe(shutdown);
    const runtime = f.runtime.shutdown();
    await Promise.resolve();
    expect(f.runtime.getPhase()).toBe('draining');
    expect(f.close).not.toHaveBeenCalled();
    expect(f.service.getPendingOperationCounts().previewContext).toBe(1);
    if (settle === 'resolve') pending.resolve(null);
    else pending.reject(new Error('独立原快照拒绝'));
    expect(await previewResult).toBe('rejected');
    await expect(runtime).resolves.toBeUndefined();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.service.getPendingOperationCounts().previewContext).toBe(0);
  },
);

it.each(['ask', 'agentAsk'] as const)(
  '独立反例：%s原stream退休前不因终态错误/重复取消而关闭资源',
  async (kind) => {
    const entered = deferred<AbortSignal>();
    const original = deferred<void>();
    const provider: LLMProvider = {
      metadata: FAKE_PROVIDER_METADATA,
      async *stream(_request, signal): AsyncIterable<ProviderEvent> {
        entered.resolve(signal);
        await original.promise;
        yield { type: 'delta', text: '迟到独立哨兵' };
        yield { type: 'done' };
      },
    };
    const f = fixture({ provider });
    const session = await f.service.createSession();
    if (!session) throw new Error('夹具未建立会话');
    const admission = await f.service[kind]({
      sessionId: session.id,
      question: '合成',
      goal: '合成',
    });
    if (!admission.ok) throw new Error('夹具未准入');
    const signal = await entered.promise;
    const activePath = join(f.store.dirPath, `${session.id}.json`);
    const before = readFileSync(activePath);
    expect(await f.service.getHistory(brokenId)).toBeNull();
    let reentrant: Promise<void> | null = null;
    signal.addEventListener(
      'abort',
      () => {
        reentrant = f.runtime.shutdown();
      },
      { once: true },
    );
    const shutdown = f.runtime.shutdown();
    expect(reentrant).toBe(shutdown);
    expect(f.runtime.shutdown()).toBe(shutdown);
    f.service.abort(admission.requestId);
    await Promise.resolve();
    expect(f.close).not.toHaveBeenCalled();
    expect(f.service.getPendingOperationCounts()[kind]).toBe(1);
    original.resolve();
    await expect(shutdown).rejects.toMatchObject({ stage: 'drain' });
    expect(await f.terminal.promise).toMatchObject({
      status: 'error',
      error: { code: 'internal' },
    });
    expect(f.done).toHaveBeenCalledOnce();
    expect(f.chunks).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    expect(f.service.getPendingOperationCounts()[kind]).toBe(0);
    expect(readFileSync(activePath)).toEqual(before);
    await expect(f.service.shutdown()).rejects.toThrow();
  },
);

it.each(['write', 'retire'] as const)(
  '独立反例：真实文件%s失败遇上随后读取失败，退出仍锁存失败',
  async (operation) => {
    const f = fixture();
    const session = await f.service.createSession();
    if (!session) throw new Error('夹具未建立会话');
    if (operation === 'write') {
      writeFileSync(`${f.indexPath}.tmp`, '独立已有临时件');
      expect(await f.service.createSession()).toBeNull();
    } else {
      const member = join(f.store.dirPath, `${session.id}.json`);
      mkdirSync(member);
      writeFileSync(join(member, 'sentinel'), '独立退休失败原件');
      expect(await f.service.deleteSession(session.id)).toBe(false);
      expect(readFileSync(join(member, 'sentinel'), 'utf8')).toBe('独立退休失败原件');
    }
    expect(() => f.store.loadMessages(brokenId)).toThrow();
    await expect(f.runtime.shutdown()).rejects.toMatchObject({ stage: 'drain' });
    expect(f.runtime.getPhase()).toBe('failed');
    expect(f.close).not.toHaveBeenCalled();
    await expect(f.service.shutdown()).rejects.toThrow();
  },
);

it('独立接线：partial取消零副作用，重新批准后原入口先结算再共同排水', async () => {
  const f = fixture({ badIndex: true });
  const gate = vi.fn(async () => undefined);
  const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const scheduled = deferred<void>();
  let shutdown: Promise<void> | null = null;
  const requestRelaunch = vi.fn(async () => {
    setImmediate(() => {
      shutdown = runtime.shutdown();
      scheduled.resolve();
    });
    return true;
  });
  const partial = createPartialRecoveryEntry({
    assertPartialGraph: () => expect(f.service.getStorageStatus().state).toBe('recovery-required'),
    confirmRestart: confirm,
    ensureRecoveryGate: gate,
    requestRelaunch,
  });
  const runtime = new RuntimeShutdown({
    roots: [],
    producers: [partial, f.service],
    waitForUsage: async () => undefined,
    cleanupWorkspace: async () => ({ ok: true, retainedCount: 0 }),
    closeResources: f.close,
  });
  expect(await partial.start('restore', { isCurrent: () => true })).toMatchObject({
    state: 'cancelled',
  });
  expect(gate).not.toHaveBeenCalled();
  expect(requestRelaunch).not.toHaveBeenCalled();
  expect(f.close).not.toHaveBeenCalled();
  expect(await partial.start('restore', { isCurrent: () => true })).toMatchObject({
    state: 'awaiting-restart',
  });
  await scheduled.promise;
  await expect(shutdown).resolves.toBeUndefined();
  expect(runtime.getPhase()).toBe('closed');
  expect(f.close).toHaveBeenCalledOnce();
  expect(gate).toHaveBeenCalledOnce();
  expect(readFileSync(f.indexPath, 'utf8')).toBe('独立坏索引原件');
});

it('独立控制：读取失败允许会话排水，原资源关闭失败仍不得报成功退出', async () => {
  const f = fixture({ badIndex: true });
  const close = vi.fn(() => {
    throw new Error('独立句柄退休失败');
  });
  const runtime = new RuntimeShutdown({
    roots: [],
    producers: [f.service],
    waitForUsage: async () => undefined,
    cleanupWorkspace: async () => ({ ok: true, retainedCount: 0 }),
    closeResources: close,
  });
  const pending = runtime.shutdown();
  await expect(pending).rejects.toMatchObject({ stage: 'close' });
  expect(runtime.shutdown()).toBe(pending);
  expect(runtime.getPhase()).toBe('failed');
  expect(close).toHaveBeenCalledOnce();
});
