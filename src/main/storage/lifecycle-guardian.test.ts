import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGuardianSession } from './lifecycle-guardian';

const nonce = 'a'.repeat(32);
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const frames: string[] = [];
  const session = createGuardianSession({
    nonce,
    send: (frame) => frames.push(frame),
    timeoutMs: 100,
  });
  return { frames, session };
}

describe('进程生命周期授权协议', () => {
  it.each(['ready', 'authorize', 'retire', 'relaunch', 'finish'] as const)(
    '%s的ACK后同批坏帧不能通过promise交接',
    async (kind) => {
      const f = fixture();
      f.session.receive(`1|${nonce}|0|ready`);
      let result = f.session.ready;
      if (kind !== 'ready') {
        await result;
        result =
          kind === 'authorize'
            ? f.session.handle.authorizeUtility({ pid: 42, role: 'probe' })
            : kind === 'retire'
              ? f.session.handle.confirmUtilityExit(42)
              : kind === 'finish'
                ? f.session.handle.finishShutdown()
                : f.session.handle.requestRelaunch();
        f.session.receive(`1|${nonce}|1|ok`);
      }
      f.session.receive('invalid');
      await expect(result).rejects.toThrow();
      expect(() => f.session.assertCurrent()).toThrow();
    },
  );
  it.each(['ready', 'authorize', 'retire', 'relaunch', 'finish'] as const)(
    '%s的ACK已resolve但交接前过期仍失败',
    async (kind) => {
      let now = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const f = fixture();
      f.session.receive(`1|${nonce}|0|ready`);
      let result = f.session.ready;
      if (kind !== 'ready') {
        await result;
        result =
          kind === 'authorize'
            ? f.session.handle.authorizeUtility({ pid: 42, role: 'probe' })
            : kind === 'retire'
              ? f.session.handle.confirmUtilityExit(42)
              : kind === 'finish'
                ? f.session.handle.finishShutdown()
                : f.session.handle.requestRelaunch();
        f.session.receive(`1|${nonce}|1|ok`);
      }
      now = 101;
      await expect(result).rejects.toThrow();
      expect(() => f.session.assertCurrent()).toThrow();
    },
  );
  it('finish开始即封新授权，只有同序号ACK才确认正常关闭许可', async () => {
    const f = fixture();
    f.session.receive(`1|${nonce}|0|ready`);
    await f.session.ready;
    const finishing = f.session.handle.finishShutdown();
    await expect(f.session.handle.authorizeUtility({ pid: 42, role: 'probe' })).rejects.toThrow();
    expect(f.frames).toEqual([`1|${nonce}|1|finish\n`]);
    f.session.receive(`1|${nonce}|1|ok`);
    await finishing;
    f.session.close();
  });
  it('ready及utility授权必须等待同nonce同序号的原生ACK', async () => {
    const f = fixture();
    let ready = false;
    void f.session.ready.then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    f.session.receive(`1|${nonce}|0|ready`);
    await f.session.ready;
    const permit = f.session.handle.authorizeUtility({ pid: 42, role: 'probe' });
    expect(f.frames).toEqual([`1|${nonce}|1|authorize|probe|42\n`]);
    let allowed = false;
    void permit.then(() => {
      allowed = true;
    });
    await Promise.resolve();
    expect(allowed).toBe(false);
    f.session.receive(`1|${nonce}|1|ok`);
    await permit;
    expect(allowed).toBe(true);
    f.session.close();
  });
  it('错误nonce及迟到ACK永久失败，不重新开放', async () => {
    const f = fixture();
    const ready = expect(f.session.ready).rejects.toThrow();
    f.session.receive(`1|${'b'.repeat(32)}|0|ready`);
    await ready;
    f.session.receive(`1|${nonce}|0|ready`);
    await expect(
      f.session.handle.authorizeUtility({ pid: 42, role: 'transfer' }),
    ).rejects.toThrow();
    expect(f.frames).toHaveLength(0);
  });
  it('shutdown禁止新授权，但仍允许确认实际退出和固定重启意图', async () => {
    const f = fixture();
    f.session.receive(`1|${nonce}|0|ready`);
    await f.session.ready;
    f.session.handle.beginShutdown();
    await expect(f.session.handle.authorizeUtility({ pid: 42, role: 'probe' })).rejects.toThrow();
    const restart = f.session.handle.requestRelaunch();
    f.session.receive(`1|${nonce}|1|ok`);
    await restart;
    f.session.close();
  });
  it('通道退出触发失败一次且pending授权不能通过', async () => {
    const f = fixture();
    f.session.receive(`1|${nonce}|0|ready`);
    await f.session.ready;
    const failed = vi.fn();
    f.session.handle.onFailure(failed);
    const permit = f.session.handle.authorizeUtility({ pid: 42, role: 'probe' });
    const rejected = expect(permit).rejects.toThrow();
    f.session.close();
    f.session.close();
    await rejected;
    expect(failed).toHaveBeenCalledTimes(1);
    f.session.receive(`1|${nonce}|1|ok`);
    await expect(f.session.handle.confirmUtilityExit(42)).rejects.toThrow();
  });
  it('shutdown发生于登记期间，迟到ACK仍不得授init但可退休实际已退出utility', async () => {
    const f = fixture();
    f.session.receive(`1|${nonce}|0|ready`);
    await f.session.ready;
    const permit = f.session.handle.authorizeUtility({ pid: 42, role: 'probe' });
    f.session.handle.beginShutdown();
    f.session.receive(`1|${nonce}|1|ok`);
    await expect(permit).rejects.toThrow();
    const retired = f.session.handle.confirmUtilityExit(42);
    f.session.receive(`1|${nonce}|2|ok`);
    await retired;
    f.session.close();
  });
  it('超时不续租；越界PID、额外字段和超长帧拒绝', async () => {
    const f = fixture();
    const ready = expect(f.session.ready).rejects.toThrow();
    f.session.receive('x'.repeat(4097));
    await ready;
    const g = fixture();
    g.session.receive(`1|${nonce}|0|ready`);
    await g.session.ready;
    await expect(g.session.handle.authorizeUtility({ pid: -1, role: 'probe' })).rejects.toThrow();
    const pending = g.session.handle.authorizeUtility({ pid: 42, role: 'probe' });
    await expect(pending).rejects.toThrow();
    g.session.receive(`1|${nonce}|1|ok`);
    await expect(g.session.handle.requestRelaunch()).rejects.toThrow();
  });
});
