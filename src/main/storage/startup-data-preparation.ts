import { randomUUID } from 'node:crypto';
import { createDatasetScope, type DatasetContext, type DatasetScope } from './dataset-layout';
import { registerActiveDataset } from './dataset-active';
import { DatasetSwitch } from './dataset-switch';
import { assertStartupProbeInputs } from './startup-probe';
import {
  parseStartupProbeRegistration,
  type StartupProbeRegistration,
} from './startup-probe-registration';
import {
  superviseStartupProbe,
  type StartupProbeSupervisorOptions,
} from './startup-probe-supervisor';
import { registerTransferWorker, type TransferRegistration } from './transfer-registration';
import {
  superviseTransfer,
  type TransferSupervisorHandle,
  type TransferSupervisorOptions,
} from './transfer-supervisor';
import { verifyPreparedTransferWork } from './transfer-files';
import { TransferBudget } from './transfer-budget';
import { reserveTransferHandoff, type HandoffGrant } from './transfer-handoff';
import type { UtilityGuardian } from './utility-guardian-port';

interface ProbeAdapter {
  spawn: StartupProbeSupervisorOptions['spawn'];
  ownsProcess(): boolean;
}
interface TransferAdapter {
  spawn: TransferSupervisorOptions['spawn'];
  ownsProcess(): boolean;
}
export interface StartupDataPreparationOptions {
  userDataRoot: string;
  productVersion: string;
  guardian: UtilityGuardian;
  /** The caller holds startup authority; no Store or business producer has opened. */
  assertNoStores(): void;
  requireSpace(check: () => void): Promise<void>;
  /** Record intent now, schedule normal shutdown on the next turn to avoid self-drain. */
  requestRelaunch(absoluteDeadline: number): Promise<boolean>;
  now?(): number;
  createProbeAdapter?(registration: StartupProbeRegistration): ProbeAdapter;
  createTransferAdapter?(registration: TransferRegistration): TransferAdapter;
}
export type StartupDataPreparationResult =
  | { state: 'normal' | 'awaiting-restart' }
  | { state: 'recovery-required'; code: 'startup-data'; message: string };
const failure = (): Error => new Error('启动数据准备未完成，原件和现场已保留');
const failed = (): StartupDataPreparationResult => ({
  state: 'recovery-required',
  code: 'startup-data',
  message: failure().message,
});

/** Main-only, single-use preparation. No renderer action can select migration. */
export function createStartupDataPreparation(options: StartupDataPreparationOptions) {
  const now = options.now ?? (() => performance.now());
  const abort = new AbortController();
  let started = false,
    closing = false,
    handedOff = false;
  let running: Promise<StartupDataPreparationResult> | null = null;
  let probeAdapter: ProbeAdapter | null = null;
  let transferAdapter: TransferAdapter | null = null;
  let probe: ReturnType<typeof superviseStartupProbe> | null = null;
  let transfer: TransferSupervisorHandle | null = null;
  const ownsChildren = (): boolean =>
    Boolean(
      probeAdapter?.ownsProcess() ||
      transferAdapter?.ownsProcess() ||
      probe?.ownsChild() ||
      transfer?.getState().ownsChild,
    );

  async function execute(
    budget: TransferBudget,
    absoluteDeadline: number,
  ): Promise<StartupDataPreparationResult> {
    let grant: HandoffGrant | null = null;
    const checkLocal = (): void => {
      if (!grant) budget.check();
      const instant = now();
      if (
        (closing && !handedOff) ||
        abort.signal.aborted ||
        !Number.isFinite(absoluteDeadline) ||
        !Number.isFinite(instant) ||
        instant < 0 ||
        instant >= absoluteDeadline ||
        (grant && !handedOff && instant >= grant.registrationDeadline)
      )
        throw failure();
    };
    const check = (): void => {
      checkLocal();
      options.assertNoStores();
      // A synchronous main proof may reenter shutdown or consume the deadline.
      checkLocal();
    };
    const step = async <T>(task: () => Promise<T>): Promise<T> => {
      check();
      const value = await task();
      check();
      return value;
    };
    const datasetContext: DatasetContext = {
      check,
      requireRollbackSpace() {
        throw new Error('迁移回退副本只允许交接后的启动阶段创建');
      },
    };
    try {
      check();
      const operationId = randomUUID();
      const registration = parseStartupProbeRegistration(
        JSON.stringify({ version: 1, operationId, userDataRoot: options.userDataRoot }),
      );
      const probeFactory =
        options.createProbeAdapter ??
        (await step(async () => {
          const { createElectronStartupProbe } = await import('./startup-probe-electron');
          return (value: StartupProbeRegistration) =>
            createElectronStartupProbe(value, options.guardian);
        }));
      check();
      probeAdapter = probeFactory(registration);
      check();
      probe = superviseStartupProbe({
        operationId,
        budget,
        signal: abort.signal,
        spawn: probeAdapter.spawn,
      });
      const inspected = await step(() => probe!.done);
      if (
        inspected.state !== 'succeeded' ||
        ownsChildren() ||
        inspected.result.state === 'recovery-required'
      )
        throw failure();
      const inputs = inspected.result;
      await step(() => assertStartupProbeInputs(options.userDataRoot, inputs, check));
      if (inputs.state === 'normal') return { state: 'normal' };

      budget.enter('containerIo');
      await step(() => options.requireSpace(check));
      const job = Object.freeze({
        action: 'migrate' as const,
        operationId: randomUUID(),
        snapshotId: randomUUID(),
      });
      const scope: DatasetScope = await step(() =>
        createDatasetScope(
          {
            userDataRoot: options.userDataRoot,
            operationId: job.operationId.replaceAll('-', ''),
            generation: randomUUID().replaceAll('-', ''),
            purpose: 'migrate',
          },
          datasetContext,
        ),
      );
      const worker = await step(() => registerTransferWorker(scope, job, options.productVersion));
      const transferFactory =
        options.createTransferAdapter ??
        (await step(async () => {
          const { createElectronTransfer } = await import('./transfer-electron');
          return (value: TransferRegistration) => createElectronTransfer(value, options.guardian);
        }));
      await step(() => assertStartupProbeInputs(options.userDataRoot, inputs, check));
      check();
      transferAdapter = transferFactory(worker);
      check();
      transfer = superviseTransfer({
        job,
        budget,
        signal: abort.signal,
        spawn: transferAdapter.spawn,
      });
      const migrated = await step(() => transfer!.done);
      if (migrated.state !== 'succeeded' || ownsChildren()) throw failure();
      await step(() => assertStartupProbeInputs(options.userDataRoot, inputs, check));
      const expected = await step(() =>
        verifyPreparedTransferWork(
          { job, scope, budget, signal: abort.signal, assertCurrent: check },
          migrated.result,
        ),
      );
      check();
      grant = reserveTransferHandoff(budget.suspend(), now(), absoluteDeadline);
      check();
      await step(() => registerActiveDataset(scope));
      const handoff = await step(() =>
        new DatasetSwitch(scope, datasetContext).registerHandoff(expected, grant!.budget),
      );
      if (handoff.state !== 'handoff') throw failure();
      handedOff = true;
      const exitDeadline = Math.min(absoluteDeadline, now() + grant.shutdownAllowanceMs);
      if (!(await step(() => options.requestRelaunch(exitDeadline))) || now() >= exitDeadline)
        throw failure();
      return { state: 'awaiting-restart' };
    } catch {
      return failed();
    }
  }
  return {
    ownsDataProcess: ownsChildren,
    prepare(input: {
      budget: TransferBudget;
      absoluteDeadline: number;
    }): Promise<StartupDataPreparationResult> {
      if (started || closing) return Promise.resolve(failed());
      started = true;
      // Retain ownership before a caller port can synchronously request shutdown.
      running = Promise.resolve().then(() => execute(input.budget, input.absoluteDeadline));
      return running;
    },
    beginShutdown(): void {
      closing = true;
      if (!handedOff) {
        abort.abort();
        probe?.cancel();
        transfer?.cancel();
      }
    },
    async drainBeforeClose(): Promise<void> {
      await running;
      if (ownsChildren()) throw failure();
    },
  };
}
