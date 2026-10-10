import { utilityProcess } from 'electron';
import { join } from 'node:path';
import type { TransferOperationContext } from '../../../src/main/storage/data-transfer-service';
import {
  registerTransferWorker,
  registeredTransferDirectory,
} from '../../../src/main/storage/transfer-registration';
import {
  createGuardedUtilityPort,
  type UtilityGuardian,
} from '../../../src/main/storage/utility-guardian-port';
import { superviseCounts, type Counts } from './counts';
import { need } from './contract';

// Unknown native ownership is retained for the lifetime of this qualification main.
const retained = new Set<ReturnType<typeof createGuardedUtilityPort>>();
export async function countPreparedWork(
  context: TransferOperationContext,
  guardian: UtilityGuardian,
  productVersion: string,
): Promise<Counts> {
  const start = performance.now();
  context.budget.enter('sqlite');
  context.assertCurrent();
  need(context.scope);
  const deadline = Math.min(
    start + 10000,
    context.deadlineMonoMs,
    start + context.budget.remainingMs(),
  );
  const registration = await registerTransferWorker(
    context.scope,
    context.job,
    productVersion,
    context.selection.action === 'restore' ? context.selection.input.path : undefined,
  );
  context.assertCurrent();
  need(performance.now() < deadline);
  return superviseCounts({
    context,
    deadline,
    spawn(events) {
      const child = utilityProcess.fork(
        join(__dirname, 'counts-worker.js'),
        [JSON.stringify(registration)],
        {
          cwd: registeredTransferDirectory(registration),
          serviceName: 'AIbrowse 容量计数资格',
          execArgv: [],
          stdio: 'ignore',
          env: {
            SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
            TEMP: registeredTransferDirectory(registration),
            TMP: registeredTransferDirectory(registration),
          },
        },
      );
      let released = false;
      let port: ReturnType<typeof createGuardedUtilityPort> | null = null;
      port = createGuardedUtilityPort(child, guardian, 'transfer', events, () => {
        released = true;
        if (port) retained.delete(port);
      });
      if (!released) retained.add(port);
      return port;
    },
  });
}
