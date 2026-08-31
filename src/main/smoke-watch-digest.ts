// D8 focused smoke: real node:sqlite v4 + journal/frozen cycle/artifact +
// FakeProvider claim/writeback. No network, IPC, renderer or notification.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FakeClock } from '../shared/watch/clock';
import type { ChangeEvidencePair, WatchRule } from '../shared/types/watch';
import { FakeProvider } from './ai/provider/fake-provider';
import { openDb } from './sources/db/sqlite-driver';
import { runWatchMigrations } from './watch/db/watch-migrations';
import { DigestService } from './watch/digest-service';
import { WatchRepository } from './watch/repository/watch-repository';

function assertDigest(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`D8 Digest 冒烟失败：${message}`);
}

export async function runWatchDigestSmokeScenario(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'aibrowse-smoke-watch-digest-'));
  const handle = openDb(join(dir, 'watch.db'));
  runWatchMigrations(handle);
  const repo = new WatchRepository(handle);
  const now = '2026-08-31T01:00:00.000Z';
  const fingerprint = 'a'.repeat(64);
  try {
    assertDigest(
      repo.createDigestSchedule({
        id: 'digest-smoke',
        sourceIds: ['source-smoke'],
        localTime: '09:00',
        timeZone: 'Asia/Shanghai',
        aiEnabled: true,
        nextDueAt: now,
        nowIso: '2026-08-30T00:00:00.000Z',
      }).ok,
      'schedule 创建',
    );
    const rule: WatchRule = {
      id: 'rule-smoke',
      sourceId: 'source-smoke',
      kind: 'feed',
      state: 'enabled',
      pauseReason: null,
      desiredEnabled: true,
      muted: false,
      accessMode: 'public',
      schedule: { kind: 'interval', intervalMinutes: 60 },
      target: { type: 'feed', feedUrl: 'https://example.com/feed', format: 'rss2' },
      condition: null,
      notificationLevel: 'normal',
      sourceRowVersion: 1,
      sourceLocatorFingerprint: fingerprint,
      nextDueAt: null,
      lastConsumedScheduledFor: null,
      lastDailyLocalDate: null,
      consecutiveFailures: 0,
      backoffUntil: null,
      baselineVersion: 0,
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    };
    assertDigest(repo.insertRule(rule).ok, 'Rule 创建');
    const evidence: ChangeEvidencePair = {
      itemId: 'item',
      fieldKey: 'title',
      label: '标题',
      before: { kind: 'absent' },
      after: {
        kind: 'present',
        excerpt: '变化',
        valueHash: fingerprint,
        normalizedBytes: 6,
        truncated: false,
      },
      beforeCapturedAt: now,
      afterCapturedAt: now,
      beforeFinalUrl: 'https://example.com/a',
      afterFinalUrl: 'https://example.com/a',
      beforeDocumentId: null,
      afterDocumentId: null,
      feedItemKey: null,
    };
    assertDigest(
      repo.writeEventTransaction({
        event: {
          id: 'event-smoke',
          ruleId: rule.id,
          sourceId: rule.sourceId,
          eventKind: 'added',
          importance: 'normal',
          idempotencyKey: randomUUID(),
          changeFingerprint: fingerprint,
          firstObservedAt: now,
          lastObservedAt: now,
          itemCount: 1,
          readAt: null,
        },
        items: [evidence],
        identity: {
          sourceId: rule.sourceId,
          expectedSourceLocatorFingerprint: fingerprint,
          expectedBaselineVersion: null,
        },
      }).ok,
      'Event/journal 原子写',
    );
    const raw = '{"sections":[{"eventIds":["event-smoke"],"explanation":"变化已确认"}]}';
    const fake = new FakeProvider({ chunks: [raw] });
    const service = new DigestService({
      repository: repo,
      clock: new FakeClock(Date.parse(now)),
      sharing: {
        get: async () => [
          {
            sourceId: rule.sourceId,
            shareMode: 'full',
            displayName: 'Smoke',
            canonicalUrl: 'https://example.com',
          },
        ],
      },
      provider: { resolve: async () => ({ provider: fake, model: 'fake' }) },
    });
    const result = await service.handleDue({
      scheduleId: 'digest-smoke',
      expectedNextDueAt: now,
      logicalDate: '2026-08-31',
    });
    assertDigest(result.ok, 'cycle 完成');
    const row = repo.listDigestArtifactsBySchedule('digest-smoke')[0];
    assertDigest(
      row?.providerState === 'succeeded' &&
        row.providerResultCode === 'success' &&
        row.explanationJson === raw,
      'claim/writeback',
    );
    assertDigest(
      fake.getRequests().length === 1 && fake.getLastRequest()?.tools === undefined,
      'Provider 恰一次且零 tools',
    );
  } finally {
    repo.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}
