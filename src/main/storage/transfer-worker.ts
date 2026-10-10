import { parseTransferRegistration, resolveRegisteredTransfer } from './transfer-registration';
import { createTransferWorkerController } from './transfer-worker-controller';
import { runTransferPipeline } from './transfer-pipeline';

// Fixed utility entry: no app bootstrap, settings, credentials or browser Session.
if (!process.parentPort || process.argv.length !== 3) process.exit(2);
const port = process.parentPort!;
try {
  const registration = parseTransferRegistration(process.argv[2]!);
  const controller = createTransferWorkerController(
    registration.job,
    {
      send: (value) => port.postMessage(value),
      exit: (code) => process.exit(code),
      scheduleExit: (callback) => {
        setTimeout(callback, 50);
      },
    },
    async ({ control, enterPhase }) => {
      const scope = await resolveRegisteredTransfer(registration);
      return runTransferPipeline({
        job: registration.job,
        scope,
        productVersion: registration.productVersion,
        selectedInput: registration.input,
        control,
        enterPhase,
        nowIso: new Date().toISOString(),
      });
    },
  );
  port.on('message', (event: { data: unknown }) => controller.receive(event.data));
} catch {
  process.exit(2);
}
