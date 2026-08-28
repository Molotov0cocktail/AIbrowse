// D5 watch-scheduler: 纯调度计算 + 到期队列（detailed-design §4.2/§4.3、threat-model
// §3.6/WRT-16）。零 Browser/DB/HTTP/Provider/Notification 能力——只持 Clock 与
// ruleId(+trigger) 提交回调；nextDueAt 推进/退避/jitter 为无环境依赖纯函数，由
// Coordinator 消费（Coordinator 只把计算结果写入 reservation/终态事务）。
// Contract source: doc/stage6/detailed-design.md §4.1–§4.3、FIXED DECISIONS 4–6/8。
// 分层纪律：本模块不 import Electron、logger、repository、任何 IO、任何 db/ 模块。
import { createHash } from 'node:crypto';
import { createTimeZoneResolver, nextIntervalInstant } from '../../shared/watch/clock';
import {
  MAX_DUE_STARTS_PER_TICK,
  type Clock,
  type TimeZoneResolver,
  type TimerHandle,
  type WatchRunTrigger,
  type WatchRule,
} from '../../shared/types/watch';

// ---------------------------------------------------------------------------
// 纯调度计算（零 IO；供 Coordinator/测试导入）
// ---------------------------------------------------------------------------

// 退避阶梯（FIXED DECISIONS 6）：连续失败 1→15min、2→1h、3→6h、≥4→24h 封顶。
const BACKOFF_LADDER_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000] as const;

export function backoffDelayFor(consecutiveFailures: number): number {
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures <= 0) return 0;
  const index = Math.min(consecutiveFailures - 1, BACKOFF_LADDER_MS.length - 1);
  return BACKOFF_LADDER_MS[index]!;
}

/** effectiveDueAt = max(nextDueAt, backoffUntil)（§4.2）；无有效锚点返回 null。 */
export function effectiveDueAtMs(rule: {
  nextDueAt: string | null;
  backoffUntil: string | null;
}): number | null {
  const next = rule.nextDueAt === null ? Number.NaN : Date.parse(rule.nextDueAt);
  const backoff = rule.backoffUntil === null ? Number.NaN : Date.parse(rule.backoffUntil);
  const candidates: number[] = [];
  if (Number.isFinite(next)) candidates.push(next);
  if (Number.isFinite(backoff)) candidates.push(backoff);
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

/** 目标时区下 instant 的逻辑本地日期（YYYY-MM-DD；纯 Intl，零 IO）。 */
export function localDateOf(instantMs: number, timeZone: string): string | null {
  if (!Number.isFinite(instantMs)) return null;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = fmt.formatToParts(new Date(instantMs));
    const get = (t: string): string | undefined => parts.find((p) => p.type === t)?.value;
    const year = get('year');
    const month = get('month');
    const day = get('day');
    if (year === undefined || month === undefined || day === undefined) return null;
    return `${year}-${month}-${day}`;
  } catch {
    return null;
  }
}

const timeZoneResolver: TimeZoneResolver = createTimeZoneResolver();

/**
 * 按原 schedule 锚点 O(1) 推进 nextDueAt（FIXED DECISIONS 4）：
 * - interval：nextIntervalInstant(anchor=消费前 scheduledFor, intervalMs, after=now)，
 *   结果严格 > now，不枚举中间 missed；
 * - daily：nextDailyInstant({after:now, localTime, timeZone, lastLocalDate=消费时点
 *   的本地逻辑日期})，跳过已消费逻辑日，DST gap/fold 由 D1 oracle 承载；
 * - daily 同时写本次 logical local date（= 本次消费 scheduledFor 的本地逻辑日，
 *   用于「同一逻辑日期至多一次」与审计可观测性）；interval 恒 null。
 * 返回 null 表示无法安全推进（fail-closed，调用方按不可用处理）。
 */
export function computeNextDueAt(input: {
  rule: Pick<WatchRule, 'schedule'>;
  consumedScheduledFor: string;
  nowMs: number;
}): { nextDueAt: string; lastDailyLocalDate: string | null } | null {
  const consumedMs = Date.parse(input.consumedScheduledFor);
  if (!Number.isFinite(consumedMs)) return null;
  if (!Number.isFinite(input.nowMs)) return null;
  if (input.rule.schedule.kind === 'interval') {
    const advanced = nextIntervalInstant(
      consumedMs,
      input.rule.schedule.intervalMinutes * 60_000,
      input.nowMs,
    );
    if (!Number.isFinite(advanced)) return null;
    return { nextDueAt: new Date(advanced).toISOString(), lastDailyLocalDate: null };
  }
  const consumedLocalDate = localDateOf(consumedMs, input.rule.schedule.timeZone);
  if (consumedLocalDate === null) return null;
  const resolved = timeZoneResolver.nextDailyInstant({
    after: new Date(input.nowMs),
    localTime: input.rule.schedule.localTime,
    timeZone: input.rule.schedule.timeZone,
    lastLocalDate: consumedLocalDate,
  });
  if (resolved === null) return null;
  return { nextDueAt: resolved.instant.toISOString(), lastDailyLocalDate: consumedLocalDate };
}

/**
 * 顶层 acquisition 确定性 jitter（FIXED DECISIONS 8）：0..500ms，
 * SHA-256(ruleId|hostKey|seed) 截断取模；seed=消费 scheduledFor（手动以 requestId）。
 * 实际 start 为 due/backoff/host-gap 全部满足后再延迟该值，永不提前于 due。
 */
export function computeJitterMs(input: { ruleId: string; hostKey: string; seed: string }): number {
  const digest = createHash('sha256')
    .update(`${input.ruleId}|${input.hostKey}|${input.seed}`, 'utf8')
    .digest();
  return digest.readUInt32BE(0) % 501;
}

// ---------------------------------------------------------------------------
// WatchScheduler：到期队列（effectiveDueAt, ruleId）+ 单 timer 重臂 + ≤MAX_DUE_STARTS
// ---------------------------------------------------------------------------

export interface SchedulerEntry {
  ruleId: string;
  effectiveDueAt: number;
  trigger: Extract<WatchRunTrigger, 'catch-up' | 'scheduled'>;
}

export interface WatchSchedulerOptions {
  clock: Clock;
  maxStartsPerTick?: number;
  onDue: (entries: readonly { ruleId: string; trigger: 'catch-up' | 'scheduled' }[]) => void;
}

/**
 * 到期队列：
 * - 单一 timer 重臂到最早 effectiveDueAt；单次 fire 只提交 ≤maxStartsPerTick 条，
 *   其余留在有界排序队列 (effectiveDueAt, ruleId)，次 tick 继续；
 * - initialize（启动/恢复）时 effectiveDueAt<=now 的条目标 catch-up，其余 scheduled；
 *   upsert（reservation 后推进/backoff/新规则）一律 scheduled；
 * - wall clock 回拨：已提交条目从队列移除，不重放已消费 scheduledFor；未到期条目
 *   不会因负延迟伪触发；向前跳只触发一次合并补跑（条目在 fire 时一次性提交）；
 * - stop()/重复调用幂等：清 timer、清队列。
 */
export class WatchScheduler {
  private readonly clock: Clock;
  private readonly maxStartsPerTick: number;
  private readonly onDue: WatchSchedulerOptions['onDue'];
  private readonly heap: SchedulerEntry[] = [];
  private readonly index = new Map<string, number>();
  private timer: TimerHandle | null = null;
  private stopped = false;

  constructor(options: WatchSchedulerOptions) {
    this.clock = options.clock;
    this.maxStartsPerTick = options.maxStartsPerTick ?? MAX_DUE_STARTS_PER_TICK;
    this.onDue = options.onDue;
  }

  get size(): number {
    return this.heap.length;
  }

  has(ruleId: string): boolean {
    return this.index.has(ruleId);
  }

  initialize(entries: readonly { ruleId: string; effectiveDueAt: number }[]): void {
    if (this.stopped) return;
    const now = this.clock.now().getTime();
    for (const entry of entries) {
      if (this.index.has(entry.ruleId)) continue;
      this.insert({
        ruleId: entry.ruleId,
        effectiveDueAt: entry.effectiveDueAt,
        trigger: entry.effectiveDueAt <= now ? 'catch-up' : 'scheduled',
      });
    }
    this.arm();
  }

  upsert(entry: { ruleId: string; effectiveDueAt: number }): void {
    if (this.stopped) return;
    const existing = this.index.get(entry.ruleId);
    if (existing === undefined) {
      this.insert({
        ruleId: entry.ruleId,
        effectiveDueAt: entry.effectiveDueAt,
        trigger: 'scheduled',
      });
    } else {
      const prior = this.heap[existing]!;
      this.heap[existing] = {
        ...prior,
        effectiveDueAt: entry.effectiveDueAt,
        trigger: 'scheduled',
      };
      this.siftDown(existing);
      this.siftUp(existing);
    }
    this.arm();
  }

  remove(ruleId: string): void {
    const index = this.index.get(ruleId);
    if (index === undefined) return;
    const last = this.heap.length - 1;
    if (index !== last) {
      this.heap[index] = this.heap[last]!;
      this.index.set(this.heap[index]!.ruleId, index);
      this.siftDown(index);
      this.siftUp(index);
    }
    this.heap.pop();
    this.index.delete(ruleId);
    if (this.heap.length === 0) this.disarm();
    else this.arm();
  }

  stop(): void {
    this.stopped = true;
    this.disarm();
    this.heap.length = 0;
    this.index.clear();
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  private insert(entry: SchedulerEntry): void {
    this.heap.push(entry);
    this.index.set(entry.ruleId, this.heap.length - 1);
    this.siftUp(this.heap.length - 1);
  }

  private siftUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(i, parent)) {
        this.swap(i, parent);
        i = parent;
      } else break;
    }
  }

  private siftDown(index: number): void {
    let i = index;
    for (;;) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if (left < this.heap.length && this.less(left, smallest)) smallest = left;
      if (right < this.heap.length && this.less(right, smallest)) smallest = right;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private less(a: number, b: number): boolean {
    const ea = this.heap[a]!;
    const eb = this.heap[b]!;
    if (ea.effectiveDueAt !== eb.effectiveDueAt) return ea.effectiveDueAt < eb.effectiveDueAt;
    return ea.ruleId < eb.ruleId;
  }

  private swap(a: number, b: number): void {
    const tmp = this.heap[a]!;
    this.heap[a] = this.heap[b]!;
    this.heap[b] = tmp;
    this.index.set(this.heap[a]!.ruleId, a);
    this.index.set(this.heap[b]!.ruleId, b);
  }

  private arm(): void {
    if (this.stopped) return;
    if (this.heap.length === 0) {
      this.disarm();
      return;
    }
    const now = this.clock.now().getTime();
    const delay = Math.max(0, this.heap[0]!.effectiveDueAt - now);
    if (this.timer !== null) this.disarm();
    this.timer = this.clock.setTimeout(() => this.fire(), delay);
  }

  private disarm(): void {
    if (this.timer === null) return;
    try {
      this.clock.clearTimeout(this.timer);
    } catch {
      // 幂等：未知/已执行 handle
    }
    this.timer = null;
  }

  private fire(): void {
    this.timer = null;
    if (this.stopped) return;
    const now = this.clock.now().getTime();
    const due: SchedulerEntry[] = [];
    while (
      due.length < this.maxStartsPerTick &&
      this.heap.length > 0 &&
      this.heap[0]!.effectiveDueAt <= now
    ) {
      const entry = this.heap[0]!;
      this.removeRoot();
      due.push(entry);
    }
    if (due.length > 0) {
      this.onDue(due.map((d) => ({ ruleId: d.ruleId, trigger: d.trigger })));
    }
    this.arm();
  }

  private removeRoot(): void {
    const removed = this.heap[0]!;
    const last = this.heap.length - 1;
    if (last === 0) {
      this.heap.pop();
    } else {
      this.heap[0] = this.heap[last]!;
      this.index.set(this.heap[0]!.ruleId, 0);
      this.heap.pop();
      this.siftDown(0);
    }
    this.index.delete(removed.ruleId);
  }
}
