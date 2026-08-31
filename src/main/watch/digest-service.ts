import { randomUUID } from 'node:crypto';
import type { LLMProvider } from '../ai/provider/llm-provider';
import type { Clock } from '../../shared/types/watch';
import { MAX_DIGEST_PROVIDER_OUTPUT_BYTES } from '../../shared/types/watch';
import { createTimeZoneResolver } from '../../shared/watch/clock';
import { buildDigestFacts, type DigestObservationSlice } from '../../shared/watch/digest-facts';
import {
  projectDigestForProvider,
  type DigestSourceSharingProjection,
} from '../../shared/watch/digest-sharing-projector';
import { parseDigestExplanation } from '../../shared/watch/digest-validator';
import { utf8ByteLength } from '../../shared/watch/watch-budget';
import { buildDigestProviderRequest } from './digest-prompt';
import type {
  StoredDigestArtifact,
  StoredDigestRun,
  StoredDigestSchedule,
  WatchResult,
  WatchRepository,
} from './repository/watch-repository';

export interface DigestMembershipPort {
  resolve(selector: { sourceIds?: readonly string[]; groupId?: string }): Promise<{
    status: 'ok' | 'unavailable';
    members: readonly { sourceId: string; displayName: string; canonicalUrl: string }[];
  }>;
}

export interface DigestSharingPort {
  get(sourceIds: readonly string[]): Promise<readonly DigestSourceSharingProjection[]>;
}

export interface DigestProviderPort {
  resolve(): Promise<{ provider: LLMProvider; model: string } | null>;
}

export interface DigestScheduleControlPort {
  upsert(entry: { scheduleId: string; expectedNextDueAt: string; timeZone: string }): void;
  remove(scheduleId: string): void;
}

export interface DigestServiceOptions {
  repository: WatchRepository;
  clock: Clock;
  sharing: DigestSharingPort;
  provider: DigestProviderPort;
  membership?: DigestMembershipPort;
  scheduleControl: DigestScheduleControlPort;
  onArtifactReady?: () => void;
  windowsNotificationsEnabled?: boolean;
}

export interface DigestScheduleQueryDto {
  schedule: StoredDigestSchedule;
  runs: StoredDigestRun[];
  artifacts: StoredDigestArtifact[];
}

const resolver = createTimeZoneResolver();

export class DigestService {
  private readonly controllers = new Set<AbortController>();
  private readonly attempts = new Set<Promise<unknown>>();
  private accepting = true;

  constructor(private readonly options: DigestServiceOptions) {}

  createSchedule(input: {
    id: string;
    selector: { sourceIds?: readonly string[]; groupId?: string };
    localTime: string;
    timeZone: string;
    aiEnabled?: boolean;
  }): Promise<{ ok: boolean }> {
    return this.track(async () => {
      if (!this.accepting || this.options.membership === undefined) return { ok: false };
      const resolution = await this.options.membership.resolve(input.selector);
      if (!this.accepting || resolution.status !== 'ok') return { ok: false };
      const sourceIds = [...new Set(resolution.members.map((member) => member.sourceId))].sort(
        (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)),
      );
      if (sourceIds.length < 1 || sourceIds.length > 100) return { ok: false };
      const now = this.options.clock.now();
      const next = resolver.nextDailyInstant({
        after: now,
        localTime: input.localTime,
        timeZone: input.timeZone,
        lastLocalDate: null,
      });
      if (next === null) return { ok: false };
      const created = this.options.repository.createDigestSchedule({
        id: input.id,
        sourceIds,
        localTime: input.localTime,
        timeZone: input.timeZone,
        aiEnabled: input.aiEnabled === true,
        nextDueAt: next.instant.toISOString(),
        nowIso: now.toISOString(),
      });
      if (!created.ok) return { ok: false };
      const schedule = this.options.repository.getDigestSchedule(input.id);
      if (schedule === null) return { ok: false };
      this.upsertSchedule(schedule);
      return { ok: true };
    });
  }

  handleDue(input: {
    scheduleId: string;
    expectedNextDueAt: string;
    logicalDate: string;
  }): Promise<{ ok: boolean; nextDueAt: string | null }> {
    return this.track(() => this.handleDueInternal(input));
  }

  private async handleDueInternal(input: {
    scheduleId: string;
    expectedNextDueAt: string;
    logicalDate: string;
  }): Promise<{ ok: boolean; nextDueAt: string | null }> {
    if (!this.accepting) return { ok: false, nextDueAt: null };
    let schedule = this.options.repository.getDigestSchedule(input.scheduleId);
    if (
      schedule === null ||
      schedule.state !== 'active' ||
      schedule.nextDueAt !== input.expectedNextDueAt
    )
      return { ok: false, nextDueAt: null };
    let run = this.options.repository.getNonterminalDigestRun(schedule.id);
    if (run === null) {
      const now = this.options.clock.now();
      const next = resolver.nextDailyInstant({
        after: now,
        localTime: schedule.localTime,
        timeZone: schedule.timeZone,
        lastLocalDate: input.logicalDate,
      });
      if (next === null) return { ok: false, nextDueAt: null };
      const reserved = this.options.repository.reserveDigestRun({
        scheduleId: schedule.id,
        expectedVersion: schedule.version,
        expectedNextDueAt: input.expectedNextDueAt,
        expectedLastConsumedScheduledFor: schedule.lastConsumedScheduledFor,
        expectedLastDailyLocalDate: schedule.lastDailyLocalDate,
        runId: randomUUID(),
        requestKey: `${schedule.id}:${input.logicalDate}`,
        logicalDate: input.logicalDate,
        nextDueAt: next.instant.toISOString(),
        nowIso: now.toISOString(),
      });
      if (!reserved.ok) return { ok: false, nextDueAt: null };
      run = reserved.run;
      schedule = this.options.repository.getDigestSchedule(schedule.id);
      if (schedule === null) return { ok: false, nextDueAt: null };
    }
    if (run.state === 'budget_exceeded') return { ok: false, nextDueAt: schedule.nextDueAt };
    const ok = await this.processRun(schedule, run);
    const current = this.options.repository.getDigestSchedule(schedule.id);
    if (ok && current !== null && current.state === 'active') this.upsertSchedule(current);
    return { ok, nextDueAt: current?.nextDueAt ?? schedule.nextDueAt };
  }

  resumeActiveCycles(): Promise<void> {
    return this.track(async () => {
      for (const schedule of this.options.repository.listActiveDigestSchedules()) {
        let run = this.options.repository.getNonterminalDigestRun(schedule.id);
        if (run?.state === 'budget_exceeded') {
          const recovered = this.options.repository.revalidateDigestRunBudget(
            run.id,
            this.options.clock.now().toISOString(),
            this.options.windowsNotificationsEnabled,
          );
          if (!recovered.ok) throw new Error('Digest cycle 容量恢复失败');
          run = this.options.repository.getDigestRun(run.id);
        }
        if (run?.state === 'running') {
          const ok = await this.processRun(schedule, run);
          if (!ok) {
            const refreshed = this.options.repository.getDigestRun(run.id);
            if (refreshed?.state !== 'budget_exceeded') {
              throw new Error('Digest cycle 恢复失败');
            }
            this.options.scheduleControl.remove(schedule.id);
          }
        }
      }
    });
  }

  pause(id: string, expectedVersion: number): WatchResult {
    if (!this.accepting) return { ok: false, code: 'store-unavailable' };
    const result = this.options.repository.pauseDigestSchedule(
      id,
      expectedVersion,
      this.options.clock.now().toISOString(),
    );
    if (result.ok) this.options.scheduleControl.remove(id);
    return result;
  }

  resume(id: string, expectedVersion: number): Promise<WatchResult> {
    return this.track(async () => {
      if (!this.accepting) return { ok: false, code: 'store-unavailable' };
      const resumed = this.options.repository.resumeDigestSchedule(
        id,
        expectedVersion,
        this.options.clock.now().toISOString(),
      );
      if (!resumed.ok) return resumed;
      const schedule = this.options.repository.getDigestSchedule(id);
      let run = this.options.repository.getNonterminalDigestRun(id);
      if (schedule === null) return { ok: false, code: 'store-unavailable' };
      if (run?.state === 'budget_exceeded') {
        const retried = this.options.repository.revalidateDigestRunBudget(
          run.id,
          this.options.clock.now().toISOString(),
          this.options.windowsNotificationsEnabled,
        );
        if (!retried.ok) return retried;
        if (retried.state === 'budget_exceeded') {
          this.options.scheduleControl.remove(id);
          return { ok: false, code: 'db-budget-exceeded' };
        }
        run = this.options.repository.getDigestRun(run.id);
      }
      if (run?.state === 'running' && !(await this.processRun(schedule, run))) {
        return { ok: false, code: 'store-unavailable' };
      }
      const current = this.options.repository.getDigestSchedule(id);
      if (current !== null && current.state === 'active') this.upsertSchedule(current);
      return { ok: true };
    });
  }

  delete(id: string, expectedVersion: number): WatchResult {
    if (!this.accepting) return { ok: false, code: 'store-unavailable' };
    this.options.scheduleControl.remove(id);
    const result = this.options.repository.deleteDigestSchedule(id, expectedVersion);
    if (!result.ok) {
      const current = this.options.repository.getDigestSchedule(id);
      if (current !== null && current.state === 'active') this.upsertSchedule(current);
    }
    return result;
  }

  retryBudget(runId: string): Promise<WatchResult> {
    return this.track(async () => {
      if (!this.accepting) return { ok: false, code: 'store-unavailable' };
      const retried = this.options.repository.revalidateDigestRunBudget(
        runId,
        this.options.clock.now().toISOString(),
        this.options.windowsNotificationsEnabled,
      );
      if (!retried.ok) return retried;
      if (retried.state === 'budget_exceeded') {
        const blocked = this.options.repository.getDigestRun(runId);
        if (blocked !== null) this.options.scheduleControl.remove(blocked.scheduleId);
        return { ok: false, code: 'db-budget-exceeded' };
      }
      const run = this.options.repository.getDigestRun(runId);
      const schedule = run && this.options.repository.getDigestSchedule(run.scheduleId);
      if (run === null || schedule === null) return { ok: false, code: 'store-unavailable' };
      if (!(await this.processRun(schedule, run))) return { ok: false, code: 'store-unavailable' };
      const current = this.options.repository.getDigestSchedule(schedule.id);
      if (current !== null && current.state === 'active') this.upsertSchedule(current);
      return { ok: true };
    });
  }

  setAiEnabled(id: string, expectedVersion: number, enabled: boolean): WatchResult {
    if (!this.accepting) return { ok: false, code: 'store-unavailable' };
    return this.options.repository.setDigestScheduleAiEnabled(
      id,
      expectedVersion,
      enabled,
      this.options.clock.now().toISOString(),
    );
  }

  getSchedule(id: string): DigestScheduleQueryDto | null {
    const schedule = this.options.repository.getDigestSchedule(id);
    return schedule === null
      ? null
      : {
          schedule,
          runs: this.options.repository.listDigestRunsBySchedule(id),
          artifacts: this.options.repository.listDigestArtifactsBySchedule(id),
        };
  }

  listSchedules(): DigestScheduleQueryDto[] {
    return this.options.repository
      .listDigestSchedules()
      .map((schedule) => this.getSchedule(schedule.id))
      .filter((item): item is DigestScheduleQueryDto => item !== null);
  }

  preview(input: {
    previewId: string;
    sourceIds: readonly string[];
    afterSequence?: number;
    fromExclusive: string;
    toInclusive: string;
  }): {
    facts: ReturnType<typeof buildDigestFacts>;
    hasMore: boolean;
    nextPreviewSequence: number;
  } | null {
    const slice = this.options.repository.readDigestPreviewSlice({
      sourceIds: [...new Set(input.sourceIds)].sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      ),
      afterSequence: input.afterSequence ?? 0,
      fromExclusive: input.fromExclusive,
      toInclusive: input.toInclusive,
    });
    if (slice === null) return null;
    const observations: DigestObservationSlice[] = [];
    let lastSequence = input.afterSequence ?? 0;
    let facts: ReturnType<typeof buildDigestFacts> = null;
    for (const item of slice.rows) {
      if (item.observation === null) {
        lastSequence = item.sequence;
        continue;
      }
      const candidate = buildDigestFacts({
        scheduleId: `preview:${input.previewId}`,
        digestRunId: `preview:${input.previewId}`,
        batchIndex: 0,
        period: { fromExclusive: input.fromExclusive, toInclusive: input.toInclusive },
        runStats: { changed: 0, failed: 0, unchanged: 0 },
        observations: [...observations, item.observation],
        fetchedAt: input.toInclusive,
      });
      if (candidate === null) break;
      observations.push(item.observation);
      facts = candidate;
      lastSequence = item.sequence;
    }
    if (facts === null) lastSequence = slice.upperSequence;
    return {
      facts,
      hasMore: lastSequence < slice.upperSequence,
      nextPreviewSequence: lastSequence,
    };
  }

  stopAdmission(): void {
    this.accepting = false;
  }

  abort(): void {
    for (const controller of this.controllers) controller.abort();
  }

  async drain(): Promise<void> {
    while (this.attempts.size > 0) {
      await Promise.allSettled([...this.attempts]);
    }
    while (this.controllers.size > 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  dispose(): void {
    this.stopAdmission();
    this.abort();
  }

  private async processRun(
    schedule: StoredDigestSchedule,
    initialRun: StoredDigestRun,
  ): Promise<boolean> {
    let run = initialRun;
    for (const pending of this.options.repository.listPendingDigestArtifacts(run.id)) {
      if (!this.accepting) return false;
      await this.attemptProvider(pending.id, schedule);
    }
    while (this.accepting && run.nextSequence < run.upperSequence) {
      const journal = this.options.repository.readDigestJournalSlice(run.id);
      if (journal === null) return false;
      const observations: DigestObservationSlice[] = [];
      let lastSequence = run.nextSequence;
      let built = null as ReturnType<typeof buildDigestFacts>;
      const batchIndex = this.options.repository.nextDigestBatchIndex(run.id);
      for (const item of journal) {
        if (item.observation === null) {
          lastSequence = item.sequence;
          continue;
        }
        const candidate = buildDigestFacts({
          scheduleId: schedule.id,
          digestRunId: run.id,
          batchIndex,
          period: run.period,
          runStats: run.runStats,
          observations: [...observations, item.observation],
          fetchedAt: run.period.toInclusive,
        });
        if (candidate === null) {
          if (observations.length === 0) return false;
          break;
        }
        observations.push(item.observation);
        built = candidate;
        lastSequence = item.sequence;
      }
      if (built === null) break;
      const artifactId = randomUUID();
      const committed = this.options.repository.commitDigestBatch({
        artifactId,
        run,
        expectedNextSequence: run.nextSequence,
        firstSequence: run.nextSequence + 1,
        lastSequence,
        facts: built,
        createdAt: this.options.clock.now().toISOString(),
        aiEnabled: schedule.aiEnabled,
        windowsNotificationsEnabled: this.options.windowsNotificationsEnabled === true,
      });
      if (!committed.ok) {
        return false;
      }
      if (schedule.aiEnabled) await this.attemptProvider(artifactId, schedule);
      this.options.onArtifactReady?.();
      const refreshed = this.options.repository.getDigestRun(run.id);
      if (refreshed === null) return false;
      run = refreshed;
      await Promise.resolve();
    }
    const refreshed = this.options.repository.getDigestRun(run.id);
    if (refreshed === null) return false;
    return this.options.repository.completeDigestRun(
      refreshed,
      this.options.clock.now().toISOString(),
    ).ok;
  }

  private async attemptProvider(id: string, schedule: StoredDigestSchedule): Promise<void> {
    if (!this.accepting) return;
    const resolved = await this.options.provider.resolve();
    if (!this.accepting) return;
    let currentSchedule = this.options.repository.getDigestSchedule(schedule.id);
    let artifact = this.options.repository.getDigestArtifact(id);
    if (artifact === null || artifact.providerState !== 'pending' || currentSchedule === null)
      return;
    if (currentSchedule.state !== 'active') return;
    if (!currentSchedule.aiEnabled) {
      this.options.repository.finishPendingDigest(
        id,
        'disabled',
        'disabled',
        this.options.clock.now().toISOString(),
      );
      return;
    }
    if (resolved === null) {
      this.options.repository.finishPendingDigest(
        id,
        'skipped',
        'key-unavailable',
        this.options.clock.now().toISOString(),
      );
      return;
    }
    const sharing = await this.options.sharing.get(currentSchedule.sourceIds);
    if (!this.accepting) return;
    currentSchedule = this.options.repository.getDigestSchedule(schedule.id);
    artifact = this.options.repository.getDigestArtifact(id);
    if (artifact === null || artifact.providerState !== 'pending' || currentSchedule === null)
      return;
    if (currentSchedule.state !== 'active') return;
    if (!currentSchedule.aiEnabled) {
      this.options.repository.finishPendingDigest(
        id,
        'disabled',
        'disabled',
        this.options.clock.now().toISOString(),
      );
      return;
    }
    const projection = projectDigestForProvider(artifact.facts, sharing);
    if (projection.events.length === 0) {
      this.options.repository.finishPendingDigest(
        id,
        'skipped',
        'no-visible-events',
        this.options.clock.now().toISOString(),
      );
      return;
    }
    const request = buildDigestProviderRequest({
      requestId: id,
      model: resolved.model,
      projection,
    });
    if (request === null) {
      this.options.repository.finishPendingDigest(
        id,
        'skipped',
        'request-budget',
        this.options.clock.now().toISOString(),
      );
      return;
    }
    if (!this.accepting) return;
    const claimed = this.options.repository.claimDigestProvider({
      id,
      scheduleId: currentSchedule.id,
      factsRevision: artifact.factsRevision,
      factsHash: artifact.factsHash,
      nowIso: this.options.clock.now().toISOString(),
    });
    if (claimed === null) return;
    await this.consumeProvider(
      resolved.provider,
      request,
      claimed,
      projection.events.map((item) => item.event.eventId),
    );
  }

  private async consumeProvider(
    provider: LLMProvider,
    request: Parameters<LLMProvider['stream']>[0],
    claimed: StoredDigestArtifact,
    visibleEventIds: readonly string[],
  ): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    let raw = '';
    let failure: 'provider-error' | 'timeout' | 'aborted' | 'invalid-output' | null = null;
    let done = false;
    try {
      for await (const event of provider.stream(request, controller.signal)) {
        if (done) {
          failure = 'invalid-output';
          controller.abort();
          break;
        }
        if (event.type === 'delta') {
          raw += event.text;
          if (utf8ByteLength(raw) > MAX_DIGEST_PROVIDER_OUTPUT_BYTES) {
            failure = 'invalid-output';
            controller.abort();
            break;
          }
        } else if (event.type === 'error') {
          failure =
            event.error.code === 'timeout'
              ? 'timeout'
              : event.error.code === 'aborted'
                ? 'aborted'
                : 'provider-error';
          break;
        } else if (event.type === 'toolCalls' || event.type === 'reasoning') {
          failure = 'invalid-output';
          controller.abort();
          break;
        } else if (event.type === 'done') {
          done = true;
        }
      }
    } catch {
      failure = controller.signal.aborted ? 'aborted' : 'provider-error';
    } finally {
      this.controllers.delete(controller);
    }
    const nowIso = this.options.clock.now().toISOString();
    if (failure === null && !done) failure = 'provider-error';
    if (failure !== null) {
      this.options.repository.finishClaimedDigest({
        id: claimed.id,
        factsRevision: claimed.factsRevision,
        factsHash: claimed.factsHash,
        state: 'failed',
        code: failure,
        explanationJson: null,
        nowIso,
      });
      return;
    }
    const explanation = parseDigestExplanation(raw, visibleEventIds);
    this.options.repository.finishClaimedDigest({
      id: claimed.id,
      factsRevision: claimed.factsRevision,
      factsHash: claimed.factsHash,
      state: explanation === null ? 'failed' : 'succeeded',
      code: explanation === null ? 'invalid-output' : 'success',
      explanationJson: explanation === null ? null : raw,
      nowIso,
    });
  }

  private track<T>(work: () => Promise<T>): Promise<T> {
    const operation = work();
    this.attempts.add(operation);
    void operation.then(
      () => this.attempts.delete(operation),
      () => this.attempts.delete(operation),
    );
    return operation;
  }

  private upsertSchedule(schedule: StoredDigestSchedule): void {
    if (!this.accepting) return;
    this.options.scheduleControl.upsert({
      scheduleId: schedule.id,
      expectedNextDueAt: schedule.nextDueAt,
      timeZone: schedule.timeZone,
    });
  }
}
