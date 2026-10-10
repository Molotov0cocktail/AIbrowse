import { afterEach, describe, expect, it, vi } from 'vitest';
import { MainFailureShutdown } from './main-failure-shutdown';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('不可恢复主进程错误', () => {
  it('guardian退休已经发出时，排水后直接异常退出而不再等待通知或旧ack', async () => {
    vi.useFakeTimers();
    const notify = vi.fn(() => new Promise<void>(() => {}));
    const guardian = vi.fn(() => new Promise<void>(() => {}));
    const exit = vi.fn();
    const shutdown = new MainFailureShutdown({
      stopAdmission: vi.fn(),
      hasGuardianFinishStarted: () => true,
      notify,
      drain: async () => undefined,
      finishGuardian: guardian,
      exit,
    });
    shutdown.begin();
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).not.toHaveBeenCalled();
    expect(guardian).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('已有guardian退休不能越过仍未完成的真实排水', async () => {
    vi.useFakeTimers();
    let finishDrain!: () => void;
    const exit = vi.fn();
    const guardian = vi.fn();
    const shutdown = new MainFailureShutdown({
      stopAdmission: vi.fn(),
      hasGuardianFinishStarted: () => true,
      notify: vi.fn(),
      drain: () => new Promise<void>((resolve) => (finishDrain = resolve)),
      finishGuardian: guardian,
      exit,
    });
    shutdown.begin();
    await vi.advanceTimersByTimeAsync(100);
    expect(exit).not.toHaveBeenCalled();
    finishDrain();
    await vi.advanceTimersByTimeAsync(0);
    expect(guardian).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('timer尚未获执行时，迟到drain不能启动guardian', async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    let resolve!: () => void;
    const guardian = vi.fn(async () => undefined);
    const exit = vi.fn();
    const shutdown = new MainFailureShutdown({
      stopAdmission: vi.fn(),
      notify: vi.fn(),
      exit,
      drain: () => new Promise<void>((yes) => (resolve = yes)),
      finishGuardian: guardian,
    });
    shutdown.begin();
    await vi.advanceTimersByTimeAsync(0);
    now = 10_001;
    resolve();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(guardian).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('未关闭提示在九秒取消，排水先完成而guardian宽限从提示结束后开始', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const drain = vi.fn(async () => undefined);
    const guardian = vi.fn(async () => undefined);
    const exit = vi.fn();
    const shutdown = new MainFailureShutdown({
      stopAdmission: vi.fn(),
      notify: (_reason, notificationSignal) => {
        signal = notificationSignal;
        return new Promise<void>(() => {});
      },
      drain,
      finishGuardian: guardian,
      exit,
    });
    shutdown.begin();
    await vi.advanceTimersByTimeAsync(0);
    expect(drain).toHaveBeenCalledOnce();
    expect(guardian).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8_999);
    expect(guardian).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(guardian).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('用户提前关闭提示后才开启guardian退出宽限，故障退出取消遗留通知资源', async () => {
    vi.useFakeTimers();
    let dismiss!: () => void;
    let signal: AbortSignal | undefined;
    const guardian = vi.fn(async () => undefined);
    const exit = vi.fn();
    const shutdown = new MainFailureShutdown({
      stopAdmission: vi.fn(),
      notify: (_reason, notificationSignal) => {
        signal = notificationSignal;
        return new Promise<void>((resolve) => (dismiss = resolve));
      },
      drain: async () => undefined,
      finishGuardian: guardian,
      exit,
    });
    shutdown.begin('ui-unavailable');
    await vi.advanceTimersByTimeAsync(100);
    expect(guardian).not.toHaveBeenCalled();
    dismiss();
    await vi.advanceTimersByTimeAsync(0);
    expect(guardian).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('通知九秒取消不使仍在排水的数据库提前退休', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const guardian = vi.fn(async () => undefined);
    const exit = vi.fn();
    const shutdown = new MainFailureShutdown({
      stopAdmission: vi.fn(),
      notify: (_reason, notificationSignal) => {
        signal = notificationSignal;
        return new Promise<void>(() => {});
      },
      drain: () => new Promise<void>(() => {}),
      finishGuardian: guardian,
      exit,
    });
    shutdown.begin();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(signal?.aborted).toBe(true);
    expect(guardian).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(guardian).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('准入同步关闭耗尽提示预算时不弹出迟到原生对话框', async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const notify = vi.fn();
    const guardian = vi.fn(async () => undefined);
    const exit = vi.fn();
    const shutdown = new MainFailureShutdown({
      stopAdmission: () => {
        now = 9_001;
      },
      notify,
      drain: async () => undefined,
      finishGuardian: guardian,
      exit,
    });
    shutdown.begin();
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).not.toHaveBeenCalled();
    expect(guardian).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('同步关闭准入，排水与guardian按序成功后仍以失败码退出且只执行一次', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const exit = vi.fn();
    const shutdown = new MainFailureShutdown({
      stopAdmission: () => calls.push('stop'),
      notify: () => {
        calls.push('notify');
      },
      drain: async () => {
        calls.push('drain');
      },
      finishGuardian: async () => {
        calls.push('guardian');
      },
      exit,
    });
    shutdown.begin();
    shutdown.begin();
    expect(calls[0]).toBe('stop');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['stop', 'notify', 'drain', 'guardian']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['drain', 'guardian'] as const)(
    '%s悬挂仍在10秒边界exit1，未完成清理不伪报guardian完成',
    async (phase) => {
      vi.useFakeTimers();
      const guardian = vi.fn(() =>
        phase === 'guardian' ? new Promise<void>(() => {}) : Promise.resolve(),
      );
      const exit = vi.fn();
      const shutdown = new MainFailureShutdown({
        stopAdmission: vi.fn(),
        notify: vi.fn(),
        exit,
        drain: () => (phase === 'drain' ? new Promise<void>(() => {}) : Promise.resolve()),
        finishGuardian: guardian,
      });
      shutdown.begin();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      if (phase === 'drain') expect(guardian).not.toHaveBeenCalled();
    },
  );

  it('排水失败保留guardian异常退出语义，提示故障不阻止退出', async () => {
    vi.useFakeTimers();
    const guardian = vi.fn();
    const exit = vi.fn();
    const shutdown = new MainFailureShutdown({
      stopAdmission: vi.fn(),
      notify: () => {
        throw new Error('合成提示失败');
      },
      exit,
      drain: async () => {
        throw new Error('合成排水失败');
      },
      finishGuardian: guardian,
    });
    shutdown.begin();
    await vi.advanceTimersByTimeAsync(0);
    expect(guardian).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
