import { describe, expect, it, vi } from 'vitest';
import { NormalQuitCoordinator, snapshotQuitMessage } from './normal-quit';
import { RuntimeShutdown } from './runtime-shutdown';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function fixture() {
  const drain = deferred();
  const choice = deferred<'stop' | 'wait'>();
  let count = 1;
  let failed = false;
  const ports = {
    closeSnapshotAdmission: vi.fn(),
    pendingSnapshots: () => count,
    askToStop: vi.fn<(count: number, signal: AbortSignal) => Promise<'stop' | 'wait'>>(
      () => choice.promise,
    ),
    stopSnapshots: vi.fn(async () => {
      count = 0;
    }),
    shutdown: vi.fn(() => drain.promise),
    finish: vi.fn(async () => undefined),
    isFailureActive: () => failed,
    reportFailure: vi.fn(),
  };
  const coordinator = new NormalQuitCoordinator(ports);
  return {
    coordinator,
    ports,
    choice,
    drain,
    count: (n: number) => {
      count = n;
    },
    fail: () => {
      failed = true;
    },
  };
}

describe('用户正常退出选择', () => {
  it('原生弹窗默认和取消都选择等待，计数有界且没有页面文本', () => {
    const signal = new AbortController().signal;
    const options = snapshotQuitMessage(10_000_000, signal);
    expect(options.buttons[options.defaultId]).toBe('继续等待');
    expect(options.buttons[options.cancelId]).toBe('继续等待');
    expect(options.message).toBe('仍有 1000000 个页面快照请求尚未完成');
    expect(options.signal).toBe(signal);
    expect(options.noLink).toBe(true);
  });
  it('关闭准入并启动一次排水，原生确认前不强停，重复退出不叠加弹窗', async () => {
    const f = fixture();
    f.coordinator.request();
    f.coordinator.request();
    await flush();
    expect(f.ports.closeSnapshotAdmission).toHaveBeenCalledOnce();
    expect(f.ports.shutdown).toHaveBeenCalledOnce();
    expect(f.ports.askToStop).toHaveBeenCalledOnce();
    expect(f.ports.stopSnapshots).not.toHaveBeenCalled();
    f.choice.resolve('stop');
    await flush();
    expect(f.ports.stopSnapshots).toHaveBeenCalledOnce();
    expect(f.ports.finish).not.toHaveBeenCalled();
    f.drain.resolve();
    await flush();
    expect(f.ports.finish).toHaveBeenCalledOnce();
  });

  it.each(['wait', 'rejected'] as const)(
    '等待或弹窗失败不批准，之后可重新选择：%s',
    async (choice) => {
      const f = fixture();
      f.coordinator.request();
      await flush();
      if (choice === 'wait') f.choice.resolve('wait');
      else f.choice.reject(new Error('synthetic'));
      await flush();
      expect(f.ports.stopSnapshots).not.toHaveBeenCalled();
      f.ports.askToStop.mockResolvedValueOnce('stop');
      f.coordinator.request();
      await flush();
      expect(f.ports.askToStop).toHaveBeenCalledTimes(2);
      expect(f.ports.stopSnapshots).toHaveBeenCalledOnce();
      expect(f.ports.shutdown).toHaveBeenCalledOnce();
    },
  );

  it('自然排水完成撤销弹窗，迟到批准不能再关闭页面', async () => {
    const f = fixture();
    f.coordinator.request();
    await flush();
    const signal = f.ports.askToStop.mock.calls[0]![1];
    f.drain.resolve();
    await flush();
    expect(signal.aborted).toBe(true);
    f.choice.resolve('stop');
    await flush();
    expect(f.ports.stopSnapshots).not.toHaveBeenCalled();
    expect(f.ports.finish).toHaveBeenCalledOnce();
  });

  it('批准交接后重查快照，无待处理请求时零强停', async () => {
    const f = fixture();
    f.coordinator.request();
    await flush();
    f.count(0);
    f.choice.resolve('stop');
    await flush();
    expect(f.ports.stopSnapshots).not.toHaveBeenCalled();
  });

  it('异常退出接管撤销正常弹窗，不强停或完成正常退出', async () => {
    const f = fixture();
    f.coordinator.request();
    await flush();
    const signal = f.ports.askToStop.mock.calls[0]![1];
    f.fail();
    f.coordinator.interrupt();
    f.choice.resolve('stop');
    f.drain.resolve();
    await flush();
    expect(signal.aborted).toBe(true);
    expect(f.ports.stopSnapshots).not.toHaveBeenCalled();
    expect(f.ports.finish).not.toHaveBeenCalled();
  });

  it('没有快照直接正常排水；排水失败不启动退休或再次关闭', async () => {
    const f = fixture();
    f.count(0);
    f.coordinator.request();
    await flush();
    expect(f.ports.askToStop).not.toHaveBeenCalled();
    f.drain.reject(new Error('synthetic'));
    await flush();
    f.count(1);
    f.coordinator.request();
    await flush();
    expect(f.ports.askToStop).not.toHaveBeenCalled();
    expect(f.ports.finish).not.toHaveBeenCalled();
    expect(f.ports.reportFailure).toHaveBeenCalledOnce();
  });

  it('快照取消不跳过独立写操作、usage和workspace的真实排水', async () => {
    const f = fixture();
    const snapshot = deferred();
    const writing = deferred();
    const usage = deferred();
    const workspace = deferred();
    const close = vi.fn();
    const runtime = new RuntimeShutdown({
      roots: [],
      producers: [snapshot, writing].map((operation) => ({
        beginShutdown: () => undefined,
        drainBeforeClose: () => operation.promise,
      })),
      waitForUsage: () => usage.promise,
      cleanupWorkspace: async () => {
        await workspace.promise;
        return { ok: true, retainedCount: 0 };
      },
      closeResources: close,
    });
    f.ports.shutdown.mockImplementation(() => runtime.shutdown());
    f.ports.stopSnapshots.mockImplementation(async () => {
      snapshot.resolve();
    });
    f.coordinator.request();
    f.choice.resolve('stop');
    await flush();
    expect(f.ports.stopSnapshots).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    writing.resolve();
    await flush();
    expect(close).not.toHaveBeenCalled();
    usage.resolve();
    await flush();
    expect(close).not.toHaveBeenCalled();
    workspace.resolve();
    await flush();
    expect(close).toHaveBeenCalledOnce();
    expect(f.ports.finish).toHaveBeenCalledOnce();
  });
});
