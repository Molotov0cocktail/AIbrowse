import type {
  QualificationCoordinatorDetail,
  QualificationFrame,
} from '../../src/main/watch/qualification/native-contract.ts';
import {
  cadenceIssues,
  metric,
  point,
  selectObservations,
  ticks,
  validMembers,
  type MetricReport,
  type ResourceInput,
  type Verdict,
} from './resource-report.ts';
import { statistics, type Point, type Statistics } from './statistics.ts';

const REVISION = 'handle-growth-v2' as const;
const SESSION_INDEX_FIRST = 80;
const SESSION_INDEX_LAST = 99;
const PULSES_PER_ROUND = 5;
const ROUNDS = 4;

export interface HandleGrowthDependencies {
  mainTraceComplete: boolean;
  loadVerdict: Verdict;
}

export interface HandleGrowthPhaseReport {
  count: number;
  spanSeconds: number | null;
  statistics: Statistics | null;
  coverageComplete: boolean;
  violations: string[];
}

export interface HandleGrowthPulseCoverage {
  round: number;
  pulse: number;
  points: number;
  taskTabRegistrations: number;
  taskTabReleases: number;
  lifecycleComplete: boolean;
}

export interface HandleGrowthReport {
  revision: typeof REVISION;
  verdict: Verdict;
  evidenceIssues: string[];
  violations: string[];
  rawAllPoints: MetricReport;
  absolute: MetricReport;
  classifications: {
    idle: number;
    session: number;
    transition: number;
    unclassified: number;
  };
  idle: HandleGrowthPhaseReport;
  session: HandleGrowthPhaseReport;
  pulseCoverage: HandleGrowthPulseCoverage[];
}

interface Anchor {
  sequence: number;
  begin: bigint;
  end: bigint;
  taskTabs: number;
  taskTabGeneration: number;
  pulseKey: string | null;
}

interface PulseLifecycle {
  registrations: number;
  releases: number;
}

function mainTicks(value: string): bigint {
  if (!/^[0-9a-f]{16}$/i.test(value)) throw new Error('main QPC无效');
  return BigInt(`0x${value}`);
}

function pulseKey(detail: QualificationCoordinatorDetail): string | null {
  if (
    detail.phase !== 'measurement' ||
    detail.round === null ||
    detail.round < 0 ||
    detail.round >= ROUNDS ||
    detail.entryIndex < SESSION_INDEX_FIRST ||
    detail.entryIndex > SESSION_INDEX_LAST
  )
    return null;
  return `${detail.round}:${Math.floor((detail.entryIndex - SESSION_INDEX_FIRST) / 4)}`;
}

function fullPulse(
  coordinators: ReadonlyMap<string, QualificationCoordinatorDetail>,
): string | null {
  const groups = new Map<string, Set<number>>();
  for (const detail of coordinators.values()) {
    const key = pulseKey(detail);
    if (key === null) continue;
    const indexes = groups.get(key) ?? new Set<number>();
    indexes.add(detail.entryIndex);
    groups.set(key, indexes);
  }
  const complete = [...groups.entries()]
    .filter(([key, indexes]) => {
      const pulse = Number(key.split(':')[1]);
      const first = SESSION_INDEX_FIRST + pulse * 4;
      return indexes.size === 4 && [0, 1, 2, 3].every((offset) => indexes.has(first + offset));
    })
    .map(([key]) => key);
  return complete.length === 1 ? complete[0]! : null;
}

function anchorPulse(
  taskAssignments: ReadonlyMap<string, string | null>,
  coordinators: ReadonlyMap<string, QualificationCoordinatorDetail>,
): string | null {
  if (taskAssignments.size !== 4) return null;
  const assignments = new Set(taskAssignments.values());
  if (assignments.size !== 1 || assignments.has(null)) return null;
  const assigned = [...assignments][0]!;
  return fullPulse(coordinators) === assigned ? assigned : null;
}

function replayAnchors(
  runId: string,
  frames: readonly QualificationFrame[],
  dependencies: HandleGrowthDependencies,
): {
  trusted: boolean;
  anchors: Anchor[];
  lifecycles: Map<string, PulseLifecycle>;
  issues: string[];
} {
  const issues: string[] = [];
  if (!dependencies.mainTraceComplete) issues.push('main认证序列不完整或不可信');
  if (dependencies.loadVerdict !== 'PASS') issues.push('固定负载未由完整Load报告授PASS');
  const anchors: Anchor[] = [];
  const coordinators = new Map<string, QualificationCoordinatorDetail>();
  const tasks = new Map<string, string | null>();
  const seenTasks = new Set<string>();
  const lifecycles = new Map<string, PulseLifecycle>();
  let generation = 0;
  let ready = false;
  let complete = false;
  let previousAnchor: Anchor | null = null;

  const issue = (message: string): void => {
    issues.push(message);
  };
  const lifecycle = (key: string): PulseLifecycle => {
    const value = lifecycles.get(key) ?? { registrations: 0, releases: 0 };
    lifecycles.set(key, value);
    return value;
  };

  for (let index = 0; index < frames.length; ++index) {
    const frame = frames[index]!;
    try {
      if (
        frame.version !== 2 ||
        frame.qualificationRunId !== runId ||
        !Number.isSafeInteger(frame.sequence) ||
        frame.sequence !== index + 1 ||
        complete
      ) {
        issue('main遥测身份、连续序列或终态边界无效');
        continue;
      }
      if (frame.kind === 'ready') {
        if (ready || index !== 0) issue('main认证ready缺失、重复或不在首帧');
        ready = true;
      } else if (!ready) issue('ready之前出现main遥测');

      if (frame.kind === 'register' || frame.kind === 'unregister') {
        const event = frame.payload;
        if (event.registry === 'coordinator-slot') {
          if (frame.kind === 'register') {
            if (coordinators.has(event.identity)) issue('Coordinator身份重复注册');
            else coordinators.set(event.identity, event.detail);
          } else if (!coordinators.has(event.identity)) issue('Coordinator释放没有匹配注册');
          else coordinators.delete(event.identity);
        }
        if (event.registry === 'task-tab') {
          ++generation;
          if (frame.kind === 'register') {
            if (seenTasks.has(event.identity) || tasks.has(event.identity))
              issue('task-tab身份重复注册');
            else {
              seenTasks.add(event.identity);
              const assignment = fullPulse(coordinators);
              tasks.set(event.identity, assignment);
              if (assignment !== null) ++lifecycle(assignment).registrations;
            }
          } else {
            if (!tasks.has(event.identity)) issue('task-tab释放没有匹配注册');
            else {
              const assignment = tasks.get(event.identity);
              tasks.delete(event.identity);
              if (assignment !== null && assignment !== undefined) ++lifecycle(assignment).releases;
            }
          }
        }
      }

      let begin: bigint | null = null;
      let end: bigint | null = null;
      if (frame.kind === 'heartbeat') begin = end = mainTicks(frame.payload.qpcTicks);
      if (frame.kind === 'sample') {
        begin = mainTicks(frame.payload.timing.linearizedQpcTicks);
        end = mainTicks(frame.payload.timing.snapshotQpcTicks);
        const bindingIds = frame.payload.taskTabBindings.map((row) => row.identity).sort();
        if (JSON.stringify(bindingIds) !== JSON.stringify([...tasks.keys()].sort()))
          issue('sample的task-tab绑定与连续owner序列不一致');
      }
      if (begin !== null && end !== null) {
        const anchor: Anchor = {
          sequence: frame.sequence,
          begin,
          end,
          taskTabs: tasks.size,
          taskTabGeneration: generation,
          pulseKey: anchorPulse(tasks, coordinators),
        };
        if (end < begin || (previousAnchor !== null && begin < previousAnchor.end))
          issue('heartbeat/sample锚的QPC与序列不一致');
        anchors.push(anchor);
        previousAnchor = anchor;
      }
      if (frame.kind === 'complete') {
        complete = true;
        if (index !== frames.length - 1) issue('complete之后仍有main遥测');
      }
    } catch {
      issue('main阶段锚或owner字段无效');
    }
  }
  if (!ready || !complete) issue('缺少main认证开始或正常结束');
  return {
    trusted:
      dependencies.mainTraceComplete && dependencies.loadVerdict === 'PASS' && !issues.length,
    anchors,
    lifecycles,
    issues: [...new Set(issues)],
  };
}

function phaseReport(
  name: 'idle' | 'session',
  points: Point[],
  coverageComplete: boolean,
  formal: boolean,
): HandleGrowthPhaseReport {
  const stats = statistics(points);
  const violations: string[] = [];
  if (
    formal &&
    coverageComplete &&
    stats?.slopePerHour !== null &&
    stats?.slopePerHour !== undefined &&
    stats.slopePerHour > 60
  )
    violations.push(`${name} slopePerHour=${stats.slopePerHour} 超过 60`);
  return {
    count: points.length,
    spanSeconds: stats?.spanSeconds ?? null,
    statistics: stats,
    coverageComplete,
    violations,
  };
}

/**
 * Applies the frozen handle-growth-v2 oracle. All-point absolute statistics and the legacy raw
 * OLS remain visible; only the two phase-qualified slopes replace raw OLS as the growth gate.
 */
export function reportHandleGrowth(
  input: ResourceInput,
  runId: string,
  frames: readonly QualificationFrame[],
  dependencies: HandleGrowthDependencies,
): HandleGrowthReport {
  const evidenceIssues = cadenceIssues(input);
  if (input.window.mode === 'short')
    evidenceIssues.push('短验只报告句柄观察数据，不授handle-growth-v2通过');
  const selected = selectObservations(input.window, input.members, validMembers);
  const rows = [...selected.values.values()].sort((a, b) => a.slot - b.slot);
  const handlePoints = rows.map((row) =>
    point(
      input.window,
      row,
      row.value!.processes.reduce((sum, member) => sum + member.handles, 0),
    ),
  );
  const complete = evidenceIssues.length === 0 && selected.missing.length <= 3;
  const rawAllPoints = metric(
    input.window,
    selected,
    handlePoints,
    { median: 3000, p95: 4000, observedPeak: 5000, slopePerHour: 60 },
    complete,
  );
  const absolute = metric(
    input.window,
    selected,
    handlePoints,
    { median: 3000, p95: 4000, observedPeak: 5000 },
    complete,
  );
  const replay = replayAnchors(runId, frames, dependencies);
  evidenceIssues.push(...replay.issues);

  const idlePoints: Point[] = [];
  const sessionPoints: Point[] = [];
  const pulsePoints = new Map<string, number>();
  let transition = 0;
  let unclassified = 0;
  if (replay.trusted) {
    const frequency = BigInt(input.window.qpcFrequency);
    for (const row of rows) {
      const osBegin = ticks(row.beginQpc);
      const osEnd = ticks(row.endQpc);
      let left: Anchor | undefined;
      let right: Anchor | undefined;
      for (const anchor of replay.anchors) {
        if (anchor.end <= osBegin) left = anchor;
        if (right === undefined && anchor.begin >= osEnd) right = anchor;
      }
      if (!left || !right) {
        ++unclassified;
        evidenceIssues.push('至少一个members观察缺少前锚或后锚');
        continue;
      }
      if (
        right.sequence <= left.sequence ||
        right.begin < left.end ||
        right.begin - left.end > 12n * frequency
      ) {
        ++unclassified;
        evidenceIssues.push('至少一个members观察的锚序、锚距或QPC不可信');
        continue;
      }
      if (left.taskTabGeneration !== right.taskTabGeneration) {
        ++transition;
        continue;
      }
      if (left.taskTabs !== right.taskTabs) {
        ++unclassified;
        evidenceIssues.push('无task-tab变更时前后锚状态不一致');
        continue;
      }
      const value = row.value!.processes.reduce((sum, member) => sum + member.handles, 0);
      const classified = point(input.window, row, value);
      if (left.taskTabs === 0) idlePoints.push(classified);
      else if (left.taskTabs === 4) {
        sessionPoints.push(classified);
        if (left.pulseKey !== null && left.pulseKey === right.pulseKey)
          pulsePoints.set(left.pulseKey, (pulsePoints.get(left.pulseKey) ?? 0) + 1);
      } else ++transition;
    }
  } else unclassified = rows.length;

  const pulseCoverage: HandleGrowthPulseCoverage[] = [];
  for (let round = 0; round < ROUNDS; ++round) {
    for (let pulse = 0; pulse < PULSES_PER_ROUND; ++pulse) {
      const key = `${round}:${pulse}`;
      const lifecycle = replay.lifecycles.get(key) ?? { registrations: 0, releases: 0 };
      pulseCoverage.push({
        round,
        pulse,
        points: pulsePoints.get(key) ?? 0,
        taskTabRegistrations: lifecycle.registrations,
        taskTabReleases: lifecycle.releases,
        lifecycleComplete: lifecycle.registrations === 4 && lifecycle.releases === 4,
      });
    }
  }
  const pulsesComplete = pulseCoverage.every(
    (pulse) => pulse.lifecycleComplete && pulse.points >= 1,
  );
  const idleStats = statistics(idlePoints);
  const sessionStats = statistics(sessionPoints);
  const idleCoverage =
    replay.trusted && idlePoints.length >= 240 && (idleStats?.spanSeconds ?? -1) >= 3300;
  const sessionCoverage =
    replay.trusted &&
    sessionPoints.length >= 20 &&
    (sessionStats?.spanSeconds ?? -1) >= 2700 &&
    pulsesComplete;
  if (!idleCoverage) evidenceIssues.push('无Session阶段覆盖不足240点或3300秒');
  if (!sessionCoverage) evidenceIssues.push('Session阶段覆盖不足20点、2700秒或20个可信固定波');
  if (transition > 36) evidenceIssues.push('过渡观察超过36点');
  if (unclassified) evidenceIssues.push('存在因缺锚或trace不可信而无法分类的members观察');

  const formal = input.window.mode === 'formal';
  const idle = phaseReport('idle', idlePoints, idleCoverage, formal);
  const session = phaseReport('session', sessionPoints, sessionCoverage, formal);
  const violations = [...absolute.violations, ...idle.violations, ...session.violations];
  return {
    revision: REVISION,
    verdict: violations.length
      ? 'FAIL-product'
      : formal &&
          absolute.verdict === 'PASS' &&
          !evidenceIssues.length &&
          transition <= 36 &&
          idleCoverage &&
          sessionCoverage
        ? 'PASS'
        : 'BLOCKED/evidence-insufficient',
    evidenceIssues: [...new Set(evidenceIssues)],
    violations,
    rawAllPoints,
    absolute,
    classifications: {
      idle: idlePoints.length,
      session: sessionPoints.length,
      transition,
      unclassified,
    },
    idle,
    session,
    pulseCoverage,
  };
}
