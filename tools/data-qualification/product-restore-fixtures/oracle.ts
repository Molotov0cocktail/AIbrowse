import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { validateSourceTransfer } from '../../../src/main/sources/repository/source-transfer-validation';
import { validateResearchTransfer } from '../../../src/main/research/repository/research-transfer-validation';
import { validateWatchTransferDatabase } from '../../../src/main/watch/repository/watch-transfer-validation';
import { validateWatchSourceTransfer } from '../../../src/main/watch/repository/watch-source-transfer-validation';
import { validateTransferSchema } from '../../../src/main/storage/transfer-schema';
import { projectIndex, projectSession } from '../../../src/main/ai/conversation-transfer';
import { DOMAINS, LIMIT, STAMP, LATER, id, watchIds, type Variant } from './seed';
import { EXPECTED } from './expected';

export type Mode = 'source' | 'restored';
type Row = Record<string, SQLOutputValue>;
export type Snapshot = Record<string, unknown>;
// All SQL is compiled here, including empty relationship tables. Never derive SQL from a file.
const QUERIES = {
  sources: {
    sources: 'SELECT * FROM sources ORDER BY id',
    source_groups: 'SELECT * FROM source_groups ORDER BY id',
    source_tags: 'SELECT * FROM source_tags ORDER BY id',
    source_tag_links: 'SELECT * FROM source_tag_links ORDER BY source_id,tag_id',
    change_journal: 'SELECT * FROM change_journal ORDER BY idempotency_key',
    usage_events: 'SELECT * FROM usage_events ORDER BY source_id',
  },
  research: {
    research_tasks: 'SELECT * FROM research_tasks ORDER BY id',
    research_candidates: 'SELECT * FROM research_candidates ORDER BY candidate_id',
    research_captures: 'SELECT * FROM research_captures ORDER BY capture_id',
    research_evidence: 'SELECT * FROM research_evidence ORDER BY evidence_id',
    research_claims: 'SELECT * FROM research_claims ORDER BY claim_id',
    research_conflicts: 'SELECT * FROM research_conflicts ORDER BY conflict_id',
    research_results: 'SELECT * FROM research_results ORDER BY result_id',
  },
  watch: {
    watch_rules: 'SELECT * FROM watch_rules ORDER BY id',
    watch_baselines: 'SELECT * FROM watch_baselines ORDER BY rule_id',
    watch_runs: 'SELECT * FROM watch_runs ORDER BY id',
    watch_audits: 'SELECT * FROM watch_audits ORDER BY id',
    watch_events: 'SELECT * FROM watch_events ORDER BY id',
    watch_event_observations: 'SELECT * FROM watch_event_observations ORDER BY id',
    watch_event_items: 'SELECT * FROM watch_event_items ORDER BY id',
    digest_change_state: 'SELECT * FROM digest_change_state ORDER BY id',
    digest_change_journal: 'SELECT * FROM digest_change_journal ORDER BY sequence',
    digest_schedules: 'SELECT * FROM digest_schedules ORDER BY id',
    digest_runs: 'SELECT * FROM digest_runs ORDER BY id',
    watch_digests: 'SELECT * FROM watch_digests ORDER BY id',
    digest_event_refs: 'SELECT * FROM digest_event_refs ORDER BY digest_id,event_id',
    notification_outbox: 'SELECT * FROM notification_outbox ORDER BY id',
    source_cleanup_intents: 'SELECT * FROM source_cleanup_intents ORDER BY mutation_id',
  },
} as const;

function requireFact(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(`小恢复夹具校验失败：${code}`);
}
function safeSize(path: string): number {
  const stat = lstatSync(path);
  requireFact(stat.isFile() && !stat.isSymbolicLink() && stat.size <= LIMIT, '文件资格');
  return stat.size;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function snapshotHashes(snapshot: Snapshot): Record<string, string> {
  return Object.fromEntries(
    Object.entries(snapshot).map(([key, value]) => [
      key,
      createHash('sha256').update(canonical(value)).digest('hex'),
    ]),
  );
}

/** Caller must supply a quiescent, owned synthetic root, never a live profile. */
export function readSmallSnapshot(
  root: string,
  variant: Variant,
  layout: 'profile' | 'work' = 'profile',
): { snapshot: Snapshot; bytes: number } {
  requireFact(['A', 'B', 'H'].includes(variant), '版本');
  const paths = DOMAINS.map((domain) =>
    layout === 'profile' ? join(root, domain, `${domain}.db`) : join(root, `${domain}.db`),
  );
  const conversation = join(root, 'conversations');
  const names = readdirSync(conversation).sort();
  requireFact(
    JSON.stringify(names) === JSON.stringify([`${id(variant, 9000)}.json`, 'index.json'].sort()),
    '会话文件集合',
  );
  const files = [...paths, ...names.map((name) => join(conversation, name))];
  const bytes = files.reduce((total, path) => total + safeSize(path), 0);
  requireFact(bytes <= LIMIT, '总字节预算');
  for (const path of paths) {
    requireFact(
      !readdirSync(join(path, '..')).some(
        (name) =>
          name === `${path.split(/[\\/]/).at(-1)}-wal` ||
          name === `${path.split(/[\\/]/).at(-1)}-shm` ||
          name === `${path.split(/[\\/]/).at(-1)}-journal`,
      ),
      '数据库未静止',
    );
  }
  const opened: DatabaseSync[] = [];
  const snapshot: Snapshot = {};
  try {
    for (const [n, domain] of DOMAINS.entries()) {
      const db = new DatabaseSync(paths[n], { readOnly: true, allowExtension: false });
      opened.push(db);
      requireFact(validateTransferSchema(db, domain).ok, `${domain} schema`);
      const scan =
        domain === 'sources'
          ? validateSourceTransfer(db)
          : domain === 'research'
            ? validateResearchTransfer(db)
            : validateWatchTransferDatabase(db);
      requireFact(scan.ok, `${domain}语义 ${JSON.stringify(scan)}`);
      requireFact(db.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok', '完整性');
      requireFact(db.prepare('PRAGMA foreign_key_check').all().length === 0, '外键');
      for (const [table, sql] of Object.entries(QUERIES[domain]))
        snapshot[table] = db.prepare(sql).all();
    }
    requireFact(validateWatchSourceTransfer(opened[0], opened[2]).ok, 'Source与Watch关联');
  } finally {
    for (const db of opened) db.close();
  }
  const index: unknown = JSON.parse(readFileSync(join(conversation, 'index.json'), 'utf8'));
  const session: unknown = JSON.parse(
    readFileSync(join(conversation, `${id(variant, 9000)}.json`), 'utf8'),
  );
  projectIndex(index);
  projectSession(session);
  snapshot.conversation_index = index;
  snapshot.conversation_session = session;
  return { snapshot, bytes };
}

function normalizeExpectedChanges(snapshot: Snapshot, variant: Variant, mode: Mode): Snapshot {
  const copy = structuredClone(snapshot);
  if (variant !== 'H' || mode === 'source') return copy;
  const row = (key: string, field: string, value: string): Row => {
    const rows = copy[key] as Row[];
    const found = rows.filter((item) => item[field] === value);
    requireFact(found.length === 1, `${key}主键`);
    return found[0];
  };
  const time = (value: SQLOutputValue | undefined): void =>
    requireFact(
      typeof value === 'string' &&
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString() === value &&
        value >= LATER,
      '规范化时间',
    );
  const task = row('research_tasks', 'id', id('H', 50));
  requireFact(task.status === 'interrupted' && task.phase === null, '研究中断');
  time(task.interrupted_at);
  time(task.updated_at);
  requireFact(task.updated_at === task.interrupted_at, '研究中断时间一致');
  task.status = 'running';
  task.phase = 'reading';
  task.interrupted_at = null;
  task.updated_at = STAMP;
  const identity = watchIds('H');
  const run = row('watch_runs', 'id', identity.watchRun);
  requireFact(run.status === 'interrupted', '采集中断');
  time(run.finished_at);
  requireFact(
    run.finished_at ===
      (snapshot.research_tasks as Row[]).find((item) => item.id === id('H', 50))?.interrupted_at,
    '同批规范化时间',
  );
  run.status = 'running';
  run.finished_at = null;
  const digest = row('watch_digests', 'id', identity.digest);
  requireFact(
    digest.provider_state === 'uncertain' &&
      digest.provider_result_code === 'uncertain-after-restart',
    'Digest不重放',
  );
  time(digest.provider_finished_at);
  requireFact(
    digest.provider_finished_at === (snapshot.watch_runs as Row[])[0].finished_at,
    'Digest同批时间',
  );
  digest.provider_state = 'claimed';
  digest.provider_result_code = null;
  digest.provider_finished_at = null;
  const schedule = row('digest_schedules', 'id', identity.schedule);
  requireFact(schedule.state === 'paused' && schedule.version === 2, 'cycle暂停');
  time(schedule.updated_at);
  requireFact(
    schedule.updated_at === (snapshot.watch_runs as Row[])[0].finished_at,
    'schedule同批时间',
  );
  schedule.state = 'active';
  schedule.version = 1;
  schedule.updated_at = STAMP;
  const notification = row('notification_outbox', 'id', identity.notification);
  requireFact(notification.state === 'failed' && notification.attempts === 0, '通知不重放');
  time(notification.updated_at);
  requireFact(
    notification.updated_at === (snapshot.watch_runs as Row[])[0].finished_at,
    '通知同批时间',
  );
  notification.state = 'pending';
  notification.updated_at = LATER;
  const rule = row('watch_rules', 'id', identity.rule);
  const target = JSON.parse(String(rule.target_json)) as Record<string, unknown>;
  requireFact(target.sessionConsent === null, 'Session授权失效');
  time(rule.updated_at);
  target.sessionConsent = { version: 1, origin: 'https://example.invalid', grantedAt: STAMP };
  rule.target_json = JSON.stringify(target);
  rule.updated_at = STAMP;
  return copy;
}

export function verifySmallSnapshot(snapshot: Snapshot, variant: Variant, mode: Mode): void {
  requireFact(mode === 'source' || mode === 'restored', '模式');
  const hashes = snapshotHashes(normalizeExpectedChanges(snapshot, variant, mode));
  requireFact(canonical(hashes) === canonical(EXPECTED[variant]), '固定业务集合');
}
export function verifySmallFixture(
  root: string,
  variant: Variant,
  mode: Mode,
  layout: 'profile' | 'work' = 'profile',
): { bytes: number; hashes: Record<string, string> } {
  const { snapshot, bytes } = readSmallSnapshot(root, variant, layout);
  verifySmallSnapshot(snapshot, variant, mode);
  return { bytes, hashes: snapshotHashes(snapshot) };
}
