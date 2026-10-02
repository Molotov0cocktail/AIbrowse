export interface Point {
  slot: number;
  seconds: number;
  value: number;
}

export interface Statistics {
  count: number;
  median: number;
  p95: number;
  observedPeak: number;
  slopePerHour: number | null;
  spanSeconds: number;
}

export function median(values: readonly number[]): number {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value)))
    throw new Error('统计输入为空或非有限数');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Center both axes to avoid cancellation from an absolute QPC origin. */
export function statistics(points: readonly Point[]): Statistics | null {
  if (points.length === 0) return null;
  if (points.some((point) => !Number.isFinite(point.value) || !Number.isFinite(point.seconds)))
    throw new Error('统计输入无效');
  const values = points.map((point) => point.value).sort((a, b) => a - b);
  const origin = points[0]!.seconds;
  const xs = points.map((point) => (point.seconds - origin) / 3600);
  const xMean = xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const yMean = values.reduce((sum, y) => sum + y, 0) / values.length;
  const denominator = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
  const numerator = points.reduce(
    (sum, point, index) => sum + (xs[index]! - xMean) * (point.value - yMean),
    0,
  );
  return {
    count: points.length,
    median: median(values),
    p95: values[Math.ceil(values.length * 0.95) - 1]!,
    observedPeak: values[values.length - 1]!,
    slopePerHour: denominator > 0 ? numerator / denominator : null,
    spanSeconds:
      Math.max(...points.map((point) => point.seconds)) -
      Math.min(...points.map((point) => point.seconds)),
  };
}
