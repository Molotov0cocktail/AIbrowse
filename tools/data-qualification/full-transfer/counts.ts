import type { TransferOperationContext } from '../../../src/main/storage/data-transfer-service';
import type {
  OwnedTransferChild,
  TransferChildEvents,
} from '../../../src/main/storage/transfer-supervisor';
import { need } from './contract';
export const EXPECTED_COUNTS = Object.freeze({
  sources: 5000,
  research: 30,
  rules: 200,
  events: 2800,
  evidence: 8400,
  digests: 1030,
});
export type Counts = typeof EXPECTED_COUNTS;
function countsFailure(code: 'counts' | 'counts-exit' | 'counts-start' | 'counts-budget'): Error {
  return Object.assign(new Error('固定计数资格失败'), { code });
}
export function parseCounts(value: unknown): Counts {
  need(value && typeof value === 'object' && !Array.isArray(value));
  need(Object.keys(value).sort().join('|') === Object.keys(EXPECTED_COUNTS).sort().join('|'));
  for (const key of Object.keys(EXPECTED_COUNTS) as (keyof Counts)[])
    need(Object.hasOwn(value, key) && (value as Counts)[key] === EXPECTED_COUNTS[key]);
  return Object.freeze({ ...(value as Counts) });
}
export interface CountsOptions {
  context: TransferOperationContext;
  deadline: number;
  spawn(events: TransferChildEvents): OwnedTransferChild;
  now?: () => number;
}
export function superviseCounts(options: CountsOptions): Promise<Counts> {
  return new Promise((resolve, reject) => {
    const now = options.now ?? (() => performance.now());
    let child: OwnedTransferChild | null = null,
      result: Counts | null = null;
    let exited = false,
      exitCode: number | null = null,
      failed = false,
      finished = false,
      killRequested = false;
    let workTimer: ReturnType<typeof setTimeout> | undefined,
      exitTimer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      options.context.assertCurrent();
      options.context.budget.check();
      need(
        !options.context.signal.aborted &&
          now() < options.deadline &&
          now() < options.context.deadlineMonoMs,
      );
    };
    const finish = () => {
      if (finished || !exited || !child) return;
      finished = true;
      clearTimeout(workTimer);
      clearTimeout(exitTimer);
      options.context.signal.removeEventListener('abort', fail);
      try {
        child.disposeListeners();
        check();
        if (failed || exitCode !== 0 || result === null) throw new Error('计数utility未通过');
        resolve(result);
      } catch {
        reject(
          countsFailure(failed || exitCode !== 0 || result === null ? 'counts' : 'counts-budget'),
        );
      }
    };
    const kill = () => {
      if (child && !exited && !killRequested) {
        killRequested = true;
        try {
          child.kill();
        } catch {
          /* Unknown ownership remains retained until original exit. */
        }
      }
    };
    function fail(): void {
      if (finished) return;
      failed = true;
      clearTimeout(workTimer);
      kill();
      if (!exitTimer && !exited)
        exitTimer = setTimeout(() => {
          finished = true;
          options.context.signal.removeEventListener('abort', fail);
          reject(countsFailure('counts-exit'));
        }, 10000);
      finish();
    }
    try {
      options.context.budget.enter('sqlite');
      check();
      const remaining = Math.min(
        options.deadline - now(),
        options.context.deadlineMonoMs - now(),
        options.context.budget.remainingMs(),
      );
      need(remaining > 0 && remaining <= 10000);
      workTimer = setTimeout(fail, remaining);
      options.context.signal.addEventListener('abort', fail, { once: true });
      child = options.spawn({
        onMessage(raw) {
          if (finished || failed) return;
          try {
            check();
            need(
              !exited &&
                result === null &&
                typeof raw === 'string' &&
                Buffer.byteLength(raw) <= 1024,
            );
            const frame = JSON.parse(raw) as {
              version: unknown;
              operationId: unknown;
              counts: unknown;
            };
            need(
              frame &&
                typeof frame === 'object' &&
                Object.keys(frame).sort().join('|') === 'counts|operationId|version' &&
                frame.version === 1 &&
                frame.operationId === options.context.job.operationId,
            );
            result = parseCounts(frame.counts);
          } catch {
            fail();
          }
        },
        onExit(code) {
          if (exited) return;
          exited = true;
          exitCode = code;
          finish();
        },
      });
      if (failed) kill();
      if (exited) finish();
      else if (!failed) {
        check();
        child.postMessage(
          JSON.stringify({
            version: 1,
            operationId: options.context.job.operationId,
            remainingMs: Math.min(
              remaining,
              options.deadline - now(),
              options.context.budget.remainingMs(),
            ),
          }),
        );
      }
    } catch {
      if (child) fail();
      else {
        finished = true;
        clearTimeout(workTimer);
        clearTimeout(exitTimer);
        options.context.signal.removeEventListener('abort', fail);
        reject(countsFailure('counts-start'));
      }
    }
  });
}
