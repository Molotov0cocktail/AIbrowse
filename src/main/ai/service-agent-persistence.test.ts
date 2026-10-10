import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationStore } from './conversation-store';
import { ConversationServiceImpl } from './conversation-service';
import { ConfigStore } from './config-store';
import type { SecureCredentialStore } from './credential-store';
import { FakeProvider } from './provider/fake-provider';
import { registerProviderFactory } from './provider/llm-provider';
import { ConfirmManager } from './confirm-manager';
import type { AgentRunDoneEvent } from '../../shared/types/agent';
import type { BrowserController } from '../browser/browser-controller';
import { BROWSER_TOOL_DEFINITIONS } from './tools/browser-tools';
import { registerTool, resetToolRegistry } from './tools/tool-registry';

const root = mkdtempSync(join(process.cwd(), 'log/stage7-e2/agent-persistence-'));
afterEach(() => {
  vi.restoreAllMocks();
  resetToolRegistry();
});
const credentials: SecureCredentialStore = {
  isAvailable: () => true,
  set: async () => false,
  get: async () => null,
  has: async () => false,
  delete: async () => false,
};

it.each([
  { failure: 'user', expectedSteps: 0, expectedRounds: 0 },
  { failure: 'round', expectedSteps: 0, expectedRounds: 1 },
  { failure: 'first-tool', expectedSteps: 1, expectedRounds: 1 },
  { failure: 'second-tool', expectedSteps: 2, expectedRounds: 1 },
] as const)(
  'Agent $failure 写入失败终态保留事实且阻止后续动作',
  async ({ failure, expectedSteps, expectedRounds }) => {
    registerProviderFactory({ kind: 'fake-persistence', create: () => new FakeProvider({}) });
    for (const def of BROWSER_TOOL_DEFINITIONS) registerTool(def);
    const dir = mkdtempSync(join(root, 'case-'));
    const store = new ConversationStore(dir);
    const configStore = new ConfigStore(dir, credentials);
    configStore.set({
      providerId: 'fake-persistence',
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
              { id: 'third', name: 'browser_get_tabs', arguments: '{}' },
            ],
          },
        ],
      ],
    });
    const audit = vi.fn();
    const resolveProviderFn = vi.fn(async () => provider);
    const terminal = vi.fn();
    const turnDone = vi.fn();
    let complete!: (event: AgentRunDoneEvent) => void;
    const done = new Promise<AgentRunDoneEvent>((resolve) => {
      complete = resolve;
    });
    const service = new ConversationServiceImpl({
      store,
      configStore,
      credentials,
      browser,
      resolveProviderFn,
      agent: {
        browser: browser as unknown as BrowserController,
        confirmManager: new ConfirmManager(),
        audit,
        limits: { maxSteps: 7 },
      },
      onTurnDone: turnDone,
      onAgentRunDone: (event) => {
        terminal(event);
        complete(event);
      },
    });
    const session = await service.createSession();
    if (session === null) throw new Error('合成会话创建失败');
    const save = store.saveMessages.bind(store);
    vi.spyOn(store, 'saveMessages').mockImplementation((id, messages) => {
      const last = messages.at(-1);
      const reject =
        failure === 'user'
          ? last?.role === 'user'
          : failure === 'round'
            ? last?.role === 'assistant' && last.toolCalls !== undefined
            : messages.filter((m) => m.role === 'tool').length >= expectedSteps;
      return reject ? false : save(id, messages);
    });
    expect((await service.agentAsk({ sessionId: session.id, goal: '合成只读目标' })).ok).toBe(true);
    const result = await done;
    expect(result).toMatchObject({
      status: 'error',
      run: {
        status: 'error',
        stepsUsed: expectedSteps,
        maxSteps: 7,
        toolStepCount: expectedSteps,
      },
    });
    expect(getTabs).toHaveBeenCalledTimes(expectedSteps);
    expect(audit).toHaveBeenCalledTimes(expectedSteps);
    expect(provider.getRequests()).toHaveLength(expectedRounds);
    expect(resolveProviderFn).toHaveBeenCalledTimes(failure === 'user' ? 0 : 1);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(turnDone).toHaveBeenCalledTimes(1);
    expect(service.pauseForMaintenance(1)).toBe(true);
    await expect(service.drainForMaintenance(1)).rejects.toThrow('会话排水失败');
    expect(service.prepareResumeAfterMaintenance(1)).toBe(false);
    await expect(service.shutdown()).rejects.toThrow('会话排水失败');
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(getTabs).toHaveBeenCalledTimes(expectedSteps);
  },
);
