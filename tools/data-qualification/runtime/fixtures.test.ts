import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RESEARCH_MIGRATIONS } from '../../../src/main/research/db/research-migrations';
import { WATCH_MIGRATIONS } from '../../../src/main/watch/db/watch-migrations';
import { MIGRATIONS } from '../../../src/main/sources/db/migrations';
import {
  normalizeAndVerifySourceIndex,
  validateSourceTransfer,
} from '../../../src/main/sources/repository/source-transfer-validation';
import { normalizeTransferSchema } from '../../../src/main/storage/transfer-schema';
import { openPrivateStagingDatabase } from '../../../src/main/storage/staging-sqlite';
import { SourceServiceImpl } from '../../../src/main/sources/source-service';
import { sourceInput, STAMP } from '../fixtures';
import { validateResearchTransfer } from '../../../src/main/research/repository/research-transfer-validation';
import { validateWatchTransferDatabase } from '../../../src/main/watch/repository/watch-transfer-validation';
import { seedResearch, seedWatch, seedSources } from './fixtures';

describe('实际容量夹具的最小同形资格', () => {
  it('正式私有 staging 配置可执行三库语义扫描及 Sources FTS 重建', () => {
    const root = mkdtempSync(join(tmpdir(), 'aibrowse-runtime-staging-'));
    try {
      for (const domain of ['sources', 'research', 'watch'] as const) {
        const file = join(root, `${domain}.db`);
        const original = new DatabaseSync(file);
        try {
          const migrations =
            domain === 'sources'
              ? MIGRATIONS
              : domain === 'research'
                ? RESEARCH_MIGRATIONS
                : WATCH_MIGRATIONS;
          for (const step of migrations) for (const sql of step.statements) original.exec(sql);
          if (domain === 'sources') {
            original.exec('PRAGMA user_version = 1');
            seedSources(original, 1);
          } else if (domain === 'research') {
            original.exec('PRAGMA user_version = 1');
            seedResearch(original, 1);
          } else {
            original.exec('PRAGMA user_version = 5');
            seedWatch(original, 1, 1);
          }
        } finally {
          original.close();
        }
        const opened = openPrivateStagingDatabase(file, domain);
        try {
          expect(normalizeTransferSchema(opened.db, domain)).toMatchObject({ ok: true });
          if (domain === 'sources') {
            expect(validateSourceTransfer(opened.db)).toMatchObject({ ok: true });
            expect(normalizeAndVerifySourceIndex(opened.db)).toMatchObject({ ok: true });
          } else if (domain === 'research') {
            expect(validateResearchTransfer(opened.db)).toMatchObject({ ok: true });
          } else {
            expect(validateWatchTransferDatabase(opened.db)).toMatchObject({ ok: true });
          }
        } finally {
          opened.db.close();
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('Sources 最大字段合成数据与实际 Service 写入的 provenance 一致', async () => {
    const db = new DatabaseSync(':memory:');
    let service: SourceServiceImpl | null = null;
    try {
      for (const step of MIGRATIONS) for (const sql of step.statements) db.exec(sql);
      seedSources(db, 1);
      expect(validateSourceTransfer(db)).toMatchObject({ ok: true });
      service = new SourceServiceImpl({
        db: {
          path: ':memory:',
          get isOpen() {
            return db.isOpen;
          },
          prepare: (sql) => db.prepare(sql),
          exec: (sql) => db.exec(sql),
          close: () => db.close(),
        },
        now: () => Date.parse(STAMP),
      });
      const input = sourceInput(1);
      const result = await service.addManual(input);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('实际 SourceService 最大字段写入失败');
      const actual = db.prepare('SELECT * FROM sources WHERE id=?').get(result.source.id);
      expect(actual).toMatchObject({
        trust_asserted_by: 'user',
        trust_verification: 'asserted',
        name: input.name,
        user_note: input.userNote,
        ai_note: input.aiNote,
        url: input.url,
      });
      expect(validateSourceTransfer(db)).toMatchObject({ ok: true });
      db.exec("UPDATE sources SET trust_verification='unverified' WHERE trust_asserted_by='user'");
      expect(validateSourceTransfer(db)).toMatchObject({ ok: false, table: 'sources' });
    } finally {
      if (service !== null) service.dispose();
      else db.close();
    }
  });
  it('Research 稠密结果保留正文并满足正式语义扫描', () => {
    const db = new DatabaseSync(':memory:');
    try {
      for (const step of RESEARCH_MIGRATIONS) for (const sql of step.statements) db.exec(sql);
      seedResearch(db, 1);
      expect(validateResearchTransfer(db)).toMatchObject({ ok: true });
      expect(
        db.prepare('SELECT length(blocks_json) AS size FROM research_results').get()?.size,
      ).toBeGreaterThan(160000);
      db.exec("UPDATE research_candidates SET sort_key='1'");
      expect(validateResearchTransfer(db)).toMatchObject({ ok: false });
    } finally {
      db.close();
    }
  });

  it('Watch 稠密正文与真实 journal/ref 一致，旧 cursor 反例仍拒绝', () => {
    const db = new DatabaseSync(':memory:');
    try {
      for (const step of WATCH_MIGRATIONS) for (const sql of step.statements) db.exec(sql);
      seedWatch(db, 1, 1);
      expect(validateWatchTransferDatabase(db)).toMatchObject({ ok: true });
      expect(
        db.prepare('SELECT length(before_value_json) AS size FROM watch_event_items').get()?.size,
      ).toBeGreaterThan(4096);
      db.exec('UPDATE digest_schedules SET cursor_sequence=0');
      expect(validateWatchTransferDatabase(db)).toMatchObject({ ok: false });
    } finally {
      db.close();
    }
  });
});
