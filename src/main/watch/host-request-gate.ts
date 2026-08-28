// D5 host-request-gate: main 进程单例注册表（canonical host:effectivePort → lastStartedAt）
//（detailed-design §4.3、threat-model §3.2/WRT-05、FIXED DECISIONS 3/5/8）。
// - 同 canonical host 相邻 app-initiated start（含 robots/redirect/retry/createTab）
//   ≥ MIN_HOST_REQUEST_GAP_MS；gate 必须在 socket 发起/createTab 之前取得；
//   global/host 槽释放、重试、手动运行均不缩短间隔；
// - Public client 与（D6）Session workspace 注入同一主进程实例，不分模式各自计时；
// - acquire（登记式）：等待 gap 满足后登记 lastStartedAt=now，供实际 socket start；
//   waitUntilAvailable（非登记）：Coordinator 在 jitter 之前确认 host-gap 已满足，
//   不登记 start（避免与首个 socket 的登记式 acquire 重复计时导致间隔被压缩）；
// - deriveHostKey 是 host:effectivePort（80/443 显式）单一事实源，供 coordinator/
//   工厂/（D6）workspace 复用；
// - 零 Electron、零 IO；可注入 Clock；clear() 幂等清理。
import {
  MIN_HOST_REQUEST_GAP_MS,
  type Clock,
  type TimerHandle,
} from '../../shared/types/watch';
import type { PublicScheme } from './network-policy';

/**
 * canonical host:effectivePort 派生（FIXED DECISIONS 5/8 单一事实源）：
 * 端口恒显式写（80/443 不省略），故 `https://example.com` 与
 * `https://example.com:443` 映射同一 hostKey；仅 http 80 / https 443 合法
 *（ApprovedTarget 已由 NetworkPolicy 闭合为 80|443）。
 */
export function deriveHostKey(input: { scheme: PublicScheme; host: string; port: 80 | 443 }): string {
  return `${input.host}:${input.port}`;
}

export type HostGateResult =
  | { ok: true }
  | { ok: false; reason: 'aborted' | 'deadline' | 'clock-invalid' };

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

export class HostRequestGate {
  private readonly clock: Clock;
  private readonly gapMs: number;
  private readonly registry = new Map<string, number>();

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

  /** 幂等清理（dispose/生命周期；重复调用安全）。 */
  clear(): void {
    this.registry.clear();
  }

  /** 非登记可用性等待：仅当 now−lastStartedAt≥gap 时立即放行，不登记 start。 */
  waitUntilAvailable(hostKey: string, options?: HostGateAcquireOptions): Promise<HostGateResult> {
    return this.waitForGap(hostKey, options, false);
  }

  /** 登记式 acquire：等待 gap 满足后登记 lastStartedAt=now 并放行（实际 socket start 前）。 */
  acquire(hostKey: string, options?: HostGateAcquireOptions): Promise<HostGateResult> {
    return this.waitForGap(hostKey, options, true);
  }

  private waitForGap(
    hostKey: string,
    options: HostGateAcquireOptions | undefined,
    register: boolean,
  ): Promise<HostGateResult> {
    const signal = options?.signal;
    const deadline = options?.deadlineMs;
    return new Promise<HostGateResult>((resolve) => {
      let timer: TimerHandle | null = null;
      let deadlineTimer: TimerHandle | null = null;
      let settled = false;
      const settle = (result: HostGateResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const cleanup = (): void => {
        for (const t of [timer, deadlineTimer]) {
          if (t !== null) {
            try {
              this.clock.clearTimeout(t);
            } catch {
              // 单项失败继续剩余清理
            }
          }
        }
        timer = null;
        deadlineTimer = null;
        if (signal !== undefined) {
          try {
            signal.removeEventListener('abort', onAbort);
          } catch {
            // 单项失败继续剩余清理
          }
        }
      };
      const onAbort = (): void => settle({ ok: false, reason: 'aborted' });
      const nowMs = (): number => this.clock.now().getTime();

      if (signal !== undefined) {
        if (signal.aborted) {
          settle({ ok: false, reason: 'aborted' });
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const failIfDeadline = (): boolean => {
        if (deadline !== undefined && Number.isFinite(deadline) && nowMs() >= deadline) {
          settle({ ok: false, reason: 'deadline' });
          return true;
        }
        return false;
      };
      const now = nowMs();
      if (!Number.isFinite(now)) {
        settle({ ok: false, reason: 'clock-invalid' });
        return;
      }
      if (failIfDeadline()) return;
      const last = this.registry.get(hostKey);
      const elapsed = last === undefined ? Number.POSITIVE_INFINITY : now - last;
      if (elapsed >= this.gapMs) {
        if (register) this.registry.set(hostKey, now);
        settle({ ok: true });
        return;
      }
      const waitMs = this.gapMs - elapsed;
      // gap timer：补齐到间隔满；deadline timer：截止先到则受控失败（单调有界等待）。
      // 二者谁先到谁定终态（settle 单次守卫）；deadline timer 保证不越过外部截止。
      timer = this.clock.setTimeout(() => {
        if (failIfDeadline()) return;
        const grantedAt = nowMs();
        if (register) this.registry.set(hostKey, grantedAt);
        settle({ ok: true });
      }, waitMs);
      if (deadline !== undefined && Number.isFinite(deadline)) {
        const dWait = Math.max(0, deadline - now);
        deadlineTimer = this.clock.setTimeout(() => settle({ ok: false, reason: 'deadline' }), dWait);
      }
    });
  }
}
