import { describe, expect, it } from 'vitest';
import { QualificationQpcClock, formatQpcTicks, parseQpcTicks } from './qpc';
import { QualificationPausableClock } from './pausable-clock';

describe('资格 QPC：固定UTC锚点与整数tick边界', () => {
  it('暂停前已排队的旧timer回调不能穿过冻结或在恢复后重复执行', () => {
    let now = 1000;
    let serial = 0;
    const callbacks: (() => void)[] = [];
    const live = new Set<string>();
    const clock = new QualificationPausableClock(
      {
        now: () => new Date(now),
        setTimeout: (callback) => {
          callbacks.push(callback);
          return { kind: 'timer', id: callbacks.length };
        },
        clearTimeout: () => {},
      },
      {
        register: () => {
          const id = String(++serial);
          live.add(id);
          return id;
        },
        unregister: (id) => {
          expect(live.delete(id)).toBe(true);
        },
      },
    );
    let calls = 0;
    clock.forOwner('coordinator').setTimeout(() => {
      calls++;
    }, 50);
    const stale = callbacks[0]!;
    clock.pause();
    stale();
    expect(calls).toBe(0);
    expect(live.size).toBe(0);
    now = 2000;
    clock.resume();
    stale();
    expect(calls).toBe(0);
    callbacks[1]!();
    stale();
    callbacks[1]!();
    expect(calls).toBe(1);
    expect(live.size).toBe(0);
  });
  it('只用QPC推进时间，向上取整UTC到tick且误差小于1tick', () => {
    let ticks = 1000000n;
    const clock = new QualificationQpcClock(
      { readQpc: () => ({ ticks: formatQpcTicks(ticks), frequency: 3579545 }) },
      3579545,
      formatQpcTicks(ticks),
      10000,
    );
    const deadline = parseQpcTicks(clock.ticksForUtc(10001));
    expect(deadline - ticks).toBe(3580n);
    expect((deadline - ticks) * 1000n).toBeGreaterThanOrEqual(3579545n);
    expect((deadline - ticks - 1n) * 1000n).toBeLessThan(3579545n);
    ticks += 3579545n;
    expect(clock.now().getTime()).toBe(11000);
    expect(clock.ticksForUtc(9999)).toBe(formatQpcTicks(996421n));
  });
  it('倒退、频率漂移、非规范hex与溢出fail-closed', () => {
    let ticks = 10n;
    let frequency = 1000;
    const clock = new QualificationQpcClock(
      { readQpc: () => ({ ticks: formatQpcTicks(ticks), frequency }) },
      frequency,
      formatQpcTicks(ticks),
      0,
    );
    ticks = 11n;
    clock.readTicks();
    ticks = 10n;
    expect(() => clock.readTicks()).toThrow();
    ticks = 12n;
    frequency = 1001;
    expect(() => clock.readTicks()).toThrow();
    for (const value of [
      '1',
      '000000000000000A',
      '8000000000000000',
      '-000000000000001',
      '000000000000000g',
    ])
      expect(() => parseQpcTicks(value)).toThrow();
    expect(() => formatQpcTicks(-1n)).toThrow();
    expect(() => formatQpcTicks(0x8000000000000000n)).toThrow();
  });
  it('时限按整数余量保守判断，不以浮点四舍五入越过边界', () => {
    const clock = new QualificationQpcClock(
      { readQpc: () => ({ ticks: formatQpcTicks(1000n), frequency: 1000 }) },
      1000,
      formatQpcTicks(1000n),
      0,
    );
    expect(clock.within(formatQpcTicks(1000n), formatQpcTicks(1249n), 250)).toBe(true);
    expect(clock.within(formatQpcTicks(1000n), formatQpcTicks(1250n), 250)).toBe(false);
    expect(clock.within(formatQpcTicks(1001n), formatQpcTicks(1000n), 250)).toBe(false);
    expect(() => clock.elapsedMs(formatQpcTicks(2n), formatQpcTicks(1n))).toThrow();
    expect(() => clock.addMs(formatQpcTicks(1n), -1)).toThrow();
  });
});
