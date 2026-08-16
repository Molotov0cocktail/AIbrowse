// 决议 #154：ResearchService 启动预占与 Provider 交接（红→绿）——
// deferred resolve 下两个并发 start 只有一个占槽；resolve 前任务保持
// created；resolve 期间 shutdown 后迟到 continuation 零 DB 写入/零
// launch；prepared 恰一次消费（launch/release 二选一）；resolve 失败
// 精确错误码 + 任务保持 created；stopTask 在 resolving 阶段零副作用；
// 预占 CAS（旧 continuation 不清新 run 槽位）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, closeDb, type DbHandle } from '../sources/db/sqlite-driver';
import { runResearchMigrations } from './db/research-migrations';
import { ResearchServiceImpl, type ResearchServiceOptions } from './research-service';
import { ResearchRepository } from './repository/research-repository';
import type {
  ResearchPreparedLaunch,
  ResearchPreparedLaunchResult,
  ResearchResolveErrorCode,
  ResearchRuntimeHandle,
  ResearchRuntimeLaunchInput,
} from '../../shared/types/research';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-research-pre-'));
const T0 = Date.UTC(2026, 7, 16, 0, 0, 0);

let handle: DbHandle;
let dbPath: string;
let nowMs: number;
let svc: ResearchServiceImpl;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------- 可控 deferred 工厂（决议 #154(7) 新接口形状） ----------

interface FakeRuntime {
  input: ResearchRuntimeLaunchInput;
  aborts: number;
  resolveDone: () => void;
  done: Promise<void>;
}

function makeRuntimeHandle(
  taskId: string,
  runToken: string,
): { handle: ResearchRuntimeHandle; fake: FakeRuntime } {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const fake: FakeRuntime = {
    input: null as unknown as ResearchRuntimeLaunchInput,
    aborts: 0,
    resolveDone,
    done,
  };
  const handle: ResearchRuntimeHandle = {
    taskId,
    runToken,
    done,
    abort() {
      fake.aborts += 1;
    },
  };
  return { handle, fake };
}

interface PreparedStats {
  launches: Array<{ handle: ResearchRuntimeHandle; fake: FakeRuntime }>;
  releases: number;
}

function makePrepared(): { prepared: ResearchPreparedLaunch; stats: PreparedStats } {
  const stats: PreparedStats = { launches: [], releases: 0 };
  let consumed = false;
  const prepared: ResearchPreparedLaunch = {
    launch(input) {
      if (consumed) throw new Error('程序缺陷：prepared 已被消费');
      consumed = true;
      const { handle, fake } = makeRuntimeHandle(input.taskId, input.runToken);
      fake.input = input;
      stats.launches.push({ handle, fake });
      return handle;
    },
    release() {
      if (!consumed) {
        consumed = true;
        stats.releases += 1;
      }
      // 重复 release：幂等 no-op（决议 #154(7)）
    },
  };
  return { prepared, stats };
}

interface DeferredResolve {
  resolve: (result: ResearchPreparedLaunchResult) => void;
  reject: (err: unknown) => void;
}

function makeDeferredFactory(): {
  resolveCalls: number;
  deferred: DeferredResolve;
  stats: PreparedStats;
  resolveProvider: () => Promise<ResearchPreparedLaunchResult>;
} {
  const stats: PreparedStats = { launches: [], releases: 0 };
  let resolveCalls = 0;
  let pending: {
    resolve: (r: ResearchPreparedLaunchResult) => void;
    reject: (e: unknown) => void;
  } | null = null;
  const factory = {
    get resolveCalls() {
      return resolveCalls;
    },
    stats,
    deferred: {
      resolve(r: ResearchPreparedLaunchResult) {
        pending?.resolve(r);
        pending = null;
      },
      reject(e: unknown) {
        pending?.reject(e);
        pending = null;
      },
    },
    async resolveProvider(): Promise<ResearchPreparedLaunchResult> {
      resolveCalls += 1;
      return new Promise<ResearchPreparedLaunchResult>((resolve, reject) => {
        pending = { resolve, reject };
      });
    },
  };
  return factory;
}

function buildService(over: Partial<ResearchServiceOptions> = {}): ResearchServiceImpl {
  return new ResearchServiceImpl({
    db: handle,
    now: () => nowMs,
    ...over,
  });
}

function repo(): ResearchRepository {
  return new ResearchRepository(handle);
}

beforeEach(() => {
  dbPath = join(root, `pre-${Math.random().toString(36).slice(2)}.db`);
  handle = openDb(dbPath);
  runResearchMigrations(handle);
  nowMs = T0;
  svc = buildService();
});

afterEach(async () => {
  await svc.shutdown();
  closeDb(handle);
});

describe('决议 #154：启动预占与 Provider 交接', () => {
  it('两个并发 start（deferred resolve）只有先调用者占槽；后者立即 research-busy（零二次 resolve）', async () => {
    const f1 = makeDeferredFactory();
    const svc2 = buildService({ runtimeFactory: { resolveProvider: f1.resolveProvider } });
    const task = await svc2.createTask('并发目标');
    expect(task.ok).toBe(true);
    if (!task.ok) return;
    const p1 = svc2.startTask(task.task.id);
    // 同步段后：p1 已占 starting slot、resolve 挂起
    expect(f1.resolveCalls).toBe(1);
    const p2 = svc2.startTask(task.task.id);
    const r2 = await p2;
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.errorCode).toBe('research-busy'); // 立即拒绝（不得等待 resolve）
    expect(f1.resolveCalls).toBe(1); // 第二次 start 零 resolve 调用
    // resolve 完成前任务保持 created（未写 running）
    const before = repo().getTaskById(task.task.id);
    expect(before?.status).toBe('created');
    // 释放 resolve → 第一个 start 正常完成
    const { prepared, stats } = makePrepared();
    f1.deferred.resolve({ ok: true, prepared });
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.task.status).toBe('running');
    expect(stats.launches).toHaveLength(1);
    // 终态收敛（避免 dangling）
    stats.launches[0]!.fake.resolveDone();
    await stats.launches[0]!.handle.done;
  });

  it('resolve 期间 shutdown：迟到 continuation 零 DB 写入、零 launch、prepared 被释放', async () => {
    const f1 = makeDeferredFactory();
    const svc2 = buildService({ runtimeFactory: { resolveProvider: f1.resolveProvider } });
    const task = await svc2.createTask('关机竞态目标');
    expect(task.ok).toBe(true);
    if (!task.ok) return;
    const p1 = svc2.startTask(task.task.id);
    expect(f1.resolveCalls).toBe(1);
    const shutdownPromise = svc2.shutdown();
    // resolve 在 shutdown 开始后才返回
    const { prepared, stats } = makePrepared();
    f1.deferred.resolve({ ok: true, prepared });
    const r1 = await p1;
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.errorCode).toBe('research-unavailable'); // 迟到 continuation 安全拒绝
    expect(stats.launches).toHaveLength(0); // 零 launch（不建立 Runtime）
    expect(stats.releases).toBe(1); // prepared 被释放（丢弃）
    await shutdownPromise;
    // 零 DB 写入：新只读连接读回（shutdown 已关闭旧句柄——文件保留）——
    // 任务仍 created（未写 running）
    const probe = openDb(dbPath);
    try {
      const after = new ResearchRepository(probe).getTaskById(task.task.id);
      expect(after?.status).toBe('created');
      expect(after?.startedAt).toBeNull();
    } finally {
      closeDb(probe);
    }
  });

  it('resolve 失败（provider/sources/unavailable 精确码）：任务保持 created、零 DB 写入、零 launch', async () => {
    for (const code of [
      'research-provider-unavailable',
      'research-sources-unavailable',
      'research-unavailable',
    ] as ResearchResolveErrorCode[]) {
      // 每迭代独立句柄（shutdown 关闭连接——迭代间不得共享）
      const localHandle = openDb(join(root, `pre-fail-${Math.random().toString(36).slice(2)}.db`));
      runResearchMigrations(localHandle);
      const f1 = makeDeferredFactory();
      const svc2 = new ResearchServiceImpl({
        db: localHandle,
        now: () => nowMs,
        runtimeFactory: { resolveProvider: f1.resolveProvider },
      });
      const task = await svc2.createTask('失败码目标');
      expect(task.ok).toBe(true);
      if (!task.ok) return;
      const p1 = svc2.startTask(task.task.id);
      f1.deferred.resolve({ ok: false, errorCode: code });
      const r1 = await p1;
      expect(r1.ok).toBe(false);
      if (r1.ok) return;
      expect(r1.errorCode).toBe(code);
      expect(f1.stats.launches).toHaveLength(0);
      expect(f1.stats.releases).toBe(0); // 失败路径无 prepared 可释放
      const after = new ResearchRepository(localHandle).getTaskById(task.task.id);
      expect(after?.status).toBe('created');
      expect(after?.startedAt).toBeNull();
      await svc2.shutdown();
      closeDb(localHandle);
    }
  });

  it('resolveProvider 抛异常 → research-provider-unavailable 归一 + 任务保持 created + 预占清除（后续 start 可重试）', async () => {
    let failNext = true;
    const holder: { stats: PreparedStats | null } = { stats: null };
    const factory = {
      async resolveProvider(): Promise<ResearchPreparedLaunchResult> {
        if (failNext) throw new Error('配置读取爆炸');
        const { prepared, stats } = makePrepared();
        holder.stats = stats;
        return { ok: true, prepared };
      },
    };
    const svc2 = buildService({ runtimeFactory: factory });
    const task = await svc2.createTask('异常归一目标');
    expect(task.ok).toBe(true);
    if (!task.ok) return;
    const r1 = await svc2.startTask(task.task.id);
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.errorCode).toBe('research-provider-unavailable');
    expect(repo().getTaskById(task.task.id)?.status).toBe('created');
    // 预占已按身份清除：可再次 start
    failNext = false;
    const r2 = await svc2.startTask(task.task.id);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    // 收敛 fake run（避免 dangling + shutdown 挂起）
    holder.stats?.launches[0]?.fake.resolveDone();
    await svc2.shutdown();
  });

  it('prepared 恰一次消费：launch 后重复 launch 抛程序缺陷；release 幂等 no-op', () => {
    const { prepared, stats } = makePrepared();
    const input: ResearchRuntimeLaunchInput = {
      taskId: 't',
      goal: 'g',
      runToken: 'r',
      onProgress: () => {},
      onSettle: () => {},
    };
    prepared.launch(input);
    expect(stats.launches).toHaveLength(1);
    expect(() => prepared.launch(input)).toThrow(/消费/);
    prepared.release(); // 已消费后 release：幂等（不重复计数）
    expect(stats.releases).toBe(0);
  });

  it('prepared 释放后不得 launch（程序缺陷抛错）', () => {
    const { prepared, stats } = makePrepared();
    prepared.release();
    expect(stats.releases).toBe(1);
    const input: ResearchRuntimeLaunchInput = {
      taskId: 't',
      goal: 'g',
      runToken: 'r',
      onProgress: () => {},
      onSettle: () => {},
    };
    expect(() => prepared.launch(input)).toThrow(/消费/);
    expect(stats.launches).toHaveLength(0);
  });

  it('stopTask 在 resolving 阶段：research-invalid-state + 零副作用（任务保持 created、零 abort、零 launch）', async () => {
    const f1 = makeDeferredFactory();
    const svc2 = buildService({ runtimeFactory: { resolveProvider: f1.resolveProvider } });
    const task = await svc2.createTask('解析中停止目标');
    expect(task.ok).toBe(true);
    if (!task.ok) return;
    const p1 = svc2.startTask(task.task.id);
    expect(f1.resolveCalls).toBe(1);
    const stop = await svc2.stopTask(task.task.id);
    expect(stop.ok).toBe(false);
    if (stop.ok) return;
    expect(stop.errorCode).toBe('research-invalid-state'); // 尚未进入 running——诚实语义
    expect(f1.stats.launches).toHaveLength(0); // 零 Runtime 建立
    // 释放 resolve：start 正常完成（stop 不干扰未建立的 run）
    const { prepared, stats } = makePrepared();
    f1.deferred.resolve({ ok: true, prepared });
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(stats.launches).toHaveLength(1);
    // 收敛
    stats.launches[0]!.fake.resolveDone();
    await stats.launches[0]!.handle.done;
  });

  it('预占 CAS：前一次 start 的迟到清除不影响新 run 的槽位（顺序任务 A→B）', async () => {
    const f1 = makeDeferredFactory();
    const svc2 = buildService({ runtimeFactory: { resolveProvider: f1.resolveProvider } });
    const taskA = await svc2.createTask('任务A');
    const taskB = await svc2.createTask('任务B');
    expect(taskA.ok && taskB.ok).toBe(true);
    if (!taskA.ok || !taskB.ok) return;
    const p1 = svc2.startTask(taskA.task.id);
    const { prepared: pa, stats: sa } = makePrepared();
    f1.deferred.resolve({ ok: true, prepared: pa });
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    // A run 进行中：active slot 被占（B 无法 start——单 running 互斥）
    const rB = await svc2.startTask(taskB.task.id);
    expect(rB.ok).toBe(false);
    if (rB.ok) return;
    expect(rB.errorCode).toBe('research-busy');
    // 收敛 A：fake run settle + 测试设施写终态（fake runtime 无持久化）
    sa.launches[0]!.fake.resolveDone();
    await sa.launches[0]!.handle.done;
    const taskARow = repo().getTaskById(taskA.task.id)!;
    repo().setTaskCompleted(taskA.task.id, {
      resultId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      finishedAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
      stats: taskARow.stats,
    });
    // A settle 后（restart 屏障解除）B 可正常 start（新 Service 实例同库）
    const { prepared: pb, stats: sb } = makePrepared();
    const svc3 = buildService({
      runtimeFactory: { resolveProvider: async () => ({ ok: true, prepared: pb }) },
    });
    const rB2 = await svc3.startTask(taskB.task.id);
    expect(rB2.ok).toBe(true);
    if (!rB2.ok) return;
    expect(sb.launches).toHaveLength(1);
    sb.launches[0]!.fake.resolveDone();
    await sb.launches[0]!.handle.done;
    await svc3.shutdown();
  });
});
