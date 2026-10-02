import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import {
  createQualificationDigestSchedules,
  createQualificationManifest,
  createQualificationProjection,
  createQualificationRules,
  createQualificationRuns,
  createQualificationSources,
  getQualificationDigestOracle,
  getQualificationRun,
  qualificationResponseMetadata,
  type QualificationRunPlan,
} from '../../src/main/watch/qualification/manifest.ts';
import { validateDigestFacts } from '../../src/shared/watch/digest-facts.ts';
import { serializeDigestArtifact } from '../../src/shared/watch/digest-validator.ts';
import { diffFeedProjections } from '../../src/shared/watch/diff/feed-diff.ts';
import { diffPageProjections } from '../../src/shared/watch/diff/page-diff.ts';
import {
  computeChangeFingerprint,
  computeConditionVersion,
  computeIdempotencyKey,
  validateChangeEvidencePair,
} from '../../src/shared/watch/event-validator.ts';
import type {
  ChangeEvidencePair,
  DigestFacts,
  WatchEventKind,
} from '../../src/shared/types/watch.ts';

export type DatabaseVerdict = 'PASS' | 'FAIL-product' | 'BLOCKED/evidence-insufficient';
export type DatabaseMode = 'short' | 'formal';

interface Check {
  id: string;
  status: DatabaseVerdict;
  counts: Record<string, number>;
  issues: string[];
}

export interface DatabaseReport {
  schema: 'watch-database-report-v1';
  runId: string;
  mode: DatabaseMode;
  verdict: DatabaseVerdict;
  checks: Check[];
  pendingOracle: string[];
  disclosure: 'counts-and-classifications-only';
}

export interface DatabaseReportOptions {
  runRoot: string;
  runId: string;
  mode: DatabaseMode;
  expectedM0Ms?: number;
  /** Trusted caller configuration. The CLI uses the fixed qualification root. */
  allowedRoots?: readonly string[];
}

type Row = Record<string, unknown>;

// The reporter must never reopen the released product root: even SQLite read-only mode may create
// WAL/SHM sidecars. A trusted collector first copies the closed, exclusive database files here.
const DEFAULT_ROOT = resolve(
  fileURLToPath(new URL('../../log/watch-qualification-db-copies', import.meta.url)),
);
const RUN_ID = /^[A-Z2-7]{26}$/;
const SQL_INTEGRITY = 'PRAGMA integrity_check(100)';
const SQL_FOREIGN_KEYS = 'PRAGMA foreign_key_check';
const SQL_TABLES = `SELECT name, sql FROM sqlite_master
  WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 128`;
const SQL_TABLE_COLUMNS = 'SELECT name FROM pragma_table_info(?) ORDER BY cid LIMIT 128';
const SQL_RULES = `SELECT id, source_id, kind, state, pause_reason, desired_enabled, muted,
  access_mode, schedule_json, target_json, condition_json, notification_level,
  source_row_version, source_locator_fingerprint, next_due_at, last_consumed_scheduled_for,
  last_daily_local_date, consecutive_failures, backoff_until, baseline_version, created_at,
  updated_at, rule_version, notification_show_details FROM watch_rules ORDER BY id LIMIT 101`;
const SQL_SOURCES = `SELECT id, scope, canonical_key, url, name, group_id, priority, enabled,
  share_mode, trust_value, trust_asserted_by, trust_verification, user_note, ai_note, created_by,
  version, created_at, updated_at, deleted_at, last_used_at, last_usage_outcome
  FROM sources ORDER BY id LIMIT 101`;
const SQL_RUNS = `SELECT id, rule_id, request_key, status, trigger, scheduled_for, started_at,
  finished_at, outcome_json, health_json, response_metadata_json
  FROM watch_runs ORDER BY request_key LIMIT 568`;
const SQL_BASELINES = `SELECT rule_id, version, projection_type, projection_json, content_hash,
  byte_length, final_url, captured_at, document_id, conditional_etag, conditional_last_modified
  FROM watch_baselines ORDER BY rule_id LIMIT 101`;
const SQL_AUDITS = `SELECT rule_id, kind, reason_code FROM watch_audits
  ORDER BY created_at, id LIMIT 569`;
const SQL_EVENTS = `SELECT id, rule_id, source_id, event_kind, importance, change_fingerprint, first_observed_at,
  last_observed_at, item_count FROM watch_events ORDER BY first_observed_at, id LIMIT 51`;
const SQL_OBSERVATIONS = `SELECT id, event_id, sequence, idempotency_key, change_fingerprint, event_kind, observed_at, item_count
  FROM watch_event_observations ORDER BY observed_at, id LIMIT 101`;
const SQL_ITEMS = `SELECT event_id, observation_id, observation_item_sequence, item_id, field_key,
  label, before_value_json, after_value_json, before_captured_at, after_captured_at,
  before_final_url, after_final_url, before_document_id, after_document_id, feed_item_key
  FROM watch_event_items ORDER BY observation_id, observation_item_sequence LIMIT 101`;
const SQL_JOURNAL = `SELECT sequence, observation_id, event_id, source_id, observed_at, status
  FROM digest_change_journal ORDER BY sequence LIMIT 101`;
const SQL_DIGEST_STATE = 'SELECT last_sequence FROM digest_change_state WHERE id = 1';
const SQL_DIGEST_SCHEDULES = `SELECT id, version, source_ids_json, schedule_json, ai_enabled,
  cursor_sequence, state, next_due_at, last_consumed_scheduled_for, last_daily_local_date,
  last_checked_at, last_period_json, last_run_stats_json FROM digest_schedules ORDER BY id LIMIT 3`;
const SQL_DIGEST_RUNS = `SELECT id, schedule_id, request_key, logical_date, lower_sequence,
  upper_sequence, next_sequence, period_json, run_stats_json, state, created_at, finished_at
  FROM digest_runs ORDER BY schedule_id, logical_date LIMIT 3`;
const SQL_DIGESTS = `SELECT id, schedule_id, run_id, batch_index, first_sequence, last_sequence,
  facts_json, facts_hash, facts_revision, explanation_json, byte_length, provider_state,
  provider_result_code, claimed_at, provider_finished_at, created_at FROM watch_digests
  ORDER BY schedule_id, batch_index LIMIT 3`;
const SQL_DIGEST_REFS = `SELECT digest_id, event_id, status FROM digest_event_refs
  ORDER BY digest_id, event_id LIMIT 51`;
const SQL_OUTBOX = `SELECT subject_type, subject_id, channel, state, attempts, created_at, updated_at
  FROM notification_outbox ORDER BY subject_type, subject_id LIMIT 3`;
const SQL_EMPTY_COUNTS = `SELECT
  (SELECT COUNT(*) FROM source_groups) AS source_groups,
  (SELECT COUNT(*) FROM source_tags) AS source_tags,
  (SELECT COUNT(*) FROM source_tag_links) AS source_tag_links,
  (SELECT COUNT(*) FROM change_journal) AS change_journal,
  (SELECT COUNT(*) FROM usage_events) AS usage_events`;

function asRow(value: unknown): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('row');
  return value as Row;
}

function textValue(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error('text');
  return value;
}

function numberValue(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('number');
  return value;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 131072)
    throw new Error('json');
  return JSON.parse(value) as unknown;
}

function canonicalTime(value: unknown): { iso: string; ms: number } | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const canonical = new Date(ms).toISOString();
  return canonical === value ||
    (canonical.endsWith('.000Z') && canonical.slice(0, -5) + 'Z' === value)
    ? { iso: value, ms }
    : null;
}

function same(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function addCheck(
  checks: Check[],
  id: string,
  issues: string[],
  counts: Record<string, number>,
): void {
  checks.push({
    id,
    status: issues.length === 0 ? 'PASS' : 'FAIL-product',
    counts,
    issues: [...new Set(issues)],
  });
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertNoLinks(root: string, target: string): void {
  if (!within(root, target)) throw new Error('path-outside-root');
  let current = root;
  const rel = relative(root, target);
  for (const part of rel === '' ? [] : rel.split(/[\\/]/)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('path-link');
  }
}

function resolveDatabases(options: DatabaseReportOptions): { watch: string; sources: string } {
  if (!RUN_ID.test(options.runId) || !isAbsolute(options.runRoot)) throw new Error('run-invalid');
  const runRoot = resolve(options.runRoot);
  const allowed = (options.allowedRoots ?? [DEFAULT_ROOT]).map((root) => resolve(root));
  const parent = allowed.find((root) => within(root, runRoot));
  if (parent === undefined || basename(runRoot) !== `run-${options.runId}`)
    throw new Error('root-invalid');
  assertNoLinks(parent, runRoot);
  if (realpathSync.native(runRoot) !== runRoot) throw new Error('root-alias');
  const watch = join(runRoot, 'user-data', 'watch', 'watch.db');
  const sources = join(runRoot, 'user-data', 'sources', 'sources.db');
  assertNoLinks(runRoot, watch);
  assertNoLinks(runRoot, sources);
  if (!lstatSync(watch).isFile() || !lstatSync(sources).isFile()) throw new Error('db-invalid');
  return { watch, sources };
}

function openReadOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function integrity(db: DatabaseSync): string[] {
  const issues: string[] = [];
  const rows = db.prepare(SQL_INTEGRITY).all().map(asRow);
  if (rows.length !== 1 || rows[0]?.['integrity_check'] !== 'ok')
    issues.push('integrity_check未通过');
  if (db.prepare(SQL_FOREIGN_KEYS).all().length !== 0) issues.push('外键一致性未通过');
  return issues;
}

function inspectSchema(db: DatabaseSync): { issues: string[]; tableCount: number } {
  const rows = db.prepare(SQL_TABLES).all().map(asRow);
  const issues: string[] = [];
  const suspicious = /^(?:raw|raw_body|body|html|cookie|credential|prompt|response_body)$/i;
  const columns = db.prepare(SQL_TABLE_COLUMNS);
  for (const row of rows) {
    const table = textValue(row, 'name');
    const names = columns.all(table).map(asRow);
    if (names.length === 128) issues.push('数据库列数量超过报告器上限');
    if (names.some((column) => suspicious.test(textValue(column, 'name'))))
      issues.push('数据库schema出现禁止的原始内容列');
  }
  if (rows.length === 128) issues.push('数据库表数量超过报告器上限');
  return { issues, tableCount: rows.length };
}

function inferM0(rules: readonly Row[]): number {
  if (rules.length !== 100) throw new Error('rule-count');
  const values = new Set(rules.map((row) => textValue(row, 'created_at')));
  if (values.size !== 1) throw new Error('m0-ambiguous');
  const created = Date.parse([...values][0]!);
  if (!Number.isFinite(created)) throw new Error('m0-invalid');
  return created + 3_600_000;
}

function checkSources(db: DatabaseSync, m0: number): Check {
  const issues: string[] = [];
  const rows = db.prepare(SQL_SOURCES).all().map(asRow);
  const expected = createQualificationSources(m0).sort((a, b) =>
    Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
  );
  if (rows.length !== expected.length) issues.push('Source数量不是100');
  for (let index = 0; index < Math.min(rows.length, expected.length); index++) {
    const row = rows[index]!;
    const source = expected[index]!;
    const actual = {
      id: row['id'],
      scope: row['scope'],
      canonicalKey: row['canonical_key'],
      url: row['url'],
      name: row['name'],
      groupId: row['group_id'],
      priority: row['priority'],
      enabled: row['enabled'] === 1,
      shareMode: row['share_mode'],
      trust: {
        value: row['trust_value'],
        assertedBy: row['trust_asserted_by'],
        verification: row['trust_verification'],
      },
      userNote: row['user_note'],
      aiNote: row['ai_note'],
      createdBy: row['created_by'],
      version: row['version'],
      createdAt: row['created_at'],
      updatedAt: row['updated_at'],
      deletedAt: row['deleted_at'],
      lastUsedAt: row['last_used_at'],
      lastUsageOutcome: row['last_usage_outcome'],
      tags: [],
    };
    if (!same(actual, source)) issues.push('Source固定清单不匹配');
  }
  const empty = asRow(db.prepare(SQL_EMPTY_COUNTS).get());
  if (Object.values(empty).some((value) => value !== 0))
    issues.push('Source库出现资格清单外业务记录');
  return {
    id: 'sources-fixed-manifest',
    status: issues.length ? 'FAIL-product' : 'PASS',
    counts: { sources: rows.length },
    issues: [...new Set(issues)],
  };
}

function checkRules(rows: readonly Row[], m0: number, mode: DatabaseMode): Check {
  const issues: string[] = [];
  const expected = createQualificationRules(m0).sort((a, b) =>
    Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
  );
  if (rows.length !== 100) issues.push('Rule数量不是100');
  for (let index = 0; index < Math.min(rows.length, expected.length); index++) {
    const row = rows[index]!;
    const rule = expected[index]!;
    if (
      row['id'] !== rule.id ||
      row['source_id'] !== rule.sourceId ||
      row['kind'] !== rule.kind ||
      row['state'] !== 'enabled' ||
      row['pause_reason'] !== null ||
      row['desired_enabled'] !== 1 ||
      row['muted'] !== 1 ||
      row['access_mode'] !== rule.accessMode ||
      !same(parseJson(row['schedule_json']), rule.schedule) ||
      !same(parseJson(row['target_json']), rule.target) ||
      !same(
        row['condition_json'] === null ? null : parseJson(row['condition_json']),
        rule.condition,
      ) ||
      row['notification_level'] !== 'normal' ||
      row['notification_show_details'] !== 0 ||
      row['source_locator_fingerprint'] !== rule.sourceLocatorFingerprint ||
      row['rule_version'] !== 1
    )
      issues.push('Rule固定清单或安全属性不匹配');
    const manifestIndex = createQualificationManifest().entries.find(
      (entry) => entry.ruleId === rule.id,
    )!.index;
    const expectedVersion =
      mode === 'formal'
        ? manifestIndex % 4 >= 2
          ? 5
          : 1
        : manifestIndex >= 80 && manifestIndex <= 83
          ? 1
          : 0;
    if (row['baseline_version'] !== expectedVersion) issues.push('Rule baseline版本不匹配');
  }
  return {
    id: 'rules-fixed-manifest',
    status: issues.length ? 'FAIL-product' : 'PASS',
    counts: { rules: rows.length },
    issues: [...new Set(issues)],
  };
}

function expectedPlans(mode: DatabaseMode, m0: number) {
  return mode === 'formal'
    ? createQualificationRuns(m0)
    : [80, 81, 82, 83].map((index) => getQualificationRun(index, 'initialization', null, m0));
}

function checkRuns(
  db: DatabaseSync,
  m0: number,
  mode: DatabaseMode,
): { check: Check; eventBindings: Array<{ eventId: string; plan: QualificationRunPlan }> } {
  const issues: string[] = [];
  const rows = db.prepare(SQL_RUNS).all().map(asRow);
  const plans = expectedPlans(mode, m0);
  const byKey = new Map(rows.map((row) => [textValue(row, 'request_key'), row]));
  const eventBindings: Array<{ eventId: string; plan: QualificationRunPlan }> = [];
  if (rows.length !== plans.length) issues.push('运行数量不匹配');
  for (const plan of plans) {
    const row = byKey.get(plan.requestKey);
    if (!row) {
      issues.push('缺少固定运行');
      continue;
    }
    const outcome = asRow(parseJson(row['outcome_json']));
    const trigger =
      plan.phase === 'initialization'
        ? 'manual'
        : plan.phase === 'warmup' && plan.entry.index <= 35
          ? 'catch-up'
          : 'scheduled';
    if (
      row['rule_id'] !== plan.entry.ruleId ||
      row['status'] !== 'finished' ||
      row['trigger'] !== trigger ||
      row['scheduled_for'] !== plan.scheduledFor ||
      outcome['kind'] !== plan.expectedOutcome
    )
      issues.push('运行阶段、触发或结果不匹配');
    const finished = canonicalTime(row['finished_at']);
    const health = parseJson(row['health_json']);
    const metadata = parseJson(row['response_metadata_json']);
    const expectedHealth = {
      state: 'healthy',
      acquisition: plan.entry.kind === 'feed' ? 'rss' : 'browser',
      code: null,
    };
    const expectedMetadata = {
      schemaVersion: 1,
      http: qualificationResponseMetadata(plan.entry.index),
      conditionWarnings: [],
    };
    if (!finished || !same(health, expectedHealth) || !same(metadata, expectedMetadata))
      issues.push('运行时间、health或response metadata无效');
    if (mode === 'formal' && plan.phase === 'initialization') {
      if (finished && finished.ms > m0 - 630_000) issues.push('初始化运行未在warmup前30秒settle');
    } else if (
      mode === 'formal' &&
      (plan.releaseAtMs === null ||
        !finished ||
        finished.ms < plan.releaseAtMs ||
        finished.ms > plan.releaseAtMs + 34_000)
    )
      issues.push('warmup/measurement完成时间超出固定plan边界');
    if (plan.expectedOutcome === 'event-created' || plan.expectedOutcome === 'event-coalesced') {
      if (typeof outcome['eventId'] !== 'string') issues.push('事件运行缺少eventId');
      else eventBindings.push({ eventId: outcome['eventId'], plan });
    }
  }
  return {
    check: {
      id: 'runs-by-phase-and-index',
      status: issues.length ? 'FAIL-product' : 'PASS',
      counts: { runs: rows.length, eventOutcomes: eventBindings.length },
      issues: [...new Set(issues)],
    },
    eventBindings,
  };
}

function checkBaselines(db: DatabaseSync, m0: number, mode: DatabaseMode): Check {
  const rows = db.prepare(SQL_BASELINES).all().map(asRow);
  const issues: string[] = [];
  const indices = mode === 'formal' ? Array.from({ length: 100 }, (_, i) => i) : [80, 81, 82, 83];
  const byRule = new Map(rows.map((row) => [textValue(row, 'rule_id'), row]));
  if (rows.length !== indices.length) issues.push('Baseline数量不匹配');
  for (const index of indices) {
    const plan =
      mode === 'formal'
        ? index % 4 >= 2
          ? getQualificationRun(index, 'measurement', 3, m0)
          : getQualificationRun(index, 'initialization', null, m0)
        : getQualificationRun(index, 'initialization', null, m0);
    const row = byRule.get(plan.entry.ruleId);
    if (!row) {
      issues.push('缺少固定Baseline');
      continue;
    }
    try {
      const projection = createQualificationProjection(plan, textValue(row, 'captured_at'));
      if (
        row['version'] !== (mode === 'formal' ? (index % 4 >= 2 ? 5 : 1) : 1) ||
        row['projection_type'] !== plan.entry.kind ||
        row['projection_json'] !== JSON.stringify(projection.value) ||
        row['content_hash'] !== projection.contentHash ||
        row['byte_length'] !== projection.byteLength ||
        row['final_url'] !== projection.finalUrl ||
        row['document_id'] !== projection.documentId
      )
        issues.push('Baseline投影或版本不匹配');
    } catch {
      issues.push('Baseline投影不可复算');
    }
  }
  return {
    id: 'baselines-recomputed',
    status: issues.length ? 'FAIL-product' : 'PASS',
    counts: {
      baselines: rows.length,
      projectionBytes: rows.reduce((sum, row) => sum + numberValue(row, 'byte_length'), 0),
    },
    issues: [...new Set(issues)],
  };
}

function checkAudits(db: DatabaseSync, mode: DatabaseMode, expectedRuns: number): Check {
  const rows = db.prepare(SQL_AUDITS).all().map(asRow);
  const issues: string[] = [];
  const reconciliations = rows.filter(
    (row) =>
      row['rule_id'] === null &&
      row['kind'] === 'reconciliation' &&
      row['reason_code'] === 'complete',
  );
  if (reconciliations.length !== 1) issues.push('normal reconciliation审计不是恰一条');
  if (rows.length !== expectedRuns + 1) issues.push('运行审计数量不匹配');
  if (
    mode === 'short' &&
    rows.some(
      (row) =>
        row['kind'] !== 'reconciliation' &&
        (row['kind'] !== 'run' || row['reason_code'] !== 'baseline-established'),
    )
  )
    issues.push('短验出现初始化外审计');
  return {
    id: 'audits-preserved',
    status: issues.length ? 'FAIL-product' : 'PASS',
    counts: { audits: rows.length, reconciliation: reconciliations.length },
    issues: [...new Set(issues)],
  };
}

function evidencePair(row: Row): unknown {
  return {
    itemId: row['item_id'],
    fieldKey: row['field_key'],
    label: row['label'],
    before: parseJson(row['before_value_json']),
    after: parseJson(row['after_value_json']),
    beforeCapturedAt: row['before_captured_at'],
    afterCapturedAt: row['after_captured_at'],
    beforeFinalUrl: row['before_final_url'],
    afterFinalUrl: row['after_final_url'],
    beforeDocumentId: row['before_document_id'],
    afterDocumentId: row['after_document_id'],
    feedItemKey: row['feed_item_key'],
  };
}

function validatedEvidence(rows: readonly Row[]): ChangeEvidencePair[] | null {
  const output: ChangeEvidencePair[] = [];
  for (const row of rows) {
    const pair = validateChangeEvidencePair(evidencePair(row));
    if (pair === null) return null;
    output.push(pair);
  }
  return output;
}

interface DigestSlice {
  sequence: number;
  eventId: string;
  ruleId: string;
  sourceId: string;
  eventKind: WatchEventKind;
  importance: 'normal' | 'important';
  observedAt: string;
  items: ChangeEvidencePair[];
}

function rebuildDigestFacts(input: {
  scheduleId: string;
  runId: string;
  period: { fromExclusive: string; toInclusive: string };
  runStats: { changed: number; failed: number; unchanged: number };
  slices: readonly DigestSlice[];
}): DigestFacts | null {
  const groups = new Map<string, DigestSlice[]>();
  for (const slice of [...input.slices].sort((a, b) => a.sequence - b.sequence)) {
    const current = groups.get(slice.eventId) ?? [];
    current.push(slice);
    groups.set(slice.eventId, current);
  }
  if (groups.size === 0 || groups.size > 50) return null;
  const events: DigestFacts['events'] = [];
  const evidenceMap: DigestFacts['evidenceMap'] = {};
  const referenceStates: DigestFacts['referenceStates'] = {};
  for (const [eventId, slices] of groups) {
    const first = slices[0]!;
    if (slices.some((slice) => slice.ruleId !== first.ruleId || slice.sourceId !== first.sourceId))
      return null;
    const last = slices[slices.length - 1]!;
    const eventKind = slices.every((slice) => slice.eventKind === first.eventKind)
      ? first.eventKind
      : 'mixed';
    const evidence = slices.flatMap((slice) => slice.items);
    events.push({
      eventId,
      ruleId: first.ruleId,
      sourceId: first.sourceId,
      eventKind,
      importance: first.importance,
      firstIncludedAt: first.observedAt,
      lastIncludedAt: last.observedAt,
      observationCount: slices.length,
      itemCount: evidence.length,
    });
    evidenceMap[eventId] = evidence;
    referenceStates[eventId] = 'active';
  }
  const facts: DigestFacts = {
    schemaVersion: 1,
    scheduleId: input.scheduleId,
    digestRunId: input.runId,
    batchIndex: 0,
    period: input.period,
    eventCount: events.length,
    runStats: input.runStats,
    events,
    evidenceMap,
    referenceStates,
    fetchedAt: input.period.toInclusive,
  };
  return facts;
}

function expectedEvidence(plan: QualificationRunPlan, row: Row): unknown[] {
  const round = plan.round!;
  const beforePlan =
    round > 0
      ? getQualificationRun(plan.entry.index, 'measurement', round - 1, plan.m0Ms)
      : getQualificationRun(plan.entry.index, 'initialization', null, plan.m0Ms);
  const before = createQualificationProjection(beforePlan, textValue(row, 'before_captured_at'));
  const after = createQualificationProjection(plan, textValue(row, 'after_captured_at'));
  return before.value.type === 'feed' && after.value.type === 'feed'
    ? diffFeedProjections({ ...before, value: before.value }, { ...after, value: after.value })
        .pairs
    : before.value.type === 'page' && after.value.type === 'page'
      ? diffPageProjections({ ...before, value: before.value }, { ...after, value: after.value })
          .pairs
      : [];
}

function checkEvents(
  db: DatabaseSync,
  mode: DatabaseMode,
  runBindings: readonly { eventId: string; plan: QualificationRunPlan }[],
): Check {
  const events = db.prepare(SQL_EVENTS).all().map(asRow);
  const observations = db.prepare(SQL_OBSERVATIONS).all().map(asRow);
  const items = db.prepare(SQL_ITEMS).all().map(asRow);
  const journal = db.prepare(SQL_JOURNAL).all().map(asRow);
  const issues: string[] = [];
  const expected =
    mode === 'formal'
      ? { events: 50, observations: 100, items: 100 }
      : { events: 0, observations: 0, items: 0 };
  if (
    events.length !== expected.events ||
    observations.length !== expected.observations ||
    items.length !== expected.items ||
    journal.length !== expected.observations
  )
    issues.push('Event/observation/evidence数量不匹配');
  if (
    numberValue(asRow(db.prepare(SQL_DIGEST_STATE).get()), 'last_sequence') !==
    expected.observations
  )
    issues.push('digest journal high-water不匹配');
  if (mode === 'formal') {
    const eventSet = new Set(events.map((row) => textValue(row, 'id')));
    if (
      new Set(runBindings.map((binding) => binding.eventId)).size !== 50 ||
      runBindings.some((binding) => !eventSet.has(binding.eventId))
    )
      issues.push('运行结果与Event关联不匹配');
    const obsByEvent = new Map<string, Row[]>();
    for (const row of observations) {
      const id = textValue(row, 'event_id');
      const list = obsByEvent.get(id) ?? [];
      list.push(row);
      obsByEvent.set(id, list);
    }
    const itemsByObservation = new Map<string, Row[]>();
    for (const item of items) {
      const id = textValue(item, 'observation_id');
      const list = itemsByObservation.get(id) ?? [];
      list.push(item);
      itemsByObservation.set(id, list);
    }
    for (const [eventId, rows] of obsByEvent) {
      rows.sort((a, b) => numberValue(a, 'sequence') - numberValue(b, 'sequence'));
      const kinds = rows.map((row) => row['event_kind']);
      if (
        rows.length !== 2 ||
        rows[0]?.['sequence'] !== 0 ||
        rows[1]?.['sequence'] !== 1 ||
        !same(kinds, kinds[0] === 'changed' ? ['changed', 'reversal'] : ['reversal', 'reversal'])
      )
        issues.push('每Event的两次observation或reversal序列不匹配');
      const bindings = runBindings
        .filter((binding) => binding.eventId === eventId)
        .sort((a, b) => a.plan.round! - b.plan.round!);
      const event = events.find((candidate) => candidate['id'] === eventId);
      if (
        bindings.length !== 2 ||
        !event ||
        event['rule_id'] !== bindings[0]?.plan.entry.ruleId ||
        event['source_id'] !== bindings[0]?.plan.entry.sourceId ||
        event['item_count'] !== 2 ||
        event['event_kind'] !== (kinds[0] === kinds[1] ? kinds[0] : 'mixed') ||
        event['first_observed_at'] !== rows[0]?.['observed_at'] ||
        event['last_observed_at'] !== rows[1]?.['observed_at']
      )
        issues.push('Event与固定Rule/Source/运行归属不匹配');
      for (let index = 0; index < Math.min(bindings.length, rows.length); index++) {
        const observation = rows[index]!;
        const binding = bindings[index]!;
        const evidenceRows = itemsByObservation.get(textValue(observation, 'id')) ?? [];
        const actualPairs = evidenceRows.map(evidencePair);
        const expectedPairs = evidenceRows.map((row) => expectedEvidence(binding.plan, row)[0]);
        if (
          evidenceRows.length !== 1 ||
          observation['item_count'] !== 1 ||
          !same(actualPairs, expectedPairs)
        )
          issues.push('Evidence未精确匹配固定A/B old/new投影');
        const pair = expectedPairs[0];
        const validatedPair = validateChangeEvidencePair(pair);
        if (validatedPair !== null) {
          const expectedFingerprint = computeChangeFingerprint([
            {
              itemKey: validatedPair.itemId,
              fieldKey: validatedPair.fieldKey,
              pairKind: binding.plan.round === 0 ? 'changed' : 'reversal',
              before: validatedPair.before,
              after: validatedPair.after,
            },
          ]);
          const after = createQualificationProjection(
            binding.plan,
            textValue(evidenceRows[0]!, 'after_captured_at'),
          );
          const baselineVersion = 1 + binding.plan.round!;
          const rule = createQualificationRules(binding.plan.m0Ms)[binding.plan.entry.index]!;
          const expectedIdempotency = computeIdempotencyKey({
            ruleId: rule.id,
            baselineVersion,
            newProjectionHash: after.contentHash,
            conditionVersion: computeConditionVersion(rule.condition),
          });
          if (
            observation['change_fingerprint'] !== expectedFingerprint ||
            observation['idempotency_key'] !== expectedIdempotency ||
            (index === 0 && event?.['change_fingerprint'] !== expectedFingerprint)
          )
            issues.push('Event指纹或幂等键未匹配固定投影');
        }
      }
    }
    const observationSet = new Set(observations.map((row) => textValue(row, 'id')));
    for (const row of items) {
      let pair: unknown = null;
      try {
        pair = evidencePair(row);
      } catch {
        /* reported below */
      }
      if (
        !observationSet.has(String(row['observation_id'])) ||
        validateChangeEvidencePair(pair) === null
      )
        issues.push('Evidence不是有效typed old/new pair');
    }
    for (let index = 0; index < journal.length; index++)
      if (journal[index]?.['sequence'] !== index + 1 || journal[index]?.['status'] !== 'active')
        issues.push('digest journal序列或状态不匹配');
    const observationById = new Map(observations.map((row) => [textValue(row, 'id'), row]));
    const eventById = new Map(events.map((row) => [textValue(row, 'id'), row]));
    for (const entry of journal) {
      const observation = observationById.get(textValue(entry, 'observation_id'));
      const event = eventById.get(textValue(entry, 'event_id'));
      if (
        !observation ||
        !event ||
        observation['event_id'] !== entry['event_id'] ||
        observation['observed_at'] !== entry['observed_at'] ||
        event['source_id'] !== entry['source_id']
      )
        issues.push('digest journal未逐行绑定observation/Event/Source');
    }
  }
  return {
    id: 'events-evidence-coalescing',
    status: issues.length ? 'FAIL-product' : 'PASS',
    counts: {
      events: events.length,
      observations: observations.length,
      evidencePairs: items.length,
      journal: journal.length,
    },
    issues: [...new Set(issues)],
  };
}

function checkDigests(db: DatabaseSync, mode: DatabaseMode, m0: number): Check {
  const schedules = db.prepare(SQL_DIGEST_SCHEDULES).all().map(asRow);
  const runs = db.prepare(SQL_DIGEST_RUNS).all().map(asRow);
  const digests = db.prepare(SQL_DIGESTS).all().map(asRow);
  const refs = db.prepare(SQL_DIGEST_REFS).all().map(asRow);
  const outbox = db.prepare(SQL_OUTBOX).all().map(asRow);
  const issues: string[] = [];
  if (mode === 'short') {
    if (schedules.length || runs.length || digests.length || refs.length || outbox.length)
      issues.push('短验不应生成Digest或通知');
  } else {
    const events = db.prepare(SQL_EVENTS).all().map(asRow);
    const observations = db.prepare(SQL_OBSERVATIONS).all().map(asRow);
    const items = db.prepare(SQL_ITEMS).all().map(asRow);
    const journal = db.prepare(SQL_JOURNAL).all().map(asRow);
    const eventById = new Map(events.map((event) => [textValue(event, 'id'), event]));
    const observationById = new Map(observations.map((row) => [textValue(row, 'id'), row]));
    const itemsByObservation = new Map<string, Row[]>();
    for (const item of items) {
      const id = textValue(item, 'observation_id');
      const list = itemsByObservation.get(id) ?? [];
      list.push(item);
      itemsByObservation.set(id, list);
    }
    const expectedSchedules = createQualificationDigestSchedules(m0).sort((a, b) =>
      Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
    );
    if (schedules.length !== 2 || runs.length !== 2 || digests.length !== 2 || outbox.length !== 2)
      issues.push('Digest持久化数量不匹配');
    if (
      digests.some(
        (row) =>
          row['provider_state'] !== 'disabled' ||
          row['provider_result_code'] !== 'disabled' ||
          row['explanation_json'] !== null ||
          row['claimed_at'] !== null,
      )
    )
      issues.push('Digest facts、预算或零Provider状态不匹配');
    for (let index = 0; index < expectedSchedules.length; index++) {
      const expected = expectedSchedules[index]!;
      const row = schedules[index];
      if (
        !row ||
        row['id'] !== expected.id ||
        !same(parseJson(row['source_ids_json']), expected.sourceIds) ||
        row['ai_enabled'] !== 0 ||
        row['state'] !== 'active'
      )
        issues.push('Digest schedule固定成员或AI开关不匹配');
      const run = runs.find((candidate) => candidate['schedule_id'] === expected.id);
      const digest = digests.find((candidate) => candidate['schedule_id'] === expected.id);
      const oracleIndex = createQualificationManifest().digests.find(
        (candidate) => candidate.id === expected.id,
      )!.index;
      const oracle = getQualificationDigestOracle(oracleIndex);
      if (
        !run ||
        run['state'] !== 'completed' ||
        !same(parseJson(run['run_stats_json']), oracle.runStats)
      )
        issues.push('Digest run闭合状态或统计不匹配');
      if (run) {
        const due = Date.parse(expected.nextDueAt);
        const created = canonicalTime(run['created_at']);
        const finished = canonicalTime(run['finished_at']);
        const period = asRow(parseJson(run['period_json']));
        if (
          !Number.isFinite(due) ||
          !created ||
          !finished ||
          created.ms < due ||
          created.ms > due + 30000 ||
          finished.ms < created.ms ||
          finished.ms > due + 30000 ||
          row?.['last_consumed_scheduled_for'] !== expected.nextDueAt ||
          row?.['last_checked_at'] !== run['created_at'] ||
          period['fromExclusive'] !== expected.createdAt ||
          period['toInclusive'] !== run['created_at'] ||
          run['request_key'] !== `${expected.id}:${expected.nextDueAt.slice(0, 10)}` ||
          run['logical_date'] !== expected.nextDueAt.slice(0, 10) ||
          run['lower_sequence'] !== 0 ||
          run['next_sequence'] !== run['upper_sequence']
        )
          issues.push('Digest due时限、period或cursor绑定不匹配');
      }
      if (!digest) {
        issues.push('缺少Digest facts');
        continue;
      }
      const factsText = textValue(digest, 'facts_json');
      const facts = parseJson(factsText);
      const factsBytes = Buffer.byteLength(factsText, 'utf8');
      if (
        !validateDigestFacts(facts) ||
        digest['facts_hash'] !== sha256(factsText) ||
        factsBytes > 49152 ||
        numberValue(digest, 'byte_length') !==
          serializeDigestArtifact(factsText, null).byteLength ||
        digest['provider_state'] !== 'disabled' ||
        digest['provider_result_code'] !== 'disabled' ||
        digest['explanation_json'] !== null ||
        digest['claimed_at'] !== null
      )
        issues.push('Digest facts、预算或零Provider状态不匹配');
      if (
        validateDigestFacts(facts) &&
        (facts.runStats.changed !== oracle.runStats.changed ||
          facts.runStats.unchanged !== oracle.runStats.unchanged ||
          facts.runStats.failed !== 0 ||
          facts.events.reduce((sum, event) => sum + event.observationCount, 0) !==
            oracle.observations ||
          facts.events.length !== oracle.events)
      )
        issues.push('Digest facts未匹配分区时点oracle');
      if (run && validateDigestFacts(facts)) {
        const period = asRow(parseJson(run['period_json']));
        const allowed = new Set(expected.sourceIds);
        const fromExclusive = textValue(period, 'fromExclusive');
        const toInclusive = textValue(period, 'toInclusive');
        const slices: DigestSlice[] = [];
        for (const entry of journal.filter(
          (candidate) =>
            numberValue(candidate, 'sequence') > numberValue(run, 'lower_sequence') &&
            numberValue(candidate, 'sequence') <= numberValue(run, 'upper_sequence') &&
            allowed.has(textValue(candidate, 'source_id')) &&
            textValue(candidate, 'observed_at') > fromExclusive &&
            textValue(candidate, 'observed_at') <= toInclusive,
        )) {
          const observation = observationById.get(textValue(entry, 'observation_id'));
          const event = eventById.get(textValue(entry, 'event_id'));
          if (!observation || !event) {
            issues.push('Digest journal引用无效');
            continue;
          }
          const evidence = validatedEvidence(
            itemsByObservation.get(textValue(observation, 'id')) ?? [],
          );
          if (evidence === null) {
            issues.push('Digest journal Evidence无效');
            continue;
          }
          slices.push({
            sequence: numberValue(entry, 'sequence'),
            eventId: textValue(entry, 'event_id'),
            ruleId: textValue(event, 'rule_id'),
            sourceId: textValue(event, 'source_id'),
            eventKind: observation['event_kind'] as WatchEventKind,
            importance: event['importance'] as 'normal' | 'important',
            observedAt: textValue(observation, 'observed_at'),
            items: evidence,
          });
        }
        const rebuilt = rebuildDigestFacts({
          scheduleId: expected.id,
          runId: textValue(run, 'id'),
          period: { fromExclusive, toInclusive },
          runStats: oracle.runStats,
          slices,
        });
        const digestRefs = refs
          .filter((ref) => ref['digest_id'] === digest['id'])
          .map((ref) => ref['event_id']);
        const factsMatch = same(rebuilt, facts);
        const refsActive = refs.every((ref) => ref['status'] === 'active');
        const refIdsMatch = same(
          digestRefs.sort(),
          facts.events.map((event) => event.eventId).sort(),
        );
        const runBindingMatches =
          digest['run_id'] === run['id'] &&
          digest['batch_index'] === 0 &&
          digest['first_sequence'] === 1 &&
          digest['last_sequence'] === run['upper_sequence'];
        if (!factsMatch || !refsActive || !refIdsMatch || !runBindingMatches)
          issues.push('Digest run/facts/journal/ref绑定不匹配');
        if (!factsMatch) issues.push('Digest facts无法由journal与Evidence独立重建');
        if (
          rebuilt !== null &&
          (!same(rebuilt.period, facts.period) ||
            !same(rebuilt.runStats, facts.runStats) ||
            rebuilt.scheduleId !== facts.scheduleId ||
            rebuilt.digestRunId !== facts.digestRunId ||
            rebuilt.batchIndex !== facts.batchIndex ||
            rebuilt.fetchedAt !== facts.fetchedAt)
        )
          issues.push('Digest facts顶层run/period绑定不匹配');
        if (rebuilt !== null && !same(rebuilt.events, facts.events))
          issues.push('Digest facts Event聚合不匹配');
        if (rebuilt !== null && !same(rebuilt.evidenceMap, facts.evidenceMap))
          issues.push('Digest facts Evidence聚合不匹配');
        if (rebuilt !== null && !same(rebuilt.referenceStates, facts.referenceStates))
          issues.push('Digest facts referenceStates不匹配');
        if (!refsActive || !refIdsMatch) issues.push('Digest refs状态或成员不匹配');
        if (!runBindingMatches) issues.push('Digest artifact与run cursor不匹配');
        const notice = outbox.find((candidate) => candidate['subject_id'] === digest['id']);
        const due = Date.parse(expected.nextDueAt);
        const runCreated = canonicalTime(run['created_at']);
        const artifactCreated = canonicalTime(digest['created_at']);
        const noticeCreated = notice ? canonicalTime(notice['created_at']) : null;
        const noticeUpdated = notice ? canonicalTime(notice['updated_at']) : null;
        if (
          !Number.isFinite(due) ||
          !notice ||
          !runCreated ||
          !artifactCreated ||
          !noticeCreated ||
          !noticeUpdated ||
          artifactCreated.ms < runCreated.ms ||
          artifactCreated.ms > due + 30000 ||
          noticeCreated.ms < artifactCreated.ms ||
          noticeCreated.ms > due + 30000 ||
          noticeUpdated.ms < noticeCreated.ms ||
          noticeUpdated.ms > due + 30000
        )
          issues.push('Digest artifact或应用内通知超过due后30秒');
      }
    }
    if (
      outbox.some(
        (row) =>
          row['subject_type'] !== 'digest' ||
          row['channel'] !== 'in-app' ||
          row['state'] !== 'sent',
      )
    )
      issues.push('Digest应用内通知不匹配');
    if (refs.length !== 38) issues.push('Digest Event引用数量不匹配');
  }
  return {
    id: 'digests-facts-provider-zero',
    status: issues.length ? 'FAIL-product' : 'PASS',
    counts: {
      schedules: schedules.length,
      digestRuns: runs.length,
      digests: digests.length,
      eventRefs: refs.length,
      notifications: outbox.length,
      providerClaims: digests.filter((row) => row['claimed_at'] !== null).length,
    },
    issues: [...new Set(issues)],
  };
}

export function reportDatabases(options: DatabaseReportOptions): DatabaseReport {
  const paths = resolveDatabases(options);
  const checks: Check[] = [];
  let watch: DatabaseSync | null = null;
  let sources: DatabaseSync | null = null;
  try {
    watch = openReadOnly(paths.watch);
    sources = openReadOnly(paths.sources);
    const watchIntegrity = integrity(watch);
    const sourceIntegrity = integrity(sources);
    addCheck(checks, 'sqlite-integrity', [...watchIntegrity, ...sourceIntegrity], { databases: 2 });
    const watchSchema = inspectSchema(watch);
    const sourceSchema = inspectSchema(sources);
    addCheck(checks, 'schema-payload-column-ban', [...watchSchema.issues, ...sourceSchema.issues], {
      tables: watchSchema.tableCount + sourceSchema.tableCount,
    });
    const rules = watch.prepare(SQL_RULES).all().map(asRow);
    let m0: number;
    try {
      m0 = inferM0(rules);
    } catch {
      throw new Error('fixed-load-invalid');
    }
    if (options.mode === 'formal')
      checks.push({
        id: 'formal-authenticated-m0',
        status:
          options.expectedM0Ms === undefined
            ? 'BLOCKED/evidence-insufficient'
            : options.expectedM0Ms === m0
              ? 'PASS'
              : 'FAIL-product',
        counts: { supplied: options.expectedM0Ms === undefined ? 0 : 1 },
        issues:
          options.expectedM0Ms === undefined
            ? ['缺少认证setup M0']
            : options.expectedM0Ms === m0
              ? []
              : ['数据库M0与认证setup不匹配'],
      });
    if (options.mode === 'formal')
      checks.push({
        id: 'copy-provenance',
        status: 'BLOCKED/evidence-insufficient',
        counts: {},
        issues: ['副本hash/FileId收据由外部释放门绑定'],
      });
    if (options.mode === 'formal')
      checks.push({
        id: 'run-start-provenance',
        status: 'BLOCKED/evidence-insufficient',
        counts: {},
        issues: ['受审计时实现、实际产物、完整567完成trace与DB时间联合证据待绑定'],
      });
    checks.push(checkSources(sources, m0));
    checks.push(checkRules(rules, m0, options.mode));
    const runResult = checkRuns(watch, m0, options.mode);
    checks.push(runResult.check);
    checks.push(checkBaselines(watch, m0, options.mode));
    checks.push(checkAudits(watch, options.mode, expectedPlans(options.mode, m0).length));
    checks.push(checkEvents(watch, options.mode, runResult.eventBindings));
    checks.push(checkDigests(watch, options.mode, m0));
  } finally {
    try {
      sources?.close();
    } finally {
      watch?.close();
    }
  }
  const failed = checks.some((check) => check.status === 'FAIL-product');
  const blocked = checks.some((check) => check.status === 'BLOCKED/evidence-insufficient');
  const pendingOracle =
    options.mode === 'formal'
      ? [
          ...(options.expectedM0Ms === undefined ? ['认证setup M0输入'] : []),
          '副本hash/FileId外部收据绑定',
          '受审计时实现、实际产物、完整567完成trace与DB时间联合证据绑定',
        ]
      : ['完整567次正式负载未运行'];
  return {
    schema: 'watch-database-report-v1',
    runId: options.runId,
    mode: options.mode,
    verdict: failed
      ? 'FAIL-product'
      : options.mode === 'short' || blocked || pendingOracle.length
        ? 'BLOCKED/evidence-insufficient'
        : 'PASS',
    checks,
    pendingOracle,
    disclosure: 'counts-and-classifications-only',
  };
}

function run(): void {
  try {
    if (process.argv.length < 5 || process.argv.length > 6) throw new Error('arguments');
    const [runRoot, runId, mode, expectedM0] = process.argv.slice(2);
    if (mode !== 'short' && mode !== 'formal') throw new Error('mode');
    const expectedM0Ms = expectedM0 === undefined ? undefined : Date.parse(expectedM0);
    if ((mode === 'formal') !== (expectedM0Ms !== undefined && Number.isFinite(expectedM0Ms)))
      throw new Error('m0');
    process.stdout.write(
      JSON.stringify(reportDatabases({ runRoot: runRoot!, runId: runId!, mode, expectedM0Ms })) +
        '\n',
    );
  } catch {
    process.stdout.write(
      JSON.stringify({
        schema: 'watch-database-report-v1',
        verdict: 'BLOCKED/evidence-insufficient',
        error: 'database-report-unavailable',
      }) + '\n',
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  run();
