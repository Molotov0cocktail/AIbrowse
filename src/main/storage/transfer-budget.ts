export const TRANSFER_PHASE_MS = Object.freeze({
  drain: 20_000,
  rollbackCopy: 120_000,
  containerIo: 150_000,
  sqlite: 90_000,
  conversations: 1_000_000,
  publish: 60_000,
  boot: 60_000,
});
export type TransferPhase = keyof typeof TRANSFER_PHASE_MS;
export const TRANSFER_WORK_MS = 1_500_000;
export const TRANSFER_EXIT_MS = 10_000;
export const TRANSFER_FRAME_LIMITS = Object.freeze({ bytes: 4096, count: 16, totalBytes: 65536 });
export interface TransferBudgetState {
  version: 1;
  totalRemainingMs: number;
  phaseRemainingMs: Record<TransferPhase, number>;
}
export class TransferBudgetError extends Error {
  constructor(readonly code: 'deadline' | 'cancelled' | 'clock' | 'state') {
    super('数据维护已停止，原件和恢复记录已保留');
  }
}
export class TransferBudget {
  private readonly clock: () => number;
  private last: number;
  private totalRemaining: number;
  private readonly phases: Record<TransferPhase, number>;
  private active: TransferPhase | null = null;
  private failure: TransferBudgetError | null = null;
  private suspended = false;

  constructor(clock: () => number = () => performance.now(), state?: TransferBudgetState) {
    this.clock = clock;
    this.last = clock();
    if (!Number.isFinite(this.last) || this.last < 0) throw new TransferBudgetError('clock');
    const value = state ?? {
      version: 1,
      totalRemainingMs: TRANSFER_WORK_MS,
      phaseRemainingMs: { ...TRANSFER_PHASE_MS },
    };
    const object = (item: unknown): item is Record<string, unknown> =>
      item !== null && typeof item === 'object' && !Array.isArray(item);
    if (
      !object(value) ||
      Object.keys(value).length !== 3 ||
      !['version', 'totalRemainingMs', 'phaseRemainingMs'].every((key) =>
        Object.hasOwn(value, key),
      ) ||
      value.version !== 1 ||
      !Number.isFinite(value.totalRemainingMs) ||
      value.totalRemainingMs <= 0 ||
      value.totalRemainingMs > TRANSFER_WORK_MS ||
      !object(value.phaseRemainingMs) ||
      Object.keys(value.phaseRemainingMs).length !== Object.keys(TRANSFER_PHASE_MS).length
    )
      throw new TransferBudgetError('state');
    for (const phase of Object.keys(TRANSFER_PHASE_MS) as TransferPhase[]) {
      const remaining = value.phaseRemainingMs[phase];
      if (
        !Object.hasOwn(value.phaseRemainingMs, phase) ||
        !Number.isFinite(remaining) ||
        remaining < 0 ||
        remaining > TRANSFER_PHASE_MS[phase]
      )
        throw new TransferBudgetError('state');
    }
    const phaseTotal = Object.values(value.phaseRemainingMs).reduce((sum, ms) => sum + ms, 0);
    if (value.totalRemainingMs > phaseTotal + 0.000001) throw new TransferBudgetError('state');
    // Fractional clock readings can accumulate slightly different rounding in
    // each sum. Clamp downward so this tolerance never extends a deadline.
    this.totalRemaining = Math.min(value.totalRemainingMs, phaseTotal);
    this.phases = { ...value.phaseRemainingMs };
  }

  private fail(code: TransferBudgetError['code']): never {
    this.failure ??= new TransferBudgetError(code);
    throw this.failure;
  }

  // This ledger revokes permission; the main-process supervisor must separately
  // terminate a utility that is blocked in native code and confirm actual exit.
  check(): void {
    if (this.failure) throw this.failure;
    if (this.suspended) this.fail('state');
    const now = this.clock();
    if (!Number.isFinite(now) || now < this.last) this.fail('clock');
    const elapsed = now - this.last;
    this.last = now;
    this.totalRemaining -= elapsed;
    if (this.active !== null) this.phases[this.active] -= elapsed;
    if (this.totalRemaining <= 0 || (this.active !== null && this.phases[this.active] <= 0))
      this.fail('deadline');
  }

  enter(phase: TransferPhase): void {
    this.check();
    if (!Object.hasOwn(TRANSFER_PHASE_MS, phase)) this.fail('state');
    this.active = phase;
    this.check();
  }

  leave(): void {
    this.check();
    this.active = null;
  }

  remainingMs(): number {
    this.check();
    return this.active === null
      ? this.totalRemaining
      : Math.min(this.totalRemaining, this.phases[this.active]);
  }

  cancel(): void {
    this.failure ??= new TransferBudgetError('cancelled');
  }

  // Only a durable, single-use main-process handoff may resume this state.
  // A fresh monotonic clock starts from the recorded remaining allowances.
  suspend(): TransferBudgetState {
    this.check();
    this.suspended = true;
    return {
      version: 1,
      totalRemainingMs: this.totalRemaining,
      phaseRemainingMs: { ...this.phases },
    };
  }
}
