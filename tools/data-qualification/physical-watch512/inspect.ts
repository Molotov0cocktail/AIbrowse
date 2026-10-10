import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validateWatchTransferDatabase } from '../../../src/main/watch/repository/watch-transfer-validation';
import { validateTransferSchema } from '../../../src/main/storage/transfer-schema';
import type { Check } from '../full-transfer/io';
import { need } from './contract';

// Every business table has a fixed query. Include rowids where SQLite owns them;
// the composite-key WITHOUT ROWID table has its own deterministic order.
const DATA_QUERIES = [
  'SELECT rowid AS qualification_rowid,* FROM watch_rules ORDER BY id',
  'SELECT rowid AS qualification_rowid,* FROM watch_baselines ORDER BY rule_id',
  'SELECT rowid AS qualification_rowid,* FROM watch_runs ORDER BY id',
  'SELECT rowid AS qualification_rowid,* FROM watch_audits ORDER BY id',
  'SELECT rowid AS qualification_rowid,* FROM watch_events ORDER BY id',
  'SELECT rowid AS qualification_rowid,* FROM watch_event_observations ORDER BY id',
  'SELECT rowid AS qualification_rowid,* FROM watch_event_items ORDER BY id',
  'SELECT rowid AS qualification_rowid,* FROM source_cleanup_intents ORDER BY mutation_id',
  'SELECT rowid AS qualification_rowid,* FROM digest_change_state ORDER BY id',
  'SELECT rowid AS qualification_rowid,* FROM digest_change_journal ORDER BY sequence',
  'SELECT rowid AS qualification_rowid,* FROM digest_schedules ORDER BY id',
  'SELECT rowid AS qualification_rowid,* FROM digest_runs ORDER BY id',
  'SELECT rowid AS qualification_rowid,* FROM watch_digests ORDER BY id',
  'SELECT * FROM digest_event_refs ORDER BY digest_id,event_id',
  'SELECT rowid AS qualification_rowid,* FROM notification_outbox ORDER BY id',
] as const;

/** Read-only facts before/after padding and from the independent SQLite backup. */
export function inspectWatch(db: DatabaseSync, check: Check) {
  check();
  const schema = validateTransferSchema(db, 'watch');
  need(schema.ok && schema.variant === 'current');
  check();
  const semantic = validateWatchTransferDatabase(db);
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
