import { utilityProcess } from 'electron';
import { createGuardedUtilityPort, type UtilityGuardian } from './utility-guardian-port';
import { join } from 'node:path';
import {
  parseTransferRegistration,
  registeredTransferDirectory,
  type TransferRegistration,
} from './transfer-registration';
import type { TransferSupervisorOptions } from './transfer-supervisor';

/** One registration owns one launch and its exact native handle until actual exit. */
export function createElectronTransfer(
  registration: TransferRegistration,
  guardian: UtilityGuardian,
): {
  spawn: TransferSupervisorOptions['spawn'];
  ownsProcess(): boolean;
} {
  const frozen = parseTransferRegistration(JSON.stringify(registration));
  const bootstrap = JSON.stringify(frozen);
  let attempted = false;
  let owned = false;
  return {
    ownsProcess: () => owned,
    spawn(job, events) {
      if (
        attempted ||
        job.operationId !== frozen.job.operationId ||
        job.snapshotId !== frozen.job.snapshotId ||
        job.action !== frozen.job.action
      )
        throw new Error('数据维护进程已登记或世代不符');
      attempted = true;
      owned = true;
      const child = utilityProcess.fork(join(__dirname, 'transfer-worker.js'), [bootstrap], {
        cwd: registeredTransferDirectory(frozen),
        serviceName: 'AIbrowse 数据校验',
        execArgv: [],
        stdio: 'ignore',
        env: {
          SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
          TEMP: registeredTransferDirectory(frozen),
          TMP: registeredTransferDirectory(frozen),
        },
      });
      return createGuardedUtilityPort(child, guardian, 'transfer', events, () => {
        owned = false;
      });
    },
  };
}
