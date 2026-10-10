import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validateSourceTransfer } from '../../../src/main/sources/repository/source-transfer-validation';
import { validateTransferSchema } from '../../../src/main/storage/transfer-schema';
import type { Check } from '../full-transfer/io';
import { need } from './contract';

// The production scanner validates rows first. Stable, closed queries then
// bind every business value, including complete journal run/tool identifiers.
const DATA_QUERIES = [
  'SELECT rowid,* FROM sources ORDER BY id',
  'SELECT * FROM source_groups ORDER BY id',
  'SELECT * FROM source_tags ORDER BY id',
  'SELECT * FROM source_tag_links ORDER BY source_id,tag_id',
  'SELECT * FROM change_journal ORDER BY idempotency_key',
  'SELECT * FROM usage_events ORDER BY source_id',
] as const;

/** No writes: used before padding, after padding and on the independent backup. */
export function inspectSources(db: DatabaseSync, check: Check) {
  check();
  const schema = validateTransferSchema(db, 'sources');
  need(schema.ok && schema.variant === 'current');
  check();
  const semantic = validateSourceTransfer(db);
  need(semantic.ok);
  check();
  const digest = createHash('sha256');
  for (const sql of DATA_QUERIES) {
    digest.update(JSON.stringify(sql) + '\n');
    for (const row of db.prepare(sql).iterate()) {
      check();
      digest.update(JSON.stringify(row) + '\n');
    }
  }
  const objects = db
    .prepare('SELECT name,type,tbl_name,sql FROM sqlite_schema ORDER BY name')
    .all();
  const integrity = db.prepare('PRAGMA integrity_check').all();
  need(integrity.length === 1 && integrity[0].integrity_check === 'ok');
  need(db.prepare('PRAGMA foreign_key_check').get() === undefined);
  const integer = (sql: string, key: string): number => {
    check();
    const value = db.prepare(sql).get()?.[key];
    need(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
    return value;
  };
  const result = {
    schemaSha256: createHash('sha256').update(JSON.stringify(objects)).digest('hex'),
    dataSha256: digest.digest('hex'),
    userVersion: integer('PRAGMA user_version', 'user_version'),
    pageSize: integer('PRAGMA page_size', 'page_size'),
    pageCount: integer('PRAGMA page_count', 'page_count'),
    freelistCount: integer('PRAGMA freelist_count', 'freelist_count'),
    semantic,
  };
  need(result.pageCount >= result.freelistCount);
  check();
  return result;
}
