// D5 M1: watch-scheduler 纯调度计算 + 到期队列测试（FakeClock 驱动，零 IO）。
// Contract source: detailed-design §4.1–§4.3、FIXED DECISIONS 4/6/8。
// 红态：模块尚不存在 → 红；绿后全绿（含纯函数 DST/回拨/万次 missed O(1) 推进）。
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../shared/watch/clock';
import {
  WatchScheduler,
  backoffDelayFor,
  computeJitterMs,
  computeNextDueAt,
  effectiveDueAtMs,
  localDateOf,
  type WatchSchedulerOptions,
} from './watch-scheduler';
import type { WatchRule } from '../../shared/types/watch';

function intervalRule(overrides: Partial<WatchRule> = {}): WatchRule {
  return {
    id: 'r1',
    sourceId: 's1',
    kind: 'feed',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'public',
    schedule: { kind: 'interval', intervalMinutes: 15 },
    target: { type: 'feed', feedUrl: 'https://example.com/rss.xml', format: 'rss2' },
    condition: null,
    notificationLevel: 'normal',
    sourceRowVersion: 1,
    sourceLocatorFingerprint: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    nextDueAt: null,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

function dailyRule(localTime: `${string}:${string}`, timeZone: string): WatchRule {
  return intervalRule({ schedule: { kind: 'daily', localTime, timeZone } });
}

// ---------------------------------------------------------------------------
// 纯调度计算
// ---------------------------------------------------------------------------

describe('backoffDelayFor（退避阶梯 FIXED 6：15m/1h/6h/24h 封顶）', () => {
  it('0 失败 → 0；1→15min；2→1h；3→6h；4 及以上→24h 封顶', () => {
    expect(backoffDelayFor(0)).toBe(0);
    expect(backoffDelayFor(1)).toBe(15 * 60_000);
    expect(backoffDelayFor(2)).toBe(60 * 60_000);
    expect(backoffDelayFor(3)).toBe(6 * 60 * 60_000);
    expect(backoffDelayFor(4)).toBe(24 * 60 * 60_000);
    expect(backoffDelayFor(5)).toBe(24 * 60 * 60_000);
    expect(backoffDelayFor(99)).toBe(24 * 60 * 60_000);
    expect(backoffDelayFor(-1)).toBe(0);
    expect(backoffDelayFor(Number.NaN)).toBe(0);
  });
});

describe('effectiveDueAtMs（§4.2：max(nextDueAt, backoffUntil)）', () => {
  it('nextDueAt/backoffUntil 取较晚者；backoff 覆盖 next；全空 → null', () => {
    expect(
      effectiveDueAtMs({ nextDueAt: '2026-08-28T10:00:00.000Z', backoffUntil: null }),
    ).toBe(Date.parse('2026-08-28T10:00:00.000Z'));
    expect(
      effectiveDueAtMs({
        nextDueAt: '2026-08-28T10:00:00.000Z',
        backoffUntil: '2026-08-28T12:00:00.000Z',
      }),
    ).toBe(Date.parse('2026-08-28T12:00:00.000Z'));
    expect(effectiveDueAtMs({ nextDueAt: null, backoffUntil: null })).toBeNull();
  });
});

describe('computeJitterMs（FIXED 8：SHA-256 截断取模 0..500，确定性）', () => {
  it('同输入恒等；异输入分布有界 [0,500]', () => {
    const a = computeJitterMs({ ruleId: 'r1', hostKey: 'example.com:443', seed: 's1' });
    const b = computeJitterMs({ ruleId: 'r1', hostKey: 'example.com:443', seed: 's1' });
    expect(a).toBe(b);
    expect(Number.isInteger(a) && a >= 0 && a <= 500).toBe(true);
    // 异输入（host/seed/ruleId 变化）产生不同值（概率断言：多对样本去重后 >1）
    const samples = new Set<number>();
    for (let i = 0; i < 50; i += 1) {
      samples.add(
        computeJitterMs({ ruleId: `r${i}`, hostKey: `h.example.com:443`, seed: `s${i}` }),
      );
    }
    expect(samples.size).toBeGreaterThan(1);
    for (const v of samples) expect(v >= 0 && v <= 500).toBe(true);
  });
});

describe('computeNextDueAt（FIXED 4：O(1) 推进，不枚举 missed）', () => {
  const NOW = Date.parse('2026-08-28T12:00:00.000Z');

  it('interval：推进到首个严格 > now 的时点；一万次 missed 也只推进一次', () => {
    const rule = intervalRule();
    const consumed = '2026-08-28T00:00:00.000Z'; // 12 小时前（48 个 15min 间隔）
    const r = computeNextDueAt({ rule, consumedScheduledFor: consumed, nowMs: NOW });
    expect(r).not.toBeNull();
    const advanced = Date.parse(r!.nextDueAt);
    expect(advanced).toBeGreaterThan(NOW);
    expect(r!.lastDailyLocalDate).toBeNull();
    // 一万次 missed：consumed 极早 → 仍只推进到一个 > now 的时点（零枚举）
    const ancient = new Date(NOW - 10_000 * 15 * 60_000).toISOString();
    const r2 = computeNextDueAt({ rule, consumedScheduledFor: ancient, nowMs: NOW });
    expect(r2).not.toBeNull();
    expect(Date.parse(r2!.nextDueAt)).toBeGreaterThan(NOW);
    // 推进结果与锚点同余（下一个 15min 边界）
    const diff = Date.parse(r2!.nextDueAt) - Date.parse(ancient);
    expect(diff % (15 * 60_000)).toBe(0);
    expect(Date.parse(r2!.nextDueAt)).toBeLessThanOrEqual(NOW + 15 * 60_000);
  });

  it('daily：推进到次日排程并写 lastDailyLocalDate', () => {
    const rule = dailyRule('09:00', 'Asia/Shanghai');
    const r = computeNextDueAt({
      rule,
      consumedScheduledFor: '2026-08-28T01:00:00.000Z', // 上海 08-28 09:00
      nowMs: NOW,
    });
    expect(r).not.toBeNull();
    expect(r!.lastDailyLocalDate).toBe('2026-08-28');
    // 次一时点严格 > now 且本地为 08-29 09:00 上海（UTC 01:00）
    expect(Date.parse(r!.nextDueAt)).toBeGreaterThan(NOW);
    expect(r!.nextDueAt).toBe('2026-08-29T01:00:00.000Z');
  });

  it('daily DST gap（America/New_York 02:30 春令）：跳变后首个有效 instant，恰一次', () => {
    const rule = dailyRule('02:30', 'America/New_York');
    const r = computeNextDueAt({
      rule,
      consumedScheduledFor: '2026-03-07T06:30:00.000Z', // NY 03-07 01:30
      nowMs: Date.parse('2026-03-07T14:00:00.000Z'), // NY 03-07 09:00
    });
    expect(r).not.toBeNull();
    expect(r!.lastDailyLocalDate).toBe('2026-03-07'); // 本次消费逻辑日
    // 02:30 不存在；跳变后第一个 >=02:30 的有效墙钟 = 03:00 EDT = 07:00 UTC
    expect(r!.nextDueAt).toBe('2026-03-08T07:00:00.000Z');
  });

  it('daily DST fold（秋季回拨）：选较早 instant；同一逻辑日期零二次（lastLocalDate 防重）', () => {
    const rule = dailyRule('01:30', 'America/New_York');
    const r = computeNextDueAt({
      rule,
      consumedScheduledFor: '2026-10-31T04:00:00.000Z', // NY 10-31 00:00
      nowMs: Date.parse('2026-10-31T14:00:00.000Z'), // NY 10-31 10:00
    });
    expect(r).not.toBeNull();
    expect(r!.lastDailyLocalDate).toBe('2026-10-31'); // 本次消费逻辑日
    // fold 选较早 instant：01:30 EDT = 05:30 UTC
    expect(r!.nextDueAt).toBe('2026-11-01T05:30:00.000Z');
    // 同一逻辑日不重复：已消费 11-01 → 下一逻辑日 11-02
    const r2 = computeNextDueAt({
      rule,
      consumedScheduledFor: r!.nextDueAt,
      nowMs: Date.parse('2026-11-01T06:00:00.000Z'), // NY 11-01 01:00 EST
    });
    expect(r2!.lastDailyLocalDate).toBe('2026-11-01');
    expect(r2!.nextDueAt).toBe('2026-11-02T06:30:00.000Z');
  });
});

describe('localDateOf（目标时区逻辑日）', () => {
  it('Asia/Shanghai 与 America/New_York 正确映射', () => {
    expect(localDateOf(Date.parse('2026-08-28T17:00:00.000Z'), 'Asia/Shanghai')).toBe('2026-08-29');
    expect(localDateOf(Date.parse('2026-08-28T23:00:00.000Z'), 'America/New_York')).toBe('2026-08-28');
    expect(localDateOf(Number.NaN, 'Asia/Shanghai')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WatchScheduler 到期队列（FakeClock）
// ---------------------------------------------------------------------------

function makeScheduler(clock: FakeClock, opts?: Partial<WatchSchedulerOptions>) {
  const submitted: Array<{ ruleId: string; trigger: 'catch-up' | 'scheduled' }> = [];
  const scheduler = new WatchScheduler({
    clock,
    onDue: (entries) => submitted.push(...entries),
    ...opts,
  });
  return { scheduler, submitted };
}

describe('WatchScheduler 到期队列（§4.2/§14）', () => {
  it('initialize：过期条目立即 catch-up 提交一次；未来条目按 due 时间 scheduled 提交', () => {
    const clock = new FakeClock(Date.parse('2026-08-28T10:00:00.000Z'));
    const { scheduler, submitted } = makeScheduler(clock);
    scheduler.initialize([
      { ruleId: 'overdue', effectiveDueAt: Date.parse('2026-08-28T09:00:00.000Z') },
      { ruleId: 'future', effectiveDueAt: Date.parse('2026-08-28T11:00:00.000Z') },
    ]);
    expect(submitted).toEqual([]); // 到期 timer 尚未到事件轮
    clock.advanceBy(0); // 触发 delay-0 到期 timer
    expect(submitted).toEqual([{ ruleId: 'overdue', trigger: 'catch-up' }]);
    expect(clock.pendingTimerCount()).toBe(1);
    clock.advanceTo(Date.parse('2026-08-28T11:00:00.000Z'));
    expect(submitted).toEqual([
      { ruleId: 'overdue', trigger: 'catch-up' },
      { ruleId: 'future', trigger: 'scheduled' },
    ]);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it('21 条同时到期：单 tick 恰 20 启动、第 21 留队列次 tick', () => {
    const clock = new FakeClock(Date.parse('2026-08-28T10:00:00.000Z'));
    const batches: number[] = [];
    const scheduler = new WatchScheduler({
      clock,
      onDue: (entries) => batches.push(entries.length),
    });
    const entries = Array.from({ length: 21 }, (_, i) => ({
      ruleId: `r${String(i).padStart(2, '0')}`,
      effectiveDueAt: Date.parse('2026-08-28T09:00:00.000Z'), // 全部过期
    }));
    scheduler.initialize(entries);
    clock.advanceBy(0); // 触发到期 timer；delay-0 重臂在同一事件轮完成剩余
    expect(batches).toEqual([20, 1]); // 首批恰 20，第 21 留队列次 tick（独立 fire 调用）
    expect(scheduler.size).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it('100 条满载稳定收敛：全部提交恰好一次、队列/timer 归零', () => {
    const clock = new FakeClock(Date.parse('2026-08-28T10:00:00.000Z'));
    const { scheduler, submitted } = makeScheduler(clock);
    const entries = Array.from({ length: 100 }, (_, i) => ({
      ruleId: `r${String(i).padStart(3, '0')}`,
      effectiveDueAt: Date.parse('2026-08-28T09:00:00.000Z'),
    }));
    scheduler.initialize(entries);
    clock.advanceBy(0);
    expect(submitted.length).toBe(100);
    expect(new Set(submitted.map((s) => s.ruleId)).size).toBe(100);
    expect(submitted.every((s) => s.trigger === 'catch-up')).toBe(true);
    expect(scheduler.size).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it('setBack 回拨：已消费 scheduledFor 零重放；未到期条目零提前（负延迟不伪触发）', () => {
    const clock = new FakeClock(Date.parse('2026-08-28T10:00:00.000Z'));
    const { scheduler, submitted } = makeScheduler(clock);
    scheduler.initialize([
      { ruleId: 'a', effectiveDueAt: Date.parse('2026-08-28T09:00:00.000Z') }, // 已到期 → 提交
      { ruleId: 'b', effectiveDueAt: Date.parse('2026-08-28T12:00:00.000Z') }, // 未到期
    ]);
    clock.advanceBy(0);
    expect(submitted.map((s) => s.ruleId)).toEqual(['a']);
    // 回拨到 a 的到期时刻之前 → a 不得重放；b 不得提前触发
    clock.setBack(Date.parse('2026-08-28T08:00:00.000Z'));
    clock.advanceTo(Date.parse('2026-08-28T11:59:59.000Z'));
    expect(submitted.map((s) => s.ruleId)).toEqual(['a']);
    expect(scheduler.has('b')).toBe(true);
    // 推进到 b 的 due → b 触发
    clock.advanceTo(Date.parse('2026-08-28T12:00:00.000Z'));
    expect(submitted.map((s) => s.ruleId)).toEqual(['a', 'b']);
  });

  it('向前跳：合并补跑（每条目一次提交，不枚举中间时点）', () => {
    const clock = new FakeClock(Date.parse('2026-08-28T10:00:00.000Z'));
    const { scheduler, submitted } = makeScheduler(clock);
    scheduler.initialize([
      { ruleId: 'x', effectiveDueAt: Date.parse('2026-08-28T10:30:00.000Z') },
    ]);
    // 墙钟直接前跳 3 天（离线场景）→ 单次合并补跑
    clock.advanceTo(Date.parse('2026-08-31T09:00:00.000Z'));
    expect(submitted).toEqual([{ ruleId: 'x', trigger: 'scheduled' }]);
  });

  it('upsert 更新到期时刻并重臂；remove 移除后不再触发', () => {
    const clock = new FakeClock(Date.parse('2026-08-28T10:00:00.000Z'));
    const { scheduler, submitted } = makeScheduler(clock);
    scheduler.initialize([{ ruleId: 'a', effectiveDueAt: Date.parse('2026-08-28T11:00:00.000Z') }]);
    scheduler.upsert({ ruleId: 'a', effectiveDueAt: Date.parse('2026-08-28T12:00:00.000Z') });
    clock.advanceTo(Date.parse('2026-08-28T11:00:00.000Z'));
    expect(submitted.length).toBe(0); // 已推迟，不在 11:00 触发
    scheduler.remove('a');
    clock.advanceTo(Date.parse('2026-08-28T12:00:00.000Z'));
    expect(submitted.length).toBe(0); // 移除后零触发
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it('零规则零 timer；stop 幂等可重复（重复 stop/disarm 安全）', () => {
    const clock = new FakeClock(Date.parse('2026-08-28T10:00:00.000Z'));
    const { scheduler } = makeScheduler(clock);
    expect(scheduler.size).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
    scheduler.initialize([]);
    expect(clock.pendingTimerCount()).toBe(0);
    // stop 幂等
    scheduler.initialize([{ ruleId: 'a', effectiveDueAt: Date.parse('2026-08-28T11:00:00.000Z') }]);
    expect(clock.pendingTimerCount()).toBe(1);
    scheduler.stop();
    scheduler.stop();
    expect(clock.pendingTimerCount()).toBe(0);
    expect(scheduler.size).toBe(0);
    // stop 后 upsert/initialize 不再新增 timer
    scheduler.upsert({ ruleId: 'b', effectiveDueAt: Date.parse('2026-08-28T11:00:00.000Z') });
    scheduler.initialize([{ ruleId: 'c', effectiveDueAt: Date.parse('2026-08-28T11:00:00.000Z') }]);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it('同 ruleId 去重：initialize 重复条目与 upsert 覆盖不产生双条目', () => {
    const clock = new FakeClock(Date.parse('2026-08-28T10:00:00.000Z'));
    const { scheduler, submitted } = makeScheduler(clock);
    scheduler.initialize([
      { ruleId: 'a', effectiveDueAt: Date.parse('2026-08-28T09:00:00.000Z') },
      { ruleId: 'a', effectiveDueAt: Date.parse('2026-08-28T09:00:00.000Z') },
    ]);
    scheduler.upsert({ ruleId: 'a', effectiveDueAt: Date.parse('2026-08-28T10:30:00.000Z') });
    clock.advanceTo(Date.parse('2026-08-28T10:30:00.000Z'));
    expect(submitted).toEqual([{ ruleId: 'a', trigger: 'scheduled' }]);
    expect(scheduler.size).toBe(0);
  });
});
