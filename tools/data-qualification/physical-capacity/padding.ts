import type { DatabaseSync } from 'node:sqlite';

export interface PaddingProof {
  targetBytes: number;
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  bulkSteps: number;
  tailSteps: number;
  sqliteVersion: string;
}
const MAX_BYTES = 512 * 1024 ** 2;
const BLOB_BYTES = 8 * 1024 ** 2;
const RESERVE_PAGES = 16;
const BULK = 'aibrowse_qualification_bulk';
const TAIL = 'aibrowse_qualification_tail';
const SCHEMA = 'SELECT name,type,tbl_name,sql FROM sqlite_schema ORDER BY name';
function need(value: unknown): asserts value {
  if (!value) throw new Error('固定SQLite物理夹具不满足精确页数约束，保留现场');
}

/** Only a caller-owned synthetic COPY may be supplied. No successful proof is emitted on failure. */
export function padPrivateFixture(
  db: DatabaseSync,
  targetBytes: number,
  check: () => void,
): PaddingProof {
  const step = <T>(work: () => T): T => {
    check();
    const result = work();
    check();
    return result;
  };
  const integer = (sql: string, key: string): number => {
    const value = step(() => db.prepare(sql).get()?.[key]);
    need(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
    return value;
  };
  need(Number.isSafeInteger(targetBytes) && targetBytes > 0 && targetBytes <= MAX_BYTES);
  need(db.isOpen && !db.isTransaction);
  const pageSize = integer('PRAGMA page_size', 'page_size');
  need(pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0);
  need(targetBytes % pageSize === 0);
  const targetPages = targetBytes / pageSize;
  const originalPages = integer('PRAGMA page_count', 'page_count');
  need(originalPages <= targetPages);
  need(integer('PRAGMA auto_vacuum', 'auto_vacuum') === 0);
  const originalSchema = JSON.stringify(step(() => db.prepare(SCHEMA).all()));
  const originalVersion = integer('PRAGMA user_version', 'user_version');
  need(
    step(() => db.prepare('SELECT name FROM sqlite_schema WHERE name IN (?, ?)').all(BULK, TAIL))
      .length === 0,
  );
  const sqliteVersion = step(() => db.prepare('SELECT sqlite_version() AS version').get()?.version);
  need(typeof sqliteVersion === 'string');
  let bulkSteps = 0;
  let tailSteps = 0;
  const available = (): number => {
    const pages = integer('PRAGMA page_count', 'page_count');
    const free = integer('PRAGMA freelist_count', 'freelist_count');
    need(pages <= targetPages && free <= pages);
    return targetPages - pages + free;
  };
  if (originalPages !== targetPages) {
    // Fixed bounded integer derived from the closed capacity range, never caller SQL.
    need(integer(`PRAGMA max_page_count=${targetPages}`, 'max_page_count') === targetPages);
    need(available() >= 4);
    try {
      step(() => db.exec('BEGIN IMMEDIATE'));
      step(() => db.exec('CREATE TABLE aibrowse_qualification_bulk(payload BLOB NOT NULL)'));
      step(() => db.exec('CREATE TABLE aibrowse_qualification_tail(payload BLOB NOT NULL)'));
      step(() => db.exec('INSERT INTO aibrowse_qualification_tail VALUES(zeroblob(0))'));
      const insert = step(() =>
        db.prepare('INSERT INTO aibrowse_qualification_bulk VALUES(zeroblob(?))'),
      );
      const overflowBytes = pageSize - 4;
      let free = available();
      while (free > RESERVE_PAGES) {
        need(bulkSteps < 512);
        const pages = Math.min(free - RESERVE_PAGES, Math.floor(BLOB_BYTES / overflowBytes));
        need(pages > 0);
        step(() => insert.run(pages * overflowBytes));
        bulkSteps++;
        const next = available();
        need(next < free);
        free = next;
      }
      if (free > 0) {
        // A single-row, separate leaf keeps its local cell in the existing root.
        // Each overflow page carries page_size-4 bytes; qualify this once, never search payloads.
        need(free * overflowBytes <= BLOB_BYTES);
        step(() =>
          db
            .prepare('UPDATE aibrowse_qualification_tail SET payload=zeroblob(?)')
            .run(free * overflowBytes),
        );
        tailSteps++;
      }
      need(available() === 0);
      need(integer('PRAGMA page_count', 'page_count') === targetPages);
      step(() =>
        db.exec('DROP TABLE aibrowse_qualification_bulk; DROP TABLE aibrowse_qualification_tail'),
      );
      step(() => db.exec('COMMIT'));
    } catch (error) {
      // Settle this owned transaction; retain the database file and original failure.
      if (db.isTransaction) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* The caller retains the unclosed handle and failed file. */
        }
      }
      throw error;
    }
  }
  need(JSON.stringify(step(() => db.prepare(SCHEMA).all())) === originalSchema);
  need(integer('PRAGMA user_version', 'user_version') === originalVersion);
  const integrity = step(() => db.prepare('PRAGMA integrity_check').all());
  need(integrity.length === 1 && integrity[0].integrity_check === 'ok');
  need(step(() => db.prepare('PRAGMA foreign_key_check').get()) === undefined);
  const pageCount = integer('PRAGMA page_count', 'page_count');
  need(pageCount === targetPages);
  return {
    targetBytes,
    pageSize,
    pageCount,
    freelistCount: integer('PRAGMA freelist_count', 'freelist_count'),
    bulkSteps,
    tailSteps,
    sqliteVersion,
  };
}
