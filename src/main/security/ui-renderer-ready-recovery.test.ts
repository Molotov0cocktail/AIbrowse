import { afterEach, expect, it, vi } from 'vitest';
import { UiRendererRecovery } from './ui-renderer-recovery';

afterEach(() => vi.useRealTimers());

function pendingLoad() {
  vi.useFakeTimers();
  const pending: Array<() => void> = [];
  const choose = vi.fn(async (): Promise<'exit'> => 'exit');
  const exit = vi.fn();
  const recovery = new UiRendererRecovery({
    invalidate: vi.fn(),
    load: () => new Promise<void>((resolve) => pending.push(resolve)),
    choose,
    exit,
    isAlive: () => true,
    now: () => Date.now(),
  });
  return { recovery, pending, choose, exit };
}

it('页面加载完成但当前文档bridge未就绪时仍受原十秒恢复截止约束', async () => {
  vi.useFakeTimers();
  const choose = vi.fn(async (): Promise<'exit'> => 'exit');
  const exit = vi.fn();
  const load = vi.fn(async () => undefined);
  const recovery = new UiRendererRecovery({
    invalidate: vi.fn(),
    load,
    choose,
    exit,
    isAlive: () => true,
    now: () => Date.now(),
  });
  recovery.crashed();
  await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(9_999);
  expect(choose).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(choose).toHaveBeenCalledExactlyOnceWith(true);
  expect(exit).toHaveBeenCalledOnce();
});

it.each(['ready-first', 'load-first'])('当前Ready与load完成均齐备才恢复：%s', async (order) => {
  const x = pendingLoad();
  x.recovery.crashed();
  await vi.advanceTimersByTimeAsync(0);
  if (order === 'ready-first') x.recovery.rendererReady();
  else {
    x.pending[0]!();
    await vi.advanceTimersByTimeAsync(0);
  }
  await vi.advanceTimersByTimeAsync(9_999);
  expect(x.choose).not.toHaveBeenCalled();
  if (order === 'ready-first') x.pending[0]!();
  else x.recovery.rendererReady();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(x.choose).not.toHaveBeenCalled();
  expect(x.exit).not.toHaveBeenCalled();
  x.recovery.dispose();
});

it('只有当前Ready而load悬挂不能取消十秒截止', async () => {
  const x = pendingLoad();
  x.recovery.crashed();
  await vi.advanceTimersByTimeAsync(0);
  x.recovery.rendererReady();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(x.choose).toHaveBeenCalledExactlyOnceWith(true);
  expect(x.exit).toHaveBeenCalledOnce();
  x.pending[0]!();
  await vi.advanceTimersByTimeAsync(0);
  expect(x.exit).toHaveBeenCalledOnce();
});

it('timer尚未执行时，截止处迟到的Ready也不能授恢复成功', async () => {
  const x = pendingLoad();
  x.recovery.crashed();
  await vi.advanceTimersByTimeAsync(0);
  x.pending[0]!();
  await vi.advanceTimersByTimeAsync(0);
  vi.setSystemTime(Date.now() + 10_000);
  x.recovery.rendererReady();
  await vi.advanceTimersByTimeAsync(0);
  expect(x.choose).toHaveBeenCalledExactlyOnceWith(true);
  expect(x.exit).toHaveBeenCalledOnce();
});

it('先前epoch的load完成不能与新epoch的Ready拼接', async () => {
  const x = pendingLoad();
  x.recovery.crashed();
  await vi.advanceTimersByTimeAsync(0);
  x.recovery.crashed();
  await vi.advanceTimersByTimeAsync(0);
  x.recovery.rendererReady();
  x.pending[0]!();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(x.choose).toHaveBeenCalledExactlyOnceWith(true);
  expect(x.exit).toHaveBeenCalledOnce();
  x.pending[1]!();
  await vi.advanceTimersByTimeAsync(0);
  expect(x.exit).toHaveBeenCalledOnce();
});

it('dispose后的Ready和load完成不复活恢复状态', async () => {
  const x = pendingLoad();
  x.recovery.crashed();
  await vi.advanceTimersByTimeAsync(0);
  x.recovery.dispose();
  x.recovery.rendererReady();
  x.pending[0]!();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(x.choose).not.toHaveBeenCalled();
  expect(x.exit).not.toHaveBeenCalled();
});
