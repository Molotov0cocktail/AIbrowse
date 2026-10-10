import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../shared/watch/clock';
import { DigestScheduler } from './digest-scheduler';

describe('DigestScheduler', () => {
  it.each(['stop', 'maintenance'] as const)(
    '首个到期回调同步%s后不再消费下一项',
    async (boundary) => {
      const clock = new FakeClock(1000);
      const calls: string[] = [];
      const entries = ['a', 'b'].map((scheduleId) => ({
        scheduleId,
        expectedNextDueAt: new Date(0).toISOString(),
        timeZone: 'UTC',
      }));
      const scheduler = new DigestScheduler(
        clock,
        (entry) => {
          calls.push(entry.scheduleId);
          if (entry.scheduleId !== 'a') return;
          if (boundary === 'stop') scheduler.stop();
          else expect(scheduler.pauseForMaintenance(1)).toBe(true);
        },
        { startupHold: true },
      );
      scheduler.initialize(entries);
      scheduler.releaseStartup();
      clock.advanceTo(1000);
      expect(calls).toEqual(['a']);
      expect(clock.pendingTimerCount()).toBe(0);
      expect(scheduler.size).toBe(boundary === 'stop' ? 0 : 1);
      if (boundary === 'maintenance') {
        await scheduler.drainForMaintenance(1);
        expect(scheduler.prepareResumeAfterMaintenance(1, [entries[1]!])).toBe(true);
        expect(scheduler.resumeAfterMaintenance(1)).toBe(true);
        clock.advanceTo(1000);
        expect(calls).toEqual(['a', 'b']);
      }
    },
  );

  it('回调推迟另一到期项时旧fire不按旧值触发，其他due由新timer继续处理', () => {
    const clock = new FakeClock(1000);
    const calls: string[] = [];
    const scheduler = new DigestScheduler(clock, (entry) => {
      calls.push(entry.scheduleId);
      if (entry.scheduleId === 'a')
        scheduler.upsert({
          scheduleId: 'b',
          expectedNextDueAt: new Date(2000).toISOString(),
          timeZone: 'UTC',
        });
    });
    scheduler.initialize(
      ['a', 'b', 'c'].map((scheduleId) => ({
        scheduleId,
        expectedNextDueAt: new Date(0).toISOString(),
        timeZone: 'UTC',
      })),
    );
    clock.advanceTo(1000);
    expect(calls).toEqual(['a', 'c']);
    expect(scheduler.size).toBe(1);
    expect(clock.pendingTimerCount()).toBe(1);
    clock.advanceTo(2000);
    expect(calls).toEqual(['a', 'c', 'b']);
    expect(scheduler.size).toBe(0);
  });

  it('回调更新最后一项时旧fire不替换新timer', () => {
    const clock = new FakeClock(1000);
    const arm = vi.spyOn(clock, 'setTimeout');
    const scheduler = new DigestScheduler(clock, (entry) => {
      scheduler.upsert({ ...entry, expectedNextDueAt: new Date(2000).toISOString() });
    });
    scheduler.initialize([
      { scheduleId: 'a', expectedNextDueAt: new Date(0).toISOString(), timeZone: 'UTC' },
    ]);
    clock.advanceTo(1000);
    expect(arm).toHaveBeenCalledTimes(2);
    expect(clock.pendingTimerCount()).toBe(1);
    expect(scheduler.size).toBe(1);
    scheduler.stop();
  });

  it('按 due/scheduleId 全序提交冻结身份与 logicalDate', () => {
    const clock = new FakeClock(Date.parse('2026-08-31T00:00:00.000Z'));
    const onDue = vi.fn();
    const scheduler = new DigestScheduler(clock, onDue);
    scheduler.initialize([
      { scheduleId: 'b', expectedNextDueAt: '2026-08-31T01:00:00.000Z', timeZone: 'Asia/Shanghai' },
      { scheduleId: 'a', expectedNextDueAt: '2026-08-31T01:00:00.000Z', timeZone: 'Asia/Shanghai' },
    ]);
    clock.advanceTo(Date.parse('2026-08-31T01:00:00.000Z'));
    expect(onDue.mock.calls.map((call) => call[0].scheduleId)).toEqual(['a', 'b']);
    expect(onDue.mock.calls[0]![0].logicalDate).toBe('2026-08-31');
    expect(scheduler.size).toBe(0);
  });

  it('remove/stop 幂等并清理 timer', () => {
    const clock = new FakeClock(0);
    const onDue = vi.fn();
    const scheduler = new DigestScheduler(clock, onDue);
    scheduler.upsert({
      scheduleId: 'a',
      expectedNextDueAt: new Date(1000).toISOString(),
      timeZone: 'UTC',
    });
    scheduler.remove('a');
    scheduler.stop();
    scheduler.stop();
    clock.advanceTo(2000);
    expect(onDue).not.toHaveBeenCalled();
    expect(scheduler.isStopped).toBe(true);
  });
});
