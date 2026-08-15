// C1 research-store tests: startup assembly matrix (detailed-design §9.2,
// adjudications #109/#111) — probe → migration → checks → normal | unavailable
// (two-state; no backup/recovery for research v1). Covers: fresh DB migration
// v1, current-version reopen, bad magic, future version (zero writes),
// migration failure (original preserved), check failure, unavailable
// all-reject (service null), leftover running tasks atomically marked
// interrupted, and idempotent handle close via dispose.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { MigrationStep } from '../sources/db/migrations';
import { openResearchStore } from './research-store';
import { RESEARCH_MIGRATION_V1 } from './db/research-migrations';
import type { ResearchService } from '../../shared/types/research';
import { MAX_STORED_TASKS } from '../../shared/types/research';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-research-store-'));
const T0 = '2026-08-16T00:00:00.000Z';

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function readVersion(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

const GOOD_STATS = JSON.stringify({
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
});

function makeSeededDb(path: string, status: string): void {
  // 合法 v1 库（产品 migration 全表集——决议 #113 投影预算检查需读全部子表；
  // 夹具校准：真实 v1 库恒为 7 表集）+ 指定状态的任务行（模拟上次进程遗留；
  // stats_json 为完整形状）
  const db = new DatabaseSync(path);
  for (const statement of RESEARCH_MIGRATION_V1.statements) {
    db.exec(statement);
  }
  db.exec('PRAGMA user_version = 1');
  db.prepare(
    `INSERT INTO research_tasks (id, goal, status, phase, created_at, updated_at, started_at, stats_json)
  VALUES ('11111111-1111-4111-8111-111111111111', '遗留任务', ?, ?, ?, ?, ?, ?)`,
  ).run(status, status === 'running' ? 'reading' : null, T0, T0, T0, GOOD_STATS);
  db.close();
}

const BAD_MIGRATIONS: readonly MigrationStep[] = [
  { version: 1, statements: ['CREATE TABLE research_tasks (id TEXT PRIMARY KEY)'] },
  { version: 2, statements: ['THIS IS NOT VALID SQL'] },
];

describe('research-store 装配矩阵（normal | unavailable 两态）', () => {
  it('新库：迁移 v1 + normal + service 可用', () => {
    const outcome = openResearchStore({ dbPath: join(root, 'fresh.db') });
    expect(outcome.mode).toBe('normal');
    expect(outcome.reason).toBeNull();
    expect(outcome.service).not.toBeNull();
    expect(readVersion(join(root, 'fresh.db'))).toBe(1);
    outcome.service!.dispose();
  });

  it('当前版本库重新打开：normal', () => {
    const path = join(root, 'current.db');
    const first = openResearchStore({ dbPath: path });
    first.service!.dispose();
    const second = openResearchStore({ dbPath: path });
    expect(second.mode).toBe('normal');
    second.service!.dispose();
  });

  it('坏 magic：unavailable + service null + 原文件保留', () => {
    const path = join(root, 'badmagic.db');
    writeFileSync(path, 'This is definitely not a SQLite file at all.');
    const outcome = openResearchStore({ dbPath: path });
    expect(outcome.mode).toBe('unavailable');
    expect(outcome.service).toBeNull();
    expect(outcome.reason!.length).toBeGreaterThan(0);
    expect(readFileSync(path, 'utf8')).toBe('This is definitely not a SQLite file at all.');
  });

  it('未来版本：unavailable + 零写入（原库字节不变）', () => {
    const path = join(root, 'future.db');
    makeSeededDb(path, 'created');
    const before = createHash('sha256').update(readFileSync(path)).digest('hex');
    // 提升到未来版本
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 2');
    db.close();
    const seeded = readFileSync(path);
    const outcome = openResearchStore({ dbPath: path });
    expect(outcome.mode).toBe('unavailable');
    expect(outcome.service).toBeNull();
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(
      createHash('sha256').update(seeded).digest('hex'),
    );
    expect(before).not.toBe(createHash('sha256').update(seeded).digest('hex')); // 夹具自检：版本已变
  });

  it('迁移失败：unavailable + 原库保留', () => {
    const path = join(root, 'migfail.db');
    makeSeededDb(path, 'created');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 0');
    db.close();
    const before = readFileSync(path);
    const outcome = openResearchStore({ dbPath: path, migrations: BAD_MIGRATIONS });
    expect(outcome.mode).toBe('unavailable');
    expect(outcome.service).toBeNull();
    // 原库保留（未被迁移事务改写——user_version 仍为 0、遗留数据仍在）
    expect(readVersion(path)).toBe(0);
    expect(readFileSync(path).length).toBe(before.length);
  });

  it('非文件路径（目录形态）：unavailable', () => {
    const dir = join(root, 'adir');
    mkdirSync(dir);
    const outcome = openResearchStore({ dbPath: dir });
    expect(outcome.mode).toBe('unavailable');
    expect(outcome.service).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('注入 nowMs 时钟：interrupted 标记时间确定性', async () => {
    const path = join(root, 'clock.db');
    makeSeededDb(path, 'running');
    const outcome = openResearchStore({
      dbPath: path,
      nowMs: () => Date.UTC(2026, 7, 16, 12, 0, 0),
    });
    expect(outcome.mode).toBe('normal');
    const result = await outcome.service!.getTask('11111111-1111-4111-8111-111111111111');
    expect(result.ok && result.task!.interruptedAt).toBe('2026-08-16T12:00:00.000Z');
    outcome.service!.dispose();
  });
});

describe('遗留 running → interrupted（原子、phase 置 null、不自动续跑）', () => {
  it('running 任务在装配后被标 interrupted（interruptedAt=now、phase=null）', async () => {
    const path = join(root, 'leftover.db');
    makeSeededDb(path, 'running');
    const outcome = openResearchStore({
      dbPath: path,
      nowMs: () => Date.UTC(2026, 7, 16, 9, 30, 0),
    });
    expect(outcome.mode).toBe('normal');
    const result = await outcome.service!.getTask('11111111-1111-4111-8111-111111111111');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task!.status).toBe('interrupted');
    expect(result.task!.phase).toBeNull();
    expect(result.task!.interruptedAt).toBe('2026-08-16T09:30:00.000Z');
    expect(result.task!.finishedAt).toBeNull();
    outcome.service!.dispose();
  });

  it('非 running 任务（created/completed）不被误标', async () => {
    const path = join(root, 'created.db');
    makeSeededDb(path, 'created');
    const outcome = openResearchStore({ dbPath: path });
    const result = await outcome.service!.getTask('11111111-1111-4111-8111-111111111111');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task!.status).toBe('created');
    expect(result.task!.interruptedAt).toBeNull();
    outcome.service!.dispose();
  });

  it('多任务：仅 running 被标 interrupted', async () => {
    const path = join(root, 'multi.db');
    makeSeededDb(path, 'created');
    const db = new DatabaseSync(path);
    db.prepare(
      `INSERT INTO research_tasks (id, goal, status, phase, created_at, updated_at, started_at, stats_json)
  VALUES ('22222222-2222-4222-8222-222222222222', '第二个', 'running', 'planning', ?, ?, ?, ?)`,
    ).run(T0, T0, T0, GOOD_STATS);
    db.close();
    const outcome = openResearchStore({
      dbPath: path,
      nowMs: () => Date.UTC(2026, 7, 16, 10, 0, 0),
    });
    const svc = outcome.service!;
    const first = await svc.getTask('11111111-1111-4111-8111-111111111111');
    const second = await svc.getTask('22222222-2222-4222-8222-222222222222');
    expect(first.ok && first.task!.status).toBe('created');
    expect(second.ok && second.task!.status).toBe('interrupted');
    svc.dispose();
  });
});

describe('启动装配总数硬上限（决议 #112：overflowRemaining 不得静默忽略）', () => {
  // 用产品迁移生成合法 v1 库后直接种入 N 行任务（模拟外部/遗留状态）
  function seedTasks(path: string, rows: Array<{ status: string; finishedAt?: string }>): void {
    const first = openResearchStore({ dbPath: path });
    expect(first.mode).toBe('normal');
    first.service!.dispose();
    const db = new DatabaseSync(path);
    try {
      const ins = db.prepare(
        `INSERT INTO research_tasks (id, goal, status, phase, created_at, updated_at, started_at, finished_at, stats_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let i = 0; i < rows.length; i += 1) {
        const id = `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`;
        ins.run(
          id,
          `任务${i}`,
          rows[i]!.status,
          rows[i]!.status === 'running' ? 'planning' : null,
          T0,
          T0,
          T0,
          rows[i]!.finishedAt ?? null,
          GOOD_STATS,
        );
      }
    } finally {
      db.close();
    }
  }

  function countRows(path: string): number {
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      return (probe.prepare('SELECT COUNT(*) AS n FROM research_tasks').get() as { n: number }).n;
    } finally {
      probe.close();
    }
  }

  it('31 个 created + 零可清理终态 → unavailable（不静默忽略溢出、created 零删除）', () => {
    const path = join(root, 'overflow-created.db');
    seedTasks(
      path,
      Array.from({ length: MAX_STORED_TASKS + 1 }, () => ({ status: 'created' })),
    );
    const outcome = openResearchStore({ dbPath: path });
    outcome.service?.dispose(); // 绿态 service=null；红态（历史缺陷形态）防御性关闭
    expect(outcome.mode).toBe('unavailable');
    expect(outcome.service).toBeNull();
    expect(outcome.reason!.length).toBeGreaterThan(0);
    expect(outcome.reason).toContain('上限'); // 中文诊断定位根因
    // created 任务零删除：库内仍为 31 行
    expect(countRows(path)).toBe(MAX_STORED_TASKS + 1);
  });

  it('31 个含 1 个终态：清理最旧终态后 normal（30 行、created 保留）', () => {
    const path = join(root, 'overflow-finished.db');
    const rows: Array<{ status: string; finishedAt?: string }> = Array.from(
      { length: MAX_STORED_TASKS },
      () => ({ status: 'created' }),
    );
    rows.push({ status: 'completed', finishedAt: '2026-08-16T00:02:00.000Z' });
    seedTasks(path, rows);
    const outcome = openResearchStore({ dbPath: path });
    expect(outcome.mode).toBe('normal');
    expect(outcome.service).not.toBeNull();
    outcome.service!.dispose();
    expect(countRows(path)).toBe(MAX_STORED_TASKS);
    // 唯一终态已被清理；created 全部保留
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      const created = probe
        .prepare("SELECT COUNT(*) AS n FROM research_tasks WHERE status = 'created'")
        .get() as { n: number };
      expect(created.n).toBe(MAX_STORED_TASKS);
    } finally {
      probe.close();
    }
  });

  it('31 个全 running：标记 interrupted 后可清理 → normal（30 行）', () => {
    const path = join(root, 'overflow-running.db');
    seedTasks(
      path,
      Array.from({ length: MAX_STORED_TASKS + 1 }, () => ({ status: 'running' })),
    );
    const outcome = openResearchStore({ dbPath: path });
    expect(outcome.mode).toBe('normal');
    expect(outcome.service).not.toBeNull();
    outcome.service!.dispose();
    // 标记后全部可清理：清理最旧 1 个 → 30 行、无 running 残留
    expect(countRows(path)).toBe(MAX_STORED_TASKS);
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      const running = probe
        .prepare("SELECT COUNT(*) AS n FROM research_tasks WHERE status = 'running'")
        .get() as { n: number };
      expect(running.n).toBe(0);
    } finally {
      probe.close();
    }
  });
});

describe('unavailable 全拒与句柄幂等关闭（决议 #109）', () => {
  it('dispose 幂等：两次调用不抛、句柄关闭后方法全拒', async () => {
    const path = join(root, 'dispose.db');
    const outcome = openResearchStore({ dbPath: path });
    const svc = outcome.service as ResearchService;
    svc.dispose();
    svc.dispose();
    const created = await svc.createTask('目标');
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.errorCode).toBe('research-unavailable');
  });
});

describe('store 装配后基本读写回路（真实持久化跨句柄）', () => {
  it('create → dispose → 重开 → getTask 读回', async () => {
    const path = join(root, 'roundtrip.db');
    const first = openResearchStore({ dbPath: path });
    const created = await first.service!.createTask('持久化回路目标');
    expect(created.ok).toBe(true);
    first.service!.dispose();
    const second = openResearchStore({ dbPath: path });
    expect(second.mode).toBe('normal');
    const result = await second.service!.getTask(
      (created as { ok: true; task: { id: string } }).task.id,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task!.goal).toBe('持久化回路目标');
    expect(result.task!.status).toBe('created');
    second.service!.dispose();
  });

  it('existsSync 辅助断言：临时库文件生成于指定路径', () => {
    const path = join(root, 'exists.db');
    const outcome = openResearchStore({ dbPath: path });
    expect(existsSync(path)).toBe(true);
    outcome.service!.dispose();
  });
});
