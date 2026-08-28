// D4 watch-repository tests: 真实 node:sqlite 全部业务原语（detailed-design
// §7/§9/§10、threat-model §3.5/WT-21）。覆盖：Rule CRUD/CAS、Baseline CAS、
// Event+items+Baseline+Run+outbox 原子性（注入失败全回滚）、run 状态机、
// intent 状态机、级联删除 + Digest tombstone、保留预算（时间/数量/单对象/全库）、
// SQL 注入串仅作数据、读路径二次校验 fail-closed。临时目录精确清理。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DbHandle } from '../../sources/db/sqlite-driver';
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
    expect(repo.transitionRun('r1', 'queued', { status: 'finished' })).toEqual({
      ok: false,
      code: 'run-state-conflict',
    });
    expect(
      repo.transitionRun('r1', 'running', {
        status: 'finished',
        finishedAt: NOW,
        outcome: { kind: 'unchanged' },
        health: { state: 'healthy', acquisition: 'rss', code: null },
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
    repo.transitionRun('r3', 'queued', { status: 'finished', finishedAt: NOW });
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
    handle
      .prepare(
        `INSERT INTO digest_schedules (id, source_ids_json, schedule_json, ai_enabled, state, created_at, updated_at)
  VALUES ('ds1','[]','{"kind":"daily","localTime":"09:00","timeZone":"Asia/Shanghai"}',1,'active',?,?)`,
      )
      .run(NOW, NOW);
    handle
      .prepare(
        `INSERT INTO watch_digests (id, schedule_id, facts_json, byte_length, created_at)
  VALUES ('d1','ds1','{}',2,?)`,
      )
      .run(NOW);
    expect(
      repo.insertDigestEventRef({ digestId: 'd1', eventId: event.id, status: 'active' }),
    ).toEqual({ ok: true });
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
    const marginalA = afterC - afterB;
    const tight = new WatchRepository(handle, { maxDbBytes: afterC - marginalA });
    const pruned = tight.pruneEventsToDbBudget(new Date(base).toISOString());
    expect(pruned.deleted).toBe(1);
    expect(repo.getEvent(evA.id)).toBeNull();
    expect(repo.getEvent(evB.id)).not.toBeNull();
    expect(repo.getEvent(evC.id)).not.toBeNull();
    void afterA;
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
    handle
      .prepare(
        `INSERT INTO digest_schedules (id, source_ids_json, schedule_json, ai_enabled, state, created_at, updated_at)
  VALUES ('ds1','[]','{"kind":"daily","localTime":"09:00","timeZone":"Asia/Shanghai"}',1,'active',?,?)`,
      )
      .run(NOW, NOW);
    handle
      .prepare(
        `INSERT INTO watch_digests (id, schedule_id, facts_json, byte_length, created_at)
  VALUES ('d1','ds1','{}',2,?)`,
      )
      .run(NOW);
    expect(
      repo.insertDigestEventRef({ digestId: 'd1', eventId: ancient.id, status: 'active' }),
    ).toEqual({ ok: true });
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
