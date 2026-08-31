import { createHash } from 'node:crypto';
import {
  MAX_DIGEST_EVENTS,
  MAX_DIGEST_FACTS_BYTES,
  WATCH_EVENT_KINDS,
  WATCH_NOTIFICATION_LEVELS,
  type ChangeEvidencePair,
  type DigestEventProjection,
  type DigestFacts,
  type DigestRunStats,
  type WatchEventKind,
  type WatchNotificationLevel,
} from '../types/watch';
import { validateChangeEvidencePair } from './event-validator';
import { utf8ByteLength } from './watch-budget';

export interface DigestObservationSlice {
  sequence: number;
  eventId: string;
  ruleId: string;
  sourceId: string;
  eventKind: WatchEventKind;
  importance: WatchNotificationLevel;
  observedAt: string;
  items: readonly ChangeEvidencePair[];
}

export interface BuildDigestFactsInput {
  scheduleId: string;
  digestRunId: string;
  batchIndex: number;
  period: { fromExclusive: string; toInclusive: string };
  runStats: DigestRunStats;
  observations: readonly DigestObservationSlice[];
  fetchedAt: string;
}

function aggregateKind(kinds: readonly WatchEventKind[]): WatchEventKind {
  const first = kinds[0];
  return first !== undefined && kinds.every((kind) => kind === first) ? first : 'mixed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key, index) => actual[index] === key);
}

function safeInt(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

export function validateDigestFacts(value: unknown): value is DigestFacts {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'scheduleId',
      'digestRunId',
      'batchIndex',
      'period',
      'eventCount',
      'runStats',
      'events',
      'evidenceMap',
      'referenceStates',
      'fetchedAt',
    ])
  )
    return false;
  if (
    value['schemaVersion'] !== 1 ||
    typeof value['scheduleId'] !== 'string' ||
    value['scheduleId'] === '' ||
    typeof value['digestRunId'] !== 'string' ||
    value['digestRunId'] === '' ||
    !safeInt(value['batchIndex'])
  )
    return false;
  const period = value['period'];
  const stats = value['runStats'];
  if (
    !isRecord(period) ||
    !exactKeys(period, ['fromExclusive', 'toInclusive']) ||
    typeof period['fromExclusive'] !== 'string' ||
    typeof period['toInclusive'] !== 'string' ||
    !Number.isFinite(Date.parse(period['fromExclusive'])) ||
    !Number.isFinite(Date.parse(period['toInclusive'])) ||
    period['fromExclusive'] >= period['toInclusive'] ||
    value['fetchedAt'] !== period['toInclusive']
  )
    return false;
  if (
    !isRecord(stats) ||
    !exactKeys(stats, ['changed', 'failed', 'unchanged']) ||
    !safeInt(stats['changed']) ||
    !safeInt(stats['failed']) ||
    !safeInt(stats['unchanged'])
  )
    return false;
  if (
    !Array.isArray(value['events']) ||
    value['events'].length < 1 ||
    value['events'].length > MAX_DIGEST_EVENTS ||
    value['eventCount'] !== value['events'].length ||
    !isRecord(value['evidenceMap']) ||
    !isRecord(value['referenceStates'])
  )
    return false;
  const eventIds: string[] = [];
  for (const event of value['events']) {
    if (
      !isRecord(event) ||
      !exactKeys(event, [
        'eventId',
        'ruleId',
        'sourceId',
        'eventKind',
        'importance',
        'firstIncludedAt',
        'lastIncludedAt',
        'observationCount',
        'itemCount',
      ]) ||
      typeof event['eventId'] !== 'string' ||
      event['eventId'] === '' ||
      eventIds.includes(event['eventId']) ||
      typeof event['ruleId'] !== 'string' ||
      typeof event['sourceId'] !== 'string' ||
      !WATCH_EVENT_KINDS.includes(event['eventKind'] as WatchEventKind) ||
      !WATCH_NOTIFICATION_LEVELS.includes(event['importance'] as WatchNotificationLevel) ||
      typeof event['firstIncludedAt'] !== 'string' ||
      typeof event['lastIncludedAt'] !== 'string' ||
      !Number.isFinite(Date.parse(event['firstIncludedAt'])) ||
      !Number.isFinite(Date.parse(event['lastIncludedAt'])) ||
      event['firstIncludedAt'] > event['lastIncludedAt'] ||
      !safeInt(event['observationCount'], 1) ||
      !safeInt(event['itemCount'], 1)
    )
      return false;
    eventIds.push(event['eventId']);
  }
  if (Object.keys(value['referenceStates']).join('\0') !== eventIds.join('\0')) return false;
  const activeIds: string[] = [];
  for (const eventId of eventIds) {
    const state = value['referenceStates'][eventId];
    if (state !== 'active' && state !== 'expired' && state !== 'user-deleted') return false;
    if (state === 'active') activeIds.push(eventId);
  }
  if (Object.keys(value['evidenceMap']).join('\0') !== activeIds.join('\0')) return false;
  for (const eventId of activeIds) {
    const evidence = value['evidenceMap'][eventId];
    const event = value['events'].find(
      (candidate) => isRecord(candidate) && candidate['eventId'] === eventId,
    )!;
    if (
      !Array.isArray(evidence) ||
      evidence.length !== event['itemCount'] ||
      evidence.some((pair) => validateChangeEvidencePair(pair) === null)
    )
      return false;
  }
  return true;
}

export function buildDigestFacts(input: BuildDigestFactsInput): DigestFacts | null {
  const ordered = [...input.observations].sort((a, b) => a.sequence - b.sequence);
  if (
    ordered.some(
      (row, index) =>
        row.sequence < 1 || (index > 0 && row.sequence <= ordered[index - 1]!.sequence),
    )
  ) {
    return null;
  }
  const groups = new Map<string, DigestObservationSlice[]>();
  for (const row of ordered) {
    const current = groups.get(row.eventId);
    if (current === undefined) groups.set(row.eventId, [row]);
    else current.push(row);
  }
  if (groups.size < 1 || groups.size > MAX_DIGEST_EVENTS) return null;
  const events: DigestEventProjection[] = [];
  const evidenceMap: Record<string, ChangeEvidencePair[]> = Object.create(null) as Record<
    string,
    ChangeEvidencePair[]
  >;
  const referenceStates: Record<string, 'active'> = Object.create(null) as Record<string, 'active'>;
  for (const [eventId, slices] of groups) {
    const first = slices[0]!;
    const last = slices[slices.length - 1]!;
    if (
      slices.some((slice) => slice.ruleId !== first.ruleId || slice.sourceId !== first.sourceId)
    ) {
      return null;
    }
    const items = slices.flatMap((slice) => slice.items.map((item) => structuredClone(item)));
    events.push({
      eventId,
      ruleId: first.ruleId,
      sourceId: first.sourceId,
      eventKind: aggregateKind(slices.map((slice) => slice.eventKind)),
      importance: first.importance,
      firstIncludedAt: first.observedAt,
      lastIncludedAt: last.observedAt,
      observationCount: slices.length,
      itemCount: items.length,
    });
    evidenceMap[eventId] = items;
    referenceStates[eventId] = 'active';
  }
  const facts: DigestFacts = {
    schemaVersion: 1,
    scheduleId: input.scheduleId,
    digestRunId: input.digestRunId,
    batchIndex: input.batchIndex,
    period: { ...input.period },
    eventCount: events.length,
    runStats: {
      changed: input.runStats.changed,
      failed: input.runStats.failed,
      unchanged: input.runStats.unchanged,
    },
    events,
    evidenceMap,
    referenceStates,
    fetchedAt: input.fetchedAt,
  };
  return canonicalizeDigestFacts(facts).ok ? facts : null;
}

export function canonicalizeDigestFacts(
  facts: DigestFacts,
): { ok: true; json: string; byteLength: number; hash: string } | { ok: false } {
  if (!validateDigestFacts(facts)) return { ok: false };
  const json = JSON.stringify(facts);
  const byteLength = utf8ByteLength(json);
  if (byteLength > MAX_DIGEST_FACTS_BYTES) return { ok: false };
  return {
    ok: true,
    json,
    byteLength,
    hash: createHash('sha256').update(json, 'utf8').digest('hex'),
  };
}
