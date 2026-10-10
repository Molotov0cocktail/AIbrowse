import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import process from 'node:process';
import { URL } from 'node:url';

// Caller establishes ownership of an empty synthetic profile and natural process exit.
// Only copies of three closed databases are opened. No credential or browser files are read.
const [rootArgument, outputArgument, layout = 'profile'] = process.argv.slice(2);
if (
  !rootArgument ||
  !outputArgument ||
  process.argv.length > 5 ||
  !isAbsolute(rootArgument) ||
  !isAbsolute(outputArgument) ||
  !['profile', 'work'].includes(layout)
)
  throw new Error('需要合成数据绝对路径、新证据目录和 profile/work 布局');
const root = resolve(rootArgument);
const output = resolve(outputArgument);
if (output === root || output.startsWith(root + '\\') || existsSync(output))
  throw new Error('证据目录必须是数据根外的新目录');
const rootStat = lstatSync(root, { bigint: true });
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('合成数据根无效');
const queries = {
  sources: [
    'SELECT * FROM sources ORDER BY id',
    'SELECT * FROM source_groups ORDER BY id',
    'SELECT * FROM source_tags ORDER BY id',
    'SELECT * FROM source_tag_links ORDER BY source_id,tag_id',
    'SELECT * FROM change_journal ORDER BY idempotency_key',
    'SELECT * FROM usage_events ORDER BY source_id',
  ],
  research: [
    'SELECT * FROM research_tasks ORDER BY id',
    'SELECT * FROM research_candidates ORDER BY candidate_id',
    'SELECT * FROM research_captures ORDER BY capture_id',
    'SELECT * FROM research_evidence ORDER BY evidence_id',
    'SELECT * FROM research_claims ORDER BY claim_id',
    'SELECT * FROM research_conflicts ORDER BY conflict_id',
    'SELECT * FROM research_results ORDER BY result_id',
  ],
  watch: [
    'SELECT * FROM watch_rules ORDER BY id',
    'SELECT * FROM watch_baselines ORDER BY rule_id',
    'SELECT * FROM watch_runs ORDER BY id',
    'SELECT * FROM watch_audits ORDER BY id',
    'SELECT * FROM watch_events ORDER BY id',
    'SELECT * FROM watch_event_observations ORDER BY id',
    'SELECT * FROM watch_event_items ORDER BY id',
    'SELECT * FROM digest_change_state ORDER BY id',
    'SELECT * FROM digest_change_journal ORDER BY sequence',
    'SELECT * FROM digest_schedules ORDER BY id',
    'SELECT * FROM digest_runs ORDER BY id',
    'SELECT * FROM watch_digests ORDER BY id',
    'SELECT * FROM digest_event_refs ORDER BY digest_id,event_id',
    'SELECT * FROM notification_outbox ORDER BY id',
    'SELECT * FROM source_cleanup_intents ORDER BY mutation_id',
  ],
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
const tables = {};
const originals = [];
mkdirSync(output);
for (const [domain, sql] of Object.entries(queries)) {
  const path =
    layout === 'profile' ? join(root, domain, `${domain}.db`) : join(root, `${domain}.db`);
  for (const suffix of ['-wal', '-shm', '-journal'])
    if (existsSync(path + suffix)) throw new Error('数据仍有事务侧文件，停止只读取证');
  const before = lstatSync(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > 16n * 1024n ** 2n
  )
    throw new Error('合成数据库资格或预算失败');
  const bytes = readFileSync(path);
  const hash = digest(bytes);
  const copy = join(output, `${domain}.db`);
  writeFileSync(copy, bytes, { flag: 'wx' });
  if (
    digest(readFileSync(copy)) !== hash ||
    JSON.stringify(identity(before)) !==
      JSON.stringify(identity(lstatSync(path, { bigint: true }))) ||
    digest(readFileSync(path)) !== hash
  )
    throw new Error('数据库复制期间发生变化，原件保留');
  const database = new DatabaseSync(copy, { readOnly: true });
  try {
    const integrity = database.prepare('PRAGMA integrity_check').all();
    if (
      JSON.stringify(integrity) !== '[{"integrity_check":"ok"}]' ||
      database.prepare('PRAGMA foreign_key_check').all().length !== 0
    )
      throw new Error('数据库完整性失败');
    for (const query of sql) {
      const name = query.split(' ')[3];
      const rows = database.prepare(query).all();
      if (rows.length > 10000) throw new Error('合成数据行数超预算');
      tables[name] = { count: rows.length, sha256: digest(JSON.stringify(rows)), rows };
    }
  } finally {
    database.close();
  }
  originals.push({ path, identity: identity(before), bytes: Number(before.size), sha256: hash });
}
for (const original of originals)
  if (
    digest(readFileSync(original.path)) !== original.sha256 ||
    JSON.stringify(identity(lstatSync(original.path, { bigint: true }))) !==
      JSON.stringify(original.identity)
  )
    throw new Error('取证期间原数据库变化');
const report = {
  schema: 1,
  utc: new Date().toISOString(),
  sourceSha256: digest(readFileSync(new URL(import.meta.url))),
  root,
  rootIdentity: [String(rootStat.dev), String(rootStat.ino)],
  layout,
  originals,
  tables,
  credentialsRead: false,
  sqliteOpenedOriginals: false,
  conversationCoverage: '另由产品 R/P 四域验收覆盖；此原生场景未创建会话',
};
writeFileSync(join(output, 'snapshot.json'), JSON.stringify(report, null, 2) + '\n', {
  flag: 'wx',
});
process.stdout.write(
  JSON.stringify({ output, tables: Object.keys(tables).length, sourceRows: tables.sources.rows }) +
    '\n',
);
