import { parseStartupProbeRegistration } from './startup-probe-registration';
import { createStartupProbeWorkerController } from './startup-probe-worker-controller';
import { runStartupProbe } from './startup-probe';
// Fixed utility entry; it never initializes Stores, browser sessions or settings.
if (!process.parentPort || process.argv.length !== 3) process.exit(2);
const port = process.parentPort!;
try {
  const registration = parseStartupProbeRegistration(process.argv[2]!);
  const controller = createStartupProbeWorkerController(
    registration.operationId,
    {
      send: (value) => port.postMessage(value),
      exit: (code) => process.exit(code),
      scheduleExit: (callback) => {
        setTimeout(callback, 50);
      },
    },
    (control) => runStartupProbe(registration.userDataRoot, control),
  );
  port.on('message', (event: { data: unknown }) => controller.receive(event.data));
} catch {
  process.exit(2);
}
