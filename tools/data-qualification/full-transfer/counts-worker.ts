import { join } from 'node:path';
import {
  parseTransferRegistration,
  resolveRegisteredTransfer,
} from '../../../src/main/storage/transfer-registration';
import { createCountsController, readCounts } from './counts-worker-core';
if (!process.parentPort || process.argv.length !== 3) process.exit(2);
const port = process.parentPort!;
try {
  const registration = parseTransferRegistration(process.argv[2]);
  const controller = createCountsController(registration.job.operationId, {
    async work(check) {
      check();
      const scope = await resolveRegisteredTransfer(registration);
      check();
      return readCounts(join(scope.operationRoot, 'work'), check);
    },
    send: (value) => port.postMessage(value),
    exit: (code) => process.exit(code),
  });
  port.on('message', (event: { data: unknown }) => controller.receive(event.data));
} catch {
  process.exit(2);
}
