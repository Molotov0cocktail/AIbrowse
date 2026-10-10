import { describe, expect, it } from 'vitest';
import { isPing, isSample } from './ui-protocol';
import { Hold, ObservedPromise, enteredBeforeDone, observeMethod } from './controls';

describe('资格 UI 与原操作观察边界', () => {
  it('叶保持诊断区分未进入、取消未释放、已释放与原wait已结束，重复释放不改时间', async () => {
    const hold = new Hold();
    expect(hold.snapshot()).toEqual({
      enteredAt: null,
      releasedAt: null,
      settledAt: null,
      pending: false,
      aborted: false,
    });
    const controller = new AbortController();
    const original = hold.wait(controller.signal);
    const before = hold.snapshot();
    expect(before.enteredAt).not.toBeNull();
    expect(before.pending).toBe(true);
    controller.abort();
    expect(hold.snapshot()).toMatchObject({
      pending: true,
      aborted: true,
      releasedAt: null,
      settledAt: null,
    });
    hold.release.release();
    const released = hold.snapshot();
    expect(released.releasedAt).not.toBeNull();
    expect(released.pending).toBe(false);
    expect(released.settledAt).toBeNull();
    await original;
    const settled = hold.snapshot();
    expect(settled.settledAt).toBeGreaterThanOrEqual(settled.releasedAt!);
    hold.release.release();
    expect(hold.snapshot()).toEqual(settled);
    expect(before.pending).toBe(true);
  });
  it('UI 只有固定序号和时延，不接受 action/path/额外参数或非有限值', () => {
    expect(isPing({ sequence: 1 })).toBe(true);
    expect(isSample({ sequence: 1802, roundTripMs: 750 })).toBe(true);
    for (const value of [
      null,
      [],
      { sequence: 0 },
      { sequence: 1803 },
      { sequence: 1.1 },
      { sequence: 1, path: 'x' },
      { sequence: 1, action: 'resume' },
    ])
      expect(isPing(value)).toBe(false);
    for (const value of [
      { sequence: 1, roundTripMs: NaN },
      { sequence: 1, roundTripMs: Infinity },
      { sequence: 1, roundTripMs: -1 },
      { sequence: 1, roundTripMs: 0, action: 'read' },
    ])
      expect(isSample(value)).toBe(false);
  });
  it('诊断观察返回原 Promise，提前结束不能冒充 Provider 已进入', async () => {
    const hold = new Hold();
    const original = hold.wait();
    const owner = { runAsk: () => original };
    const observation = new ObservedPromise();
    observeMethod(owner, 'runAsk', observation);
    expect(owner.runAsk()).toBe(original);
    expect(observation.pending()).toBe(true);
    hold.release.release();
    await original;
    expect(observation.pending()).toBe(false);
    const early = new ObservedPromise();
    early.track(Promise.resolve());
    await expect(enteredBeforeDone(new Promise(() => undefined), early)).rejects.toThrow(
      '已经终结',
    );
  });
});
