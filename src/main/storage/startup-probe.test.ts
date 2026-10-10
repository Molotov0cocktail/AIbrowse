import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { runStartupProbe, assertStartupProbeInputs } from './startup-probe';
import { MIGRATIONS } from '../sources/db/migrations';
import { RESEARCH_MIGRATIONS } from '../research/db/research-migrations';
import { WATCH_MIGRATIONS } from '../watch/db/watch-migrations';
import type { StartupProbeDomain } from './startup-probe-protocol';
import { historicalWatchMigrationSteps } from './transfer-schema';
import * as layout from './dataset-layout';
const root = fs.mkdtempSync(join(tmpdir(), 'startup-probe-'));
const handles: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of handles.splice(0)) if (db.isOpen) db.close();
});
it('binds only the empty auxiliary WAL created by a closed clean WAL-mode database read', async () => {
  const path = profile();
  const db = database(path, 'sources', undefined, true);
  db.close();
  const file = join(path, 'sources/sources.db');
  const before = fs.readFileSync(file);
  expect(fs.existsSync(file + '-wal')).toBe(false);
  const result = await runStartupProbe(path, control());
  expect(result.state).toBe('normal');
  if (result.state === 'recovery-required') throw new Error('错误结果');
  expect(result.members[0]?.wal).toMatchObject({ size: '0' });
  expect(fs.readFileSync(file)).toEqual(before);
  await expect(assertStartupProbeInputs(path, result, () => {})).resolves.toBeUndefined();
  fs.renameSync(file + '-wal', file + '-wal-retained');
  fs.writeFileSync(file + '-wal', '', { flag: 'wx' });
  await expect(assertStartupProbeInputs(path, result, () => {})).rejects.toThrow();
});

it.each(['new-nonempty', 'database', 'journal', 'linked', 'parent', 'existing-wal'] as const)(
  'rejects %s changes at the original read-only SQLite close boundary',
  async (mutation) => {
    const path = profile();
    const db = database(path, 'sources', undefined, true);
    db.close();
    const file = join(path, 'sources/sources.db');
    if (mutation === 'existing-wal') fs.writeFileSync(file + '-wal', '', { flag: 'wx' });
    const close = DatabaseSync.prototype.close;
    let changed = false;
    vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
      const target = this.prepare('PRAGMA database_list')
        .all()
        .some((row) => row.file === file);
      close.call(this);
      if (!target) return;
      changed = true;
      if (mutation === 'new-nonempty') fs.appendFileSync(file + '-wal', 'x');
      else if (mutation === 'database')
        fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
      else if (mutation === 'journal') fs.writeFileSync(file + '-journal', '', { flag: 'wx' });
      else if (mutation === 'linked') fs.linkSync(file + '-wal', join(path, 'retained-link'));
      else if (mutation === 'existing-wal') {
        fs.renameSync(file + '-wal', file + '-wal-retained');
        fs.writeFileSync(file + '-wal', '', { flag: 'wx' });
      } else {
        fs.renameSync(join(path, 'sources'), join(path, 'retained-sources'));
        fs.mkdirSync(join(path, 'sources'));
        fs.copyFileSync(join(path, 'retained-sources/sources.db'), file);
        fs.writeFileSync(file + '-wal', '', { flag: 'wx' });
      }
    });
    expect((await runStartupProbe(path, control())).state).toBe('recovery-required');
    expect(changed).toBe(true);
  },
);

it('rejects replacement after the first empty WAL observation, before final group verification', async () => {
  const path = profile();
  database(path, 'sources', undefined, true).close();
  const file = join(path, 'sources/sources.db');
  const checkedStat = layout.checkedStat;
  let changed = false;
  vi.spyOn(layout, 'checkedStat').mockImplementation(async (...args) => {
    const value = await checkedStat(...args);
    if (args[0] === file + '-wal' && value !== null && !changed) {
      changed = true;
      fs.renameSync(file + '-wal', file + '-wal-retained');
      fs.writeFileSync(file + '-wal', '', { flag: 'wx' });
    }
    return value;
  });
  expect((await runStartupProbe(path, control())).state).toBe('recovery-required');
  expect(changed).toBe(true);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const control = () => ({
  signal: new AbortController().signal,
  deadline: performance.now() + 10000,
});
const profile = () => {
  const path = join(root, randomUUID());
  fs.mkdirSync(path);
  return path;
};
function database(
  path: string,
  id: StartupProbeDomain,
  version?: number,
  wal = false,
): DatabaseSync {
  fs.mkdirSync(join(path, id));
  const db = new DatabaseSync(join(path, id, `${id}.db`));
  handles.push(db);
  if (wal) db.exec('PRAGMA journal_mode=WAL');
  const steps =
    id === 'sources' ? MIGRATIONS : id === 'research' ? RESEARCH_MIGRATIONS : WATCH_MIGRATIONS;
  for (const step of steps) {
    if (step.version > (version ?? steps.length)) break;
    for (const sql of step.statements) db.exec(sql);
    db.exec(`PRAGMA user_version=${step.version}`);
  }
  return db;
}
it('admits an empty profile without creating any Store files', async () => {
  const path = profile();
  const result = await runStartupProbe(path, control());
  expect(result.state).toBe('normal');
  expect(fs.readdirSync(path)).toEqual([]);
});
it('reads committed schema from WAL rather than the main-file user_version header', async () => {
  const path = profile();
  database(path, 'sources', undefined, true);
  const file = join(path, 'sources/sources.db');
  const sha = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const before = [sha(file), sha(file + '-wal')];
  expect(fs.readFileSync(file).readInt32BE(60)).toBe(0);
  const result = await runStartupProbe(path, control());
  expect(result.state).toBe('normal');
  if (result.state === 'recovery-required') throw new Error('错误结果');
  expect(result.members[0]).toMatchObject({ version: 1, state: 'current' });
  expect([sha(file), sha(file + '-wal')]).toEqual(before);
  await expect(assertStartupProbeInputs(path, result, () => {})).resolves.toBeUndefined();
});
it('routes known old Watch schema to one batch migration', async () => {
  const path = profile();
  database(path, 'watch', 2);
  expect((await runStartupProbe(path, control())).state).toBe('migrate');
});
it.each(['future', 'corrupt', 'orphan'] as const)(
  'blocks %s before any missing Store is created',
  async (kind) => {
    const path = profile();
    fs.mkdirSync(join(path, 'research'));
    if (kind === 'future') {
      const db = new DatabaseSync(join(path, 'research/research.db'));
      db.exec('PRAGMA user_version=99');
      db.close();
    } else
      fs.writeFileSync(
        join(path, 'research/research.db' + (kind === 'orphan' ? '-wal' : '')),
        'preserved',
      );
    expect((await runStartupProbe(path, control())).state).toBe('recovery-required');
    expect(fs.existsSync(join(path, 'sources'))).toBe(false);
  },
);
it('blocks foreign-key corruption without opening a missing second Store', async () => {
  const path = profile();
  const db = database(path, 'sources');
  db.exec('PRAGMA foreign_keys=OFF');
  db.prepare(
    "INSERT INTO sources(id,scope,canonical_key,url,name,group_id,created_at,updated_at) VALUES(?,'page','https://example.com/','https://example.com/','name','orphan',?,?)",
  ).run(randomUUID(), '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
  expect(await runStartupProbe(path, control())).toEqual({
    state: 'recovery-required',
    code: 'integrity',
    domain: 'sources',
  });
  expect(fs.existsSync(join(path, 'research'))).toBe(false);
});
it('recognizes historical Watch table spelling at the current version as requiring migration', async () => {
  const path = profile();
  const db = database(path, 'watch', 0);
  for (const step of historicalWatchMigrationSteps()) {
    for (const sql of step.statements) db.exec(sql);
    db.exec(`PRAGMA user_version=${step.version}`);
  }
  const result = await runStartupProbe(path, control());
  expect(result.state).toBe('migrate');
  if (result.state !== 'recovery-required')
    expect(result.members[2]).toMatchObject({ state: 'legacy', version: 5 });
});
it('accepts an actual empty version-zero file without initializing it', async () => {
  const path = profile();
  fs.mkdirSync(join(path, 'research'));
  const file = join(path, 'research/research.db');
  fs.writeFileSync(file, '');
  const result = await runStartupProbe(path, control());
  expect(result.state).toBe('normal');
  if (result.state !== 'recovery-required')
    expect(result.members[1]).toMatchObject({ state: 'empty', version: 0 });
  expect(fs.statSync(file).size).toBe(0);
});
it('blocks a file changed between successful utility inspection and main Store acquisition', async () => {
  const path = profile();
  database(path, 'research');
  const result = await runStartupProbe(path, control());
  if (result.state === 'recovery-required') throw new Error('夹具错误');
  fs.appendFileSync(join(path, 'research/research.db'), 'late');
  await expect(assertStartupProbeInputs(path, result, () => {})).rejects.toThrow(
    '启动数据预检失败',
  );
});
it.each(['cancelled', 'deadline'] as const)('preserves a pre-start %s failure', async (code) => {
  const path = profile();
  const abort = new AbortController();
  if (code === 'cancelled') abort.abort();
  expect(
    await runStartupProbe(path, {
      signal: abort.signal,
      deadline: code === 'deadline' ? performance.now() - 1 : performance.now() + 10000,
    }),
  ).toMatchObject({ state: 'recovery-required', code });
  expect(fs.readdirSync(path)).toEqual([]);
});
