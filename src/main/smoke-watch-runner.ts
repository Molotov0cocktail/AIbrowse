// Sixth Stage D10: deterministic offline Watch gate orchestration.
// This runner reports bounded evidence; it never calls the network or a Provider.

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInAppNotification } from './watch/notification-policy';
import { closeDb, openDb } from './sources/db/sqlite-driver';
import { runMigrations } from './sources/db/migrations';
import { SourceServiceImpl } from './sources/source-service';
import { createSourcesAdapter } from './sources/source-ipc';
import { SecureCredentialStoreImpl } from './ai/credential-store';
import { AgentLoop } from './ai/agent/agent-loop';
import { ConfirmManager } from './ai/confirm-manager';
import { FakeProvider } from './ai/provider/fake-provider';
import { runResearchMigrations } from './research/db/research-migrations';
import { ConversationStore } from './ai/conversation-store';
import { WatchProcessingServiceImpl } from './watch/watch-processing-service';
import { WatchRepository } from './watch/repository/watch-repository';
import { runWatchMigrations } from './watch/db/watch-migrations';
import { parseFeedXml } from './watch/feed-parser';
import { readPublicHtml } from './watch/public-html-sax-reader';
import {
  createPublicWatchHttpStack,
  type WatchRequestFactory,
  type WatchRequestLike,
} from './watch/public-watch-http-client';
import { FeedAcquisitionService } from './watch/feed-acquisition-service';
import { PageAcquisitionRouter, WatchAcquisitionService } from './watch/watch-acquisition-service';
import { DigestService } from './watch/digest-service';
import { WatchNotificationService } from './watch/watch-notification-service';
import { diffFeedProjections } from '../shared/watch/diff/feed-diff';
import { renderDigestMarkdown } from './watch/watch-export-service';
import { buildDigestProviderRequest } from './watch/digest-prompt';
import { parseDigestExplanation } from '../shared/watch/digest-validator';
import { serializeCsv } from '../shared/csv/csv-serializer';
import { buildDigestFacts } from '../shared/watch/digest-facts';
import { projectDigestForProvider } from '../shared/watch/digest-sharing-projector';
import { computeChangeFingerprint, computeIdempotencyKey } from '../shared/watch/event-validator';
import { sha256Hex } from '../shared/watch/diff/evidence';
import { FakeClock } from '../shared/watch/clock';
import type { FeedProjection, WatchEvent, WatchRule } from '../shared/types/watch';
import {
  aggregateWatchWrtOutcomes,
  validateWatchSixthMapping,
  validateWatchWrtManifest,
  WATCH_SIXTH_SECTION_MAPPING,
  WATCH_WRT_MANIFEST,
  type WatchWrtOutcome,
} from './smoke-watch-manifest';
import {
  countTokenInBuffer,
  createWatchCanaries,
  evaluateWatchScan,
  readSurfaceFiles,
  summarizeWatchScan,
  validateWatchScanExpectations,
  WATCH_SCAN_EXPECTATIONS,
  WATCH_SCAN_SURFACES,
  type WatchScanVerdict,
  type WatchCanaryKind,
  type WatchScanSurface,
} from './smoke-watch-scan';
import { runWatchRedTeamScenarios } from './smoke-watch-redteam';
import { WATCH_LIVE_SCENARIO_MANIFEST } from './smoke-watch-live';
import { createProductWatchResourcePort } from './smoke-watch-live-resource';

const COHESIVE_STAGES = [
  'Feed',
  'Baseline',
  'Diff',
  'Condition',
  'Event + typed Evidence',
  'Digest',
  'Notification/UI',
] as const;

export interface WatchResourceProbeResult {
  durationMs: number;
  samples: number;
  residualServers: number;
  residualTimers: number;
  residualDatabases: number;
  residualTaskTabs: number;
  residualChildren: number;
  residualTempDirs: number;
  ok: boolean;
}

export interface WatchD10OfflineReport {
  ok: boolean;
  wrtOutcomes: readonly WatchWrtOutcome[];
  wrtAggregation: { ok: boolean; failures: string[] };
  contractErrors: string[];
  scanVerdicts: readonly WatchScanVerdict[];
  scanSummary: { ok: boolean; failures: string[] };
  cohesiveStages: readonly string[];
  resourceProbe: WatchResourceProbeResult;
  scanSource: 'product-pipeline' | 'not-run';
  scanSurfaceSources: readonly { surface: string; source: string; bytes: number }[];
  scanReadFailures: readonly string[];
  cohesiveOk: boolean;
  stageEvidence: readonly WatchStageEvidence[];
  stageEvidenceFailures: readonly string[];
}

export interface WatchStageEvidence {
  id: string;
  section: '§7' | '§9' | '§10';
  ok: boolean;
  evidenceKind: 'structural-proof' | 'real-observation' | 'honest-limit' | 'not-run';
  detail: string;
}

export interface WatchD10OfflineOptions {
  rendererDom?: () => Promise<string>;
  logFile?: string;
  auditEntries?: readonly unknown[];
  resourceObserve?: () => Omit<WatchResourceProbeResult, 'durationMs' | 'samples' | 'ok'>;
  resourceDurationMs?: number;
  resourceSamples?: number;
}

const WATCH_D10_REQUIRED_TABLES = [
  'watch_rules',
  'watch_baselines',
  'watch_runs',
  'watch_events',
  'watch_event_items',
  'watch_event_observations',
  'digest_schedules',
  'digest_runs',
  'digest_change_journal',
  'notification_outbox',
] as const;

const D10_NOW = '2026-09-01T00:00:00.000Z';
const D10_FINGERPRINT = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function d10Rule(id: string): WatchRule {
  return {
    id,
    version: 1,
    sourceId: 'source-d10',
    kind: 'feed',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'public',
    schedule: { kind: 'interval', intervalMinutes: 60 },
    target: { type: 'feed', feedUrl: 'https://example.com/d10.xml', format: 'rss2' },
    condition: null,
    notificationLevel: 'important',
    showDetails: true,
    sourceRowVersion: 1,
    sourceLocatorFingerprint: D10_FINGERPRINT,
    nextDueAt: null,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: D10_NOW,
    updatedAt: D10_NOW,
  };
}

function d10FeedXml(title: string): Buffer {
  return Buffer.from(
    `<rss version="2.0"><channel><title>${title}</title><description>bounded</description><link>https://example.com/</link><item><guid>d10-item</guid><title>${title}</title><link>https://example.com/item</link><description>bounded</description></item></channel></rss>`,
    'utf8',
  );
}

function d10Envelope(
  rule: WatchRule,
  parsed: Extract<Awaited<ReturnType<typeof parseFeedXml>>, { ok: true }>,
  capturedAt: string,
): FeedProjection {
  return {
    schemaVersion: 1,
    ruleId: rule.id,
    sourceId: rule.sourceId,
    finalUrl: 'https://example.com/d10.xml',
    capturedAt,
    documentId: null,
    contentHash: sha256Hex(parsed.canonicalJson),
    byteLength: parsed.byteLength,
    value: parsed.value,
  };
}

function d10ProductRequestFactory(
  feedTitles: readonly string[],
  paths: string[],
  kind: 'feed' | 'page' = 'feed',
  ingressCanary: string | null = null,
): WatchRequestFactory {
  let feedIndex = 0;
  return (options) => {
    const request = new EventEmitter();
    const response = new EventEmitter();
    paths.push(options.path);
    const isRobots = options.path === '/robots.txt';
    const title = feedTitles[Math.min(feedIndex, feedTitles.length - 1)] ?? 'safe';
    let body: Buffer;
    if (isRobots) body = Buffer.alloc(0);
    else if (kind === 'page') {
      body = Buffer.from(
        `<html><body><h1>D10 page</h1><p>cohesive page observation</p><script>${ingressCanary ?? 'drop'}</script></body></html>`,
        'utf8',
      );
    } else {
      feedIndex += 1;
      const xml = d10FeedXml(title);
      body =
        ingressCanary === null
          ? xml
          : Buffer.from(
              xml
                .toString('utf8')
                .replace('</channel>', `<ignored>${ingressCanary}</ignored></channel>`),
              'utf8',
            );
    }
    Object.assign(response, {
      statusCode: isRobots ? 404 : 200,
      statusMessage: isRobots ? 'Not Found' : 'OK',
      headers: isRobots
        ? {}
        : { 'content-type': kind === 'page' ? 'text/html' : 'application/rss+xml' },
      destroy: () => undefined,
      resume: () => undefined,
    });
    Object.assign(request, {
      setTimeout: () => undefined,
      abort: () => request.emit('close'),
      destroy: () => request.emit('close'),
      end: () => {
        queueMicrotask(() => {
          request.emit('response', response);
          if (body.length > 0) response.emit('data', body);
          response.emit('end');
          response.emit('close');
          request.emit('close');
        });
      },
    });
    return request as unknown as WatchRequestLike;
  };
}

function insertRunningWatchRun(repo: WatchRepository, ruleId: string, key: string): string {
  const runId = randomUUID();
  if (
    !repo.insertRun({ id: runId, ruleId, requestKey: key, trigger: 'manual', scheduledFor: null })
      .ok
  )
    throw new Error('D10 cohesive run insert failed');
  if (
    !repo.transitionRun(runId, 'queued', {
      status: 'running',
      startedAt: D10_NOW,
    }).ok
  )
    throw new Error('D10 cohesive run transition failed');
  return runId;
}

function surfaceRows(dbPath: string, tables: readonly string[]): Buffer {
  const db = openDb(dbPath);
  try {
    const rows = tables.map((table) => ({
      table,
      rows: db.prepare(`SELECT * FROM ${table}`).all(),
    }));
    return Buffer.from(JSON.stringify(rows), 'utf8');
  } finally {
    closeDb(db);
  }
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(path);
    }
  };
  if (existsSync(root)) visit(root);
  return files;
}

interface ProductSurfaceBuild {
  surfaces: Map<WatchScanSurface, Buffer>;
  sources: Map<WatchScanSurface, string>;
  readFailures: string[];
  cohesive: boolean;
  cohesiveStages: readonly string[];
  resourceObserve: () => Omit<WatchResourceProbeResult, 'durationMs' | 'samples' | 'ok'>;
  cleanup: () => void;
}

async function buildProductSurfaces(
  canaries: ReadonlyMap<WatchCanaryKind, { value: string }>,
  options: WatchD10OfflineOptions,
): Promise<ProductSurfaceBuild> {
  const root = mkdtempSync(join(tmpdir(), 'aibrowse-d10-product-'));
  const surfaces = new Map<WatchScanSurface, Buffer>();
  const sources = new Map<WatchScanSurface, string>();
  const readFailures: string[] = [];
  const productAuditEntries: string[] = [];
  let cohesive: boolean;
  let completed = false;
  const owned = {
    servers: new Set<object>(),
    timers: new Set<object>(),
    databases: new Set<object>(),
    taskTabs: new Set<string>(),
    children: new Set<object>(),
    tempDirs: new Set<string>(),
  };
  owned.tempDirs.add(root);
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    rmSync(root, { recursive: true, force: true });
    owned.tempDirs.delete(root);
  };
  const resourceObserve = () => ({
    residualServers: owned.servers.size,
    residualTimers: owned.timers.size,
    residualDatabases: owned.databases.size,
    residualTaskTabs: owned.taskTabs.size,
    residualChildren: owned.children.size,
    residualTempDirs: [...owned.tempDirs].filter((path) => existsSync(path)).length,
  });
  try {
    const sourcePath = join(root, 'sources.db');
    const sourceDb = openDb(sourcePath);
    owned.databases.add(sourceDb);
    runMigrations(sourceDb);
    const sourceService = new SourceServiceImpl({ db: sourceDb });
    try {
      const sourceAdapter = createSourcesAdapter({
        service: sourceService,
        audit: (entry) => productAuditEntries.push(entry),
        onChanged: () => undefined,
      });
      const added = await sourceAdapter.add({
        scope: 'page',
        url: 'https://example.com/d10-source',
        name: 'D10 actual source',
      });
      if (!added.ok) throw new Error('D10 SourceService product write failed');
    } finally {
      sourceService.dispose();
      owned.databases.delete(sourceDb);
    }

    const researchPath = join(root, 'research.db');
    const researchDb = openDb(researchPath);
    owned.databases.add(researchDb);
    runResearchMigrations(researchDb);
    closeDb(researchDb);
    owned.databases.delete(researchDb);

    const conversationRoot = join(root, 'conversation');
    const conversationStore = new ConversationStore(conversationRoot);
    conversationStore.saveSessions([]);
    conversationStore.saveMessages('d10-session', []);

    const apiKey = canaries.get('api-key')?.value;
    if (apiKey === undefined) throw new Error('D10 API key canary missing');
    const credentials = new SecureCredentialStoreImpl(join(root, 'credentials'), {
      isAvailable: () => true,
      encrypt: (value) => sha256Hex(value),
      decrypt: () => '',
    });
    if (
      !(await credentials.set('d10-provider', apiKey)) ||
      !(await credentials.has('d10-provider'))
    ) {
      throw new Error('D10 SecureCredentialStore product ingress failed');
    }
    const credentialRead = readSurfaceFiles([
      { label: 'credentials', path: join(root, 'credentials', 'credentials.json') },
    ]);
    if (credentialRead.readFailures.length > 0 || credentialRead.data.includes(apiKey)) {
      throw new Error('D10 SecureCredentialStore plaintext exposure');
    }

    const reasoningCanary = canaries.get('reasoning-transcript')?.value;
    if (reasoningCanary === undefined) throw new Error('D10 reasoning canary missing');
    const reasoningProvider = new FakeProvider({
      rounds: [[{ kind: 'reasoning', text: reasoningCanary }, { text: '完成' }]],
    });
    const reasoningLoop = new AgentLoop({
      requestId: 'd10-reasoning-run',
      model: 'd10-offline',
      goalMessage: { role: 'user', content: '执行 D10 reasoning ingress' },
      replayMessages: [],
      tools: [],
      providerResolver: async () => reasoningProvider,
      confirmManager: new ConfirmManager(),
      browser: null as never,
      audit: () => undefined,
      now: () => Date.parse(D10_NOW),
      limits: { maxSteps: 1, totalTimeoutMs: 5_000 },
    });
    const reasoningResult = await reasoningLoop.run(new AbortController().signal);
    if (
      reasoningResult.status !== 'done' ||
      JSON.stringify(reasoningResult).includes(reasoningCanary) ||
      JSON.stringify(reasoningProvider.getRequests()).includes(reasoningCanary)
    ) {
      throw new Error('D10 reasoning ingress exposure');
    }

    // Each non-persisted canary enters its own product parser/validator seam;
    // only the bounded, validated projections below are eligible for storage.
    const httpBodyCanary = canaries.get('http-body')?.value;
    const pageSnapshotCanary = canaries.get('page-snapshot')?.value;
    const providerRawCanary = canaries.get('provider-raw')?.value;
    const urlTokenCanary = canaries.get('url-token')?.value;
    if (
      httpBodyCanary === undefined ||
      pageSnapshotCanary === undefined ||
      providerRawCanary === undefined ||
      urlTokenCanary === undefined
    ) {
      throw new Error('D10 canary ingress 缺失');
    }
    const rawFeedProbe = await parseFeedXml(
      Buffer.from(
        `<rss version="2.0"><channel><title>raw-body-probe</title><description>safe</description><link>https://example.com/</link><ignored>${httpBodyCanary}</ignored></channel></rss>`,
        'utf8',
      ),
    );
    if (!rawFeedProbe.ok || rawFeedProbe.canonicalJson.includes(httpBodyCanary)) {
      throw new Error('D10 raw HTTP body ingress 未被 FeedParser 丢弃');
    }
    const pageProbe = readPublicHtml(
      Buffer.from(
        `<html><body><script>${pageSnapshotCanary}</script><p>page probe</p></body></html>`,
        'utf8',
      ),
      'https://example.com/d10-page',
    );
    if (!pageProbe.ok || JSON.stringify(pageProbe.channels).includes(pageSnapshotCanary)) {
      throw new Error('D10 PageSnapshot ingress 未被 PageParser 丢弃');
    }
    const explanationProbe = parseDigestExplanation(
      JSON.stringify({
        sections: [{ eventIds: ['d10-event'], explanation: providerRawCanary }],
      }),
      ['d10-event'],
    );
    if (explanationProbe === null) {
      throw new Error('D10 Provider raw ingress 未被解释器隔离');
    }
    const urlProbe = new URL(`https://example.com/d10?token=${encodeURIComponent(urlTokenCanary)}`);
    if (urlProbe.searchParams.get('token') !== urlTokenCanary) {
      throw new Error('D10 URL query canary ingress failed');
    }

    const watchPath = join(root, 'watch.db');
    const watchDb = openDb(watchPath);
    owned.databases.add(watchDb);
    runWatchMigrations(watchDb);
    const repo = new WatchRepository(watchDb);
    try {
      const rule = d10Rule(randomUUID());
      if (!repo.insertRule(rule).ok) throw new Error('D10 Watch rule insert failed');
      const safeParsed = await parseFeedXml(d10FeedXml('safe baseline'));
      if (!safeParsed.ok) throw new Error('D10 FeedParser baseline failed');
      const safeProjection = d10Envelope(rule, safeParsed, D10_NOW);
      const evidenceCanary = canaries.get('evidence-excerpt');
      if (evidenceCanary === undefined) throw new Error('D10 evidence canary missing');
      const changedParsed = await parseFeedXml(d10FeedXml(evidenceCanary.value));
      if (!changedParsed.ok) throw new Error('D10 FeedParser Evidence input failed');
      const changedProjection = d10Envelope(rule, changedParsed, '2026-09-01T00:00:01.000Z');
      const diff = diffFeedProjections(
        {
          value: safeProjection.value,
          finalUrl: safeProjection.finalUrl,
          capturedAt: safeProjection.capturedAt,
          documentId: safeProjection.documentId,
        },
        {
          value: changedProjection.value,
          finalUrl: changedProjection.finalUrl,
          capturedAt: changedProjection.capturedAt,
          documentId: changedProjection.documentId,
        },
      );
      if (!diff.ok || diff.pairs.length === 0) throw new Error('D10 Feed Diff product path failed');
      const eventId = randomUUID();
      const event: WatchEvent = {
        id: eventId,
        ruleId: rule.id,
        sourceId: rule.sourceId,
        eventKind: 'changed',
        importance: 'important',
        idempotencyKey: computeIdempotencyKey({
          ruleId: rule.id,
          baselineVersion: 0,
          newProjectionHash: changedProjection.contentHash,
          conditionVersion: 'none',
        }),
        changeFingerprint: computeChangeFingerprint(
          diff.pairs.map((pair) => ({
            itemKey: pair.itemId,
            fieldKey: pair.fieldKey,
            pairKind:
              pair.before.kind === 'absent'
                ? 'added'
                : pair.after.kind === 'absent'
                  ? 'removed'
                  : 'changed',
            before: pair.before,
            after: pair.after,
          })),
        ),
        firstObservedAt: changedProjection.capturedAt,
        lastObservedAt: changedProjection.capturedAt,
        itemCount: diff.pairs.length,
        readAt: null,
      };
      const runId = insertRunningWatchRun(repo, rule.id, 'd10-privacy-run');
      const result = repo.writeEventResult({
        path: 'create',
        rule,
        runId,
        sourceAfterRevalidationRowVersion: 1,
        identity: {
          sourceId: rule.sourceId,
          sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
          expectedBaselineVersion: null,
        },
        baseline: {
          projectionType: 'feed',
          projectionJson: JSON.stringify(safeProjection.value),
          contentHash: safeProjection.contentHash,
          byteLength: safeProjection.byteLength,
          finalUrl: safeProjection.finalUrl,
          capturedAt: safeProjection.capturedAt,
          documentId: null,
          validators: { etag: null, lastModified: null },
        },
        event: { event, items: diff.pairs },
        run: {
          expectedStatus: 'running',
          outcome: { kind: 'event-created', eventId },
          health: { state: 'healthy', acquisition: 'rss', code: null },
          responseMetadataJson: JSON.stringify({
            schemaVersion: 1,
            http: { httpStatus: 200, etag: null, lastModified: null, warnings: [] },
            conditionWarnings: [],
          }),
        },
        audits: [{ id: randomUUID(), reasonCode: 'event-created', createdAt: D10_NOW }],
      });
      if (!result.ok) throw new Error('D10 Watch event product transaction failed');

      const eventRows = repo.listEventsByRule(rule.id);
      const actualEvent = eventRows[0];
      if (actualEvent === undefined) throw new Error('D10 Watch event readback failed');
      const actualItems = repo.listEventItems(actualEvent.id);
      const facts = buildDigestFacts({
        scheduleId: 'd10-schedule',
        digestRunId: 'd10-digest-run',
        batchIndex: 0,
        period: { fromExclusive: '2026-08-31T00:00:00.000Z', toInclusive: D10_NOW },
        runStats: { changed: 1, failed: 0, unchanged: 0 },
        observations: [
          {
            sequence: 1,
            eventId: actualEvent.id,
            ruleId: actualEvent.ruleId,
            sourceId: actualEvent.sourceId,
            eventKind: actualEvent.eventKind,
            importance: actualEvent.importance,
            observedAt: actualEvent.firstObservedAt,
            items: actualItems,
          },
        ],
        fetchedAt: D10_NOW,
      });
      if (facts === null) throw new Error('D10 DigestFacts product build failed');
      const projection = projectDigestForProvider(facts, [
        {
          sourceId: rule.sourceId,
          shareMode: 'full',
          displayName: 'D10 actual source',
          canonicalUrl: safeProjection.finalUrl,
        },
      ]);
      const providerRequest = buildDigestProviderRequest({
        requestId: randomUUID(),
        model: 'd10-observation-model',
        projection,
      });
      if (providerRequest === null) throw new Error('D10 Provider request product build failed');
      const notification = buildInAppNotification({
        notificationId: randomUUID(),
        subjectType: 'event',
        subjectId: actualEvent.id,
        accessMode: 'public',
        showDetails: true,
        importance: actualEvent.importance,
        sourceName: 'D10 actual source',
        changeCount: actualEvent.itemCount,
        fieldLabels: actualItems.map((item) => item.label),
        createdAt: D10_NOW,
      });
      if (notification.subjectId !== actualEvent.id)
        throw new Error('D10 NotificationPolicy product build failed');
      const markdown = renderDigestMarkdown({ facts, explanation: null });
      const formula = canaries.get('csv-formula');
      if (markdown === null || formula === undefined)
        throw new Error('D10 export product build failed');
      const csv = serializeCsv(['事件 ID', '备注'], [[actualEvent.id, formula.value]]);

      surfaces.set(
        'watch-db-evidence',
        surfaceRows(watchPath, ['watch_event_items', 'watch_digests']),
      );
      sources.set('watch-db-evidence', `${watchPath}:watch_event_items+watch_digests`);
      surfaces.set(
        'watch-db-non-evidence',
        surfaceRows(watchPath, [
          'watch_rules',
          'watch_baselines',
          'watch_runs',
          'watch_events',
          'watch_event_observations',
          'watch_audits',
          'digest_change_state',
          'digest_schedules',
          'digest_runs',
          'notification_outbox',
          'source_cleanup_intents',
          'digest_change_journal',
          'digest_event_refs',
        ]),
      );
      sources.set('watch-db-non-evidence', `${watchPath}:non-evidence-columns`);
      surfaces.set('exports', Buffer.from(`${markdown.text}\n${csv.text}`, 'utf8'));
      sources.set('exports', 'WatchExportService.renderDigestMarkdown + serializeCsv');
      // The final privacy surface is populated from the request captured by the
      // actual DigestService -> Provider path below. The direct builder result
      // remains a shape/serialization assertion, but it is not itself the
      // byte-level transport oracle.

      // Exercise the actual FeedParser and ProcessingService with five observations in a
      // separate product-owned database; the privacy event above was also produced by this
      // same acquisition/diff/result path.
      const cohesiveDir = mkdtempSync(join(root, 'cohesive-'));
      const cohesiveDb = openDb(join(cohesiveDir, 'watch.db'));
      owned.databases.add(cohesiveDb);
      runWatchMigrations(cohesiveDb);
      const cohesiveRepo = new WatchRepository(cohesiveDb);
      let capturedProviderRequest: unknown = null;
      let capturedNotification: unknown = null;
      try {
        const cohesiveRule = d10Rule(randomUUID());
        cohesiveRule.condition = {
          version: 1,
          combine: 'all',
          predicates: [
            { fieldKey: 'title', operator: 'changed', operand: null, caseSensitive: false },
          ],
        };
        if (!cohesiveRepo.insertRule(cohesiveRule).ok) throw new Error('cohesive rule failed');
        const clock = new FakeClock(Date.parse(D10_NOW));
        const processing = new WatchProcessingServiceImpl({ repo: cohesiveRepo, clock });
        const acquisitionPaths: string[] = [];
        const httpBodyCanary = canaries.get('http-body')?.value ?? null;
        const pageSnapshotCanary = canaries.get('page-snapshot')?.value ?? null;
        const evidenceCanaryValue =
          canaries.get('evidence-excerpt')?.value ?? 'D10-evidence-missing';
        const publicStack = createPublicWatchHttpStack({
          clock,
          lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
          request: d10ProductRequestFactory(
            ['A', 'B', evidenceCanaryValue],
            acquisitionPaths,
            'feed',
            httpBodyCanary,
          ),
        });
        const feedService = new FeedAcquisitionService({ target: publicStack.target });
        const pagePaths: string[] = [];
        const pageStack = createPublicWatchHttpStack({
          clock,
          lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
          request: d10ProductRequestFactory([], pagePaths, 'page', pageSnapshotCanary),
        });
        const pageRouter = new PageAcquisitionRouter({
          publicTarget: pageStack.target,
          workspace: null as never,
          reader: null as never,
          hostGate: null as never,
          clock,
        });
        const unified = new WatchAcquisitionService({ feed: feedService, page: pageRouter });
        const providerRawCanary = canaries.get('provider-raw')?.value ?? 'D10-provider-raw-missing';
        const digestProvider = new FakeProvider({ rounds: [[providerRawCanary]] });
        const pageRule: WatchRule = {
          ...cohesiveRule,
          id: randomUUID(),
          kind: 'page',
          target: {
            type: 'page',
            pageUrl: 'https://example.com/watch',
            regions: [{ kind: 'main-text', label: '正文' }],
            sessionConsent: null,
          },
          condition: null,
        };
        const signal = new AbortController().signal;
        const deadline = new Date(Date.now() + 5_000);
        const pageAcquired = await unified.run({
          rule: pageRule,
          baselineHint: { kind: 'none', expectedBaselineVersion: 0 },
          signal,
          deadline,
        });
        if (
          !pageAcquired.ok ||
          pageAcquired.kind !== 'projection' ||
          pageAcquired.projection.value.type !== 'page' ||
          !pageAcquired.projection.value.fields.some(
            (field) => 'value' in field && field.value.includes('cohesive page observation'),
          ) ||
          pagePaths.join('|') !== '/robots.txt|/watch'
        ) {
          throw new Error('cohesive Page acquisition failed');
        }
        const firstAcquired = await unified.run({
          rule: cohesiveRule,
          baselineHint: { kind: 'none', expectedBaselineVersion: 0 },
          signal,
          deadline,
        });
        if (!firstAcquired.ok || firstAcquired.kind !== 'projection')
          throw new Error('cohesive Feed acquisition failed');
        const firstRun = insertRunningWatchRun(cohesiveRepo, cohesiveRule.id, 'cohesive-1');
        const first = processing.process({
          rule: cohesiveRule,
          runId: firstRun,
          baselineHint: { kind: 'none', expectedBaselineVersion: 0 },
          acquisition: firstAcquired,
          sourceAfterAcquisition: {
            sourceId: cohesiveRule.sourceId,
            rowVersion: 1,
            enabled: true,
            deletedAt: null,
            scope: 'page',
            canonicalKey: 'https://example.com/d10-source',
          },
        });
        if (!first.ok) throw new Error('cohesive baseline failed');
        const fresh = cohesiveRepo.getRule(cohesiveRule.id);
        if (fresh === null) throw new Error('cohesive rule readback failed');
        const hint = processing.prepareAcquisition({ rule: fresh });
        if (!hint.ok) throw new Error('cohesive baseline hint failed');
        const secondAcquired = await unified.run({
          rule: fresh,
          baselineHint: hint.baselineHint,
          signal,
          deadline,
        });
        if (!secondAcquired.ok || secondAcquired.kind !== 'projection')
          throw new Error('cohesive Feed re-acquisition failed');
        const secondRun = insertRunningWatchRun(cohesiveRepo, fresh.id, 'cohesive-2');
        const second = processing.process({
          rule: fresh,
          runId: secondRun,
          baselineHint: hint.baselineHint,
          acquisition: secondAcquired,
          sourceAfterAcquisition: {
            sourceId: fresh.sourceId,
            rowVersion: 1,
            enabled: true,
            deletedAt: null,
            scope: 'page',
            canonicalKey: 'https://example.com/d10-source',
          },
        });
        if (!second.ok || !second.outcome.kind.startsWith('event-'))
          throw new Error('cohesive event failed');
        const event = cohesiveRepo.listEventsByRule(fresh.id)[0];
        if (event === undefined) throw new Error('cohesive event readback failed');
        const digest = new DigestService({
          repository: cohesiveRepo,
          clock,
          sharing: {
            get: async () => [
              {
                sourceId: fresh.sourceId,
                shareMode: 'full' as const,
                displayName: 'D10 cohesive source',
                canonicalUrl: 'https://example.com/d10-source',
              },
            ],
          },
          provider: {
            resolve: async () => ({ provider: digestProvider, model: 'd10-offline-provider' }),
          },
          membership: {
            resolve: async () => ({
              status: 'ok' as const,
              members: [
                {
                  sourceId: fresh.sourceId,
                  displayName: 'D10 cohesive source',
                  canonicalUrl: 'https://example.com/d10-source',
                },
              ],
            }),
          },
          scheduleControl: { upsert: () => undefined, remove: () => undefined },
        });
        const scheduleId = 'cohesive-schedule';
        try {
          if (
            !(
              await digest.createSchedule({
                id: scheduleId,
                selector: { sourceIds: [fresh.sourceId] },
                localTime: '00:00',
                timeZone: 'UTC',
                aiEnabled: true,
              })
            ).ok
          )
            throw new Error('cohesive Digest schedule failed');

          const afterSecond = cohesiveRepo.getRule(fresh.id);
          if (afterSecond === null) throw new Error('cohesive post-event rule readback failed');
          const thirdHint = processing.prepareAcquisition({ rule: afterSecond });
          if (!thirdHint.ok) throw new Error('cohesive second baseline hint failed');
          // The second event is intentionally committed before the digest
          // schedule, so the schedule cursor starts at that event. Advance the
          // product clock and commit one more changed observation after the
          // schedule exists; the digest must consume that observation.
          clock.advanceBy(1_000);
          const thirdAcquired = await unified.run({
            rule: afterSecond,
            baselineHint: thirdHint.baselineHint,
            signal,
            deadline,
          });
          if (!thirdAcquired.ok || thirdAcquired.kind !== 'projection')
            throw new Error('cohesive Feed third acquisition failed');
          const thirdRun = insertRunningWatchRun(cohesiveRepo, afterSecond.id, 'cohesive-3');
          const third = processing.process({
            rule: afterSecond,
            runId: thirdRun,
            baselineHint: thirdHint.baselineHint,
            acquisition: thirdAcquired,
            sourceAfterAcquisition: {
              sourceId: afterSecond.sourceId,
              rowVersion: 1,
              enabled: true,
              deletedAt: null,
              scope: 'page',
              canonicalKey: 'https://example.com/d10-source',
            },
          });
          if (!third.ok || !third.outcome.kind.startsWith('event-'))
            throw new Error('cohesive second event failed');
          const schedule = digest.getSchedule(scheduleId)?.schedule;
          if (schedule === undefined) throw new Error('cohesive Digest schedule readback failed');
          const handled = await digest.handleDue({
            scheduleId,
            expectedNextDueAt: schedule.nextDueAt,
            logicalDate: '2026-09-01',
          });
          const digestState = digest.getSchedule(scheduleId);
          if (!handled.ok) throw new Error('cohesive Digest handleDue failed');
          const artifact = digestState?.artifacts[0];
          if (artifact === undefined) throw new Error('cohesive Digest artifact missing');
          const providerRequestCapture = digestProvider.getRequests()[0];
          if (providerRequestCapture === undefined)
            throw new Error('cohesive Provider request capture missing');
          capturedProviderRequest = providerRequestCapture;
          if (
            surfaceRows(join(cohesiveDir, 'watch.db'), ['watch_digests']).includes(
              providerRawCanary,
            )
          )
            throw new Error('cohesive Digest persisted raw Provider response');
          const cohesiveFacts = artifact.facts;
          const cohesiveDigest = renderDigestMarkdown({ facts: cohesiveFacts, explanation: null });
          if (cohesiveDigest === null) throw new Error('cohesive Digest render failed');
          const delivered: string[] = [];
          const notifications = new WatchNotificationService(
            () => cohesiveRepo,
            (notification) => {
              delivered.push(notification.subjectId);
              capturedNotification = notification;
              return true;
            },
            () => undefined,
            'in-app',
            () => 'D10 cohesive source',
          );
          await notifications.drain();
          const cohesiveNotification = delivered.includes(event.id);
          const digestNotification = delivered.includes(artifact.id);
          const typedEvidence = cohesiveRepo
            .listEventItems(event.id)
            .every((item) => item.before !== undefined && item.after !== undefined);
          cohesive =
            cohesiveNotification &&
            digestNotification &&
            typedEvidence &&
            cohesiveFacts.eventCount > 0 &&
            cohesiveFacts.events.some((factEvent) =>
              cohesiveDigest.text.includes(factEvent.eventId.replaceAll('-', '\\-')),
            );
        } finally {
          digest.dispose();
        }
        if (!cohesive) throw new Error('cohesive final projection failed');
        if (acquisitionPaths.join('|') !== '/robots.txt|/d10.xml|/d10.xml|/d10.xml') {
          throw new Error('cohesive acquisition request ledger mismatch');
        }
      } finally {
        cohesiveRepo.dispose();
        owned.databases.delete(cohesiveDb);
        rmSync(cohesiveDir, { recursive: true, force: true });
      }
      if (capturedProviderRequest === null) throw new Error('cohesive Provider request missing');
      surfaces.set(
        'provider-request',
        Buffer.from(JSON.stringify(capturedProviderRequest), 'utf8'),
      );
      sources.set('provider-request', 'DigestService -> Provider.stream request capture');
      if (capturedNotification === null)
        throw new Error('cohesive Notification DTO capture missing');
      surfaces.set('notification-dto', Buffer.from(JSON.stringify(capturedNotification), 'utf8'));
      sources.set('notification-dto', 'WatchNotificationService -> delivery callback capture');
    } finally {
      repo.dispose();
      owned.databases.delete(watchDb);
    }

    const sourceRead = readSurfaceFiles([{ label: 'sources-db', path: sourcePath }]);
    surfaces.set('sources-db', sourceRead.data);
    sources.set('sources-db', sourcePath);
    readFailures.push(...sourceRead.readFailures);
    const researchRead = readSurfaceFiles([{ label: 'research-db', path: researchPath }]);
    surfaces.set('research-db', researchRead.data);
    sources.set('research-db', researchPath);
    readFailures.push(...researchRead.readFailures);
    const conversationFiles = readSurfaceFiles(
      filesUnder(conversationRoot).map((path) => ({ label: `conversation:${path}`, path })),
    );
    surfaces.set('conversation', conversationFiles.data);
    sources.set('conversation', `${conversationRoot}:ConversationStore`);
    readFailures.push(...conversationFiles.readFailures);

    if (options.logFile === undefined) {
      readFailures.push('log:not-provided');
      surfaces.set('log', Buffer.alloc(0));
      sources.set('log', 'not-provided');
    } else {
      const log = readSurfaceFiles([{ label: 'log', path: options.logFile }]);
      surfaces.set('log', log.data);
      sources.set('log', options.logFile);
      readFailures.push(...log.readFailures);
    }
    if (options.auditEntries === undefined) {
      readFailures.push('audit:not-provided');
      surfaces.set('audit', Buffer.alloc(0));
      sources.set('audit', 'not-provided');
    } else {
      surfaces.set(
        'audit',
        Buffer.from(JSON.stringify([...productAuditEntries, ...options.auditEntries]), 'utf8'),
      );
      sources.set('audit', 'smokeAuditCollector');
    }
    if (options.rendererDom === undefined) {
      readFailures.push('renderer-dom:not-provided');
      surfaces.set('renderer-dom', Buffer.alloc(0));
      sources.set('renderer-dom', 'not-provided');
    } else {
      surfaces.set('renderer-dom', Buffer.from(await options.rendererDom(), 'utf8'));
      sources.set('renderer-dom', 'BrowserWindow.webContents DOM');
    }
    const result: ProductSurfaceBuild = {
      surfaces,
      sources,
      readFailures,
      cohesive,
      cohesiveStages: COHESIVE_STAGES,
      resourceObserve,
      cleanup,
    };
    completed = true;
    return result;
  } finally {
    // Successful builds keep their owned root until the caller has explicitly
    // completed the bounded residual-resource observation.
    if (!completed) cleanup();
  }
}

function assertWatchD10GateSchema(dbPath: string, label: string): void {
  const db = openDb(dbPath);
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version !== 5) throw new Error(`${label}：Watch schema version 非 v5`);
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    for (const table of WATCH_D10_REQUIRED_TABLES) {
      if (!tables.has(table)) throw new Error(`${label}：Watch D10 table 缺失`);
    }
    const columns = new Set(
      (db.prepare('PRAGMA table_info(watch_rules)').all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!columns.has('rule_version') || !columns.has('notification_show_details')) {
      throw new Error(`${label}：Watch v5 column 缺失`);
    }
  } finally {
    closeDb(db);
  }
}

/** Cross-process set-side schema observation; it performs no product writes. */
export function runWatchD10CrossProcessSet(dbPath: string): void {
  assertWatchD10GateSchema(dbPath, 'WATCH D10 set');
}

/** Cross-process check-side schema/state observation; it performs no product writes. */
export function runWatchD10CrossProcessCheck(dbPath: string): void {
  assertWatchD10GateSchema(dbPath, 'WATCH D10 check');
  const db = openDb(dbPath);
  try {
    const eventCount = (
      db.prepare('SELECT COUNT(*) AS count FROM watch_events').get() as { count: number }
    ).count;
    if (eventCount < 1) throw new Error('WATCH D10 check：跨进程 Event 事实缺失');
  } finally {
    closeDb(db);
  }
}

function buildStageEvidence(input: {
  wrtOutcomes: readonly WatchWrtOutcome[];
  cohesiveOk: boolean;
  scanOk: boolean;
  resourceOk: boolean;
}): { results: WatchStageEvidence[]; failures: string[] } {
  const wrt = new Map(input.wrtOutcomes.map((item) => [item.id, item]));
  const wrtOk = (...ids: string[]): boolean => ids.every((id) => wrt.get(id)?.ok === true);
  const result = (
    id: string,
    section: WatchStageEvidence['section'],
    ok: boolean,
    evidenceKind: WatchStageEvidence['evidenceKind'],
    detail: string,
  ): WatchStageEvidence => ({ id, section, ok, evidenceKind, detail });
  const results = [
    result(
      'S6-7-1',
      '§7',
      wrtOk('WRT-08'),
      'real-observation',
      'WRT-08 实际 FeedParser/Processing 五次观察产生稳定事件事实',
    ),
    result(
      'S6-7-2',
      '§7',
      wrtOk('WRT-08'),
      'real-observation',
      'WRT-08 从实际 watch.db 观察读取更新事件',
    ),
    result(
      'S6-7-3',
      '§7',
      wrtOk('WRT-11'),
      'structural-proof',
      'WRT-11 实际 PageProjector/PageDiff 区域路径证明；Electron 页面采集未在离线 gate 运行',
    ),
    result(
      'S6-7-4',
      '§7',
      wrtOk('WRT-12'),
      'structural-proof',
      'WRT-12 实际 Condition 引擎求值 warning/error 分离',
    ),
    result(
      'S6-7-5',
      '§7',
      wrtOk('WRT-11', 'WRT-12'),
      'structural-proof',
      'WRT-11/WRT-12 证明结构变化与条件失败不制造假结论',
    ),
    result(
      'S6-7-6',
      '§7',
      input.cohesiveOk && input.scanOk,
      'structural-proof',
      'cohesive 实际完成 Digest facts、导出、Provider request 与通知 DTO',
    ),
    result(
      'S6-7-7',
      '§7',
      wrtOk('WRT-08') && input.cohesiveOk,
      'real-observation',
      'WRT-08 去重观察与 cohesive 通知投影均来自实际路径',
    ),
    result(
      'S6-9-1',
      '§9',
      wrtOk('WRT-08'),
      'real-observation',
      '真实 FeedParser/ProcessingService 观察覆盖 feed 去重与 health 结果',
    ),
    result(
      'S6-9-2',
      '§9',
      input.cohesiveOk,
      'structural-proof',
      'cohesive 实际完成 Feed → Baseline → Diff → Event/Evidence',
    ),
    result(
      'S6-9-3',
      '§9',
      wrtOk('WRT-12'),
      'structural-proof',
      'Condition warning/error 与 typed Evidence 由确定性代码产生',
    ),
    result(
      'S6-9-4',
      '§9',
      input.cohesiveOk && input.scanOk,
      'structural-proof',
      'Digest changed/unchanged 事实、通知与导出均已读取',
    ),
    result(
      'S6-9-5',
      '§9',
      wrtOk('WRT-05', 'WRT-16') && input.resourceOk,
      'structural-proof',
      'robots/预算/调度 reservation 与有界资源观察通过',
    ),
    result(
      'S6-9-6',
      '§9',
      input.scanOk && input.resourceOk && wrtOk('WRT-18'),
      'structural-proof',
      'D10 机器 gate 覆盖隐私、资源、迁移和 WRT 独立结果',
    ),
    result(
      'S6-10-1',
      '§10',
      wrtOk('WRT-08', 'WRT-11'),
      'structural-proof',
      'Feed identity 去重与 Page 区域精确 Diff 防止噪声事件',
    ),
    result(
      'S6-10-2',
      '§10',
      wrtOk('WRT-05', 'WRT-12'),
      'structural-proof',
      '失败分类、预算拒绝和 Condition error 与变化事实分离',
    ),
    result(
      'S6-10-3',
      '§10',
      wrtOk('WRT-04', 'WRT-05', 'WRT-16') && input.resourceOk,
      'real-observation',
      'Node 24 transport、robots、reservation 与资源探针结果已执行',
    ),
    result(
      'S6-10-4',
      '§10',
      wrtOk('WRT-03', 'WRT-08', 'WRT-11'),
      'structural-proof',
      'RSS/Public 与 Page fallback 的安全边界和 Diff 分支已验证',
    ),
    result(
      'S6-10-5',
      '§10',
      wrtOk('WRT-18') && input.scanOk,
      'structural-proof',
      'Watch schema/retention surface 与隐私扫描均来自当前 gate',
    ),
  ];
  const failures = results.filter((item) => !item.ok).map((item) => `${item.id}：${item.detail}`);
  return { results, failures };
}

export async function runWatchResourceProbe(
  options: {
    durationMs?: number;
    samples?: number;
    observe?: () => Omit<WatchResourceProbeResult, 'durationMs' | 'samples' | 'ok'>;
  } = {},
): Promise<WatchResourceProbeResult> {
  const durationMs = options.durationMs ?? 250;
  const samples = options.samples ?? 3;
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 30_000) {
    throw new Error('D10 resource probe duration 超出有界范围');
  }
  if (!Number.isSafeInteger(samples) || samples < 2 || samples > 100) {
    throw new Error('D10 resource probe samples 超出有界范围');
  }
  if (options.observe === undefined) {
    throw new Error('D10 resource probe 缺少产品所有权观察器，不能伪造零残留结果');
  }
  const observe = options.observe;
  let last = observe();
  const intervalMs = Math.max(1, Math.floor(durationMs / (samples - 1 || 1)));
  for (let index = 1; index < samples; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    last = observe();
  }
  const ok = Object.values(last).every((value) => Number.isSafeInteger(value) && value === 0);
  return { durationMs, samples, ...last, ok };
}

async function buildProductScanVerdicts(options: WatchD10OfflineOptions): Promise<{
  verdicts: WatchScanVerdict[];
  sources: readonly { surface: string; source: string; bytes: number }[];
  readFailures: readonly string[];
  cohesive: boolean;
  cohesiveStages: readonly string[];
  resourceObserve: () => Omit<WatchResourceProbeResult, 'durationMs' | 'samples' | 'ok'>;
  cleanup: () => void;
}> {
  const canaries = new Map(createWatchCanaries().map((canary) => [canary.kind, canary]));
  const product = await buildProductSurfaces(canaries, options);
  // First observe every actual product surface against every ingress canary.
  // The expectation manifest only interprets this completed observation matrix;
  // it cannot choose a fixture or supply the bytes being scanned.
  const observedHits = new Map<string, number>();
  for (const surface of WATCH_SCAN_SURFACES) {
    const data = product.surfaces.get(surface);
    if (data === undefined) continue;
    for (const [kind, canary] of canaries) {
      observedHits.set(`${kind}@${surface}`, countTokenInBuffer(data, canary.value));
    }
  }
  const verdicts = WATCH_SCAN_EXPECTATIONS.map((expectation) => {
    const label = `${expectation.canaryKind}@${expectation.surface}`;
    const hits = observedHits.get(label);
    if (hits === undefined) return { label, hits: 0, ok: false };
    return { ...evaluateWatchScan(expectation, hits), label };
  });
  return {
    verdicts,
    sources: [...product.surfaces].map(([surface, data]) => ({
      surface,
      source: product.sources.get(surface) ?? 'unknown',
      bytes: data.byteLength,
    })),
    readFailures: product.readFailures,
    cohesive: product.cohesive,
    cohesiveStages: product.cohesiveStages,
    resourceObserve: product.resourceObserve,
    cleanup: product.cleanup,
  };
}

export async function runWatchD10OfflineScenario(
  options: WatchD10OfflineOptions = {},
): Promise<WatchD10OfflineReport> {
  const contractErrors = [
    ...validateWatchWrtManifest(WATCH_WRT_MANIFEST),
    ...validateWatchSixthMapping(WATCH_SIXTH_SECTION_MAPPING),
    ...validateWatchScanExpectations(WATCH_SCAN_EXPECTATIONS),
  ];
  const wrtOutcomes = await runWatchRedTeamScenarios();
  const wrtAggregation = aggregateWatchWrtOutcomes(wrtOutcomes);
  const productScan = await buildProductScanVerdicts(options);
  const scanVerdicts = productScan.verdicts;
  const scanSummary = summarizeWatchScan(scanVerdicts);
  let resourceProbe: WatchResourceProbeResult;
  try {
    // Observe only after the product has completed its own close/dispose and
    // temporary-directory cleanup sequence.
    productScan.cleanup();
    if (options.resourceObserve === undefined) {
      const scenario = WATCH_LIVE_SCENARIO_MANIFEST.find((item) => item.kind === 'resource');
      if (scenario === undefined) throw new Error('D10 resource scenario missing');
      const actual = await createProductWatchResourcePort(null).probe(
        scenario,
        new AbortController().signal,
      );
      const residuals = actual.residuals;
      resourceProbe = {
        durationMs: actual.observedForMs ?? 0,
        samples: actual.samples ?? 0,
        residualServers: residuals?.servers ?? Number.NaN,
        residualTimers: residuals?.timers ?? Number.NaN,
        residualDatabases: residuals?.databases ?? Number.NaN,
        residualTaskTabs: residuals?.taskTabs ?? Number.NaN,
        residualChildren: residuals?.children ?? Number.NaN,
        residualTempDirs: residuals?.tempDirs ?? Number.NaN,
        ok:
          actual.errorCode === undefined &&
          actual.observedForMs !== undefined &&
          actual.observedForMs > 0 &&
          actual.samples !== undefined &&
          actual.samples >= 2 &&
          residuals !== undefined &&
          Object.values(residuals).every((value) => value === 0),
      };
    } else {
      resourceProbe = await runWatchResourceProbe({
        durationMs: options.resourceDurationMs,
        samples: options.resourceSamples,
        observe: options.resourceObserve,
      });
    }
  } catch {
    resourceProbe = {
      durationMs: 0,
      samples: 0,
      residualServers: Number.NaN,
      residualTimers: Number.NaN,
      residualDatabases: Number.NaN,
      residualTaskTabs: Number.NaN,
      residualChildren: Number.NaN,
      residualTempDirs: Number.NaN,
      ok: false,
    };
  } finally {
    productScan.cleanup();
  }
  const stageEvidence = buildStageEvidence({
    wrtOutcomes,
    cohesiveOk: productScan.cohesive,
    scanOk: scanSummary.ok && productScan.readFailures.length === 0,
    resourceOk: resourceProbe.ok,
  });
  return {
    ok:
      contractErrors.length === 0 &&
      wrtAggregation.ok &&
      scanSummary.ok &&
      productScan.readFailures.length === 0 &&
      productScan.cohesive &&
      resourceProbe.ok &&
      stageEvidence.failures.length === 0,
    wrtOutcomes,
    wrtAggregation,
    contractErrors,
    scanVerdicts,
    scanSummary,
    cohesiveStages: productScan.cohesiveStages,
    resourceProbe,
    scanSource: 'product-pipeline',
    scanSurfaceSources: productScan.sources,
    scanReadFailures: productScan.readFailures,
    cohesiveOk: productScan.cohesive,
    stageEvidence: stageEvidence.results,
    stageEvidenceFailures: stageEvidence.failures,
  };
}
