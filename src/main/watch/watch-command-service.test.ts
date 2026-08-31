import { describe, expect, it, vi } from 'vitest';
import { computeSourceLocatorFingerprint } from '../../shared/watch/watch-rule-state';
import type { SourceWatchProjection } from '../../shared/types/watch';
import type { WatchRepository } from './repository/watch-repository';
import { WatchCommandService } from './watch-command-service';
import { WatchPreviewStore } from './watch-preview-store';
import { SessionGrantStore } from './session-grant-store';
import { computeSessionTargetDigest } from './page-projector';

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

  it('拒绝用其他 Source 的有效预览重建既有 Rule', () => {
    const store = new WatchPreviewStore();
    const sourceB = { ...source, sourceId: '00000000-0000-4000-8000-000000000002' };
    const handle = store.issue({
      sourceId: sourceB.sourceId,
      sourceRowVersion: sourceB.rowVersion,
      locatorFingerprint: computeSourceLocatorFingerprint({
        sourceId: sourceB.sourceId,
        scope: sourceB.scope,
        canonicalKey: sourceB.canonicalKey,
        kind: 'page',
        canonicalTargetUrl: target.pageUrl,
      }),
      finalOrigin: 'https://example.com',
      accessMode: 'public',
      target,
      projection: {
        schemaVersion: 1,
        contentHash: 'b'.repeat(64),
        byteLength: 27,
        finalUrl: target.pageUrl,
        capturedAt: '2026-08-31T00:00:00.000Z',
        documentId: null,
        value: { type: 'page', fields: [] },
      },
      fieldCatalog: [],
      validator: {},
    });
    const rebaselineRule = vi.fn(() => ({ ok: true as const }));
    const service = new WatchCommandService(
      store,
      () => ({ status: 'found', projection: sourceB }),
      () =>
        ({
          getRule: () => ({ sourceId: source.sourceId }),
          rebaselineRule,
        }) as unknown as WatchRepository,
      () => null,
    );
    expect(
      service.rebaseline({
        ruleId: '11111111-1111-4111-8111-111111111111',
        expectedVersion: 1,
        previewHandle: handle!,
        sessionGrantHandle: null,
        schedule: { kind: 'interval', intervalMinutes: 60 },
        condition: null,
        notificationLevel: 'normal',
        showDetails: false,
        resumeAfterConfirm: true,
      }),
    ).toEqual({ ok: false, errorCode: 'conflict' });
    expect(rebaselineRule).not.toHaveBeenCalled();
  });

  it('即使 grant 绑定有效也拒绝 target origin 与预览最终 origin 不同的 Session 命令', () => {
    const store = new WatchPreviewStore();
    const grants = new SessionGrantStore();
    const mismatchedTarget = { ...target, pageUrl: 'https://evil.example/doc' };
    const targetDigest = computeSessionTargetDigest({
      accessMode: 'session',
      pageUrl: mismatchedTarget.pageUrl,
      regions: mismatchedTarget.regions,
    })!;
    const previewHandle = store.issue({
      sourceId: source.sourceId,
      sourceRowVersion: source.rowVersion,
      locatorFingerprint: computeSourceLocatorFingerprint({
        sourceId: source.sourceId,
        scope: source.scope,
        canonicalKey: source.canonicalKey,
        kind: 'page',
        canonicalTargetUrl: mismatchedTarget.pageUrl,
      }),
      finalOrigin: 'https://example.com',
      accessMode: 'session',
      target: mismatchedTarget,
      projection: {
        schemaVersion: 1,
        contentHash: 'c'.repeat(64),
        byteLength: 27,
        finalUrl: source.canonicalKey,
        capturedAt: '2026-08-31T00:00:00.000Z',
        documentId: null,
        value: { type: 'page', fields: [] },
      },
      fieldCatalog: [],
      validator: { targetDigest },
      previewTabId: 'tab-preview-1',
    })!;
    const issued = grants.issue({
      sourceId: source.sourceId,
      previewTabId: 'tab-preview-1',
      finalOrigin: 'https://example.com',
      targetDigest,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const persist = vi.fn();
    const service = new WatchCommandService(
      store,
      () => ({ status: 'found', projection: source }),
      () => ({ createRuleWithBaseline: persist }) as unknown as WatchRepository,
      () => grants,
    );
    expect(
      service.create({
        previewHandle,
        sessionGrantHandle: issued.handle,
        schedule: { kind: 'interval', intervalMinutes: 60 },
        condition: null,
        notificationLevel: 'normal',
        showDetails: false,
      }),
    ).toEqual({ ok: false, errorCode: 'consent-required' });
    expect(persist).not.toHaveBeenCalled();
  });
});
