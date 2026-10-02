import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createQualificationProjection,
  createQualificationRules,
  createQualificationSources,
  getQualificationRun,
} from '../../src/main/watch/qualification/manifest';
import { reportDatabases } from './database-report';
import { populateFormalWatchDatabase } from './database-report-fixture';

vi.mock('../../src/main/watch/qualification/seed-authorization', () => ({
  assertQualificationSeedAuthorization: () => {},
  assertQualificationSeedDatabase: () => {},
  completeQualificationSeed: () => {},
}));

const RUN_ID = 'AAAAAAAAAAAAAAAAAAAAAAAAAA';
const M0 = Date.parse('2026-10-02T10:55:00.000Z');
const roots: string[] = [];

function schema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE watch_rules (id TEXT,source_id TEXT,kind TEXT,state TEXT,pause_reason TEXT,desired_enabled INTEGER,muted INTEGER,access_mode TEXT,schedule_json TEXT,target_json TEXT,condition_json TEXT,notification_level TEXT,source_row_version INTEGER,source_locator_fingerprint TEXT,next_due_at TEXT,last_consumed_scheduled_for TEXT,last_daily_local_date TEXT,consecutive_failures INTEGER,backoff_until TEXT,baseline_version INTEGER,created_at TEXT,updated_at TEXT,rule_version INTEGER,notification_show_details INTEGER);
    CREATE TABLE watch_runs (id TEXT,rule_id TEXT,request_key TEXT,status TEXT,trigger TEXT,scheduled_for TEXT,started_at TEXT,finished_at TEXT,outcome_json TEXT,health_json TEXT,response_metadata_json TEXT);
    CREATE TABLE watch_baselines (rule_id TEXT,version INTEGER,projection_type TEXT,projection_json TEXT,content_hash TEXT,byte_length INTEGER,final_url TEXT,captured_at TEXT,document_id TEXT,conditional_etag TEXT,conditional_last_modified TEXT);
    CREATE TABLE watch_audits (id TEXT,rule_id TEXT,kind TEXT,reason_code TEXT,created_at TEXT);
    CREATE TABLE watch_events (id TEXT,rule_id TEXT,source_id TEXT,event_kind TEXT,importance TEXT,change_fingerprint TEXT,first_observed_at TEXT,last_observed_at TEXT,item_count INTEGER);
    CREATE TABLE watch_event_observations (id TEXT,event_id TEXT,sequence INTEGER,idempotency_key TEXT,change_fingerprint TEXT,event_kind TEXT,observed_at TEXT,item_count INTEGER);
    CREATE TABLE watch_event_items (event_id TEXT,observation_id TEXT,observation_item_sequence INTEGER,item_id TEXT,field_key TEXT,label TEXT,before_value_json TEXT,after_value_json TEXT,before_captured_at TEXT,after_captured_at TEXT,before_final_url TEXT,after_final_url TEXT,before_document_id TEXT,after_document_id TEXT,feed_item_key TEXT);
    CREATE TABLE digest_change_journal (sequence INTEGER,observation_id TEXT,event_id TEXT,source_id TEXT,observed_at TEXT,status TEXT);
    CREATE TABLE digest_change_state (id INTEGER,last_sequence INTEGER);
    CREATE TABLE digest_schedules (id TEXT,version INTEGER,source_ids_json TEXT,schedule_json TEXT,ai_enabled INTEGER,cursor_sequence INTEGER,state TEXT,next_due_at TEXT,last_consumed_scheduled_for TEXT,last_daily_local_date TEXT,last_checked_at TEXT,last_period_json TEXT,last_run_stats_json TEXT);
    CREATE TABLE digest_runs (id TEXT,schedule_id TEXT,request_key TEXT,logical_date TEXT,lower_sequence INTEGER,upper_sequence INTEGER,next_sequence INTEGER,period_json TEXT,run_stats_json TEXT,state TEXT,created_at TEXT,finished_at TEXT);
    CREATE TABLE watch_digests (id TEXT,schedule_id TEXT,run_id TEXT,batch_index INTEGER,first_sequence INTEGER,last_sequence INTEGER,facts_json TEXT,facts_hash TEXT,facts_revision INTEGER,explanation_json TEXT,byte_length INTEGER,provider_state TEXT,provider_result_code TEXT,claimed_at TEXT,provider_finished_at TEXT,created_at TEXT);
    CREATE TABLE digest_event_refs (digest_id TEXT,event_id TEXT,status TEXT);
    CREATE TABLE notification_outbox (subject_type TEXT,subject_id TEXT,channel TEXT,state TEXT,attempts INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE sources (id TEXT,scope TEXT,canonical_key TEXT,url TEXT,name TEXT,group_id TEXT,priority INTEGER,enabled INTEGER,share_mode TEXT,trust_value TEXT,trust_asserted_by TEXT,trust_verification TEXT,user_note TEXT,ai_note TEXT,created_by TEXT,version INTEGER,created_at TEXT,updated_at TEXT,deleted_at TEXT,last_used_at TEXT,last_usage_outcome TEXT);
    CREATE TABLE source_groups (id TEXT); CREATE TABLE source_tags (id TEXT); CREATE TABLE source_tag_links (id TEXT);
    CREATE TABLE change_journal (id TEXT); CREATE TABLE usage_events (id TEXT);
  `);
}

function makeShort(): { allowed: string; runRoot: string; watch: string } {
  const allowed = mkdtempSync(join(tmpdir(), 'aibrowse-db-report-'));
  roots.push(allowed);
  const runRoot = join(allowed, `run-${RUN_ID}`);
  const watchPath = join(runRoot, 'user-data', 'watch', 'watch.db');
  const sourcesPath = join(runRoot, 'user-data', 'sources', 'sources.db');
  mkdirSync(dirname(watchPath), { recursive: true });
  mkdirSync(dirname(sourcesPath), { recursive: true });
  const watch = new DatabaseSync(watchPath);
  const sources = new DatabaseSync(sourcesPath);
  schema(watch);
  schema(sources);
  watch.prepare('INSERT INTO digest_change_state VALUES (1,0)').run();
  const insertSource = sources.prepare(
    'INSERT INTO sources VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  for (const source of createQualificationSources(M0))
    insertSource.run(
      source.id,
      source.scope,
      source.canonicalKey,
      source.url,
      source.name,
      source.groupId,
      source.priority,
      source.enabled ? 1 : 0,
      source.shareMode,
      source.trust.value,
      source.trust.assertedBy,
      source.trust.verification,
      source.userNote,
      source.aiNote,
      source.createdBy,
      source.version,
      source.createdAt,
      source.updatedAt,
      source.deletedAt,
      source.lastUsedAt,
      source.lastUsageOutcome,
    );
  const insertRule = watch.prepare(
    'INSERT INTO watch_rules VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  for (const [index, rule] of createQualificationRules(M0).entries())
    insertRule.run(
      rule.id,
      rule.sourceId,
      rule.kind,
      rule.state,
      rule.pauseReason,
      rule.desiredEnabled ? 1 : 0,
      rule.muted ? 1 : 0,
      rule.accessMode,
      JSON.stringify(rule.schedule),
      JSON.stringify(rule.target),
      rule.condition === null ? null : JSON.stringify(rule.condition),
      rule.notificationLevel,
      rule.sourceRowVersion,
      rule.sourceLocatorFingerprint,
      rule.nextDueAt,
      rule.lastConsumedScheduledFor,
      rule.lastDailyLocalDate,
      rule.consecutiveFailures,
      rule.backoffUntil,
      index >= 80 && index <= 83 ? 1 : 0,
      rule.createdAt,
      rule.updatedAt,
      rule.version,
      rule.showDetails ? 1 : 0,
    );
  watch
    .prepare('INSERT INTO watch_audits VALUES (?,?,?,?,?)')
    .run('audit-start', null, 'reconciliation', 'complete', new Date(M0 - 1000).toISOString());
  for (const index of [80, 81, 82, 83]) {
    const plan = getQualificationRun(index, 'initialization', null, M0);
    const captured = new Date(M0 + index).toISOString();
    const projection = createQualificationProjection(plan, captured);
    const auditId = `audit-${index}`;
    watch
      .prepare('INSERT INTO watch_runs VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        `run-${index}`,
        plan.entry.ruleId,
        plan.requestKey,
        'finished',
        'manual',
        null,
        null,
        captured,
        JSON.stringify({ kind: 'baseline-established', auditId }),
        JSON.stringify({ state: 'healthy', acquisition: 'browser', code: null }),
        JSON.stringify({ schemaVersion: 1, http: null, conditionWarnings: [] }),
      );
    watch
      .prepare('INSERT INTO watch_baselines VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        plan.entry.ruleId,
        1,
        plan.entry.kind,
        JSON.stringify(projection.value),
        projection.contentHash,
        projection.byteLength,
        projection.finalUrl,
        captured,
        projection.documentId,
        null,
        null,
      );
    watch
      .prepare('INSERT INTO watch_audits VALUES (?,?,?,?,?)')
      .run(auditId, plan.entry.ruleId, 'run', 'baseline-established', captured);
  }
  watch.close();
  sources.close();
  return { allowed, runRoot, watch: watchPath };
}

async function makeFormal(): Promise<{ allowed: string; runRoot: string; watch: string }> {
  const fixture = makeShort();
  rmSync(fixture.watch, { force: true });
  await populateFormalWatchDatabase(fixture.watch, M0);
  return fixture;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('关闭后数据库独立报告', () => {
  it('完整formal file-backed DB内容子门通过且总门等待外部副本收据', async () => {
    const fixture = await makeFormal();
    const report = reportDatabases({
      runRoot: fixture.runRoot,
      runId: RUN_ID,
      mode: 'formal',
      expectedM0Ms: M0,
      allowedRoots: [fixture.allowed],
    });
    expect(report.verdict, JSON.stringify(report, null, 2)).toBe('BLOCKED/evidence-insufficient');
    expect(report.pendingOracle).toEqual([
      '副本hash/FileId外部收据绑定',
      '受审计时实现、实际产物、完整567完成trace与DB时间联合证据绑定',
    ]);
    expect(
      report.checks
        .filter((check) => !['copy-provenance', 'run-start-provenance'].includes(check.id))
        .every((check) => check.status === 'PASS'),
    ).toBe(true);
  }, 30_000);

  it('formal反例区分Evidence值、Event归属、Digest ref与非规范时间', async () => {
    const fixture = await makeFormal();
    const db = new DatabaseSync(fixture.watch);
    db.prepare(
      'UPDATE watch_event_items SET after_value_json=? WHERE rowid=(SELECT MIN(rowid) FROM watch_event_items)',
    ).run(JSON.stringify({ kind: 'absent' }));
    db.exec(
      "UPDATE watch_events SET source_id='wrong-source' WHERE rowid=(SELECT MIN(rowid) FROM watch_events)",
    );
    db.exec(`DELETE FROM digest_event_refs WHERE (digest_id,event_id)=(
        SELECT digest_id,event_id FROM digest_event_refs ORDER BY digest_id,event_id LIMIT 1)`);
    db.exec(
      "UPDATE watch_digests SET created_at='2026-10-02 11:39:00' WHERE rowid=(SELECT MIN(rowid) FROM watch_digests)",
    );
    db.close();
    const report = reportDatabases({
      runRoot: fixture.runRoot,
      runId: RUN_ID,
      mode: 'formal',
      expectedM0Ms: M0,
      allowedRoots: [fixture.allowed],
    });
    expect(report.verdict).toBe('FAIL-product');
    expect(
      report.checks.find((check) => check.id === 'events-evidence-coalescing')?.issues,
    ).toEqual(
      expect.arrayContaining([
        'Event与固定Rule/Source/运行归属不匹配',
        'Evidence未精确匹配固定A/B old/new投影',
      ]),
    );
    expect(
      report.checks.find((check) => check.id === 'digests-facts-provider-zero')?.issues,
    ).toEqual(
      expect.arrayContaining([
        'Digest run/facts/journal/ref绑定不匹配',
        'Digest artifact或应用内通知超过due后30秒',
      ]),
    );
  }, 30_000);
  it('formal单字段反例覆盖全journal绑定、ref状态和facts实际UTF8上限', async () => {
    const fixture = await makeFormal();
    const db = new DatabaseSync(fixture.watch);
    db.exec(
      "UPDATE digest_change_journal SET observed_at='2026-10-02T00:00:00Z' WHERE sequence=100",
    );
    db.exec(`UPDATE digest_event_refs SET status='expired' WHERE (digest_id,event_id)=(
        SELECT digest_id,event_id FROM digest_event_refs ORDER BY digest_id,event_id LIMIT 1)`);
    const row = db
      .prepare('SELECT id,facts_json,byte_length FROM watch_digests ORDER BY id LIMIT 1')
      .get() as { id: string; facts_json: string; byte_length: number };
    const targetBytes = 49_153;
    const inflated = row.facts_json + ' '.repeat(targetBytes - Buffer.byteLength(row.facts_json));
    const hash = createHash('sha256').update(inflated).digest('hex');
    db.prepare('UPDATE watch_digests SET facts_json=?,facts_hash=? WHERE id=?').run(
      inflated,
      hash,
      row.id,
    );
    db.close();
    const report = reportDatabases({
      runRoot: fixture.runRoot,
      runId: RUN_ID,
      mode: 'formal',
      expectedM0Ms: M0,
      allowedRoots: [fixture.allowed],
    });
    expect(
      report.checks.find((check) => check.id === 'events-evidence-coalescing')?.issues,
    ).toContain('digest journal未逐行绑定observation/Event/Source');
    expect(
      report.checks.find((check) => check.id === 'digests-facts-provider-zero')?.issues,
    ).toEqual(
      expect.arrayContaining([
        'Digest facts、预算或零Provider状态不匹配',
        'Digest run/facts/journal/ref绑定不匹配',
      ]),
    );
  }, 30_000);
  it('真实短验形状逐项通过，但总门保持BLOCKED且不输出路径或正文', () => {
    const fixture = makeShort();
    const report = reportDatabases({
      runRoot: fixture.runRoot,
      runId: RUN_ID,
      mode: 'short',
      allowedRoots: [fixture.allowed],
    });
    expect(report.verdict).toBe('BLOCKED/evidence-insufficient');
    expect(report.pendingOracle).toEqual(['完整567次正式负载未运行']);
    expect(report.checks.every((check) => check.status === 'PASS')).toBe(true);
    expect(JSON.stringify(report)).not.toContain(fixture.allowed);
    expect(JSON.stringify(report)).not.toContain('projection_json');
  });

  it('拒绝runId与目录名不一致', () => {
    const fixture = makeShort();
    expect(() =>
      reportDatabases({
        runRoot: fixture.runRoot,
        runId: 'BBBBBBBBBBBBBBBBBBBBBBBBBB',
        mode: 'short',
        allowedRoots: [fixture.allowed],
      }),
    ).toThrow(/root-invalid/);
  });

  it('损坏库不能被完整性门错误接受', () => {
    const fixture = makeShort();
    const broken = join(dirname(fixture.watch), 'broken.db');
    copyFileSync(fixture.watch, broken);
    writeFileSync(broken, Buffer.alloc(256, 0));
    writeFileSync(fixture.watch, Buffer.alloc(256, 0));
    expect(() =>
      reportDatabases({
        runRoot: fixture.runRoot,
        runId: RUN_ID,
        mode: 'short',
        allowedRoots: [fixture.allowed],
      }),
    ).toThrow();
  });

  it('第二个数据库打开失败时仍关闭第一个数据库句柄', () => {
    const fixture = makeShort();
    const sources = join(fixture.runRoot, 'user-data', 'sources', 'sources.db');
    writeFileSync(sources, Buffer.alloc(128, 0));
    expect(() =>
      reportDatabases({
        runRoot: fixture.runRoot,
        runId: RUN_ID,
        mode: 'short',
        allowedRoots: [fixture.allowed],
      }),
    ).toThrow();
    renameSync(fixture.watch, fixture.watch + '.closed');
  });

  it('schema中的raw_body列被真实识别且不伪报固定零行', () => {
    const fixture = makeShort();
    const db = new DatabaseSync(fixture.watch);
    db.exec('ALTER TABLE watch_runs ADD COLUMN raw_body TEXT');
    db.close();
    const report = reportDatabases({
      runRoot: fixture.runRoot,
      runId: RUN_ID,
      mode: 'short',
      allowedRoots: [fixture.allowed],
    });
    const check = report.checks.find((candidate) => candidate.id === 'schema-payload-column-ban');
    expect(check?.issues).toContain('数据库schema出现禁止的原始内容列');
    expect(check?.counts).not.toHaveProperty('rawBodyRows');
  });

  it('formal缺Event不会只因运行总数不足而被模糊化', () => {
    const fixture = makeShort();
    const report = reportDatabases({
      runRoot: fixture.runRoot,
      runId: RUN_ID,
      mode: 'formal',
      allowedRoots: [fixture.allowed],
    });
    const event = report.checks.find((check) => check.id === 'events-evidence-coalescing');
    expect(event?.issues).toContain('Event/observation/evidence数量不匹配');
    expect(report.verdict).toBe('FAIL-product');
  });

  it('formal业务oracle补齐前显式保持BLOCKED或更高优先级FAIL', () => {
    const fixture = makeShort();
    const report = reportDatabases({
      runRoot: fixture.runRoot,
      runId: RUN_ID,
      mode: 'formal',
      allowedRoots: [fixture.allowed],
    });
    expect(report.pendingOracle).toContain('认证setup M0输入');
    expect(report.checks.find((check) => check.id === 'copy-provenance')?.status).toBe(
      'BLOCKED/evidence-insufficient',
    );
    expect(report.verdict).not.toBe('PASS');
  });

  it('formal将认证setup M0与数据库固定清单时间独立绑定', () => {
    const fixture = makeShort();
    const matching = reportDatabases({
      runRoot: fixture.runRoot,
      runId: RUN_ID,
      mode: 'formal',
      expectedM0Ms: M0,
      allowedRoots: [fixture.allowed],
    });
    expect(matching.checks.find((check) => check.id === 'formal-authenticated-m0')?.status).toBe(
      'PASS',
    );
    expect(matching.pendingOracle).toEqual([
      '副本hash/FileId外部收据绑定',
      '受审计时实现、实际产物、完整567完成trace与DB时间联合证据绑定',
    ]);
    const mismatched = reportDatabases({
      runRoot: fixture.runRoot,
      runId: RUN_ID,
      mode: 'formal',
      expectedM0Ms: M0 + 1,
      allowedRoots: [fixture.allowed],
    });
    expect(mismatched.checks.find((check) => check.id === 'formal-authenticated-m0')?.status).toBe(
      'FAIL-product',
    );
  });

  it('伪Evidence和Provider claim分别产生明确失败分类', () => {
    const fixture = makeShort();
    const db = new DatabaseSync(fixture.watch);
    db.prepare('INSERT INTO watch_events VALUES (?,?,?,?,?,?,?,?,?)').run(
      'event-1',
      createQualificationRules(M0)[3]!.id,
      createQualificationSources(M0)[3]!.id,
      'changed',
      'normal',
      'fake-fingerprint',
      new Date(M0).toISOString(),
      new Date(M0).toISOString(),
      1,
    );
    db.prepare('INSERT INTO watch_event_observations VALUES (?,?,?,?,?,?,?,?)').run(
      'observation-1',
      'event-1',
      0,
      'fake-idempotency',
      'fake-fingerprint',
      'changed',
      new Date(M0).toISOString(),
      1,
    );
    db.prepare('INSERT INTO watch_event_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'event-1',
      'observation-1',
      0,
      'item',
      'title',
      'title',
      '{"kind":"present"}',
      '{"kind":"present"}',
      new Date(M0).toISOString(),
      new Date(M0).toISOString(),
      'https://h3.aibrowse.invalid/',
      'https://h3.aibrowse.invalid/',
      null,
      null,
      null,
    );
    db.prepare('INSERT INTO watch_digests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'digest-1',
      'schedule-1',
      'digest-run-1',
      0,
      1,
      1,
      '{}',
      '0'.repeat(64),
      1,
      null,
      new Date(M0).toISOString(),
      2,
      'claimed',
      null,
      new Date(M0).toISOString(),
      null,
    );
    db.close();
    const report = reportDatabases({
      runRoot: fixture.runRoot,
      runId: RUN_ID,
      mode: 'formal',
      allowedRoots: [fixture.allowed],
    });
    expect(
      report.checks.find((check) => check.id === 'events-evidence-coalescing')?.issues,
    ).toContain('Evidence不是有效typed old/new pair');
    expect(
      report.checks.find((check) => check.id === 'digests-facts-provider-zero')?.issues,
    ).toContain('Digest facts、预算或零Provider状态不匹配');
  });
});
