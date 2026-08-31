import { describe, expect, it, vi } from 'vitest';
import { computeSourceLocatorFingerprint } from '../../shared/watch/watch-rule-state';
import type { SourceWatchProjection } from '../../shared/types/watch';
import type { WatchRepository } from './repository/watch-repository';
import { WatchCommandService } from './watch-command-service';
import { WatchPreviewStore } from './watch-preview-store';

const source: SourceWatchProjection = {
  sourceId: '00000000-0000-4000-8000-000000000001',
  rowVersion: 1,
  enabled: true,
  deletedAt: null,
  scope: 'page',
  canonicalKey: 'https://example.com/doc',
};
const target = {
  type: 'page' as const,
  pageUrl: source.canonicalKey,
  regions: [{ kind: 'main-text' as const, label: '正文' }],
  sessionConsent: null,
};

describe('D9 WatchCommandService 预览目录绑定', () => {
  it('拒绝不在预览 fieldCatalog 的条件，且不触发持久化', () => {
    const store = new WatchPreviewStore();
    const createRuleWithBaseline = vi.fn(() => ({ ok: true as const }));
    const handle = store.issue({
      sourceId: source.sourceId,
      sourceRowVersion: source.rowVersion,
      locatorFingerprint: computeSourceLocatorFingerprint({
        sourceId: source.sourceId,
        scope: source.scope,
        canonicalKey: source.canonicalKey,
        kind: 'page',
        canonicalTargetUrl: target.pageUrl,
      }),
      finalOrigin: 'https://example.com',
      accessMode: 'public',
      target,
      projection: {
        schemaVersion: 1,
        contentHash: 'a'.repeat(64),
        byteLength: 1,
        finalUrl: target.pageUrl,
        capturedAt: '2026-08-31T00:00:00.000Z',
        documentId: null,
        value: { type: 'page', fields: [] },
      },
      fieldCatalog: ['r0:main'],
      validator: {},
    });
    expect(handle).not.toBeNull();
    const service = new WatchCommandService(
      store,
      () => ({ status: 'found', projection: source }),
      () => ({ createRuleWithBaseline }) as unknown as WatchRepository,
      () => null,
    );
    expect(
      service.create({
        previewHandle: handle!,
        sessionGrantHandle: null,
        schedule: { kind: 'interval', intervalMinutes: 60 },
        condition: {
          version: 1,
          combine: 'all',
          predicates: [
            {
              fieldKey: 'content',
              operator: 'contains',
              operand: '更新',
              caseSensitive: false,
            },
          ],
        },
        notificationLevel: 'normal',
        showDetails: false,
      }),
    ).toEqual({ ok: false, errorCode: 'security-rejected' });
    expect(createRuleWithBaseline).not.toHaveBeenCalled();
  });
});
