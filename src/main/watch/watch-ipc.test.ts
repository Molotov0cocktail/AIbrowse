import { describe, expect, it, vi } from 'vitest';
import type { StructuredCondition, WatchRule } from '../../shared/types/watch';
import type { WatchRepository } from './repository/watch-repository';
import type { WatchRunCoordinator } from './watch-run-coordinator';
import type { WatchQueryService } from './watch-query-service';
import type { WatchExportService } from './watch-export-service';
import type { WatchPreviewService } from './watch-preview-service';
import type { WatchCommandService } from './watch-command-service';
import type { DigestService } from './digest-service';
import { WatchIpcAdapter } from './watch-ipc';

const RULE_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const condition: StructuredCondition = {
  version: 1,
  combine: 'all',
  predicates: [{ fieldKey: 'title', operator: 'contains', operand: '更新', caseSensitive: false }],
};

function rule(): WatchRule {
  return {
    id: RULE_ID,
    version: 1,
    sourceId: SOURCE_ID,
    kind: 'page',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'public',
    schedule: { kind: 'interval', intervalMinutes: 60 },
    target: {
      type: 'page',
      pageUrl: 'https://example.com',
      regions: [],
      sessionConsent: null,
    },
    condition,
    notificationLevel: 'normal',
    showDetails: false,
    sourceRowVersion: 1,
    sourceLocatorFingerprint: 'a'.repeat(64),
    nextDueAt: null,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 1,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
  };
}

function adapter(
  overrides: {
    repository?: WatchRepository | null;
    query?: WatchQueryService;
    preview?: WatchPreviewService;
    digest?: DigestService | null;
    resolveDigestSources?: () => Array<{ sourceId: string; displayName: string }> | null;
    audit?: (message: string) => void;
  } = {},
): WatchIpcAdapter {
  return new WatchIpcAdapter({
    repository: () => overrides.repository ?? null,
    coordinator: () => null as WatchRunCoordinator | null,
    query:
      overrides.query ??
      ({ status: () => ({ rawBody: 'must-not-cross' }) } as unknown as WatchQueryService),
    exporter: {} as WatchExportService,
    preview:
      overrides.preview ??
      ({
        previewPage: async () => ({
          ok: true,
          value: {
            previewHandle: 'a'.repeat(43),
            kind: 'page',
            accessMode: 'public',
            targetDisplay: 'example.com',
            fields: [],
            regions: [
              {
                kind: 'table',
                label: '表格候选',
                status: 'not-found',
                headerFingerprint: '0'.repeat(64),
                occurrence: 0,
                groups: [],
              },
            ],
          },
        }),
      } as unknown as WatchPreviewService),
    commands: {} as WatchCommandService,
    digest: () => overrides.digest ?? null,
    resolveDigestSources: overrides.resolveDigestSources ?? (() => null),
    audit: overrides.audit ?? (() => {}),
  });
}

describe('D9 WatchIpcAdapter fail-closed dispatch/audit', () => {
  it('settings 不允许借 condition 绕过 preview fieldCatalog', async () => {
    const update = vi.fn(() => ({ ok: true as const }));
    const repository = {
      getRule: () => rule(),
      updateRuleSettings: update,
    } as unknown as WatchRepository;
    const ipc = adapter({ repository });
    const base = {
      mode: 'settings',
      ruleId: RULE_ID,
      expectedVersion: 1,
      schedule: { kind: 'interval', intervalMinutes: 60 },
      notificationLevel: 'normal',
      showDetails: false,
    };
    await expect(
      ipc.invoke('watch:updateRule', {
        ...base,
        condition: {
          ...condition,
          predicates: [{ ...condition.predicates[0], fieldKey: 'unknown_field' }],
        },
      }),
    ).resolves.toEqual({ ok: false, errorCode: 'security-rejected' });
    expect(update).not.toHaveBeenCalled();
    await expect(ipc.invoke('watch:updateRule', { ...base, condition })).resolves.toEqual({
      ok: true,
      value: { updated: true },
    });
    expect(update).toHaveBeenCalledOnce();
  });

  it('输入和输出均 fail-closed，effectful read 只写结构化审计元数据', async () => {
    const audit = vi.fn();
    const ipc = adapter({ audit });
    await expect(ipc.invoke('watch:getRule', { ruleId: 'bad' })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid-payload',
    });
    await expect(ipc.invoke('watch:getStatus', {})).resolves.toEqual({
      ok: false,
      errorCode: 'unavailable',
    });
    await expect(
      ipc.invoke('watch:previewPageRegions', {
        sourceId: SOURCE_ID,
        accessMode: 'public',
        regions: [
          {
            kind: 'table',
            label: '表格候选',
            headerFingerprint: '0'.repeat(64),
            occurrence: 0,
          },
        ],
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: 'page', regions: [{ kind: 'table', groups: [] }] },
    });
    expect(audit).toHaveBeenCalledOnce();
    expect(audit.mock.calls[0]?.[0]).toMatch(
      /^watch-ipc kind=effectful-read channel=watch:previewPageRegions result=ok durationMs=\d+$/,
    );
  });

  it('dispose 后销毁冻结成员对应的 digest preview handle', async () => {
    const eventId = '33333333-3333-4333-8333-333333333333';
    const createSchedule = vi.fn(async () => ({ ok: true }));
    const digest = {
      preview: () => ({
        facts: {
          schemaVersion: 1,
          scheduleId: 'preview:schedule',
          digestRunId: 'preview:run',
          batchIndex: 0,
          period: {
            fromExclusive: '2026-08-30T00:00:00.000Z',
            toInclusive: '2026-08-31T00:00:00.000Z',
          },
          eventCount: 1,
          runStats: { changed: 1, failed: 0, unchanged: 0 },
          events: [
            {
              eventId,
              ruleId: RULE_ID,
              sourceId: SOURCE_ID,
              eventKind: 'changed',
              importance: 'normal',
              firstIncludedAt: '2026-08-31T00:00:00.000Z',
              lastIncludedAt: '2026-08-31T00:00:00.000Z',
              observationCount: 1,
              itemCount: 1,
            },
          ],
          evidenceMap: Object.create(null) as Record<string, never>,
          referenceStates: Object.assign(Object.create(null) as Record<string, string>, {
            [eventId]: 'expired',
          }),
          fetchedAt: '2026-08-31T00:00:00.000Z',
        },
        hasMore: false,
        nextPreviewSequence: 1,
      }),
      createSchedule,
    } as unknown as DigestService;
    const ipc = adapter({
      digest,
      resolveDigestSources: () => [{ sourceId: SOURCE_ID, displayName: '示例来源' }],
    });
    const preview = await ipc.invoke('watch:generateDigestPreview', {
      selector: { kind: 'sources', sourceIds: [SOURCE_ID] },
      afterSequence: 0,
      fromExclusive: '2026-08-30T00:00:00.000Z',
      toInclusive: '2026-08-31T00:00:00.000Z',
    });
    expect(preview).toMatchObject({ ok: true });
    if (!preview.ok) throw new Error('digest preview should succeed');
    expect(preview.value).toMatchObject({
      frozenMembers: [{ sourceId: SOURCE_ID, displayName: '示例来源' }],
    });
    const previewHandle = (preview.value as { previewHandle: string }).previewHandle;
    ipc.dispose();
    await expect(
      ipc.invoke('watch:saveDigestSchedule', {
        action: 'create',
        previewHandle,
        localTime: '09:00',
        timeZone: 'Asia/Shanghai',
        aiEnabled: false,
        confirmed: true,
      }),
    ).resolves.toEqual({ ok: false, errorCode: 'preview-expired' });
    expect(createSchedule).not.toHaveBeenCalled();
  });
});
