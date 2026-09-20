import { randomBytes } from 'node:crypto';
import type { QualificationPhase, QualificationSample, QpcTicks } from './native-contract';
import { QualificationPausableClock } from './pausable-clock';
import { QualificationQpcClock, parseQpcTicks } from './qpc';
import { QualificationRegistry } from './registry';
import { QualificationSequencer } from './telemetry';

export interface QualificationSamplePort {
  snapshot(): Pick<
    QualificationSample,
    | 'mainHeapUsedBytes'
    | 'nodeActiveByType'
    | 'taskTabBindings'
    | 'watchLogicalDbBytes'
    | 'webContentsIds'
  >;
  closeAdmission(): void;
  onResumed(phase: QualificationPhase, index: number): void;
  onBarrierResumed?(pause: QpcTicks, resume: QpcTicks): void;
  shutdown(): Promise<void>;
  completed(): Promise<void>;
}

export function qualificationSampleToken(): string {
  const bytes = randomBytes(16);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) out += alphabet[(accumulator << (5 - bits)) & 31];
  return out;
}

export function readNodeActiveResources(): { type: string; count: number }[] {
  const values = process.getActiveResourcesInfo();
  if (!Array.isArray(values)) throw new Error('资格Node资源读取无效');
  const counts = new Map<string, number>();
  for (const value of values) {
    if (typeof value !== 'string') throw new Error('资格Node资源类型无效');
    const type = value.normalize('NFC');
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(type)) throw new Error('资格Node资源类型无效');
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts]
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(([type, count]) => ({ type, count }));
}

/** Observer timers stay outside the business Clock and remain in Node/Job totals. */
export class QualificationSampler {
  private observer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private failed = false;
  private stopped = false;
  private nextHeartbeatMs = 0;
  private nextOrdinal = 0;
  private m0Ms = 0;
  private diagnostic = false;
  private finalOrdinal = 420;
  private admissionDeadlineMs = 0;
  private heartbeatPending = false;

  constructor(
    private readonly qpc: QualificationQpcClock,
    private readonly businessClock: QualificationPausableClock,
    private readonly registry: QualificationRegistry,
    private readonly sequencer: QualificationSequencer,
    private readonly product: QualificationSamplePort,
    private readonly fail: (code: string) => never,
  ) {}

  startHeartbeat(): void {
    this.nextHeartbeatMs = this.qpc.now().getTime() + 10_000;
    this.armHeartbeat();
  }

  start(m0Ms: number): void {
    if (this.m0Ms !== 0 || !Number.isSafeInteger(m0Ms)) this.fail('sample-state');
    this.m0Ms = m0Ms;
    this.admissionDeadlineMs = this.diagnostic
      ? m0Ms - 600_000 + this.finalOrdinal * 10_000
      : m0Ms + 3_600_000;
    this.armNext();
  }

  startDiagnostic(): void {
    if (!__WATCH_QUALIFICATION_DIAGNOSTIC__) this.fail('diagnostic-build-required');
    this.diagnostic = true;
    this.finalOrdinal = 1;
    this.start(this.qpc.now().getTime() + 610_000);
  }

  startLoadDiagnostic(): void {
    if (!__WATCH_QUALIFICATION_DIAGNOSTIC__ || !__WATCH_QUALIFICATION_LOAD_DIAGNOSTIC__)
      this.fail('diagnostic-build-required');
    this.diagnostic = true;
    this.finalOrdinal = 3;
    this.start(this.qpc.now().getTime() + 610_000);
  }

  isAdmissionOpen(): boolean {
    return (
      !this.active &&
      !this.stopped &&
      !this.failed &&
      (this.m0Ms === 0 ||
        parseQpcTicks(this.qpc.readTicks()) <
          parseQpcTicks(this.qpc.ticksForUtc(this.admissionDeadlineMs)))
    );
  }

  stopObservers(): void {
    if (this.observer !== null) clearTimeout(this.observer);
    if (this.heartbeat !== null) clearTimeout(this.heartbeat);
    this.observer = null;
    this.heartbeat = null;
  }

  private armNext(): void {
    const ordinal = this.nextOrdinal;
    if (ordinal > this.finalOrdinal) return;
    const targetMs = this.m0Ms - 600_000 + ordinal * 10_000;
    this.observer = setTimeout(
      () => {
        this.observer = null;
        void this.sample(ordinal, targetMs).catch(() => {
          this.failed = true;
          this.fail('sample-failed');
        });
      },
      Math.max(0, targetMs - this.qpc.now().getTime()),
    );
  }

  private armHeartbeat(): void {
    if (this.stopped || this.failed) return;
    this.heartbeat = setTimeout(
      () => {
        this.heartbeat = null;
        if (!this.active) void this.sequencer.send('heartbeat', { qpcTicks: this.qpc.readTicks() });
        else this.heartbeatPending = true;
        this.nextHeartbeatMs += 10_000;
        this.armHeartbeat();
      },
      Math.max(0, this.nextHeartbeatMs - this.qpc.now().getTime()),
    );
  }

  private async sample(ordinal: number, targetMs: number): Promise<void> {
    const trigger = this.qpc.readTicks();
    if (this.active || ordinal !== this.nextOrdinal) this.fail('sample-overlap');
    const phase =
      this.diagnostic && ordinal === this.finalOrdinal
        ? 'measurement'
        : ordinal < 60
          ? 'warmup'
          : 'measurement';
    const slotIndex = this.diagnostic
      ? ordinal === this.finalOrdinal
        ? 0
        : ordinal
      : ordinal < 60
        ? ordinal
        : ordinal - 60;
    const slotTicks = this.qpc.ticksForUtc(targetMs);
    if (
      parseQpcTicks(trigger) < parseQpcTicks(slotTicks) ||
      !this.qpc.within(slotTicks, trigger, 2_000)
    ) {
      this.fail('sample-trigger-deadline');
    }
    this.active = true;
    const ending = ordinal === this.finalOrdinal;
    if (ending) {
      this.stopped = true;
      this.product.closeAdmission();
      this.registry.closeAdmission();
      void this.sequencer.send('stop', {
        admissionClosedQpcTicks: slotTicks,
        observedQpcTicks: trigger,
        reason: 'normal-exit',
      });
    }
    this.businessClock.pause();
    await this.sequencer.flush();
    const linearized = this.qpc.readTicks();
    if (!this.qpc.within(trigger, linearized, 500)) this.fail('sample-linearize-deadline');
    this.registry.freeze();
    const prefix = this.sequencer.prefix;
    const values = this.product.snapshot();
    const snapshot = this.qpc.readTicks();
    const token = qualificationSampleToken();
    const receipt = await this.sequencer.send(
      'sample',
      {
        ...values,
        counters: this.registry.counters(),
        phase,
        registryLive: this.registry.snapshot(),
        registryPrefixSequence: prefix,
        sampleToken: token,
        timing: {
          linearizedQpcTicks: linearized,
          slotQpcTicks: slotTicks,
          snapshotQpcTicks: snapshot,
          triggerQpcTicks: trigger,
        },
      },
      slotIndex,
    );
    const completed = receipt.writeCompletedQpcTicks;
    if (
      !this.qpc.within(linearized, completed, 250) ||
      !this.qpc.within(trigger, completed, 750) ||
      parseQpcTicks(completed) < parseQpcTicks(snapshot)
    )
      this.fail('sample-write-deadline');
    const closeTarget = [this.qpc.addMs(trigger, 1_750), this.qpc.addMs(completed, 1_000)].sort(
      (a, b) =>
        parseQpcTicks(a) < parseQpcTicks(b) ? -1 : parseQpcTicks(a) > parseQpcTicks(b) ? 1 : 0,
    )[0]!;
    await this.waitUntil(closeTarget);
    const close = this.qpc.readTicks();
    if (
      this.sequencer.prefix !== prefix + 1 ||
      !this.qpc.within(trigger, close, 2_000) ||
      !this.qpc.within(completed, close, 1_250)
    )
      this.fail('sample-close-deadline');
    void this.sequencer.send(
      'sample-closed',
      {
        closeQpcTicks: close,
        phase,
        registryPrefixSequence: prefix,
        sampleToken: token,
        sampleWriteCompletedQpcTicks: completed,
      },
      slotIndex,
    );
    this.registry.thaw();
    if (ending) this.businessClock.stop();
    this.businessClock.resume();
    const resumed = this.qpc.readTicks();
    if (!this.qpc.within(close, resumed, 250)) this.fail('sample-resume-deadline');
    void this.sequencer.send(
      'sample-resumed',
      { phase, resumeQpcTicks: resumed, sampleToken: token },
      slotIndex,
    );
    this.active = false;
    if (this.heartbeatPending && !ending) {
      this.heartbeatPending = false;
      void this.sequencer.send('heartbeat', { qpcTicks: this.qpc.readTicks() });
    }
    ++this.nextOrdinal;
    this.product.onBarrierResumed?.(trigger, resumed);
    this.product.onResumed(phase, slotIndex);
    if (ending) {
      this.stopObservers();
      await this.product.shutdown();
      const live = this.registry.snapshot();
      if (
        live.some((row) => row.identities.length !== 0) ||
        Object.values(this.registry.counters()).some((value) => value !== 0)
      ) {
        this.fail('complete-live-resources');
      }
      await this.sequencer.send('complete', {
        counters: this.registry.counters(),
        registryLive: live,
      });
      await this.product.completed();
      return;
    }
    this.armNext();
  }

  private waitUntil(target: QpcTicks): Promise<void> {
    return new Promise((resolve) => {
      const arm = (): void => {
        const now = this.qpc.readTicks();
        if (parseQpcTicks(now) >= parseQpcTicks(target)) {
          resolve();
          return;
        }
        this.observer = setTimeout(arm, this.qpc.elapsedMs(now, target));
      };
      arm();
    });
  }
}
