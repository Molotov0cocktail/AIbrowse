// migrations engine unit tests (B1): validation matrix + runtime behavior on real
// node:sqlite temp databases (system Node). Test-only probe SQL is confined to this
// file (adjudication #47). Electron dev+production gate evidence comes from smoke B-01.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, openDb } from './sqlite-driver';
import {
  MIGRATIONS,
  planMigration,
  readUserVersion,
  runMigrations,
  validateMigrationList,
  type MigrationStep,
} from './migrations';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-migrations-'));

const step = (version: number, statements: string[]): MigrationStep => ({ version, statements });
const stepV1 = step(1, ['CREATE TABLE m1 (k TEXT)']);
const stepV2 = step(2, ['CREATE TABLE m2 (k TEXT)']);

describe('validateMigrationList — 列表校验矩阵', () => {
  it('空列表合法；程序列表恒合法（B2 起 MIGRATIONS 含 schema v1）', () => {
    expect(validateMigrationList([]).ok).toBe(true);
    expect(validateMigrationList(MIGRATIONS).ok).toBe(true);
  });

  it('版本重复 → 拒绝', () => {
    const r = validateMigrationList([stepV1, step(1, ['SELECT 1'])]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('重复');
  });

  it('乱序 → 拒绝', () => {
    const r = validateMigrationList([stepV2, stepV1]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('缺失');
  });

  it('缺级 → 拒绝', () => {
    const r = validateMigrationList([stepV1, step(3, ['SELECT 1'])]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('缺失第 2 级');
  });

  it('版本非正整数 → 拒绝', () => {
    const bad = validateMigrationList([step(0, ['SELECT 1'])]);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('正整数');
    expect(validateMigrationList([step(1.5, ['SELECT 1'])]).ok).toBe(false);
  });
});

describe('planMigration — 版本状态判定', () => {
  it('当前版本 == 程序版本 → up-to-date', () => {
    const plan = planMigration(0, []);
    expect(plan.state).toBe('up-to-date');
    expect(plan.latestVersion).toBe(0);
  });

  it('当前版本 < 程序版本 → migrate + 待执行步骤', () => {
    const plan = planMigration(0, [stepV1, stepV2]);
    expect(plan.state).toBe('migrate');
    expect(plan.pendingSteps.map((s) => s.version)).toEqual([1, 2]);
  });

  it('部分迁移：current 1 → 仅 v2 待执行', () => {
    const plan = planMigration(1, [stepV1, stepV2]);
    expect(plan.state).toBe('migrate');
    expect(plan.pendingSteps.map((s) => s.version)).toEqual([2]);
  });

  it('未知更高版本 → newer-than-program（零写入决策）', () => {
    const plan = planMigration(3, [stepV1]);
    expect(plan.state).toBe('newer-than-program');
    expect(plan.pendingSteps).toEqual([]);
  });

  it('非法列表传入 → 明确抛出（程序错误，不静默）', () => {
    expect(() => planMigration(0, [stepV1, stepV1])).toThrow(/迁移列表校验失败/);
  });
});

describe('runMigrations — 真实 node:sqlite 临时库行为', () => {
  it('空列表 → up-to-date（v0）', () => {
    const dbPath = join(root, 'empty.db');
    const h = openDb(dbPath);
    try {
      const out = runMigrations(h, []);
      expect(out.state).toBe('up-to-date');
      expect(out.ok).toBe(true);
      expect(readUserVersion(h)).toBe(0);
    } finally {
      closeDb(h);
    }
  });

  it('成功逐级迁移 → migrated 且 user_version=2、两表存在', () => {
    const dbPath = join(root, 'ok.db');
    const h = openDb(dbPath);
    try {
      const out = runMigrations(h, [stepV1, stepV2]);
      expect(out.state).toBe('migrated');
      expect(out.ok).toBe(true);
      expect(out.toVersion).toBe(2);
      expect(readUserVersion(h)).toBe(2);
      for (const name of ['m1', 'm2']) {
        const n = (
          h.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?').get(name) as {
            n: number;
          }
        ).n;
        expect(n).toBe(1);
      }
    } finally {
      closeDb(h);
    }
  });

  it('第 N 步失败 → 该步整体回滚，不留下部分状态（此前已提交步骤保留）', () => {
    const dbPath = join(root, 'fail.db');
    const h = openDb(dbPath);
    try {
      // 每级迁移单事务：第 2 步内含「建表 + 失败语句」——失败后第 2 步的建表也须
      // 回滚（零部分状态）；第 1 步已提交，保留（逐级迁移语义，不得回退已发布步骤）
      const steps = [
        stepV1,
        step(2, ['CREATE TABLE m2 (k TEXT)', 'INSERT INTO no_such_table VALUES (1)']),
      ];
      expect(() => runMigrations(h, steps)).toThrow(/迁移到版本 2 失败/);
      expect(readUserVersion(h)).toBe(1); // 版本停留在最后成功步骤
      const tableCount = (name: string): number =>
        (
          h.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?').get(name) as {
            n: number;
          }
        ).n;
      expect(tableCount('m1')).toBe(1); // 第 1 步已提交，保留
      expect(tableCount('m2')).toBe(0); // 第 2 步整体回滚——零部分状态
      h.prepare('SELECT 1').get(); // 连接仍可诊断
    } finally {
      closeDb(h);
    }
  });

  it('未知更高版本 → newer-than-program 且零写入', () => {
    const dbPath = join(root, 'newer.db');
    const h = openDb(dbPath);
    try {
      h.exec('PRAGMA user_version = 3'); // 测试专用 SQL：模拟未来版本库
      const out = runMigrations(h, [stepV1]);
      expect(out.state).toBe('newer-than-program');
      expect(out.ok).toBe(false);
      expect(readUserVersion(h)).toBe(3); // 原样保留
      const m1 = (
        h.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'm1'").get() as {
          n: number;
        }
      ).n;
      expect(m1).toBe(0); // 零写入
    } finally {
      closeDb(h);
    }
  });

  it('部分迁移续跑：current 1 → 仅应用 v2', () => {
    const dbPath = join(root, 'partial.db');
    const h = openDb(dbPath);
    try {
      runMigrations(h, [stepV1]); // 先迁移到 v1
      closeDb(h);
      const h2 = openDb(dbPath);
      try {
        const out = runMigrations(h2, [stepV1, stepV2]);
        expect(out.state).toBe('migrated');
        expect(out.fromVersion).toBe(1);
        expect(out.toVersion).toBe(2);
        expect(readUserVersion(h2)).toBe(2);
      } finally {
        closeDb(h2);
      }
    } finally {
      // h 已在上面关闭；此处兜底（重复关闭幂等）
      if (h.isOpen) closeDb(h);
    }
  });
});

// ---------------------------------------------------------------------------
// schema v1 契约断言（B2，决议 #49/#51/#53/#54/#55）：语句恒等 + 约束真实生效。
// 探针 SQL 仅限本测试文件（决议 #47：测试专用 SQL 仅允许 *.test.ts 与冒烟 B-01）。
// ---------------------------------------------------------------------------
describe('schema v1 契约（B2 红→绿：旧 MIGRATIONS 空列表下本组以真实断言失败）', () => {
  const v1Statements = (): string[] => {
    if (MIGRATIONS.length !== 1 || MIGRATIONS[0]!.version !== 1) {
      throw new Error(
        `schema v1 未定义：期望 MIGRATIONS 恰含 1 级 v1（实际 ${MIGRATIONS.length} 级）`,
      );
    }
    return [...MIGRATIONS[0]!.statements];
  };

  it('MIGRATIONS 恰含 v1（version 1，语句非空）', () => {
    expect(MIGRATIONS.length).toBe(1);
    expect(MIGRATIONS[0]!.version).toBe(1);
    expect(MIGRATIONS[0]!.statements.length).toBeGreaterThan(0);
  });

  it('复合唯一约束语句恒等（决议 #49：UNIQUE(scope, canonical_key)）', () => {
    expect(v1Statements()).toContain(
      'CREATE UNIQUE INDEX idx_sources_scope_key ON sources(scope, canonical_key)',
    );
  });

  it('负向：不存在单列 canonical_key UNIQUE（决议 #49 取代原 §5 单列约束）', () => {
    expect(v1Statements().some((s) => /canonical_key TEXT NOT NULL UNIQUE/.test(s))).toBe(false);
  });

  it('部分唯一索引语句恒等（决议 #53：(run_id, tool_call_id) WHERE agent 行）', () => {
    const idx = v1Statements().find((s) =>
      s.startsWith('CREATE UNIQUE INDEX idx_change_journal_run_tool'),
    );
    expect(idx).toBeDefined();
    expect(idx).toContain("WHERE change_type = 'agent-change-set'");
  });

  it('journal 指纹/结果列存在（决议 #53）', () => {
    const journal = v1Statements().find((s) => s.startsWith('CREATE TABLE change_journal'));
    expect(journal).toBeDefined();
    expect(journal).toContain('request_fingerprint TEXT');
    expect(journal).toContain('result_payload TEXT');
  });

  it('FTS 虚拟表语句恒等（决议 #54：trigram + 外部内容 + rowid 映射）', () => {
    expect(v1Statements()).toContain(
      "CREATE VIRTUAL TABLE sources_fts USING fts5(name, url, user_note, ai_note, content='sources', content_rowid='rowid', tokenize='trigram')",
    );
  });

  it('v0→v1 全表创建 + user_version=1', () => {
    const dbPath = join(root, 'v1.db');
    const h = openDb(dbPath);
    try {
      const out = runMigrations(h);
      expect(out.state).toBe('migrated');
      expect(out.toVersion).toBe(1);
      expect(readUserVersion(h)).toBe(1);
      for (const name of [
        'sources',
        'source_groups',
        'source_tags',
        'source_tag_links',
        'change_journal',
        'usage_events',
        'sources_fts',
      ]) {
        const n = (
          h.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?').get(name) as {
            n: number;
          }
        ).n;
        expect(n, `表 ${name} 应存在`).toBe(1);
      }
    } finally {
      closeDb(h);
    }
  });

  it('重开不重复迁移（user_version=1 → up-to-date）', () => {
    const dbPath = join(root, 'v1-reopen.db');
    const h = openDb(dbPath);
    try {
      expect(runMigrations(h).state).toBe('migrated');
      closeDb(h);
      const h2 = openDb(dbPath);
      try {
        const out = runMigrations(h2);
        expect(out.state).toBe('up-to-date');
        expect(readUserVersion(h2)).toBe(1);
      } finally {
        closeDb(h2);
      }
    } finally {
      if (h.isOpen) closeDb(h);
    }
  });

  it('未知更高版本（user_version=2）→ newer-than-program 零写入', () => {
    const dbPath = join(root, 'v1-newer.db');
    const h = openDb(dbPath);
    try {
      h.exec('PRAGMA user_version = 2'); // 测试专用：模拟未来版本库
      const out = runMigrations(h);
      expect(out.state).toBe('newer-than-program');
      expect(out.ok).toBe(false);
      const n = (
        h.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sources'").get() as {
          n: number;
        }
      ).n;
      expect(n).toBe(0);
    } finally {
      closeDb(h);
    }
  });

  it('CHECK 约束真实生效（scope/priority/share_mode/change_type）', () => {
    const dbPath = join(root, 'v1-check.db');
    const h = openDb(dbPath);
    try {
      runMigrations(h);
      const base = {
        id: 'c-1',
        scope: 'origin',
        canonical_key: 'https://example.com',
        url: 'https://example.com',
        name: 'n',
        created_at: '2026-08-15T00:00:00.000Z',
        updated_at: '2026-08-15T00:00:00.000Z',
      };
      const runInsert = (over: Record<string, unknown>): void => {
        const values = { ...base, ...over };
        const cols = Object.keys(values);
        h.prepare(
          `INSERT INTO sources (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        ).run(...Object.values(values));
      };
      expect(() => runInsert({ scope: 'site' })).toThrow();
      expect(() => runInsert({ priority: 9 })).toThrow();
      expect(() => runInsert({ share_mode: 'secret' })).toThrow();
      expect(() => runInsert({ created_by: 'model' })).toThrow();
      expect(() =>
        h
          .prepare(
            "INSERT INTO change_journal (idempotency_key, change_type, before_payload, after_payload, source_ids, applied_at) VALUES ('k1','weird','{}','{}','[]','2026-08-15')",
          )
          .run(),
      ).toThrow(); // change_type 枚举 CHECK（'weird' 非法）
    } finally {
      closeDb(h);
    }
  });

  it('FK 约束真实生效（group_id 与 tag_links 引用）', () => {
    const dbPath = join(root, 'v1-fk.db');
    const h = openDb(dbPath);
    try {
      runMigrations(h);
      const insert = h.prepare(
        `INSERT INTO sources (id, scope, canonical_key, url, name, group_id, created_at, updated_at)
         VALUES (?, 'origin', ?, ?, 'n', ?, ?, ?)`,
      );
      expect(() =>
        insert.run('fk-1', 'https://example.com', 'https://example.com', 'no-such-group', 't', 't'),
      ).toThrow(); // group_id 不存在 → FK 拦截（PRAGMA foreign_keys=ON）
      expect(() =>
        h
          .prepare(
            "INSERT INTO source_tag_links (source_id, tag_id) VALUES ('no-such-source', 'no-such-tag')",
          )
          .run(),
      ).toThrow(); // 两列 FK 均拦截
    } finally {
      closeDb(h);
    }
  });

  it('复合 UNIQUE 真实生效（同 (scope, canonical_key) 双写 → 第二写失败）', () => {
    const dbPath = join(root, 'v1-unique.db');
    const h = openDb(dbPath);
    try {
      runMigrations(h);
      const insert = h.prepare(
        `INSERT INTO sources (id, scope, canonical_key, url, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'n', 't', 't')`,
      );
      insert.run('u-1', 'page', 'https://example.com/p', 'https://example.com/p');
      expect(() =>
        insert.run('u-2', 'page', 'https://example.com/p', 'https://example.com/p'),
      ).toThrow();
      // 键空间独立：同 canonical_key 不同 scope 合法（决议 #49）
      expect(() =>
        insert.run('u-3', 'origin', 'https://example.com/p', 'https://example.com/p'),
      ).not.toThrow();
    } finally {
      closeDb(h);
    }
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
