import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiRendererRecovery } from './ui-renderer-recovery';

afterEach(() => vi.useRealTimers());

function harness() {
  vi.useFakeTimers();
  const invalidate = vi.fn();
  const load = vi.fn(async (): Promise<void> => recovery.rendererReady());
  const choose = vi.fn<(allowRetry: boolean) => Promise<'retry' | 'exit'>>(async () => 'exit');
  const exit = vi.fn();
  const alive = { value: true };
  const recovery = new UiRendererRecovery({
    invalidate,
    load,
    choose,
    exit,
    isAlive: () => alive.value,
    now: () => Date.now(),
  });
  return { recovery, invalidate, load, choose, exit, alive };
}

describe('主界面有界恢复', () => {
  it('timer尚未获执行时，迟到load完成仍必须进入出口', async () => {
    const h = harness();
    let resolve!: () => void;
    h.load.mockImplementation(() => new Promise<void>((yes) => (resolve = yes)));
    h.recovery.crashed();
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 10_001);
    resolve();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(h.choose).toHaveBeenCalledOnce();
    expect(h.exit).toHaveBeenCalledOnce();
  });

  it('启动微任务迟于原截止时不能开始Electron load', async () => {
    const h = harness();
    h.recovery.crashed();
    vi.setSystemTime(Date.now() + 10_001);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(h.load).not.toHaveBeenCalled();
    expect(h.choose).toHaveBeenCalledOnce();
  });

  it('同步失效授权，复用原装配仅重新加载；60秒内第三次崩溃须明确选择', async () => {
    const h = harness();
    h.recovery.crashed();
    expect(h.invalidate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    h.recovery.crashed();
    await vi.advanceTimersByTimeAsync(0);
    h.recovery.crashed();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.load).toHaveBeenCalledTimes(2);
    expect(h.choose).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.exit).toHaveBeenCalledOnce();
  });

  it('成功reload不重置60秒预算，满60秒才允许新的自动恢复', async () => {
    const h = harness();
    for (let i = 0; i < 2; i += 1) {
      h.recovery.crashed();
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    h.recovery.crashed();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.load).toHaveBeenCalledTimes(3);
    expect(h.choose).not.toHaveBeenCalled();
    h.recovery.dispose();
  });

  it('加载失败只允许一次手动重试，再失败只提供退出', async () => {
    const h = harness();
    h.load.mockRejectedValue(new Error('SECRET 不得显示'));
    h.choose.mockResolvedValueOnce('retry').mockResolvedValueOnce('exit');
    h.recovery.crashed();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.load).toHaveBeenCalledTimes(2);
    expect(h.choose.mock.calls).toEqual([[true], [false]]);
    expect(h.exit).toHaveBeenCalledOnce();
  });

  it('加载悬挂10秒进入用户出口，迟到成功不再开启重试', async () => {
    const h = harness();
    let resolve!: () => void;
    h.load.mockImplementation(() => new Promise<void>((yes) => (resolve = yes)));
    h.recovery.crashed();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.choose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.choose).toHaveBeenCalledOnce();
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.exit).toHaveBeenCalledOnce();
  });

  it('等待选择时重复崩溃不弹重复对话框，销毁后迟到选择不重载', async () => {
    const h = harness();
    h.load.mockRejectedValue(new Error('合成失败'));
    let answer!: (value: 'retry') => void;
    h.choose.mockImplementation(() => new Promise((yes) => (answer = yes)));
    h.recovery.crashed();
    await vi.advanceTimersByTimeAsync(0);
    h.recovery.crashed();
    h.recovery.crashed();
    expect(h.choose).toHaveBeenCalledOnce();
    h.recovery.dispose();
    answer('retry');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.load).toHaveBeenCalledOnce();
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('恢复中再次崩溃废弃旧加载结果，最多两次自动加载', async () => {
    const h = harness();
    const pending: Array<() => void> = [];
    h.load.mockImplementation(() => new Promise<void>((yes) => pending.push(yes)));
    h.recovery.crashed();
    await vi.advanceTimersByTimeAsync(0);
    h.recovery.crashed();
    await vi.advanceTimersByTimeAsync(0);
    pending[0]!();
    await vi.advanceTimersByTimeAsync(0);
    h.recovery.crashed();
    await vi.advanceTimersByTimeAsync(0);
    pending[1]!();
    expect(h.load).toHaveBeenCalledTimes(2);
    expect(h.exit).toHaveBeenCalledOnce();
  });
});
