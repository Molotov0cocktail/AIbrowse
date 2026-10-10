import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { openDb, closeDb } from '../sources/db/sqlite-driver';
import { runResearchMigrations } from './db/research-migrations';
import { ResearchRepository } from './repository/research-repository';
import { ResearchServiceImpl } from './research-service';
import type {
  ResearchPreparedLaunchResult,
  ResearchRuntimeLaunchInput,
} from '../../shared/types/research';

const root = mkdtempSync(join(tmpdir(), 'research-maintenance-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function database() {
  const db = openDb(join(root, `${crypto.randomUUID()}.db`));
  runResearchMigrations(db);
  return db;
}

describe('Research 维护真实排水', () => {
  it('prepare保持准入关闭，shutdown作废已准备的恢复许可', async () => {
    const service = new ResearchServiceImpl({ db: database() });
    service.pauseForMaintenance(1);
    await service.drainForMaintenance(1);
    expect(service.resumeAfterMaintenance(1)).toBe(false);
    expect(service.prepareResumeAfterMaintenance(2)).toBe(false);
    expect(service.prepareResumeAfterMaintenance(1)).toBe(true);
    expect(await service.createTask('不准入')).toEqual({
      ok: false,
      errorCode: 'research-unavailable',
    });
    await service.shutdown();
    expect(service.resumeAfterMaintenance(1)).toBe(false);
    expect(service.prepareResumeAfterMaintenance(1)).toBe(false);
  });
  it('等待原始Provider解析，释放迟到prepared且零launch，并按世代恢复', async () => {
    const db = database();
    const pending = deferred<ResearchPreparedLaunchResult>();
    const service = new ResearchServiceImpl({
      db,
      runtimeFactory: { resolveProvider: () => pending.promise },
    });
    const task = await service.createTask('合成研究');
    if (!task.ok) throw new Error('夹具失败');
    const starting = service.startTask(task.task.id);
    expect(service.pauseForMaintenance(1)).toBe(true);
    let drained = false;
    const drain = service.drainForMaintenance(1).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(service.resumeAfterMaintenance(1)).toBe(false);
    expect(await service.createTask('不准入')).toEqual({
      ok: false,
      errorCode: 'research-unavailable',
    });
    expect(await service.listTasks()).toEqual({ ok: false, errorCode: 'research-unavailable' });
    const release = vi.fn();
    const launch = vi.fn(() => {
      throw new Error('禁止迟到启动');
    });
    pending.resolve({ ok: true, prepared: { release, launch } });
    expect(await starting).toEqual({ ok: false, errorCode: 'research-unavailable' });
    await drain;
    expect(release).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
    expect(new ResearchRepository(db).getTaskById(task.task.id)?.status).toBe('created');
    expect(service.resumeAfterMaintenance(2)).toBe(false);
    expect(service.resumeAfterMaintenance(1)).toBe(false);
    expect(service.prepareResumeAfterMaintenance(1)).toBe(true);
    expect(service.resumeAfterMaintenance(1)).toBe(true);
    expect(service.pauseForMaintenance(1)).toBe(false);
    await service.shutdown();
  });

  it('提前onSettle不能绕过done，终态持久化完成之前不关库', async () => {
    const db = database();
    const pending = deferred<void>();
    let input!: ResearchRuntimeLaunchInput;
    const abort = vi.fn();
    const service = new ResearchServiceImpl({
      db,
      runtimeFactory: {
        resolveProvider: async () => ({
          ok: true,
          prepared: {
            release() {},
            launch(value) {
              input = value;
              return { ...value, done: pending.promise, abort };
            },
          },
        }),
      },
    });
    const task = await service.createTask('合成研究');
    if (!task.ok) throw new Error('夹具失败');
    await service.startTask(task.task.id);
    input.onSettle();
    expect(service.pauseForMaintenance(5)).toBe(true);
    let drained = false;
    const drain = service.drainForMaintenance(5).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(abort).toHaveBeenCalled();
    expect(drained).toBe(false);
    expect(new ResearchRepository(db).getTaskById(task.task.id)?.status).toBe('running');
    pending.resolve();
    await drain;
    expect(service.resumeAfterMaintenance(5)).toBe(false);
    expect(service.prepareResumeAfterMaintenance(5)).toBe(true);
    expect(service.resumeAfterMaintenance(5)).toBe(true);
    await service.shutdown();
  });

  it('清理失败阻止排水和关库，不把失败done当作已释放', async () => {
    const db = database();
    const pending = deferred<void>();
    const service = new ResearchServiceImpl({
      db,
      runtimeFactory: {
        resolveProvider: async () => ({
          ok: true,
          prepared: {
            release() {},
            launch(value) {
              return { ...value, done: pending.promise, abort() {} };
            },
          },
        }),
      },
    });
    const task = await service.createTask('合成研究');
    if (!task.ok) throw new Error('夹具失败');
    await service.startTask(task.task.id);
    service.pauseForMaintenance(1);
    const drain = service.drainForMaintenance(1);
    pending.reject(new Error('任务标签页清理失败'));
    await expect(drain).rejects.toThrow();
    expect(service.resumeAfterMaintenance(1)).toBe(false);
    await expect(service.shutdown()).rejects.toThrow();
    expect(new ResearchRepository(db).getTaskById(task.task.id)).not.toBeNull();
    closeDb(db);
  });
});
