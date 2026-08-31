import { randomBytes, randomUUID } from 'node:crypto';
import type { WatchIpcErrorCode, WatchIpcResult } from '../../shared/types/watch-ipc';
import {
  WATCH_IPC_CHANNELS,
  validateWatchIpcOutput,
  validateWatchIpcPayload,
  type WatchIpcChannel,
} from '../../shared/watch/watch-ipc-validator';
import type { WatchRepository, WatchResult } from './repository/watch-repository';
import type { WatchRunCoordinator } from './watch-run-coordinator';
import type { WatchQueryService } from './watch-query-service';
import type { WatchExportService } from './watch-export-service';
import type { WatchPreviewService } from './watch-preview-service';
import type { WatchCommandService } from './watch-command-service';
import type { DigestService } from './digest-service';

export const MUTATING_WATCH_CHANNELS = new Set<WatchIpcChannel>([
  'watch:createRule',
  'watch:updateRule',
  'watch:setPaused',
  'watch:setMuted',
  'watch:deleteRule',
  'watch:runNow',
  'watch:issueSessionGrant',
  'watch:setEventsRead',
  'watch:deleteEvent',
  'watch:saveDigestSchedule',
  'watch:deleteDigestSchedule',
  'watch:exportEventsCsv',
  'watch:exportDigestMarkdown',
]);
const EFFECTFUL_READ_WATCH_CHANNELS = new Set<WatchIpcChannel>([
  'watch:previewFeed',
  'watch:previewPageRegions',
  'watch:generateDigestPreview',
]);

const fail = <T>(errorCode: WatchIpcErrorCode): WatchIpcResult<T> => ({ ok: false, errorCode });
const mapWrite = (result: WatchResult): WatchIpcResult<{ updated: true }> =>
  result.ok
    ? { ok: true, value: { updated: true } }
    : result.code === 'rule-not-found'
      ? fail('not-found')
      : result.code === 'rule-version-conflict'
        ? fail('conflict')
        : result.code === 'rule-state-conflict'
          ? fail('invalid-state')
          : fail('unavailable');

export interface WatchIpcAdapterOptions {
  repository: () => WatchRepository | null;
  coordinator: () => WatchRunCoordinator | null;
  query: WatchQueryService;
  exporter: WatchExportService;
  preview: WatchPreviewService;
  commands: WatchCommandService;
  digest: () => DigestService | null;
  resolveDigestSources: (selector: {
    sourceIds?: readonly string[];
    groupId?: string;
  }) => Array<{ sourceId: string; displayName: string }> | null;
  audit: (message: string) => void;
}

export class WatchIpcAdapter {
  private readonly digestPreviews = new Map<string, { sourceIds: string[]; expiresAt: number }>();
  private static readonly MAX_DIGEST_PREVIEWS = 128;
  private static readonly DIGEST_PREVIEW_TTL_MS = 300_000;
  constructor(private readonly options: WatchIpcAdapterOptions) {}

  dispose(): void {
    this.digestPreviews.clear();
  }

  async invoke(channel: string, payload: unknown): Promise<WatchIpcResult<unknown>> {
    const started = Date.now();
    const validated = validateWatchIpcPayload(channel, payload);
    let result: WatchIpcResult<unknown>;
    try {
      result = validated.ok
        ? await this.dispatch(channel as WatchIpcChannel, payload as Record<string, unknown>)
        : fail('invalid-payload');
    } catch {
      result = fail('unavailable');
    }
    if (!validateWatchIpcOutput(result, channel as WatchIpcChannel)) result = fail('unavailable');
    if (
      MUTATING_WATCH_CHANNELS.has(channel as WatchIpcChannel) ||
      EFFECTFUL_READ_WATCH_CHANNELS.has(channel as WatchIpcChannel)
    ) {
      this.options.audit(
        `watch-ipc kind=${EFFECTFUL_READ_WATCH_CHANNELS.has(channel as WatchIpcChannel) ? 'effectful-read' : 'action'} channel=${channel} result=${result.ok ? 'ok' : result.errorCode} durationMs=${Math.max(0, Date.now() - started)}`,
      );
    }
    return result;
  }

  private async dispatch(
    channel: WatchIpcChannel,
    p: Record<string, unknown>,
  ): Promise<WatchIpcResult<unknown>> {
    const repo = this.options.repository();
    switch (channel) {
      case 'watch:getStatus':
        return { ok: true, value: this.options.query.status() };
      case 'watch:listRules': {
        const v = this.options.query.listRules(p as never);
        return v === null ? fail('unavailable') : { ok: true, value: v };
      }
      case 'watch:getRule': {
        const v = this.options.query.getRule(String(p['ruleId']));
        return v === null ? fail('not-found') : { ok: true, value: v };
      }
      case 'watch:listEvents': {
        const v = this.options.query.listEvents(p as never);
        return v === null ? fail('unavailable') : { ok: true, value: v };
      }
      case 'watch:listDigestSchedules': {
        const v = this.options.query.listDigestSchedules(Number(p['page']), Number(p['pageSize']));
        return v === null ? fail('unavailable') : { ok: true, value: v };
      }
      case 'watch:listDigests': {
        const v = this.options.query.listDigests(
          Number(p['page']),
          Number(p['pageSize']),
          p['scheduleId'] as string | null,
        );
        return v === null ? fail('unavailable') : { ok: true, value: v };
      }
      case 'watch:getDigest': {
        const v = this.options.query.getDigest(String(p['digestId']));
        return v === null ? fail('not-found') : { ok: true, value: v };
      }
      case 'watch:generateDigestPreview': {
        const digest = this.options.digest();
        const selector = p['selector'] as {
          kind: 'sources' | 'group';
          sourceIds?: string[];
          groupId?: string;
        };
        const members = this.options.resolveDigestSources(
          selector.kind === 'sources'
            ? { sourceIds: selector.sourceIds }
            : { groupId: selector.groupId },
        );
        if (digest === null || members === null) return fail('unavailable');
        const frozenMembers = [...members]
          .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
          .slice(0, 100)
          .map((member) => ({ sourceId: member.sourceId, displayName: member.displayName }));
        const sourceIds = frozenMembers.map((member) => member.sourceId);
        const preview = digest.preview({
          previewId: randomUUID(),
          sourceIds,
          afterSequence: Number(p['afterSequence']),
          fromExclusive: String(p['fromExclusive']),
          toInclusive: String(p['toInclusive']),
        });
        if (preview === null) return fail('unavailable');
        this.pruneDigestPreviews();
        if (this.digestPreviews.size >= WatchIpcAdapter.MAX_DIGEST_PREVIEWS)
          return fail('budget-exceeded');
        const previewHandle = randomBytes(32).toString('base64url');
        this.digestPreviews.set(previewHandle, {
          sourceIds,
          expiresAt: Date.now() + WatchIpcAdapter.DIGEST_PREVIEW_TTL_MS,
        });
        return { ok: true, value: { previewHandle, frozenMembers, ...preview } };
      }
      case 'watch:previewFeed':
        return this.options.preview.previewFeed(p as never);
      case 'watch:previewPageRegions':
        return this.options.preview.previewPage(p as never);
      case 'watch:issueSessionGrant':
        return this.options.preview.issueSessionGrant(String(p['previewHandle']));
      case 'watch:createRule':
        return this.options.commands.create(p as never);
      case 'watch:setPaused':
        return repo === null
          ? fail('unavailable')
          : mapWrite(
              repo.setRulePaused(
                String(p['ruleId']),
                Number(p['expectedVersion']),
                Boolean(p['paused']),
                new Date().toISOString(),
              ),
            );
      case 'watch:setMuted':
        return repo === null
          ? fail('unavailable')
          : mapWrite(
              repo.setRuleMuted(
                String(p['ruleId']),
                Number(p['expectedVersion']),
                Boolean(p['muted']),
                new Date().toISOString(),
              ),
            );
      case 'watch:deleteRule':
        return repo === null
          ? fail('unavailable')
          : mapWrite(
              repo.deleteRuleExpectedVersion(String(p['ruleId']), Number(p['expectedVersion'])),
            );
      case 'watch:setEventsRead':
        return repo === null
          ? fail('unavailable')
          : {
              ok: true,
              value: {
                updated: repo.markEventsRead(
                  p['eventIds'] as string[],
                  p['read'] === true ? new Date().toISOString() : null,
                ),
              },
            };
      case 'watch:deleteEvent':
        return repo === null
          ? fail('unavailable')
          : mapWrite(repo.deleteEventWithScrub(String(p['eventId']), new Date().toISOString()));
      case 'watch:runNow': {
        const c = this.options.coordinator();
        if (c === null) return fail('unavailable');
        const r = c.manualRun(String(p['ruleId']), randomUUID());
        return r.ok
          ? { ok: true, value: { runId: r.runId } }
          : r.reason === 'rule-not-found'
            ? fail('not-found')
            : r.reason === 'rule-disabled'
              ? fail('invalid-state')
              : fail('unavailable');
      }
      case 'watch:updateRule': {
        if (p['mode'] === 'rebaseline') return this.options.commands.rebaseline(p as never);
        if (repo === null) return fail('unavailable');
        const current = repo.getRule(String(p['ruleId']));
        if (current === null) return fail('not-found');
        if (JSON.stringify(current.condition) !== JSON.stringify(p['condition']))
          return fail('security-rejected');
        return mapWrite(
          repo.updateRuleSettings({
            ruleId: String(p['ruleId']),
            expectedVersion: Number(p['expectedVersion']),
            schedule: p['schedule'] as never,
            condition: p['condition'] as never,
            notificationLevel: p['notificationLevel'] as never,
            showDetails: Boolean(p['showDetails']),
            nowIso: new Date().toISOString(),
          }),
        );
      }
      case 'watch:deleteDigestSchedule':
        return this.options.digest() === null
          ? fail('unavailable')
          : mapWrite(
              this.options.digest()!.delete(String(p['scheduleId']), Number(p['expectedVersion'])),
            );
      case 'watch:saveDigestSchedule': {
        const digest = this.options.digest();
        if (digest === null) return fail('unavailable');
        if (p['action'] === 'create') {
          const previewHandle = String(p['previewHandle']);
          const preview = this.digestPreviews.get(previewHandle);
          this.digestPreviews.delete(previewHandle);
          if (preview === undefined || Date.now() >= preview.expiresAt)
            return fail('preview-expired');
          const result = await digest.createSchedule({
            id: randomUUID(),
            selector: { sourceIds: preview.sourceIds },
            localTime: String(p['localTime']),
            timeZone: String(p['timeZone']),
            aiEnabled: p['aiEnabled'] === true,
          });
          return result.ok ? { ok: true, value: { created: true } } : fail('unavailable');
        }
        if (p['action'] === 'set-state')
          return mapWrite(
            p['state'] === 'paused'
              ? digest.pause(String(p['scheduleId']), Number(p['expectedVersion']))
              : await digest.resume(String(p['scheduleId']), Number(p['expectedVersion'])),
          );
        if (p['action'] === 'set-ai')
          return mapWrite(
            digest.setAiEnabled(
              String(p['scheduleId']),
              Number(p['expectedVersion']),
              p['aiEnabled'] === true,
            ),
          );
        return mapWrite(await digest.retryBudget(String(p['runId'])));
      }
      case 'watch:exportEventsCsv':
        return this.options.exporter.exportEventsCsv(p['filter'] as Record<string, unknown>);
      case 'watch:exportDigestMarkdown':
        return this.options.exporter.exportDigestMarkdown(String(p['digestId']));
      default:
        return fail('feature-unavailable');
    }
  }

  private pruneDigestPreviews(): void {
    const now = Date.now();
    for (const [handle, preview] of this.digestPreviews)
      if (now >= preview.expiresAt) this.digestPreviews.delete(handle);
  }
}

export { WATCH_IPC_CHANNELS };
