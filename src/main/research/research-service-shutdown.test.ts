import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, expect, it, vi } from 'vitest';
import { openDb, closeDb } from '../sources/db/sqlite-driver';
import { runResearchMigrations } from './db/research-migrations';
import { ResearchServiceImpl } from './research-service';
import { ResearchRepository } from './repository/research-repository';
import type { ResearchPreparedLaunchResult } from '../../shared/types/research';

const root = mkdtempSync(join(tmpdir(), 'research-shutdown-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function database() {
  const db = openDb(join(root, `${crypto.randomUUID()}.db`));
  runResearchMigrations(db);
  return db;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it('begin只封闭准入，drain真实退出后数据库仍打开，最终shutdown才关闭', async () => {
  const db = database();
  const work = deferred<void>();
  let nestedDrain: Promise<void> | undefined;
  const abort = vi.fn(() => {
    if (nestedDrain === undefined) {
      nestedDrain = Promise.resolve();
      nestedDrain = service.drainBeforeClose();
    }
  });
  const service = new ResearchServiceImpl({
    db,
    runtimeFactory: {
      resolveProvider: async () => ({
        ok: true,
        prepared: {
          release() {},
          launch(input) {
            return { ...input, abort, done: work.promise };
          },
        },
      }),
    },
  });
  const created = await service.createTask('合成退出');
  if (!created.ok) throw new Error('夹具失败');
  await service.startTask(created.task.id);
  service.beginShutdown();
  service.beginShutdown();
  expect(abort).not.toHaveBeenCalled();
  expect(db.isOpen).toBe(true);
  expect(await service.createTask('禁止准入')).toEqual({
    ok: false,
    errorCode: 'research-unavailable',
  });
  const drain = service.drainBeforeClose();
  expect(nestedDrain).toBe(drain);
  expect(service.drainBeforeClose()).toBe(drain);
  expect(abort).toHaveBeenCalledOnce();
  let drained = false;
  void drain.then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(new ResearchRepository(db).getTaskById(created.task.id)?.status).toBe('running');
  const now = new Date().toISOString();
  new ResearchRepository(db).setTaskCancelled(created.task.id, {
    finishedAt: now,
    updatedAt: now,
    stats: created.task.stats,
  });
  work.resolve();
  await drain;
  expect(db.isOpen).toBe(true);
  expect(new ResearchRepository(db).getTaskById(created.task.id)?.status).toBe('cancelled');
  const closing = service.shutdown();
  expect(service.shutdown()).toBe(closing);
  await closing;
  expect(db.isOpen).toBe(false);
});

it('drainBeforeClose等待迟到原始Provider解析并release，零launch且不关库', async () => {
  const db = database();
  const provider = deferred<ResearchPreparedLaunchResult>();
  const service = new ResearchServiceImpl({
    db,
    runtimeFactory: { resolveProvider: () => provider.promise },
  });
  const task = await service.createTask('合成退出');
  if (!task.ok) throw new Error('夹具失败');
  const starting = service.startTask(task.task.id);
  const drain = service.drainBeforeClose();
  let drained = false;
  void drain.then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  const release = vi.fn();
  const launch = vi.fn(() => {
    throw new Error('禁止迟到启动');
  });
  provider.resolve({ ok: true, prepared: { release, launch } });
  expect(await starting).toEqual({ ok: false, errorCode: 'research-unavailable' });
  await drain;
  expect(release).toHaveBeenCalledOnce();
  expect(launch).not.toHaveBeenCalled();
  expect(db.isOpen).toBe(true);
  await service.shutdown();
});

it('排水失败保持数据库打开，最终shutdown同样拒绝关闭', async () => {
  const db = database();
  const work = deferred<void>();
  const service = new ResearchServiceImpl({
    db,
    runtimeFactory: {
      resolveProvider: async () => ({
        ok: true,
        prepared: {
          release() {},
          launch(input) {
            return { ...input, abort() {}, done: work.promise };
          },
        },
      }),
    },
  });
  const task = await service.createTask('合成退出');
  if (!task.ok) throw new Error('夹具失败');
  await service.startTask(task.task.id);
  const drain = service.drainBeforeClose();
  work.reject(new Error('合成持久化失败'));
  await expect(drain).rejects.toThrow();
  await expect(service.shutdown()).rejects.toThrow();
  expect(db.isOpen).toBe(true);
  closeDb(db);
});

it('维护已prepare后begin永久作废恢复许可，但不提前关闭DB', async () => {
  const db = database();
  const service = new ResearchServiceImpl({ db });
  service.pauseForMaintenance(1);
  await service.drainForMaintenance(1);
  expect(service.prepareResumeAfterMaintenance(1)).toBe(true);
  service.beginShutdown();
  expect(service.prepareResumeAfterMaintenance(1)).toBe(false);
  expect(service.resumeAfterMaintenance(1)).toBe(false);
  expect(service.pauseForMaintenance(2)).toBe(false);
  await service.drainBeforeClose();
  expect(db.isOpen).toBe(true);
  await service.shutdown();
});
