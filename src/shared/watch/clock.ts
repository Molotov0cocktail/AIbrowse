// Watch Clock / TimeZoneResolver — deterministic time & timer base (D1).
// Contract source: doc/stage6/detailed-design.md §4.1 (Clock/TimeZone 接口)、
// §2 (MAX_LOG_* 与字符串预算仅日志用，本模块不依赖)、threat-model §3.6/WRT-16。
// 纯逻辑 + Node/Intl 既有能力，零新依赖、零网络、零 DB、零 D2+ 域类型。
// 分层纪律：本模块不依赖 logger、Electron、任何 IO。

import type { Clock, TimerHandle, TimeZoneResolver } from '../types/watch';

// ---------------------------------------------------------------------------
// 常量（detailed-design §4.1 / §14 冻结）
// ---------------------------------------------------------------------------

// 非法时间/时区/无法安全求解时返回 null 的受控出口（fail-closed，不回显敌手正文）。
// localTime 必须严格 HH:mm（00:00..23:59）。IANA 时区经 Intl 构造验证。
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAILY_WINDOW_DAYS = 4; // 探索带：最长 3 日即穷尽全部合法目标逻辑日期（含 gap/fold/回拨）
const MS_PER_HOUR = 3_600_000;

/** IANA 时区 id 验证：Intl 构造失败视为非法（RangeError 由构造验证，不捕获伪造文本）。 */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** 严格 HH:mm 24 小时制（00:00..23:59）校验。 */
export function isValidLocalTime(localTime: string): boolean {
  return LOCAL_TIME_PATTERN.test(localTime);
}

/**
 * interval 下一时点 O(1) 计算：严格大于 after 的第一个
 * `anchor + k * intervalMs`（k 为正整数，最小 k=1，即最小合法候选为 anchor+interval）。
 * 纯算术，禁止枚举 missed intervals。after 早于 anchor 时不产生锚点之前的伪 slot：
 * 此时 k 钳制到 1，返回 anchor+interval（anchor 本身 k=0 不在候选集合）。
 * 结果恒为有限 number，绝不返回 Infinity/NaN（防御性钳制）。
 */
export function nextIntervalInstant(anchor: number, intervalMs: number, after: number): number {
  if (!Number.isFinite(anchor) || !Number.isFinite(intervalMs) || !Number.isFinite(after)) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (intervalMs <= 0) return Number.MAX_SAFE_INTEGER;
  // after < anchor 时 floor 为负 → k 钳制到 1，避免锚点之前的伪 slot。
  const k = Math.max(1, Math.floor((after - anchor) / intervalMs) + 1);
  const candidate = anchor + k * intervalMs;
  if (!Number.isFinite(candidate) || candidate <= after) {
    // 溢出或边界异常：回退到不会枚举的超大有限哨兵（调用方/Clock 不得等待该值）
    return Number.MAX_SAFE_INTEGER;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// production Clock（真实墙钟 + 全局 setTimeout/clearTimeout）
// ---------------------------------------------------------------------------

/** 确定性与真实时间分离（§4.1）：now() 返回每次调用时的真实时刻副本。 */
export function createSystemClock(): Clock {
  return {
    now(): Date {
      return new Date();
    },
    setTimeout(callback: () => void, delayMs: number): TimerHandle {
      const raw = globalThis.setTimeout(callback, delayMs);
      return { kind: 'timer', id: Number(raw) };
    },
    clearTimeout(handle: TimerHandle): void {
      // 共享模块不依赖 NodeJS.Timeout（renderer 亦使用本类型）；handle.id 是原始数值 id。
      globalThis.clearTimeout(
        handle.id as unknown as Parameters<typeof globalThis.clearTimeout>[0],
      );
    },
  };
}

// ---------------------------------------------------------------------------
// FakeClock（确定、零真实等待；相同 deadline FIFO；幂等 clear）
// ---------------------------------------------------------------------------

interface FakeTimer {
  id: number;
  atMs: number;
  callback: () => void;
}

const FAKE_MAX_PENDING = 10_000; // 防无界循环/无界 timer 累积的硬上限（受控失败）

/**
 * 确定性 FakeClock：now() 只反映 push 的绝对值；advance 按 FIFO 顺序执行到期 callback。
 * clearTimeout/清理对未知或已执行 handle 幂等。callback 新建的到期 timer 在同一
 * advance 中按确定顺序处理，并有防无界循环保护。返回的 now() Date 为防御性副本，
 * 外部 mutation 不能改变内部 FakeClock 状态。
 */
export class FakeClock implements Clock {
  private timers: FakeTimer[] = [];
  private nextId = 1;
  private nowMs: number;

  constructor(now = 0) {
    this.nowMs = now;
  }

  now(): Date {
    return new Date(this.nowMs);
  }

  /** 当前内部绝对毫秒（测试断言用）。 */
  currentTimeMs(): number {
    return this.nowMs;
  }

  /** 外部提供时间推进信号（等价于真实墙钟前进到此刻）。 */
  pushNow(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.nowMs = ms;
  }

  /** 推进 nowMs 并执行所有到期 timer（FIFO）；timer 在回调中新建的到期 timer 亦处理。 */
  advanceTo(ms: number): void {
    this.nowMs = ms;
    this.runDueTimers();
  }

  /** 推进 deltaMs 并执行到期 timer（防微积分场景，等于 advanceTo(nowMs+delta)）。 */
  advanceBy(deltaMs: number): void {
    if (!Number.isFinite(deltaMs)) return;
    this.advanceTo(this.nowMs + deltaMs);
  }

  /** 回拨 nowMs（不触发 timer）；任何过期 timer 保持挂起，等待未来推进（受控）。 */
  setBack(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.nowMs = ms;
  }

  /** 当前挂起 timer 数（含未来到期；测试断言用）。 */
  pendingTimerCount(): number {
    return this.timers.length;
  }

  private runDueTimers(): void {
    let iterations = 0;
    for (;;) {
      let index = -1;
      for (let i = 0; i < this.timers.length; i += 1) {
        const t = this.timers[i]!;
        if (t.atMs <= this.nowMs && (index === -1 || t.atMs < this.timers[index]!.atMs)) {
          index = i;
        }
      }
      if (index === -1) return;
      const [timer] = this.timers.splice(index, 1) as [FakeTimer];
      const snapshot = this.nowMs;
      timer.callback();
      // 回调内 now() 始终反映快照时刻；后续推进由新的 advance/setBack 显式驱动
      void snapshot;
      iterations += 1;
      if (iterations > FAKE_MAX_PENDING) {
        this.timers = [];
        return;
      }
    }
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    if (this.timers.length >= FAKE_MAX_PENDING) {
      throw new Error('FakeClock 挂起 timer 超出硬上限');
    }
    const id = this.nextId;
    this.nextId += 1;
    this.timers.push({
      id,
      atMs: this.nowMs + delayMs,
      callback,
    });
    return { kind: 'timer', id };
  }

  clearTimeout(handle: TimerHandle): void {
    if (handle === null || handle === undefined) return;
    if (handle.kind !== 'timer') return;
    for (let i = 0; i < this.timers.length; i += 1) {
      if (this.timers[i]!.id === handle.id) {
        this.timers.splice(i, 1);
        return;
      }
    }
    // 未知或已执行 handle：幂等 no-op
  }

  /** 幂等清理全部挂起 timer（生命周期/重复 dispose 安全）。 */
  clearAll(): void {
    this.timers = [];
  }
}

// ---------------------------------------------------------------------------
// TimeZoneResolver：daily 本地时刻 → 下一 instant
// ---------------------------------------------------------------------------

interface TzParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

function formatDate(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

// IANA 时区下 HH:mm 的本地墙钟部件。返回 null 表示该 instant 的墙钟在该时区不可解析
// （极端时间/历史边界），调用方按受控失败处理。
function tzLocalParts(instantMs: number, timeZone: string): TzParts | null {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const parts = fmt.formatToParts(new Date(instantMs));
    const get = (t: string): number | null => {
      const p = parts.find((x) => x.type === t);
      if (!p) return null;
      const n = Number(p.value);
      return Number.isFinite(n) ? n : null;
    };
    const year = get('year');
    const month = get('month');
    const day = get('day');
    const hour = get('hour');
    const minute = get('minute');
    if (year === null || month === null || day === null || hour === null || minute === null) {
      return null;
    }
    return { year, month, day, hour, minute };
  } catch {
    return null;
  }
}

// 目标时区下逻辑日期 +N 天（用 UTC 日历算术逼近，再以 tzLocalParts 修正到真实逻辑日）。
// 探测时刻必须落在目标逻辑日期当天：用 UTC 正午（12:00Z）探测在 UTC+13/+14 极东偏移
// 下会跨到次日本地 00:00 之后（12:00Z = Kiritimati 次日 02:00），导致跳过 after 所在逻辑日。
// 修正：以「base 逻辑日 + days」的 UTC 日历为基准日期，探测 12:00Z 的本地日期；
// 若漂移一天，沿相反方向 ±24h 重探一次（至多一次，O(1)），保证返回目标时区真实逻辑日。
function tzAddDays(base: TzParts, days: number, timeZone: string): TzParts {
  const naive = Date.UTC(base.year, base.month - 1, base.day + days, 12, 0, 0);
  const target = formatDate(base.year, base.month, base.day + days);
  const probe = (ms: number): TzParts | null => {
    const w = tzLocalParts(ms, timeZone);
    if (w === null) return null;
    const wd = formatDate(w.year, w.month, w.day);
    if (wd === target) return w;
    // 极端偏移下漂移一天：沿相反方向移动 24h 重探（至多一次）
    if (wd < target) return tzLocalParts(ms + 24 * MS_PER_HOUR, timeZone);
    return tzLocalParts(ms - 24 * MS_PER_HOUR, timeZone);
  };
  const w = probe(naive);
  if (w !== null) return w;
  return { year: base.year, month: base.month, day: base.day + days, hour: 12, minute: 0 };
}

/**
 * 目标逻辑日期 (y,m,d) 在指定时区下「本地 HH:mm 之后的第一个有效 instant」。
 * - 普通日期：本地墙钟恰为 HH:mm 的 instant；
 * - DST gap（该本地时间不存在）：返回时钟跳变后的第一个有效 instant（墙钟首次 >= HH:mm）；
 * - DST fold（该本地时间出现两次）：返回较早的 instant（墙钟首次 == HH:mm）。
 * 统一采用有界分钟扫描（[-16h, +16h]，覆盖 -12..+14 全部合法时区偏移，最多 ~1920 次
 * 迭代），确定、无枚举一万 missed。返回 null 表示该日期在该时区不存在满足条件的墙钟。
 */
function resolveTargetInstant(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  timeZone: string,
): number | null {
  const targetDate = formatDate(y, m, d);
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  if (!Number.isFinite(naive)) return null;
  const startMs = naive - 16 * MS_PER_HOUR;
  const endMs = naive + 16 * MS_PER_HOUR;
  for (let ms = startMs; ms <= endMs; ms += 60_000) {
    const w = tzLocalParts(ms, timeZone);
    if (w === null) continue;
    if (formatDate(w.year, w.month, w.day) !== targetDate) continue;
    if (w.hour > hh || (w.hour === hh && w.minute >= mm)) {
      return ms;
    }
  }
  return null;
}

/**
 * TimeZoneResolver 实现（detailed-design §4.1 oracle）：
 * - daily localTime 严格 HH:mm；非法时间/IANA 时区返回 null；
 * - 返回的 instant 严格晚于 input.after；same logical date 由 lastLocalDate 防重；
 * - DST gap：同一逻辑日期选择跳变后的第一个有效 instant；
 * - DST fold：只选较早 instant；较早已不晚于 after 时不得改选较晚重复 instant，应寻下一逻辑日期；
 * - 系统时区变化不影响显式 input.timeZone 的结果；
 * - 回拨/大幅前跳：按单调候选扫描，回拨场景下的早重复 instant 仍有效。
 */
export function createTimeZoneResolver(): TimeZoneResolver {
  return {
    nextDailyInstant(input): { instant: Date; localDate: string } | null {
      const { after, localTime, timeZone, lastLocalDate } = input;
      const afterMs = after instanceof Date ? after.getTime() : Number.NaN;
      if (!Number.isFinite(afterMs)) return null;
      if (!isValidLocalTime(localTime)) return null;
      if (!isValidTimeZone(timeZone)) return null;

      const hh = Number(localTime.slice(0, 2));
      const mm = Number(localTime.slice(3, 5));
      if (localTime.length !== 5 || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;

      // 起始点：after 在目标时区的本地逻辑日期（构造其当日内候选）
      const startParts = tzLocalParts(afterMs, timeZone);
      if (startParts === null) return null;

      // 逐逻辑日期求解；first-wins（较早日历先于较晚）。同一逻辑日期只返回最早有效 instant。
      for (let offset = 0; offset <= DAILY_WINDOW_DAYS; offset += 1) {
        const date = tzAddDays(startParts, offset, timeZone);
        const localDate = formatDate(date.year, date.month, date.day);
        if (lastLocalDate !== null && localDate === lastLocalDate) continue;
        const ms = resolveTargetInstant(date.year, date.month, date.day, hh, mm, timeZone);
        if (ms === null) continue;
        if (ms <= afterMs) continue;
        return { instant: new Date(ms), localDate };
      }
      return null;
    },
  };
}
