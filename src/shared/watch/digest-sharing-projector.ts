import type {
  ChangeEvidencePair,
  DigestEventProjection,
  DigestFacts,
  WatchSharingMode,
} from '../types/watch';
import { truncateUtf8 } from './watch-budget';

export interface DigestSourceSharingProjection {
  sourceId: string;
  shareMode: WatchSharingMode;
  displayName: string;
  canonicalUrl: string;
}

export interface DigestProviderEventProjection {
  event: DigestEventProjection;
  sourceName: string;
  sourceUrl: string;
  evidence?: ChangeEvidencePair[];
}

export interface DigestProviderProjection {
  schemaVersion: 1;
  scheduleId: string;
  digestRunId: string;
  batchIndex: number;
  period: DigestFacts['period'];
  runStats: DigestFacts['runStats'];
  events: DigestProviderEventProjection[];
  fetchedAt: string;
}

export function projectDigestForProvider(
  facts: DigestFacts,
  sources: readonly DigestSourceSharingProjection[],
): DigestProviderProjection {
  const byId = new Map(sources.map((source) => [source.sourceId, source]));
  const events: DigestProviderEventProjection[] = [];
  for (const event of facts.events) {
    if (facts.referenceStates[event.eventId] !== 'active') continue;
    const source = byId.get(event.sourceId);
    if (source === undefined || source.shareMode === 'blocked') continue;
    const projected: DigestProviderEventProjection = {
      event: structuredClone(event),
      sourceName: truncateUtf8(source.displayName, 256).text,
      sourceUrl: truncateUtf8(source.canonicalUrl, 2_048).text,
    };
    if (source.shareMode === 'full')
      projected.evidence = structuredClone(facts.evidenceMap[event.eventId] ?? []);
    events.push(projected);
  }
  return {
    schemaVersion: 1,
    scheduleId: facts.scheduleId,
    digestRunId: facts.digestRunId,
    batchIndex: facts.batchIndex,
    period: { ...facts.period },
    runStats: { ...facts.runStats },
    events,
    fetchedAt: facts.fetchedAt,
  };
}
