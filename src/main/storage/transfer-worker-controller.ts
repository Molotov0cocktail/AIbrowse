import { parseBoundedJson } from './bounded-json';
import { checkTransferControl, type OperationControl } from './backup-container';
import { TRANSFER_PHASE_MS, TRANSFER_WORK_MS } from './transfer-budget';
import { UTILITY_INIT_TIMEOUT_MS } from './utility-guardian-port';
import {
  createTransferProtocol,
  TRANSFER_ACTION_PHASES,
  type TransferIncoming,
  type TransferJobRecord,
  type TransferOutgoing,
  type TransferResult,
  type ValidationPhase,
} from './transfer-protocol';

export interface TransferWorkerPort {
  send(message: string): void;
  exit(code: number): void;
  scheduleExit(callback: () => void): void;
}
export interface TransferWorkerWork {
  control: OperationControl;
  enterPhase(phase: ValidationPhase): Promise<void>;
}

/** Utility-side peer. Main still owns the independent native-kill deadline. */
export function createTransferWorkerController(
  job: TransferJobRecord,
  port: TransferWorkerPort,
  work: (context: TransferWorkerWork) => Promise<TransferResult>,
): { receive(value: unknown): void } {
  const protocol = createTransferProtocol(job);
  const phases = TRANSFER_ACTION_PHASES[job.action];
  const abort = new AbortController();
  const totalDeadline = performance.now() + TRANSFER_WORK_MS;
  let phaseDeadline = totalDeadline;
  const control: OperationControl = {
    signal: abort.signal,
    get deadline() {
      return Math.min(totalDeadline, phaseDeadline);
    },
  };
  let initialized = false,
    stopped = false,
    completed = false,
    next = 0;
  let pending: { phase: ValidationPhase; resolve(): void; reject(error: Error): void } | null =
    null;
  const initDeadline = performance.now() + UTILITY_INIT_TIMEOUT_MS;
  const initTimer = setTimeout(stop, UTILITY_INIT_TIMEOUT_MS);
  initTimer.unref();
  function send(value: TransferIncoming): void {
    checkTransferControl(control);
    const raw = JSON.stringify(value);
    protocol.receive(raw);
    port.send(raw);
  }
  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(initTimer);
    abort.abort();
    const wait = pending;
    pending = null;
    wait?.reject(new Error('数据校验已停止'));
    port.exit(2);
  }
  async function enterPhase(phase: ValidationPhase): Promise<void> {
    checkTransferControl(control);
    if (stopped || completed || pending || phases[next] !== phase)
      throw new Error('数据校验阶段无效');
    await new Promise<void>((resolve, reject) => {
      pending = { phase, resolve, reject };
      try {
        send({ type: 'phase', operationId: job.operationId, phase });
      } catch {
        stop();
      }
    });
    checkTransferControl(control);
  }
  return {
    receive(value) {
      if (stopped) return;
      try {
        if (!initialized && performance.now() >= initDeadline) throw new Error('初始化许可超时');
        if (typeof value !== 'string' || value.length > 4096 || Buffer.byteLength(value) > 4096)
          throw new Error('通信超限');
        const parsed = parseBoundedJson(value, {
          bytes: 4096,
          depth: 4,
          nodes: 32,
        }) as TransferOutgoing;
        // Reuse exactly the main peer's closed frame schema and duplex ledger.
        protocol.send(parsed);
        checkTransferControl(control);
        if (parsed.type === 'cancel') {
          stop();
          return;
        }
        if (!initialized) {
          if (parsed.type !== 'init') throw new Error('缺少初始化');
          initialized = true;
          clearTimeout(initTimer);
          send({ type: 'ready', operationId: job.operationId });
          void Promise.resolve()
            .then(() => {
              checkTransferControl(control);
              return work({ control, enterPhase });
            })
            .then((result) => {
              if (stopped) return;
              if (pending || next !== phases.length) throw new Error('数据校验阶段未完成');
              send({ type: 'result', operationId: job.operationId, result });
              completed = true;
              port.scheduleExit(() => {
                if (stopped) return;
                try {
                  checkTransferControl(control);
                  stopped = true;
                  port.exit(0);
                } catch {
                  stop();
                }
              });
            })
            .catch(stop);
          return;
        }
        if (
          completed ||
          parsed.type !== 'phase' ||
          pending === null ||
          parsed.phase !== pending.phase
        )
          throw new Error('数据校验许可不符');
        const wait = pending;
        pending = null;
        phaseDeadline = Math.min(totalDeadline, performance.now() + TRANSFER_PHASE_MS[wait.phase]);
        next++;
        wait.resolve();
      } catch {
        stop();
      }
    },
  };
}
