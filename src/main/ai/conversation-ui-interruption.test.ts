import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ConversationServiceImpl } from './conversation-service';
import { ConversationStore } from './conversation-store';
import { ConfigStore } from './config-store';
import type { SecureCredentialStore } from './credential-store';
import type { PageSnapshot, TabInfo } from '../../shared/types/browser';
import { ConfirmManager } from './confirm-manager';
import type { BrowserController } from '../browser/browser-controller';

const root = mkdtempSync(join(tmpdir(), 'conversation-ui-interruption-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const credentials: SecureCredentialStore = {
  isAvailable: () => true,
  has: async () => false,
  get: async () => null,
  set: async () => false,
  delete: async () => false,
};
const tab: TabInfo = {
  id: 'synthetic',
  url: 'https://example.com',
  title: '合成',
  active: true,
  state: 'ready',
};

describe('主界面中断只取消旧请求而不销毁会话服务', () => {
  it('待确认动作同步作废，旧确认不能批准，未结束的生成仍受原会话互斥保护', async () => {
    const directory = join(root, crypto.randomUUID());
    let entered!: () => void;
    const started = new Promise<void>((yes) => (entered = yes));
    let release!: (value: PageSnapshot | null) => void;
    const snapshot = new Promise<PageSnapshot | null>((yes) => (release = yes));
    const browser = {
      getActiveTab: async () => tab,
      getPageSnapshot: async () => {
        entered();
        return snapshot;
      },
    };
    const manager = new ConfirmManager();
    const service = new ConversationServiceImpl({
      store: new ConversationStore(directory),
      credentials,
      configStore: new ConfigStore(directory, credentials),
      browser,
      agent: {
        browser: browser as unknown as BrowserController,
        confirmManager: manager,
        audit: vi.fn(),
      },
    });
    const session = await service.createSession();
    if (!session) throw new Error('合成会话未创建');
    const request = await service.agentAsk({ sessionId: session.id, goal: '合成任务' });
    if (!request.ok) throw new Error('合成任务未接收');
    await started;
    const confirmation = manager.requestConfirm(
      request.requestId,
      'synthetic-call',
      'browser_click',
      { detail: '合成确认' },
    );
    try {
      service.interruptUiRequests();
      expect(manager.getPending()).toBeNull();
      expect(await confirmation).toBe('cancelled');
      expect(await service.confirmTool('synthetic-call', true)).toBe(false);
      expect(await service.agentAsk({ sessionId: session.id, goal: '新任务' })).toMatchObject({
        ok: false,
        error: { code: 'busy' },
      });
      expect(service.getPendingOperationCounts().agentAsk).toBe(1);
    } finally {
      release(null);
      await service.shutdown();
    }
  });

  it.each(['ask', 'agentAsk', 'previewContext'] as const)(
    '%s同步收到取消，原等待结束前仍有所有权，之后服务可继续',
    async (kind) => {
      let entered!: (signal: AbortSignal | undefined) => void;
      const started = new Promise<AbortSignal | undefined>((yes) => (entered = yes));
      let release!: (value: PageSnapshot | null) => void;
      const pending = new Promise<PageSnapshot | null>((yes) => (release = yes));
      const getPageSnapshot = vi.fn((_id: string, signal?: AbortSignal) => {
        entered(signal);
        return pending;
      });
      const directory = join(root, crypto.randomUUID());
      const service = new ConversationServiceImpl({
        store: new ConversationStore(directory),
        credentials,
        configStore: new ConfigStore(directory, credentials),
        browser: { getActiveTab: async () => tab, getPageSnapshot },
      });
      const session = await service.createSession();
      if (!session) throw new Error('合成会话未创建');
      const operation =
        kind === 'previewContext'
          ? service.previewContext().then(
              () => 'delivered',
              () => 'rejected',
            )
          : service[kind]({ sessionId: session.id, question: '合成', goal: '合成' });
      const signal = await started;
      try {
        const interrupt = Reflect.get(service, 'interruptUiRequests') as (() => void) | undefined;
        expect(interrupt).toBeTypeOf('function');
        interrupt!.call(service);
        interrupt!.call(service);
        expect(signal!.aborted).toBe(true);
        expect(service.getPendingOperationCounts()[kind]).toBe(1);
        release(null);
        if (kind === 'previewContext') expect(await operation).toBe('rejected');
        else await operation;
        await vi.waitFor(() => expect(service.getPendingOperationCounts()[kind]).toBe(0));
        expect(await service.createSession()).not.toBeNull();
        expect((await service.listSessions()).some((item) => item.id === session.id)).toBe(true);
        expect(await service.previewContext()).toMatchObject({ tabId: tab.id });
      } finally {
        release(null);
        await operation;
        await service.shutdown();
      }
    },
  );
});
