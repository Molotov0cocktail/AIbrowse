import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { WatchRepository } from '../../../src/main/watch/repository/watch-repository';
import { WatchQueryService } from '../../../src/main/watch/watch-query-service';
import { validateWatchIpcOutput } from '../../../src/shared/watch/watch-ipc-validator';
import { createSmallFixture, handle, marker, watchIds } from './seed';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-restore-fixture-ui-'));
it.each(['A', 'B', 'H'] as const)('固定%s经真实WatchRepository/Query可穿过UI输出门', (variant) => {
  const path = join(root, variant);
  createSmallFixture(path, variant);
  const db = new DatabaseSync(join(path, 'watch/watch.db'), { readOnly: true });
  try {
    const repo = new WatchRepository(handle(db));
    const query = new WatchQueryService(
      () => repo,
      () => ({ mode: 'stopped', activeCount: 0 }),
      () => ({ windowsNotification: 'available', windowsReason: null }),
      () => marker(variant),
    );
    const rules = query.listRules({
      page: 1,
      pageSize: 50,
      filter: { state: null, sourceId: null },
    });
    expect(rules?.items).toHaveLength(1);
    expect(rules?.items[0]?.sourceName).toBe(marker(variant));
    expect(validateWatchIpcOutput({ ok: true, value: rules }, 'watch:listRules')).toBe(true);
    expect(
      validateWatchIpcOutput(
        { ok: true, value: query.getRule(watchIds(variant).rule) },
        'watch:getRule',
      ),
    ).toBe(true);
    if (variant === 'H') {
      const events = query.listEvents({
        page: 1,
        pageSize: 50,
        filter: {
          ruleId: null,
          sourceId: null,
          eventKind: null,
          importance: null,
          readState: 'all',
          fromInclusive: null,
          toExclusive: null,
        },
        selectedEventId: watchIds('H').event,
      });
      expect(events?.items).toHaveLength(1);
      expect(validateWatchIpcOutput({ ok: true, value: events }, 'watch:listEvents')).toBe(true);
      expect(
        validateWatchIpcOutput(
          { ok: true, value: query.listDigestSchedules(1, 50) },
          'watch:listDigestSchedules',
        ),
      ).toBe(true);
      expect(
        validateWatchIpcOutput(
          { ok: true, value: query.listDigests(1, 50, null) },
          'watch:listDigests',
        ),
      ).toBe(true);
      expect(
        validateWatchIpcOutput(
          { ok: true, value: query.getDigest(watchIds('H').digest) },
          'watch:getDigest',
        ),
      ).toBe(true);
    }
  } finally {
    db.close();
  }
});
