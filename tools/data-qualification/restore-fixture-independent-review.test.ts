import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, expect, it } from 'vitest';
import { createDatasetScope } from '../../src/main/storage/dataset-layout';
import { runTransferPipeline } from '../../src/main/storage/transfer-pipeline';
import { computeSourceLocatorFingerprint } from '../../src/shared/watch/watch-rule-state';
import { createSmallFixture, type Variant } from './product-restore-fixtures/seed';
import {
  readSmallSnapshot,
  verifySmallFixture,
  verifySmallSnapshot,
  type Snapshot,
} from './product-restore-fixtures/oracle';

type Row = Record<string, unknown>;
const parent = join(process.cwd(), 'log/stage7-e2/restore-fixture-independent-review-001');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'run-'));
const variants = ['A', 'B', 'H'] as const;
const snapshots = new Map<Variant, Snapshot>();
const at = '2026-10-10T02:00:00.000Z';
let restored: Snapshot;
let restoredRoot: string;
const rows = (snapshot: Snapshot, table: string): Row[] => snapshot[table] as Row[];
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

function files(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const item = join(path, name);
    return statSync(item).isDirectory() ? files(item) : [item];
  });
}

function fingerprint(path: string): Record<string, string> {
  return Object.fromEntries(
    files(path).map((file) => [
      file,
      createHash('sha256').update(readFileSync(file)).digest('hex'),
    ]),
  );
}

function writeRecord(name: string, value: unknown): void {
  writeFileSync(join(root, name), JSON.stringify(value, null, 2), { flag: 'wx' });
}

function reject(snapshot: Snapshot, variant: Variant, mode: 'source' | 'restored'): void {
  expect(() => verifySmallSnapshot(snapshot, variant, mode)).toThrow();
}

beforeAll(async () => {
  for (const variant of variants) {
    const path = join(root, variant);
    createSmallFixture(path, variant);
    const result = readSmallSnapshot(path, variant);
    snapshots.set(variant, result.snapshot);
    writeRecord(`${variant}-source.json`, result);
  }
  const operationId = randomUUID();
  const scope = await createDatasetScope(
    {
      userDataRoot: join(root, 'H'),
      operationId: operationId.replaceAll('-', ''),
      generation: randomUUID().replaceAll('-', ''),
      purpose: 'migrate',
    },
    { check() {}, requireRollbackSpace() {} },
  );
  await runTransferPipeline({
    job: { operationId, snapshotId: randomUUID(), action: 'migrate' },
    scope,
    productVersion: '0.1.0',
    selectedInput: null,
    control: { signal: new AbortController().signal, deadline: performance.now() + 15000 },
    enterPhase: async () => {},
    nowIso: at,
  });
  restoredRoot = join(scope.operationRoot, 'work');
  restored = readSmallSnapshot(restoredRoot, 'H', 'work').snapshot;
  writeRecord('H-restored.json', restored);
}, 30000);

it.each(variants)('%s四域实质内容、主键和关联独立核验', (variant) => {
  const snapshot = snapshots.get(variant)!;
  const n = { A: 10, B: 20, H: 30 }[variant];
  expect(verifySmallFixture(join(root, variant), variant, 'source').bytes).toBe(942553);
  expect(rows(snapshot, 'sources')).toHaveLength(1);
  const source = rows(snapshot, 'sources')[0];
  const rule = rows(snapshot, 'watch_rules')[0];
  expect(source).toMatchObject({
    id: uuid(n),
    name: `恢复夹具${variant}`,
    url: `https://example.invalid/restore-${variant}/`,
    version: 1,
    enabled: 1,
  });
  expect(rule).toMatchObject({
    id: uuid(n + 10000),
    source_id: source.id,
    source_row_version: 1,
    state: 'paused',
    pause_reason: 'user',
    desired_enabled: 0,
  });
  expect(rule.source_locator_fingerprint).toBe(
    computeSourceLocatorFingerprint({
      sourceId: uuid(n),
      scope: 'page',
      canonicalKey: String(source.canonical_key),
      kind: 'page',
      canonicalTargetUrl: String(source.url),
    }),
  );
  for (const table of [
    'research_candidates',
    'research_captures',
    'research_evidence',
    'research_results',
  ])
    expect(rows(snapshot, table)).toHaveLength(1);
  const candidate = rows(snapshot, 'research_candidates')[0];
  const capture = rows(snapshot, 'research_captures')[0];
  const evidence = rows(snapshot, 'research_evidence')[0];
  const result = rows(snapshot, 'research_results')[0];
  expect(candidate).toMatchObject({
    candidate_id: uuid(n + 1000),
    task_id: uuid(n),
    discovered_via_json: '["search"]',
  });
  expect(capture).toMatchObject({
    capture_id: uuid(n + 2000),
    candidate_id: candidate.candidate_id,
    task_id: uuid(n),
    failed: 0,
  });
  expect(evidence).toMatchObject({
    evidence_id: uuid(n + 4000),
    capture_id: capture.capture_id,
    candidate_id: candidate.candidate_id,
    task_id: uuid(n),
    excerpt: '合成证据',
    verification: 'verified',
    content_hash: createHash('sha256').update('合成证据').digest('hex').slice(0, 32),
  });
  expect(result).toMatchObject({
    result_id: uuid(n + 100),
    task_id: uuid(n),
    title: `恢复夹具${variant}`,
  });
  expect(JSON.parse(String(result.blocks_json))[0]).toEqual({
    kind: 'table',
    columns: ['结果'],
    rows: [[`恢复夹具${variant}`]],
    sourceRefs: [candidate.candidate_id],
  });
  expect(JSON.parse(String(result.evidence_map_json))).toEqual({
    [uuid(n + 4000)]: {
      candidateId: candidate.candidate_id,
      url: evidence.url,
      title: evidence.title,
      accessTime: evidence.access_time,
    },
  });
  expect(rows(snapshot, 'research_tasks').find((task) => task.id === uuid(n))).toMatchObject({
    status: 'completed',
    result_id: result.result_id,
  });
  const index = snapshot.conversation_index as { sessions: Row[] };
  const session = snapshot.conversation_session as { messages: Row[] };
  expect(index.sessions).toHaveLength(1);
  expect(index.sessions[0]).toMatchObject({
    id: uuid(n + 9000),
    title: `恢复夹具${variant}`,
    ephemeral: false,
  });
  expect(session.messages).toHaveLength(2);
  expect(session.messages[0]).toMatchObject({
    id: uuid(n + 9001),
    role: 'user',
    content: `恢复夹具${variant}问题`,
    status: 'complete',
  });
  expect(session.messages[1]).toMatchObject({
    id: uuid(n + 9002),
    role: 'assistant',
    content: `恢复夹具${variant}回答`,
    status: 'complete',
  });
});

it('H危险历史含真实claim、cycle、slot、通知及有效旧授权', () => {
  const h = snapshots.get('H')!;
  expect(rows(h, 'research_tasks')).toHaveLength(2);
  expect(rows(h, 'research_tasks')[1]).toMatchObject({
    id: uuid(80),
    status: 'running',
    phase: 'reading',
  });
  expect(rows(h, 'watch_runs')).toHaveLength(1);
  expect(rows(h, 'watch_runs')[0]).toMatchObject({
    id: uuid(10031),
    rule_id: uuid(10030),
    status: 'running',
    request_key: 'H-consumed-slot',
    trigger: 'scheduled',
    scheduled_for: rows(h, 'watch_rules')[0].last_consumed_scheduled_for,
  });
  expect(JSON.parse(String(rows(h, 'watch_rules')[0].target_json)).sessionConsent).toEqual({
    version: 1,
    origin: 'https://example.invalid',
    grantedAt: '2026-10-10T00:00:00.000Z',
  });
  expect(rows(h, 'digest_schedules')[0]).toMatchObject({
    id: uuid(10034),
    version: 1,
    state: 'active',
    cursor_sequence: 1,
    ai_enabled: 1,
  });
  expect(rows(h, 'digest_runs')[0]).toMatchObject({
    id: uuid(10035),
    schedule_id: uuid(10034),
    state: 'running',
    lower_sequence: 0,
    upper_sequence: 1,
    next_sequence: 1,
  });
  const digest = rows(h, 'watch_digests')[0];
  expect(digest).toMatchObject({
    id: uuid(10036),
    schedule_id: uuid(10034),
    run_id: uuid(10035),
    provider_state: 'claimed',
    facts_revision: 1,
    claimed_facts_revision: 1,
    claimed_at: '2026-10-10T01:00:00.000Z',
  });
  expect(digest.facts_hash).toBe(
    createHash('sha256').update(String(digest.facts_json)).digest('hex'),
  );
  expect(digest.claimed_facts_hash).toBe(digest.facts_hash);
  expect(rows(h, 'notification_outbox')[0]).toMatchObject({
    id: uuid(10037),
    rule_id: uuid(10030),
    subject_id: uuid(10032),
    state: 'pending',
    attempts: 0,
    dedupe_key: `windows|event|${uuid(10032)}|1`,
  });
  reject(h, 'H', 'restored');
});

it('生产migrate后精确变化，源未被规范化', () => {
  verifySmallSnapshot(restored, 'H', 'restored');
  verifySmallFixture(join(root, 'H'), 'H', 'source');
  expect(rows(restored, 'research_tasks')[1]).toMatchObject({
    status: 'interrupted',
    phase: null,
    interrupted_at: at,
    updated_at: at,
  });
  expect(rows(restored, 'watch_runs')[0]).toMatchObject({ status: 'interrupted', finished_at: at });
  expect(rows(restored, 'watch_digests')[0]).toMatchObject({
    provider_state: 'uncertain',
    provider_result_code: 'uncertain-after-restart',
    provider_finished_at: at,
  });
  expect(rows(restored, 'digest_schedules')[0]).toMatchObject({
    state: 'paused',
    version: 2,
    updated_at: at,
  });
  expect(rows(restored, 'notification_outbox')[0]).toMatchObject({
    state: 'failed',
    attempts: 0,
    updated_at: at,
  });
  expect(
    JSON.parse(String(rows(restored, 'watch_rules')[0].target_json)).sessionConsent,
  ).toBeNull();
  reject(restored, 'H', 'source');
});

it('所有业务列逐项篡改均拒绝，不把规范化当整行豁免', () => {
  let mutations = 0;
  for (const [variant, snapshot, mode] of [
    ...variants.map((variant) => [variant, snapshots.get(variant)!, 'source'] as const),
    ['H', restored, 'restored'] as const,
  ]) {
    for (const [table, value] of Object.entries(snapshot)) {
      if (!Array.isArray(value)) continue;
      for (let index = 0; index < value.length; index++) {
        for (const [field, old] of Object.entries(value[index] as Row)) {
          const copy = structuredClone(snapshot);
          rows(copy, table)[index][field] =
            typeof old === 'number' ? old + 1 : typeof old === 'string' ? `${old}篡改` : '非空篡改';
          reject(copy, variant, mode);
          mutations++;
        }
      }
    }
  }
  expect(mutations).toBe(700);
  writeRecord('column-mutations.json', { mutations });
});

it('全业务表拒绝缺表、额外行、缺列和额外列', () => {
  for (const [table, value] of Object.entries(restored)) {
    const missing = structuredClone(restored);
    delete missing[table];
    reject(missing, 'H', 'restored');
    if (!Array.isArray(value)) continue;
    const extra = structuredClone(restored);
    rows(extra, table).push({ unexpected: 1 });
    reject(extra, 'H', 'restored');
    if (value.length > 0) {
      const missingColumn = structuredClone(restored);
      delete rows(missingColumn, table)[0][Object.keys(value[0] as Row)[0]];
      reject(missingColumn, 'H', 'restored');
      const extraColumn = structuredClone(restored);
      rows(extraColumn, table)[0].unexpected = 1;
      reject(extraColumn, 'H', 'restored');
    }
  }
  reject({ ...restored, unexpected: [] }, 'H', 'restored');
});

it('逐域混代和会话嵌套额外字段拒绝', () => {
  for (const prefix of ['sources', 'research_', 'watch_', 'conversation_']) {
    const bad = structuredClone(snapshots.get('A')!);
    for (const [key, value] of Object.entries(snapshots.get('B')!))
      if (key.startsWith(prefix)) bad[key] = value;
    reject(bad, 'A', 'source');
  }
  for (const key of ['conversation_index', 'conversation_session']) {
    const bad = structuredClone(restored);
    (bad[key] as Row).unexpected = 1;
    reject(bad, 'H', 'restored');
  }
  const reordered = structuredClone(restored);
  (reordered.conversation_session as { messages: unknown[] }).messages.reverse();
  reject(reordered, 'H', 'restored');
});

it('时间仅接受明确白名单，拒绝早于claim、非规范UTC及不同批次', () => {
  const fields = [
    ['research_tasks', 1, 'interrupted_at'],
    ['research_tasks', 1, 'updated_at'],
    ['watch_runs', 0, 'finished_at'],
    ['watch_digests', 0, 'provider_finished_at'],
    ['digest_schedules', 0, 'updated_at'],
    ['notification_outbox', 0, 'updated_at'],
    ['watch_rules', 0, 'updated_at'],
  ] as const;
  for (const [table, index, field] of fields) {
    for (const invalid of [
      '2026-10-10T00:59:59.999Z',
      '2026-10-10T02:00:00Z',
      '2026-10-10T10:00:00.000+08:00',
      null,
    ]) {
      const bad = structuredClone(restored);
      rows(bad, table)[index][field] = invalid;
      reject(bad, 'H', 'restored');
    }
    if (table === 'watch_rules') continue;
    const separate = structuredClone(restored);
    rows(separate, table)[index][field] = '2026-10-10T03:00:00.000Z';
    reject(separate, 'H', 'restored');
  }
  const independentClock = structuredClone(restored);
  rows(independentClock, 'watch_rules')[0].updated_at = '2026-10-10T03:00:00.000Z';
  verifySmallSnapshot(independentClock, 'H', 'restored');
});

it('读回oracle不改变源和恢复文件，也不制造sidecar', () => {
  const beforeSource = fingerprint(join(root, 'A'));
  const beforeRestored = fingerprint(restoredRoot);
  verifySmallFixture(join(root, 'A'), 'A', 'source');
  verifySmallFixture(restoredRoot, 'H', 'restored', 'work');
  expect(fingerprint(join(root, 'A'))).toEqual(beforeSource);
  expect(fingerprint(restoredRoot)).toEqual(beforeRestored);
  expect(() => createSmallFixture(join(root, 'A'), 'B')).toThrow();
  expect(fingerprint(join(root, 'A'))).toEqual(beforeSource);
});

it('真实库额外schema、sidecar和索引外会话文件拒绝并保留原件', () => {
  for (const kind of ['schema', 'sidecar', 'conversation'] as const) {
    const path = join(root, `bad-${kind}`);
    createSmallFixture(path, 'A');
    if (kind === 'schema') {
      const db = new DatabaseSync(join(path, 'sources/sources.db'));
      try {
        db.exec('CREATE TABLE forbidden_extra(id INTEGER)');
      } finally {
        db.close();
      }
    } else if (kind === 'sidecar') writeFileSync(join(path, 'watch/watch.db-journal'), '保留反例');
    else writeFileSync(join(path, 'conversations/extra.json'), '{}');
    const before = fingerprint(path);
    expect(() => verifySmallFixture(path, 'A', 'source')).toThrow();
    expect(fingerprint(path)).toEqual(before);
  }
});

it('真实库混代拒绝且本轮新物理产物小于16MiB', () => {
  const path = join(root, 'bad-mixed');
  createSmallFixture(path, 'A');
  copyFileSync(join(root, 'B/research/research.db'), join(path, 'research/research.db'));
  expect(() => verifySmallFixture(path, 'A', 'source')).toThrow();
  const bytes = files(root).reduce((sum, file) => sum + statSync(file).size, 0);
  expect(bytes).toBeLessThan(16 * 1024 ** 2);
  writeRecord('physical-budget.json', { bytes, limit: 16 * 1024 ** 2 });
});
