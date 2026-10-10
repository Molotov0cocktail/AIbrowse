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
