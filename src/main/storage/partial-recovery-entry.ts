import { randomUUID } from 'node:crypto';
import type { DataTransferCode, DataTransferStatus } from '../../shared/types/data-transfer';
import type { TransferDocument } from './data-transfer-service';
import type { TransferTimers } from './transfer-supervisor';
import {
  TransferBudget,
  TransferBudgetError,
  TRANSFER_PHASE_MS,
  TRANSFER_WORK_MS,
} from './transfer-budget';

export interface PartialRecoveryGateContext {
  readonly signal: AbortSignal;
  readonly budget: TransferBudget;
  readonly deadlineMonoMs: number;
  /** Recheck immediately before each persistent side effect. */
  assertCurrent(): void;
}

export interface PartialRecoveryEntryOptions {
  /** Same retained partial graph, data admission closed, guardian still current. */
  assertPartialGraph(): void;
  confirmRestart(message: string): Promise<boolean>;
  /** Own the original file operation until settlement; never detach its writes. */
  ensureRecoveryGate(context: PartialRecoveryGateContext): Promise<void>;
  /** Main owns this irreversible handoff and schedules real shutdown next turn. */
  requestRelaunch(deadlineMonoMs: number): Promise<boolean>;
  now?: () => number;
  timers?: TransferTimers;
}

export interface PartialRecoveryEntry {
  start(action: unknown, document: TransferDocument): Promise<DataTransferStatus>;
  getStatus(): DataTransferStatus;
  beginShutdown(): void;
  drainBeforeClose(): Promise<void>;
  relaunchFailed(): void;
}

const CONFIRM =
  '本地数据服务未完整启动。是否关闭当前标签页并重新启动到恢复界面？重新启动后需要再次选择备份并确认恢复；原件和失败现场将保留。';
const INITIAL = '本地数据服务未完整启动。恢复需要先关闭标签页并重新启动，再选择备份。';
class EntryFailure extends Error {
  constructor(readonly code: DataTransferCode) {
    super('恢复准备未完成，业务保持关闭，原件和现场已保留');
  }
}
interface Attempt {
  readonly operationId: string;
  readonly document: TransferDocument;
  readonly abort: AbortController;
  budget: TransferBudget | null;
  deadline: number | null;
  mainOwned: boolean;
  failure: DataTransferCode | null;
  state: DataTransferStatus['state'];
  cancelTimer: (() => void) | null;
}

/** This entry never opens a Store, chooses a backup, or resumes a rejected graph. */
export function createPartialRecoveryEntry(
  options: PartialRecoveryEntryOptions,
): PartialRecoveryEntry {
  const now = options.now ?? (() => performance.now());
  const timers = options.timers ?? {
    set(ms: number, callback: () => void) {
      const timer = setTimeout(callback, Math.ceil(ms));
      return () => clearTimeout(timer);
    },
  };
  let stopped = false;
  let blocked = false;
  let attempt: Attempt | null = null;
  let pending: Promise<DataTransferStatus> | null = null;
  let shutdown: Promise<void> | null = null;

  function fail(value: Attempt, code: DataTransferCode): void {
    value.failure ??= code;
    value.state = 'recovery-required';
    value.abort.abort();
  }
  function local(value: Attempt): void {
    if (value.failure !== null) throw new EntryFailure(value.failure);
    if (!value.mainOwned && (stopped || value.abort.signal.aborted))
      throw new EntryFailure('cancelled');
    value.budget?.check();
    if (value.deadline !== null) {
      const instant = now();
      if (!Number.isFinite(instant) || instant < 0 || instant >= value.deadline)
        throw new EntryFailure('deadline');
    }
  }
  function check(value: Attempt): void {
    const checkDocument = (): void => {
      local(value);
      let current = false;
      try {
        current = value.document.isCurrent() === true;
      } catch {
        /* An unavailable document cannot authorize a new handoff. */
      }
      local(value);
      if (!current) throw new EntryFailure('stale-document');
    };
    checkDocument();
    options.assertPartialGraph();
    // Proof callbacks may synchronously revoke admission or advance the clock.
    checkDocument();
  }
  function arm(value: Attempt, delay: number): void {
    value.cancelTimer?.();
    value.cancelTimer = timers.set(delay, () => fail(value, 'deadline'));
  }
  function permitted(): boolean {
    if (stopped || blocked || pending !== null) return false;
    try {
      options.assertPartialGraph();
      return !stopped && !blocked && pending === null;
    } catch {
      return false;
    }
  }
  function status(): DataTransferStatus {
    const value = attempt;
    const state = value?.state ?? 'recovery-required';
    const code = value?.failure ?? (state === 'cancelled' ? 'cancelled' : 'recovery');
    return {
      operationId: value?.operationId ?? null,
      action: value ? 'restore' : null,
      state,
      code: state === 'awaiting-restart' ? 'none' : code,
      message:
        state === 'awaiting-restart'
          ? '恢复入口已登记，正在关闭当前标签页并重新启动；下一启动请再次选择备份'
          : state === 'confirming'
            ? '请在系统对话框确认是否重新启动到恢复界面'
            : state === 'handoff'
              ? '正在保存恢复入口并准备重新启动'
              : state === 'cancelled'
                ? '已取消重新启动，原数据业务保持关闭'
                : value?.failure
                  ? '恢复准备未完成，业务保持关闭，原件和现场已保留'
                  : INITIAL,
      canCancel: false,
      canRecoverOriginal: false,
      availableActions: permitted() ? ['restore'] : [],
    };
  }
  function receipt(code: DataTransferCode): DataTransferStatus {
    return {
      ...status(),
      code,
      message: code === 'busy' ? '恢复准备尚未安全结束，不能开始新操作' : '恢复请求无效或已停止',
    };
  }
  async function run(value: Attempt): Promise<void> {
    let stage: DataTransferCode = 'recovery';
    try {
      check(value);
      const accepted = await options.confirmRestart(CONFIRM);
      check(value);
      if (!accepted) {
        value.state = 'cancelled';
        return;
      }
      value.budget = new TransferBudget(now);
      value.deadline = now() + TRANSFER_WORK_MS;
      value.budget.enter('containerIo');
      arm(value, value.budget.remainingMs());
      check(value);
      stage = 'handoff';
      value.state = 'handoff';
      // Even a rejected write can leave durable evidence. Never retry this instance.
      blocked = true;
      await options.ensureRecoveryGate({
        signal: value.abort.signal,
        budget: value.budget,
        deadlineMonoMs: value.deadline,
        assertCurrent: () => check(value),
      });
      check(value);
      value.budget.enter('drain');
      value.deadline = Math.min(value.deadline, now() + TRANSFER_PHASE_MS.drain);
      arm(value, Math.min(value.budget.remainingMs(), value.deadline - now()));
      check(value);
      // Native relaunch intent is irreversible. After this final proof, main owns
      // the handoff; renderer navigation and normal shutdown cannot revoke it.
      value.mainOwned = true;
      stage = 'relaunch';
      const scheduled = await options.requestRelaunch(value.deadline);
      local(value);
      if (!scheduled) throw new EntryFailure('relaunch');
      value.state = 'awaiting-restart';
    } catch (error) {
      fail(
        value,
        error instanceof EntryFailure
          ? error.code
          : error instanceof TransferBudgetError
            ? error.code === 'cancelled'
              ? 'cancelled'
              : 'deadline'
            : stage,
      );
    } finally {
      value.cancelTimer?.();
      value.cancelTimer = null;
    }
  }
  const api: PartialRecoveryEntry = {
    getStatus: status,
    start(action, document) {
      if (action !== 'restore') return Promise.resolve(receipt('invalid-request'));
      if (stopped) return Promise.resolve(receipt('cancelled'));
      if (pending || blocked) return Promise.resolve(receipt('busy'));
      let resolve!: (result: DataTransferStatus) => void;
      const owned = new Promise<DataTransferStatus>((done) => {
        resolve = done;
      });
      pending = owned;
      const value: Attempt = {
        operationId: randomUUID(),
        document,
        abort: new AbortController(),
        budget: null,
        deadline: null,
        mainOwned: false,
        failure: null,
        state: 'confirming',
        cancelTimer: null,
      };
      attempt = value;
      void run(value).then(() => {
        pending = null;
        resolve(status());
      });
      return owned;
    },
    relaunchFailed() {
      blocked = true;
      if (attempt) fail(attempt, 'relaunch');
    },
    beginShutdown() {
      if (stopped) return;
      stopped = true;
      if (attempt && !attempt.mainOwned) attempt.abort.abort();
    },
    drainBeforeClose() {
      if (shutdown) return shutdown;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      shutdown = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      api.beginShutdown();
      // A timer can revoke permission, but never settles a native dialog or write.
      void (async () => {
        if (pending) await pending;
      })().then(resolve, reject);
      return shutdown;
    },
  };
  return api;
}
