import { randomUUID } from 'node:crypto';
import type {
  FeedProjection,
  PageProjection,
  StructuredCondition,
  WatchNotificationLevel,
  WatchRule,
  WatchSchedule,
} from '../../shared/types/watch';
import type { SourceWatchProjectionReadResult } from '../sources/source-service';
import { computeSourceLocatorFingerprint } from '../../shared/watch/watch-rule-state';
import { validateStructuredCondition } from '../../shared/watch/condition-engine';
import { urlOrigin } from './page-projector';
import type { WatchRepository } from './repository/watch-repository';
import type { SessionGrantStore } from './session-grant-store';
import { WatchPreviewStore, type WatchPreviewRecord } from './watch-preview-store';

type CommandResult =
  | { ok: true; value: { ruleId: string; version: number } }
  | {
      ok: false;
      errorCode:
        | 'preview-expired'
        | 'consent-required'
        | 'conflict'
        | 'budget-exceeded'
        | 'security-rejected'
        | 'unavailable';
    };

export class WatchCommandService {
  constructor(
    private readonly store: WatchPreviewStore,
    private readonly source: (sourceId: string) => SourceWatchProjectionReadResult,
    private readonly repository: () => WatchRepository | null,
    private readonly grants: () => SessionGrantStore | null,
  ) {}

  create(input: {
    previewHandle: string;
    sessionGrantHandle: string | null;
    schedule: WatchSchedule;
    condition: StructuredCondition | null;
    notificationLevel: WatchNotificationLevel;
    showDetails: boolean;
  }): CommandResult {
    const preview = this.store.consume(input.previewHandle);
    if (preview === null) return { ok: false, errorCode: 'preview-expired' };
    const target = consentedTarget(preview, input.sessionGrantHandle, this.grants());
    if (target === null)
      return {
        ok: false,
        errorCode: preview.accessMode === 'session' ? 'consent-required' : 'security-rejected',
      };
    const current = this.source(preview.sourceId);
    if (current.status !== 'found')
      return { ok: false, errorCode: current.status === 'missing' ? 'conflict' : 'unavailable' };
    if (
      current.projection.rowVersion !== preview.sourceRowVersion ||
      locatorFingerprint(current.projection, preview.target) !== preview.locatorFingerprint
    )
      return { ok: false, errorCode: 'conflict' };
    const projection = readProjection(preview.projection);
    const repo = this.repository();
    if (projection === null || repo === null) return { ok: false, errorCode: 'unavailable' };
    if (!conditionMatchesPreview(input.condition, preview.fieldCatalog))
      return { ok: false, errorCode: 'security-rejected' };
    const now = new Date().toISOString();
    const rule: WatchRule = {
      id: randomUUID(),
      version: 1,
      sourceId: preview.sourceId,
      kind: target.type,
      state: 'enabled',
      pauseReason: null,
      desiredEnabled: true,
      muted: false,
      accessMode: preview.accessMode,
      schedule: input.schedule,
      target,
      condition: input.condition,
      notificationLevel: input.notificationLevel,
      showDetails: input.showDetails,
      sourceRowVersion: preview.sourceRowVersion,
      sourceLocatorFingerprint: preview.locatorFingerprint,
      nextDueAt: now,
      lastConsumedScheduledFor: null,
      lastDailyLocalDate: null,
      consecutiveFailures: 0,
      backoffUntil: null,
      baselineVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
    const validators = readValidators(preview.validator);
    const written = repo.createRuleWithBaseline({
      rule,
      baseline: {
        projectionType: projection.value.type === 'feed' ? 'feed' : 'page',
        projectionJson: JSON.stringify(projection.value),
        contentHash: projection.contentHash,
        byteLength: projection.byteLength,
        finalUrl: projection.finalUrl,
        capturedAt: projection.capturedAt,
        documentId: projection.documentId,
        validators,
      },
    });
    if (!written.ok)
      return {
        ok: false,
        errorCode:
          written.code === 'db-budget-exceeded' || written.code === 'baseline-budget-exceeded'
            ? 'budget-exceeded'
            : 'unavailable',
      };
    return { ok: true, value: { ruleId: rule.id, version: 1 } };
  }

  rebaseline(input: {
    ruleId: string;
    expectedVersion: number;
    previewHandle: string;
    sessionGrantHandle: string | null;
    schedule: WatchSchedule;
    condition: StructuredCondition | null;
    notificationLevel: WatchNotificationLevel;
    showDetails: boolean;
    resumeAfterConfirm: boolean;
  }): CommandResult {
    const preview = this.store.consume(input.previewHandle);
    if (preview === null) return { ok: false, errorCode: 'preview-expired' };
    const target = consentedTarget(preview, input.sessionGrantHandle, this.grants());
    if (target === null)
      return {
        ok: false,
        errorCode: preview.accessMode === 'session' ? 'consent-required' : 'security-rejected',
      };
    const current = this.source(preview.sourceId);
    if (
      current.status !== 'found' ||
      current.projection.rowVersion !== preview.sourceRowVersion ||
      locatorFingerprint(current.projection, target) !== preview.locatorFingerprint
    )
      return { ok: false, errorCode: 'conflict' };
    const projection = readProjection(preview.projection);
    const repo = this.repository();
    if (projection === null || repo === null) return { ok: false, errorCode: 'unavailable' };
    const existing = repo.getRule(input.ruleId);
    if (existing === null) return { ok: false, errorCode: 'conflict' };
    // A preview is Source-owned. Never allow a valid preview for Source B to replace the
    // target/baseline of a Rule that remains owned by Source A.
    if (existing.sourceId !== preview.sourceId) return { ok: false, errorCode: 'conflict' };
    if (!conditionMatchesPreview(input.condition, preview.fieldCatalog))
      return { ok: false, errorCode: 'security-rejected' };
    const written = repo.rebaselineRule({
      ruleId: input.ruleId,
      expectedVersion: input.expectedVersion,
      resumeAfterConfirm: input.resumeAfterConfirm,
      sourceRowVersion: preview.sourceRowVersion,
      sourceLocatorFingerprint: preview.locatorFingerprint,
      accessMode: preview.accessMode,
      target,
      schedule: input.schedule,
      condition: input.condition,
      notificationLevel: input.notificationLevel,
      showDetails: input.showDetails,
      nowIso: new Date().toISOString(),
      baseline: {
        projectionType: projection.value.type === 'feed' ? 'feed' : 'page',
        projectionJson: JSON.stringify(projection.value),
        contentHash: projection.contentHash,
        byteLength: projection.byteLength,
        finalUrl: projection.finalUrl,
        capturedAt: projection.capturedAt,
        documentId: projection.documentId,
        validators: readValidators(preview.validator),
      },
    });
    if (!written.ok)
      return {
        ok: false,
        errorCode:
          written.code === 'rule-version-conflict'
            ? 'conflict'
            : written.code === 'db-budget-exceeded' || written.code === 'baseline-budget-exceeded'
              ? 'budget-exceeded'
              : 'unavailable',
      };
    return { ok: true, value: { ruleId: input.ruleId, version: input.expectedVersion + 1 } };
  }
}

function conditionMatchesPreview(
  condition: StructuredCondition | null,
  fieldCatalog: readonly string[],
): boolean {
  return condition === null || validateStructuredCondition(condition, new Set(fieldCatalog)).ok;
}

function readProjection(value: unknown): FeedProjection | PageProjection | null {
  if (typeof value !== 'object' || value === null) return null;
  const p = value as Partial<FeedProjection | PageProjection>;
  return p.schemaVersion === 1 &&
    typeof p.contentHash === 'string' &&
    typeof p.byteLength === 'number' &&
    typeof p.finalUrl === 'string' &&
    typeof p.capturedAt === 'string' &&
    typeof p.value === 'object' &&
    p.value !== null
    ? (value as FeedProjection | PageProjection)
    : null;
}

function readValidators(value: unknown): { etag: string | null; lastModified: string | null } {
  if (typeof value !== 'object' || value === null) return { etag: null, lastModified: null };
  const v = value as { etag?: unknown; lastModified?: unknown };
  return {
    etag: typeof v.etag === 'string' ? v.etag : null,
    lastModified: typeof v.lastModified === 'string' ? v.lastModified : null,
  };
}

function consentedTarget(
  preview: WatchPreviewRecord,
  grantHandle: string | null,
  grants: SessionGrantStore | null,
): WatchRule['target'] | null {
  if (typeof preview.target !== 'object' || preview.target === null) return null;
  const target = preview.target as WatchRule['target'];
  if (preview.accessMode === 'public') return grantHandle === null ? target : null;
  if (
    target.type !== 'page' ||
    grantHandle === null ||
    grants === null ||
    preview.previewTabId === undefined
  )
    return null;
  const v = preview.validator;
  const digest =
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { targetDigest?: unknown }).targetDigest === 'string'
      ? (v as { targetDigest: string }).targetDigest
      : null;
  if (digest === null) return null;
  const consumed = grants.consume({
    handle: grantHandle,
    sourceId: preview.sourceId,
    previewTabId: preview.previewTabId,
    finalOrigin: preview.finalOrigin,
    targetDigest: digest,
  });
  if (!consumed.ok) return null;
  const targetOrigin = urlOrigin(target.pageUrl);
  const grantOrigin = consumed.grant.origin;
  if (
    targetOrigin === null ||
    grantOrigin === null ||
    targetOrigin !== preview.finalOrigin ||
    grantOrigin !== preview.finalOrigin
  )
    return null;
  return { ...target, sessionConsent: consumed.grant };
}

function locatorFingerprint(
  source: Extract<SourceWatchProjectionReadResult, { status: 'found' }>['projection'],
  rawTarget: unknown,
): string {
  if (typeof rawTarget !== 'object' || rawTarget === null) return '';
  const target = rawTarget as WatchRule['target'];
  if (target.type !== 'feed' && target.type !== 'page') return '';
  return computeSourceLocatorFingerprint({
    sourceId: source.sourceId,
    scope: source.scope,
    canonicalKey: source.canonicalKey,
    kind: target.type,
    canonicalTargetUrl: target.type === 'feed' ? target.feedUrl : target.pageUrl,
  });
}
