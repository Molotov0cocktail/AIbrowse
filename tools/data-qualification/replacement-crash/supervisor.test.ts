import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { assertExactCheckpointSequence, REPLACEMENT_CHECKPOINTS } from './contracts';
import { superviseProcess } from './supervisor';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fakeChild(kill: () => boolean): {
  child: ChildProcess;
  events: EventEmitter;
  send: ReturnType<typeof vi.fn>;
} {
  const events = new EventEmitter();
  const send = vi.fn((_message: unknown, callback?: (error: Error | null) => void) =>
    callback?.(null),
  );
  Object.assign(events, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(kill),
    send,
  });
  return { child: events as unknown as ChildProcess, events, send };
}

it.each([
  ['false', (): boolean => false],
  [
    'throw',
    (): boolean => {
      throw new Error('kill失败');
    },
  ],
] as const)('kill返回%s时未知exit保持失败与所有权，不把kill调用当退出', async (_label, kill) => {
  vi.useFakeTimers();
  const fake = fakeChild(kill);
  const result = superviseProcess(() => fake.child, REPLACEMENT_CHECKPOINTS[0]);
  const observed = result.catch((error: unknown) => error);
  fake.events.emit('message', { kind: 'boundary', point: REPLACEMENT_CHECKPOINTS[0] });
  await vi.advanceTimersByTimeAsync(1_999);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(String(await observed)).toContain('退出未确认');
});

it('非法IPC帧先终止并等待真实exit，exit0也只能结算原失败', async () => {
  const fake = fakeChild(() => true);
  const result = superviseProcess(() => fake.child, null);
  fake.events.emit('message', { kind: 'boundary', point: 'not-registered' });
  fake.events.emit('exit', 0, null);
  fake.events.emit('close', 0, null);
  await expect(result).rejects.toThrow('IPC帧非法');
});

it('不可编码的IPC值也走受控失败和真实exit路径', async () => {
  const fake = fakeChild(() => true);
  const result = superviseProcess(() => fake.child, null);
  const observed = result.catch((error: unknown) => error);
  let escaped: unknown;
  try {
    fake.events.emit('message', undefined);
  } catch (error) {
    escaped = error;
  }
  fake.events.emit('exit', 0, null);
  fake.events.emit('close', 0, null);
  const outcome = await observed;
  expect(escaped).toBeUndefined();
  expect(String(outcome)).toContain('IPC');
});

it.each(['frame-size', 'frame-count', 'output'] as const)(
  '%s超过固定预算即停止且不授PASS',
  async (kind) => {
    const fake = fakeChild(() => true);
    const result = superviseProcess(() => fake.child, null);
    if (kind === 'frame-size') fake.events.emit('message', { data: 'x'.repeat(513) });
    else if (kind === 'frame-count') {
      for (let index = 0; index < 129; index += 1)
        fake.events.emit('message', { kind: 'boundary', point: REPLACEMENT_CHECKPOINTS[0] });
    } else fake.child.stdout?.emit('data', Buffer.alloc(4097));
    expect(fake.child.kill).toHaveBeenCalledOnce();
    fake.events.emit('exit', 0, null);
    fake.events.emit('close', 0, null);
    await expect(result).rejects.toThrow();
  },
);

it('正常exit后继续等待close，尾部输出纳入最终计量且流close不能代替child close', async () => {
  const fake = fakeChild(() => true);
  let finished = false;
  const result = superviseProcess(() => fake.child, null).then((value) => {
    finished = true;
    return value;
  });
  fake.events.emit('message', { kind: 'result', state: 'normal' });
  fake.events.emit('exit', 0, null);
  fake.child.stdout?.emit('data', Buffer.alloc(4096));
  fake.child.stdout?.emit('close');
  fake.child.stderr?.emit('close');
  await Promise.resolve();
  expect(finished).toBe(false);
  fake.events.emit('close', 0, null);
  await expect(result).resolves.toMatchObject({ outputBytes: 4096, killed: false });
});

it.each(['normal', 'stopped'] as const)(
  '%s的close超过原截止时不可重新借用排水窗口',
  async (mode) => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const fake = fakeChild(() => true);
    const result = superviseProcess(
      () => fake.child,
      mode === 'stopped' ? REPLACEMENT_CHECKPOINTS[0] : null,
    );
    const observed = result.catch((error: unknown) => error);
    now = 100;
    if (mode === 'stopped')
      fake.events.emit('message', { kind: 'boundary', point: REPLACEMENT_CHECKPOINTS[0] });
    else fake.events.emit('message', { kind: 'result', state: 'normal' });
    const code = mode === 'stopped' ? null : 0;
    const signal = mode === 'stopped' ? 'SIGKILL' : null;
    now = 200;
    fake.events.emit('exit', code, signal);
    now = mode === 'stopped' ? 2101 : 8001;
    fake.events.emit('close', code, signal);
    expect(await observed).toBeInstanceOf(Error);
  },
);

it('正常exit但close不来时仍在原工作截止失败，保留输出所有权', async () => {
  vi.useFakeTimers();
  const fake = fakeChild(() => true);
  const result = superviseProcess(() => fake.child, null);
  const observed = result.catch((error: unknown) => error);
  fake.events.emit('message', { kind: 'result', state: 'normal' });
  fake.events.emit('exit', 0, null);
  await vi.advanceTimersByTimeAsync(8000);
  expect(String(await observed)).toContain('输出关闭未确认');
  expect(fake.child.kill).not.toHaveBeenCalled();
});

it('kill调用成功仍须SIGKILL实际exit及close，不能把自然非零退出当强杀', async () => {
  const fake = fakeChild(() => true);
  const result = superviseProcess(() => fake.child, REPLACEMENT_CHECKPOINTS[0]);
  fake.events.emit('message', { kind: 'boundary', point: REPLACEMENT_CHECKPOINTS[0] });
  fake.events.emit('exit', 1, null);
  fake.events.emit('close', 1, null);
  await expect(result).rejects.toThrow('强杀对应');
});

it.each(['false', 'throw'] as const)(
  'kill %s失败在exit后仍持有输出直到close，尾部错误不改首失败',
  async (mode) => {
    const fake = fakeChild(() => {
      if (mode === 'throw') throw new Error('合成kill错误');
      return false;
    });
    let finished = false;
    const result = superviseProcess(() => fake.child, REPLACEMENT_CHECKPOINTS[0]);
    const observed = result.catch((error: unknown) => {
      finished = true;
      return error;
    });
    fake.events.emit('message', { kind: 'boundary', point: REPLACEMENT_CHECKPOINTS[0] });
    fake.events.emit('exit', 1, null);
    await Promise.resolve();
    expect(finished).toBe(false);
    fake.child.stdout?.emit('data', Buffer.alloc(4097));
    fake.events.emit('close', 1, null);
    expect(String(await observed)).toContain(
      mode === 'throw' ? '强杀请求抛错' : '强杀请求返回false',
    );
  },
);

it('目标SIGKILL的exit与close在同一退出截止内才授中断成功', async () => {
  const fake = fakeChild(() => true);
  const result = superviseProcess(() => fake.child, REPLACEMENT_CHECKPOINTS[0]);
  fake.events.emit('message', { kind: 'boundary', point: REPLACEMENT_CHECKPOINTS[0] });
  fake.events.emit('exit', null, 'SIGKILL');
  fake.child.stderr?.emit('data', Buffer.alloc(7));
  fake.events.emit('close', null, 'SIGKILL');
  await expect(result).resolves.toMatchObject({ killed: true, signal: 'SIGKILL', outputBytes: 7 });
});

it('延迟工作timer不能从晚到时刻重获2秒退出窗口', async () => {
  vi.useFakeTimers();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const fake = fakeChild(() => true);
  const result = superviseProcess(() => fake.child, null);
  const observed = result.catch((error: unknown) => error);
  now = 9999;
  await vi.advanceTimersByTimeAsync(8000);
  expect(fake.child.kill).toHaveBeenCalledOnce();
  now = 10001;
  fake.events.emit('exit', null, 'SIGKILL');
  fake.events.emit('close', null, 'SIGKILL');
  expect(String(await observed)).toContain('工作期限');
});

it('总截止夹住工作和退出且spawn耗时不续租', async () => {
  vi.useFakeTimers();
  let now = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const fake = fakeChild(() => true);
  const result = superviseProcess(
    () => {
      now = 501;
      return fake.child;
    },
    null,
    { workMs: 8000, exitMs: 2000, deadline: 2500 },
  );
  const observed = result.catch((error: unknown) => error);
  expect(fake.child.kill).toHaveBeenCalledOnce();
  now = 2501;
  fake.events.emit('exit', null, 'SIGKILL');
  fake.events.emit('close', null, 'SIGKILL');
  expect(String(await observed)).toContain('工作期限');
});

it('正常枚举缺点、重复或乱序均不能取得18点控制资格', () => {
  expect(() => assertExactCheckpointSequence(REPLACEMENT_CHECKPOINTS.slice(0, -1))).toThrow();
  expect(() =>
    assertExactCheckpointSequence([
      REPLACEMENT_CHECKPOINTS[1],
      REPLACEMENT_CHECKPOINTS[0],
      ...REPLACEMENT_CHECKPOINTS.slice(2),
    ]),
  ).toThrow();
  expect(() =>
    assertExactCheckpointSequence([
      ...REPLACEMENT_CHECKPOINTS.slice(0, -1),
      REPLACEMENT_CHECKPOINTS[0],
    ]),
  ).toThrow();
});
