import { MaintenanceAdmission } from './maintenance-admission';
import { MaintenanceCoordinator, type MaintenanceParticipant } from './maintenance-coordinator';
import type { SourceServiceImpl } from '../sources/source-service';
import type { SourceUsageTracker } from '../sources/usage/usage-tracker';
import type { WatchLifecycleCoordinator } from '../watch/watch-lifecycle-coordinator';
import type { WatchTaskTabWorkspace } from '../watch/watch-task-tab-workspace';

export const MAINTENANCE_UNAVAILABLE_MESSAGE = '数据维护期间暂不可执行此操作';

/** Register before calling work, including its first synchronous continuation. */
export async function runWithMaintenanceAdmission<T>(
  admission: MaintenanceAdmission,
  work: (isCurrent: () => boolean) => T | Promise<T>,
  isOwnerCurrent: () => boolean = () => true,
): Promise<T> {
  if (!isOwnerCurrent()) throw new Error(MAINTENANCE_UNAVAILABLE_MESSAGE);
  const release = admission.enter();
  if (release === null) throw new Error(MAINTENANCE_UNAVAILABLE_MESSAGE);
  const epoch = admission.captureEpoch();
  try {
    return await work(() => admission.isCurrent(epoch) && isOwnerCurrent());
  } finally {
    release();
  }
}

type SealedSource = Pick<
  SourceServiceImpl,
  | 'sealForMaintenance'
  | 'getSourceWatchProjectionForMaintenance'
  | 'prepareResumeAfterMaintenance'
  | 'resumeAfterMaintenance'
>;

export interface RuntimeMaintenanceOptions {
  readonly rootAdmission: MaintenanceAdmission;
  readonly sourceIpcAdmission: MaintenanceParticipant;
  readonly researchIpcAdmission: MaintenanceParticipant;
  readonly watchIpcAdmission: MaintenanceParticipant;
  readonly conversation: MaintenanceParticipant;
  readonly research: MaintenanceParticipant;
  readonly watch: MaintenanceParticipant;
  readonly digest: MaintenanceParticipant;
  readonly preview: MaintenanceParticipant;
  readonly exporter: MaintenanceParticipant;
  readonly notifications: MaintenanceParticipant;
  readonly windowsNotifications: MaintenanceParticipant | null;
  readonly sources: SealedSource;
  readonly usage: Pick<SourceUsageTracker, 'waitForIdle'>;
  readonly workspace: Pick<WatchTaskTabWorkspace, 'cleanupAll'>;
  readonly lifecycle: Pick<WatchLifecycleCoordinator, 'reconcileForMaintenance'>;
  readonly now?: () => number;
}

/** Same-data-generation assembly only: never closes, reopens or replaces a store. */
export function createRuntimeMaintenance(
  options: RuntimeMaintenanceOptions,
): MaintenanceCoordinator {
  // Capture this complete dataset once. Caller-held variables cannot redirect old work.
  const { sources, usage, workspace, lifecycle } = options;
  let sealedGeneration: number | null = null;
  const lateSource: MaintenanceParticipant = {
    // Source internal calls remain available for accepted producers and usage tails.
    pauseForMaintenance: () => true,
    drainForMaintenance: async () => undefined,
    prepareResumeAfterMaintenance: (generation) =>
      sealedGeneration === generation && sources.prepareResumeAfterMaintenance(generation),
    resumeAfterMaintenance: (generation) => {
      if (sealedGeneration !== generation || !sources.resumeAfterMaintenance(generation))
        return false;
      sealedGeneration = null;
      return true;
    },
  };
  const participants: MaintenanceParticipant[] = [
    // Resume Source before any scheduler owner; root admission reopens last.
    lateSource,
    options.conversation,
    options.research,
    options.preview,
    options.exporter,
    options.notifications,
    ...(options.windowsNotifications === null ? [] : [options.windowsNotifications]),
    options.watch,
    options.digest,
    options.sourceIpcAdmission,
    options.researchIpcAdmission,
    options.watchIpcAdmission,
    options.rootAdmission,
  ];
  const coordinator = new MaintenanceCoordinator(
    participants,
    async (ticket) => {
      coordinator.assertCurrentDraining(ticket);
      await usage.waitForIdle();
      coordinator.assertCurrentDraining(ticket);
      const cleanup = await workspace.cleanupAll();
      coordinator.assertCurrentDraining(ticket);
      if (!cleanup.ok || cleanup.retainedCount !== 0)
        throw new Error('维护期间任务标签页未全部释放');
      if (!sources.sealForMaintenance(ticket.generation)) throw new Error('维护期间信源封闭失败');
      sealedGeneration = ticket.generation;
      coordinator.assertCurrentDraining(ticket);
      const reconciliation = lifecycle.reconcileForMaintenance((id) =>
        sources.getSourceWatchProjectionForMaintenance(id, ticket.generation),
      );
      if (!reconciliation.ok) throw new Error('维护期间信源与监控协调失败');
      coordinator.assertCurrentDraining(ticket);
    },
    options.now,
  );
  return coordinator;
}
