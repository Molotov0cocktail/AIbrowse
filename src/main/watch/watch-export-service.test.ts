import { describe, expect, it } from 'vitest';
import { renderDigestMarkdown } from './watch-export-service';
import type { DigestFacts } from '../../shared/types/watch';

const pair = {
  itemId: 'i',
  fieldKey: 'title',
  label: '<img onerror=bad>',
  before: {
    kind: 'present' as const,
    excerpt: '=1+1',
    valueHash: 'a'.repeat(64),
    normalizedBytes: 4,
    truncated: false,
  },
  after: {
    kind: 'present' as const,
    excerpt: '[x](javascript:bad)',
    valueHash: 'b'.repeat(64),
    normalizedBytes: 19,
    truncated: false,
  },
  beforeCapturedAt: '2026-01-01T00:00:00.000Z',
  afterCapturedAt: '2026-01-01T00:01:00.000Z',
  beforeFinalUrl: 'javascript:bad',
  afterFinalUrl: 'https://example.com/a(b)',
  beforeDocumentId: null,
  afterDocumentId: null,
  feedItemKey: null,
};
const facts: DigestFacts = {
  schemaVersion: 1,
  scheduleId: 's',
  digestRunId: 'r',
  batchIndex: 0,
  period: { fromExclusive: '2026-01-01T00:00:00.000Z', toInclusive: '2026-01-02T00:00:00.000Z' },
  eventCount: 1,
  runStats: { changed: 1, failed: 0, unchanged: 0 },
  events: [
    {
      eventId: 'e',
      ruleId: 'r',
      sourceId: 's',
      eventKind: 'changed',
      importance: 'normal',
      firstIncludedAt: '2026-01-01T00:00:00.000Z',
      lastIncludedAt: '2026-01-01T00:01:00.000Z',
      observationCount: 1,
      itemCount: 1,
    },
  ],
  evidenceMap: { e: [pair] },
  referenceStates: { e: 'active' },
  fetchedAt: '2026-01-02T00:00:00.000Z',
};

describe('D9 Digest Markdown', () => {
  it('转义 raw HTML/Markdown 并仅链接安全 http(s) URL', () => {
    const out = renderDigestMarkdown({
      facts,
      explanation: { sections: [{ eventIds: ['e'], explanation: '<script>bad</script>' }] },
    })!;
    expect(out.text).toContain('&lt;img onerror');
    expect(out.text).not.toContain('<script>');
    expect(out.text).not.toContain('[x](javascript:');
    expect(out.text).toContain('https://example.com/a%28b%29');
  });
  it.each(['expired', 'user-deleted'] as const)('%s 仅输出 tombstone，不恢复 Evidence', (state) => {
    const changed = { ...facts, referenceStates: { e: state } };
    const out = renderDigestMarkdown({
      facts: changed,
      explanation: { sections: [{ eventIds: ['e'], explanation: 'secret explanation' }] },
    })!;
    expect(out.text).not.toContain('1+1');
    expect(out.text).not.toContain('secret explanation');
  });
});
