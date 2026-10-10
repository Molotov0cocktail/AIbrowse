import { afterEach, expect, it, vi } from 'vitest';
import { createTransferWorkerController } from './transfer-worker-controller';
import { createStartupProbeWorkerController } from './startup-probe-worker-controller';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('./transfer-registration');
  vi.doUnmock('./startup-probe-registration');
  vi.doUnmock('./transfer-pipeline');
  vi.doUnmock('./startup-probe');
});
const operationId = '00000000-0000-4000-8000-000000000001';
const job = {
  operationId,
  action: 'backup' as const,
  snapshotId: '00000000-0000-4000-8000-000000000002',
};

it.each(['probe', 'transfer'] as const)(
  '%s 固定worker入口在未初始化窗口不调用任何登记读取或数据流水线',
  async (role) => {
    vi.useFakeTimers();
    vi.resetModules();
    const resolve = vi.fn(),
      work = vi.fn(),
      exit = vi.fn();
    const parentPort = { on: vi.fn(), postMessage: vi.fn() };
    vi.stubGlobal(
      'process',
      Object.assign(Object.create(process), {
        argv: ['node', 'worker', '{}'],
        parentPort,
        exit,
      }),
    );
    vi.doMock('./transfer-registration', () => ({
      parseTransferRegistration: () => ({ job }),
      resolveRegisteredTransfer: resolve,
    }));
    vi.doMock('./startup-probe-registration', () => ({
      parseStartupProbeRegistration: () => ({ operationId, userDataRoot: 'registered' }),
    }));
    vi.doMock('./transfer-pipeline', () => ({ runTransferPipeline: work }));
    vi.doMock('./startup-probe', () => ({ runStartupProbe: work }));
    if (role === 'probe') await import('./startup-probe-worker');
    else await import('./transfer-worker');
    expect(parentPort.on).toHaveBeenCalledExactlyOnceWith('message', expect.any(Function));
    await vi.advanceTimersByTimeAsync(10000);
    expect(resolve).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
    expect(parentPort.postMessage).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(2);
  },
);
function fixture(role: 'probe' | 'transfer') {
  const work = vi.fn(() => new Promise<never>(() => {}));
  const port = { send: vi.fn(), exit: vi.fn(), scheduleExit: vi.fn() };
  const controller =
    role === 'probe'
      ? createStartupProbeWorkerController(operationId, port, work)
      : createTransferWorkerController(job, port, work);
  const init = JSON.stringify(
    role === 'probe' ? { type: 'init', operationId, remainingMs: 90000 } : { type: 'init', ...job },
  );
  return { work, port, controller, init };
}
it.each(['probe', 'transfer'] as const)(
  '%s 未收到init时零数据I/O、10秒受控退出、迟到init无效',
  async (role) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const f = fixture(role);
    await vi.advanceTimersByTimeAsync(9999);
    expect(f.work).not.toHaveBeenCalled();
    expect(f.port.send).not.toHaveBeenCalled();
    expect(f.port.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.port.exit).toHaveBeenCalledExactlyOnceWith(2);
    f.controller.receive(f.init);
    await Promise.resolve();
    expect(f.work).not.toHaveBeenCalled();
    expect(f.port.send).not.toHaveBeenCalled();
  },
);
it.each(['probe', 'transfer'] as const)(
  '%s 已授权init撤销pre-init计时但不提前结束真实工作',
  async (role) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const f = fixture(role);
    f.controller.receive(f.init);
    await Promise.resolve();
    expect(f.work).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.port.exit).not.toHaveBeenCalled();
  },
);
it.each(['probe', 'transfer'] as const)(
  '%s 事件循环迟到的init不能在已到绝对截止后获得许可',
  async (role) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const f = fixture(role);
    now.mockReturnValue(10000);
    f.controller.receive(f.init);
    await Promise.resolve();
    expect(f.work).not.toHaveBeenCalled();
    expect(f.port.exit).toHaveBeenCalledExactlyOnceWith(2);
    now.mockRestore();
  },
);
