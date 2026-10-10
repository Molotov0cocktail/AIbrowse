import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { padPrivateFixture } from './padding';
import { backupOwnedFixture } from './backup';
const root = join(process.cwd(), 'log/stage7-e2/physical-capacity-small-backup');
mkdirSync(root, { recursive: true });
function small() {
  const scope = mkdtempSync(join(root, 'small-'));
  const path = join(scope, 'source.db');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE business(value TEXT); INSERT INTO business VALUES('合成哨兵');");
  padPrivateFixture(db, 1024 ** 2, () => {});
  db.close();
  return { path, target: join(scope, 'backup.db') };
}
it('实际小SQLite backup保留精确页数与freelist、业务，原件字节不变', async () => {
  const f = small(),
    before = readFileSync(f.path);
  const journal = await backupOwnedFixture(f.path, f.target, 1024 ** 2, () => {});
  expect(journal).toMatchObject({
    budgetBytes: 134217728,
    finalAbsent: true,
    continuousPeakVerified: false,
  });
  expect(journal).toHaveProperty('maxObservedBytes');
  expect(statSync(f.target).size).toBe(1024 ** 2);
  expect(readFileSync(f.path)).toEqual(before);
  const db = new DatabaseSync(f.target, { readOnly: true });
  try {
    expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    expect(Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count)).toBeGreaterThan(0);
    expect(db.prepare('SELECT value FROM business').get()?.value).toBe('合成哨兵');
  } finally {
    db.close();
  }
});

it('backup运行期的未知目标成员不能被结束时的已知sidecar检查漏过', async () => {
  const f = small();
  let calls = 0;
  const close = vi.spyOn(DatabaseSync.prototype, 'close');
  try {
    await expect(
      backupOwnedFixture(f.path, f.target, 1024 ** 2, () => {
        if (++calls === 2) writeFileSync(f.target + '-unexpected', '保留敌手标记');
      }),
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    close.mockRestore();
  }
  expect(readFileSync(f.target + '-unexpected', 'utf8')).toBe('保留敌手标记');
  expect(statSync(f.target).isFile()).toBe(true);
});
it('已有目标不能覆盖，长度错误和期限失败保留原件', async () => {
  const f = small(),
    before = readFileSync(f.path);
  writeFileSync(f.target, '保留');
  await expect(backupOwnedFixture(f.path, f.target, 1024 ** 2, () => {})).rejects.toThrow();
  expect(readFileSync(f.target, 'utf8')).toBe('保留');
  await expect(backupOwnedFixture(f.path, f.target + '.wrong', 4096, () => {})).rejects.toThrow();
  await expect(
    backupOwnedFixture(f.path, f.target + '.deadline', 1024 ** 2, () => {
      throw new Error('截止');
    }),
  ).rejects.toThrow('截止');
  expect(readFileSync(f.path)).toEqual(before);
});
it('源附属文件在打开SQLite前拒绝，不消耗未封闭WAL', async () => {
  const f = small(),
    before = readFileSync(f.path);
  writeFileSync(f.path + '-wal', '保留失败附属文件');
  await expect(backupOwnedFixture(f.path, f.target, 1024 ** 2, () => {})).rejects.toThrow();
  expect(readFileSync(f.path)).toEqual(before);
  expect(readFileSync(f.path + '-wal', 'utf8')).toBe('保留失败附属文件');
});
it('备份期间期限失败保留实际部分目标和原件，不自动重试', async () => {
  const f = small(),
    before = readFileSync(f.path);
  let calls = 0;
  await expect(
    backupOwnedFixture(f.path, f.target, 1024 ** 2, () => {
      if (++calls === 2) throw new Error('备份中截止');
    }),
  ).rejects.toThrow();
  expect(statSync(f.target).isFile()).toBe(true);
  expect(readFileSync(f.path)).toEqual(before);
});
