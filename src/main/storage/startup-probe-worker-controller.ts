import { checkTransferControl, type OperationControl } from './backup-container';
import { createStartupProbeProtocol, type StartupProbeResult } from './startup-probe-protocol';
import type { TransferWorkerPort } from './transfer-worker-controller';
import { UTILITY_INIT_TIMEOUT_MS } from './utility-guardian-port';
export function createStartupProbeWorkerController(
  operationId: string,
  port: TransferWorkerPort,
  work: (control: OperationControl) => Promise<StartupProbeResult>,
): { receive(raw: unknown): void } {
  const protocol = createStartupProbeProtocol(operationId);
  const abort = new AbortController();
  let initialized = false,
    stopped = false,
    completed = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearTimeout(initTimer);
    abort.abort();
    port.exit(2);
  };
  const initDeadline = performance.now() + UTILITY_INIT_TIMEOUT_MS;
  const initTimer = setTimeout(stop, UTILITY_INIT_TIMEOUT_MS);
  initTimer.unref();
  return {
    receive(raw) {
      if (stopped) return;
      try {
        if (!initialized && performance.now() >= initDeadline) throw new Error('初始化许可超时');
        const message = protocol.read(raw);
        if (initialized || completed || message.type !== 'init')
          throw new Error('启动预检通信无效');
        initialized = true;
        clearTimeout(initTimer);
        const control: OperationControl = {
          signal: abort.signal,
          deadline: performance.now() + message.remainingMs,
        };
        port.send(protocol.write({ type: 'ready', operationId }));
        void Promise.resolve()
          .then(() => {
            checkTransferControl(control);
            return work(control);
          })
          .then((result) => {
            checkTransferControl(control);
            if (stopped) return;
            port.send(protocol.write({ type: 'result', operationId, result }));
            completed = true;
            port.scheduleExit(() => {
              if (stopped) return;
              try {
                checkTransferControl(control);
                port.exit(0);
              } catch {
                stop();
              }
            });
          })
          .catch(stop);
      } catch {
        stop();
      }
    },
  };
}
