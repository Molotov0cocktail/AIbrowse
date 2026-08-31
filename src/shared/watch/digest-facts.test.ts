import { describe, expect, it } from 'vitest';
import { MAX_DIGEST_FACTS_BYTES } from '../types/watch';
import {
  buildDigestFacts,
  canonicalizeDigestFacts,
  validateDigestFacts,
  type DigestObservationSlice,
} from './digest-facts';

function observation(sequence: number, eventId = `e${sequence}`): DigestObservationSlice {
  return {
    sequence,
    eventId,
    ruleId: 'rule',
    sourceId: 'source',
    eventKind: 'changed',
    importance: 'normal',
    observedAt: `2026-08-31T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    items: [
      {
        itemId: `i${sequence}`,
        fieldKey: 'title',
        label: '标题',
        before: { kind: 'absent' },
        after: {
          kind: 'present',
          excerpt: 'x',
          valueHash: 'h',
          normalizedBytes: 1,
          truncated: false,
        },
        beforeCapturedAt: '2026-08-31T00:00:00.000Z',
        afterCapturedAt: '2026-08-31T00:00:00.000Z',
        beforeFinalUrl: 'https://example.com',
        afterFinalUrl: 'https://example.com',
        beforeDocumentId: null,
        afterDocumentId: null,
        feedItemKey: null,
      },
    ],
  };
}

describe('DigestFacts deterministic builder', () => {
  it('按 journal sequence 排序并只在当前 batch 内聚合同 Event observation', () => {
    const input = [observation(2, 'e1'), observation(1, 'e1'), observation(3, 'e2')];
    const facts = buildDigestFacts({
      scheduleId: 's',
      digestRunId: 'r',
      batchIndex: 0,
      period: {
        fromExclusive: '2026-08-30T00:00:00.000Z',
        toInclusive: '2026-08-31T00:01:00.000Z',
      },
      runStats: { changed: 2, unchanged: 0, failed: 0 },
      observations: input,
      fetchedAt: '2026-08-31T00:01:00.000Z',
    });
    expect(facts?.events.map((event) => event.eventId)).toEqual(['e1', 'e2']);
    expect(facts?.events[0]?.observationCount).toBe(2);
    expect(input.map((row) => row.sequence)).toEqual([2, 1, 3]);
    const canonical = canonicalizeDigestFacts(facts!);
    expect(canonical.ok).toBe(true);
    if (canonical.ok) expect(canonical.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('51 个 unique Event 被单 artifact builder 拒绝', () => {
    expect(
      buildDigestFacts({
        scheduleId: 's',
        digestRunId: 'r',
        batchIndex: 0,
        period: {
          fromExclusive: '2026-08-30T00:00:00.000Z',
          toInclusive: '2026-08-31T00:01:00.000Z',
        },
        runStats: { changed: 51, unchanged: 0, failed: 0 },
        observations: Array.from({ length: 51 }, (_, i) => observation(i + 1)),
        fetchedAt: '2026-08-31T00:01:00.000Z',
      }),
    ).toBeNull();
  });

  it('facts 49152 UTF-8 bytes 接受，49153 拒绝，畸形 Evidence fail-closed', () => {
    const facts = buildDigestFacts({
      scheduleId: 's',
      digestRunId: 'r',
      batchIndex: 0,
      period: {
        fromExclusive: '2026-08-30T00:00:00.000Z',
        toInclusive: '2026-08-31T00:01:00.000Z',
      },
      runStats: { changed: 11, unchanged: 0, failed: 0 },
      observations: Array.from({ length: 11 }, (_, i) => observation(i + 1)),
      fetchedAt: '2026-08-31T00:01:00.000Z',
    })!;
    for (let index = 1; index <= 10; index += 1) {
      const after = facts.evidenceMap[`e${index}`]![0]!.after;
      if (after.kind === 'present') {
        after.excerpt = 'a'.repeat(4_096);
        after.normalizedBytes = 4_096;
      }
    }
    const last = facts.evidenceMap['e11']![0]!.after;
    expect(last.kind).toBe('present');
    if (last.kind !== 'present') return;
    last.normalizedBytes = 4_096;
    const baseBytes = Buffer.byteLength(JSON.stringify(facts), 'utf8');
    const excerptLength = 1 + MAX_DIGEST_FACTS_BYTES - baseBytes;
    expect(excerptLength).toBeGreaterThanOrEqual(1);
    expect(excerptLength).toBeLessThanOrEqual(4_096);
    last.excerpt = 'a'.repeat(excerptLength);
    const atLimit = canonicalizeDigestFacts(facts);
    expect(atLimit).toMatchObject({ ok: true, byteLength: MAX_DIGEST_FACTS_BYTES });
    last.excerpt += 'a';
    expect(canonicalizeDigestFacts(facts)).toEqual({ ok: false });

    const malformed = structuredClone(facts) as unknown as Record<string, unknown>;
    const evidenceMap = malformed['evidenceMap'] as Record<string, unknown[]>;
    evidenceMap['e1']![0] = { hostile: true };
    expect(validateDigestFacts(malformed)).toBe(false);
  });
});
