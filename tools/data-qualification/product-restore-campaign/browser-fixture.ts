import { lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BROWSER_MIGRATIONS } from '../../../src/main/browser-library/browser-library-migrations';
import { validateBrowserLibraryTransfer } from '../../../src/main/browser-library/browser-library-repository';
import { validateTransferSchema } from '../../../src/main/storage/transfer-schema';
import {
  createSmallFixture,
  id,
  STAMP,
  LATER,
  LIMIT,
  type Variant,
} from '../product-restore-fixtures/seed';
import { snapshotHashes, verifySmallFixture, type Mode } from '../product-restore-fixtures/oracle';
import { need } from './contract';

function expected(variant: Variant) {
  const url = `https://example.invalid/library-${variant}/?query=retained#fragment`;
  return {
    history: [
      { id: id(variant, 11000), url, title: `历史${variant}一`, visited_at: STAMP },
      { id: id(variant, 11001), url, title: `历史${variant}二`, visited_at: LATER },
    ],
    bookmarks: [
      {
        id: id(variant, 11002),
        url,
        title: `书签${variant}`,
        created_at: STAMP,
        updated_at: LATER,
      },
    ],
  };
}

/** Extend the historical three-database oracle without rewriting its evidence. */
export function createCampaignFixture(root: string, variant: Variant): void {
  createSmallFixture(root, variant);
  mkdirSync(join(root, 'browser'));
  const db = new DatabaseSync(join(root, 'browser/browser.db'));
  try {
    for (const step of BROWSER_MIGRATIONS) {
      for (const sql of step.statements) db.exec(sql);
      db.exec(`PRAGMA user_version=${step.version}`);
    }
    const rows = expected(variant);
    for (const row of rows.history)
      db.prepare('INSERT INTO browser_history VALUES(?,?,?,?)').run(
        row.id,
        row.url,
        row.title,
        row.visited_at,
      );
    for (const row of rows.bookmarks)
      db.prepare(
        'INSERT INTO browser_bookmarks(id,url,title,created_at,updated_at) VALUES(?,?,?,?,?)',
      ).run(row.id, row.url, row.title, row.created_at, row.updated_at);
  } finally {
    db.close();
  }
}

export function verifyCampaignFixture(root: string, variant: Variant, mode: Mode) {
  const legacy = verifySmallFixture(root, variant, mode);
  const path = join(root, 'browser/browser.db');
  const stat = lstatSync(path);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= LIMIT);
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    need(validateTransferSchema(db, 'browser').ok && validateBrowserLibraryTransfer(db).ok);
    const actual = {
      history: db.prepare('SELECT id,url,title,visited_at FROM browser_history ORDER BY id').all(),
      bookmarks: db
        .prepare('SELECT id,url,title,created_at,updated_at FROM browser_bookmarks ORDER BY id')
        .all(),
    };
    need(
      JSON.stringify(actual) === JSON.stringify(expected(variant)),
      '浏览资料未保持固定历史及书签集合',
    );
    return {
      bytes: legacy.bytes + stat.size,
      legacyBytes: legacy.bytes,
      browserBytes: stat.size,
      hashes: { ...legacy.hashes, ...snapshotHashes({ browser: actual }) },
    };
  } finally {
    db.close();
  }
}
