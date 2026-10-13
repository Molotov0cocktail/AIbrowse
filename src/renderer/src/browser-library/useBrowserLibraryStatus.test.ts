import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserLibraryStatus } from '../../../shared/types/browser-library';
import { useBrowserLibraryStatus } from './useBrowserLibraryStatus';

const hooks = vi.hoisted(() => ({
  effect: null as null | (() => () => void),
  publish: vi.fn(),
}));
vi.mock('react', () => ({
  useState: () => [null, hooks.publish],
  useEffect: (effect: () => () => void) => {
    hooks.effect = effect;
  },
}));
let cleanup: (() => void) | undefined;
const getStatus = vi.fn<() => Promise<BrowserLibraryStatus>>();
beforeEach(() => {
  vi.useFakeTimers();
  hooks.publish.mockClear();
  getStatus.mockReset();
  vi.stubGlobal('window', { aibrowse: { browserLibrary: { getStatus } } });
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount() {
  useBrowserLibraryStatus();
  cleanup = hooks.effect!();
  await vi.advanceTimersByTimeAsync(0);
}

it('慢初始化保持中性并快速读到就绪，之后恢复稳态轮询', async () => {
  getStatus.mockResolvedValue({ state: 'initializing', message: '正在准备浏览数据' });
  await mount();
  await vi.advanceTimersByTimeAsync(6000);
  expect(getStatus.mock.calls.length).toBeGreaterThan(20);
  expect(hooks.publish.mock.calls.every(([status]) => status.state === 'initializing')).toBe(true);
  getStatus.mockResolvedValue({ state: 'available', message: '就绪' });
  await vi.advanceTimersByTimeAsync(250);
  expect(hooks.publish).toHaveBeenLastCalledWith({ state: 'available', message: '就绪' });
  const calls = getStatus.mock.calls.length;
  await vi.advanceTimersByTimeAsync(4999);
  expect(getStatus).toHaveBeenCalledTimes(calls);
  await vi.advanceTimersByTimeAsync(1);
  expect(getStatus).toHaveBeenCalledTimes(calls + 1);
});

it.each(['unavailable', 'storage-error'] as const)(
  '初始化后的真实%s在下一次读取立即呈现',
  async (state) => {
    getStatus.mockResolvedValueOnce({ state: 'initializing', message: '正在准备浏览数据' });
    getStatus.mockResolvedValue({ state, message: '真实故障' });
    await mount();
    await vi.advanceTimersByTimeAsync(250);
    expect(hooks.publish).toHaveBeenLastCalledWith({ state, message: '真实故障' });
  },
);

it('首次IPC失败仍立即告警，卸载后的迟到读取不发布或重启轮询', async () => {
  getStatus.mockRejectedValueOnce(new Error('IPC失败'));
  await mount();
  expect(hooks.publish).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'unavailable' }));
  let resolve!: (value: BrowserLibraryStatus) => void;
  getStatus.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await vi.advanceTimersByTimeAsync(5000);
  cleanup!();
  cleanup = undefined;
  const publications = hooks.publish.mock.calls.length;
  resolve({ state: 'available', message: '就绪' });
  await vi.advanceTimersByTimeAsync(10000);
  expect(hooks.publish).toHaveBeenCalledTimes(publications);
  expect(getStatus).toHaveBeenCalledTimes(2);
});
