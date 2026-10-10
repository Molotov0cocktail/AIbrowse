import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/main/sources/db/migrations';
import { WATCH_MIGRATIONS } from '../../src/main/watch/db/watch-migrations';
import { WatchRepository } from '../../src/main/watch/repository/watch-repository';
import { WatchLifecycleCoordinator } from '../../src/main/watch/watch-lifecycle-coordinator';
import { validateSourceTransfer } from '../../src/main/sources/repository/source-transfer-validation';
import { validateWatchTransferDatabase } from '../../src/main/watch/repository/watch-transfer-validation';
import { validateWatchSourceTransfer } from '../../src/main/watch/repository/watch-source-transfer-validation';
import { computeSourceLocatorFingerprint } from '../../src/shared/watch/watch-rule-state';

const root = join(process.cwd(), 'log/stage7-e2/independent-cross-review-001');
mkdirSync(root, { recursive: true });
const id = 'a0000000-0000-4000-8000-000000000001';
const now = '2026-10-04T00:00:00.000Z';

it.each(['missing', 'changed', 'disabled', 'user'] as const)(
  '实际生命周期协调后的%s状态可通过只读跨库扫描，原DB字节不变',
  (variant) => {
    const folder = mkdtempSync(join(root, 'case-'));
    const sourceFile = join(folder, 'sources.db');
    const watchFile = join(folder, 'watch.db');
    const source = new DatabaseSync(sourceFile);
    const watch = Object.assign(new DatabaseSync(watchFile), { path: watchFile });
    for (const migration of MIGRATIONS) for (const sql of migration.statements) source.exec(sql);
    for (const migration of WATCH_MIGRATIONS)
      for (const sql of migration.statements) watch.exec(sql);
    source
      .prepare(
        `INSERT INTO sources(id,scope,canonical_key,url,name,trust_verification,created_at,updated_at)
         VALUES(?,'page','https://example.test/','https://example.test/','合成信源','asserted',?,?)`,
      )
      .run(id, now, now);
    const fingerprint = computeSourceLocatorFingerprint({
      sourceId: id,
      scope: 'page',
      canonicalKey: 'https://example.test/',
      kind: 'feed',
      canonicalTargetUrl: 'https://example.test/rss',
    });
    watch
      .prepare(
        `INSERT INTO watch_rules(id,source_id,kind,state,desired_enabled,muted,access_mode,
         schedule_json,target_json,notification_level,source_locator_fingerprint,created_at,updated_at)
         VALUES('rule',?,'feed','enabled',1,0,'public',?,?,'normal',?,?,?)`,
      )
      .run(
        id,
        JSON.stringify({ kind: 'interval', intervalMinutes: 60 }),
        JSON.stringify({ type: 'feed', feedUrl: 'https://example.test/rss', format: 'rss2' }),
        fingerprint,
        now,
        now,
      );
    const repo = new WatchRepository(watch);
    const coordinator = new WatchLifecycleCoordinator({ nowMs: () => Date.parse(now) });
    try {
      if (variant === 'missing') source.exec('DELETE FROM sources');
      else if (variant === 'changed')
        source.exec(
          "UPDATE sources SET version=2,canonical_key='https://example.test/changed',url='https://example.test/changed'",
        );
      else if (variant === 'disabled')
        source.prepare('UPDATE sources SET version=2,enabled=0,deleted_at=?').run(now);
      else {
        source.exec("UPDATE sources SET version=2,share_mode='blocked'");
        watch.exec("UPDATE watch_rules SET state='paused',pause_reason='user',desired_enabled=0");
      }
      const result = coordinator.reconcileOnStartup(repo, () =>
        variant === 'missing'
          ? { status: 'missing' }
          : {
              status: 'found',
              projection: {
                sourceId: id,
                rowVersion: 2,
                enabled: variant !== 'disabled',
                deletedAt: variant === 'disabled' ? now : null,
                scope: 'page',
                canonicalKey:
                  variant === 'changed' ? 'https://example.test/changed' : 'https://example.test/',
              },
            },
      );
      expect(result.ok).toBe(true);
      expect(repo.getRule('rule')?.state).toBe('paused');
      expect(repo.getRule('rule')?.pauseReason).toBe(
        {
          missing: 'source-deleted',
          changed: 'source-changed',
          disabled: 'source-disabled',
          user: 'user',
        }[variant],
      );
      expect(validateSourceTransfer(source).ok).toBe(true);
      expect(validateWatchTransferDatabase(watch).ok).toBe(true);
    } finally {
      coordinator.dispose();
      repo.dispose();
      source.close();
    }
    const before = [sourceFile, watchFile].map((path) => readFileSync(path));
    const readonlySource = new DatabaseSync(sourceFile, { readOnly: true, allowExtension: false });
    const readonlyWatch = new DatabaseSync(watchFile, { readOnly: true, allowExtension: false });
    try {
      expect(validateWatchSourceTransfer(readonlySource, readonlyWatch).ok).toBe(true);
    } finally {
      readonlySource.close();
      readonlyWatch.close();
    }
    expect([sourceFile, watchFile].map((path) => readFileSync(path))).toEqual(before);
  },
);
