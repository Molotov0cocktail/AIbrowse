import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from './contract';
import { superviseChild, type ChildLike } from './supervisor';

class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  connected = true;
  kills = 0;
  kill(): boolean {
    this.kills++;
    return true;
  }
  close(code: number | null, signal: NodeJS.Signals | null): void {
    this.connected = false;
    this.emit('close', code, signal);
  }
}
function terminal() {
  return {
    kind: 'result',
    result: {
      scene: 'normal',
      action: 'initial',
      state: 'committed',
      code: 'ok',
      journalPhase: 'committed',
      rollbackCopyRemaining: 0,
      rollbackCopyBudget: 0,
      selected: 0,
      waitedMs: 0,
      rollbackSpaceCalls: 1,
      rollbackSpaceBytes: 4096,
    },
    runtime: {
      nodePath: 'fixed-node',
      nodeVersion: 'v24.18.0',
      workerPath: 'fixed-worker',
      workerSha256: 'a'.repeat(64),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('worker监督器', () => {
  it('必须同时收到exit和close，不能凭终态或exit提前变绿', async () => {
    const child = new FakeChild();
    let settled = false;
    const observed = superviseChild(() => child, LIMITS.controlOrReopenMs).then((value) => {
      settled = true;
      return value;
    });
    child.emit('message', terminal());
    child.emit('exit', 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.close(0, null);
    await expect(observed).resolves.toMatchObject({ exitObserved: true, closeObserved: true });
  });

  it('exit后的迟到error在close前到达时必须失败', async () => {
    const child = new FakeChild();
    const observed = superviseChild(() => child, LIMITS.controlOrReopenMs);
    child.emit('message', terminal());
    child.emit('exit', 0, null);
    child.emit('error', new Error('late'));
    child.close(0, null);
    await expect(observed).rejects.toThrow('worker进程错误');
  });

  it('超限IPC帧会撤销worker且不能由随后exit0覆盖', async () => {
    const child = new FakeChild();
    const observed = superviseChild(() => child, LIMITS.controlOrReopenMs);
    child.emit('message', { kind: 'selected', phase: 'x'.repeat(LIMITS.frameBytes) });
    expect(child.kills).toBe(1);
    child.emit('exit', 0, null);
    child.close(0, null);
    await expect(observed).rejects.toThrow('worker帧校验失败');
  });

  it('工作期限触发强杀但仍要求实际exit和close', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const observed = superviseChild(() => child, LIMITS.controlOrReopenMs);
    const rejected = observed.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(LIMITS.controlOrReopenMs);
    expect(child.kills).toBe(1);
    child.emit('exit', null, 'SIGKILL');
    child.close(null, 'SIGKILL');
    expect(String(await rejected)).toContain('工作期限耗尽');
  });

  it.each(['factory', 'callback'] as const)(
    '%s耗时越过绝对工作截止时不能被迟到终态授绿',
    async (location) => {
      vi.useFakeTimers();
      let now = 100;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const child = new FakeChild();
      const observed = superviseChild(() => {
        if (location === 'factory') now += LIMITS.controlOrReopenMs + 1;
        return child;
      }, LIMITS.controlOrReopenMs);
      if (location === 'callback') now += LIMITS.controlOrReopenMs + 1;
      child.emit('message', terminal());
      child.emit('exit', 0, null);
      child.close(0, null);
      await expect(observed).rejects.toBeInstanceOf(Error);
    },
  );

  it.each([0, 2])('exit%d后缺close必须在原预算内拒绝', async (code) => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const observed = superviseChild(() => child, LIMITS.controlOrReopenMs);
    const rejected = observed.catch((error: unknown) => error);
    child.emit('message', terminal());
    child.emit('exit', code, null);
    await vi.advanceTimersByTimeAsync(LIMITS.controlOrReopenMs + LIMITS.childExitMs + 1);
    expect(String(await rejected)).toContain('close');
    child.close(code, null);
  });

  it('强杀后始终没有exit/close必须在退出门拒绝', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const observed = superviseChild(() => child, LIMITS.controlOrReopenMs);
    const rejected = observed.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(LIMITS.controlOrReopenMs + LIMITS.childExitMs + 1);
    expect(child.kills).toBe(1);
    expect(String(await rejected)).toContain('实际exit/close未确认');
  });
});
