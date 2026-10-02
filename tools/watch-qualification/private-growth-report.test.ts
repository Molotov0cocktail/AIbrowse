import { describe, expect, it } from 'vitest';
import { dependencies, fixture, groupedFixture, hours, RUN_ID } from './growth-report-fixture.ts';
import { reportHandleGrowth } from './handle-growth-report.ts';
import { reportPrivateGrowth } from './private-growth-report.ts';
import { reportResources } from './resource-report.ts';
import { reportRssGrowth } from './rss-growth-report.ts';

describe('private-growth-v2独立字段与阈值', () => {
  it('三项新增长门均拒绝重复槽且保留后来可信高值的绝对失败', () => {
    for (const reporter of [reportPrivateGrowth, reportRssGrowth, reportHandleGrowth]) {
      const data = groupedFixture();
      const duplicate = structuredClone(data.input.members[20]!);
      data.input.members.push(duplicate);
      expect(reporter(data.input, RUN_ID, data.frames, dependencies).verdict).toBe(
        'BLOCKED/evidence-insufficient',
      );
      Object.assign(duplicate.value!.processes[0]!, {
        rssBytes: 2049 * 1048576,
        privateBytes: 2049 * 1048576,
        handles: 5001,
      });
      expect(reporter(data.input, RUN_ID, data.frames, dependencies).verdict).toBe('FAIL-product');
    }
  });

  it('每进程恒定private的周期成本使用新门，raw旧失败完整保留', () => {
    const data = groupedFixture();
    const privateGrowth = reportPrivateGrowth(data.input, RUN_ID, data.frames, dependencies);
    const rssGrowth = reportRssGrowth(data.input, RUN_ID, data.frames, dependencies);
    const handleGrowth = reportHandleGrowth(data.input, RUN_ID, data.frames, dependencies);
    expect(privateGrowth.revision).toBe('private-growth-v2');
    expect(privateGrowth.rawAllPoints.verdict).toBe('FAIL-product');
    expect(privateGrowth.verdict).toBe('PASS');
    const resources = reportResources(data.input, { privateGrowth, rssGrowth, handleGrowth });
    expect(resources.privateGrowthRevision).toBe('private-growth-v2');
    expect(resources.privateMiB.statistics).toEqual(privateGrowth.rawAllPoints.statistics);
    expect(resources.privateMiB.rawAllPoints.verdict).toBe('FAIL-product');
    expect(resources.privateMiB.verdict).toBe('PASS');
    expect(resources.rssMiB.verdict).toBe('PASS');
    expect(resources.verdict).toBe('PASS');
  });

  it('只private增长RSS恒定及反向场景不串接字段', () => {
    for (const field of ['privateBytes', 'rssBytes'] as const) {
      const data = groupedFixture();
      for (const row of data.input.members)
        row.value!.processes[0]![field] += Math.round(25 * hours(data, row.slot) * 1048576);
      const privateGrowth = reportPrivateGrowth(data.input, RUN_ID, data.frames, dependencies);
      const rssGrowth = reportRssGrowth(data.input, RUN_ID, data.frames, dependencies);
      expect(privateGrowth.verdict).toBe(field === 'privateBytes' ? 'FAIL-product' : 'PASS');
      expect(rssGrowth.verdict).toBe(field === 'rssBytes' ? 'FAIL-product' : 'PASS');
    }
  });

  it('private各transition拓扑独立使用24门且不与负增长抵消', () => {
    for (const count of [4, 8]) {
      const data = groupedFixture();
      for (const slot of data.pulseBySlot.keys()) {
        const members = data.input.members[slot]!.value!;
        members.processes[0]!.privateBytes += Math.round(
          (members.processes.length === count ? 25 : -25) * hours(data, slot) * 1048576,
        );
      }
      const report = reportPrivateGrowth(data.input, RUN_ID, data.frames, dependencies);
      expect(
        report.transitionGroups.find((group) => group.memberCount === count)!.violations,
      ).toHaveLength(1);
      expect(report.verdict).toBe('FAIL-product');
      expect(reportRssGrowth(data.input, RUN_ID, data.frames, dependencies).verdict).toBe('PASS');
    }
  });

  it('未知owner与覆盖不足不能通过，绝对预算仍是1280/1792/2048', () => {
    const unknown = fixture({ transitions: [30, 120, 220, 320, 358] });
    expect(reportPrivateGrowth(unknown.input, RUN_ID, unknown.frames, dependencies).verdict).toBe(
      'BLOCKED/evidence-insufficient',
    );
    const data = groupedFixture();
    const group = reportPrivateGrowth(data.input, RUN_ID, data.frames, dependencies)
      .transitionGroups[0]!;
    for (const slot of group.slots.filter((slot) => data.pulseBySlot.get(slot)! < 5))
      data.input.members[slot]!.value = null;
    expect(reportPrivateGrowth(data.input, RUN_ID, data.frames, dependencies).verdict).toBe(
      'BLOCKED/evidence-insufficient',
    );
    unknown.input.members[30]!.value!.processes[0]!.privateBytes = 2049 * 1048576;
    const peak = reportPrivateGrowth(unknown.input, RUN_ID, unknown.frames, dependencies);
    expect(peak.absolute.violations.some((message) => message.includes('observedPeak'))).toBe(true);
    expect(peak.verdict).toBe('FAIL-product');
    const median = fixture({ transitions: [], ownedTransitionPulses: [] });
    for (const row of median.input.members) row.value!.processes[0]!.privateBytes = 1281 * 1048576;
    expect(
      reportPrivateGrowth(median.input, RUN_ID, median.frames, dependencies).absolute.violations,
    ).toEqual(['median=1281 超过 1280']);
    const p95 = fixture({ transitions: [], ownedTransitionPulses: [] });
    for (const row of p95.input.members.slice(0, 20))
      row.value!.processes[0]!.privateBytes = 1793 * 1048576;
    expect(
      reportPrivateGrowth(p95.input, RUN_ID, p95.frames, dependencies).absolute.violations,
    ).toEqual(['p95=1793 超过 1792']);
  });
});
