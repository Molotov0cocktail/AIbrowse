import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, type MigrationStep } from '../sources/db/migrations';
import { RESEARCH_MIGRATIONS } from '../research/db/research-migrations';
import { WATCH_MIGRATIONS, WATCH_MIGRATION_V3 } from '../watch/db/watch-migrations';

export type TransferDatabaseDomain = 'sources' | 'research' | 'watch';
type Variant = 'current' | 'historical-watch-v3';
interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
export type TransferSchemaResult =
  | { ok: true; version: number; variant: Variant }
  | { ok: false; code: 'schema-mismatch' | 'unknown-version' | 'sqlite-error' };
export type TransferSchemaNormalizationResult =
  | { ok: true; fromVersion: number; fromVariant: Variant; version: number }
  | {
      ok: false;
      code: 'schema-mismatch' | 'unknown-version' | 'sqlite-error' | 'migration-failed';
      version?: number;
    };

// Exact legacy D7 definition from 7e17d381d37ce5ee10512a3f9330dbc3a945b54e.
// Later V4/V5 did not rebuild it. This is recognition, never input SQL execution.
const HISTORICAL_BASELINE_V3 = `CREATE TABLE watch_baselines_v3 (
  rule_id TEXT PRIMARY KEY REFERENCES watch_rules(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  projection_type TEXT NOT NULL CHECK (projection_type IN ('feed','page')),
  projection_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0 AND byte_length <= 65536),
  final_url TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  document_id TEXT,
  conditional_etag TEXT,
  conditional_last_modified TEXT
)`;

export function historicalWatchMigrationSteps(): readonly MigrationStep[] {
  return WATCH_MIGRATIONS.map((step) =>
    step.version !== 3
      ? step
      : {
          version: 3,
          statements: step.statements.map((sql) =>
            sql.startsWith('CREATE TABLE watch_baselines_v3 (') ? HISTORICAL_BASELINE_V3 : sql,
          ),
        },
  );
}

const CURRENT: Record<TransferDatabaseDomain, readonly MigrationStep[]> = {
  sources: MIGRATIONS,
  research: RESEARCH_MIGRATIONS,
  watch: WATCH_MIGRATIONS,
};
const CATALOG = 'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name';
const SIZES = `SELECT rowid AS object_id, length(CAST(type AS BLOB)) AS type_bytes,
 length(CAST(name AS BLOB)) AS name_bytes, length(CAST(tbl_name AS BLOB)) AS table_bytes,
 length(CAST(sql AS BLOB)) AS sql_bytes FROM sqlite_schema ORDER BY type, name`;
const OBJECT = 'SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE rowid = ?';
const cache = new Map<string, readonly SchemaObject[]>();

function isObject(raw: Record<string, unknown>): raw is Record<string, unknown> & SchemaObject {
  return (
    typeof raw.type === 'string' &&
    typeof raw.name === 'string' &&
    typeof raw.tbl_name === 'string' &&
    (raw.sql === null || typeof raw.sql === 'string')
  );
}

function expectedSchema(
  domain: TransferDatabaseDomain,
  version: number,
  variant: Variant,
): readonly SchemaObject[] {
  const key = `${domain}:${version}:${variant}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const db = new DatabaseSync(':memory:', { allowExtension: false, defensive: true });
  try {
    const steps = variant === 'current' ? CURRENT[domain] : historicalWatchMigrationSteps();
    for (const step of steps) {
      if (step.version > version) break;
      for (const sql of step.statements) db.exec(sql);
    }
    const rows = db.prepare(CATALOG).all();
    const result = rows.map((row) => {
      if (!isObject(row)) throw new Error('编译期数据库定义无效');
      return Object.freeze({
        type: row.type,
        name: row.name,
        tbl_name: row.tbl_name,
        sql: row.sql,
      });
    });
    cache.set(key, result);
    return result;
  } finally {
    db.close();
  }
}

/** Pure catalogue inspection. The caller owns the isolated connection and its deadline. */
export function validateTransferSchema(
  db: DatabaseSync,
  domain: TransferDatabaseDomain,
): TransferSchemaResult {
  try {
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (
      typeof version !== 'number' ||
      !Number.isSafeInteger(version) ||
      version < 0 ||
      version > CURRENT[domain].length
    )
      return { ok: false, code: 'unknown-version' };
    const candidates: Array<{ variant: Variant; rows: readonly SchemaObject[] }> = [
      { variant: 'current', rows: expectedSchema(domain, version, 'current') },
    ];
    if (domain === 'watch' && version >= 3)
      candidates.push({
        variant: 'historical-watch-v3',
        rows: expectedSchema(domain, version, 'historical-watch-v3'),
      });
    const expected = candidates.flatMap((entry) => entry.rows);
    const limits = {
      type_bytes: Math.max(0, ...expected.map((row) => Buffer.byteLength(row.type))),
      name_bytes: Math.max(0, ...expected.map((row) => Buffer.byteLength(row.name))),
      table_bytes: Math.max(0, ...expected.map((row) => Buffer.byteLength(row.tbl_name))),
      sql_bytes: Math.max(
        0,
        ...expected.map((row) => (row.sql === null ? 0 : Buffer.byteLength(row.sql))),
      ),
    };
    const countLimit = Math.max(...candidates.map((entry) => entry.rows.length));
    const actual: SchemaObject[] = [];
    let statement: ReturnType<DatabaseSync['prepare']> | null = null;
    for (const size of db.prepare(SIZES).iterate()) {
      if (
        actual.length >= countLimit ||
        typeof size.object_id !== 'number' ||
        !Number.isSafeInteger(size.object_id)
      )
        return { ok: false, code: 'schema-mismatch' };
      for (const field of ['type_bytes', 'name_bytes', 'table_bytes', 'sql_bytes'] as const) {
        const value = size[field];
        if (field === 'sql_bytes' && value === null) continue;
        if (
          typeof value !== 'number' ||
          !Number.isSafeInteger(value) ||
          value < 0 ||
          value > limits[field]
        )
          return { ok: false, code: 'schema-mismatch' };
      }
      statement ??= db.prepare(OBJECT);
      const row = statement.get(size.object_id);
      if (row === undefined || !isObject(row)) return { ok: false, code: 'schema-mismatch' };
      actual.push({ type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql });
    }
    for (const candidate of candidates) {
      if (
        candidate.rows.length === actual.length &&
        candidate.rows.every((row, i) => {
          const other = actual[i]!;
          return (
            row.type === other.type &&
            row.name === other.name &&
            row.tbl_name === other.tbl_name &&
            row.sql === other.sql
          );
        })
      )
        return { ok: true, version, variant: candidate.variant };
    }
    return { ok: false, code: 'schema-mismatch' };
  } catch {
    return { ok: false, code: 'sqlite-error' };
  }
}

const BASELINE_CREATE = WATCH_MIGRATION_V3.statements.find((sql) =>
  sql.startsWith('CREATE TABLE watch_baselines_v3 ('),
);
const NORMALIZE_BASELINE = [
  `INSERT INTO watch_baselines_v3 (rule_id, version, projection_type, projection_json,
  content_hash, byte_length, final_url, captured_at, document_id, conditional_etag, conditional_last_modified)
  SELECT rule_id, version, projection_type, projection_json,
  content_hash, byte_length, final_url, captured_at, document_id, conditional_etag, conditional_last_modified
  FROM watch_baselines`,
  'DROP TABLE watch_baselines',
  'ALTER TABLE watch_baselines_v3 RENAME TO watch_baselines',
] as const;

/** Caller must supply a private staging database, never the original or a live handle.
 * Only compiled migrations run here. Success covers schema, not business validation.
 * Each step commits independently; a later failure preserves earlier committed steps.
 */
export function normalizeTransferSchema(
  staging: DatabaseSync,
  domain: TransferDatabaseDomain,
): TransferSchemaNormalizationResult {
  const before = validateTransferSchema(staging, domain);
  if (!before.ok) return before;
  let version = before.version;
  let transactionOwned = false;
  const step = (statements: readonly string[], targetVersion?: number): void => {
    staging.exec('BEGIN IMMEDIATE');
    transactionOwned = true;
    for (const sql of statements) staging.exec(sql);
    if (staging.prepare('PRAGMA foreign_key_check').get() !== undefined)
      throw new Error('暂存数据库外键无效');
    // targetVersion is selected exclusively from the compiled migration list.
    if (targetVersion !== undefined) staging.exec(`PRAGMA user_version = ${targetVersion}`);
    staging.exec('COMMIT');
    transactionOwned = false;
    if (targetVersion !== undefined) version = targetVersion;
  };
  try {
    staging.exec('PRAGMA foreign_keys = ON');
    if (staging.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1)
      return { ok: false, code: 'migration-failed', version };
    for (const migration of CURRENT[domain]) {
      if (migration.version > version) step(migration.statements, migration.version);
    }
    if (domain === 'watch' && before.variant === 'historical-watch-v3') {
      if (BASELINE_CREATE === undefined) throw new Error('编译期数据库定义无效');
      step([BASELINE_CREATE, ...NORMALIZE_BASELINE]);
    }
    const after = validateTransferSchema(staging, domain);
    if (!after.ok || after.variant !== 'current' || after.version !== CURRENT[domain].length)
      return { ok: false, code: 'migration-failed', version };
    return { ok: true, fromVersion: before.version, fromVariant: before.variant, version };
  } catch {
    if (transactionOwned) {
      try {
        staging.exec('ROLLBACK');
      } catch {
        /* Caller retains failed staging and disposes the handle. */
      }
    }
    return { ok: false, code: 'migration-failed', version };
  }
}
