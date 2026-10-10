import type { UtilityProcess } from 'electron';
import type { LifecycleGuardianHandle } from './lifecycle-guardian';

export type UtilityGuardian = Pick<
  LifecycleGuardianHandle,
  'authorizeUtility' | 'confirmUtilityExit'
>;

export const UTILITY_INIT_TIMEOUT_MS = 10_000;

/** A child receives no data capability before durable registration acknowledgement. */
export function createGuardedUtilityPort(
  child: UtilityProcess,
  guardian: UtilityGuardian,
  role: 'probe' | 'transfer',
  events: { onMessage(value: unknown): void; onExit(code: number): void },
  released: () => void,
) {
  let exited = false,
    retired = false,
    revoked = false,
    authorized = false;
  let queued: string | null = null;
  let pid: number | null = null;
  let authorization: Promise<void> | null = null;
  const fail = (): void => {
    revoked = true;
    queued = null;
    events.onMessage(null);
  };
  const spawn = (): void => {
    if (exited || revoked || authorization) return;
    const nativePid = child.pid;
    if (!Number.isSafeInteger(nativePid) || !nativePid || nativePid < 1) {
      fail();
      return;
    }
    pid = nativePid;
    // Publish the retained wait before native registration can synchronously emit exit.
    let resolveAuthorization!: () => void;
    let rejectAuthorization!: (error: unknown) => void;
    authorization = new Promise<void>((resolve, reject) => {
      resolveAuthorization = resolve;
      rejectAuthorization = reject;
    });
    try {
      void guardian.authorizeUtility({ pid, role }).then(resolveAuthorization, rejectAuthorization);
    } catch {
      rejectAuthorization(new Error('数据进程登记失败'));
    }
    void authorization.then(() => {
      if (exited || revoked) return;
      authorized = true;
      if (queued !== null) {
        const init = queued;
        queued = null;
        try {
          child.postMessage(init);
        } catch {
          fail();
        }
      }
    }, fail);
  };
  const message = (value: unknown): void => {
    if (!authorized || revoked || exited) {
      fail();
      return;
    }
    events.onMessage(value);
  };
  const error = (): void => fail();
  const exit = (code: number): void => {
    if (exited) return;
    exited = true;
    revoked = true;
    queued = null;
    void (async () => {
      if (authorization) {
        // An exit can precede the durable ACK. Retire only after that request settles.
        try {
          await authorization;
        } catch {
          /* The native channel remains fail-closed. */
        }
        if (pid === null) throw new Error('数据进程身份不可用');
        await guardian.confirmUtilityExit(pid);
      }
      // No request was sent when a child exited before spawn: it never received init.
      retired = true;
      released();
      events.onExit(code);
    })().catch(fail);
  };
  // Attach synchronously before the supervisor can enqueue init or cancel.
  try {
    child.on('exit', exit);
    child.on('message', message);
    child.on('error', error);
    child.on('spawn', spawn);
  } catch {
    fail();
  }
  return {
    postMessage(value: string) {
      if (exited || revoked) throw new Error('数据进程入口已关闭');
      if (!authorized) {
        if (queued !== null || typeof value !== 'string' || Buffer.byteLength(value) > 4096)
          throw new Error('数据进程登记尚未完成');
        queued = value;
        return;
      }
      child.postMessage(value);
    },
    kill() {
      revoked = true;
      queued = null;
      return exited ? false : child.kill();
    },
    disposeListeners() {
      if (!retired) throw new Error('数据进程退出和账本退休尚未确认');
      child.removeListener('message', message);
      child.removeListener('error', error);
      child.removeListener('exit', exit);
      child.removeListener('spawn', spawn);
    },
  };
}
