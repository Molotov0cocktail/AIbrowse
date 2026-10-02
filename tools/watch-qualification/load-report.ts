import {
  QUALIFICATION_REGISTRIES,
  type QualificationFrame,
} from '../../src/main/watch/qualification/native-contract.ts';
import type { Verdict } from './resource-report.ts';

/** Checks the fixed workload keys directly, independently of the runtime's counters. */
export function reportLoad(
  mode: 'formal' | 'short',
  runId: string,
  frames: readonly QualificationFrame[],
  authenticatedComplete: boolean,
): {
  verdict: Verdict;
  expectedRuns: number;
  coordinatorRuns: number;
  hostGrants: number;
  taskTabs: number;
  perHost: number[];
  violations: string[];
  evidenceIssues: string[];
} {
  const expected = new Set<string>();
  const key = (index: number, phase: string, round: number | null): string =>
    `${phase}:${round ?? '-'}:${index}`;
  if (mode === 'short') {
    for (let index = 80; index <= 83; ++index) expected.add(key(index, 'initialization', null));
  } else {
    for (let index = 0; index < 100; ++index) {
      expected.add(key(index, 'initialization', null));
      if (index >= 33) expected.add(key(index, 'warmup', null));
      for (let round = 0; round < 4; ++round) expected.add(key(index, 'measurement', round));
    }
  }
  const coordinators = new Set<string>();
  const grants = new Set<string>();
  const liveCoordinators = new Map<string, string>();
  const liveGrants = new Map<string, string>();
  const violations: string[] = [];
  const evidenceIssues: string[] = [];
  const perHost = [0, 0, 0, 0];
  let taskTabs = 0;
  let previousSequence = 0;
  let ready = false;
  let complete = false;
  let ownerStateTrusted = true;
  const ownerIdentities = new Set<string>();
  const ownerPayloads = new Map<string, string>();
  for (const frame of frames) {
    try {
      if (
        frame.version !== 2 ||
        frame.qualificationRunId !== runId ||
        frame.sequence !== previousSequence + 1 ||
        complete
      ) {
        evidenceIssues.push('负载遥测身份、序列或终态边界无效');
        ownerStateTrusted = false;
        continue;
      }
      previousSequence = frame.sequence;
      if (
        ![
          'ready',
          'gpu-info',
          'setup',
          'heartbeat',
          'stop',
          'register',
          'unregister',
          'sample',
          'complete',
        ].includes(frame.kind)
      )
        throw new Error('kind-invalid');
      if (frame.kind === 'ready') {
        if (previousSequence !== 1 || ready || frame.payload.processType !== 'browser')
          throw new Error('ready-invalid');
        ready = true;
      }
      if (!ready) throw new Error('ready-missing');
      if (frame.kind === 'complete') complete = true;
      if (frame.kind !== 'register' && frame.kind !== 'unregister') continue;
      const event = frame.payload;
      if (!event || !QUALIFICATION_REGISTRIES.includes(event.registry))
        throw new Error('event-invalid');
      if (!['task-tab', 'coordinator-slot', 'host-grant'].includes(event.registry)) continue;
      if (!new RegExp(`^${event.registry}:[1-9][0-9]{0,19}$`).test(event.identity))
        throw new Error('owner-invalid');
      if (frame.kind === 'register') {
        if (ownerIdentities.has(event.identity)) throw new Error('owner-reused');
        ownerIdentities.add(event.identity);
        ownerPayloads.set(event.identity, JSON.stringify(event));
      } else {
        if (ownerPayloads.get(event.identity) !== JSON.stringify(event))
          throw new Error('release-payload-invalid');
        ownerPayloads.delete(event.identity);
      }
      if (event.registry === 'task-tab' && event.detail !== null) throw new Error('tab-invalid');
      if (event.registry === 'task-tab' && frame.kind === 'register') ++taskTabs;
      if (event.registry !== 'coordinator-slot' && event.registry !== 'host-grant') continue;
      const detail = event.detail;
      if (
        !detail ||
        !Number.isSafeInteger(detail.entryIndex) ||
        detail.entryIndex < 0 ||
        detail.entryIndex > 99 ||
        !Number.isSafeInteger(detail.hostSlot) ||
        detail.hostSlot < 0 ||
        detail.hostSlot > 3 ||
        !['initialization', 'warmup', 'measurement'].includes(detail.phase) ||
        (detail.phase === 'measurement'
          ? !Number.isSafeInteger(detail.round) || detail.round! < 0 || detail.round! > 3
          : detail.round !== null)
      )
        throw new Error('detail-invalid');
      if (
        event.registry === 'host-grant' &&
        (!Number.isSafeInteger(event.detail.attemptOrdinal) ||
          !Number.isFinite(event.detail.grantElapsedMs) ||
          event.detail.grantElapsedMs < 0 ||
          typeof event.detail.waitedForGap !== 'boolean')
      )
        throw new Error('grant-invalid');
      const runKey = key(detail.entryIndex, detail.phase, detail.round);
      if (
        !Number.isSafeInteger(detail.entryIndex) ||
        detail.hostSlot !== detail.entryIndex % 4 ||
        !expected.has(runKey)
      ) {
        violations.push('出现固定负载之外的运行或host绑定');
        continue;
      }
      const seen = event.registry === 'coordinator-slot' ? coordinators : grants;
      const live = event.registry === 'coordinator-slot' ? liveCoordinators : liveGrants;
      if (frame.kind === 'register') {
        if (seen.has(runKey)) violations.push('固定负载运行或grant重复');
        seen.add(runKey);
        live.set(event.identity, runKey);
        if (event.registry === 'host-grant') {
          ++perHost[detail.hostSlot]!;
          if (ownerStateTrusted && ![...liveCoordinators.values()].includes(runKey))
            violations.push('host grant没有对应的存活Coordinator');
        }
      } else {
        if (live.get(event.identity) !== runKey) {
          evidenceIssues.push('负载owner释放身份不匹配');
          ownerStateTrusted = false;
        }
        if (
          ownerStateTrusted &&
          event.registry === 'coordinator-slot' &&
          [...liveGrants.values()].includes(runKey)
        )
          violations.push('Coordinator早于其host grant释放');
        live.delete(event.identity);
      }
    } catch {
      evidenceIssues.push('负载遥测字段无效');
      ownerStateTrusted = false;
    }
  }
  if (!authenticatedComplete || !ready || !complete || evidenceIssues.length)
    evidenceIssues.push('负载完整性依赖认证连续遥测及正常complete');
  else {
    if (coordinators.size !== expected.size || grants.size !== expected.size)
      violations.push('固定负载Coordinator或host grant缺失');
    if (taskTabs !== (mode === 'formal' ? 120 : 4)) violations.push('Session任务Tab总数不匹配');
    if (liveCoordinators.size || liveGrants.size) violations.push('固定负载owner未释放');
    const expectedHosts = mode === 'formal' ? [141, 142, 142, 142] : [1, 1, 1, 1];
    if (JSON.stringify(perHost) !== JSON.stringify(expectedHosts))
      violations.push('各host的固定grant总数不匹配');
  }
  return {
    verdict: violations.length
      ? 'FAIL-product'
      : evidenceIssues.length
        ? 'BLOCKED/evidence-insufficient'
        : 'PASS',
    expectedRuns: expected.size,
    coordinatorRuns: coordinators.size,
    hostGrants: grants.size,
    taskTabs,
    perHost,
    violations: [...new Set(violations)],
    evidenceIssues: [...new Set(evidenceIssues)],
  };
}
