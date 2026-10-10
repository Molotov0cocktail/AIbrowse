import { TransferBudget, type TransferBudgetState } from './transfer-budget';

export interface HandoffGrant {
  budget: TransferBudgetState;
  registrationDeadline: number;
  shutdownAllowanceMs: number;
}

/** Reserve once before durable metadata writes; no remaining grant is refunded. */
export function reserveTransferHandoff(
  state: TransferBudgetState,
  now: number,
  absoluteDeadline: number,
): HandoffGrant {
  const budget = new TransferBudget(() => 0, state).suspend();
  const registration = budget.phaseRemainingMs.containerIo;
  const shutdown = budget.phaseRemainingMs.drain;
  const reserved = registration + shutdown;
  if (
    !Number.isFinite(now) ||
    now < 0 ||
    !Number.isFinite(absoluteDeadline) ||
    registration <= 0 ||
    shutdown <= 0 ||
    absoluteDeadline - now <= reserved ||
    budget.totalRemainingMs <= reserved
  )
    throw new Error('恢复登记与关闭额度不足，现场已保留');
  budget.totalRemainingMs -= reserved;
  budget.phaseRemainingMs.containerIo = 0;
  budget.phaseRemainingMs.drain = 0;
  // Revalidate the exact serialized ledger after deducting both grants.
  new TransferBudget(() => 0, budget).check();
  return {
    budget,
    registrationDeadline: now + registration,
    shutdownAllowanceMs: shutdown,
  };
}
