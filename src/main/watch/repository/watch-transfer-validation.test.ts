import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WATCH_MIGRATIONS } from '../db/watch-migrations';
import { validateWatchTransferDatabase } from './watch-transfer-validation';
import { serializeDigestArtifact } from '../../../shared/watch/digest-validator';
import { WatchRepository } from './watch-repository';
import type { DigestFacts } from '../../../shared/types/watch';
import { MAX_WATCH_DB_BYTES } from '../../../shared/types/watch';
import { normalizeFeedField } from '../../../shared/watch/feed-normalize';

const NOW = '2026-08-28T00:00:00.000Z';
const LATER = '2026-08-29T00:00:00.000Z';
const PERIOD = JSON.stringify({ fromExclusive: NOW, toInclusive: LATER });
const STATS = JSON.stringify({ changed: 1, failed: 0, unchanged: 0 });
const PAIR = {
  itemId: 'item',
  fieldKey: 'main-text:0',
  label: '正文',
  before: { kind: 'absent' },
  after: {
    kind: 'present',
    excerpt: '变化',
    valueHash: createHash('sha256').update('变化').digest('hex'),
    normalizedBytes: 6,
    truncated: false,
  },
  beforeCapturedAt: NOW,
  afterCapturedAt: NOW,
  beforeFinalUrl: 'https://example.com/',
  afterFinalUrl: 'https://example.com/',
  beforeDocumentId: null,
  afterDocumentId: null,
  feedItemKey: null,
};

const opened: DatabaseSync[] = [];
function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  opened.push(db);
  for (const migration of WATCH_MIGRATIONS) for (const sql of migration.statements) db.exec(sql);
  return db;
}
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function fixture(): DatabaseSync {
  const db = database();
  db.prepare(
    `INSERT INTO watch_rules (id,source_id,kind,state,desired_enabled,muted,access_mode,
    schedule_json,target_json,notification_level,source_locator_fingerprint,baseline_version,created_at,updated_at)
    VALUES ('rule','source','page','enabled',1,0,'public',?,?,'normal',?,1,?,?)`,
  ).run(
    JSON.stringify({ kind: 'interval', intervalMinutes: 60 }),
    JSON.stringify({
      type: 'page',
      pageUrl: 'https://example.com/',
      regions: [{ kind: 'main-text', label: '正文' }],
      sessionConsent: null,
    }),
    'a'.repeat(64),
    NOW,
    NOW,
  );
  const projection = JSON.stringify({ type: 'page', fields: [] });
  db.prepare(
    `INSERT INTO watch_baselines VALUES ('rule',1,'page',?,?,?,'https://example.com/',?,NULL,NULL,NULL)`,
  ).run(
    projection,
    createHash('sha256').update(projection).digest('hex'),
    Buffer.byteLength(projection),
    NOW,
  );
  db.prepare(
    `INSERT INTO watch_runs VALUES ('run','rule','request','finished','manual',NULL,?,?,?, ?,?)`,
  ).run(
    NOW,
    NOW,
    JSON.stringify({ kind: 'event-created', eventId: 'event' }),
    JSON.stringify({ state: 'healthy', acquisition: 'browser', code: null }),
    '{"legacy":[1,true,null]}',
  );
  db.prepare("INSERT INTO watch_audits VALUES ('audit','rule','run','event-created',?)").run(NOW);
  db.prepare(
    "INSERT INTO watch_events VALUES ('event','rule','source','added','normal','idem','fp',?,?,1,NULL)",
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO watch_event_observations VALUES ('v2:event','event',0,'idem','fp','added',?,0,1)",
  ).run(NOW);
  db.prepare(
    `INSERT INTO watch_event_items VALUES ('event-0','event',0,'v2:event',0,'item','main-text:0','正文',?,?,?,?,'https://example.com/','https://example.com/',NULL,NULL,NULL)`,
  ).run(JSON.stringify(PAIR.before), JSON.stringify(PAIR.after), NOW, NOW);
  db.prepare(
    "INSERT INTO source_cleanup_intents VALUES ('intent','source','update',NULL,NULL,'{}','complete',?,?)",
  ).run(NOW, NOW);
  db.exec('UPDATE digest_change_state SET last_sequence=1');
  db.prepare(
    "INSERT INTO digest_change_journal VALUES (1,'v2:event','event','source',?,'active')",
  ).run(NOW);
  db.prepare(
    `INSERT INTO digest_schedules (id,version,source_ids_json,schedule_json,ai_enabled,cursor_sequence,state,next_due_at,created_at,updated_at)
    VALUES ('schedule',1,'["source"]',?,0,1,'active',?,?,?)`,
  ).run(
    JSON.stringify({ kind: 'daily', localTime: '09:00', timeZone: 'Asia/Shanghai' }),
    LATER,
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO digest_runs (id,schedule_id,request_key,logical_date,lower_sequence,upper_sequence,next_sequence,period_json,run_stats_json,state,created_at,finished_at)
    VALUES ('digest-run','schedule','digest-request','2026-08-29',0,1,1,?,?,'completed',?,?)`,
  ).run(PERIOD, STATS, NOW, LATER);
  const facts = JSON.stringify({
    schemaVersion: 1,
    scheduleId: 'schedule',
    digestRunId: 'digest-run',
    batchIndex: 0,
    period: JSON.parse(PERIOD) as unknown,
    eventCount: 1,
    runStats: JSON.parse(STATS) as unknown,
    events: [
      {
        eventId: 'event',
        ruleId: 'rule',
        sourceId: 'source',
        eventKind: 'added',
        importance: 'normal',
        firstIncludedAt: NOW,
        lastIncludedAt: NOW,
        observationCount: 1,
        itemCount: 1,
      },
    ],
    evidenceMap: { event: [PAIR] },
    referenceStates: { event: 'active' },
    fetchedAt: LATER,
  });
  db.prepare(
    `INSERT INTO watch_digests (id,schedule_id,run_id,batch_index,first_sequence,last_sequence,facts_json,facts_hash,facts_revision,byte_length,provider_state,provider_result_code,provider_finished_at,created_at)
    VALUES ('digest','schedule','digest-run',0,1,1,?,?,1,?,'disabled','disabled',?,?)`,
  ).run(
    facts,
    createHash('sha256').update(facts).digest('hex'),
    serializeDigestArtifact(facts, null).byteLength,
    NOW,
    NOW,
  );
  db.exec("INSERT INTO digest_event_refs VALUES ('digest','event','active')");
  db.prepare(
    `INSERT INTO notification_outbox VALUES ('notice','rule','event','event','in-app','in-app|event|event|1',?,'pending',0,?,?)`,
  ).run(JSON.stringify({ eventKind: 'added', importance: 'normal', itemCount: 1 }), NOW, NOW);
  return db;
}
it.each([
  ['pending', 0, true],
  ['pending', 1, false],
  ['failed', 0, true],
  ['failed', 1, true],
  ['sent', 0, false],
  ['sent', 1, true],
  ['uncertain', 0, false],
  ['uncertain', 1, true],
] as const)(
  'keeps notification state %s attempts %s transfer semantics closed',
  (state, attempts, accepted) => {
    const db = fixture();
    db.prepare('UPDATE notification_outbox SET state=?,attempts=?').run(state, attempts);
    expect(validateWatchTransferDatabase(db).ok).toBe(accepted);
  },
);
function rewriteFacts(db: DatabaseSync, mutate: (facts: DigestFacts) => void): void {
  const row = db.prepare('SELECT facts_json FROM watch_digests').get()!;
  const facts = JSON.parse(row['facts_json'] as string) as DigestFacts;
  mutate(facts);
  const raw = JSON.stringify(facts);
  db.prepare('UPDATE watch_digests SET facts_json=?,facts_hash=?,byte_length=?').run(
    raw,
    createHash('sha256').update(raw).digest('hex'),
    serializeDigestArtifact(raw, null).byteLength,
  );
}

describe('Watch 完整导入语义扫描', () => {
  it('完整15表可信夹具扫描无写入，计数闭合', () => {
    const db = fixture();
    const before = db.prepare('SELECT total_changes() AS n').get();
    const result = validateWatchTransferDatabase(db);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(Object.keys(result.counts)).toHaveLength(15);
    expect(Object.values(result.counts)).toEqual(Array.from({ length: 15 }, () => 1));
    expect(result.logicalBytes).toBeGreaterThan(0);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    const repository = new WatchRepository({
      path: ':memory:',
      isOpen: true,
      prepare: (sql) => db.prepare(sql),
      exec: (sql) => db.exec(sql),
      close: () => {},
    });
    expect(result.logicalBytes).toBe(repository.estimateLogicalBytes());
  });
  it.each([
    ['watch_rules', "UPDATE watch_rules SET state='future'"],
    ['watch_baselines', "UPDATE watch_baselines SET content_hash='legacy-nonhex'"],
    ['watch_runs', 'UPDATE watch_runs SET outcome_json=\'{"kind":"future"}\''],
    ['watch_audits', "UPDATE watch_audits SET created_at='secret-time'"],
    ['watch_events', "UPDATE watch_events SET event_kind='future'"],
    ['watch_event_observations', "UPDATE watch_event_observations SET observed_at='bad-time'"],
    ['watch_event_items', 'UPDATE watch_event_items SET sequence=-1'],
    ['source_cleanup_intents', "UPDATE source_cleanup_intents SET affected_rule_state_json='[]'"],
    ['digest_change_state', 'UPDATE digest_change_state SET last_sequence=-1'],
    ['digest_change_journal', "UPDATE digest_change_journal SET status='future'"],
    ['digest_schedules', "UPDATE digest_schedules SET source_ids_json='[]'"],
    ['digest_runs', "UPDATE digest_runs SET state='future'"],
    ['watch_digests', "UPDATE watch_digests SET facts_hash='a'"],
    ['digest_event_refs', "UPDATE digest_event_refs SET status='future'"],
    ['notification_outbox', 'UPDATE notification_outbox SET privacy_json=\'{"secret":1}\''],
  ])('%s 的坏行不能被分页/过滤遗漏', (table, sql) => {
    const db = fixture();
    db.exec('PRAGMA ignore_check_constraints=ON');
    db.exec(sql);
    const result = validateWatchTransferDatabase(db);
    expect(result).toMatchObject({ ok: false, table });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it.each([
    ['baseline版本', 'UPDATE watch_baselines SET version=2'],
    ['baseline缺失', 'DELETE FROM watch_baselines'],
    ['event来源错配', "UPDATE watch_events SET source_id='other'"],
    ['observation首兼容列', "UPDATE watch_event_observations SET change_fingerprint='other'"],
    ['observation序号缺口', 'UPDATE watch_event_observations SET sequence=2'],
    ['observation范围', 'UPDATE watch_event_observations SET first_item_sequence=1'],
    ['item序号缺口', 'UPDATE watch_event_items SET sequence=2'],
    ['item观察内序号', 'UPDATE watch_event_items SET observation_item_sequence=2'],
    ['item观察归属', "UPDATE watch_event_items SET observation_id='missing'"],
    ['event聚合类型', "UPDATE watch_events SET event_kind='mixed'"],
    ['event聚合数量', 'UPDATE watch_events SET item_count=2'],
    ['journal活动关系', "UPDATE digest_change_journal SET event_id='missing'"],
    ['journal高水位', 'UPDATE digest_change_state SET last_sequence=0'],
    ['journal墓碑残留事件', "UPDATE digest_change_journal SET status='expired'"],
    ['digest运行归属', "UPDATE watch_digests SET run_id='missing'"],
    ['digest首batch缺口', 'UPDATE watch_digests SET batch_index=1'],
    ['digest首sequence缺口', 'UPDATE watch_digests SET first_sequence=2,last_sequence=2'],
    ['digest超runcursor', 'UPDATE watch_digests SET last_sequence=2'],
    ['digest引用错配', "UPDATE digest_event_refs SET event_id='missing'"],
    ['schedule游标越界', 'UPDATE digest_schedules SET cursor_sequence=2'],
    [
      'outbox主体缺失',
      "UPDATE notification_outbox SET subject_id='missing',dedupe_key='in-app|event|missing|1'",
    ],
    ['outbox去重键', "UPDATE notification_outbox SET dedupe_key='other'"],
    ['outbox状态次数', "UPDATE notification_outbox SET state='uncertain'"],
    ['partial claim', 'UPDATE watch_digests SET claimed_facts_revision=1'],
  ])('%s 跨行或状态反例拒绝', (_name, sql) => {
    const db = fixture();
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec('PRAGMA ignore_check_constraints=ON');
    db.exec(sql);
    expect(validateWatchTransferDatabase(db).ok).toBe(false);
  });
  it('非hex baseline 被旧扫描放行，新导入扫描拒绝', () => {
    const db = fixture();
    db.exec("UPDATE watch_baselines SET content_hash='legacy-nonhex'");
    const repository = new WatchRepository({
      path: ':memory:',
      isOpen: true,
      prepare: (sql) => db.prepare(sql),
      exec: (sql) => db.exec(sql),
      close: () => {},
    });
    expect(repository.scanIntegrity()).toEqual({ ok: true, reason: null });
    expect(validateWatchTransferDatabase(db)).toMatchObject({
      ok: false,
      table: 'watch_baselines',
    });
  });
  it('Digest自洽重算hash仍不能伪造保留Evidence', () => {
    const db = fixture();
    rewriteFacts(db, (facts) => {
      const pair = facts.evidenceMap['event']![0]!;
      if (pair.after.kind === 'present') {
        pair.after.excerpt = '伪造';
        pair.after.valueHash = createHash('sha256').update('伪造').digest('hex');
      }
    });
    expect(validateWatchTransferDatabase(db)).toMatchObject({
      ok: false,
      code: 'reference-invalid',
      table: 'watch_digests',
    });
  });

  it.each([
    { valueHash: 'not-a-hash' },
    { valueHash: 'a'.repeat(64) },
    { normalizedBytes: 1 },
    { truncated: true },
  ])('Evidence拒绝可重算事实不符 %j', (patch) => {
    const db = fixture();
    db.prepare('UPDATE watch_event_items SET after_value_json=?').run(
      JSON.stringify({ ...PAIR.after, ...patch }),
    );
    expect(validateWatchTransferDatabase(db)).toMatchObject({
      ok: false,
      table: 'watch_event_items',
    });
  });

  it.each([
    'javascript:alert(1)',
    'https://example.com/?private=value',
    'https://example.com/#secret',
    'https://user:secret@example.com/',
  ])('Evidence拒绝非安全持久URL %s', (url) => {
    const db = fixture();
    db.prepare('UPDATE watch_event_items SET before_final_url=?').run(url);
    expect(validateWatchTransferDatabase(db)).toMatchObject({
      ok: false,
      table: 'watch_event_items',
    });
  });

  it('合法截断Evidence只能核对完整哈希形状，不把摘录hash冒充完整值hash', () => {
    const db = fixture();
    const text = 'x'.repeat(5000);
    const value = {
      kind: 'present',
      excerpt: text.slice(0, 4096),
      valueHash: createHash('sha256').update(text).digest('hex'),
      normalizedBytes: 5000,
      truncated: true,
    } as const;
    db.prepare('UPDATE watch_event_items SET after_value_json=?').run(JSON.stringify(value));
    rewriteFacts(db, (facts) => {
      facts.evidenceMap['event']![0]!.after = value;
    });
    expect(validateWatchTransferDatabase(db).ok).toBe(true);
  });

  it.each(['absent', 'present'] as const)('相同的双侧%s不能证明发生变化', (kind) => {
    const db = fixture();
    const value =
      kind === 'absent' ? { kind: 'absent' as const } : { ...PAIR.after, kind: 'present' as const };
    db.prepare('UPDATE watch_event_items SET before_value_json=?,after_value_json=?').run(
      JSON.stringify(value),
      JSON.stringify(value),
    );
    rewriteFacts(db, (facts) => {
      const pair = facts.evidenceMap['event']![0]!;
      pair.before = value;
      pair.after = value;
    });
    expect(validateWatchTransferDatabase(db)).toMatchObject({
      ok: false,
      table: 'watch_event_items',
    });
  });
  it('合法已删event与已清理journal墓碑不当作孤儿', () => {
    const db = fixture();
    rewriteFacts(db, (facts) => {
      delete facts.evidenceMap['event'];
      facts.referenceStates['event'] = 'expired';
    });
    db.exec("UPDATE digest_event_refs SET status='expired'");
    db.exec("UPDATE digest_change_journal SET status='expired'");
    db.exec('DELETE FROM notification_outbox');
    db.exec('DELETE FROM watch_event_items');
    db.exec('DELETE FROM watch_event_observations');
    db.exec('DELETE FROM watch_events');
    expect(validateWatchTransferDatabase(db).ok).toBe(true);
    db.exec('DELETE FROM digest_change_journal');
    expect(validateWatchTransferDatabase(db).ok).toBe(true);
  });
  it('typed JSON深度/节点/重复键在域validator前拒绝', () => {
    for (const raw of [
      '{"kind":"interval","kind":"interval","intervalMinutes":60}',
      '['.repeat(17) + '0' + ']'.repeat(17),
      JSON.stringify(Array.from({ length: 129 }, () => 0)),
    ]) {
      const db = fixture();
      db.prepare('UPDATE watch_rules SET target_json=?').run(raw);
      expect(validateWatchTransferDatabase(db).ok).toBe(false);
    }
  });
  it('nullable列中的JSON null不冒充SQL NULL', () => {
    const db = fixture();
    db.exec("UPDATE watch_runs SET outcome_json='null'");
    expect(validateWatchTransferDatabase(db).ok).toBe(false);
  });
  it('旧opaque metadata超过新写4096B仍保持字节恒等', () => {
    const db = fixture();
    const raw = JSON.stringify({ legacy: 'x'.repeat(20_000) });
    db.prepare('UPDATE watch_runs SET response_metadata_json=?').run(raw);
    expect(validateWatchTransferDatabase(db).ok).toBe(true);
    expect(
      db.prepare('SELECT response_metadata_json FROM watch_runs').get()?.['response_metadata_json'],
    ).toBe(raw);
  });
  it.each(['null', 'true', '{"same":1,"same":2}', '['.repeat(20_000) + '0' + ']'.repeat(20_000)])(
    '旧opaque深结构/重复键只校验语法，绝不展开 %s',
    (raw) => {
      const db = fixture();
      db.prepare('UPDATE watch_runs SET response_metadata_json=?').run(raw);
      const parse = vi.spyOn(JSON, 'parse');
      try {
        expect(validateWatchTransferDatabase(db).ok).toBe(true);
        expect(parse.mock.calls.some((call) => call[0] === raw)).toBe(false);
        expect(
          db.prepare('SELECT response_metadata_json FROM watch_runs').get()?.[
            'response_metadata_json'
          ],
        ).toBe(raw);
      } finally {
        parse.mockRestore();
      }
    },
  );
  it.each(['{"x":', '[1,]', '"\\u00ZZ"', 'false tail'])('旧opaque语法错误仍拒绝 %s', (raw) => {
    const db = fixture();
    db.prepare('UPDATE watch_runs SET response_metadata_json=?').run(raw);
    expect(validateWatchTransferDatabase(db)).toMatchObject({
      ok: false,
      code: 'json-invalid',
      table: 'watch_runs',
    });
  });
  it.each([
    ['watch_rules', 'UPDATE watch_rules SET id=NULL'],
    ['watch_rules', "UPDATE watch_rules SET access_mode='oversize-invalid-enum'"],
    ['watch_event_items', "UPDATE watch_event_items SET observation_item_sequence='not-integer'"],
    [
      'digest_schedules',
      "UPDATE digest_schedules SET last_consumed_scheduled_for='oversize-invalid-timestamp-repeated',last_daily_local_date='2026-08-29'",
    ],
  ])('%s 未计费的非法scalar在完整行读取前拒绝', (table, sql) => {
    const db = fixture();
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec('PRAGMA ignore_check_constraints=ON');
    db.exec(sql);
    expect(validateWatchTransferDatabase(db)).toMatchObject({
      ok: false,
      code: 'row-invalid',
      table,
    });
  });
  it('daily本地日期必须与持久scheduledFor和时区对应', () => {
    const db = fixture();
    db.prepare(
      "UPDATE digest_schedules SET last_consumed_scheduled_for=?,last_daily_local_date='2026-08-29'",
    ).run(LATER);
    expect(validateWatchTransferDatabase(db).ok).toBe(true);
    db.exec("UPDATE digest_schedules SET last_daily_local_date='2026-08-28'");
    expect(validateWatchTransferDatabase(db)).toMatchObject({
      ok: false,
      table: 'digest_schedules',
    });
  });
  it('完整逻辑预算先于JSON解析且不做清理', () => {
    const db = fixture();
    db.exec("UPDATE watch_runs SET outcome_json='not-json'");
    // Exercise the arithmetic boundary without allocating a 100 MiB test row.
    db.function('length', (value) => (value === null ? 0 : MAX_WATCH_DB_BYTES));
    const before = db.prepare('SELECT total_changes() AS n').get();
    expect(validateWatchTransferDatabase(db)).toMatchObject({ ok: false, code: 'budget-exceeded' });
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });
  it('单Event预算计入完整Evidence wrapper，不能只算before/after正文', () => {
    const db = fixture();
    const copy = db.prepare(`INSERT INTO watch_event_items
      SELECT ?,event_id,?,observation_id,?,?,field_key,label,before_value_json,after_value_json,
      before_captured_at,after_captured_at,before_final_url,after_final_url,before_document_id,after_document_id,feed_item_key
      FROM watch_event_items WHERE id='event-0'`);
    for (let index = 1; index < 8; index++)
      copy.run(`item-${index}`, index, index, `field-${index}`);
    const url = 'https://example.com/' + 'x'.repeat(2000);
    db.prepare('UPDATE watch_event_items SET before_final_url=?,after_final_url=?').run(url, url);
    db.exec('UPDATE watch_events SET item_count=8');
    db.exec('UPDATE watch_event_observations SET item_count=8');
    expect(validateWatchTransferDatabase(db)).toMatchObject({
      ok: false,
      code: 'budget-exceeded',
      table: 'watch_events',
    });
  });
  it('实际Feed字段canonical顺序和hash通过，重排value后重新hash仍拒绝', () => {
    const db = fixture();
    db.exec("UPDATE watch_rules SET kind='feed'");
    db.prepare('UPDATE watch_rules SET target_json=?').run(
      JSON.stringify({ type: 'feed', feedUrl: 'https://example.com/feed', format: 'rss2' }),
    );
    const value = {
      type: 'feed',
      format: 'rss2',
      title: normalizeFeedField('标题'),
      description: normalizeFeedField(''),
      siteUrl: normalizeFeedField('https://example.com/'),
      feedUrl: normalizeFeedField('https://example.com/feed'),
      items: [],
      itemsTruncated: false,
    };
    const setProjection = (raw: string): void => {
      db.prepare(
        "UPDATE watch_baselines SET projection_type='feed',projection_json=?,content_hash=?,byte_length=?",
      ).run(raw, createHash('sha256').update(raw).digest('hex'), Buffer.byteLength(raw));
    };
    setProjection(JSON.stringify(value));
    expect(validateWatchTransferDatabase(db).ok).toBe(true);
    const { type, ...rest } = value;
    setProjection(JSON.stringify({ ...rest, type }));
    expect(validateWatchTransferDatabase(db)).toMatchObject({
      ok: false,
      table: 'watch_baselines',
    });
  });
  it('已claimed的Digest保持原样，不恢复为pending或启动Provider', () => {
    const db = fixture();
    db.prepare(
      "UPDATE watch_digests SET provider_state='claimed',provider_result_code=NULL,provider_finished_at=NULL,claimed_at=?,claimed_facts_revision=1,claimed_facts_hash=facts_hash",
    ).run(NOW);
    expect(validateWatchTransferDatabase(db).ok).toBe(true);
    expect(db.prepare('SELECT provider_state FROM watch_digests').get()?.['provider_state']).toBe(
      'claimed',
    );
  });
  it('Digest通知主体被删除后拒绝孤儿通知，区别于Event/Digest tombstone', () => {
    const db = fixture();
    db.prepare(
      "UPDATE notification_outbox SET rule_id=NULL,subject_type='digest',subject_id='digest',dedupe_key='in-app|digest|digest|1',privacy_json=?",
    ).run(JSON.stringify({ eventKind: 'digest', importance: 'normal', itemCount: 1 }));
    expect(validateWatchTransferDatabase(db).ok).toBe(true);
    // Inject historical damage directly; the production delete path now cleans
    // these rows transactionally and has its own Repository regression tests.
    db.exec("DELETE FROM digest_schedules WHERE id='schedule'");
    expect(db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get()?.['n']).toBe(1);
    expect(validateWatchTransferDatabase(db)).toMatchObject({
      ok: false,
      table: 'notification_outbox',
      code: 'reference-invalid',
    });
  });
  it('空当前库通过，high-water 行损坏必须拒绝', () => {
    const db = database();
    expect(validateWatchTransferDatabase(db).ok).toBe(true);
    db.exec('DELETE FROM digest_change_state');
    expect(validateWatchTransferDatabase(db).ok).toBe(false);
  });
  it('未被现有 row validator 覆盖的 audit 时间必须拒绝且结果不回显正文', () => {
    const db = database();
    db.prepare("INSERT INTO watch_audits VALUES ('secret-id', NULL, 'run', 'unchanged', ?)").run(
      'secret-body',
    );
    const result = validateWatchTransferDatabase(db);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
