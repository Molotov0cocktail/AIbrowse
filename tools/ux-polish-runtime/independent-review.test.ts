import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { BROWSER_MIGRATIONS } from '../../src/main/browser-library/browser-library-migrations';
import {
  BrowserLibraryRepository,
  validateBrowserLibraryTransfer,
} from '../../src/main/browser-library/browser-library-repository';
import { openBrowserLibraryStore } from '../../src/main/browser-library/browser-library-store';
import { createDatasetScope } from '../../src/main/storage/dataset-layout';
import {
  runTransferPipeline,
  type TransferPipelineOptions,
} from '../../src/main/storage/transfer-pipeline';
import type { DbHandle } from '../../src/main/sources/db/sqlite-driver';
import { writeBackupContainer } from '../../src/main/storage/backup-container';
import {
  createCampaignFixture,
  verifyCampaignFixture,
} from '../data-qualification/product-restore-campaign/browser-fixture';

const stamp = '2026-10-29T00:00:00.000Z';
const request = { query: '', cursor: null, limit: 100 };
const evidence = join(process.cwd(), 'log/ux-polish-20261029');
mkdirSync(evidence, { recursive: true });
const root = mkdtempSync(join(evidence, 'independent-fixtures-'));

it('既有恢复验收夹具兼容当前书签schema', () => {
  const directory = join(root, `campaign-${randomUUID()}`);
  createCampaignFixture(directory, 'A');
  expect(verifyCampaignFixture(directory, 'A', 'source').browserBytes).toBeGreaterThan(0);
});

function schema(db: DatabaseSync, version: 1 | 2): void {
  for (const step of BROWSER_MIGRATIONS.slice(0, version)) {
    for (const sql of step.statements) db.exec(sql);
    db.exec(`PRAGMA user_version=${step.version}`);
  }
}

it.each(['update', 'remove'] as const)('空组清理失败时%s完整回滚书签与归属', (action) => {
  const db = new DatabaseSync(':memory:');
  schema(db, 2);
  let failCleanup = false;
  const handle: DbHandle = {
    path: ':memory:',
    get isOpen() {
      return db.isOpen;
    },
    prepare(sql) {
      if (failCleanup && sql.startsWith('DELETE FROM browser_bookmark_groups'))
        throw new Error('合成清理故障');
      return db.prepare(sql);
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
  try {
    const repo = new BrowserLibraryRepository(handle);
    repo.saveBookmarkGroup(
      { name: '原组', color: 'blue', bookmarks: [{ url: 'https://example.test/', title: '原名' }] },
      stamp,
    );
    const before = repo.listBookmarks(request);
    const groups = repo.listBookmarkGroups();
    const item = before.items[0]!;
    failCleanup = true;
    expect(() =>
      action === 'remove'
        ? repo.removeBookmark(item.id)
        : repo.updateBookmark({ id: item.id, url: item.url, title: '新名', groupId: null }, stamp),
    ).toThrow('合成清理故障');
    expect(repo.listBookmarks(request)).toEqual(before);
    expect(repo.listBookmarkGroups()).toEqual(groups);
  } finally {
    db.close();
  }
});

it('v1本地迁移完整保留历史与书签身份和时间', () => {
  const path = join(root, `${randomUUID()}.db`);
  const db = new DatabaseSync(path);
  schema(db, 1);
  const id = randomUUID();
  db.prepare('INSERT INTO browser_bookmarks VALUES(?,?,?,?,?)').run(
    id,
    'https://example.test/?q=kept#kept',
    '旧书签',
    stamp,
    stamp,
  );
  db.prepare('INSERT INTO browser_history VALUES(?,?,?,?)').run(
    id,
    'https://example.test/',
    '旧历史',
    stamp,
  );
  db.close();
  const outcome = openBrowserLibraryStore({ dbPath: path });
  expect(outcome.mode).toBe('normal');
  if (outcome.mode !== 'normal') return;
  try {
    expect(outcome.service.listBookmarks(request)).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            id,
            groupId: null,
            title: '旧书签',
            createdAt: stamp,
            updatedAt: stamp,
            url: 'https://example.test/?q=kept#kept',
          },
        ],
      },
    });
    expect(outcome.service.listHistory(request)).toMatchObject({
      ok: true,
      value: { items: [{ id, title: '旧历史', visitedAt: stamp }] },
    });
  } finally {
    outcome.service.dispose();
  }
});

it('v2传输语义拒绝孤立外键与超预算分组', () => {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  schema(db, 2);
  try {
    db.prepare('INSERT INTO browser_bookmarks VALUES(?,?,?,?,?,?)').run(
      randomUUID(),
      'https://example.test/',
      '',
      stamp,
      stamp,
      randomUUID(),
    );
    expect(validateBrowserLibraryTransfer(db)).toEqual({ ok: false });
    db.exec('DELETE FROM browser_bookmarks');
    for (let i = 0; i < 101; i++)
      db.prepare('INSERT INTO browser_bookmark_groups VALUES(?,?,?)').run(
        randomUUID(),
        `组${i}`,
        'grey',
      );
    expect(validateBrowserLibraryTransfer(db)).toEqual({ ok: false });
  } finally {
    db.close();
  }
});

async function options(action: 'backup' | 'restore'): Promise<TransferPipelineOptions> {
  const userDataRoot = mkdtempSync(join(root, 'profile-'));
  const operationId = randomUUID();
  const scope = await createDatasetScope(
    {
      userDataRoot,
      operationId: operationId.replaceAll('-', ''),
      generation: randomUUID().replaceAll('-', ''),
      purpose: action,
    },
    { check() {}, requireRollbackSpace() {} },
  );
  return {
    job: { operationId, snapshotId: randomUUID(), action },
    scope,
    productVersion: '0.1.17',
    selectedInput: null,
    control: { signal: new AbortController().signal, deadline: performance.now() + 15000 },
    enterPhase: async () => {},
    nowIso: stamp,
  };
}

it('历史format2/schema1备份可恢复并迁移为未分组且原件恒等', async () => {
  const restore = await options('restore');
  const directory = mkdtempSync(join(root, 'historical-'));
  const oldPath = join(directory, 'browser.db');
  const db = new DatabaseSync(oldPath);
  schema(db, 1);
  const id = randomUUID();
  db.prepare('INSERT INTO browser_bookmarks VALUES(?,?,?,?,?)').run(
    id,
    'https://example.test/old',
    '历史备份项',
    stamp,
    stamp,
  );
  db.close();
  const archive = join(root, `old-${randomUUID()}.aibak`);
  const oldBytes = readFileSync(oldPath);
  const packed = writeBackupContainer({
    snapshotDirectory: directory,
    files: {
      sources: null,
      research: null,
      watch: null,
      conversations: null,
      browser: { path: oldPath, snapshotId: restore.job.snapshotId, schemaVersion: 1 },
    },
    outputPath: archive,
    snapshotId: restore.job.snapshotId,
    productVersion: '0.1.16',
    control: restore.control,
  });
  expect(packed.manifest.formatVersion).toBe(2);
  expect(packed.manifest.members.find((member) => member.id === 'browser')?.schemaVersion).toBe(1);
  const archiveBytes = readFileSync(archive);
  const stat = lstatSync(archive, { bigint: true });
  restore.selectedInput = {
    path: archive,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
  await runTransferPipeline(restore);
  const restored = new DatabaseSync(join(restore.scope.operationRoot, 'work/browser.db'), {
    readOnly: true,
  });
  try {
    expect(restored.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
    expect(restored.prepare('SELECT id,title,group_id FROM browser_bookmarks').all()).toEqual([
      { id, title: '历史备份项', group_id: null },
    ]);
    expect(validateBrowserLibraryTransfer(restored)).toEqual({ ok: true });
  } finally {
    restored.close();
  }
  expect(readFileSync(archive)).toEqual(archiveBytes);
  expect(readFileSync(oldPath)).toEqual(oldBytes);
});

it.each([1, 2] as const)('真实传输管道备份/恢复v%s书签且不改原库', async (version) => {
  const backup = await options('backup');
  const dir = join(backup.scope.userDataRoot, 'browser');
  mkdirSync(dir);
  const path = join(dir, 'browser.db');
  const db = new DatabaseSync(path);
  schema(db, version);
  const id = randomUUID();
  const groupId = randomUUID();
  if (version === 2)
    db.prepare('INSERT INTO browser_bookmark_groups VALUES(?,?,?)').run(
      groupId,
      '备份组',
      'purple',
    );
  db.prepare(
    'INSERT INTO browser_bookmarks(id,url,title,created_at,updated_at) VALUES(?,?,?,?,?)',
  ).run(id, 'https://example.test/', '保留项', stamp, stamp);
  if (version === 2) db.prepare('UPDATE browser_bookmarks SET group_id=?').run(groupId);
  db.close();
  const bytes = readFileSync(path);
  await runTransferPipeline(backup);
  expect(readFileSync(path)).toEqual(bytes);
  const archive = join(backup.scope.operationRoot, 'output.aibak');
  const restore = await options('restore');
  restore.job = { ...restore.job, snapshotId: backup.job.snapshotId };
  const stat = lstatSync(archive, { bigint: true });
  restore.selectedInput = {
    path: archive,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
  await runTransferPipeline(restore);
  const restored = new DatabaseSync(join(restore.scope.operationRoot, 'work/browser.db'), {
    readOnly: true,
  });
  try {
    expect(validateBrowserLibraryTransfer(restored)).toEqual({ ok: true });
    expect(restored.prepare('SELECT id,title,group_id FROM browser_bookmarks').all()).toEqual([
      { id, title: '保留项', group_id: version === 2 ? groupId : null },
    ]);
    expect(restored.prepare('SELECT name,color FROM browser_bookmark_groups').all()).toEqual(
      version === 2 ? [{ name: '备份组', color: 'purple' }] : [],
    );
  } finally {
    restored.close();
  }
});
