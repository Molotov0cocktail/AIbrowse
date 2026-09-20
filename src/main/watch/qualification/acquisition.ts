import type { WatchAcquisitionResult, Clock, TimerHandle } from '../../../shared/types/watch';
import type { WatchAcquisitionPort } from '../watch-run-coordinator';
import type { HostRequestGate } from '../host-request-gate';
import type { WatchTaskTabWorkspace } from '../watch-task-tab-workspace';
import { createQualificationProjection, qualificationResponseMetadata } from './manifest';
import type { QualificationRoundReleaseGate } from './round-release-gate';
import type { QualificationRegistry } from './registry';
import type { QpcTicks } from './native-contract';
import { parseQpcTicks } from './qpc';

/** Fixed validated-projection seam. No raw body, HTTP, Provider or temporary file capability. */
export class QualificationAcquisitionPort implements WatchAcquisitionPort {
  constructor(
    private readonly clock: Clock,
    private readonly gate: HostRequestGate,
    private readonly workspace: WatchTaskTabWorkspace,
    private readonly rounds: QualificationRoundReleaseGate,
    private readonly registry: QualificationRegistry,
    private readonly fail: (code: string) => never,
  ) {}

  run(input: Parameters<WatchAcquisitionPort['run']>[0]): Promise<WatchAcquisitionResult> {
    const entry = this.rounds.timing.begin(input.runId);
    return this.registry.track(() => this.acquire(input, entry));
  }

  private async acquire(
    input: Parameters<WatchAcquisitionPort['run']>[0],
    entry: QpcTicks,
  ): Promise<WatchAcquisitionResult> {
    const qpc = this.rounds.qpc;
    const plan = this.rounds.validateRule(input.runId, input.rule);
    if (
      input.hostKey !== plan.entry.hostKey ||
      input.requestKey !== plan.requestKey ||
      input.scheduledFor !== plan.scheduledFor
    )
      this.fail('acquisition-identity');
    const grant = await this.registry.track(() =>
      this.gate.acquire(input.hostKey, {
        signal: input.signal,
        deadlineMs: input.deadline.getTime(),
      }),
    );
    if (!grant.ok) this.fail('acquisition-grant-failed');
    let tabId: string | null = null;
    try {
      if (plan.entry.accessMode === 'session') {
        const acquired = await this.workspace.acquire(plan.entry.targetUrl, input.signal);
        if (!acquired.ok) this.fail('acquisition-tab-failed');
        tabId = acquired.lease.tabId;
        if (!qpc.within(entry, qpc.readTicks(), 1_000))
          this.fail('acquisition-tab-publish-deadline');
        await this.delayUntil(qpc.addMs(entry, 27_000), input.signal);
        const released = await this.workspace.release(tabId);
        if (!released.ok || released.userClosed) this.fail('acquisition-tab-release');
        this.rounds.timing.sessionClosed(input.runId);
        tabId = null;
      }
      const projection = createQualificationProjection(plan, this.clock.now().toISOString());
      await this.delayUntil(qpc.addMs(entry, 28_000), input.signal);
      return {
        ok: true,
        kind: 'projection',
        projection,
        expectedSourceLocatorFingerprint: input.rule.sourceLocatorFingerprint,
        responseMetadata: qualificationResponseMetadata(plan.entry.index),
      };
    } finally {
      if (tabId !== null) await this.workspace.release(tabId);
    }
  }

  private delayUntil(deadline: QpcTicks, signal: AbortSignal): Promise<void> {
    return this.registry.track(
      () =>
        new Promise<void>((resolve, reject) => {
          let timer: TimerHandle | null = null;
          let settled = false;
          const finish = (aborted: boolean): void => {
            if (settled) return;
            settled = true;
            if (timer !== null) this.clock.clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            if (aborted) reject(new Error('资格采集被中止'));
            else resolve();
          };
          const abort = (): void => finish(true);
          if (signal.aborted) {
            finish(true);
            return;
          }
          signal.addEventListener('abort', abort, { once: true });
          const arm = (): void => {
            const now = this.rounds.qpc.readTicks();
            if (parseQpcTicks(now) >= parseQpcTicks(deadline)) {
              finish(false);
              return;
            }
            timer = this.clock.setTimeout(arm, this.rounds.qpc.elapsedMs(now, deadline));
          };
          arm();
        }),
    );
  }
}
