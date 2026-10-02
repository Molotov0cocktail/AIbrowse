import { median, statistics, type Point, type Statistics } from './statistics.ts';

export type Verdict = 'PASS' | 'FAIL-product' | 'BLOCKED/evidence-insufficient';
export interface Window {
  mode: 'formal' | 'short';
  beginQpc: string;
  endQpc: string;
  qpcFrequency: number;
  processors: number;
}
export interface Observation<T> {
  slot: number;
  beginQpc: string;
  endQpc: string;
  value: T | null;
}
export interface Member {
  pid: number;
  creationFileTime: string;
  inJob: boolean;
  rssBytes: number;
  privateBytes: number;
  handles: number;
}
export interface Members {
  before: { pid: number; creationFileTime: string }[];
  after: { pid: number; creationFileTime: string }[];
  processes: Member[];
}
export interface ResourceInput {
  window: Window;
  attempts: { slot: number; qpc: string }[];
  suspended: boolean;
  cadenceEvidenceIssues?: string[];
  cpu: Observation<string>[];
  members: Observation<Members>[];
}
export interface MetricReport {
  verdict: Verdict;
  statistics: Statistics | null;
  missingSlots: number[];
  duplicateSlots: number[];
  invalidObservations: number;
  violations: string[];
  endpointErrorsSeconds: { first: number | null; last: number | null };
}
export interface ResourceReport {
  mode: Window['mode'];
  verdict: Verdict;
  handleGrowthRevision: 'raw-all-points-v1' | 'handle-growth-v2';
  evidenceIssues: string[];
  cpuPercent: MetricReport & {
    counterEndpointSpanSeconds: number | null;
    coveredIntervalSeconds: number;
  };
  rssMiB: MetricReport;
  privateMiB: MetricReport;
  handles: MetricReport;
  activeProcesses: MetricReport;
}
export interface ResourceReportOptions {
  handleGrowth?: { revision: 'handle-growth-v2'; verdict: Verdict };
}
interface Selected<T> {
  values: Map<number, Observation<T>>;
  missing: number[];
  duplicate: number[];
  invalid: number;
}

export function ticks(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error('QPC或累计计数无效');
  const parsed = BigInt(value);
  if (parsed > 0xffffffffffffffffn) throw new Error('QPC或累计计数越界');
  return parsed;
}

function integer(value: number, minimum = 0): boolean {
  return Number.isSafeInteger(value) && value >= minimum;
}

export function validateWindow(window: Window): number {
  if (!integer(window.qpcFrequency, 1) || !integer(window.processors, 1))
    throw new Error('时钟频率或处理器数量无效');
  const duration = ticks(window.endQpc) - ticks(window.beginQpc);
  const frequency = BigInt(window.qpcFrequency);
  if (duration <= 0n || (window.mode === 'formal' && duration % (frequency * 10n) !== 0n))
    throw new Error('资源窗口必须由完整十秒槽构成');
  const last = Number(duration / (frequency * 10n));
  if ((window.mode === 'formal' && last !== 360) || last > 360)
    throw new Error('正式资源窗口必须为六十分钟');
  return last;
}

export function inWindow<T>(window: Window, observation: Observation<T>, last: number): boolean {
  if (!integer(observation.slot) || observation.slot > last) return false;
  const start = ticks(window.beginQpc);
  const end = ticks(window.endQpc);
  const frequency = BigInt(window.qpcFrequency);
  const target = start + BigInt(observation.slot * 10) * frequency;
  const low = observation.slot === 0 ? start : target - 2n * frequency;
  const high = observation.slot === last ? end : target + 2n * frequency;
  const begin = ticks(observation.beginQpc);
  const finish = ticks(observation.endQpc);
  return begin >= low && finish >= begin && finish <= high && begin >= start && finish <= end;
}

export function selectObservations<T>(
  window: Window,
  observations: readonly Observation<T>[],
  valid: (value: T) => boolean,
): Selected<T> {
  const last = validateWindow(window);
  const values = new Map<number, Observation<T>>();
  const duplicate: number[] = [];
  let invalid = 0;
  for (const observation of observations) {
    try {
      if (
        observation.value === null ||
        !inWindow(window, observation, last) ||
        !valid(observation.value)
      ) {
        ++invalid;
        continue;
      }
      if (values.has(observation.slot)) duplicate.push(observation.slot);
      else values.set(observation.slot, observation);
    } catch {
      ++invalid;
    }
  }
  return {
    values,
    duplicate,
    invalid,
    missing: Array.from({ length: last + 1 }, (_, slot) => slot).filter(
      (slot) => !values.has(slot),
    ),
  };
}

export function validMembers(value: Members): boolean {
  const key = (member: { pid: number; creationFileTime: string }): string => {
    if (
      !integer(member.pid, 1) ||
      !/^[0-9a-f]{16}$/i.test(member.creationFileTime) ||
      /^0{16}$/.test(member.creationFileTime)
    )
      throw new Error('进程身份无效');
    return `${member.pid}:${member.creationFileTime}`;
  };
  const before = value.before.map(key).sort();
  const after = value.after.map(key).sort();
  const processes = value.processes.map(key).sort();
  return (
    new Set(value.before.map((member) => member.pid)).size === before.length &&
    new Set(value.after.map((member) => member.pid)).size === after.length &&
    new Set(value.processes.map((member) => member.pid)).size === processes.length &&
    JSON.stringify(before) === JSON.stringify(after) &&
    JSON.stringify(before) === JSON.stringify(processes) &&
    value.processes.every(
      (member) =>
        member.inJob &&
        integer(member.rssBytes) &&
        integer(member.privateBytes) &&
        integer(member.handles),
    ) &&
    ['rssBytes', 'privateBytes', 'handles'].every((field) =>
      Number.isSafeInteger(
        value.processes.reduce(
          (sum, member) => sum + member[field as 'rssBytes' | 'privateBytes' | 'handles'],
          0,
        ),
      ),
    )
  );
}

export function cadenceIssues(input: ResourceInput): string[] {
  const last = validateWindow(input.window);
  const issues: string[] = [...(input.cadenceEvidenceIssues ?? [])];
  const seen = new Set<number>();
  let previous: bigint | null = null;
  for (const attempt of input.attempts) {
    try {
      const qpc = ticks(attempt.qpc);
      if (
        !integer(attempt.slot) ||
        attempt.slot > last ||
        seen.has(attempt.slot) ||
        attempt.slot !== seen.size
      )
        issues.push('节拍重复、乱序或越界');
      seen.add(attempt.slot);
      if (
        !inWindow(
          input.window,
          { slot: attempt.slot, beginQpc: attempt.qpc, endQpc: attempt.qpc, value: true },
          last,
        )
      )
        issues.push('节拍不在观察窗内');
      if (
        previous !== null &&
        (qpc <= previous || qpc - previous > 20n * BigInt(input.window.qpcFrequency))
      )
        issues.push('节拍倒退或相邻间隔超过二十秒');
      previous = qpc;
    } catch {
      issues.push('节拍计数无效');
    }
  }
  if (seen.size !== last + 1) issues.push('节拍记录缺失');
  if (input.suspended) issues.push('窗口发生系统暂停');
  return [...new Set(issues)];
}

export function point(window: Window, observation: Observation<unknown>, value: number): Point {
  return {
    slot: observation.slot,
    seconds: Number(ticks(observation.endQpc) - ticks(window.beginQpc)) / window.qpcFrequency,
    value,
  };
}

export function metric(
  window: Window,
  selection: Selected<unknown>,
  points: Point[],
  limits: {
    median?: number;
    p95?: number;
    observedPeak?: number;
    slopePerHour?: number;
    medianGrowth?: number;
  },
  complete: boolean,
  extraViolations: string[] = [],
): MetricReport {
  const stats = statistics(points);
  const violations = [...extraViolations];
  if (stats !== null && window.mode === 'formal') {
    for (const name of ['median', 'p95', 'observedPeak', 'slopePerHour'] as const) {
      const limit = limits[name];
      const value = stats[name];
      if (limit !== undefined && value !== null && value > limit)
        violations.push(`${name}=${value} 超过 ${limit}`);
    }
    if (limits.medianGrowth !== undefined) {
      const first = points.filter((row) => row.slot <= 60).map((row) => row.value);
      const last = points.filter((row) => row.slot >= 300).map((row) => row.value);
      if (first.length && last.length && median(last) - median(first) > limits.medianGrowth)
        violations.push(`首末段中位数增量超过 ${limits.medianGrowth}`);
    }
  }
  const finalSlot = validateWindow(window);
  const first = points.find((row) => row.slot === 0);
  const last = points.find((row) => row.slot === finalSlot);
  return {
    verdict: violations.length
      ? 'FAIL-product'
      : complete && stats !== null && window.mode === 'formal'
        ? 'PASS'
        : 'BLOCKED/evidence-insufficient',
    statistics: stats,
    missingSlots: selection.missing,
    duplicateSlots: selection.duplicate,
    invalidObservations: selection.invalid,
    violations,
    endpointErrorsSeconds: {
      first: first?.seconds ?? null,
      last: last ? last.seconds - finalSlot * 10 : null,
    },
  };
}

export function reportResources(
  input: ResourceInput,
  options: ResourceReportOptions = {},
): ResourceReport {
  const { window } = input;
  const last = validateWindow(window);
  const evidenceIssues = cadenceIssues(input);
  if (window.mode === 'short') evidenceIssues.push('短验只报告观察数据，不授正式资源门通过');
  const cpu = selectObservations(window, input.cpu, (value) => ticks(value) >= 0n);
  const cpuPoints: Point[] = [];
  const missingIntervals: number[] = [];
  let coveredIntervalSeconds = 0;
  let rollback = false;
  let prior: bigint | null = null;
  for (let slot = 0; slot <= last; ++slot) {
    const current = cpu.values.get(slot);
    if (current?.value !== null && current?.value !== undefined) {
      const total = ticks(current.value);
      if (prior !== null && total < prior) rollback = true;
      prior = total;
    }
    if (slot === 0) continue;
    const previous = cpu.values.get(slot - 1);
    if (!current || current.value === null || !previous || previous.value === null) {
      missingIntervals.push(slot);
      continue;
    }
    const delta = ticks(current.value) - ticks(previous.value);
    const elapsed = ticks(current.endQpc) - ticks(previous.endQpc);
    if (delta < 0n || elapsed <= 0n) {
      missingIntervals.push(slot);
      rollback = true;
      continue;
    }
    coveredIntervalSeconds += Number(elapsed) / window.qpcFrequency;
    cpuPoints.push(
      point(
        window,
        current,
        (Number(delta) / 1e7 / (Number(elapsed) / window.qpcFrequency) / window.processors) * 100,
      ),
    );
  }
  const complete = evidenceIssues.length === 0;
  if (rollback) evidenceIssues.push('Job累计CPU倒退或端点时间不递增');
  const cpuReport = metric(
    window,
    { ...cpu, missing: missingIntervals },
    cpuPoints,
    { median: 5, p95: 20, observedPeak: 60 },
    complete &&
      !rollback &&
      cpu.values.has(0) &&
      cpu.values.has(last) &&
      missingIntervals.length <= 3,
  );
  // CPU slot zero is a counter baseline, never a fabricated zero-percent sample.
  const firstCpu = cpu.values.get(0);
  const lastCpu = cpu.values.get(last);
  cpuReport.endpointErrorsSeconds.first = firstCpu ? point(window, firstCpu, 0).seconds : null;
  const members = selectObservations(window, input.members, validMembers);
  const rows = [...members.values.values()].sort((a, b) => a.slot - b.slot);
  const sum = (field: 'rssBytes' | 'privateBytes' | 'handles', divisor = 1): Point[] =>
    rows.map((row) =>
      point(
        window,
        row,
        row.value!.processes.reduce((total, member) => total + member[field], 0) / divisor,
      ),
    );
  const memberComplete = complete && members.missing.length <= 3;
  const processPoints = rows.map((row) => point(window, row, row.value!.processes.length));
  const reports = {
    cpuPercent: {
      ...cpuReport,
      counterEndpointSpanSeconds:
        firstCpu && lastCpu
          ? Number(ticks(lastCpu.endQpc) - ticks(firstCpu.endQpc)) / window.qpcFrequency
          : null,
      coveredIntervalSeconds,
    },
    rssMiB: metric(
      window,
      members,
      sum('rssBytes', 1048576),
      { median: 1024, p95: 1536, observedPeak: 2048, slopePerHour: 24 },
      memberComplete,
    ),
    privateMiB: metric(
      window,
      members,
      sum('privateBytes', 1048576),
      { median: 1280, p95: 1792, observedPeak: 2048, slopePerHour: 24 },
      memberComplete,
    ),
    handles: metric(
      window,
      members,
      sum('handles'),
      { median: 3000, p95: 4000, observedPeak: 5000, slopePerHour: 60 },
      memberComplete,
    ),
    activeProcesses: metric(
      window,
      members,
      processPoints,
      { slopePerHour: 6, medianGrowth: 4 },
      memberComplete,
    ),
  };
  const verdicts = options.handleGrowth
    ? [
        reports.cpuPercent.verdict,
        reports.rssMiB.verdict,
        reports.privateMiB.verdict,
        reports.activeProcesses.verdict,
        options.handleGrowth.verdict,
      ]
    : Object.values(reports).map((report) => report.verdict);
  return {
    mode: window.mode,
    verdict: verdicts.includes('FAIL-product')
      ? 'FAIL-product'
      : verdicts.every((value) => value === 'PASS')
        ? 'PASS'
        : 'BLOCKED/evidence-insufficient',
    handleGrowthRevision: options.handleGrowth?.revision ?? 'raw-all-points-v1',
    evidenceIssues,
    ...reports,
  };
}
