import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, lstatSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { createDatasetScope } from '../../../src/main/storage/dataset-layout';
import { runTransferPipeline } from '../../../src/main/storage/transfer-pipeline';
import { createSmallFixture, id, LIMIT, type Variant } from './seed';
import {
  readSmallSnapshot,
  snapshotHashes,
  verifySmallFixture,
  verifySmallSnapshot,
  type Snapshot,
} from './oracle';

const parent = join(process.cwd(), 'log/stage7-e2/restore-small-fixtures-001');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'pure-'));
const snapshots = new Map<Variant, Snapshot>();
for (const variant of ['A', 'B', 'H'] as const) {
  const path = join(root, variant);
  createSmallFixture(path, variant);
  const { snapshot, bytes } = readSmallSnapshot(path, variant);
  snapshots.set(variant, snapshot);
  writeFileSync(
    join(root, `${variant}-source.json`),
    JSON.stringify({ bytes, snapshot, hashes: snapshotHashes(snapshot) }, null, 2),
  );
}

it.each(['A', 'B', 'H'] as const)('固定%s通过当前生产scanner和闭合集合且≤16MiB', (variant) => {
  expect(verifySmallFixture(join(root, variant), variant, 'source').bytes).toBeLessThanOrEqual(
    LIMIT,
  );
});

it('拒绝混代、空库、错关联、额外行、缺失会话消息和篡改正文', () => {
  const original = snapshots.get('A')!;
  const cases: Snapshot[] = [];
  const mixed = structuredClone(original);
  mixed.research_tasks = snapshots.get('B')!.research_tasks;
  cases.push(mixed);
  const empty = structuredClone(original);
  empty.research_tasks = [];
  empty.research_results = [];
  empty.research_evidence = [];
  cases.push(empty);
  const wrong = structuredClone(original);
  (wrong.watch_rules as Record<string, unknown>[])[0].source_id = id('B');
  cases.push(wrong);
  const extra = structuredClone(original);
  (extra.sources as unknown[]).push(...(snapshots.get('B')!.sources as unknown[]));
  cases.push(extra);
  const absent = structuredClone(original);
  (absent.conversation_session as { messages: unknown[] }).messages.pop();
  cases.push(absent);
  const text = structuredClone(original);
  (text.conversation_session as { messages: { content: string }[] }).messages[0].content = '错误';
  cases.push(text);
  for (const sample of cases) expect(() => verifySmallSnapshot(sample, 'A', 'source')).toThrow();
});

it('危险历史未规范化不能被恢复oracle接受', () => {
  expect(() => verifySmallSnapshot(snapshots.get('H')!, 'H', 'restored')).toThrow();
});

it('拒绝额外会话文件并且保留现场', () => {
  const path = join(root, 'extra');
  createSmallFixture(path, 'A');
  writeFileSync(join(path, 'conversations', 'unlisted.json'), '{}');
  expect(() => verifySmallFixture(path, 'A', 'source')).toThrow('会话文件集合');
});

it('H生产backup保留危险历史，restore规范化且二次migrate保持旧事实与源', async () => {
  async function options(path: string, action: 'backup' | 'restore' | 'migrate') {
    const operationId = randomUUID();
    const scope = await createDatasetScope(
      {
        userDataRoot: path,
        operationId: operationId.replaceAll('-', ''),
        generation: randomUUID().replaceAll('-', ''),
        purpose: action,
      },
      { check() {}, requireRollbackSpace() {} },
    );
    return {
      job: { operationId, snapshotId: randomUUID(), action },
      scope,
      productVersion: '0.1.0',
      selectedInput: null,
      control: { signal: new AbortController().signal, deadline: performance.now() + 15000 },
      enterPhase: async () => {},
      nowIso: '2026-10-10T02:00:00.000Z',
    };
  }
  const backup = await options(join(root, 'H'), 'backup');
  await runTransferPipeline(backup);
  const backupWatch = new DatabaseSync(join(backup.scope.operationRoot, 'work', 'watch.db'), {
    readOnly: true,
  });
  try {
    expect(backupWatch.prepare('SELECT provider_state FROM watch_digests').get()).toEqual({
      provider_state: 'claimed',
    });
    expect(backupWatch.prepare('SELECT state FROM digest_schedules').get()).toEqual({
      state: 'active',
    });
  } finally {
    backupWatch.close();
  }
  verifySmallFixture(join(root, 'H'), 'H', 'source');
  const destination = join(root, 'restore');
  mkdirSync(destination);
  const restore = await options(destination, 'restore');
  const input = join(backup.scope.operationRoot, 'output.aibak');
  const stat = lstatSync(input, { bigint: true });
  await runTransferPipeline({
    ...restore,
    job: { ...restore.job, snapshotId: backup.job.snapshotId },
    selectedInput: {
      path: input,
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
    },
  });
  const work = join(restore.scope.operationRoot, 'work');
  const restored = readSmallSnapshot(work, 'H', 'work');
  verifySmallSnapshot(restored.snapshot, 'H', 'restored');
  writeFileSync(join(root, 'H-restored.json'), JSON.stringify(restored, null, 2));
  // Changing any retained cursor, slot, claim, notification attempt, or budget is forbidden.
  for (const [table, field, value] of [
    ['watch_rules', 'last_consumed_scheduled_for', null],
    ['digest_schedules', 'cursor_sequence', 0],
    ['digest_runs', 'next_sequence', 0],
    ['watch_digests', 'claimed_facts_hash', '0'.repeat(64)],
    ['notification_outbox', 'attempts', 1],
    ['digest_runs', 'blocked_available_bytes', 1],
  ] as const) {
    const bad = structuredClone(restored.snapshot);
    (bad[table] as Record<string, unknown>[])[0][field] = value;
    expect(() => verifySmallSnapshot(bad, 'H', 'restored')).toThrow();
  }
  verifySmallFixture(join(root, 'H'), 'H', 'source');
  const migratedRoot = join(root, 'second-migrate');
  mkdirSync(migratedRoot);
  for (const domain of ['sources', 'research', 'watch']) {
    mkdirSync(join(migratedRoot, domain));
    copyFileSync(join(work, `${domain}.db`), join(migratedRoot, domain, `${domain}.db`));
  }
  mkdirSync(join(migratedRoot, 'conversations'));
  for (const name of ['index.json', `${id('H', 9000)}.json`]) {
    copyFileSync(join(work, 'conversations', name), join(migratedRoot, 'conversations', name));
  }
  const second = await options(migratedRoot, 'migrate');
  second.nowIso = '2026-10-10T03:00:00.000Z';
  await runTransferPipeline(second);
  const twice = readSmallSnapshot(join(second.scope.operationRoot, 'work'), 'H', 'work');
  verifySmallSnapshot(twice.snapshot, 'H', 'restored');
  expect(twice.snapshot).toEqual(restored.snapshot);
}, 30000);
