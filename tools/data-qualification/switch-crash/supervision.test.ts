import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());
async function harness(throwKill: boolean) {
  const source = await readFile('tools/data-qualification/switch-crash/run.ts', 'utf8');
  const start = source.indexOf('async function supervise(');
  const end = source.indexOf('async function textAt(', start);
  const compiled = await transform(source.slice(start, end), { loader: 'ts', target: 'node24' });
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => {
      if (throwKill) throw new Error('受控kill错误');
      return false;
    }),
    send: vi.fn(),
  });
  vi.useFakeTimers();
  const output = resolve('log/stage7-e2');
  const supervise = runInNewContext(compiled.code + '\nsupervise;', {
    output,
    worker: 'no-native-worker',
    process: { execPath: 'unused' },
    spawn: () => child,
    isAbsolute,
    sep,
    Buffer,
    Promise,
    setTimeout,
    clearTimeout,
    LIMIT: { exitMs: 20, childMs: 100, frameBytes: 256, frames: 500 },
  }) as (path: string, mode: string, index: number | null) => Promise<unknown>;
  let result: string | null = null;
  const done = supervise(join(output, 'mock-owned'), 'publish', null).then(
    () => {
      result = 'success';
    },
    (error: unknown) => {
      result = String(error);
    },
  );
  return { child, done, result: () => result };
}

it.each([false, true])(
  'kill false/抛错=%s仍等待固定退出期限，重复error不续期',
  async (throwKill) => {
    const h = await harness(throwKill);
    h.child.emit('error', new Error('IPC失败'));
    await vi.advanceTimersByTimeAsync(19);
    expect(h.result()).toBeNull();
    h.child.emit('error', new Error('第二错误'));
    expect(h.child.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await h.done;
    expect(h.result()).toContain('退出未确认');
    h.child.emit('exit', 0);
    expect(h.result()).toContain('退出未确认');
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('error后期限内的真实exit只结算原失败，不以exit0授成功', async () => {
  const h = await harness(false);
  h.child.emit('error', new Error('IPC失败'));
  await vi.advanceTimersByTimeAsync(10);
  expect(h.result()).toBeNull();
  h.child.emit('exit', 0);
  await h.done;
  expect(h.result()).toContain('资格子进程失败');
  expect(vi.getTimerCount()).toBe(0);
});
