import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { ConfigStore } from '../ai/config-store';
import type { SecureCredentialStore } from '../ai/credential-store';
import { registerProviderFactory } from '../ai/provider/llm-provider';
import { FakeProvider } from '../ai/provider/fake-provider';
import { createProductionResearchRuntimeFactory } from './research-runtime-factory';
import { ResearchServiceImpl } from './research-service';
import { StaleRunError } from './research-runtime-persistence';
import { ResearchRepository } from './repository/research-repository';
import { openDb, closeDb } from '../sources/db/sqlite-driver';
import { runResearchMigrations } from './db/research-migrations';
import type { SourceGroupsResult } from '../../shared/types/sources';

const root = mkdtempSync(join(tmpdir(), 'independent-maintenance-review-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
const credentials: SecureCredentialStore = {
  isAvailable: () => true,
  has: async () => true,
  get: async () => null,
  set: async () => false,
  delete: async () => false,
};

it.each([
  'cancelled',
  'failed',
  'normal-cancel',
  'stale-terminal',
  'stale-running',
  'stale-other-run',
  'stale-missing',
] as const)('真实Research终态持久化与归属复验：%s', async (terminal) => {
  const db = openDb(join(root, `${crypto.randomUUID()}.db`));
  runResearchMigrations(db);
  const dir = join(root, crypto.randomUUID());
  const configStore = new ConfigStore(dir, credentials);
  registerProviderFactory({ kind: 'independent-maintenance', create: () => new FakeProvider({}) });
  configStore.set({
    providerId: 'independent-maintenance',
    model: 'synthetic',
    baseUrl: 'https://example.com',
  });
  let resolveGroups!: (value: SourceGroupsResult) => void;
  const groups = new Promise<SourceGroupsResult>((resolve) => {
    resolveGroups = resolve;
  });
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
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
      listGroups: () => {
        entered();
        return groups;
      },
      get: async () => ({ ok: false, errorCode: 'source-not-found' }),
    },
    searchProvider: { id: 'synthetic', search: async () => ({ ok: true, results: [] }) },
  });
  const service = new ResearchServiceImpl({ db, runtimeFactory: factory });
  try {
    const task = await service.createTask('合成研究');
    if (!task.ok) throw new Error('夹具失败');
    expect((await service.startTask(task.task.id)).ok).toBe(true);
    await entering;
    const repo = new ResearchRepository(db);
    const now = new Date().toISOString();
    if (terminal === 'stale-other-run') {
      repo.setTaskRunning(task.task.id, {
        phase: 'planning',
        startedAt: '2099-01-01T00:00:00.000Z',
        updatedAt: now,
        stats: task.task.stats,
      });
    }
    if (terminal === 'stale-terminal' || terminal === 'stale-other-run') {
      repo.setTaskCancelled(task.task.id, {
        finishedAt: now,
        updatedAt: now,
        stats: task.task.stats,
      });
    }
    if (terminal === 'stale-missing') repo.deleteTask(task.task.id);
    const commit = vi.spyOn(
      ResearchRepository.prototype,
      terminal === 'failed' ? 'setTaskFailed' : 'setTaskCancelled',
    );
    if (terminal === 'cancelled' || terminal === 'failed')
      commit.mockImplementation(() => {
        throw new Error('合成终态磁盘写失败');
      });
    if (terminal === 'stale-running')
      commit.mockImplementation(() => {
        throw new StaleRunError(task.task.id);
      });
    expect(service.pauseForMaintenance(1)).toBe(true);
    const draining = terminal !== 'failed' ? service.drainForMaintenance(1) : null;
    resolveGroups({ ok: true, page: 0, pageSize: 20, total: 0, groups: [] });
    if (terminal === 'failed') await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    const outcome = await (draining ?? service.drainForMaintenance(1)).then(
      () => 'resolved',
      () => 'rejected',
    );
    if (['cancelled', 'failed', 'normal-cancel', 'stale-running'].includes(terminal))
      expect(commit).toHaveBeenCalledOnce();
    const expectedDrained = terminal === 'normal-cancel' || terminal === 'stale-terminal';
    expect(outcome).toBe(expectedDrained ? 'resolved' : 'rejected');
    const status = repo.getTaskById(task.task.id)?.status;
    const expectedStatus =
      terminal === 'stale-missing'
        ? undefined
        : ['normal-cancel', 'stale-terminal', 'stale-other-run'].includes(terminal)
          ? 'cancelled'
          : 'running';
    expect(status).toBe(expectedStatus);
    expect(service.resumeAfterMaintenance(1)).toBe(false);
    expect(service.prepareResumeAfterMaintenance(1)).toBe(expectedDrained);
    expect(service.resumeAfterMaintenance(1)).toBe(expectedDrained);
  } finally {
    await service.shutdown().catch(() => undefined);
    if (db.isOpen) closeDb(db);
  }
});
