import { randomBytes } from 'node:crypto';
import type { QualificationPhase, QualificationSample } from './native-contract';
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
  private failed = false;
  private stopped = false;
  private nextHeartbeatMs = 0;
  private nextOrdinal = 0;
  private m0Ms = 0;
  private diagnostic = false;
  private finalOrdinal = 420;
  private admissionDeadlineMs = 0;
  private endingTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.armEnding();
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
    if (this.endingTimer !== null) clearTimeout(this.endingTimer);
    this.observer = null;
    this.heartbeat = null;
    this.endingTimer = null;
  }

  private armNext(): void {
    const ordinal = this.nextOrdinal;
    if (ordinal > this.finalOrdinal) return;
    const targetMs = this.m0Ms - 600_000 + ordinal * 10_000;
    this.observer = setTimeout(
      () => {
        this.observer = null;
        try {
          this.sample(ordinal, targetMs);
        } catch {
          this.failed = true;
          this.fail('sample-failed');
        }
      },
      Math.max(
        0,
        targetMs - (ordinal === this.finalOrdinal ? 1_000 : 0) - this.qpc.now().getTime(),
      ),
    );
  }

  private armHeartbeat(): void {
    if (this.stopped || this.failed) return;
    this.heartbeat = setTimeout(
      () => {
        this.heartbeat = null;
        void this.sequencer.send('heartbeat', { qpcTicks: this.qpc.readTicks() });
        this.nextHeartbeatMs += 10_000;
        this.armHeartbeat();
      },
      Math.max(0, this.nextHeartbeatMs - this.qpc.now().getTime()),
    );
  }

  private sample(ordinal: number, targetMs: number): void {
    if (this.stopped || ordinal !== this.nextOrdinal) this.fail('sample-state');
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
    // Keep late observations as evidence. The reporter applies each slot's QPC window.
    this.capture(phase, slotIndex, targetMs);
    ++this.nextOrdinal;
    this.armNext();
  }

  private capture(phase: QualificationPhase, slotIndex: number, targetMs: number): void {
    const trigger = this.qpc.readTicks();
    const begin = this.qpc.readTicks();
    const prefix = this.sequencer.prefix;
    // No await or owner mutation: this is a single main-thread registry prefix.
    const values = this.product.snapshot();
    const counters = this.registry.counters();
    const registryLive = this.registry.snapshot();
    const end = this.qpc.readTicks();
    if (this.sequencer.prefix !== prefix) this.fail('sample-snapshot-mutation');
    void this.sequencer.send(
      'sample',
      {
        ...values,
        counters,
        phase,
        registryLive,
        registryPrefixSequence: prefix,
        sampleToken: qualificationSampleToken(),
        timing: {
          linearizedQpcTicks: begin,
          slotQpcTicks: this.qpc.ticksForUtc(targetMs),
          snapshotQpcTicks: end,
          triggerQpcTicks: trigger,
        },
      },
      slotIndex,
    );
  }

  private armEnding(): void {
    this.endingTimer = setTimeout(
      () => {
        this.endingTimer = null;
        // A timer may fire early after conversion to whole milliseconds.
        if (
          parseQpcTicks(this.qpc.readTicks()) <
          parseQpcTicks(this.qpc.ticksForUtc(this.admissionDeadlineMs))
        ) {
          this.armEnding();
          return;
        }
        void this.end().catch(() => {
          this.failed = true;
          this.fail('shutdown-failed');
        });
      },
      Math.max(0, this.admissionDeadlineMs - this.qpc.now().getTime()),
    );
  }

  private async end(): Promise<void> {
    this.stopped = true;
    this.product.closeAdmission();
    this.registry.closeAdmission();
    this.stopObservers();
    void this.sequencer.send('stop', {
      admissionClosedQpcTicks: this.qpc.ticksForUtc(this.admissionDeadlineMs),
      observedQpcTicks: this.qpc.readTicks(),
      reason: 'normal-exit',
    });
    this.capture('drain', 0, this.admissionDeadlineMs);
    // Writer completion does not delay the product's shutdown deadline.
    await this.product.shutdown();
    const live = this.registry.snapshot();
    if (
      this.businessClock.pendingCount !== 0 ||
      live.some((row) => row.identities.length !== 0) ||
      Object.values(this.registry.counters()).some((value) => value !== 0)
    )
      this.fail('complete-live-resources');
    this.businessClock.stop();
    await this.sequencer.send('complete', {
      counters: this.registry.counters(),
      registryLive: live,
    });
    await this.product.completed();
  }
}
