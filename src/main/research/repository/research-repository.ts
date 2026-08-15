// Fifth Stage C1: ResearchRepository — the single business-SQL execution point
// for research.db (detailed-design §9.1, adjudications #101–#111). Every
// business statement is a compile-time constant with positional bound
// parameters; there is no dynamic SQL and no user/model/web text outside bound
// parameters. JSON columns are validated field-by-field on read (malformed
// input fails closed — the row is dropped, never thrown through). Evidence
// writes accept only the verified narrow type (adjudication #102; the schema
// CHECK is the database-level backstop). Persisted-budget enforcement
// (adjudication #103): every write pre-checks cumulative UTF-8 bytes of the
// task's serialized rows inside the caller's transaction and throws
// RepositoryError('task-persisted-budget-exceeded') on overflow. Callers own
// transactions (withTransaction) so multi-statement writes commit or roll back
// together.
import type { DbHandle } from '../db/research-driver';
import type {
  CandidateOrigin,
  Capture,
  CaptureFailureReason,
  CaptureSummary,
  Claim,
  ClaimSeverity,
  Conflict,
  ConflictPosition,
  CoverageKind,
  EvidenceLocator,
  EvidenceType,
  ResearchErrorCode,
  ResearchPhase,
  ResearchResult,
  ResearchTask,
  ResearchTaskStats,
  ResearchTaskStatus,
  ResultBlock,
  SourceCandidate,
  SourceTypeClass,
  SourceTrustAssertedBy,
  SourceTrustValue,
  SourceTrustVerification,
  VerifiedEvidence,
} from '../../../shared/types/research';
import { MAX_STORED_TASKS, MAX_TASK_PERSISTED_CHARS } from '../../../shared/types/research';
import { computeUtf8Bytes, isWithinPersistedBudget } from '../domain/research-budget';

export type ResearchRepositoryErrorCode = 'task-persisted-budget-exceeded' | 'sqlite-error';

export class RepositoryError extends Error {
  readonly code: ResearchRepositoryErrorCode;

  constructor(code: ResearchRepositoryErrorCode, message: string) {
    super(message);
    this.name = 'RepositoryError';
    this.code = code;
  }
}

// ---------- 行类型（snake_case 列名，与 migration v1 一致） ----------

export interface ResearchTaskRow {
  id: string;
  goal: string;
  status: ResearchTaskStatus;
  phase: ResearchPhase | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  interrupted_at: string | null;
  error_code: ResearchErrorCode | null;
  result_id: string | null;
  stats_json: string;
}

export interface ResearchCandidateRow {
  candidate_id: string;
  task_id: string;
  url: string;
  display_url: string;
  title: string;
  canonical_key: string;
  scope: 'origin' | 'page';
  discovered_via_json: string;
  source_id: string | null;
  trust_value: SourceTrustValue | null;
  trust_asserted_by: SourceTrustAssertedBy | null;
  trust_verification: SourceTrustVerification | null;
  priority: number | null;
  last_used_at: string | null;
  note: string | null;
  sort_key: string;
}

export interface ResearchCaptureRow {
  capture_id: string;
  task_id: string;
  candidate_id: string;
  tab_id: string;
  url: string;
  title: string;
  access_time: string;
  document_id: string;
  content_hash: string;
  summary_json: string;
  failed: number; // 0/1（CHECK 约束）
  failure_reason: CaptureFailureReason | null;
}

export interface ResearchEvidenceRow {
  evidence_id: string;
  task_id: string;
  candidate_id: string;
  source_id: string | null;
  capture_id: string;
  url: string;
  title: string;
  access_time: string;
  document_id: string;
  content_hash: string;
  type: EvidenceType;
  locator_json: string;
  excerpt: string;
  value: string | null;
  verification: 'verified'; // 决议 #102：行类型仅 verified（rejected 永不落库）
}

export interface ResearchClaimRow {
  claim_id: string;
  task_id: string;
  text: string;
  severity: ClaimSeverity;
  coverage: CoverageKind;
  source_types_json: string;
  evidence_ids_json: string;
  single_source_fields_json: string;
  conflict_ids_json: string;
}

export interface ResearchConflictRow {
  conflict_id: string;
  task_id: string;
  topic: string;
  positions_json: string;
  claim_ids_json: string;
  resolved: 'explicit' | 'unresolved';
}

export interface ResearchResultRow {
  result_id: string;
  task_id: string;
  title: string;
  summary: string;
  blocks_json: string;
  evidence_map_json: string;
  conflicts_json: string;
  coverage_json: string;
  fetched_at: string;
}

// ---------- JSON 形状校验（逐字段；畸形 fail-closed null，不抛穿） ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null; // 畸形 JSON fail-closed
  }
}

function parseJsonArray(raw: unknown): unknown[] | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isNonNegativeInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

export function parseStatsJson(raw: unknown): ResearchTaskStats | null {
  const obj = parseJsonObject(raw);
  if (obj === null) return null;
  const fields: Array<keyof ResearchTaskStats> = [
    'candidateCount',
    'selectedCount',
    'captureCount',
    'failedReadCount',
    'evidenceCount',
    'rejectedEvidenceCount',
    'claimCount',
    'conflictCount',
    'stepsUsed',
    'roundsUsed',
  ];
  for (const field of fields) {
    if (!isNonNegativeInt(obj[field])) return null;
  }
  return {
    candidateCount: obj.candidateCount as number,
    selectedCount: obj.selectedCount as number,
    captureCount: obj.captureCount as number,
    failedReadCount: obj.failedReadCount as number,
    evidenceCount: obj.evidenceCount as number,
    rejectedEvidenceCount: obj.rejectedEvidenceCount as number,
    claimCount: obj.claimCount as number,
    conflictCount: obj.conflictCount as number,
    stepsUsed: obj.stepsUsed as number,
    roundsUsed: obj.roundsUsed as number,
  };
}

export function serializeStatsJson(stats: ResearchTaskStats): string {
  return JSON.stringify(stats);
}

export function parseCandidateDiscoveredVia(raw: unknown): CandidateOrigin[] | null {
  const arr = parseJsonArray(raw);
  if (arr === null) return null;
  const result: CandidateOrigin[] = [];
  for (const item of arr) {
    if (item !== 'sources' && item !== 'search') return null;
    result.push(item);
  }
  return result;
}

export function parseCaptureSummary(raw: unknown): CaptureSummary | null {
  const obj = parseJsonObject(raw);
  if (obj === null) return null;
  for (const field of ['sectionCount', 'tableCount', 'headingCount', 'charCount'] as const) {
    if (!isNonNegativeInt(obj[field])) return null;
  }
  return {
    sectionCount: obj.sectionCount as number,
    tableCount: obj.tableCount as number,
    headingCount: obj.headingCount as number,
    charCount: obj.charCount as number,
  };
}

export function parseLocatorJson(raw: unknown): EvidenceLocator | null {
  const obj = parseJsonObject(raw);
  if (obj === null) return null;
  const kind = obj['kind'];
  if (kind === 'text') {
    return typeof obj['excerpt'] === 'string' ? { kind: 'text', excerpt: obj['excerpt'] } : null;
  }
  if (kind === 'table') {
    if (!isNonNegativeInt(obj['row']) || !isNonNegativeInt(obj['col'])) return null;
    // 决议 #115：header 仅允许 string | null | 缺省（undefined → null）；
    // object/array/number/boolean 等非法形态使整个 locator 无效（fail-closed，
    // 不得静默转 null）
    const header = obj['header'];
    if (header === undefined || header === null) {
      return { kind: 'table', row: obj['row'] as number, col: obj['col'] as number, header: null };
    }
    if (typeof header === 'string') {
      return { kind: 'table', row: obj['row'] as number, col: obj['col'] as number, header };
    }
    return null;
  }
  if (kind === 'field') {
    return typeof obj['fieldPath'] === 'string'
      ? { kind: 'field', fieldPath: obj['fieldPath'] }
      : null;
  }
  return null;
}

function parseStringArray(raw: unknown): string[] | null {
  const arr = parseJsonArray(raw);
  if (arr === null) return null;
  const result: string[] = [];
  for (const item of arr) {
    if (typeof item !== 'string') return null;
    result.push(item);
  }
  return result;
}

function parseSourceTypes(raw: unknown): SourceTypeClass[] | null {
  const arr = parseJsonArray(raw);
  if (arr === null) return null;
  const result: SourceTypeClass[] = [];
  for (const item of arr) {
    if (item !== 'vendor' && item !== 'third-party' && item !== 'community') return null;
    result.push(item);
  }
  return result;
}

function parsePositions(raw: unknown): ConflictPosition[] | null {
  const arr = parseJsonArray(raw);
  if (arr === null) return null;
  const result: ConflictPosition[] = [];
  for (const item of arr) {
    if (!isRecord(item)) return null;
    if (typeof item['positionText'] !== 'string') return null;
    const refs = Array.isArray(item['sourceRefs'])
      ? item['sourceRefs'].every((r) => typeof r === 'string')
      : false;
    if (!refs) return null;
    result.push({ positionText: item['positionText'], sourceRefs: item['sourceRefs'] as string[] });
  }
  return result;
}

function parseBlocks(raw: unknown): ResultBlock[] | null {
  const arr = parseJsonArray(raw);
  if (arr === null) return null;
  // C1 存储层形状校验仅做判别联合 kind 白名单 + 对象形状（细粒度边界校验归 C7
  // ResultValidator）；畸形/未知 kind fail-closed
  const result: ResultBlock[] = [];
  for (const item of arr) {
    if (!isRecord(item)) return null;
    const kind = item['kind'];
    if (kind === 'markdown' || kind === 'uncertain') {
      if (typeof item['text'] !== 'string') return null;
      if (kind === 'markdown') result.push({ kind, text: item['text'] });
      else if (typeof item['reason'] === 'string') {
        result.push({ kind, text: item['text'], reason: item['reason'] });
      } else return null;
    } else if (kind === 'table') {
      const columns =
        Array.isArray(item['columns']) && item['columns'].every((c) => typeof c === 'string');
      const rows =
        Array.isArray(item['rows']) &&
        item['rows'].every((r) => Array.isArray(r) && r.every((c) => typeof c === 'string'));
      const refs =
        Array.isArray(item['sourceRefs']) && item['sourceRefs'].every((r) => typeof r === 'string');
      if (!columns || !rows || !refs) return null;
      result.push({
        kind,
        columns: item['columns'] as string[],
        rows: item['rows'] as string[][],
        sourceRefs: item['sourceRefs'] as string[],
      });
    } else if (kind === 'cards' || kind === 'ranking') {
      const items = Array.isArray(item['items'])
        ? item['items'].map((entry) => (isRecord(entry) ? entry : null))
        : null;
      if (items === null || items.some((e) => e === null)) return null;
      const valid = (items as Array<Record<string, unknown>>).every((entry) => {
        if (typeof entry['title'] !== 'string') return false;
        if (
          !Array.isArray(entry['sourceRefs']) ||
          !entry['sourceRefs'].every((r) => typeof r === 'string')
        )
          return false;
        if (kind === 'cards') {
          if (
            entry['subtitle'] !== null &&
            entry['subtitle'] !== undefined &&
            typeof entry['subtitle'] !== 'string'
          )
            return false;
          if (typeof entry['body'] !== 'string') return false;
        } else {
          if (!isNonNegativeInt(entry['rank'])) return false;
          if (typeof entry['detail'] !== 'string') return false;
        }
        return true;
      });
      if (!valid) return null;
      result.push(item as unknown as ResultBlock);
    } else {
      return null; // 未知 kind fail-closed
    }
  }
  return result;
}

function parseEvidenceMap(raw: unknown): ResearchResult['evidenceMap'] | null {
  const obj = parseJsonObject(raw);
  if (obj === null) return null;
  const result: ResearchResult['evidenceMap'] = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!isRecord(value)) return null;
    if (typeof value['candidateId'] !== 'string') return null;
    if (typeof value['url'] !== 'string') return null;
    if (typeof value['title'] !== 'string') return null;
    if (typeof value['accessTime'] !== 'string') return null;
    result[key] = {
      candidateId: value['candidateId'],
      url: value['url'],
      title: value['title'],
      accessTime: value['accessTime'],
    };
  }
  return result;
}

function parseResultConflicts(raw: unknown): ResearchResult['conflicts'] | null {
  const arr = parseJsonArray(raw);
  if (arr === null) return null;
  const result: ResearchResult['conflicts'] = [];
  for (const item of arr) {
    if (!isRecord(item)) return null;
    if (typeof item['conflictId'] !== 'string') return null;
    if (typeof item['topic'] !== 'string') return null;
    const positions = parsePositions(JSON.stringify(item['positions'] ?? null));
    if (positions === null) return null;
    result.push({ conflictId: item['conflictId'], topic: item['topic'], positions });
  }
  return result;
}

function parseCoverage(raw: unknown): ResearchResult['coverage'] | null {
  const obj = parseJsonObject(raw);
  if (obj === null) return null;
  for (const field of [
    'total',
    'multiSource',
    'singleSource',
    'vendor',
    'thirdParty',
    'community',
  ] as const) {
    if (!isNonNegativeInt(obj[field])) return null;
  }
  return {
    total: obj.total as number,
    multiSource: obj.multiSource as number,
    singleSource: obj.singleSource as number,
    vendor: obj.vendor as number,
    thirdParty: obj.thirdParty as number,
    community: obj.community as number,
  };
}

// ---------- 行 ↔ 域转换 ----------

export function rowToTask(row: ResearchTaskRow): ResearchTask | null {
  const stats = parseStatsJson(row.stats_json);
  if (stats === null) return null; // 畸形 stats fail-closed（整行丢弃）
  return {
    id: row.id,
    goal: row.goal,
    status: row.status,
    phase: row.phase,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    interruptedAt: row.interrupted_at,
    errorCode: row.error_code,
    resultId: row.result_id,
    stats,
  };
}

export function taskToRow(task: ResearchTask): ResearchTaskRow {
  return {
    id: task.id,
    goal: task.goal,
    status: task.status,
    phase: task.phase,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    started_at: task.startedAt,
    finished_at: task.finishedAt,
    interrupted_at: task.interruptedAt,
    error_code: task.errorCode,
    result_id: task.resultId,
    stats_json: serializeStatsJson(task.stats),
  };
}

function rowToCandidate(row: ResearchCandidateRow): SourceCandidate | null {
  const discoveredVia = parseCandidateDiscoveredVia(row.discovered_via_json);
  if (discoveredVia === null) return null;
  const trust =
    row.trust_value === null || row.trust_asserted_by === null || row.trust_verification === null
      ? null
      : {
          value: row.trust_value,
          assertedBy: row.trust_asserted_by,
          verification: row.trust_verification,
        };
  return {
    id: row.candidate_id,
    url: row.url,
    displayUrl: row.display_url,
    title: row.title,
    canonicalKey: row.canonical_key,
    scope: row.scope,
    discoveredVia,
    sourceId: row.source_id,
    trust,
    priority: row.priority,
    lastUsedAt: row.last_used_at,
    note: row.note,
    sortKey: row.sort_key,
  };
}

export function rowToCapture(row: ResearchCaptureRow): Capture | null {
  const summary = parseCaptureSummary(row.summary_json);
  if (summary === null) return null;
  return {
    captureId: row.capture_id,
    taskId: row.task_id,
    candidateId: row.candidate_id,
    tabId: row.tab_id,
    url: row.url,
    title: row.title,
    accessTime: row.access_time,
    documentId: row.document_id,
    contentHash: row.content_hash,
    summary,
    failed: row.failed === 1,
    failureReason: row.failure_reason,
  };
}

export function rowToEvidence(row: ResearchEvidenceRow): VerifiedEvidence | null {
  const locator = parseLocatorJson(row.locator_json);
  if (locator === null) return null;
  return {
    evidenceId: row.evidence_id,
    taskId: row.task_id,
    captureId: row.capture_id,
    candidateId: row.candidate_id,
    sourceId: row.source_id,
    url: row.url,
    title: row.title,
    accessTime: row.access_time,
    documentId: row.document_id,
    contentHash: row.content_hash,
    type: row.type,
    locator,
    excerpt: row.excerpt,
    value: row.value,
    verification: row.verification,
  };
}

function rowToClaim(row: ResearchClaimRow): Claim | null {
  const sourceTypes = parseSourceTypes(row.source_types_json);
  const evidenceIds = parseStringArray(row.evidence_ids_json);
  const singleSourceFields = parseStringArray(row.single_source_fields_json);
  const conflictIds = parseStringArray(row.conflict_ids_json);
  if (
    sourceTypes === null ||
    evidenceIds === null ||
    singleSourceFields === null ||
    conflictIds === null
  ) {
    return null;
  }
  return {
    claimId: row.claim_id,
    taskId: row.task_id,
    text: row.text,
    severity: row.severity,
    coverage: row.coverage,
    sourceTypes,
    evidenceIds,
    singleSourceFields,
    conflictIds,
  };
}

function rowToConflict(row: ResearchConflictRow): Conflict | null {
  const positions = parsePositions(row.positions_json);
  const claimIds = parseStringArray(row.claim_ids_json);
  if (positions === null || claimIds === null) return null;
  return {
    conflictId: row.conflict_id,
    taskId: row.task_id,
    topic: row.topic,
    positions,
    claimIds,
    resolved: row.resolved,
  };
}

function rowToResult(row: ResearchResultRow): ResearchResult | null {
  const blocks = parseBlocks(row.blocks_json);
  const evidenceMap = parseEvidenceMap(row.evidence_map_json);
  const conflicts = parseResultConflicts(row.conflicts_json);
  const coverage = parseCoverage(row.coverage_json);
  if (blocks === null || evidenceMap === null || conflicts === null || coverage === null) {
    return null;
  }
  return {
    resultId: row.result_id,
    taskId: row.task_id,
    title: row.title,
    summary: row.summary,
    blocks,
    evidenceMap,
    conflicts,
    coverage,
    fetchedAt: row.fetched_at,
  };
}

// ---------- 编译期 SQL 常量（全部参数绑定；无动态拼接） ----------

const SQL_INSERT_TASK = `INSERT INTO research_tasks (
  id, goal, status, phase, created_at, updated_at, started_at, finished_at,
  interrupted_at, error_code, result_id, stats_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const SQL_SELECT_TASK_BY_ID = 'SELECT * FROM research_tasks WHERE id = ?';
const SQL_SELECT_RUNNING_TASK = "SELECT * FROM research_tasks WHERE status = 'running' LIMIT 1";
// 决议 #113：markAllRunningInterrupted 投影预算检查用（全部 running 行）
const SQL_LIST_RUNNING_TASKS = "SELECT * FROM research_tasks WHERE status = 'running'";
const SQL_COUNT_TASKS = 'SELECT COUNT(*) AS n FROM research_tasks';
const SQL_COUNT_TASKS_BY_STATUS = 'SELECT COUNT(*) AS n FROM research_tasks WHERE status = ?';
const SQL_COUNT_FINISHED_TASKS = `SELECT COUNT(*) AS n FROM research_tasks
  WHERE status IN ('completed','failed','cancelled','interrupted')`;
const SQL_LIST_TASKS_ALL =
  'SELECT * FROM research_tasks ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?';
const SQL_LIST_TASKS_BY_STATUS =
  'SELECT * FROM research_tasks WHERE status = ? ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?';
const SQL_COUNT_TASKS_ALL = 'SELECT COUNT(*) AS n FROM research_tasks';
// 决议 #104：最旧排序键 = COALESCE(finished_at, interrupted_at) DESC, created_at DESC, id ASC
// （全序）；LIMIT -1 OFFSET ? 返回超保留数的最旧部分（保最新 keepCount 个终态）
const SQL_LIST_FINISHED_BEYOND = `SELECT id FROM research_tasks
  WHERE status IN ('completed','failed','cancelled','interrupted')
  ORDER BY COALESCE(finished_at, interrupted_at) DESC, created_at DESC, id ASC
  LIMIT -1 OFFSET ?`;
const SQL_SET_TASK_RUNNING = `UPDATE research_tasks SET
  status = 'running', phase = ?, started_at = ?, updated_at = ?, stats_json = ?,
  finished_at = NULL, interrupted_at = NULL, error_code = NULL, result_id = NULL
  WHERE id = ?`;
const SQL_SET_TASK_COMPLETED = `UPDATE research_tasks SET
  status = 'completed', phase = NULL, finished_at = ?, updated_at = ?, stats_json = ?,
  result_id = ?, error_code = NULL
  WHERE id = ?`;
const SQL_SET_TASK_FAILED = `UPDATE research_tasks SET
  status = 'failed', phase = NULL, finished_at = ?, updated_at = ?, stats_json = ?,
  error_code = ?, result_id = NULL
  WHERE id = ?`;
const SQL_SET_TASK_CANCELLED = `UPDATE research_tasks SET
  status = 'cancelled', phase = NULL, finished_at = ?, updated_at = ?, stats_json = ?,
  error_code = NULL, result_id = NULL
  WHERE id = ?`;
const SQL_SET_TASK_INTERRUPTED = `UPDATE research_tasks SET
  status = 'interrupted', phase = NULL, interrupted_at = ?, updated_at = ?
  WHERE id = ?`;
const SQL_UPDATE_TASK_PHASE = 'UPDATE research_tasks SET phase = ?, updated_at = ? WHERE id = ?';
const SQL_DELETE_TASK = 'DELETE FROM research_tasks WHERE id = ?';
// 决议 #109（store 装配）：遗留 running 原子标 interrupted（单条 UPDATE，事务内）
const SQL_MARK_ALL_RUNNING_INTERRUPTED = `UPDATE research_tasks SET
  status = 'interrupted', phase = NULL, interrupted_at = ?, updated_at = ?
  WHERE status = 'running'`;

const SQL_INSERT_CANDIDATE = `INSERT INTO research_candidates (
  candidate_id, task_id, url, display_url, title, canonical_key, scope,
  discovered_via_json, source_id, trust_value, trust_asserted_by,
  trust_verification, priority, last_used_at, note, sort_key
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const SQL_LIST_CANDIDATES_BY_TASK =
  'SELECT * FROM research_candidates WHERE task_id = ? ORDER BY sort_key ASC, candidate_id ASC';
const SQL_COUNT_CANDIDATES_BY_TASK =
  'SELECT COUNT(*) AS n FROM research_candidates WHERE task_id = ?';
const SQL_DELETE_CANDIDATES_BY_TASK = 'DELETE FROM research_candidates WHERE task_id = ?';

const SQL_INSERT_CAPTURE = `INSERT INTO research_captures (
  capture_id, task_id, candidate_id, tab_id, url, title, access_time,
  document_id, content_hash, summary_json, failed, failure_reason
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const SQL_LIST_CAPTURES_BY_TASK =
  'SELECT * FROM research_captures WHERE task_id = ? ORDER BY access_time ASC, capture_id ASC';
const SQL_COUNT_CAPTURES_BY_TASK = 'SELECT COUNT(*) AS n FROM research_captures WHERE task_id = ?';
const SQL_DELETE_CAPTURES_BY_TASK = 'DELETE FROM research_captures WHERE task_id = ?';

const SQL_INSERT_EVIDENCE = `INSERT INTO research_evidence (
  evidence_id, task_id, candidate_id, source_id, capture_id, url, title,
  access_time, document_id, content_hash, type, locator_json, excerpt, value,
  verification
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified')`;
const SQL_LIST_EVIDENCE_BY_TASK =
  'SELECT * FROM research_evidence WHERE task_id = ? ORDER BY access_time ASC, evidence_id ASC';
const SQL_COUNT_EVIDENCE_BY_TASK = 'SELECT COUNT(*) AS n FROM research_evidence WHERE task_id = ?';
const SQL_DELETE_EVIDENCE_BY_TASK = 'DELETE FROM research_evidence WHERE task_id = ?';

const SQL_INSERT_CLAIM = `INSERT INTO research_claims (
  claim_id, task_id, text, severity, coverage, source_types_json,
  evidence_ids_json, single_source_fields_json, conflict_ids_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const SQL_LIST_CLAIMS_BY_TASK =
  'SELECT * FROM research_claims WHERE task_id = ? ORDER BY claim_id ASC';
const SQL_COUNT_CLAIMS_BY_TASK = 'SELECT COUNT(*) AS n FROM research_claims WHERE task_id = ?';
const SQL_DELETE_CLAIMS_BY_TASK = 'DELETE FROM research_claims WHERE task_id = ?';

const SQL_INSERT_CONFLICT = `INSERT INTO research_conflicts (
  conflict_id, task_id, topic, positions_json, claim_ids_json, resolved
) VALUES (?, ?, ?, ?, ?, ?)`;
const SQL_LIST_CONFLICTS_BY_TASK =
  'SELECT * FROM research_conflicts WHERE task_id = ? ORDER BY conflict_id ASC';
const SQL_COUNT_CONFLICTS_BY_TASK =
  'SELECT COUNT(*) AS n FROM research_conflicts WHERE task_id = ?';
const SQL_DELETE_CONFLICTS_BY_TASK = 'DELETE FROM research_conflicts WHERE task_id = ?';

const SQL_INSERT_RESULT = `INSERT INTO research_results (
  result_id, task_id, title, summary, blocks_json, evidence_map_json,
  conflicts_json, coverage_json, fetched_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const SQL_SELECT_RESULT_BY_TASK = 'SELECT * FROM research_results WHERE task_id = ?';
const SQL_DELETE_RESULT_BY_TASK = 'DELETE FROM research_results WHERE task_id = ?';

// ---------- Repository ----------

export interface ResearchTaskListFilter {
  page: number;
  pageSize: number;
  status?: ResearchTaskStatus;
}

export interface ResearchTaskList {
  total: number;
  items: ResearchTask[];
}

export interface TaskStatusWrite {
  phase?: ResearchPhase;
  startedAt?: string;
  finishedAt?: string;
  interruptedAt?: string;
  updatedAt: string;
  errorCode?: ResearchErrorCode;
  resultId?: string | null;
  stats: ResearchTaskStats;
}

function rowValue(row: Record<string, unknown>): string {
  return String(row['id'] ?? '');
}

export class ResearchRepository {
  private readonly db: DbHandle;

  constructor(db: DbHandle) {
    this.db = db;
  }

  // --- 任务 CRUD ---

  insertTask(row: ResearchTaskRow): void {
    const task = rowToTask(row);
    if (task === null)
      throw new RepositoryError('sqlite-error', '任务行 stats 形状非法（拒绝写入）');
    this.assertPersistedBudget(row.id, task);
    this.db
      .prepare(SQL_INSERT_TASK)
      .run(
        row.id,
        row.goal,
        row.status,
        row.phase,
        row.created_at,
        row.updated_at,
        row.started_at,
        row.finished_at,
        row.interrupted_at,
        row.error_code,
        row.result_id,
        row.stats_json,
      );
  }

  getTaskById(id: string): ResearchTask | null {
    const row = this.getRawTaskRow(id);
    if (row === null) return null;
    return rowToTask(row);
  }

  // 原始任务行（不经域转换——投影预算检查需要以原始行为基做字段补丁）
  private getRawTaskRow(id: string): ResearchTaskRow | null {
    const row = this.db.prepare(SQL_SELECT_TASK_BY_ID).get(id) as unknown;
    if (!isRecord(row)) return null;
    return row as unknown as ResearchTaskRow;
  }

  getRunningTask(): ResearchTask | null {
    const row = this.db.prepare(SQL_SELECT_RUNNING_TASK).get() as unknown;
    if (!isRecord(row)) return null;
    return rowToTask(row as unknown as ResearchTaskRow);
  }

  listTasks(filter: ResearchTaskListFilter): ResearchTaskList {
    const offset = (filter.page - 1) * filter.pageSize;
    const rows = (
      filter.status === undefined
        ? this.db.prepare(SQL_LIST_TASKS_ALL).all(filter.pageSize, offset)
        : this.db.prepare(SQL_LIST_TASKS_BY_STATUS).all(filter.status, filter.pageSize, offset)
    ) as unknown[];
    const totalRow = (
      filter.status === undefined
        ? this.db.prepare(SQL_COUNT_TASKS_ALL).get()
        : this.db.prepare(SQL_COUNT_TASKS_BY_STATUS).get(filter.status)
    ) as { n: number };
    const items: ResearchTask[] = [];
    for (const raw of rows) {
      if (!isRecord(raw)) continue;
      const task = rowToTask(raw as unknown as ResearchTaskRow);
      if (task !== null) items.push(task); // 畸形行跳过（fail-closed）
    }
    return { total: totalRow.n, items };
  }

  countTasks(): number {
    return (this.db.prepare(SQL_COUNT_TASKS).get() as { n: number }).n;
  }

  countTasksByStatus(status: ResearchTaskStatus): number {
    return (this.db.prepare(SQL_COUNT_TASKS_BY_STATUS).get(status) as { n: number }).n;
  }

  countFinishedTasks(): number {
    return (this.db.prepare(SQL_COUNT_FINISHED_TASKS).get() as { n: number }).n;
  }

  // --- 状态迁移写入（事务由调用方持有；决议 #113：全部按更新后任务投影做
  // 字节预算检查——替换写不是新增行，任何成功写入后的持久化投影不得超过上限） ---

  setTaskRunning(
    id: string,
    write: { phase: ResearchPhase; startedAt: string; updatedAt: string; stats: ResearchTaskStats },
  ): void {
    const raw = this.getRawTaskRow(id);
    if (raw !== null) {
      this.assertProjectedTaskBudget(id, {
        ...raw,
        status: 'running',
        phase: write.phase,
        started_at: write.startedAt,
        updated_at: write.updatedAt,
        stats_json: serializeStatsJson(write.stats),
        finished_at: null,
        interrupted_at: null,
        error_code: null,
        result_id: null,
      });
    }
    this.db
      .prepare(SQL_SET_TASK_RUNNING)
      .run(write.phase, write.startedAt, write.updatedAt, serializeStatsJson(write.stats), id);
  }

  setTaskCompleted(
    id: string,
    write: {
      resultId: string;
      finishedAt: string;
      updatedAt: string;
      stats: ResearchTaskStats;
    },
  ): void {
    const raw = this.getRawTaskRow(id);
    if (raw !== null) {
      this.assertProjectedTaskBudget(id, {
        ...raw,
        status: 'completed',
        phase: null,
        finished_at: write.finishedAt,
        updated_at: write.updatedAt,
        stats_json: serializeStatsJson(write.stats),
        result_id: write.resultId,
        error_code: null,
      });
    }
    this.db
      .prepare(SQL_SET_TASK_COMPLETED)
      .run(write.finishedAt, write.updatedAt, serializeStatsJson(write.stats), write.resultId, id);
  }

  setTaskFailed(
    id: string,
    write: {
      errorCode: ResearchErrorCode;
      finishedAt: string;
      updatedAt: string;
      stats: ResearchTaskStats;
    },
  ): void {
    const raw = this.getRawTaskRow(id);
    if (raw !== null) {
      this.assertProjectedTaskBudget(id, {
        ...raw,
        status: 'failed',
        phase: null,
        finished_at: write.finishedAt,
        updated_at: write.updatedAt,
        stats_json: serializeStatsJson(write.stats),
        error_code: write.errorCode,
        result_id: null,
      });
    }
    this.db
      .prepare(SQL_SET_TASK_FAILED)
      .run(write.finishedAt, write.updatedAt, serializeStatsJson(write.stats), write.errorCode, id);
  }

  setTaskCancelled(
    id: string,
    write: { finishedAt: string; updatedAt: string; stats: ResearchTaskStats },
  ): void {
    const raw = this.getRawTaskRow(id);
    if (raw !== null) {
      this.assertProjectedTaskBudget(id, {
        ...raw,
        status: 'cancelled',
        phase: null,
        finished_at: write.finishedAt,
        updated_at: write.updatedAt,
        stats_json: serializeStatsJson(write.stats),
        error_code: null,
        result_id: null,
      });
    }
    this.db
      .prepare(SQL_SET_TASK_CANCELLED)
      .run(write.finishedAt, write.updatedAt, serializeStatsJson(write.stats), id);
  }

  setTaskInterrupted(id: string, write: { interruptedAt: string; updatedAt: string }): void {
    const raw = this.getRawTaskRow(id);
    if (raw !== null) {
      this.assertProjectedTaskBudget(id, {
        ...raw,
        status: 'interrupted',
        phase: null,
        interrupted_at: write.interruptedAt,
        updated_at: write.updatedAt,
      });
    }
    this.db.prepare(SQL_SET_TASK_INTERRUPTED).run(write.interruptedAt, write.updatedAt, id);
  }

  updateTaskPhase(id: string, phase: ResearchPhase, updatedAt: string): void {
    const raw = this.getRawTaskRow(id);
    if (raw !== null) {
      this.assertProjectedTaskBudget(id, { ...raw, phase, updated_at: updatedAt });
    }
    this.db.prepare(SQL_UPDATE_TASK_PHASE).run(phase, updatedAt, id);
  }

  // 决议 #109：启动装配遗留 running 原子标 interrupted（单条 UPDATE，事务内）。
  // 决议 #113：任一受影响任务的更新后投影超限 → 整体拒绝零写入（store 装配
  // 将其归一化 unavailable）
  markAllRunningInterrupted(interruptedAt: string, updatedAt: string): number {
    const rows = this.db.prepare(SQL_LIST_RUNNING_TASKS).all() as unknown[];
    for (const raw of rows) {
      if (!isRecord(raw)) continue;
      const row = raw as unknown as ResearchTaskRow;
      this.assertProjectedTaskBudget(row.id, {
        ...row,
        status: 'interrupted',
        phase: null,
        interrupted_at: interruptedAt,
        updated_at: updatedAt,
      });
    }
    return Number(
      this.db.prepare(SQL_MARK_ALL_RUNNING_INTERRUPTED).run(interruptedAt, updatedAt).changes,
    );
  }

  deleteTask(id: string): boolean {
    return Number(this.db.prepare(SQL_DELETE_TASK).run(id).changes) > 0;
  }

  // 决议 #106：restart 原子清理（事务由调用方持有）——删除全部旧 run 子行
  clearTaskRunData(taskId: string): void {
    this.db.prepare(SQL_DELETE_CANDIDATES_BY_TASK).run(taskId);
    this.db.prepare(SQL_DELETE_CAPTURES_BY_TASK).run(taskId);
    this.db.prepare(SQL_DELETE_EVIDENCE_BY_TASK).run(taskId);
    this.db.prepare(SQL_DELETE_CLAIMS_BY_TASK).run(taskId);
    this.db.prepare(SQL_DELETE_CONFLICTS_BY_TASK).run(taskId);
    this.db.prepare(SQL_DELETE_RESULT_BY_TASK).run(taskId);
  }

  // 决议 #104：超保留数的「最旧终态」id 列表（全序；供清理——调用方事务内删除）
  listFinishedTasksBeyond(keepCount: number): Array<{ id: string }> {
    const rows = this.db.prepare(SQL_LIST_FINISHED_BEYOND).all(keepCount) as unknown[];
    const result: Array<{ id: string }> = [];
    for (const raw of rows) {
      if (isRecord(raw)) result.push({ id: rowValue(raw) });
    }
    return result;
  }

  // 逐条参数化删除（IN 列表不动态拼接——编译期常量纪律）
  deleteTasksByIds(ids: readonly string[]): void {
    for (const id of ids) this.db.prepare(SQL_DELETE_TASK).run(id);
  }

  // 决议 #104：总数硬上限清理（纯组合既有 SQL 方法，无新 SQL）——总数超过
  // MAX_STORED_TASKS 时删除最旧的终态任务（created 永不清除）。返回实际删除
  // 数与仍无法消化的超限数（created 占满场景）。调用方须持有事务。
  cleanupOldestFinishedOverflow(): { deleted: number; overflowRemaining: number } {
    const count = this.countTasks();
    if (count <= MAX_STORED_TASKS) return { deleted: 0, overflowRemaining: 0 };
    const overflow = count - MAX_STORED_TASKS;
    const finished = this.countFinishedTasks();
    const toDelete = Math.min(overflow, finished);
    if (toDelete > 0) {
      const beyond = this.listFinishedTasksBeyond(finished - toDelete);
      this.deleteTasksByIds(beyond.map((r) => r.id));
    }
    return { deleted: toDelete, overflowRemaining: overflow - toDelete };
  }

  // --- 候选来源（C3 使用；C1 落地 CRUD） ---

  insertCandidate(row: ResearchCandidateRow): void {
    const candidate = rowToCandidate(row);
    if (candidate === null) {
      throw new RepositoryError('sqlite-error', '候选行 JSON 形状非法（拒绝写入）');
    }
    this.assertPersistedBudget(row.task_id, candidate);
    this.db
      .prepare(SQL_INSERT_CANDIDATE)
      .run(
        row.candidate_id,
        row.task_id,
        row.url,
        row.display_url,
        row.title,
        row.canonical_key,
        row.scope,
        row.discovered_via_json,
        row.source_id,
        row.trust_value,
        row.trust_asserted_by,
        row.trust_verification,
        row.priority,
        row.last_used_at,
        row.note,
        row.sort_key,
      );
  }

  listCandidatesByTask(taskId: string): SourceCandidate[] {
    const rows = this.db.prepare(SQL_LIST_CANDIDATES_BY_TASK).all(taskId) as unknown[];
    const result: SourceCandidate[] = [];
    for (const raw of rows) {
      if (!isRecord(raw)) continue;
      const candidate = rowToCandidate(raw as unknown as ResearchCandidateRow);
      if (candidate !== null) result.push(candidate);
    }
    return result;
  }

  countCandidatesByTask(taskId: string): number {
    return (this.db.prepare(SQL_COUNT_CANDIDATES_BY_TASK).get(taskId) as { n: number }).n;
  }

  // --- Capture（C4 使用；C1 落地 CRUD） ---

  insertCapture(row: ResearchCaptureRow): void {
    const capture = rowToCapture(row);
    if (capture === null) {
      throw new RepositoryError('sqlite-error', '捕获行 JSON 形状非法（拒绝写入）');
    }
    this.assertPersistedBudget(row.task_id, capture);
    this.db
      .prepare(SQL_INSERT_CAPTURE)
      .run(
        row.capture_id,
        row.task_id,
        row.candidate_id,
        row.tab_id,
        row.url,
        row.title,
        row.access_time,
        row.document_id,
        row.content_hash,
        row.summary_json,
        row.failed,
        row.failure_reason,
      );
  }

  listCapturesByTask(taskId: string): Capture[] {
    const rows = this.db.prepare(SQL_LIST_CAPTURES_BY_TASK).all(taskId) as unknown[];
    const result: Capture[] = [];
    for (const raw of rows) {
      if (!isRecord(raw)) continue;
      const capture = rowToCapture(raw as unknown as ResearchCaptureRow);
      if (capture !== null) result.push(capture);
    }
    return result;
  }

  countCapturesByTask(taskId: string): number {
    return (this.db.prepare(SQL_COUNT_CAPTURES_BY_TASK).get(taskId) as { n: number }).n;
  }

  // --- Evidence（决议 #102：仅 verified 窄类型） ---

  insertEvidence(row: ResearchEvidenceRow): void {
    const evidence = rowToEvidence(row);
    if (evidence === null) {
      throw new RepositoryError('sqlite-error', '证据行 JSON 形状非法（拒绝写入）');
    }
    this.assertPersistedBudget(row.task_id, evidence);
    this.db
      .prepare(SQL_INSERT_EVIDENCE)
      .run(
        row.evidence_id,
        row.task_id,
        row.candidate_id,
        row.source_id,
        row.capture_id,
        row.url,
        row.title,
        row.access_time,
        row.document_id,
        row.content_hash,
        row.type,
        row.locator_json,
        row.excerpt,
        row.value,
      );
  }

  listEvidenceByTask(taskId: string): VerifiedEvidence[] {
    const rows = this.db.prepare(SQL_LIST_EVIDENCE_BY_TASK).all(taskId) as unknown[];
    const result: VerifiedEvidence[] = [];
    for (const raw of rows) {
      if (!isRecord(raw)) continue;
      const evidence = rowToEvidence(raw as unknown as ResearchEvidenceRow);
      if (evidence !== null) result.push(evidence);
    }
    return result;
  }

  countEvidenceByTask(taskId: string): number {
    return (this.db.prepare(SQL_COUNT_EVIDENCE_BY_TASK).get(taskId) as { n: number }).n;
  }

  // --- Claims / Conflicts（C6 使用；C1 落地 CRUD） ---

  insertClaim(row: ResearchClaimRow): void {
    const claim = rowToClaim(row);
    if (claim === null) {
      throw new RepositoryError('sqlite-error', '结论行 JSON 形状非法（拒绝写入）');
    }
    this.assertPersistedBudget(row.task_id, claim);
    this.db
      .prepare(SQL_INSERT_CLAIM)
      .run(
        row.claim_id,
        row.task_id,
        row.text,
        row.severity,
        row.coverage,
        row.source_types_json,
        row.evidence_ids_json,
        row.single_source_fields_json,
        row.conflict_ids_json,
      );
  }

  listClaimsByTask(taskId: string): Claim[] {
    const rows = this.db.prepare(SQL_LIST_CLAIMS_BY_TASK).all(taskId) as unknown[];
    const result: Claim[] = [];
    for (const raw of rows) {
      if (!isRecord(raw)) continue;
      const claim = rowToClaim(raw as unknown as ResearchClaimRow);
      if (claim !== null) result.push(claim);
    }
    return result;
  }

  countClaimsByTask(taskId: string): number {
    return (this.db.prepare(SQL_COUNT_CLAIMS_BY_TASK).get(taskId) as { n: number }).n;
  }

  insertConflict(row: ResearchConflictRow): void {
    const conflict = rowToConflict(row);
    if (conflict === null) {
      throw new RepositoryError('sqlite-error', '冲突行 JSON 形状非法（拒绝写入）');
    }
    this.assertPersistedBudget(row.task_id, conflict);
    this.db
      .prepare(SQL_INSERT_CONFLICT)
      .run(
        row.conflict_id,
        row.task_id,
        row.topic,
        row.positions_json,
        row.claim_ids_json,
        row.resolved,
      );
  }

  listConflictsByTask(taskId: string): Conflict[] {
    const rows = this.db.prepare(SQL_LIST_CONFLICTS_BY_TASK).all(taskId) as unknown[];
    const result: Conflict[] = [];
    for (const raw of rows) {
      if (!isRecord(raw)) continue;
      const conflict = rowToConflict(raw as unknown as ResearchConflictRow);
      if (conflict !== null) result.push(conflict);
    }
    return result;
  }

  countConflictsByTask(taskId: string): number {
    return (this.db.prepare(SQL_COUNT_CONFLICTS_BY_TASK).get(taskId) as { n: number }).n;
  }

  // --- Result（C7 使用；C1 落地 CRUD） ---

  insertResult(row: ResearchResultRow): void {
    const result = rowToResult(row);
    if (result === null) {
      throw new RepositoryError('sqlite-error', '结果行 JSON 形状非法（拒绝写入）');
    }
    this.assertPersistedBudget(row.task_id, result);
    this.db
      .prepare(SQL_INSERT_RESULT)
      .run(
        row.result_id,
        row.task_id,
        row.title,
        row.summary,
        row.blocks_json,
        row.evidence_map_json,
        row.conflicts_json,
        row.coverage_json,
        row.fetched_at,
      );
  }

  getResultByTaskId(taskId: string): ResearchResult | null {
    const row = this.db.prepare(SQL_SELECT_RESULT_BY_TASK).get(taskId) as unknown;
    if (!isRecord(row)) return null;
    return rowToResult(row as unknown as ResearchResultRow);
  }

  // --- 决议 #103：累计持久化预算（UTF-8 字节；事务内前置检查） ---

  computeTaskPersistedBytes(taskId: string): number {
    let total = 0;
    const task = this.getTaskById(taskId);
    if (task !== null) total += computeUtf8Bytes(JSON.stringify(task));
    for (const candidate of this.listCandidatesByTask(taskId)) {
      total += computeUtf8Bytes(JSON.stringify(candidate));
    }
    for (const capture of this.listCapturesByTask(taskId)) {
      total += computeUtf8Bytes(JSON.stringify(capture));
    }
    for (const evidence of this.listEvidenceByTask(taskId)) {
      total += computeUtf8Bytes(JSON.stringify(evidence));
    }
    for (const claim of this.listClaimsByTask(taskId)) {
      total += computeUtf8Bytes(JSON.stringify(claim));
    }
    for (const conflict of this.listConflictsByTask(taskId)) {
      total += computeUtf8Bytes(JSON.stringify(conflict));
    }
    const result = this.getResultByTaskId(taskId);
    if (result !== null) total += computeUtf8Bytes(JSON.stringify(result));
    return total;
  }

  // 写库前序列化合计 ≤ MAX_TASK_PERSISTED_CHARS（UTF-8 字节）；超限拒绝写入。
  // 畸形现有行被读取路径跳过 → 不计入（与「序列化后」集合一致）。
  private assertPersistedBudget(taskId: string, domainObject: unknown): void {
    const current = this.computeTaskPersistedBytes(taskId);
    const additional = computeUtf8Bytes(JSON.stringify(domainObject));
    if (!isWithinPersistedBudget(current, additional)) {
      throw new RepositoryError(
        'task-persisted-budget-exceeded',
        `任务持久化字节预算超限（当前 ${current} + 新增 ${additional} > ${MAX_TASK_PERSISTED_CHARS} 字节）`,
      );
    }
  }

  // 决议 #113：任务行更新（状态/resultId/stats/时间字段）按**更新后的任务
  // 投影**检查——子行字节 + 更新后任务行字节 ≤ 上限（替换写不得误算为完整
  // 新增、不得把既有任务行重复计入）；任何成功写入后的持久化投影不得超过
  // 上限。畸形行读取路径跳过 → 不计入（与 #103 既有语义一致）；目标行不
  // 存在时 UPDATE 零行，无写入可越界。
  private assertProjectedTaskBudget(taskId: string, projectedRow: ResearchTaskRow): void {
    const currentTask = this.getTaskById(taskId);
    const currentTotal = this.computeTaskPersistedBytes(taskId);
    const currentTaskBytes =
      currentTask === null ? 0 : computeUtf8Bytes(JSON.stringify(currentTask));
    const childrenBytes = currentTotal - currentTaskBytes;
    const projectedTask = rowToTask(projectedRow);
    const projectedTaskBytes =
      projectedTask === null ? 0 : computeUtf8Bytes(JSON.stringify(projectedTask));
    if (!isWithinPersistedBudget(childrenBytes, projectedTaskBytes)) {
      throw new RepositoryError(
        'task-persisted-budget-exceeded',
        `任务持久化字节预算超限（更新后投影 ${childrenBytes + projectedTaskBytes} > ${MAX_TASK_PERSISTED_CHARS} 字节）`,
      );
    }
  }
}
