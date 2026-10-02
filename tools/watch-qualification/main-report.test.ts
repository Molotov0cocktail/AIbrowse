import { describe, expect, it } from 'vitest';
import {
  QUALIFICATION_REGISTRIES,
  type QualificationFrame,
  type QualificationPayloads,
  type QualificationReady,
  type QualificationRegistryLive,
} from '../../src/main/watch/qualification/native-contract.ts';
import { reportMain } from './main-report.ts';
import type { Window } from './resource-report.ts';

const runId = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const window: Window = {
  mode: 'formal',
  beginQpc: '100000',
  endQpc: '3700000',
  qpcFrequency: 1000,
  processors: 4,
};
const counters = {
  duplicateTerminalAttemptTotal: 0,
  uncaughtExceptionTotal: 0,
  unhandledRejectionTotal: 0,
};
const hex = (value: number): string => value.toString(16).padStart(16, '0');
function fixture(): QualificationFrame[] {
  const rows: QualificationFrame[] = [];
  const live: QualificationRegistryLive[] = QUALIFICATION_REGISTRIES.map((registry) => ({
    registry,
    identities: [],
  }));
  const add = <K extends keyof QualificationPayloads>(
    kind: K,
    payload: QualificationPayloads[K],
    slotIndex: number | null = null,
  ): void => {
    rows.push({
      version: 2,
      kind,
      payload,
      qualificationRunId: runId,
      sequence: rows.length + 1,
      slotIndex,
    } as QualificationFrame);
  };
  add('ready', { processType: 'browser', qpcFrequency: 1000 } as QualificationReady);
  for (const registry of ['watch-store', 'watch-db'] as const) {
    add('register', { registry, identity: `${registry}:1`, detail: null });
    live.find((row) => row.registry === registry)!.identities = [`${registry}:1`];
  }
  for (let slot = 0; slot <= 360; ++slot) {
    add(
      'sample',
      {
        counters,
        mainHeapUsedBytes: 100 * 1048576,
        nodeActiveByType: [{ type: 'Timeout', count: 4 }],
        phase: 'measurement',
        registryLive: structuredClone(live),
        registryPrefixSequence: rows.length,
        sampleToken: runId,
        taskTabBindings: [],
        timing: {
          linearizedQpcTicks: hex(100000 + slot * 10000),
          snapshotQpcTicks: hex(100000 + slot * 10000),
          slotQpcTicks: hex(100000 + slot * 10000),
          triggerQpcTicks: hex(100000 + slot * 10000),
        },
        watchLogicalDbBytes: 4096,
        webContentsIds: [1, 2],
      },
      slot,
    );
  }
  add('stop', {
    admissionClosedQpcTicks: hex(3700000),
    observedQpcTicks: hex(3700000),
    reason: 'normal-exit',
  });
  for (const registry of ['watch-db', 'watch-store'] as const) {
    add('unregister', { registry, identity: `${registry}:1`, detail: null });
    live.find((row) => row.registry === registry)!.identities = [];
  }
  add('complete', { counters, registryLive: structuredClone(live) });
  return rows;
}

describe('main prefix独立复算', () => {
  it('从完整序列复算资源并统计每个Node key', () => {
    const report = reportMain(window, runId, fixture());
    expect(report.verdict).toBe('PASS');
    expect(report.heapMiB.statistics!.count).toBe(361);
    expect(report.nodeByType.Timeout!.statistics!.median).toBe(4);
    expect(report.complete).toBe(true);
    expect(report.traceComplete).toBe(true);
  });
  it('拒绝伪身份、缺帧、伪prefix及假归零', () => {
    for (const mutate of [
      (rows: QualificationFrame[]) => {
        rows[5]!.qualificationRunId = '2'.repeat(26);
      },
      (rows: QualificationFrame[]) => {
        rows.splice(5, 1);
      },
      (rows: QualificationFrame[]) => {
        const row = rows[5]!;
        if (row.kind === 'sample') row.payload.registryPrefixSequence = 0;
      },
      (rows: QualificationFrame[]) => {
        const row = rows[5]!;
        if (row.kind === 'sample')
          row.payload.registryLive.find((live) => live.registry === 'watch-db')!.identities = [];
      },
    ]) {
      const rows = fixture();
      mutate(rows);
      expect(reportMain(window, runId, rows).verdict).toBe('BLOCKED/evidence-insufficient');
    }
  });
  it('Node每key/总量的泄漏不能被类型数替代或忽略', () => {
    const rows = fixture();
    for (const row of rows)
      if (row.kind === 'sample')
        row.payload.nodeActiveByType[0]!.count = 4 + Math.floor(row.slotIndex! / 20);
    const result = reportMain(window, runId, rows);
    expect(result.nodeByType.Timeout!.verdict).toBe('FAIL-product');
    expect(result.nodeTotal.verdict).toBe('FAIL-product');
  });
  it('真实资源硬峰值及逻辑DB大小越界必须失败', () => {
    const rows = fixture();
    const sample = rows.find((row) => row.kind === 'sample')!;
    if (sample.kind === 'sample') sample.payload.watchLogicalDbBytes = 104857601;
    expect(reportMain(window, runId, rows).violations).toContain('Watch逻辑数据库超过100MiB');
    expect(reportMain(window, runId, rows).verdict).toBe('FAIL-product');
  });
  it('较早坏prefix不能掩盖后续有效点的heap越界', () => {
    const rows = fixture();
    for (const row of rows)
      if (row.kind === 'sample') {
        if (row.slotIndex === 2) row.payload.registryPrefixSequence = 0;
        if (row.slotIndex === 200) row.payload.mainHeapUsedBytes = 600 * 1048576;
      }
    const result = reportMain(window, runId, rows);
    expect(result.verdict).toBe('FAIL-product');
    expect(result.heapMiB.statistics!.observedPeak).toBe(600);
  });
  it('未知DTO类型不能通过闭合协议', () => {
    const rows = fixture();
    rows.splice(1, 0, {
      version: 2,
      qualificationRunId: runId,
      sequence: 2,
      slotIndex: null,
      kind: 'not-a-real-kind',
      payload: {},
    } as unknown as QualificationFrame);
    rows.forEach((row, index) => {
      row.sequence = index + 1;
      if (row.kind === 'sample') row.payload.registryPrefixSequence = index;
    });
    expect(reportMain(window, runId, rows).verdict).toBe('BLOCKED/evidence-insufficient');
    expect(reportMain(window, runId, rows).evidenceIssues).toContain('出现未知遥测类型');
  });
  it('系统暂停使main持续窗口缺证但仍保留实际heap越界', () => {
    const rows = fixture();
    expect(reportMain(window, runId, rows, ['窗口发生系统暂停']).verdict).toBe(
      'BLOCKED/evidence-insufficient',
    );
    expect(reportMain(window, runId, rows, ['窗口发生系统暂停']).traceComplete).toBe(true);
    const sample = rows.find((row) => row.kind === 'sample')!;
    if (sample.kind === 'sample') sample.payload.mainHeapUsedBytes = 600 * 1048576;
    expect(reportMain(window, runId, rows, ['窗口发生系统暂停']).verdict).toBe('FAIL-product');
  });
});
