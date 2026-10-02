import { describe, expect, it } from 'vitest';
import {
  reportResources,
  type Members,
  type Observation,
  type ResourceInput,
} from './resource-report.ts';
import { statistics } from './statistics.ts';

function fixture(): ResourceInput {
  const identity = { pid: 10, creationFileTime: '0000000000000100' };
  const member = {
    ...identity,
    inJob: true,
    rssBytes: 100 * 1048576,
    privateBytes: 120 * 1048576,
    handles: 100,
  };
  const at = (slot: number): string => String(100000 + slot * 10000);
  const observed = <T>(slot: number, value: T): Observation<T> => ({
    slot,
    beginQpc: at(slot),
    endQpc: at(slot),
    value,
  });
  return {
    window: { mode: 'formal', beginQpc: at(0), endQpc: at(360), qpcFrequency: 1000, processors: 4 },
    suspended: false,
    attempts: Array.from({ length: 361 }, (_, slot) => ({ slot, qpc: at(slot) })),
    cpu: Array.from({ length: 361 }, (_, slot) => observed(slot, String(slot * 4000000))),
    members: Array.from({ length: 361 }, (_, slot) =>
      observed<Members>(slot, { before: [identity], after: [identity], processes: [member] }),
    ),
  };
}

describe('独立资源报告反例', () => {
  it('用Job累计量与实际端点计算CPU，slot0不混入统计', () => {
    const input = fixture();
    input.cpu[0]!.value = '0';
    const report = reportResources(input);
    expect(report.verdict).toBe('PASS');
    expect(report.cpuPercent.statistics).toMatchObject({
      count: 360,
      median: 1,
      p95: 1,
      observedPeak: 1,
    });
    expect(report.cpuPercent.counterEndpointSpanSeconds).toBe(3600);
    expect(report.cpuPercent.coveredIntervalSeconds).toBe(3600);
    expect(report.cpuPercent.statistics?.spanSeconds).toBe(3590);
    input.cpu[20]!.value = String(20 * 4000000 + 300000000);
    expect(reportResources(input).cpuPercent.verdict).toBe('FAIL-product');
  });

  it('不跨缺失端点桥接，也不给CPU端点另一份缺样额度', () => {
    const input = fixture();
    input.cpu[100]!.value = null;
    expect(reportResources(input).cpuPercent.missingSlots).toEqual([100, 101]);
    expect(reportResources(input).cpuPercent.counterEndpointSpanSeconds).toBe(3600);
    expect(reportResources(input).cpuPercent.coveredIntervalSeconds).toBe(3580);
    expect(reportResources(input).cpuPercent.verdict).toBe('PASS');
    input.cpu[200]!.value = null;
    expect(reportResources(input).cpuPercent.missingSlots).toEqual([100, 101, 200, 201]);
    expect(reportResources(input).cpuPercent.verdict).toBe('BLOCKED/evidence-insufficient');
  });

  it('首末累计端点缺失和counter回退不能通过', () => {
    const input = fixture();
    input.cpu[0]!.value = null;
    expect(reportResources(input).cpuPercent.counterEndpointSpanSeconds).toBeNull();
    expect(reportResources(input).cpuPercent.coveredIntervalSeconds).toBe(3590);
    expect(reportResources(input).cpuPercent.verdict).toBe('BLOCKED/evidence-insufficient');
    const rollback = fixture();
    rollback.cpu[360]!.value = '1';
    expect(reportResources(rollback).cpuPercent.verdict).toBe('BLOCKED/evidence-insufficient');
  });

  it('仅接收第一份有效重复值，不按较低值挑选', () => {
    const input = fixture();
    input.members[0]!.value!.processes[0]!.rssBytes = 3000 * 1048576;
    // Fixture shares its constant member deliberately; replace a duplicate independently.
    const duplicate = structuredClone(input.members[0]!);
    duplicate.value!.processes[0]!.rssBytes = 10;
    input.members.push(duplicate);
    const report = reportResources(input);
    expect(report.rssMiB.verdict).toBe('FAIL-product');
    expect(report.rssMiB.duplicateSlots).toEqual([0]);
  });

  it('membership变化、PID复用、遗漏子进程和越权成员均缺证', () => {
    for (const mutate of [
      (value: Members) => {
        value.after.push({ pid: 11, creationFileTime: '0000000000000101' });
      },
      (value: Members) => {
        value.after[0]!.creationFileTime = '0000000000000200';
      },
      (value: Members) => {
        value.processes = [];
      },
      (value: Members) => {
        value.processes[0]!.inJob = false;
      },
    ]) {
      const input = structuredClone(fixture());
      for (let slot = 0; slot < 4; ++slot) mutate(input.members[slot]!.value!);
      expect(reportResources(input).rssMiB.verdict).toBe('BLOCKED/evidence-insufficient');
    }
  });

  it('迟到、跨窗口和缺样不补0，drain零不混入正式窗口', () => {
    const input = fixture();
    input.members[0]!.beginQpc = '99999';
    input.members[360]!.endQpc = '3700001';
    input.members[40]!.endQpc = '503000';
    expect(reportResources(input).rssMiB.missingSlots).toEqual([0, 40, 360]);
    expect(reportResources(input).rssMiB.verdict).toBe('PASS');
    input.members[50]!.value = null;
    expect(reportResources(input).rssMiB.verdict).toBe('BLOCKED/evidence-insufficient');
    expect(reportResources(input).rssMiB.statistics!.median).toBe(100);
  });

  it('节拍独立于有效数值；缺值不隐式认定系统暂停', () => {
    const input = fixture();
    input.members[5]!.value = null;
    input.members[6]!.value = null;
    expect(reportResources(input).rssMiB.verdict).toBe('PASS');
    input.attempts.splice(5, 2);
    expect(reportResources(input).rssMiB.verdict).toBe('BLOCKED/evidence-insufficient');
    const suspended = fixture();
    suspended.suspended = true;
    expect(reportResources(suspended).verdict).toBe('BLOCKED/evidence-insufficient');
  });

  it('缺证不能遮盖有效证据中的资源越界', () => {
    const input = fixture();
    input.cpu = [];
    input.members[20]!.value!.processes[0]!.handles = 6000;
    const report = reportResources(input);
    expect(report.cpuPercent.verdict).toBe('BLOCKED/evidence-insufficient');
    expect(report.handles.verdict).toBe('FAIL-product');
    expect(report.verdict).toBe('FAIL-product');
  });

  it('子进程退出后CPU仍归Job总量；不以当前成员CPU代替', () => {
    const input = fixture();
    for (let slot = 1; slot <= 360; ++slot) input.cpu[slot]!.value = String(slot * 1000000000);
    const report = reportResources(input);
    expect(report.cpuPercent.statistics!.median).toBe(250);
    expect(report.cpuPercent.verdict).toBe('FAIL-product');
  });

  it('点值资源超过三个缺点或非法数值不能通过', () => {
    const input = fixture();
    for (let slot = 0; slot < 4; ++slot) input.members[slot]!.value = null;
    expect(reportResources(input).rssMiB.verdict).toBe('BLOCKED/evidence-insufficient');
    input.members[5]!.value!.processes[0]!.rssBytes = Number.NaN;
    expect(reportResources(input).rssMiB.statistics).toBeNull();
  });

  it('OLS用实际QPC且带截距，P95是nearest-rank', () => {
    expect(
      statistics([
        { slot: 0, seconds: 100, value: 2 },
        { slot: 1, seconds: 1900, value: 8 },
        { slot: 2, seconds: 3700, value: 14 },
      ]),
    ).toMatchObject({ median: 8, p95: 14, slopePerHour: 12 });
  });

  it('短验不能冒充正式通过，正式时长不能缩短', () => {
    const input = fixture();
    input.window.mode = 'short';
    expect(reportResources(input).verdict).toBe('BLOCKED/evidence-insufficient');
    input.window.mode = 'formal';
    input.window.endQpc = '120000';
    expect(() => reportResources(input)).toThrow('六十分钟');
  });

  it('显式v2门替换增长判定但继续返回原全点OLS', () => {
    const input = fixture();
    for (let slot = 0; slot <= 360; ++slot) {
      const value = structuredClone(input.members[slot]!.value!);
      value.processes[0]!.handles = 1000 + Math.floor(slot / 3);
      input.members[slot]!.value = value;
    }
    const legacy = reportResources(input);
    expect(legacy.handleGrowthRevision).toBe('raw-all-points-v1');
    expect(legacy.handles.statistics!.slopePerHour).toBeCloseTo(120, 1);
    expect(legacy.verdict).toBe('FAIL-product');
    const revised = reportResources(input, {
      handleGrowth: { revision: 'handle-growth-v2', verdict: 'PASS' },
    });
    expect(revised.handleGrowthRevision).toBe('handle-growth-v2');
    expect(revised.handles.statistics!.slopePerHour).toBeCloseTo(120, 1);
    expect(revised.handles.verdict).toBe('FAIL-product');
    expect(revised.verdict).toBe('PASS');
  });
});
