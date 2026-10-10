import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { MIGRATIONS } from '../../sources/db/migrations';
import { WATCH_MIGRATIONS } from '../db/watch-migrations';
import { validateSourceTransfer } from '../../sources/repository/source-transfer-validation';
import { validateWatchTransferDatabase } from './watch-transfer-validation';
import { computeSourceLocatorFingerprint } from '../../../shared/watch/watch-rule-state';
import { serializeDigestArtifact } from '../../../shared/watch/digest-validator';
import { validateWatchSourceTransfer } from './watch-source-transfer-validation';

const ID = '12345678-1234-4123-8123-123456789abc';
const NOW = '2026-10-04T00:00:00.000Z';
const LATER = '2026-10-05T00:00:00.000Z';
const opened: DatabaseSync[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
function fixture() {
  const sources = new DatabaseSync(':memory:');
  const watch = new DatabaseSync(':memory:');
  opened.push(sources, watch);
  for (const migration of MIGRATIONS) for (const sql of migration.statements) sources.exec(sql);
  for (const migration of WATCH_MIGRATIONS) for (const sql of migration.statements) watch.exec(sql);
  sources
    .prepare(
      `INSERT INTO sources(id,scope,canonical_key,url,name,trust_verification,created_at,updated_at)
    VALUES(?,'page','https://example.com/','https://example.com/','合成信源','asserted',?,?)`,
    )
    .run(ID, NOW, NOW);
  const fingerprint = computeSourceLocatorFingerprint({
    sourceId: ID,
    scope: 'page',
    canonicalKey: 'https://example.com/',
    kind: 'page',
    canonicalTargetUrl: 'https://example.com/',
  });
  watch
    .prepare(
      `INSERT INTO watch_rules(id,source_id,kind,state,desired_enabled,muted,access_mode,
    schedule_json,target_json,notification_level,source_locator_fingerprint,created_at,updated_at)
    VALUES('rule',?,'page','enabled',1,0,'public',?,?,'normal',?,?,?)`,
    )
    .run(
      ID,
      JSON.stringify({ kind: 'interval', intervalMinutes: 60 }),
      JSON.stringify({
        type: 'page',
        pageUrl: 'https://example.com/',
        regions: [{ kind: 'main-text', label: '正文' }],
        sessionConsent: null,
      }),
      fingerprint,
      NOW,
      NOW,
    );
  return { sources, watch };
}
function verify(sources: DatabaseSync, watch: DatabaseSync) {
  expect(validateSourceTransfer(sources).ok).toBe(true);
  expect(validateWatchTransferDatabase(watch).ok).toBe(true);
  const before = [sources, watch].map((db) => db.prepare('SELECT total_changes() AS n').get());
  for (const db of [sources, watch]) db.exec('PRAGMA query_only=ON');
  const result = validateWatchSourceTransfer(sources, watch);
  expect([sources, watch].map((db) => db.prepare('SELECT total_changes() AS n').get())).toEqual(
    before,
  );
  return result;
}
function schedule(watch: DatabaseSync, state = 'active') {
  watch
    .prepare(
      `INSERT INTO digest_schedules(id,version,source_ids_json,schedule_json,ai_enabled,cursor_sequence,state,next_due_at,created_at,updated_at)
    VALUES('schedule',1,?,?,0,0,?,?,?,?)`,
    )
    .run(
      JSON.stringify([ID]),
      JSON.stringify({ kind: 'daily', localTime: '09:00', timeZone: 'Asia/Shanghai' }),
      state,
      LATER,
      NOW,
      NOW,
    );
}

it('同代合法规则只读通过，返回闭合计数', () => {
  const { sources, watch } = fixture();
  expect(verify(sources, watch)).toEqual({
    ok: true,
    counts: {
      rules: 1,
      missingRuleSources: 0,
      historicalRules: 0,
      schedules: 0,
      scheduleMembers: 0,
      missingScheduleMembers: 0,
    },
  });
});
it.each(['missing', 'disabled', 'locator', 'version'] as const)(
  '拒绝enabled规则的%s跨库矛盾',
  (change) => {
    const { sources, watch } = fixture();
    if (change === 'missing') sources.exec('DELETE FROM sources');
    if (change === 'disabled')
      sources.prepare('UPDATE sources SET enabled=0,deleted_at=?').run(NOW);
    if (change === 'locator')
      sources.exec(
        "UPDATE sources SET canonical_key='https://example.com/changed',url='https://example.com/changed'",
      );
    if (change === 'version') sources.exec('UPDATE sources SET version=2');
    expect(verify(sources, watch)).toMatchObject({ ok: false, code: `rule-source-${change}` });
  },
);
it.each(['user', 'login-required', 'source-deleted'] as const)(
  '缺失Source时允许已暂停规则保留%s原因',
  (reason) => {
    const { sources, watch } = fixture();
    sources.exec('DELETE FROM sources');
    watch
      .prepare("UPDATE watch_rules SET state='paused',pause_reason=?,desired_enabled=0")
      .run(reason);
    expect(verify(sources, watch)).toMatchObject({ ok: true, counts: { missingRuleSources: 1 } });
  },
);
it('已暂停规则允许旧locator与当前blocked共享模式，不重新启用', () => {
  const { sources, watch } = fixture();
  sources.exec(
    "UPDATE sources SET canonical_key='https://example.com/changed',url='https://example.com/changed',share_mode='blocked',version=2",
  );
  watch.exec(
    "UPDATE watch_rules SET state='paused',pause_reason='user',desired_enabled=0,source_row_version=2",
  );
  expect(verify(sources, watch).ok).toBe(true);
  expect(watch.prepare('SELECT state,desired_enabled FROM watch_rules').get()).toMatchObject({
    state: 'paused',
    desired_enabled: 0,
  });
});
it('deleted历史规则不要求当前Source或当前locator/version', () => {
  const { sources, watch } = fixture();
  sources.exec('DELETE FROM sources');
  watch.exec("UPDATE watch_rules SET state='deleted',desired_enabled=0,source_row_version=9");
  expect(verify(sources, watch)).toMatchObject({ ok: true, counts: { historicalRules: 1 } });
});
it.each(['prepared', 'source-committed'] as const)('未闭合%s intent不得冒充一致快照', (state) => {
  const { sources, watch } = fixture();
  watch
    .prepare("INSERT INTO source_cleanup_intents VALUES('intent',?,'update',NULL,NULL,'{}',?,?,?)")
    .run(ID, state, NOW, NOW);
  expect(verify(sources, watch)).toMatchObject({ ok: false, code: 'unresolved-source-intent' });
});
it.each(['active', 'paused'] as const)(
  '固定%s Digest计划可保留已硬删除Source成员及scrub历史',
  (state) => {
    const { sources, watch } = fixture();
    sources.exec('DELETE FROM sources');
    watch.exec('DELETE FROM watch_rules');
    schedule(watch, state);
    const period = { fromExclusive: NOW, toInclusive: LATER };
    const stats = { changed: 1, failed: 0, unchanged: 0 };
    watch.exec(
      'UPDATE digest_change_state SET last_sequence=1; UPDATE digest_schedules SET cursor_sequence=1',
    );
    watch
      .prepare("INSERT INTO digest_change_journal VALUES(1,'observation','event',?,?,'expired')")
      .run(ID, NOW);
    watch
      .prepare(
        `INSERT INTO digest_runs(id,schedule_id,request_key,logical_date,lower_sequence,upper_sequence,next_sequence,
    period_json,run_stats_json,state,created_at,finished_at) VALUES('run','schedule','request','2026-10-05',0,1,1,?,?,'completed',?,?)`,
      )
      .run(JSON.stringify(period), JSON.stringify(stats), NOW, LATER);
    const facts = JSON.stringify({
      schemaVersion: 1,
      scheduleId: 'schedule',
      digestRunId: 'run',
      batchIndex: 0,
      period,
      eventCount: 1,
      runStats: stats,
      events: [
        {
          eventId: 'event',
          ruleId: 'old-rule',
          sourceId: ID,
          eventKind: 'added',
          importance: 'normal',
          firstIncludedAt: NOW,
          lastIncludedAt: NOW,
          observationCount: 1,
          itemCount: 1,
        },
      ],
      evidenceMap: {},
      referenceStates: { event: 'expired' },
      fetchedAt: LATER,
    });
    watch
      .prepare(
        `INSERT INTO watch_digests(id,schedule_id,run_id,batch_index,first_sequence,last_sequence,facts_json,facts_hash,facts_revision,
    byte_length,provider_state,provider_result_code,provider_finished_at,created_at) VALUES('digest','schedule','run',0,1,1,?,?,1,?,'disabled','disabled',?,?)`,
      )
      .run(
        facts,
        createHash('sha256').update(facts).digest('hex'),
        serializeDigestArtifact(facts, null).byteLength,
        NOW,
        NOW,
      );
    watch.exec("INSERT INTO digest_event_refs VALUES('digest','event','expired')");
    expect(verify(sources, watch)).toMatchObject({
      ok: true,
      counts: { schedules: 1, scheduleMembers: 1, missingScheduleMembers: 1 },
    });
  },
);

it('同代metadata更新在两库记录相同新版本后通过', () => {
  const { sources, watch } = fixture();
  sources.exec("UPDATE sources SET version=2,share_mode='metadata'");
  watch.exec('UPDATE watch_rules SET source_row_version=2');
  expect(verify(sources, watch).ok).toBe(true);
});

it('已暂停规则仍必须观察到现存Source当前版本', () => {
  const { sources, watch } = fixture();
  sources.exec('UPDATE sources SET version=2');
  watch.exec("UPDATE watch_rules SET state='paused',pause_reason='user',desired_enabled=0");
  expect(verify(sources, watch)).toEqual({ ok: false, code: 'rule-source-version' });
});

it('已软删Source的暂停规则与固定计划保持暂停且不丢失用户意图', () => {
  const { sources, watch } = fixture();
  sources.prepare('UPDATE sources SET enabled=0,deleted_at=?').run(NOW);
  watch.exec(
    "UPDATE watch_rules SET state='paused',pause_reason='source-disabled',desired_enabled=1",
  );
  schedule(watch, 'paused');
  expect(verify(sources, watch)).toMatchObject({
    ok: true,
    counts: { scheduleMembers: 1, missingScheduleMembers: 0 },
  });
  expect(watch.prepare('SELECT state,desired_enabled FROM watch_rules').get()).toMatchObject({
    state: 'paused',
    desired_enabled: 1,
  });
});

it.each(['complete', 'aborted'] as const)('已闭合%s intent允许只读校验且不清理历史', (state) => {
  const { sources, watch } = fixture();
  watch
    .prepare("INSERT INTO source_cleanup_intents VALUES('intent',?,'update',NULL,NULL,'{}',?,?,?)")
    .run(ID, state, NOW, NOW);
  expect(verify(sources, watch).ok).toBe(true);
  expect(watch.prepare('SELECT state FROM source_cleanup_intents').get()).toEqual({ state });
});

it('Feed使用其独立目标URL重算locator', () => {
  const { sources, watch } = fixture();
  const target = { type: 'feed', feedUrl: 'https://example.com/feed.xml', format: 'rss2' };
  const fingerprint = computeSourceLocatorFingerprint({
    sourceId: ID,
    scope: 'page',
    canonicalKey: 'https://example.com/',
    kind: 'feed',
    canonicalTargetUrl: target.feedUrl,
  });
  watch
    .prepare("UPDATE watch_rules SET kind='feed',target_json=?,source_locator_fingerprint=?")
    .run(JSON.stringify(target), fingerprint);
  expect(verify(sources, watch).ok).toBe(true);
});

it('数据库读异常返回固定错误，不泄露Source标识或正文', () => {
  const { sources, watch } = fixture();
  expect(validateSourceTransfer(sources).ok).toBe(true);
  expect(validateWatchTransferDatabase(watch).ok).toBe(true);
  const spy = vi.spyOn(sources, 'prepare').mockImplementationOnce(() => {
    throw new Error(`私有正文 ${ID}`);
  });
  expect(validateWatchSourceTransfer(sources, watch)).toEqual({
    ok: false,
    code: 'snapshot-invalid',
  });
  spy.mockRestore();
});

it('Session暂停规则校验不建立授权或重新启用', () => {
  const { sources, watch } = fixture();
  watch.exec(
    "UPDATE watch_rules SET access_mode='session',state='paused',pause_reason='login-required'",
  );
  const before = watch.prepare('SELECT target_json,state FROM watch_rules').get();
  expect(verify(sources, watch).ok).toBe(true);
  expect(watch.prepare('SELECT target_json,state FROM watch_rules').get()).toEqual(before);
  expect(JSON.parse(String(before?.target_json)) as { sessionConsent: null }).toMatchObject({
    sessionConsent: null,
  });
});

it('意外缺失Source的暂停规则仍可保留已校验Event及Evidence', () => {
  const { sources, watch } = fixture();
  sources.exec('DELETE FROM sources');
  watch.exec("UPDATE watch_rules SET state='paused',pause_reason='user',desired_enabled=0");
  watch
    .prepare(
      "INSERT INTO watch_events VALUES ('event','rule',?,'added','normal','idem','fp',?,?,1,NULL)",
    )
    .run(ID, NOW, NOW);
  watch
    .prepare(
      "INSERT INTO watch_event_observations VALUES ('v2:event','event',0,'idem','fp','added',?,0,1)",
    )
    .run(NOW);
  const after = {
    kind: 'present',
    excerpt: '变化',
    valueHash: createHash('sha256').update('变化').digest('hex'),
    normalizedBytes: 6,
    truncated: false,
  };
  watch
    .prepare(
      `INSERT INTO watch_event_items VALUES ('event-0','event',0,'v2:event',0,'item','main-text:0','正文',?,?,?,?,'https://example.com/','https://example.com/',NULL,NULL,NULL)`,
    )
    .run(JSON.stringify({ kind: 'absent' }), JSON.stringify(after), NOW, NOW);
  watch.exec('UPDATE digest_change_state SET last_sequence=1');
  watch
    .prepare("INSERT INTO digest_change_journal VALUES(1,'v2:event','event',?,?,'active')")
    .run(ID, NOW);
  expect(verify(sources, watch)).toMatchObject({ ok: true, counts: { missingRuleSources: 1 } });
  expect(watch.prepare('SELECT count(*) AS n FROM watch_event_items').get()).toEqual({ n: 1 });
});
