// C1 research-driver tests: the thin wrapper over the frozen node:sqlite
// driver pattern (adjudication #111) — independent handles per open, idempotent
// close, option passthrough, and the connection-level operational SQL boundary
// (no business SQL in the driver; verified by red-line grep elsewhere).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, openResearchDb, withTransaction } from './research-driver';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-research-driver-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('research-driver 薄封装（决议 #111：独立库独立句柄）', () => {
  it('openResearchDb 每次打开返回独立句柄（独立库独立句柄语义）', () => {
    const a = openResearchDb(join(root, 'a.db'));
    const b = openResearchDb(join(root, 'b.db'));
    expect(a).not.toBe(b);
    expect(a.path).not.toBe(b.path);
    expect(a.isOpen).toBe(true);
    expect(b.isOpen).toBe(true);
    closeDb(a);
    closeDb(b);
  });

  it('closeDb 幂等（重复关闭安全无操作）', () => {
    const handle = openResearchDb(join(root, 'c.db'));
    closeDb(handle);
    closeDb(handle);
    expect(handle.isOpen).toBe(false);
  });

  it('关闭后 prepare/exec 确定性抛错（安全失败不静默）', () => {
    const handle = openResearchDb(join(root, 'd.db'));
    closeDb(handle);
    expect(() => handle.prepare('SELECT 1')).toThrow();
  });

  it('withTransaction 提交与回滚语义（连接级运维原语）', () => {
    const handle = openResearchDb(join(root, 'e.db'));
    handle.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    withTransaction(handle, () => {
      handle.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('a', '1');
    });
    expect(handle.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 1 });
    expect(() =>
      withTransaction(handle, () => {
        handle.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('b', '2');
        throw new Error('业务失败');
      }),
    ).toThrow('业务失败');
    expect(handle.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 1 });
    closeDb(handle);
  });

  it('wal:false 选项透传（store 迁移路径复用语义）', () => {
    const handle = openResearchDb(join(root, 'f.db'), { wal: false });
    expect(handle.isOpen).toBe(true);
    closeDb(handle);
  });
});
