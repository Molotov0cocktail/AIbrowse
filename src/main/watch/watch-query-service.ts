import {
  PUBLIC_EVENT_RETENTION_DAYS,
  PUBLIC_EVENTS_PER_RULE,
  SESSION_EVENT_RETENTION_DAYS,
  SESSION_EVENTS_PER_RULE,
} from '../../shared/types/watch';
import type { RuleSummaryDto, WatchStatusDto } from '../../shared/types/watch-ipc';
import type { WatchRepository } from './repository/watch-repository';
import type { WatchRule } from '../../shared/types/watch';

function displayTarget(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return '无效目标';
  }
}

export interface WatchRuntimeState {
  mode: 'running' | 'stopped' | 'unavailable';
  activeCount: number;
}

export class WatchQueryService {
  constructor(
    private readonly repo: () => WatchRepository | null,
    private readonly runtime: () => WatchRuntimeState,
    private readonly windows: () => Pick<WatchStatusDto, 'windowsNotification' | 'windowsReason'>,
    private readonly sourceName: (sourceId: string) => string | null = () => null,
  ) {}

  listRules(input: {
    page: number;
    pageSize: number;
    filter: { state: null | 'enabled' | 'paused'; sourceId: string | null };
  }) {
    const repo = this.repo();
    if (repo === null) return null;
    const filtered = repo
      .listRules()
      .filter(
        (rule) =>
          (input.filter.state === null || rule.state === input.filter.state) &&
          (input.filter.sourceId === null || rule.sourceId === input.filter.sourceId),
      );
    const start = (input.page - 1) * input.pageSize;
    const items: RuleSummaryDto[] = filtered
      .slice(start, start + input.pageSize)
      .map((rule) => this.projectRule(rule));
    return { page: input.page, pageSize: input.pageSize, total: filtered.length, items };
  }

  private projectRule(rule: WatchRule): RuleSummaryDto {
    const activity = this.repo()?.getRuleActivity(rule.id) ?? {
      lastCheckedAt: null,
      lastChangedAt: null,
    };
    return {
      id: rule.id,
      version: rule.version,
      sourceId: rule.sourceId,
      sourceName: this.sourceName(rule.sourceId) ?? `信源 ${rule.sourceId.slice(0, 8)}`,
      kind: rule.kind,
      state: rule.state === 'deleted' ? 'paused' : rule.state,
      pauseReason: rule.pauseReason,
      desiredEnabled: rule.desiredEnabled,
      muted: rule.muted,
      accessMode: rule.accessMode,
      schedule: rule.schedule,
      condition: rule.condition,
      notificationLevel: rule.notificationLevel,
      showDetails: rule.showDetails,
      targetDisplay: displayTarget(
        rule.target.type === 'feed' ? rule.target.feedUrl : rule.target.pageUrl,
      ),
      lastCheckedAt: activity.lastCheckedAt,
      lastChangedAt: activity.lastChangedAt,
      nextDueAt: rule.nextDueAt,
      health:
        rule.state === 'enabled'
          ? rule.consecutiveFailures > 0
            ? 'degraded'
            : 'healthy'
          : 'paused',
      backoffUntil: rule.backoffUntil,
    };
  }

  getRule(ruleId: string) {
    const rule = this.repo()?.getRule(ruleId) ?? null;
    if (rule === null) return null;
    return this.projectRule(rule);
  }

  listEvents(input: {
    page: number;
    pageSize: number;
    filter: Record<string, unknown>;
    selectedEventId: string | null;
  }) {
    const repo = this.repo();
    if (repo === null) return null;
    const rules = repo.listRules();
    let events = rules.flatMap((rule) => repo.listEventsByRule(rule.id));
    const f = input.filter;
    events = events.filter(
      (event) =>
        (f['ruleId'] === null || event.ruleId === f['ruleId']) &&
        (f['sourceId'] === null || event.sourceId === f['sourceId']) &&
        (f['eventKind'] === null || event.eventKind === f['eventKind']) &&
        (f['importance'] === null || event.importance === f['importance']) &&
        (f['readState'] === 'all' || (f['readState'] === 'read') === (event.readAt !== null)) &&
        (f['fromInclusive'] === null || event.lastObservedAt >= String(f['fromInclusive'])) &&
        (f['toExclusive'] === null || event.lastObservedAt < String(f['toExclusive'])),
    );
    events.sort(
      (a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt) || a.id.localeCompare(b.id),
    );
    const start = (input.page - 1) * input.pageSize;
    const items = events.slice(start, start + input.pageSize).map((event) => ({
      id: event.id,
      ruleId: event.ruleId,
      sourceId: event.sourceId,
      sourceName: this.sourceName(event.sourceId) ?? `信源 ${event.sourceId.slice(0, 8)}`,
      eventKind: event.eventKind,
      importance: event.importance,
      firstObservedAt: event.firstObservedAt,
      lastObservedAt: event.lastObservedAt,
      itemCount: event.itemCount,
      read: event.readAt !== null,
    }));
    const selectedEvent =
      input.selectedEventId === null
        ? null
        : events.find((item) => item.id === input.selectedEventId);
    const selected =
      selectedEvent === undefined || selectedEvent === null
        ? null
        : {
            id: selectedEvent.id,
            ruleId: selectedEvent.ruleId,
            sourceId: selectedEvent.sourceId,
            sourceName:
              this.sourceName(selectedEvent.sourceId) ??
              `信源 ${selectedEvent.sourceId.slice(0, 8)}`,
            eventKind: selectedEvent.eventKind,
            importance: selectedEvent.importance,
            firstObservedAt: selectedEvent.firstObservedAt,
            lastObservedAt: selectedEvent.lastObservedAt,
            itemCount: selectedEvent.itemCount,
            read: selectedEvent.readAt !== null,
          };
    const detail =
      selected === undefined || selected === null
        ? null
        : { ...selected, evidence: repo.listEventItems(selected.id) };
    return {
      page: input.page,
      pageSize: input.pageSize,
      total: events.length,
      items,
      selected: detail,
    };
  }

  listDigestSchedules(page: number, pageSize: number) {
    const repo = this.repo();
    if (repo === null) return null;
    const all = repo.listDigestSchedules();
    const start = (page - 1) * pageSize;
    return {
      page,
      pageSize,
      total: all.length,
      items: all.slice(start, start + pageSize).map((schedule) => {
        const run = repo.getNonterminalDigestRun(schedule.id);
        return {
          id: schedule.id,
          version: schedule.version,
          sourceCount: schedule.sourceIds.length,
          localTime: schedule.localTime,
          timeZone: schedule.timeZone,
          aiEnabled: schedule.aiEnabled,
          state: schedule.state,
          nextDueAt: schedule.nextDueAt,
          lastCheckedAt: schedule.lastCheckedAt,
          lastPeriod: schedule.lastPeriod,
          lastRunStats: schedule.lastRunStats,
          runState: run?.state ?? null,
          blockedRunId: run?.state === 'budget_exceeded' ? run.id : null,
          blockedAt: run?.blockedAt ?? null,
          blockedRequiredBytes: run?.blockedRequiredBytes ?? null,
          blockedAvailableBytes: run?.blockedAvailableBytes ?? null,
        };
      }),
    };
  }

  listDigests(page: number, pageSize: number, scheduleId: string | null) {
    const repo = this.repo();
    if (repo === null) return null;
    const schedules =
      scheduleId === null ? repo.listDigestSchedules().map((s) => s.id) : [scheduleId];
    const all = schedules
      .flatMap((id) => repo.listDigestArtifactsBySchedule(id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    const start = (page - 1) * pageSize;
    return {
      page,
      pageSize,
      total: all.length,
      items: all.slice(start, start + pageSize).map((d) => ({
        id: d.id,
        scheduleId: d.scheduleId,
        providerState: d.providerState,
        providerResultCode: d.providerResultCode,
        createdAt: d.createdAt,
        eventCount: d.facts.events.length,
      })),
    };
  }

  getDigest(id: string) {
    const digest = this.repo()?.getDigestArtifact(id) ?? null;
    if (digest === null) return null;
    const explanation = parseJson(digest.explanationJson);
    if (digest.explanationJson !== null && explanation === null) return null;
    return {
      id: digest.id,
      scheduleId: digest.scheduleId,
      facts: digest.facts,
      explanation,
      providerState: digest.providerState,
      providerResultCode: digest.providerResultCode,
      createdAt: digest.createdAt,
    };
  }

  status(): WatchStatusDto {
    const repo = this.repo();
    const runtime = this.runtime();
    const rules = repo?.listRules() ?? [];
    const events = repo === null ? [] : rules.flatMap((rule) => repo.listEventsByRule(rule.id));
    const digestCount =
      repo === null
        ? 0
        : repo
            .listDigestSchedules()
            .reduce((n, s) => n + repo.listDigestArtifactsBySchedule(s.id).length, 0);
    return {
      mode: repo === null ? 'unavailable' : 'available',
      schedulerRunning: runtime.mode === 'running',
      activeRuns: runtime.activeCount,
      ruleCount: rules.length,
      eventCount: events.length,
      unreadCount: events.filter((event) => event.readAt === null).length,
      digestCount,
      inAppNotification: 'available',
      ...this.windows(),
      appRunsOnlyWhileOpen: true,
      mainDocumentOnly: true,
      publicRetentionDays: PUBLIC_EVENT_RETENTION_DAYS,
      sessionRetentionDays: SESSION_EVENT_RETENTION_DAYS,
      publicEventsPerRule: PUBLIC_EVENTS_PER_RULE,
      sessionEventsPerRule: SESSION_EVENTS_PER_RULE,
    };
  }
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
