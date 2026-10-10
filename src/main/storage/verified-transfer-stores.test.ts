import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { normalizeTransferSchema, type TransferDatabaseDomain } from './transfer-schema';
import { openPrivateStagingDatabase } from './staging-sqlite';
import { openDb, openVerifiedTransferDb } from '../sources/db/sqlite-driver';
import { openSourcesStore, assembleVerifiedTransferSourcesStore } from '../sources/sources-store';
import { assembleVerifiedTransferResearchStore } from '../research/research-store';
import { assembleVerifiedTransferWatchStore } from '../watch/watch-store';

function fixture(domain: TransferDatabaseDomain = 'sources') {
  const root = mkdtempSync(join(tmpdir(), 'aibrowse-verified-transfer-'));
  const dbPath = join(root, `${domain}.db`);
  writeFileSync(dbPath, '');
  const { db } = openPrivateStagingDatabase(dbPath, domain);
  expect(normalizeTransferSchema(db, domain).ok).toBe(true);
  db.close();
  return { root, dbPath, backupsDir: join(root, 'backups') };
}
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('已验证数据代的服务健康装配', () => {
  it('原正常启动切WAL会改变摘要，不能直接作为恢复提交前健康装配', () => {
    const options = fixture();
    const before = hash(options.dbPath);
    const outcome = openSourcesStore(options);
    expect(outcome.mode).toBe('normal');
    expect(hash(options.dbPath)).not.toBe(before);
    outcome.service?.dispose();
  });

  it('健康句柄拒绝exec、run、RETURNING及PRAGMA读方法绕过，摘要与目录不变', () => {
    const { root, dbPath } = fixture();
    const before = hash(dbPath);
    const entry = openVerifiedTransferDb(dbPath);
    try {
      expect(entry.handle.prepare('SELECT count(*) AS n FROM sources').get()).toEqual({ n: 0 });
      expect(() => entry.handle.exec('PRAGMA query_only=OFF')).toThrow();
      expect(() => entry.handle.prepare('DELETE FROM sources').run()).toThrow();
      expect(() => entry.handle.prepare('DELETE FROM sources RETURNING id').get()).toThrow();
      expect(() => entry.handle.prepare('PRAGMA query_only=OFF').get()).toThrow();
      expect(() => entry.handle.prepare('PRAGMA query_only(0)').all()).toThrow();
      expect(() => entry.handle.prepare('/* comment */ PRAGMA query_only=OFF').get()).toThrow();
      expect(entry.handle.prepare('PRAGMA query_only').get()).toEqual({ query_only: 1 });
      expect(hash(dbPath)).toBe(before);
      expect(readdirSync(root)).toEqual(['sources.db']);
    } finally {
      entry.handle.close();
    }
  });

  it('提交后的同一闭包解锁保留非WAL，预先prepare的语句仍受当前准入状态控制', () => {
    const { root, dbPath } = fixture();
    const entry = openVerifiedTransferDb(dbPath);
    const write = entry.handle.prepare('CREATE TABLE activation_probe (value TEXT)');
    expect(() => write.run()).toThrow();
    entry.activateWrites();
    entry.activateWrites();
    write.run();
    expect(entry.handle.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    expect(existsSync(join(root, 'sources.db-wal'))).toBe(false);
    entry.handle.close();
    entry.handle.close();
    expect(() => entry.activateWrites()).toThrow();
  });

  it.each(['sources', 'research', 'watch'] as const)(
    '%s完整Store装配保持摘要且不重跑维护',
    (domain) => {
      const options = fixture(domain);
      const before = hash(options.dbPath);
      const entry = openVerifiedTransferDb(options.dbPath);
      const reconcile = vi.fn(() => {
        throw new Error('不应重跑');
      });
      if (domain === 'sources') {
        const result = assembleVerifiedTransferSourcesStore(options, entry.handle);
        expect(result.mode).toBe('normal');
        expect(result.service?.getState().mode).toBe('normal');
        result.service?.dispose();
      } else if (domain === 'research') {
        const result = assembleVerifiedTransferResearchStore(options, entry.handle);
        expect(result.mode).toBe('normal');
        result.service?.dispose();
      } else {
        const result = assembleVerifiedTransferWatchStore({ ...options, reconcile }, entry.handle);
        expect(result.mode).toBe('normal');
        expect(result.repo?.listRules()).toEqual([]);
        result.repo?.dispose();
      }
      expect(reconcile).not.toHaveBeenCalled();
      expect(hash(options.dbPath)).toBe(before);
      expect(readdirSync(options.root)).toEqual([`${domain}.db`]);
    },
  );

  it('普通可写句柄不得冒充已验证健康句柄', () => {
    const options = fixture();
    const handle = openDb(options.dbPath, { wal: false });
    try {
      expect(assembleVerifiedTransferSourcesStore(options, handle).mode).toBe('unavailable');
    } finally {
      handle.close();
    }
  });

  it('健康句柄不创建缺失文件，不接受WAL或附属文件', () => {
    const options = fixture();
    const missing = join(options.root, 'missing.db');
    expect(() => openVerifiedTransferDb(missing)).toThrow();
    expect(existsSync(missing)).toBe(false);
    writeFileSync(options.dbPath + '-journal', '未封闭');
    expect(() => openVerifiedTransferDb(options.dbPath)).toThrow();
    expect(readFileSync(options.dbPath + '-journal', 'utf8')).toBe('未封闭');
  });

  it('Research工厂装配失败关闭健康句柄，激活不能复活失败服务', () => {
    const options = fixture('research');
    const entry = openVerifiedTransferDb(options.dbPath);
    const before = hash(options.dbPath);
    const result = assembleVerifiedTransferResearchStore(
      {
        ...options,
        buildRuntimeFactory: () => {
          throw new Error('注入装配失败');
        },
      },
      entry.handle,
    );
    expect(result.mode).toBe('unavailable');
    expect(entry.handle.isOpen).toBe(false);
    expect(() => entry.activateWrites()).toThrow();
    expect(hash(options.dbPath)).toBe(before);
  });

  it('已激活或路径不匹配的句柄不能用于健康装配', () => {
    const options = fixture();
    const entry = openVerifiedTransferDb(options.dbPath);
    entry.activateWrites();
    expect(assembleVerifiedTransferSourcesStore(options, entry.handle).mode).toBe('unavailable');
    const another = openVerifiedTransferDb(options.dbPath);
    expect(
      assembleVerifiedTransferSourcesStore(
        { ...options, dbPath: join(options.root, 'other.db') },
        another.handle,
      ).mode,
    ).toBe('unavailable');
    expect(another.handle.isOpen).toBe(false);
  });
});
