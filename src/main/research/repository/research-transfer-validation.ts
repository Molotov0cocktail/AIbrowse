// Stage 7 semantic validation over a caller-owned, schema-checked connection.
// No paths, migrations, SQL from the database, writes, or connection disposal.
// Capture bodies and vendor-origin proposals were never persisted: this checks
// saved structure/provenance, not the historical truth of webpage statements.
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { isSafeMarkdownUrl } from '../../../shared/markdown/markdown-url';
import * as R from '../../../shared/types/research';
import { isUuidShape } from '../../sources/domain/source-change-set';
import { normalizeSourceUrl } from '../../sources/domain/source-canonical';
import { isIso8601Timestamp } from '../domain/research-task-state';
import { computeUtf8Bytes } from '../domain/research-budget';
import { JsonReadError, parseBoundedJson } from '../../storage/bounded-json';
import { validate } from '../result-validator';
import { buildCandidateSortKey } from '../source-selector';
import {
  CAPTURE_EMPTY_CONTENT_HASH,
  CAPTURE_SENTINEL_DOCUMENT_ID,
  CAPTURE_SENTINEL_TAB_ID,
  normalizeCaptureText,
} from '../capture-service';
import {
  rowToTask,
  rowToCandidate,
  rowToCapture,
  rowToEvidence,
  rowToClaim,
  rowToConflict,
  rowToResult,
  type ResearchTaskRow,
  type ResearchCandidateRow,
  type ResearchCaptureRow,
  type ResearchEvidenceRow,
  type ResearchClaimRow,
  type ResearchConflictRow,
  type ResearchResultRow,
} from './research-repository';

// All storage classes and necessary byte bounds are checked before selecting
// business values. JSON text has its independent raw-input budget.
const PREFLIGHT: readonly [Table, string, string, readonly number[]][] = [
  [
    'tasks',
    `SELECT 1 FROM research_tasks WHERE typeof(id) <> 'text'
      OR typeof(goal) <> 'text'
      OR typeof(status) <> 'text'
      OR typeof(phase) NOT IN ('text','null')
      OR typeof(created_at) <> 'text'
      OR typeof(updated_at) <> 'text'
      OR typeof(started_at) NOT IN ('text','null')
      OR typeof(finished_at) NOT IN ('text','null')
      OR typeof(interrupted_at) NOT IN ('text','null')
      OR typeof(error_code) NOT IN ('text','null')
      OR typeof(result_id) NOT IN ('text','null')
      OR typeof(stats_json) <> 'text' LIMIT 1`,
    `SELECT 1 FROM research_tasks WHERE length(CAST(id AS BLOB)) > ?
      OR length(CAST(goal AS BLOB)) > ?
      OR length(CAST(status AS BLOB)) > ?
      OR length(CAST(phase AS BLOB)) > ?
      OR length(CAST(created_at AS BLOB)) > ?
      OR length(CAST(updated_at AS BLOB)) > ?
      OR length(CAST(started_at AS BLOB)) > ?
      OR length(CAST(finished_at AS BLOB)) > ?
      OR length(CAST(interrupted_at AS BLOB)) > ?
      OR length(CAST(error_code AS BLOB)) > ?
      OR length(CAST(result_id AS BLOB)) > ?
      OR length(CAST(stats_json AS BLOB)) > ? LIMIT 1`,
    [36, 6000, 11, 12, 29, 29, 29, 29, 29, 40, 36, 500000],
  ],
  [
    'candidates',
    `SELECT 1 FROM research_candidates WHERE typeof(candidate_id) <> 'text'
      OR typeof(task_id) <> 'text'
      OR typeof(url) <> 'text'
      OR typeof(display_url) <> 'text'
      OR typeof(title) <> 'text'
      OR typeof(canonical_key) <> 'text'
      OR typeof(scope) <> 'text'
      OR typeof(discovered_via_json) <> 'text'
      OR typeof(source_id) NOT IN ('text','null')
      OR typeof(trust_value) NOT IN ('text','null')
      OR typeof(trust_asserted_by) NOT IN ('text','null')
      OR typeof(trust_verification) NOT IN ('text','null')
      OR typeof(priority) NOT IN ('integer','null')
      OR typeof(last_used_at) NOT IN ('text','null')
      OR typeof(note) NOT IN ('text','null')
      OR typeof(sort_key) <> 'text' LIMIT 1`,
    `SELECT 1 FROM research_candidates WHERE length(CAST(candidate_id AS BLOB)) > ?
      OR length(CAST(task_id AS BLOB)) > ?
      OR length(CAST(url AS BLOB)) > ?
      OR length(CAST(display_url AS BLOB)) > ?
      OR length(CAST(title AS BLOB)) > ?
      OR length(CAST(canonical_key AS BLOB)) > ?
      OR length(CAST(scope AS BLOB)) > ?
      OR length(CAST(discovered_via_json AS BLOB)) > ?
      OR length(CAST(source_id AS BLOB)) > ?
      OR length(CAST(trust_value AS BLOB)) > ?
      OR length(CAST(trust_asserted_by AS BLOB)) > ?
      OR length(CAST(trust_verification AS BLOB)) > ?
      OR length(CAST(last_used_at AS BLOB)) > ?
      OR length(CAST(note AS BLOB)) > ?
      OR length(CAST(sort_key AS BLOB)) > ? LIMIT 1`,
    [36, 36, 500000, 500000, 600, 500000, 6, 500000, 36, 9, 4, 10, 29, 600, 500000],
  ],
  [
    'captures',
    `SELECT 1 FROM research_captures WHERE typeof(capture_id) <> 'text'
      OR typeof(task_id) <> 'text'
      OR typeof(candidate_id) <> 'text'
      OR typeof(tab_id) <> 'text'
      OR typeof(url) <> 'text'
      OR typeof(title) <> 'text'
      OR typeof(access_time) <> 'text'
      OR typeof(document_id) <> 'text'
      OR typeof(content_hash) <> 'text'
      OR typeof(summary_json) <> 'text'
      OR typeof(failed) <> 'integer'
      OR typeof(failure_reason) NOT IN ('text','null') LIMIT 1`,
    `SELECT 1 FROM research_captures WHERE length(CAST(capture_id AS BLOB)) > ?
      OR length(CAST(task_id AS BLOB)) > ?
      OR length(CAST(candidate_id AS BLOB)) > ?
      OR length(CAST(tab_id AS BLOB)) > ?
      OR length(CAST(url AS BLOB)) > ?
      OR length(CAST(title AS BLOB)) > ?
      OR length(CAST(access_time AS BLOB)) > ?
      OR length(CAST(document_id AS BLOB)) > ?
      OR length(CAST(content_hash AS BLOB)) > ?
      OR length(CAST(summary_json AS BLOB)) > ?
      OR length(CAST(failure_reason AS BLOB)) > ? LIMIT 1`,
    [36, 36, 36, 500000, 500000, 500000, 29, 500000, 32, 500000, 24],
  ],
  [
    'evidence',
    `SELECT 1 FROM research_evidence WHERE typeof(evidence_id) <> 'text'
      OR typeof(task_id) <> 'text'
      OR typeof(candidate_id) <> 'text'
      OR typeof(source_id) NOT IN ('text','null')
      OR typeof(capture_id) <> 'text'
      OR typeof(url) <> 'text'
      OR typeof(title) <> 'text'
      OR typeof(access_time) <> 'text'
      OR typeof(document_id) <> 'text'
      OR typeof(content_hash) <> 'text'
      OR typeof(type) <> 'text'
      OR typeof(locator_json) <> 'text'
      OR typeof(excerpt) <> 'text'
      OR typeof(value) NOT IN ('text','null')
      OR typeof(verification) <> 'text' LIMIT 1`,
    `SELECT 1 FROM research_evidence WHERE length(CAST(evidence_id AS BLOB)) > ?
      OR length(CAST(task_id AS BLOB)) > ?
      OR length(CAST(candidate_id AS BLOB)) > ?
      OR length(CAST(source_id AS BLOB)) > ?
      OR length(CAST(capture_id AS BLOB)) > ?
      OR length(CAST(url AS BLOB)) > ?
      OR length(CAST(title AS BLOB)) > ?
      OR length(CAST(access_time AS BLOB)) > ?
      OR length(CAST(document_id AS BLOB)) > ?
      OR length(CAST(content_hash AS BLOB)) > ?
      OR length(CAST(type AS BLOB)) > ?
      OR length(CAST(locator_json AS BLOB)) > ?
      OR length(CAST(excerpt AS BLOB)) > ?
      OR length(CAST(value AS BLOB)) > ?
      OR length(CAST(verification AS BLOB)) > ? LIMIT 1`,
    [36, 36, 36, 36, 36, 500000, 500000, 29, 500000, 32, 13, 500000, 1500, 1500, 8],
  ],
  [
    'claims',
    `SELECT 1 FROM research_claims WHERE typeof(claim_id) <> 'text'
      OR typeof(task_id) <> 'text'
      OR typeof(text) <> 'text'
      OR typeof(severity) <> 'text'
      OR typeof(coverage) <> 'text'
      OR typeof(source_types_json) <> 'text'
      OR typeof(evidence_ids_json) <> 'text'
      OR typeof(single_source_fields_json) <> 'text'
      OR typeof(conflict_ids_json) <> 'text' LIMIT 1`,
    `SELECT 1 FROM research_claims WHERE length(CAST(claim_id AS BLOB)) > ?
      OR length(CAST(task_id AS BLOB)) > ?
      OR length(CAST(text AS BLOB)) > ?
      OR length(CAST(severity AS BLOB)) > ?
      OR length(CAST(coverage AS BLOB)) > ?
      OR length(CAST(source_types_json AS BLOB)) > ?
      OR length(CAST(evidence_ids_json AS BLOB)) > ?
      OR length(CAST(single_source_fields_json AS BLOB)) > ?
      OR length(CAST(conflict_ids_json AS BLOB)) > ? LIMIT 1`,
    [36, 36, 1500, 6, 13, 500000, 500000, 500000, 500000],
  ],
  [
    'conflicts',
    `SELECT 1 FROM research_conflicts WHERE typeof(conflict_id) <> 'text'
      OR typeof(task_id) <> 'text'
      OR typeof(topic) <> 'text'
      OR typeof(positions_json) <> 'text'
      OR typeof(claim_ids_json) <> 'text'
      OR typeof(resolved) <> 'text' LIMIT 1`,
    `SELECT 1 FROM research_conflicts WHERE length(CAST(conflict_id AS BLOB)) > ?
      OR length(CAST(task_id AS BLOB)) > ?
      OR length(CAST(topic AS BLOB)) > ?
      OR length(CAST(positions_json AS BLOB)) > ?
      OR length(CAST(claim_ids_json AS BLOB)) > ?
      OR length(CAST(resolved AS BLOB)) > ? LIMIT 1`,
    [36, 36, 600, 500000, 500000, 10],
  ],
  [
    'results',
    `SELECT 1 FROM research_results WHERE typeof(result_id) <> 'text'
      OR typeof(task_id) <> 'text'
      OR typeof(title) <> 'text'
      OR typeof(summary) <> 'text'
      OR typeof(blocks_json) <> 'text'
      OR typeof(evidence_map_json) <> 'text'
      OR typeof(conflicts_json) <> 'text'
      OR typeof(coverage_json) <> 'text'
      OR typeof(fetched_at) <> 'text' LIMIT 1`,
    `SELECT 1 FROM research_results WHERE length(CAST(result_id AS BLOB)) > ?
      OR length(CAST(task_id AS BLOB)) > ?
      OR length(CAST(title AS BLOB)) > ?
      OR length(CAST(summary AS BLOB)) > ?
      OR length(CAST(blocks_json AS BLOB)) > ?
      OR length(CAST(evidence_map_json AS BLOB)) > ?
      OR length(CAST(conflicts_json AS BLOB)) > ?
      OR length(CAST(coverage_json AS BLOB)) > ?
      OR length(CAST(fetched_at AS BLOB)) > ? LIMIT 1`,
    [36, 36, 360, 6000, 500000, 500000, 500000, 500000, 29],
  ],
];
// A necessary lower bound, not raw JSON SUM: valid escaped/pretty JSON can be
// larger than the closed JSON.stringify projection. Exact domain accounting
// still runs after bounded parsing; these plain values alone cannot exceed it.
const TASK_PLAIN_BYTES = `SELECT 1 FROM (
  SELECT id AS task_id, coalesce(length(CAST(id AS BLOB)),0)+coalesce(length(CAST(goal AS BLOB)),0)+coalesce(length(CAST(status AS BLOB)),0)+coalesce(length(CAST(phase AS BLOB)),0)+coalesce(length(CAST(created_at AS BLOB)),0)+coalesce(length(CAST(updated_at AS BLOB)),0)+coalesce(length(CAST(started_at AS BLOB)),0)+coalesce(length(CAST(finished_at AS BLOB)),0)+coalesce(length(CAST(interrupted_at AS BLOB)),0)+coalesce(length(CAST(error_code AS BLOB)),0)+coalesce(length(CAST(result_id AS BLOB)),0) AS bytes FROM research_tasks
    UNION ALL
    SELECT task_id AS task_id, coalesce(length(CAST(candidate_id AS BLOB)),0)+coalesce(length(CAST(url AS BLOB)),0)+coalesce(length(CAST(display_url AS BLOB)),0)+coalesce(length(CAST(title AS BLOB)),0)+coalesce(length(CAST(canonical_key AS BLOB)),0)+coalesce(length(CAST(scope AS BLOB)),0)+coalesce(length(CAST(source_id AS BLOB)),0)+coalesce(length(CAST(trust_value AS BLOB)),0)+coalesce(length(CAST(trust_asserted_by AS BLOB)),0)+coalesce(length(CAST(trust_verification AS BLOB)),0)+coalesce(length(CAST(last_used_at AS BLOB)),0)+coalesce(length(CAST(note AS BLOB)),0)+coalesce(length(CAST(sort_key AS BLOB)),0) AS bytes FROM research_candidates
    UNION ALL
    SELECT task_id AS task_id, coalesce(length(CAST(capture_id AS BLOB)),0)+coalesce(length(CAST(task_id AS BLOB)),0)+coalesce(length(CAST(candidate_id AS BLOB)),0)+coalesce(length(CAST(tab_id AS BLOB)),0)+coalesce(length(CAST(url AS BLOB)),0)+coalesce(length(CAST(title AS BLOB)),0)+coalesce(length(CAST(access_time AS BLOB)),0)+coalesce(length(CAST(document_id AS BLOB)),0)+coalesce(length(CAST(content_hash AS BLOB)),0)+coalesce(length(CAST(failure_reason AS BLOB)),0) AS bytes FROM research_captures
    UNION ALL
    SELECT task_id AS task_id, coalesce(length(CAST(evidence_id AS BLOB)),0)+coalesce(length(CAST(task_id AS BLOB)),0)+coalesce(length(CAST(candidate_id AS BLOB)),0)+coalesce(length(CAST(source_id AS BLOB)),0)+coalesce(length(CAST(capture_id AS BLOB)),0)+coalesce(length(CAST(url AS BLOB)),0)+coalesce(length(CAST(title AS BLOB)),0)+coalesce(length(CAST(access_time AS BLOB)),0)+coalesce(length(CAST(document_id AS BLOB)),0)+coalesce(length(CAST(content_hash AS BLOB)),0)+coalesce(length(CAST(type AS BLOB)),0)+coalesce(length(CAST(excerpt AS BLOB)),0)+coalesce(length(CAST(value AS BLOB)),0)+coalesce(length(CAST(verification AS BLOB)),0) AS bytes FROM research_evidence
    UNION ALL
    SELECT task_id AS task_id, coalesce(length(CAST(claim_id AS BLOB)),0)+coalesce(length(CAST(task_id AS BLOB)),0)+coalesce(length(CAST(text AS BLOB)),0)+coalesce(length(CAST(severity AS BLOB)),0)+coalesce(length(CAST(coverage AS BLOB)),0) AS bytes FROM research_claims
    UNION ALL
    SELECT task_id AS task_id, coalesce(length(CAST(conflict_id AS BLOB)),0)+coalesce(length(CAST(task_id AS BLOB)),0)+coalesce(length(CAST(topic AS BLOB)),0)+coalesce(length(CAST(resolved AS BLOB)),0) AS bytes FROM research_conflicts
    UNION ALL
    SELECT task_id AS task_id, coalesce(length(CAST(result_id AS BLOB)),0)+coalesce(length(CAST(task_id AS BLOB)),0)+coalesce(length(CAST(title AS BLOB)),0)+coalesce(length(CAST(summary AS BLOB)),0)+coalesce(length(CAST(fetched_at AS BLOB)),0) AS bytes FROM research_results
) GROUP BY task_id HAVING sum(bytes)>? LIMIT 1`;

const QUERIES = {
  tasks: 'SELECT * FROM research_tasks',
  candidates: 'SELECT * FROM research_candidates',
  captures: 'SELECT * FROM research_captures',
  evidence: 'SELECT * FROM research_evidence',
  claims: 'SELECT * FROM research_claims',
  conflicts: 'SELECT * FROM research_conflicts',
  results: 'SELECT * FROM research_results',
} as const;
type Table = keyof typeof QUERIES;
type Code =
  'row-invalid' | 'json-invalid' | 'reference-invalid' | 'budget-exceeded' | 'sqlite-error';
export type ResearchTransferValidationResult =
  | { ok: true; counts: Record<Table, number>; persistedBytes: number }
  | { ok: false; code: Code; table: Table };

class Invalid extends Error {
  constructor(readonly code: Code) {
    super(code);
  }
}
function requireValid(condition: unknown, code: Code = 'row-invalid'): asserts condition {
  if (!condition) throw new Invalid(code);
}
type Check = (v: unknown) => boolean;
const text: Check = (v) => typeof v === 'string';
const nonempty: Check = (v) => text(v) && (v as string).length > 0;
const uuid: Check = (v) =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const integer: Check = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);
const bounded =
  (max: number, min = 0): Check =>
  (v) =>
    typeof v === 'string' && v.length >= min && v.length <= max;
const numberMax =
  (max: number): Check =>
  (v) =>
    integer(v) && (v as number) <= max;
const enumeration =
  (values: readonly unknown[]): Check =>
  (v) =>
    values.includes(v);
const object: Check = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function fields(value: unknown, shape: Record<string, Check>): boolean {
  if (!object(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === Object.keys(shape).length &&
    Object.entries(shape).every(([key, check]) => Object.hasOwn(record, key) && check(record[key]))
  );
}
const array =
  (check: Check, max: number, min = 0, unique = false): Check =>
  (v) =>
    Array.isArray(v) &&
    v.length >= min &&
    v.length <= max &&
    v.every(check) &&
    (!unique || new Set(v).size === v.length);
const refs = (max: number, min = 0): Check => array(uuid, max, min, true);
const sourceTypes = array(enumeration(['vendor', 'third-party', 'community']), 3, 1, true);

// These preparse limits are wider than every closed persisted domain shape.
// Nodes count values, not object keys. Size uses UTF8, matching task budgets.
function parseJson(value: unknown): unknown {
  requireValid(typeof value === 'string', 'json-invalid');
  requireValid(computeUtf8Bytes(value) <= R.MAX_TASK_PERSISTED_CHARS, 'budget-exceeded');
  try {
    return parseBoundedJson(value, {
      bytes: R.MAX_TASK_PERSISTED_CHARS,
      depth: 16,
      nodes: R.MAX_TASK_PERSISTED_CHARS,
    });
  } catch (error) {
    throw new Invalid(
      error instanceof JsonReadError && error.code === 'budget-exceeded'
        ? 'budget-exceeded'
        : 'json-invalid',
    );
  }
}
const json =
  (check: Check): Check =>
  (v) => {
    requireValid(check(parseJson(v)), 'json-invalid');
    return true;
  };
const statsShape = {
  candidateCount: numberMax(R.MAX_SOURCE_CANDIDATES),
  selectedCount: numberMax(R.MAX_SELECTED_SOURCES),
  captureCount: numberMax(R.MAX_CAPTURES_PER_TASK),
  failedReadCount: numberMax(R.MAX_CAPTURES_PER_TASK),
  evidenceCount: numberMax(R.MAX_EVIDENCE_PER_TASK),
  rejectedEvidenceCount: integer,
  claimCount: numberMax(R.MAX_CLAIMS_PER_TASK),
  conflictCount: numberMax(R.MAX_CONFLICTS_PER_TASK),
  stepsUsed: numberMax(R.MAX_RESEARCH_TOOL_STEPS),
  roundsUsed: numberMax(R.MAX_RESEARCH_ROUNDS),
};
const summaryShape = {
  sectionCount: integer,
  tableCount: integer,
  headingCount: integer,
  charCount: numberMax(R.MAX_PAGE_CAPTURE_CHARS),
};
const position: Check = (v) =>
  fields(v, {
    positionText: bounded(R.MAX_CONFLICT_POSITION_CHARS, 1),
    sourceRefs: refs(R.MAX_CONFLICT_POSITION_SOURCE_REFS, 1),
  });
const positions = array(position, R.MAX_CONFLICT_POSITIONS, 2);
const locator: Check = (v) => {
  if (!object(v)) return false;
  const record = v as Record<string, unknown>;
  switch (record.kind) {
    case 'text':
      return fields(v, {
        kind: enumeration(['text']),
        excerpt: bounded(R.MAX_EVIDENCE_EXCERPT_CHARS, 1),
      });
    case 'table': {
      const shape = {
        kind: enumeration(['table']),
        tableIndex: integer,
        row: integer,
        col: integer,
      };
      return fields(v, shape) || fields(v, { ...shape, header: nullable(text) });
    }
    case 'field':
      return fields(v, {
        kind: enumeration(['field']),
        fieldPath: (p) =>
          bounded(R.MAX_EVIDENCE_LOCATOR_FIELD_PATH_CHARS, 1)(p) &&
          /^(?:page\.(?:url|title)|headings\[0\]\.text|links\[0\]\.(?:text|href)|tables\[\d+\]\.cell\[\d+\]\[\d+\])$/.test(
            p as string,
          ),
      });
    default:
      return false;
  }
};
const SHAPES: Record<Table, Record<string, Check>> = {
  tasks: {
    id: uuid,
    goal: bounded(R.MAX_GOAL_CHARS, 1),
    status: enumeration(R.RESEARCH_STATUSES),
    phase: nullable(enumeration(R.RESEARCH_PHASES)),
    created_at: isIso8601Timestamp,
    updated_at: isIso8601Timestamp,
    started_at: nullable(isIso8601Timestamp),
    finished_at: nullable(isIso8601Timestamp),
    interrupted_at: nullable(isIso8601Timestamp),
    error_code: nullable(enumeration(R.RESEARCH_ERROR_CODES)),
    result_id: nullable(uuid),
    stats_json: json((v) => fields(v, statsShape)),
  },
  candidates: {
    candidate_id: uuid,
    task_id: uuid,
    url: nonempty,
    display_url: nonempty,
    title: bounded(R.MAX_CANDIDATE_TITLE_CHARS),
    canonical_key: nonempty,
    scope: enumeration(['origin', 'page']),
    discovered_via_json: json(array(enumeration(['sources', 'search']), 2, 1, true)),
    source_id: nullable(isUuidShape),
    trust_value: nullable(
      enumeration(['official', 'primary', 'secondary', 'community', 'unknown']),
    ),
    trust_asserted_by: nullable(enumeration(['user', 'ai'])),
    trust_verification: nullable(enumeration(['asserted', 'unverified'])),
    priority: nullable((v) => numberMax(5)(v) && v !== 0),
    last_used_at: nullable(isIso8601Timestamp),
    note: nullable(bounded(R.MAX_CANDIDATE_NOTE_CHARS)),
    sort_key: nonempty,
  },
  captures: {
    capture_id: uuid,
    task_id: uuid,
    candidate_id: uuid,
    tab_id: nonempty,
    url: nonempty,
    title: text,
    access_time: isIso8601Timestamp,
    document_id: nonempty,
    content_hash: (v) => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v),
    summary_json: json((v) => fields(v, summaryShape)),
    failed: enumeration([0, 1]),
    failure_reason: nullable(
      enumeration([
        'page-load-failed',
        'snapshot-degraded',
        'tab-closed-by-user',
        'timeout',
        'aborted',
        'http-scheme-rejected',
      ]),
    ),
  },
  evidence: {
    evidence_id: uuid,
    task_id: uuid,
    candidate_id: uuid,
    source_id: nullable(isUuidShape),
    capture_id: uuid,
    url: nonempty,
    title: text,
    access_time: isIso8601Timestamp,
    document_id: nonempty,
    content_hash: (v) => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v),
    type: enumeration(['quote', 'table-cell', 'field', 'summary-point']),
    locator_json: json(locator),
    excerpt: bounded(R.MAX_EVIDENCE_EXCERPT_CHARS),
    // Historical verifyEvidence accepts an excerpt-only proposal up to 500.
    value: nullable(bounded(R.MAX_EVIDENCE_EXCERPT_CHARS)),
    verification: enumeration(['verified']),
  },
  claims: {
    claim_id: uuid,
    task_id: uuid,
    text: bounded(R.MAX_CLAIM_TEXT_CHARS, 1),
    severity: enumeration(['high', 'medium', 'low']),
    coverage: enumeration(['multi-source', 'single-source']),
    source_types_json: json(sourceTypes),
    evidence_ids_json: json(refs(R.MAX_CLAIM_EVIDENCE_REFS, 1)),
    single_source_fields_json: json(
      (v) => isDeepStrictEqual(v, []) || isDeepStrictEqual(v, ['整条结论']),
    ),
    conflict_ids_json: json(refs(R.MAX_CONFLICTS_PER_TASK)),
  },
  conflicts: {
    conflict_id: uuid,
    task_id: uuid,
    topic: bounded(R.MAX_CONFLICT_TOPIC_CHARS, 1),
    positions_json: json(positions),
    claim_ids_json: json(refs(R.MAX_CONFLICT_CLAIM_REFS, 2)),
    resolved: enumeration(['explicit', 'unresolved']),
  },
  results: {
    result_id: uuid,
    task_id: uuid,
    title: bounded(R.MAX_RESULT_TITLE_CHARS, 1),
    summary: bounded(R.MAX_RESULT_SUMMARY_CHARS),
    blocks_json: json(array(object, R.MAX_RESULT_BLOCKS, 1)),
    evidence_map_json: json(object),
    conflicts_json: json(array(object, R.MAX_CONFLICTS_PER_TASK)),
    coverage_json: json((v) =>
      fields(v, {
        total: integer,
        multiSource: integer,
        singleSource: integer,
        vendor: integer,
        thirdParty: integer,
        community: integer,
      }),
    ),
    fetched_at: isIso8601Timestamp,
  },
};

interface TaskData {
  task: R.ResearchTask;
  bytes: number;
  candidates: R.SourceCandidate[];
  captures: R.Capture[];
  evidence: R.VerifiedEvidence[];
  claims: R.Claim[];
  conflicts: R.Conflict[];
  results: R.ResearchResult[];
}
function present<T>(value: T | null | undefined): T {
  requireValid(value !== null && value !== undefined, 'reference-invalid');
  return value;
}
function validateTask(task: R.ResearchTask): void {
  if (task.status === 'created') {
    requireValid(
      task.startedAt === null &&
        task.finishedAt === null &&
        task.interruptedAt === null &&
        task.errorCode === null &&
        task.resultId === null &&
        task.phase === null,
    );
    requireValid(Object.values(task.stats).every((value) => value === 0));
    return;
  }
  requireValid(task.startedAt !== null);
  if (task.status === 'running') {
    requireValid(
      task.phase !== null &&
        task.finishedAt === null &&
        task.interruptedAt === null &&
        task.errorCode === null &&
        task.resultId === null,
    );
    return;
  }
  requireValid(task.phase === null);
  if (task.status === 'interrupted') {
    requireValid(
      task.interruptedAt !== null &&
        task.finishedAt === null &&
        task.errorCode === null &&
        task.resultId === null,
    );
  } else {
    requireValid(task.finishedAt !== null && task.interruptedAt === null);
    requireValid(task.status === 'failed' ? task.errorCode !== null : task.errorCode === null);
    requireValid(task.status === 'completed' ? task.resultId !== null : task.resultId === null);
  }
}
function validateCandidate(candidate: R.SourceCandidate, row: ResearchCandidateRow): void {
  const normal = normalizeSourceUrl(candidate.url, candidate.scope);
  requireValid(
    normal.ok &&
      normal.canonicalKey === candidate.canonicalKey &&
      normal.displayUrl === candidate.displayUrl,
  );
  const triple = [row.trust_value, row.trust_asserted_by, row.trust_verification];
  requireValid(triple.every((v) => v === null) || triple.every((v) => v !== null));
  requireValid(
    candidate.trust?.assertedBy !== 'ai' || candidate.trust.verification === 'unverified',
  );
  requireValid(
    candidate.trust?.assertedBy !== 'user' || candidate.trust.verification === 'asserted',
  );
  if (candidate.sourceId === null) {
    requireValid(
      candidate.trust === null &&
        candidate.priority === null &&
        candidate.lastUsedAt === null &&
        candidate.note === null,
    );
  }
  requireValid(candidate.discoveredVia.includes('sources') === (candidate.sourceId !== null));
  const parts = candidate.sortKey.split('|');
  const tier = Number(parts[0]);
  const rank = Number(parts[1]);
  requireValid((tier === 3) === (candidate.sourceId === null));
  requireValid(
    (tier === 1 || tier === 2 || tier === 3) &&
      Number.isInteger(rank) &&
      rank >= 0 &&
      rank <= 99999,
  );
  requireValid(
    buildCandidateSortKey({
      tier,
      inputRank: rank,
      priority: candidate.priority,
      lastUsedAt: candidate.lastUsedAt,
      scope: candidate.scope,
      canonicalKey: candidate.canonicalKey,
      candidateId: candidate.id,
    }) === candidate.sortKey,
  );
}

function validateReferences(data: TaskData, markTable: (table: Table) => void): void {
  const { task, candidates, captures, evidence, claims, conflicts, results } = data;
  markTable('tasks');
  if (task.status === 'completed') {
    requireValid(
      task.stats.candidateCount === candidates.length &&
        task.stats.captureCount === captures.length &&
        task.stats.failedReadCount === captures.filter((c) => c.failed).length &&
        task.stats.evidenceCount === evidence.length &&
        task.stats.claimCount === claims.length &&
        task.stats.conflictCount === conflicts.length &&
        task.stats.selectedCount <= candidates.length,
      'reference-invalid',
    );
  }
  requireValid(
    task.status !== 'created' ||
      candidates.length +
        captures.length +
        evidence.length +
        claims.length +
        conflicts.length +
        results.length ===
        0,
    'reference-invalid',
  );
  markTable('candidates');
  const identities = new Set<string>();
  for (const candidate of candidates) {
    const identity = `${candidate.scope}\0${candidate.canonicalKey}`;
    requireValid(!identities.has(identity), 'reference-invalid');
    identities.add(identity);
  }
  const candidate = (id: string): R.SourceCandidate => present(candidates.find((c) => c.id === id));
  markTable('captures');
  for (const capture of captures) {
    const owner = candidate(capture.candidateId);
    // The capture stores WHATWG output, which may exceed the old raw-input
    // URL limit after percent encoding. Recheck the serialized identity only.
    requireValid(isSafeMarkdownUrl(capture.url) && new URL(capture.url).href === capture.url);
    requireValid(
      capture.summary.sectionCount <= capture.summary.charCount &&
        capture.summary.tableCount <= capture.summary.sectionCount &&
        capture.summary.headingCount <= capture.summary.sectionCount,
    );
    if (capture.failed) {
      requireValid(
        capture.failureReason !== null &&
          capture.documentId === CAPTURE_SENTINEL_DOCUMENT_ID &&
          capture.contentHash === CAPTURE_EMPTY_CONTENT_HASH &&
          Object.values(capture.summary).every((n) => n === 0),
      );
      requireValid(
        capture.url === owner.displayUrl && capture.title === owner.title,
        'reference-invalid',
      );
    } else {
      requireValid(
        capture.failureReason === null &&
          capture.tabId !== CAPTURE_SENTINEL_TAB_ID &&
          /^\d+$/.test(capture.documentId),
      );
    }
  }
  markTable('evidence');
  for (const item of evidence) {
    requireValid(normalizeCaptureText(item.excerpt) === item.excerpt);
    const owner = candidate(item.candidateId);
    const capture = present(captures.find((c) => c.captureId === item.captureId));
    requireValid(
      !capture.failed &&
        capture.candidateId === item.candidateId &&
        item.sourceId === owner.sourceId,
      'reference-invalid',
    );
    requireValid(
      item.url === capture.url &&
        item.title === capture.title &&
        item.accessTime === capture.accessTime &&
        item.documentId === capture.documentId &&
        item.contentHash === capture.contentHash,
      'reference-invalid',
    );
    if (item.type === 'quote' || item.type === 'summary-point') {
      requireValid(
        item.locator.kind === 'text' &&
          item.excerpt.length > 0 &&
          item.locator.excerpt === item.excerpt &&
          item.value === null,
      );
    } else {
      requireValid(item.value !== null && item.value === item.excerpt);
      requireValid(
        item.type === 'field'
          ? item.locator.kind === 'field'
          : item.locator.kind === 'table' && item.value.length > 0,
      );
      if (item.locator.kind === 'table')
        requireValid(item.locator.tableIndex < capture.summary.tableCount);
    }
  }
  markTable('claims');
  for (const claim of claims) {
    requireValid(normalizeCaptureText(claim.text) === claim.text);
    const sources = claim.evidenceIds.map((id) =>
      candidate(present(evidence.find((e) => e.evidenceId === id)).candidateId),
    );
    const multi = new Set(sources.map((c) => c.canonicalKey)).size >= 2;
    requireValid(
      claim.coverage === (multi ? 'multi-source' : 'single-source'),
      'reference-invalid',
    );
    requireValid(
      isDeepStrictEqual(claim.singleSourceFields, multi ? [] : ['整条结论']),
      'reference-invalid',
    );
    const community = sources.some((c) => c.trust?.value === 'community');
    const official = sources.some((c) => c.trust?.value === 'official');
    const thirdParty = sources.some(
      (c) => c.trust?.value !== 'community' && c.trust?.value !== 'official',
    );
    requireValid(
      claim.sourceTypes.includes('community') === community &&
        (!claim.sourceTypes.includes('vendor') || official) &&
        (!thirdParty || claim.sourceTypes.includes('third-party')) &&
        (!claim.sourceTypes.includes('third-party') || thirdParty || official) &&
        (!official ||
          claim.sourceTypes.includes('vendor') ||
          claim.sourceTypes.includes('third-party')) &&
        isDeepStrictEqual(
          claim.sourceTypes,
          ['vendor', 'third-party', 'community'].filter((type) =>
            claim.sourceTypes.includes(type as R.SourceTypeClass),
          ),
        ),
      'reference-invalid',
    );
    for (const id of claim.conflictIds)
      requireValid(
        present(conflicts.find((c) => c.conflictId === id)).claimIds.includes(claim.claimId),
        'reference-invalid',
      );
  }
  markTable('conflicts');
  for (const conflict of conflicts) {
    requireValid(
      normalizeCaptureText(conflict.topic) === conflict.topic &&
        conflict.positions.every((p) => normalizeCaptureText(p.positionText) === p.positionText) &&
        new Set(conflict.positions.map((p) => p.positionText)).size >= 2,
    );
    const union = new Set<string>();
    for (const id of conflict.claimIds) {
      const claim = present(claims.find((c) => c.claimId === id));
      requireValid(claim.conflictIds.includes(conflict.conflictId), 'reference-invalid');
      for (const eid of claim.evidenceIds)
        union.add(present(evidence.find((e) => e.evidenceId === eid)).candidateId);
    }
    requireValid(
      new Set([...union].map((id) => candidate(id).canonicalKey)).size >= 2,
      'reference-invalid',
    );
    for (const position of conflict.positions)
      for (const id of position.sourceRefs) requireValid(union.has(id), 'reference-invalid');
  }
  markTable('results');
  requireValid(
    task.status === 'completed'
      ? results.length === 1 && task.resultId === results[0]?.resultId
      : results.length === 0 && task.resultId === null,
    'reference-invalid',
  );
  for (const result of results) {
    // Conflict row order is not stored. Match the result's explicit order.
    const ordered = result.conflicts.map((c) =>
      present(conflicts.find((row) => row.conflictId === c.conflictId)),
    );
    requireValid(
      ordered.length === conflicts.length && new Set(ordered).size === ordered.length,
      'reference-invalid',
    );
    const checked = validate(
      { title: result.title, summary: result.summary, blocks: result.blocks },
      {
        taskId: task.id,
        candidates,
        evidence,
        claims,
        conflicts: ordered,
        verificationState: 'verified',
        now: result.fetchedAt,
        createId: () => result.resultId,
      },
    );
    requireValid(checked.ok && isDeepStrictEqual(checked.result, result), 'reference-invalid');
  }
}

export function validateResearchTransfer(db: DatabaseSync): ResearchTransferValidationResult {
  let table: Table = 'tasks';
  const counts: Record<Table, number> = {
    tasks: 0,
    candidates: 0,
    captures: 0,
    evidence: 0,
    claims: 0,
    conflicts: 0,
    results: 0,
  };
  const tasks = new Map<string, TaskData>();
  try {
    for (const [name, types, sizes, bounds] of PREFLIGHT) {
      table = name;
      requireValid(db.prepare(types).get() === undefined, 'row-invalid');
      requireValid(db.prepare(sizes).get(...bounds) === undefined, 'budget-exceeded');
    }
    table = 'tasks';
    requireValid(
      db.prepare(TASK_PLAIN_BYTES).get(R.MAX_TASK_PERSISTED_CHARS) === undefined,
      'budget-exceeded',
    );
    for (const name of Object.keys(QUERIES) as Table[]) {
      table = name;
      for (const row of db.prepare(QUERIES[name]).iterate()) {
        requireValid(fields(row, SHAPES[name]));
        counts[name] += 1;
        if (name === 'tasks') {
          requireValid(counts.tasks <= R.MAX_STORED_TASKS, 'budget-exceeded');
          const task = present(rowToTask(row as unknown as ResearchTaskRow));
          requireValid(!tasks.has(task.id));
          validateTask(task);
          tasks.set(task.id, {
            task,
            bytes: computeUtf8Bytes(JSON.stringify(task)),
            candidates: [],
            captures: [],
            evidence: [],
            claims: [],
            conflicts: [],
            results: [],
          });
          continue;
        }
        const data = present(tasks.get(row.task_id as string));
        let projected: unknown;
        switch (name) {
          case 'candidates': {
            const typed = row as unknown as ResearchCandidateRow;
            const item = present(rowToCandidate(typed));
            validateCandidate(item, typed);
            data.candidates.push(item);
            projected = item;
            requireValid(data.candidates.length <= R.MAX_SOURCE_CANDIDATES, 'budget-exceeded');
            break;
          }
          case 'captures': {
            const item = present(rowToCapture(row as unknown as ResearchCaptureRow));
            data.captures.push(item);
            projected = item;
            requireValid(data.captures.length <= R.MAX_CAPTURES_PER_TASK, 'budget-exceeded');
            break;
          }
          case 'evidence': {
            const item = present(rowToEvidence(row as unknown as ResearchEvidenceRow));
            data.evidence.push(item);
            projected = item;
            requireValid(data.evidence.length <= R.MAX_EVIDENCE_PER_TASK, 'budget-exceeded');
            break;
          }
          case 'claims': {
            const item = present(rowToClaim(row as unknown as ResearchClaimRow));
            data.claims.push(item);
            projected = item;
            requireValid(data.claims.length <= R.MAX_CLAIMS_PER_TASK, 'budget-exceeded');
            break;
          }
          case 'conflicts': {
            const item = present(rowToConflict(row as unknown as ResearchConflictRow));
            data.conflicts.push(item);
            projected = item;
            requireValid(data.conflicts.length <= R.MAX_CONFLICTS_PER_TASK, 'budget-exceeded');
            break;
          }
          case 'results': {
            const item = present(rowToResult(row as unknown as ResearchResultRow));
            // Result JSON is compared raw to the domain projection too: parsers
            // must not hide extra fields or silently replace malformed values.
            requireValid(
              isDeepStrictEqual(parseJson(row.blocks_json), item.blocks) &&
                isDeepStrictEqual(parseJson(row.evidence_map_json), item.evidenceMap) &&
                isDeepStrictEqual(parseJson(row.conflicts_json), item.conflicts) &&
                isDeepStrictEqual(parseJson(row.coverage_json), item.coverage),
              'json-invalid',
            );
            data.results.push(item);
            projected = item;
            requireValid(data.results.length <= 1, 'budget-exceeded');
            break;
          }
        }
        data.bytes += computeUtf8Bytes(JSON.stringify(projected));
        requireValid(data.bytes <= R.MAX_TASK_PERSISTED_CHARS, 'budget-exceeded');
      }
    }
    for (const data of tasks.values()) {
      requireValid(data.bytes <= R.MAX_TASK_PERSISTED_CHARS, 'budget-exceeded');
      validateReferences(data, (name) => {
        table = name;
      });
    }
    return {
      ok: true,
      counts,
      persistedBytes: [...tasks.values()].reduce((sum, t) => sum + t.bytes, 0),
    };
  } catch (error) {
    return { ok: false, code: error instanceof Invalid ? error.code : 'sqlite-error', table };
  }
}
