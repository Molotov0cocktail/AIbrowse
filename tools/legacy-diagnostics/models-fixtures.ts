// Synthetic fixtures for diagnosis; never open production business databases.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { openDb } from '../../src/main/sources/db/sqlite-driver';
import { ResearchRepository } from '../../src/main/research/repository/research-repository';
import { runResearchMigrations } from '../../src/main/research/db/research-migrations';
import { createRepositoryPersistence } from '../../src/main/research/research-runtime-persistence';
import { ResearchRuntime } from '../../src/main/research/research-runtime';
import { RESEARCH_PROMPTS_PORT } from '../../src/main/research/synthesis/research-prompts';
import { RESEARCH_SYNTHESIS_PORT } from '../../src/main/research/synthesis/claim-model';
import { RESEARCH_RESULT_VALIDATION_PORT } from '../../src/main/research/result-validator';
import { runWatchMigrations } from '../../src/main/watch/db/watch-migrations';
import { WatchRepository } from '../../src/main/watch/repository/watch-repository';
import { DigestService } from '../../src/main/watch/digest-service';
import { FakeClock } from '../../src/shared/watch/clock';
import type { LLMProvider } from '../../src/main/ai/provider/llm-provider';
import type { SourceSearchItem } from '../../src/shared/types/sources';
import type { WatchRule } from '../../src/shared/types/watch';

const created = '2026-10-10T00:00:00.000Z';
const due = '2026-10-11T01:00:00.000Z';
const hex = 'a'.repeat(64);
export const syntheticUrl = 'https://example.com/diagnostic-source';
export const emptyResult = JSON.stringify({
  result: {
    title: '合成诊断',
    summary: '缺少可验证来源',
    blocks: [{ kind: 'uncertain', text: '证据不足', reason: '无已核验证据' }],
  },
});
export const emptyPlan = JSON.stringify({
  sourceMode: 'search',
  sourceQuery: syntheticUrl,
  groupId: null,
  webQueries: [],
});

export function researchFixture(
  root: string,
  provider: LLMProvider,
  model: string,
  withSource = false,
  forceTool = false,
) {
  const db = openDb(join(root, `${randomUUID()}.research.db`));
  runResearchMigrations(db);
  const repo = new ResearchRepository(db);
  const taskId = randomUUID();
  const stats = {
    candidateCount: 0,
    selectedCount: 0,
    captureCount: 0,
    failedReadCount: 0,
    evidenceCount: 0,
    rejectedEvidenceCount: 0,
    claimCount: 0,
    conflictCount: 0,
    stepsUsed: 0,
    roundsUsed: 0,
  };
  const goal = `研究 ${syntheticUrl}。${forceTool ? '这是固定合成协议测试：首次回答必须调用一次 source_list，参数 page=0。收到工具结果后只输出计划 JSON，webQueries=[]。' : ''}`;
  repo.insertTask({
    id: taskId,
    goal,
    status: 'running',
    phase: 'planning',
    created_at: created,
    updated_at: created,
    started_at: created,
    finished_at: null,
    interrupted_at: null,
    error_code: null,
    result_id: null,
    stats_json: JSON.stringify(stats),
  });
  const source: SourceSearchItem = {
    id: randomUUID(),
    scope: 'page',
    canonicalKey: syntheticUrl,
    url: syntheticUrl,
    name: '合成来源',
    groupId: null,
    groupName: null,
    tags: [],
    priority: 3,
    enabled: true,
    trust: { value: 'unknown', assertedBy: 'ai', verification: 'unverified' },
    shareMode: 'full',
    lastUsedAt: null,
    note: null,
  };
  const observed = { captureCalls: 0, searchCalls: 0, sourceCalls: 0 };
  const controller = new AbortController();
  const runtime = new ResearchRuntime({
    taskId,
    goal,
    runToken: randomUUID(),
    model,
    provider,
    sourceService: {
      search: async (query) => {
        observed.sourceCalls++;
        return { ok: true, query, results: withSource ? [source] : [] };
      },
      list: async () => ({ ok: true, page: 0, pageSize: 20, total: 0, items: [] }),
      listGroups: async () => ({ ok: true, page: 0, pageSize: 20, total: 0, groups: [] }),
      get: async () => ({ ok: false, errorCode: 'source-not-found' }),
    },
    searchProvider: {
      id: 'synthetic-search',
      search: async () => {
        observed.searchCalls++;
        return { ok: true, results: [] };
      },
    },
    captureService: {
      read: async () => {
        observed.captureCalls++;
        return { ok: false, attempts: [], failureReason: 'timeout', warnings: [] };
      },
    },
    persistence: createRepositoryPersistence(db, taskId),
    prompts: RESEARCH_PROMPTS_PORT,
    synthesis: RESEARCH_SYNTHESIS_PORT,
    resultValidation: RESEARCH_RESULT_VALIDATION_PORT,
    stopSignal: controller.signal,
    deadlineMs: 120_000,
  });
  return {
    runtime,
    controller,
    observed,
    task: () => repo.getTaskById(taskId),
    close: () => db.close(),
  };
}

export function digestFixture(
  root: string,
  provider: LLMProvider,
  model: string,
  Service = DigestService,
) {
  const db = openDb(join(root, `${randomUUID()}.watch.db`));
  runWatchMigrations(db);
  const repo = new WatchRepository(db);
  const rule: WatchRule = {
    id: 'rule-1',
    version: 1,
    sourceId: 'source-1',
    kind: 'feed',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'public',
    schedule: { kind: 'interval', intervalMinutes: 60 },
    target: { type: 'feed', feedUrl: syntheticUrl, format: 'rss2' },
    condition: null,
    notificationLevel: 'normal',
    showDetails: false,
    sourceRowVersion: 1,
    sourceLocatorFingerprint: hex,
    nextDueAt: null,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: created,
    updatedAt: created,
  };
  const schedule = repo.createDigestSchedule({
    id: 'schedule-1',
    sourceIds: ['source-1'],
    localTime: '09:00',
    timeZone: 'Asia/Shanghai',
    aiEnabled: true,
    nextDueAt: due,
    nowIso: created,
  });
  const inserted = repo.insertRule(rule);
  const event = repo.writeEventTransaction({
    event: {
      id: 'event-001',
      ruleId: rule.id,
      sourceId: rule.sourceId,
      eventKind: 'added',
      importance: 'normal',
      idempotencyKey: 'synthetic-event',
      changeFingerprint: hex,
      firstObservedAt: created,
      lastObservedAt: created,
      itemCount: 1,
      readAt: null,
    },
    items: [
      {
        itemId: 'price',
        fieldKey: 'title',
        label: '合成产品价格',
        before: { kind: 'absent' },
        after: {
          kind: 'present',
          excerpt: '合成产品价格49元',
          valueHash: hex,
          normalizedBytes: 25,
          truncated: false,
        },
        beforeCapturedAt: created,
        afterCapturedAt: created,
        beforeFinalUrl: syntheticUrl,
        afterFinalUrl: syntheticUrl,
        beforeDocumentId: null,
        afterDocumentId: null,
        feedItemKey: null,
      },
    ],
    identity: {
      sourceId: rule.sourceId,
      expectedSourceLocatorFingerprint: hex,
      expectedBaselineVersion: null,
    },
  });
  if (!schedule.ok || !inserted.ok || !event.ok) throw new Error('合成Digest夹具写入失败');
  const service = new Service({
    repository: repo,
    clock: new FakeClock(Date.parse(due)),
    sharing: {
      get: async () => [
        {
          sourceId: 'source-1',
          shareMode: 'full',
          displayName: '合成来源',
          canonicalUrl: syntheticUrl,
        },
      ],
    },
    provider: { resolve: async () => ({ provider, model }) },
    scheduleControl: { upsert: () => undefined, remove: () => undefined },
  });
  return {
    run: () =>
      service.handleDue({
        scheduleId: 'schedule-1',
        expectedNextDueAt: due,
        logicalDate: '2026-10-11',
      }),
    result: () =>
      db
        .prepare(
          'SELECT provider_state,provider_result_code,explanation_json,facts_hash FROM watch_digests',
        )
        .get() as Record<string, unknown> | undefined,
    close: () => {
      service.dispose();
      repo.dispose();
    },
  };
}
