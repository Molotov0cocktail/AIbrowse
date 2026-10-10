import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { ConversationServiceImpl } from './conversation-service';
import { ConversationStore } from './conversation-store';
import { ConfigStore } from './config-store';
import type { SecureCredentialStore } from './credential-store';
import type { TurnDoneEvent, ProviderEvent } from '../../shared/types/conversation';
import type { TabInfo } from '../../shared/types/browser';
import { FakeProvider, FAKE_PROVIDER_METADATA } from './provider/fake-provider';
import { registerProviderFactory, type LLMProvider } from './provider/llm-provider';
import { ConfirmManager } from './confirm-manager';
import type { BrowserController } from '../browser/browser-controller';
import { LIMITS } from './conversation-transfer';

const root = mkdtempSync(join(tmpdir(), 'conversation-maintenance-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const credentials: SecureCredentialStore = {
  isAvailable: () => true,
  set: async () => false,
  get: async () => null,
  has: async () => false,
  delete: async () => false,
};
registerProviderFactory({ kind: 'fake-maintenance', create: () => new FakeProvider({}) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup(resolveProviderFn: () => Promise<LLMProvider | null>) {
  const dir = join(root, crypto.randomUUID());
  const store = new ConversationStore(dir);
  const configStore = new ConfigStore(dir, credentials);
  configStore.set({
    providerId: 'fake-maintenance',
    baseUrl: 'https://example.com',
    model: 'synthetic',
  });
  const terminal = deferred<TurnDoneEvent>();
  const chunks = vi.fn();
  const service = new ConversationServiceImpl({
    store,
    configStore,
    credentials,
    browser: { getActiveTab: async () => null, getPageSnapshot: async () => null },
    resolveProviderFn,
    onTurnDone: terminal.resolve,
    onStreamChunk: chunks,
    agent: {
      browser: {} as BrowserController,
      confirmManager: new ConfirmManager(),
      audit: vi.fn(),
    },
  });
  return { service, terminal, chunks, store };
}

it.each(['ask', 'agentAsk', 'previewContext'] as const)(
  '只读诊断按固定类别跟踪%s原Promise，取消或修改返回投影不能清除所有权',
  async (kind) => {
    const pending = deferred<TabInfo | null>();
    const entered = deferred<void>();
    const dir = join(root, crypto.randomUUID());
    const service = new ConversationServiceImpl({
      store: new ConversationStore(dir),
      configStore: new ConfigStore(dir, credentials),
      credentials,
      browser: {
        getActiveTab: () => {
          entered.resolve();
          return pending.promise;
        },
        getPageSnapshot: async () => null,
      },
    });
    const session = await service.createSession();
    if (!session) throw new Error('夹具失败');
    const operation =
      kind === 'previewContext'
        ? service.previewContext()
        : service[kind]({ sessionId: session.id, question: '合成', goal: '合成' });
    const settlement = operation.then(
      () => undefined,
      () => undefined,
    );
    await entered.promise;
    const expected = { ask: 0, agentAsk: 0, previewContext: 0, [kind]: 1 };
    expect(service.getPendingOperationCounts()).toEqual(expected);
    const projection = service.getPendingOperationCounts();
    projection[kind] = 0;
    const shutdown = service.shutdown();
    expect(service.getPendingOperationCounts()).toEqual(expected);
    pending.resolve(null);
    await settlement;
    await shutdown;
    expect(service.getPendingOperationCounts()).toEqual({ ask: 0, agentAsk: 0, previewContext: 0 });
  },
);

it.each(['chat', 'agent'] as const)(
  '首条持久化失败阻断%s的Provider并返回一次受控错误',
  async (kind) => {
    const resolve = vi.fn(async () => new FakeProvider({}));
    const { service, store, terminal } = setup(resolve);
    const session = await service.createSession();
    if (!session) throw new Error('夹具失败');
    vi.spyOn(store, 'saveMessages').mockReturnValue(false);
    const result =
      kind === 'chat'
        ? await service.ask({ sessionId: session.id, question: '问题' })
        : await service.agentAsk({ sessionId: session.id, goal: '目标' });
    expect(result.ok).toBe(true);
    expect(await terminal.promise).toMatchObject({ status: 'error', error: { code: 'internal' } });
    expect(resolve).not.toHaveBeenCalled();
    expect(service.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'io' });
  },
);

it.each(['chat', 'agent'] as const)('超预算%s终态明确未保存，原user提交保留', async (kind) => {
  const provider: LLMProvider = {
    metadata: FAKE_PROVIDER_METADATA,
    async *stream(): AsyncGenerator<ProviderEvent> {
      yield { type: 'delta', text: 'x'.repeat(LIMITS.messageBytes) };
      yield { type: 'done' };
    },
  };
  const { service, store, terminal } = setup(async () => provider);
  const session = await service.createSession();
  if (!session) throw new Error('夹具失败');
  if (kind === 'chat') await service.ask({ sessionId: session.id, question: '问题' });
  else await service.agentAsk({ sessionId: session.id, goal: '目标' });
  const done = await terminal.promise;
  expect(done).toMatchObject({
    status: 'error',
    message: { status: 'error', errorCode: 'internal' },
    error: { code: 'internal' },
  });
  expect(done.error?.message).toContain('保存');
  expect(store.loadMessages(session.id)).toHaveLength(1);
  expect(service.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'budget' });
});
it('维护等待已准入的原始快照和终态落盘，期间全部新入口拒绝', async () => {
  let resolve!: (value: TabInfo | null) => void;
  const pending = new Promise<TabInfo | null>((yes) => {
    resolve = yes;
  });
  const turns: TurnDoneEvent[] = [];
  const browser = { getActiveTab: vi.fn(() => pending), getPageSnapshot: vi.fn(async () => null) };
  const store = new ConversationStore(root);
  const service = new ConversationServiceImpl({
    browser,
    store,
    configStore: new ConfigStore(root, credentials),
    credentials,
    onTurnDone: (e) => turns.push(e),
  });
  const session = await service.createSession();
  if (session === null) throw new Error('夹具失败');
  await service.ask({ sessionId: session.id, question: '合成问题' });
  expect(service.pauseForMaintenance(1)).toBe(true);
  let drained = false;
  const drain = service.drainForMaintenance(1).then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(service.resumeAfterMaintenance(1)).toBe(false);
  expect(await service.createSession()).toBeNull();
  expect(await service.listSessions()).toEqual([]);
  expect(await service.getHistory(session.id)).toBeNull();
  expect(await service.deleteSession(session.id)).toBe(false);
  expect(await service.setEphemeral(session.id, true)).toBe(false);
  expect(await service.confirmTool('pending', true)).toBe(false);
  expect(await service.ask({ sessionId: session.id, question: '迟到' })).toMatchObject({
    ok: false,
    error: { code: 'busy' },
  });
  resolve(null);
  await drain;
  expect(turns).toHaveLength(1);
  expect(turns[0]?.status).toBe('aborted');
  expect(store.loadMessages(session.id)).toHaveLength(2);
  expect(service.resumeAfterMaintenance(2)).toBe(false);
  expect(service.resumeAfterMaintenance(1)).toBe(false);
  expect(service.prepareResumeAfterMaintenance(1)).toBe(true);
  expect(service.resumeAfterMaintenance(1)).toBe(true);
  expect(await service.getHistory(session.id)).toHaveLength(2);
  expect(service.pauseForMaintenance(1)).toBe(false);
  await service.shutdown();
});

it.each(['ask', 'agentAsk'] as const)(
  '%s的迟到Provider解析必须真实结束，且取消后零stream',
  async (mode) => {
    const pending = deferred<LLMProvider | null>();
    const entered = deferred<void>();
    const { service, terminal } = setup(() => {
      entered.resolve();
      return pending.promise;
    });
    const session = await service.createSession();
    if (session === null) throw new Error('夹具失败');
    await service[mode]({ sessionId: session.id, question: '合成问题', goal: '合成问题' });
    await entered.promise;
    service.pauseForMaintenance(1);
    let done = false;
    const drain = service.drainForMaintenance(1).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    const provider = new FakeProvider({});
    const stream = vi.spyOn(provider, 'stream');
    pending.resolve(provider);
    await drain;
    expect(stream).not.toHaveBeenCalled();
    expect(await terminal.promise).toMatchObject({ status: 'aborted', error: { code: 'aborted' } });
    await service.shutdown();
  },
);

it('Agent交互终态之后维护仍等待原始stream，旧delta不发布', async () => {
  const entered = deferred<void>();
  const pending = deferred<void>();
  const provider: LLMProvider = {
    metadata: FAKE_PROVIDER_METADATA,
    async *stream(): AsyncIterable<ProviderEvent> {
      entered.resolve();
      await pending.promise;
      yield { type: 'delta', text: '迟到内容' };
    },
  };
  const { service, terminal, chunks } = setup(async () => provider);
  const session = await service.createSession();
  if (session === null) throw new Error('夹具失败');
  await service.agentAsk({ sessionId: session.id, goal: '合成目标' });
  await entered.promise;
  service.pauseForMaintenance(1);
  let done = false;
  const drain = service.drainForMaintenance(1).then(() => {
    done = true;
  });
  expect((await terminal.promise).status).toBe('aborted');
  expect(done).toBe(false);
  expect(service.getPendingOperationCounts()).toEqual({ ask: 0, agentAsk: 1, previewContext: 0 });
  pending.resolve();
  await drain;
  expect(service.getPendingOperationCounts()).toEqual({ ask: 0, agentAsk: 0, previewContext: 0 });
  expect(chunks).not.toHaveBeenCalled();
  await service.shutdown();
});

it('终态落盘失败保持维护关闭，不把业务Promise结束视为快照成功', async () => {
  const { service, store, terminal } = setup(async () => null);
  const session = await service.createSession();
  if (session === null) throw new Error('夹具失败');
  vi.spyOn(store, 'saveMessages').mockReturnValue(false);
  await service.ask({ sessionId: session.id, question: '合成问题' });
  await terminal.promise;
  service.pauseForMaintenance(1);
  await expect(service.drainForMaintenance(1)).rejects.toThrow('会话排水失败');
  expect(service.resumeAfterMaintenance(1)).toBe(false);
  await expect(service.shutdown()).rejects.toThrow();
});

it.each([
  'create',
  'delete-index',
  'save-mode-messages',
  'save-mode-index',
  'ephemeral-index',
] as const)('%s持久化失败拒绝原操作及维护恢复', async (kind) => {
  const { service, store } = setup(async () => null);
  const session = await service.createSession({ ephemeral: kind.startsWith('save-mode') });
  if (session === null) throw new Error('夹具失败');
  if (kind === 'save-mode-messages') vi.spyOn(store, 'saveMessages').mockReturnValue(false);
  else vi.spyOn(store, 'saveSessions').mockReturnValue(false);
  if (kind === 'create') expect(await service.createSession()).toBeNull();
  else if (kind === 'delete-index') expect(await service.deleteSession(session.id)).toBe(false);
  else expect(await service.setEphemeral(session.id, kind === 'ephemeral-index')).toBe(false);
  expect(await service.createSession()).toBeNull();
  expect(service.pauseForMaintenance(1)).toBe(true);
  await expect(service.drainForMaintenance(1)).rejects.toThrow();
  expect(service.prepareResumeAfterMaintenance(1)).toBe(false);
  expect(service.resumeAfterMaintenance(1)).toBe(false);
  await expect(service.shutdown()).rejects.toThrow();
});

it.each(['delete', 'ephemeral'] as const)(
  '真实文件删除失败：%s不报成功，保留失败原件并拒绝维护',
  async (kind) => {
    const { service, store } = setup(async () => null);
    const session = await service.createSession();
    if (session === null) throw new Error('夹具失败');
    const blockedPath = join(store.dirPath, `${session.id}.json`);
    mkdirSync(blockedPath);
    const marker = join(blockedPath, 'synthetic-marker');
    writeFileSync(marker, '保留原件');
    const result =
      kind === 'delete'
        ? await service.deleteSession(session.id)
        : await service.setEphemeral(session.id, true);
    expect(result).toBe(false);
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('保留原件');
    service.pauseForMaintenance(1);
    await expect(service.drainForMaintenance(1)).rejects.toThrow();
    expect(service.prepareResumeAfterMaintenance(1)).toBe(false);
    await expect(service.shutdown()).rejects.toThrow();
  },
);

it('prepare只作恢复预检，shutdown后同世代许可也不能恢复', async () => {
  const { service } = setup(async () => null);
  service.pauseForMaintenance(1);
  await service.drainForMaintenance(1);
  expect(service.resumeAfterMaintenance(1)).toBe(false);
  expect(service.prepareResumeAfterMaintenance(2)).toBe(false);
  expect(service.prepareResumeAfterMaintenance(1)).toBe(true);
  expect(await service.createSession()).toBeNull();
  await service.shutdown();
  expect(service.resumeAfterMaintenance(1)).toBe(false);
  expect(service.prepareResumeAfterMaintenance(1)).toBe(false);
});
