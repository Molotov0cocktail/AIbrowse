// Fifth Stage C1: research.db driver thin wrapper (detailed-design §1/§9.2,
// adjudication #111). Reuses the frozen connection-level primitives from
// sources/db/sqlite-driver (B1 decision gate, adjudication #48) by import —
// that file is unmodified. Independent database, independent handle per open:
// each openResearchDb call returns its own DbHandle. Zero business SQL here
// (connection-level operational SQL only; business SQL lives exclusively in
// ResearchRepository compile-time constants and migrations).
import { openDb, type DbHandle, type DbOpenOptions } from '../../sources/db/sqlite-driver';

export type { DbHandle, DbOpenOptions, DbStatement } from '../../sources/db/sqlite-driver';

// 独立库独立句柄（决议 #111）：路径由主进程生成（<userData>/research/research.db 或冒烟临时目录）
export function openResearchDb(path: string, options: DbOpenOptions = {}): DbHandle {
  return openDb(path, options);
}

export { closeDb, withTransaction } from '../../sources/db/sqlite-driver';
