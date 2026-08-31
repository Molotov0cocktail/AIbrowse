import { randomBytes, randomUUID } from 'node:crypto';
import type { BrowserController } from '../browser/browser-controller';
import type { SourceWatchProjectionReadResult } from '../sources/source-service';
import type { RegionDescriptor, WatchRule } from '../../shared/types/watch';
import { computeSourceLocatorFingerprint } from '../../shared/watch/watch-rule-state';
import type { WatchAcquisitionService } from './watch-acquisition-service';
import type { BrowserWatchReader } from './browser-watch-reader';
import {
  computeSessionTargetDigest,
  previewPageRegions,
  projectPageProjection,
  urlOrigin,
} from './page-projector';
import { WatchPreviewStore, type WatchPreviewRecord } from './watch-preview-store';
import type { SessionGrantStore } from './session-grant-store';
import type { TargetGatedClient } from './public-watch-http-client';
import { parseDiscoveryCandidates } from './feed-discovery';
import { readPublicHtml } from './public-html-sax-reader';
import { extractContentTypeCharset } from './text-encoding';

const TABLE_DISCOVERY_FINGERPRINT = '0'.repeat(64);

type PreviewResult =
  | { ok: true; value: Record<string, unknown> }
  | {
      ok: false;
      errorCode:
        'not-found' | 'security-rejected' | 'preview-expired' | 'unavailable' | 'budget-exceeded';
    };

export interface WatchPreviewServiceOptions {
  store: WatchPreviewStore;
  source: (sourceId: string) => SourceWatchProjectionReadResult;
  acquisition: () => WatchAcquisitionService | null;
  discoveryTarget: () => TargetGatedClient | null;
  browser: () => BrowserController | null;
  reader: () => BrowserWatchReader | null;
  grants: () => SessionGrantStore | null;
}

export class WatchPreviewService {
  constructor(private readonly options: WatchPreviewServiceOptions) {}

  async previewFeed(input: {
    mode: 'source' | 'manual' | 'candidate';
    sourceId?: string;
    feedUrl?: string;
    discoveryHandle?: string;
    candidateId?: string;
  }): Promise<PreviewResult> {
    const candidate =
      input.mode === 'candidate' &&
      input.discoveryHandle !== undefined &&
      input.candidateId !== undefined
        ? this.options.store.consumeDiscovery(input.discoveryHandle, input.candidateId)
        : null;
    const sourceId = input.mode === 'candidate' ? candidate?.sourceId : input.sourceId;
    if (sourceId === undefined)
      return {
        ok: false,
        errorCode: input.mode === 'candidate' ? 'preview-expired' : 'unavailable',
      };
    const source = this.options.source(sourceId);
    if (source.status !== 'found')
      return { ok: false, errorCode: source.status === 'missing' ? 'not-found' : 'unavailable' };
    const feedUrl =
      input.mode === 'manual'
        ? input.feedUrl!
        : input.mode === 'candidate'
          ? candidate!.feedUrl
          : source.projection.canonicalKey;
    const direct = await this.previewWithAcquisition(
      source.projection,
      { type: 'feed', feedUrl, format: 'rss2' },
      'public',
    );
    if (direct.result.ok || input.mode !== 'source' || !direct.discoveryEligible)
      return direct.result;
    return this.discoverFeedCandidates(source.projection);
  }

  async previewPage(input: {
    sourceId: string;
    accessMode: 'public' | 'session';
    regions: RegionDescriptor[];
  }): Promise<PreviewResult> {
    const source = this.options.source(input.sourceId);
    if (source.status !== 'found')
      return { ok: false, errorCode: source.status === 'missing' ? 'not-found' : 'unavailable' };
    if (
      input.regions.length === 1 &&
      input.regions[0]?.kind === 'table' &&
      input.regions[0].headerFingerprint === TABLE_DISCOVERY_FINGERPRINT &&
      input.regions[0].occurrence === 0
    )
      return this.discoverPageTables(source.projection, input.accessMode, input.regions);
    const target = {
      type: 'page' as const,
      pageUrl: source.projection.canonicalKey,
      regions: input.regions,
      sessionConsent: null,
    };
    if (input.accessMode === 'public')
      return (await this.previewWithAcquisition(source.projection, target, 'public')).result;
    const browser = this.options.browser();
    const reader = this.options.reader();
    const active = (await browser?.getActiveTab()) ?? null;
    if (
      browser === null ||
      reader === null ||
      active === null ||
      urlOrigin(active.url) !== urlOrigin(source.projection.canonicalKey)
    )
      return { ok: false, errorCode: 'security-rejected' };
    const abort = new AbortController();
    const read = await reader.read({
      tabId: active.id,
      signal: abort.signal,
      deadline: new Date(Date.now() + 30_000),
    });
    if (!read.ok)
      return {
        ok: false,
        errorCode: read.code === 'timeout' ? 'unavailable' : 'security-rejected',
      };
    const finalOrigin = urlOrigin(read.meta.url);
    // Re-check after the asynchronous read: the active tab may have navigated while the
    // main process was collecting channels.
    if (finalOrigin === null || !hasSameHttpOrigin(source.projection.canonicalKey, read.meta.url))
      return { ok: false, errorCode: 'security-rejected' };
    const regionPreview = previewPageRegions(read.channels, input.regions);
    if (!regionPreview.ok)
      return {
        ok: false,
        errorCode: regionPreview.health === 'budget_exceeded' ? 'budget-exceeded' : 'unavailable',
      };
    const projection = projectPageProjection({
      channels: read.channels,
      regions: input.regions,
      ruleId: randomUUID(),
      sourceId: source.projection.sourceId,
      finalUrl: read.meta.url,
      capturedAt: read.meta.capturedAt,
      documentId: read.meta.documentId,
    });
    if (!projection.ok)
      return {
        ok: false,
        errorCode: projection.health === 'budget_exceeded' ? 'budget-exceeded' : 'unavailable',
      };
    const digest = computeSessionTargetDigest({
      accessMode: 'session',
      pageUrl: source.projection.canonicalKey,
      regions: input.regions,
    });
    if (digest === null) return { ok: false, errorCode: 'security-rejected' };
    const record: WatchPreviewRecord = {
      sourceId: source.projection.sourceId,
      sourceRowVersion: source.projection.rowVersion,
      locatorFingerprint: locatorFingerprint(source.projection, target),
      finalOrigin,
      accessMode: 'session',
      target,
      projection: projection.projection,
      fieldCatalog: projection.projection.value.fields.map((field) => field.fieldKey),
      validator: { etag: null, lastModified: null, targetDigest: digest },
      previewTabId: active.id,
    };
    const previewHandle = this.options.store.issue(record);
    if (previewHandle === null) return { ok: false, errorCode: 'budget-exceeded' };
    return {
      ok: true,
      value: {
        previewHandle,
        kind: 'page',
        accessMode: 'session',
        targetDisplay: safeDisplay(source.projection.canonicalKey),
        fields: record.fieldCatalog,
        regions: regionPreview.preview,
      },
    };
  }

  private async discoverPageTables(
    source: Extract<SourceWatchProjectionReadResult, { status: 'found' }>['projection'],
    accessMode: 'public' | 'session',
    regions: RegionDescriptor[],
  ): Promise<PreviewResult> {
    let channels: import('../../shared/types/watch').DocumentChannels;
    if (accessMode === 'public') {
      const target = this.options.discoveryTarget();
      if (target === null) return { ok: false, errorCode: 'unavailable' };
      const response = await target.get({
        url: source.canonicalKey,
        purpose: 'page',
        signal: new AbortController().signal,
        deadline: new Date(Date.now() + 30_000),
      });
      if (response.kind !== 'ok')
        return {
          ok: false,
          errorCode:
            response.kind === 'failed' && response.health === 'security_rejected'
              ? 'security-rejected'
              : response.kind === 'failed' && response.health === 'budget_exceeded'
                ? 'budget-exceeded'
                : 'unavailable',
        };
      const parsed = readPublicHtml(response.body, response.meta.finalUrl, {
        contentTypeCharset: extractContentTypeCharset(response.meta.contentType),
      });
      if (!parsed.ok)
        return {
          ok: false,
          errorCode:
            parsed.health === 'security_rejected'
              ? 'security-rejected'
              : parsed.health === 'budget_exceeded'
                ? 'budget-exceeded'
                : 'unavailable',
        };
      channels = parsed.channels;
    } else {
      const browser = this.options.browser();
      const reader = this.options.reader();
      const active = (await browser?.getActiveTab()) ?? null;
      if (
        browser === null ||
        reader === null ||
        active === null ||
        urlOrigin(active.url) !== urlOrigin(source.canonicalKey)
      )
        return { ok: false, errorCode: 'security-rejected' };
      const read = await reader.read({
        tabId: active.id,
        signal: new AbortController().signal,
        deadline: new Date(Date.now() + 30_000),
      });
      if (!read.ok) return { ok: false, errorCode: 'security-rejected' };
      if (!hasSameHttpOrigin(source.canonicalKey, read.meta.url))
        return { ok: false, errorCode: 'security-rejected' };
      channels = read.channels;
    }
    // Table-only documents legitimately have no mainText because table cell text is kept in the
    // dedicated table channel. Supply a non-persisted sentinel solely so the shared structural
    // validator can validate every other channel before deterministic candidate extraction.
    const discoveryChannels = channels.mainText === '' ? { ...channels, mainText: '_' } : channels;
    const discovered = previewPageRegions(discoveryChannels, regions);
    if (!discovered.ok) return { ok: false, errorCode: 'unavailable' };
    return {
      ok: true,
      value: {
        // Discovery previews are deliberately not entered into WatchPreviewStore. If a hostile
        // renderer tries to use this shape-only handle for create/rebaseline it fails closed.
        previewHandle: randomBytes(32).toString('base64url'),
        kind: 'page',
        accessMode,
        targetDisplay: safeDisplay(source.canonicalKey),
        fields: [],
        regions: discovered.preview,
      },
    };
  }

  issueSessionGrant(previewHandle: string): PreviewResult {
    const record = this.options.store.consume(previewHandle);
    if (record === null) return { ok: false, errorCode: 'preview-expired' };
    const targetDigest = readTargetDigest(record);
    const grants = this.options.grants();
    if (
      record.accessMode !== 'session' ||
      record.previewTabId === undefined ||
      targetDigest === null ||
      grants === null
    )
      return { ok: false, errorCode: 'security-rejected' };
    const issued = grants.issue({
      sourceId: record.sourceId,
      previewTabId: record.previewTabId,
      finalOrigin: record.finalOrigin,
      targetDigest,
    });
    if (!issued.ok) return { ok: false, errorCode: 'unavailable' };
    const reissuedHandle = this.options.store.issue(record);
    if (reissuedHandle === null) return { ok: false, errorCode: 'budget-exceeded' };
    return {
      ok: true,
      value: { previewHandle: reissuedHandle, sessionGrantHandle: issued.handle },
    };
  }

  private async previewWithAcquisition(
    source: Extract<SourceWatchProjectionReadResult, { status: 'found' }>['projection'],
    target: WatchRule['target'],
    accessMode: 'public',
  ): Promise<{ result: PreviewResult; discoveryEligible: boolean }> {
    const acquisition = this.options.acquisition();
    if (acquisition === null)
      return { result: { ok: false, errorCode: 'unavailable' }, discoveryEligible: false };
    const fingerprint = locatorFingerprint(source, target);
    const rule: WatchRule = {
      id: randomUUID(),
      version: 1,
      sourceId: source.sourceId,
      kind: target.type,
      state: 'enabled',
      pauseReason: null,
      desiredEnabled: true,
      muted: false,
      accessMode,
      schedule: { kind: 'interval', intervalMinutes: 60 },
      target,
      condition: null,
      notificationLevel: 'normal',
      showDetails: false,
      sourceRowVersion: source.rowVersion,
      sourceLocatorFingerprint: fingerprint,
      nextDueAt: null,
      lastConsumedScheduledFor: null,
      lastDailyLocalDate: null,
      consecutiveFailures: 0,
      backoffUntil: null,
      baselineVersion: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const abort = new AbortController();
    const acquired = await acquisition.run({
      rule,
      baselineHint: { kind: 'none', expectedBaselineVersion: 0 },
      signal: abort.signal,
      deadline: new Date(Date.now() + 30_000),
    });
    if (!acquired.ok || acquired.kind !== 'projection')
      return {
        result: {
          ok: false,
          errorCode: acquired.ok
            ? 'unavailable'
            : acquired.health === 'budget_exceeded'
              ? 'budget-exceeded'
              : acquired.health === 'security_rejected'
                ? 'security-rejected'
                : 'unavailable',
        },
        discoveryEligible:
          !acquired.ok && acquired.health === 'parse_changed' && acquired.disposition === 'parse',
      };
    const fields =
      acquired.projection.value.type === 'feed'
        ? ['title', 'link', 'summary', 'published']
        : acquired.projection.value.fields.map((field) => field.fieldKey);
    const record: WatchPreviewRecord = {
      sourceId: source.sourceId,
      sourceRowVersion: source.rowVersion,
      locatorFingerprint: fingerprint,
      finalOrigin: urlOrigin(acquired.projection.finalUrl) ?? '',
      accessMode,
      target,
      projection: acquired.projection,
      fieldCatalog: fields,
      validator: {
        etag: acquired.responseMetadata?.etag ?? null,
        lastModified: acquired.responseMetadata?.lastModified ?? null,
      },
    };
    if (record.finalOrigin === '')
      return {
        result: { ok: false, errorCode: 'security-rejected' },
        discoveryEligible: false,
      };
    const previewHandle = this.options.store.issue(record);
    if (previewHandle === null)
      return {
        result: { ok: false, errorCode: 'budget-exceeded' },
        discoveryEligible: false,
      };
    return {
      result: {
        ok: true,
        value: {
          previewHandle,
          kind: target.type,
          accessMode,
          targetDisplay: safeDisplay(acquired.projection.finalUrl),
          fields,
          ...(target.type === 'page' && acquired.projection.value.type === 'page'
            ? {
                regions: acquired.projection.value.fields.map((field) => ({
                  kind: field.kind,
                  label: field.label,
                  fieldKey: field.fieldKey,
                })),
              }
            : {}),
        },
      },
      discoveryEligible: false,
    };
  }

  private async discoverFeedCandidates(
    source: Extract<SourceWatchProjectionReadResult, { status: 'found' }>['projection'],
  ): Promise<PreviewResult> {
    const target = this.options.discoveryTarget();
    if (target === null) return { ok: false, errorCode: 'unavailable' };
    const response = await target.get({
      url: source.canonicalKey,
      purpose: 'discovery',
      signal: new AbortController().signal,
      deadline: new Date(Date.now() + 30_000),
    });
    if (response.kind !== 'ok')
      return {
        ok: false,
        errorCode:
          response.kind === 'failed' && response.health === 'security_rejected'
            ? 'security-rejected'
            : response.kind === 'failed' && response.health === 'budget_exceeded'
              ? 'budget-exceeded'
              : 'unavailable',
      };
    const parsed = parseDiscoveryCandidates(response.body.toString('utf8'), response.meta.finalUrl);
    if (!parsed.ok)
      return {
        ok: false,
        errorCode:
          parsed.health === 'security_rejected'
            ? 'security-rejected'
            : parsed.health === 'budget_exceeded'
              ? 'budget-exceeded'
              : 'unavailable',
      };
    if (parsed.candidates.length === 0) return { ok: false, errorCode: 'not-found' };
    const issued = this.options.store.issueDiscovery(
      source.sourceId,
      parsed.candidates.map((candidate) => candidate.url),
    );
    if (issued === null) return { ok: false, errorCode: 'budget-exceeded' };
    return {
      ok: true,
      value: {
        discoveryHandle: issued.discoveryHandle,
        candidates: issued.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          targetDisplay: safeDisplay(candidate.feedUrl),
        })),
      },
    };
  }
}

function hasSameHttpOrigin(sourceUrl: string, finalUrl: string): boolean {
  const sourceOrigin = urlOrigin(sourceUrl);
  return sourceOrigin !== null && urlOrigin(finalUrl) === sourceOrigin;
}

function safeDisplay(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return '无效目标';
  }
}
function readTargetDigest(record: WatchPreviewRecord): string | null {
  const v = record.validator;
  return typeof v === 'object' &&
    v !== null &&
    typeof (v as { targetDigest?: unknown }).targetDigest === 'string'
    ? (v as { targetDigest: string }).targetDigest
    : null;
}
function locatorFingerprint(
  source: Extract<SourceWatchProjectionReadResult, { status: 'found' }>['projection'],
  target: WatchRule['target'],
): string {
  return computeSourceLocatorFingerprint({
    sourceId: source.sourceId,
    scope: source.scope,
    canonicalKey: source.canonicalKey,
    kind: target.type,
    canonicalTargetUrl: target.type === 'feed' ? target.feedUrl : target.pageUrl,
  });
}
