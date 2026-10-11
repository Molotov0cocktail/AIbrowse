export interface MetricSummary {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface CpuPoint {
  readonly elapsedMs: number;
  readonly aggregatePercent: number;
}

export interface CpuSummary {
  readonly wallMs: number;
  readonly logicalCoreMs: number;
  readonly averageLogicalCores: number | null;
  readonly peakAggregatePercent: number;
}

export interface TopologyPoint {
  readonly elapsedMs: number;
  readonly members: number;
  readonly value: number;
}

export interface IdentityMetric {
  readonly pid: number;
  readonly createdFileTime: string;
  readonly rssBytes: number;
  readonly privateBytes: number;
  readonly handles: number;
}

export interface IdentityPoint {
  readonly elapsedMs: number;
  readonly members: readonly IdentityMetric[];
}

export interface FixedIdentityGrowth {
  readonly identities: readonly string[];
  readonly samples: number;
  readonly spanMs: number;
  readonly rssBytesPerHour: number;
  readonly privateBytesPerHour: number;
  readonly handlesPerHour: number;
}

export interface IdentityLifetime {
  readonly pid: number;
  readonly createdFileTime: string;
  readonly firstObservedMs: number;
  readonly lastObservedMs: number;
  readonly retiredObservedMs: number | null;
}

export interface TurnoverIdentityEvent {
  readonly slot: number;
  readonly generation: number;
  readonly closeStartedMs: number;
  readonly createStartedMs: number;
  readonly createCompletedMs: number;
  readonly oldPid: number;
  readonly newPid: number;
}

export interface ResolvedTurnoverEvent {
  readonly slot: number;
  readonly generation: number;
  readonly oldIdentity: string;
  readonly newIdentity: string;
}

export const SUPPLEMENT_BASELINE_DEPENDENCY_PATHS = Object.freeze([
  'node_modules/react/jsx-runtime.js',
  'node_modules/react/index.js',
  'node_modules/react-dom/client.js',
  'node_modules/react/cjs/react-jsx-runtime.production.js',
  'node_modules/react/cjs/react.production.js',
  'node_modules/react-dom/cjs/react-dom-client.production.js',
  'node_modules/scheduler/index.js',
  'node_modules/react-dom/index.js',
  'node_modules/react-dom/cjs/react-dom.production.js',
  'node_modules/scheduler/cjs/scheduler.production.js',
]);

export function validateSupplementSourceCompatibility(
  current: Readonly<Record<string, unknown>>,
  fixedFirst: Readonly<Record<string, unknown>>,
  baseline: Readonly<Record<string, unknown>>,
): void {
  const dependencies = Object.keys(current)
    .filter((name) => name.startsWith('node_modules/'))
    .sort();
  const expected = [...SUPPLEMENT_BASELINE_DEPENDENCY_PATHS].sort();
  if (JSON.stringify(dependencies) !== JSON.stringify(expected)) {
    throw new Error('补验依赖来源集合改变');
  }
  for (const name of expected) {
    const hash = current[name];
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash) || hash !== baseline[name]) {
      throw new Error(`补验依赖来源改变:${name}`);
    }
  }
  for (const [name, hash] of Object.entries(current)) {
    if (
      !name.startsWith('tools/data-qualification/performance-check/') &&
      !name.startsWith('node_modules/') &&
      fixedFirst[name] !== hash
    ) {
      throw new Error(`当前产品来源不是固定FIRST来源:${name}`);
    }
  }
}

function finiteNonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label}无效`);
}

export function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0 || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    throw new Error('指标样本或分位无效');
  }
  for (const value of values) finiteNonnegative(value, '指标样本');
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * ratio) - 1]!;
}

export function summarize(values: readonly number[]): MetricSummary {
  return Object.freeze({
    samples: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  });
}

export function relativeLimit(p95: number): number {
  finiteNonnegative(p95, '基线p95');
  return p95 * 1.2 + 20;
}

// Each ProcessMetric percentage applies to the interval ending at that point.
export function summarizeCpu(points: readonly CpuPoint[]): CpuSummary {
  let wallMs = 0;
  let logicalCoreMs = 0;
  let peakAggregatePercent = 0;
  let previous = -1;
  for (const point of points) {
    finiteNonnegative(point.elapsedMs, 'CPU时钟');
    finiteNonnegative(point.aggregatePercent, 'CPU百分比');
    if (point.elapsedMs <= previous) throw new Error('CPU时钟非递增');
    peakAggregatePercent = Math.max(peakAggregatePercent, point.aggregatePercent);
    if (previous >= 0) {
      const interval = point.elapsedMs - previous;
      wallMs += interval;
      logicalCoreMs += (point.aggregatePercent / 100) * interval;
    }
    previous = point.elapsedMs;
  }
  return Object.freeze({
    wallMs,
    logicalCoreMs,
    averageLogicalCores: wallMs === 0 ? null : logicalCoreMs / wallMs,
    peakAggregatePercent,
  });
}

export function validateTimeline(
  points: readonly { elapsedMs: number }[],
  durationMs: number,
): void {
  finiteNonnegative(durationMs, '固定时长');
  if (points.length < 2) throw new Error('采样覆盖不足');
  let previous = -1;
  for (const point of points) {
    finiteNonnegative(point.elapsedMs, '采样时钟');
    if (point.elapsedMs <= previous || (previous >= 0 && point.elapsedMs - previous > 12_000)) {
      throw new Error('采样时序无效');
    }
    previous = point.elapsedMs;
  }
  if (
    points[0]!.elapsedMs > 10_000 ||
    points.at(-1)!.elapsedMs < durationMs - 10_000 ||
    points.at(-1)!.elapsedMs > durationMs + 30_000
  )
    throw new Error('采样未绑定固定窗口起末');
}

function slopePerHour(points: readonly { elapsedMs: number; value: number }[]): number {
  if (points.length < 2) throw new Error('分组增长样本不足');
  const meanX = points.reduce((sum, point) => sum + point.elapsedMs, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.elapsedMs - meanX) ** 2, 0);
  if (denominator <= 0) throw new Error('分组增长时钟无效');
  return (
    (points.reduce((sum, point) => sum + (point.elapsedMs - meanX) * (point.value - meanY), 0) /
      denominator) *
    3_600_000
  );
}

function identity(pid: number, createdFileTime: string): string {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) throw new Error('进程PID无效');
  if (!/^[1-9][0-9]*$/u.test(createdFileTime)) throw new Error('进程creation time无效');
  return `${pid}:${createdFileTime}`;
}

function normalizedMembers(members: readonly IdentityMetric[]): {
  readonly keys: readonly string[];
  readonly rss: number;
  readonly privateBytes: number;
  readonly handles: number;
} {
  if (members.length === 0 || members.length > 24) throw new Error('固定实体成员数无效');
  const keys: string[] = [];
  let rss = 0;
  let privateBytes = 0;
  let handles = 0;
  for (const member of members) {
    const key = identity(member.pid, member.createdFileTime);
    finiteNonnegative(member.rssBytes, '实体RSS');
    finiteNonnegative(member.privateBytes, '实体private');
    finiteNonnegative(member.handles, '实体handles');
    if (!Number.isSafeInteger(member.handles)) throw new Error('实体handles无效');
    keys.push(key);
    rss += member.rssBytes;
    privateBytes += member.privateBytes;
    handles += member.handles;
  }
  keys.sort();
  if (new Set(keys).size !== keys.length) throw new Error('固定实体身份重复');
  return { keys, rss, privateBytes, handles };
}

export function fixedIdentityTreeGrowth(
  points: readonly IdentityPoint[],
  warmupMs = 600_000,
): FixedIdentityGrowth {
  finiteNonnegative(warmupMs, '固定实体暖机');
  let previous = -1;
  let expected: readonly string[] | null = null;
  const rss: Array<{ elapsedMs: number; value: number }> = [];
  const privateBytes: Array<{ elapsedMs: number; value: number }> = [];
  const handles: Array<{ elapsedMs: number; value: number }> = [];
  for (const point of points) {
    finiteNonnegative(point.elapsedMs, '固定实体时钟');
    if (point.elapsedMs <= previous) throw new Error('固定实体时钟非递增');
    previous = point.elapsedMs;
    const normalized = normalizedMembers(point.members);
    if (point.elapsedMs < warmupMs) continue;
    expected ??= normalized.keys;
    if (
      normalized.keys.length !== expected.length ||
      normalized.keys.some((key, index) => key !== expected![index])
    )
      throw new Error('固定实体集合漂移');
    rss.push({ elapsedMs: point.elapsedMs, value: normalized.rss });
    privateBytes.push({ elapsedMs: point.elapsedMs, value: normalized.privateBytes });
    handles.push({ elapsedMs: point.elapsedMs, value: normalized.handles });
  }
  if (expected === null || rss.length < 30) throw new Error('固定实体增长样本不足');
  const spanMs = rss.at(-1)!.elapsedMs - rss[0]!.elapsedMs;
  if (spanMs < 3_600_000) throw new Error('固定实体增长跨度不足');
  return Object.freeze({
    identities: Object.freeze([...expected]),
    samples: rss.length,
    spanMs,
    rssBytesPerHour: slopePerHour(rss),
    privateBytesPerHour: slopePerHour(privateBytes),
    handlesPerHour: slopePerHour(handles),
  });
}

export function validateFixedIdentityLifetimes(
  fixedIdentities: readonly string[],
  lifetimes: readonly IdentityLifetime[],
  freezeAtMs: number,
  windowEndMs: number,
): void {
  finiteNonnegative(freezeAtMs, '固定实体冻结时钟');
  finiteNonnegative(windowEndMs, '固定实体结束时钟');
  if (windowEndMs <= freezeAtMs) throw new Error('固定实体工作窗无效');
  const fixed = new Set(fixedIdentities);
  if (fixed.size === 0 || fixed.size !== fixedIdentities.length)
    throw new Error('固定实体集合无效');
  const crossed = new Set<string>();
  const seen = new Set<string>();
  for (const lifetime of lifetimes) {
    const key = identity(lifetime.pid, lifetime.createdFileTime);
    if (seen.has(key)) throw new Error('原生实体lifetime重复');
    seen.add(key);
    finiteNonnegative(lifetime.firstObservedMs, '实体首次观察');
    finiteNonnegative(lifetime.lastObservedMs, '实体末次观察');
    if (lifetime.lastObservedMs < lifetime.firstObservedMs) throw new Error('实体lifetime倒置');
    if (lifetime.retiredObservedMs !== null) {
      finiteNonnegative(lifetime.retiredObservedMs, '实体退休观察');
      if (lifetime.retiredObservedMs < lifetime.lastObservedMs)
        throw new Error('实体退休早于末次观察');
    }
    const crossesWindow =
      lifetime.firstObservedMs <= freezeAtMs &&
      (lifetime.retiredObservedMs === null || lifetime.retiredObservedMs > windowEndMs);
    if (crossesWindow) crossed.add(key);
    if (
      (lifetime.firstObservedMs > freezeAtMs && lifetime.firstObservedMs < windowEndMs) ||
      (lifetime.retiredObservedMs !== null &&
        lifetime.retiredObservedMs > freezeAtMs &&
        lifetime.retiredObservedMs <= windowEndMs)
    )
      throw new Error('固定实体工作窗出现出生或退休');
  }
  if (
    crossed.size !== fixed.size ||
    [...fixed].some((key) => !crossed.has(key)) ||
    [...crossed].some((key) => !fixed.has(key))
  )
    throw new Error('固定实体lifetime与资源集合不符');
}

export function validateTurnoverLifetimes(
  events: readonly TurnoverIdentityEvent[],
  lifetimes: readonly IdentityLifetime[],
): readonly ResolvedTurnoverEvent[] {
  if (events.length !== 20) throw new Error('周转事件数无效');
  const byPid = new Map<number, Array<IdentityLifetime & { key: string }>>();
  const lifetimeKeys = new Set<string>();
  for (const lifetime of lifetimes) {
    const key = identity(lifetime.pid, lifetime.createdFileTime);
    if (lifetimeKeys.has(key)) throw new Error('原生实体lifetime重复');
    lifetimeKeys.add(key);
    finiteNonnegative(lifetime.firstObservedMs, '实体首次观察');
    finiteNonnegative(lifetime.lastObservedMs, '实体末次观察');
    if (lifetime.lastObservedMs < lifetime.firstObservedMs) throw new Error('实体lifetime倒置');
    if (lifetime.retiredObservedMs !== null) {
      finiteNonnegative(lifetime.retiredObservedMs, '实体退休观察');
      if (lifetime.retiredObservedMs < lifetime.lastObservedMs)
        throw new Error('实体退休早于末次观察');
    }
    const list = byPid.get(lifetime.pid) ?? [];
    list.push({ ...lifetime, key });
    byPid.set(lifetime.pid, list);
  }
  const currentBySlot = new Map<number, string>();
  const newIdentities = new Set<string>();
  const resolved: ResolvedTurnoverEvent[] = [];
  let priorClose = -1;
  for (const [index, event] of events.entries()) {
    const expectedSlot = index % 10;
    const expectedGeneration = Math.floor(index / 10) + 1;
    if (event.slot !== expectedSlot || event.generation !== expectedGeneration)
      throw new Error('周转预定序列错绑');
    for (const value of [event.closeStartedMs, event.createStartedMs, event.createCompletedMs])
      finiteNonnegative(value, '周转时钟');
    if (
      event.closeStartedMs <= priorClose ||
      event.createStartedMs < event.closeStartedMs ||
      event.createCompletedMs < event.createStartedMs ||
      event.createCompletedMs > 1_200_000
    )
      throw new Error('周转时钟或总预算无效');
    priorClose = event.closeStartedMs;
    identity(event.oldPid, '1');
    identity(event.newPid, '1');
    const oldCandidates = (byPid.get(event.oldPid) ?? []).filter(
      (lifetime) =>
        lifetime.firstObservedMs <= event.closeStartedMs &&
        lifetime.retiredObservedMs !== null &&
        lifetime.retiredObservedMs >= event.closeStartedMs &&
        lifetime.retiredObservedMs <= event.createStartedMs,
    );
    if (oldCandidates.length !== 1) throw new Error('旧renderer实体退休无法唯一证明');
    const newCandidates = (byPid.get(event.newPid) ?? []).filter(
      (lifetime) =>
        lifetime.firstObservedMs >= event.createStartedMs - 1_000 &&
        lifetime.firstObservedMs <= event.createCompletedMs + 10_000 &&
        lifetime.lastObservedMs >= event.createCompletedMs,
    );
    if (newCandidates.length !== 1) throw new Error('新renderer实体出生无法唯一证明');
    const oldIdentity = oldCandidates[0]!.key;
    const newIdentity = newCandidates[0]!.key;
    if (oldIdentity === newIdentity || newIdentities.has(newIdentity))
      throw new Error('周转实体未产生唯一新代');
    const priorIdentity = currentBySlot.get(event.slot);
    if (priorIdentity !== undefined && priorIdentity !== oldIdentity)
      throw new Error('同槽前代身份错绑');
    currentBySlot.set(event.slot, newIdentity);
    newIdentities.add(newIdentity);
    resolved.push({ slot: event.slot, generation: event.generation, oldIdentity, newIdentity });
  }
  return Object.freeze(resolved.map((event) => Object.freeze(event)));
}

export interface TopologyGrowth {
  readonly evaluated: Readonly<Record<string, number>>;
  readonly sparse: Readonly<Record<string, number>>;
}

export function fixedTopologyGrowth(points: readonly TopologyPoint[]): TopologyGrowth {
  const groups = new Map<number, TopologyPoint[]>();
  let previous = -1;
  const warmed: TopologyPoint[] = [];
  for (const point of points) {
    finiteNonnegative(point.elapsedMs, '增长时钟');
    finiteNonnegative(point.value, '增长值');
    if (point.elapsedMs <= previous) throw new Error('增长时钟非递增');
    previous = point.elapsedMs;
    if (!Number.isSafeInteger(point.members) || point.members < 1 || point.members > 24)
      throw new Error('拓扑成员数无效');
    if (point.elapsedMs < 600_000) continue;
    warmed.push(point);
    const group = groups.get(point.members) ?? [];
    group.push(point);
    groups.set(point.members, group);
  }
  const evaluated: Record<string, number> = {};
  const sparse: Record<string, number> = {};
  for (const [members, group] of [...groups].sort(([left], [right]) => left - right)) {
    const span = group.at(-1)!.elapsedMs - group[0]!.elapsedMs;
    if (group.length >= 30 && span >= 3_600_000) evaluated[String(members)] = slopePerHour(group);
    else sparse[String(members)] = group.length;
  }
  if (Object.keys(evaluated).length === 0) throw new Error('无稳定拓扑可评估');
  const stable = new Set(Object.keys(evaluated).map(Number));
  for (let index = 0; index < warmed.length;) {
    if (stable.has(warmed[index]!.members)) {
      index += 1;
      continue;
    }
    const begin = index;
    while (index < warmed.length && !stable.has(warmed[index]!.members)) index += 1;
    const episode = warmed.slice(begin, index);
    const before = warmed[begin - 1];
    const after = warmed[index];
    if (
      episode.length > 2 ||
      episode.at(-1)!.elapsedMs - episode[0]!.elapsedMs > 20_000 ||
      before === undefined ||
      after === undefined ||
      before.members !== after.members ||
      !stable.has(before.members)
    )
      throw new Error('稀疏过渡拓扑包络无效');
  }
  return Object.freeze({ evaluated: Object.freeze(evaluated), sparse: Object.freeze(sparse) });
}
