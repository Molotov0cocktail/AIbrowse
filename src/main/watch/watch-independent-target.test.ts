import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../sources/db/sqlite-driver';
import { runWatchMigrations } from './db/watch-migrations';
import { WatchRepository } from './repository/watch-repository';
import { WatchPreviewService } from './watch-preview-service';
import { WatchPreviewStore } from './watch-preview-store';
import { WatchCommandService } from './watch-command-service';
import type { WatchAcquisitionService } from './watch-acquisition-service';
import { projectPageProjection } from './page-projector';
import type { WatchRule } from '../../shared/types/watch';
import { WatchLifecycleCoordinator } from './watch-lifecycle-coordinator';
import { DatabaseSync } from 'node:sqlite';
import { validateWatchTransferDatabase } from './repository/watch-transfer-validation';
import { parseFeedXml } from './feed-parser';
import type { TargetGatedClient } from './public-watch-http-client';

describe('独立监控目标', () => {
  it('HTML发现候选保留独立身份，创建后重新建立Baseline读取已确认Feed URL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'watch-independent-feed-'));
    const handle = openDb(join(root, 'watch.db'));
    runWatchMigrations(handle);
    const repo = new WatchRepository(handle);
    try {
      const parsed = await parseFeedXml(
        Buffer.from(
          '<rss version="2.0"><channel><title>新闻</title><item><guid>1</guid><title>第一条</title></item></channel></rss>',
        ),
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const source = vi.fn(() => ({ status: 'missing' as const }));
      const requested: string[] = [];
      const store = new WatchPreviewStore();
      const service = new WatchPreviewService({
        store,
        source,
        repository: () => repo,
        acquisition: () =>
          ({
            run: async ({ rule }: { rule: WatchRule }) => {
              if (rule.target.type !== 'feed') throw new Error('fixture');
              requested.push(rule.target.feedUrl);
              if (rule.target.feedUrl.endsWith('/news'))
                return { ok: false, health: 'parse_changed', disposition: 'parse' };
              return {
                ok: true,
                kind: 'projection',
                projection: {
                  schemaVersion: 1,
                  ruleId: rule.id,
                  sourceId: rule.sourceId,
                  finalUrl: 'https://example.com/rss.xml',
                  capturedAt: new Date().toISOString(),
                  documentId: null,
                  value: parsed.value,
                  contentHash: createHash('sha256').update(parsed.canonicalJson).digest('hex'),
                  byteLength: parsed.byteLength,
                },
              };
            },
          }) as unknown as WatchAcquisitionService,
        discoveryTarget: () =>
          ({
            get: async () => ({
              kind: 'ok',
              meta: { finalUrl: 'https://example.com/news' },
              body: Buffer.from(
                '<html><head><link rel="alternate" type="application/rss+xml" href="/rss.xml"></head></html>',
              ),
            }),
          }) as unknown as TargetGatedClient,
        browser: () => null,
        reader: () => null,
        grants: () => null,
      });
      const discovery = await service.previewFeed({
        mode: 'standalone',
        url: 'https://example.com/news',
      });
      expect(discovery.ok).toBe(true);
      if (!discovery.ok) return;
      const candidates = discovery.value['candidates'] as Array<{ candidateId: string }>;
      const preview = await service.previewFeed({
        mode: 'candidate',
        discoveryHandle: String(discovery.value['discoveryHandle']),
        candidateId: candidates[0]!.candidateId,
      });
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      const command = new WatchCommandService(
        store,
        source,
        () => repo,
        () => null,
      );
      const common = {
        sessionGrantHandle: null,
        schedule: { kind: 'interval' as const, intervalMinutes: 60 as const },
        condition: null,
        notificationLevel: 'normal' as const,
        showDetails: false,
      };
      const created = command.create({
        ...common,
        previewHandle: String(preview.value['previewHandle']),
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const again = await service.previewFeed({ mode: 'rule', ruleId: created.value.ruleId });
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(
        command.rebaseline({
          ...common,
          previewHandle: String(again.value['previewHandle']),
          ruleId: created.value.ruleId,
          expectedVersion: 1,
          resumeAfterConfirm: true,
        }).ok,
      ).toBe(true);
      expect(requested).toEqual([
        'https://example.com/news',
        'https://example.com/rss.xml',
        'https://example.com/rss.xml',
      ]);
      expect(source).not.toHaveBeenCalled();
      expect(repo.getRule(created.value.ruleId)?.bindingKind).toBe('watch-target');
      expect(repo.scanIntegrity().ok).toBe(true);
    } finally {
      repo.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('直接URL预览与确认不访问Sources，目标与Baseline同事务保存', async () => {
    const root = mkdtempSync(join(tmpdir(), 'watch-independent-'));
    const handle = openDb(join(root, 'watch.db'));
    runWatchMigrations(handle);
    const repo = new WatchRepository(handle);
    try {
      const source = vi.fn(() => ({ status: 'missing' as const }));
      const store = new WatchPreviewStore();
      const preview = new WatchPreviewService({
        store,
        source,
        repository: () => repo,
        acquisition: () =>
          ({
            run: async ({ rule }: { rule: WatchRule }) => {
              const projection = projectPageProjection({
                channels: { mainText: '独立监控正文', headings: [], links: [], tables: [] },
                regions: [{ kind: 'main-text', label: '正文' }],
                ruleId: rule.id,
                sourceId: rule.sourceId,
                finalUrl: 'https://example.com/news',
                capturedAt: new Date().toISOString(),
                documentId: '1',
              });
              if (!projection.ok) throw new Error('夹具投影失败');
              return { ok: true, kind: 'projection', projection: projection.projection };
            },
          }) as unknown as WatchAcquisitionService,
        discoveryTarget: () => null,
        browser: () => null,
        reader: () => null,
        grants: () => null,
      } as ConstructorParameters<typeof WatchPreviewService>[0]);
      const result = await preview.previewPage({
        mode: 'standalone',
        url: 'https://example.com/news',
        accessMode: 'public',
        regions: [{ kind: 'main-text', label: '正文' }],
      } as never);
      expect(result.ok).toBe(true);
      expect(source).not.toHaveBeenCalled();
      expect(handle.prepare('SELECT COUNT(*) AS n FROM watch_targets').get()).toEqual({ n: 0 });
      if (!result.ok) return;
      const commands = new WatchCommandService(
        store,
        source,
        () => repo,
        () => null,
      );
      const created = commands.create({
        previewHandle: String(result.value['previewHandle']),
        sessionGrantHandle: null,
        schedule: { kind: 'interval', intervalMinutes: 60 },
        condition: null,
        notificationLevel: 'normal',
        showDetails: false,
      });
      expect(created.ok).toBe(true);
      expect(source).not.toHaveBeenCalled();
      if (!created.ok) return;
      const rule = repo.getRule(created.value.ruleId)!;
      expect(rule).toMatchObject({ bindingKind: 'watch-target', baselineVersion: 1 });
      expect(
        handle.prepare('SELECT ai_share_mode FROM watch_targets WHERE id=?').get(rule.sourceId),
      ).toEqual({ ai_share_mode: 'blocked' });
      expect(repo.listRulesBySource(rule.sourceId)).toEqual([]);
      expect(repo.cascadeDeleteRulesBySource(rule.sourceId)).toEqual({
        ok: true,
        deletedEvents: 0,
      });
      expect(repo.getRule(rule.id)).not.toBeNull();
      expect(repo.scanIntegrity()).toEqual({ ok: true, reason: null });
      const coordination = new WatchLifecycleCoordinator();
      coordination.bind(repo, source);
      expect(coordination.reconcileOnStartup(repo, source)).toEqual({ ok: true, reason: null });
      expect(coordination.revalidateRuleSource(rule.id).status).toBe('ok');
      expect(source).not.toHaveBeenCalled();
      const reader = new DatabaseSync(join(root, 'watch.db'), { readOnly: true });
      try {
        expect(validateWatchTransferDatabase(reader).ok).toBe(true);
        handle.prepare('UPDATE watch_targets SET version=2 WHERE id=?').run(rule.sourceId);
        expect(repo.scanIntegrity().ok).toBe(false);
        expect(validateWatchTransferDatabase(reader)).toMatchObject({
          ok: false,
          code: 'reference-invalid',
        });
        handle.prepare('UPDATE watch_targets SET version=1 WHERE id=?').run(rule.sourceId);
        handle.prepare("UPDATE watch_rules SET binding_kind='source' WHERE id=?").run(rule.id);
        expect(repo.scanIntegrity().ok).toBe(false);
        expect(validateWatchTransferDatabase(reader)).toMatchObject({
          ok: false,
          code: 'reference-invalid',
        });
        handle
          .prepare("UPDATE watch_rules SET binding_kind='watch-target' WHERE id=?")
          .run(rule.id);
      } finally {
        reader.close();
      }

      const newPreview = await preview.previewPage({
        mode: 'standalone',
        url: 'https://example.com/news',
        accessMode: 'public',
        regions: [{ kind: 'main-text', label: '正文' }],
      });
      expect(newPreview.ok).toBe(true);
      handle.exec(
        "CREATE TRIGGER fail_baseline BEFORE INSERT ON watch_baselines BEGIN SELECT RAISE(ABORT,'injected'); END",
      );
      if (newPreview.ok)
        expect(
          commands.create({
            previewHandle: String(newPreview.value['previewHandle']),
            sessionGrantHandle: null,
            schedule: { kind: 'interval', intervalMinutes: 60 },
            condition: null,
            notificationLevel: 'normal',
            showDetails: false,
          }).ok,
        ).toBe(false);
      expect(handle.prepare('SELECT COUNT(*) AS n FROM watch_targets').get()).toEqual({ n: 1 });
      expect(repo.listRules()).toHaveLength(1);
      handle.exec('DROP TRIGGER fail_baseline');

      const sourceRule: WatchRule = {
        ...rule,
        id: randomUUID(),
        bindingKind: 'source',
        baselineVersion: 0,
      };
      expect(repo.insertRule(sourceRule).ok).toBe(true);
      const when = '2026-10-12T01:00:00.000Z';
      for (const owner of [sourceRule, rule]) {
        expect(
          repo.writeEventTransaction({
            event: {
              id: randomUUID(),
              ruleId: owner.id,
              sourceId: owner.sourceId,
              eventKind: 'added',
              importance: 'normal',
              idempotencyKey: randomUUID(),
              changeFingerprint: 'a'.repeat(64),
              firstObservedAt: when,
              lastObservedAt: when,
              itemCount: 1,
              readAt: null,
            },
            items: [
              {
                itemId: 'item',
                fieldKey: 'main-text:0',
                label: '正文',
                before: { kind: 'absent' },
                after: {
                  kind: 'present',
                  excerpt: '变化',
                  valueHash: 'a'.repeat(64),
                  normalizedBytes: 6,
                  truncated: false,
                },
                beforeCapturedAt: when,
                afterCapturedAt: when,
                beforeFinalUrl: 'https://example.com/news',
                afterFinalUrl: 'https://example.com/news',
                beforeDocumentId: null,
                afterDocumentId: null,
                feedItemKey: null,
              },
            ],
            identity: {
              sourceId: owner.sourceId,
              expectedSourceLocatorFingerprint: owner.sourceLocatorFingerprint,
              expectedBaselineVersion: owner.baselineVersion === 0 ? null : owner.baselineVersion,
            },
          }).ok,
        ).toBe(true);
      }
      for (const owner of [sourceRule, rule]) {
        const slice = repo.readDigestPreviewSlice({
          sourceIds: [owner.sourceId],
          bindingKind: owner.bindingKind,
          afterSequence: 0,
          fromExclusive: '2026-10-12T00:00:00.000Z',
          toInclusive: '2026-10-12T02:00:00.000Z',
        });
        expect(
          slice?.rows.flatMap((row) => (row.observation === null ? [] : [row.observation.ruleId])),
        ).toEqual([owner.id]);
      }
      expect(repo.cascadeDeleteRulesBySource(rule.sourceId).ok).toBe(true);
      expect(repo.getRule(rule.id)).not.toBeNull();
      const sourceTombstones = repo.readDigestPreviewSlice({
        sourceIds: [rule.sourceId],
        bindingKind: 'source',
        afterSequence: 0,
        fromExclusive: '2026-10-12T00:00:00.000Z',
        toInclusive: '2026-10-12T02:00:00.000Z',
      });
      const targetEvents = repo.readDigestPreviewSlice({
        sourceIds: [rule.sourceId],
        bindingKind: 'watch-target',
        afterSequence: 0,
        fromExclusive: '2026-10-12T00:00:00.000Z',
        toInclusive: '2026-10-12T02:00:00.000Z',
      });
      expect(sourceTombstones?.rows.filter((row) => row.status === 'expired')).toHaveLength(1);
      expect(targetEvents?.rows.filter((row) => row.status === 'user-deleted')).toHaveLength(0);
      expect(
        targetEvents?.rows.flatMap((row) =>
          row.observation === null ? [] : [row.observation.ruleId],
        ),
      ).toEqual([rule.id]);
      expect(repo.deleteRuleExpectedVersion(rule.id, rule.version).ok).toBe(true);
      expect(repo.getIndependentTarget(rule.sourceId)).toBeNull();
      expect(handle.prepare('SELECT COUNT(*) AS n FROM watch_targets').get()).toEqual({ n: 0 });
      expect(
        handle
          .prepare('SELECT binding_kind,status FROM digest_change_journal ORDER BY sequence')
          .all(),
      ).toEqual([
        { binding_kind: 'source', status: 'expired' },
        { binding_kind: 'watch-target', status: 'user-deleted' },
      ]);
      const afterDeleteReader = new DatabaseSync(join(root, 'watch.db'), { readOnly: true });
      try {
        expect(validateWatchTransferDatabase(afterDeleteReader).ok).toBe(true);
      } finally {
        afterDeleteReader.close();
      }
    } finally {
      repo.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('v6独立目标表与显式绑定分隔Source同值ID', () => {
    const root = mkdtempSync(join(tmpdir(), 'watch-target-schema-'));
    const handle = openDb(join(root, 'watch.db'));
    try {
      runWatchMigrations(handle);
      expect(handle.prepare('PRAGMA user_version').get()).toEqual({ user_version: 6 });
      const id = randomUUID();
      handle
        .prepare(
          'INSERT INTO watch_targets(id,version,scope,canonical_url,display_name,ai_share_mode) VALUES(?,1,?,?,?,?)',
        )
        .run(id, 'page', 'https://example.com/news', 'example.com/news', 'blocked');
      expect(handle.prepare('SELECT id FROM watch_targets').get()).toEqual({ id });
    } finally {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
