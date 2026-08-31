import { randomUUID } from 'node:crypto';
import type { LLMProvider } from '../ai/provider/llm-provider';
import type { Clock } from '../../shared/types/watch';
import { MAX_DIGEST_PROVIDER_OUTPUT_BYTES } from '../../shared/types/watch';
import { createTimeZoneResolver } from '../../shared/watch/clock';
import {
  buildDigestFacts,
  canonicalizeDigestFacts,
  type DigestObservationSlice,
} from '../../shared/watch/digest-facts';
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
  WatchRepository,
} from './repository/watch-repository';

export interface DigestMembershipPort {
  resolve(selector: {
    sourceIds?: readonly string[];
    groupId?: string;
  }): Promise<readonly string[]>;
}

export interface DigestSharingPort {
  get(sourceIds: readonly string[]): Promise<readonly DigestSourceSharingProjection[]>;
}

export interface DigestProviderPort {
  resolve(): Promise<{ provider: LLMProvider; model: string } | null>;
}

export interface DigestServiceOptions {
  repository: WatchRepository;
  clock: Clock;
  sharing: DigestSharingPort;
  provider: DigestProviderPort;
  membership?: DigestMembershipPort;
}

const resolver = createTimeZoneResolver();

export class DigestService {
  private readonly controllers = new Set<AbortController>();
  private accepting = true;

  constructor(private readonly options: DigestServiceOptions) {}

  async createSchedule(input: {
    id: string;
    selector: { sourceIds?: readonly string[]; groupId?: string };
    localTime: string;
    timeZone: string;
    aiEnabled?: boolean;
  }): Promise<{ ok: boolean }> {
    if (!this.accepting || this.options.membership === undefined) return { ok: false };
    const sourceIds = [...new Set(await this.options.membership.resolve(input.selector))].sort(
      (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)),
    );
    const now = this.options.clock.now();
    const next = resolver.nextDailyInstant({
      after: now,
      localTime: input.localTime,
      timeZone: input.timeZone,
      lastLocalDate: null,
    });
    if (next === null) return { ok: false };
    return {
      ok: this.options.repository.createDigestSchedule({
        id: input.id,
        sourceIds,
        localTime: input.localTime,
        timeZone: input.timeZone,
        aiEnabled: input.aiEnabled === true,
        nextDueAt: next.instant.toISOString(),
        nowIso: now.toISOString(),
      }).ok,
    };
  }

  async handleDue(input: {
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
    return { ok, nextDueAt: schedule.nextDueAt };
  }

  async resumeActiveCycles(): Promise<void> {
    for (const schedule of this.options.repository.listActiveDigestSchedules()) {
      const run = this.options.repository.getNonterminalDigestRun(schedule.id);
      if (run?.state === 'running') await this.processRun(schedule, run);
    }
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
      });
      if (!committed.ok) {
        if (committed.code === 'db-budget-exceeded') {
          const canonical = canonicalizeDigestFacts(built);
          if (canonical.ok) {
            const available = this.options.repository.remainingDbBudget();
            this.options.repository.markDigestRunBudgetExceeded(
              run.id,
              Math.max(canonical.byteLength, available + 1),
              available,
              this.options.clock.now().toISOString(),
            );
          }
        }
        return false;
      }
      if (schedule.aiEnabled) await this.attemptProvider(artifactId, schedule);
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
    const artifact = this.options.repository.getDigestArtifact(id);
    if (artifact === null || artifact.providerState !== 'pending') return;
    const currentSchedule = this.options.repository.getDigestSchedule(schedule.id);
    if (currentSchedule === null || currentSchedule.state !== 'active') return;
    if (!currentSchedule.aiEnabled) {
      this.options.repository.finishPendingDigest(
        id,
        'disabled',
        'disabled',
        this.options.clock.now().toISOString(),
      );
      return;
    }
    const sharing = await this.options.sharing.get(currentSchedule.sourceIds);
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
    const resolved = await this.options.provider.resolve();
    if (resolved === null) {
      this.options.repository.finishPendingDigest(
        id,
        'skipped',
        'key-unavailable',
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
    const claimed = this.options.repository.claimDigestProvider(
      id,
      this.options.clock.now().toISOString(),
    );
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
}
