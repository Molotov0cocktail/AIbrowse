import type { WatchRule } from '../../../shared/types/watch';
import type { RunTask, WatchRunObserver } from '../watch-run-coordinator';
import type { WatchRepository } from '../repository/watch-repository';
import {
  createQualificationManifest,
  createQualificationRules,
  createQualificationRuns,
  type QualificationRunPlan,
} from './manifest';
import { QualificationRegistry } from './registry';
import { QualificationQpcClock } from './qpc';
import { QualificationRunTiming } from './run-timing';

export class QualificationRoundReleaseGate implements WatchRunObserver {
  private readonly plans: QualificationRunPlan[];
  private readonly tasks = new Map<string, QualificationRunPlan>();
  private readonly admitted = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly activeHosts = new Map<string, QualificationRunPlan>();
  private readonly grants = new Set<string>();
  private readonly rules: WatchRule[];
  readonly timing: QualificationRunTiming;

  constructor(
    readonly m0Ms: number,
    private readonly repo: WatchRepository,
    private readonly registry: QualificationRegistry,
    readonly qpc: QualificationQpcClock,
    private readonly admittedNow: () => boolean,
    private readonly fail: (code: string) => never,
  ) {
    this.plans = createQualificationRuns(m0Ms);
    this.rules = createQualificationRules(m0Ms);
    this.timing = new QualificationRunTiming(qpc, fail);
  }

  admissionOpen(): boolean {
    return this.admittedNow();
  }
  assertMutable(): void {
    this.registry.assertMutable();
  }
  track<T>(create: () => Promise<T>): Promise<T> {
    return this.registry.track(create);
  }

  revalidated(task: Readonly<RunTask>): void {
    this.registry.assertMutable();
    this.timing.revalidated(task.runId);
  }

  processingEntered(runId: string, observedAt: string): void {
    this.registry.assertMutable();
    this.timing.entered(runId, observedAt, this.plan(runId).releaseAtMs);
  }

  processed(task: Readonly<RunTask>): void {
    this.registry.assertMutable();
    this.timing.committed(task.runId);
  }

  acquired(task: Readonly<RunTask>): void {
    this.timing.acquired(task.runId);
  }

  duplicateTerminalAttempt(): void {
    this.registry.increment('duplicateTerminalAttemptTotal');
  }

  release(task: Readonly<RunTask>): number {
    this.registry.assertMutable();
    const plan = this.plans.find(
      (candidate) =>
        candidate.entry.ruleId === task.ruleId && candidate.requestKey === task.requestKey,
    );
    if (
      plan === undefined ||
      plan.scheduledFor !== task.scheduledFor ||
      plan.entry.hostKey !== task.hostKey ||
      this.admitted.has(plan.requestKey)
    ) {
      this.fail('run-reservation-mismatch');
    }
    const previous = this.plans.filter(
      (candidate) =>
        candidate.entry.index === plan.entry.index && candidate.runOrdinal < plan.runOrdinal,
    );
    if (previous.some((candidate) => !this.completed.has(candidate.requestKey)))
      this.fail('run-ordinal-mismatch');
    this.admitted.add(plan.requestKey);
    this.tasks.set(task.runId, plan);
    return Math.max(task.earliestStartMs, plan.releaseAtMs ?? task.earliestStartMs);
  }

  enter(task: Readonly<RunTask>): string {
    const plan = this.plan(task.runId);
    if (this.activeHosts.has(task.hostKey)) this.fail('run-host-concurrency');
    this.activeHosts.set(task.hostKey, plan);
    return this.registry.register({
      registry: 'coordinator-slot',
      detail: {
        entryIndex: plan.entry.index,
        hostSlot: plan.entry.index % 4,
        phase: plan.phase,
        round: plan.round,
      },
    });
  }

  leave(identity: string, task: Readonly<RunTask>): void {
    const plan = this.plan(task.runId);
    const run = this.repo.getRun(task.runId);
    if (
      run === null ||
      run.status !== 'finished' ||
      run.outcome?.kind !== plan.expectedOutcome ||
      !this.grants.has(plan.requestKey)
    ) {
      this.fail('run-outcome-mismatch');
    }
    this.timing.released(task.runId, plan.releaseAtMs);
    this.completed.add(plan.requestKey);
    this.activeHosts.delete(task.hostKey);
    this.registry.unregister(identity);
  }

  grant(hostKey: string, atMs: number, waitedForGap: boolean): () => void {
    const plan = this.activeHosts.get(hostKey);
    if (plan === undefined || waitedForGap || this.grants.has(plan.requestKey))
      this.fail('host-grant-mismatch');
    this.grants.add(plan.requestKey);
    const identity = this.registry.register({
      registry: 'host-grant',
      detail: {
        attemptOrdinal: 1,
        entryIndex: plan.entry.index,
        grantElapsedMs: Math.max(0, Math.trunc(atMs - this.qpc.utcAnchorMs)),
        hostSlot: plan.entry.index % 4,
        phase: plan.phase,
        round: plan.round,
        waitedForGap,
      },
    });
    return () => this.registry.unregister(identity);
  }

  plan(runId: string): QualificationRunPlan {
    const plan = this.tasks.get(runId);
    if (plan === undefined) this.fail('run-identity-missing');
    return plan;
  }

  validateRule(runId: string, rule: WatchRule): QualificationRunPlan {
    const plan = this.plan(runId);
    const expected = this.rules[plan.entry.index]!;
    for (const field of [
      'id',
      'sourceId',
      'kind',
      'accessMode',
      'version',
      'sourceRowVersion',
      'sourceLocatorFingerprint',
      'target',
      'condition',
      'schedule',
    ] as const) {
      if (JSON.stringify(rule[field]) !== JSON.stringify(expected[field]))
        this.fail('run-rule-mismatch');
    }
    return plan;
  }

  phaseComplete(phase: QualificationRunPlan['phase']): boolean {
    return this.plans
      .filter((plan) => plan.phase === phase)
      .every((plan) => this.completed.has(plan.requestKey));
  }

  verifyFinal(): void {
    if (this.completed.size !== 567 || this.grants.size !== 567 || this.activeHosts.size !== 0)
      this.fail('run-final-count');
    for (const entry of createQualificationManifest().entries) {
      const expectedEvents = entry.conditionClass === 'event' ? 2 : 0;
      if (this.repo.listEventsByRule(entry.ruleId).length !== expectedEvents)
        this.fail('event-final-count');
    }
  }

  verifyLoadDiagnostic(): void {
    if (this.completed.size !== 4 || this.grants.size !== 4 || this.activeHosts.size !== 0)
      this.fail('diagnostic-run-count');
    for (const plan of this.tasks.values())
      if (
        plan.phase !== 'initialization' ||
        plan.entry.index < 80 ||
        plan.entry.index > 83 ||
        !this.completed.has(plan.requestKey)
      )
        this.fail('diagnostic-run-selection');
  }
}
