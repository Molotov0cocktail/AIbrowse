// Sixth Stage D4: watch.db driver thin wrapper (detailed-design §1/§10,
// threat-model §3.5). Reuses the frozen connection-level primitives from
// sources/db/sqlite-driver (B1 decision gate, adjudication #48) by import —
// that file is unmodified. Independent database, independent handle per open:
// each openWatchDb call returns its own DbHandle. Zero business SQL here
// (connection-level operational SQL only; business SQL lives exclusively in
// WatchRepository compile-time constants and watch-migrations).
import { openDb, type DbHandle, type DbOpenOptions } from '../../sources/db/sqlite-driver';

export type { DbHandle, DbOpenOptions, DbStatement } from '../../sources/db/sqlite-driver';

// 独立库独立句柄（同 Research 决议 #111 模式）：路径由主进程生成
// （<userData>/watch/watch.db 或冒烟临时目录）
export function openWatchDb(path: string, options: DbOpenOptions = {}): DbHandle {
  return openDb(path, options);
}

export { closeDb, withTransaction } from '../../sources/db/sqlite-driver';
