import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FakeClock } from '../shared/watch/clock';
import { sha256Hex } from '../shared/watch/diff/evidence';
import type { PageProjection, SourceWatchProjection, WatchRule } from '../shared/types/watch';
import { openDb } from './sources/db/sqlite-driver';
import { runWatchMigrations } from './watch/db/watch-migrations';
import { WatchRepository } from './watch/repository/watch-repository';
import { WatchProcessingServiceImpl } from './watch/watch-processing-service';

it('H3a Page 200 ETag finishes unchanged without writing Page validators', () => {
  const root = mkdtempSync(join(tmpdir(), 'aibrowse-h3a-page-validator-'));
  const nowMs = Date.parse('2026-09-06T00:00:00.000Z');
  const repo = new WatchRepository(openDb(join(root, 'watch.db')));
  try {
    runWatchMigrations(repo.dbHandle);
    const clock = new FakeClock(nowMs);
    const service = new WatchProcessingServiceImpl({ repo, clock });
    const sourceId = randomUUID();
    const fingerprint = 'a'.repeat(64);
    const rule: WatchRule = {
      id: randomUUID(),
      version: 1,
      sourceId,
      kind: 'page',
      state: 'enabled',
      pauseReason: null,
      desiredEnabled: true,
      muted: true,
      accessMode: 'public',
      schedule: { kind: 'interval', intervalMinutes: 60 },
      target: {
        type: 'page',
        pageUrl: 'https://example.com/',
        regions: [{ kind: 'main-text', label: '主文档正文' }],
        sessionConsent: null,
      },
      condition: null,
      notificationLevel: 'normal',
      showDetails: false,
      sourceRowVersion: 1,
      sourceLocatorFingerprint: fingerprint,
      nextDueAt: null,
      lastConsumedScheduledFor: null,
      lastDailyLocalDate: null,
      consecutiveFailures: 0,
      backoffUntil: null,
      baselineVersion: 0,
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    };
    const source: SourceWatchProjection = {
      sourceId,
      rowVersion: 1,
      enabled: true,
      deletedAt: null,
      scope: 'page',
      canonicalKey: 'https://example.com/',
    };
    const value = { type: 'page' as const, fields: [] };
    const projectionJson = JSON.stringify(value);
    const projection: PageProjection = {
      schemaVersion: 1,
      ruleId: rule.id,
      sourceId,
      finalUrl: 'https://example.com/',
      capturedAt: new Date(nowMs).toISOString(),
      documentId: null,
      contentHash: sha256Hex(projectionJson),
      byteLength: Buffer.byteLength(projectionJson, 'utf8'),
      value,
    };
    const metadata = {
      httpStatus: 200 as const,
      etag: '"example-etag"',
      lastModified: null,
      warnings: [],
    };

    expect(repo.insertRule(rule)).toEqual({ ok: true });
    const firstPrepared = service.prepareAcquisition({ rule });
    expect(firstPrepared.ok).toBe(true);
    if (!firstPrepared.ok) return;
    const firstRunId = randomUUID();
    expect(
      repo.insertRun({
        id: firstRunId,
        ruleId: rule.id,
        requestKey: 'h3a-page-first',
        trigger: 'manual',
        scheduledFor: null,
      }),
    ).toEqual({ ok: true });
    expect(
      repo.transitionRun(firstRunId, 'queued', {
        status: 'running',
        startedAt: new Date(nowMs).toISOString(),
      }),
    ).toEqual({ ok: true });
    const first = service.process({
      rule,
      runId: firstRunId,
      baselineHint: firstPrepared.baselineHint,
      acquisition: {
        ok: true,
        kind: 'projection',
        projection,
        expectedSourceLocatorFingerprint: fingerprint,
        responseMetadata: metadata,
      },
      sourceAfterAcquisition: source,
    });
    expect(first.ok).toBe(true);
    expect(repo.getBaseline(rule.id)?.conditionalEtag).toBeNull();

    const freshRule = repo.getRule(rule.id)!;
    const secondPrepared = service.prepareAcquisition({ rule: freshRule });
    expect(secondPrepared.ok).toBe(true);
    if (!secondPrepared.ok) return;
    const secondRunId = randomUUID();
    expect(
      repo.insertRun({
        id: secondRunId,
        ruleId: rule.id,
        requestKey: 'h3a-page-second',
        trigger: 'manual',
        scheduledFor: null,
      }),
    ).toEqual({ ok: true });
    expect(
      repo.transitionRun(secondRunId, 'queued', {
        status: 'running',
        startedAt: new Date(nowMs).toISOString(),
      }),
    ).toEqual({ ok: true });
    const second = service.process({
      rule: freshRule,
      runId: secondRunId,
      baselineHint: secondPrepared.baselineHint,
      acquisition: {
        ok: true,
        kind: 'projection',
        projection,
        expectedSourceLocatorFingerprint: fingerprint,
        responseMetadata: metadata,
      },
      sourceAfterAcquisition: source,
    });

    expect(second).toEqual({ ok: true, outcome: { kind: 'unchanged' } });
    expect(repo.getRun(secondRunId)?.status).toBe('finished');
    expect(repo.getBaseline(rule.id)?.conditionalEtag).toBeNull();
    expect(repo.getBaseline(rule.id)?.version).toBe(1);
    expect(repo.listEventsByRule(rule.id)).toEqual([]);
  } finally {
    repo.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
