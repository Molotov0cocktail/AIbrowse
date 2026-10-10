import {
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fileFact } from '../full-transfer/io';
import { boundedIdentity, createJournalGuard } from './journal';
import { JOURNAL_BYTES } from './contract';

const root = join(process.cwd(), 'log/stage7-e2/physical-capacity-journal-repair-001');
mkdirSync(root, { recursive: true });
function fixture() {
  const directory = mkdtempSync(join(root, 'guard-'));
  const source = join(directory, 'source.db'),
    target = join(directory, 'backup.db');
  writeFileSync(source, '原件');
  closeSync(openSync(target, 'wx'));
  const guard = createJournalGuard(source, target, Buffer.byteLength('原件'));
  return { directory, source, target, journal: target + '-journal', guard };
}

it('按独立预算拒绝超界和非整数事实，不创建128MiB测试文件', () => {
  const f = fixture(),
    initial = fileFact(f.target);
  expect(boundedIdentity({ ...initial, size: String(JOURNAL_BYTES) }, initial, JOURNAL_BYTES)).toBe(
    JOURNAL_BYTES,
  );
  for (const size of [String(JOURNAL_BYTES + 1), '-1', 'NaN', '1.5', '9007199254740992'])
    expect(() => boundedIdentity({ ...initial, size }, initial, JOURNAL_BYTES)).toThrow();
  for (const changed of [{ ino: '替代' }, { dev: '替代' }, { nlink: '2' }])
    expect(() => boundedIdentity({ ...initial, ...changed }, initial, JOURNAL_BYTES)).toThrow();
});

it('记录离散最大观测且只允许SQLite退役唯一journal，完成不可重入', () => {
  const f = fixture();
  f.guard.observe();
  writeFileSync(f.journal, Buffer.alloc(512));
  f.guard.observe();
  writeFileSync(f.journal, Buffer.alloc(1024));
  f.guard.observe();
  // Only this synthetic journal is retired to model SQLite's successful cleanup.
  rmSync(f.journal);
  expect(f.guard.finish()).toEqual({
    budgetBytes: JOURNAL_BYTES,
    maxObservedBytes: 1024,
    observations: 4,
    journalObservations: 2,
    finalAbsent: true,
    continuousPeakVerified: false,
  });
  expect(() => f.guard.observe()).toThrow();
});

it.each([
  'source.db-journal',
  'source.db-wal',
  'source.db-shm',
  'backup.db-wal',
  'backup.db-shm',
  'backup.db-extra',
])('拒绝未知或源附属成员%s并锁存失败', (name) => {
  const f = fixture();
  const path = join(f.directory, name);
  writeFileSync(path, '敌手标记');
  expect(() => f.guard.observe()).toThrow();
  expect(() => f.guard.finish()).toThrow();
  expect(readFileSync(path, 'utf8')).toBe('敌手标记');
});

it('拒绝journal硬链接且保留源文件', () => {
  const f = fixture();
  linkSync(f.source, f.journal);
  expect(() => f.guard.observe()).toThrow();
  expect(readFileSync(f.source, 'utf8')).toBe('原件');
});

it.each(['source', 'target', 'journal'] as const)(
  '路径%s身份替换不能继续，替代前后原件都保留',
  (kind) => {
    const f = fixture();
    writeFileSync(f.journal, 'journal');
    f.guard.observe();
    const path = f[kind];
    // The destination is a separately created sibling in this owned synthetic root.
    const archive = mkdtempSync(join(root, 'archived-'));
    renameSync(path, join(archive, kind));
    writeFileSync(path, '替代');
    expect(() => f.guard.observe()).toThrow();
    expect(() => f.guard.finish()).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('替代');
  },
);

it('结束仍存在journal不能授成功，不删除失败文件', () => {
  const f = fixture();
  writeFileSync(f.journal, '未结算');
  expect(() => f.guard.finish()).toThrow();
  expect(readFileSync(f.journal, 'utf8')).toBe('未结算');
});
