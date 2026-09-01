import { describe, expect, it } from 'vitest';
import {
  aggregateWatchWrtOutcomes,
  validateWatchSixthMapping,
  validateWatchWrtManifest,
  WATCH_SIXTH_SECTION_MAPPING,
  WATCH_WRT_MANIFEST,
  type WatchWrtOutcome,
} from './smoke-watch-manifest';

describe('D10 Watch manifest', () => {
  it('固定包含 WRT-01..19 且映射 Sixth §7/§9/§10', () => {
    expect(validateWatchWrtManifest(WATCH_WRT_MANIFEST)).toEqual([]);
    expect(WATCH_WRT_MANIFEST.map((entry) => entry.id)).toEqual(
      Array.from({ length: 19 }, (_, index) => `WRT-${String(index + 1).padStart(2, '0')}`),
    );
    expect(validateWatchSixthMapping(WATCH_SIXTH_SECTION_MAPPING)).toEqual([]);
  });

  it('缺项、重复项和未知结果均 fail-closed', () => {
    const malformed = WATCH_WRT_MANIFEST.slice(0, 18);
    expect(validateWatchWrtManifest(malformed)).not.toEqual([]);
    const outcomes: WatchWrtOutcome[] = WATCH_WRT_MANIFEST.map((entry) => ({
      id: entry.id,
      ok: true,
      evidenceKind: entry.evidenceKind,
      detail: 'fixture',
    }));
    outcomes.pop();
    outcomes.push({ id: 'WRT-01', ok: true, evidenceKind: 'structural-proof', detail: 'fixture' });
    outcomes.push({ id: 'WRT-99', ok: true, evidenceKind: 'structural-proof', detail: 'fixture' });
    const aggregate = aggregateWatchWrtOutcomes(outcomes);
    expect(aggregate.ok).toBe(false);
    expect(aggregate.failures.some((failure) => failure.includes('WRT-19'))).toBe(true);
    expect(aggregate.failures.some((failure) => failure.includes('WRT-99'))).toBe(true);
  });
});
