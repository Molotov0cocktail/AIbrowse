// Stage 7: deterministic business-row scan. The caller owns schema checking,
// a stable read-only connection, physical limits, and staging provenance.
// FTS is derived data: business success always requires a subsequent rebuild
// and integrity check on private staging before accepting the complete member.
import type { DatabaseSync } from 'node:sqlite';
import {
  CHANGE_SET_MAX_OPS,
  SOURCE_NAME_MAX_LENGTH,
  SOURCE_NOTE_MAX_LENGTH,
  SOURCE_TAG_MAX_LENGTH,
  SOURCE_TAGS_MAX_COUNT,
  SOURCE_GROUP_NAME_MAX_LENGTH,
  SOURCE_PRIORITY_MIN,
  SOURCE_PRIORITY_MAX,
  isUuidShape,
  stripControlChars,
} from '../domain/source-change-set';
import {
  normalizeSourceUrl,
  containsUrlControlChar,
  SOURCE_URL_MAX_LENGTH,
} from '../domain/source-canonical';
import { JOURNAL_MAX_ENTRIES } from './change-journal';
import type { SourceRow } from './source-repository';
import { JsonReadError, parseBoundedJson } from '../../storage/bounded-json';

export const SOURCE_TRANSFER_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const SOURCE_TRANSFER_RESULT_BYTES = 64 * 1024;
export const SOURCE_TRANSFER_IDS_BYTES = 4 * 1024;
const JSON_DEPTH = 16;
const JSON_NODES = 131072;
// SQL checks return only fixed scalars before any business values cross into JS.
// Text budgets are necessary UTF8 bounds: at most 3 bytes per UTF16 unit;
// serialized URLs use the existing 2048-input limit times 9 percent-encoding.
const PREFLIGHT: readonly [Table, string, string, readonly number[]][] = [
  [
    'sources',
    `SELECT 1 FROM sources WHERE typeof(id) <> 'text'
      OR typeof(scope) <> 'text'
      OR typeof(canonical_key) <> 'text'
      OR typeof(url) <> 'text'
      OR typeof(name) <> 'text'
      OR typeof(group_id) NOT IN ('text','null')
      OR typeof(priority) <> 'integer'
      OR typeof(enabled) <> 'integer'
      OR typeof(share_mode) <> 'text'
      OR typeof(trust_value) <> 'text'
      OR typeof(trust_asserted_by) <> 'text'
      OR typeof(trust_verification) <> 'text'
      OR typeof(user_note) <> 'text'
      OR typeof(ai_note) <> 'text'
      OR typeof(created_by) <> 'text'
      OR typeof(version) <> 'integer'
      OR typeof(created_at) <> 'text'
      OR typeof(updated_at) <> 'text'
      OR typeof(deleted_at) NOT IN ('text','null')
      OR typeof(last_used_at) NOT IN ('text','null')
      OR typeof(last_usage_outcome) NOT IN ('text','null') LIMIT 1`,
    `SELECT 1 FROM sources WHERE length(CAST(id AS BLOB)) > ?
      OR length(CAST(scope AS BLOB)) > ?
      OR length(CAST(canonical_key AS BLOB)) > ?
      OR length(CAST(url AS BLOB)) > ?
      OR length(CAST(name AS BLOB)) > ?
      OR length(CAST(group_id AS BLOB)) > ?
      OR length(CAST(share_mode AS BLOB)) > ?
      OR length(CAST(trust_value AS BLOB)) > ?
      OR length(CAST(trust_asserted_by AS BLOB)) > ?
      OR length(CAST(trust_verification AS BLOB)) > ?
      OR length(CAST(user_note AS BLOB)) > ?
      OR length(CAST(ai_note AS BLOB)) > ?
      OR length(CAST(created_by AS BLOB)) > ?
      OR length(CAST(created_at AS BLOB)) > ?
      OR length(CAST(updated_at AS BLOB)) > ?
      OR length(CAST(deleted_at AS BLOB)) > ?
      OR length(CAST(last_used_at AS BLOB)) > ?
      OR length(CAST(last_usage_outcome AS BLOB)) > ? LIMIT 1`,
    [36, 6, 18432, 18432, 600, 36, 8, 9, 4, 10, 6000, 6000, 4, 27, 27, 27, 27, 13],
  ],
  [
    'groups',
    `SELECT 1 FROM source_groups WHERE typeof(id) <> 'text'
      OR typeof(name) <> 'text'
      OR typeof(created_at) <> 'text'
      OR typeof(deleted_at) NOT IN ('text','null') LIMIT 1`,
    `SELECT 1 FROM source_groups WHERE length(CAST(id AS BLOB)) > ?
      OR length(CAST(name AS BLOB)) > ?
      OR length(CAST(created_at AS BLOB)) > ?
      OR length(CAST(deleted_at AS BLOB)) > ? LIMIT 1`,
    [36, 192, 27, 27],
  ],
  [
    'tags',
    `SELECT 1 FROM source_tags WHERE typeof(id) <> 'text'
      OR typeof(name) <> 'text'
      OR typeof(created_at) <> 'text' LIMIT 1`,
    `SELECT 1 FROM source_tags WHERE length(CAST(id AS BLOB)) > ?
      OR length(CAST(name AS BLOB)) > ?
      OR length(CAST(created_at AS BLOB)) > ? LIMIT 1`,
    [36, 96, 27],
  ],
  [
    'tagLinks',
    `SELECT 1 FROM source_tag_links WHERE typeof(source_id) <> 'text'
      OR typeof(tag_id) <> 'text' LIMIT 1`,
    `SELECT 1 FROM source_tag_links WHERE length(CAST(source_id AS BLOB)) > ?
      OR length(CAST(tag_id AS BLOB)) > ? LIMIT 1`,
    [36, 36],
  ],
  [
    'journal',
    `SELECT 1 FROM change_journal WHERE typeof(idempotency_key) <> 'text'
      OR typeof(run_id) NOT IN ('text','null')
      OR typeof(tool_call_id) NOT IN ('text','null')
      OR typeof(change_type) <> 'text'
      OR typeof(before_payload) <> 'text'
      OR typeof(after_payload) <> 'text'
      OR typeof(source_ids) <> 'text'
      OR typeof(request_fingerprint) NOT IN ('text','null')
      OR typeof(result_payload) NOT IN ('text','null')
      OR typeof(applied_at) <> 'text' LIMIT 1`,
    `SELECT 1 FROM change_journal WHERE length(CAST(idempotency_key AS BLOB)) > ?
      OR length(CAST(change_type AS BLOB)) > ?
      OR length(CAST(before_payload AS BLOB)) > ?
      OR length(CAST(after_payload AS BLOB)) > ?
      OR length(CAST(source_ids AS BLOB)) > ?
      OR length(CAST(request_fingerprint AS BLOB)) > ?
      OR length(CAST(result_payload AS BLOB)) > ?
      OR length(CAST(applied_at AS BLOB)) > ? LIMIT 1`,
    [36, 16, 2097152, 2097152, 4096, 64, 65536, 27],
  ],
  [
    'usage',
    `SELECT 1 FROM usage_events WHERE typeof(source_id) <> 'text'
      OR typeof(outcome) <> 'text'
      OR typeof(recorded_at) <> 'text' LIMIT 1`,
    `SELECT 1 FROM usage_events WHERE length(CAST(source_id AS BLOB)) > ?
      OR length(CAST(outcome AS BLOB)) > ?
      OR length(CAST(recorded_at AS BLOB)) > ? LIMIT 1`,
    [36, 13, 27],
  ],
];
const QUERIES = {
  sources: 'SELECT * FROM sources',
  groups: 'SELECT * FROM source_groups',
  tags: 'SELECT * FROM source_tags',
  tagLinks: 'SELECT * FROM source_tag_links',
  // Old run/tool IDs have no length cap. Only their null/nonempty state is
  // needed here, so their potentially large bodies never cross into JS.
  journal: `SELECT idempotency_key,
    CASE WHEN run_id IS NULL THEN NULL WHEN length(CAST(run_id AS BLOB))=0 THEN '' ELSE 'present' END AS run_id,
    CASE WHEN tool_call_id IS NULL THEN NULL WHEN length(CAST(tool_call_id AS BLOB))=0 THEN '' ELSE 'present' END AS tool_call_id,
    change_type, before_payload, after_payload, source_ids, request_fingerprint, result_payload, applied_at
    FROM change_journal`,
  usage: 'SELECT * FROM usage_events',
} as const;
const SOURCE_BY_ID = 'SELECT * FROM sources WHERE id=?';
const GROUP_BY_ID = 'SELECT id FROM source_groups WHERE id=?';
const TAG_BY_ID = 'SELECT id FROM source_tags WHERE id=?';
const LINKS_BY_SOURCE = 'SELECT tag_id FROM source_tag_links WHERE source_id=?';
const USAGE_BY_SOURCE = 'SELECT * FROM usage_events WHERE source_id=?';
type Table = keyof typeof QUERIES;
type Code =
  'row-invalid' | 'json-invalid' | 'reference-invalid' | 'budget-exceeded' | 'sqlite-error';
export type SourceTransferValidationResult =
  | { ok: true; counts: Record<Table, number>; fts: 'rebuild-required' }
  | { ok: false; code: Code; table: Table };
export type SourceIndexNormalizationResult =
  { ok: true; sourceCount: number } | { ok: false; code: 'fts-invalid' };
class Invalid extends Error {
  constructor(readonly code: Code) {
    super(code);
  }
}
function check(condition: unknown, code: Code = 'row-invalid'): asserts condition {
  if (!condition) throw new Invalid(code);
}
type Predicate = (value: unknown) => boolean;
const record: Predicate = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const text: Predicate = (v) => typeof v === 'string';
const nonempty: Predicate = (v) => typeof v === 'string' && v.length > 0;
const nullable =
  (predicate: Predicate): Predicate =>
  (v) =>
    v === null || predicate(v);
const oneOf =
  (values: readonly unknown[]): Predicate =>
  (v) =>
    values.includes(v);
const positive: Predicate = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const bounded =
  (max: number, min = 0): Predicate =>
  (v) =>
    typeof v === 'string' && v.length >= min && v.length <= max;
const normalized =
  (max: number): Predicate =>
  (v) =>
    bounded(max, 1)(v) &&
    stripControlChars(v as string)
      .normalize('NFC')
      .trim() === v;
const note: Predicate = (v) =>
  bounded(SOURCE_NOTE_MAX_LENGTH)(v) && stripControlChars(v as string) === v;
const outcome = oneOf(['unknown', 'reachable', 'unreachable', 'auth-required', 'blocked']);
function fields(value: unknown, shape: Record<string, Predicate>): boolean {
  if (!record(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === Object.keys(shape).length &&
    Object.entries(shape).every(
      ([key, predicate]) => Object.hasOwn(row, key) && predicate(row[key]),
    )
  );
}
// Sources writes use Date.toISOString. Do not borrow the runtime input URL
// limit for already serialized URLs: Unicode percent-encoding may expand it.
const iso: Predicate = (v) => {
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) return false;
  return new Date(v).toISOString() === v;
};
const SOURCE_SHAPE: Record<string, Predicate> = {
  id: isUuidShape,
  scope: oneOf(['origin', 'page']),
  canonical_key: nonempty,
  url: nonempty,
  name: normalized(SOURCE_NAME_MAX_LENGTH),
  group_id: nullable(isUuidShape),
  priority: (v) =>
    positive(v) && (v as number) >= SOURCE_PRIORITY_MIN && (v as number) <= SOURCE_PRIORITY_MAX,
  enabled: oneOf([0, 1]),
  share_mode: oneOf(['full', 'metadata', 'blocked']),
  trust_value: oneOf(['official', 'primary', 'secondary', 'community', 'unknown']),
  trust_asserted_by: oneOf(['user', 'ai']),
  trust_verification: oneOf(['asserted', 'unverified']),
  user_note: note,
  ai_note: note,
  created_by: oneOf(['user', 'ai']),
  version: positive,
  created_at: iso,
  updated_at: iso,
  deleted_at: nullable(iso),
  last_used_at: nullable(iso),
  last_usage_outcome: nullable(outcome),
};
const SHAPES: Record<Table, Record<string, Predicate>> = {
  sources: SOURCE_SHAPE,
  groups: {
    id: isUuidShape,
    name: normalized(SOURCE_GROUP_NAME_MAX_LENGTH),
    created_at: iso,
    deleted_at: nullable(iso),
  },
  tags: { id: isUuidShape, name: normalized(SOURCE_TAG_MAX_LENGTH), created_at: iso },
  tagLinks: { source_id: isUuidShape, tag_id: isUuidShape },
  usage: { source_id: isUuidShape, outcome, recorded_at: iso },
  journal: {
    idempotency_key: isUuidShape,
    run_id: nullable(nonempty),
    tool_call_id: nullable(nonempty),
    change_type: oneOf(['manual', 'agent-change-set']),
    before_payload: text,
    after_payload: text,
    source_ids: text,
    request_fingerprint: nullable((v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)),
    result_payload: nullable(text),
    applied_at: iso,
  },
};
function json(value: unknown, bytes: number): unknown {
  check(typeof value === 'string', 'json-invalid');
  try {
    return parseBoundedJson(value, { bytes, depth: JSON_DEPTH, nodes: JSON_NODES });
  } catch (error) {
    throw new Invalid(
      error instanceof JsonReadError && error.code === 'budget-exceeded'
        ? 'budget-exceeded'
        : 'json-invalid',
    );
  }
}
function source(value: unknown): SourceRow {
  check(fields(value, SOURCE_SHAPE));
  const row = value as SourceRow;
  check((row.enabled === 0) === (row.deleted_at !== null));
  check((row.last_used_at === null) === (row.last_usage_outcome === null));
  check(
    row.trust_asserted_by === 'ai'
      ? row.trust_verification === 'unverified'
      : row.trust_verification === 'asserted',
  );
  if (row.url.length <= SOURCE_URL_MAX_LENGTH) {
    const normal = normalizeSourceUrl(row.url, row.scope);
    check(normal.ok && normal.canonicalKey === row.canonical_key && normal.displayUrl === row.url);
  } else {
    // Recompute the same identity without reapplying the pre-normalization
    // input limit. No new persisted URL bound was present in earlier versions.
    check(!containsUrlControlChar(row.url));
    let parsed: URL;
    try {
      parsed = new URL(row.url);
    } catch {
      throw new Invalid('row-invalid');
    }
    check(
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.username === '' &&
        parsed.password === '' &&
        parsed.href === row.url,
    );
    let canonical = parsed.origin;
    if (row.scope === 'page') {
      parsed.hash = '';
      canonical = parsed.href;
    }
    check(canonical === row.canonical_key);
  }
  return row;
}
interface Snapshot {
  row: SourceRow | null;
  tags: string[];
}
function snapshots(raw: unknown, ids: string[]): Record<string, Snapshot> {
  const parsed = json(raw, SOURCE_TRANSFER_SNAPSHOT_BYTES);
  check(record(parsed), 'json-invalid');
  const values = parsed as Record<string, unknown>;
  check(
    Object.keys(values).length === ids.length &&
      Object.keys(values).every((id) => ids.includes(id)),
    'reference-invalid',
  );
  const result: Record<string, Snapshot> = Object.create(null) as Record<string, Snapshot>;
  for (const id of ids) {
    const snapshot = values[id];
    check(
      fields(snapshot, {
        row: (v) => v === null || record(v),
        tags: (v) =>
          Array.isArray(v) &&
          v.length <= SOURCE_TAGS_MAX_COUNT &&
          v.every(normalized(SOURCE_TAG_MAX_LENGTH)) &&
          new Set(v).size === v.length,
      }),
      'json-invalid',
    );
    const value = snapshot as { row: unknown; tags: string[] };
    const row = value.row === null ? null : source(value.row);
    check(row === null ? value.tags.length === 0 : row.id === id, 'reference-invalid');
    result[id] = { row, tags: value.tags };
  }
  return result;
}
function validateJournal(row: Record<string, unknown>, db: DatabaseSync): void {
  const sourceIds = json(row.source_ids, SOURCE_TRANSFER_IDS_BYTES);
  check(
    Array.isArray(sourceIds) &&
      sourceIds.length >= 1 &&
      sourceIds.length <= CHANGE_SET_MAX_OPS &&
      sourceIds.every(isUuidShape) &&
      new Set(sourceIds).size === sourceIds.length,
    'json-invalid',
  );
  const ids = sourceIds as string[];
  const before = snapshots(row.before_payload, ids);
  const after = snapshots(row.after_payload, ids);
  for (const id of ids) {
    const old = before[id]!.row;
    const next = after[id]!.row;
    check(next !== null, 'reference-invalid');
    check(
      old === null
        ? next.version === 1
        : next.version === old.version + 1 &&
            next.scope === old.scope &&
            next.created_by === old.created_by &&
            next.created_at === old.created_at,
      'reference-invalid',
    );
    check(next.updated_at === row.applied_at, 'reference-invalid');
    for (const snapshot of [old, next])
      if (snapshot?.group_id != null)
        check(db.prepare(GROUP_BY_ID).get(snapshot.group_id) !== undefined, 'reference-invalid');
    // Historical entries may outlive a Source. Current row/version and usage
    // are deliberately not treated as foreign keys for old snapshots.
  }
  if (row.change_type === 'manual') {
    check(
      ids.length === 1 &&
        row.run_id === null &&
        row.tool_call_id === null &&
        row.request_fingerprint === null &&
        row.result_payload === null,
    );
  } else {
    check(
      row.run_id !== null &&
        row.tool_call_id !== null &&
        row.request_fingerprint !== null &&
        row.result_payload !== null,
    );
    const results = json(row.result_payload, SOURCE_TRANSFER_RESULT_BYTES);
    check(
      Array.isArray(results) && results.length >= 1 && results.length <= CHANGE_SET_MAX_OPS,
      'json-invalid',
    );
    const seen = new Set<string>();
    for (let index = 0; index < results.length; index++) {
      const result: unknown = results[index];
      check(
        fields(result, {
          opIndex: (v) => v === index,
          ok: (v) => v === true,
          sourceId: isUuidShape,
        }),
        'json-invalid',
      );
      const id = (result as { sourceId: string }).sourceId;
      check(!seen.has(id), 'json-invalid');
      seen.add(id);
    }
    // hardDelete splits before/after/source_ids but retains the original
    // successful replay payload; removed IDs are legitimate historical data.
    check(
      ids.every((id) => seen.has(id)),
      'reference-invalid',
    );
  }
}

export function validateSourceTransfer(db: DatabaseSync): SourceTransferValidationResult {
  let table: Table = 'sources';
  const counts: Record<Table, number> = {
    sources: 0,
    groups: 0,
    tags: 0,
    tagLinks: 0,
    journal: 0,
    usage: 0,
  };
  try {
    for (const [name, types, sizes, bounds] of PREFLIGHT) {
      table = name;
      check(db.prepare(types).get() === undefined, 'row-invalid');
      check(db.prepare(sizes).get(...bounds) === undefined, 'budget-exceeded');
    }
    for (const name of Object.keys(QUERIES) as Table[]) {
      table = name;
      for (const row of db.prepare(QUERIES[name]).iterate()) {
        check(fields(row, SHAPES[name]));
        check(Number.isSafeInteger(++counts[name]), 'budget-exceeded');
        switch (name) {
          case 'sources': {
            const item = source(row);
            if (item.group_id !== null)
              check(db.prepare(GROUP_BY_ID).get(item.group_id) !== undefined, 'reference-invalid');
            let links = 0;
            for (const link of db.prepare(LINKS_BY_SOURCE).iterate(item.id)) {
              check(++links <= SOURCE_TAGS_MAX_COUNT, 'budget-exceeded');
              check(isUuidShape(link.tag_id));
            }
            const usage = db.prepare(USAGE_BY_SOURCE).get(item.id);
            check(
              usage === undefined
                ? item.last_used_at === null && item.last_usage_outcome === null
                : usage.recorded_at === item.last_used_at &&
                    usage.outcome === item.last_usage_outcome,
              'reference-invalid',
            );
            break;
          }
          case 'tagLinks':
            check(
              db.prepare(SOURCE_BY_ID).get(row.source_id!) !== undefined &&
                db.prepare(TAG_BY_ID).get(row.tag_id!) !== undefined,
              'reference-invalid',
            );
            break;
          case 'usage':
            check(db.prepare(SOURCE_BY_ID).get(row.source_id!) !== undefined, 'reference-invalid');
            break;
          case 'journal':
            check(counts.journal <= JOURNAL_MAX_ENTRIES, 'budget-exceeded');
            validateJournal(row, db);
            break;
          case 'groups':
          case 'tags':
            break;
        }
      }
    }
    return { ok: true, counts, fts: 'rebuild-required' };
  } catch (error) {
    return { ok: false, code: error instanceof Invalid ? error.code : 'sqlite-error', table };
  }
}

const SAVEPOINT = 'SAVEPOINT source_transfer_index';
const REBUILD = "INSERT INTO sources_fts(sources_fts) VALUES('rebuild')";
const INTEGRITY = "INSERT INTO sources_fts(sources_fts,rank) VALUES('integrity-check',1)";
const COUNTS =
  'SELECT (SELECT count(*) FROM sources) AS sources, (SELECT count(*) FROM sources_fts_docsize) AS indexed';
const RELEASE = 'RELEASE source_transfer_index';
const ROLLBACK = 'ROLLBACK TO source_transfer_index';

/** Only the caller's proven private staging connection may enter this writer. */
export function normalizeAndVerifySourceIndex(
  staging: DatabaseSync,
): SourceIndexNormalizationResult {
  let saved = false;
  try {
    staging.exec(SAVEPOINT);
    saved = true;
    staging.prepare(REBUILD).run();
    staging.prepare(INTEGRITY).run();
    const count = staging.prepare(COUNTS).get();
    if (
      count === undefined ||
      typeof count.sources !== 'number' ||
      !Number.isSafeInteger(count.sources) ||
      count.sources < 0 ||
      count.indexed !== count.sources
    )
      throw new Error('索引计数无效');
    staging.exec(RELEASE);
    saved = false;
    return { ok: true, sourceCount: count.sources };
  } catch {
    if (saved) {
      try {
        staging.exec(ROLLBACK);
        staging.exec(RELEASE);
      } catch {
        /* The caller discards failed staging; no input connection was touched. */
      }
    }
    return { ok: false, code: 'fts-invalid' };
  }
}
