import { describe, expect, it } from 'vitest';
import {
  fixedIdentityTreeGrowth,
  fixedTopologyGrowth,
  percentile,
  relativeLimit,
  summarize,
  summarizeCpu,
  SUPPLEMENT_BASELINE_DEPENDENCY_PATHS,
  validateFixedIdentityLifetimes,
  validateSupplementSourceCompatibility,
  validateTurnoverLifetimes,
  validateTimeline,
} from './metric-oracle';

describe('performance metric oracle', () => {
  it('allows only the ten baseline-bound dependency sources', () => {
    const dependencySources = Object.fromEntries(
      SUPPLEMENT_BASELINE_DEPENDENCY_PATHS.map((name, index) => [
        name,
        String(index).padStart(64, '0'),
      ]),
    );
    const fixed = { 'src/main/index.ts': 'a'.repeat(64) };
    const current = { ...dependencySources, ...fixed };
    expect(() =>
      validateSupplementSourceCompatibility(current, fixed, dependencySources),
    ).not.toThrow();
    expect(() =>
      validateSupplementSourceCompatibility(
        { ...current, [SUPPLEMENT_BASELINE_DEPENDENCY_PATHS[0]!]: 'f'.repeat(64) },
        fixed,
        dependencySources,
      ),
    ).toThrow('补验依赖来源改变');
    const missing: Record<string, string> = { ...current };
    delete missing[SUPPLEMENT_BASELINE_DEPENDENCY_PATHS[0]!];
    expect(() => validateSupplementSourceCompatibility(missing, fixed, dependencySources)).toThrow(
      '补验依赖来源集合改变',
    );
    expect(() =>
      validateSupplementSourceCompatibility(
        { ...current, 'node_modules/unknown/index.js': 'b'.repeat(64) },
        fixed,
        dependencySources,
      ),
    ).toThrow('补验依赖来源集合改变');
  });

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

  it('rejects a same-count member replacement instead of folding its birth RSS into growth', () => {
    const points = Array.from({ length: 362 }, (_, index) => ({
      elapsedMs: 600_000 + index * 10_100,
      members: [
        {
          pid: index < 180 ? 10 : 20,
          createdFileTime: index < 180 ? '100' : '200',
          rssBytes: 100 * 1024 ** 2 + index * 1024,
          privateBytes: 80 * 1024 ** 2,
          handles: 100,
        },
      ],
    }));
    expect(() => fixedIdentityTreeGrowth(points)).toThrow('固定实体集合漂移');
  });

  it('calculates all three slopes only for one exact PID plus creation set', () => {
    const points = Array.from({ length: 362 }, (_, index) => ({
      elapsedMs: 600_000 + index * 10_100,
      members: [
        {
          pid: 10,
          createdFileTime: '100',
          rssBytes: 100 * 1024 ** 2 + index * 1024,
          privateBytes: 80 * 1024 ** 2 + index * 2 * 1024,
          handles: 100 + index,
        },
      ],
    }));
    const result = fixedIdentityTreeGrowth(points);
    expect(result.identities).toEqual(['10:100']);
    expect(result.samples).toBe(362);
    expect(result.rssBytesPerHour).toBeGreaterThan(0);
    expect(result.privateBytesPerHour).toBeGreaterThan(result.rssBytesPerHour);
    expect(result.handlesPerHour).toBeGreaterThan(0);
  });

  it('rejects a short-lived identity hidden between fixed ten-second resource points', () => {
    expect(() =>
      validateFixedIdentityLifetimes(
        ['10:100'],
        [
          {
            pid: 10,
            createdFileTime: '100',
            firstObservedMs: 0,
            lastObservedMs: 7_200_000,
            retiredObservedMs: null,
          },
          {
            pid: 20,
            createdFileTime: '200',
            firstObservedMs: 700_000,
            lastObservedMs: 700_100,
            retiredObservedMs: 700_200,
          },
        ],
        600_000,
        7_200_000,
      ),
    ).toThrow('出现出生或退休');
  });

  it('requires the fixed 10-slot two-generation sequence and native retirement before rebirth', () => {
    const events = Array.from({ length: 20 }, (_, index) => ({
      slot: index % 10,
      generation: Math.floor(index / 10) + 1,
      closeStartedMs: 10_000 + index * 20_000,
      createStartedMs: 12_000 + index * 20_000,
      createCompletedMs: 13_000 + index * 20_000,
      oldPid: 100 + index,
      newPid: 110 + index,
    }));
    const lifetimes = Array.from({ length: 30 }, (_, index) => ({
      pid: 100 + index,
      createdFileTime: String(1_000 + index),
      firstObservedMs: index < 10 ? 0 : 12_000 + (index - 10) * 20_000,
      lastObservedMs: index < 20 ? 10_000 + index * 20_000 : 500_000,
      retiredObservedMs: index < 20 ? 11_000 + index * 20_000 : null,
    }));
    const resolved = validateTurnoverLifetimes(events, lifetimes);
    expect(resolved).toHaveLength(20);
    expect(resolved[10]!.oldIdentity).toBe(resolved[0]!.newIdentity);
    expect(() =>
      validateTurnoverLifetimes(events, [
        ...lifetimes.slice(0, 5),
        { ...lifetimes[5]!, retiredObservedMs: null },
        ...lifetimes.slice(6),
      ]),
    ).toThrow('退休无法唯一证明');
    expect(() =>
      validateTurnoverLifetimes(events, [
        ...lifetimes,
        {
          pid: 100,
          createdFileTime: '9999',
          firstObservedMs: 0,
          lastObservedMs: 10_500,
          retiredObservedMs: 11_500,
        },
      ]),
    ).toThrow('退休无法唯一证明');
  });
});
