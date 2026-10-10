import { TransferBudget, TransferBudgetError, TRANSFER_EXIT_MS } from './transfer-budget';
import type {
  OwnedTransferChild,
  TransferChildEvents,
  TransferTimers,
  TransferFailureCode,
} from './transfer-supervisor';
import { createStartupProbeProtocol, type StartupProbeResult } from './startup-probe-protocol';
export interface StartupProbeSupervisorOptions {
  operationId: string;
  budget: TransferBudget;
  signal: AbortSignal;
  spawn(operationId: string, events: TransferChildEvents): OwnedTransferChild;
  timers?: TransferTimers;
}
export type StartupProbeOutcome =
  | { state: 'succeeded'; result: StartupProbeResult; exitCode: 0 }
  | { state: 'failed' | 'recovery-required'; code: TransferFailureCode; exitCode: number | null };
const nativeTimers: TransferTimers = {
  set(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
/** Uses the caller's existing sqlite allowance. The result is not permission to open a Store until actual exit. */
export function superviseStartupProbe(options: StartupProbeSupervisorOptions): {
  done: Promise<StartupProbeOutcome>;
  cancel(): void;
  ownsChild(): boolean;
} {
  let resolveDone!: (value: StartupProbeOutcome) => void;
  const done = new Promise<StartupProbeOutcome>((resolve) => {
    resolveDone = resolve;
  });
  const timers = options.timers ?? nativeTimers;
  let child: OwnedTransferChild | null = null,
    owned = false,
    spawning = false,
    exited = false,
    settled = false,
    killed = false,
    disposed = false,
    queued = false;
  let failure: TransferFailureCode | null = null,
    exitCode: number | null = null,
    result: StartupProbeResult | null = null;
  let initialized = false,
    ready = false;
  let stopWork: (() => void) | null = null,
    stopExit: (() => void) | null = null;
  let protocol: ReturnType<typeof createStartupProbeProtocol>;
  const code = (error: unknown): TransferFailureCode =>
    error instanceof TransferBudgetError &&
    (error.code === 'deadline' || error.code === 'cancelled')
      ? error.code
      : 'budget';
  function finish(outcome: StartupProbeOutcome): void {
    if (settled) return;
    settled = true;
    stopWork?.();
    stopWork = null;
    stopExit?.();
    stopExit = null;
    options.signal.removeEventListener('abort', cancel);
    resolveDone(outcome);
  }
  function finalize(): void {
    if (!exited || spawning) return;
    if (child && !disposed) {
      disposed = true;
      try {
        child.disposeListeners();
      } catch {
        failure ??= 'cleanup';
      }
    }
    if (settled) return;
    if (!failure && (!result || exitCode !== 0)) failure = 'exit';
    if (failure) finish({ state: 'failed', code: failure, exitCode });
    else finish({ state: 'succeeded', result: result!, exitCode: 0 });
  }
  function queueFinalize(): void {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      finalize();
    });
  }
  function kill(): void {
    if (!child || exited || killed) return;
    killed = true;
    try {
      child.kill();
    } catch {
      /* Actual exit remains unconfirmed. */
    }
  }
  function fail(reason: TransferFailureCode): void {
    if (settled) return;
    failure ??= reason;
    stopWork?.();
    stopWork = null;
    if (exited) {
      queueFinalize();
      return;
    }
    if (stopExit === null)
      stopExit = timers.set(TRANSFER_EXIT_MS, () => {
        if (exited) finalize();
        else finish({ state: 'recovery-required', code: failure!, exitCode: null });
      });
    kill();
  }
  function cancel(): void {
    if (settled) return;
    options.budget.cancel();
    fail('cancelled');
  }
  function arm(): void {
    stopWork?.();
    stopWork = null;
    if (failure || exited || settled) return;
    try {
      stopWork = timers.set(options.budget.remainingMs(), () => {
        stopWork = null;
        try {
          options.budget.check();
          arm();
        } catch (error) {
          fail(code(error));
        }
      });
    } catch (error) {
      fail(code(error));
    }
  }
  const events: TransferChildEvents = {
    onMessage(raw) {
      if (settled || failure) return;
      if (exited) {
        fail('protocol');
        return;
      }
      try {
        options.budget.check();
        const message = protocol.read(raw);
        if (!initialized || result) {
          fail('protocol');
          return;
        }
        if (message.type === 'ready') {
          if (ready) {
            fail('protocol');
            return;
          }
          ready = true;
        } else if (message.type === 'result') {
          if (!ready) {
            fail('protocol');
            return;
          }
          result = message.result;
        } else fail('protocol');
      } catch (error) {
        fail(error instanceof TransferBudgetError ? code(error) : 'protocol');
      }
    },
    onExit(value) {
      if (exited) {
        fail('protocol');
        return;
      }
      exited = true;
      owned = false;
      exitCode = typeof value === 'number' && Number.isInteger(value) ? value : null;
      stopWork?.();
      stopWork = null;
      if (!settled && !failure) {
        try {
          options.budget.leave();
        } catch (error) {
          failure = code(error);
        }
        if (!result || exitCode !== 0) failure ??= 'exit';
      }
      queueFinalize();
    },
  };
  const handle = { done, cancel, ownsChild: () => owned };
  try {
    protocol = createStartupProbeProtocol(options.operationId);
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
  try {
    options.budget.enter('sqlite');
  } catch (error) {
    finish({ state: 'failed', code: code(error), exitCode: null });
    return handle;
  }
  arm();
  if (failure) {
    finish({ state: 'failed', code: failure, exitCode: null });
    return handle;
  }
  spawning = true;
  try {
    child = options.spawn(options.operationId, events);
    owned = !exited;
  } catch {
    failure ??= 'spawn';
    owned = !exited;
    spawning = false;
    if (exited) finalize();
    else finish({ state: 'recovery-required', code: failure, exitCode: null });
    return handle;
  }
  spawning = false;
  if (exited) {
    queueFinalize();
    return handle;
  }
  if (failure) {
    kill();
    return handle;
  }
  try {
    const raw = protocol.write({
      type: 'init',
      operationId: options.operationId,
      remainingMs: options.budget.remainingMs(),
    });
    initialized = true;
    child.postMessage(raw);
  } catch (error) {
    fail(error instanceof TransferBudgetError ? code(error) : 'transport');
  }
  return handle;
}
