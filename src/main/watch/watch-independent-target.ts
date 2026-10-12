import { randomUUID } from 'node:crypto';
import type { SourceWatchProjection, WatchIndependentTarget } from '../../shared/types/watch';
import { normalizeSourceUrl } from '../sources/domain/source-canonical';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function newIndependentTarget(raw: string): WatchIndependentTarget | null {
  const normalized = normalizeSourceUrl(raw, 'page');
  if (!normalized.ok || normalized.canonicalKey.length > 2_048) return null;
  const url = new URL(normalized.canonicalKey);
  return {
    id: randomUUID(),
    version: 1,
    scope: 'page',
    canonicalUrl: normalized.canonicalKey,
    displayName: `${url.hostname}${url.pathname}`.slice(0, 256),
    aiShareMode: 'blocked',
  };
}

export function validateIndependentTargetRow(row: unknown): WatchIndependentTarget | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  if (
    typeof r['id'] !== 'string' ||
    !UUID.test(r['id']) ||
    typeof r['version'] !== 'number' ||
    !Number.isSafeInteger(r['version']) ||
    r['version'] < 1 ||
    r['scope'] !== 'page' ||
    typeof r['canonical_url'] !== 'string' ||
    r['canonical_url'].length > 2_048 ||
    typeof r['display_name'] !== 'string' ||
    r['display_name'].length < 1 ||
    r['display_name'].length > 256 ||
    typeof r['ai_share_mode'] !== 'string' ||
    !['full', 'metadata', 'blocked'].includes(r['ai_share_mode'])
  )
    return null;
  const normalized = normalizeSourceUrl(r['canonical_url'], 'page');
  if (!normalized.ok || normalized.canonicalKey !== r['canonical_url']) return null;
  return {
    id: r['id'],
    version: r['version'],
    scope: 'page',
    canonicalUrl: r['canonical_url'],
    displayName: r['display_name'],
    aiShareMode: r['ai_share_mode'] as WatchIndependentTarget['aiShareMode'],
  };
}

export function targetProjection(target: WatchIndependentTarget): SourceWatchProjection {
  return {
    sourceId: target.id,
    rowVersion: target.version,
    enabled: true,
    deletedAt: null,
    scope: target.scope,
    canonicalKey: target.canonicalUrl,
  };
}
