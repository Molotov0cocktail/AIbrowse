import { describe, expect, it, vi } from 'vitest';
import type { QualificationFrame } from '../../src/main/watch/qualification/native-contract.ts';
import {
  BEGIN,
  FREQUENCY,
  dependencies,
  fixture,
  groupedFixture,
  hours,
  resequence,
  RUN_ID,
} from './growth-report-fixture.ts';
import { reportHandleGrowth } from './handle-growth-report.ts';
import { reportPrivateGrowth } from './private-growth-report.ts';
import { reportRssGrowth } from './rss-growth-report.ts';
import { statistics } from './statistics.ts';
import * as regression from './statistics.ts';

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
    const report = reportRssGrowth(data.input, RUN_ID, data.frames, dependencies);
    expect(report.rawAllPoints.statistics).toMatchObject({
      median: 400,
      p95: 800,
      observedPeak: 800,
    });
    expect(report.rawAllPoints.statistics!.slopePerHour).toBeGreaterThan(24);
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
    expect(phaseShortcut.verdict).toBe('BLOCKED/evidence-insufficient');
    expect(statistics(transitionPoints)!.slopePerHour).toBeCloseTo(300, 8);
    const report = reportRssGrowth(data.input, RUN_ID, data.frames, dependencies);
    expect(report.rawAllPoints.statistics!.slopePerHour).toBeLessThan(24);
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
    const report = reportRssGrowth(data.input, RUN_ID, data.frames, dependencies);
    expect(report.rawAllPoints.statistics!.observedPeak).toBe(800);
    expect(report.verdict).not.toBe('FAIL-product');
  });

  it('四轮覆盖充分时transition的4/8固定成本比例变化可通过，聚合裸斜率仍完整保留', () => {
    const data = groupedFixture();
    const report = reportRssGrowth(data.input, RUN_ID, data.frames, dependencies);
    const transition = [...data.pulseBySlot.keys()].map((slot) => ({
      slot,
      seconds: hours(data, slot) * 3600,
      value: data.input.members[slot]!.value!.processes.length * 100,
    }));
    expect(statistics(transition)!.slopePerHour).toBeGreaterThan(24);
    expect(report.verdict).toBe('PASS');
    expect(report.classifications.transition).toBe(20);
    expect(report.transitionGroups.map((group) => group.roundPoints)).toEqual([
      [3, 3, 2, 2],
      [2, 2, 3, 3],
    ]);
    expect(
      report.transitionGroups.every(
        (group) => group.coverageComplete && group.statistics!.slopePerHour === 0,
      ),
    ).toBe(true);
    expect(reportHandleGrowth(data.input, RUN_ID, data.frames, dependencies).verdict).toBe('PASS');
  });

  it('固定Session大峰之下的单一transition拓扑持续增长仍FAIL', () => {
    const data = groupedFixture();
    for (const slot of data.pulseBySlot.keys()) {
      const row = data.input.members[slot]!;
      if (row.value!.processes.length === 4)
        row.value!.processes[0]!.rssBytes += Math.round(300 * hours(data, slot) * 1048576);
    }
    const report = reportRssGrowth(data.input, RUN_ID, data.frames, dependencies);
    expect(report.idle.statistics!.slopePerHour).toBe(0);
    expect(report.session.statistics!.slopePerHour).toBe(0);
    expect(report.absolute.statistics!.observedPeak).toBe(800);
    expect(report.transitionGroups[0]!.statistics!.slopePerHour).toBeCloseTo(300, 5);
    expect(report.transitionGroups[1]!.violations).toEqual([]);
    expect(report.verdict).toBe('FAIL-product');
  });

  it('RSS每个拓扑独立使用24门，负斜率和其它拓扑缺证不能抵消有效失败', () => {
    for (const growingCount of [4, 8]) {
      const data = groupedFixture();
      for (const slot of data.pulseBySlot.keys()) {
        const member = data.input.members[slot]!.value!;
        member.processes[0]!.rssBytes += Math.round(
          (member.processes.length === growingCount ? 25 : -25) * hours(data, slot) * 1048576,
        );
      }
      let report = reportRssGrowth(data.input, RUN_ID, data.frames, dependencies);
      expect(
        report.transitionGroups.find((group) => group.memberCount === growingCount)!.violations,
      ).toHaveLength(1);
      expect(report.verdict).toBe('FAIL-product');
      const other = report.transitionGroups.find((group) => group.memberCount !== growingCount)!;
      for (const slot of other.slots.filter((slot) => data.pulseBySlot.get(slot)! < 5))
        data.input.members[slot]!.value = null;
      report = reportRssGrowth(data.input, RUN_ID, data.frames, dependencies);
      expect(
        report.transitionGroups.find((group) => group.memberCount !== growingCount)!
          .coverageComplete,
      ).toBe(false);
      expect(report.verdict).toBe('FAIL-product');
    }
  });

  it('handle-v3也对每个transition拓扑使用60门，不能只修RSS', () => {
    for (const growingCount of [4, 8]) {
      const data = groupedFixture();
      for (const slot of data.pulseBySlot.keys()) {
        const member = data.input.members[slot]!.value!;
        if (member.processes.length === growingCount)
          member.processes[0]!.handles += Math.round(61 * hours(data, slot));
      }
      const report = reportHandleGrowth(data.input, RUN_ID, data.frames, dependencies);
      expect(report.revision).toBe('handle-growth-v3');
      expect(
        report.transitionGroups.find((group) => group.memberCount === growingCount)!.violations,
      ).toHaveLength(1);
      expect(report.verdict).toBe('FAIL-product');
    }
  });

  it('稳定idle和Session仍各自对原始总量增长判定，不按人数再细分', () => {
    for (const session of [false, true]) {
      const data = groupedFixture();
      for (const row of data.input.members) {
        if (!data.pulseBySlot.has(row.slot) && data.busy.has(row.slot) === session) {
          row.value!.processes[0]!.rssBytes += Math.round(25 * hours(data, row.slot) * 1048576);
          row.value!.processes[0]!.handles += Math.round(61 * hours(data, row.slot));
        }
      }
      const rss = reportRssGrowth(data.input, RUN_ID, data.frames, dependencies);
      const handle = reportHandleGrowth(data.input, RUN_ID, data.frames, dependencies);
      expect((session ? rss.session : rss.idle).violations).toHaveLength(1);
      expect((session ? handle.session : handle.idle).violations).toHaveLength(1);
      expect(rss.verdict).toBe('FAIL-product');
      expect(handle.verdict).toBe('FAIL-product');
    }
  });

  it('一个拓扑缺轮、轮内仅一点或晚期首次出现均BLOCKED', () => {
    for (const removeCount of [1, 2]) {
      const data = groupedFixture();
      const selected = reportRssGrowth(data.input, RUN_ID, data.frames, dependencies)
        .transitionGroups[0]!;
      const lastRound = selected.slots.filter((slot) => data.pulseBySlot.get(slot)! >= 15);
      for (const slot of lastRound.slice(0, removeCount)) data.input.members[slot]!.value = null;
      const report = reportRssGrowth(data.input, RUN_ID, data.frames, dependencies);
      expect(report.absolute.verdict).toBe('PASS');
      expect(report.transitionGroups[0]!.coverageComplete).toBe(false);
      expect(report.verdict).toBe('BLOCKED/evidence-insufficient');
    }
    const late = groupedFixture((pulse) =>
      pulse === 19 ? 9 : pulse % 5 < (pulse < 10 ? 3 : 2) ? 4 : 8,
    );
    const report = reportRssGrowth(late.input, RUN_ID, late.frames, dependencies);
    expect(report.transitionGroups.find((group) => group.memberCount === 9)!.roundPoints).toEqual([
      0, 0, 0, 1,
    ]);
    expect(report.verdict).toBe('BLOCKED/evidence-insufficient');
  });

  it('四轮各两点但实际跨度不足2700秒的拓扑仍BLOCKED', () => {
    const data = groupedFixture((pulse) =>
      (pulse < 5 && pulse % 5 >= 3) || (pulse >= 5 && pulse % 5 <= 1) ? 9 : 4,
    );
    const report = reportRssGrowth(data.input, RUN_ID, data.frames, dependencies);
    const group = report.transitionGroups.find((row) => row.memberCount === 9)!;
    expect(group.roundPoints).toEqual([2, 2, 2, 2]);
    expect(group.spanSeconds).toBeLessThan(2700);
    expect(group.coverageComplete).toBe(false);
    expect(report.verdict).toBe('BLOCKED/evidence-insufficient');
  });

  it('没有transition明确报告未观察到，不虚构通过分组', () => {
    const data = fixture({ transitions: [], ownedTransitionPulses: [] });
    const report = reportRssGrowth(data.input, RUN_ID, data.frames, dependencies);
    expect(report.transitionObserved).toBe(false);
    expect(report.transitionGroups).toEqual([]);
    expect(report.verdict).toBe('PASS');
  });

  it('锚间完整owner分别属于两round时，不按QPC或最近一轮猜归属', () => {
    const data = groupedFixture();
    const coordinator = data.frames.find(
      (frame) => frame.kind === 'register' && frame.payload.registry === 'coordinator-slot',
    )!;
    const base = { qualificationRunId: RUN_ID, sequence: 0, slotIndex: null, version: 2 as const };
    const extra: QualificationFrame[] = [];
    for (let offset = 0; offset < 4; ++offset)
      extra.push({
        ...base,
        kind: 'register',
        payload: {
          registry: 'coordinator-slot',
          identity: `coordinator-slot:${900 + offset}`,
          detail: { phase: 'measurement', round: 1, entryIndex: 80 + offset, hostSlot: offset },
        },
      });
    for (const kind of ['register', 'unregister'] as const)
      extra.push({
        ...base,
        kind,
        payload: { registry: 'task-tab', identity: 'task-tab:900', detail: null },
      });
    for (const frame of extra.slice(0, 4))
      if (frame.kind === 'register') extra.push({ ...frame, kind: 'unregister' });
    data.frames.splice(data.frames.indexOf(coordinator), 0, ...extra);
    data.frames = resequence(data.frames);
    for (const reporter of [reportRssGrowth, reportPrivateGrowth, reportHandleGrowth]) {
      const report = reporter(data.input, RUN_ID, data.frames, dependencies);
      expect(report.classifications).toEqual({
        idle: 290,
        session: 51,
        transition: 20,
        unclassified: 0,
      });
      expect(report.transitionUnassignedSlots).toEqual([68]);
      expect(report.transitionGroups[0]!.count).toBe(10);
      expect(report.transitionGroups[0]!.roundPoints).toEqual([2, 3, 2, 2]);
      expect(report.transitionGroups[0]!.coverageComplete).toBe(false);
      expect(report.verdict).toBe('BLOCKED/evidence-insufficient');
    }
  });

  it('阈值判据接受恰24或60，拒绝一个浮点步长的越界，不加epsilon', () => {
    const calculate = regression.statistics;
    for (const [reporter, limit] of [
      [reportRssGrowth, 24],
      [reportPrivateGrowth, 24],
      [reportHandleGrowth, 60],
    ] as const) {
      const data = groupedFixture();
      for (const slope of [limit, limit + Number.EPSILON * limit]) {
        // Isolate the decision boundary; actual QPC regression is checked separately below.
        const spy = vi.spyOn(regression, 'statistics').mockImplementation((points) => {
          const result = calculate(points);
          return result === null ? null : { ...result, slopePerHour: slope };
        });
        try {
          const report = reporter(data.input, RUN_ID, data.frames, dependencies);
          expect(report.idle.coverageComplete).toBe(true);
          expect(report.session.coverageComplete).toBe(true);
          expect(report.transitionGroups.every((group) => group.coverageComplete)).toBe(true);
          expect(report.verdict).toBe(slope === limit ? 'PASS' : 'FAIL-product');
        } finally {
          spy.mockRestore();
        }
      }
    }
  });

  it('过渡回归使用不等间隔的实际QPC，不以slot代替采样时刻', () => {
    const data = groupedFixture();
    const points = [];
    for (const [slot, pulse] of data.pulseBySlot) {
      const row = data.input.members[slot]!;
      if (row.value!.processes.length !== 4) continue;
      const end = BEGIN + slot * 10 * FREQUENCY + (pulse < 10 ? -400 : 400);
      row.beginQpc = row.endQpc = String(end);
      row.value!.processes[0]!.rssBytes += Math.round(25 * hours(data, slot) * 1048576);
      points.push({ slot, seconds: slot * 10, value: 400 + 25 * hours(data, slot) });
    }
    const report = reportRssGrowth(data.input, RUN_ID, data.frames, dependencies);
    expect(report.transitionGroups[0]!.statistics!.slopePerHour).toBeCloseTo(25, 5);
    expect(Math.abs(statistics(points)!.slopePerHour! - 25)).toBeGreaterThan(0.001);
    expect(report.verdict).toBe('FAIL-product');
  });

  it('资源数值任意置换不改变phase、拓扑成员或可信round归属', () => {
    const data = groupedFixture();
    const before = reportRssGrowth(data.input, RUN_ID, data.frames, dependencies);
    for (const row of data.input.members) {
      row.value!.processes[0]!.rssBytes = (361 - row.slot) * 1048576;
      row.value!.processes[0]!.handles = row.slot * 3;
    }
    const after = reportRssGrowth(data.input, RUN_ID, data.frames, dependencies);
    expect(after.phaseSlots).toEqual(before.phaseSlots);
    expect(
      after.transitionGroups.map(({ memberCount, roundPoints, slots }) => ({
        memberCount,
        roundPoints,
        slots,
      })),
    ).toEqual(
      before.transitionGroups.map(({ memberCount, roundPoints, slots }) => ({
        memberCount,
        roundPoints,
        slots,
      })),
    );
  });

  it('全部点绝对峰值失败不被未知owner或覆盖不足隐藏', () => {
    const data = fixture({ transitions: [30, 120, 220, 320, 358] });
    data.input.members[30]!.value!.processes[0]!.rssBytes = 2049 * 1048576;
    const report = reportRssGrowth(data.input, RUN_ID, data.frames, dependencies);
    expect(report.transitionUnassignedSlots).toEqual([30, 120, 220, 320, 358]);
    expect(report.absolute.violations).toHaveLength(1);
    expect(report.verdict).toBe('FAIL-product');
  });
});
