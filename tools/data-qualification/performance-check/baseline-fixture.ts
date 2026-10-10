import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS } from '../../../src/main/sources/db/migrations';
import { createSmallFixture } from '../product-restore-fixtures/seed';

const COUNT = 5_000;
const STAMP = '2026-10-10T00:00:00.000Z';
const TABLES = {
  sources: [
    'sources',
    'source_groups',
    'source_tags',
    'source_tag_links',
    'change_journal',
    'usage_events',
  ],
  research: [
    'research_tasks',
    'research_candidates',
    'research_captures',
    'research_evidence',
    'research_claims',
    'research_conflicts',
    'research_results',
  ],
  watch: [
    'watch_rules',
    'watch_baselines',
    'watch_runs',
    'watch_audits',
    'watch_events',
    'watch_event_observations',
    'watch_event_items',
    'source_cleanup_intents',
    'digest_change_state',
    'digest_change_journal',
    'digest_schedules',
    'digest_runs',
    'watch_digests',
    'digest_event_refs',
    'notification_outbox',
  ],
} as const;

export interface BaselineFixtureReceipt {
  readonly version: 1;
  readonly sources: 5_000;
  readonly queryTokens: readonly string[];
  readonly digest: string;
}

export interface PersistenceReceipt {
  readonly version: 1;
  readonly audits: readonly Readonly<Record<string, unknown>>[];
  readonly tables: Readonly<Record<string, Readonly<{ rows: number; sha256: string }>>>;
  readonly conversations: Readonly<{ files: readonly string[]; sha256: string }>;
}

function rowsDigest(db: DatabaseSync, table: string): { rows: number; sha256: string } {
  if (!/^[a-z_]+$/u.test(table)) throw new Error('持久化表名无效');
  const definition = db.prepare('SELECT wr FROM pragma_table_list WHERE name=?').get(table);
  if (definition === undefined) throw new Error('持久化表缺失');
  let sql = `SELECT rowid AS qualification_rowid,* FROM ${table} ORDER BY rowid`;
  if (definition.wr === 1) {
    const keys = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .filter((value) => typeof value.pk === 'number' && value.pk > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((value) => value.name);
    if (
      keys.length === 0 ||
      keys.some((value) => typeof value !== 'string' || !/^[a-z_]+$/u.test(value))
    )
      throw new Error('持久化主键无效');
    sql = `SELECT * FROM ${table} ORDER BY ${keys.join(',')}`;
  }
  const rows = db.prepare(sql).all();
  return {
    rows: rows.length,
    sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function capturePersistence(profile: string): PersistenceReceipt {
  const tables: Record<string, { rows: number; sha256: string }> = {};
  let audits: readonly Readonly<Record<string, unknown>>[] = [];
  for (const [domain, names] of Object.entries(TABLES)) {
    const db = new DatabaseSync(join(profile, domain, `${domain}.db`), {
      readOnly: true,
      allowExtension: false,
    });
    try {
      if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') {
        throw new Error(`${domain}完整性失败`);
      }
      if (db.prepare('PRAGMA foreign_key_check').get() !== undefined) {
        throw new Error(`${domain}外键失败`);
      }
      for (const table of names) tables[`${domain}.${table}`] = rowsDigest(db, table);
      if (domain === 'watch')
        audits = db.prepare('SELECT * FROM watch_audits ORDER BY created_at,id').all();
    } finally {
      db.close();
    }
  }
  const directory = join(profile, 'conversations');
  const files = readdirSync(directory).sort();
  const digest = createHash('sha256');
  for (const name of files) {
    if (!/^(?:index|[a-f0-9-]{36})\.json$/u.test(name)) throw new Error('会话文件名无效');
    const parsed: unknown = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    digest.update(name).update('\0').update(canonical(parsed)).update('\0');
  }
  return Object.freeze({
    version: 1,
    audits: Object.freeze(audits.map((row) => Object.freeze({ ...row }))),
    tables: Object.freeze(tables),
    conversations: Object.freeze({ files: Object.freeze(files), sha256: digest.digest('hex') }),
  });
}

export function verifyStartupAudits(
  value: unknown,
  windows: readonly Readonly<{ startedAt: number; endedAt: number }>[],
): void {
  if (
    !Array.isArray(value) ||
    value.length !== windows.length ||
    windows.length < 1 ||
    windows.length > 7
  )
    throw new Error('启动审计数量不符');
  const ids = new Set<string>();
  const claimed = new Set<number>();
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
      throw new Error('启动审计形状不符');
    const row = item as Record<string, unknown>;
    if (
      Object.keys(row).sort().join('|') !== 'created_at|id|kind|reason_code|rule_id' ||
      typeof row.id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(row.id) ||
      ids.has(row.id) ||
      row.rule_id !== null ||
      row.kind !== 'reconciliation' ||
      row.reason_code !== 'complete' ||
      typeof row.created_at !== 'string'
    )
      throw new Error('启动审计内容不符');
    ids.add(row.id);
    const instant = Date.parse(row.created_at);
    if (!Number.isFinite(instant) || new Date(instant).toISOString() !== row.created_at)
      throw new Error('启动审计时间无效');
    const matches = windows
      .map((window, index) => ({ window, index }))
      .filter(
        ({ window }) =>
          Number.isFinite(window.startedAt) &&
          Number.isFinite(window.endedAt) &&
          window.endedAt >= window.startedAt &&
          instant >= window.startedAt &&
          instant <= window.endedAt,
      );
    if (matches.length !== 1 || claimed.has(matches[0]!.index))
      throw new Error('启动审计未绑定唯一真实进程时窗');
    claimed.add(matches[0]!.index);
  }
}

function fileHash(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('持久化原件不是普通文件');
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fixedFiles(profile: string): Readonly<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const domain of Object.keys(TABLES)) {
    const directory = join(profile, domain);
    const expected = `${domain}.db`;
    const names = readdirSync(directory).sort();
    if (names.length !== 1 || names[0] !== expected) throw new Error(`${domain}持久化文件集无效`);
    files[`${domain}/${expected}`] = fileHash(join(directory, expected));
  }
  const conversationDirectory = join(profile, 'conversations');
  const conversations = readdirSync(conversationDirectory).sort();
  if (
    conversations.length === 0 ||
    conversations.some((name) => !/^(?:index|[a-f0-9-]{36})\.json$/u.test(name))
  )
    throw new Error('会话持久化文件集无效');
  for (const name of conversations)
    files[`conversations/${name}`] = fileHash(join(conversationDirectory, name));
  return Object.freeze(files);
}

export function capturePersistenceCopy(
  profile: string,
  inspectionRoot: string,
): PersistenceReceipt {
  const before = fixedFiles(profile);
  mkdirSync(inspectionRoot);
  for (const relative of Object.keys(before)) {
    const parts = relative.split('/');
    const destination = join(inspectionRoot, ...parts);
    mkdirSync(join(destination, '..'), { recursive: true });
    copyFileSync(join(profile, ...parts), destination, constants.COPYFILE_EXCL);
  }
  const after = fixedFiles(profile);
  if (JSON.stringify(after) !== JSON.stringify(before))
    throw new Error('持久化原件在副本捕获期间改变');
  return capturePersistence(inspectionRoot);
}

export function prepareBaselineSources(
  profile: string,
  allowSmallSeed = false,
): BaselineFixtureReceipt {
  const directory = join(profile, 'sources');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'sources.db');
  const exists = readdirSync(directory).includes('sources.db');
  const db = new DatabaseSync(path, { allowExtension: false });
  const digest = createHash('sha256');
  try {
    if (!exists)
      for (const step of MIGRATIONS) {
        for (const statement of step.statements) db.exec(statement);
        db.exec(`PRAGMA user_version=${step.version}`);
      }
    const existing = db.prepare('SELECT count(*) AS count FROM sources').get() as { count: number };
    if (
      !Number.isSafeInteger(existing.count) ||
      existing.count < 0 ||
      existing.count > COUNT ||
      (existing.count !== 0 && !(allowSmallSeed && existing.count === 1))
    )
      throw new Error('Sources已有计数无效');
    const insert = db.prepare(`INSERT INTO sources
      (id,scope,canonical_key,url,name,share_mode,trust_verification,created_at,updated_at)
      VALUES (?,'page',?,?,?,'metadata','asserted',?,?)`);
    db.exec('BEGIN');
    try {
      for (let index = 0; index < COUNT - existing.count; index += 1) {
        const id = `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
        const url = `https://performance.invalid/source/${index}`;
        const name = `PERF_SOURCE_${index.toString().padStart(4, '0')} PERF_QUERY_${index % 10}`;
        insert.run(id, url, url, name, STAMP, STAMP);
        digest.update(`${id}\0${url}\0${name}\n`);
      }
      db.exec("INSERT INTO sources_fts(sources_fts) VALUES ('rebuild')");
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const count = db.prepare('SELECT count(*) AS count FROM sources').get() as { count: number };
    const indexed = db.prepare('SELECT count(*) AS count FROM sources_fts').get() as {
      count: number;
    };
    if (count.count !== COUNT || indexed.count !== COUNT) throw new Error('Sources夹具计数失败');
  } finally {
    db.close();
  }
  return Object.freeze({
    version: 1,
    sources: COUNT,
    queryTokens: Object.freeze(Array.from({ length: 10 }, (_, index) => `PERF_QUERY_${index}`)),
    digest: digest.digest('hex'),
  });
}

export function seedPerformanceProfile(profile: string): void {
  createSmallFixture(profile, 'A');
  const fixture = prepareBaselineSources(profile, true);
  writeFileSync(join(profile, '..', 'baseline-fixture.json'), JSON.stringify(fixture), {
    flag: 'wx',
  });
  writeFileSync(
    join(profile, '..', 'persistence-seed.json'),
    JSON.stringify(capturePersistenceCopy(profile, join(profile, '..', 'persistence-before'))),
    { flag: 'wx' },
  );
}
