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

export interface TransitionGrowthGroup extends HandleGrowthPhaseReport {
  memberCount: number;
  roundPoints: number[];
  slots: number[];
}

export interface HandleGrowthReport {
  revision: 'handle-growth-v3' | 'rss-growth-v2' | 'private-growth-v2';
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
  transitionGroups: TransitionGrowthGroup[];
  transitionUnassignedSlots: number[];
  transitionObserved: boolean;
  phaseSlots: { idle: number[]; session: number[]; transition: number[]; unclassified: number[] };
}

interface Anchor {
  sequence: number;
  begin: bigint;
  end: bigint;
  taskTabs: number;
  taskTabGeneration: number;
  pulseKey: string | null;
  taskRounds: (number | null)[];
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
  taskChanges: { sequence: number; round: number | null }[];
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
  const taskChanges: { sequence: number; round: number | null }[] = [];
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
              taskChanges.push({
                sequence: frame.sequence,
                round: assignment === null ? null : Number(assignment.split(':')[0]),
              });
              if (assignment !== null) ++lifecycle(assignment).registrations;
            }
          } else {
            if (!tasks.has(event.identity)) issue('task-tab释放没有匹配注册');
            else {
              const assignment = tasks.get(event.identity);
              taskChanges.push({
                sequence: frame.sequence,
                round: assignment == null ? null : Number(assignment.split(':')[0]),
              });
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
          taskRounds: [...tasks.values()].map((assignment) =>
            assignment === null ? null : Number(assignment.split(':')[0]),
          ),
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
    taskChanges,
    issues: [...new Set(issues)],
  };
}

function phaseReport(
  name: string,
  points: Point[],
  coverageComplete: boolean,
  formal: boolean,
  limit: number,
): HandleGrowthPhaseReport {
  const stats = statistics(points);
  const violations: string[] = [];
  if (
    formal &&
    coverageComplete &&
    stats?.slopePerHour !== null &&
    stats?.slopePerHour !== undefined &&
    stats.slopePerHour > limit
  )
    violations.push(`${name} slopePerHour=${stats.slopePerHour} 超过 ${limit}`);
  return {
    count: points.length,
    spanSeconds: stats?.spanSeconds ?? null,
    statistics: stats,
    coverageComplete,
    violations,
  };
}

/**
 * Classifies from authenticated owners only. Transition topology is the validated OS member
 * count; the complete raw tree total remains the dependent value in every regression.
 */
export function reportResourceGrowth(
  input: ResourceInput,
  runId: string,
  frames: readonly QualificationFrame[],
  dependencies: HandleGrowthDependencies,
  resource: 'handles' | 'rssMiB' | 'privateMiB',
): HandleGrowthReport {
  const revision =
    resource === 'handles'
      ? 'handle-growth-v3'
      : resource === 'rssMiB'
        ? 'rss-growth-v2'
        : 'private-growth-v2';
  const limit = resource === 'handles' ? 60 : 24;
  const absoluteLimits =
    resource === 'handles'
      ? { median: 3000, p95: 4000, observedPeak: 5000 }
      : resource === 'rssMiB'
        ? { median: 1024, p95: 1536, observedPeak: 2048 }
        : { median: 1280, p95: 1792, observedPeak: 2048 };
  const total = (row: ResourceInput['members'][number]): number =>
    row.value!.processes.reduce(
      (sum, member) =>
        sum +
        (resource === 'handles'
          ? member.handles
          : (resource === 'rssMiB' ? member.rssBytes : member.privateBytes) / 1048576),
      0,
    );
  const evidenceIssues = cadenceIssues(input);
  if (input.window.mode === 'short') evidenceIssues.push(`短验只报告观察数据，不授${revision}通过`);
  const selected = selectObservations(input.window, input.members, validMembers);
  if (selected.duplicate.length) evidenceIssues.push('members存在重复有效观察槽');
  const rows = [...selected.values.values()].sort((a, b) => a.slot - b.slot);
  const resourcePoints = rows.map((row) => point(input.window, row, total(row)));
  const peakPoints = selected.allValid.map((row) => point(input.window, row, total(row)));
  const complete = evidenceIssues.length === 0 && selected.missing.length <= 3;
  const rawAllPoints = metric(
    input.window,
    selected,
    resourcePoints,
    { ...absoluteLimits, slopePerHour: limit },
    complete,
    [],
    peakPoints,
  );
  const absolute = metric(
    input.window,
    selected,
    resourcePoints,
    absoluteLimits,
    complete,
    [],
    peakPoints,
  );
  const replay = replayAnchors(runId, frames, dependencies);
  evidenceIssues.push(...replay.issues);

  const idlePoints: Point[] = [];
  const sessionPoints: Point[] = [];
  const pulsePoints = new Map<string, number>();
  let transition = 0;
  let unclassified = 0;
  const transitionPoints = new Map<
    number,
    { points: Point[]; rounds: number[]; unassigned: number }
  >();
  const transitionUnassignedSlots: number[] = [];
  const phaseSlots: HandleGrowthReport['phaseSlots'] = {
    idle: [],
    session: [],
    transition: [],
    unclassified: [],
  };
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
        phaseSlots.unclassified.push(row.slot);
        evidenceIssues.push('至少一个members观察缺少前锚或后锚');
        continue;
      }
      if (
        right.sequence <= left.sequence ||
        right.begin < left.end ||
        right.begin - left.end > 12n * frequency
      ) {
        ++unclassified;
        phaseSlots.unclassified.push(row.slot);
        evidenceIssues.push('至少一个members观察的锚序、锚距或QPC不可信');
        continue;
      }
      const classified = point(input.window, row, total(row));
      if (
        left.taskTabGeneration !== right.taskTabGeneration ||
        (left.taskTabs === right.taskTabs && left.taskTabs !== 0 && left.taskTabs !== 4)
      ) {
        ++transition;
        phaseSlots.transition.push(row.slot);
        const changed = replay.taskChanges.filter(
          (change) => change.sequence > left!.sequence && change.sequence < right!.sequence,
        );
        const rounds = [
          ...left.taskRounds,
          ...right.taskRounds,
          ...changed.map((change) => change.round),
        ];
        const assigned = new Set(rounds);
        const round =
          rounds.length > 0 && !assigned.has(null) && assigned.size === 1 ? rounds[0] : null;
        const memberCount = row.value!.processes.length;
        const group = transitionPoints.get(memberCount) ?? {
          points: [],
          rounds: [0, 0, 0, 0],
          unassigned: 0,
        };
        group.points.push(classified);
        if (round === null || round === undefined || round < 0 || round >= ROUNDS) {
          transitionUnassignedSlots.push(row.slot);
          ++group.unassigned;
        } else {
          group.rounds[round]! += 1;
        }
        transitionPoints.set(memberCount, group);
        continue;
      }
      if (left.taskTabs !== right.taskTabs) {
        ++unclassified;
        phaseSlots.unclassified.push(row.slot);
        evidenceIssues.push('无task-tab变更时前后锚状态不一致');
        continue;
      }
      if (left.taskTabs === 0) {
        idlePoints.push(classified);
        phaseSlots.idle.push(row.slot);
      } else if (left.taskTabs === 4) {
        sessionPoints.push(classified);
        phaseSlots.session.push(row.slot);
        if (left.pulseKey !== null && left.pulseKey === right.pulseKey)
          pulsePoints.set(left.pulseKey, (pulsePoints.get(left.pulseKey) ?? 0) + 1);
      }
    }
  } else {
    unclassified = rows.length;
    phaseSlots.unclassified.push(...rows.map((row) => row.slot));
  }

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
  const idle = phaseReport('idle', idlePoints, idleCoverage, formal, limit);
  const session = phaseReport('session', sessionPoints, sessionCoverage, formal, limit);
  const transitionGroups: TransitionGrowthGroup[] = [...transitionPoints.entries()]
    .sort(([a], [b]) => a - b)
    .map(([memberCount, group]) => {
      const stats = statistics(group.points);
      const coverage =
        replay.trusted &&
        group.unassigned === 0 &&
        group.rounds.every((count) => count >= 2) &&
        group.points.length >= 8 &&
        (stats?.spanSeconds ?? -1) >= 2700;
      if (!coverage) evidenceIssues.push(`过渡T[${memberCount}]缺少四轮各两点或2700秒覆盖`);
      return {
        memberCount,
        roundPoints: group.rounds,
        slots: group.points.map((row) => row.slot),
        ...phaseReport(`transition[${memberCount}]`, group.points, coverage, formal, limit),
      };
    });
  if (transitionUnassignedSlots.length)
    evidenceIssues.push('存在不能由task-tab所有权归属正式轮次的过渡观察');
  const violations = [
    ...absolute.violations,
    ...idle.violations,
    ...session.violations,
    ...transitionGroups.flatMap((group) => group.violations),
  ];
  return {
    revision,
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
    transitionGroups,
    transitionUnassignedSlots,
    transitionObserved: transition > 0,
    phaseSlots,
  };
}

export function reportHandleGrowth(
  input: ResourceInput,
  runId: string,
  frames: readonly QualificationFrame[],
  dependencies: HandleGrowthDependencies,
): HandleGrowthReport & { revision: 'handle-growth-v3' } {
  return {
    ...reportResourceGrowth(input, runId, frames, dependencies, 'handles'),
    revision: 'handle-growth-v3',
  };
}
