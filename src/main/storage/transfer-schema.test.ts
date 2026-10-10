import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { readHistoricalSteps } from '../../../tools/data-qualification/history';
import { MIGRATIONS } from '../sources/db/migrations';
import { RESEARCH_MIGRATIONS } from '../research/db/research-migrations';
import { WATCH_MIGRATIONS } from '../watch/db/watch-migrations';
import { validateWatchTransferDatabase } from '../watch/repository/watch-transfer-validation';
import {
  validateTransferSchema,
  historicalWatchMigrationSteps,
  normalizeTransferSchema,
} from './transfer-schema';

function fixture(domain: 'sources' | 'research' | 'watch', version: number, historical = false) {
  const db = new DatabaseSync(':memory:');
  const steps =
    domain === 'sources'
      ? MIGRATIONS
      : domain === 'research'
        ? RESEARCH_MIGRATIONS
        : historical
          ? historicalWatchMigrationSteps()
          : WATCH_MIGRATIONS;
  for (const step of steps) {
    if (step.version > version) break;
    for (const sql of step.statements) db.exec(sql);
    db.exec(`PRAGMA user_version = ${step.version}`);
  }
  return db;
}

describe('固定数据库schema白名单', () => {
  it('只在调用方提供的staging逐级迁移，全部已知前缀规范为当前schema', () => {
    for (const [domain, latest] of [
      ['sources', 1],
      ['research', 1],
      ['watch', 5],
    ] as const) {
      for (let version = 0; version <= latest; version++) {
        const db = fixture(domain, version);
        try {
          expect(normalizeTransferSchema(db, domain)).toMatchObject({
            ok: true,
            fromVersion: version,
            version: latest,
          });
          expect(validateTransferSchema(db, domain)).toEqual({
            ok: true,
            version: latest,
            variant: 'current',
          });
        } finally {
          db.close();
        }
      }
    }
  });

  it('历史同版本定义重建保留全部列，坏值导致整个规范化事务回滚', () => {
    for (const bad of [false, true]) {
      const db = fixture('watch', 5, true);
      try {
        db.prepare(
          `INSERT INTO watch_rules (id,source_id,kind,state,desired_enabled,muted,access_mode,
          schedule_json,target_json,notification_level,source_locator_fingerprint,baseline_version,created_at,updated_at)
          VALUES ('r','s','page','enabled',1,0,'public',?,?,'normal',?,1,?,?)`,
        ).run(
          JSON.stringify({ kind: 'interval', intervalMinutes: 60 }),
          JSON.stringify({
            type: 'page',
            pageUrl: 'https://example.com/',
            regions: [{ kind: 'main-text', label: '正文' }],
            sessionConsent: null,
          }),
          'a'.repeat(64),
          '2026-10-04T00:00:00.000Z',
          '2026-10-04T00:00:00.000Z',
        );
        const projection = '{"type":"page","fields":[]}';
        db.prepare(
          `INSERT INTO watch_baselines VALUES ('r',1,'page',?,?,?,'https://example.com/',?,NULL,?,NULL)`,
        ).run(
          projection,
          createHash('sha256').update(projection).digest('hex'),
          Buffer.byteLength(projection),
          '2026-10-04T00:00:00.000Z',
          bad ? 'invalid-for-page' : null,
        );
        const before = db.prepare('SELECT * FROM watch_baselines').all();
        expect(normalizeTransferSchema(db, 'watch').ok).toBe(!bad);
        expect(db.prepare('SELECT * FROM watch_baselines').all()).toEqual(before);
        expect(validateTransferSchema(db, 'watch')).toEqual({
          ok: true,
          version: 5,
          variant: bad ? 'historical-watch-v3' : 'current',
        });
        if (!bad) expect(validateWatchTransferDatabase(db).ok).toBe(true);
      } finally {
        db.close();
      }
    }
  });

  it('全部真实历史v3后续版本显式规范化后仍通过业务扫描', () => {
    for (const version of [3, 4, 5]) {
      const db = fixture('watch', version, true);
      try {
        expect(normalizeTransferSchema(db, 'watch')).toEqual({
          ok: true,
          fromVersion: version,
          fromVariant: 'historical-watch-v3',
          version: 5,
        });
        expect(validateTransferSchema(db, 'watch')).toEqual({
          ok: true,
          variant: 'current',
          version: 5,
        });
        expect(validateWatchTransferDatabase(db).ok).toBe(true);
      } finally {
        db.close();
      }
    }
  });

  it('迁移失败只回滚当前步骤，明确报告已经提交的前置版本', () => {
    const db = fixture('watch', 2);
    const exec = db.exec.bind(db);
    const spy = vi.spyOn(db, 'exec').mockImplementation((sql) => {
      if (sql === 'PRAGMA user_version = 4') throw new Error('合成持久化失败');
      return exec(sql);
    });
    try {
      expect(normalizeTransferSchema(db, 'watch')).toMatchObject({
        ok: false,
        code: 'migration-failed',
        version: 3,
      });
      expect(validateTransferSchema(db, 'watch')).toEqual({
        ok: true,
        version: 3,
        variant: 'current',
      });
    } finally {
      spy.mockRestore();
      db.close();
    }
  });

  it('未知schema零写入；不能回滚调用方已有事务', () => {
    const db = fixture('watch', 2);
    try {
      db.exec('CREATE TABLE unexpected (x TEXT)');
      const writer = vi.spyOn(db, 'exec');
      expect(normalizeTransferSchema(db, 'watch')).toMatchObject({
        ok: false,
        code: 'schema-mismatch',
      });
      expect(writer).not.toHaveBeenCalled();
      writer.mockRestore();
      db.exec('DROP TABLE unexpected');
      db.exec('BEGIN');
      expect(normalizeTransferSchema(db, 'watch').ok).toBe(false);
      expect(() => db.exec('ROLLBACK')).not.toThrow();
    } finally {
      db.close();
    }
  });
  it('全部正式迁移前缀含FTS隐藏表按真实定义通过', () => {
    for (const [domain, latest] of [
      ['sources', 1],
      ['research', 1],
      ['watch', 5],
    ] as const) {
      for (let version = 0; version <= latest; version++) {
        const db = fixture(domain, version);
        try {
          expect(validateTransferSchema(db, domain)).toMatchObject({
            ok: true,
            version,
            variant: 'current',
          });
        } finally {
          db.close();
        }
      }
    }
  });

  it('真实历史v3定义及其既有v4/v5升级结果明确识别，不能按user_version误拒或误信', () => {
    const actualHistory = readHistoricalSteps(
      process.cwd(),
      '7e17d381d37ce5ee10512a3f9330dbc3a945b54e',
      'watch',
    ).steps;
    expect(historicalWatchMigrationSteps().slice(0, 3)).toEqual(actualHistory);
    for (const version of [3, 4, 5]) {
      const db = fixture('watch', version, true);
      try {
        expect(validateTransferSchema(db, 'watch')).toEqual({
          ok: true,
          version,
          variant: 'historical-watch-v3',
        });
      } finally {
        db.close();
      }
    }
  });

  it('未知表/索引/触发器/视图、定义漂移与未来版本均拒绝且无执行', () => {
    for (const sql of [
      'CREATE TABLE extra (value TEXT)',
      'CREATE INDEX extra ON research_tasks(goal)',
      'CREATE VIEW extra AS SELECT load_extension(goal) FROM research_tasks',
      'CREATE TRIGGER extra AFTER INSERT ON research_tasks BEGIN DELETE FROM research_results; END',
      'DROP INDEX idx_research_tasks_status',
      'PRAGMA user_version = 99',
    ]) {
      const db = fixture('research', 1);
      try {
        db.exec(sql);
        const before = db
          .prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name')
          .all();
        expect(validateTransferSchema(db, 'research').ok).toBe(false);
        expect(
          db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
        ).toEqual(before);
      } finally {
        db.close();
      }
    }
  });

  it('同名同列但少约束不能通过', () => {
    const db = fixture('sources', 0);
    try {
      db.exec('CREATE TABLE sources (id TEXT PRIMARY KEY)');
      db.exec('PRAGMA user_version = 1');
      expect(validateTransferSchema(db, 'sources')).toEqual({ ok: false, code: 'schema-mismatch' });
    } finally {
      db.close();
    }
  });

  it('超长敌手定义在长度探测处拒绝，不读取SQL正文', () => {
    const db = fixture('sources', 0);
    try {
      db.exec(`CREATE TABLE x (data TEXT /*${'a'.repeat(10000)}*/) `);
      db.exec('PRAGMA user_version = 1');
      const prepared = vi.spyOn(db, 'prepare');
      expect(validateTransferSchema(db, 'sources')).toEqual({ ok: false, code: 'schema-mismatch' });
      expect(prepared).not.toHaveBeenCalledWith(
        'SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE rowid = ?',
      );
    } finally {
      db.close();
    }
  });
});
