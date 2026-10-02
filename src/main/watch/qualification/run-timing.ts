import type { QpcTicks } from './native-contract';
import { parseQpcTicks, QualificationQpcClock } from './qpc';

interface RunTiming {
  entry: QpcTicks;
  deadline: QpcTicks;
  acquired?: QpcTicks;
  revalidated?: QpcTicks;
  observed?: QpcTicks;
  committed: boolean;
}

/** All budgets share actual QPC; timer lateness never creates another allowance. */
export class QualificationRunTiming {
  private readonly runs = new Map<string, RunTiming>();

  constructor(
    private readonly qpc: QualificationQpcClock,
    private readonly fail: (code: string) => never,
  ) {}

  begin(runId: string): QpcTicks {
    if (this.runs.has(runId)) this.fail('acquisition-timing-duplicate');
    const entry = this.qpc.readTicks();
    this.runs.set(runId, { entry, deadline: this.qpc.addMs(entry, 28_000), committed: false });
    return entry;
  }

  sessionClosed(runId: string): void {
    const run = this.get(runId);
    const now = this.qpc.readTicks();
    if (parseQpcTicks(now) <= parseQpcTicks(run.deadline)) return;
    const basis = run.deadline;
    if (!this.qpc.within(basis, now, 500)) this.fail('session-close-deadline');
  }

  acquired(runId: string): void {
    const run = this.get(runId);
    const now = this.qpc.readTicks();
    if (
      run.acquired !== undefined ||
      parseQpcTicks(now) < parseQpcTicks(run.deadline) ||
      !this.qpc.within(run.deadline, now, 500)
    )
      this.fail('acquisition-settlement-deadline');
    run.acquired = now;
  }

  revalidated(runId: string): void {
    const run = this.get(runId);
    if (run.acquired === undefined || run.revalidated !== undefined)
      this.fail('processing-revalidation-duplicate');
    run.revalidated = this.qpc.readTicks();
  }

  entered(runId: string, observedAt: string, releaseAtMs: number | null): void {
    const run = this.get(runId);
    const now = this.qpc.readTicks();
    if (
      run.revalidated === undefined ||
      run.observed !== undefined ||
      !Number.isFinite(Date.parse(observedAt)) ||
      new Date(observedAt).toISOString() !== observedAt ||
      !this.qpc.within(run.deadline, now, 500)
    )
      this.fail('processing-entry-deadline');
    if (releaseAtMs !== null && !this.qpc.within(this.qpc.ticksForUtc(releaseAtMs), now, 33_500))
      this.fail('event-observation-deadline');
    run.observed = now;
  }

  committed(runId: string): void {
    const run = this.get(runId);
    if (
      run.observed === undefined ||
      run.committed ||
      !this.qpc.within(run.observed, this.qpc.readTicks(), 500)
    )
      this.fail('processing-writer-deadline');
    run.committed = true;
  }

  released(runId: string, releaseAtMs: number | null): void {
    const run = this.get(runId);
    const now = this.qpc.readTicks();
    if (!run.committed || run.observed === undefined || !this.qpc.within(run.observed, now, 500))
      this.fail('processing-slot-release-deadline');
    if (releaseAtMs !== null && !this.qpc.within(this.qpc.ticksForUtc(releaseAtMs), now, 34_000))
      this.fail('run-slot-deadline');
    this.runs.delete(runId);
  }

  private get(runId: string): RunTiming {
    const run = this.runs.get(runId);
    if (run === undefined) return this.fail('acquisition-timing-missing');
    return run;
  }
}
