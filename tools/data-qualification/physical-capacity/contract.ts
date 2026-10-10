import { DATABASE_INPUTS, RUNTIME_ID, SOURCE_PROOFS } from '../full-transfer/contract';

export const RESEARCH = DATABASE_INPUTS[1];
export { RUNTIME_ID };
export const SOURCE_PROOF = SOURCE_PROOFS.runtime;
export const TARGET_BYTES = 64 * 1024 ** 2;
export const JOURNAL_BYTES = 128 * 1024 ** 2;
export const WORK_MS = 120_000;
export const NODE_VERSION = 'v24.18.0';
export const NODE_SHA256 = '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de';
export function need(value: unknown): asserts value {
  if (!value) throw new Error('固定物理容量前置条件不成立，原件保留');
}
export function requireScopeId(scope: string): void {
  need(/^physical-capacity-[a-f0-9]{32}$/u.test(scope));
}
export function object(value: unknown): Record<string, unknown> {
  need(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
export function generationSpace(unit: bigint): bigint {
  need(unit > 0n && unit <= 1048576n);
  const round = (bytes: bigint) => ((bytes + unit - 1n) / unit) * unit;
  // The source uses MEMORY, but SQLite backup owns a separate destination
  // connection whose rollback journal needs its own explicit allowance.
  return (
    2n * round(BigInt(TARGET_BYTES)) +
    round(BigInt(JOURNAL_BYTES)) +
    round(16n * 1024n ** 2n) +
    1024n ** 3n
  );
}
