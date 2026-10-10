import type { DataTransferStatus } from '../../shared/types/data-transfer';
import {
  DataTransferService,
  type DataTransferPorts,
  type TransferDocument,
  type TransferOperationContext,
} from './data-transfer-service';
import type { UtilityGuardian } from './utility-guardian-port';
import { MaintenanceCoordinator } from './maintenance-coordinator';
import { createTransferFiles } from './transfer-files';
import { createDatasetScope, type DatasetContext } from './dataset-layout';
import { DatasetReplacement } from './dataset-replacement';
import { registerActiveDataset } from './dataset-active';
import { DatasetSwitch } from './dataset-switch';
import { reserveTransferHandoff } from './transfer-handoff';
import { requireTransferSpace } from './transfer-space';

export interface RecoveryTransferRuntimeOptions {
  userDataRoot: string;
  productVersion: string;
  guardian: UtilityGuardian;
  assertNoStores(): void;
  chooseNative: DataTransferPorts['chooseNative'];
  confirmRestore: DataTransferPorts['confirmRestore'];
  requestRelaunch(deadlineMonoMs: number): Promise<boolean>;
}
export interface RecoveryTransferRuntime {
  start(action: unknown, document: TransferDocument): Promise<DataTransferStatus>;
  cancel(operationId: unknown, document: TransferDocument): DataTransferStatus;
  getStatus(): DataTransferStatus;
  relaunchFailed(): void;
  beginShutdown(): void;
  drainBeforeClose(): Promise<void>;
}
/** Recovery never constructs or resumes the rejected original Store graph. */
export function createRecoveryTransferRuntime(
  options: RecoveryTransferRuntimeOptions,
): RecoveryTransferRuntime {
  const now = (): number => performance.now();
  const files = createTransferFiles({
    productVersion: options.productVersion,
    guardian: options.guardian,
  });
  const attempts: Array<{ service: DataTransferService; drain: Promise<void> | null }> = [];
  let current: (typeof attempts)[number] | null = null;
  let pending: Promise<DataTransferStatus> | null = null;
  let stopped = false;
  let blocked = false;
  let restarting = false;
  let relaunchFailure = false;
  let shutdown: Promise<void> | null = null;
  function permitted(): boolean {
    try {
      options.assertNoStores();
      return true;
    } catch {
      return false;
    }
  }
  function status(): DataTransferStatus {
    const value: DataTransferStatus = current?.service.getStatus() ?? {
      operationId: null,
      action: null,
      state: 'recovery-required',
      code: 'recovery',
      message: '本地数据需要恢复。请选择备份；原件和失败现场将保留。',
      canCancel: false,
      canRecoverOriginal: false,
      availableActions: [],
    };
    return {
      ...value,
      ...(relaunchFailure
        ? {
            state: 'recovery-required' as const,
            code: 'relaunch' as const,
            message: '恢复已登记，但重新启动未完成，业务保持关闭，现场已保留',
          }
        : {}),
      canCancel: !stopped && !blocked && !relaunchFailure && value.canCancel,
      canRecoverOriginal: false,
      availableActions:
        !stopped && !blocked && !pending && !restarting && permitted() ? ['restore'] : [],
    };
  }
  function receipt(code: DataTransferStatus['code']): DataTransferStatus {
    return {
      ...status(),
      code,
      message: code === 'busy' ? '前次恢复尚未安全退出，不能开始新操作' : '恢复请求无效或已停止',
      canCancel: false,
    };
  }
  function check(context: TransferOperationContext): void {
    context.assertCurrent();
    options.assertNoStores();
    context.assertCurrent();
  }
  function makeService(): DataTransferService {
    // An empty participant list is safe only under the required main-owned proof.
    options.assertNoStores();
    const maintenance = new MaintenanceCoordinator([], async () => options.assertNoStores(), now);
    let shutdownAllowance: number | null = null;
    return new DataTransferService({
      now,
      timers: {
        set(ms, callback) {
          const timer = setTimeout(callback, Math.ceil(ms));
          return () => clearTimeout(timer);
        },
      },
      maintenance,
      async chooseNative(action) {
        options.assertNoStores();
        if (stopped || action !== 'restore') throw new Error('恢复模式不允许该操作');
        const selected = await options.chooseNative('restore');
        options.assertNoStores();
        return selected;
      },
      async confirmRestore(message) {
        options.assertNoStores();
        if (stopped) throw new Error('恢复入口已停止');
        const accepted = await options.confirmRestore(message);
        options.assertNoStores();
        return accepted;
      },
      async createScope(context) {
        check(context);
        const scope = await createDatasetScope(
          {
            userDataRoot: options.userDataRoot,
            operationId: context.job.operationId.replaceAll('-', ''),
            generation: context.generation,
            purpose: 'restore',
          },
          {
            check: () => check(context),
            requireRollbackSpace() {
              throw new Error('回退副本仅在启动健康检查前创建');
            },
          },
        );
        check(context);
        return scope;
      },
      requireSpace: (context) =>
        requireTransferSpace(options.userDataRoot, context.selection, () => check(context)),
      async run(context) {
        check(context);
        const result = await files.run(context);
        check(context);
        return result;
      },
      async verify(context, result) {
        check(context);
        const proof = await files.verify(context, result);
        check(context);
        return proof;
      },
      async publishBackup() {
        throw new Error('恢复模式不允许备份');
      },
      async registerHandoff(context, proof, budget) {
        check(context);
        if (
          !context.scope ||
          !context.ticket ||
          !maintenance.isQuiescent(context.ticket) ||
          !files.state(context.job.operationId).childrenExited
        )
          return false;
        const grant = reserveTransferHandoff(budget, now(), context.deadlineMonoMs);
        const assertRegistered = (): void => {
          check(context);
          if (
            now() >= grant.registrationDeadline ||
            !context.ticket ||
            !maintenance.isQuiescent(context.ticket) ||
            !files.state(context.job.operationId).childrenExited
          )
            throw new Error('恢复登记已停止');
        };
        const dataset: DatasetContext = {
          check: assertRegistered,
          requireRollbackSpace() {
            throw new Error('回退副本仅在启动健康检查前创建');
          },
        };
        const replacement = new DatasetReplacement(context.scope, {
          ...dataset,
          assertNoWriters: options.assertNoStores,
        });
        await replacement.prepare();
        assertRegistered();
        await replacement.archivePrevious();
        assertRegistered();
        await registerActiveDataset(context.scope);
        assertRegistered();
        await replacement.verifyActive();
        assertRegistered();
        const result = await new DatasetSwitch(context.scope, dataset).registerHandoff(
          proof.expected,
          grant.budget,
        );
        assertRegistered();
        if (result.state !== 'handoff') return false;
        shutdownAllowance = grant.shutdownAllowanceMs;
        return true;
      },
      async requestRelaunch(context) {
        check(context);
        if (shutdownAllowance === null) return false;
        const accepted = await options.requestRelaunch(
          Math.min(context.deadlineMonoMs, now() + shutdownAllowance),
        );
        if (accepted) restarting = true;
        check(context);
        return accepted;
      },
      originalState(context) {
        context.assertCurrent();
        return {
          childrenExited: files.state(context.job.operationId).childrenExited,
          originalDrainsSettled: !maintenance.status().pending,
          beforeSwitch: false,
        };
      },
      async verifyOriginal() {
        throw new Error('恢复模式不能开放原数据');
      },
      async recoverOriginal() {
        return false;
      },
    });
  }
  function retire(attempt: (typeof attempts)[number]): Promise<void> {
    attempt.drain ??= attempt.service.drainBeforeClose();
    return attempt.drain;
  }
  const api: RecoveryTransferRuntime = {
    getStatus: status,
    start(action, document) {
      if (action !== 'restore') return Promise.resolve(receipt('invalid-request'));
      if (stopped) return Promise.resolve(receipt('cancelled'));
      if (pending || blocked || restarting) return Promise.resolve(receipt('busy'));
      let done!: (value: DataTransferStatus) => void;
      const owned = new Promise<DataTransferStatus>((resolve) => {
        done = resolve;
      });
      // Publish before native choice or proof callbacks can synchronously re-enter.
      pending = owned;
      void (async () => {
        let rejected: DataTransferStatus['code'] | null = null;
        try {
          let live = false;
          try {
            live = document.isCurrent() === true;
          } catch {
            /* Reject stale documents. */
          }
          if (!live) {
            rejected = 'stale-document';
            return;
          }
          if (!permitted()) {
            rejected = 'recovery';
            return;
          }
          if (stopped) {
            rejected = 'cancelled';
            return;
          }
          relaunchFailure = false;
          const attempt = { service: makeService(), drain: null };
          attempts.push(attempt);
          current = attempt;
          if (stopped) attempt.service.beginShutdown();
          await attempt.service.start('restore', document);
          await retire(attempt);
        } catch {
          blocked = true;
        } finally {
          pending = null;
          done(rejected ? receipt(rejected) : status());
        }
      })();
      return owned;
    },
    cancel(operationId, document) {
      if (current && !stopped) current.service.cancel(operationId, document);
      return status();
    },
    relaunchFailed() {
      relaunchFailure = true;
      restarting = false;
    },
    beginShutdown() {
      if (stopped) return;
      stopped = true;
      for (const attempt of attempts) attempt.service.beginShutdown();
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
      void (async () => {
        if (pending) await pending;
        const results = await Promise.allSettled(attempts.map(retire));
        if (blocked || results.some((result) => result.status === 'rejected'))
          throw new Error('恢复工作尚未真实退出，现场已保留');
      })().then(resolve, reject);
      return shutdown;
    },
  };
  return api;
}
