import { closeSync, openSync, readdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileFact, same, type Check } from '../full-transfer/io';
import { need } from './contract';
import { createJournalGuard, type JournalProof } from './journal';

/** The caller owns this closed synthetic source and the fresh target directory. */
export async function backupOwnedFixture(
  source: string,
  target: string,
  bytes: number,
  check: Check,
): Promise<JournalProof> {
  check();
  need(source !== target && Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 512 * 1024 ** 2);
  const noSidecars = (path: string) => {
    const siblings = readdirSync(dirname(path));
    need(
      !['-wal', '-shm', '-journal'].some((suffix) => siblings.includes(basename(path) + suffix)),
    );
  };
  noSidecars(source);
  noSidecars(target);
  const original = fileFact(source);
  need(Number(original.size) === bytes);
  const fd = openSync(target, 'wx');
  closeSync(fd);
  const reserved = fileFact(target);
  const journal = createJournalGuard(source, target, bytes);
  journal.observe();
  const db = new DatabaseSync(source, {
    readOnly: true,
    allowExtension: false,
    defensive: true,
    timeout: 0,
  });
  try {
    const pageSize = db.prepare('PRAGMA page_size').get()?.page_size;
    need(
      typeof pageSize === 'number' &&
        Number.isSafeInteger(pageSize) &&
        pageSize >= 512 &&
        pageSize <= 65536,
    );
    await backup(db, target, {
      rate: 64,
      progress: ({ totalPages }) => {
        check();
        journal.observe();
        need(
          Number.isSafeInteger(totalPages) && totalPages >= 0 && totalPages * pageSize === bytes,
        );
      },
    });
  } finally {
    db.close();
  }
  check();
  const actual = fileFact(target);
  need(actual.dev === reserved.dev && actual.ino === reserved.ino && Number(actual.size) === bytes);
  need(same(original, fileFact(source)));
  noSidecars(source);
  noSidecars(target);
  return journal.finish();
}
