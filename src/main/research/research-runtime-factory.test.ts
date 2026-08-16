// 决议 #155：生产 ResearchRuntimeFactory 真实依赖接线（红→绿）——
// FakeProvider 通过与生产相同的 factory 代码路径完成真实 C6+C7 端口任务；
// 缺配置/缺 Key/不支持 tools/Sources 缺失或非 normal 的精确错误码
// （任务保持 created）；prepared 恰一次消费；每次 launch 独立
// Workspace/CaptureService/Runtime；可信字段全部程序生成。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigStore } from '../ai/config-store';
import type { SecureCredentialStore } from '../ai/credential-store';
import { FakeProvider, type FakeProviderScript } from '../ai/provider/fake-provider';
import { registerProviderFactory } from '../ai/provider/llm-provider';
import { openDb, closeDb } from '../sources/db/sqlite-driver';
import type { ResearchService, ResearchTask } from '../../shared/types/research';
import { runResearchMigrations } from './db/research-migrations';
import { openResearchStore } from './research-store';
import { createProductionResearchRuntimeFactory } from './research-runtime-factory';
import type { SourceService } from '../../shared/types/sources';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-research-fac-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------- fixtures ----------

const FAKE_KIND = 'fake-research-test';

let currentScript: FakeProviderScript = { rounds: [] };
let hasKeyFlag = true;
let supportsToolCallingFlag = true;

registerProviderFactory({
  kind: FAKE_KIND,
  create: () => {
    const provider = new FakeProvider(currentScript);
    return {
      metadata: supportsToolCallingFlag
        ? provider.metadata
        : { ...provider.metadata, supportsToolCalling: false },
      stream: (req: Parameters<typeof provider.stream>[0], sig: AbortSignal) =>
        provider.stream(req, sig),
    };
  },
});

function makeCredentials(): SecureCredentialStore {
  return {
    isAvailable: () => true,
    set: async () => false,
    get: async () => null,
    has: async (providerId: string) => Promise.resolve(providerId === FAKE_KIND && hasKeyFlag),
    delete: async () => false,
  };
}

// 零候选 Sources 端口（normal 态；search 恒空——合法空候选）
function makeSourceService(mode: 'normal' | 'readonly-recovery' | 'unavailable'): SourceService {
  return {
    search: async () => ({ ok: true, query: '', results: [] }),
    list: async () => ({ ok: true, page: 0, pageSize: 20, total: 0, items: [] }),
    listGroups: async () => ({ ok: true, page: 0, pageSize: 20, total: 0, groups: [] }),
    get: async () => ({ ok: false, errorCode: 'source-not-found' }),
    getState: () => ({ mode, reason: mode === 'normal' ? null : '测试注入状态' }),
    addManual: async () => ({ ok: false, errorCode: 'source-unavailable' }),
    updateManual: async () => ({ ok: false, errorCode: 'source-unavailable' }),
    disableManual: async () => ({ ok: false, errorCode: 'source-unavailable' }),
    restoreManual: async () => ({ ok: false, errorCode: 'source-unavailable' }),
    hardDeleteManual: async () => ({ ok: false, errorCode: 'source-unavailable' }),
    issueDeleteConfirmToken: async () => ({ ok: false, errorCode: 'source-unavailable' }),
    previewChangeSet: async () => ({ ok: false, errorCode: 'source-unavailable' }),
    applyChangeSet: async () => ({ ok: false, errorCode: 'source-unavailable' }),
    undoChange: async () => ({ ok: false, errorCode: 'source-unavailable' }),
    listUndoable: async () => ({ ok: false, errorCode: 'source-unavailable' }),
    recordUsage: async () => {},
    rebuildSearchIndex: async () => ({ ok: false, errorCode: 'source-unavailable' }),
    dispose: () => {},
    listByGroup: async () => ({ ok: true, page: 0, pageSize: 20, total: 0, items: [] }),
  } as unknown as SourceService;
}

// 零候选研究脚本：plan（零候选）→ 零选择 → 空 claims → 三字段结果草案
// （含 uncertain——claims 空强制矩阵）
function makeZeroCandidateScript(): FakeProviderScript {
  return {
    rounds: [
      [
        {
          text: JSON.stringify({
            sourceMode: 'search',
            sourceQuery: '工厂测试研究',
            groupId: null,
            webQueries: [],
          }),
        },
      ],
      [{ text: JSON.stringify({ selectedCandidateIds: [] }) }],
      [{ text: JSON.stringify({ vendorCandidateIds: [], claims: [], conflicts: [] }) }],
      [
        {
          text: JSON.stringify({
            result: {
              title: '工厂测试结果',
              summary: '工厂路径确定性结果',
              blocks: [
                { kind: 'markdown', text: '工厂正文' },
                { kind: 'uncertain', text: '无已核验证据', reason: '候选为空' },
              ],
            },
          }),
        },
      ],
    ],
  };
}

function makeBrowser() {
  const browser = {
    createTab: async () => ({
      id: 'tab-x',
      title: '',
      url: '',
      active: true,
      state: 'ready' as const,
    }),
    closeTab: async () => true,
    activateTab: async () => true,
    getTabs: async () => [],
    getActiveTab: async () => null,
    getPageSnapshot: async () => null,
  };
  return browser;
}

async function waitTerminal(
  service: ResearchService,
  taskId: string,
  timeoutMs = 15_000,
): Promise<ResearchTask | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await service.getTask(taskId);
    if (!got.ok) return null;
    if (got.task.status !== 'running' && got.task.status !== 'created') return got.task;
    if (Date.now() > deadline) throw new Error('任务未在期限内收敛');
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------- 测试 ----------

describe('生产 ResearchRuntimeFactory（决议 #155）', () => {
  it('FakeProvider 通过与生产相同的 factory 代码路径完成任务（真实 C6+C7 端口；可信字段程序生成）', async () => {
    currentScript = makeZeroCandidateScript();
    hasKeyFlag = true;
    supportsToolCallingFlag = true;
    const dir = mkdtempSync(join(root, 'run-'));
    try {
      const dbPath = join(dir, 'research.db');
      const outcome = openResearchStore({
        dbPath,
        buildRuntimeFactory: (db) =>
          createProductionResearchRuntimeFactory({
            db,
            browser: makeBrowser(),
            sourceService: makeSourceService('normal'),
            searchProvider: {
              id: 'test-search',
              search: async () => ({ ok: true, results: [] }),
            },
            configStore: new ConfigStore(dir, makeCredentials()),
            credentials: makeCredentials(),
          }),
      });
      expect(outcome.mode).toBe('normal');
      if (outcome.mode !== 'normal') return;
      const service = outcome.service;
      // 配置一个已注册 fake kind 的 Provider
      const cfg = new ConfigStore(dir, makeCredentials());
      const set = cfg.set({
        providerId: FAKE_KIND,
        baseUrl: 'https://test.invalid',
        model: 'test-model',
      });
      expect(set).toBe(true);
      const created = await service.createTask('生产工厂测试目标');
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const started = await service.startTask(created.task.id);
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const terminal = await waitTerminal(service, created.task.id);
      expect(terminal?.status).toBe('completed');
      expect(terminal?.resultId).not.toBeNull();
      // Result 落库读回（真实 C7 端口校验 + 程序组装）
      const db = openDb(dbPath);
      runResearchMigrations(db); // 幂等：user_version 已为 1，无操作
      const repo = new (await import('./repository/research-repository')).ResearchRepository(db);
      const result = repo.getResultByTaskId(created.task.id);
      expect(result).not.toBeNull();
      expect(result?.title).toBe('工厂测试结果');
      expect(result?.taskId).toBe(created.task.id);
      // 可信字段全部程序生成
      expect(result?.resultId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(result?.coverage).toEqual({
        total: 0,
        multiSource: 0,
        singleSource: 0,
        vendor: 0,
        thirdParty: 0,
        community: 0,
      });
      expect(result?.conflicts).toEqual([]);
      expect(result?.evidenceMap).toEqual({});
      // fetchedAt 为程序值（ISO 形态——非模型时间）
      expect(result?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // uncertain 块存在（claims 空强制矩阵）
      const uncertain = result?.blocks.filter((b) => b.kind === 'uncertain');
      expect(uncertain?.length).toBeGreaterThanOrEqual(1);
      // 候选为空：capture 零（正文零持久化）
      const captures = repo.listCapturesByTask(created.task.id);
      expect(captures).toHaveLength(0);
      closeDb(db);
      await service.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('缺配置（无已注册 kind 配置）→ research-provider-unavailable + 任务保持 created', async () => {
    currentScript = makeZeroCandidateScript();
    hasKeyFlag = true;
    supportsToolCallingFlag = true;
    const dir = mkdtempSync(join(root, 'cfg-'));
    try {
      const outcome = openResearchStore({
        dbPath: join(dir, 'research.db'),
        buildRuntimeFactory: (db) =>
          createProductionResearchRuntimeFactory({
            db,
            browser: makeBrowser(),
            sourceService: makeSourceService('normal'),
            searchProvider: { id: 's', search: async () => ({ ok: true, results: [] }) },
            configStore: new ConfigStore(dir, makeCredentials()), // 零配置
            credentials: makeCredentials(),
          }),
      });
      expect(outcome.mode).toBe('normal');
      if (outcome.mode !== 'normal') return;
      const created = await outcome.service.createTask('缺配置目标');
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const started = await outcome.service.startTask(created.task.id);
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.errorCode).toBe('research-provider-unavailable');
      const after = await outcome.service.getTask(created.task.id);
      expect(after.ok && after.task.status === 'created').toBe(true);
      await outcome.service.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('缺 Key → research-provider-unavailable + 任务保持 created', async () => {
    currentScript = makeZeroCandidateScript();
    hasKeyFlag = false;
    supportsToolCallingFlag = true;
    const dir = mkdtempSync(join(root, 'key-'));
    try {
      const cfg = new ConfigStore(dir, makeCredentials());
      cfg.set({ providerId: FAKE_KIND, baseUrl: 'https://test.invalid', model: 'm' });
      const outcome = openResearchStore({
        dbPath: join(dir, 'research.db'),
        buildRuntimeFactory: (db) =>
          createProductionResearchRuntimeFactory({
            db,
            browser: makeBrowser(),
            sourceService: makeSourceService('normal'),
            searchProvider: { id: 's', search: async () => ({ ok: true, results: [] }) },
            configStore: cfg,
            credentials: makeCredentials(),
          }),
      });
      expect(outcome.mode).toBe('normal');
      if (outcome.mode !== 'normal') return;
      const created = await outcome.service.createTask('缺 Key 目标');
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const started = await outcome.service.startTask(created.task.id);
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.errorCode).toBe('research-provider-unavailable');
      const after = await outcome.service.getTask(created.task.id);
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.task.status).toBe('created');
      await outcome.service.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supportsToolCalling=false → research-provider-unavailable + 任务保持 created', async () => {
    currentScript = makeZeroCandidateScript();
    hasKeyFlag = true;
    supportsToolCallingFlag = false;
    const dir = mkdtempSync(join(root, 'tools-'));
    try {
      const cfg = new ConfigStore(dir, makeCredentials());
      cfg.set({ providerId: FAKE_KIND, baseUrl: 'https://test.invalid', model: 'm' });
      const outcome = openResearchStore({
        dbPath: join(dir, 'research.db'),
        buildRuntimeFactory: (db) =>
          createProductionResearchRuntimeFactory({
            db,
            browser: makeBrowser(),
            sourceService: makeSourceService('normal'),
            searchProvider: { id: 's', search: async () => ({ ok: true, results: [] }) },
            configStore: cfg,
            credentials: makeCredentials(),
          }),
      });
      expect(outcome.mode).toBe('normal');
      if (outcome.mode !== 'normal') return;
      const created = await outcome.service.createTask('不支持工具目标');
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const started = await outcome.service.startTask(created.task.id);
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.errorCode).toBe('research-provider-unavailable');
      expect((await outcome.service.getTask(created.task.id)).ok).toBe(true);
      await outcome.service.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SourceService 缺失或非 normal → research-sources-unavailable（精确错误；任务保持 created）', async () => {
    currentScript = makeZeroCandidateScript();
    hasKeyFlag = true;
    supportsToolCallingFlag = true;
    for (const mode of ['readonly-recovery', 'unavailable'] as const) {
      const dir = mkdtempSync(join(root, `src-${mode}-`));
      try {
        const cfg = new ConfigStore(dir, makeCredentials());
        cfg.set({ providerId: FAKE_KIND, baseUrl: 'https://test.invalid', model: 'm' });
        const outcome = openResearchStore({
          dbPath: join(dir, 'research.db'),
          buildRuntimeFactory: (db) =>
            createProductionResearchRuntimeFactory({
              db,
              browser: makeBrowser(),
              sourceService: mode === 'unavailable' ? null : makeSourceService(mode),
              searchProvider: { id: 's', search: async () => ({ ok: true, results: [] }) },
              configStore: cfg,
              credentials: makeCredentials(),
            }),
        });
        expect(outcome.mode).toBe('normal');
        if (outcome.mode !== 'normal') return;
        const created = await outcome.service.createTask('Sources 状态目标');
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const started = await outcome.service.startTask(created.task.id);
        expect(started.ok).toBe(false);
        if (started.ok) return;
        expect(started.errorCode).toBe('research-sources-unavailable');
        await outcome.service.shutdown();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('prepared 恰一次消费（launch/release 二选一；禁止跨 task 复用）', async () => {
    currentScript = makeZeroCandidateScript();
    hasKeyFlag = true;
    supportsToolCallingFlag = true;
    const dir = mkdtempSync(join(root, 'prep-'));
    let db: ReturnType<typeof openDb> | null = null;
    try {
      const cfg = new ConfigStore(dir, makeCredentials());
      cfg.set({ providerId: FAKE_KIND, baseUrl: 'https://test.invalid', model: 'm' });
      db = openDb(join(dir, 'r.db'));
      runResearchMigrations(db);
      const factory = createProductionResearchRuntimeFactory({
        db,
        browser: makeBrowser(),
        sourceService: makeSourceService('normal'),
        searchProvider: { id: 's', search: async () => ({ ok: true, results: [] }) },
        configStore: cfg,
        credentials: makeCredentials(),
      });
      const resolved = await factory.resolveProvider();
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      const input = {
        taskId: 't-1',
        goal: 'g',
        runToken: 'r-1',
        onProgress: () => {},
        onSettle: () => {},
      };
      const repo = new (await import('./repository/research-repository')).ResearchRepository(db);
      const nowIso = new Date().toISOString();
      const taskRow = (id: string, goal: string): void =>
        repo.insertTask({
          id,
          goal,
          status: 'running',
          phase: 'planning',
          created_at: nowIso,
          updated_at: nowIso,
          started_at: nowIso,
          finished_at: null,
          interrupted_at: null,
          error_code: null,
          result_id: null,
          stats_json: JSON.stringify({
            candidateCount: 0,
            selectedCount: 0,
            captureCount: 0,
            failedReadCount: 0,
            evidenceCount: 0,
            rejectedEvidenceCount: 0,
            claimCount: 0,
            conflictCount: 0,
            stepsUsed: 0,
            roundsUsed: 0,
          }),
        });
      taskRow('t-1', 'g');
      const h1 = resolved.prepared.launch(input);
      expect(h1.taskId).toBe('t-1');
      // 重复 launch → 程序缺陷抛错
      expect(() => resolved.prepared.launch(input)).toThrow(/消费/);
      // 释放后不得 launch
      const resolved2 = await factory.resolveProvider();
      expect(resolved2.ok).toBe(true);
      if (!resolved2.ok) return;
      resolved2.prepared.release();
      expect(() => resolved2.prepared.launch(input)).toThrow(/消费/);
      await h1.done;
      expect(repo.getTaskById('t-1')?.status).toBe('completed');
      // 同一 factory 再次解析 → 新 prepared（无共享状态），新 task 独立完成
      const resolved3 = await factory.resolveProvider();
      expect(resolved3.ok).toBe(true);
      if (!resolved3.ok) return;
      taskRow('t-3', 'g3');
      const h3 = resolved3.prepared.launch({ ...input, taskId: 't-3', runToken: 'r-3' });
      await h3.done;
      expect(repo.getTaskById('t-3')?.status).toBe('completed');
    } finally {
      if (db !== null) closeDb(db);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveProvider 内部异常（config 读取爆炸）→ research-provider-unavailable 归一（不抛穿）', async () => {
    const dir = mkdtempSync(join(root, 'boom-'));
    let db: ReturnType<typeof openDb> | null = null;
    try {
      const explodingConfig: ConfigStore = {
        list: async () => {
          throw new Error('配置读取爆炸');
        },
      } as unknown as ConfigStore;
      db = openDb(join(dir, 'r.db'));
      runResearchMigrations(db);
      const factory = createProductionResearchRuntimeFactory({
        db,
        browser: makeBrowser(),
        sourceService: makeSourceService('normal'),
        searchProvider: { id: 's', search: async () => ({ ok: true, results: [] }) },
        configStore: explodingConfig,
        credentials: makeCredentials(),
      });
      const resolved = await factory.resolveProvider();
      expect(resolved.ok).toBe(false);
      if (resolved.ok) return;
      expect(resolved.errorCode).toBe('research-provider-unavailable');
    } finally {
      if (db !== null) closeDb(db);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
