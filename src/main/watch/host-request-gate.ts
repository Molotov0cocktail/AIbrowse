// D5 host-request-gate: main 进程单例注册表（canonical host:effectivePort → lastStartedAt）
//（detailed-design §4.3、threat-model §3.2/WRT-05、FIXED DECISIONS 3/5/8）。
// - 同 canonical host 相邻 app-initiated start（含 robots/redirect/retry/createTab）
//   ≥ MIN_HOST_REQUEST_GAP_MS；gate 必须在 socket 发起/createTab 之前取得；
//   global/host 槽释放、重试、手动运行均不缩短间隔；
// - Public client 与（D6）Session workspace 注入同一主进程实例，不分模式各自计时；
// - 每 hostKey 一个 FIFO 队列：同一时刻只有一个等待者持有 gap 槽（确定性串行排队），
//   队列尾按前一等待者结算后的最新 lastStartedAt 重新计算等待，保证任意两个实际
//   socket start（含并发/redirect/retry 汇聚到同一新 host）相邻间隔 ≥ gap；abort/
//   deadline 结算即出队并推进下一个，不阻塞后续等待者；clear() 幂等清空注册表并
//   取消全部 pending（零迟到 grant）；
// - acquire（登记式）：等待 gap 满足后登记 lastStartedAt=now，供实际 socket start；
//   waitUntilAvailable（非登记）：Coordinator 在 jitter 之前确认 host-gap 已满足，
//   不登记 start（避免与首个 socket 的登记式 acquire 重复计时导致间隔被压缩）；
// - deriveHostKey 是 host:effectivePort（80/443 显式）单一事实源，供 coordinator/
//   工厂/（D6）workspace 复用；
// - 零 Electron、零 IO；可注入 Clock；clear() 幂等清理。
import { MIN_HOST_REQUEST_GAP_MS, type Clock, type TimerHandle } from '../../shared/types/watch';
import type { PublicScheme } from './network-policy';

/**
 * canonical host:effectivePort 派生（FIXED DECISIONS 5/8 单一事实源）：
 * 端口恒显式写（80/443 不省略），故 `https://example.com` 与
 * `https://example.com:443` 映射同一 hostKey；仅 http 80 / https 443 合法
 *（ApprovedTarget 已由 NetworkPolicy 闭合为 80|443）。
 */
export function deriveHostKey(input: {
  scheme: PublicScheme;
  host: string;
  port: 80 | 443;
}): string {
  return `${input.host}:${input.port}`;
}

export type HostGateResult =
  { ok: true } | { ok: false; reason: 'aborted' | 'deadline' | 'clock-invalid' };

export interface HostGateAcquireOptions {
  signal?: AbortSignal;
  deadlineMs?: number; // 单调有界等待上限（Coordinator 传 WATCH_RUN_TIMEOUT_MS 约束值）
}

function createSystemClock(): Clock {
  return {
    now: () => new Date(),
    setTimeout: (cb, ms) => ({
      kind: 'timer' as const,
      id: Number(globalThis.setTimeout(cb, ms)),
    }),
    clearTimeout: (h) =>
      globalThis.clearTimeout(h.id as unknown as Parameters<typeof globalThis.clearTimeout>[0]),
  };
}

interface PendingWaiter {
  hostKey: string;
  register: boolean;
  signal?: AbortSignal;
  deadline?: number;
  gapTimer: TimerHandle | null;
  deadlineTimer: TimerHandle | null;
  settled: boolean;
  onAbort: () => void;
  finalize: (result: HostGateResult) => void;
}

export class HostRequestGate {
  private readonly clock: Clock;
  private readonly gapMs: number;
  private readonly registry = new Map<string, number>();
  private readonly queues = new Map<string, PendingWaiter[]>();

  constructor(options: { clock?: Clock; gapMs?: number } = {}) {
    this.clock = options.clock ?? createSystemClock();
    this.gapMs = options.gapMs ?? MIN_HOST_REQUEST_GAP_MS;
  }

  /** 观测：某 hostKey 最近一次登记 start（测试/诊断；无则 null）。 */
  lastStartedAt(hostKey: string): number | null {
    const value = this.registry.get(hostKey);
    return value === undefined ? null : value;
  }

  get size(): number {
    return this.registry.size;
  }

  /**
   * 幂等清理（dispose/生命周期；重复调用安全）：清空注册表并取消全部 pending 等待者
   *（零迟到 grant——已排队/等待中的 acquire 一律受控 'aborted'，不留下任何未来登记）。
   */
  clear(): void {
    this.registry.clear();
    const pending: PendingWaiter[] = [];
    for (const list of this.queues.values()) {
      for (const waiter of list) pending.push(waiter);
    }
    this.queues.clear();
    for (const waiter of pending) {
      this.finalizeWaiter(waiter, { ok: false, reason: 'aborted' });
    }
  }

  /** 非登记可用性等待：仅当 now−lastStartedAt≥gap 时立即放行，不登记 start。 */
  waitUntilAvailable(hostKey: string, options?: HostGateAcquireOptions): Promise<HostGateResult> {
    return this.waitForGap(hostKey, options, false);
  }

  /** 登记式 acquire：等待 gap 满足后登记 lastStartedAt=now 并放行（实际 socket start 前）。 */
  acquire(hostKey: string, options?: HostGateAcquireOptions): Promise<HostGateResult> {
    return this.waitForGap(hostKey, options, true);
  }

  // ---------------------------------------------------------------------------
  // 每 hostKey FIFO 串行队列：同一 host 任意时刻只有一个等待者持有 gap 槽，原子地
  // 读取 lastStartedAt 并安装 timer；前一个结算后才推进下一个（abort/deadline 结算
  // 即出队，不阻塞后续）。不同 host 各走独立队列，互不阻塞。
  // ---------------------------------------------------------------------------

  private waitForGap(
    hostKey: string,
    options: HostGateAcquireOptions | undefined,
    register: boolean,
  ): Promise<HostGateResult> {
    const signal = options?.signal;
    const deadline = options?.deadlineMs;
    return new Promise<HostGateResult>((resolve) => {
      const waiter: PendingWaiter = {
        hostKey,
        register,
        signal,
        deadline,
        gapTimer: null,
        deadlineTimer: null,
        settled: false,
        onAbort: () => {},
        finalize: (result) => {
          resolve(result);
        },
      };
      const settle = (result: HostGateResult): void => {
        if (waiter.settled) return;
        this.finalizeWaiter(waiter, result);
        this.removeAndAdvance(hostKey, waiter);
      };
      waiter.onAbort = (): void => settle({ ok: false, reason: 'aborted' });

      if (signal !== undefined) {
        if (signal.aborted) {
          resolve({ ok: false, reason: 'aborted' });
          return;
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      const list = this.queues.get(hostKey);
      if (list === undefined) {
        this.queues.set(hostKey, [waiter]);
        this.processHead(hostKey, waiter);
      } else {
        list.push(waiter);
      }
    });
  }

  /** 结算单个等待者：标记 settled、清除全部 timer/listener、resolve（不动队列）。 */
  private finalizeWaiter(waiter: PendingWaiter, result: HostGateResult): void {
    if (waiter.settled) return;
    waiter.settled = true;
    for (const t of [waiter.gapTimer, waiter.deadlineTimer]) {
      if (t !== null) {
        try {
          this.clock.clearTimeout(t);
        } catch {
          // 单项失败继续剩余清理
        }
      }
    }
    waiter.gapTimer = null;
    waiter.deadlineTimer = null;
    if (waiter.signal !== undefined) {
      try {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      } catch {
        // 单项失败继续剩余清理
      }
    }
    waiter.finalize(result);
  }

  /** 出队并推进下一个头（若结算的是头；非头只移除自身）。 */
  private removeAndAdvance(hostKey: string, waiter: PendingWaiter): void {
    const list = this.queues.get(hostKey);
    if (list === undefined) return;
    const idx = list.indexOf(waiter);
    if (idx < 0) return;
    list.splice(idx, 1);
    if (idx !== 0) return; // 非头：头仍在推进，不重复处理
    const next = list[0];
    if (next === undefined) {
      this.queues.delete(hostKey);
      return;
    }
    this.processHead(hostKey, next);
  }

  /** 头等待者：原子读取 lastStartedAt 并安装 gap/deadline timer（串行化核心）。 */
  private processHead(hostKey: string, waiter: PendingWaiter): void {
    const now = this.clock.now().getTime();
    if (!Number.isFinite(now)) {
      this.finalizeWaiter(waiter, { ok: false, reason: 'clock-invalid' });
      this.removeAndAdvance(hostKey, waiter);
      return;
    }
    if (
      waiter.deadline !== undefined &&
      Number.isFinite(waiter.deadline) &&
      now >= waiter.deadline
    ) {
      this.finalizeWaiter(waiter, { ok: false, reason: 'deadline' });
      this.removeAndAdvance(hostKey, waiter);
      return;
    }
    const last = this.registry.get(hostKey);
    const elapsed = last === undefined ? Number.POSITIVE_INFINITY : now - last;
    if (elapsed >= this.gapMs) {
      if (waiter.register) this.registry.set(hostKey, now);
      this.finalizeWaiter(waiter, { ok: true });
      this.removeAndAdvance(hostKey, waiter);
      return;
    }
    const waitMs = this.gapMs - elapsed;
    // gap timer：补齐到间隔满；deadline timer：截止先到则受控失败（单调有界等待）。
    // 二者谁先到谁定终态（settle 单次守卫）；deadline timer 保证不越过外部截止。
    const settleDeadline = (): void => {
      this.finalizeWaiter(waiter, { ok: false, reason: 'deadline' });
      this.removeAndAdvance(hostKey, waiter);
    };
    waiter.gapTimer = this.clock.setTimeout(() => {
      const grantedAt = this.clock.now().getTime();
      if (
        waiter.deadline !== undefined &&
        Number.isFinite(waiter.deadline) &&
        grantedAt >= waiter.deadline
      ) {
        settleDeadline();
        return;
      }
      if (waiter.register) this.registry.set(hostKey, grantedAt);
      this.finalizeWaiter(waiter, { ok: true });
      this.removeAndAdvance(hostKey, waiter);
    }, waitMs);
    if (waiter.deadline !== undefined && Number.isFinite(waiter.deadline)) {
      const dWait = Math.max(0, waiter.deadline - now);
      waiter.deadlineTimer = this.clock.setTimeout(() => {
        settleDeadline();
      }, dWait);
    }
  }
}
