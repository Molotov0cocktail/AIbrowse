// Fourth Stage B1: node:sqlite thin wrapper (decision gate spike + driver foundation).
// Adjudication #47: this file may define connection-level operational SQL constants
// only — PRAGMA busy_timeout / foreign_keys / journal_mode and BEGIN/COMMIT/ROLLBACK.
// PRAGMA statements do not support bound parameters (verified 2026-08-15 on SQLite
// 3.53.1: `PRAGMA busy_timeout = ?` fails with "near \"?\": syntax error"), so values
// are program-validated integer options or compile-time constants; no user/model/web
// text can ever reach these statements. Business SQL stays in Repository/migrations
// (B2+). The ExperimentalWarning emitted on first node:sqlite import is recorded
// truthfully by the process (stderr), never suppressed.
import { DatabaseSync } from 'node:sqlite';

// --- connection-level operational SQL (compile-time constants only) ---
const SQL_BEGIN = 'BEGIN';
const SQL_COMMIT = 'COMMIT';
const SQL_ROLLBACK = 'ROLLBACK';
const SQL_PRAGMA_FOREIGN_KEYS_ON = 'PRAGMA foreign_keys = ON';
const SQL_PRAGMA_FOREIGN_KEYS_OFF = 'PRAGMA foreign_keys = OFF';
const SQL_PRAGMA_JOURNAL_MODE_WAL = 'PRAGMA journal_mode = WAL';

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;
export const BUSY_TIMEOUT_MIN_MS = 0; // 0 = 禁用等待（SQLite busy_timeout 语义）
export const BUSY_TIMEOUT_MAX_MS = 30_000;

export interface DbOpenOptions {
  // 连接级选项：busyTimeoutMs 仅接受 [1, 30000] 内整数（默认 5000）；非法值明确拒绝
  busyTimeoutMs?: number;
  enableForeignKeys?: boolean; // 默认 true（PRAGMA foreign_keys = ON）
  wal?: boolean; // 默认 true（PRAGMA journal_mode = WAL）
}

export interface DbStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface DbHandle {
  readonly path: string;
  readonly isOpen: boolean;
  prepare(sql: string): DbStatement;
  exec(sql: string): void;
  close(): void;
}

class DbHandleImpl implements DbHandle {
  readonly path: string;
  private readonly db: DatabaseSync;
  private open = true;

  constructor(path: string, db: DatabaseSync) {
    this.path = path;
    this.db = db;
  }

  get isOpen(): boolean {
    return this.open;
  }

  prepare(sql: string): DbStatement {
    this.ensureOpen();
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.ensureOpen();
    this.db.exec(sql);
  }

  close(): void {
    if (!this.open) return; // 重复关闭幂等
    this.db.close();
    this.open = false;
  }

  private ensureOpen(): void {
    if (!this.open) throw new Error('数据库连接已关闭');
  }
}

export function openDb(path: string, options: DbOpenOptions = {}): DbHandle {
  const busyTimeoutMs = normalizeBusyTimeout(options.busyTimeoutMs);
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path);
    // PRAGMA 不支持参数绑定（实测）——busy_timeout 值仅为程序校验后的整数选项
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    // 显式双分支：本机 SQLite 构建（Node 24.18.0）默认 SQLITE_DEFAULT_FOREIGN_KEYS=1，
    // 与 stock 默认（OFF）不同——显式设置保证跨构建确定性，不依赖编译默认
    db.exec(
      options.enableForeignKeys === false
        ? SQL_PRAGMA_FOREIGN_KEYS_OFF
        : SQL_PRAGMA_FOREIGN_KEYS_ON,
    );
    if (options.wal !== false) db.exec(SQL_PRAGMA_JOURNAL_MODE_WAL);
    return new DbHandleImpl(path, db);
  } catch (err) {
    // 安全失败、不静默吞错：中文包装重抛；失败路径句柄清理（最佳努力）
    try {
      db?.close();
    } catch {
      // close 失败不掩盖原始错误
    }
    throw new Error(`打开数据库失败：${path}`, { cause: err });
  }
}

export function closeDb(handle: DbHandle): void {
  handle.close(); // 幂等（内部守卫）
}

export function withTransaction<T>(handle: DbHandle, fn: () => T): T {
  // 同步契约：node:sqlite DatabaseSync 为同步 API；fn 同步抛出 → ROLLBACK 后原样
  // 重抛（连接保持可用、可诊断）。不支持重入（嵌套 BEGIN 由 SQLite 报错，属安全
  // 失败）；fn 不得返回 Promise（本驱动契约不含异步事务）。
  if (!handle.isOpen) throw new Error('事务无法开始：数据库连接已关闭');
  handle.exec(SQL_BEGIN);
  try {
    const result = fn();
    handle.exec(SQL_COMMIT);
    return result;
  } catch (err) {
    try {
      handle.exec(SQL_ROLLBACK);
    } catch (rollbackErr) {
      // 回滚失败属连接级故障：以中文包装报告（症状异常为 cause，原始异常并入消息），不静默
      throw new Error(`事务回滚失败：${String(rollbackErr)}（原始异常：${String(err)}）`, {
        cause: rollbackErr,
      });
    }
    throw err;
  }
}

function normalizeBusyTimeout(value: number | undefined): number {
  const ms = value ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(ms) || ms < BUSY_TIMEOUT_MIN_MS || ms > BUSY_TIMEOUT_MAX_MS) {
    throw new Error(
      `busyTimeoutMs 非法：必须为 ${BUSY_TIMEOUT_MIN_MS}–${BUSY_TIMEOUT_MAX_MS} 内整数（收到 ${String(value)}）`,
    );
  }
  return ms;
}
