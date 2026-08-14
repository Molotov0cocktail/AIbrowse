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
  it('空列表合法（B1 骨架 v0；schema v1 随 B2 追加）', () => {
    expect(validateMigrationList([]).ok).toBe(true);
    expect(validateMigrationList(MIGRATIONS).ok).toBe(true); // B1 恒为空
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

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
