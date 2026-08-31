import { describe, expect, it } from 'vitest';
import type { DigestFacts } from '../types/watch';
import { projectDigestForProvider } from './digest-sharing-projector';

const facts: DigestFacts = {
  schemaVersion: 1,
  scheduleId: 's',
  digestRunId: 'r',
  batchIndex: 0,
  period: { fromExclusive: '2026-08-30T00:00:00.000Z', toInclusive: '2026-08-31T00:00:00.000Z' },
  eventCount: 3,
  runStats: { changed: 3, unchanged: 0, failed: 0 },
  events: ['full', 'meta', 'blocked'].map((sourceId, index) => ({
    eventId: `e${index + 1}`,
    ruleId: `r${index + 1}`,
    sourceId,
    eventKind: 'changed' as const,
    importance: 'normal' as const,
    firstIncludedAt: '2026-08-31T00:00:00.000Z',
    lastIncludedAt: '2026-08-31T00:00:00.000Z',
    observationCount: 1,
    itemCount: 1,
  })),
  evidenceMap: {
    e1: [
      {
        itemId: 'i',
        fieldKey: 'f',
        label: 'l',
        before: {
          kind: 'present',
          excerpt: 'SECRET_FULL',
          valueHash: 'a'.repeat(64),
          normalizedBytes: 11,
          truncated: false,
        },
        after: { kind: 'absent' },
        beforeCapturedAt: '2026-08-31T00:00:00.000Z',
        afterCapturedAt: '2026-08-31T00:00:00.000Z',
        beforeFinalUrl: 'https://a.test/',
        afterFinalUrl: 'https://a.test/',
        beforeDocumentId: 'DOC_CANARY',
        afterDocumentId: null,
        feedItemKey: 'FEED_CANARY',
      },
    ],
    e2: [
      {
        itemId: 'i',
        fieldKey: 'f',
        label: 'l',
        before: {
          kind: 'present',
          excerpt: 'SECRET_META',
          valueHash: 'b'.repeat(64),
          normalizedBytes: 11,
          truncated: false,
        },
        after: { kind: 'absent' },
        beforeCapturedAt: '2026-08-31T00:00:00.000Z',
        afterCapturedAt: '2026-08-31T00:00:00.000Z',
        beforeFinalUrl: 'https://b.test/',
        afterFinalUrl: 'https://b.test/',
        beforeDocumentId: null,
        afterDocumentId: null,
        feedItemKey: null,
      },
    ],
    e3: [],
  },
  referenceStates: { e1: 'active', e2: 'active', e3: 'active' },
  fetchedAt: '2026-08-31T00:00:00.000Z',
};

describe('Digest sharing projector', () => {
  it('full 保留 Evidence；metadata 剥离；blocked/missing 整个 Event 不可见', () => {
    const projected = projectDigestForProvider(facts, [
      { sourceId: 'full', shareMode: 'full', displayName: 'Full', canonicalUrl: 'https://a.test/' },
      {
        sourceId: 'meta',
        shareMode: 'metadata',
        displayName: 'Meta',
        canonicalUrl: 'https://b.test/',
      },
      {
        sourceId: 'blocked',
        shareMode: 'blocked',
        displayName: 'BLOCKED_NAME',
        canonicalUrl: 'https://blocked.test/',
      },
    ]);
    expect(projected.events.map((entry) => entry.event.eventId)).toEqual(['e1', 'e2']);
    expect(projected.events[0]).toHaveProperty('evidence');
    expect(projected.events[1]).not.toHaveProperty('evidence');
    const serialized = JSON.stringify(projected);
    expect(serialized).toContain('SECRET_FULL');
    expect(serialized).not.toContain('SECRET_META');
    expect(serialized).not.toContain('BLOCKED_NAME');
    expect(serialized).not.toContain('https://blocked.test/');
  });
});
