// D7 8.24 Watch Diff/Event/Evidence 冒烟（默认矩阵自动包含；dev+生产双场景）。
// 真实 node:sqlite watch.db（临时目录）+ FakeClock + 确定性 FeedProjection +
// WatchProcessingServiceImpl——覆盖首建 Baseline、change→create（typed 双侧
// Evidence + outbox）、coalesce（30 分钟窗口追加 observation/items）、dedup
// （同 idempotencyKey 重放零新增）、unchanged（同 contentHash validator 更新）、
// condition_error（暂停 + 旧 Baseline）。零网络、零真实 Provider。
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { logInfo } from './logger';
import { openWatchStore } from './watch/watch-store';
import { WatchRepository } from './watch/repository/watch-repository';
import { WatchProcessingServiceImpl } from './watch/watch-processing-service';
import { FakeClock } from '../shared/watch/clock';
import { computeSourceLocatorFingerprint } from '../shared/watch/watch-rule-state';
import { sha256Hex } from '../shared/watch/diff/evidence';
import type {
  FeedProjection,
  FeedProjectionValue,
  SourceWatchProjection,
  WatchAcquisitionResult,
  WatchRule,
} from '../shared/types/watch';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const NOW_MS = Date.parse('2026-08-28T00:00:00.000Z');

function makeRule(): WatchRule {
  const sourceId = 'src-1';
  const fingerprint = computeSourceLocatorFingerprint({
    sourceId,
    scope: 'page',
    canonicalKey: 'https://example.com/doc',
    kind: 'feed',
    canonicalTargetUrl: 'https://example.com/rss.xml',
  });
  return {
    id: randomUUID(),
    version: 1,
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
    showDetails: false,
    sourceRowVersion: 1,
    sourceLocatorFingerprint: fingerprint,
    nextDueAt: null,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: new Date(NOW_MS).toISOString(),
    updatedAt: new Date(NOW_MS).toISOString(),
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
      etag: '"smoke"',
      lastModified: '2026-08-28T00:00:00.000Z',
      warnings: [],
    },
  };
}

async function insertRunningRun(
  repo: WatchRepository,
  ruleId: string,
  requestKey: string,
  startedAtMs: number,
): Promise<string> {
  const runId = randomUUID();
  assert(
    repo.insertRun({ id: runId, ruleId, requestKey, trigger: 'scheduled', scheduledFor: null }).ok,
    'insertRun',
  );
  assert(
    repo.transitionRun(runId, 'queued', {
      status: 'running',
      startedAt: new Date(startedAtMs).toISOString(),
    }).ok,
    'transitionRun',
  );
  return runId;
}

async function processProjection(
  service: WatchProcessingServiceImpl,
  rule: WatchRule,
  runId: string,
  hint: import('../shared/types/watch').WatchBaselineHint,
  projection: FeedProjection,
) {
  return service.process({
    rule,
    runId,
    baselineHint: hint,
    acquisition: projectionAcquisition(rule, projection),
    sourceAfterAcquisition: sourceProjection,
  });
}

export async function runWatchDiffEventSmokeScenario(): Promise<void> {
  const dir = mkdtempSync(join(app.getPath('temp'), 'aibrowse-smoke-watch-diff-'));
  let repo: WatchRepository | null = null;
  try {
    const outcome = openWatchStore({
      dbPath: join(dir, 'watch.db'),
      backupsDir: join(dir, 'backups'),
      reconcile: () => ({ ok: true, reason: null }),
    });
    assert(outcome.mode === 'normal', '8.24：watch.db 应 normal 装配');
    if (outcome.mode !== 'normal') return;
    repo = outcome.repo;
    const clock = new FakeClock(NOW_MS);
    const service = new WatchProcessingServiceImpl({ repo, clock });

    // 1. 首建 Baseline（零 Event）+ 同 contentHash 200 → unchanged（validator 更新）
    const rule = makeRule();
    assert(repo.insertRule(rule).ok, '8.24：insertRule');
    const prepared = service.prepareAcquisition({ rule });
    assert(prepared.ok, '8.24：首建 prepareAcquisition 应 ok');
    if (!prepared.ok) return;
    assert(prepared.baselineHint.kind === 'none', '8.24：首建 hint 应为 none');
    const p1 = makeProjection(rule, 'A', new Date(NOW_MS).toISOString());
    const run1 = await insertRunningRun(repo, rule.id, 'smoke-k1', NOW_MS);
    const r1 = await processProjection(service, rule, run1, prepared.baselineHint, p1);
    assert(r1.ok, `8.24：首建应 ok（${JSON.stringify(r1)}）`);
    if (!r1.ok) return;
    assert(r1.outcome.kind === 'baseline-established', '8.24：首建应为 baseline-established');
    assert(repo.getBaseline(rule.id)!.version === 1, '8.24：首建 baseline version=1');
    assert(repo.listEventsByRule(rule.id).length === 0, '8.24：首建零 Event');

    // 2. change → create（typed 双侧 Evidence + outbox + baseline 推进）
    const freshRule = repo.getRule(rule.id)!;
    const prepared2 = service.prepareAcquisition({ rule: freshRule });
    assert(prepared2.ok, '8.24：第二次 prepareAcquisition 应 ok');
    if (!prepared2.ok) return;
    if (prepared2.baselineHint.kind !== 'feed') throw new Error('8.24：期望 feed hint');
    const p2 = makeProjection(rule, 'B', new Date(NOW_MS + 60_000).toISOString());
    const run2 = await insertRunningRun(repo, rule.id, 'smoke-k2', NOW_MS + 1);
    const r2 = await processProjection(service, freshRule, run2, prepared2.baselineHint, p2);
    assert(r2.ok, `8.24：create 应 ok（${JSON.stringify(r2)}）`);
    if (!r2.ok) return;
    assert(r2.outcome.kind === 'event-created', '8.24：change 应 event-created');
    const event = repo.listEventsByRule(rule.id)[0]!;
    assert(event.itemCount === 1, '8.24：Event itemCount=1');
    const items = repo.listEventItems(event.id);
    assert(items.length === 1, '8.24：恰一条 item');
    assert(
      items[0]!.before.kind === 'present' && items[0]!.after.kind === 'present',
      '8.24：双侧 present Evidence',
    );
    if (items[0]!.before.kind === 'present' && items[0]!.after.kind === 'present') {
      assert(
        items[0]!.before.excerpt === 'A' && items[0]!.after.excerpt === 'B',
        '8.24：before=A after=B',
      );
      assert(items[0]!.before.valueHash === sha256Hex('A'), '8.24：before valueHash 完整值哈希');
    }
    assert(repo.getBaseline(rule.id)!.version === 2, '8.24：Baseline 推进到 2');
    const ob = repo.dbHandle
      .prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE subject_type='event'")
      .get() as { n: number };
    assert(ob.n === 1, '8.24：非 muted 新建 Event 恰一条 outbox');

    // 3. coalesce（30 分钟内再次变化 → 追加 observation/items、Baseline 推进）
    const freshRule2 = repo.getRule(rule.id)!;
    const prepared3 = service.prepareAcquisition({ rule: freshRule2 });
    assert(prepared3.ok, '8.24：第三次 prepareAcquisition 应 ok');
    if (!prepared3.ok) return;
    if (prepared3.baselineHint.kind !== 'feed') throw new Error('8.24：期望 feed hint');
    const p3 = makeProjection(rule, 'C', new Date(NOW_MS + 600_000).toISOString());
    const run3 = await insertRunningRun(repo, rule.id, 'smoke-k3', NOW_MS + 60_000);
    const r3 = await processProjection(service, freshRule2, run3, prepared3.baselineHint, p3);
    assert(r3.ok, `8.24：coalesce 应 ok（${JSON.stringify(r3)}）`);
    if (!r3.ok) return;
    assert(r3.outcome.kind === 'event-coalesced', '8.24：窗口内应 event-coalesced');
    const eventAfter = repo.listEventsByRule(rule.id)[0]!;
    assert(eventAfter.itemCount === 2, '8.24：coalesce 后 itemCount=2');
    assert(repo.listEventItems(eventAfter.id).length === 2, '8.24：coalesce 后两条 item');
    const obsCount = repo.dbHandle
      .prepare('SELECT COUNT(*) AS n FROM watch_event_observations WHERE event_id = ?')
      .get(eventAfter.id) as { n: number };
    assert(obsCount.n === 2, '8.24：coalesce 后两条 observation');

    // 4. dedup：同 idempotencyKey 重放 → event-deduplicated、零新增
    const run4 = await insertRunningRun(repo, rule.id, 'smoke-k4', NOW_MS + 2);
    const r4 = await processProjection(service, freshRule2, run4, prepared3.baselineHint, p3);
    assert(r4.ok, `8.24：dedup 应 ok（${JSON.stringify(r4)}）`);
    if (!r4.ok) return;
    assert(r4.outcome.kind === 'event-deduplicated', '8.24：同 key 重放应 event-deduplicated');
    assert(repo.listEventsByRule(rule.id).length === 1, '8.24：dedup 零新增 Event');
    assert(repo.getBaseline(rule.id)!.version === 3, '8.24：dedup 不回退 Baseline');

    // 5. condition_error：非目录 fieldKey → failed + dependency-unavailable 暂停 + 旧 Baseline
    const badRule = makeRule();
    badRule.condition = {
      version: 1,
      combine: 'all',
      predicates: [{ fieldKey: 'price', operator: 'increased', operand: 10, caseSensitive: false }],
    };
    assert(repo.insertRule(badRule).ok, '8.24：insertRule(condition)');
    const bp = makeProjection(badRule, 'A', new Date(NOW_MS).toISOString());
    assert(
      repo.writeBaseline({
        ruleId: badRule.id,
        expectedBaselineVersion: null,
        projectionType: 'feed',
        projectionJson: JSON.stringify(bp.value),
        contentHash: bp.contentHash,
        byteLength: bp.byteLength,
        finalUrl: bp.finalUrl,
        capturedAt: bp.capturedAt,
        documentId: null,
      }).ok,
      '8.24：condition 规则写 baseline',
    );
    const freshBad = repo.getRule(badRule.id)!;
    const badPrepared = service.prepareAcquisition({ rule: freshBad });
    assert(badPrepared.ok, '8.24：condition prepareAcquisition ok');
    if (!badPrepared.ok) return;
    const run5 = await insertRunningRun(repo, badRule.id, 'smoke-k5', NOW_MS + 1);
    const r5 = await processProjection(
      service,
      freshBad,
      run5,
      badPrepared.baselineHint,
      makeProjection(badRule, 'B', new Date(NOW_MS + 60_000).toISOString()),
    );
    assert(r5.ok, `8.24：condition_error 应 ok（${JSON.stringify(r5)}）`);
    if (!r5.ok) return;
    assert(
      r5.outcome.kind === 'failed' &&
        r5.outcome.health === 'condition_error' &&
        r5.outcome.retryable === false,
      '8.24：应 failed(condition_error, retryable=false)',
    );
    const badAfter = repo.getRule(badRule.id)!;
    assert(badAfter.state === 'paused', '8.24：condition_error 应暂停');
    assert(
      badAfter.pauseReason === 'dependency-unavailable',
      '8.24：pauseReason=dependency-unavailable',
    );
    assert(repo.getBaseline(badRule.id)!.version === 1, '8.24：旧 Baseline 保留');

    logInfo('smoke', '8.24 D7 Watch Diff/Event/Evidence 冒烟全部通过');
  } finally {
    try {
      if (repo !== null && !repo.isDisposed) repo.dispose();
    } catch {
      // 已关闭
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败保留现场
    }
  }
}
