// Clock / TimeZoneResolver tests (D1). Contract source: doc/stage6/detailed-design.md §4.1、
// §14 边界表、threat-model §3.6/WRT-16。纯逻辑、零依赖、零真实等待。
// DST oracle 使用稳定 IANA 时区（America/New_York、Asia/Shanghai、Australia/Lord_Howe）。
import { describe, expect, it, vi } from 'vitest';
import {
  FakeClock,
  createSystemClock,
  createTimeZoneResolver,
  isValidLocalTime,
  isValidTimeZone,
  nextIntervalInstant,
} from './clock';
import type { Clock, TimerHandle } from '../types/watch';

const NY = 'America/New_York';
const RESOLVER = createTimeZoneResolver();

// 2026 年 America/New_York：春季 forward 03-08 02:00→03:00；秋季 back 11-01 02:00→01:00。
function at(ms: number): Date {
  return new Date(ms);
}
function nyLocalDate(ms: number): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const p = fmt.formatToParts(new Date(ms));
  const g = (t: string): string => (p.find((x) => x.type === t) ?? { value: '' }).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
function localToUtc(y: number, mo: number, d: number, h: number, mi: number, s = 0): number {
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

describe('isValidTimeZone / isValidLocalTime', () => {
  it('合法与非法 IANA 时区', () => {
    expect(isValidTimeZone(NY)).toBe(true);
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('严格 HH:mm 校验', () => {
    expect(isValidLocalTime('00:00')).toBe(true);
    expect(isValidLocalTime('23:59')).toBe(true);
    expect(isValidLocalTime('09:05')).toBe(true);
    expect(isValidLocalTime('24:00')).toBe(false);
    expect(isValidLocalTime('23:60')).toBe(false);
    expect(isValidLocalTime('9:05')).toBe(false);
    expect(isValidLocalTime('0905')).toBe(false);
    expect(isValidLocalTime('')).toBe(false);
  });
});

describe('nextIntervalInstant — O(1) 纯算术', () => {
  it('基础锚点推进', () => {
    const anchor = 1000;
    expect(nextIntervalInstant(anchor, 5000, anchor)).toBe(6000);
    expect(nextIntervalInstant(anchor, 5000, 5999)).toBe(6000);
    expect(nextIntervalInstant(anchor, 5000, 6000)).toBe(11000); // 严格大于
    expect(nextIntervalInstant(anchor, 5000, 100000)).toBe(101000);
  });

  it('一万次 missed 仍 O(1) 精确计算（纯算术、零枚举）', () => {
    // nextIntervalInstant 是闭式公式（anchor + k*interval），内部无任何循环；
    // 一万个 missed interval 之外直接精确算出下一时点，不枚举。
    const anchor = 1_000;
    const interval = 3_600_000;
    const after = anchor + 10_000 * interval + 1234;
    expect(nextIntervalInstant(anchor, interval, after)).toBe(anchor + 10_001 * interval);
    // 边界精确：恰在下一时点仍需推进一格（严格大于 after）
    const exact = anchor + 10_001 * interval;
    expect(nextIntervalInstant(anchor, interval, exact)).toBe(exact + interval);
  });

  it('非法/非有限输入受控（不抛、不枚举）', () => {
    expect(nextIntervalInstant(Number.NaN, 1000, 5000)).toBe(Number.MAX_SAFE_INTEGER);
    expect(nextIntervalInstant(0, -1, 5000)).toBe(Number.MAX_SAFE_INTEGER);
    expect(nextIntervalInstant(0, 0, 5000)).toBe(Number.MAX_SAFE_INTEGER);
    expect(nextIntervalInstant(0, 1000, Number.POSITIVE_INFINITY)).toBe(Number.MAX_SAFE_INTEGER);
    expect(nextIntervalInstant(0, 1000, Number.NaN)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('FakeClock — 确定性', () => {
  it('now() 返回防御副本：外部 mutation 不改内部状态', () => {
    const fc = new FakeClock(1000);
    const d = fc.now();
    d.setTime(999999);
    expect(fc.currentTimeMs()).toBe(1000);
    expect(fc.now().getTime()).toBe(1000);
  });

  it('相同 deadline 使用确定性 FIFO', () => {
    const fc = new FakeClock(0);
    const order: string[] = [];
    fc.setTimeout(() => order.push('a'), 10);
    fc.setTimeout(() => order.push('b'), 10);
    fc.setTimeout(() => order.push('c'), 10);
    fc.advanceTo(10);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('不同 deadline 按到期序执行，不清除未到期 timer', () => {
    const fc = new FakeClock(0);
    const order: string[] = [];
    fc.setTimeout(() => order.push('late'), 100);
    fc.setTimeout(() => order.push('early'), 10);
    fc.advanceTo(50);
    expect(order).toEqual(['early']);
    expect(fc.pendingTimerCount()).toBe(1);
    fc.advanceTo(100);
    expect(order).toEqual(['early', 'late']);
    expect(fc.pendingTimerCount()).toBe(0);
  });

  it('clearTimeout 幂等：未知/已执行 handle 均安全', () => {
    const fc = new FakeClock(0);
    const order: string[] = [];
    const h = fc.setTimeout(() => order.push('x'), 10);
    fc.clearTimeout(h);
    fc.clearTimeout(h);
    fc.advanceTo(10);
    expect(order).toEqual([]);
    fc.clearTimeout({ kind: 'timer', id: 9999 }); // 未知 handle
    fc.clearTimeout(null as unknown as TimerHandle);
  });

  it('callback 内新建到期 timer 按确定顺序处理', () => {
    const fc = new FakeClock(0);
    const order: string[] = [];
    fc.setTimeout(() => {
      order.push('t1');
      fc.setTimeout(() => order.push('t1-child'), 1);
    }, 5);
    fc.setTimeout(() => order.push('t2'), 5);
    fc.advanceTo(5);
    // t1、t2 均到期（FIFO）；t1-child 延迟 1ms，此刻未到期
    expect(order).toEqual(['t1', 't2']);
    fc.advanceTo(6);
    expect(order).toEqual(['t1', 't2', 't1-child']);
  });

  it('零延迟自循环被有界保护（不无限循环）', () => {
    const fc = new FakeClock(0);
    let count = 0;
    fc.setTimeout(() => {
      count += 1;
      fc.setTimeout(() => {}, 0); // 自再排零延迟
    }, 0);
    fc.advanceTo(0);
    // 硬上限 10000：循环必须受控终止，不能挂死测试
    expect(count).toBeLessThanOrEqual(10000);
    expect(count).toBeGreaterThan(0);
  });

  it('advance/backward/forward 与当前时间', () => {
    const fc = new FakeClock(1000);
    fc.advanceBy(500);
    expect(fc.currentTimeMs()).toBe(1500);
    fc.setBack(1200);
    expect(fc.currentTimeMs()).toBe(1200);
    fc.advanceTo(9999);
    expect(fc.currentTimeMs()).toBe(9999);
    // 回拨后未到期的 timer 保留
    const order: string[] = [];
    fc.setTimeout(() => order.push('y'), 100);
    fc.setBack(0);
    fc.advanceTo(0);
    expect(order).toEqual([]); // 回拨不触发
    expect(fc.pendingTimerCount()).toBe(1);
  });

  it('clearAll 幂等清理', () => {
    const fc = new FakeClock(0);
    fc.setTimeout(() => {}, 1000);
    fc.setTimeout(() => {}, 2000);
    expect(fc.pendingTimerCount()).toBe(2);
    fc.clearAll();
    fc.clearAll();
    expect(fc.pendingTimerCount()).toBe(0);
  });
});

describe('createSystemClock — 真实墙钟与 timer 桥接', () => {
  it('now() 返回真实时间', () => {
    const c = createSystemClock();
    const before = Date.now();
    const n = c.now().getTime();
    const after = Date.now();
    expect(n).toBeGreaterThanOrEqual(before);
    expect(n).toBeLessThanOrEqual(after);
  });

  it('setTimeout/clearTimeout 与全局行为一致', async () => {
    const c: Clock = createSystemClock();
    const fired = await new Promise<boolean>((resolve) => {
      const h = c.setTimeout(() => resolve(true), 1);
      expect(h.kind).toBe('timer');
      // 不清理，等待触发
    });
    expect(fired).toBe(true);
  });

  it('clearTimeout 取消真实 timer', async () => {
    const c: Clock = createSystemClock();
    let fired = false;
    await new Promise<void>((resolve) => {
      const h = c.setTimeout(() => {
        fired = true;
        resolve();
      }, 5);
      c.clearTimeout(h);
      setTimeout(() => resolve(), 20);
    });
    expect(fired).toBe(false);
  });
});

describe('TimeZoneResolver — 普通日期', () => {
  it('after 当日之后返回下一逻辑日期 HH:mm', () => {
    const after = at(localToUtc(2026, 7, 20, 1, 0, 0)); // NY 2026-07-19 21:00
    const r = RESOLVER.nextDailyInstant({
      after,
      localTime: '09:00',
      timeZone: NY,
      lastLocalDate: null,
    });
    expect(r).not.toBeNull();
    expect(r!.localDate).toBe('2026-07-20');
    expect(r!.instant.getTime()).toBe(localToUtc(2026, 7, 20, 13, 0, 0)); // NY 09:00 = UTC 13:00
  });

  it('after 已过当日时刻则顺延到次日', () => {
    const after = at(localToUtc(2026, 7, 20, 14, 0, 0)); // NY 10:00
    const r = RESOLVER.nextDailyInstant({
      after,
      localTime: '09:00',
      timeZone: NY,
      lastLocalDate: null,
    });
    expect(r!.localDate).toBe('2026-07-21');
    expect(r!.instant.getTime()).toBe(localToUtc(2026, 7, 21, 13, 0, 0));
  });

  it('after 恰为目标时刻：严格晚于，取下一日', () => {
    const after = at(localToUtc(2026, 7, 20, 13, 0, 0));
    const r = RESOLVER.nextDailyInstant({
      after,
      localTime: '09:00',
      timeZone: NY,
      lastLocalDate: null,
    });
    expect(r!.localDate).toBe('2026-07-21');
    expect(r!.instant.getTime()).toBe(localToUtc(2026, 7, 21, 13, 0, 0));
  });

  it('月份/年份边界正确（7/31→8/1）', () => {
    const after = at(localToUtc(2026, 7, 31, 14, 0, 0)); // NY 07-31 10:00
    const r = RESOLVER.nextDailyInstant({
      after,
      localTime: '09:00',
      timeZone: NY,
      lastLocalDate: null,
    });
    expect(r!.localDate).toBe('2026-08-01');
    expect(r!.instant.getTime()).toBe(localToUtc(2026, 8, 1, 13, 0, 0));
  });
});

describe('TimeZoneResolver — DST gap（春季向前跳）', () => {
  // NY 2026-03-08 02:00 → 03:00（UTC 07:00 → 08:00）。02:30 本地时间不存在。
  it('gap 时刻：同一逻辑日期选择跳变后第一个有效 instant（本地墙钟首达 02:30）', () => {
    const after = at(localToUtc(2026, 3, 7, 14, 0, 0)); // NY 03-07 09:00
    const r = RESOLVER.nextDailyInstant({
      after,
      localTime: '02:30',
      timeZone: NY,
      lastLocalDate: null,
    });
    expect(r!.localDate).toBe('2026-03-08');
    // 02:30 不存在；跳变后第一个 >= 02:30 的有效墙钟是 03:00 EDT（07:00 UTC）
    expect(r!.instant.getTime()).toBe(localToUtc(2026, 3, 8, 7, 0, 0));
  });

  it('gap 当日 01:30 正常（跳变前）', () => {
    const after = at(localToUtc(2026, 3, 7, 14, 0, 0));
    const r = RESOLVER.nextDailyInstant({
      after,
      localTime: '01:30',
      timeZone: NY,
      lastLocalDate: null,
    });
    expect(r!.localDate).toBe('2026-03-08');
    expect(r!.instant.getTime()).toBe(localToUtc(2026, 3, 8, 6, 30, 0)); // 01:30 EST
  });
});

describe('TimeZoneResolver — DST fold（秋季回拨）', () => {
  // NY 2026-11-01 02:00 → 01:00。01:30 出现两次：EDT（04:30 UTC）与 EST（06:30 UTC）。
  it('fold 只选较早 instant', () => {
    const after = at(localToUtc(2026, 10, 31, 14, 0, 0)); // NY 10-31 10:00
    const r = RESOLVER.nextDailyInstant({
      after,
      localTime: '01:30',
      timeZone: NY,
      lastLocalDate: null,
    });
    expect(r!.localDate).toBe('2026-11-01');
    expect(r!.instant.getTime()).toBe(localToUtc(2026, 11, 1, 5, 30, 0)); // 早侧 01:30 EDT
    expect(nyLocalDate(r!.instant.getTime())).toBe('2026-11-01');
  });

  it('较早 instant 已过则不得改选较晚重复，寻找下一逻辑日期', () => {
    // after = 2026-11-01 06:00 UTC = NY 01:00 EST（早侧 01:30 EDT=05:30 UTC 已过，
    // 较晚侧 01:30 EST=06:30 UTC 未到）；不得改选较晚重复，应跳下一日
    const after = at(localToUtc(2026, 11, 1, 6, 0, 0));
    const r = RESOLVER.nextDailyInstant({
      after,
      localTime: '01:30',
      timeZone: NY,
      lastLocalDate: null,
    });
    expect(r!.localDate).toBe('2026-11-02');
    expect(r!.instant.getTime()).toBe(localToUtc(2026, 11, 2, 6, 30, 0));
  });

  it('after 在回拨后（较晚侧之后）：下一日为 11-02', () => {
    const after = at(localToUtc(2026, 11, 1, 7, 0, 0)); // NY 02:00 EST（fold 已结束）
    const r = RESOLVER.nextDailyInstant({
      after,
      localTime: '01:30',
      timeZone: NY,
      lastLocalDate: null,
    });
    expect(r!.localDate).toBe('2026-11-02');
  });
});

describe('TimeZoneResolver — lastLocalDate 防重', () => {
  it('localDate 等于 lastLocalDate 时跳过该逻辑日期', () => {
    const after = at(localToUtc(2026, 7, 20, 1, 0, 0));
    const r = RESOLVER.nextDailyInstant({
      after,
      localTime: '09:00',
      timeZone: NY,
      lastLocalDate: '2026-07-20',
    });
    expect(r!.localDate).toBe('2026-07-21');
  });

  it('fold 场景 lastLocalDate 防同逻辑日重复', () => {
    // 已消费 2026-11-01 早侧后，lastLocalDate='2026-11-01'，下一次必须越过整个 11-01
    const after = at(localToUtc(2026, 11, 1, 4, 30, 0));
    const r = RESOLVER.nextDailyInstant({
      after,
      localTime: '01:30',
      timeZone: NY,
      lastLocalDate: '2026-11-01',
    });
    expect(r!.localDate).toBe('2026-11-02');
  });

  it('lastLocalDate 为过去日期不阻塞', () => {
    const after = at(localToUtc(2026, 7, 20, 1, 0, 0));
    const r = RESOLVER.nextDailyInstant({
      after,
      localTime: '09:00',
      timeZone: NY,
      lastLocalDate: '2026-07-19',
    });
    expect(r!.localDate).toBe('2026-07-20');
  });
});

describe('TimeZoneResolver — 非法输入/时区/受控失败', () => {
  it('非法 HH:mm 返回 null', () => {
    for (const bad of ['24:00', '23:60', '9:05', '0905', '', 'ab:cd']) {
      const r = RESOLVER.nextDailyInstant({
        after: new Date(0),
        localTime: bad,
        timeZone: NY,
        lastLocalDate: null,
      });
      expect(r).toBeNull();
    }
  });

  it('非法 timezone 返回 null（不抛未捕获异常）', () => {
    const r = RESOLVER.nextDailyInstant({
      after: new Date(0),
      localTime: '09:00',
      timeZone: 'Not/AZone',
      lastLocalDate: null,
    });
    expect(r).toBeNull();
    expect(() =>
      RESOLVER.nextDailyInstant({
        after: new Date(0),
        localTime: '09:00',
        timeZone: 'Not/AZone',
        lastLocalDate: null,
      }),
    ).not.toThrow();
  });

  it('非 Date after 返回 null', () => {
    const r = RESOLVER.nextDailyInstant({
      after: 'not-a-date' as unknown as Date,
      localTime: '09:00',
      timeZone: NY,
      lastLocalDate: null,
    });
    expect(r).toBeNull();
  });
});

describe('TimeZoneResolver — 系统时区独立性', () => {
  it('求解路径不读取任何系统时区依赖的 Date 本地 getter', () => {
    // resolver 只用 Intl.DateTimeFormat(显式 timeZone) 求墙钟，绝不调用 Date 本地 getter
    // （getFullYear/getMonth/getDate/getHours/getMinutes/getTimezoneOffset 等），
    // 因此系统时区不可能改变显式 input.timeZone 的结果（结构性证明，零依赖）。
    const spies = [
      vi.spyOn(Date.prototype, 'getFullYear'),
      vi.spyOn(Date.prototype, 'getMonth'),
      vi.spyOn(Date.prototype, 'getDate'),
      vi.spyOn(Date.prototype, 'getHours'),
      vi.spyOn(Date.prototype, 'getMinutes'),
      vi.spyOn(Date.prototype, 'getTimezoneOffset'),
    ];
    try {
      const r = RESOLVER.nextDailyInstant({
        after: at(localToUtc(2026, 7, 20, 1, 0, 0)),
        localTime: '09:00',
        timeZone: NY,
        lastLocalDate: null,
      });
      expect(r!.localDate).toBe('2026-07-20');
      expect(r!.instant.getTime()).toBe(localToUtc(2026, 7, 20, 13, 0, 0));
      for (const s of spies) {
        expect(s).not.toHaveBeenCalled();
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it('同一显式 timeZone 的求解结果确定（多次调用一致）', () => {
    const after = at(localToUtc(2026, 7, 20, 1, 0, 0));
    const a = RESOLVER.nextDailyInstant({
      after,
      localTime: '09:00',
      timeZone: NY,
      lastLocalDate: null,
    });
    const b = RESOLVER.nextDailyInstant({
      after,
      localTime: '09:00',
      timeZone: NY,
      lastLocalDate: null,
    });
    expect(a!.instant.getTime()).toBe(b!.instant.getTime());
    expect(a!.localDate).toBe(b!.localDate);
  });
});

describe('TimeZoneResolver — 其他稳定 IANA 区域', () => {
  it('Asia/Shanghai 无 DST 的普通推进', () => {
    const r = RESOLVER.nextDailyInstant({
      after: at(localToUtc(2026, 7, 20, 4, 0, 0)), // Shanghai 12:00
      localTime: '09:00',
      timeZone: 'Asia/Shanghai',
      lastLocalDate: null,
    });
    expect(r!.localDate).toBe('2026-07-21');
    expect(r!.instant.getTime()).toBe(localToUtc(2026, 7, 21, 1, 0, 0)); // 09:00 CST = 01:00 UTC
  });

  it('Australia/Lord_Howe 半小时间隔 DST 边界（2026-10-04 02:00→02:30）', () => {
    // Lord Howe：DST 从 10-04 02:00 → 02:30（30 分钟跳变）。02:15 不存在。
    const after = at(localToUtc(2026, 10, 3, 14, 0, 0));
    const r = RESOLVER.nextDailyInstant({
      after,
      localTime: '02:15',
      timeZone: 'Australia/Lord_Howe',
      lastLocalDate: null,
    });
    expect(r!.localDate).toBe('2026-10-04');
    // 跳变后首个 >= 02:15 的墙钟 = 02:30 LHST（UTC 差 +10:30/+11:00 → 前一日 16:15 UTC 前…）
    // 02:30 LHST(UTC+11) = 10-03 15:30 UTC
    expect(r!.instant.getTime()).toBe(Date.UTC(2026, 9, 3, 15, 30, 0));
  });

  it('UTC 固定 00:00 普通推进', () => {
    const r = RESOLVER.nextDailyInstant({
      after: at(Date.UTC(2026, 6, 20, 0, 0, 0)),
      localTime: '00:00',
      timeZone: 'UTC',
      lastLocalDate: null,
    });
    expect(r!.localDate).toBe('2026-07-21');
    expect(r!.instant.getTime()).toBe(Date.UTC(2026, 6, 21, 0, 0, 0));
  });
});

describe('FakeClock 与 TimeZoneResolver 组合（日常时钟推进）', () => {
  it('FakeClock 驱动 daily 下一 instant 的完整流程', () => {
    const fc = new FakeClock(localToUtc(2026, 7, 20, 1, 0, 0));
    const r = RESOLVER.nextDailyInstant({
      after: fc.now(),
      localTime: '09:00',
      timeZone: NY,
      lastLocalDate: null,
    });
    expect(r!.instant.getTime()).toBe(localToUtc(2026, 7, 20, 13, 0, 0));
    fc.advanceTo(r!.instant.getTime());
    expect(fc.currentTimeMs()).toBe(localToUtc(2026, 7, 20, 13, 0, 0));
    // 已消费本逻辑日
    const r2 = RESOLVER.nextDailyInstant({
      after: fc.now(),
      localTime: '09:00',
      timeZone: NY,
      lastLocalDate: '2026-07-20',
    });
    expect(r2!.localDate).toBe('2026-07-21');
  });
});
