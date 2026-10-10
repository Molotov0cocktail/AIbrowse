// These limits are measurement budgets, not E2 product commitments.
export const BUDGET = Object.freeze({
  rounds: 3,
  roundMs: 20_000,
  jobMs: 90_000,
  jobCleanupMs: 30_000,
  diskBytes: 1024 * 1024 * 1024,
  holdAfterReturnMs: 150,
  maximumEvents: 256,
});

export interface DrainObservation {
  methodReturnedAt: number;
  actualSettledAt: number | null;
  pendingAtReturn: number;
  pendingAfterHold: number;
  terminalAtReturn: boolean;
  terminalAfterRelease: boolean;
}

export function legacyReturnedBeforeDrain(value: DrainObservation): boolean {
  return (
    Number.isFinite(value.methodReturnedAt) &&
    value.pendingAtReturn > 0 &&
    value.pendingAfterHold > 0 &&
    value.actualSettledAt !== null &&
    value.actualSettledAt > value.methodReturnedAt
  );
}

export function assertFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function validBuildId(value: string): boolean {
  return /^drain-[a-f0-9]{32}$/.test(value);
}
