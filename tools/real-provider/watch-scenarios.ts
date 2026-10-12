// Synthetic production Watch fixtures; no user profile or raw model output is read.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../../src/main/sources/db/sqlite-driver';
import { runMigrations } from '../../src/main/sources/db/migrations';
import { SourceServiceImpl } from '../../src/main/sources/source-service';
import { runWatchMigrations } from '../../src/main/watch/db/watch-migrations';
import { WatchRepository } from '../../src/main/watch/repository/watch-repository';
import { DigestService } from '../../src/main/watch/digest-service';
import { newIndependentTarget } from '../../src/main/watch/watch-independent-target';
import { projectPageProjection } from '../../src/main/watch/page-projector';
import { computeSourceLocatorFingerprint } from '../../src/shared/watch/watch-rule-state';
import { diffPageProjections } from '../../src/shared/watch/diff/page-diff';
import { FakeClock } from '../../src/shared/watch/clock';
import type { WatchRule, PageProjection } from '../../src/shared/types/watch';
import type { LLMProvider } from '../../src/main/ai/provider/llm-provider';

export const WATCH_REPAIR_EVENT_ID = 'watch-repair-selected-event';
const otherEventId = 'watch-repair-unselected-event';
const unselectedCanary = 'UNSELECTED_WATCH_EVENT_CANARY';
const sourceCanary = 'SOURCE_LIBRARY_CANARY';
const created = '2026-10-10T00:00:00.000Z';
const observed = '2026-10-10T00:01:00.000Z';
const due = '2026-10-11T01:00:00.000Z';
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

function rowRecord(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), '合成数据库行无效');
  return value as Record<string, unknown>;
}

function sourceFingerprint(db: DbHandle): string {
  return digest([
    db.prepare('SELECT * FROM sources ORDER BY id').all(),
    db.prepare('SELECT * FROM usage_events ORDER BY source_id').all(),
    db.prepare('SELECT * FROM change_journal ORDER BY idempotency_key').all(),
    db.prepare('SELECT * FROM sources_fts_data ORDER BY id').all(),
    db.prepare('SELECT * FROM sources_fts_idx ORDER BY segid, term').all(),
    db.prepare('SELECT * FROM sources_fts_docsize ORDER BY id').all(),
    db.prepare('SELECT * FROM sources_fts_config ORDER BY k').all(),
  ]);
}

function eventFingerprint(db: DbHandle): string {
  return digest([
    db.prepare('SELECT * FROM watch_events ORDER BY id').all(),
    db.prepare('SELECT * FROM watch_event_items ORDER BY id').all(),
  ]);
}

function seedOwner(repo: WatchRepository, selected: boolean) {
  const target = newIndependentTarget(
    `https://example.com/${selected ? 'selected' : 'unselected'}?private=PRIVATE_QUERY_CANARY`,
  );
  assert(target !== null);
  const rule: WatchRule = {
    id: randomUUID(),
    version: 1,
    bindingKind: 'watch-target',
    sourceId: target.id,
    kind: 'page',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'public',
    schedule: { kind: 'interval', intervalMinutes: 60 },
    target: {
      type: 'page',
      pageUrl: target.canonicalUrl,
      regions: [{ kind: 'main-text', label: '价格' }],
      sessionConsent: null,
    },
    condition: null,
    notificationLevel: 'normal',
    showDetails: false,
    sourceRowVersion: 1,
    sourceLocatorFingerprint: computeSourceLocatorFingerprint({
      sourceId: target.id,
      scope: 'page',
      canonicalKey: target.canonicalUrl,
      kind: 'page',
      canonicalTargetUrl: target.canonicalUrl,
    }),
    nextDueAt: null,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: created,
    updatedAt: created,
  };
  const projection = (after: boolean): PageProjection => {
    const result = projectPageProjection({
      channels: {
        mainText: selected
          ? `合成产品价格${after ? '49' : '42'}元`
          : `${unselectedCanary}${after ? 'B' : 'A'}`,
        headings: [],
        links: [],
        tables: [],
      },
      regions: [{ kind: 'main-text', label: '价格' }],
      ruleId: rule.id,
      sourceId: target.id,
      finalUrl: target.canonicalUrl,
      capturedAt: after ? observed : created,
      documentId: after ? '2' : '1',
    });
    assert(result.ok, '合成页面投影失败');
    return result.projection;
  };
  const before = projection(false);
  const after = projection(true);
  const baseline = (value: PageProjection) => ({
    projectionType: 'page' as const,
    projectionJson: JSON.stringify(value.value),
    contentHash: value.contentHash,
    byteLength: value.byteLength,
    finalUrl: value.finalUrl,
    capturedAt: value.capturedAt,
    documentId: value.documentId,
  });
  assert(
    repo.createRuleWithBaseline({ rule, independentTarget: target, baseline: baseline(before) }).ok,
    '独立目标事务失败',
  );
  const pairs = diffPageProjections(before, after).pairs;
  assert.equal(pairs.length, 1);
  assert(pairs.every((pair) => pair.before.kind === 'present' && pair.after.kind === 'present'));
  const eventId = selected ? WATCH_REPAIR_EVENT_ID : otherEventId;
  const writeEvent = () =>
    assert(
      repo.writeEventTransaction({
        event: {
          id: eventId,
          ruleId: rule.id,
          sourceId: target.id,
          eventKind: 'changed',
          importance: 'normal',
          idempotencyKey: eventId,
          changeFingerprint: digest(pairs),
          firstObservedAt: observed,
          lastObservedAt: observed,
          itemCount: pairs.length,
          readAt: null,
        },
        items: pairs,
        identity: {
          sourceId: target.id,
          expectedSourceLocatorFingerprint: rule.sourceLocatorFingerprint,
          expectedBaselineVersion: 1,
        },
        baseline: { ...baseline(after), expectedBaselineVersion: 1 },
      }).ok,
      '确定性事件事务失败',
    );
  return { id: target.id, writeEvent };
}

export async function runIndependentWatchScenarios(
  root: string,
  provider: LLMProvider,
  model: string,
) {
  const sourceDb = openDb(join(root, 'synthetic-sources.db'));
  const watchDb = openDb(join(root, 'synthetic-watch.db'));
  runMigrations(sourceDb);
  runWatchMigrations(watchDb);
  const sources = new SourceServiceImpl({ db: sourceDb, now: () => Date.parse(created) });
  const repo = new WatchRepository(watchDb);
  let service: DigestService | null = null;
  try {
    assert(
      (
        await sources.addManual({
          scope: 'page',
          url: 'https://example.com/source-sentinel',
          name: sourceCanary,
          shareMode: 'full',
        })
      ).ok,
    );
    const sourceBefore = sourceFingerprint(sourceDb);
    const selected = seedOwner(repo, true);
    const other = seedOwner(repo, false);
    const selectedId = selected.id;
    const otherId = other.id;
    const schedules = [
      { id: 'default-plan', owner: selectedId, ai: false },
      { id: 'other-plan', owner: otherId, ai: false },
      { id: 'authorized-plan', owner: selectedId, ai: true },
    ];
    for (const item of schedules)
      assert(
        repo.createDigestSchedule({
          bindingKind: 'watch-target',
          id: item.id,
          sourceIds: [item.owner],
          localTime: '09:00',
          timeZone: 'Asia/Shanghai',
          aiEnabled: item.ai,
          nextDueAt: due,
          nowIso: created,
        }).ok,
        '独立摘要计划创建失败',
      );
    selected.writeEvent();
    other.writeEvent();
    const eventsBefore = eventFingerprint(watchDb);
    let providerCalls = 0;
    let sourceSharingReads = 0;
    let selectedProjectionOnly = false;
    const measured: LLMProvider = {
      metadata: provider.metadata,
      async *stream(request, signal) {
        providerCalls++;
        assert.equal(providerCalls, 1, '独立摘要不得额外调用模型');
        const content = JSON.stringify(request);
        selectedProjectionOnly =
          content.includes(WATCH_REPAIR_EVENT_ID) &&
          ![otherEventId, unselectedCanary, sourceCanary, 'PRIVATE_QUERY_CANARY'].some((item) =>
            content.includes(item),
          );
        assert(selectedProjectionOnly, '模型投影越过计划授权范围');
        yield* provider.stream(request, signal);
      },
    };
    service = new DigestService({
      repository: repo,
      clock: new FakeClock(Date.parse(due)),
      sharing: {
        get: async () => {
          sourceSharingReads++;
          throw new Error('独立目标不得读取Sources共享');
        },
      },
      provider: { resolve: async () => ({ provider: measured, model }) },
      scheduleControl: { upsert: () => undefined, remove: () => undefined },
    });
    for (const item of schedules) {
      await service.handleDue({
        scheduleId: item.id,
        expectedNextDueAt: due,
        logicalDate: '2026-10-11',
      });
      if (!item.ai) assert.equal(providerCalls, 0, '未授权计划触发模型');
    }
    const rows = watchDb
      .prepare(
        'SELECT schedule_id, provider_state, provider_result_code, explanation_json FROM watch_digests ORDER BY schedule_id',
      )
      .all()
      .map(rowRecord);
    const authorized = rows.find((row) => row['schedule_id'] === 'authorized-plan');
    const disabledPlans = rows.filter((row) => row['schedule_id'] !== 'authorized-plan');
    const disabledPlansSkippedProvider =
      disabledPlans.length === 2 &&
      disabledPlans.every(
        (row) => row['provider_state'] === 'disabled' && row['explanation_json'] === null,
      );
    const explanationStored =
      authorized?.['provider_state'] === 'succeeded' &&
      typeof authorized['explanation_json'] === 'string';
    const sourcesUnchanged = sourceBefore === sourceFingerprint(sourceDb);
    const targetSharingUnchanged = [selectedId, otherId].every(
      (id) => repo.getIndependentTarget(id)?.aiShareMode === 'blocked',
    );
    const eventsUnchanged =
      rowRecord(watchDb.prepare('SELECT COUNT(*) AS n FROM watch_events').get())['n'] === 2 &&
      eventsBefore === eventFingerprint(watchDb);
    const integrityValid = repo.scanIntegrity().ok;
    return {
      name: '独立监控摘要显式AI授权',
      passed:
        providerCalls === 1 &&
        sourceSharingReads === 0 &&
        selectedProjectionOnly &&
        disabledPlansSkippedProvider &&
        explanationStored &&
        sourcesUnchanged &&
        targetSharingUnchanged &&
        eventsUnchanged &&
        integrityValid,
      providerCalls,
      sourceSharingReads,
      selectedProjectionOnly,
      disabledPlansSkippedProvider,
      explanationStored,
      sourcesUnchanged,
      targetSharingUnchanged,
      eventsUnchanged,
      integrityValid,
      selectedEventCount: 1,
      totalSyntheticEvents: 2,
      state: authorized?.['provider_state'] ?? null,
      code: authorized?.['provider_result_code'] ?? null,
    };
  } finally {
    service?.dispose();
    sources.dispose();
    sourceDb.close();
    repo.dispose();
  }
}
