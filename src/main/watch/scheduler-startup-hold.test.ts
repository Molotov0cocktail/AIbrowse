import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../shared/watch/clock';
import { DigestScheduler } from './digest-scheduler';
import { WatchScheduler } from './watch-scheduler';

function setup(kind: 'watch' | 'digest') {
  const clock = new FakeClock(1000);
  const callbacks: (() => void)[] = [];
  const originalSetTimeout = clock.setTimeout.bind(clock);
  const arm = vi.spyOn(clock, 'setTimeout').mockImplementation((callback, delay) => {
    callbacks.push(callback);
    return originalSetTimeout(callback, delay);
  });
  const due: string[] = [];
  if (kind === 'watch') {
    const scheduler = new WatchScheduler({
      clock,
      startupHold: true,
      onDue: (entries) => due.push(...entries.map((entry) => entry.ruleId)),
    });
    return {
      clock,
      callbacks,
      arm,
      due,
      scheduler,
      initialize: () => scheduler.initialize([{ ruleId: 'a', effectiveDueAt: 0 }]),
      upsert: () => scheduler.upsert({ ruleId: 'b', effectiveDueAt: 0 }),
      prepare: () =>
        scheduler.prepareResumeAfterMaintenance(1, [{ ruleId: 'b', effectiveDueAt: 0 }]),
    };
  }
  const entry = { scheduleId: 'b', expectedNextDueAt: new Date(0).toISOString(), timeZone: 'UTC' };
  const scheduler = new DigestScheduler(clock, (entry) => due.push(entry.scheduleId), {
    startupHold: true,
  });
  return {
    clock,
    callbacks,
    arm,
    due,
    scheduler,
    initialize: () => scheduler.initialize([{ ...entry, scheduleId: 'a' }]),
    upsert: () => scheduler.upsert(entry),
    prepare: () => scheduler.prepareResumeAfterMaintenance(1, [entry]),
  };
}

describe.each(['watch', 'digest'] as const)('%s 独立启动保持', (kind) => {
  it('initialize/upsert/remove 只维护索引，释放后恰好消费仍存在的到期项', () => {
    const s = setup(kind);
    s.initialize();
    s.upsert();
    s.scheduler.remove('a');
    s.clock.advanceTo(5000);
    expect(s.arm).not.toHaveBeenCalled();
    expect(s.due).toEqual([]);
    expect(s.scheduler.size).toBe(1);
    expect(s.scheduler.releaseStartup()).toBe(true);
    expect(s.scheduler.releaseStartup()).toBe(true);
    expect(s.arm).toHaveBeenCalledTimes(1);
    s.clock.advanceTo(5000);
    expect(s.due).toEqual(['b']);
    expect(s.scheduler.size).toBe(0);
  });

  it('维护恢复不暗中释放启动保持', async () => {
    const s = setup(kind);
    s.initialize();
    expect(s.scheduler.pauseForMaintenance(1)).toBe(true);
    await s.scheduler.drainForMaintenance(1);
    expect(s.prepare()).toBe(true);
    expect(s.scheduler.resumeAfterMaintenance(1)).toBe(true);
    s.clock.advanceTo(5000);
    expect(s.arm).not.toHaveBeenCalled();
    expect(s.due).toEqual([]);
    expect(s.scheduler.releaseStartup()).toBe(true);
    s.clock.advanceTo(5000);
    expect(s.due).toEqual(['b']);
  });

  it('释放启动保持不越过维护屏障', async () => {
    const s = setup(kind);
    s.initialize();
    expect(s.scheduler.pauseForMaintenance(1)).toBe(true);
    expect(s.scheduler.releaseStartup()).toBe(true);
    expect(s.arm).not.toHaveBeenCalled();
    await s.scheduler.drainForMaintenance(1);
    expect(s.prepare()).toBe(true);
    expect(s.scheduler.resumeAfterMaintenance(1)).toBe(true);
    s.clock.advanceTo(5000);
    expect(s.due).toEqual(['b']);
  });

  it('永久 stop 后不可释放或重建队列', () => {
    const s = setup(kind);
    s.initialize();
    s.scheduler.stop();
    expect(s.scheduler.releaseStartup()).toBe(false);
    s.upsert();
    s.initialize();
    s.clock.advanceTo(5000);
    expect(s.arm).not.toHaveBeenCalled();
    expect(s.scheduler.size).toBe(0);
    expect(s.due).toEqual([]);
  });

  it('已撤销的 timer 回调不能消费维护恢复后的新队列', async () => {
    const s = setup(kind);
    s.initialize();
    expect(s.scheduler.releaseStartup()).toBe(true);
    const revoked = s.callbacks[0]!;
    expect(s.scheduler.pauseForMaintenance(1)).toBe(true);
    revoked();
    expect(s.due).toEqual([]);
    await s.scheduler.drainForMaintenance(1);
    expect(s.prepare()).toBe(true);
    expect(s.scheduler.resumeAfterMaintenance(1)).toBe(true);
    revoked();
    expect(s.scheduler.size).toBe(1);
    expect(s.due).toEqual([]);
    s.clock.advanceTo(5000);
    expect(s.due).toEqual(['b']);
  });
});
