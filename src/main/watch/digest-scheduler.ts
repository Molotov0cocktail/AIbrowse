// D8 zero-capability daily Digest scheduler. It owns only Clock/timers and a
// deterministic due queue; all persistence, membership and Provider work is
// delegated as an opaque schedule identity to DigestService.
import type { Clock, TimerHandle } from '../../shared/types/watch';
import { localDateOf } from './watch-scheduler';

export interface DigestSchedulerEntry {
  scheduleId: string;
  expectedNextDueAt: string;
  timeZone: string;
}

export interface DigestDueEntry extends DigestSchedulerEntry {
  logicalDate: string;
}

export class DigestScheduler {
  private readonly entries = new Map<string, DigestSchedulerEntry>();
  private timer: TimerHandle | null = null;
  private stopped = false;
  private startupHeld: boolean;
  private maintenanceGeneration: number | null = null;
  private lastMaintenanceGeneration = 0;
  private maintenanceDrained = false;
  private maintenanceResumePrepared = false;
  private timerEpoch = 0;

  constructor(
    private readonly clock: Clock,
    private readonly onDue: (entry: DigestDueEntry) => void,
    options: { startupHold?: boolean } = {},
  ) {
    this.startupHeld = options.startupHold ?? false;
  }

  releaseStartup(): boolean {
    if (this.stopped) return false;
    if (!this.startupHeld) return true;
    this.startupHeld = false;
    this.arm();
    return true;
  }

  initialize(entries: readonly DigestSchedulerEntry[]): void {
    if (this.stopped) return;
    for (const entry of entries) this.entries.set(entry.scheduleId, { ...entry });
    this.arm();
  }

  upsert(entry: DigestSchedulerEntry): void {
    if (this.stopped) return;
    this.entries.set(entry.scheduleId, { ...entry });
    this.arm();
  }

  remove(scheduleId: string): void {
    this.entries.delete(scheduleId);
    this.arm();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.disarm();
    this.entries.clear();
  }

  pauseForMaintenance(generation: number): boolean {
    if (this.stopped) return false;
    if (this.maintenanceGeneration !== null) return this.maintenanceGeneration === generation;
    if (!Number.isSafeInteger(generation) || generation <= this.lastMaintenanceGeneration)
      return false;
    this.maintenanceGeneration = generation;
    this.lastMaintenanceGeneration = generation;
    this.maintenanceDrained = false;
    this.maintenanceResumePrepared = false;
    this.disarm();
    return true;
  }

  drainForMaintenance(generation: number): Promise<void> {
    if (this.stopped || this.maintenanceGeneration !== generation) {
      return Promise.reject(new Error('Digest 调度维护世代不可用'));
    }
    this.maintenanceDrained = true;
    return Promise.resolve();
  }

  prepareResumeAfterMaintenance(
    generation: number,
    entries: readonly DigestSchedulerEntry[],
  ): boolean {
    if (this.stopped || this.maintenanceGeneration !== generation || !this.maintenanceDrained)
      return false;
    if (this.maintenanceResumePrepared) return true;
    const seen = new Set<string>();
    for (const entry of entries) {
      if (
        entry.scheduleId.length === 0 ||
        !Number.isFinite(Date.parse(entry.expectedNextDueAt)) ||
        seen.has(entry.scheduleId)
      )
        return false;
      seen.add(entry.scheduleId);
    }
    this.entries.clear();
    for (const entry of entries) this.entries.set(entry.scheduleId, { ...entry });
    this.maintenanceResumePrepared = true;
    return true;
  }

  resumeAfterMaintenance(generation: number): boolean {
    if (
      this.stopped ||
      this.maintenanceGeneration !== generation ||
      !this.maintenanceDrained ||
      !this.maintenanceResumePrepared
    )
      return false;
    this.maintenanceGeneration = null;
    this.maintenanceDrained = false;
    this.maintenanceResumePrepared = false;
    this.arm();
    return true;
  }

  get size(): number {
    return this.entries.size;
  }
  get isStopped(): boolean {
    return this.stopped;
  }

  private arm(): void {
    if (this.stopped || this.startupHeld || this.maintenanceGeneration !== null) return;
    this.disarm();
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) {
      const due = Date.parse(entry.expectedNextDueAt);
      if (Number.isFinite(due) && due < earliest) earliest = due;
    }
    if (!Number.isFinite(earliest)) return;
    const epoch = ++this.timerEpoch;
    this.timer = this.clock.setTimeout(
      () => this.fire(epoch),
      Math.max(0, earliest - this.clock.now().getTime()),
    );
  }

  private disarm(): void {
    this.timerEpoch += 1;
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private fire(epoch: number): void {
    if (epoch !== this.timerEpoch) return;
    this.timer = null;
    if (this.stopped || this.startupHeld || this.maintenanceGeneration !== null) return;
    const now = this.clock.now().getTime();
    const due = [...this.entries.values()]
      .filter((entry) => Date.parse(entry.expectedNextDueAt) <= now)
      .sort(
        (a, b) =>
          Date.parse(a.expectedNextDueAt) - Date.parse(b.expectedNextDueAt) ||
          a.scheduleId.localeCompare(b.scheduleId),
      );
    for (const entry of due) {
      // A preceding callback may revoke this fire or replace the queued identity.
      // Leave unconsumed entries to the current timer/maintenance owner.
      if (
        this.stopped ||
        this.startupHeld ||
        this.maintenanceGeneration !== null ||
        epoch !== this.timerEpoch
      )
        return;
      this.entries.delete(entry.scheduleId);
      const logicalDate = localDateOf(Date.parse(entry.expectedNextDueAt), entry.timeZone);
      if (logicalDate !== null) this.onDue({ ...entry, logicalDate });
    }
    if (epoch === this.timerEpoch) this.arm();
  }
}
