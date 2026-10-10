import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDb, closeDb } from './db/sqlite-driver';
import { runMigrations } from './db/migrations';
import { runWatchMigrations } from '../watch/db/watch-migrations';
import { SourceServiceImpl } from './source-service';
import { WatchRepository } from '../watch/repository/watch-repository';
import { WatchLifecycleCoordinator } from '../watch/watch-lifecycle-coordinator';

it('生产者排水后seal Source，协调端口仅在同维护世代读旧库并闭合持久intent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aibrowse-source-maintenance-'));
  const sourceDb = openDb(join(root, 'sources.db'));
  const watchDb = openDb(join(root, 'watch.db'));
  runMigrations(sourceDb);
  runWatchMigrations(watchDb);
  const repository = new WatchRepository(watchDb);
  const lifecycle = new WatchLifecycleCoordinator();
  const service = new SourceServiceImpl({
    db: sourceDb,
    observer: {
      prepare: (changes) => lifecycle.prepare(changes),
      commit: () => ({ ok: true }),
      abort: (ids) => lifecycle.abort(ids),
    },
  });
  lifecycle.bind(repository, (id) => service.getSourceWatchProjection(id));
  try {
    const added = await service.addManual({ scope: 'page', url: 'https://example.com/' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const token = service.issueDeleteConfirmToken(added.source.id);
    expect(repository.listSourceCleanupIntents().some((row) => row.state === 'prepared')).toBe(
      true,
    );
    expect(service.sealForMaintenance(1)).toBe(true);
    expect(
      await service.addManual({ scope: 'page', url: 'https://example.com/late' }),
    ).toMatchObject({ ok: false, errorCode: 'source-unavailable' });
    expect(service.getSourceWatchProjection(added.source.id)).toEqual({ status: 'unavailable' });
    expect(service.getSourceWatchProjectionForMaintenance(added.source.id, 2)).toEqual({
      status: 'unavailable',
    });
    expect(
      lifecycle.reconcileForMaintenance((id) =>
        service.getSourceWatchProjectionForMaintenance(id, 1),
      ),
    ).toMatchObject({ ok: true });
    expect(repository.listSourceCleanupIntents()).toEqual([]);
    expect(sourceDb.isOpen).toBe(true);
    expect(service.resumeAfterMaintenance(1)).toBe(false);
    expect(service.prepareResumeAfterMaintenance(1)).toBe(true);
    expect(service.resumeAfterMaintenance(1)).toBe(true);
    expect(await service.hardDeleteManual(added.source.id, token)).toMatchObject({ ok: false });
    expect((await service.get(added.source.id, 'user')).ok).toBe(true);
    expect(service.sealForMaintenance(1)).toBe(false);
  } finally {
    lifecycle.dispose();
    service.dispose();
    repository.dispose();
    closeDb(watchDb);
    rmSync(root, { recursive: true, force: true });
  }
});

it('维护协调读取unavailable不能变成missing或删除未决intent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aibrowse-source-maintenance-failure-'));
  const db = openDb(join(root, 'watch.db'));
  runWatchMigrations(db);
  const repository = new WatchRepository(db);
  const lifecycle = new WatchLifecycleCoordinator();
  lifecycle.bind(repository, () => ({ status: 'missing' }));
  const id = '00000000-0000-4000-8000-000000000001';
  const mutationId = '00000000-0000-4000-8000-000000000002';
  try {
    expect(
      lifecycle.prepare([
        {
          mutationId,
          operation: 'create',
          before: null,
          after: {
            sourceId: id,
            rowVersion: 1,
            enabled: true,
            deletedAt: null,
            scope: 'page',
            canonicalKey: 'https://example.com/',
          },
        },
      ]).ok,
    ).toBe(true);
    expect(lifecycle.reconcileForMaintenance(() => ({ status: 'unavailable' })).ok).toBe(false);
    expect(repository.listSourceCleanupIntents()).toHaveLength(1);
    expect(repository.listSourceCleanupIntents()[0]?.state).toBe('prepared');
    expect(lifecycle.getState().mode).toBe('unavailable');
  } finally {
    lifecycle.dispose();
    repository.dispose();
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});
