import { describe, expect, it } from 'vitest';
import { dependencies, fixture, RUN_ID } from './growth-report-fixture.ts';
import { reportHandleGrowth } from './handle-growth-report.ts';
import { reportResources } from './resource-report.ts';
import { statistics } from './statistics.ts';

describe('RSS增长判据反例', () => {
  it('每个存活进程恒100MiB时，4/8进程生命周期不应被判作持续增长', () => {
    const data = fixture();
    const busy = new Map(
      data.pulseSlots.flatMap((slots, pulse) => slots.map((slot) => [slot, pulse])),
    );
    for (const row of data.input.members) {
      const processes = Array.from({ length: busy.has(row.slot) ? 8 : 4 }, (_, index) => ({
        pid: index < 4 ? index + 10 : 1000 + busy.get(row.slot)! * 4 + index,
        creationFileTime: (index < 4 ? index + 1 : 1000 + busy.get(row.slot)! * 4 + index)
          .toString(16)
          .padStart(16, '0'),
        inJob: true,
        rssBytes: 100 * 1048576,
        privateBytes: 120 * 1048576,
        handles: 100,
      }));
      const identities = processes.map(({ pid, creationFileTime }) => ({ pid, creationFileTime }));
      row.value = { before: identities, after: identities, processes };
    }
    const report = reportResources(data.input).rssMiB;
    expect(report.statistics).toMatchObject({ median: 400, p95: 800, observedPeak: 800 });
    expect(report.statistics!.slopePerHour).toBeGreaterThan(24);
    expect(report.verdict).toBe('PASS');
  });

  it('仅transition增长不能被全点稀释或两个恒定阶段放行', () => {
    const transitionSlots = new Set([30, 120, 220, 320, 358]);
    const data = fixture({ transitions: [...transitionSlots], handle: () => 100 });
    const transitionPoints = [];
    for (const row of data.input.members) {
      const seconds =
        Number(BigInt(row.endQpc) - BigInt(data.input.window.beginQpc)) /
        data.input.window.qpcFrequency;
      const rssMiB = transitionSlots.has(row.slot) ? 100 + (300 * seconds) / 3600 : 100;
      row.value!.processes[0]!.rssBytes = Math.round(rssMiB * 1048576);
      // Reuse the existing classifier only to demonstrate the rejected two-phase shortcut.
      row.value!.processes[0]!.handles = Math.round(rssMiB);
      if (transitionSlots.has(row.slot))
        transitionPoints.push({ slot: row.slot, seconds, value: rssMiB });
    }
    const phaseShortcut = reportHandleGrowth(data.input, RUN_ID, data.frames, dependencies);
    expect(phaseShortcut.idle.statistics!.slopePerHour).toBe(0);
    expect(phaseShortcut.session.statistics!.slopePerHour).toBe(0);
    expect(phaseShortcut.verdict).toBe('PASS');
    expect(statistics(transitionPoints)!.slopePerHour).toBeCloseTo(300, 8);
    const report = reportResources(data.input).rssMiB;
    expect(report.statistics!.slopePerHour).toBeLessThan(24);
    expect(report.verdict).not.toBe('PASS');
  });

  it('transition内部4与8进程固定开销占比变化不能冒充持续增长', () => {
    const transitionSlots = new Set([30, 120, 220, 320, 358]);
    const data = fixture({ transitions: [...transitionSlots] });
    const busy = new Set(data.pulseSlots.flat());
    const transitionPoints = [];
    for (const row of data.input.members) {
      const count =
        busy.has(row.slot) || (transitionSlots.has(row.slot) && row.slot >= 200) ? 8 : 4;
      const processes = Array.from({ length: count }, (_, index) => ({
        pid: index < 4 ? index + 10 : 1000 + row.slot * 8 + index,
        creationFileTime: (index < 4 ? index + 1 : 1000 + row.slot * 8 + index)
          .toString(16)
          .padStart(16, '0'),
        inJob: true,
        rssBytes: 100 * 1048576,
        privateBytes: 120 * 1048576,
        handles: 100,
      }));
      const identities = processes.map(({ pid, creationFileTime }) => ({ pid, creationFileTime }));
      row.value = { before: identities, after: identities, processes };
      if (transitionSlots.has(row.slot))
        transitionPoints.push({
          slot: row.slot,
          seconds:
            Number(BigInt(row.endQpc) - BigInt(data.input.window.beginQpc)) /
            data.input.window.qpcFrequency,
          value: count * 100,
        });
    }
    expect(new Set(transitionPoints.map((point) => point.value))).toEqual(new Set([400, 800]));
    expect(statistics(transitionPoints)!.slopePerHour).toBeGreaterThan(24);
    const report = reportResources(data.input).rssMiB;
    expect(report.statistics!.observedPeak).toBe(800);
    expect(report.verdict).not.toBe('FAIL-product');
  });
});
