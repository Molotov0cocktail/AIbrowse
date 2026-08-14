// Fourth Stage B2: SourceRepository — the single business-SQL execution point
// (detailed-design §3.1/§5, adjudications #47/#49/#51/#54). Every business
// statement is a compile-time constant with positional bound parameters; there is
// no dynamic SQL, no dynamic column/sort expressions, no user text in exec().
// All writes assume an already-open transaction owned by the caller (SourceService)
// so that sources + FTS + journal commit or roll back together; reads may run
// standalone. Unique violations are translated into typed RepositoryError codes.
import { randomUUID } from 'node:crypto';
import type { DbHandle } from '../db/sqlite-driver';
import type {
  Source,
  SourceGroup,
  SourceScope,
  SourceShareMode,
  SourceTrustValue,
  SourceUsageOutcome,
  SourceCreator,
  SourceTrustAssertedBy,
  SourceTrustVerification,
} from '../../../shared/types/sources';

export type RepositoryErrorCode =
  | 'duplicate-source'
  | 'duplicate-journal-key'
  | 'duplicate-journal-run-tool'
  | 'version-mismatch'
  | 'sqlite-error';

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;

  constructor(code: RepositoryErrorCode, message: string) {
    super(message);
    this.name = 'RepositoryError';
    this.code = code;
  }
}

export function translateSqliteError(err: unknown): RepositoryError {
  // SQLite 唯一冲突消息为「列名」形态（实测 SQLite 3.53.1：复合唯一索引报
  // UNIQUE constraint failed: t.a, t.b；部分唯一索引报其列；主键报表.主键列）
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('UNIQUE constraint failed: sources.scope, sources.canonical_key')) {
    return new RepositoryError('duplicate-source', '已存在相同规范化地址的条目（唯一约束拦截）');
  }
  if (
    message.includes('UNIQUE constraint failed: change_journal.run_id, change_journal.tool_call_id')
  ) {
    return new RepositoryError(
      'duplicate-journal-run-tool',
      '同 (run_id, tool_call_id) 的 journal 记录已存在',
    );
  }
  if (message.includes('UNIQUE constraint failed: change_journal.idempotency_key')) {
    return new RepositoryError('duplicate-journal-key', 'idempotency key 已存在');
  }
  return new RepositoryError('sqlite-error', `数据库错误：${message}`);
}

export interface SourceRow {
  id: string;
  scope: SourceScope;
  canonical_key: string;
  url: string;
  name: string;
  group_id: string | null;
  priority: number;
  enabled: number;
  share_mode: SourceShareMode;
  trust_value: SourceTrustValue;
  trust_asserted_by: SourceTrustAssertedBy;
  trust_verification: SourceTrustVerification;
  user_note: string;
  ai_note: string;
  created_by: SourceCreator;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  last_used_at: string | null;
  last_usage_outcome: SourceUsageOutcome | null;
}

export interface GroupRow {
  id: string;
  name: string;
  created_at: string;
  deleted_at: string | null;
}

export interface TagRow {
  id: string;
  name: string;
  created_at: string;
}

export interface SourceListFilter {
  limit: number;
  offset: number;
  groupId?: string | null; // undefined = 不过滤；null = 未分组；string = 该组
  enabledOnly?: boolean;
}

export type SourceInsert = SourceRow;

export interface SourceFieldValues {
  url: string;
  canonical_key: string;
  name: string;
  group_id: string | null;
  priority: number;
  share_mode: SourceShareMode;
  trust_value: SourceTrustValue;
  trust_asserted_by: SourceTrustAssertedBy;
  trust_verification: SourceTrustVerification;
  user_note: string;
  ai_note: string;
}

// --- 编译期 SQL 常量（全部参数绑定；无动态拼接） ---

const SQL_SELECT_SOURCE_BY_ID = 'SELECT * FROM sources WHERE id = ?';
const SQL_SELECT_SOURCE_BY_CANONICAL =
  'SELECT * FROM sources WHERE scope = ? AND canonical_key = ?';
const SQL_SELECT_SOURCE_ROWID = 'SELECT rowid FROM sources WHERE id = ?';
const SQL_SELECT_GROUP_BY_NAME = 'SELECT * FROM source_groups WHERE name = ?';
const SQL_SELECT_TAG_BY_NAME = 'SELECT * FROM source_tags WHERE name = ?';
const SQL_SELECT_TAGS_BY_SOURCE = `SELECT t.name AS name FROM source_tags t
  JOIN source_tag_links l ON l.tag_id = t.id
  WHERE l.source_id = ? ORDER BY t.name ASC, t.id ASC`;
const SQL_INSERT_SOURCE = `INSERT INTO sources (
  id, scope, canonical_key, url, name, group_id, priority, enabled, share_mode,
  trust_value, trust_asserted_by, trust_verification, user_note, ai_note,
  created_by, version, created_at, updated_at, deleted_at, last_used_at, last_usage_outcome
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const SQL_UPDATE_SOURCE = `UPDATE sources SET
  url = ?, canonical_key = ?, name = ?, group_id = ?, priority = ?, share_mode = ?,
  trust_value = ?, trust_asserted_by = ?, trust_verification = ?,
  user_note = ?, ai_note = ?, version = version + 1, updated_at = ?
  WHERE id = ? AND version = ?`;
const SQL_SET_SOURCE_DISABLED = `UPDATE sources SET
  enabled = 0, deleted_at = ?, version = version + 1, updated_at = ?
  WHERE id = ? AND version = ?`;
const SQL_SET_SOURCE_RESTORED = `UPDATE sources SET
  enabled = 1, deleted_at = NULL, version = version + 1, updated_at = ?
  WHERE id = ? AND version = ?`;
const SQL_DELETE_SOURCE = 'DELETE FROM sources WHERE id = ?';
const SQL_RESTORE_SOURCE = `UPDATE sources SET
  scope = ?, canonical_key = ?, url = ?, name = ?, group_id = ?, priority = ?,
  enabled = ?, share_mode = ?, trust_value = ?, trust_asserted_by = ?,
  trust_verification = ?, user_note = ?, ai_note = ?, created_by = ?, version = ?,
  created_at = ?, updated_at = ?, deleted_at = ?, last_used_at = ?, last_usage_outcome = ?
  WHERE id = ?`;
const SQL_SELECT_GROUP_NAME_BY_ID = 'SELECT name FROM source_groups WHERE id = ?';
const SQL_INSERT_GROUP = `INSERT OR IGNORE INTO source_groups (id, name, created_at, deleted_at)
  VALUES (?, ?, ?, NULL)`;
const SQL_INSERT_TAG = 'INSERT OR IGNORE INTO source_tags (id, name, created_at) VALUES (?, ?, ?)';
const SQL_DELETE_TAG_LINKS = 'DELETE FROM source_tag_links WHERE source_id = ?';
const SQL_INSERT_TAG_LINK = 'INSERT INTO source_tag_links (source_id, tag_id) VALUES (?, ?)';
const SQL_INSERT_FTS =
  'INSERT INTO sources_fts (rowid, name, url, user_note, ai_note) VALUES (?, ?, ?, ?, ?)';
const SQL_DELETE_FTS = `INSERT INTO sources_fts (sources_fts, rowid, name, url, user_note, ai_note)
  VALUES ('delete', ?, ?, ?, ?, ?)`;
const SQL_UPSERT_USAGE = `INSERT INTO usage_events (source_id, outcome, recorded_at) VALUES (?, ?, ?)
  ON CONFLICT(source_id) DO UPDATE SET outcome = excluded.outcome, recorded_at = excluded.recorded_at`;
// groupId 三态：mode 0 = 不过滤；mode 1 = 未分组（group_id IS NULL）；mode 2 = 指定组
const SQL_LIST_SOURCES = `SELECT s.*, g.name AS group_name FROM sources s
  LEFT JOIN source_groups g ON g.id = s.group_id
  WHERE s.deleted_at IS NULL
    AND (? = 0 OR (? = 1 AND s.group_id IS NULL) OR (? = 2 AND s.group_id = ?))
    AND (? = 0 OR s.enabled = 1)
  ORDER BY s.created_at DESC, s.id ASC LIMIT ? OFFSET ?`;
const SQL_COUNT_SOURCES = `SELECT COUNT(*) AS n FROM sources s
  WHERE s.deleted_at IS NULL
    AND (? = 0 OR (? = 1 AND s.group_id IS NULL) OR (? = 2 AND s.group_id = ?))
    AND (? = 0 OR s.enabled = 1)`;
const SQL_SEARCH_SOURCES = `SELECT s.*, g.name AS group_name FROM sources s
  LEFT JOIN source_groups g ON g.id = s.group_id
  WHERE s.deleted_at IS NULL AND (
    s.name = ? OR s.name LIKE ? ESCAPE '\\'
    OR s.canonical_key = ? OR s.canonical_key LIKE ? ESCAPE '\\'
    OR s.url = ? OR s.url LIKE ? ESCAPE '\\'
    OR s.group_id IN (SELECT id FROM source_groups WHERE name = ?)
    OR s.id IN (SELECT l.source_id FROM source_tag_links l
      JOIN source_tags t ON t.id = l.tag_id WHERE t.name = ?)
  )
  ORDER BY s.created_at DESC, s.id ASC LIMIT ?`;

export interface SourceListRow extends SourceRow {
  group_name: string | null;
}

export function escapeLikePrefix(text: string): string {
  // LIKE ? ESCAPE '\'：转义 \ % _ 后追加 %（查询串只作数据，ST-04）。
  // 注：SQLite 3.53.1 实测——转义通配符位于模式首位时前缀语义正常
  // （'\'%bc%' 匹配 '%bc' 与 '%bcx'，不匹配 'x%bc'）。
  return text.replace(/[\\%_]/g, (m) => `\\${m}`) + '%';
}

function groupFilterParams(groupId: string | null | undefined): {
  mode: number;
  value: string | null;
} {
  if (groupId === undefined) return { mode: 0, value: null }; // 不过滤
  if (groupId === null) return { mode: 1, value: null }; // 未分组
  return { mode: 2, value: groupId }; // 指定组
}

export function rowToSource(row: SourceRow): Source {
  return {
    id: row.id,
    scope: row.scope,
    canonicalKey: row.canonical_key,
    url: row.url,
    name: row.name,
    groupId: row.group_id,
    tags: [], // 由 service 经 listTagsBySource 填充
    priority: row.priority,
    enabled: row.enabled === 1,
    shareMode: row.share_mode,
    trust: {
      value: row.trust_value,
      assertedBy: row.trust_asserted_by,
      verification: row.trust_verification,
    },
    userNote: row.user_note,
    aiNote: row.ai_note,
    createdBy: row.created_by,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    lastUsedAt: row.last_used_at,
    lastUsageOutcome: row.last_usage_outcome,
  };
}

export function rowToGroup(row: GroupRow): SourceGroup {
  return { id: row.id, name: row.name, createdAt: row.created_at, deletedAt: row.deleted_at };
}

export class SourceRepository {
  constructor(private readonly handle: DbHandle) {}

  // --- 读 ---

  getSourceById(id: string): SourceRow | null {
    return (this.handle.prepare(SQL_SELECT_SOURCE_BY_ID).get(id) as SourceRow | undefined) ?? null;
  }

  getSourceByCanonical(scope: SourceScope, canonicalKey: string): SourceRow | null {
    return (
      (this.handle.prepare(SQL_SELECT_SOURCE_BY_CANONICAL).get(scope, canonicalKey) as
        SourceRow | undefined) ?? null
    );
  }

  getSourceRowid(id: string): number | null {
    const row = this.handle.prepare(SQL_SELECT_SOURCE_ROWID).get(id) as
      { rowid: number } | undefined;
    return row === undefined ? null : row.rowid;
  }

  getGroupByName(name: string): GroupRow | null {
    return (
      (this.handle.prepare(SQL_SELECT_GROUP_BY_NAME).get(name) as GroupRow | undefined) ?? null
    );
  }

  getGroupNameById(id: string): string | null {
    const row = this.handle.prepare(SQL_SELECT_GROUP_NAME_BY_ID).get(id) as
      { name: string } | undefined;
    return row === undefined ? null : row.name;
  }

  getTagByName(name: string): TagRow | null {
    return (this.handle.prepare(SQL_SELECT_TAG_BY_NAME).get(name) as TagRow | undefined) ?? null;
  }

  listTagsBySource(sourceId: string): string[] {
    const rows = this.handle.prepare(SQL_SELECT_TAGS_BY_SOURCE).all(sourceId) as { name: string }[];
    return rows.map((r) => r.name);
  }

  listSources(filter: SourceListFilter): SourceListRow[] {
    const { mode, value } = groupFilterParams(filter.groupId);
    const enabledOnly = filter.enabledOnly === true ? 1 : 0;
    return this.handle
      .prepare(SQL_LIST_SOURCES)
      .all(mode, mode, mode, value, enabledOnly, filter.limit, filter.offset) as SourceListRow[];
  }

  countSources(filter: { groupId?: string | null; enabledOnly?: boolean }): number {
    const { mode, value } = groupFilterParams(filter.groupId);
    const enabledOnly = filter.enabledOnly === true ? 1 : 0;
    const row = this.handle
      .prepare(SQL_COUNT_SOURCES)
      .get(mode, mode, mode, value, enabledOnly) as { n: number };
    return row.n;
  }

  // B2 最小检索：name/canonical/url 精确或前缀 + group/tag 精确（参数化 LIKE ESCAPE；
  // 软删行过滤；FTS 查询构造归 B3）。排序确定性：created_at DESC + id ASC。
  searchBasic(query: string, limit: number): SourceListRow[] {
    const prefix = escapeLikePrefix(query);
    return this.handle
      .prepare(SQL_SEARCH_SOURCES)
      .all(query, prefix, query, prefix, query, prefix, query, query, limit) as SourceListRow[];
  }

  // --- 写（调用方事务内） ---

  insertSource(row: SourceInsert): number {
    try {
      const result = this.handle
        .prepare(SQL_INSERT_SOURCE)
        .run(
          row.id,
          row.scope,
          row.canonical_key,
          row.url,
          row.name,
          row.group_id,
          row.priority,
          row.enabled,
          row.share_mode,
          row.trust_value,
          row.trust_asserted_by,
          row.trust_verification,
          row.user_note,
          row.ai_note,
          row.created_by,
          row.version,
          row.created_at,
          row.updated_at,
          row.deleted_at,
          row.last_used_at,
          row.last_usage_outcome,
        );
      return Number(result.lastInsertRowid); // = sources 隐式 rowid（FTS 行 id，决议 #54）
    } catch (err) {
      throw translateSqliteError(err);
    }
  }

  updateSourceFields(
    id: string,
    expectedVersion: number,
    values: SourceFieldValues,
    updatedAt: string,
  ): void {
    try {
      const result = this.handle
        .prepare(SQL_UPDATE_SOURCE)
        .run(
          values.url,
          values.canonical_key,
          values.name,
          values.group_id,
          values.priority,
          values.share_mode,
          values.trust_value,
          values.trust_asserted_by,
          values.trust_verification,
          values.user_note,
          values.ai_note,
          updatedAt,
          id,
          expectedVersion,
        );
      if (Number(result.changes) === 0) {
        throw new RepositoryError('version-mismatch', 'expectedVersion 不匹配（行不存在或已变更）');
      }
    } catch (err) {
      if (err instanceof RepositoryError) throw err;
      throw translateSqliteError(err);
    }
  }

  setSourceDisabled(
    id: string,
    expectedVersion: number,
    deletedAt: string,
    updatedAt: string,
  ): void {
    this.runVersioned(SQL_SET_SOURCE_DISABLED, deletedAt, updatedAt, id, expectedVersion);
  }

  setSourceRestored(id: string, expectedVersion: number, updatedAt: string): void {
    this.runVersioned(SQL_SET_SOURCE_RESTORED, updatedAt, id, expectedVersion);
  }

  deleteSource(id: string): void {
    try {
      this.handle.prepare(SQL_DELETE_SOURCE).run(id);
    } catch (err) {
      throw translateSqliteError(err);
    }
  }

  // Undo 回放：整行快照恢复（含 version/enabled/deleted_at——决议 #52 消费语义的
  // 前置版本校验在 Service 层完成，此处为权威写入）。WHERE 仅 id（回放不以乐观
  // 版本为条件——已通过冲突预检）。
  restoreSourceSnapshot(row: SourceRow): void {
    try {
      this.handle
        .prepare(SQL_RESTORE_SOURCE)
        .run(
          row.scope,
          row.canonical_key,
          row.url,
          row.name,
          row.group_id,
          row.priority,
          row.enabled,
          row.share_mode,
          row.trust_value,
          row.trust_asserted_by,
          row.trust_verification,
          row.user_note,
          row.ai_note,
          row.created_by,
          row.version,
          row.created_at,
          row.updated_at,
          row.deleted_at,
          row.last_used_at,
          row.last_usage_outcome,
          row.id,
        );
    } catch (err) {
      throw translateSqliteError(err);
    }
  }

  upsertGroup(name: string, createdAt: string): GroupRow {
    const existing = this.getGroupByName(name);
    if (existing !== null) return existing;
    try {
      this.handle.prepare(SQL_INSERT_GROUP).run(randomUUID(), name, createdAt);
    } catch (err) {
      throw translateSqliteError(err);
    }
    const row = this.getGroupByName(name);
    if (row === null) throw new RepositoryError('sqlite-error', '分组 upsert 后读回失败');
    return row;
  }

  upsertTag(name: string, createdAt: string): TagRow {
    const existing = this.getTagByName(name);
    if (existing !== null) return existing;
    try {
      this.handle.prepare(SQL_INSERT_TAG).run(randomUUID(), name, createdAt);
    } catch (err) {
      throw translateSqliteError(err);
    }
    const row = this.getTagByName(name);
    if (row === null) throw new RepositoryError('sqlite-error', '标签 upsert 后读回失败');
    return row;
  }

  setSourceTags(sourceId: string, tagIds: string[]): void {
    try {
      this.handle.prepare(SQL_DELETE_TAG_LINKS).run(sourceId);
      const insert = this.handle.prepare(SQL_INSERT_TAG_LINK);
      for (const tagId of tagIds) insert.run(sourceId, tagId);
    } catch (err) {
      throw translateSqliteError(err);
    }
  }

  ftsInsert(rowid: number, name: string, url: string, userNote: string, aiNote: string): void {
    try {
      this.handle.prepare(SQL_INSERT_FTS).run(rowid, name, url, userNote, aiNote);
    } catch (err) {
      throw translateSqliteError(err);
    }
  }

  ftsDelete(rowid: number, name: string, url: string, userNote: string, aiNote: string): void {
    try {
      this.handle.prepare(SQL_DELETE_FTS).run(rowid, name, url, userNote, aiNote);
    } catch (err) {
      throw translateSqliteError(err);
    }
  }

  upsertUsage(sourceId: string, outcome: SourceUsageOutcome, recordedAt: string): void {
    try {
      this.handle.prepare(SQL_UPSERT_USAGE).run(sourceId, outcome, recordedAt);
    } catch (err) {
      throw translateSqliteError(err);
    }
  }

  private runVersioned(sql: string, ...params: (string | number)[]): void {
    try {
      const result = this.handle.prepare(sql).run(...params);
      if (Number(result.changes) === 0) {
        throw new RepositoryError('version-mismatch', 'expectedVersion 不匹配（行不存在或已变更）');
      }
    } catch (err) {
      if (err instanceof RepositoryError) throw err;
      throw translateSqliteError(err);
    }
  }
}
