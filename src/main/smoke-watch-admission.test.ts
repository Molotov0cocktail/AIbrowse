import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  addWatchSubscriptionDestroyedListener,
  closeAndDrainThenDispose,
  WatchIpcAdmission,
} from './smoke-watch-admission';
import { SourcesIpcAdmission } from './sources/source-ipc';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb } from './sources/db/sqlite-driver';
import { runWatchMigrations } from './watch/db/watch-migrations';
import { WatchLifecycleCoordinator } from './watch/watch-lifecycle-coordinator';
import { WatchRepository } from './watch/repository/watch-repository';

describe('Watch IPC shutdown admission', () => {
  it('Watch subscription destroyed listener 必须可幂等解绑', () => {
    const sender = new EventEmitter();
    const cleanup = addWatchSubscriptionDestroyedListener(sender, () => undefined);
    expect(sender.listenerCount('destroyed')).toBe(1);
    cleanup();
    expect(sender.listenerCount('destroyed')).toBe(0);
    cleanup();
    expect(sender.listenerCount('destroyed')).toBe(0);

    const destroyedCleanup = addWatchSubscriptionDestroyedListener(sender, () => undefined);
    expect(sender.listenerCount('destroyed')).toBe(1);
    sender.emit('destroyed');
    expect(sender.listenerCount('destroyed')).toBe(0);
    destroyedCleanup();
    expect(sender.listenerCount('destroyed')).toBe(0);
  });

  it('shutdown 后拒绝迟到订阅并清空旧 sender', () => {
    const admission = new WatchIpcAdmission();
    const sender = {};
    expect(admission.subscribe(sender)).toBe(true);
    admission.beginShutdown();
    expect(admission.isOpen()).toBe(false);
    expect(admission.currentSender()).toBeNull();
    expect(admission.subscribe(sender)).toBe(false);
  });

  it('shutdown 必须等待已经获准的 Watch IPC 调用排水后再释放 repository', async () => {
    const admission = new WatchIpcAdmission();
    const release = admission.enter();
    expect(release).not.toBeNull();
    admission.beginShutdown();
    let drained = false;
    const pending = admission.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release?.();
    await pending;
    expect(drained).toBe(true);
  });

  it('Sources shutdown 必须等待已经获准的 IPC 调用排水后再释放 repository', async () => {
    const admission = new SourcesIpcAdmission();
    const release = admission.enter();
    expect(release).not.toBeNull();
    admission.beginShutdown();
    let drained = false;
    const pending = admission.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release?.();
    await pending;
    expect(drained).toBe(true);
  });

  it('必须先同时封闭并排水 Sources/Watch，再允许 coordinator 释放 repository', async () => {
    const sources = new SourcesIpcAdmission();
    const watch = new WatchIpcAdmission();
    const sourceRelease = sources.enter();
    const watchRelease = watch.enter();
    const order: string[] = [];
    const shutdown = closeAndDrainThenDispose([sources, watch], async () => {
      order.push('dispose');
    });
    await Promise.resolve();
    expect(sources.isOpen()).toBe(false);
    expect(watch.isOpen()).toBe(false);
    expect(order).toEqual([]);
    sourceRelease?.();
    await Promise.resolve();
    expect(order).toEqual([]);
    watchRelease?.();
    await shutdown;
    expect(order).toEqual(['dispose']);
  });

  it('真实 WatchRepository 必须等 Sources/Watch 在途调用都排水后才释放', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aibrowse-watch-admission-real-'));
    const db = openDb(join(root, 'watch.db'));
    runWatchMigrations(db);
    const repository = new WatchRepository(db);
    const coordinator = new WatchLifecycleCoordinator();
    coordinator.bind(repository, () => ({ status: 'missing' }));
    const sources = new SourcesIpcAdmission();
    const watch = new WatchIpcAdmission();
    const lateSourceOperation = sources.enter();
    const lateWatchOperation = watch.enter();
    const order: string[] = [];
    try {
      const shutdown = closeAndDrainThenDispose([sources, watch], () => {
        order.push('dispose');
        coordinator.dispose();
        repository.dispose();
      });
      await Promise.resolve();
      expect(repository.isDisposed).toBe(false);
      expect(coordinator.getState().mode).toBe('normal');
      lateSourceOperation?.();
      expect(repository.isDisposed).toBe(false);
      lateWatchOperation?.();
      await shutdown;
      expect(order).toEqual(['dispose']);
      expect(repository.isDisposed).toBe(true);
      expect(coordinator.getState().mode).toBe('unavailable');
    } finally {
      if (!repository.isDisposed) repository.dispose();
      closeDb(db);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
