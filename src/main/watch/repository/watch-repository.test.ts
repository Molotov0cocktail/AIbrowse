// D4 watch-repository tests: 真实 node:sqlite 全部业务原语（detailed-design
// §7/§9/§10、threat-model §3.5/WT-21）。覆盖：Rule CRUD/CAS、Baseline CAS、
// Event+items+Baseline+Run+outbox 原子性（注入失败全回滚）、run 状态机、
// intent 状态机、级联删除 + Digest tombstone、保留预算（时间/数量/单对象/全库）、
// SQL 注入串仅作数据、读路径二次校验 fail-closed。临时目录精确清理。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, closeDb, type DbHandle } from '../../sources/db/sqlite-driver';
import { runWatchMigrations } from '../db/watch-migrations';
import { WatchRepository, WatchRepositoryError } from './watch-repository';
import type { ChangeEvidencePair, WatchEvent, WatchRule } from '../../../shared/types/watch';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-watch-repo-'));

let handle: DbHandle;
let repo: WatchRepository;

function newHandle(): DbHandle {
  const db = openDb(join(root, `repo-${Math.random().toString(36).slice(2)}.db`));
  runWatchMigrations(db);
  return db;
}

beforeEach(() => {
  handle = newHandle();
  repo = new WatchRepository(handle);
});

afterEach(() => {
  if (!repo.isDisposed) repo.dispose();
  else handle.close();
});

const FINGERPRINT = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const NOW = '2026-08-28T00:00:00.000Z';

function makeRule(overrides: Partial<WatchRule> = {}): WatchRule {
  return {
    id: randomUUID(),
    sourceId: 'src-1',
    kind: 'feed',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'public',
    schedule: { kind: 'interval', intervalMinutes: 60 },
    target: { type: 'feed', feedUrl: 'https://example.com/rss.xml', format: 'rss2' },
    condition: null,
    notificationLevel: 'normal',
    sourceRowVersion: 1,
    sourceLocatorFingerprint: FINGERPRINT,
    nextDueAt: null,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeEvent(ruleId: string, overrides: Partial<WatchEvent> = {}): WatchEvent {
  return {
    id: randomUUID(),
    ruleId,
    sourceId: 'src-1',
    eventKind: 'added',
    importance: 'normal',
    idempotencyKey: randomUUID(),
    changeFingerprint: 'fp-1',
    firstObservedAt: NOW,
    lastObservedAt: NOW,
    itemCount: 1,
    readAt: null,
    ...overrides,
  };
}

function makeItem(overrides: Partial<ChangeEvidencePair> = {}): ChangeEvidencePair {
  return {
    itemId: 'it-1',
    fieldKey: 'title',
    label: '标题',
    before: { kind: 'absent' },
    after: {
      kind: 'present',
      excerpt: '新标题',
      valueHash: 'h',
      normalizedBytes: 9,
      truncated: false,
    },
    beforeCapturedAt: NOW,
    afterCapturedAt: NOW,
    beforeFinalUrl: 'https://example.com',
    afterFinalUrl: 'https://example.com',
    beforeDocumentId: null,
    afterDocumentId: null,
    feedItemKey: null,
    ...overrides,
  };
}

function count(table: string): number {
  const row = handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint };
  return Number(row.n);
}

function insertDigestRefFixture(eventId: string): void {
  const event = repo.getEvent(eventId)!;
  const facts = JSON.stringify({
    schemaVersion: 1,
    scheduleId: 'ds1',
    digestRunId: 'dr1',
    batchIndex: 0,
    period: { fromExclusive: NOW, toInclusive: '2026-08-29T00:00:00.000Z' },
    eventCount: 1,
    runStats: { changed: 0, failed: 0, unchanged: 0 },
    events: [
      {
        eventId,
        ruleId: event.ruleId,
        sourceId: event.sourceId,
        eventKind: event.eventKind,
        importance: event.importance,
        firstIncludedAt: event.firstObservedAt,
        lastIncludedAt: event.lastObservedAt,
        observationCount: 1,
        itemCount: 1,
      },
    ],
    evidenceMap: { [eventId]: [makeItem()] },
    referenceStates: { [eventId]: 'active' },
    fetchedAt: '2026-08-29T00:00:00.000Z',
  });
  const hash = createHash('sha256').update(facts, 'utf8').digest('hex');
  expect(
    repo.createDigestSchedule({
      id: 'ds1',
      sourceIds: ['src-1'],
      localTime: '09:00',
      timeZone: 'Asia/Shanghai',
      nextDueAt: '2026-08-29T01:00:00.000Z',
      nowIso: NOW,
    }),
  ).toEqual({ ok: true });
  handle
    .prepare(
      `INSERT INTO digest_runs
  (id,schedule_id,request_key,logical_date,lower_sequence,upper_sequence,next_sequence,
   period_json,run_stats_json,state,created_at)
  VALUES ('dr1','ds1','req1','2026-08-29',0,1,0,
   '{"fromExclusive":"2026-08-28T00:00:00.000Z","toInclusive":"2026-08-29T00:00:00.000Z"}',
   '{"changed":0,"failed":0,"unchanged":0}','running',?)`,
    )
    .run(NOW);
  handle
    .prepare(
      `INSERT INTO watch_digests
  (id,schedule_id,run_id,batch_index,first_sequence,last_sequence,facts_json,facts_hash,
   facts_revision,byte_length,provider_state,provider_result_code,provider_finished_at,created_at)
  VALUES ('d1','ds1','dr1',0,1,1,?,?,1,?,
   'disabled','disabled',?,?)`,
    )
    .run(facts, hash, Buffer.byteLength(facts), NOW, NOW);
  expect(repo.insertDigestEventRef({ digestId: 'd1', eventId, status: 'active' })).toEqual({
    ok: true,
  });
}

// D4-R：Event/结果提交的单事务完整身份 CAS 期望值（rule 的当前身份投影）
function identity(ruleId: string, baselineVersion: number | null = null) {
  void ruleId; // 本夹具全部规则共享 src-1/FINGERPRINT 身份
  return {
    sourceId: 'src-1',
    expectedSourceLocatorFingerprint: FINGERPRINT,
    expectedBaselineVersion: baselineVersion,
  };
}

describe('Rule CRUD + CAS', () => {
  it('insert/get/list/listBySource 恒等读回（经共享 validator）', () => {
    const rule = makeRule({
      muted: true,
      condition: {
        version: 1,
        combine: 'all',
        predicates: [
          { fieldKey: 'title', operator: 'contains', operand: 'x', caseSensitive: true },
        ],
      },
    });
    expect(repo.insertRule(rule)).toEqual({ ok: true });
    const got = repo.getRule(rule.id);
    expect(got).not.toBeNull();
    expect(got).toEqual(rule);
    expect(repo.listRules().map((r) => r.id)).toEqual([rule.id]);
    expect(repo.listRulesBySource('src-1').length).toBe(1);
    expect(repo.listRulesBySource('other').length).toBe(0);
  });

  it('paused 必须带 reason；enabled 带 reason 拒绝（validation-failed）', () => {
    expect(repo.insertRule(makeRule({ state: 'paused', pauseReason: null }))).toEqual({
      ok: false,
      code: 'validation-failed',
    });
    expect(repo.insertRule(makeRule({ pauseReason: 'user' }))).toEqual({
      ok: false,
      code: 'validation-failed',
    });
    expect(repo.insertRule(makeRule({ state: 'paused', pauseReason: 'user' }))).toEqual({
      ok: true,
    });
  });

  it('feed+session / page+session 之外组合拒绝；kind 与 target 不一致拒绝', () => {
    expect(repo.insertRule(makeRule({ accessMode: 'session' }))).toEqual({
      ok: false,
      code: 'validation-failed',
    });
    expect(
      repo.insertRule(
        makeRule({
          kind: 'page',
          target: { type: 'feed', feedUrl: 'https://x.com/f', format: 'rss2' },
        }),
      ),
    ).toEqual({ ok: false, code: 'validation-failed' });
  });

  it('updateRuleCoordination CAS：匹配更新、不匹配零写入、缺失 rule-not-found', () => {
    const rule = makeRule();
    expect(repo.insertRule(rule)).toEqual({ ok: true });
    const expected = {
      state: rule.state,
      pauseReason: rule.pauseReason,
      sourceRowVersion: rule.sourceRowVersion,
      sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
    };
    const ok = repo.updateRuleCoordination(
      rule.id,
      expected,
      {
        state: 'paused',
        pauseReason: 'source-disabled',
        sourceRowVersion: 2,
        sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
      },
      NOW,
    );
    expect(ok).toEqual({ ok: true });
    const after = repo.getRule(rule.id)!;
    expect(after.state).toBe('paused');
    expect(after.pauseReason).toBe('source-disabled');
    expect(after.sourceRowVersion).toBe(2);
    // 陈旧 expected → 零写入
    const stale = repo.updateRuleCoordination(
      rule.id,
      expected,
      {
        state: 'enabled',
        pauseReason: null,
        sourceRowVersion: 3,
        sourceLocatorFingerprint: FINGERPRINT,
      },
      NOW,
    );
    expect(stale).toEqual({ ok: false, code: 'rule-state-conflict' });
    expect(repo.getRule(rule.id)!.sourceRowVersion).toBe(2);
    expect(
      repo.updateRuleCoordination(
        'ghost',
        expected,
        {
          state: 'enabled',
          pauseReason: null,
          sourceRowVersion: 1,
          sourceLocatorFingerprint: FINGERPRINT,
        },
        NOW,
      ),
    ).toEqual({
      ok: false,
      code: 'rule-not-found',
    });
  });

  it('deleteRule 级联清空子行', () => {
    const rule = makeRule();
    expect(repo.insertRule(rule)).toEqual({ ok: true });
    repo.insertRun({
      id: 'run1',
      ruleId: rule.id,
      requestKey: 'k1',
      trigger: 'scheduled',
      scheduledFor: null,
    });
    expect(repo.deleteRule(rule.id)).toEqual({ ok: true });
    expect(count('watch_runs')).toBe(0);
    expect(repo.deleteRule(rule.id)).toEqual({ ok: false, code: 'rule-not-found' });
  });

  it('SQL 注入串仅作数据（sourceId/operand 敌手形态）', () => {
    const injection = "'; DROP TABLE watch_rules;--";
    const rule = makeRule({
      sourceId: injection,
      condition: {
        version: 1,
        combine: 'all',
        predicates: [
          { fieldKey: 'title', operator: 'contains', operand: injection, caseSensitive: true },
        ],
      },
    });
    expect(repo.insertRule(rule)).toEqual({ ok: true });
    const got = repo.getRule(rule.id)!;
    expect(got.sourceId).toBe(injection);
    expect(got.condition!.predicates[0]!.operand).toBe(injection);
    expect(count('watch_rules')).toBe(1);
  });
});

describe('Baseline CAS（§9.1）', () => {
  function baselineInput(
    ruleId: string,
    expected: number | null,
    projectionJson = '{"format":"rss2"}',
  ) {
    return {
      ruleId,
      expectedBaselineVersion: expected,
      projectionType: 'feed' as const,
      projectionJson,
      contentHash: 'h1',
      byteLength: Buffer.byteLength(projectionJson, 'utf8'),
      finalUrl: 'https://example.com',
      capturedAt: NOW,
      documentId: null,
    };
  }

  it('首个写入（expected null）→ version 1 + rule.baseline_version 同步', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const r = repo.writeBaseline(baselineInput(rule.id, null));
    expect(r).toEqual({ ok: true });
    const baseline = repo.getBaseline(rule.id)!;
    expect(baseline.version).toBe(1);
    expect(repo.getRule(rule.id)!.baselineVersion).toBe(1);
  });

  it('CAS 推进：expected=1 命中 → version 2；陈旧 expected=0 → conflict 零写入', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    repo.writeBaseline(baselineInput(rule.id, null));
    expect(repo.writeBaseline(baselineInput(rule.id, 1))).toEqual({ ok: true });
    expect(repo.getBaseline(rule.id)!.version).toBe(2);
    const stale = repo.writeBaseline(baselineInput(rule.id, 0));
    expect(stale).toEqual({ ok: false, code: 'baseline-conflict' });
    expect(repo.getBaseline(rule.id)!.version).toBe(2);
    // 双重首写（expected null 但已存在）→ conflict（UNIQUE 主键兜底）
    expect(repo.writeBaseline(baselineInput(rule.id, null))).toEqual({
      ok: false,
      code: 'baseline-conflict',
    });
  });

  it('单 Baseline 预算：==65536 接受、+1 拒绝（baseline-budget-exceeded）', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    // 真实 UTF-8 字节 == 65536（多字节字符参与，字节数与声明一致）
    const exact = JSON.stringify({ x: '汉'.repeat(2) + 'a'.repeat(65536 - 14) });
    expect(Buffer.byteLength(exact, 'utf8')).toBe(65536);
    expect(repo.writeBaseline(baselineInput(rule.id, null, exact))).toEqual({ ok: true });
    const forged = baselineInput(rule.id, 1, '{}');
    forged.byteLength = 65537; // 伪造声明 > 单对象上限
    expect(repo.writeBaseline(forged)).toEqual({ ok: false, code: 'baseline-budget-exceeded' });
  });

  it('规则不存在 → rule-not-found', () => {
    expect(repo.writeBaseline(baselineInput('ghost', null))).toEqual({
      ok: false,
      code: 'rule-not-found',
    });
  });
});

describe('Run 状态机（status 列 D5 reservation 前向兼容）', () => {
  it('insertRun + 状态迁移 CAS + 终态不可离开', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    expect(
      repo.insertRun({
        id: 'r1',
        ruleId: rule.id,
        requestKey: 'k1',
        trigger: 'scheduled',
        scheduledFor: null,
      }),
    ).toEqual({ ok: true });
    expect(
      repo.insertRun({
        id: 'r2',
        ruleId: rule.id,
        requestKey: 'k1',
        trigger: 'manual',
        scheduledFor: null,
      }),
    ).toEqual({
      ok: false,
      code: 'duplicate-request-key',
    });
    expect(repo.transitionRun('r1', 'queued', { status: 'running', startedAt: NOW })).toEqual({
      ok: true,
    });
    const running = repo.getRun('r1')!;
    expect(running.status).toBe('running');
    expect(running.startedAt).toBe(NOW);
    // R3-2：finished 必须携带 canonical metadata；此处提供合法 metadata，冲突判定
    //（queued→finished 且当前 running）仍返回 run-state-conflict（CAS 先于写入）。
    expect(
      repo.transitionRun('r1', 'queued', {
        status: 'finished',
        finishedAt: NOW,
        responseMetadataJson: metaJson(),
      }),
    ).toEqual({
      ok: false,
      code: 'run-state-conflict',
    });
    expect(
      repo.transitionRun('r1', 'running', {
        status: 'finished',
        finishedAt: NOW,
        outcome: { kind: 'unchanged' },
        health: { state: 'healthy', acquisition: 'rss', code: null },
        responseMetadataJson: metaJson(),
      }),
    ).toEqual({ ok: true });
    expect(repo.getRun('r1')!.outcome).toEqual({ kind: 'unchanged' });
    expect(repo.transitionRun('ghost', 'queued', { status: 'running' })).toEqual({
      ok: false,
      code: 'run-not-found',
    });
  });

  it('markAllNonTerminalInterrupted 只影响 queued/running', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    repo.insertRun({
      id: 'r1',
      ruleId: rule.id,
      requestKey: 'k1',
      trigger: 'scheduled',
      scheduledFor: null,
    });
    repo.insertRun({
      id: 'r2',
      ruleId: rule.id,
      requestKey: 'k2',
      trigger: 'manual',
      scheduledFor: null,
    });
    repo.insertRun({
      id: 'r3',
      ruleId: rule.id,
      requestKey: 'k3',
      trigger: 'manual',
      scheduledFor: null,
    });
    repo.transitionRun('r2', 'queued', { status: 'running' });
    repo.transitionRun('r3', 'queued', {
      status: 'finished',
      finishedAt: NOW,
      responseMetadataJson: metaJson(),
    });
    expect(repo.markAllNonTerminalInterrupted(NOW)).toBe(2);
    expect(repo.getRun('r1')!.status).toBe('interrupted');
    expect(repo.getRun('r2')!.status).toBe('interrupted');
    expect(repo.getRun('r3')!.status).toBe('finished');
  });
});

describe('Event+items+Baseline+Run+outbox 单事务原子写（§9.4）', () => {
  it('全量成功：event/items/baseline/run/outbox 全部落库', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    repo.insertRun({
      id: 'run1',
      ruleId: rule.id,
      requestKey: 'k1',
      trigger: 'scheduled',
      scheduledFor: null,
    });
    repo.transitionRun('run1', 'queued', { status: 'running' });
    const result = repo.writeEventTransaction({
      event: makeEvent(rule.id, { itemCount: 2 }),
      items: [makeItem(), makeItem({ itemId: 'it-2', fieldKey: 'link' })],
      identity: identity(rule.id),
      baseline: {
        expectedBaselineVersion: null,
        projectionType: 'feed',
        projectionJson: '{"format":"rss2"}',
        contentHash: 'h',
        byteLength: 17,
        finalUrl: 'https://example.com',
        capturedAt: NOW,
        documentId: null,
      },
      run: {
        runId: 'run1',
        expectedStatus: 'running',
        outcome: { kind: 'event-created', eventId: 'e1' },
        health: null,
        responseMetadataJson: metaJson(),
      },
      outbox: [
        {
          id: 'o1',
          ruleId: rule.id,
          subjectType: 'event',
          subjectId: 'e1',
          channel: 'in-app',
          dedupeKey: 'dk1',
          privacyJson: '{"title":"x"}',
          createdAt: NOW,
        },
      ],
    });
    expect(result).toEqual({ ok: true });
    expect(count('watch_events')).toBe(1);
    expect(count('watch_event_items')).toBe(2);
    expect(count('notification_outbox')).toBe(1);
    expect(repo.getBaseline(rule.id)!.version).toBe(1);
    expect(repo.getRun('run1')!.status).toBe('finished');
    expect(repo.getRun('run1')!.outcome).toEqual({ kind: 'event-created', eventId: 'e1' });
  });

  it('注入失败（run CAS 冲突）→ 全回滚零半数据', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const result = repo.writeEventTransaction({
      event: makeEvent(rule.id),
      items: [makeItem()],
      identity: identity(rule.id),
      baseline: {
        expectedBaselineVersion: null,
        projectionType: 'feed',
        projectionJson: '{}',
        contentHash: 'h',
        byteLength: 2,
        finalUrl: 'https://example.com',
        capturedAt: NOW,
        documentId: null,
      },
      run: {
        runId: 'ghost',
        expectedStatus: 'running',
        outcome: { kind: 'unchanged' },
        health: null,
        responseMetadataJson: metaJson(),
      },
    });
    expect(result).toEqual({ ok: false, code: 'run-not-found' });
    expect(count('watch_events')).toBe(0);
    expect(count('watch_event_items')).toBe(0);
    expect(repo.getBaseline(rule.id)).toBeNull();
  });

  it('重复 idempotency_key → duplicate-idempotency 全回滚（含 baseline 推进）', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const event = makeEvent(rule.id);
    expect(
      repo.writeEventTransaction({
        event,
        items: [makeItem()],
        identity: identity(rule.id),
        baseline: {
          expectedBaselineVersion: null,
          projectionType: 'feed',
          projectionJson: '{}',
          contentHash: 'h',
          byteLength: 2,
          finalUrl: 'https://example.com',
          capturedAt: NOW,
          documentId: null,
        },
      }),
    ).toEqual({ ok: true });
    const second = repo.writeEventTransaction({
      event: { ...makeEvent(rule.id), idempotencyKey: event.idempotencyKey },
      items: [makeItem()],
      identity: identity(rule.id, 1),
      baseline: {
        expectedBaselineVersion: 1,
        projectionType: 'feed',
        projectionJson: '{}',
        contentHash: 'h',
        byteLength: 2,
        finalUrl: 'https://example.com',
        capturedAt: NOW,
        documentId: null,
      },
    });
    expect(second).toEqual({ ok: false, code: 'duplicate-idempotency' });
    expect(count('watch_events')).toBe(1);
    expect(repo.getBaseline(rule.id)!.version).toBe(1); // baseline 未推进
  });

  it('单对象预算边界：Evidence 合计 == 上限接受、+1 拒绝', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const item = makeItem();
    item.after = {
      kind: 'present',
      excerpt: 'x'.repeat(100),
      valueHash: 'h',
      normalizedBytes: 100,
      truncated: false,
    };
    const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
    const tight = new WatchRepository(handle, { maxEventEvidenceBytes: bytes });
    const ok = tight.writeEventTransaction({
      event: makeEvent(rule.id),
      items: [item],
      identity: identity(rule.id),
    });
    expect(ok).toEqual({ ok: true });
    const tight2 = new WatchRepository(handle, { maxEventEvidenceBytes: bytes - 1 });
    const fail = tight2.writeEventTransaction({
      event: makeEvent(rule.id),
      items: [item],
      identity: identity(rule.id),
    });
    expect(fail).toEqual({ ok: false, code: 'event-budget-exceeded' });
  });

  it('全库预算写前估算：注入小 maxDbBytes 拒绝（db-budget-exceeded）', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const tiny = new WatchRepository(handle, { maxDbBytes: 10 });
    const result = tiny.writeEventTransaction({
      event: makeEvent(rule.id),
      items: [makeItem()],
      identity: identity(rule.id),
    });
    expect(result).toEqual({ ok: false, code: 'db-budget-exceeded' });
  });

  it('itemCount 与 items 数量不符 → validation-failed；非法 item → validation-failed', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    expect(
      repo.writeEventTransaction({
        event: makeEvent(rule.id, { itemCount: 2 }),
        items: [makeItem()],
        identity: identity(rule.id),
      }),
    ).toEqual({ ok: false, code: 'validation-failed' });
    const hostile = { ...makeItem(), fieldKey: '' };
    expect(
      repo.writeEventTransaction({
        event: makeEvent(rule.id),
        items: [hostile],
        identity: identity(rule.id),
      }),
    ).toEqual({
      ok: false,
      code: 'validation-failed',
    });
  });

  it('读回经共享 validator：手工污染行 → getEvent 返回 null（fail-closed）', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const event = makeEvent(rule.id);
    expect(
      repo.writeEventTransaction({ event, items: [makeItem()], identity: identity(event.ruleId) }),
    ).toEqual({ ok: true });
    handle
      .prepare('UPDATE watch_events SET first_observed_at = ? WHERE id = ?')
      .run('not-a-time', event.id);
    expect(repo.getEvent(event.id)).toBeNull();
    expect(repo.listEventsByRule(rule.id).length).toBe(0);
  });
});

describe('intent 状态机（§10.3）', () => {
  function intentRow(state: 'prepared' | 'source-committed' | 'complete' | 'aborted' = 'prepared') {
    return {
      mutationId: randomUUID(),
      sourceId: 'src-1',
      operation: 'hard-delete' as const,
      beforeProjection: {
        sourceId: 'src-1',
        rowVersion: 1,
        enabled: true,
        deletedAt: null,
        scope: 'page' as const,
        canonicalKey: 'https://example.com/doc',
      },
      afterProjection: null,
      affectedRuleState: {
        r1: {
          state: 'enabled' as const,
          pauseReason: null,
          desiredEnabled: true,
          sourceRowVersion: 1,
          sourceLocatorFingerprint: FINGERPRINT,
        },
      },
      state,
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  it('insert/get/list/pending 恒等；重复 mutationId → duplicate-mutation', () => {
    const row = intentRow();
    expect(repo.insertSourceCleanupIntent(row)).toEqual({ ok: true });
    expect(repo.insertSourceCleanupIntent(row)).toEqual({ ok: false, code: 'duplicate-mutation' });
    const got = repo.getSourceCleanupIntent(row.mutationId)!;
    expect(got.mutationId).toBe(row.mutationId);
    expect(got.affectedRuleState['r1']!.state).toBe('enabled');
    expect(repo.listSourceCleanupIntents().length).toBe(1);
    expect(repo.listPendingSourceCleanupIntents().length).toBe(1);
  });

  it('transition CAS：prepared→complete；终态不可离开；缺行 intent-not-found', () => {
    const row = intentRow();
    repo.insertSourceCleanupIntent(row);
    expect(repo.transitionSourceCleanupIntent(row.mutationId, 'prepared', 'complete', NOW)).toEqual(
      { ok: true },
    );
    expect(repo.transitionSourceCleanupIntent(row.mutationId, 'complete', 'aborted', NOW)).toEqual({
      ok: false,
      code: 'intent-state-conflict',
    });
    expect(repo.transitionSourceCleanupIntent(row.mutationId, 'prepared', 'aborted', NOW)).toEqual({
      ok: false,
      code: 'intent-state-conflict',
    });
    expect(repo.transitionSourceCleanupIntent('ghost', 'prepared', 'complete', NOW)).toEqual({
      ok: false,
      code: 'intent-not-found',
    });
    expect(repo.listPendingSourceCleanupIntents().length).toBe(0);
  });

  it('deleteResolvedIntents 只删 complete/aborted', () => {
    const a = intentRow('complete');
    const b = intentRow('aborted');
    const c = intentRow('prepared');
    repo.insertSourceCleanupIntent(a);
    repo.insertSourceCleanupIntent(b);
    repo.insertSourceCleanupIntent(c);
    expect(repo.deleteResolvedIntents()).toBe(2);
    expect(repo.listSourceCleanupIntents().length).toBe(1);
  });

  it('非法投影/affected map → validation-failed 零写入', () => {
    const bad = intentRow();
    bad.beforeProjection = { ...bad.beforeProjection!, scope: 'weird' as never };
    expect(repo.insertSourceCleanupIntent(bad)).toEqual({ ok: false, code: 'validation-failed' });
    expect(count('source_cleanup_intents')).toBe(0);
  });
});

describe('级联删除 + Digest tombstone + outbox 清理', () => {
  it('cascadeDeleteRulesBySource：规则/事件级联、ref → expired、outbox 移除、audit CASCADE 随规则删除', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const event = makeEvent(rule.id);
    expect(
      repo.writeEventTransaction({
        event,
        items: [makeItem()],
        identity: identity(rule.id),
        outbox: [
          {
            id: 'o1',
            ruleId: rule.id,
            subjectType: 'event',
            subjectId: event.id,
            channel: 'in-app',
            dedupeKey: 'dk1',
            privacyJson: '{}',
            createdAt: NOW,
          },
        ],
      }),
    ).toEqual({ ok: true });
    insertDigestRefFixture(event.id);
    repo.insertAudit({
      id: 'a1',
      ruleId: rule.id,
      kind: 'lifecycle-pause',
      reasonCode: 'source-disabled',
      createdAt: NOW,
    });
    expect(repo.cascadeDeleteRulesBySource('src-1')).toEqual({ ok: true, deletedEvents: 1 });
    expect(count('watch_rules')).toBe(0);
    expect(count('watch_events')).toBe(0);
    expect(count('notification_outbox')).toBe(0);
    expect(repo.listDigestEventRefs()).toEqual([
      { digestId: 'd1', eventId: event.id, status: 'expired' },
    ]);
    expect(count('watch_audits')).toBe(0); // §10.1：删除 Rule CASCADE audits
  });
});

describe('invalidateAllSessionConsents（恢复后 grant 失效）', () => {
  function pageRule() {
    return makeRule({
      kind: 'page',
      target: {
        type: 'page',
        pageUrl: 'https://example.com/doc',
        regions: [{ kind: 'main-text', label: '正文' }],
        sessionConsent: { version: 1, origin: 'https://example.com', grantedAt: NOW },
      },
    });
  }

  it('全部 page 规则 consent 置 null；feed 不动；计数', () => {
    const page = pageRule();
    const feed = makeRule();
    repo.insertRule(page);
    repo.insertRule(feed);
    expect(repo.invalidateAllSessionConsents()).toEqual({ ok: true, count: 1 });
    const gotPage = repo.getRule(page.id)!;
    expect(gotPage.target.type).toBe('page');
    if (gotPage.target.type === 'page') expect(gotPage.target.sessionConsent).toBeNull();
    expect(repo.getRule(feed.id)!.target).toEqual(feed.target);
    // 幂等：再次调用零计数
    expect(repo.invalidateAllSessionConsents()).toEqual({ ok: true, count: 0 });
  });

  it('非法 target JSON → 整体失败零写入', () => {
    const page = pageRule();
    repo.insertRule(page);
    handle.prepare('UPDATE watch_rules SET target_json = ? WHERE id = ?').run('not-json', page.id);
    expect(repo.invalidateAllSessionConsents()).toEqual({ ok: false, count: 0 });
  });
});

describe('保留预算（§10.4）', () => {
  it('公开规则：==200 全保留、+1 删最旧；时间截止 90 天', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const base = Date.parse('2026-08-28T00:00:00.000Z');
    const oldTime = new Date(base - 91 * 24 * 60 * 60 * 1000).toISOString();
    const freshTime = new Date(base - 10 * 24 * 60 * 60 * 1000).toISOString();
    // 200 个新鲜事件（== cap 保留）
    for (let i = 0; i < 200; i += 1) {
      const event = makeEvent(rule.id, {
        firstObservedAt: new Date(base - i * 1000).toISOString(),
        lastObservedAt: new Date(base - i * 1000).toISOString(),
      });
      expect(
        repo.writeEventTransaction({
          event,
          items: [makeItem()],
          identity: identity(event.ruleId),
        }),
      ).toEqual({ ok: true });
    }
    expect(repo.pruneEventsByRuleLimits(new Date(base).toISOString())).toEqual({
      deleted: 0,
      expiredRefs: 0,
    });
    // +1 → 删 1（最旧）
    const extra = makeEvent(rule.id, { firstObservedAt: freshTime, lastObservedAt: freshTime });
    expect(
      repo.writeEventTransaction({
        event: extra,
        items: [makeItem()],
        identity: identity(extra.ruleId),
      }),
    ).toEqual({ ok: true });
    expect(repo.pruneEventsByRuleLimits(new Date(base).toISOString()).deleted).toBe(1);
    expect(count('watch_events')).toBe(200);
    // 91 天前事件 → 时间截止删除
    const ancient = makeEvent(rule.id, { firstObservedAt: oldTime, lastObservedAt: oldTime });
    expect(
      repo.writeEventTransaction({
        event: ancient,
        items: [makeItem()],
        identity: identity(ancient.ruleId),
      }),
    ).toEqual({
      ok: true,
    });
    const pruned = repo.pruneEventsByRuleLimits(new Date(base).toISOString());
    expect(pruned.deleted).toBe(1);
    expect(repo.getEvent(ancient.id)).toBeNull();
    expect(count('watch_events')).toBe(200);
  });

  it('清理顺序：已读最旧 → 未读最旧（全库预算逐事件边际验证）', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const base = Date.parse('2026-08-28T00:00:00.000Z');
    const evA = makeEvent(rule.id, {
      firstObservedAt: new Date(base - 3000).toISOString(),
      lastObservedAt: new Date(base - 3000).toISOString(),
    });
    const evB = makeEvent(rule.id, {
      firstObservedAt: new Date(base - 2000).toISOString(),
      lastObservedAt: new Date(base - 2000).toISOString(),
    });
    const evC = makeEvent(rule.id, {
      firstObservedAt: new Date(base - 1000).toISOString(),
      lastObservedAt: new Date(base - 1000).toISOString(),
    });
    expect(
      repo.writeEventTransaction({
        event: evA,
        items: [makeItem()],
        identity: identity(evA.ruleId),
      }),
    ).toEqual({ ok: true });
    const afterA = repo.estimateLogicalBytes();
    expect(
      repo.writeEventTransaction({
        event: evB,
        items: [makeItem()],
        identity: identity(evB.ruleId),
      }),
    ).toEqual({ ok: true });
    const afterB = repo.estimateLogicalBytes();
    expect(
      repo.writeEventTransaction({
        event: evC,
        items: [makeItem()],
        identity: identity(evC.ruleId),
      }),
    ).toEqual({ ok: true });
    const afterC = repo.estimateLogicalBytes();
    // evA 已读；evB/evC 未读。预算设为「只差 evA 边际」→ 只允许删 evA
    // （读优先 + 最旧），证明清理顺序而不是任意删除。
    repo.markEventsRead([evA.id], new Date(base).toISOString());
    const afterMark = repo.estimateLogicalBytes();
    const tight = new WatchRepository(handle, { maxDbBytes: afterMark - 1 });
    const pruned = tight.pruneEventsToDbBudget(new Date(base).toISOString());
    expect(pruned.deleted).toBe(1);
    expect(repo.getEvent(evA.id)).toBeNull();
    expect(repo.getEvent(evB.id)).not.toBeNull();
    expect(repo.getEvent(evC.id)).not.toBeNull();
    void afterA;
    void afterB;
    void afterC;
  });

  it('Digest ref 在 Event 清理后 → expired（tombstone）', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const ancient = makeEvent(rule.id, {
      firstObservedAt: '2026-01-01T00:00:00.000Z',
      lastObservedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(
      repo.writeEventTransaction({
        event: ancient,
        items: [makeItem()],
        identity: identity(ancient.ruleId),
      }),
    ).toEqual({
      ok: true,
    });
    insertDigestRefFixture(ancient.id);
    repo.pruneEventsByRuleLimits(NOW);
    expect(repo.listDigestEventRefs()).toEqual([
      { digestId: 'd1', eventId: ancient.id, status: 'expired' },
    ]);
  });

  it('session 规则 30天/100 边界', () => {
    const rule = makeRule({
      kind: 'page',
      accessMode: 'session',
      target: {
        type: 'page',
        pageUrl: 'https://example.com/doc',
        regions: [{ kind: 'main-text', label: '正文' }],
        sessionConsent: { version: 1, origin: 'https://example.com', grantedAt: NOW },
      },
    });
    repo.insertRule(rule);
    const base = Date.parse('2026-08-28T00:00:00.000Z');
    const day31 = new Date(base - 31 * 24 * 60 * 60 * 1000).toISOString();
    const day30 = new Date(base - 30 * 24 * 60 * 60 * 1000 + 60_000).toISOString();
    const old = makeEvent(rule.id, { firstObservedAt: day31, lastObservedAt: day31 });
    const edge = makeEvent(rule.id, { firstObservedAt: day30, lastObservedAt: day30 });
    for (const event of [old, edge]) {
      expect(
        repo.writeEventTransaction({
          event,
          items: [makeItem()],
          identity: identity(event.ruleId),
        }),
      ).toEqual({ ok: true });
    }
    repo.pruneEventsByRuleLimits(new Date(base).toISOString());
    expect(repo.getEvent(old.id)).toBeNull();
    expect(repo.getEvent(edge.id)).not.toBeNull();
  });
});

describe('审计与诊断', () => {
  it('insertAudit/listAudits 闭合码恒等', () => {
    repo.insertAudit({
      id: 'a1',
      ruleId: null,
      kind: 'reconciliation',
      reasonCode: 'complete',
      createdAt: NOW,
    });
    const audits = repo.listAudits();
    expect(audits).toEqual([
      { id: 'a1', ruleId: null, kind: 'reconciliation', reasonCode: 'complete', createdAt: NOW },
    ]);
  });
});

describe('D4-R 回归：fail-closed 查询 / 身份 CAS / 字节预算 / audit 白名单', () => {
  describe('R1 查询与行校验必须严格 fail-closed（不得降级空结果）', () => {
    it('listRulesBySource SQL 异常必须抛出', () => {
      const rule = makeRule();
      repo.insertRule(rule);
      handle.prepare('DROP TABLE watch_rules').run();
      expect(() => repo.listRulesBySource('src-1')).toThrow(WatchRepositoryError);
    });

    it('listRules 读回非法行必须抛出（不得静默跳过）', () => {
      const rule = makeRule();
      repo.insertRule(rule);
      handle.prepare("UPDATE watch_rules SET schedule_json = 'not-json'").run();
      expect(() => repo.listRules()).toThrow(WatchRepositoryError);
    });

    it('getRule 读回非法行必须抛出（不得降级 null）', () => {
      const rule = makeRule();
      repo.insertRule(rule);
      handle.prepare("UPDATE watch_rules SET schedule_json = 'not-json' WHERE id = ?").run(rule.id);
      expect(() => repo.getRule(rule.id)).toThrow(WatchRepositoryError);
    });

    it('intent 读回非法行必须抛出（get/list/pending 同根因）', () => {
      repo.insertSourceCleanupIntent({
        mutationId: 'm1',
        sourceId: 's1',
        operation: 'update',
        beforeProjection: null,
        afterProjection: null,
        affectedRuleState: {},
        state: 'prepared',
        createdAt: NOW,
        updatedAt: NOW,
      });
      handle
        .prepare("UPDATE source_cleanup_intents SET affected_rule_state_json = 'not-json'")
        .run();
      expect(() => repo.getSourceCleanupIntent('m1')).toThrow(WatchRepositoryError);
      expect(() => repo.listSourceCleanupIntents()).toThrow(WatchRepositoryError);
      expect(() => repo.listPendingSourceCleanupIntents()).toThrow(WatchRepositoryError);
    });

    it('合法空结果与 not-found 保持空/ null（不误报）', () => {
      expect(repo.listRulesBySource('none')).toEqual([]);
      expect(repo.getRule('ghost')).toBeNull();
      expect(repo.getSourceCleanupIntent('ghost')).toBeNull();
      expect(repo.listPendingSourceCleanupIntents()).toEqual([]);
    });
  });

  describe('R5 Event 单事务完整身份 CAS', () => {
    function eventTx(rule: WatchRule, overrides: Record<string, unknown> = {}) {
      return {
        event: makeEvent(rule.id),
        items: [makeItem()],
        identity: identity(rule.id),
        baseline: {
          expectedBaselineVersion: null,
          projectionType: 'feed' as const,
          projectionJson: '{}',
          contentHash: 'h',
          byteLength: 2,
          finalUrl: 'https://example.com',
          capturedAt: NOW,
          documentId: null,
        },
        ...overrides,
      };
    }

    it('三者匹配 → 全部落库', () => {
      const rule = makeRule();
      repo.insertRule(rule);
      const result = repo.writeEventTransaction(eventTx(rule));
      expect(result).toEqual({ ok: true });
      expect(count('watch_events')).toBe(1);
      expect(repo.getBaseline(rule.id)!.version).toBe(1);
    });

    it('sourceId 不匹配 → 零写入（event/items/baseline/outbox/audit 全无）', () => {
      const rule = makeRule();
      repo.insertRule(rule);
      const input = eventTx(rule, {
        identity: {
          sourceId: 'other-source',
          expectedSourceLocatorFingerprint: FINGERPRINT,
          expectedBaselineVersion: null,
        },
      });
      const result = repo.writeEventTransaction(input);
      expect(result.ok).toBe(false);
      expect(count('watch_events')).toBe(0);
      expect(count('watch_event_items')).toBe(0);
      expect(repo.getBaseline(rule.id)).toBeNull();
      expect(count('watch_audits')).toBe(0);
    });

    it('fingerprint 陈旧 → 零写入', () => {
      const rule = makeRule();
      repo.insertRule(rule);
      const stale = identity(rule.id);
      stale.expectedSourceLocatorFingerprint = 'f'.repeat(64);
      expect(repo.writeEventTransaction(eventTx(rule, { identity: stale })).ok).toBe(false);
      expect(count('watch_events')).toBe(0);
      expect(repo.getBaseline(rule.id)).toBeNull();
    });

    it('baselineVersion 陈旧 → 零写入', () => {
      const rule = makeRule();
      repo.insertRule(rule);
      repo.writeBaseline({
        ruleId: rule.id,
        expectedBaselineVersion: null,
        projectionType: 'feed',
        projectionJson: '{}',
        contentHash: 'h',
        byteLength: 2,
        finalUrl: 'https://example.com',
        capturedAt: NOW,
        documentId: null,
      });
      const stale = identity(rule.id, 0); // 实际已是 1
      const result = repo.writeEventTransaction(eventTx(rule, { identity: stale }));
      expect(result).toEqual({ ok: false, code: 'baseline-conflict' });
      expect(count('watch_events')).toBe(0);
      expect(repo.getBaseline(rule.id)!.version).toBe(1);
    });

    it('规则已删除 → 拒绝零写入', () => {
      const rule = makeRule();
      repo.insertRule(rule);
      handle.prepare("UPDATE watch_rules SET state = 'deleted', pause_reason = 'user'").run();
      const result = repo.writeEventTransaction(eventTx(rule));
      expect(result.ok).toBe(false);
      expect(count('watch_events')).toBe(0);
    });

    it('事务内 audits 写入失败 → 整体回滚零半数据', () => {
      const rule = makeRule();
      repo.insertRule(rule);
      handle.prepare('DROP TABLE watch_audits').run();
      const input = eventTx(rule, {
        audits: [
          {
            id: 'a1',
            ruleId: rule.id,
            kind: 'baseline-established',
            reasonCode: 'baseline-established',
            createdAt: NOW,
          },
        ],
      });
      const result = repo.writeEventTransaction(input);
      expect(result.ok).toBe(false);
      expect(count('watch_events')).toBe(0);
      expect(count('watch_event_items')).toBe(0);
      expect(repo.getBaseline(rule.id)).toBeNull();
    });
  });

  describe('R6 Baseline 投影真实字节预算', () => {
    it('多字节 UTF-8：实际字节与声明一致才接受', () => {
      const rule = makeRule();
      repo.insertRule(rule);
      const json = '{"x":"' + '汉'.repeat(10) + '"}';
      const actual = Buffer.byteLength(json, 'utf8');
      const ok = repo.writeBaseline({
        ruleId: rule.id,
        expectedBaselineVersion: null,
        projectionType: 'feed',
        projectionJson: json,
        contentHash: 'h',
        byteLength: actual,
        finalUrl: 'https://example.com',
        capturedAt: NOW,
        documentId: null,
      });
      expect(ok).toEqual({ ok: true });
      expect(repo.getBaseline(rule.id)!.byteLength).toBe(actual);
    });

    it('伪造较小 byteLength → 写入前拒绝（validation-failed）', () => {
      const rule = makeRule();
      repo.insertRule(rule);
      const json = '{"x":"' + '汉'.repeat(10) + '"}';
      const actual = Buffer.byteLength(json, 'utf8');
      const forged = repo.writeBaseline({
        ruleId: rule.id,
        expectedBaselineVersion: null,
        projectionType: 'feed',
        projectionJson: json,
        contentHash: 'h',
        byteLength: actual - 1,
        finalUrl: 'https://example.com',
        capturedAt: NOW,
        documentId: null,
      });
      expect(forged).toEqual({ ok: false, code: 'validation-failed' });
      expect(repo.getBaseline(rule.id)).toBeNull();
    });

    it('实际字节超单对象上限 → baseline-budget-exceeded', () => {
      const rule = makeRule();
      repo.insertRule(rule);
      const over = '{"x":"' + 'a'.repeat(65540) + '"}';
      const result = repo.writeBaseline({
        ruleId: rule.id,
        expectedBaselineVersion: null,
        projectionType: 'feed',
        projectionJson: over,
        contentHash: 'h',
        byteLength: Buffer.byteLength(over, 'utf8'),
        finalUrl: 'https://example.com',
        capturedAt: NOW,
        documentId: null,
      });
      expect(result).toEqual({ ok: false, code: 'baseline-budget-exceeded' });
    });

    it('writeBaseline 规则级 CAS：deleted 规则拒绝、fingerprint 参数匹配才接受', () => {
      const rule = makeRule();
      repo.insertRule(rule);
      expect(
        repo.writeBaseline({
          ruleId: rule.id,
          expectedBaselineVersion: null,
          expectedSourceLocatorFingerprint: 'f'.repeat(64),
          projectionType: 'feed',
          projectionJson: '{}',
          contentHash: 'h',
          byteLength: 2,
          finalUrl: 'https://example.com',
          capturedAt: NOW,
          documentId: null,
        }),
      ).toEqual({ ok: false, code: 'identity-conflict' });
      handle.prepare("UPDATE watch_rules SET state = 'deleted', pause_reason = 'user'").run();
      expect(
        repo.writeBaseline({
          ruleId: rule.id,
          expectedBaselineVersion: null,
          projectionType: 'feed',
          projectionJson: '{}',
          contentHash: 'h',
          byteLength: 2,
          finalUrl: 'https://example.com',
          capturedAt: NOW,
          documentId: null,
        }),
      ).toEqual({ ok: false, code: 'identity-conflict' });
    });
  });

  describe('R7 audit kind/reason 白名单', () => {
    it('baseline-established 与 rebaseline 可写', () => {
      expect(
        repo.insertAudit({
          id: 'a1',
          ruleId: null,
          kind: 'baseline-established',
          reasonCode: 'baseline-established',
          createdAt: NOW,
        }),
      ).toEqual({ ok: true });
      expect(
        repo.insertAudit({
          id: 'a2',
          ruleId: null,
          kind: 'rebaseline',
          reasonCode: 'rebaseline',
          createdAt: NOW,
        }),
      ).toEqual({ ok: true });
    });

    it('非白名单 kind/reason 被拒绝', () => {
      expect(
        repo.insertAudit({
          id: 'a3',
          ruleId: null,
          kind: 'other' as never,
          reasonCode: 'complete',
          createdAt: NOW,
        }),
      ).toEqual({ ok: false, code: 'validation-failed' });
      expect(
        repo.insertAudit({
          id: 'a4',
          ruleId: null,
          kind: 'reconciliation',
          reasonCode: 'other' as never,
          createdAt: NOW,
        }),
      ).toEqual({ ok: false, code: 'validation-failed' });
    });
  });
});

// 真实临时目录清理（文件级 afterAll）
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// D7 Repair oracle：Run metadata 同 CAS 持久化 / 终态 dedup 重入零写 /
// scanIntegrity observation 关系矩阵 / 预算包含 observations 与 v3 新列
// ---------------------------------------------------------------------------

function metaJson(http: unknown = null): string {
  return JSON.stringify({ schemaVersion: 1, http, conditionWarnings: [] });
}

function makeWriteResultCreateInput(rule: WatchRule, runId: string, metadata: string) {
  return {
    path: 'create' as const,
    rule,
    runId,
    sourceAfterRevalidationRowVersion: 1,
    identity: {
      sourceId: 'src-1',
      sourceLocatorFingerprint: FINGERPRINT,
      expectedBaselineVersion: null,
    },
    baseline: {
      projectionType: 'feed' as const,
      projectionJson: '{}',
      contentHash: 'h',
      byteLength: 2,
      finalUrl: 'https://example.com',
      capturedAt: NOW,
      documentId: null,
      validators: { etag: null, lastModified: null },
    },
    event: {
      event: makeEvent(rule.id, { itemCount: 1 }),
      items: [makeItem()],
      outbox: [] as Array<{ id: string; dedupeKey: string; privacyJson: string }>,
    },
    run: {
      expectedStatus: 'running' as const,
      outcome: { kind: 'event-created', eventId: 'e1' } as const,
      health: { state: 'healthy' as const, acquisition: 'rss' as const, code: null },
      responseMetadataJson: metadata,
    },
    audits: [{ id: randomUUID(), reasonCode: 'event-created' as const, createdAt: NOW }],
  };
}

describe('D7 Repair：Run metadata 同 CAS UPDATE + 终态 dedup 重入零写', () => {
  it('create 成功终态：response_metadata_json 随终态 CAS UPDATE 精确持久化', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    repo.insertRun({
      id: 'run-meta',
      ruleId: rule.id,
      requestKey: 'k-meta',
      trigger: 'scheduled',
      scheduledFor: null,
    });
    repo.transitionRun('run-meta', 'queued', { status: 'running' });
    const meta = metaJson({ httpStatus: 200, etag: '"v1"', lastModified: null, warnings: [] });
    const result = repo.writeEventResult(makeWriteResultCreateInput(rule, 'run-meta', meta));
    expect(result).toEqual({ ok: true });
    const run = repo.getRun('run-meta')!;
    expect(run.status).toBe('finished');
    // metadata 必须精确持久化（不得被终态 transitionRun 覆盖为 null）
    expect(run.responseMetadataJson).toBe(meta);
  });

  it('终态 dedup 重入：返回 ok 前 Run/Rule/audit/metadata 全行零变化', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    repo.insertRun({
      id: 'run-first',
      ruleId: rule.id,
      requestKey: 'k-first',
      trigger: 'scheduled',
      scheduledFor: null,
    });
    repo.transitionRun('run-first', 'queued', { status: 'running' });
    const event = makeEvent(rule.id, { itemCount: 1 });
    const meta = metaJson();
    const first = repo.writeEventResult({
      path: 'create',
      rule,
      runId: 'run-first',
      sourceAfterRevalidationRowVersion: 1,
      identity: {
        sourceId: 'src-1',
        sourceLocatorFingerprint: FINGERPRINT,
        expectedBaselineVersion: null,
      },
      baseline: {
        projectionType: 'feed',
        projectionJson: '{}',
        contentHash: 'h',
        byteLength: 2,
        finalUrl: 'https://example.com',
        capturedAt: NOW,
        documentId: null,
        validators: { etag: null, lastModified: null },
      },
      event: { event, items: [makeItem()], outbox: [] },
      run: {
        expectedStatus: 'running',
        outcome: { kind: 'event-created', eventId: event.id },
        health: { state: 'healthy', acquisition: 'rss', code: null },
        responseMetadataJson: meta,
      },
      audits: [{ id: randomUUID(), reasonCode: 'event-created', createdAt: NOW }],
    });
    expect(first).toEqual({ ok: true });
    // 重入 run 已终态（finished）。R3-2 后 transitionRun 新写 finished 必须携带
    // canonical metadata；此处以直接 SQL 注入「既有 v2-era legacy 终态行」（null
    // metadata 只读兼容形态），验证已终态 dedup 重入零写且不重写 metadata。
    repo.insertRun({
      id: 'run-replay',
      ruleId: rule.id,
      requestKey: 'k-replay',
      trigger: 'scheduled',
      scheduledFor: null,
    });
    handle
      .prepare("UPDATE watch_runs SET status = 'finished', finished_at = ? WHERE id = ?")
      .run(NOW, 'run-replay');
    const beforeAudits = count('watch_audits');
    const beforeRule = repo.getRule(rule.id)!;
    const replay = repo.writeEventResult({
      path: 'dedup',
      rule,
      runId: 'run-replay',
      sourceAfterRevalidationRowVersion: 1,
      identity: {
        sourceId: 'src-1',
        sourceLocatorFingerprint: FINGERPRINT,
        expectedBaselineVersion: 0,
      },
      dedupIdempotencyKey: event.idempotencyKey,
      run: {
        expectedStatus: 'running',
        outcome: { kind: 'event-deduplicated', eventId: event.id },
        health: { state: 'healthy', acquisition: 'rss', code: null },
        responseMetadataJson: meta,
      },
      audits: [{ id: randomUUID(), reasonCode: 'event-deduplicated', createdAt: NOW }],
    });
    expect(replay).toEqual({ ok: true });
    // 已终态重入：零写 —— run 行、rule 行、audit 计数全部不变
    const replayRun = repo.getRun('run-replay')!;
    expect(replayRun.status).toBe('finished');
    expect(replayRun.responseMetadataJson).toBeNull(); // 不得被 metadata UPDATE 改写
    expect(count('watch_audits')).toBe(beforeAudits);
    const afterRule = repo.getRule(rule.id)!;
    expect(afterRule.updatedAt).toBe(beforeRule.updatedAt);
    expect(afterRule.sourceRowVersion).toBe(beforeRule.sourceRowVersion);
  });
});

describe('D7 Repair：scanIntegrity observation 关系不变量', () => {
  function seedEventWithObservation(): { rule: WatchRule; event: WatchEvent } {
    const rule = makeRule();
    repo.insertRule(rule);
    const event = makeEvent(rule.id, { itemCount: 1 });
    const result = repo.writeEventTransaction({
      event,
      items: [makeItem()],
      identity: identity(rule.id),
    });
    expect(result).toEqual({ ok: true });
    return { rule, event };
  }

  it('正常数据 scanIntegrity ok', () => {
    seedEventWithObservation();
    expect(repo.scanIntegrity()).toEqual({ ok: true, reason: null });
  });

  it('Event 缺 observation → fail-closed', () => {
    const { event } = seedEventWithObservation();
    handle.prepare('DELETE FROM watch_event_observations WHERE event_id = ?').run(event.id);
    expect(repo.scanIntegrity().ok).toBe(false);
  });

  it('observation.item_count 与 items 实际数不一致 → fail-closed', () => {
    const { event } = seedEventWithObservation();
    handle
      .prepare('UPDATE watch_event_observations SET item_count = 2 WHERE event_id = ?')
      .run(event.id);
    expect(repo.scanIntegrity().ok).toBe(false);
  });

  it('Event.item_count 与 Σ observation.item_count 不一致 → fail-closed', () => {
    const { event } = seedEventWithObservation();
    handle.prepare('UPDATE watch_events SET item_count = 2 WHERE id = ?').run(event.id);
    expect(repo.scanIntegrity().ok).toBe(false);
  });

  it('observation sequence 从 0 连续（缺口）→ fail-closed', () => {
    const { rule, event } = seedEventWithObservation();
    // 把唯一 observation 的 sequence 改成 2（0→2 缺口），不触发 UNIQUE 冲突
    handle
      .prepare('UPDATE watch_event_observations SET sequence = 2 WHERE event_id = ?')
      .run(event.id);
    void rule;
    expect(repo.scanIntegrity().ok).toBe(false);
  });

  it('observation first_item_sequence/item_count 未精确覆盖 item 范围 → fail-closed', () => {
    const { event } = seedEventWithObservation();
    handle
      .prepare('UPDATE watch_event_observations SET first_item_sequence = 1 WHERE event_id = ?')
      .run(event.id);
    expect(repo.scanIntegrity().ok).toBe(false);
  });

  it('item 的 observation_id 与 observation 不一致（跨观察）→ fail-closed', () => {
    const { rule, event } = seedEventWithObservation();
    handle
      .prepare(
        `INSERT INTO watch_event_observations (id, event_id, sequence, idempotency_key,
         change_fingerprint, event_kind, observed_at, first_item_sequence, item_count)
         VALUES ('obs-b', ?, 1, 'ik-b', 'fp', 'added', ?, 1, 1)`,
      )
      .run(event.id, NOW);
    handle
      .prepare('UPDATE watch_event_items SET observation_id = ? WHERE event_id = ?')
      .run('obs-b', event.id);
    void rule;
    expect(repo.scanIntegrity().ok).toBe(false);
  });

  it('observation_item_sequence 缺口 → fail-closed', () => {
    const { event } = seedEventWithObservation();
    handle
      .prepare('UPDATE watch_event_items SET observation_item_sequence = 5 WHERE event_id = ?')
      .run(event.id);
    expect(repo.scanIntegrity().ok).toBe(false);
  });

  it('sequence=0 observation 与 Event 首 idempotency/fingerprint 兼容列不一致 → fail-closed', () => {
    const { rule, event } = seedEventWithObservation();
    handle
      .prepare(
        'UPDATE watch_event_observations SET idempotency_key = ? WHERE event_id = ? AND sequence = 0',
      )
      .run('ik-tampered', event.id);
    void rule;
    expect(repo.scanIntegrity().ok).toBe(false);
  });

  it('R2-4 孤儿 observation（不属于任何 Event）→ fail-closed', () => {
    const { event } = seedEventWithObservation();
    // FK=OFF 连接注入孤儿 observation（事件不存在）；注入后恢复 FK 再扫描
    handle.exec('PRAGMA foreign_keys = OFF');
    handle
      .prepare(
        `INSERT INTO watch_event_observations (id, event_id, sequence, idempotency_key,
         change_fingerprint, event_kind, observed_at, first_item_sequence, item_count)
         VALUES ('orphan-obs', 'no-such-event', 0, 'ik-orphan', 'fp-orphan', 'added', ?, 0, 1)`,
      )
      .run(NOW);
    handle.exec('PRAGMA foreign_keys = ON');
    void event;
    expect(repo.scanIntegrity().ok).toBe(false);
  });

  it('R2-4 孤儿 item（observation_id 悬空）→ fail-closed', () => {
    const { event } = seedEventWithObservation();
    handle.exec('PRAGMA foreign_keys = OFF');
    handle
      .prepare(
        `INSERT INTO watch_event_items (id, event_id, sequence, observation_id,
         observation_item_sequence, item_id, field_key, label,
         before_value_json, after_value_json, before_captured_at, after_captured_at,
         before_final_url, after_final_url)
         VALUES ('orphan-item', ?, 5, 'no-such-obs', 0, 'itx', 'title', '标题',
          '{"kind":"absent"}', '{"kind":"absent"}', ?, ?, 'https://example.com', 'https://example.com')`,
      )
      .run(event.id, NOW, NOW);
    handle.exec('PRAGMA foreign_keys = ON');
    expect(repo.scanIntegrity().ok).toBe(false);
  });

  it('R2-4 跨 Event 关系（item.event_id 与 observation 所属 Event 不一致）→ fail-closed', () => {
    const { rule, event: firstEvent } = seedEventWithObservation();
    const secondEvent = makeEvent(rule.id, { itemCount: 1 });
    handle.exec('PRAGMA foreign_keys = OFF');
    handle
      .prepare(
        `INSERT INTO watch_events (id, rule_id, source_id, event_kind, importance,
         idempotency_key, change_fingerprint, first_observed_at, last_observed_at, item_count)
         VALUES (?, ?, 'src-1', 'added', 'normal', ?, 'fp2', ?, ?, 1)`,
      )
      .run(secondEvent.id, rule.id, secondEvent.idempotencyKey, NOW, NOW);
    handle
      .prepare(
        `INSERT INTO watch_event_observations (id, event_id, sequence, idempotency_key,
         change_fingerprint, event_kind, observed_at, first_item_sequence, item_count)
         VALUES ('obs-b', ?, 0, ?, 'fp2', 'added', ?, 0, 1)`,
      )
      .run(secondEvent.id, secondEvent.idempotencyKey, NOW);
    // item.event_id=secondEvent，但 observation_id 指向第一个 Event 的 observation
    //（跨 Event 错配；observation_item_sequence 取 5 避免与第一个 observation 的
    // UNIQUE(observation_id, observation_item_sequence) 冲突）
    const firstObs = handle
      .prepare('SELECT id FROM watch_event_observations WHERE event_id = ? LIMIT 1')
      .get(firstEvent.id) as { id: string };
    handle
      .prepare(
        `INSERT INTO watch_event_items (id, event_id, sequence, observation_id,
         observation_item_sequence, item_id, field_key, label,
         before_value_json, after_value_json, before_captured_at, after_captured_at,
         before_final_url, after_final_url)
         VALUES ('cross-item', ?, 0, ?, 5, 'itx', 'title', '标题',
          '{"kind":"absent"}', '{"kind":"absent"}', ?, ?, 'https://example.com', 'https://example.com')`,
      )
      .run(secondEvent.id, firstObs.id, NOW, NOW);
    handle.exec('PRAGMA foreign_keys = ON');
    expect(repo.scanIntegrity().ok).toBe(false);
  });
});

describe('D7 Repair：100 MiB 预算包含 observations 与 v3 新列', () => {
  it('estimateLogicalBytes 随 observation 行数增长', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const event = makeEvent(rule.id, { itemCount: 1 });
    expect(
      repo.writeEventTransaction({ event, items: [makeItem()], identity: identity(rule.id) }),
    ).toEqual({ ok: true });
    const afterEvent = repo.estimateLogicalBytes();
    // 追加第二条 observation（同一事件）——v3 观察表字节必须计入估算
    handle
      .prepare(
        `INSERT INTO watch_event_observations (id, event_id, sequence, idempotency_key,
         change_fingerprint, event_kind, observed_at, first_item_sequence, item_count)
         VALUES ('obs-2', ?, 1, 'ik-2', 'fp', 'added', ?, 1, 1)`,
      )
      .run(event.id, NOW);
    const afterSecondObs = repo.estimateLogicalBytes();
    expect(afterSecondObs).toBeGreaterThan(afterEvent);
  });

  it('writeEventResult create：observation/run metadata/outbox/audit 写集计入预算', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    repo.insertRun({
      id: 'run-budget',
      ruleId: rule.id,
      requestKey: 'k-budget',
      trigger: 'scheduled',
      scheduledFor: null,
    });
    repo.transitionRun('run-budget', 'queued', { status: 'running' });
    const meta = metaJson({ httpStatus: 200, etag: '"v1"', lastModified: null, warnings: [] });
    const input = makeWriteResultCreateInput(rule, 'run-budget', meta);
    input.event.outbox = [
      {
        id: randomUUID(),
        dedupeKey: 'dk-1',
        privacyJson: '{"eventKind":"added","importance":"normal","itemCount":1}',
      },
    ];
    // 预算设为「仅当前库 + items」不足以覆盖 observation/outbox/audit/metadata 写集
    const tight = new WatchRepository(handle, { maxDbBytes: repo.estimateLogicalBytes() + 60 });
    const result = tight.writeEventResult(input);
    // 完整写集超出预算 → 拒绝（低估不得绕过 maxDbBytes）
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R2-1 Repository 新写 metadata 敌手矩阵 + 4096 ==/+1 字节边界
// ---------------------------------------------------------------------------

describe('R2-1 Repository 新写 metadata 敌手矩阵（#S6-058）', () => {
  function createWrite(rule: WatchRule, runId: string, metadata: string | null) {
    const base = makeWriteResultCreateInput(rule, runId, metadata ?? '');
    if (metadata === null) {
      (base.run as { responseMetadataJson: string | null }).responseMetadataJson = null;
    }
    return base;
  }

  function seedRunning(rule: WatchRule, runId: string, key: string) {
    repo.insertRule(rule);
    repo.insertRun({
      id: runId,
      ruleId: rule.id,
      requestKey: key,
      trigger: 'scheduled',
      scheduledFor: null,
    });
    repo.transitionRun(runId, 'queued', { status: 'running' });
  }

  it('null / 非 JSON → validation-failed 零写', () => {
    const rule = makeRule();
    const runId = 'rm-hostile';
    seedRunning(rule, runId, 'k-hostile');
    expect(repo.writeEventResult(createWrite(rule, runId, null))).toEqual({
      ok: false,
      code: 'validation-failed',
    });
    expect(repo.writeEventResult(createWrite(rule, runId, 'not-json'))).toEqual({
      ok: false,
      code: 'validation-failed',
    });
    expect(repo.getRun(runId)!.status).toBe('running'); // 零写
    expect(count('watch_events')).toBe(0);
  });

  it('额外/缺失 key 拒绝', () => {
    const rule = makeRule();
    const runId = 'rm-keys';
    seedRunning(rule, runId, 'k-keys');
    const extra = '{"schemaVersion":1,"http":null,"conditionWarnings":[],"x":1}';
    const missing = '{"schemaVersion":1,"http":null}';
    expect(repo.writeEventResult(createWrite(rule, runId, extra))).toEqual({
      ok: false,
      code: 'validation-failed',
    });
    expect(repo.writeEventResult(createWrite(rule, runId, missing))).toEqual({
      ok: false,
      code: 'validation-failed',
    });
    expect(count('watch_events')).toBe(0);
  });

  it('未来 schemaVersion 拒绝', () => {
    const rule = makeRule();
    const runId = 'rm-future';
    seedRunning(rule, runId, 'k-future');
    const future = '{"schemaVersion":2,"http":null,"conditionWarnings":[]}';
    expect(repo.writeEventResult(createWrite(rule, runId, future))).toEqual({
      ok: false,
      code: 'validation-failed',
    });
    expect(count('watch_events')).toBe(0);
  });

  it('非 canonical key order 拒绝', () => {
    const rule = makeRule();
    const runId = 'rm-order';
    seedRunning(rule, runId, 'k-order');
    const reordered = '{"http":null,"schemaVersion":1,"conditionWarnings":[]}';
    expect(repo.writeEventResult(createWrite(rule, runId, reordered))).toEqual({
      ok: false,
      code: 'validation-failed',
    });
    expect(count('watch_events')).toBe(0);
  });

  it('非法 httpStatus/类型 拒绝', () => {
    const rule = makeRule();
    const runId = 'rm-http';
    seedRunning(rule, runId, 'k-http');
    const badStatus =
      '{"schemaVersion":1,"http":{"httpStatus":201,"etag":null,"lastModified":null,"warnings":[]},"conditionWarnings":[]}';
    const badType = '{"schemaVersion":1,"http":"oops","conditionWarnings":[]}';
    expect(repo.writeEventResult(createWrite(rule, runId, badStatus))).toEqual({
      ok: false,
      code: 'validation-failed',
    });
    expect(repo.writeEventResult(createWrite(rule, runId, badType))).toEqual({
      ok: false,
      code: 'validation-failed',
    });
    expect(count('watch_events')).toBe(0);
  });

  it('非法/乱序/重复 warning 拒绝（http.warnings 与 conditionWarnings）', () => {
    const rule = makeRule();
    const runId = 'rm-warn';
    seedRunning(rule, runId, 'k-warn');
    const badHttpWarn =
      '{"schemaVersion":1,"http":{"httpStatus":200,"etag":null,"lastModified":null,"warnings":["last-modified-oversize","etag-oversize"]},"conditionWarnings":[]}';
    const dupHttpWarn =
      '{"schemaVersion":1,"http":{"httpStatus":200,"etag":null,"lastModified":null,"warnings":["etag-oversize","etag-oversize"]},"conditionWarnings":[]}';
    const unknownWarn =
      '{"schemaVersion":1,"http":{"httpStatus":200,"etag":null,"lastModified":null,"warnings":["nope"]},"conditionWarnings":[]}';
    const badCondWarn =
      '{"schemaVersion":1,"http":null,"conditionWarnings":["operator-not-applicable","field-absent"]}';
    for (const meta of [badHttpWarn, dupHttpWarn, unknownWarn, badCondWarn]) {
      expect(repo.writeEventResult(createWrite(rule, runId, meta))).toEqual({
        ok: false,
        code: 'validation-failed',
      });
    }
    expect(count('watch_events')).toBe(0);
  });

  it('etag 单字段边界：1024 字节写入成功、1025 拒绝（不用大 etag 证明整体 4096）', () => {
    const base = {
      schemaVersion: 1,
      http: { httpStatus: 200, etag: '', lastModified: null, warnings: [] },
      conditionWarnings: [] as string[],
    };
    const at1024 = JSON.stringify({ ...base, http: { ...base.http, etag: 'a'.repeat(1024) } });
    const rule = makeRule();
    const runIdOk = 'rm-field-ok';
    seedRunning(rule, runIdOk, 'k-field-ok');
    expect(repo.writeEventResult(createWrite(rule, runIdOk, at1024))).toEqual({ ok: true });
    const rule2 = makeRule();
    const runIdOver = 'rm-field-over';
    seedRunning(rule2, runIdOver, 'k-field-over');
    const at1025 = JSON.stringify({ ...base, http: { ...base.http, etag: 'a'.repeat(1025) } });
    const eventsBeforeOver = count('watch_events');
    expect(repo.writeEventResult(createWrite(rule2, runIdOver, at1025))).toEqual({
      ok: false,
      code: 'validation-failed',
    });
    expect(repo.getRun(runIdOver)!.status).toBe('running'); // 零写
    expect(count('watch_events')).toBe(eventsBeforeOver);
  });

  it('lastModified 单字段边界：1024 字节写入成功、1025 拒绝', () => {
    const base = {
      schemaVersion: 1,
      http: { httpStatus: 200, etag: null, lastModified: '', warnings: [] },
      conditionWarnings: [] as string[],
    };
    const at1024 = JSON.stringify({
      ...base,
      http: { ...base.http, lastModified: 'a'.repeat(1024) },
    });
    const rule = makeRule();
    const runIdOk = 'rm-lm-ok';
    seedRunning(rule, runIdOk, 'k-lm-ok');
    expect(repo.writeEventResult(createWrite(rule, runIdOk, at1024))).toEqual({ ok: true });
    const rule2 = makeRule();
    const runIdOver = 'rm-lm-over';
    seedRunning(rule2, runIdOver, 'k-lm-over');
    const at1025 = JSON.stringify({
      ...base,
      http: { ...base.http, lastModified: 'a'.repeat(1025) },
    });
    const eventsBeforeOver = count('watch_events');
    expect(repo.writeEventResult(createWrite(rule2, runIdOver, at1025))).toEqual({
      ok: false,
      code: 'validation-failed',
    });
    expect(count('watch_events')).toBe(eventsBeforeOver);
  });

  it('总体 >4096 字节拒绝（整体预算）', () => {
    const over = JSON.stringify({
      schemaVersion: 1,
      http: { httpStatus: 200, etag: 'a'.repeat(4096), lastModified: null, warnings: [] },
      conditionWarnings: [],
    });
    expect(Buffer.byteLength(over, 'utf8')).toBeGreaterThan(4096);
    const rule = makeRule();
    const runIdOver = 'rm-total-over';
    seedRunning(rule, runIdOver, 'k-total-over');
    expect(repo.writeEventResult(createWrite(rule, runIdOver, over))).toEqual({
      ok: false,
      code: 'validation-failed',
    });
    expect(count('watch_events')).toBe(0);
  });

  it('whitespace / 非 canonical 编码写入拒绝', () => {
    const rule = makeRule();
    const runId = 'rm-whitespace';
    seedRunning(rule, runId, 'k-whitespace');
    const withSpace = '{"schemaVersion":1, "http":null, "conditionWarnings":[]}';
    expect(repo.writeEventResult(createWrite(rule, runId, withSpace))).toEqual({
      ok: false,
      code: 'validation-failed',
    });
    expect(repo.getRun(runId)!.status).toBe('running'); // 零写
  });

  it('transitionRun 直接写非法 metadata → validation-failed（新写边界拒绝）', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    repo.insertRun({
      id: 'run-tx',
      ruleId: rule.id,
      requestKey: 'k-tx',
      trigger: 'manual',
      scheduledFor: null,
    });
    expect(
      repo.transitionRun('run-tx', 'queued', {
        status: 'finished',
        finishedAt: NOW,
        outcome: { kind: 'unchanged' },
        health: { state: 'healthy', acquisition: 'rss', code: null },
        responseMetadataJson: '{"schemaVersion":2,"http":null,"conditionWarnings":[]}',
      }),
    ).toEqual({ ok: false, code: 'validation-failed' });
    expect(repo.getRun('run-tx')!.status).toBe('queued'); // 零写
  });

  it('finalizeRun 写非法 metadata → validation-failed', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    repo.insertRun({
      id: 'run-fin',
      ruleId: rule.id,
      requestKey: 'k-fin',
      trigger: 'manual',
      scheduledFor: null,
    });
    repo.transitionRun('run-fin', 'queued', { status: 'running', startedAt: NOW });
    expect(
      repo.finalizeRun({
        runId: 'run-fin',
        ruleId: rule.id,
        outcome: { kind: 'failed', health: 'parse_changed', retryable: false },
        health: { state: 'degraded', acquisition: 'rss', code: 'parse_changed' },
        consecutiveFailures: 1,
        backoffUntil: null,
        responseMetadataJson: 'not-json',
        runAudit: { id: randomUUID(), reasonCode: 'parse-changed', createdAt: NOW },
      }),
    ).toEqual({ ok: false, code: 'validation-failed' });
    expect(repo.getRun('run-fin')!.status).toBe('running'); // 零写
  });

  it('finalizeRun 合法 canonical metadata 成功持久化', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    repo.insertRun({
      id: 'run-fin2',
      ruleId: rule.id,
      requestKey: 'k-fin2',
      trigger: 'manual',
      scheduledFor: null,
    });
    repo.transitionRun('run-fin2', 'queued', { status: 'running', startedAt: NOW });
    const meta = metaJson({ httpStatus: 200, etag: '"v1"', lastModified: null, warnings: [] });
    expect(
      repo.finalizeRun({
        runId: 'run-fin2',
        ruleId: rule.id,
        outcome: { kind: 'failed', health: 'parse_changed', retryable: false },
        health: { state: 'degraded', acquisition: 'rss', code: 'parse_changed' },
        consecutiveFailures: 1,
        backoffUntil: null,
        responseMetadataJson: meta,
        runAudit: { id: randomUUID(), reasonCode: 'parse-changed', createdAt: NOW },
      }),
    ).toEqual({ ok: true });
    expect(repo.getRun('run-fin2')!.responseMetadataJson).toBe(meta);
  });
});

// ---------------------------------------------------------------------------
// R2-2 coalesce 全库预算：写前同事务估算 + ==/+1 边界 + 拒绝后逐行恒等
// ---------------------------------------------------------------------------

describe('R2-2 coalesce 全库预算（maxDbBytes ==/+1 边界）', () => {
  // 返回一个 fresh 的「已建首个 Event + running Run」seed 的写入输入。
  // 每次调用创建独立 DB（迁移完整），保证边界搜索确定性互不污染。
  function seedCoalesceCandidate(): {
    db: DbHandle;
    repo: WatchRepository;
    coalesceInput: () => Parameters<WatchRepository['writeEventResult']>[0];
    snapshotKey: () => string;
  } {
    const db = openDb(join(root, `coalesce-${Math.random().toString(36).slice(2)}.db`));
    runWatchMigrations(db);
    const baseRepo = new WatchRepository(db);
    const rule = makeRule();
    expect(baseRepo.insertRule(rule).ok).toBe(true);
    // 首建 Event（path=create）：Baseline v1 + Event + observation + items
    const runId1 = 'coalesce-run1';
    baseRepo.insertRun({
      id: runId1,
      ruleId: rule.id,
      requestKey: 'k-c1',
      trigger: 'scheduled',
      scheduledFor: null,
    });
    baseRepo.transitionRun(runId1, 'queued', { status: 'running' });
    const meta1 = metaJson({ httpStatus: 200, etag: '"v1"', lastModified: null, warnings: [] });
    const event = makeEvent(rule.id, { itemCount: 1 });
    const first = baseRepo.writeEventResult({
      path: 'create',
      rule,
      runId: runId1,
      sourceAfterRevalidationRowVersion: 1,
      identity: {
        sourceId: 'src-1',
        sourceLocatorFingerprint: FINGERPRINT,
        expectedBaselineVersion: null,
      },
      baseline: {
        projectionType: 'feed',
        projectionJson: '{}',
        contentHash: 'h',
        byteLength: 2,
        finalUrl: 'https://example.com',
        capturedAt: NOW,
        documentId: null,
        validators: { etag: null, lastModified: null },
      },
      event: { event, items: [makeItem()], outbox: [] },
      run: {
        expectedStatus: 'running',
        outcome: { kind: 'event-created', eventId: event.id },
        health: { state: 'healthy', acquisition: 'rss', code: null },
        responseMetadataJson: meta1,
      },
      audits: [{ id: randomUUID(), reasonCode: 'event-created', createdAt: NOW }],
    });
    expect(first).toEqual({ ok: true });
    // 第二个 running Run 用于 coalesce
    const runId2 = 'coalesce-run2';
    baseRepo.insertRun({
      id: runId2,
      ruleId: rule.id,
      requestKey: 'k-c2',
      trigger: 'scheduled',
      scheduledFor: null,
    });
    baseRepo.transitionRun(runId2, 'queued', { status: 'running' });
    const meta2 = metaJson({ httpStatus: 200, etag: '"v2"', lastModified: null, warnings: [] });
    const newItem = makeItem({ itemId: 'it-2', fieldKey: 'link' });
    // create 已把 Baseline 推进到 v1：coalesce 输入必须携带反映当前库身份的规则
    //（baselineVersion=1），否则结果事务顶部 baseline-conflict。
    const ruleAfterCreate: WatchRule = { ...rule, baselineVersion: 1 };
    const coalesceInput: () => Parameters<WatchRepository['writeEventResult']>[0] = () => ({
      path: 'coalesce',
      rule: ruleAfterCreate,
      runId: runId2,
      sourceAfterRevalidationRowVersion: 1,
      identity: {
        sourceId: 'src-1',
        sourceLocatorFingerprint: FINGERPRINT,
        expectedBaselineVersion: 1,
      },
      baseline: {
        projectionType: 'feed',
        projectionJson: '{"v2":true}',
        contentHash: 'h2',
        byteLength: 12,
        finalUrl: 'https://example.com',
        capturedAt: NOW,
        documentId: null,
        validators: { etag: null, lastModified: null },
      },
      coalesce: {
        eventId: event.id,
        expectedFirstObservedAt: event.firstObservedAt,
        expectedItemCount: 1,
        eventKind: 'mixed',
        lastObservedAt: NOW,
        newItemCount: 2,
        observationId: randomUUID(),
        idempotencyKey: randomUUID(),
        changeFingerprint: 'fp2',
        items: [newItem],
      },
      run: {
        expectedStatus: 'running',
        outcome: { kind: 'event-coalesced', eventId: event.id },
        health: { state: 'healthy', acquisition: 'rss', code: null },
        responseMetadataJson: meta2,
      },
      audits: [{ id: randomUUID(), reasonCode: 'event-coalesced', createdAt: NOW }],
    });
    const snapshotKey = (): string => {
      const h = openDb(db.path);
      try {
        const tables = [
          'watch_events',
          'watch_event_observations',
          'watch_event_items',
          'watch_baselines',
          'watch_runs',
          'watch_audits',
          'watch_rules',
        ];
        return tables
          .map((t) => {
            const rows = h.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>;
            return `${t}:${rows
              .map((r) => JSON.stringify(r))
              .sort()
              .join('|')}`;
          })
          .join('\n');
      } finally {
        closeDb(h);
      }
    };
    return { db, repo: baseRepo, coalesceInput, snapshotKey };
  }

  function runCoalesce(
    seed: ReturnType<typeof seedCoalesceCandidate>,
    maxDbBytes: number,
  ): { ok: boolean; code?: string } {
    const db = seed.db;
    const repoI = new WatchRepository(db, { maxDbBytes });
    const result = repoI.writeEventResult(seed.coalesceInput());
    repoI.dispose();
    if (result.ok) return { ok: true };
    return { ok: false, code: result.code };
  }

  it('coalesce 写前估算：maxDbBytes==边界成功、+1 拒绝；拒绝后相关表逐行恒等', () => {
    // 找到一个可成功的宽松预算作为上界
    const seedWide = seedCoalesceCandidate();
    const wide = runCoalesce(seedWide, 100_000_000);
    expect(wide.ok).toBe(true);
    closeDb(seedWide.db);
    // 用二分确定最小可成功预算 B（每次 fresh seed 保证确定性）
    let lo = 0;
    let hi = 100_000_000;
    let boundary = hi;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const s = seedCoalesceCandidate();
      const r = runCoalesce(s, mid);
      closeDb(s.db);
      if (r.ok) {
        boundary = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    // == 边界成功
    const seedOk = seedCoalesceCandidate();
    const okRes = runCoalesce(seedOk, boundary);
    expect(okRes.ok).toBe(true);
    closeDb(seedOk.db);
    // +1 拒绝（budget-exceeded）且相关表逐行恒等
    const seedFail = seedCoalesceCandidate();
    const before = seedFail.snapshotKey();
    const failRes = runCoalesce(seedFail, boundary - 1);
    expect(failRes).toEqual({ ok: false, code: 'db-budget-exceeded' });
    expect(seedFail.snapshotKey()).toBe(before);
    closeDb(seedFail.db);
  });
});

// ---------------------------------------------------------------------------
// R3-2 finished Run metadata 必填：transitionRun/finalizeRun/writeEventTransaction
// 缺失/null/非法 → validation-failed 零写；canonical 成功并精确持久化
// ---------------------------------------------------------------------------

describe('R3-2 finished Run metadata 必填（零写矩阵）', () => {
  function seedQueued(rule: WatchRule, runId: string, key: string): void {
    repo.insertRule(rule);
    repo.insertRun({
      id: runId,
      ruleId: rule.id,
      requestKey: key,
      trigger: 'scheduled',
      scheduledFor: null,
    });
  }

  function seedRunning(rule: WatchRule, runId: string, key: string): void {
    seedQueued(rule, runId, key);
    expect(repo.transitionRun(runId, 'queued', { status: 'running' }).ok).toBe(true);
  }

  it('transitionRun finished 缺失 metadata → validation-failed 且 Run 保持 queued', () => {
    const rule = makeRule();
    const runId = 'r3-run-missing';
    seedQueued(rule, runId, 'k-missing');
    expect(
      repo.transitionRun(runId, 'queued', {
        status: 'finished',
        finishedAt: NOW,
        outcome: { kind: 'unchanged' },
        health: { state: 'healthy', acquisition: 'rss', code: null },
      }),
    ).toEqual({ ok: false, code: 'validation-failed' });
    expect(repo.getRun(runId)!.status).toBe('queued');
  });

  it('transitionRun finished null metadata → validation-failed 零写', () => {
    const rule = makeRule();
    const runId = 'r3-run-null';
    seedQueued(rule, runId, 'k-null');
    expect(
      repo.transitionRun(runId, 'queued', {
        status: 'finished',
        finishedAt: NOW,
        responseMetadataJson: null,
      }),
    ).toEqual({ ok: false, code: 'validation-failed' });
    expect(repo.getRun(runId)!.status).toBe('queued');
  });

  it('transitionRun queued→running 保持 metadata=null；提供非 null metadata 拒绝', () => {
    const rule = makeRule();
    const runId = 'r3-run-running';
    seedQueued(rule, runId, 'k-running');
    expect(
      repo.transitionRun(runId, 'queued', {
        status: 'running',
        startedAt: NOW,
        responseMetadataJson: metaJson(),
      }),
    ).toEqual({ ok: false, code: 'validation-failed' });
    expect(repo.getRun(runId)!.status).toBe('queued');
    expect(repo.transitionRun(runId, 'queued', { status: 'running', startedAt: NOW })).toEqual({
      ok: true,
    });
    expect(repo.getRun(runId)!.responseMetadataJson).toBeNull();
  });

  it('transitionRun finished canonical metadata → 成功并精确持久化', () => {
    const rule = makeRule();
    const runId = 'r3-run-ok';
    seedQueued(rule, runId, 'k-ok');
    const meta = metaJson({ httpStatus: 200, etag: '"v1"', lastModified: null, warnings: [] });
    expect(
      repo.transitionRun(runId, 'queued', {
        status: 'finished',
        finishedAt: NOW,
        outcome: { kind: 'unchanged' },
        health: { state: 'healthy', acquisition: 'rss', code: null },
        responseMetadataJson: meta,
      }),
    ).toEqual({ ok: true });
    expect(repo.getRun(runId)!.status).toBe('finished');
    expect(repo.getRun(runId)!.responseMetadataJson).toBe(meta);
  });

  it('finalizeRun null metadata（运行时敌手）→ validation-failed 且 Run 保持 running', () => {
    const rule = makeRule();
    const runId = 'r3-fin-null';
    seedRunning(rule, runId, 'k-fin-null');
    expect(
      repo.finalizeRun({
        runId,
        ruleId: rule.id,
        outcome: { kind: 'unchanged' },
        health: { state: 'healthy', acquisition: 'rss', code: null },
        consecutiveFailures: 0,
        backoffUntil: null,
        responseMetadataJson: null as unknown as string,
        runAudit: { id: randomUUID(), reasonCode: 'unchanged', createdAt: NOW },
      }),
    ).toEqual({ ok: false, code: 'validation-failed' });
    expect(repo.getRun(runId)!.status).toBe('running');
    expect(count('watch_audits')).toBe(0);
  });

  it('writeEventTransaction 提供 run 时缺失/null metadata → validation-failed 零写', () => {
    const rule = makeRule();
    const runId = 'r3-tx-null';
    seedQueued(rule, runId, 'k-tx-null');
    expect(repo.transitionRun(runId, 'queued', { status: 'running' }).ok).toBe(true);
    const event = makeEvent(rule.id);
    const result = repo.writeEventTransaction({
      event,
      items: [makeItem()],
      identity: identity(rule.id),
      run: {
        runId,
        expectedStatus: 'running',
        outcome: { kind: 'event-created', eventId: event.id },
        health: null,
        responseMetadataJson: null as unknown as string,
      },
    });
    expect(result).toEqual({ ok: false, code: 'validation-failed' });
    expect(count('watch_events')).toBe(0);
    expect(repo.getRun(runId)!.status).toBe('running');
  });

  it('writeEventTransaction 提供 run 且 canonical metadata → 成功并精确持久化', () => {
    const rule = makeRule();
    const runId = 'r3-tx-ok';
    seedQueued(rule, runId, 'k-tx-ok');
    expect(repo.transitionRun(runId, 'queued', { status: 'running' }).ok).toBe(true);
    const event = makeEvent(rule.id);
    const meta = metaJson({ httpStatus: 200, etag: '"v1"', lastModified: null, warnings: [] });
    expect(
      repo.writeEventTransaction({
        event,
        items: [makeItem()],
        identity: identity(rule.id),
        run: {
          runId,
          expectedStatus: 'running',
          outcome: { kind: 'event-created', eventId: event.id },
          health: null,
          responseMetadataJson: meta,
        },
      }),
    ).toEqual({ ok: true });
    const run = repo.getRun(runId)!;
    expect(run.status).toBe('finished');
    expect(run.responseMetadataJson).toBe(meta);
    expect(repo.getEvent(event.id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R3-3 Baseline validator runtime：writeBaseline/applyBaselineInternal 写前
// 复用同一 runtime 规则（超限 / Page 非 null → validation-failed 零写）
// ---------------------------------------------------------------------------

describe('R3-3 Baseline validator runtime 写前边界', () => {
  it('writeBaseline feed validator 1024 字节接受、1025 拒绝（零写）', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    expect(
      repo.writeBaseline({
        ruleId: rule.id,
        expectedBaselineVersion: null,
        projectionType: 'feed',
        projectionJson: '{}',
        contentHash: 'h',
        byteLength: 2,
        finalUrl: 'https://example.com',
        capturedAt: NOW,
        documentId: null,
        validators: { etag: 'a'.repeat(1024), lastModified: null },
      }),
    ).toEqual({ ok: true });
    const rule2 = makeRule();
    repo.insertRule(rule2);
    expect(
      repo.writeBaseline({
        ruleId: rule2.id,
        expectedBaselineVersion: null,
        projectionType: 'feed',
        projectionJson: '{}',
        contentHash: 'h',
        byteLength: 2,
        finalUrl: 'https://example.com',
        capturedAt: NOW,
        documentId: null,
        validators: { etag: 'a'.repeat(1025), lastModified: null },
      }),
    ).toEqual({ ok: false, code: 'validation-failed' });
    expect(repo.getBaseline(rule2.id)).toBeNull();
    expect(repo.getRule(rule2.id)!.baselineVersion).toBe(0);
  });

  it('writeBaseline Page 非 null validator → validation-failed 零写', () => {
    const rule = makeRule({ kind: 'page', accessMode: 'session' });
    repo.insertRule(rule);
    expect(
      repo.writeBaseline({
        ruleId: rule.id,
        expectedBaselineVersion: null,
        projectionType: 'page',
        projectionJson: '{"type":"page","fields":[]}',
        contentHash: 'h',
        byteLength: 30,
        finalUrl: 'https://example.com/doc',
        capturedAt: NOW,
        documentId: 'doc1',
        validators: { etag: '"x"', lastModified: null },
      }),
    ).toEqual({ ok: false, code: 'validation-failed' });
    expect(repo.getBaseline(rule.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R3-4 observation id 闭合形状（启动扫描只接受小写 UUID v4 或 v2:<所属 eventId>）
// ---------------------------------------------------------------------------

describe('R3-4 scanIntegrity observation id 形状', () => {
  function seedEventWithObservation(): { rule: WatchRule; event: WatchEvent } {
    const rule = makeRule();
    repo.insertRule(rule);
    const event = makeEvent(rule.id);
    expect(
      repo.writeEventTransaction({ event, items: [makeItem()], identity: identity(rule.id) }),
    ).toEqual({ ok: true });
    return { rule, event };
  }

  it('正常 UUID v4 observation → scanIntegrity ok；新写 ID 为小写 UUID v4', () => {
    const { event } = seedEventWithObservation();
    const obs = handle
      .prepare('SELECT id FROM watch_event_observations WHERE event_id = ?')
      .get(event.id) as { id: string };
    expect(obs.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(repo.scanIntegrity()).toEqual({ ok: true, reason: null });
  });

  it('v2:<eventId> 迁移回填形态 → scanIntegrity ok', () => {
    const { event } = seedEventWithObservation();
    // FK=OFF 下改写 observation id 与 item.observation_id（v2 回填形态）；
    // 恢复 FK 后扫描须接受 `v2:<所属 eventId>`。
    handle.exec('PRAGMA foreign_keys = OFF');
    handle
      .prepare('UPDATE watch_event_observations SET id = ? WHERE event_id = ?')
      .run(`v2:${event.id}`, event.id);
    handle
      .prepare('UPDATE watch_event_items SET observation_id = ? WHERE event_id = ?')
      .run(`v2:${event.id}`, event.id);
    handle
      .prepare('UPDATE digest_change_journal SET observation_id = ? WHERE event_id = ?')
      .run(`v2:${event.id}`, event.id);
    handle.exec('PRAGMA foreign_keys = ON');
    expect(repo.scanIntegrity()).toEqual({ ok: true, reason: null });
  });

  it('敌手形状拒绝：c-<uuid> / <event>-obs0 / 大小写 UUID / 非 v4 / 任意 v2 suffix', () => {
    const hostile = [
      `c-${randomUUID()}`,
      `${'e'}-obs0`,
      randomUUID().toUpperCase(),
      '01234567-89ab-5def-8a9b-0c1d2e3f4a5b', // 非 v4 version
      '01234567-89ab-4def-6a9b-0c1d2e3f4a5b', // 非 v4 variant
      'v2:whatever',
    ];
    for (const id of hostile) {
      const { event } = seedEventWithObservation();
      handle.exec('PRAGMA foreign_keys = OFF');
      handle
        .prepare('UPDATE watch_event_observations SET id = ? WHERE event_id = ?')
        .run(id, event.id);
      handle
        .prepare('UPDATE watch_event_items SET observation_id = ? WHERE event_id = ?')
        .run(id, event.id);
      handle.exec('PRAGMA foreign_keys = ON');
      expect(repo.scanIntegrity().ok).toBe(false);
    }
  });

  it('v2: suffix 不等于所属 Event ID → 拒绝', () => {
    const { event } = seedEventWithObservation();
    const wrong = `v2:${randomUUID()}`;
    handle.exec('PRAGMA foreign_keys = OFF');
    handle
      .prepare('UPDATE watch_event_observations SET id = ? WHERE event_id = ?')
      .run(wrong, event.id);
    handle
      .prepare('UPDATE watch_event_items SET observation_id = ? WHERE event_id = ?')
      .run(wrong, event.id);
    handle.exec('PRAGMA foreign_keys = ON');
    expect(repo.scanIntegrity().ok).toBe(false);
  });
});
