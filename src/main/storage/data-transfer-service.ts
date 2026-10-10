import { randomUUID } from 'node:crypto';
import type {
  DataTransferAction,
  DataTransferCode,
  DataTransferState,
  DataTransferStatus,
} from '../../shared/types/data-transfer';
import {
  TransferBudget,
  TransferBudgetError,
  TRANSFER_WORK_MS,
  type TransferBudgetState,
} from './transfer-budget';
import type { DatasetScope, NewDatasetFingerprints } from './dataset-layout';
import type { MaintenanceCoordinator, MaintenanceTicket } from './maintenance-coordinator';
import type { TransferJobRecord, TransferResult } from './transfer-protocol';
import type { RegisteredTransferInput } from './transfer-registration';
import type { TransferOutcome, TransferTimers } from './transfer-supervisor';
import type { FileDigest } from './backup-container';
import { isTransferUuid } from './backup-container';

export interface TransferDocument {
  isCurrent(): boolean;
}
export type NativeTransferSelection =
  | { action: 'backup'; destination: string }
  | { action: 'restore'; input: RegisteredTransferInput; snapshotId: string };
export type VerifiedTransferData =
  | { action: 'backup'; snapshotId: string; backup: FileDigest }
  | { action: 'restore'; snapshotId: string; expected: NewDatasetFingerprints };
export interface OriginalRecoveryContext {
  readonly job: TransferJobRecord;
  readonly generation: string;
  readonly scope: DatasetScope | null;
  readonly deadlineMonoMs: number;
  readonly maintenanceOperationId: string | null;
  readonly ticket: MaintenanceTicket | null;
  /** Every async port must recheck immediately before its externally visible side effects. */
  assertCurrent(): void;
}
export interface TransferOperationContext extends OriginalRecoveryContext {
  readonly selection: NativeTransferSelection;
  readonly budget: TransferBudget;
  readonly signal: AbortSignal;
}
export interface OriginalTransferState {
  childrenExited: boolean;
  originalDrainsSettled: boolean;
  beforeSwitch: boolean;
}
export interface OriginalTransferProof extends OriginalTransferState {
  operationId: string;
  sameData: boolean;
}
export interface DataTransferPorts {
  now(): number;
  timers: TransferTimers;
  maintenance: Pick<
    MaintenanceCoordinator,
    'acquire' | 'status' | 'cancel' | 'isQuiescent' | 'resume' | 'waitForIdle'
  >;
  chooseNative(action: DataTransferAction): Promise<NativeTransferSelection | null>;
  confirmRestore(message: string): Promise<boolean>;
  createScope(context: TransferOperationContext): Promise<DatasetScope>;
  requireSpace(context: TransferOperationContext): Promise<void>;
  run(context: TransferOperationContext): Promise<TransferOutcome>;
  verify(
    context: TransferOperationContext,
    result: TransferResult,
  ): Promise<VerifiedTransferData | null>;
  publishBackup(
    context: TransferOperationContext,
    proof: Extract<VerifiedTransferData, { action: 'backup' }>,
  ): Promise<boolean>;
  registerHandoff(
    context: TransferOperationContext,
    proof: Extract<VerifiedTransferData, { action: 'restore' }>,
    budget: TransferBudgetState,
  ): Promise<boolean>;
  requestRelaunch(context: TransferOperationContext): Promise<boolean>;
  originalState(context: OriginalRecoveryContext): OriginalTransferState;
  verifyOriginal(context: OriginalRecoveryContext): Promise<OriginalTransferProof>;
  /** Recheck proof and admission together after the last await, then resolve.
   * Restore only original-data admission; never restart the failed job.
   */
  recoverOriginal(context: OriginalRecoveryContext, proof: OriginalTransferProof): Promise<boolean>;
}

const MESSAGES: Record<DataTransferState, string> = {
  idle: '尚未开始数据维护',
  choosing: '请在系统对话框中选择文件',
  confirming: '等待恢复确认',
  draining: '正在停止新任务并等待在途工作结束',
  validating: '正在校验数据',
  verifying: '正在复核数据文件',
  publishing: '正在保存备份并恢复原数据业务',
  handoff: '正在保存恢复登记',
  'awaiting-restart': '恢复已登记，等待重新启动后完成',
  completed: '备份已完整保存，原数据业务已恢复',
  cancelled: '操作已取消',
  failed: '数据维护失败，原件和现场已保留',
  'recovery-required': '数据维护已停止，原件和现场已保留，业务保持关闭',
  'recovering-original': '正在复核原数据及工作退出状态',
  'original-restored': '原数据业务已恢复，失败操作未重试',
};
const CONFIRM =
  '恢复将替换当前信源、研究、监控数据和已保存会话，并关闭当前标签页后重新启动。是否继续？';
interface Operation {
  job: TransferJobRecord;
  generation: string;
  document: TransferDocument;
  selection: NativeTransferSelection | null;
  scope: DatasetScope | null;
  budget: TransferBudget | null;
  deadline: number | null;
  abort: AbortController;
  state: DataTransferState;
  failure: DataTransferCode | null;
  maintenanceStarted: boolean;
  maintenanceId: string | null;
  ticket: MaintenanceTicket | null;
  handoffStarted: boolean;
  suspended: boolean;
  inFlight: boolean;
  recoveryInFlight: boolean;
  stopWorkTimer: (() => void) | null;
  stopDrainTimer: (() => void) | null;
}
class OperationStopped extends Error {}

/** Main-only orchestration. Ports retain native resources and failed scopes.
 * A failed record blocks new work until explicit original-data recovery succeeds.
 * Recovery consumes the original absolute deadline; it never renews the work ledger.
 */
export class DataTransferService {
  private active: Operation | null = null;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private readonly owned = new Set<Promise<DataTransferStatus>>();
  private last: DataTransferStatus = {
    operationId: null,
    action: null,
    state: 'idle',
    code: 'none',
    message: MESSAGES.idle,
    canCancel: false,
    canRecoverOriginal: false,
    availableActions: ['backup', 'restore'],
  };
  constructor(readonly ports: DataTransferPorts) {}

  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const op = this.active;
    if (op !== null && !op.handoffStarted) this.stop(op, 'cancelled');
  }

  drainBeforeClose(): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.shutdownPromise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    // Publish ownership before abort callbacks can synchronously re-enter.
    this.beginShutdown();
    void this.finishShutdown().then(resolve, reject);
    return this.shutdownPromise;
  }

  private async finishShutdown(): Promise<void> {
    const settled = await Promise.allSettled([...this.owned]);
    await this.ports.maintenance.waitForIdle();
    if (
      settled.some((result) => result.status === 'rejected') ||
      this.ports.maintenance.status().pending
    )
      throw new Error('数据维护退出未完成，原件和句柄已保留');
    const op = this.active;
    if (op === null || op.scope === null) return;
    if (op.deadline === null) throw new Error('数据维护退出未完成，原件和句柄已保留');
    // Physical exit inspection is allowed after expiry. This context grants no
    // further transfer work and never renews the original absolute deadline.
    const context: OriginalRecoveryContext = {
      job: op.job,
      generation: op.generation,
      scope: op.scope,
      deadlineMonoMs: op.deadline,
      maintenanceOperationId: op.maintenanceId,
      ticket: op.ticket,
      assertCurrent: () => {
        if (!this.shuttingDown || this.active !== op || op.inFlight || op.recoveryInFlight)
          throw new Error('数据维护退出未完成，原件和句柄已保留');
      },
    };
    try {
      context.assertCurrent();
      const state = this.ports.originalState(context);
      context.assertCurrent();
      if (
        state.childrenExited !== true ||
        state.originalDrainsSettled !== true ||
        this.ports.maintenance.status().pending
      )
        throw new OperationStopped();
    } catch {
      throw new Error('数据维护退出未完成，原件和句柄已保留');
    }
  }

  private own(work: () => Promise<DataTransferStatus>): Promise<DataTransferStatus> {
    let resolve!: (value: DataTransferStatus) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<DataTransferStatus>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    this.owned.add(promise);
    const finish = (value: DataTransferStatus) => {
      this.owned.delete(promise);
      resolve(value);
    };
    const fail = (error: unknown) => {
      this.owned.delete(promise);
      reject(error);
    };
    try {
      void work().then(finish, fail);
    } catch (error) {
      fail(error);
    }
    return promise;
  }

  private shutdownReceipt(): DataTransferStatus {
    return {
      ...this.getStatus(),
      code: 'cancelled',
      message: '应用正在退出，不能开始数据操作',
      canCancel: false,
      canRecoverOriginal: false,
      availableActions: [],
    };
  }

  private current(document: TransferDocument): boolean {
    try {
      return document.isCurrent() === true;
    } catch {
      return false;
    }
  }
  private receipt(code: DataTransferCode): DataTransferStatus {
    return {
      ...this.getStatus(),
      code,
      message: code === 'busy' ? '已有数据维护操作尚未结束' : '数据维护请求无效或已过期',
      canCancel: false,
      canRecoverOriginal: false,
      availableActions: [],
    };
  }
  private context(op: Operation): TransferOperationContext {
    if (!op.budget || !op.selection || op.deadline === null) throw new OperationStopped();
    return {
      job: op.job,
      generation: op.generation,
      selection: op.selection,
      budget: op.budget,
      signal: op.abort.signal,
      deadlineMonoMs: op.deadline,
      get scope() {
        return op.scope;
      },
      get maintenanceOperationId() {
        return op.maintenanceId;
      },
      get ticket() {
        return op.ticket;
      },
      assertCurrent: () => this.assertCurrent(op),
    };
  }
  private originalContext(
    op: Operation,
    document: TransferDocument | null,
  ): OriginalRecoveryContext {
    if (op.deadline === null) throw new OperationStopped();
    return {
      job: op.job,
      generation: op.generation,
      scope: op.scope,
      deadlineMonoMs: op.deadline,
      maintenanceOperationId: op.maintenanceId,
      ticket: op.ticket,
      assertCurrent: () => {
        if (
          this.active !== op ||
          (document !== null && this.shuttingDown) ||
          (document !== null && !this.current(document)) ||
          op.handoffStarted ||
          !Number.isFinite(this.ports.now()) ||
          this.ports.now() >= op.deadline!
        )
          throw new OperationStopped();
      },
    };
  }
  private canRecover(op: Operation): boolean {
    if (
      this.shuttingDown ||
      !op.failure ||
      op.state !== 'recovery-required' ||
      op.inFlight ||
      op.recoveryInFlight ||
      !op.maintenanceStarted ||
      op.handoffStarted ||
      op.deadline === null ||
      this.ports.now() >= op.deadline
    )
      return false;
    try {
      // Status inspects physical ownership only; it grants no recovery authority.
      // Explicit recovery binds its complete execution to the new trusted document.
      const state = this.ports.originalState(this.originalContext(op, null));
      return (
        state.childrenExited === true &&
        state.originalDrainsSettled === true &&
        state.beforeSwitch === true &&
        !this.ports.maintenance.status().pending
      );
    } catch {
      return false;
    }
  }
  private projection(op: Operation): DataTransferStatus {
    return {
      operationId: op.job.operationId,
      action: op.job.action as DataTransferAction,
      state: op.state,
      code: op.failure ?? 'none',
      message: MESSAGES[op.state],
      canCancel: !this.shuttingDown && op.inFlight && !op.failure && !op.handoffStarted,
      canRecoverOriginal: this.canRecover(op),
      availableActions: [],
    };
  }
  getStatus(): DataTransferStatus {
    return this.active
      ? this.projection(this.active)
      : {
          ...this.last,
          availableActions: this.shuttingDown ? [] : ['backup', 'restore'],
        };
  }
  private stop(op: Operation, code: DataTransferCode): void {
    op.failure ??= code;
    op.state =
      op.maintenanceStarted || op.handoffStarted
        ? 'recovery-required'
        : op.failure === 'cancelled'
          ? 'cancelled'
          : 'failed';
    op.budget?.cancel();
    if (!op.abort.signal.aborted) op.abort.abort();
    if (op.maintenanceId !== null) this.ports.maintenance.cancel(op.maintenanceId);
  }
  private assertCurrent(op: Operation): void {
    if (this.active !== op) throw new OperationStopped();
    if (!this.current(op.document)) this.stop(op, 'stale-document');
    if (op.failure) throw new OperationStopped();
    if (op.deadline !== null) {
      const now = this.ports.now();
      if (!Number.isFinite(now) || now >= op.deadline) {
        this.stop(op, 'deadline');
        throw new OperationStopped();
      }
    }
    if (op.budget && !op.suspended) {
      try {
        op.budget.check();
      } catch (error) {
        this.stop(
          op,
          error instanceof TransferBudgetError && error.code === 'cancelled'
            ? 'cancelled'
            : 'deadline',
        );
        throw new OperationStopped();
      }
    }
  }
  private stage(op: Operation, state: DataTransferState): void {
    this.assertCurrent(op);
    op.state = state;
  }
  private originalMatches(op: Operation, proof: OriginalTransferProof): boolean {
    return (
      proof.operationId === op.job.operationId &&
      proof.childrenExited === true &&
      proof.originalDrainsSettled === true &&
      proof.beforeSwitch === true &&
      proof.sameData === true
    );
  }
  private cleanupTimers(op: Operation): void {
    op.stopDrainTimer?.();
    op.stopDrainTimer = null;
    op.stopWorkTimer?.();
    op.stopWorkTimer = null;
  }
  start(action: unknown, document: TransferDocument): Promise<DataTransferStatus> {
    if (this.shuttingDown) return Promise.resolve(this.shutdownReceipt());
    return this.own(() => this.startOwned(action, document));
  }
  private async startOwned(
    action: unknown,
    document: TransferDocument,
  ): Promise<DataTransferStatus> {
    if (action !== 'backup' && action !== 'restore') return this.receipt('invalid-request');
    if (!this.current(document)) return this.receipt('stale-document');
    if (this.shuttingDown) return this.shutdownReceipt();
    if (this.active !== null) return this.receipt('busy');
    const op: Operation = {
      job: Object.freeze({ operationId: randomUUID(), snapshotId: randomUUID(), action }),
      generation: randomUUID().replaceAll('-', ''),
      document,
      selection: null,
      scope: null,
      budget: null,
      deadline: null,
      abort: new AbortController(),
      state: 'choosing',
      failure: null,
      maintenanceStarted: false,
      maintenanceId: null,
      ticket: null,
      handoffStarted: false,
      suspended: false,
      inFlight: true,
      recoveryInFlight: false,
      stopWorkTimer: null,
      stopDrainTimer: null,
    };
    this.active = op;
    let failureCode: DataTransferCode = 'invalid-request';
    try {
      const selection = await this.ports.chooseNative(action);
      this.assertCurrent(op);
      if (selection === null) {
        this.stop(op, 'cancelled');
        throw new OperationStopped();
      }
      if (
        selection.action !== action ||
        (selection.action === 'restore' && !isTransferUuid(selection.snapshotId))
      )
        throw new OperationStopped();
      op.selection = selection;
      if (selection.action === 'restore') {
        op.job = Object.freeze({ ...op.job, snapshotId: selection.snapshotId });
        this.stage(op, 'confirming');
        const confirmed = await this.ports.confirmRestore(CONFIRM);
        this.assertCurrent(op);
        if (confirmed !== true) {
          this.stop(op, 'cancelled');
          throw new OperationStopped();
        }
      }
      const started = this.ports.now();
      op.budget = new TransferBudget(() => this.ports.now());
      op.deadline = started + TRANSFER_WORK_MS;
      op.stopWorkTimer = this.ports.timers.set(op.budget.remainingMs(), () => {
        if (this.active === op && op.inFlight) this.stop(op, 'deadline');
      });
      const context = this.context(op);
      failureCode = 'scope';
      op.scope = await this.ports.createScope(context);
      this.assertCurrent(op);
      if (
        op.scope.operationId !== op.job.operationId.replaceAll('-', '') ||
        op.scope.generation !== op.generation ||
        op.scope.purpose !== action
      )
        throw new OperationStopped();
      this.stage(op, 'draining');
      failureCode = 'maintenance';
      // A different coordinator owner must never be cancelled or recovered by us.
      if (this.ports.maintenance.status().phase !== 'idle') throw new OperationStopped();
      op.budget.enter('drain');
      op.maintenanceStarted = true;
      const acquiring = this.ports.maintenance.acquire(op.deadline);
      op.maintenanceId = this.ports.maintenance.status().operationId;
      op.stopDrainTimer = this.ports.timers.set(op.budget.remainingMs(), () =>
        this.stop(op, 'deadline'),
      );
      const acquired = await acquiring;
      op.stopDrainTimer?.();
      op.stopDrainTimer = null;
      this.assertCurrent(op);
      if (!acquired.ok) {
        this.stop(op, acquired.reason === 'deadline' ? 'deadline' : 'maintenance');
        throw new OperationStopped();
      }
      op.ticket = acquired.ticket;
      if (
        op.ticket.operationId !== op.maintenanceId ||
        !this.ports.maintenance.isQuiescent(op.ticket)
      )
        throw new OperationStopped();
      op.budget.leave();
      op.budget.enter('containerIo');
      await this.ports.requireSpace(context);
      this.assertCurrent(op);
      op.budget.leave();
      if (!this.ports.maintenance.isQuiescent(op.ticket)) throw new OperationStopped();
      this.stage(op, 'validating');
      failureCode = 'worker';
      const outcome = await this.ports.run(context);
      if (outcome.state !== 'succeeded') {
        this.stop(
          op,
          outcome.code === 'deadline'
            ? 'deadline'
            : outcome.code === 'cancelled'
              ? 'cancelled'
              : 'worker',
        );
      }
      this.assertCurrent(op);
      if (
        outcome.state !== 'succeeded' ||
        outcome.exitCode !== 0 ||
        outcome.result.manifest.snapshotId !== op.job.snapshotId
      )
        throw new OperationStopped();
      this.stage(op, 'verifying');
      failureCode = 'verification';
      op.budget.enter('containerIo');
      const proof = await this.ports.verify(context, outcome.result);
      this.assertCurrent(op);
      if (
        !proof ||
        proof.action !== action ||
        proof.snapshotId !== op.job.snapshotId ||
        !this.ports.maintenance.isQuiescent(op.ticket)
      )
        throw new OperationStopped();
      op.budget.leave();
      op.budget.enter('publish');
      if (proof.action === 'backup') {
        this.stage(op, 'publishing');
        failureCode = 'publication';
        const published = await this.ports.publishBackup(context, proof);
        this.assertCurrent(op);
        if (published !== true) throw new OperationStopped();
        const original = await this.ports.verifyOriginal(context);
        this.assertCurrent(op);
        if (!this.originalMatches(op, original) || !this.ports.maintenance.isQuiescent(op.ticket))
          throw new OperationStopped();
        op.budget.leave();
        if (!this.ports.maintenance.resume(op.ticket)) throw new OperationStopped();
        op.state = 'completed';
      } else {
        this.stage(op, 'handoff');
        failureCode = 'handoff';
        op.handoffStarted = true;
        const budget = op.budget.suspend();
        op.suspended = true;
        const registered = await this.ports.registerHandoff(context, proof, budget);
        this.assertCurrent(op);
        if (registered !== true) throw new OperationStopped();
        failureCode = 'relaunch';
        const relaunched = await this.ports.requestRelaunch(context);
        this.assertCurrent(op);
        if (relaunched !== true) throw new OperationStopped();
        op.state = 'awaiting-restart';
      }
    } catch (error) {
      if (!op.failure)
        this.stop(op, error instanceof TransferBudgetError ? 'deadline' : failureCode);
    } finally {
      op.inFlight = false;
      this.cleanupTimers(op);
      this.last = this.projection(op);
      if (!op.maintenanceStarted || op.state === 'completed') this.active = null;
    }
    return this.getStatus();
  }
  cancel(operationId: unknown, document: TransferDocument): DataTransferStatus {
    if (this.shuttingDown) return this.shutdownReceipt();
    if (!this.current(document)) return this.receipt('stale-document');
    const op = this.active;
    if (!op || operationId !== op.job.operationId) return this.receipt('invalid-request');
    if (!op.inFlight || op.handoffStarted || op.failure) return this.getStatus();
    this.stop(op, 'cancelled');
    return this.getStatus();
  }
  recoverOriginal(operationId: unknown, document: TransferDocument): Promise<DataTransferStatus> {
    if (this.shuttingDown) return Promise.resolve(this.shutdownReceipt());
    return this.own(() => this.recoverOriginalOwned(operationId, document));
  }
  private async recoverOriginalOwned(
    operationId: unknown,
    document: TransferDocument,
  ): Promise<DataTransferStatus> {
    if (!this.current(document)) return this.receipt('stale-document');
    if (this.shuttingDown) return this.shutdownReceipt();
    const op = this.active;
    if (!op || operationId !== op.job.operationId) return this.receipt('invalid-request');
    if (!this.canRecover(op)) return this.getStatus();
    op.recoveryInFlight = true;
    op.state = 'recovering-original';
    const context = this.originalContext(op, document);
    const stopRecoveryTimer = this.ports.timers.set(op.deadline! - this.ports.now(), () => {
      if (this.active === op && op.recoveryInFlight) op.state = 'recovery-required';
    });
    try {
      context.assertCurrent();
      const proof = await this.ports.verifyOriginal(context);
      context.assertCurrent();
      if (!this.originalMatches(op, proof) || this.ports.maintenance.status().pending)
        throw new OperationStopped();
      const restored = await this.ports.recoverOriginal(context, proof);
      context.assertCurrent();
      if (restored !== true) throw new OperationStopped();
      op.state = 'original-restored';
    } catch {
      op.state = 'recovery-required';
    } finally {
      stopRecoveryTimer();
      op.recoveryInFlight = false;
      this.last = this.projection(op);
      if (op.state === 'original-restored') this.active = null;
    }
    return this.getStatus();
  }
}
