import { TransferBudget, TransferBudgetError, TRANSFER_EXIT_MS } from './transfer-budget';
import {
  createTransferProtocol,
  validateTransferJob,
  TRANSFER_ACTION_PHASES,
  type TransferIncoming,
  type TransferJobRecord,
  type TransferOutgoing,
  type ValidationPhase,
  type TransferResult,
} from './transfer-protocol';

export interface TransferChildEvents {
  onMessage(message: unknown): void;
  onExit(code: number | null): void;
}
export interface OwnedTransferChild {
  postMessage(message: string): void;
  kill(): boolean;
  disposeListeners(): void;
}
export interface TransferTimers {
  /** Returns an idempotent cancellation function. Callbacks must be scheduled asynchronously. */
  set(milliseconds: number, callback: () => void): () => void;
}
export type TransferFailureCode =
  | 'protocol'
  | 'deadline'
  | 'cancelled'
  | 'budget'
  | 'spawn'
  | 'transport'
  | 'worker'
  | 'exit'
  | 'cleanup';
export type TransferOutcome =
  | { state: 'succeeded'; result: TransferResult; exitCode: 0 }
  | { state: 'failed' | 'recovery-required'; code: TransferFailureCode; exitCode: number | null };
export interface TransferSupervisorOptions {
  job: TransferJobRecord;
  /** The existing operation ledger; this supervisor never creates or resets a work budget. */
  budget: TransferBudget;
  signal: AbortSignal;
  /**
   * Attach callbacks synchronously in the same launch turn before returning; do not
   * await or yield between native launch and subscription. The adapter must retain
   * ownership and deliver any already-observed exit. Paths remain in its registration.
   */
  spawn(job: TransferJobRecord, events: TransferChildEvents): OwnedTransferChild;
  timers?: TransferTimers;
}
export interface TransferSupervisorHandle {
  readonly done: Promise<TransferOutcome>;
  cancel(): void;
  getState(): {
    state: 'starting' | 'running' | 'awaiting-exit' | 'stopping' | TransferOutcome['state'];
    phase: ValidationPhase | null;
    ownsChild: boolean;
  };
}
const nativeTimers: TransferTimers = {
  set(milliseconds, callback) {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};

/** Success proves this protocol and actual exit, not the truth of worker-reported disk hashes. */
export function superviseTransfer(options: TransferSupervisorOptions): TransferSupervisorHandle {
  let resolveDone!: (value: TransferOutcome) => void;
  const done = new Promise<TransferOutcome>((resolve) => {
    resolveDone = resolve;
  });
  let state: ReturnType<TransferSupervisorHandle['getState']>['state'] = 'starting';
  let phase: ValidationPhase | null = null;
  let child: OwnedTransferChild | null = null;
  let ownsChild = false;
  let failure: TransferFailureCode | null = null;
  let settled = false;
  let exited = false;
  let exitCode: number | null = null;
  let spawning = false;
  let killSent = false;
  let ready = false;
  let requested = 0;
  let granted = 0;
  let initSent = false;
  let posting = false;
  let pendingPhase: TransferOutgoing | null = null;
  let result: TransferResult | null = null;
  let stopWorkTimer: (() => void) | null = null;
  let stopExitTimer: (() => void) | null = null;
  let listenersDisposed = false;
  let finalizationQueued = false;
  let job: TransferJobRecord;
  let protocol: ReturnType<typeof createTransferProtocol>;
  let phases: readonly ValidationPhase[];
  const timers = options.timers ?? nativeTimers;
  const budgetCode = (error: unknown): TransferFailureCode =>
    error instanceof TransferBudgetError
      ? error.code === 'deadline' || error.code === 'cancelled'
        ? error.code
        : 'budget'
      : 'budget';
  function clearWork(): void {
    stopWorkTimer?.();
    stopWorkTimer = null;
  }
  function finish(outcome: TransferOutcome): void {
    if (settled) return;
    settled = true;
    state = outcome.state;
    clearWork();
    stopExitTimer?.();
    stopExitTimer = null;
    options.signal.removeEventListener('abort', cancel);
    resolveDone(outcome);
  }
  function dispose(): void {
    if (!child || listenersDisposed) return;
    listenersDisposed = true;
    try {
      child.disposeListeners();
    } catch {
      failure ??= 'cleanup';
    }
  }
  function finalizeExit(): void {
    if (!exited || spawning) return;
    dispose();
    if (settled) return;
    if (!failure && (!result || exitCode !== 0)) failure = 'exit';
    if (failure) finish({ state: 'failed', code: failure, exitCode });
    else finish({ state: 'succeeded', result: result!, exitCode: 0 });
  }
  function scheduleFinalization(): void {
    if (finalizationQueued) return;
    finalizationQueued = true;
    queueMicrotask(() => {
      finalizationQueued = false;
      finalizeExit();
    });
  }
  function requestKill(): void {
    if (exited || !child || killSent) return;
    killSent = true;
    // A false return or exception is not exit confirmation. Keep ownership and wait.
    try {
      child.kill();
    } catch {
      /* The original failure stays sticky. */
    }
  }
  function fail(code: TransferFailureCode): void {
    if (settled) return;
    failure ??= code;
    state = 'stopping';
    clearWork();
    if (exited) {
      scheduleFinalization();
      return;
    }
    if (stopExitTimer === null) {
      stopExitTimer = timers.set(TRANSFER_EXIT_MS, () => {
        if (exited) {
          finalizeExit();
          return;
        }
        finish({ state: 'recovery-required', code: failure!, exitCode: null });
      });
    }
    requestKill();
  }
  function cancel(): void {
    if (settled) return;
    options.budget.cancel();
    fail('cancelled');
  }
  function arm(): void {
    clearWork();
    if (failure || exited || settled) return;
    try {
      const remaining = options.budget.remainingMs();
      stopWorkTimer = timers.set(remaining, () => {
        stopWorkTimer = null;
        try {
          options.budget.check();
          arm();
        } catch (error) {
          fail(budgetCode(error));
        }
      });
    } catch (error) {
      fail(budgetCode(error));
    }
  }
  function post(value: TransferOutgoing): void {
    if (failure || exited || settled || !child) return;
    if (posting) {
      if (value.type !== 'phase' || pendingPhase !== null) {
        fail('protocol');
        return;
      }
      pendingPhase = value;
      return;
    }
    let next: TransferOutgoing | null = value;
    while (next !== null && !failure && !exited && !settled) {
      posting = true;
      try {
        const text = protocol.send(next);
        // Permission is effective at dispatch, allowing a response reentered from
        // this post. A deferred dispatch cannot authorize an earlier arrival.
        if (next.type === 'init') initSent = true;
        if (next.type === 'phase') granted = requested;
        child.postMessage(text);
      } catch {
        fail('transport');
      } finally {
        posting = false;
      }
      next = pendingPhase;
      pendingPhase = null;
    }
  }
  function accept(message: TransferIncoming): void {
    if (settled || failure) return;
    if (exited || result) {
      fail('protocol');
      return;
    }
    try {
      options.budget.check();
    } catch (error) {
      fail(budgetCode(error));
      return;
    }
    if (message.type === 'ready') {
      if (ready) {
        fail('protocol');
        return;
      }
      ready = true;
      state = 'running';
    } else if (message.type === 'phase') {
      if (
        !ready ||
        !initSent ||
        granted !== requested ||
        requested >= phases.length ||
        message.phase !== phases[requested]
      ) {
        fail('protocol');
        return;
      }
      phase = message.phase;
      requested++;
      try {
        options.budget.enter(phase);
      } catch (error) {
        fail(budgetCode(error));
        return;
      }
      arm();
      post({ type: 'phase', operationId: job.operationId, phase });
    } else if (message.type === 'result') {
      if (!ready || !initSent || requested !== phases.length || granted !== requested) {
        fail('protocol');
        return;
      }
      result = message.result;
      state = 'awaiting-exit';
      // Keep charging the last phase and the total until actual process exit.
      arm();
    } else {
      fail('worker');
    }
  }
  function acceptExit(code: number | null): void {
    if (exited) {
      fail('protocol');
      return;
    }
    exited = true;
    ownsChild = false;
    exitCode = typeof code === 'number' && Number.isInteger(code) ? code : null;
    clearWork();
    if (!settled && !failure) {
      try {
        options.budget.leave();
      } catch (error) {
        failure = budgetCode(error);
      }
      if (!result || exitCode !== 0) failure ??= 'exit';
    }
    scheduleFinalization();
  }
  const events: TransferChildEvents = {
    onMessage(value) {
      if (settled || failure) return;
      try {
        const message = protocol.receive(value);
        accept(message);
      } catch {
        fail('protocol');
      }
    },
    onExit(code) {
      acceptExit(code);
    },
  };
  const handle: TransferSupervisorHandle = {
    done,
    cancel,
    getState: () => ({ state, phase, ownsChild }),
  };
  try {
    job = validateTransferJob(options.job);
    protocol = createTransferProtocol(job);
    phases = TRANSFER_ACTION_PHASES[job.action];
  } catch {
    finish({ state: 'failed', code: 'protocol', exitCode: null });
    return handle;
  }
  if (options.signal.aborted) {
    options.budget.cancel();
    finish({ state: 'failed', code: 'cancelled', exitCode: null });
    return handle;
  }
  options.signal.addEventListener('abort', cancel, { once: true });
  phase = phases[0];
  try {
    options.budget.enter(phase);
  } catch (error) {
    finish({ state: 'failed', code: budgetCode(error), exitCode: null });
    return handle;
  }
  arm();
  if (failure) {
    finish({ state: 'failed', code: failure, exitCode: null });
    return handle;
  }
  spawning = true;
  try {
    child = options.spawn(job, events);
    ownsChild = !exited;
  } catch {
    // An adapter throw cannot prove that no native process was created. Preserve its workspace.
    failure ??= 'spawn';
    ownsChild = !exited;
    spawning = false;
    if (exited) finalizeExit();
    else finish({ state: 'recovery-required', code: failure, exitCode: null });
    return handle;
  }
  spawning = false;
  // Exit is recorded at arrival, even before spawn returns. It forbids all posts.
  if (!failure && !exited) post({ type: 'init', ...job });
  if (failure) requestKill();
  return handle;
}
