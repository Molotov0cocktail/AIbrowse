import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const STAGING_DATABASE_LIMITS = {
  sources: 512 * 1024 * 1024,
  research: 64 * 1024 * 1024,
  watch: 512 * 1024 * 1024,
} as const;
export type StagingDatabaseDomain = keyof typeof STAGING_DATABASE_LIMITS;

export interface StagingSqliteSettings {
  sqliteVersion: string;
  sqliteSourceId: string;
  compileOptions: string[];
  pageSize: number;
  maxPageCount: number;
  journalMode: 'memory';
  tempStore: 2;
  trustedSchema: 0;
  foreignKeys: 1;
  cacheSize: -8192;
  memoryStatusDefault: 0 | 1 | 'unknown';
  heapEnforcement: 'not-guaranteed';
}

/**
 * Only an already-created, exclusively owned private COPY may enter this API.
 * The caller proves directory ownership and excludes concurrent writers. These
 * file checks are rejection checks, not a sandbox or proof of provenance.
 * MEMORY journals make a killed/crashed copy unusable: retain it as evidence;
 * never publish it, resume it, or apply these settings to an original/live DB.
 * This profile provides no heap/RSS/OS memory cap. Compile-time memory accounting
 * is reported as a build fact, not proof of runtime accounting or enforcement.
 */
export function openPrivateStagingDatabase(
  stagingPath: string,
  domain: StagingDatabaseDomain,
): { db: DatabaseSync; settings: StagingSqliteSettings } {
  const limit = STAGING_DATABASE_LIMITS[domain];
  if (!isAbsolute(stagingPath) || !Number.isSafeInteger(limit))
    throw new Error('暂存数据库参数无效');
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(stagingPath);
  } catch {
    throw new Error('暂存数据库文件无法核验');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit)
    throw new Error('暂存数据库文件不符合独立副本或容量要求');
  // Imported snapshots must be self-contained. Never consume an adjacent WAL.
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      lstatSync(`${stagingPath}${suffix}`);
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw new Error('暂存数据库附属文件无法核验', { cause: error });
    }
    throw new Error('暂存数据库存在未封闭的附属文件');
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(stagingPath, {
      allowExtension: false,
      defensive: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      timeout: 0,
    });
    // Values are compile-time constants or integers derived from fixed caps.
    const compileOptions = db
      .prepare('PRAGMA compile_options')
      .all()
      .map((row) => {
        if (typeof row.compile_options !== 'string') throw new Error('SQLite编译选项无效');
        return row.compile_options;
      });
    if (compileOptions.includes('TEMP_STORE=0'))
      throw new Error('SQLite编译选项不支持所需内存临时存储');
    db.exec(`PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA journal_mode = MEMORY;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -8192;`);
    const pageSize = db.prepare('PRAGMA page_size').get()?.page_size;
    if (
      typeof pageSize !== 'number' ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 512 ||
      pageSize > 65536 ||
      (pageSize & (pageSize - 1)) !== 0
    )
      throw new Error('暂存数据库页大小无效');
    const maxPageCount = Math.floor(limit / pageSize);
    db.exec(`PRAGMA max_page_count = ${maxPageCount}`);
    const expected = {
      journal_mode: 'memory',
      temp_store: 2,
      trusted_schema: 0,
      foreign_keys: 1,
      cache_size: -8192,
      max_page_count: maxPageCount,
    } as const;
    for (const [name, value] of Object.entries(expected)) {
      if (db.prepare(`PRAGMA ${name}`).get()?.[name] !== value)
        throw new Error('暂存数据库安全配置回读不一致');
    }
    const identity = db
      .prepare('SELECT sqlite_version() AS version, sqlite_source_id() AS source')
      .get();
    if (typeof identity?.version !== 'string' || typeof identity.source !== 'string')
      throw new Error('SQLite版本无法确认');
    return {
      db,
      settings: {
        sqliteVersion: identity.version,
        sqliteSourceId: identity.source,
        compileOptions,
        pageSize,
        maxPageCount,
        journalMode: 'memory',
        tempStore: 2,
        trustedSchema: 0,
        foreignKeys: 1,
        cacheSize: -8192,
        memoryStatusDefault: compileOptions.includes('DEFAULT_MEMSTATUS=0')
          ? 0
          : compileOptions.includes('DEFAULT_MEMSTATUS=1')
            ? 1
            : 'unknown',
        heapEnforcement: 'not-guaranteed',
      },
    };
  } catch {
    try {
      db?.close();
    } catch {
      /* The owning utility must terminate; retain its copy. */
    }
    throw new Error('暂存数据库安全配置失败，副本已保留');
  }
}
