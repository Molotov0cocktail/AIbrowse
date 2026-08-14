// sqlite-driver unit tests (B1): real node:sqlite under system Node (Vitest node env).
// The authoritative Electron dev+production gate evidence comes from smoke B-01;
// these cases cover the driver contract deterministically. Test-only probe SQL is
// confined to this file (adjudication #47) — the driver itself carries no business SQL.
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, openDb, withTransaction, type DbHandle } from './sqlite-driver';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-sqlite-driver-'));

// 打开/执行/关闭三段式：断言失败路径也保证句柄关闭（所有异常路径句柄清理纪律）
function withDb<T>(
  path: string,
  fn: (h: DbHandle) => T,
  options?: Parameters<typeof openDb>[1],
): T {
  const h = openDb(path, options);
  try {
    return fn(h);
  } finally {
    closeDb(h);
  }
}

function countRows(dbPath: string, table: string): number {
  return withDb(
    dbPath,
    (h) => (h.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
  );
}

interface LockHolder {
  locked: Promise<void>;
  done: Promise<void>;
}

// 锁持有者工作线程：对同一库文件 BEGIN IMMEDIATE + 写入后持锁 holdMs，再提交退出。
// busy_timeout 正向证据（等待至释放后成功）需要真正的并发——DatabaseSync 为同步 API，
// 单线程内锁持有方无法在竞争方阻塞期间释放。工作线程脚本写入本测试专属临时目录，
// 测试结束随根目录一并清理（不触碰产品代码路径）。
function startLockHolder(dbPath: string, holdMs: number): LockHolder {
  const workerFile = join(root, `lock-holder-${process.pid}-${Date.now()}.cjs`);
  const code = [
    "'use strict';",
    "const { parentPort, workerData } = require('node:worker_threads');",
    "const { DatabaseSync } = require('node:sqlite');",
    'const db = new DatabaseSync(workerData.dbPath);',
    "db.exec('BEGIN IMMEDIATE');",
    "db.prepare('INSERT INTO busy_t(k) VALUES (?)').run('holder');",
    "parentPort.postMessage({ state: 'locked' });",
    'setTimeout(() => {',
    "  db.exec('COMMIT');",
    '  db.close();',
    '  process.exit(0);',
    '}, workerData.holdMs);',
    '',
  ].join('\n');
  writeFileSync(workerFile, code);
  const worker = new Worker(workerFile, { workerData: { dbPath, holdMs } });
  const locked = new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve());
    worker.once('error', (err) => reject(err));
  });
  const done = new Promise<void>((resolve, reject) => {
    worker.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`锁持有者线程退出码异常：${String(code)}`)),
    );
  });
  return { locked, done };
}

describe('sqlite-driver — 文件库与句柄（B1 基础能力）', () => {
  it('打开/关闭/重开并读回一致（含中文）', () => {
    const dbPath = join(root, 'reopen.db');
    withDb(dbPath, (h1) => {
      h1.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
      h1.prepare('INSERT INTO t(k, v) VALUES (?, ?)').run('a', '中文内容');
    });
    withDb(dbPath, (h2) => {
      expect((h2.prepare('SELECT v FROM t WHERE k = ?').get('a') as { v: string }).v).toBe(
        '中文内容',
      );
    });
  });

  it('prepared statement 注入串只作数据（中文/引号/; DROP TABLE）', () => {
    const dbPath = join(root, 'inject.db');
    withDb(dbPath, (h) => {
      h.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
      h.exec('CREATE TABLE keep (k TEXT PRIMARY KEY)');
      h.prepare('INSERT INTO keep(k) VALUES (?)').run('存活');
      const injection = "'; DROP TABLE keep --";
      h.prepare('INSERT INTO t(k, v) VALUES (?, ?)').run('i1', '中文与"引号"');
      h.prepare('INSERT INTO t(k, v) VALUES (?, ?)').run('i2', injection);
      expect((h.prepare('SELECT v FROM t WHERE k = ?').get('i2') as { v: string }).v).toBe(
        injection,
      );
      // DROP TABLE 未执行：keep 表与其数据完好
      expect((h.prepare('SELECT COUNT(*) AS n FROM keep').get() as { n: number }).n).toBe(1);
    });
  });

  it('withTransaction 成功提交并透传返回值', () => {
    withDb(join(root, 'tx-commit.db'), (h) => {
      h.exec('CREATE TABLE t (k TEXT PRIMARY KEY)');
      const result = withTransaction(h, () => {
        h.prepare('INSERT INTO t(k) VALUES (?)').run('a');
        h.prepare('INSERT INTO t(k) VALUES (?)').run('b');
        return 42;
      });
      expect(result).toBe(42);
      expect((h.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n).toBe(2);
    });
  });

  it('withTransaction 回调异常整体回滚且连接仍可诊断', () => {
    withDb(join(root, 'tx-throw.db'), (h) => {
      h.exec('CREATE TABLE t (k TEXT PRIMARY KEY)');
      expect(() =>
        withTransaction(h, () => {
          h.prepare('INSERT INTO t(k) VALUES (?)').run('a');
          throw new Error('探针回调异常');
        }),
      ).toThrow('探针回调异常');
      expect((h.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n).toBe(0);
      // 失败后连接仍可诊断（安全失败、不静默）
      h.prepare('INSERT INTO t(k) VALUES (?)').run('after');
      expect((h.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n).toBe(1);
    });
  });

  it('withTransaction 语句异常整体回滚', () => {
    withDb(join(root, 'tx-stmt.db'), (h) => {
      h.exec('CREATE TABLE t (k TEXT PRIMARY KEY)');
      expect(() =>
        withTransaction(h, () => {
          h.prepare('INSERT INTO t(k) VALUES (?)').run('a');
          h.exec('INSERT INTO no_such_table VALUES (1)'); // 语句异常
        }),
      ).toThrow();
      expect((h.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n).toBe(0);
    });
  });

  it('外键默认开启：非法外键写入被拦截', () => {
    withDb(join(root, 'fk-on.db'), (h) => {
      expect(
        (h.prepare('PRAGMA foreign_keys').get() as Record<string, number>)['foreign_keys'],
      ).toBe(1);
      h.exec('CREATE TABLE p (id INTEGER PRIMARY KEY)');
      h.exec('CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL REFERENCES p(id))');
      expect(() => h.prepare('INSERT INTO c(pid) VALUES (?)').run(999)).toThrow(/foreign key/i);
      h.prepare('INSERT INTO p(id) VALUES (?)').run(1);
      h.prepare('INSERT INTO c(pid) VALUES (?)').run(1); // 合法写入成功
    });
  });

  it('enableForeignKeys=false：非法外键写入放行（拦截来自 PRAGMA 设置）', () => {
    // 本机 SQLite 构建默认 foreign_keys=ON（SQLITE_DEFAULT_FOREIGN_KEYS=1，实测）——
    // driver 显式 OFF 分支保证跨构建确定性，此处验证关闭语义真实生效
    withDb(
      join(root, 'fk-off.db'),
      (h) => {
        expect(
          (h.prepare('PRAGMA foreign_keys').get() as Record<string, number>)['foreign_keys'],
        ).toBe(0);
        h.exec('CREATE TABLE p (id INTEGER PRIMARY KEY)');
        h.exec('CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL REFERENCES p(id))');
        h.prepare('INSERT INTO c(pid) VALUES (?)').run(999); // 不拦截
      },
      { enableForeignKeys: false },
    );
  });

  it('WAL 默认开启（PRAGMA journal_mode 回读为 wal）', () => {
    withDb(join(root, 'wal.db'), (h) => {
      expect(
        (h.prepare('PRAGMA journal_mode').get() as Record<string, string>)['journal_mode'],
      ).toBe('wal');
    });
  });

  it('busy_timeout 默认值 5000（PRAGMA 回读）', () => {
    withDb(join(root, 'busy-read.db'), (h) => {
      expect((h.prepare('PRAGMA busy_timeout').get() as Record<string, number>)['timeout']).toBe(
        5000,
      );
    });
  });

  it('busy_timeout 两连接锁竞争：等待至释放后成功（无墙钟断言）', async () => {
    const dbPath = join(root, 'busy-pos.db');
    withDb(dbPath, (setup) => {
      setup.exec('CREATE TABLE busy_t (k TEXT)');
    });
    const holder = startLockHolder(dbPath, 500);
    try {
      await holder.locked; // 锁已持有
      const b = openDb(dbPath, { busyTimeoutMs: 2000 });
      try {
        // 阻塞至持有方提交（~500ms）后成功——busy_timeout 生效的直接证据；
        // 未生效时该写会在持有期内立即以 SQLITE_BUSY 失败
        b.prepare('INSERT INTO busy_t(k) VALUES (?)').run('competing');
      } finally {
        closeDb(b);
      }
    } finally {
      await holder.done; // 确保持有方已提交退出
    }
    // 持有行与竞争行均已落库
    expect(countRows(dbPath, 'busy_t')).toBe(2);
  });

  it('busyTimeoutMs=0：锁竞争立即失败（负证，不等待）', async () => {
    const dbPath = join(root, 'busy-zero.db');
    withDb(dbPath, (setup) => {
      setup.exec('CREATE TABLE busy_t (k TEXT)');
    });
    const holder = startLockHolder(dbPath, 800);
    try {
      await holder.locked; // 锁已持有
      const b = openDb(dbPath, { busyTimeoutMs: 0 });
      try {
        expect(() => b.prepare('INSERT INTO busy_t(k) VALUES (?)').run('x')).toThrow(
          /locked|busy/i,
        );
      } finally {
        closeDb(b);
      }
    } finally {
      await holder.done;
    }
  });

  it('锁竞争等待下界证据（busy_timeout=300，等待 ≥100ms 后 SQLITE_BUSY）', () => {
    const dbPath = join(root, 'busy-wait.db');
    const a = openDb(dbPath);
    try {
      a.exec('CREATE TABLE busy_t (k TEXT)');
      a.exec('BEGIN IMMEDIATE');
      a.prepare('INSERT INTO busy_t(k) VALUES (?)').run('a');
      const b = openDb(dbPath, { busyTimeoutMs: 300 });
      try {
        const t0 = Date.now();
        let err: unknown = null;
        try {
          b.prepare('INSERT INTO busy_t(k) VALUES (?)').run('b');
        } catch (e) {
          err = e;
        }
        const waited = Date.now() - t0;
        expect(err !== null && /locked|busy/i.test(String(err))).toBe(true);
        // 仅下界断言（免疫系统变慢）：证明发生了等待而非立即失败
        expect(waited).toBeGreaterThanOrEqual(100);
      } finally {
        closeDb(b);
      }
      a.exec('COMMIT');
    } finally {
      closeDb(a);
    }
  });

  it('重复关闭幂等（不抛异常）', () => {
    const dbPath = join(root, 'dup-close.db');
    const h = openDb(dbPath);
    closeDb(h);
    expect(() => closeDb(h)).not.toThrow();
  });

  it('关闭后句柄释放：重命名与删除成功', () => {
    const dbPath = join(root, 'rename.db');
    withDb(dbPath, (h) => {
      h.exec('CREATE TABLE t (k TEXT)');
      h.prepare('INSERT INTO t(k) VALUES (?)').run('x');
    });
    const renamed = `${dbPath}.renamed`;
    renameSync(dbPath, renamed); // Windows：句柄未释放会抛错
    withDb(renamed, (h2) => {
      expect((h2.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n).toBe(1);
    });
    rmSync(renamed, { force: true });
    expect(existsSync(renamed)).toBe(false);
  });

  it('无效路径安全失败（中文错误，不静默）', () => {
    expect(() => openDb(join(root, 'no-such-dir', 'x.db'))).toThrow(/打开数据库失败/);
  });

  it('关闭后使用句柄明确拒绝（不静默）', () => {
    const dbPath = join(root, 'closed-use.db');
    const h = openDb(dbPath);
    closeDb(h);
    expect(() => h.prepare('SELECT 1')).toThrow(/数据库连接已关闭/);
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
