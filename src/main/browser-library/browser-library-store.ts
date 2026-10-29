import { validateBrowserLibraryTransfer } from './browser-library-repository';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { probeDbFile } from '../sources/db/backup';
import { runMigrations } from '../sources/db/migrations';
import { requireVerifiedTransferHandle, type DbHandle } from '../sources/db/sqlite-driver';
import { validateTransferSchema } from '../storage/transfer-schema';
import { BROWSER_MIGRATIONS } from './browser-library-migrations';
import { BrowserLibraryService } from './browser-library-service';

export interface BrowserLibraryStoreOptions {
  dbPath: string;
}
export type BrowserLibraryStoreOutcome =
  | { mode: 'normal'; service: BrowserLibraryService; reason: null }
  | { mode: 'unavailable'; service: null; reason: string };

function unavailable(): BrowserLibraryStoreOutcome {
  return {
    mode: 'unavailable',
    service: null,
    reason: '浏览历史与书签数据库无法安全打开，原件已保留',
  };
}

export function assembleVerifiedTransferBrowserLibraryStore(
  options: BrowserLibraryStoreOptions,
  handle: DbHandle,
): BrowserLibraryStoreOutcome {
  try {
    requireVerifiedTransferHandle(handle, options.dbPath);
    return { mode: 'normal', service: new BrowserLibraryService(handle), reason: null };
  } catch {
    handle.close();
    return unavailable();
  }
}

export function openBrowserLibraryStore(
  options: BrowserLibraryStoreOptions,
): BrowserLibraryStoreOutcome {
  let database: DatabaseSync | null = null;
  try {
    if (!isAbsolute(options.dbPath)) return unavailable();
    let missing = false;
    try {
      const stat = lstatSync(options.dbPath);
      const actual = realpathSync.native(options.dbPath);
      const expected = resolve(options.dbPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (process.platform === 'win32'
          ? actual.toLowerCase() !== expected.toLowerCase()
          : actual !== expected)
      )
        return unavailable();
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        return unavailable();
      missing = true;
    }
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try {
        const stat = lstatSync(options.dbPath + suffix);
        if (missing || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          return unavailable();
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
          return unavailable();
      }
    }
    const probe = probeDbFile(options.dbPath);
    if (
      probe.state !== 'missing' &&
      (probe.state !== 'ok' ||
        probe.userVersion === null ||
        probe.userVersion < 0 ||
        probe.userVersion > BROWSER_MIGRATIONS.length)
    )
      return unavailable();
    if (probe.state === 'ok') {
      const readonly = new DatabaseSync(options.dbPath, {
        readOnly: true,
        allowExtension: false,
        defensive: true,
        timeout: 0,
      });
      try {
        readonly.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
        if (
          !validateTransferSchema(readonly, 'browser').ok ||
          readonly.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok' ||
          (probe.userVersion === 1 && !validateBrowserLibraryTransfer(readonly, 1).ok)
        )
          return unavailable();
      } finally {
        readonly.close();
      }
    }
    mkdirSync(dirname(options.dbPath), { recursive: true });
    database = new DatabaseSync(options.dbPath, {
      allowExtension: false,
      defensive: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      timeout: 0,
    });
    database.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL;');
    const db = database;
    const handle: DbHandle = {
      path: options.dbPath,
      get isOpen() {
        return db.isOpen;
      },
      prepare: (sql) => db.prepare(sql),
      exec: (sql) => db.exec(sql),
      close: () => {
        if (db.isOpen) db.close();
      },
    };
    runMigrations(handle, BROWSER_MIGRATIONS);
    return { mode: 'normal', service: new BrowserLibraryService(handle), reason: null };
  } catch {
    database?.close();
    return unavailable();
  }
}
