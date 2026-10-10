import { describe, expect, it } from 'vitest';
import {
  fixedTopologyGrowth,
  percentile,
  relativeLimit,
  summarize,
  summarizeCpu,
  validateTimeline,
} from './metric-oracle';

describe('performance metric oracle', () => {
  it('uses nearest-rank p95 and freezes the stated relative formula', () => {
    const samples = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(percentile(samples, 0.95)).toBe(19);
    expect(summarize(samples)).toEqual({ samples: 20, p50: 10, p95: 19, max: 20 });
    expect(relativeLimit(19)).toBeCloseTo(42.8);
  });

  it('integrates all-member aggregate CPU by the real interval denominator', () => {
    expect(
      summarizeCpu([
        { elapsedMs: 0, aggregatePercent: 10 },
        { elapsedMs: 2_000, aggregatePercent: 150 },
        { elapsedMs: 5_000, aggregatePercent: 50 },
      ]),
    ).toEqual({
      wallMs: 5_000,
      logicalCoreMs: 4_500,
      averageLogicalCores: 0.9,
      peakAggregatePercent: 150,
    });
  });

  it('rejects empty, non-finite, negative and non-monotonic inputs', () => {
    expect(() => summarize([])).toThrow();
    expect(() => relativeLimit(Number.NaN)).toThrow();
    expect(() => percentile([1, -1], 0.95)).toThrow();
    expect(() =>
      summarizeCpu([
        { elapsedMs: 10, aggregatePercent: 1 },
        { elapsedMs: 10, aggregatePercent: 1 },
      ]),
    ).toThrow('CPU时钟非递增');
  });

  it('binds the sampling origin and end instead of accepting a shifted two-hour count', () => {
    const valid = Array.from({ length: 720 }, (_, index) => ({ elapsedMs: index * 10_000 }));
    expect(() => validateTimeline(valid, 7_200_000)).not.toThrow();
    expect(() =>
      validateTimeline(
        valid.map((point) => ({ elapsedMs: point.elapsedMs + 20_000_000 })),
        7_200_000,
      ),
    ).toThrow('固定窗口');
  });

  it('keeps each observed stable topology separate so opposite slopes cannot cancel', () => {
    const points = Array.from({ length: 720 }, (_, index) => ({
      elapsedMs: index * 10_000,
      members: index % 2 === 0 ? 10 : 11,
      value:
        500 * 1024 ** 2 +
        ((index % 2 === 0 ? 1 : -1) * 50 * 1024 ** 2 * index * 10_000) / 3_600_000,
    }));
    const growth = fixedTopologyGrowth(points);
    expect(growth.evaluated['10']).toBeGreaterThan(24 * 1024 ** 2);
    expect(growth.evaluated['11']).toBeLessThan(0);
  });

  it('evaluates the dominant real topology and reports bounded transition points', () => {
    const points = Array.from({ length: 362 }, (_, index) => ({
      elapsedMs: 600_000 + index * 10_100,
      members: index === 100 ? 14 : index === 200 ? 16 : 15,
      value: 500 * 1024 ** 2 + index * 1024,
    }));
    const growth = fixedTopologyGrowth(points);
    expect(Object.keys(growth.evaluated)).toEqual(['15']);
    expect(growth.sparse).toEqual({ '14': 1, '16': 1 });
  });

  it('rejects a sparse episode that does not return promptly to the same stable topology', () => {
    const points = Array.from({ length: 362 }, (_, index) => ({
      elapsedMs: 600_000 + index * 10_100,
      members: index >= 100 && index <= 102 ? 16 : 15,
      value: 500 * 1024 ** 2 + index * 1024,
    }));
    expect(() => fixedTopologyGrowth(points)).toThrow('包络无效');
  });
});
