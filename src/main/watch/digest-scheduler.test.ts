import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../shared/watch/clock';
import { DigestScheduler } from './digest-scheduler';

describe('DigestScheduler', () => {
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
