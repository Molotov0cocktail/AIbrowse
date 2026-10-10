import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile, copyFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { superviseProcess } from './replacement-crash/supervisor';
import { REPLACEMENT_CHECKPOINTS } from './replacement-crash/contracts';
import { BoundaryChannel } from './replacement-crash/boundary-channel';
import {
  createFixture,
  inspectFixture,
  reopenFixture,
  runWriter,
} from './replacement-crash/fixture';
import { DatasetReplacement } from '../../src/main/storage/dataset-replacement';

const evidence = resolve('log/stage7-e2/replacement-crash-independent-review-001');

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function childPort(kill: () => boolean = () => true): {
  child: ChildProcess;
  events: EventEmitter;
} {
  const events = new EventEmitter();
  Object.assign(events, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    send: vi.fn((_message: unknown, callback?: (error: Error | null) => void) => callback?.(null)),
    kill: vi.fn(kill),
  });
  return { events, child: events as unknown as ChildProcess };
}

it('独审：同步spawn消耗计入一次工作截止，不从spawn返回后重获8秒', async () => {
  vi.useFakeTimers();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const port = childPort();
  const result = superviseProcess(() => {
    now = 8_001;
    return port.child;
  }, null);
  const assertion = expect(result).rejects.toThrow();
  port.events.emit('message', { kind: 'result', state: 'normal' });
  port.events.emit('exit', 0, null);
  port.events.emit('close', 0, null);
  await assertion;
});

it('独审：工作timer延迟派发时，超出单调截止的result和exit不能授PASS', async () => {
  vi.useFakeTimers();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const port = childPort();
  const result = superviseProcess(() => port.child, null);
  const assertion = expect(result).rejects.toThrow();
  now = 8_001;
  port.events.emit('message', { kind: 'result', state: 'normal' });
  port.events.emit('exit', 0, null);
  port.events.emit('close', 0, null);
  await assertion;
});

it('独审：退出timer延迟派发时，超过原2秒的exit不能授中断PASS', async () => {
  vi.useFakeTimers();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const port = childPort();
  const result = superviseProcess(() => port.child, REPLACEMENT_CHECKPOINTS[0]);
  const assertion = expect(result).rejects.toThrow();
  now = 100;
  port.events.emit('message', { kind: 'boundary', point: REPLACEMENT_CHECKPOINTS[0] });
  now = 2_101;
  port.events.emit('exit', null, 'SIGKILL');
  port.events.emit('close', null, 'SIGKILL');
  await assertion;
});

it.each(['false', 'throw'] as const)(
  '独审：kill %s后观察到自然失败退出仍不能算目标强杀成功',
  async (mode) => {
    const port = childPort(() => {
      if (mode === 'throw') throw new Error('合成kill错误');
      return false;
    });
    const result = superviseProcess(() => port.child, REPLACEMENT_CHECKPOINTS[0]);
    const assertion = expect(result).rejects.toThrow();
    port.events.emit('message', { kind: 'boundary', point: REPLACEMENT_CHECKPOINTS[0] });
    port.events.emit('exit', 1, null);
    port.events.emit('close', 1, null);
    await assertion;
  },
);

it('独审：持续边界不会续租工作timer', async () => {
  vi.useFakeTimers();
  const port = childPort();
  const result = superviseProcess(() => port.child, null);
  const assertion = expect(result).rejects.toThrow('工作期限');
  for (let i = 0; i < 7; i += 1) {
    await vi.advanceTimersByTimeAsync(1_000);
    port.events.emit('message', { kind: 'boundary', point: REPLACEMENT_CHECKPOINTS[0] });
  }
  await vi.advanceTimersByTimeAsync(1_000);
  expect(port.child.kill).toHaveBeenCalledOnce();
  port.events.emit('exit', null, 'SIGKILL');
  port.events.emit('close', null, 'SIGKILL');
  await assertion;
});

it('独审：exit后尚未close的stdout尾部仍受4KiB门限制', async () => {
  const port = childPort();
  const result = superviseProcess(() => port.child, null);
  const assertion = expect(result).rejects.toThrow();
  port.events.emit('message', { kind: 'result', state: 'normal' });
  port.events.emit('exit', 0, null);
  port.child.stdout?.emit('data', Buffer.alloc(4_097));
  port.events.emit('close', 0, null);
  await assertion;
});

it.each([true, false])(
  '独审：kill同步触发exit与close时，必须等kill返回%s再结算',
  async (accepted) => {
    const port = childPort(() => {
      port.events.emit('exit', null, 'SIGKILL');
      port.events.emit('close', null, 'SIGKILL');
      return accepted;
    });
    const result = superviseProcess(() => port.child, REPLACEMENT_CHECKPOINTS[0]);
    const assertion = accepted
      ? expect(result).resolves.toMatchObject({ killed: true, signal: 'SIGKILL' })
      : expect(result).rejects.toThrow('强杀请求返回false');
    port.events.emit('message', { kind: 'boundary', point: REPLACEMENT_CHECKPOINTS[0] });
    await assertion;
  },
);

it('独审：ack在发送回调完成前同步到达仍保留，双pause不能共用一个等待者', async () => {
  const channel = new BoundaryChannel();
  let finishSend: (() => void) | undefined;
  const pending = channel.pause(
    () =>
      new Promise<void>((done) => {
        finishSend = done;
      }),
  );
  await expect(channel.pause(async () => {})).rejects.toThrow('状态非法');
  channel.accept('continue');
  finishSend?.();
  await pending;
});

async function freshFixture(): Promise<string> {
  await mkdir(evidence, { recursive: true });
  return join(evidence, `fixture-${randomUUID().replaceAll('-', '')}`);
}

it('独审：正常小SQLite控制和重开保留四类old/new及opaque active', async () => {
  const root = await freshFixture();
  await runWriter(root, () => {});
  await expect(reopenFixture(root)).resolves.toBe('normal');
  await expect(inspectFixture(root, 'normal')).resolves.toMatchObject({
    completeOldCopies: 8,
    completeNewCopies: 4,
  });
});

it.each(['corrupt-old', 'duplicate-opaque', 'missing-new', 'canary'] as const)(
  '独审：oracle拒绝%s',
  async (kind) => {
    const root = await freshFixture();
    await runWriter(root, () => {});
    const operation = join(root, 'data-transfer', 'a'.repeat(32));
    if (kind === 'corrupt-old') await writeFile(join(operation, 'retired', 'sources'), 'corrupt');
    if (kind === 'duplicate-opaque')
      await copyFile(
        join(operation, 'evidence', 'active.json'),
        join(root, 'data-transfer', 'active.json'),
      );
    if (kind === 'missing-new') await unlink(join(root, 'watch', 'watch.db'));
    if (kind === 'canary') await writeFile(join(root, 'qualification-side-branch.bin'), 'changed');
    await expect(inspectFixture(root, 'normal')).rejects.toThrow();
  },
);

it('独审：创建中空gate和已flush完整gate均触发恢复门并保全旧数据', async () => {
  for (const point of REPLACEMENT_CHECKPOINTS.slice(0, 2)) {
    const root = await freshFixture();
    const { scope } = await createFixture(root);
    const replacement = new DatasetReplacement(scope, {
      check() {},
      requireRollbackSpace() {},
      assertNoWriters() {},
      boundary(current) {
        if (current === point) throw new Error('合成边界中止');
      },
    });
    await expect(replacement.prepare()).rejects.toThrow();
    expect((await readFile(join(root, 'data-transfer', 'recovery-gate'))).length).toBe(
      point === REPLACEMENT_CHECKPOINTS[0] ? 0 : 26,
    );
    await expect(reopenFixture(root)).resolves.toBe('recovery-required');
    await expect(inspectFixture(root, 'recovery-required')).resolves.toMatchObject({
      completeOldCopies: 4,
      completeNewCopies: 4,
    });
  }
});
