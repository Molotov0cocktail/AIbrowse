import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { ConversationServiceImpl } from './conversation-service';
import { ConversationStore } from './conversation-store';
import { ConfigStore } from './config-store';
import type { SecureCredentialStore } from './credential-store';

const root = mkdtempSync(join(tmpdir(), 'conversation-storage-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const credentials: SecureCredentialStore = {
  isAvailable: () => true,
  set: async () => false,
  get: async () => null,
  has: async () => false,
  delete: async () => false,
};
const id = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
function setup(index: string, message?: string) {
  const dir = join(root, crypto.randomUUID());
  const store = new ConversationStore(dir);
  mkdirSync(store.dirPath, { recursive: true });
  writeFileSync(join(store.dirPath, 'index.json'), index);
  if (message !== undefined) writeFileSync(join(store.dirPath, `${id}.json`), message);
  const browser = {
    getActiveTab: vi.fn(async () => null),
    getPageSnapshot: vi.fn(async () => null),
  };
  const service = new ConversationServiceImpl({
    store,
    browser,
    configStore: new ConfigStore(dir, credentials),
    credentials,
  });
  return { store, browser, service };
}
it('bad index does not throw during construction or admit writes and model work', async () => {
  const { store, browser, service } = setup('private-broken');
  expect(service.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'invalid' });
  expect(await service.createSession()).toBeNull();
  for (const result of [
    await service.ask({ sessionId: id, question: '问题' }),
    await service.agentAsk({ sessionId: id, goal: '目标' }),
  ]) {
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'internal', message: '会话数据无法读取，原文件已保留，请恢复备份' },
    });
  }
  expect(browser.getActiveTab).not.toHaveBeenCalled();
  expect(readFileSync(join(store.dirPath, 'index.json'), 'utf8')).toBe('private-broken');
  expect(service.pauseForMaintenance(1)).toBe(true);
  await expect(service.drainForMaintenance(1)).rejects.toThrow();
  expect(service.prepareResumeAfterMaintenance(1)).toBe(false);
});
it.each(['getHistory', 'ask', 'agentAsk', 'deleteSession', 'setEphemeral'] as const)(
  'bad lazy member is preserved when reached through %s',
  async (method) => {
    const { store, service, browser } = setup(
      JSON.stringify({
        version: 1,
        sessions: [{ id, title: '会话', createdAt: 1, updatedAt: 1, ephemeral: false }],
      }),
      'private-broken',
    );
    expect(service.getStorageStatus()).toEqual({ state: 'ready', code: null });
    if (method === 'ask')
      expect(await service.ask({ sessionId: id, question: '问题' })).toMatchObject({
        ok: false,
        error: { code: 'internal' },
      });
    else if (method === 'agentAsk')
      expect(await service.agentAsk({ sessionId: id, goal: '目标' })).toMatchObject({
        ok: false,
        error: { code: 'internal' },
      });
    else if (method === 'setEphemeral') expect(await service.setEphemeral(id, true)).toBe(false);
    else if (method === 'deleteSession') expect(await service.deleteSession(id)).toBe(false);
    else expect(await service.getHistory(id)).toBeNull();
    expect(service.getStorageStatus()).toEqual({ state: 'recovery-required', code: 'invalid' });
    expect(browser.getActiveTab).not.toHaveBeenCalled();
    expect(store.saveSessions([])).toBe(false);
    expect(readFileSync(join(store.dirPath, `${id}.json`), 'utf8')).toBe('private-broken');
    expect(
      JSON.parse(readFileSync(join(store.dirPath, 'index.json'), 'utf8')).sessions,
    ).toHaveLength(1);
  },
);
