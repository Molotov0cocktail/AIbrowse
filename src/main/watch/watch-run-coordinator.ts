// D5 watch-run-coordinator: 运行所有权/并发/abort/drain 编排（detailed-design
// §4.2–§4.4/§7/§10.3、threat-model §3.6/WRT-16、FIXED DECISIONS 1/4/6/7/8）。
// - 只消费已批准的窄端口：WatchRepository（reservation/终态事务）、
//   WatchRevalidator（revalidateRuleSource）、WatchAcquisitionPort（D6 接缝）、
//   HostRequestGate、SchedulerPort（upsert/remove/stop）；零 Electron、零网络能力；
// - 同 Rule 永不并发（reservation CAS + 内存 active 集合双保险）；global=4/host=1
//   并发；同 host 相邻 start ≥5s（host gate）；90s 总超时（AbortController）；
//   单 run 内至多一次重试（重试重过 host gate）；429 零立即重试 + max(阶梯, Retry-After)；
//   退避阶梯/健康映射/审计 reason 均为确定性纯函数（本模块导出，测试直接断言）；
// - 每 run 两次 Source revalidation（acquisition 前、结果事务前）；第二次不一致 →
//   丢弃结果、aborted/superseded、零网络重试；
// - stop-admission → abort → drain → close 幂等可重复；退出路径不写复杂终态
//   （未完成行留待下次启动标 interrupted）。
import { randomUUID } from 'node:crypto';
import { logWarn, logError, logInfo } from '../logger';
import {
  MAX_GLOBAL_WATCH_RUNS,
  MAX_HOST_WATCH_RUNS,
  WATCH_RUN_TIMEOUT_MS,
  type Clock,
  type TimerHandle,
  type WatchAcquisition,
  type WatchAcquisitionResult,
  type WatchFailureCode,
  type WatchHealthSnapshot,
  type WatchProcessingService,
  type WatchRule,
  type WatchRunOutcome,
  type WatchRunTrigger,
} from '../../shared/types/watch';
import type { WatchRevalidationResult } from './watch-lifecycle-coordinator';
import type { WatchRepository } from './repository/watch-repository';
import type { WatchAuditReasonCode } from './db/watch-migrations';
import { HostRequestGate, deriveHostKey } from './host-request-gate';
import {
  backoffDelayFor,
  computeJitterMs,
  computeNextDueAt,
  effectiveDueAtMs,
} from './watch-scheduler';

// ---------------------------------------------------------------------------
// 确定性纯决策函数（供测试直接断言；零 IO）
// ---------------------------------------------------------------------------

// 立即健康暂停原因（§7/#S6-044：login_required/captcha/robots_disallowed/
// security_rejected/dependency_unavailable）
const IMMEDIATE_PAUSE_CODES: ReadonlySet<WatchFailureCode> = new Set([
  'login_required',
  'captcha',
  'robots_disallowed',
  'security_rejected',
  'dependency_unavailable',
]);

export function isImmediatePauseCode(code: WatchFailureCode): boolean {
  return IMMEDIATE_PAUSE_CODES.has(code);
}

// 仅 unavailable 在单 run 内可重试一次（§7：budget/依赖/暂停/parse 均零重试）
export function isRetryableFailure(code: WatchFailureCode): boolean {
  return code === 'unavailable';
}

/**
 * run 终态健康映射（FIXED 6/§7 表，#S6-044）：
 * - login/captcha/robots/security/dependency_unavailable → paused（立即健康暂停）；
 * - parse_changed：连续第 2 次暂停、第 1 次 degraded；
 * - unavailable：连续第 3 次起 degraded（第 1/2 次 healthy）；
 * - budget_exceeded → healthy（仅失败不降级不暂停）。
 */
export function mapRunHealth(
  code: WatchFailureCode,
  consecutiveFailuresAfter: number,
  acquisition: WatchAcquisition = 'rss',
): WatchHealthSnapshot {
  if (IMMEDIATE_PAUSE_CODES.has(code)) {
    return { state: 'paused', acquisition, code };
  }
  if (code === 'parse_changed') {
    return consecutiveFailuresAfter >= 2
      ? { state: 'paused', acquisition, code }
      : { state: 'degraded', acquisition, code };
  }
  if (code === 'unavailable') {
    return consecutiveFailuresAfter >= 3
      ? { state: 'degraded', acquisition, code }
      : { state: 'healthy', acquisition, code: null };
  }
  return { state: 'healthy', acquisition, code: null };
}

// 健康暂停审计 reason（kind='lifecycle-pause'，FIXED 7）
export type HealthPauseAuditReason =
  | 'login-required'
  | 'captcha'
  | 'parse-changed'
  | 'robots-disallowed'
  | 'security-rejected'
  | 'dependency-unavailable';

export function healthPauseAuditReason(code: WatchFailureCode): HealthPauseAuditReason | null {
  switch (code) {
    case 'login_required':
      return 'login-required';
    case 'captcha':
      return 'captcha';
    case 'parse_changed':
      return 'parse-changed';
    case 'robots_disallowed':
      return 'robots-disallowed';
    case 'security_rejected':
      return 'security-rejected';
    case 'dependency_unavailable':
      return 'dependency-unavailable';
    default:
      return null;
  }
}

function hyphenateFailureCode(code: WatchFailureCode): WatchAuditReasonCode | null {
  switch (code) {
    case 'login_required':
      return 'login-required';
    case 'captcha':
      return 'captcha';
    case 'parse_changed':
      return 'parse-changed';
    case 'unavailable':
      return 'unavailable';
    case 'robots_disallowed':
      return 'robots-disallowed';
    case 'security_rejected':
      return 'security-rejected';
    case 'budget_exceeded':
      return 'budget-exceeded';
    case 'dependency_unavailable':
      return 'dependency-unavailable';
    case 'interrupted':
      return 'interrupted';
    default:
      return null;
  }
}

// run 审计 reason（FIXED 7）：unchanged→unchanged；failed{health}→连字符化；
// aborted→aborted；D7 的 baseline/changed/event 终态统一按成功 unchanged 记账
//（D7 引入更细码时按同一迁移模式追加 v3+）。
export function auditReasonForRunOutcome(outcome: WatchRunOutcome): WatchAuditReasonCode | null {
  switch (outcome.kind) {
    case 'unchanged':
    case 'baseline-established':
    case 'changed-unmatched':
    case 'event-created':
    case 'event-deduplicated':
      return 'unchanged';
    case 'failed':
      return hyphenateFailureCode(outcome.health);
    case 'aborted':
      return 'aborted';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// WatchAcquisitionPort（D7：统一 acquisition DTO；Feed/Page 由
// WatchAcquisitionService 路由，Coordinator 只传 hint 并消费结果）
// ---------------------------------------------------------------------------

export interface WatchAcquisitionPort {
  run(input: {
    rule: WatchRule;
    runId: string;
    requestKey: string;
    scheduledFor: string | null;
    hostKey: string;
    baselineHint: import('../../shared/types/watch').WatchBaselineHint;
    signal: AbortSignal;
    deadline: Date;
  }): Promise<WatchAcquisitionResult>;
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export interface WatchRevalidatorPort {
  revalidateRuleSource(ruleId: string): WatchRevalidationResult;
}

export interface SchedulerPort {
  initialize(entries: readonly { ruleId: string; effectiveDueAt: number }[]): void;
  upsert(entry: { ruleId: string; effectiveDueAt: number }): void;
  remove(ruleId: string): void;
  stop(): void;
}

export interface WatchRunCoordinatorOptions {
  repo: WatchRepository;
  revalidator: WatchRevalidatorPort;
  acquisition: WatchAcquisitionPort;
  processing: WatchProcessingService;
  hostGate: HostRequestGate;
  scheduler: SchedulerPort;
  clock: Clock;
}

export type ManualRunResult =
  | { ok: true; runId: string; reused: boolean }
  | {
      ok: false;
      reason: 'stopped' | 'unavailable' | 'rule-not-found' | 'rule-disabled' | 'invalid-request';
    };

interface RunTask {
  ruleId: string;
  runId: string;
  trigger: WatchRunTrigger;
  requestKey: string;
  scheduledFor: string | null;
  hostKey: string; // 恒非空（URL 不可解析时统一 'nohost'，极端边界不崩溃）
  earliestStartMs: number;
}

interface ActiveRun {
  task: RunTask;
  controller: AbortController;
}

export class WatchRunCoordinator {
  private readonly repo: WatchRepository;
  private readonly revalidator: WatchRevalidatorPort;
  private readonly acquisition: WatchAcquisitionPort;
  private readonly processing: WatchProcessingService;
  private readonly hostGate: HostRequestGate;
  private readonly scheduler: SchedulerPort;
  private readonly clock: Clock;

  private pending: RunTask[] = [];
  private active = new Map<string, ActiveRun>();
  private hostActive = new Map<string, number>();
  private activeGlobal = 0;
  private started = false;
  private stopped = false;
  private unavailable = false;
  private pendingWakeTimer: TimerHandle | null = null;
  private drainPromise: Promise<void> | null = null;

  constructor(options: WatchRunCoordinatorOptions) {
    this.repo = options.repo;
    this.revalidator = options.revalidator;
    this.acquisition = options.acquisition;
    this.processing = options.processing;
    this.hostGate = options.hostGate;
    this.scheduler = options.scheduler;
    this.clock = options.clock;
  }

  // -------------------------------------------------------------------------
  // 状态查询（有界；测试/装配诊断）
  // -------------------------------------------------------------------------

  getState(): {
    mode: 'running' | 'stopped' | 'unavailable';
    pendingCount: number;
    activeCount: number;
  } {
    const mode = this.unavailable ? 'unavailable' : this.stopped ? 'stopped' : 'running';
    return { mode, pendingCount: this.pending.length, activeCount: this.active.size };
  }

  pendingRunCount(): number {
    return this.pending.length;
  }

  activeRunCount(): number {
    return this.active.size;
  }

  // -------------------------------------------------------------------------
  // 生命周期：start（载入全部 enabled 规则）/ stop（stop-admission→abort→drain）
  // -------------------------------------------------------------------------

  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    let rules: WatchRule[];
    try {
      rules = this.repo.listRules();
    } catch (err) {
      logError('watch', 'Coordinator 启动读取规则失败（Watch 不可用）', err);
      this.markUnavailable();
      return;
    }
    const entries: Array<{ ruleId: string; effectiveDueAt: number }> = [];
    for (const rule of rules) {
      if (rule.state !== 'enabled') continue;
      const eff = effectiveDueAtMs(rule);
      if (eff === null) continue;
      entries.push({ ruleId: rule.id, effectiveDueAt: eff });
    }
    this.scheduler.initialize(entries);
    logInfo('watch', `Watch 调度启动：${entries.length} 条 enabled 规则载入到期队列`);
  }

  async stop(): Promise<void> {
    // 共享同一排水结果：重复/并发调用返回同一个 drain promise（幂等且不重复 abort/清空）。
    if (this.drainPromise !== null) {
      await this.drainPromise;
      return;
    }
    this.stopped = true;
    // stop-admission：新 tick/manual 全受控拒绝（handleDue/manualRun 检查 stopped）
    this.pending = [];
    this.clearPendingWake();
    // abort 全部在途（signal）→ port 在 raceWithAbort 下立即受控结算
    for (const active of this.active.values()) {
      try {
        active.controller.abort();
      } catch {
        // 幂等
      }
    }
    const drain = this.waitForActiveDrain();
    this.drainPromise = drain;
    await drain;
    // close：scheduler 由装配层调用 stop（本模块只负责自身排水）
  }

  private clearPendingWake(): void {
    if (this.pendingWakeTimer !== null) {
      try {
        this.clock.clearTimeout(this.pendingWakeTimer);
      } catch {
        // 幂等
      }
      this.pendingWakeTimer = null;
    }
  }

  private async waitForActiveDrain(): Promise<void> {
    for (let i = 0; i < 2000 && this.active.size > 0; i += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1);
      });
    }
  }

  private markUnavailable(reason = 'watch.db 操作失败'): void {
    if (this.unavailable) return;
    this.unavailable = true;
    this.stopped = true;
    this.pending = [];
    this.clearPendingWake();
    for (const active of this.active.values()) {
      try {
        active.controller.abort();
      } catch {
        // 幂等
      }
    }
    this.scheduler.stop();
    logWarn('watch', `Watch 进入不可用（停止调度）：${reason}`);
  }

  // -------------------------------------------------------------------------
  // 入口：scheduler.onDue 回调（计划/补跑）与手动 run
  // -------------------------------------------------------------------------

  handleDue(entries: readonly { ruleId: string; trigger: 'catch-up' | 'scheduled' }[]): void {
    if (!this.started || this.stopped || this.unavailable) return;
    const nowMs = this.nowMs();
    for (const entry of entries) {
      if (this.stopped || this.unavailable) return;
      let rule: WatchRule | null;
      try {
        rule = this.repo.getRule(entry.ruleId);
      } catch {
        this.markUnavailable();
        return;
      }
      if (rule === null || rule.state !== 'enabled') continue;
      const consumed = rule.nextDueAt;
      if (consumed === null) continue;
      const advanced = computeNextDueAt({ rule, consumedScheduledFor: consumed, nowMs });
      if (advanced === null) {
        logWarn('watch', `规则 nextDueAt 无法推进（跳过本轮）：rule=${rule.id}`);
        continue;
      }
      const runId = randomUUID();
      const requestKey = `${rule.id}|${consumed}`;
      let reserved;
      try {
        reserved = this.repo.reserveScheduledRun({
          ruleId: rule.id,
          runId,
          requestKey,
          trigger: entry.trigger,
          scheduledFor: consumed,
          expectedNextDueAt: consumed,
          advancedNextDueAt: advanced.nextDueAt,
          advancedLastDailyLocalDate: advanced.lastDailyLocalDate,
          nowIso: this.iso(),
        });
      } catch {
        this.markUnavailable();
        return;
      }
      if (reserved.ok) {
        this.enqueue({
          ruleId: rule.id,
          runId,
          trigger: entry.trigger,
          requestKey,
          scheduledFor: consumed,
          hostKey: this.hostKeyOfRule(rule) ?? 'nohost',
          earliestStartMs: nowMs,
        });
        this.pump();
      } else if (
        reserved.code === 'rule-already-running' ||
        reserved.code === 'rule-state-conflict' ||
        reserved.code === 'rule-not-found'
      ) {
        // 规则已并发/已变：不重复排队（在途运行终态会负责 re-queue）
      } else {
        this.markUnavailable();
        return;
      }
    }
  }

  manualRun(ruleId: string, requestId: string): ManualRunResult {
    if (!this.started || this.stopped || this.unavailable) return { ok: false, reason: 'stopped' };
    if (typeof requestId !== 'string' || requestId === '' || requestId.length > 200) {
      return { ok: false, reason: 'invalid-request' };
    }
    let reserved;
    try {
      reserved = this.repo.reserveManualRun({
        ruleId,
        runId: randomUUID(),
        requestKey: requestId,
        nowIso: this.iso(),
      });
    } catch {
      this.markUnavailable();
      return { ok: false, reason: 'unavailable' };
    }
    if (!reserved.ok) {
      if (reserved.code === 'rule-state-conflict') return { ok: false, reason: 'rule-disabled' };
      if (reserved.code === 'rule-not-found') return { ok: false, reason: 'rule-not-found' };
      this.markUnavailable();
      return { ok: false, reason: 'unavailable' };
    }
    if (reserved.reused === true) {
      return { ok: true, runId: reserved.runId, reused: true };
    }
    let rule: WatchRule | null;
    try {
      rule = this.repo.getRule(ruleId);
    } catch {
      this.markUnavailable();
      return { ok: false, reason: 'unavailable' };
    }
    const backoffUntilMs =
      rule !== null && rule.backoffUntil !== null
        ? Date.parse(rule.backoffUntil)
        : Number.NEGATIVE_INFINITY;
    const earliest = Number.isFinite(backoffUntilMs)
      ? Math.max(this.nowMs(), backoffUntilMs)
      : this.nowMs();
    this.enqueue({
      ruleId,
      runId: reserved.runId,
      trigger: 'manual',
      requestKey: requestId,
      scheduledFor: null,
      hostKey: (rule === null ? null : this.hostKeyOfRule(rule)) ?? 'nohost',
      earliestStartMs: earliest,
    });
    this.pump();
    return { ok: true, runId: reserved.runId, reused: false };
  }

  // -------------------------------------------------------------------------
  // 并发调度：global=4 / host=1；earliestStart 满足且 host 空闲才启动
  // -------------------------------------------------------------------------

  private pump(): void {
    if (this.stopped || this.unavailable) return;
    while (this.activeGlobal < MAX_GLOBAL_WATCH_RUNS) {
      const now = this.nowMs();
      const idx = this.pending.findIndex(
        (t) =>
          t.earliestStartMs <= now && (this.hostActive.get(t.hostKey) ?? 0) < MAX_HOST_WATCH_RUNS,
      );
      if (idx === -1) break;
      const [task] = this.pending.splice(idx, 1);
      void this.executeRun(task);
    }
    this.armPendingWake();
  }

  private enqueue(task: RunTask): void {
    this.pending.push(task);
    this.armPendingWake();
  }

  // 为未来 earliestStart（如手动 run 等 backoff）的单 timer 唤醒；到点后 pump 启动。
  private armPendingWake(): void {
    if (this.pendingWakeTimer !== null) {
      try {
        this.clock.clearTimeout(this.pendingWakeTimer);
      } catch {
        // 幂等
      }
      this.pendingWakeTimer = null;
    }
    if (this.stopped || this.unavailable || this.pending.length === 0) return;
    const now = this.nowMs();
    const earliest = Math.min(...this.pending.map((t) => t.earliestStartMs));
    if (earliest <= now) return; // 无需唤醒：pump 会直接处理
    this.pendingWakeTimer = this.clock.setTimeout(() => {
      this.pendingWakeTimer = null;
      this.pump();
    }, earliest - now);
  }

  // -------------------------------------------------------------------------
  // 单 run 编排：queued→running → 第一次 revalidation → gate/jitter/acquisition
  //（≤1 次重试）→ 第二次 revalidation → 终态事务 → re-queue
  // -------------------------------------------------------------------------

  private async executeRun(task: RunTask): Promise<void> {
    this.activeGlobal += 1;
    const hostKey = task.hostKey;
    this.hostActive.set(hostKey, (this.hostActive.get(hostKey) ?? 0) + 1);
    const controller = new AbortController();
    const deadlineMs = this.nowMs() + WATCH_RUN_TIMEOUT_MS;
    const deadline = new Date(deadlineMs);
    let deadlineTimer: TimerHandle | null = null;
    if (Number.isFinite(deadlineMs)) {
      deadlineTimer = this.clock.setTimeout(() => {
        try {
          controller.abort();
        } catch {
          // 幂等
        }
      }, WATCH_RUN_TIMEOUT_MS);
    }
    this.active.set(task.ruleId, { task, controller });
    try {
      // queued → running
      const started = this.repo.transitionRun(task.runId, 'queued', {
        status: 'running',
        startedAt: this.iso(),
      });
      if (!started.ok) return; // 已终态/规则删除：零处理（不写终态）
      // 第一次 Source revalidation（acquisition 前）
      const reval1 = this.revalidator.revalidateRuleSource(task.ruleId);
      if (reval1.status === 'unavailable') {
        this.markUnavailable('revalidation unavailable');
        return;
      }
      if (reval1.status !== 'ok') {
        // 运行前 Source 失效：零 acquisition、不计数失败、aborted/superseded
        this.terminalSuperseded(task);
        this.requeueIfEnabled(task.ruleId);
        return;
      }
      // 第一次 revalidation 成功后、任何网络前：prepareAcquisition（§8.1）
      const rulePrepared = this.repo.getRule(task.ruleId);
      if (rulePrepared === null) return; // 规则已删除
      const prepared = this.processing.prepareAcquisition({ rule: rulePrepared });
      if (!prepared.ok) {
        this.markUnavailable('prepareAcquisition 失败（store unavailable）');
        return;
      }
      const baselineHint = prepared.baselineHint;
      // host gate（非登记）+ jitter + acquisition（≤1 次重试）
      const jitterMs = computeJitterMs({
        ruleId: task.ruleId,
        hostKey,
        seed: task.scheduledFor ?? task.requestKey,
      });
      let failure: {
        health: WatchFailureCode;
        retryable: boolean;
        retryAfterSeconds: number | null;
      } | null = null;
      let acquired: WatchAcquisitionResult | null = null;
      let attempt = 0;
      while (!this.stopped) {
        attempt += 1;
        if (controller.signal.aborted || this.nowMs() >= deadlineMs) {
          failure = { health: 'unavailable', retryable: true, retryAfterSeconds: null };
          break;
        }
        const gate = await this.hostGate.waitUntilAvailable(hostKey, {
          signal: controller.signal,
          deadlineMs,
        });
        if (!gate.ok) {
          failure = { health: 'unavailable', retryable: true, retryAfterSeconds: null };
          break;
        }
        if (attempt === 1 && jitterMs > 0) {
          const waited = await this.delay(jitterMs, controller.signal, deadlineMs);
          if (!waited) {
            failure = { health: 'unavailable', retryable: true, retryAfterSeconds: null };
            break;
          }
        }
        const ruleNow = this.repo.getRule(task.ruleId);
        if (ruleNow === null) return; // 规则已删除（运行行已级联删除）：零终态
        const result = await this.raceWithAbort(
          this.acquisition.run({
            rule: ruleNow,
            runId: task.runId,
            requestKey: task.requestKey,
            scheduledFor: task.scheduledFor,
            hostKey,
            baselineHint,
            signal: controller.signal,
            deadline,
          }),
          controller.signal,
          (): WatchAcquisitionResult => ({
            ok: false,
            health: 'unavailable',
            retryable: true,
            retryAfterSeconds: null,
            disposition: 'network',
          }),
        );
        if (result.ok) {
          acquired = result;
          break;
        }
        failure = {
          health: result.health,
          retryable: result.retryable,
          retryAfterSeconds: result.retryAfterSeconds,
        };
        const canRetry =
          isRetryableFailure(result.health) &&
          result.retryable === true &&
          attempt < 2 &&
          !controller.signal.aborted &&
          this.nowMs() < deadlineMs;
        if (!canRetry) break;
        // 重试重过 host gate（下次循环开头 waitUntilAvailable）
      }
      if (this.stopped) return; // 退出路径：不写复杂终态（留待下次启动 interrupted）
      // 第二次 Source revalidation（结果事务前；§10.3 步骤 5）
      const reval2 = this.revalidator.revalidateRuleSource(task.ruleId);
      if (reval2.status === 'unavailable') {
        this.markUnavailable('revalidation unavailable');
        return;
      }
      if (reval2.status !== 'ok') {
        // 第二次不一致：丢弃结果、aborted/superseded、零网络重试
        this.terminalSuperseded(task);
        this.requeueIfEnabled(task.ruleId);
        return;
      }
      if (acquired !== null) {
        // ProcessingService 统一编排结果事务（§8.1）：成功终态由 processing 单事务
        // 写定；identity/baseline/event-conflict 为零写 conflict（不另写 Run audit）。
        const ruleNow = this.repo.getRule(task.ruleId);
        if (ruleNow === null) return;
        const processed = this.processing.process({
          rule: ruleNow,
          runId: task.runId,
          baselineHint,
          acquisition: acquired,
          sourceAfterAcquisition: reval2.sourceAfterAcquisition,
        });
        if (!processed.ok) {
          logWarn(
            'watch',
            `结果处理 conflict（rule=${task.ruleId}，code=${processed.code}；零写，交协调/恢复）`,
          );
          // zero-write conflict：不写 Run 终态、不计数失败
        }
      } else {
        const mapped = this.failureTerminal(task.ruleId, failure!);
        this.writeTerminal(task, mapped.outcome, mapped.health, {
          consecutiveFailures: mapped.consecutiveFailures,
          backoffUntil: mapped.backoffUntil,
          healthPauseReason: mapped.healthPauseReason,
        });
      }
      this.requeueIfEnabled(task.ruleId);
    } catch (err) {
      logError('watch', `运行编排异常（run=${task.runId}）`, err);
      this.markUnavailable();
    } finally {
      if (deadlineTimer !== null) {
        try {
          this.clock.clearTimeout(deadlineTimer);
        } catch {
          // 幂等
        }
      }
      try {
        controller.abort();
      } catch {
        // 幂等
      }
      this.active.delete(task.ruleId);
      this.activeGlobal -= 1;
      const next = (this.hostActive.get(hostKey) ?? 1) - 1;
      if (next <= 0) this.hostActive.delete(hostKey);
      else this.hostActive.set(hostKey, next);
      this.pump();
    }
  }

  private failureTerminal(
    ruleId: string,
    failure: { health: WatchFailureCode; retryable: boolean; retryAfterSeconds: number | null },
  ): {
    outcome: WatchRunOutcome;
    health: WatchHealthSnapshot;
    consecutiveFailures: number;
    backoffUntil: string | null;
    healthPauseReason: HealthPauseAuditReason | null;
  } {
    const rule = this.repo.getRule(ruleId)!;
    const cf = rule.consecutiveFailures + 1;
    const nowMs = this.nowMs();
    const health = mapRunHealth(failure.health, cf, 'rss');
    const outcome: WatchRunOutcome = {
      kind: 'failed',
      health: failure.health,
      retryable: isRetryableFailure(failure.health) && failure.retryAfterSeconds === null,
    };
    let backoffUntil: string | null = null;
    let healthPauseReason: HealthPauseAuditReason | null = null;
    if (isImmediatePauseCode(failure.health)) {
      backoffUntil = null;
      healthPauseReason = healthPauseAuditReason(failure.health);
    } else if (failure.health === 'parse_changed') {
      backoffUntil = null;
      if (cf >= 2) healthPauseReason = healthPauseAuditReason(failure.health);
    } else if (failure.health === 'unavailable') {
      const ladder = backoffDelayFor(cf);
      const retryAfterMs =
        failure.retryAfterSeconds !== null ? failure.retryAfterSeconds * 1000 : 0;
      const effectiveWait = Number.isFinite(retryAfterMs) ? Math.max(ladder, retryAfterMs) : ladder;
      backoffUntil = new Date(nowMs + effectiveWait).toISOString();
    }
    // budget_exceeded：不重试、不暂停、不设 backoff（dependency_unavailable 已走
    // 上方立即健康暂停分支，同样零重试零退避）
    return { outcome, health, consecutiveFailures: cf, backoffUntil, healthPauseReason };
  }

  private terminalSuperseded(task: RunTask): void {
    const outcome: WatchRunOutcome = { kind: 'aborted', reason: 'superseded' };
    const health: WatchHealthSnapshot = { state: 'healthy', acquisition: 'rss', code: null };
    let rule: WatchRule | null;
    try {
      rule = this.repo.getRule(task.ruleId);
    } catch {
      this.markUnavailable();
      return;
    }
    // superseded：不计数失败、不设 backoff（Source 变化不是网络失败）
    this.writeTerminal(task, outcome, health, {
      consecutiveFailures: rule?.consecutiveFailures ?? 0,
      backoffUntil: rule?.backoffUntil ?? null,
      healthPauseReason: null,
    });
  }

  private writeTerminal(
    task: RunTask,
    outcome: WatchRunOutcome,
    health: WatchHealthSnapshot,
    params: {
      consecutiveFailures: number;
      backoffUntil: string | null;
      healthPauseReason: HealthPauseAuditReason | null;
    },
  ): void {
    const nowIso = this.iso();
    const runAuditReason = auditReasonForRunOutcome(outcome);
    if (runAuditReason === null) {
      this.markUnavailable('run 审计 reason 无法映射');
      return;
    }
    const input: Parameters<WatchRepository['finalizeRun']>[0] = {
      runId: task.runId,
      ruleId: task.ruleId,
      outcome,
      health,
      consecutiveFailures: params.consecutiveFailures,
      backoffUntil: params.backoffUntil,
      runAudit: { id: randomUUID(), reasonCode: runAuditReason, createdAt: nowIso },
    };
    if (params.healthPauseReason !== null) {
      input.healthPause = {
        reason: params.healthPauseReason,
        audit: { id: randomUUID(), createdAt: nowIso },
      };
    }
    const result = this.repo.finalizeRun(input);
    if (!result.ok) {
      if (result.code === 'run-state-conflict' || result.code === 'run-not-found') {
        // 已终态/已删除：幂等跳过
        return;
      }
      this.markUnavailable('终态事务失败');
    }
  }

  private requeueIfEnabled(ruleId: string): void {
    if (this.stopped || this.unavailable) return;
    let rule: WatchRule | null;
    try {
      rule = this.repo.getRule(ruleId);
    } catch {
      this.markUnavailable();
      return;
    }
    if (rule !== null && rule.state === 'enabled') {
      const eff = effectiveDueAtMs(rule);
      if (eff !== null) {
        this.scheduler.upsert({ ruleId, effectiveDueAt: eff });
        return;
      }
    }
    this.scheduler.remove(ruleId);
  }

  // -------------------------------------------------------------------------
  // 小工具
  // -------------------------------------------------------------------------

  private nowMs(): number {
    return this.clock.now().getTime();
  }

  private iso(): string {
    return new Date(this.clock.now().getTime()).toISOString();
  }

  private hostKeyOfRule(rule: WatchRule): string | null {
    const url = rule.target.type === 'feed' ? rule.target.feedUrl : rule.target.pageUrl;
    try {
      const u = new URL(url);
      const scheme = u.protocol === 'https:' ? 'https' : u.protocol === 'http:' ? 'http' : null;
      if (scheme === null) return null;
      const host = u.hostname.toLowerCase();
      const port = u.port === '' ? (scheme === 'https' ? 443 : 80) : Number(u.port);
      if (port !== 80 && port !== 443) return null;
      return deriveHostKey({ scheme, host, port: port as 80 | 443 });
    } catch {
      return null;
    }
  }

  private delay(ms: number, signal: AbortSignal, deadlineMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let timer: TimerHandle | null = null;
      let settled = false;
      const settle = (value: boolean): void => {
        if (settled) return;
        settled = true;
        // abort 分支也必须立即清除对应 timer，不得依赖未来推进时钟才清理
        if (timer !== null) {
          try {
            this.clock.clearTimeout(timer);
          } catch {
            // 幂等
          }
          timer = null;
        }
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          // 幂等
        }
        resolve(value);
      };
      const onAbort = (): void => settle(false);
      const remaining = deadlineMs - this.nowMs();
      if (signal.aborted || remaining <= 0) {
        resolve(false);
        return;
      }
      const wait = Math.min(Math.max(0, ms), remaining);
      signal.addEventListener('abort', onAbort, { once: true });
      timer = this.clock.setTimeout(() => settle(true), wait);
    });
  }

  private raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => T): Promise<T> {
    return new Promise<T>((resolve) => {
      let settled = false;
      const done = (value: T): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      promise.then(done, () => done(onAbort()));
      const onSignal = (): void => done(onAbort());
      if (signal.aborted) {
        onSignal();
        return;
      }
      signal.addEventListener('abort', onSignal, { once: true });
    });
  }
}
