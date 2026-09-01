import { describe, expect, it } from 'vitest';
import { aggregateWatchWrtOutcomes, WATCH_WRT_MANIFEST } from './smoke-watch-manifest';
import { runWatchMigrationV5Matrix, runWatchRedTeamScenarios } from './smoke-watch-redteam';

describe('D10 Watch red-team matrix', () => {
  it('独立验证 v4→v5 成功、逐语句回滚、重开和 future=6', () => {
    const result = runWatchMigrationV5Matrix();
    expect(result.ok).toBe(true);
    expect(result.checks).toBeGreaterThanOrEqual(14);
    expect(result.failures).toEqual([]);
  });

  it('WRT-01..19 每项独立执行且不允许静默缺项', async () => {
    const outcomes = await runWatchRedTeamScenarios();
    expect(outcomes).toHaveLength(19);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
    expect(new Set(outcomes.map((outcome) => outcome.id)).size).toBe(19);
    expect(aggregateWatchWrtOutcomes(outcomes)).toEqual({ ok: true, failures: [] });
    expect(outcomes.map((outcome) => outcome.id)).toEqual(
      WATCH_WRT_MANIFEST.map((entry) => entry.id),
    );
  });
});
