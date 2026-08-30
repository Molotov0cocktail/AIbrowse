// D7 watch-processing-service tests: 统一处理编排结果事务（detailed-design §8.1/
// §9.2–§9.4、#S6-047～#S6-051/#S6-053/#S6-056/#S6-057）。真实 node:sqlite repo +
// FakeClock；红→绿覆盖首建/unchanged/changed-unmatched/create/coalesce/dedup 与
// baseline-conflict 零写。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb, closeDb } from '../sources/db/sqlite-driver';
import { runWatchMigrations } from './db/watch-migrations';
import { WatchRepository } from './repository/watch-repository';
import { WatchProcessingServiceImpl } from './watch-processing-service';
import { FakeClock } from '../../shared/watch/clock';
import { sha256Hex } from '../../shared/watch/diff/evidence';
import type {
  FeedProjection,
  FeedProjectionValue,
  SourceWatchProjection,
  WatchAcquisitionResult,
  WatchBaselineHint,
  WatchRule,
} from '../../shared/types/watch';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-watch-proc-'));
const NOW_MS = Date.parse('2026-08-28T00:00:00.000Z');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const FINGERPRINT = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function makeRule(overrides: Partial<WatchRule> = {}): WatchRule {
  const sourceId = overrides.sourceId ?? 'src-1';
  return {
    id: randomUUID(),
    sourceId,
    kind: 'feed',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'public',
    schedule: { kind: 'interval', intervalMinutes: 60 },
    target: { type: 'feed', feedUrl: 'https://example.com/rss.xml', format: 'rss2' },
    condition: null,
    notificationLevel: 'important',
    sourceRowVersion: 1,
    sourceLocatorFingerprint: FINGERPRINT,
    nextDueAt: null,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: new Date(NOW_MS).toISOString(),
    updatedAt: new Date(NOW_MS).toISOString(),
    ...overrides,
  };
}

const sourceProjection: SourceWatchProjection = {
  sourceId: 'src-1',
  rowVersion: 1,
  enabled: true,
  deletedAt: null,
  scope: 'page',
  canonicalKey: 'https://example.com/doc',
};

interface Harness {
  dir: string;
  repo: WatchRepository;
  clock: FakeClock;
  service: WatchProcessingServiceImpl;
}

function setup(): Harness {
  const dir = mkdtempSync(join(root, 'proc-'));
  const handle = openDb(join(dir, 'watch.db'));
  runWatchMigrations(handle);
  const repo = new WatchRepository(handle);
  const clock = new FakeClock(NOW_MS);
  const service = new WatchProcessingServiceImpl({ repo, clock });
  return { dir, repo, clock, service };
}

function closeH(h: Harness): void {
  h.repo.dispose();
  closeDb(h.repo.dbHandle);
  rmSync(h.dir, { recursive: true, force: true });
}

function field(text: string): FeedProjectionValue['title'] {
  return {
    text,
    truncated: false,
    originalBytes: Buffer.byteLength(text, 'utf8'),
    valueHash: sha256Hex(text),
  };
}

function makeProjection(rule: WatchRule, title: string, capturedAt: string): FeedProjection {
  const value: FeedProjectionValue = {
    type: 'feed',
    format: 'rss2',
    title: field(title),
    description: field('d'),
    siteUrl: field('https://example.com'),
    feedUrl: field(''),
    items: [
      {
        identity: 'i1',
        identityKind: 'guid',
        title: field(title),
        link: field('https://example.com/a'),
        summary: field('s'),
        publishedAt: null,
        updatedAt: null,
        author: field('a'),
      },
    ],
    itemsTruncated: false,
  };
  const canonicalJson = JSON.stringify(value);
  return {
    schemaVersion: 1,
    ruleId: rule.id,
    sourceId: rule.sourceId,
    finalUrl: 'https://example.com/feed',
    capturedAt,
    documentId: null,
    contentHash: sha256Hex(canonicalJson),
    byteLength: Buffer.byteLength(canonicalJson, 'utf8'),
    value,
  };
}

function projectionAcquisition(
  rule: WatchRule,
  projection: FeedProjection,
): Extract<WatchAcquisitionResult, { ok: true }> {
  return {
    ok: true,
    kind: 'projection',
    projection,
    expectedSourceLocatorFingerprint: rule.sourceLocatorFingerprint,
    responseMetadata: {
      httpStatus: 200,
      etag: '"v1"',
      lastModified: '2026-08-28T00:00:00.000Z',
      warnings: [],
    },
  };
}

async function processProjection(
  h: Harness,
  rule: WatchRule,
  runId: string,
  baselineHint: WatchBaselineHint,
  projection: FeedProjection,
) {
  return h.service.process({
    rule,
    runId,
    baselineHint,
    acquisition: projectionAcquisition(rule, projection),
    sourceAfterAcquisition: sourceProjection,
  });
}

describe('WatchProcessingService 结果事务（#S6-047～#S6-052/#S6-057）', () => {
  it('首建 Baseline：零 Event + baseline-established + contentHash 持久化', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      const prepared = h.service.prepareAcquisition({ rule });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(prepared.baselineHint).toEqual({ kind: 'none', expectedBaselineVersion: 0 });
      const runId = randomUUID();
      expect(
        h.repo.insertRun({
          id: runId,
          ruleId: rule.id,
          requestKey: 'k1',
          trigger: 'scheduled',
          scheduledFor: null,
        }).ok,
      ).toBe(true);
      expect(
        h.repo.transitionRun(runId, 'queued', {
          status: 'running',
          startedAt: new Date(NOW_MS).toISOString(),
        }).ok,
      ).toBe(true);
      const projection = makeProjection(rule, 'New', new Date(NOW_MS).toISOString());
      const result = await processProjection(h, rule, runId, prepared.baselineHint, projection);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome.kind).toBe('baseline-established');
      const baseline = h.repo.getBaseline(rule.id);
      expect(baseline).not.toBeNull();
      expect(baseline!.version).toBe(1);
      expect(baseline!.contentHash).toBe(projection.contentHash);
      expect(baseline!.conditionalEtag).toBe('"v1"'); // 200 validator 与 Baseline 同事务
      expect(h.repo.listEventsByRule(rule.id).length).toBe(0); // 零 Event
      expect(h.repo.getRun(runId)!.status).toBe('finished');
      const readRule = h.repo.getRule(rule.id)!;
      expect(readRule.baselineVersion).toBe(1);
      expect(readRule.consecutiveFailures).toBe(0);
    } finally {
      closeH(h);
    }
  });

  it('unchanged（同 contentHash 200）：Baseline version/content 不变，validator 更新', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      const projection1 = makeProjection(rule, 'A', new Date(NOW_MS).toISOString());
      expect(
        h.repo.writeBaseline({
          ruleId: rule.id,
          expectedBaselineVersion: null,
          projectionType: 'feed',
          projectionJson: JSON.stringify(projection1.value),
          contentHash: projection1.contentHash,
          byteLength: projection1.byteLength,
          finalUrl: projection1.finalUrl,
          capturedAt: projection1.capturedAt,
          documentId: null,
          validators: { etag: '"old"', lastModified: null },
        }).ok,
      ).toBe(true);
      // 库中 baseline_version 已推进到 1；prepareAcquisition 要求传入新鲜 rule（§8.1）
      const freshRule = h.repo.getRule(rule.id)!;
      const prepared = h.service.prepareAcquisition({ rule: freshRule });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      if (prepared.baselineHint.kind !== 'feed') throw new Error('expect feed hint');
      expect(prepared.baselineHint.contentHash).toBe(projection1.contentHash);
      expect(prepared.baselineHint.validators).toEqual({ etag: '"old"', lastModified: null });
      const runId = randomUUID();
      expect(
        h.repo.insertRun({
          id: runId,
          ruleId: rule.id,
          requestKey: 'k2',
          trigger: 'scheduled',
          scheduledFor: null,
        }).ok,
      ).toBe(true);
      expect(
        h.repo.transitionRun(runId, 'queued', {
          status: 'running',
          startedAt: new Date(NOW_MS).toISOString(),
        }).ok,
      ).toBe(true);
      const result = await processProjection(
        h,
        freshRule,
        runId,
        prepared.baselineHint,
        projection1,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome).toEqual({ kind: 'unchanged' });
      const baseline = h.repo.getBaseline(rule.id);
      expect(baseline!.version).toBe(1); // version 不变
      expect(baseline!.contentHash).toBe(projection1.contentHash);
      expect(baseline!.conditionalEtag).toBe('"v1"'); // 200 新 validator 提交
      expect(h.repo.listEventsByRule(rule.id).length).toBe(0);
      expect(
        h.repo.listAudits(100).some((a) => a.kind === 'run' && a.reasonCode === 'unchanged'),
      ).toBe(true);
    } finally {
      closeH(h);
    }
  });

  it('change → matched（无 Condition）→ create Event：双侧 Evidence + outbox + baseline 推进', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      const projection1 = makeProjection(rule, 'A', new Date(NOW_MS).toISOString());
      expect(
        h.repo.writeBaseline({
          ruleId: rule.id,
          expectedBaselineVersion: null,
          projectionType: 'feed',
          projectionJson: JSON.stringify(projection1.value),
          contentHash: projection1.contentHash,
          byteLength: projection1.byteLength,
          finalUrl: projection1.finalUrl,
          capturedAt: projection1.capturedAt,
          documentId: null,
        }).ok,
      ).toBe(true);
      const freshRule = h.repo.getRule(rule.id)!;
      const prepared = h.service.prepareAcquisition({ rule: freshRule });
      if (!prepared.ok) return;
      const runId = randomUUID();
      expect(
        h.repo.insertRun({
          id: runId,
          ruleId: rule.id,
          requestKey: 'k3',
          trigger: 'scheduled',
          scheduledFor: null,
        }).ok,
      ).toBe(true);
      expect(
        h.repo.transitionRun(runId, 'queued', {
          status: 'running',
          startedAt: new Date(NOW_MS).toISOString(),
        }).ok,
      ).toBe(true);
      const projection2 = makeProjection(rule, 'B', new Date(NOW_MS + 60_000).toISOString());
      const result = await processProjection(
        h,
        freshRule,
        runId,
        prepared.baselineHint,
        projection2,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome.kind).toBe('event-created');
      if (result.outcome.kind !== 'event-created') return;
      const events = h.repo.listEventsByRule(rule.id);
      expect(events.length).toBe(1);
      const event = events[0]!;
      expect(event.id).toBe(result.outcome.eventId);
      expect(event.itemCount).toBe(1);
      const items = h.repo.listEventItems(event.id);
      expect(items.length).toBe(1);
      const item = items[0]!;
      expect(item.itemId).toBe('i1');
      expect(item.fieldKey).toBe('title');
      if (item.before.kind === 'present' && item.after.kind === 'present') {
        expect(item.before.excerpt).toBe('A');
        expect(item.after.excerpt).toBe('B');
      }
      const baseline = h.repo.getBaseline(rule.id);
      expect(baseline!.version).toBe(2); // baseline 推进
      expect(h.repo.getRule(rule.id)!.baselineVersion).toBe(2);
      // outbox（非 muted 新建 Event）
      const ob = h.repo.dbHandle
        .prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE subject_type='event'")
        .get() as { n: number };
      expect(ob.n).toBe(1);
      expect(
        h.repo.listAudits(100).some((a) => a.kind === 'run' && a.reasonCode === 'event-created'),
      ).toBe(true);
    } finally {
      closeH(h);
    }
  });

  it('dedup：相同 idempotencyKey 重放 → event-deduplicated、零新增 Event/items/Baseline', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      const projection1 = makeProjection(rule, 'A', new Date(NOW_MS).toISOString());
      expect(
        h.repo.writeBaseline({
          ruleId: rule.id,
          expectedBaselineVersion: null,
          projectionType: 'feed',
          projectionJson: JSON.stringify(projection1.value),
          contentHash: projection1.contentHash,
          byteLength: projection1.byteLength,
          finalUrl: projection1.finalUrl,
          capturedAt: projection1.capturedAt,
          documentId: null,
        }).ok,
      ).toBe(true);
      const freshRule = h.repo.getRule(rule.id)!;
      const prepared = h.service.prepareAcquisition({ rule: freshRule });
      if (!prepared.ok) return;
      const projection2 = makeProjection(rule, 'B', new Date(NOW_MS + 60_000).toISOString());
      // 第一次：create（pass fresh rule：baselineVersion=1 匹配 hint expected=1）
      const runId1 = randomUUID();
      expect(
        h.repo.insertRun({
          id: runId1,
          ruleId: rule.id,
          requestKey: 'k4a',
          trigger: 'scheduled',
          scheduledFor: null,
        }).ok,
      ).toBe(true);
      expect(
        h.repo.transitionRun(runId1, 'queued', {
          status: 'running',
          startedAt: new Date(NOW_MS).toISOString(),
        }).ok,
      ).toBe(true);
      const r1 = await processProjection(h, freshRule, runId1, prepared.baselineHint, projection2);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      expect(r1.outcome.kind).toBe('event-created');
      // 第二次：同一 hint（expected=1）但 Baseline 已推进到 2 —— dedup 合法（baseline>=expected+1）
      const runId2 = randomUUID();
      expect(
        h.repo.insertRun({
          id: runId2,
          ruleId: rule.id,
          requestKey: 'k4b',
          trigger: 'scheduled',
          scheduledFor: null,
        }).ok,
      ).toBe(true);
      expect(
        h.repo.transitionRun(runId2, 'queued', {
          status: 'running',
          startedAt: new Date(NOW_MS + 1).toISOString(),
        }).ok,
      ).toBe(true);
      const r2 = await processProjection(h, freshRule, runId2, prepared.baselineHint, projection2);
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.outcome.kind).toBe('event-deduplicated');
      // 零新增
      expect(h.repo.listEventsByRule(rule.id).length).toBe(1);
      expect(h.repo.listEventItems(h.repo.listEventsByRule(rule.id)[0]!.id).length).toBe(1);
      expect(h.repo.getBaseline(rule.id)!.version).toBe(2); // 不回退
      expect(
        h.repo
          .listAudits(100)
          .some((a) => a.kind === 'run' && a.reasonCode === 'event-deduplicated'),
      ).toBe(true);
    } finally {
      closeH(h);
    }
  });

  it('coalesce：30 分钟内再次变化 → event-coalesced 追加 observation/items、Baseline 推进', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      const projection1 = makeProjection(rule, 'A', new Date(NOW_MS).toISOString());
      expect(
        h.repo.writeBaseline({
          ruleId: rule.id,
          expectedBaselineVersion: null,
          projectionType: 'feed',
          projectionJson: JSON.stringify(projection1.value),
          contentHash: projection1.contentHash,
          byteLength: projection1.byteLength,
          finalUrl: projection1.finalUrl,
          capturedAt: projection1.capturedAt,
          documentId: null,
        }).ok,
      ).toBe(true);
      const freshRule = h.repo.getRule(rule.id)!;
      const prepared = h.service.prepareAcquisition({ rule: freshRule });
      if (!prepared.ok) return;
      // 第一次 create（t=0）
      const runId1 = randomUUID();
      expect(
        h.repo.insertRun({
          id: runId1,
          ruleId: rule.id,
          requestKey: 'k5a',
          trigger: 'scheduled',
          scheduledFor: null,
        }).ok,
      ).toBe(true);
      expect(
        h.repo.transitionRun(runId1, 'queued', {
          status: 'running',
          startedAt: new Date(NOW_MS).toISOString(),
        }).ok,
      ).toBe(true);
      const p2 = makeProjection(rule, 'B', new Date(NOW_MS + 60_000).toISOString());
      const r1 = await processProjection(h, freshRule, runId1, prepared.baselineHint, p2);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      expect(r1.outcome.kind).toBe('event-created');
      // 第二次（t=+10min，仍在 30min 窗口）：从新 baseline hint（version=2）→ coalesce
      const readRule = h.repo.getRule(rule.id)!;
      const prepared2 = h.service.prepareAcquisition({ rule: readRule });
      if (!prepared2.ok) return;
      if (prepared2.baselineHint.kind !== 'feed') throw new Error('expect feed hint');
      const runId2 = randomUUID();
      expect(
        h.repo.insertRun({
          id: runId2,
          ruleId: rule.id,
          requestKey: 'k5b',
          trigger: 'scheduled',
          scheduledFor: null,
        }).ok,
      ).toBe(true);
      expect(
        h.repo.transitionRun(runId2, 'queued', {
          status: 'running',
          startedAt: new Date(NOW_MS + 60_000).toISOString(),
        }).ok,
      ).toBe(true);
      const p3 = makeProjection(rule, 'C', new Date(NOW_MS + 600_000).toISOString());
      const r2 = await processProjection(h, readRule, runId2, prepared2.baselineHint, p3);
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.outcome.kind).toBe('event-coalesced');
      if (r2.outcome.kind !== 'event-coalesced') return;
      const event = h.repo.listEventsByRule(rule.id)[0]!;
      expect(event.itemCount).toBe(2); // 两次变化
      expect(h.repo.listEventItems(event.id).length).toBe(2);
      expect(
        h.repo.listAudits(100).some((a) => a.kind === 'run' && a.reasonCode === 'event-coalesced'),
      ).toBe(true);
    } finally {
      closeH(h);
    }
  });

  it('condition_error：验证/求值失败 → failed(condition_error) 非重试 + dependency-unavailable 暂停 + 旧 Baseline', async () => {
    const h = setup();
    try {
      // 存储层合法的 condition，但 predicate fieldKey 不在 feed 字段目录
      // {title,link,summary,published} → 求值期 condition error（§5/#S6-053）
      const rule = makeRule({
        condition: {
          version: 1,
          combine: 'all',
          predicates: [
            { fieldKey: 'price', operator: 'increased', operand: 10, caseSensitive: false },
          ],
        },
      });
      expect(h.repo.insertRule(rule).ok).toBe(true);
      const projection1 = makeProjection(rule, 'A', new Date(NOW_MS).toISOString());
      expect(
        h.repo.writeBaseline({
          ruleId: rule.id,
          expectedBaselineVersion: null,
          projectionType: 'feed',
          projectionJson: JSON.stringify(projection1.value),
          contentHash: projection1.contentHash,
          byteLength: projection1.byteLength,
          finalUrl: projection1.finalUrl,
          capturedAt: projection1.capturedAt,
          documentId: null,
        }).ok,
      ).toBe(true);
      const freshRule = h.repo.getRule(rule.id)!;
      expect(freshRule.condition).not.toBeNull();
      const prepared = h.service.prepareAcquisition({ rule: freshRule });
      if (!prepared.ok) return;
      const runId = randomUUID();
      expect(
        h.repo.insertRun({
          id: runId,
          ruleId: rule.id,
          requestKey: 'k6',
          trigger: 'scheduled',
          scheduledFor: null,
        }).ok,
      ).toBe(true);
      expect(
        h.repo.transitionRun(runId, 'queued', {
          status: 'running',
          startedAt: new Date(NOW_MS).toISOString(),
        }).ok,
      ).toBe(true);
      const p2 = makeProjection(rule, 'B', new Date(NOW_MS + 60_000).toISOString());
      const result = await processProjection(h, freshRule, runId, prepared.baselineHint, p2);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome).toEqual({
        kind: 'failed',
        health: 'condition_error',
        retryable: false,
      });
      const readRule = h.repo.getRule(rule.id)!;
      expect(readRule.state).toBe('paused');
      expect(readRule.pauseReason).toBe('dependency-unavailable');
      expect(readRule.consecutiveFailures).toBe(1);
      expect(readRule.backoffUntil).toBeNull(); // 无 backoff
      expect(h.repo.getBaseline(rule.id)!.version).toBe(1); // 旧 Baseline
      expect(h.repo.listEventsByRule(rule.id).length).toBe(0);
      expect(
        h.repo.listAudits(100).some((a) => a.kind === 'run' && a.reasonCode === 'condition-error'),
      ).toBe(true);
    } finally {
      closeH(h);
    }
  });
});
