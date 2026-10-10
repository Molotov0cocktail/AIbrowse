import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationStore } from '../../src/main/ai/conversation-store';
import { ConversationServiceImpl } from '../../src/main/ai/conversation-service';
import { ConfigStore } from '../../src/main/ai/config-store';
import type { SecureCredentialStore } from '../../src/main/ai/credential-store';
import { FakeProvider } from '../../src/main/ai/provider/fake-provider';
import { registerProviderFactory } from '../../src/main/ai/provider/llm-provider';
import { ConfirmManager } from '../../src/main/ai/confirm-manager';
import type { AgentRunDoneEvent } from '../../src/shared/types/agent';
import type { BrowserController } from '../../src/main/browser/browser-controller';
import { BROWSER_TOOL_DEFINITIONS } from '../../src/main/ai/tools/browser-tools';
import { registerTool, resetToolRegistry } from '../../src/main/ai/tools/tool-registry';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));
afterEach(() => {
  vi.restoreAllMocks();
  resetToolRegistry();
});
const evidence = join(process.cwd(), 'log/stage7-e2/independent-conversation-review-001');
const root = fs.mkdtempSync(join(evidence, 'repair-cases-'));
const id = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
const message = {
  id: 'm',
  role: 'user' as const,
  content: '独立合成正文',
  createdAt: 1,
  status: 'complete' as const,
};
const session = { id, title: '合成', createdAt: 1, updatedAt: 1, ephemeral: false };
function setup() {
  const dir = fs.mkdtempSync(join(root, 'case-'));
  const store = new ConversationStore(dir);
  expect(store.saveSessions([])).toBe(true);
  return { dir, store };
}

it.each(['before-observation', 'after-observation'] as const)(
  'promotion回滚不得删除在%s时出现的异身份替代文件',
  (phase) => {
    const { store } = setup();
    const target = join(store.dirPath, `${id}.json`);
    const displaced = join(store.dirPath, 'owned-displaced.json');
    const index = fs.readFileSync(join(store.dirPath, 'index.json'));
    const rename = fs.renameSync;
    const replace = () => {
      rename(target, displaced);
      fs.writeFileSync(target, '异身份合成哨兵');
    };
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === target) {
        rename(from, to);
        if (phase === 'before-observation') replace();
      } else if (String(to) === join(store.dirPath, 'index.json')) {
        if (phase === 'after-observation') replace();
        throw new Error('合成index发布故障');
      } else rename(from, to);
    });
    expect(store.promoteSession(id, [message], [session])).toBe(false);
    expect(fs.readFileSync(join(store.dirPath, 'index.json'))).toEqual(index);
    expect(store.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'io' });
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('异身份合成哨兵');
  },
);

it('promotion在index UTF8预算拒绝前不得写任何正文或临时成员', () => {
  const { store } = setup();
  const writes = vi.spyOn(fs, 'writeFileSync');
  expect(store.promoteSession(id, [message], [{ ...session, title: '界'.repeat(22000) }])).toBe(
    false,
  );
  expect(writes).not.toHaveBeenCalled();
  expect(fs.readdirSync(store.dirPath)).toEqual(['index.json']);
  expect(store.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'budget' });
});

it('Agent工具完成后保存失败保留真实步数且不执行后续工具', async () => {
  const credentials: SecureCredentialStore = {
    isAvailable: () => true,
    set: async () => false,
    get: async () => null,
    has: async () => false,
    delete: async () => false,
  };
  registerProviderFactory({ kind: 'fake-repair-review', create: () => new FakeProvider({}) });
  for (const def of BROWSER_TOOL_DEFINITIONS) registerTool(def);
  const { store, dir } = setup();
  const configStore = new ConfigStore(dir, credentials);
  configStore.set({
    providerId: 'fake-repair-review',
    baseUrl: 'https://example.com',
    model: 'synthetic',
  });
  const getTabs = vi.fn(async () => []);
  const browser = { getTabs, getActiveTab: async () => null, getPageSnapshot: async () => null };
  const provider = new FakeProvider({
    rounds: [
      [
        {
          kind: 'toolCalls',
          toolCalls: [
            { id: 'first', name: 'browser_get_tabs', arguments: '{}' },
            { id: 'second', name: 'browser_get_tabs', arguments: '{}' },
          ],
        },
      ],
    ],
  });
  let resolve!: (e: AgentRunDoneEvent) => void;
  const done = new Promise<AgentRunDoneEvent>((yes) => {
    resolve = yes;
  });
  const audit = vi.fn();
  const service = new ConversationServiceImpl({
    store,
    configStore,
    credentials,
    browser,
    resolveProviderFn: async () => provider,
    agent: {
      browser: browser as unknown as BrowserController,
      confirmManager: new ConfirmManager(),
      audit,
    },
    onAgentRunDone: resolve,
  });
  const saved = await service.createSession();
  if (!saved) throw new Error('独立夹具失败');
  const original = store.saveMessages.bind(store);
  vi.spyOn(store, 'saveMessages').mockImplementation((sid, messages) =>
    messages.some((m) => m.role === 'tool') ? false : original(sid, messages),
  );
  expect((await service.agentAsk({ sessionId: saved.id, goal: '只读合成工具' })).ok).toBe(true);
  const terminal = await done;
  expect(getTabs).toHaveBeenCalledTimes(1);
  expect(audit).toHaveBeenCalledTimes(1);
  expect(terminal.status).toBe('error');
  expect(terminal.run.stepsUsed).toBe(1);
  expect(terminal.run.maxSteps).toBe(12);
});
