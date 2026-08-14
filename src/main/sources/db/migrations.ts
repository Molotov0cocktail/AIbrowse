// Fourth Stage B1: migration engine skeleton — schema version via PRAGMA user_version,
// monotonic stepwise migrations (each step in a single transaction), rollback on any
// failure, unknown-newer-version detection (readonly recovery assembly belongs to B7).
// Business schema arrives in B2 (MIGRATIONS stays empty until then); schema changes may
// only append new versions. All step statements must be compile-time constants; the
// PRAGMA user_version value comes from the validated constant migration list only
// (PRAGMA does not support bound parameters — verified 2026-08-15 on SQLite 3.53.1).
import { withTransaction, type DbHandle } from './sqlite-driver';

export interface MigrationStep {
  version: number; // 目标 user_version（单调逐级：1..N 连续）
  statements: readonly string[]; // 本步编译期常量 SQL（不得含事务控制语句——引擎负责事务）
}

// schema v1（B2，详细设计 §5 + 决议 #49/#51/#53/#54/#55 校准）：本步语句定稿后
// 不得改写——schema 变更只能追加后续版本。所有语句均为编译期常量；任何用户/网页/
// 模型文本只能经 Repository prepared statement 参数绑定进入。
// - 决议 #49：UNIQUE(scope, canonical_key) 复合唯一（origin/page 键空间独立）；
// - 决议 #51：enabled/deleted_at 联动软删（不变量 enabled=0 ⟺ deleted_at≠NULL）；
// - 决议 #53：change_journal 部分唯一索引 (run_id, tool_call_id) WHERE agent 行
//   + request_fingerprint/result_payload 列（幂等重放）；
// - 决议 #54：sources_fts 外部内容表（B2 最小写同步，查询构造归 B3）；
// - 决议 #55：source_ids 存 JSON 数组字符串、payload 为 {sourceId: 快照} 映射。
export const MIGRATION_V1: MigrationStep = {
  version: 1,
  statements: [
    `CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('origin','page')),
  canonical_key TEXT NOT NULL,
  url TEXT NOT NULL,
  name TEXT NOT NULL,
  group_id TEXT REFERENCES source_groups(id),
  priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  enabled INTEGER NOT NULL DEFAULT 1,
  share_mode TEXT NOT NULL DEFAULT 'metadata' CHECK (share_mode IN ('full','metadata','blocked')),
  trust_value TEXT NOT NULL DEFAULT 'unknown',
  trust_asserted_by TEXT NOT NULL DEFAULT 'user',
  trust_verification TEXT NOT NULL DEFAULT 'unverified',
  user_note TEXT NOT NULL DEFAULT '',
  ai_note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','ai')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  last_used_at TEXT,
  last_usage_outcome TEXT
)`,
    'CREATE UNIQUE INDEX idx_sources_scope_key ON sources(scope, canonical_key)',
    'CREATE INDEX idx_sources_group ON sources(group_id) WHERE deleted_at IS NULL',
    'CREATE INDEX idx_sources_enabled ON sources(enabled) WHERE deleted_at IS NULL',
    `CREATE TABLE source_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL,
  deleted_at TEXT
)`,
    `CREATE TABLE source_tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
)`,
    `CREATE TABLE source_tag_links (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES source_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, tag_id)
) WITHOUT ROWID`,
    `CREATE TABLE change_journal (
  idempotency_key TEXT PRIMARY KEY,
  run_id TEXT,
  tool_call_id TEXT,
  change_type TEXT NOT NULL CHECK (change_type IN ('agent-change-set','manual')),
  before_payload TEXT NOT NULL,
  after_payload TEXT NOT NULL,
  source_ids TEXT NOT NULL,
  request_fingerprint TEXT,
  result_payload TEXT,
  applied_at TEXT NOT NULL
)`,
    `CREATE UNIQUE INDEX idx_change_journal_run_tool ON change_journal(run_id, tool_call_id)
  WHERE change_type = 'agent-change-set'`,
    `CREATE TABLE usage_events (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('unknown','reachable','unreachable','auth-required','blocked')),
  recorded_at TEXT NOT NULL
)`,
    `CREATE VIRTUAL TABLE sources_fts USING fts5(name, url, user_note, ai_note, content='sources', content_rowid='rowid', tokenize='trigram')`,
  ],
};

export const MIGRATIONS: readonly MigrationStep[] = [MIGRATION_V1];

export interface MigrationListValidation {
  ok: boolean;
  reason: string | null; // 失败时的中文原因
}

export function validateMigrationList(steps: readonly MigrationStep[]): MigrationListValidation {
  // 空列表合法（v0 骨架）；版本必须为 1..N 逐级连续——覆盖重复/乱序/缺级/非法值
  for (let i = 0; i < steps.length; i += 1) {
    const expected = i + 1;
    const version = steps[i]!.version;
    if (!Number.isInteger(version) || version <= 0) {
      return {
        ok: false,
        reason: `迁移列表非法：版本必须为正整数（第 ${expected} 项为 ${String(version)}）`,
      };
    }
    if (version < expected) {
      return {
        ok: false,
        reason: `迁移列表非法：版本 ${version} 重复或乱序（第 ${expected} 项应为 ${expected}）`,
      };
    }
    if (version > expected) {
      return {
        ok: false,
        reason: `迁移列表非法：版本缺失第 ${expected} 级（第 ${expected} 项为 ${version}，必须逐级连续）`,
      };
    }
  }
  return { ok: true, reason: null };
}

export type MigrationState = 'up-to-date' | 'migrate' | 'newer-than-program';

export interface MigrationPlan {
  state: MigrationState;
  currentVersion: number;
  latestVersion: number;
  pendingSteps: readonly MigrationStep[];
}

export function planMigration(
  currentVersion: number,
  steps: readonly MigrationStep[],
): MigrationPlan {
  const validation = validateMigrationList(steps);
  if (!validation.ok) {
    // 程序错误（启动即发现），不静默
    throw new Error(`迁移列表校验失败：${validation.reason}`);
  }
  const latestVersion = steps.length === 0 ? 0 : steps[steps.length - 1]!.version;
  if (currentVersion > latestVersion) {
    // 未知更高版本：零写入，调用方（B7）装配 Sources 只读恢复态
    return { state: 'newer-than-program', currentVersion, latestVersion, pendingSteps: [] };
  }
  if (currentVersion === latestVersion) {
    return { state: 'up-to-date', currentVersion, latestVersion, pendingSteps: [] };
  }
  return {
    state: 'migrate',
    currentVersion,
    latestVersion,
    pendingSteps: steps.filter((s) => s.version > currentVersion),
  };
}

export interface MigrationOutcome {
  ok: boolean; // newer-than-program 时为 false（异常状态，调用方进入只读恢复态）
  state: 'migrated' | 'up-to-date' | 'newer-than-program';
  fromVersion: number;
  toVersion: number;
}

// 读取 PRAGMA user_version（迁移引擎专属运维查询）
export function readUserVersion(handle: DbHandle): number {
  const row = handle.prepare('PRAGMA user_version').get() as Record<string, unknown>;
  const version = row['user_version'];
  if (!Number.isInteger(version)) {
    throw new Error(`读取 user_version 失败：回读值非法（${String(version)}）`);
  }
  return version as number;
}

export function runMigrations(
  handle: DbHandle,
  steps: readonly MigrationStep[] = MIGRATIONS,
): MigrationOutcome {
  const plan = planMigration(readUserVersion(handle), steps);
  if (plan.state === 'up-to-date') {
    return {
      ok: true,
      state: 'up-to-date',
      fromVersion: plan.currentVersion,
      toVersion: plan.currentVersion,
    };
  }
  if (plan.state === 'newer-than-program') {
    return {
      ok: false,
      state: 'newer-than-program',
      fromVersion: plan.currentVersion,
      toVersion: plan.latestVersion,
    };
  }
  for (const step of plan.pendingSteps) {
    try {
      withTransaction(handle, () => {
        for (const sql of step.statements) handle.exec(sql);
        // PRAGMA 不支持参数绑定：版本号来自校验后的编译期常量迁移列表（整数）
        handle.exec(`PRAGMA user_version = ${step.version}`);
      });
    } catch (err) {
      // withTransaction 已整体回滚；中文包装重抛，原库保留
      throw new Error(`迁移到版本 ${step.version} 失败（已回滚，原库保留）：${String(err)}`, {
        cause: err,
      });
    }
  }
  return {
    ok: true,
    state: 'migrated',
    fromVersion: plan.currentVersion,
    toVersion: plan.latestVersion,
  };
}
