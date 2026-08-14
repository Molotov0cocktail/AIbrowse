// Fourth Stage B2: ChangeJournal — durable Undo data (detailed-design §7.5,
// adjudications #53/#55). Payload shape: JSON map { sourceId: { row: SourceRow |
// null, tags: string[] } } — `row: null` marks an add (Undo replays by deleting).
// source_ids is stored as a JSON array string (exact whole-string matching on
// removal — no UUID substring false positives). Bounded prune: > 100 entries or
// older than 30 days (either bound triggers; injected clock for deterministic
// tests). All SQL is compile-time constants with bound parameters; writes run
// inside the caller's transaction.
import { type DbHandle } from '../db/sqlite-driver';
import { translateSqliteError, type SourceRow } from './source-repository';

export const JOURNAL_MAX_ENTRIES = 100;
export const JOURNAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

export interface SourceSnapshot {
  row: SourceRow | null; // null = add 反向删除（Undo 回放为物理删除）
  tags: string[];
}

export type SnapshotMap = Record<string, SourceSnapshot>;

export interface JournalEntry {
  idempotencyKey: string;
  runId: string | null;
  toolCallId: string | null;
  changeType: 'agent-change-set' | 'manual';
  beforePayload: string;
  afterPayload: string;
  sourceIds: string[];
  requestFingerprint: string | null;
  resultPayload: string | null;
  appliedAt: string;
}

// --- 编译期 SQL 常量 ---

const SQL_INSERT_JOURNAL = `INSERT INTO change_journal (
  idempotency_key, run_id, tool_call_id, change_type, before_payload, after_payload,
  source_ids, request_fingerprint, result_payload, applied_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const SQL_SELECT_BY_KEY = 'SELECT * FROM change_journal WHERE idempotency_key = ?';
const SQL_SELECT_BY_RUN_TOOL = 'SELECT * FROM change_journal WHERE run_id = ? AND tool_call_id = ?';
const SQL_LIST_RECENT = 'SELECT * FROM change_journal ORDER BY applied_at DESC, rowid DESC LIMIT ?';
const SQL_DELETE_BY_KEY = 'DELETE FROM change_journal WHERE idempotency_key = ?';
const SQL_UPDATE_PAYLOADS = `UPDATE change_journal SET before_payload = ?, after_payload = ?, source_ids = ?
  WHERE idempotency_key = ?`;
const SQL_COUNT = 'SELECT COUNT(*) AS n FROM change_journal';
const SQL_DELETE_OLDEST = `DELETE FROM change_journal WHERE rowid IN (
  SELECT rowid FROM change_journal ORDER BY applied_at ASC, rowid ASC LIMIT ?)`;
const SQL_DELETE_BY_AGE = 'DELETE FROM change_journal WHERE applied_at < ?';

interface JournalRow {
  idempotency_key: string;
  run_id: string | null;
  tool_call_id: string | null;
  change_type: 'agent-change-set' | 'manual';
  before_payload: string;
  after_payload: string;
  source_ids: string;
  request_fingerprint: string | null;
  result_payload: string | null;
  applied_at: string;
}

function parseSourceIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    // 畸形安全失败：返回空（不崩溃；removeSource 时按空处理）
  }
  return [];
}

function rowToEntry(row: JournalRow): JournalEntry {
  return {
    idempotencyKey: row.idempotency_key,
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    changeType: row.change_type,
    beforePayload: row.before_payload,
    afterPayload: row.after_payload,
    sourceIds: parseSourceIds(row.source_ids),
    requestFingerprint: row.request_fingerprint,
    resultPayload: row.result_payload,
    appliedAt: row.applied_at,
  };
}

// --- payload 序列化/校验（损坏/畸形安全失败，fail-closed） ---

export function serializeSnapshotMap(map: SnapshotMap): string {
  return JSON.stringify(map);
}

export function parseSnapshotMap(raw: string): SnapshotMap | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const out: SnapshotMap = {};
  for (const [sourceId, snapshot] of Object.entries(parsed)) {
    if (typeof snapshot !== 'object' || snapshot === null) return null;
    const s = snapshot as Record<string, unknown>;
    if (!Array.isArray(s['tags']) || !s['tags'].every((t) => typeof t === 'string')) {
      return null;
    }
    if (s['row'] === null) {
      out[sourceId] = { row: null, tags: s['tags'] };
      continue;
    }
    const row = s['row'];
    if (typeof row !== 'object' || row === null) return null;
    const r = row as Record<string, unknown>;
    if (typeof r['id'] !== 'string' || typeof r['version'] !== 'number') return null; // 关键字段形状（fail-closed）
    out[sourceId] = { row: r as unknown as SourceRow, tags: s['tags'] };
  }
  return out;
}

export class ChangeJournal {
  constructor(
    private readonly handle: DbHandle,
    private readonly nowMs: () => number,
  ) {}

  record(entry: JournalEntry): void {
    try {
      this.handle
        .prepare(SQL_INSERT_JOURNAL)
        .run(
          entry.idempotencyKey,
          entry.runId,
          entry.toolCallId,
          entry.changeType,
          entry.beforePayload,
          entry.afterPayload,
          JSON.stringify(entry.sourceIds),
          entry.requestFingerprint,
          entry.resultPayload,
          entry.appliedAt,
        );
    } catch (err) {
      throw translateSqliteError(err);
    }
    this.prune();
  }

  findByKey(idempotencyKey: string): JournalEntry | null {
    const row = this.handle.prepare(SQL_SELECT_BY_KEY).get(idempotencyKey) as
      JournalRow | undefined;
    return row === undefined ? null : rowToEntry(row);
  }

  findByRunTool(runId: string, toolCallId: string): JournalEntry | null {
    const row = this.handle.prepare(SQL_SELECT_BY_RUN_TOOL).get(runId, toolCallId) as
      JournalRow | undefined;
    return row === undefined ? null : rowToEntry(row);
  }

  listRecent(limit: number = JOURNAL_MAX_ENTRIES): JournalEntry[] {
    const rows = this.handle.prepare(SQL_LIST_RECENT).all(limit) as JournalRow[];
    return rows.map(rowToEntry);
  }

  deleteByKey(idempotencyKey: string): boolean {
    const result = this.handle.prepare(SQL_DELETE_BY_KEY).run(idempotencyKey);
    return Number(result.changes) > 0;
  }

  // hard delete 精确清理（决议 #55）：移除该 source 的条目与快照（全串相等匹配）；
  // 剩余为空 → 删除整行；payload 畸形无法拆分 → 删除整行（不残留私人 payload 优先）。
  removeSource(idempotencyKey: string, sourceId: string): void {
    const entry = this.findByKey(idempotencyKey);
    if (entry === null) return;
    const remaining = entry.sourceIds.filter((id) => id !== sourceId);
    if (remaining.length === 0) {
      this.deleteByKey(idempotencyKey);
      return;
    }
    const before = parseSnapshotMap(entry.beforePayload);
    const after = parseSnapshotMap(entry.afterPayload);
    if (before === null || after === null) {
      this.deleteByKey(idempotencyKey); // 无法精确拆分 → 整行删除（安全优先）
      return;
    }
    delete before[sourceId];
    delete after[sourceId];
    this.handle
      .prepare(SQL_UPDATE_PAYLOADS)
      .run(
        serializeSnapshotMap(before),
        serializeSnapshotMap(after),
        JSON.stringify(remaining),
        idempotencyKey,
      );
  }

  // 双上限清理（任一触发）：条数 > max 删最旧；applied_at < now-30d 按年龄删除。
  prune(maxEntries: number = JOURNAL_MAX_ENTRIES, maxAgeMs: number = JOURNAL_MAX_AGE_MS): void {
    try {
      const cutoff = new Date(this.nowMs() - maxAgeMs).toISOString();
      this.handle.prepare(SQL_DELETE_BY_AGE).run(cutoff);
      const { n } = this.handle.prepare(SQL_COUNT).get() as { n: number };
      if (n > maxEntries) {
        this.handle.prepare(SQL_DELETE_OLDEST).run(n - maxEntries);
      }
    } catch (err) {
      throw translateSqliteError(err);
    }
  }
}
