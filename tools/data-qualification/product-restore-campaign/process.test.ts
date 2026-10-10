import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: fake.spawn }));
import { Processes } from './process';

function child() {
  const value = Object.assign(new EventEmitter(), {
    pid: 123,
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  fake.spawn.mockReturnValue(value);
  return value;
}
afterEach(() => {
  vi.useRealTimers();
  fake.spawn.mockReset();
});
it('exit0之后原所有权保持到stdio真实close，失败原stderr保留', async () => {
  const c = child(),
    p = new Processes(() => performance.now() + 60_000),
    owned = p.start('node', []);
  c.stderr.emit('data', Buffer.from('受控错误原件'));
  c.emit('exit', 0);
  expect(await owned.exit).toBe(0);
  expect(p.owned.size).toBe(1);
  c.emit('close', 0);
  expect(await owned.closed).toBe(0);
  expect(p.owned.size).toBe(0);
  expect(Buffer.from(p.diagnostics[0]!.stderrBase64, 'base64').toString()).toBe('受控错误原件');
});
it('error事件不退休，close缺exit或退出码漂移不得授0', async () => {
  for (const mode of ['error', 'mismatch']) {
    const c = child(),
      p = new Processes(() => performance.now() + 60_000),
      owned = p.start('node', []);
    if (mode === 'error') c.emit('error', new Error('启动失败'));
    else c.emit('exit', 0);
    expect(p.owned.size).toBe(1);
    c.emit('close', mode === 'error' ? 0 : 1);
    expect(await owned.closed).toBeNull();
    expect(p.owned.size).toBe(0);
  }
});
it('helper逻辑超时kill一次，原child待真实close，不以Promise.race结束退休', async () => {
  vi.useFakeTimers();
  const c = child(),
    p = new Processes(() => performance.now() + 60_000);
  const outcome = p.external('node', [], performance.now() + 10).catch(() => undefined);
  await vi.advanceTimersByTimeAsync(11);
  await outcome;
  expect(c.kill).toHaveBeenCalledTimes(1);
  expect(p.owned.size).toBe(1);
  p.stop();
  expect(c.kill).toHaveBeenCalledTimes(1);
  c.emit('exit', 1);
  c.emit('close', 1);
  expect(p.owned.size).toBe(0);
});
