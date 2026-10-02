import type {
  QualificationCoordinatorDetail,
  QualificationFrame,
  QualificationReady,
} from '../../src/main/watch/qualification/native-contract.ts';
import type { Members, Observation, ResourceInput } from './resource-report.ts';
export const RUN_ID = 'C7XQOSFIJOEGPO7ZLEYRELGKNA';
export const FREQUENCY = 1000;
export const BEGIN = 100000;
export const PULSE_STARTS = [
  69, 73, 76, 80, 83, 159, 163, 166, 170, 173, 254, 257, 261, 264, 268, 339, 343, 346, 350, 353,
];
export const PULSE_LENGTHS = [3, 2, 3, 2, 3, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3];

interface FixtureOptions {
  handle?: (slot: number, session: boolean) => number;
  transitions?: number[];
}

export function hexQpc(value: number): string {
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

export function fixture(options: FixtureOptions = {}): {
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

export function resequence(frames: QualificationFrame[]): QualificationFrame[] {
  return frames.map((frame, index) => ({ ...frame, sequence: index + 1 }) as QualificationFrame);
}

export const dependencies = {
  mainTraceComplete: true,
  loadVerdict: 'PASS' as const,
};
