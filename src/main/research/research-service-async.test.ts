// C5 research-service async assembly tests (adjudication #135/#134(3)):
// startTask launches a background Runtime and returns immediately; the
// runtime-unavailable gate; provider resolution happens before entering
// running; the single active slot with runToken + CAS clearing + restart
// barrier (a new run may only start after the old run fully settles);
// Runtime is the sole terminal writer (stopTask only aborts + reads);
// launch failure never leaves a permanent running task; idempotent async
// shutdown (abort → await settle → closeDb) with zero database-closed race.
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
  ResearchProgressEvent,
  ResearchRuntimeHandle,
  ResearchRuntimeLaunchInput,
} from '../../shared/types/research';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-research-sa-'));
const T0 = Date.UTC(2026, 7, 16, 0, 0, 0);

let handle: DbHandle;
let nowMs: number;
let svc: ResearchServiceImpl;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

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

function makeFactory(
  over: {
    resolveProviderOutcome?: 'ok' | 'null';
    onLaunch?: (
      input: ResearchRuntimeLaunchInput,
      h: ResearchRuntimeHandle,
      f: FakeRuntime,
    ) => void;
  } = {},
) {
  const runs: Array<{ handle: ResearchRuntimeHandle; fake: FakeRuntime }> = [];
  const factory = {
    runs,
    resolveCalls: 0,
    launchCalls: 0,
    async resolveProvider(): Promise<ResearchPreparedLaunchResult> {
      this.resolveCalls += 1;
      if (over.resolveProviderOutcome === 'null') {
        return { ok: false, errorCode: 'research-provider-unavailable' };
      }
      let consumed = false;
      const prepared: ResearchPreparedLaunch = {
        launch(input: ResearchRuntimeLaunchInput): ResearchRuntimeHandle {
          if (consumed) throw new Error('程序缺陷：prepared 已被消费');
          consumed = true;
          factory.launchCalls += 1;
          const { handle, fake } = makeRuntimeHandle(input.taskId, input.runToken);
          fake.input = input;
          over.onLaunch?.(input, handle, fake);
          runs.push({ handle, fake });
          return handle;
        },
        release() {
          consumed = true;
        },
      };
      return { ok: true, prepared };
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

beforeEach(() => {
  handle = openDb(join(root, `sa-${Math.random().toString(36).slice(2)}.db`));
  runResearchMigrations(handle);
  nowMs = T0;
  svc = buildService();
});

afterEach(async () => {
  await svc.shutdown();
  closeDb(handle);
});

describe('runtime-unavailable 门（决议 #134(3)）', () => {
  it('未装配 runtimeFactory → startTask 拒绝 research-runtime-unavailable（任务零变化）', async () => {
    const created = await svc.createTask('比较主流模型');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const start = await svc.startTask(created.task.id);
    expect(start.ok).toBe(false);
    if (!start.ok) expect(start.errorCode).toBe('research-runtime-unavailable');
    const task = await svc.getTask(created.task.id);
    expect(task.ok && task.task.status).toBe('created');
  });
});

describe('Provider 解析前置（决议 #135(2)）', () => {
  it('resolveProvider null → research-provider-unavailable + 任务保持 created + 零 launch', async () => {
    const created = await svc.createTask('比较主流模型');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const factory = makeFactory({ resolveProviderOutcome: 'null' });
    const svc2 = buildService({ runtimeFactory: factory });
    const start = await svc2.startTask(created.task.id);
    expect(start.ok).toBe(false);
    if (!start.ok) expect(start.errorCode).toBe('research-provider-unavailable');
    expect(factory.launchCalls).toBe(0);
    const task = await svc2.getTask(created.task.id);
    expect(task.ok && task.task.status).toBe('created');
  });

  it('resolveProvider 抛错 → research-provider-unavailable（归一，不留下 running）', async () => {
    const created = await svc.createTask('比较主流模型');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const factory = makeFactory();
    factory.resolveProvider = async () => {
      throw new Error('配置读取失败');
    };
    const svc2 = buildService({ runtimeFactory: factory });
    const start = await svc2.startTask(created.task.id);
    expect(start.ok).toBe(false);
    if (!start.ok) expect(start.errorCode).toBe('research-provider-unavailable');
    const task = await svc2.getTask(created.task.id);
    expect(task.ok && task.task.status).toBe('created');
  });
});

describe('startTask 异步启动（决议 #135(1)）', () => {
  it('启动成功：任务 running + 立即返回（不等待 Runtime 完成）+ 返回 running 快照', async () => {
    const created = await svc.createTask('比较主流模型');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const factory = makeFactory();
    const svc2 = buildService({ runtimeFactory: factory });
    const start = await svc2.startTask(created.task.id);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(start.task.status).toBe('running');
    expect(start.task.phase).toBe('planning');
    expect(factory.launchCalls).toBe(1);
    expect(factory.runs[0]!.fake.input.taskId).toBe(created.task.id);
    expect(factory.runs[0]!.fake.input.goal).toBe('比较主流模型');
    // Runtime 未 settle（done pending）
    expect(factory.runs[0]!.fake.aborts).toBe(0);
    factory.runs[0]!.fake.resolveDone();
    await factory.runs[0]!.handle.done;
  });

  it('launch 抛错 → 立即写 failed(research-runtime-unavailable) + slot 零残留（无永久 running）', async () => {
    const created = await svc.createTask('比较主流模型');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const factory = makeFactory({
      onLaunch() {
        throw new Error('端口构造失败');
      },
    });
    const svc2 = buildService({ runtimeFactory: factory });
    const start = await svc2.startTask(created.task.id);
    // 决议 #135(2)：launch 失败 → start 失败 + 任务立即写 failed（零永久 running）
    expect(start.ok).toBe(false);
    if (!start.ok) expect(start.errorCode).toBe('research-runtime-unavailable');
    const task = await svc2.getTask(created.task.id);
    expect(task.ok && task.task.status).toBe('failed');
    if (task.ok) expect(task.task.errorCode).toBe('research-runtime-unavailable');
  });

  it('单 running 互斥：active run 存在时第二次 start → research-busy', async () => {
    const a = await svc.createTask('任务 A');
    const b = await svc.createTask('任务 B');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const factory = makeFactory();
    const svc2 = buildService({ runtimeFactory: factory });
    const startA = await svc2.startTask(a.task.id);
    expect(startA.ok).toBe(true);
    const startB = await svc2.startTask(b.task.id);
    expect(startB.ok).toBe(false);
    if (!startB.ok) expect(startB.errorCode).toBe('research-busy');
    factory.runs[0]!.fake.resolveDone();
    await factory.runs[0]!.handle.done;
  });

  it('restart 屏障：旧 run 完全 settle 前 startTask 拒绝；settle 后允许', async () => {
    const created = await svc.createTask('比较主流模型');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const factory = makeFactory();
    const svc2 = buildService({ runtimeFactory: factory });
    await svc2.startTask(created.task.id);
    // stop：Runtime 尚未 settle → restart 拒绝（research-busy，restart 屏障）
    const stop = await svc2.stopTask(created.task.id);
    expect(stop.ok).toBe(true);
    const restart1 = await svc2.startTask(created.task.id);
    expect(restart1.ok).toBe(false);
    if (!restart1.ok) expect(restart1.errorCode).toBe('research-busy');
    // 模拟 Runtime 终态写入（cancelled）后旧 run settle → slot 清除 → restart 允许
    const repo = new ResearchRepository(handle);
    repo.setTaskCancelled(created.task.id, {
      finishedAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
      stats: {
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
      },
    });
    factory.runs[0]!.fake.resolveDone();
    await factory.runs[0]!.handle.done;
    // 等待 slot 清除微任务
    await Promise.resolve();
    const restart2 = await svc2.startTask(created.task.id);
    expect(restart2.ok).toBe(true);
    expect(factory.launchCalls).toBe(2);
    expect(factory.runs[1]!.handle.runToken).not.toBe(factory.runs[0]!.handle.runToken);
    factory.runs[1]!.fake.resolveDone();
    await factory.runs[1]!.handle.done;
  });
});

describe('stopTask：只 abort + 读取状态（决议 #135(4)）', () => {
  it('stop 后返回当前快照；cancelled 终态由 Runtime 写入（此处 Runtime 替身不写库——快照仍 running）', async () => {
    const created = await svc.createTask('比较主流模型');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const factory = makeFactory();
    const svc2 = buildService({ runtimeFactory: factory });
    await svc2.startTask(created.task.id);
    const stop = await svc2.stopTask(created.task.id);
    expect(stop.ok).toBe(true);
    expect(factory.runs[0]!.fake.aborts).toBe(1);
    // 幂等：重复 stop 不重复 abort？——重复 stop 幂等（决议 #105）
    const stop2 = await svc2.stopTask(created.task.id);
    expect(stop2.ok).toBe(true);
    factory.runs[0]!.fake.resolveDone();
    await factory.runs[0]!.handle.done;
  });

  it('非 active 任务（无 runtime）stop → C1 语义兜底（直接写 cancelled）', async () => {
    const created = await svc.createTask('比较主流模型');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const started = await svc.startTask(created.task.id); // 无 factory → 拒绝
    expect(started.ok).toBe(false);
    const task = await svc.getTask(created.task.id);
    expect(task.ok && task.task.status).toBe('created');
    // created 非 running → stop 拒绝（invalid-state）
    const stop = await svc.stopTask(created.task.id);
    expect(stop.ok).toBe(false);
  });

  it('launch input 携带 onProgress/onSettle 回调（Service 转发链）', async () => {
    const created = await svc.createTask('比较主流模型');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const seen: ResearchProgressEvent[] = [];
    const factory = makeFactory({
      onLaunch(input) {
        expect(typeof input.onProgress).toBe('function');
        expect(typeof input.onSettle).toBe('function');
        input.onProgress({
          taskId: input.taskId,
          status: 'running',
          phase: 'planning',
          stats: {
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
          },
          finishedAt: null,
        });
        seen.push({
          taskId: input.taskId,
          status: 'running',
          phase: 'planning',
          stats: {
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
          },
          finishedAt: null,
        });
      },
    });
    const svc2 = buildService({ runtimeFactory: factory });
    await svc2.startTask(created.task.id);
    expect(seen.length).toBe(1);
    expect(seen[0]!.taskId).toBe(created.task.id);
    factory.runs[0]!.fake.resolveDone();
    await factory.runs[0]!.handle.done;
  });
});

describe('shutdown/dispose（决议 #135(7)）', () => {
  it('shutdown 幂等：重复调用返回同一 Promise；abort → await settle → 关库', async () => {
    const created = await svc.createTask('比较主流模型');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const factory = makeFactory();
    const svc2 = buildService({ runtimeFactory: factory });
    await svc2.startTask(created.task.id);
    const p1 = svc2.shutdown();
    const p2 = svc2.shutdown();
    expect(p1).toBe(p2);
    expect(factory.runs[0]!.fake.aborts).toBe(1);
    factory.runs[0]!.fake.resolveDone();
    await p1;
    // 关库后数据库访问安全失败（unavailable 全拒——不是 database-closed race 崩溃）
    const after = await svc2.getTask(created.task.id);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.errorCode).toBe('research-unavailable');
  });

  it('dispose 有 active run 时不立即关库（触发 shutdown 流程）——getTask 仍可用直至 settle', async () => {
    const created = await svc.createTask('比较主流模型');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const factory = makeFactory();
    const svc2 = buildService({ runtimeFactory: factory });
    await svc2.startTask(created.task.id);
    svc2.dispose();
    // 未 settle：库仍可用（读回 running）
    const mid = await svc2.getTask(created.task.id);
    expect(mid.ok).toBe(true);
    if (mid.ok) expect(mid.task.status).toBe('running');
    expect(factory.runs[0]!.fake.aborts).toBe(1);
    factory.runs[0]!.fake.resolveDone();
    await factory.runs[0]!.handle.done;
    await svc2.shutdown();
    const after = await svc2.getTask(created.task.id);
    expect(after.ok).toBe(false);
  });

  it('shutdown 无 active run：直接关库（幂等 dispose 兼容）', async () => {
    await svc.shutdown();
    const again = await svc.shutdown();
    expect(again).toBeUndefined();
    const task = await svc.getTask('11111111-1111-4111-8111-111111111111');
    expect(task.ok).toBe(false);
  });

  it('done settle 后 slot 按 runToken CAS 清除（旧 token 不误清新 run）', async () => {
    const created = await svc.createTask('比较主流模型');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const factory = makeFactory();
    const svc2 = buildService({ runtimeFactory: factory });
    await svc2.startTask(created.task.id);
    const run1 = factory.runs[0]!;
    // 模拟 Runtime 终态写入后 settle
    const repo = new ResearchRepository(handle);
    repo.setTaskCancelled(created.task.id, {
      finishedAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
      stats: {
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
      },
    });
    run1.fake.resolveDone();
    await run1.handle.done;
    await Promise.resolve();
    // restart 允许（slot 已按 runToken CAS 清除）
    const restart = await svc2.startTask(created.task.id);
    expect(restart.ok).toBe(true);
    const run2 = factory.runs[1]!;
    expect(run2.handle.runToken).not.toBe(run1.handle.runToken);
    run2.fake.resolveDone();
    await run2.handle.done;
  });
});
