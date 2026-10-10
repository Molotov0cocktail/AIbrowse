import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationStore } from '../../src/main/ai/conversation-store';
import { ConversationServiceImpl } from '../../src/main/ai/conversation-service';
import { ConfigStore } from '../../src/main/ai/config-store';
import type { SecureCredentialStore } from '../../src/main/ai/credential-store';
import { FakeProvider, FAKE_PROVIDER_METADATA } from '../../src/main/ai/provider/fake-provider';
import { registerProviderFactory, type LLMProvider } from '../../src/main/ai/provider/llm-provider';
import type { ProviderEvent, TurnDoneEvent } from '../../src/shared/types/conversation';
import { LIMITS } from '../../src/main/ai/conversation-transfer';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));
afterEach(() => vi.restoreAllMocks());
const evidenceRoot = join(process.cwd(), 'log/stage7-e2/independent-conversation-review-001');
fs.mkdirSync(evidenceRoot, { recursive: true });
const root = fs.mkdtempSync(join(evidenceRoot, 'cases-'));
const id = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
const message = {
  id: 'm',
  role: 'user' as const,
  content: '独立合成正文',
  createdAt: 1,
  status: 'complete' as const,
};
const credentials: SecureCredentialStore = {
  isAvailable: () => true,
  set: async () => false,
  get: async () => null,
  has: async () => false,
  delete: async () => false,
};
registerProviderFactory({ kind: 'fake-conversation-review', create: () => new FakeProvider({}) });
function setup(provider?: LLMProvider) {
  const dir = fs.mkdtempSync(join(root, 'case-'));
  const store = new ConversationStore(dir);
  const configStore = new ConfigStore(dir, credentials);
  configStore.set({
    providerId: 'fake-conversation-review',
    baseUrl: 'https://example.com',
    model: 'synthetic',
  });
  let terminal!: (e: TurnDoneEvent) => void;
  const done = new Promise<TurnDoneEvent>((resolve) => {
    terminal = resolve;
  });
  const service = new ConversationServiceImpl({
    store,
    configStore,
    credentials,
    browser: { getActiveTab: async () => null, getPageSnapshot: async () => null },
    resolveProviderFn: async () => provider ?? null,
    onTurnDone: terminal,
  });
  return { store, service, done };
}

it('独立反例：50 个已保存会话时失败的保存模式切换不能把不保存正文留在磁盘', async () => {
  const { store, service, done } = setup();
  for (let i = 0; i < 50; i++) expect(await service.createSession()).not.toBeNull();
  const ephemeral = await service.createSession({ ephemeral: true });
  expect(ephemeral).not.toBeNull();
  if (!ephemeral) return;
  expect((await service.ask({ sessionId: ephemeral.id, question: '不保存的合成标记' })).ok).toBe(
    true,
  );
  await done;
  expect(fs.existsSync(join(store.dirPath, `${ephemeral.id}.json`))).toBe(false);
  expect(await service.setEphemeral(ephemeral.id, false)).toBe(false);
  expect(ephemeral.ephemeral).toBe(true);
  expect(fs.existsSync(join(store.dirPath, `${ephemeral.id}.json`))).toBe(false);
});

it('独立反例：单消息超预算造成终态持久化拒绝，不能报告 complete 成功', async () => {
  const provider: LLMProvider = {
    metadata: FAKE_PROVIDER_METADATA,
    async *stream(): AsyncGenerator<ProviderEvent> {
      yield { type: 'delta', text: 'x'.repeat(LIMITS.messageBytes) };
      yield { type: 'done' };
    },
  };
  const { store, service, done } = setup(provider);
  const session = await service.createSession();
  expect(session).not.toBeNull();
  if (!session) return;
  expect((await service.ask({ sessionId: session.id, question: '合成问题' })).ok).toBe(true);
  const terminal = await done;
  const disk = store.loadMessages(session.id);
  expect(disk).toHaveLength(1);
  expect(terminal.status).toBe('error');
});

it('缺失初始数据为空且可写；读过坏成员后其他缓存会话仍封闭', async () => {
  const { store, service } = setup();
  expect(store.loadSessions()).toEqual([]);
  const session = await service.createSession();
  expect(session).not.toBeNull();
  if (!session) return;
  fs.writeFileSync(join(store.dirPath, `${id}.json`), '合成坏成员');
  expect(() => store.loadMessages(id)).toThrow();
  expect(store.saveMessages(session.id, [message])).toBe(false);
  expect(store.deleteFiles(id)).toBe(false);
  expect(await service.createSession()).toBeNull();
  expect(await service.setEphemeral(session.id, true)).toBe(false);
  expect(fs.readFileSync(join(store.dirPath, `${id}.json`), 'utf8')).toBe('合成坏成员');
});

it('同一描述符读后增长在返回前被拒绝且描述符关闭', () => {
  const { store } = setup();
  expect(store.saveMessages(id, [message])).toBe(true);
  const realRead = fs.readSync;
  let appended = false;
  vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
    const bytes = realRead(...args);
    if (!appended && bytes > 0) {
      appended = true;
      fs.appendFileSync(join(store.dirPath, `${id}.json`), ' ');
    }
    return bytes;
  });
  const close = vi.spyOn(fs, 'closeSync');
  expect(() => store.loadMessages(id)).toThrow();
  expect(store.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'io' });
  expect(close).toHaveBeenCalled();
});

it('同长度mtime变化和短读分别拒绝，不能接受可能被并发替换的正文', () => {
  for (const mode of ['mtime', 'short'] as const) {
    vi.restoreAllMocks();
    const { store } = setup();
    expect(store.saveMessages(id, [message])).toBe(true);
    if (mode === 'mtime') {
      const original = fs.fstatSync;
      let calls = 0;
      vi.spyOn(fs, 'fstatSync').mockImplementation((fd, options) => {
        const stat = original(fd, options);
        if (++calls === 2)
          stat.mtimeMs = typeof stat.mtimeMs === 'bigint' ? stat.mtimeMs + 1n : stat.mtimeMs + 1;
        return stat;
      });
    } else vi.spyOn(fs, 'readSync').mockReturnValue(0);
    expect(() => store.loadMessages(id)).toThrow();
    expect(store.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'io' });
  }
});

it('已知字段类型错误和转义等价重复键分别阻断全域，不回显正文', () => {
  for (const raw of [
    JSON.stringify({ version: 2, messages: [{ ...message, content: 12 }] }),
    '{"version":2,"messages":[],"\\u006dessages":[]}',
  ]) {
    const { store } = setup();
    fs.mkdirSync(store.dirPath, { recursive: true });
    fs.writeFileSync(join(store.dirPath, `${id}.json`), raw);
    expect(() => store.loadMessages(id)).toThrow('原文件已保留');
    expect(store.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'invalid' });
    expect(store.saveSessions([])).toBe(false);
    expect(store.deleteFiles(id)).toBe(false);
    expect(fs.readFileSync(join(store.dirPath, `${id}.json`), 'utf8')).toBe(raw);
  }
});
