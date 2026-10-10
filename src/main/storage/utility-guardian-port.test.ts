import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: mocks.fork } }));
import { createElectronStartupProbe } from './startup-probe-electron';
import { createElectronTransfer } from './transfer-electron';
import type { LifecycleGuardianHandle } from './lifecycle-guardian';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class Child extends EventEmitter {
  pid = 123;
  postMessage = vi.fn();
  kill = vi.fn(() => true);
}
function fixture(role: 'probe' | 'transfer') {
  const authorization = deferred(),
    retirement = deferred(),
    child = new Child();
  const guardian: Pick<LifecycleGuardianHandle, 'authorizeUtility' | 'confirmUtilityExit'> = {
    authorizeUtility: vi.fn(() => authorization.promise),
    confirmUtilityExit: vi.fn(() => retirement.promise),
  };
  mocks.fork.mockReturnValue(child);
  const operationId = randomUUID();
  const job = { operationId, snapshotId: randomUUID(), action: 'backup' as const };
  const events = { onMessage: vi.fn(), onExit: vi.fn() };
  const adapter =
    role === 'probe'
      ? createElectronStartupProbe(
          { version: 1, operationId, userDataRoot: process.cwd() },
          guardian,
        )
      : createElectronTransfer(
          {
            version: 1,
            userDataRoot: process.cwd(),
            generation: 'a'.repeat(32),
            productVersion: '0.1.0',
            input: null,
            job,
          },
          guardian,
        );
  const port =
    role === 'probe'
      ? (adapter as ReturnType<typeof createElectronStartupProbe>).spawn(operationId, events)
      : (adapter as ReturnType<typeof createElectronTransfer>).spawn(job, events);
  return { child, guardian, authorization, retirement, adapter, port, events };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

it.each(['probe', 'transfer'] as const)(
  '%s 无PID的子进程从未获init，真实exit后可释放且不伪造退休请求',
  async (role) => {
    const f = fixture(role);
    f.child.pid = 0;
    f.port.postMessage('init');
    f.child.emit('spawn');
    expect(f.events.onMessage).toHaveBeenCalledWith(null);
    expect(f.guardian.authorizeUtility).not.toHaveBeenCalled();
    expect(f.child.postMessage).not.toHaveBeenCalled();
    f.child.emit('exit', 2);
    await flush();
    expect(f.adapter.ownsProcess()).toBe(false);
    expect(f.guardian.confirmUtilityExit).not.toHaveBeenCalled();
    expect(f.events.onExit).toHaveBeenCalledExactlyOnceWith(2);
  },
);

it.each(['probe', 'transfer'] as const)(
  '%s 同步授权throw仍保留到实际exit和退休ACK，零迟到init',
  async (role) => {
    const f = fixture(role);
    vi.mocked(f.guardian.authorizeUtility).mockImplementation(() => {
      throw new Error('private');
    });
    f.port.postMessage('init');
    f.child.emit('spawn');
    await flush();
    expect(f.adapter.ownsProcess()).toBe(true);
    expect(f.child.postMessage).not.toHaveBeenCalled();
    expect(f.events.onMessage).toHaveBeenCalledWith(null);
    f.child.emit('exit', 2);
    await flush();
    expect(f.guardian.confirmUtilityExit).toHaveBeenCalledExactlyOnceWith(123);
    expect(f.events.onExit).not.toHaveBeenCalled();
    f.retirement.resolve();
    await flush();
    expect(f.adapter.ownsProcess()).toBe(false);
    expect(f.events.onExit).toHaveBeenCalledExactlyOnceWith(2);
  },
);

it.each(['probe', 'transfer'] as const)(
  '%s kill同步触发exit仍等待授权ACK且重复spawn/exit不重复退休',
  async (role) => {
    const f = fixture(role);
    f.port.postMessage('init');
    f.child.emit('spawn');
    f.child.emit('spawn');
    f.child.kill.mockImplementation(() => {
      f.child.emit('exit', 2);
      return true;
    });
    expect(f.port.kill()).toBe(true);
    f.child.emit('exit', 0);
    await flush();
    expect(f.guardian.authorizeUtility).toHaveBeenCalledOnce();
    expect(f.guardian.confirmUtilityExit).not.toHaveBeenCalled();
    f.authorization.resolve();
    await flush();
    expect(f.child.postMessage).not.toHaveBeenCalled();
    expect(f.guardian.confirmUtilityExit).toHaveBeenCalledOnce();
    f.retirement.resolve();
    await flush();
    expect(f.events.onExit).toHaveBeenCalledExactlyOnceWith(2);
    expect(() => f.port.postMessage('late')).toThrow();
  },
);

it.each(['probe', 'transfer'] as const)(
  '%s 授权调用同步重入exit也必须等原授权和退休ACK',
  async (role) => {
    const f = fixture(role);
    vi.mocked(f.guardian.authorizeUtility).mockImplementation(() => {
      f.child.emit('exit', 2);
      return f.authorization.promise;
    });
    f.port.postMessage('init');
    f.child.emit('spawn');
    await flush();
    expect(f.adapter.ownsProcess()).toBe(true);
    expect(f.events.onExit).not.toHaveBeenCalled();
    expect(f.guardian.confirmUtilityExit).not.toHaveBeenCalled();
    f.authorization.resolve();
    await flush();
    expect(f.child.postMessage).not.toHaveBeenCalled();
    expect(f.guardian.confirmUtilityExit).toHaveBeenCalledExactlyOnceWith(123);
    f.retirement.resolve();
    await flush();
    expect(f.events.onExit).toHaveBeenCalledExactlyOnceWith(2);
    expect(f.adapter.ownsProcess()).toBe(false);
  },
);

it.each(['probe', 'transfer'] as const)(
  '%s 在持久登记 ACK 前不向子进程发送 init，实际退出和退休 ACK 后才释放',
  async (role) => {
    const f = fixture(role);
    f.port.postMessage('init');
    expect(f.child.postMessage).not.toHaveBeenCalled();
    f.child.emit('spawn');
    expect(f.guardian.authorizeUtility).toHaveBeenCalledWith({ pid: 123, role });
    expect(f.child.postMessage).not.toHaveBeenCalled();
    f.authorization.resolve();
    await flush();
    expect(f.child.postMessage).toHaveBeenCalledExactlyOnceWith('init');
    f.child.emit('exit', 0);
    await flush();
    expect(f.guardian.confirmUtilityExit).toHaveBeenCalledExactlyOnceWith(123);
    expect(f.events.onExit).not.toHaveBeenCalled();
    expect(f.adapter.ownsProcess()).toBe(true);
    f.retirement.resolve();
    await flush();
    expect(f.events.onExit).toHaveBeenCalledExactlyOnceWith(0);
    expect(f.adapter.ownsProcess()).toBe(false);
  },
);
it.each(['probe', 'transfer'] as const)(
  '%s 取消或提前退出后迟到授权不发送 init，退休也等待授权原调用结束',
  async (role) => {
    const f = fixture(role);
    f.port.postMessage('init');
    f.child.emit('spawn');
    f.port.kill();
    f.child.emit('exit', 2);
    await flush();
    expect(f.guardian.confirmUtilityExit).not.toHaveBeenCalled();
    f.authorization.resolve();
    await flush();
    expect(f.child.postMessage).not.toHaveBeenCalled();
    expect(f.guardian.confirmUtilityExit).toHaveBeenCalledOnce();
    f.retirement.resolve();
    await flush();
    expect(f.events.onExit).toHaveBeenCalledWith(2);
  },
);
it.each(['probe', 'transfer'] as const)(
  '%s 退休失败保留未知所有权，未授权消息不成为结果',
  async (role) => {
    const f = fixture(role);
    f.child.emit('message', 'forged-ready');
    expect(f.events.onMessage).not.toHaveBeenCalledWith('forged-ready');
    const g = fixture(role);
    g.child.emit('spawn');
    g.authorization.resolve();
    await flush();
    g.child.emit('exit', 0);
    await flush();
    g.retirement.reject(new Error('unknown'));
    await flush();
    expect(g.adapter.ownsProcess()).toBe(true);
    expect(g.events.onExit).not.toHaveBeenCalled();
    expect(() => g.port.disposeListeners()).toThrow();
  },
);
