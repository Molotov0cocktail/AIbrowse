import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { createProductionResearchRuntimeFactory } from './research-runtime-factory';
import { ResearchRuntime } from './research-runtime';
import { ResearchWorkspace } from './research-workspace';
import { ConfigStore } from '../ai/config-store';
import type { SecureCredentialStore } from '../ai/credential-store';
import { registerProviderFactory } from '../ai/provider/llm-provider';
import { FakeProvider } from '../ai/provider/fake-provider';
import { openDb, closeDb } from '../sources/db/sqlite-driver';
import { runResearchMigrations } from './db/research-migrations';
import type { CleanupAllResult } from './research-workspace';

const root = mkdtempSync(join(tmpdir(), 'factory-maintenance-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
registerProviderFactory({ kind: 'fake-maintenance', create: () => new FakeProvider({}) });
const credentials: SecureCredentialStore = {
  isAvailable: () => true,
  has: async () => true,
  get: async () => null,
  set: async () => false,
  delete: async () => false,
};
async function prepared() {
  const db = openDb(join(root, `${crypto.randomUUID()}.db`));
  runResearchMigrations(db);
  const configStore = new ConfigStore(root, credentials);
  configStore.set({
    providerId: 'fake-maintenance',
    model: 'synthetic',
    baseUrl: 'https://example.com',
  });
  const factory = createProductionResearchRuntimeFactory({
    db,
    credentials,
    configStore,
    browser: {
      createTab: async () => {
        throw new Error('不创建标签页');
      },
      closeTab: async () => true,
      getTabs: async () => [],
      getActiveTab: async () => null,
      getPageSnapshot: async () => null,
      activateTab: async () => false,
    },
    sourceService: {
      getState: () => ({ mode: 'normal' }),
      search: async () => ({ ok: true, query: '', results: [] }),
      list: async () => ({ ok: true, page: 0, pageSize: 20, total: 0, items: [] }),
      listGroups: async () => ({ ok: true, page: 0, pageSize: 20, total: 0, groups: [] }),
      get: async () => ({ ok: false, errorCode: 'source-not-found' }),
    },
    searchProvider: { id: 'synthetic', search: async () => ({ ok: true, results: [] }) },
  });
  const result = await factory.resolveProvider();
  if (!result.ok) throw new Error('夹具失败');
  return { db, launch: result.prepared.launch };
}

it('生产done和onSettle都在workspace真实cleanup完成之后', async () => {
  vi.spyOn(ResearchRuntime.prototype, 'run').mockResolvedValue();
  let resolve!: (value: CleanupAllResult) => void;
  const pending = new Promise<CleanupAllResult>((yes) => {
    resolve = yes;
  });
  const cleanup = vi.spyOn(ResearchWorkspace.prototype, 'cleanupAll').mockReturnValue(pending);
  const { db, launch } = await prepared();
  const settled = vi.fn();
  const handle = launch({
    taskId: crypto.randomUUID(),
    goal: '合成目标',
    runToken: 'run',
    onProgress() {},
    onSettle: settled,
  });
  let done = false;
  const completion = handle.done.then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(done).toBe(false);
  expect(settled).not.toHaveBeenCalled();
  resolve({ ok: true, closedCount: 0, skippedCount: 0 });
  await completion;
  expect(settled).toHaveBeenCalledOnce();
  closeDb(db);
});

it('workspace清理失败拒绝done，保留同一owner清理端口且不发布settle', async () => {
  vi.spyOn(ResearchRuntime.prototype, 'run').mockResolvedValue();
  const cleanup = vi
    .spyOn(ResearchWorkspace.prototype, 'cleanupAll')
    .mockResolvedValueOnce({
      ok: false,
      errorCode: 'cleanup-failed',
      reason: '合成关闭失败',
      closedCount: 0,
    })
    .mockResolvedValue({ ok: true, closedCount: 1, skippedCount: 0 });
  const { db, launch } = await prepared();
  const settled = vi.fn();
  const handle = launch({
    taskId: crypto.randomUUID(),
    goal: '合成目标',
    runToken: 'run',
    onProgress() {},
    onSettle: settled,
  });
  await expect(handle.done).rejects.toThrow('研究任务标签页清理失败');
  expect(settled).not.toHaveBeenCalled();
  expect(handle.cleanup).toBeTypeOf('function');
  await handle.cleanup?.();
  expect(cleanup.mock.contexts[0]).toBe(cleanup.mock.contexts[1]);
  closeDb(db);
});
