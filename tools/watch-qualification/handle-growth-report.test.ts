import { describe, expect, it } from 'vitest';
import type {
  QualificationCoordinatorDetail,
  QualificationFrame,
  QualificationReady,
} from '../../src/main/watch/qualification/native-contract.ts';
import { reportHandleGrowth } from './handle-growth-report.ts';
import type { Members, Observation, ResourceInput } from './resource-report.ts';

const RUN_ID = 'C7XQOSFIJOEGPO7ZLEYRELGKNA';
const FREQUENCY = 1000;
const BEGIN = 100000;
const PULSE_STARTS = [
  69, 73, 76, 80, 83, 159, 163, 166, 170, 173, 254, 257, 261, 264, 268, 339, 343, 346, 350, 353,
];
const PULSE_LENGTHS = [3, 2, 3, 2, 3, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3];

interface FixtureOptions {
  handle?: (slot: number, session: boolean) => number;
  transitions?: number[];
}

function hexQpc(value: number): string {
  return value.toString(16).padStart(16, '0');
}

function ready(): QualificationReady {
  const roots = {
    appDataRoot: 'a',
    localAppDataRoot: 'b',
    processTempRoot: 'c',
    runRoot: 'd',
    userDataRoot: 'e',
    watchTempRoot: 'f',
  };
  return {
    appPathFileId: 'app',
    electronExeFileId: 'electron',
    mainCreationFileTime: '0000000000000001',
    mainEntrySha256: '0'.repeat(64),
    mainPid: 1,
    processExecPathSha256: '1'.repeat(64),
    processType: 'browser',
    qpcFrequency: FREQUENCY,
    rootFileIds: roots,
    serverCreationFileTime: '0000000000000002',
    serverPid: 2,
  };
}

function fixture(options: FixtureOptions = {}): {
  input: ResourceInput;
  frames: QualificationFrame[];
  pulseSlots: number[][];
} {
  const phase = new Map<number, number>();
  const pulseSlots = PULSE_STARTS.map((start, pulseIndex) =>
    Array.from({ length: PULSE_LENGTHS[pulseIndex]! }, (_, offset) => start + offset),
  );
  for (const [pulseIndex, slots] of pulseSlots.entries())
    for (const slot of slots) phase.set(slot, pulseIndex);
  const transitions = new Set(options.transitions ?? [30, 120, 220, 320, 358]);
  const frames: QualificationFrame[] = [];
  const add = (frame: QualificationFrame): void => {
    frames.push({ ...frame, sequence: frames.length + 1 } as QualificationFrame);
  };
  const base = {
    qualificationRunId: RUN_ID,
    sequence: 0,
    slotIndex: null,
    version: 2 as const,
  };
  add({ ...base, kind: 'ready', payload: ready() });
  let currentPulse: number | null = null;
  let taskIdentity = 0;
  let coordinatorIdentity = 0;
  const liveTasks: string[] = [];
  const liveCoordinators: { identity: string; detail: QualificationCoordinatorDetail }[] = [];
  const registerPulse = (pulseIndex: number): void => {
    const round = Math.floor(pulseIndex / 5);
    const pulse = pulseIndex % 5;
    for (let offset = 0; offset < 4; ++offset) {
      const detail: QualificationCoordinatorDetail = {
        entryIndex: 80 + pulse * 4 + offset,
        hostSlot: offset,
        phase: 'measurement',
        round,
      };
      const identity = `coordinator-slot:${++coordinatorIdentity}`;
      liveCoordinators.push({ identity, detail });
      add({
        ...base,
        kind: 'register',
        payload: { registry: 'coordinator-slot', identity, detail },
      });
    }
    for (let offset = 0; offset < 4; ++offset) {
      const identity = `task-tab:${++taskIdentity}`;
      liveTasks.push(identity);
      add({ ...base, kind: 'register', payload: { registry: 'task-tab', identity, detail: null } });
    }
  };
  const releasePulse = (): void => {
    for (const identity of liveTasks.splice(0))
      add({
        ...base,
        kind: 'unregister',
        payload: { registry: 'task-tab', identity, detail: null },
      });
    for (const { identity, detail } of liveCoordinators.splice(0))
      add({
        ...base,
        kind: 'unregister',
        payload: { registry: 'coordinator-slot', identity, detail },
      });
  };
  const heartbeat = (qpc: number): void => {
    add({ ...base, kind: 'heartbeat', payload: { qpcTicks: hexQpc(qpc) } });
  };

  const identity = { pid: 10, creationFileTime: '0000000000000100' };
  const members: Observation<Members>[] = [];
  for (let slot = 0; slot <= 360; ++slot) {
    const desired = phase.get(slot) ?? null;
    if (desired !== currentPulse) {
      if (currentPulse !== null) releasePulse();
      if (desired !== null) registerPulse(desired);
      currentPulse = desired;
    }
    const target = BEGIN + slot * 10 * FREQUENCY;
    heartbeat(slot === 0 ? target : target - 500);
    if (transitions.has(slot)) {
      const transient = `task-tab:${++taskIdentity}`;
      add({
        ...base,
        kind: 'register',
        payload: { registry: 'task-tab', identity: transient, detail: null },
      });
      add({
        ...base,
        kind: 'unregister',
        payload: { registry: 'task-tab', identity: transient, detail: null },
      });
    }
    heartbeat(slot === 360 ? target : target + 500);
    const session = desired !== null;
    const handles = options.handle?.(slot, session) ?? 1000 + (session ? 4 * 246 : 0);
    const member = {
      ...identity,
      inJob: true,
      rssBytes: 100 * 1048576,
      privateBytes: 120 * 1048576,
      handles,
    };
    members.push({
      slot,
      beginQpc: String(slot === 0 ? target + 100 : target - 100),
      endQpc: String(slot === 360 ? target - 100 : target + 100),
      value: { before: [identity], after: [identity], processes: [member] },
    });
  }
  if (currentPulse !== null) releasePulse();
  add({
    ...base,
    kind: 'complete',
    payload: {
      counters: {
        duplicateTerminalAttemptTotal: 0,
        uncaughtExceptionTotal: 0,
        unhandledRejectionTotal: 0,
      },
      registryLive: [],
    },
  });
  const at = (slot: number): string => String(BEGIN + slot * 10 * FREQUENCY);
  return {
    input: {
      window: {
        mode: 'formal',
        beginQpc: at(0),
        endQpc: at(360),
        qpcFrequency: FREQUENCY,
        processors: 4,
      },
      attempts: Array.from({ length: 361 }, (_, slot) => ({ slot, qpc: at(slot) })),
      suspended: false,
      cpu: Array.from({ length: 361 }, (_, slot) => ({
        slot,
        beginQpc: at(slot),
        endQpc: at(slot),
        value: String(slot * 1000000),
      })),
      members,
    },
    frames,
    pulseSlots,
  };
}

function resequence(frames: QualificationFrame[]): QualificationFrame[] {
  return frames.map((frame, index) => ({ ...frame, sequence: index + 1 }) as QualificationFrame);
}

const dependencies = {
  mainTraceComplete: true,
  loadVerdict: 'PASS' as const,
};

describe('handle-growth-v2反例', () => {
  it('恒定周期成本会保留raw OLS失败，但两个阶段均可通过', () => {
    const { input, frames } = fixture();
    const report = reportHandleGrowth(input, RUN_ID, frames, dependencies);
    expect(report.revision).toBe('handle-growth-v2');
    expect(report.classifications).toEqual({
      idle: 305,
      session: 51,
      transition: 5,
      unclassified: 0,
    });
    expect(report.rawAllPoints.statistics!.slopePerHour).toBeGreaterThan(60);
    expect(report.rawAllPoints.verdict).toBe('FAIL-product');
    expect(report.idle.statistics!.slopePerHour).toBeCloseTo(0, 8);
    expect(report.session.statistics!.slopePerHour).toBeCloseTo(0, 8);
    expect(
      report.pulseCoverage.every((pulse) => pulse.lifecycleComplete && pulse.points >= 1),
    ).toBe(true);
    expect(report.verdict).toBe('PASS');
  });

  it('检出两阶段共同泄漏、仅Session泄漏和每轮台阶式残留', () => {
    const common = fixture({
      handle: (slot, session) => 1000 + (session ? 4 * 246 : 0) + Math.floor(slot / 3),
    });
    let report = reportHandleGrowth(common.input, RUN_ID, common.frames, dependencies);
    expect(report.verdict).toBe('FAIL-product');
    expect(report.idle.violations).toHaveLength(1);
    expect(report.session.violations).toHaveLength(1);

    const busyOnly = fixture({
      handle: (slot, session) => 1000 + (session ? 4 * 246 + Math.floor(slot / 3) : 0),
    });
    report = reportHandleGrowth(busyOnly.input, RUN_ID, busyOnly.frames, dependencies);
    expect(report.idle.violations).toHaveLength(0);
    expect(report.session.violations).toHaveLength(1);

    const stepped = fixture({
      handle: (slot, session) =>
        1000 + (session ? 4 * 246 : 0) + (slot >= 159 ? 100 : 0) + (slot >= 254 ? 100 : 0),
    });
    report = reportHandleGrowth(stepped.input, RUN_ID, stepped.frames, dependencies);
    expect(report.verdict).toBe('FAIL-product');
    expect(report.idle.violations.length + report.session.violations.length).toBeGreaterThan(0);
  });

  it('净count相同的task-tab换代仍是过渡', () => {
    const { input, frames } = fixture();
    const report = reportHandleGrowth(input, RUN_ID, frames, dependencies);
    expect(report.classifications.transition).toBe(5);
    expect(report.classifications.idle + report.classifications.session).toBe(356);
  });

  it('缺锚、错序列和坏QPC均按缺证收口，不塞入过渡', () => {
    const missing = fixture();
    const heartbeatIndex = missing.frames.findIndex((frame) => frame.kind === 'heartbeat');
    missing.frames.splice(heartbeatIndex, 1);
    missing.frames = resequence(missing.frames);
    let report = reportHandleGrowth(missing.input, RUN_ID, missing.frames, dependencies);
    expect(report.verdict).toBe('BLOCKED/evidence-insufficient');
    expect(report.classifications.unclassified).toBeGreaterThan(0);

    const wrongSequence = fixture();
    wrongSequence.frames[5] = { ...wrongSequence.frames[5]!, sequence: 99 } as QualificationFrame;
    report = reportHandleGrowth(wrongSequence.input, RUN_ID, wrongSequence.frames, dependencies);
    expect(report.verdict).toBe('BLOCKED/evidence-insufficient');
    expect(report.classifications.transition).toBe(0);
    expect(report.classifications.unclassified).toBe(361);

    const badQpc = fixture();
    const heartbeat = badQpc.frames.findIndex((frame) => frame.kind === 'heartbeat');
    badQpc.frames[heartbeat] = {
      ...badQpc.frames[heartbeat]!,
      payload: { qpcTicks: 'not-a-qpc' },
    } as QualificationFrame;
    report = reportHandleGrowth(badQpc.input, RUN_ID, badQpc.frames, dependencies);
    expect(report.verdict).toBe('BLOCKED/evidence-insufficient');
    expect(report.evidenceIssues).toContain('main阶段锚或owner字段无效');
  });

  it('合法QPC后退与超过12秒的锚距均是缺证，不是过渡', () => {
    const backwards = fixture();
    const heartbeats = backwards.frames
      .map((frame, index) => ({ frame, index }))
      .filter((row) => row.frame.kind === 'heartbeat');
    const first = heartbeats[10]!.frame;
    const secondIndex = heartbeats[11]!.index;
    if (first.kind !== 'heartbeat') throw new Error('测试夹具heartbeat缺失');
    backwards.frames[secondIndex] = {
      ...backwards.frames[secondIndex]!,
      payload: { qpcTicks: hexQpc(Number(BigInt(`0x${first.payload.qpcTicks}`) - 1n)) },
    } as QualificationFrame;
    let report = reportHandleGrowth(backwards.input, RUN_ID, backwards.frames, dependencies);
    expect(report.verdict).toBe('BLOCKED/evidence-insufficient');
    expect(report.evidenceIssues).toContain('heartbeat/sample锚的QPC与序列不一致');
    expect(report.classifications.transition).toBe(0);

    const gap = fixture();
    const target = BEGIN + 50 * 10 * FREQUENCY;
    const removed = new Set([hexQpc(target - 500), hexQpc(target + 500)]);
    gap.frames = resequence(
      gap.frames.filter(
        (frame) => frame.kind !== 'heartbeat' || !removed.has(frame.payload.qpcTicks),
      ),
    );
    report = reportHandleGrowth(gap.input, RUN_ID, gap.frames, dependencies);
    expect(report.verdict).toBe('BLOCKED/evidence-insufficient');
    expect(report.evidenceIssues).toContain('至少一个members观察的锚序、锚距或QPC不可信');
    expect(report.classifications.transition).toBe(5);
  });

  it('跨过OS begin的sample区间不能冒充前锚', () => {
    const crossed = fixture();
    const target = BEGIN + 50 * 10 * FREQUENCY;
    const removed = new Set([
      hexQpc(target - 10 * FREQUENCY - 500),
      hexQpc(target - 10 * FREQUENCY + 500),
      hexQpc(target - 500),
    ]);
    crossed.frames = crossed.frames.filter(
      (frame) => frame.kind !== 'heartbeat' || !removed.has(frame.payload.qpcTicks),
    );
    const rightIndex = crossed.frames.findIndex(
      (frame) => frame.kind === 'heartbeat' && frame.payload.qpcTicks === hexQpc(target + 500),
    );
    const sample: QualificationFrame = {
      kind: 'sample',
      payload: {
        counters: {
          duplicateTerminalAttemptTotal: 0,
          uncaughtExceptionTotal: 0,
          unhandledRejectionTotal: 0,
        },
        mainHeapUsedBytes: 1,
        nodeActiveByType: [],
        phase: 'measurement',
        registryLive: [],
        registryPrefixSequence: 0,
        sampleToken: 'SAMPLE',
        taskTabBindings: [],
        timing: {
          linearizedQpcTicks: hexQpc(target - 500),
          slotQpcTicks: hexQpc(target),
          snapshotQpcTicks: hexQpc(target),
          triggerQpcTicks: hexQpc(target - 500),
        },
        watchLogicalDbBytes: 0,
        webContentsIds: [],
      },
      qualificationRunId: RUN_ID,
      sequence: 0,
      slotIndex: 50,
      version: 2,
    };
    crossed.frames.splice(rightIndex, 0, sample);
    crossed.frames = resequence(crossed.frames);
    const report = reportHandleGrowth(crossed.input, RUN_ID, crossed.frames, dependencies);
    expect(report.verdict).toBe('BLOCKED/evidence-insufficient');
    expect(report.classifications.unclassified).toBeGreaterThan(0);
    expect(report.evidenceIssues).toContain('至少一个members观察的锚序、锚距或QPC不可信');
  });

  it('缺pulse、阶段覆盖不足和过渡过多均不能授PASS', () => {
    const missingPulse = fixture();
    for (const slot of missingPulse.pulseSlots[1]!) missingPulse.input.members[slot]!.value = null;
    let report = reportHandleGrowth(missingPulse.input, RUN_ID, missingPulse.frames, dependencies);
    expect(report.verdict).toBe('BLOCKED/evidence-insufficient');
    expect(report.session.coverageComplete).toBe(false);

    const lowCoverage = fixture();
    for (let slot = 2; slot <= 360; ++slot) lowCoverage.input.members[slot]!.value = null;
    report = reportHandleGrowth(lowCoverage.input, RUN_ID, lowCoverage.frames, dependencies);
    expect(report.verdict).toBe('BLOCKED/evidence-insufficient');
    expect(report.idle.violations).toEqual([]);

    const busy = new Set(
      PULSE_STARTS.flatMap((start, index) =>
        Array.from({ length: PULSE_LENGTHS[index]! }, (_, offset) => start + offset),
      ),
    );
    const excessiveTransitions = Array.from({ length: 361 }, (_, slot) => slot)
      .filter((slot) => !busy.has(slot))
      .slice(0, 37);
    const excessive = fixture({ transitions: excessiveTransitions });
    report = reportHandleGrowth(excessive.input, RUN_ID, excessive.frames, dependencies);
    expect(report.classifications.transition).toBe(37);
    expect(report.verdict).toBe('BLOCKED/evidence-insufficient');
  });

  it('四个members缺点即使两阶段覆盖仍足够也不能通过', () => {
    const incomplete = fixture();
    for (const slot of [10, 20, 40, 60]) incomplete.input.members[slot]!.value = null;
    const report = reportHandleGrowth(incomplete.input, RUN_ID, incomplete.frames, dependencies);
    expect(report.idle.coverageComplete).toBe(true);
    expect(report.session.coverageComplete).toBe(true);
    expect(report.absolute.verdict).toBe('BLOCKED/evidence-insufficient');
    expect(report.verdict).toBe('BLOCKED/evidence-insufficient');
  });

  it('一个阶段覆盖完整且超限时不被另一阶段缺波遮蔽', () => {
    const mixed = fixture({
      handle: (slot, session) => 1000 + (session ? 4 * 246 : 0) + Math.floor(slot / 3),
    });
    for (const slot of mixed.pulseSlots[0]!) mixed.input.members[slot]!.value = null;
    const report = reportHandleGrowth(mixed.input, RUN_ID, mixed.frames, dependencies);
    expect(report.idle.coverageComplete).toBe(true);
    expect(report.idle.violations).toHaveLength(1);
    expect(report.session.coverageComplete).toBe(false);
    expect(report.session.violations).toEqual([]);
    expect(report.verdict).toBe('FAIL-product');
  });

  it('count为4但未绑定完整Coordinator波时不能满足pulse覆盖', () => {
    const unbound = fixture();
    const coordinatorIndexes = unbound.frames
      .map((frame, index) => ({ frame, index }))
      .filter(
        (row) => row.frame.kind === 'register' && row.frame.payload.registry === 'coordinator-slot',
      )
      .map((row) => row.index);
    const taskIndexes = unbound.frames
      .map((frame, index) => ({ frame, index }))
      .filter((row) => row.frame.kind === 'register' && row.frame.payload.registry === 'task-tab')
      .map((row) => row.index);
    const lateCoordinator = unbound.frames.splice(coordinatorIndexes[3]!, 1)[0]!;
    const fourthTask = taskIndexes[3]! - 1;
    unbound.frames.splice(fourthTask + 1, 0, lateCoordinator);
    unbound.frames = resequence(unbound.frames);
    const report = reportHandleGrowth(unbound.input, RUN_ID, unbound.frames, dependencies);
    expect(report.classifications.session).toBe(51);
    expect(report.pulseCoverage[0]!.lifecycleComplete).toBe(false);
    expect(report.session.coverageComplete).toBe(false);
    expect(report.verdict).toBe('BLOCKED/evidence-insufficient');
  });

  it('阶段只有两点的陡坡不判产品失败，但绝对peak失败不被缺证遮蔽', () => {
    const sparse = fixture();
    for (let slot = 2; slot <= 360; ++slot) sparse.input.members[slot]!.value = null;
    sparse.input.members[0]!.value!.processes[0]!.handles = 1000;
    sparse.input.members[1]!.value!.processes[0]!.handles = 2000;
    let report = reportHandleGrowth(sparse.input, RUN_ID, sparse.frames, dependencies);
    expect(report.idle.statistics!.slopePerHour).toBeGreaterThan(60);
    expect(report.idle.violations).toEqual([]);
    expect(report.verdict).toBe('BLOCKED/evidence-insufficient');

    const absolute = fixture();
    absolute.input.members[20]!.value!.processes[0]!.handles = 6001;
    absolute.frames[4] = { ...absolute.frames[4]!, sequence: 100 } as QualificationFrame;
    report = reportHandleGrowth(absolute.input, RUN_ID, absolute.frames, dependencies);
    expect(report.absolute.verdict).toBe('FAIL-product');
    expect(report.verdict).toBe('FAIL-product');
  });

  it('依赖不能凭空缺省为可信，短验也不授PASS', () => {
    const unavailable = fixture();
    let report = reportHandleGrowth(unavailable.input, RUN_ID, unavailable.frames, {
      mainTraceComplete: false,
      loadVerdict: 'BLOCKED/evidence-insufficient',
    });
    expect(report.verdict).toBe('BLOCKED/evidence-insufficient');
    expect(report.classifications.unclassified).toBe(361);

    unavailable.input.window.mode = 'short';
    report = reportHandleGrowth(unavailable.input, RUN_ID, unavailable.frames, dependencies);
    expect(report.verdict).toBe('BLOCKED/evidence-insufficient');
  });
});
