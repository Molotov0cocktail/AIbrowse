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
import { runMigrations as runSourceMigrations } from './sources/db/migrations';
import { SourceServiceImpl } from './sources/source-service';
import { runWatchMigrations } from './watch/db/watch-migrations';
import { DigestService } from './watch/digest-service';
import { WatchRepository } from './watch/repository/watch-repository';

function assertDigest(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`D8 Digest 冒烟失败：${message}`);
}

export async function runWatchDigestSmokeScenario(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'aibrowse-smoke-watch-digest-'));
  const handle = openDb(join(dir, 'watch.db'));
  const sourceHandle = openDb(join(dir, 'sources.db'));
  runWatchMigrations(handle);
  runSourceMigrations(sourceHandle);
  const repo = new WatchRepository(handle);
  const sources = new SourceServiceImpl({ db: sourceHandle });
  const now = '2026-08-31T01:00:00.000Z';
  const fingerprint = 'a'.repeat(64);
  try {
    const added = await sources.addManual({
      scope: 'page',
      url: 'https://example.com',
      name: 'Smoke',
      shareMode: 'full',
      userNote: 'DIGEST_SMOKE_NOTE_CANARY',
    });
    assertDigest(added.ok, 'Source 创建');
    if (!added.ok) return;
    const sourceId = added.source.id;
    const raw = '{"sections":[{"eventIds":["event-smoke"],"explanation":"变化已确认"}]}';
    const fake = new FakeProvider({ chunks: [raw] });
    const digestClock = new FakeClock(Date.parse('2026-08-30T02:00:00.000Z'));
    const service = new DigestService({
      repository: repo,
      clock: digestClock,
      sharing: {
        get: async (sourceIds) => {
          const result = sources.getDigestSharingProjections(sourceIds);
          return result.status === 'ok' ? result.projections : [];
        },
      },
      provider: { resolve: async () => ({ provider: fake, model: 'fake' }) },
      membership: {
        resolve: async (selector) => sources.resolveDigestMembership(selector),
      },
    });
    assertDigest(
      (
        await service.createSchedule({
          id: 'digest-smoke',
          selector: { sourceIds: [sourceId] },
          localTime: '09:00',
          timeZone: 'Asia/Shanghai',
          aiEnabled: true,
        })
      ).ok,
      'schedule 创建',
    );
    const createdSchedule = repo.getDigestSchedule('digest-smoke');
    assertDigest(createdSchedule !== null, 'schedule 读回');
    assertDigest(createdSchedule.nextDueAt === now, '生产成员装配后的 due 计算');
    digestClock.advanceTo(Date.parse(now));
    const rule: WatchRule = {
      id: 'rule-smoke',
      sourceId,
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
    assertDigest(
      !JSON.stringify(fake.getLastRequest()).includes('DIGEST_SMOKE_NOTE_CANARY'),
      'ProviderRequest note canary 零字节',
    );
  } finally {
    repo.dispose();
    sources.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}
