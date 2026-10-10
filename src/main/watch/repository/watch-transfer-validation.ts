// Caller owns schema/physical-file validation, snapshot isolation and disposal.
// This scanner never writes, prunes, opens files, or returns stored text/IDs.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  MAX_WATCH_DB_BYTES,
  MAX_PAGE_PROJECTION_BYTES,
  MAX_EVENT_EVIDENCE_BYTES,
  MAX_EVIDENCE_VALUE_BYTES,
  MAX_WATCH_RULES_TOTAL,
  MAX_WATCH_RULES_ENABLED,
  MAX_FEED_ITEMS,
  MAX_PROJECTION_FIELDS,
  MAX_DIGEST_FACTS_BYTES,
  MAX_DIGEST_EXPLANATION_BYTES,
  WATCH_EVENT_KINDS,
  type DigestFacts,
  type ChangeEvidencePair,
} from '../../../shared/types/watch';
import {
  isValidFeedProjectionValue,
  isValidPageProjectionValue,
  evidenceSafeUrl,
  sha256Hex,
} from '../../../shared/watch/diff/evidence';
import {
  JsonReadError,
  parseBoundedJson,
  validateBoundedJsonSyntax,
} from '../../storage/bounded-json';
import { WATCH_AUDIT_KINDS, WATCH_AUDIT_REASON_CODES } from '../db/watch-migrations';
import {
  validateRuleRow,
  validateBaselineRow,
  validateRunRow,
  validateEventRow,
  validateIntentRow,
  validateDigestScheduleRow,
  validateDigestRunRow,
  validateDigestArtifactRow,
  validateChangeEvidencePair,
  isValidObservationId,
} from '../watch-row-validation';

const QUERIES = {
  watch_rules: 'SELECT * FROM watch_rules',
  watch_baselines: 'SELECT * FROM watch_baselines',
  watch_runs: 'SELECT * FROM watch_runs',
  watch_audits: 'SELECT * FROM watch_audits',
  watch_events: 'SELECT * FROM watch_events',
  watch_event_observations: 'SELECT * FROM watch_event_observations',
  watch_event_items: 'SELECT * FROM watch_event_items',
  source_cleanup_intents: 'SELECT * FROM source_cleanup_intents',
  digest_change_state: 'SELECT * FROM digest_change_state',
  digest_change_journal: 'SELECT * FROM digest_change_journal ORDER BY sequence',
  digest_schedules: 'SELECT * FROM digest_schedules',
  digest_runs: 'SELECT * FROM digest_runs',
  watch_digests: 'SELECT * FROM watch_digests ORDER BY run_id, batch_index',
  digest_event_refs: 'SELECT * FROM digest_event_refs',
  notification_outbox: 'SELECT * FROM notification_outbox',
} as const;
export type WatchTransferTable = keyof typeof QUERIES;
type Code =
  'row-invalid' | 'json-invalid' | 'reference-invalid' | 'budget-exceeded' | 'sqlite-error';
export type WatchTransferValidationResult =
  | { ok: true; counts: Record<WatchTransferTable, number>; logicalBytes: number }
  | { ok: false; code: Code; table: WatchTransferTable };
type Row = Record<string, unknown>;
class Invalid extends Error {
  constructor(readonly code: Code) {
    super(code);
  }
}
function check(condition: unknown, code: Code = 'row-invalid'): asserts condition {
  if (!condition) throw new Invalid(code);
}
function str(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function integer(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}
function iso(value: unknown): value is string {
  return str(value) && Number.isFinite(Date.parse(value));
}
function member(value: unknown, values: readonly string[]): boolean {
  return typeof value === 'string' && values.includes(value);
}
function record(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function canonicalIso(value: unknown): boolean {
  return iso(value) && new Date(value).toISOString() === value;
}
function httpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return (
      ['http:', 'https:'].includes(parsed.protocol) &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}
function canonicalTimes(row: Row): void {
  for (const [column, value] of Object.entries(row))
    if ((column.endsWith('_at') || column === 'last_consumed_scheduled_for') && value !== null)
      check(canonicalIso(value));
}
function ordered(value: unknown, keys: readonly string[]): void {
  check(record(value) && Object.keys(value).join('\0') === keys.join('\0'));
}
function projectionOrder(parsed: unknown, kind: unknown): void {
  check(record(parsed));
  if (kind === 'page') {
    ordered(parsed, ['type', 'fields']);
    const fields = parsed['fields'] as Row[];
    check(fields.length <= MAX_PROJECTION_FIELDS, 'budget-exceeded');
    for (const field of fields) {
      const common = ['fieldKey', 'regionIndex', 'kind', 'label'];
      switch (field['kind']) {
        case 'main-text':
          ordered(field, [...common, 'value']);
          break;
        case 'heading':
          ordered(field, [...common, 'level', 'ordinal', 'value']);
          break;
        case 'table-header':
          ordered(field, [...common, 'occurrence', 'column', 'value']);
          break;
        case 'table-cell':
          ordered(field, [...common, 'occurrence', 'row', 'column', 'columnLabel', 'value']);
          break;
        case 'link':
          ordered(field, [...common, 'ordinal', 'text', 'url']);
          break;
      }
    }
  } else {
    ordered(parsed, [
      'type',
      'format',
      'title',
      'description',
      'siteUrl',
      'feedUrl',
      'items',
      'itemsTruncated',
    ]);
    for (const key of ['title', 'description', 'siteUrl', 'feedUrl'])
      ordered(parsed[key], ['text', 'truncated', 'originalBytes', 'valueHash']);
    const items = parsed['items'] as Row[];
    check(items.length <= MAX_FEED_ITEMS, 'budget-exceeded');
    for (const item of items) {
      ordered(item, [
        'identity',
        'identityKind',
        'title',
        'link',
        'summary',
        'publishedAt',
        'updatedAt',
        'author',
      ]);
      for (const key of ['title', 'link', 'summary', 'publishedAt', 'updatedAt', 'author'])
        if (item[key] !== null)
          ordered(item[key], ['text', 'truncated', 'originalBytes', 'valueHash']);
    }
  }
}
function dailyDate(row: Row): void {
  if (row['last_daily_local_date'] === null) return;
  const schedule = json(row['schedule_json'], MAX_WATCH_DB_BYTES, 4);
  check(
    record(schedule) &&
      schedule['kind'] === 'daily' &&
      typeof schedule['timeZone'] === 'string' &&
      iso(row['last_consumed_scheduled_for']),
  );
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule['timeZone'],
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(row['last_consumed_scheduled_for']));
  const part = (kind: string): string | undefined =>
    parts.find((entry) => entry.type === kind)?.value;
  check(row['last_daily_local_date'] === `${part('year')}-${part('month')}-${part('day')}`);
}
const JSON_NODES: Readonly<Record<string, number>> = {
  schedule_json: 4,
  target_json: 128,
  condition_json: 54,
  outcome_json: 4,
  health_json: 4,
  before_projection_json: 7,
  after_projection_json: 7,
  affected_rule_state_json: 1201,
  source_ids_json: 101,
  period_json: 3,
  last_period_json: 3,
  run_stats_json: 4,
  last_run_stats_json: 4,
  privacy_json: 4,
  before_value_json: 6,
  after_value_json: 6,
};
function json(value: unknown, bytes = MAX_WATCH_DB_BYTES, nodes = bytes): unknown {
  check(typeof value === 'string', 'json-invalid');
  try {
    return parseBoundedJson(value, {
      bytes,
      depth: 16,
      nodes: Math.max(1, Math.min(nodes, Buffer.byteLength(value))),
    });
  } catch (error) {
    throw new Invalid(
      error instanceof JsonReadError && error.code === 'budget-exceeded'
        ? 'budget-exceeded'
        : 'json-invalid',
    );
  }
}
function nullableJson(value: unknown): unknown {
  return value === null ? null : json(value);
}
function preparse(row: Row): void {
  for (const [column, value] of Object.entries(row)) {
    if (typeof value === 'number') check(Number.isSafeInteger(value));
    if (!column.endsWith('_json') || value === null) continue;
    if (column === 'response_metadata_json') {
      check(typeof value === 'string', 'json-invalid');
      try {
        // Historical opaque metadata is never promoted to a DTO here. Preserve
        // its syntax/bytes without expanding values or decoding object keys.
        validateBoundedJsonSyntax(value, {
          bytes: MAX_WATCH_DB_BYTES,
          depth: MAX_WATCH_DB_BYTES,
          nodes: MAX_WATCH_DB_BYTES,
        });
      } catch (error) {
        throw new Invalid(
          error instanceof JsonReadError && error.code === 'budget-exceeded'
            ? 'budget-exceeded'
            : 'json-invalid',
        );
      }
      continue;
    }
    const limit =
      column === 'projection_json'
        ? MAX_PAGE_PROJECTION_BYTES
        : column === 'facts_json'
          ? MAX_DIGEST_FACTS_BYTES
          : column === 'explanation_json'
            ? MAX_DIGEST_EXPLANATION_BYTES
            : column === 'before_value_json' || column === 'after_value_json'
              ? MAX_EVENT_EVIDENCE_BYTES
              : MAX_WATCH_DB_BYTES;
    json(value, limit, JSON_NODES[column] ?? limit);
  }
}

function baseline(row: Row): void {
  check(
    validateBaselineRow({
      ruleId: row['rule_id'],
      version: row['version'],
      projectionType: row['projection_type'],
      projectionJson: row['projection_json'],
      contentHash: row['content_hash'],
      byteLength: row['byte_length'],
      finalUrl: row['final_url'],
      capturedAt: row['captured_at'],
      documentId: row['document_id'],
      conditionalEtag: row['conditional_etag'],
      conditionalLastModified: row['conditional_last_modified'],
    }).ok,
  );
  const raw = row['projection_json'] as string;
  check(Buffer.byteLength(raw) === row['byte_length']);
  const parsed = json(raw, MAX_PAGE_PROJECTION_BYTES);
  check(/^[0-9a-f]{64}$/.test(row['content_hash'] as string));
  check(
    JSON.stringify(parsed) === raw &&
      createHash('sha256').update(raw).digest('hex') === row['content_hash'],
  );
  check(
    row['projection_type'] === 'feed'
      ? isValidFeedProjectionValue(parsed)
      : isValidPageProjectionValue(parsed),
  );
  projectionOrder(parsed, row['projection_type']);
  canonicalTimes(row);
  check(httpUrl(row['final_url']));
}
function run(row: Row): void {
  const outcome = nullableJson(row['outcome_json']);
  const health = nullableJson(row['health_json']);
  check(
    (row['outcome_json'] === null || outcome !== null) &&
      (row['health_json'] === null || health !== null),
  );
  check(
    validateRunRow({
      id: row['id'],
      ruleId: row['rule_id'],
      requestKey: row['request_key'],
      status: row['status'],
      trigger: row['trigger'],
      scheduledFor: row['scheduled_for'],
      startedAt: row['started_at'],
      finishedAt: row['finished_at'],
      outcome,
      health,
      // This legacy validator uses JSON.parse internally for metadata. Syntax
      // was checked above without allocation; do not pass opaque text to it.
      responseMetadataJson: null,
    }).ok,
  );
}
function intent(row: Row): void {
  const before = nullableJson(row['before_projection_json']);
  const after = nullableJson(row['after_projection_json']);
  check(
    (row['before_projection_json'] === null || before !== null) &&
      (row['after_projection_json'] === null || after !== null),
  );
  check(
    validateIntentRow({
      mutationId: row['mutation_id'],
      sourceId: row['source_id'],
      operation: row['operation'],
      beforeProjection: before,
      afterProjection: after,
      affectedRuleState: json(row['affected_rule_state_json']),
      state: row['state'],
      createdAt: row['created_at'],
      updatedAt: row['updated_at'],
    }).ok,
  );
  check(
    (before === null || (record(before) && before['sourceId'] === row['source_id'])) &&
      (after === null || (record(after) && after['sourceId'] === row['source_id'])),
    'reference-invalid',
  );
}
function storedEvidencePair(raw: unknown): ChangeEvidencePair {
  const pair = validateChangeEvidencePair(raw);
  check(pair !== null);
  check(!isDeepStrictEqual(pair.before, pair.after));
  check(evidenceSafeUrl(pair.beforeFinalUrl) === pair.beforeFinalUrl);
  check(evidenceSafeUrl(pair.afterFinalUrl) === pair.afterFinalUrl);
  for (const value of [pair.before, pair.after]) {
    if (value.kind === 'absent') continue;
    const bytes = Buffer.byteLength(value.excerpt);
    check(/^[0-9a-f]{64}$/.test(value.valueHash) && integer(value.normalizedBytes));
    check(bytes <= MAX_EVIDENCE_VALUE_BYTES);
    if (value.truncated) {
      // The full value is absent; never substitute the excerpt's hash.
      check(value.normalizedBytes > bytes);
    } else {
      check(value.normalizedBytes === bytes && value.valueHash === sha256Hex(value.excerpt));
    }
  }
  return pair;
}
function evidencePair(row: Row): ChangeEvidencePair {
  return storedEvidencePair({
    itemId: row['item_id'],
    fieldKey: row['field_key'],
    label: row['label'],
    before: json(row['before_value_json'], MAX_EVENT_EVIDENCE_BYTES, 6),
    after: json(row['after_value_json'], MAX_EVENT_EVIDENCE_BYTES, 6),
    beforeCapturedAt: row['before_captured_at'],
    afterCapturedAt: row['after_captured_at'],
    beforeFinalUrl: row['before_final_url'],
    afterFinalUrl: row['after_final_url'],
    beforeDocumentId: row['before_document_id'],
    afterDocumentId: row['after_document_id'],
    feedItemKey: row['feed_item_key'],
  });
}
function item(row: Row): void {
  check(
    str(row['id']) &&
      str(row['event_id']) &&
      str(row['observation_id']) &&
      integer(row['sequence']) &&
      integer(row['observation_item_sequence']),
  );
  evidencePair(row);
}
function observation(row: Row): void {
  check(
    str(row['id']) &&
      str(row['event_id']) &&
      isValidObservationId(row['id'], row['event_id']) &&
      integer(row['sequence']) &&
      str(row['idempotency_key']) &&
      str(row['change_fingerprint']) &&
      member(row['event_kind'], WATCH_EVENT_KINDS) &&
      iso(row['observed_at']) &&
      integer(row['first_item_sequence']) &&
      integer(row['item_count'], 1),
  );
}
function outbox(row: Row): void {
  check(
    str(row['id']) &&
      (row['rule_id'] === null || str(row['rule_id'])) &&
      str(row['subject_id']) &&
      member(row['subject_type'], ['event', 'digest']) &&
      member(row['channel'], ['in-app', 'windows']) &&
      member(row['state'], ['pending', 'sent', 'failed', 'uncertain']) &&
      integer(row['attempts']) &&
      iso(row['created_at']) &&
      iso(row['updated_at']),
  );
  check(
    row['dedupe_key'] ===
      `${String(row['channel'])}|${String(row['subject_type'])}|${String(row['subject_id'])}|1`,
  );
  const privacy = json(row['privacy_json']);
  check(
    record(privacy) &&
      Object.keys(privacy).length === 3 &&
      Object.hasOwn(privacy, 'eventKind') &&
      Object.hasOwn(privacy, 'importance') &&
      Object.hasOwn(privacy, 'itemCount') &&
      member(privacy['importance'], ['normal', 'important']) &&
      integer(privacy['itemCount'], 1) &&
      member(
        privacy['eventKind'],
        row['subject_type'] === 'digest' ? ['digest'] : WATCH_EVENT_KINDS,
      ),
  );
  check(row['subject_type'] === 'event' ? str(row['rule_id']) : row['rule_id'] === null);
  // Failed with zero attempts records an imported notification cancelled before delivery.
  check(
    row['state'] === 'pending'
      ? row['attempts'] === 0
      : integer(row['attempts'], row['state'] === 'failed' ? 0 : 1),
  );
}

// SQLite's non-STRICT TEXT PRIMARY KEY admits NULL. Such a row can nullify
// a legacy SUM term. Integer affinity also admits text that CHECK(x>=0) may
// accept. Reject both before materializing any business row or JSON string.
const SCALAR_PREFLIGHT: ReadonlyArray<readonly [WatchTransferTable, string]> = [
  [
    'watch_rules',
    `SELECT 1 FROM watch_rules WHERE typeof(id)<>'text'
    OR typeof(rule_version)<>'integer' OR typeof(source_row_version)<>'integer'
    OR typeof(desired_enabled)<>'integer' OR typeof(muted)<>'integer'
    OR typeof(notification_show_details)<>'integer' OR typeof(consecutive_failures)<>'integer'
    OR typeof(baseline_version)<>'integer' OR typeof(access_mode)<>'text'
    OR access_mode NOT IN ('public','session') LIMIT 1`,
  ],
  [
    'watch_baselines',
    `SELECT 1 FROM watch_baselines WHERE typeof(rule_id)<>'text'
    OR typeof(version)<>'integer' OR typeof(byte_length)<>'integer' LIMIT 1`,
  ],
  ['watch_runs', "SELECT 1 FROM watch_runs WHERE typeof(id)<>'text' LIMIT 1"],
  ['watch_audits', "SELECT 1 FROM watch_audits WHERE typeof(id)<>'text' LIMIT 1"],
  [
    'watch_events',
    "SELECT 1 FROM watch_events WHERE typeof(id)<>'text' OR typeof(item_count)<>'integer' LIMIT 1",
  ],
  [
    'watch_event_observations',
    `SELECT 1 FROM watch_event_observations WHERE typeof(id)<>'text'
    OR typeof(sequence)<>'integer' OR typeof(first_item_sequence)<>'integer' OR typeof(item_count)<>'integer' LIMIT 1`,
  ],
  [
    'watch_event_items',
    `SELECT 1 FROM watch_event_items WHERE typeof(id)<>'text'
    OR typeof(sequence)<>'integer' OR typeof(observation_item_sequence)<>'integer' LIMIT 1`,
  ],
  [
    'source_cleanup_intents',
    "SELECT 1 FROM source_cleanup_intents WHERE typeof(mutation_id)<>'text' LIMIT 1",
  ],
  [
    'digest_change_state',
    "SELECT 1 FROM digest_change_state WHERE typeof(id)<>'integer' OR typeof(last_sequence)<>'integer' LIMIT 1",
  ],
  [
    'digest_change_journal',
    "SELECT 1 FROM digest_change_journal WHERE typeof(sequence)<>'integer' LIMIT 1",
  ],
  [
    'digest_schedules',
    `SELECT 1 FROM digest_schedules WHERE typeof(id)<>'text'
    OR typeof(version)<>'integer' OR typeof(ai_enabled)<>'integer' OR typeof(cursor_sequence)<>'integer'
    OR (last_consumed_scheduled_for IS NOT NULL AND (typeof(last_consumed_scheduled_for)<>'text' OR length(CAST(last_consumed_scheduled_for AS BLOB))>27))
    OR (last_daily_local_date IS NOT NULL AND (typeof(last_daily_local_date)<>'text' OR length(CAST(last_daily_local_date AS BLOB))<>10)) LIMIT 1`,
  ],
  [
    'digest_runs',
    `SELECT 1 FROM digest_runs WHERE typeof(id)<>'text' OR typeof(lower_sequence)<>'integer'
    OR typeof(upper_sequence)<>'integer' OR typeof(next_sequence)<>'integer'
    OR (blocked_required_bytes IS NOT NULL AND typeof(blocked_required_bytes)<>'integer')
    OR (blocked_available_bytes IS NOT NULL AND typeof(blocked_available_bytes)<>'integer') LIMIT 1`,
  ],
  [
    'watch_digests',
    `SELECT 1 FROM watch_digests WHERE typeof(id)<>'text' OR typeof(batch_index)<>'integer'
    OR typeof(first_sequence)<>'integer' OR typeof(last_sequence)<>'integer'
    OR typeof(facts_revision)<>'integer' OR typeof(byte_length)<>'integer'
    OR (claimed_facts_revision IS NOT NULL AND typeof(claimed_facts_revision)<>'integer') LIMIT 1`,
  ],
  [
    'notification_outbox',
    "SELECT 1 FROM notification_outbox WHERE typeof(id)<>'text' OR typeof(attempts)<>'integer' LIMIT 1",
  ],
];

const RELATIONS: ReadonlyArray<readonly [WatchTransferTable, string]> = [
  [
    'watch_baselines',
    `SELECT 1 FROM watch_baselines b LEFT JOIN watch_rules r ON r.id=b.rule_id WHERE r.id IS NULL OR b.version IS NOT r.baseline_version OR b.projection_type IS NOT r.kind LIMIT 1`,
  ],
  [
    'watch_rules',
    `SELECT 1 FROM watch_rules r LEFT JOIN watch_baselines b ON b.rule_id=r.id WHERE r.baseline_version>0 AND b.rule_id IS NULL LIMIT 1`,
  ],
  [
    'watch_runs',
    `SELECT 1 FROM watch_runs x LEFT JOIN watch_rules r ON r.id=x.rule_id WHERE r.id IS NULL LIMIT 1`,
  ],
  [
    'watch_audits',
    `SELECT 1 FROM watch_audits x LEFT JOIN watch_rules r ON r.id=x.rule_id WHERE x.rule_id IS NOT NULL AND r.id IS NULL LIMIT 1`,
  ],
  [
    'watch_events',
    `SELECT 1 FROM watch_events e LEFT JOIN watch_rules r ON r.id=e.rule_id WHERE r.id IS NULL OR e.source_id IS NOT r.source_id LIMIT 1`,
  ],
  [
    'watch_event_observations',
    `SELECT 1 FROM watch_event_observations o LEFT JOIN watch_events e ON e.id=o.event_id WHERE e.id IS NULL LIMIT 1`,
  ],
  [
    'watch_event_items',
    `SELECT 1 FROM watch_event_items i LEFT JOIN watch_event_observations o ON o.id=i.observation_id WHERE o.id IS NULL OR i.event_id IS NOT o.event_id LIMIT 1`,
  ],
  [
    'digest_change_journal',
    `SELECT 1 FROM digest_change_journal j LEFT JOIN watch_event_observations o ON o.id=j.observation_id LEFT JOIN watch_events e ON e.id=j.event_id
    WHERE (j.status='active' AND (o.id IS NULL OR e.id IS NULL OR o.event_id IS NOT j.event_id OR e.source_id IS NOT j.source_id OR o.observed_at IS NOT j.observed_at)) OR (j.status<>'active' AND (o.id IS NOT NULL OR e.id IS NOT NULL)) LIMIT 1`,
  ],
  [
    'watch_event_observations',
    `SELECT 1 FROM watch_event_observations o LEFT JOIN digest_change_journal j ON j.observation_id=o.id WHERE j.sequence IS NULL OR j.status<>'active' LIMIT 1`,
  ],
  [
    'digest_runs',
    `SELECT 1 FROM digest_runs r LEFT JOIN digest_schedules s ON s.id=r.schedule_id WHERE s.id IS NULL OR r.upper_sequence>(SELECT last_sequence FROM digest_change_state WHERE id=1) OR r.next_sequence>s.cursor_sequence OR (r.state<>'completed' AND r.next_sequence IS NOT s.cursor_sequence) LIMIT 1`,
  ],
  [
    'digest_schedules',
    `SELECT 1 FROM digest_schedules WHERE cursor_sequence>(SELECT last_sequence FROM digest_change_state WHERE id=1) LIMIT 1`,
  ],
  [
    'digest_event_refs',
    `SELECT 1 FROM digest_event_refs r LEFT JOIN watch_digests d ON d.id=r.digest_id LEFT JOIN watch_events e ON e.id=r.event_id WHERE d.id IS NULL OR (r.status='active' AND e.id IS NULL) OR (r.status<>'active' AND e.id IS NOT NULL) LIMIT 1`,
  ],
  [
    'notification_outbox',
    `SELECT 1 FROM notification_outbox n LEFT JOIN watch_events e ON n.subject_type='event' AND e.id=n.subject_id LEFT JOIN watch_digests d ON n.subject_type='digest' AND d.id=n.subject_id WHERE (n.subject_type='event' AND (e.id IS NULL OR n.rule_id IS NOT e.rule_id)) OR (n.subject_type='digest' AND d.id IS NULL) LIMIT 1`,
  ],
];

/** Complete semantic scan of a current-v5, caller-owned SQLite snapshot. */
export function validateWatchTransferDatabase(
  database: DatabaseSync,
): WatchTransferValidationResult {
  let table: WatchTransferTable = 'watch_rules';
  const counts = Object.fromEntries(Object.keys(QUERIES).map((key) => [key, 0])) as Record<
    WatchTransferTable,
    number
  >;
  try {
    for (const [name, sql] of SCALAR_PREFLIGHT) {
      table = name;
      check(database.prepare(sql).get() === undefined);
    }
    table = 'watch_rules';
    const logicalBytes = database.prepare(SQL_ESTIMATE_LOGICAL_BYTES).get()?.['total'];
    check(integer(logicalBytes) && logicalBytes <= MAX_WATCH_DB_BYTES, 'budget-exceeded');
    let highWater = 0;
    for (const name of Object.keys(QUERIES) as WatchTransferTable[]) {
      table = name;
      for (const row of database.prepare(QUERIES[name]).iterate()) {
        counts[name]++;
        preparse(row);
        switch (name) {
          case 'watch_rules':
            check(validateRuleRow(row).ok);
            dailyDate(row);
            break;
          case 'watch_baselines':
            baseline(row);
            break;
          case 'watch_runs':
            run(row);
            break;
          case 'watch_audits':
            check(
              str(row['id']) &&
                (row['rule_id'] === null || str(row['rule_id'])) &&
                member(row['kind'], WATCH_AUDIT_KINDS) &&
                member(row['reason_code'], WATCH_AUDIT_REASON_CODES) &&
                iso(row['created_at']),
            );
            break;
          case 'watch_events':
            check(validateEventRow(row).ok);
            break;
          case 'watch_event_observations':
            observation(row);
            break;
          case 'watch_event_items':
            item(row);
            break;
          case 'source_cleanup_intents':
            intent(row);
            break;
          case 'digest_change_state':
            check(row['id'] === 1 && integer(row['last_sequence']) && counts[name] === 1);
            highWater = row['last_sequence'];
            break;
          case 'digest_change_journal':
            check(
              integer(row['sequence'], 1) &&
                row['sequence'] <= highWater &&
                str(row['observation_id']) &&
                str(row['event_id']) &&
                str(row['source_id']) &&
                iso(row['observed_at']) &&
                member(row['status'], ['active', 'expired', 'user-deleted']),
            );
            break;
          case 'digest_schedules':
            check(str(row['id']) && validateDigestScheduleRow(row));
            canonicalTimes(row);
            dailyDate(row);
            break;
          case 'digest_runs':
            check(
              str(row['id']) &&
                str(row['schedule_id']) &&
                str(row['request_key']) &&
                validateDigestRunRow(row),
            );
            canonicalTimes(row);
            break;
          case 'watch_digests':
            check(
              str(row['id']) &&
                str(row['run_id']) &&
                str(row['schedule_id']) &&
                validateDigestArtifactRow(row),
            );
            canonicalTimes(row);
            if (member(row['provider_state'], ['pending', 'disabled', 'skipped']))
              check(
                row['claimed_at'] === null &&
                  row['claimed_facts_revision'] === null &&
                  row['claimed_facts_hash'] === null,
              );
            break;
          case 'digest_event_refs':
            check(
              str(row['digest_id']) &&
                str(row['event_id']) &&
                member(row['status'], ['active', 'expired', 'user-deleted']),
            );
            break;
          case 'notification_outbox':
            outbox(row);
            break;
        }
      }
    }
    table = 'digest_change_state';
    check(counts.digest_change_state === 1);
    table = 'watch_rules';
    check(counts.watch_rules <= MAX_WATCH_RULES_TOTAL, 'budget-exceeded');
    check(
      (database.prepare("SELECT COUNT(*) AS n FROM watch_rules WHERE state='enabled'").get()?.[
        'n'
      ] as number) <= MAX_WATCH_RULES_ENABLED,
      'budget-exceeded',
    );
    for (const [name, sql] of RELATIONS) {
      table = name;
      check(database.prepare(sql).get() === undefined, 'reference-invalid');
    }
    table = 'watch_events';
    const observations = database.prepare(
      'SELECT * FROM watch_event_observations WHERE event_id=? ORDER BY sequence',
    );
    const items = database.prepare(
      'SELECT * FROM watch_event_items WHERE observation_id=? ORDER BY observation_item_sequence',
    );
    for (const event of database.prepare(QUERIES.watch_events).iterate()) {
      let observationIndex = 0;
      let itemIndex = 0;
      let evidenceBytes = 0;
      let firstKind: unknown;
      let mixed = false;
      for (const observed of observations.iterate(event['id'] as SQLInputValue)) {
        check(
          observed['sequence'] === observationIndex &&
            observed['first_item_sequence'] === itemIndex,
          'reference-invalid',
        );
        if (observationIndex === 0) {
          check(
            observed['idempotency_key'] === event['idempotency_key'] &&
              observed['change_fingerprint'] === event['change_fingerprint'],
            'reference-invalid',
          );
          firstKind = observed['event_kind'];
        } else if (observed['event_kind'] !== firstKind) mixed = true;
        let memberIndex = 0;
        for (const member of items.iterate(observed['id'] as SQLInputValue)) {
          check(
            member['sequence'] === itemIndex && member['observation_item_sequence'] === memberIndex,
            'reference-invalid',
          );
          // Both production Event write paths budget complete evidence pairs,
          // including their IDs, labels, URLs and timestamps.
          evidenceBytes += Buffer.byteLength(JSON.stringify(evidencePair(member)));
          check(evidenceBytes <= MAX_EVENT_EVIDENCE_BYTES, 'budget-exceeded');
          memberIndex++;
          itemIndex++;
        }
        check(memberIndex === observed['item_count'], 'reference-invalid');
        observationIndex++;
      }
      check(
        observationIndex > 0 &&
          itemIndex === event['item_count'] &&
          event['event_kind'] === (mixed ? 'mixed' : firstKind),
        'reference-invalid',
      );
    }
    table = 'watch_digests';
    const runQuery = database.prepare('SELECT * FROM digest_runs WHERE id=?');
    const refsQuery = database.prepare(
      'SELECT event_id, status FROM digest_event_refs WHERE digest_id=?',
    );
    const eventQuery = database.prepare(
      'SELECT rule_id, source_id, importance FROM watch_events WHERE id=?',
    );
    const slicesQuery =
      database.prepare(`SELECT o.id, o.observed_at, o.event_kind FROM digest_change_journal j
      JOIN watch_event_observations o ON o.id=j.observation_id WHERE j.event_id=? AND j.sequence>=? AND j.sequence<=? ORDER BY j.sequence`);
    const pairsQuery = database.prepare(
      'SELECT * FROM watch_event_items WHERE observation_id=? ORDER BY observation_item_sequence',
    );
    let previousRun: unknown;
    let previousSequence = 0;
    let nextBatch = 0;
    for (const artifact of database.prepare(QUERIES.watch_digests).iterate()) {
      const owner = runQuery.get(artifact['run_id'] as SQLInputValue);
      check(
        owner !== undefined && owner['schedule_id'] === artifact['schedule_id'],
        'reference-invalid',
      );
      if (previousRun !== artifact['run_id']) {
        previousRun = artifact['run_id'];
        previousSequence = owner['lower_sequence'] as number;
        nextBatch = 0;
      }
      check(
        artifact['batch_index'] === nextBatch &&
          artifact['first_sequence'] === previousSequence + 1 &&
          (artifact['last_sequence'] as number) <= (owner['next_sequence'] as number),
        'reference-invalid',
      );
      previousSequence = artifact['last_sequence'] as number;
      nextBatch++;
      const facts = json(artifact['facts_json'], MAX_DIGEST_FACTS_BYTES) as DigestFacts;
      for (const pairs of Object.values(facts.evidenceMap))
        for (const pair of pairs) storedEvidencePair(pair);
      check(
        JSON.stringify(facts.period) === owner['period_json'] &&
          JSON.stringify(facts.runStats) === owner['run_stats_json'],
        'reference-invalid',
      );
      const refs = new Map<string, string>();
      for (const ref of refsQuery.iterate(artifact['id'] as SQLInputValue)) {
        check(refs.size < 50, 'reference-invalid');
        refs.set(ref['event_id'] as string, ref['status'] as string);
      }
      check(refs.size === facts.events.length, 'reference-invalid');
      for (const event of facts.events) {
        check(
          refs.get(event.eventId) === facts.referenceStates[event.eventId],
          'reference-invalid',
        );
        if (facts.referenceStates[event.eventId] === 'active') {
          const saved = eventQuery.get(event.eventId);
          check(
            saved !== undefined &&
              saved['rule_id'] === event.ruleId &&
              saved['source_id'] === event.sourceId &&
              saved['importance'] === event.importance,
            'reference-invalid',
          );
          let observations = 0;
          let pairs = 0;
          let firstTime: unknown;
          let lastTime: unknown;
          let kind: unknown;
          for (const slice of slicesQuery.iterate(
            event.eventId,
            artifact['first_sequence'] as SQLInputValue,
            artifact['last_sequence'] as SQLInputValue,
          )) {
            if (observations === 0) {
              firstTime = slice['observed_at'];
              kind = slice['event_kind'];
            } else if (kind !== slice['event_kind']) kind = 'mixed';
            lastTime = slice['observed_at'];
            observations++;
            for (const pair of pairsQuery.iterate(slice['id'] as SQLInputValue)) {
              check(
                isDeepStrictEqual(evidencePair(pair), facts.evidenceMap[event.eventId]?.[pairs]),
                'reference-invalid',
              );
              pairs++;
            }
          }
          check(
            observations === event.observationCount &&
              pairs === event.itemCount &&
              firstTime === event.firstIncludedAt &&
              lastTime === event.lastIncludedAt &&
              kind === event.eventKind,
            'reference-invalid',
          );
        }
      }
    }
    return { ok: true, counts, logicalBytes };
  } catch (error) {
    return { ok: false, code: error instanceof Invalid ? error.code : 'sqlite-error', table };
  }
}

const SQL_ESTIMATE_LOGICAL_BYTES = `SELECT
  COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(source_id AS BLOB))
    + LENGTH(CAST(kind AS BLOB)) + LENGTH(CAST(state AS BLOB))
    + LENGTH(CAST(COALESCE(pause_reason,'') AS BLOB))
    + LENGTH(CAST(schedule_json AS BLOB)) + LENGTH(CAST(target_json AS BLOB))
    + LENGTH(CAST(COALESCE(condition_json,'') AS BLOB))
    + LENGTH(CAST(notification_level AS BLOB))
    + LENGTH(CAST(source_locator_fingerprint AS BLOB))
    + LENGTH(CAST(COALESCE(next_due_at,'') AS BLOB))
    + LENGTH(CAST(COALESCE(last_consumed_scheduled_for,'') AS BLOB))
    + LENGTH(CAST(COALESCE(last_daily_local_date,'') AS BLOB))
    + LENGTH(CAST(COALESCE(backoff_until,'') AS BLOB))
    + LENGTH(CAST(created_at AS BLOB)) + LENGTH(CAST(updated_at AS BLOB)) + 40)
    FROM watch_rules), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(rule_id AS BLOB))
    + LENGTH(CAST(projection_type AS BLOB)) + LENGTH(CAST(projection_json AS BLOB))
    + LENGTH(CAST(content_hash AS BLOB)) + LENGTH(CAST(final_url AS BLOB))
    + LENGTH(CAST(captured_at AS BLOB))
    + LENGTH(CAST(COALESCE(document_id,'') AS BLOB))
    + LENGTH(CAST(COALESCE(conditional_etag,'') AS BLOB))
    + LENGTH(CAST(COALESCE(conditional_last_modified,'') AS BLOB)) + 16)
    FROM watch_baselines), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(rule_id AS BLOB))
    + LENGTH(CAST(request_key AS BLOB)) + LENGTH(CAST(status AS BLOB))
    + LENGTH(CAST(trigger AS BLOB))
    + LENGTH(CAST(COALESCE(scheduled_for,'') AS BLOB))
    + LENGTH(CAST(COALESCE(started_at,'') AS BLOB))
    + LENGTH(CAST(COALESCE(finished_at,'') AS BLOB))
    + LENGTH(CAST(COALESCE(outcome_json,'') AS BLOB))
    + LENGTH(CAST(COALESCE(health_json,'') AS BLOB))
    + LENGTH(CAST(COALESCE(response_metadata_json,'') AS BLOB)))
    FROM watch_runs), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB))
    + LENGTH(CAST(COALESCE(rule_id,'') AS BLOB)) + LENGTH(CAST(kind AS BLOB))
    + LENGTH(CAST(reason_code AS BLOB)) + LENGTH(CAST(created_at AS BLOB)))
    FROM watch_audits), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(rule_id AS BLOB))
    + LENGTH(CAST(source_id AS BLOB)) + LENGTH(CAST(event_kind AS BLOB))
    + LENGTH(CAST(importance AS BLOB)) + LENGTH(CAST(idempotency_key AS BLOB))
    + LENGTH(CAST(change_fingerprint AS BLOB)) + LENGTH(CAST(first_observed_at AS BLOB))
    + LENGTH(CAST(last_observed_at AS BLOB))
    + LENGTH(CAST(COALESCE(read_at,'') AS BLOB)) + 8)
    FROM watch_events), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(event_id AS BLOB))
    + LENGTH(CAST(observation_id AS BLOB))
    + LENGTH(CAST(item_id AS BLOB)) + LENGTH(CAST(field_key AS BLOB))
    + LENGTH(CAST(label AS BLOB)) + LENGTH(CAST(before_value_json AS BLOB))
    + LENGTH(CAST(after_value_json AS BLOB)) + LENGTH(CAST(before_captured_at AS BLOB))
    + LENGTH(CAST(after_captured_at AS BLOB)) + LENGTH(CAST(before_final_url AS BLOB))
    + LENGTH(CAST(after_final_url AS BLOB))
    + LENGTH(CAST(COALESCE(before_document_id,'') AS BLOB))
    + LENGTH(CAST(COALESCE(after_document_id,'') AS BLOB))
    + LENGTH(CAST(COALESCE(feed_item_key,'') AS BLOB)) + 16)
    FROM watch_event_items), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(event_id AS BLOB))
    + LENGTH(CAST(idempotency_key AS BLOB)) + LENGTH(CAST(change_fingerprint AS BLOB))
    + LENGTH(CAST(event_kind AS BLOB)) + LENGTH(CAST(observed_at AS BLOB)) + 24)
    FROM watch_event_observations), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB))
    + LENGTH(CAST(source_ids_json AS BLOB)) + LENGTH(CAST(schedule_json AS BLOB))
    + LENGTH(CAST(next_due_at AS BLOB))
    + LENGTH(CAST(state AS BLOB)) + LENGTH(CAST(created_at AS BLOB))
    + LENGTH(CAST(updated_at AS BLOB))
    + LENGTH(CAST(COALESCE(last_checked_at,'') AS BLOB))
    + LENGTH(CAST(COALESCE(last_period_json,'') AS BLOB))
    + LENGTH(CAST(COALESCE(last_run_stats_json,'') AS BLOB)) + 24)
    FROM digest_schedules), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB)) + LENGTH(CAST(schedule_id AS BLOB))
    + LENGTH(CAST(request_key AS BLOB)) + LENGTH(CAST(logical_date AS BLOB))
    + LENGTH(CAST(period_json AS BLOB)) + LENGTH(CAST(run_stats_json AS BLOB))
    + LENGTH(CAST(state AS BLOB)) + LENGTH(CAST(COALESCE(blocked_at,'') AS BLOB))
    + LENGTH(CAST(created_at AS BLOB)) + LENGTH(CAST(COALESCE(finished_at,'') AS BLOB)) + 48)
    FROM digest_runs), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB))
    + LENGTH(CAST(schedule_id AS BLOB)) + LENGTH(CAST(run_id AS BLOB))
    + LENGTH(CAST(facts_json AS BLOB)) + LENGTH(CAST(facts_hash AS BLOB))
    + LENGTH(CAST(COALESCE(explanation_json,'') AS BLOB))
    + LENGTH(CAST(provider_state AS BLOB))
    + LENGTH(CAST(COALESCE(provider_result_code,'') AS BLOB))
    + LENGTH(CAST(COALESCE(claimed_facts_hash,'') AS BLOB))
    + LENGTH(CAST(COALESCE(claimed_at,'') AS BLOB))
    + LENGTH(CAST(COALESCE(provider_finished_at,'') AS BLOB))
    + LENGTH(CAST(created_at AS BLOB)) + 40) FROM watch_digests), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(observation_id AS BLOB))
    + LENGTH(CAST(event_id AS BLOB)) + LENGTH(CAST(source_id AS BLOB))
    + LENGTH(CAST(observed_at AS BLOB)) + LENGTH(CAST(status AS BLOB)) + 8)
    FROM digest_change_journal), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(digest_id AS BLOB))
    + LENGTH(CAST(event_id AS BLOB)) + LENGTH(CAST(status AS BLOB)))
    FROM digest_event_refs), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(id AS BLOB))
    + LENGTH(CAST(COALESCE(rule_id,'') AS BLOB)) + LENGTH(CAST(subject_type AS BLOB))
    + LENGTH(CAST(subject_id AS BLOB)) + LENGTH(CAST(channel AS BLOB))
    + LENGTH(CAST(dedupe_key AS BLOB)) + LENGTH(CAST(privacy_json AS BLOB))
    + LENGTH(CAST(state AS BLOB)) + LENGTH(CAST(created_at AS BLOB))
    + LENGTH(CAST(updated_at AS BLOB)) + 8) FROM notification_outbox), 0)
  + COALESCE((SELECT SUM(LENGTH(CAST(mutation_id AS BLOB))
    + LENGTH(CAST(source_id AS BLOB)) + LENGTH(CAST(operation AS BLOB))
    + LENGTH(CAST(COALESCE(before_projection_json,'') AS BLOB))
    + LENGTH(CAST(COALESCE(after_projection_json,'') AS BLOB))
    + LENGTH(CAST(affected_rule_state_json AS BLOB)) + LENGTH(CAST(state AS BLOB))
    + LENGTH(CAST(created_at AS BLOB)) + LENGTH(CAST(updated_at AS BLOB)))
    FROM source_cleanup_intents), 0) AS total`;
