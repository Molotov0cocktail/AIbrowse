import { describe, expect, it } from 'vitest';
import type {
  QualificationFrame,
  QualificationRegistryEvent,
} from '../../src/main/watch/qualification/native-contract.ts';
import { reportLoad } from './load-report.ts';

function fixture(): QualificationFrame[] {
  const rows: QualificationFrame[] = [];
  let owner = 0;
  const add = (kind: 'register' | 'unregister', payload: QualificationRegistryEvent): void => {
    rows.push({
      version: 2,
      kind,
      payload,
      sequence: rows.length + 1,
      slotIndex: null,
      qualificationRunId: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    } as QualificationFrame);
  };
  const run = (
    index: number,
    phase: 'initialization' | 'warmup' | 'measurement',
    round: number | null,
  ): void => {
    const detail = { entryIndex: index, hostSlot: index % 4, phase, round };
    const coordinator: QualificationRegistryEvent = {
      registry: 'coordinator-slot',
      identity: `coordinator-slot:${++owner}`,
      detail,
    };
    const grant: QualificationRegistryEvent = {
      registry: 'host-grant',
      identity: `host-grant:${++owner}`,
      detail: { ...detail, attemptOrdinal: 1, grantElapsedMs: owner * 6000, waitedForGap: false },
    };
    add('register', coordinator);
    add('register', grant);
    if (index >= 80) {
      const tab: QualificationRegistryEvent = {
        registry: 'task-tab',
        identity: `task-tab:${++owner}`,
        detail: null,
      };
      add('register', tab);
      add('unregister', tab);
    }
    add('unregister', grant);
    add('unregister', coordinator);
  };
  rows.push({
    version: 2,
    kind: 'ready',
    qualificationRunId: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    sequence: 1,
    slotIndex: null,
    payload: { processType: 'browser' },
  } as QualificationFrame);
  for (let index = 0; index < 100; ++index) run(index, 'initialization', null);
  for (let index = 33; index < 100; ++index) run(index, 'warmup', null);
  for (let round = 0; round < 4; ++round)
    for (let index = 0; index < 100; ++index) run(index, 'measurement', round);
  rows.push({
    version: 2,
    kind: 'complete',
    qualificationRunId: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    sequence: rows.length + 1,
    slotIndex: null,
    payload: {
      counters: {
        duplicateTerminalAttemptTotal: 0,
        uncaughtExceptionTotal: 0,
        unhandledRejectionTotal: 0,
      },
      registryLive: [],
    },
  });
  return rows;
}

describe('固定负载独立owner复算', () => {
  it('逐键覆盖567次及120个Session Tab', () => {
    expect(reportLoad('formal', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', fixture(), true)).toMatchObject({
      verdict: 'PASS',
      expectedRuns: 567,
      coordinatorRuns: 567,
      hostGrants: 567,
      taskTabs: 120,
      perHost: [141, 142, 142, 142],
    });
  });
  it('相同总数中的重复与缺失不能互相抵消', () => {
    const rows = fixture();
    for (const frame of rows) {
      if (
        (frame.kind === 'register' || frame.kind === 'unregister') &&
        (frame.payload.registry === 'coordinator-slot' ||
          frame.payload.registry === 'host-grant') &&
        frame.payload.detail.phase === 'measurement' &&
        frame.payload.detail.round === 3 &&
        frame.payload.detail.entryIndex === 99
      )
        frame.payload.detail.entryIndex = 95;
    }
    expect(reportLoad('formal', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', rows, true).violations).toContain(
      '固定负载运行或grant重复',
    );
    expect(reportLoad('formal', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', rows, true).verdict).toBe(
      'FAIL-product',
    );
  });
  it('拒绝Coordinator早于存活grant释放以及错误host归属', () => {
    const rows = fixture();
    [rows[3], rows[4]] = [rows[4]!, rows[3]!];
    rows.forEach((row, index) => {
      row.sequence = index + 1;
    });
    expect(reportLoad('formal', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', rows, true).verdict).toBe(
      'FAIL-product',
    );
    const changed = fixture();
    const event = changed[2]!;
    if (event.kind === 'register' && event.payload.registry === 'host-grant')
      event.payload.detail.hostSlot = 1;
    expect(reportLoad('formal', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', changed, true).violations).toContain(
      '出现固定负载之外的运行或host绑定',
    );
  });
  it('未闭合轨迹缺证，闭合空负载及缺失Session创建失败', () => {
    expect(reportLoad('formal', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', [], false).verdict).toBe(
      'BLOCKED/evidence-insufficient',
    );
    const empty = fixture().filter((frame) => frame.kind === 'ready' || frame.kind === 'complete');
    empty[1]!.sequence = 2;
    expect(reportLoad('formal', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', empty, true).verdict).toBe(
      'FAIL-product',
    );
    const rows = fixture().filter(
      (frame) =>
        !(
          (frame.kind === 'register' || frame.kind === 'unregister') &&
          frame.payload.registry === 'task-tab'
        ),
    );
    rows.forEach((row, index) => {
      row.sequence = index + 1;
    });
    expect(reportLoad('formal', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', rows, true).violations).toContain(
      'Session任务Tab总数不匹配',
    );
  });
  it('伪run和null detail只产生缺证，不抛出或冒充产品失败', () => {
    const rows = fixture();
    const fake = structuredClone(rows[2]!);
    fake.qualificationRunId = '22222222222222222222222222';
    rows.splice(2, 0, fake);
    expect(reportLoad('formal', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', rows, false).verdict).toBe(
      'BLOCKED/evidence-insufficient',
    );
    const malformed = fixture();
    const grant = malformed[2]!;
    if (grant.kind === 'register') (grant.payload as unknown as { detail: unknown }).detail = null;
    expect(reportLoad('formal', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', malformed, false).verdict).toBe(
      'BLOCKED/evidence-insufficient',
    );
    const valid = rows.find(
      (frame) =>
        frame.kind === 'register' &&
        frame.qualificationRunId === 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' &&
        frame.payload.registry === 'host-grant',
    );
    if (valid?.kind === 'register' && valid.payload.registry === 'host-grant')
      valid.payload.detail.hostSlot = 1;
    expect(reportLoad('formal', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', rows, false).verdict).toBe(
      'FAIL-product',
    );
  });
  it('owner证据损坏后不从未知存活状态推导产品失败', () => {
    for (const mutate of [
      (row: QualificationFrame) => {
        (row as unknown as { payload: unknown }).payload = null;
      },
      (row: QualificationFrame) => {
        (row as unknown as { kind: string }).kind = 'unknown-owner';
      },
      (row: QualificationFrame) => {
        if (row.kind === 'register') (row.payload as unknown as { detail: unknown }).detail = null;
      },
      (row: QualificationFrame) => {
        if (row.kind === 'register') row.payload.identity = 'coordinator-slot:999999';
      },
    ]) {
      const rows = fixture();
      mutate(rows[1]!);
      expect(reportLoad('formal', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', rows, false).verdict).toBe(
        'BLOCKED/evidence-insufficient',
      );
    }
    const release = fixture();
    release[3] = structuredClone(release[3]!);
    const changed = release[3]!;
    if (changed.kind === 'unregister' && changed.payload.registry === 'host-grant')
      changed.payload.detail.hostSlot = 1;
    expect(reportLoad('formal', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', release, false).verdict).toBe(
      'BLOCKED/evidence-insufficient',
    );
  });
});
