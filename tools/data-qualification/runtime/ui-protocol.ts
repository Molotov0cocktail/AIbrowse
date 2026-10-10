// These two channels exist only in the dedicated qualification build.
export const RUNTIME_PING = 'e2-runtime-qualification:ping';
export const RUNTIME_SAMPLE = 'e2-runtime-qualification:sample';
export interface RuntimeUiBridge {
  ping(sequence: number): Promise<number>;
  sample(sequence: number, roundTripMs: number): Promise<boolean>;
}
export function isPing(value: unknown): value is { sequence: number } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 1 &&
    Number.isSafeInteger(record.sequence) &&
    Number(record.sequence) >= 1 &&
    Number(record.sequence) <= 1802
  );
}
export function isSample(value: unknown): value is { sequence: number; roundTripMs: number } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    isPing({ sequence: record.sequence }) &&
    typeof record.roundTripMs === 'number' &&
    Number.isFinite(record.roundTripMs) &&
    record.roundTripMs >= 0 &&
    record.roundTripMs <= 90000
  );
}
