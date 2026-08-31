import { describe, expect, it } from 'vitest';
import type { WatchEvent, WatchRule } from '../../shared/types/watch';
import type { WatchRepository } from './repository/watch-repository';
import { WatchQueryService } from './watch-query-service';

const sourceId = '00000000-0000-4000-8000-000000000001';
const ruleId = '00000000-0000-4000-8000-000000000002';
const rule: WatchRule = {
  id: ruleId,
  version: 2,
  sourceId,
  kind: 'page',
  state: 'enabled',
  pauseReason: null,
  desiredEnabled: true,
  muted: false,
  accessMode: 'public',
  schedule: { kind: 'interval', intervalMinutes: 60 },
  target: {
    type: 'page',
    pageUrl: 'https://example.com/news?secret=1',
    regions: [{ kind: 'main-text', label: '正文' }],
    sessionConsent: null,
  },
  condition: null,
  notificationLevel: 'normal',
  showDetails: false,
  sourceRowVersion: 1,
  sourceLocatorFingerprint: 'fingerprint',
  nextDueAt: null,
  lastConsumedScheduledFor: null,
  lastDailyLocalDate: null,
  consecutiveFailures: 0,
  backoffUntil: null,
  baselineVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function event(id: string, observedAt: string): WatchEvent {
  return {
    id,
    ruleId,
    sourceId,
    eventKind: 'changed',
    importance: 'normal',
    idempotencyKey: `idem-${id}`,
    changeFingerprint: `fingerprint-${id}`,
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    itemCount: 1,
    readAt: null,
  };
}

describe('D9 renderer-safe Watch 查询投影', () => {
  it('使用安全 Source 名与真实活动时间，目标移除 query', () => {
    const repo = {
      listRules: () => [rule],
      getRuleActivity: () => ({
        lastCheckedAt: '2026-01-02T00:00:00.000Z',
        lastChangedAt: '2026-01-03T00:00:00.000Z',
      }),
    } as unknown as WatchRepository;
    const query = new WatchQueryService(
      () => repo,
      () => ({ mode: 'running', activeCount: 0 }),
      () => ({ windowsNotification: 'unavailable', windowsReason: 'not-packaged' }),
      () => '用户可见名称',
    );
    const result = query.listRules({
      page: 1,
      pageSize: 10,
      filter: { state: null, sourceId: null },
    });
    expect(result?.items[0]).toMatchObject({
      sourceName: '用户可见名称',
      targetDisplay: 'example.com/news',
      lastCheckedAt: '2026-01-02T00:00:00.000Z',
      lastChangedAt: '2026-01-03T00:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toContain('secret=1');
  });

  it('selected Event 属于过滤结果时即使不在当前页也返回只读详情', () => {
    const newer = event('00000000-0000-4000-8000-000000000003', '2026-01-03T00:00:00.000Z');
    const older = event('00000000-0000-4000-8000-000000000004', '2026-01-02T00:00:00.000Z');
    const repo = {
      listRules: () => [rule],
      listEventsByRule: () => [newer, older],
      listEventItems: () => [],
    } as unknown as WatchRepository;
    const query = new WatchQueryService(
      () => repo,
      () => ({ mode: 'running', activeCount: 0 }),
      () => ({ windowsNotification: 'unavailable', windowsReason: 'not-packaged' }),
    );
    const result = query.listEvents({
      page: 1,
      pageSize: 1,
      filter: {
        ruleId: null,
        sourceId: null,
        eventKind: null,
        importance: null,
        readState: 'all',
        fromInclusive: null,
        toExclusive: null,
      },
      selectedEventId: older.id,
    });
    expect(result?.items).toHaveLength(1);
    expect(result?.selected?.id).toBe(older.id);
    expect(result?.selected?.evidence).toEqual([]);
  });
});
