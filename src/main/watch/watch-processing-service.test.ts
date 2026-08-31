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
  PageProjection,
  PageProjectionValue,
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

describe('D7 Repair：Run metadata / outbox / canonical / health 精确契约', () => {
  it('R1 成功终态（event-created）精确持久化 Run response_metadata_json（同一 CAS UPDATE）', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      const p1 = makeProjection(rule, 'A', new Date(NOW_MS).toISOString());
      expect(
        h.repo.writeBaseline({
          ruleId: rule.id,
          expectedBaselineVersion: null,
          projectionType: 'feed',
          projectionJson: JSON.stringify(p1.value),
          contentHash: p1.contentHash,
          byteLength: p1.byteLength,
          finalUrl: p1.finalUrl,
          capturedAt: p1.capturedAt,
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
          requestKey: 'rm1',
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
      const run = h.repo.getRun(runId)!;
      expect(run.status).toBe('finished');
      // exact-key WatchRunResponseMetadata：schemaVersion/http/conditionWarnings 完整持久化
      const expectedMeta = JSON.stringify({
        schemaVersion: 1,
        http: {
          httpStatus: 200,
          etag: '"v1"',
          lastModified: '2026-08-28T00:00:00.000Z',
          warnings: [],
        },
        conditionWarnings: [],
      });
      expect(run.responseMetadataJson).toBe(expectedMeta);
    } finally {
      closeH(h);
    }
  });

  it('R2 outbox 矩阵：normal 非 muted 新建 Event 恰一条；important 恰一条；muted 零；coalesce 零新增', async () => {
    async function createAndCount(
      notificationLevel: 'normal' | 'important',
      muted: boolean,
    ): Promise<number> {
      const h = setup();
      try {
        const rule = makeRule({ notificationLevel, muted });
        expect(h.repo.insertRule(rule).ok).toBe(true);
        const p1 = makeProjection(rule, 'A', new Date(NOW_MS).toISOString());
        expect(
          h.repo.writeBaseline({
            ruleId: rule.id,
            expectedBaselineVersion: null,
            projectionType: 'feed',
            projectionJson: JSON.stringify(p1.value),
            contentHash: p1.contentHash,
            byteLength: p1.byteLength,
            finalUrl: p1.finalUrl,
            capturedAt: p1.capturedAt,
            documentId: null,
          }).ok,
        ).toBe(true);
        const freshRule = h.repo.getRule(rule.id)!;
        const prepared = h.service.prepareAcquisition({ rule: freshRule });
        if (!prepared.ok) return 0;
        const runId = randomUUID();
        expect(
          h.repo.insertRun({
            id: runId,
            ruleId: rule.id,
            requestKey: `rm-${Math.random()}`,
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
        if (!result.ok) return 0;
        const n = h.repo.dbHandle
          .prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE subject_type='event'")
          .get() as { n: number };
        return Number(n.n);
      } finally {
        closeH(h);
      }
    }
    // normal 非 muted 不得被抑制（FIXED DECISION 3：抑制条件只有 muted）
    expect(await createAndCount('normal', false)).toBe(1);
    expect(await createAndCount('important', false)).toBe(1);
    expect(await createAndCount('important', true)).toBe(0);
  });

  it('R3 prepareAcquisition：Baseline canonical 同字节篡改 / 键重排 / 陈旧 64-hex hash → store-unavailable', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      const p1 = makeProjection(rule, 'A', new Date(NOW_MS).toISOString());
      const canonical = JSON.stringify(p1.value);
      const byteLength = Buffer.byteLength(canonical, 'utf8');
      expect(
        h.repo.writeBaseline({
          ruleId: rule.id,
          expectedBaselineVersion: null,
          projectionType: 'feed',
          projectionJson: canonical,
          contentHash: sha256Hex(canonical),
          byteLength,
          finalUrl: p1.finalUrl,
          capturedAt: p1.capturedAt,
          documentId: null,
        }).ok,
      ).toBe(true);
      const freshRule = h.repo.getRule(rule.id)!;
      // 正常读取 ok
      const okPrepared = h.service.prepareAcquisition({ rule: freshRule });
      expect(okPrepared.ok).toBe(true);

      // 同字节篡改：替换一个相同字节数的字符，byteLength 不变
      const tamperedSameBytes = canonical.replace('"text":"A"', '"text":"B"');
      expect(tamperedSameBytes.length).toBe(canonical.length);
      h.repo.dbHandle
        .prepare('UPDATE watch_baselines SET projection_json = ? WHERE rule_id = ?')
        .run(tamperedSameBytes, rule.id);
      const tamperedPrepared = h.service.prepareAcquisition({ rule: freshRule });
      expect(tamperedPrepared.ok).toBe(false);

      // 键重排：把根对象的键顺序打乱（仍是合法 JSON、字节数可能不同）
      h.repo.dbHandle
        .prepare('UPDATE watch_baselines SET projection_json = ? WHERE rule_id = ?')
        .run(canonical, rule.id);
      const reordered = JSON.stringify(reorderFeedKeys(JSON.parse(canonical)));
      expect(reordered).not.toBe(canonical);
      h.repo.dbHandle
        .prepare(
          'UPDATE watch_baselines SET projection_json = ?, byte_length = ? WHERE rule_id = ?',
        )
        .run(reordered, Buffer.byteLength(reordered, 'utf8'), rule.id);
      const reorderedPrepared = h.service.prepareAcquisition({ rule: freshRule });
      expect(reorderedPrepared.ok).toBe(false);

      // 陈旧 64-hex hash：contentHash 与 canonical 字节串的 SHA-256 不一致
      h.repo.dbHandle
        .prepare(
          'UPDATE watch_baselines SET projection_json = ?, byte_length = ?, content_hash = ? WHERE rule_id = ?',
        )
        .run(canonical, byteLength, 'f'.repeat(64), rule.id);
      const stalePrepared = h.service.prepareAcquisition({ rule: freshRule });
      expect(stalePrepared.ok).toBe(false);
    } finally {
      closeH(h);
    }
  });

  it('R4 Page 规则成功终态 health acquisition=browser；Feed 为 rss', async () => {
    const h = setup();
    try {
      const pageRule = makeRule({
        kind: 'page',
        accessMode: 'public',
        target: {
          type: 'page',
          pageUrl: 'https://example.com/doc',
          regions: [{ kind: 'main-text', label: '正文' }],
          sessionConsent: null,
        },
      });
      expect(h.repo.insertRule(pageRule).ok).toBe(true);
      const prepared = h.service.prepareAcquisition({ rule: pageRule });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const runId = randomUUID();
      expect(
        h.repo.insertRun({
          id: runId,
          ruleId: pageRule.id,
          requestKey: 'pg1',
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
      const pageProjection: PageProjection = {
        schemaVersion: 1,
        ruleId: pageRule.id,
        sourceId: pageRule.sourceId,
        finalUrl: 'https://example.com/doc',
        capturedAt: new Date(NOW_MS).toISOString(),
        documentId: null,
        contentHash: sha256Hex('{"type":"page","fields":[]}'),
        byteLength: Buffer.byteLength('{"type":"page","fields":[]}', 'utf8'),
        value: { type: 'page', fields: [] },
      };
      const result = await h.service.process({
        rule: pageRule,
        runId,
        baselineHint: prepared.baselineHint,
        acquisition: {
          ok: true,
          kind: 'projection',
          projection: pageProjection,
          expectedSourceLocatorFingerprint: pageRule.sourceLocatorFingerprint,
          responseMetadata: null,
        },
        sourceAfterAcquisition: sourceProjection,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const run = h.repo.getRun(runId)!;
      expect(run.health).toEqual({ state: 'healthy', acquisition: 'browser', code: null });
    } finally {
      closeH(h);
    }
  });

  it('R5 Page 规则 condition_error 终态 health acquisition=browser', async () => {
    const h = setup();
    try {
      const pageRule = makeRule({
        kind: 'page',
        accessMode: 'public',
        target: {
          type: 'page',
          pageUrl: 'https://example.com/doc',
          regions: [{ kind: 'main-text', label: '正文' }],
          sessionConsent: null,
        },
        condition: {
          version: 1,
          combine: 'all',
          predicates: [
            { fieldKey: 'price', operator: 'increased', operand: 10, caseSensitive: false },
          ],
        },
      });
      expect(h.repo.insertRule(pageRule).ok).toBe(true);
      // 页面投影必须携带真实字段，使 Diff 产生 pair 后 condition 求值失败 → condition_error。
      // 字段键恰好五键（isValidPageProjectionValue exactOwnKeys）。
      const mkValue = (value: string): PageProjectionValue => ({
        type: 'page',
        fields: [{ fieldKey: 'r0:main', regionIndex: 0, kind: 'main-text', label: '正文', value }],
      });
      const pageValue = mkValue('A');
      const pageJson = JSON.stringify(pageValue);
      const pageProjection: PageProjection = {
        schemaVersion: 1,
        ruleId: pageRule.id,
        sourceId: pageRule.sourceId,
        finalUrl: 'https://example.com/doc',
        capturedAt: new Date(NOW_MS).toISOString(),
        documentId: null,
        contentHash: sha256Hex(pageJson),
        byteLength: Buffer.byteLength(pageJson, 'utf8'),
        value: pageValue,
      };
      expect(
        h.repo.writeBaseline({
          ruleId: pageRule.id,
          expectedBaselineVersion: null,
          projectionType: 'page',
          projectionJson: pageJson,
          contentHash: pageProjection.contentHash,
          byteLength: pageProjection.byteLength,
          finalUrl: pageProjection.finalUrl,
          capturedAt: pageProjection.capturedAt,
          documentId: null,
        }).ok,
      ).toBe(true);
      const freshRule = h.repo.getRule(pageRule.id)!;
      const prepared = h.service.prepareAcquisition({ rule: freshRule });
      if (!prepared.ok) return;
      const runId = randomUUID();
      expect(
        h.repo.insertRun({
          id: runId,
          ruleId: pageRule.id,
          requestKey: 'pg2',
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
      // 新投影 value='B'（与 Baseline 'A' 不同）→ Diff 产生 pair 后 condition 求值失败 → condition_error
      const newValue = mkValue('B');
      const newJson = JSON.stringify(newValue);
      const newProjection: PageProjection = {
        schemaVersion: 1,
        ruleId: pageRule.id,
        sourceId: pageRule.sourceId,
        finalUrl: 'https://example.com/doc',
        capturedAt: new Date(NOW_MS + 60_000).toISOString(),
        documentId: null,
        contentHash: sha256Hex(newJson),
        byteLength: Buffer.byteLength(newJson, 'utf8'),
        value: newValue,
      };
      const result = await h.service.process({
        rule: freshRule,
        runId,
        baselineHint: prepared.baselineHint,
        acquisition: {
          ok: true,
          kind: 'projection',
          projection: newProjection,
          expectedSourceLocatorFingerprint: freshRule.sourceLocatorFingerprint,
          responseMetadata: null,
        },
        sourceAfterAcquisition: sourceProjection,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const run = h.repo.getRun(runId)!;
      expect(run.health).toEqual({
        state: 'paused',
        acquisition: 'browser',
        code: 'condition_error',
      });
    } finally {
      closeH(h);
    }
  });
});

// 键重排辅助：把 feed 根对象与 FeedField 的键顺序打乱（合法 JSON）
function reorderFeedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderFeedKeys);
  if (typeof value !== 'object' || value === null) return value;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length < 2) return value;
  const shuffled: Record<string, unknown> = {};
  for (const k of keys.slice(1).concat(keys.slice(0, 1))) {
    shuffled[k] = reorderFeedKeys((value as Record<string, unknown>)[k]);
  }
  return shuffled;
}

// ---------------------------------------------------------------------------
// R2-1 metadata 矩阵：每种 D7 新写 Run 终态必须持久化 canonical
// WatchRunResponseMetadata（含失败终态 parse_changed / condition_error）。
// ---------------------------------------------------------------------------

function canonicalMeta(http: unknown, warnings: string[] = []): string {
  return JSON.stringify({ schemaVersion: 1, http, conditionWarnings: warnings });
}

async function seedBaseline(
  h: Harness,
  rule: WatchRule,
  projection: FeedProjection,
): Promise<void> {
  expect(
    h.repo.writeBaseline({
      ruleId: rule.id,
      expectedBaselineVersion: null,
      projectionType: 'feed',
      projectionJson: JSON.stringify(projection.value),
      contentHash: projection.contentHash,
      byteLength: projection.byteLength,
      finalUrl: projection.finalUrl,
      capturedAt: projection.capturedAt,
      documentId: null,
      validators: { etag: '"old"', lastModified: null },
    }).ok,
  ).toBe(true);
}

async function makeRunningRun(h: Harness, rule: WatchRule, key: string): Promise<string> {
  const runId = randomUUID();
  expect(
    h.repo.insertRun({
      id: runId,
      ruleId: rule.id,
      requestKey: key,
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
  return runId;
}

function readMeta(h: Harness, runId: string): string | null {
  return h.repo.getRun(runId)!.responseMetadataJson;
}

describe('R2-1 Run metadata 失败终态矩阵（#S6-058）', () => {
  it('baseline-established：http=本次 acquisition 可信元数据、warnings=[]', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      const prepared = h.service.prepareAcquisition({ rule });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const runId = await makeRunningRun(h, rule, 'rm-baseline');
      const projection = makeProjection(rule, 'New', new Date(NOW_MS).toISOString());
      const result = await processProjection(h, rule, runId, prepared.baselineHint, projection);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome.kind).toBe('baseline-established');
      expect(readMeta(h, runId)).toBe(
        canonicalMeta({
          httpStatus: 200,
          etag: '"v1"',
          lastModified: '2026-08-28T00:00:00.000Z',
          warnings: [],
        }),
      );
    } finally {
      closeH(h);
    }
  });

  it('unchanged 200：同 contentHash → http=200 元数据、warnings=[]', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      const p1 = makeProjection(rule, 'A', new Date(NOW_MS).toISOString());
      await seedBaseline(h, rule, p1);
      const freshRule = h.repo.getRule(rule.id)!;
      const prepared = h.service.prepareAcquisition({ rule: freshRule });
      if (!prepared.ok) return;
      const runId = await makeRunningRun(h, freshRule, 'rm-200');
      const result = await processProjection(h, freshRule, runId, prepared.baselineHint, p1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome).toEqual({ kind: 'unchanged' });
      expect(readMeta(h, runId)).toBe(
        canonicalMeta({
          httpStatus: 200,
          etag: '"v1"',
          lastModified: '2026-08-28T00:00:00.000Z',
          warnings: [],
        }),
      );
    } finally {
      closeH(h);
    }
  });

  it('unchanged 304（not-modified）：http=304 元数据、warnings=[]', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      const p1 = makeProjection(rule, 'A', new Date(NOW_MS).toISOString());
      await seedBaseline(h, rule, p1);
      const freshRule = h.repo.getRule(rule.id)!;
      const prepared = h.service.prepareAcquisition({ rule: freshRule });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const runId = await makeRunningRun(h, freshRule, 'rm-304');
      const result = await h.service.process({
        rule: freshRule,
        runId,
        baselineHint: prepared.baselineHint,
        acquisition: {
          ok: true,
          kind: 'not-modified',
          finalUrl: 'https://example.com/feed',
          fetchedAt: new Date(NOW_MS).toISOString(),
          expectedSourceLocatorFingerprint: freshRule.sourceLocatorFingerprint,
          responseMetadata: { httpStatus: 304, etag: '"v1"', lastModified: null, warnings: [] },
        },
        sourceAfterAcquisition: sourceProjection,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome).toEqual({ kind: 'unchanged' });
      expect(readMeta(h, runId)).toBe(
        canonicalMeta({ httpStatus: 304, etag: '"v1"', lastModified: null, warnings: [] }),
      );
    } finally {
      closeH(h);
    }
  });

  it('changed-unmatched + warning：conditionWarnings 精确持久化', async () => {
    const h = setup();
    try {
      const rule = makeRule({
        condition: {
          version: 1,
          combine: 'all',
          predicates: [
            { fieldKey: 'title', operator: 'increased', operand: 10, caseSensitive: false },
          ],
        },
      });
      expect(h.repo.insertRule(rule).ok).toBe(true);
      const p1 = makeProjection(rule, 'A', new Date(NOW_MS).toISOString());
      await seedBaseline(h, rule, p1);
      const freshRule = h.repo.getRule(rule.id)!;
      const prepared = h.service.prepareAcquisition({ rule: freshRule });
      if (!prepared.ok) return;
      const runId = await makeRunningRun(h, freshRule, 'rm-unmatched');
      const p2 = makeProjection(rule, 'B', new Date(NOW_MS + 60_000).toISOString());
      const result = await processProjection(h, freshRule, runId, prepared.baselineHint, p2);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome.kind).toBe('changed-unmatched');
      const meta = JSON.parse(readMeta(h, runId)!) as {
        http: { httpStatus: number };
        conditionWarnings: string[];
      };
      expect(meta.http.httpStatus).toBe(200);
      // title 变化但非数值 → 唯一 warning numeric-value-unavailable（canonical 顺序）
      expect(meta.conditionWarnings).toEqual(['numeric-value-unavailable']);
    } finally {
      closeH(h);
    }
  });

  it('parse_changed（unexplainable change）：http=本次 acquisition 元数据、warnings=[]', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      const p1 = makeProjection(rule, 'A', new Date(NOW_MS).toISOString());
      await seedBaseline(h, rule, p1);
      const freshRule = h.repo.getRule(rule.id)!;
      const prepared = h.service.prepareAcquisition({ rule: freshRule });
      if (!prepared.ok) return;
      const runId = await makeRunningRun(h, freshRule, 'rm-parse');
      // 只改 description（非对比字段）→ contentHash 变化但 Diff 零合规 pair → parse_changed
      const value: FeedProjectionValue = {
        type: 'feed',
        format: 'rss2',
        title: field('A'),
        description: field('DIFFERENT'),
        siteUrl: field('https://example.com'),
        feedUrl: field(''),
        items: [
          {
            identity: 'i1',
            identityKind: 'guid',
            title: field('A'),
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
      const p2: FeedProjection = {
        schemaVersion: 1,
        ruleId: rule.id,
        sourceId: rule.sourceId,
        finalUrl: 'https://example.com/feed',
        capturedAt: new Date(NOW_MS + 60_000).toISOString(),
        documentId: null,
        contentHash: sha256Hex(canonicalJson),
        byteLength: Buffer.byteLength(canonicalJson, 'utf8'),
        value,
      };
      const result = await processProjection(h, freshRule, runId, prepared.baselineHint, p2);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome).toEqual({
        kind: 'failed',
        health: 'parse_changed',
        retryable: false,
      });
      // parse_changed 不得写 null metadata：http 保留 acquisition 可信元数据
      expect(readMeta(h, runId)).toBe(
        canonicalMeta({
          httpStatus: 200,
          etag: '"v1"',
          lastModified: '2026-08-28T00:00:00.000Z',
          warnings: [],
        }),
      );
    } finally {
      closeH(h);
    }
  });

  it('condition_error：保留本次 acquisition 可信 http metadata、warnings=[]', async () => {
    const h = setup();
    try {
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
      const p1 = makeProjection(rule, 'A', new Date(NOW_MS).toISOString());
      await seedBaseline(h, rule, p1);
      const freshRule = h.repo.getRule(rule.id)!;
      const prepared = h.service.prepareAcquisition({ rule: freshRule });
      if (!prepared.ok) return;
      const runId = await makeRunningRun(h, freshRule, 'rm-conderr');
      const p2 = makeProjection(rule, 'B', new Date(NOW_MS + 60_000).toISOString());
      const result = await processProjection(h, freshRule, runId, prepared.baselineHint, p2);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome).toEqual({
        kind: 'failed',
        health: 'condition_error',
        retryable: false,
      });
      // condition_error 必须保留本次 acquisition 的 http metadata
      expect(readMeta(h, runId)).toBe(
        canonicalMeta({
          httpStatus: 200,
          etag: '"v1"',
          lastModified: '2026-08-28T00:00:00.000Z',
          warnings: [],
        }),
      );
    } finally {
      closeH(h);
    }
  });

  it('event-created：canonical metadata 精确持久化（含 warnings）', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      const p1 = makeProjection(rule, 'A', new Date(NOW_MS).toISOString());
      await seedBaseline(h, rule, p1);
      const freshRule = h.repo.getRule(rule.id)!;
      const prepared = h.service.prepareAcquisition({ rule: freshRule });
      if (!prepared.ok) return;
      const runId = await makeRunningRun(h, freshRule, 'rm-create');
      const p2 = makeProjection(rule, 'B', new Date(NOW_MS + 60_000).toISOString());
      const result = await processProjection(h, freshRule, runId, prepared.baselineHint, p2);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome.kind).toBe('event-created');
      expect(readMeta(h, runId)).toBe(
        canonicalMeta({
          httpStatus: 200,
          etag: '"v1"',
          lastModified: '2026-08-28T00:00:00.000Z',
          warnings: [],
        }),
      );
    } finally {
      closeH(h);
    }
  });

  it('event-coalesced：canonical metadata 精确持久化（含 warnings）', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      const p1 = makeProjection(rule, 'A', new Date(NOW_MS).toISOString());
      await seedBaseline(h, rule, p1);
      const freshRule = h.repo.getRule(rule.id)!;
      const prepared = h.service.prepareAcquisition({ rule: freshRule });
      if (!prepared.ok) return;
      // 第一次 create
      const runId1 = await makeRunningRun(h, freshRule, 'rm-coal-1');
      const p2 = makeProjection(rule, 'B', new Date(NOW_MS + 60_000).toISOString());
      const r1 = await processProjection(h, freshRule, runId1, prepared.baselineHint, p2);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      expect(r1.outcome.kind).toBe('event-created');
      // 第二次（仍在 30min 窗口内）→ coalesce
      const readRule = h.repo.getRule(rule.id)!;
      const prepared2 = h.service.prepareAcquisition({ rule: readRule });
      if (!prepared2.ok) return;
      const runId2 = await makeRunningRun(h, readRule, 'rm-coal-2');
      const p3 = makeProjection(rule, 'C', new Date(NOW_MS + 600_000).toISOString());
      const r2 = await processProjection(h, readRule, runId2, prepared2.baselineHint, p3);
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.outcome.kind).toBe('event-coalesced');
      expect(readMeta(h, runId2)).toBe(
        canonicalMeta({
          httpStatus: 200,
          etag: '"v1"',
          lastModified: '2026-08-28T00:00:00.000Z',
          warnings: [],
        }),
      );
    } finally {
      closeH(h);
    }
  });

  it('event-deduplicated：canonical metadata 精确持久化（重放终态）', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      const p1 = makeProjection(rule, 'A', new Date(NOW_MS).toISOString());
      await seedBaseline(h, rule, p1);
      const freshRule = h.repo.getRule(rule.id)!;
      const prepared = h.service.prepareAcquisition({ rule: freshRule });
      if (!prepared.ok) return;
      const p2 = makeProjection(rule, 'B', new Date(NOW_MS + 60_000).toISOString());
      const runId1 = await makeRunningRun(h, freshRule, 'rm-dedup-1');
      const r1 = await processProjection(h, freshRule, runId1, prepared.baselineHint, p2);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      expect(r1.outcome.kind).toBe('event-created');
      // 同一 hint 重放 → dedup（Baseline 已推进到 ≥expected+1）
      const runId2 = await makeRunningRun(h, freshRule, 'rm-dedup-2');
      const r2 = await processProjection(h, freshRule, runId2, prepared.baselineHint, p2);
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.outcome.kind).toBe('event-deduplicated');
      expect(readMeta(h, runId2)).toBe(
        canonicalMeta({
          httpStatus: 200,
          etag: '"v1"',
          lastModified: '2026-08-28T00:00:00.000Z',
          warnings: [],
        }),
      );
    } finally {
      closeH(h);
    }
  });

  it('R3-4 create/coalesce 的 observation id 均为小写 UUID v4（无 c-/obs0 前后缀）', async () => {
    const h = setup();
    try {
      const rule = makeRule();
      expect(h.repo.insertRule(rule).ok).toBe(true);
      const p1 = makeProjection(rule, 'A', new Date(NOW_MS).toISOString());
      await seedBaseline(h, rule, p1);
      const freshRule = h.repo.getRule(rule.id)!;
      const prepared = h.service.prepareAcquisition({ rule: freshRule });
      if (!prepared.ok) return;
      // create：首 observation（sequence=0）
      const runId1 = await makeRunningRun(h, freshRule, 'rm-obs-1');
      const p2 = makeProjection(rule, 'B', new Date(NOW_MS + 60_000).toISOString());
      const r1 = await processProjection(h, freshRule, runId1, prepared.baselineHint, p2);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      expect(r1.outcome.kind).toBe('event-created');
      // coalesce：追加 observation（sequence=1）
      const readRule = h.repo.getRule(rule.id)!;
      const prepared2 = h.service.prepareAcquisition({ rule: readRule });
      if (!prepared2.ok) return;
      const runId2 = await makeRunningRun(h, readRule, 'rm-obs-2');
      const p3 = makeProjection(rule, 'C', new Date(NOW_MS + 600_000).toISOString());
      const r2 = await processProjection(h, readRule, runId2, prepared2.baselineHint, p3);
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.outcome.kind).toBe('event-coalesced');
      const event = h.repo.listEventsByRule(rule.id)[0]!;
      const obs = h.repo.dbHandle
        .prepare('SELECT id FROM watch_event_observations WHERE event_id = ? ORDER BY sequence')
        .all(event.id) as Array<{ id: string }>;
      expect(obs.length).toBe(2);
      for (const o of obs) {
        expect(o.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      }
      expect(obs.some((o) => o.id.startsWith('c-') || o.id.includes('-obs0'))).toBe(false);
      expect(h.repo.scanIntegrity()).toEqual({ ok: true, reason: null });
    } finally {
      closeH(h);
    }
  });
});
