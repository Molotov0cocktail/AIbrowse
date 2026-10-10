import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { MIGRATIONS } from '../../src/main/sources/db/migrations';
import { RESEARCH_MIGRATIONS } from '../../src/main/research/db/research-migrations';
import { WATCH_MIGRATIONS } from '../../src/main/watch/db/watch-migrations';
import { assertStartupProbeInputs, runStartupProbe } from '../../src/main/storage/startup-probe';
import {
  STARTUP_PROBE_DOMAINS,
  type StartupProbeDomain,
} from '../../src/main/storage/startup-probe-protocol';

const scope = resolve(
  'log/stage7-e2',
  `startup-closed-wal-independent-${randomUUID().replaceAll('-', '')}`,
);
mkdirSync(scope);
writeFileSync(
  join(scope, 'intent.json'),
  JSON.stringify({
    purpose: '独立合成三域正控和跨域迟到WAL、根替换、孤立SHM及主进程严格复核反例',
    maxDatabasesPerTest: 3,
    maxBytesPerTest: 8 * 1024 * 1024,
    maxWorkMsPerTest: 30000,
    actualProfiles: false,
    electron: false,
  }),
  { flag: 'wx' },
);
afterEach(() => vi.restoreAllMocks());

function profile(label: string): string {
  const root = join(scope, label);
  mkdirSync(root);
  return root;
}
const control = () => ({
  signal: new AbortController().signal,
  deadline: performance.now() + 10000,
});
function seed(root: string, id: StartupProbeDomain, wal = true): string {
  mkdirSync(join(root, id));
  const file = join(root, id, `${id}.db`);
  const db = new DatabaseSync(file);
  try {
    if (wal) db.exec('PRAGMA journal_mode=WAL');
    const steps =
      id === 'sources' ? MIGRATIONS : id === 'research' ? RESEARCH_MIGRATIONS : WATCH_MIGRATIONS;
    for (const step of steps) {
      for (const sql of step.statements) db.exec(sql);
      db.exec(`PRAGMA user_version=${step.version}`);
    }
  } finally {
    db.close();
  }
  expect(existsSync(file + '-wal')).toBe(false);
  return file;
}
function facts(file: string) {
  const stat = lstatSync(file, { bigint: true });
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  };
}
function byteCount(path: string): number {
  const stat = lstatSync(path);
  return stat.isDirectory()
    ? readdirSync(path).reduce((sum, name) => sum + byteCount(join(path, name)), 0)
    : stat.size;
}
function onClose(file: string, action: () => void): () => number {
  const close = DatabaseSync.prototype.close;
  let calls = 0;
  vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
    const matched = this.prepare('PRAGMA database_list')
      .all()
      .some((row) => row.file === file);
    close.call(this);
    if (matched) {
      calls++;
      action();
    }
  });
  return () => calls;
}

it('独立三域关闭WAL正控保持主库全部元数据和字节，逐域登记空WAL', async () => {
  const root = profile('three-domains');
  const files = STARTUP_PROBE_DOMAINS.map((id) => seed(root, id));
  const before = files.map(facts);
  const result = await runStartupProbe(root, control());
  expect(result.state).toBe('normal');
  if (result.state === 'recovery-required') throw new Error('三域预检未通过');
  expect(result.members.map((member) => member.version)).toEqual([1, 1, 5]);
  expect(result.members.every((member) => member.wal?.size === '0')).toBe(true);
  expect(files.map(facts)).toEqual(before);
  await expect(assertStartupProbeInputs(root, result, () => {})).resolves.toBeUndefined();
  expect(byteCount(root)).toBeLessThan(8 * 1024 * 1024);
  writeFileSync(join(scope, 'three-domains.json'), JSON.stringify({ before, result }), {
    flag: 'wx',
  });
}, 30000);

it.each(['replace-bound', 'late-after-absent'] as const)(
  '后域关闭后不得重新认领前域的 %s WAL',
  async (mode) => {
    const root = profile(mode);
    const first = seed(root, 'sources', mode === 'replace-bound');
    const second = seed(root, 'research');
    const calls = onClose(second, () => {
      if (mode === 'replace-bound') renameSync(first + '-wal', first + '-wal-retained');
      writeFileSync(first + '-wal', '', { flag: 'wx' });
    });
    expect(await runStartupProbe(root, control())).toEqual({
      state: 'recovery-required',
      code: 'input-changed',
      domain: 'research',
    });
    expect(calls()).toBe(1);
    expect(byteCount(root)).toBeLessThan(8 * 1024 * 1024);
  },
  30000,
);

it('当前域的允许转换不接受尚未打开的后域新增空WAL', async () => {
  const root = profile('future-domain');
  const first = seed(root, 'sources');
  const second = seed(root, 'research');
  const calls = onClose(first, () => writeFileSync(second + '-wal', '', { flag: 'wx' }));
  expect(await runStartupProbe(root, control())).toEqual({
    state: 'recovery-required',
    code: 'input-changed',
    domain: 'sources',
  });
  expect(calls()).toBe(1);
  expect(byteCount(root)).toBeLessThan(8 * 1024 * 1024);
}, 30000);

it('即使域目录与数据库仍是原身份，也拒绝关闭边界后的root替换', async () => {
  const root = profile('root-replaced');
  const file = seed(root, 'sources');
  const before = facts(file);
  const calls = onClose(file, () => {
    renameSync(root, root + '-retained');
    mkdirSync(root);
    renameSync(join(root + '-retained', 'sources'), join(root, 'sources'));
  });
  expect(await runStartupProbe(root, control())).toEqual({
    state: 'recovery-required',
    code: 'input-changed',
    domain: 'sources',
  });
  expect(calls()).toBe(1);
  expect(facts(file)).toEqual(before);
  expect(byteCount(root)).toBeLessThan(8 * 1024 * 1024);
}, 30000);

it('允许当前域空WAL也不能忽略其它缺库域的孤立SHM', async () => {
  const root = profile('orphan-shm');
  const file = seed(root, 'sources');
  mkdirSync(join(root, 'watch'));
  const calls = onClose(file, () =>
    writeFileSync(join(root, 'watch', 'watch.db-shm'), '', { flag: 'wx' }),
  );
  expect((await runStartupProbe(root, control())).state).toBe('recovery-required');
  expect(calls()).toBe(1);
  expect(byteCount(root)).toBeLessThan(8 * 1024 * 1024);
}, 30000);

it('主进程复核不得为结果中缺失的WAL再次应用空文件豁免', async () => {
  const root = profile('main-strict');
  const file = seed(root, 'sources', false);
  const result = await runStartupProbe(root, control());
  expect(result.state).toBe('normal');
  if (result.state === 'recovery-required') throw new Error('DELETE正控未通过');
  expect(result.members[0]?.wal).toBeNull();
  writeFileSync(file + '-wal', '', { flag: 'wx' });
  await expect(assertStartupProbeInputs(root, result, () => {})).rejects.toThrow();
  expect(byteCount(root)).toBeLessThan(8 * 1024 * 1024);
}, 30000);
