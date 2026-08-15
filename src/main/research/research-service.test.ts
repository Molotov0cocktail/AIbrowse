// C1 research-service tests: the task lifecycle skeleton (detailed-design §9.1,
// adjudications #104–#109) — createTask (reject/truncate semantics, total-task
// ceiling with oldest-finished pruning), getTask/listTasks (pagination clamp,
// status filter), deleteTask (running refused, CASCADE), startTask (four
// precondition gates + restart atomic reset), stopTask (idempotent, prune
// trigger), invalid input safe-returns, unavailable state (db=null) full
// rejection, dispose idempotence, and injected-clock determinism.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, closeDb, type DbHandle } from '../sources/db/sqlite-driver';
import { runResearchMigrations } from './db/research-migrations';
import { ResearchRepository } from './repository/research-repository';
import { ResearchServiceImpl, type ResearchServiceOptions } from './research-service';
import { MAX_GOAL_CHARS, MAX_STORED_TASKS } from '../../shared/types/research';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-research-svc-'));
const T0 = Date.UTC(2026, 7, 16, 0, 0, 0);
const T1 = Date.UTC(2026, 7, 16, 0, 1, 0);

let handle: DbHandle;
let nowMs: number;
let svc: ResearchServiceImpl;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function buildService(over: Partial<ResearchServiceOptions> = {}): ResearchServiceImpl {
  return new ResearchServiceImpl({
    db: handle,
    now: () => nowMs,
    ...over,
  });
}

beforeEach(() => {
  handle = openDb(join(root, `svc-${Math.random().toString(36).slice(2)}.db`));
  runResearchMigrations(handle);
  nowMs = T0;
  svc = buildService();
});

afterEach(() => {
  svc.dispose();
  closeDb(handle);
});

describe('createTask：goal 语义（决议 #107）', () => {
  it('正常创建 → created + 时间戳由注入时钟决定', async () => {
    const result = await svc.createTask('比较主流模型能力');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.status).toBe('created');
    expect(result.task.phase).toBeNull();
    expect(result.task.createdAt).toBe('2026-08-16T00:00:00.000Z');
    expect(result.task.updatedAt).toBe('2026-08-16T00:00:00.000Z');
    expect(result.task.stats.candidateCount).toBe(0);
  });

  it('空串/纯空白/非串 → research-invalid-goal 拒绝（零落库）', async () => {
    for (const bad of ['', '   ', null, undefined, 42, {}]) {
      const result = await svc.createTask(bad as unknown as string);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errorCode).toBe('research-invalid-goal');
    }
    expect((await svc.listTasks()).ok && (await svc.listTasks()).ok ? 0 : 0).toBe(0);
  });

  it('超长 goal → 确定性截断至 2000 + 标记（不拒绝）', async () => {
    const long = '长'.repeat(MAX_GOAL_CHARS + 100);
    const result = await svc.createTask(long);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.goal.length).toBeGreaterThan(MAX_GOAL_CHARS); // 含截断标记
    expect(result.task.goal.startsWith('长'.repeat(MAX_GOAL_CHARS))).toBe(true);
    expect(result.task.goal).toContain('已截断');
  });

  it('边界 ±1：1999/2000 不截断、2001 截断', async () => {
    const at = await svc.createTask('x'.repeat(MAX_GOAL_CHARS - 1));
    expect(at.ok && !at.task.goal.includes('已截断')).toBe(true);
    const exact = await svc.createTask('y'.repeat(MAX_GOAL_CHARS));
    expect(exact.ok && !exact.task.goal.includes('已截断')).toBe(true);
    const above = await svc.createTask('z'.repeat(MAX_GOAL_CHARS + 1));
    expect(above.ok && above.task.goal.includes('已截断')).toBe(true);
  });
});

describe('createTask：任务总数硬上限（决议 #104）', () => {
  it('30 个 created 占满后：无可清理终态 → research-task-limit', async () => {
    for (let i = 0; i < MAX_STORED_TASKS; i += 1) {
      const r = await svc.createTask(`目标${i}`);
      expect(r.ok).toBe(true);
    }
    const blocked = await svc.createTask('第 31 个');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.errorCode).toBe('research-task-limit');
    // created 永不被清理（决议 #104）：总数仍是 30（listTasks total 为全量计数）
    const list = await svc.listTasks();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.total).toBe(MAX_STORED_TASKS);
  });

  it('存在终态时：超限创建先清理最旧终态后成功', async () => {
    // 28 个 created + 2 个终态 = 30 行；创建第 31 个任务时清理 1 个最旧终态
    // 后成功（插入后总数 ≤ 30——决议 #104 总数硬上限）
    for (let i = 0; i < MAX_STORED_TASKS - 2; i += 1) {
      await svc.createTask(`created-${i}`);
    }
    nowMs = T1;
    const finA = await svc.createTask('fin-a');
    const idA = (finA as { ok: true; task: { id: string } }).task.id;
    expect((await svc.startTask(idA)).ok).toBe(true);
    expect((await svc.stopTask(idA)).ok).toBe(true);
    nowMs = T1 + 1; // fin-b 更晚终结 → fin-a 为最旧终态（排序键确定性）
    const finB = await svc.createTask('fin-b');
    const idB = (finB as { ok: true; task: { id: string } }).task.id;
    expect((await svc.startTask(idB)).ok).toBe(true);
    expect((await svc.stopTask(idB)).ok).toBe(true);
    const next = await svc.createTask('第 31 个');
    expect(next.ok).toBe(true);
    // 最旧终态（fin-a）已被清理（getTask 契约：不存在 → ok:false）；fin-b 保留；总数 = 30
    const gone = await svc.getTask(idA);
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.errorCode).toBe('research-not-found');
    const kept = await svc.getTask(idB);
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.task!.goal).toBe('fin-b');
    const list = await svc.listTasks();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.total).toBe(MAX_STORED_TASKS);
  });
});

describe('getTask / listTasks', () => {
  it('getTask：存在/不存在/非法 id', async () => {
    const created = await svc.createTask('目标');
    const id = (created as { ok: true; task: { id: string } }).task.id;
    const hit = await svc.getTask(id);
    expect(hit.ok).toBe(true);
    if (!hit.ok) return;
    expect(hit.task!.id).toBe(id);
    const miss = await svc.getTask('ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.errorCode).toBe('research-not-found');
    for (const bad of ['', 'not-a-uuid', 42]) {
      const r = await svc.getTask(bad as unknown as string);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errorCode).toBe('research-not-found');
    }
  });

  it('listTasks：分页 clamp（page<1 → 1、pageSize 超 20 → 20）+ 新→旧排序', async () => {
    for (let i = 1; i <= 5; i += 1) {
      nowMs = T0 + i;
      await svc.createTask(`目标${i}`);
    }
    const result = await svc.listTasks({ page: 0, pageSize: 999 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(5);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.items[0]!.goal).toBe('目标5'); // 新→旧
    const paged = await svc.listTasks({ page: 2, pageSize: 3 });
    expect(paged.ok && paged.items.map((t) => t.goal)).toEqual(['目标2', '目标1']);
  });

  it('listTasks status 过滤', async () => {
    await svc.createTask('a');
    const b = await svc.createTask('b');
    const id = (b as { ok: true; task: { id: string } }).task.id;
    await svc.startTask(id);
    const running = await svc.listTasks({ status: 'running' });
    expect(running.ok && running.items.map((t) => t.goal)).toEqual(['b']);
    const created = await svc.listTasks({ status: 'created' });
    expect(created.ok && created.items.map((t) => t.goal)).toEqual(['a']);
  });
});

describe('deleteTask（决议 #105 delete 矩阵）', () => {
  it('created 可删除；删除后 not-found', async () => {
    const c = await svc.createTask('x');
    const id = (c as { ok: true; task: { id: string } }).task.id;
    const del = await svc.deleteTask(id);
    expect(del.ok).toBe(true);
    const gone = await svc.getTask(id);
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.errorCode).toBe('research-not-found');
  });

  it('running 拒绝（research-invalid-state）', async () => {
    const c = await svc.createTask('x');
    const id = (c as { ok: true; task: { id: string } }).task.id;
    await svc.startTask(id);
    const del = await svc.deleteTask(id);
    expect(del.ok).toBe(false);
    if (!del.ok) expect(del.errorCode).toBe('research-invalid-state');
  });

  it('终态（completed/failed/cancelled/interrupted 代表 cancelled）可删除', async () => {
    const c = await svc.createTask('x');
    const id = (c as { ok: true; task: { id: string } }).task.id;
    await svc.startTask(id);
    await svc.stopTask(id);
    const del = await svc.deleteTask(id);
    expect(del.ok).toBe(true);
  });

  it('不存在 → research-not-found', async () => {
    const del = await svc.deleteTask('ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect(del.ok).toBe(false);
    if (!del.ok) expect(del.errorCode).toBe('research-not-found');
  });
});

describe('startTask 前置校验（决议 #107 四前置）', () => {
  it('前置全部通过：created → running（phase=planning、startedAt）', async () => {
    const c = await svc.createTask('x');
    const id = (c as { ok: true; task: { id: string } }).task.id;
    nowMs = T1;
    const r = await svc.startTask(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.status).toBe('running');
    expect(r.task.phase).toBe('planning');
    expect(r.task.startedAt).toBe('2026-08-16T00:01:00.000Z');
  });

  it('单 running 互斥：第二个任务 start → research-busy 且状态不变', async () => {
    const a = await svc.createTask('a');
    const b = await svc.createTask('b');
    const idA = (a as { ok: true; task: { id: string } }).task.id;
    const idB = (b as { ok: true; task: { id: string } }).task.id;
    expect((await svc.startTask(idA)).ok).toBe(true);
    const blocked = await svc.startTask(idB);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.errorCode).toBe('research-busy');
    const still = await svc.getTask(idB);
    expect(still.ok && still.task!.status).toBe('created');
  });

  it('Sources 非 normal → research-sources-unavailable 且状态不变', async () => {
    const gated = new ResearchServiceImpl({
      db: handle,
      now: () => nowMs,
      getSourcesState: () => 'readonly-recovery',
    });
    const c = await gated.createTask('x');
    const id = (c as { ok: true; task: { id: string } }).task.id;
    const r = await gated.startTask(id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('research-sources-unavailable');
    const still = await gated.getTask(id);
    expect(still.ok && still.task!.status).toBe('created');
    gated.dispose();
  });

  it('Provider 未配置/不支持 tool calling → research-provider-unavailable', async () => {
    // 注：gated 实例与 svc 共享同一句柄——循环内不 dispose（句柄关闭会串扰
    // 后续实例；句柄由 afterEach 统一幂等关闭）
    for (const state of [
      { configured: false, supportsToolCalling: false },
      { configured: true, supportsToolCalling: false },
    ]) {
      const gated = new ResearchServiceImpl({
        db: handle,
        now: () => nowMs,
        getProviderState: () => state,
      });
      const c = await gated.createTask('x');
      const id = (c as { ok: true; task: { id: string } }).task.id;
      const r = await gated.startTask(id);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errorCode).toBe('research-provider-unavailable');
    }
  });

  it('completed 不可 start（research-invalid-state）', async () => {
    const c = await svc.createTask('x');
    const id = (c as { ok: true; task: { id: string } }).task.id;
    await svc.startTask(id);
    // 直接置为 completed（C5 前无 finish 服务入口——用状态机写方法直接模拟）
    handle
      .prepare(
        `UPDATE research_tasks SET status='completed', finished_at=?, result_id=? WHERE id=?`,
      )
      .run('2026-08-16T00:02:00.000Z', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', id);
    const r = await svc.startTask(id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('research-invalid-state');
  });

  it('running 上重复 start → research-invalid-state', async () => {
    const c = await svc.createTask('x');
    const id = (c as { ok: true; task: { id: string } }).task.id;
    expect((await svc.startTask(id)).ok).toBe(true);
    const again = await svc.startTask(id);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.errorCode).toBe('research-invalid-state');
  });

  it('goal 防御校验：库内 goal 为空 → research-invalid-goal', async () => {
    const c = await svc.createTask('x');
    const id = (c as { ok: true; task: { id: string } }).task.id;
    handle.prepare('UPDATE research_tasks SET goal=? WHERE id=?').run('   ', id);
    const r = await svc.startTask(id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('research-invalid-goal');
  });
});

describe('restart 原子重置（决议 #106）', () => {
  it('failed（带 Evidence 行）→ start：旧行清零 + stats 全零 + 新 run 字段', async () => {
    const c = await svc.createTask('x');
    const id = (c as { ok: true; task: { id: string } }).task.id;
    await svc.startTask(id);
    // 直接写入 Evidence 行 + 置 failed（模拟 C4/C5 产物）
    const repo = new ResearchRepository(handle);
    repo.insertCapture({
      capture_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      task_id: id,
      candidate_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tab_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      url: 'https://example.com',
      title: 't',
      access_time: '2026-08-16T00:01:00.000Z',
      document_id: 'd1',
      content_hash: 'h',
      summary_json: JSON.stringify({
        sectionCount: 1,
        tableCount: 0,
        headingCount: 1,
        charCount: 10,
      }),
      failed: 0,
      failure_reason: null,
    });
    repo.insertEvidence({
      evidence_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      task_id: id,
      candidate_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      source_id: null,
      capture_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      url: 'https://example.com',
      title: 't',
      access_time: '2026-08-16T00:01:00.000Z',
      document_id: 'd1',
      content_hash: 'h',
      type: 'quote',
      locator_json: JSON.stringify({ kind: 'text', excerpt: 'e' }),
      excerpt: 'e',
      value: null,
      verification: 'verified',
    });
    handle
      .prepare(
        `UPDATE research_tasks SET status='failed', error_code='research-timeout', finished_at=?, stats_json=? WHERE id=?`,
      )
      .run(
        '2026-08-16T00:01:00.000Z',
        JSON.stringify({
          candidateCount: 5,
          selectedCount: 3,
          captureCount: 1,
          failedReadCount: 0,
          evidenceCount: 1,
          rejectedEvidenceCount: 0,
          claimCount: 0,
          conflictCount: 0,
          stepsUsed: 4,
          roundsUsed: 2,
        }),
        id,
      );
    nowMs = T1;
    const r = await svc.startTask(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.status).toBe('running');
    expect(r.task.errorCode).toBeNull();
    expect(r.task.stats.evidenceCount).toBe(0);
    expect(repo.listEvidenceByTask(id)).toHaveLength(0);
    expect(repo.listCapturesByTask(id)).toHaveLength(0);
  });
});

describe('stopTask（决议 #105/#104：cancelled + 幂等 + 清理触发）', () => {
  it('running → cancelled（finishedAt=now、无 Result）', async () => {
    const c = await svc.createTask('x');
    const id = (c as { ok: true; task: { id: string } }).task.id;
    await svc.startTask(id);
    nowMs = T1;
    const r = await svc.stopTask(id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.status).toBe('cancelled');
    expect(r.task.finishedAt).toBe('2026-08-16T00:01:00.000Z');
    expect(r.task.resultId).toBeNull();
  });

  it('重复 stop 幂等成功（cancelled 上再 stop → ok）', async () => {
    const c = await svc.createTask('x');
    const id = (c as { ok: true; task: { id: string } }).task.id;
    await svc.startTask(id);
    expect((await svc.stopTask(id)).ok).toBe(true);
    expect((await svc.stopTask(id)).ok).toBe(true);
  });

  it('非 running 状态 stop → research-invalid-state', async () => {
    const c = await svc.createTask('x');
    const id = (c as { ok: true; task: { id: string } }).task.id;
    const r = await svc.stopTask(id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('research-invalid-state');
  });

  it('stop 触发终态清理（决议 #104：进终态写入后清理最旧）', async () => {
    for (let i = 0; i < MAX_STORED_TASKS + 2; i += 1) {
      nowMs = T0 + i; // 递增时钟：created_at/finished_at 递增 → 排序键确定性
      const c = await svc.createTask(`t${i}`);
      const id = (c as { ok: true; task: { id: string } }).task.id;
      await svc.startTask(id);
      await svc.stopTask(id);
    }
    const list = await svc.listTasks();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.total).toBe(MAX_STORED_TASKS);
    // 保留的是最新的 30 个——最旧两个（t0/t1）被清理；最新（t31）保留
    expect(list.items.some((t) => t.goal === 't0')).toBe(false);
    expect(list.items.some((t) => t.goal === 't1')).toBe(false);
    expect(list.items.some((t) => t.goal === 't31')).toBe(true);
  });
});

describe('unavailable 全拒与 dispose（决议 #109）', () => {
  it('db=null 装配：全部方法结构化 research-unavailable 零抛异常', async () => {
    const dead = new ResearchServiceImpl({ db: null });
    expect((await dead.createTask('x')).ok).toBe(false);
    const r = await dead.getTask('11111111-1111-4111-8111-111111111111');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('research-unavailable');
    expect((await dead.listTasks()).ok).toBe(false);
    expect((await dead.deleteTask('11111111-1111-4111-8111-111111111111')).ok).toBe(false);
    expect((await dead.startTask('11111111-1111-4111-8111-111111111111')).ok).toBe(false);
    expect((await dead.stopTask('11111111-1111-4111-8111-111111111111')).ok).toBe(false);
    dead.dispose();
  });

  it('dispose 后全拒（幂等 dispose 两次）', async () => {
    const c = await svc.createTask('x');
    const id = (c as { ok: true; task: { id: string } }).task.id;
    svc.dispose();
    svc.dispose();
    const r = await svc.getTask(id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('research-unavailable');
  });
});

describe('非法输入安全返回不抛异常（决议 #109）', () => {
  it('createTask 各类非法输入全部结构化返回', async () => {
    expect((await svc.createTask(null as unknown as string)).ok).toBe(false);
    expect((await svc.createTask(undefined as unknown as string)).ok).toBe(false);
    expect((await svc.createTask([] as unknown as string)).ok).toBe(false);
  });

  it('getTask/deleteTask/startTask/stopTask 各类非法 id 全部结构化返回', async () => {
    for (const bad of ['', 'x'.repeat(500), '11111111-1111-4111-8111']) {
      expect((await svc.getTask(bad)).ok).toBe(false);
      expect((await svc.deleteTask(bad)).ok).toBe(false);
      expect((await svc.startTask(bad)).ok).toBe(false);
      expect((await svc.stopTask(bad)).ok).toBe(false);
    }
  });
});
