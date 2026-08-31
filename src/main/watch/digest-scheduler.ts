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

  constructor(
    private readonly clock: Clock,
    private readonly onDue: (entry: DigestDueEntry) => void,
  ) {}

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

  get size(): number {
    return this.entries.size;
  }
  get isStopped(): boolean {
    return this.stopped;
  }

  private arm(): void {
    if (this.stopped) return;
    this.disarm();
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) {
      const due = Date.parse(entry.expectedNextDueAt);
      if (Number.isFinite(due) && due < earliest) earliest = due;
    }
    if (!Number.isFinite(earliest)) return;
    this.timer = this.clock.setTimeout(
      () => this.fire(),
      Math.max(0, earliest - this.clock.now().getTime()),
    );
  }

  private disarm(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private fire(): void {
    this.timer = null;
    if (this.stopped) return;
    const now = this.clock.now().getTime();
    const due = [...this.entries.values()]
      .filter((entry) => Date.parse(entry.expectedNextDueAt) <= now)
      .sort(
        (a, b) =>
          Date.parse(a.expectedNextDueAt) - Date.parse(b.expectedNextDueAt) ||
          a.scheduleId.localeCompare(b.scheduleId),
      );
    for (const entry of due) {
      this.entries.delete(entry.scheduleId);
      const logicalDate = localDateOf(Date.parse(entry.expectedNextDueAt), entry.timeZone);
      if (logicalDate !== null) this.onDue({ ...entry, logicalDate });
    }
    this.arm();
  }
}
