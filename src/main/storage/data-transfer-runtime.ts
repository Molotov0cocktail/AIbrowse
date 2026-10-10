import type { DataTransferStatus } from '../../shared/types/data-transfer';
import {
  DataTransferService,
  type DataTransferPorts,
  type OriginalRecoveryContext,
  type OriginalTransferState,
} from './data-transfer-service';
import { createDatasetScope, type DatasetContext } from './dataset-layout';
import { registerActiveDataset } from './dataset-active';
import { DatasetSwitch } from './dataset-switch';
import { createTransferFiles } from './transfer-files';
import { reserveTransferHandoff } from './transfer-handoff';
import type { MaintenanceCoordinator } from './maintenance-coordinator';
import { requireTransferSpace } from './transfer-space';
import type { UtilityGuardian } from './utility-guardian-port';

export interface DataTransferRuntimeOptions {
  userDataRoot: string;
  productVersion: string;
  guardian: UtilityGuardian;
  maintenance: MaintenanceCoordinator;
  /** Exact captured Store/Service references, independent of paused admission. */
  isDatasetCurrent(): boolean;
  chooseNative: DataTransferPorts['chooseNative'];
  confirmRestore: DataTransferPorts['confirmRestore'];
  /** Register intent now; begin shutdown on the next turn after Service settles. */
  requestRelaunch(deadlineMonoMs: number): Promise<boolean>;
}

/** Owns the live-generation and maintenance-record bindings across recovery attempts. */
export function createDataTransferRuntime(options: DataTransferRuntimeOptions): {
  service: DataTransferService;
  getStatus(): DataTransferStatus;
  relaunchFailed(): void;
} {
  const now = (): number => performance.now();
  const files = createTransferFiles({
    productVersion: options.productVersion,
    guardian: options.guardian,
  });
  const { maintenance } = options;
  const owners = new Map<string, { generation: string; maintenanceId: string | null }>();
  const handoffs = new Map<string, { shutdownAllowanceMs: number }>();
  let relaunchFailure = false;
  function originalState(context: OriginalRecoveryContext): OriginalTransferState {
    context.assertCurrent();
    const owner = owners.get(context.job.operationId);
    const status = maintenance.status();
    if (!owner || owner.generation !== context.generation || !options.isDatasetCurrent())
      throw new Error('原数据世代不可验证');
    if (owner.maintenanceId === null && context.maintenanceOperationId !== null) {
      if (context.maintenanceOperationId !== status.operationId)
        throw new Error('原维护记录不匹配');
      owner.maintenanceId = context.maintenanceOperationId;
    }
    return {
      childrenExited: files.state(context.job.operationId).childrenExited,
      originalDrainsSettled:
        owner.maintenanceId !== null &&
        status.operationId === owner.maintenanceId &&
        !status.pending,
      beforeSwitch: !handoffs.has(context.job.operationId),
    };
  }
  const service = new DataTransferService({
    now,
    timers: {
      set(ms, callback) {
        const timer = setTimeout(callback, Math.ceil(ms));
        return () => clearTimeout(timer);
      },
    },
    maintenance,
    chooseNative: options.chooseNative,
    confirmRestore: options.confirmRestore,
    async createScope(context) {
      context.assertCurrent();
      if (!options.isDatasetCurrent()) throw new Error('数据服务已变化');
      owners.set(context.job.operationId, { generation: context.generation, maintenanceId: null });
      const scope = await createDatasetScope(
        {
          userDataRoot: options.userDataRoot,
          operationId: context.job.operationId.replaceAll('-', ''),
          generation: context.generation,
          purpose: context.job.action,
        },
        {
          check: () => context.assertCurrent(),
          requireRollbackSpace() {
            throw new Error('活库仍打开，不能创建回退副本');
          },
        },
      );
      context.assertCurrent();
      return scope;
    },
    requireSpace: (context) =>
      requireTransferSpace(options.userDataRoot, context.selection, () => context.assertCurrent()),
    run: files.run,
    verify: files.verify,
    publishBackup: files.publishBackup,
    async registerHandoff(context, proof, budget) {
      context.assertCurrent();
      if (!context.scope || !context.ticket || !maintenance.isQuiescent(context.ticket))
        return false;
      const grant = reserveTransferHandoff(budget, now(), context.deadlineMonoMs);
      const check = (): void => {
        context.assertCurrent();
        if (
          now() >= grant.registrationDeadline ||
          !options.isDatasetCurrent() ||
          !context.ticket ||
          !maintenance.isQuiescent(context.ticket)
        )
          throw new Error('恢复登记已停止');
      };
      const datasetContext: DatasetContext = {
        check,
        requireRollbackSpace() {
          throw new Error('回退副本只允许在关闭句柄后的启动阶段创建');
        },
      };
      // From this point, even a partial metadata write requires startup recovery.
      handoffs.set(context.job.operationId, { shutdownAllowanceMs: grant.shutdownAllowanceMs });
      await registerActiveDataset(context.scope);
      check();
      const result = await new DatasetSwitch(context.scope, datasetContext).registerHandoff(
        proof.expected,
        grant.budget,
      );
      check();
      return result.state === 'handoff';
    },
    async requestRelaunch(context) {
      context.assertCurrent();
      const handoff = handoffs.get(context.job.operationId);
      if (!handoff) return false;
      return options.requestRelaunch(
        Math.min(context.deadlineMonoMs, now() + handoff.shutdownAllowanceMs),
      );
    },
    originalState,
    async verifyOriginal(context) {
      const state = originalState(context);
      return {
        ...state,
        operationId: context.job.operationId,
        sameData: options.isDatasetCurrent(),
      };
    },
    async recoverOriginal(context, proof) {
      const state = originalState(context);
      const owner = owners.get(context.job.operationId);
      if (
        !owner?.maintenanceId ||
        proof.operationId !== context.job.operationId ||
        !proof.sameData ||
        !state.childrenExited ||
        !state.originalDrainsSettled ||
        !state.beforeSwitch
      )
        return false;
      const pending = maintenance.recoverOriginal({
        operationId: owner.maintenanceId,
        originalAbsoluteDeadline: context.deadlineMonoMs,
        isCurrent: () => {
          context.assertCurrent();
          return (
            options.isDatasetCurrent() &&
            files.state(context.job.operationId).childrenExited &&
            !handoffs.has(context.job.operationId)
          );
        },
      });
      // begin() publishes its fresh record synchronously, before any drain await.
      // Only this owned call may advance the mapping; never adopt an unrelated record.
      const recoveryId = maintenance.status().operationId;
      if (recoveryId !== null) owner.maintenanceId = recoveryId;
      const result = await pending;
      context.assertCurrent();
      return result.ok && options.isDatasetCurrent();
    },
  });
  return {
    service,
    relaunchFailed() {
      relaunchFailure = true;
    },
    getStatus() {
      const status = service.getStatus();
      if (relaunchFailure)
        return {
          ...status,
          state: 'recovery-required',
          code: 'relaunch',
          message: '恢复已登记，但关闭或重启未完成，数据业务保持关闭，现场已保留',
          canCancel: false,
          canRecoverOriginal: false,
          availableActions: [],
        };
      if (
        status.operationId !== null &&
        files.state(status.operationId).publication !== 'none' &&
        status.state !== 'completed'
      )
        return { ...status, message: '备份目标已创建，后续维护未完成，现场已保留' };
      return status;
    },
  };
}
