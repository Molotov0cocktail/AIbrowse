// Sixth Stage D4: watch.db driver thin wrapper (detailed-design §1/§10,
// threat-model §3.5). Reuses the frozen connection-level primitives from
// sources/db/sqlite-driver (B1 decision gate, adjudication #48) by import —
// that file is unmodified. Independent database, independent handle per open:
// each openWatchDb call returns its own DbHandle. Zero business SQL here
// (connection-level operational SQL only; business SQL lives exclusively in
// WatchRepository compile-time constants and watch-migrations).
import {
  closeDb as closeSourceDb,
  openDb,
  withTransaction as sourceTransaction,
  type DbHandle,
  type DbOpenOptions,
} from '../../sources/db/sqlite-driver';
import type { QualificationResourceOwner } from '../qualification/registry';

const owners = new WeakMap<
  DbHandle,
  { observer: QualificationResourceOwner; db: string; store: string | null }
>();

export type { DbHandle, DbOpenOptions, DbStatement } from '../../sources/db/sqlite-driver';

// 独立库独立句柄（同 Research 决议 #111 模式）：路径由主进程生成
// （<userData>/watch/watch.db 或冒烟临时目录）
export function openWatchDb(
  path: string,
  options: DbOpenOptions = {},
  observer?: QualificationResourceOwner,
): DbHandle {
  observer?.assertMutable();
  const actual = openDb(path, options);
  if (observer === undefined) return actual;
  const handle: DbHandle = {
    path: actual.path,
    get isOpen() {
      return actual.isOpen;
    },
    prepare: (sql) => {
      const statement = actual.prepare(sql);
      return {
        run: (...params) => {
          observer.assertMutable();
          return statement.run(...params);
        },
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params),
      };
    },
    exec: (sql) => {
      observer.assertMutable();
      actual.exec(sql);
    },
    close: () => {
      observer.assertMutable();
      actual.close();
    },
  };
  if (observer !== undefined) {
    const db = observer.register({ registry: 'watch-db', detail: null });
    owners.set(handle, { observer, db, store: null });
  }
  return handle;
}

export function registerWatchStore(handle: DbHandle): void {
  const owner = owners.get(handle);
  if (owner === undefined) return;
  if (owner.store !== null) throw new Error('资格Store重复发布');
  owner.store = owner.observer.register({ registry: 'watch-store', detail: null });
}

export function closeDb(handle: DbHandle): void {
  const owner = owners.get(handle);
  owner?.observer.assertMutable();
  closeSourceDb(handle);
  if (owner !== undefined) {
    owner.observer.unregister(owner.db);
    if (owner.store !== null) owner.observer.unregister(owner.store);
    owners.delete(handle);
  }
}

export function withTransaction<T>(handle: DbHandle, fn: () => T): T {
  owners.get(handle)?.observer.assertMutable();
  return sourceTransaction(handle, fn);
}
