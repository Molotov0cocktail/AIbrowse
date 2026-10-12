import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { createDatasetScope, inspectDatasetWork, type DatasetContext } from './dataset-layout';
import { DatasetSwitch } from './dataset-switch';
import { DatasetStartup } from './dataset-startup';
import { registerActiveDataset, readActiveDataset } from './dataset-active';
import { TransferBudget } from './transfer-budget';
import { runTransferPipeline, type TransferPipelineOptions } from './transfer-pipeline';
import { inspectNativeRestoreInput } from './native-transfer-selection';
import { readBackupContainer } from './backup-container';
import { openBrowserLibraryStore } from '../browser-library/browser-library-store';

const context: DatasetContext = { check() {}, requireRollbackSpace() {} };
const domains = ['sources', 'research', 'watch'] as const;
async function legacyFixture(browserPresent = true) {
  const root = mkdtempSync(join(tmpdir(), 'browser-legacy-journal-'));
  const scope = await createDatasetScope(
    {
      userDataRoot: root,
      operationId: randomUUID().replaceAll('-', ''),
      generation: randomUUID().replaceAll('-', ''),
      purpose: 'restore',
    },
    context,
  );
  for (const domain of [...domains, 'browser']) {
    if (domain !== 'browser' || browserPresent) mkdirSync(join(root, domain));
    const paths = [join(scope.operationRoot, 'work', `${domain}.db`)];
    if (domain !== 'browser' || browserPresent) paths.push(join(root, domain, `${domain}.db`));
    for (const path of paths) {
      const db = new DatabaseSync(path);
      db.exec('CREATE TABLE marker(value TEXT)');
      db.prepare('INSERT INTO marker VALUES (?)').run(
        path.startsWith(scope.operationRoot) ? 'new' : 'old',
      );
      db.close();
    }
  }
  for (const directory of [
    join(root, 'conversations'),
    join(scope.operationRoot, 'work', 'conversations'),
  ]) {
    mkdirSync(directory);
    writeFileSync(
      join(directory, 'index.json'),
      directory.startsWith(scope.operationRoot) ? 'new' : 'old',
    );
  }
  const engine = new DatasetSwitch(scope, context);
  expect(
    (
      await engine.registerHandoff(
        await inspectDatasetWork(scope, context),
        new TransferBudget().suspend(),
      )
    ).state,
  ).toBe('handoff');
  const path = join(scope.operationRoot, 'journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8')) as {
    version: number;
    next: unknown[];
    old: unknown[] | null;
    seq: number;
  };
  journal.version = 1;
  journal.next = journal.next.slice(0, 13);
  writeFileSync(path, JSON.stringify(journal));
  await registerActiveDataset(scope);
  return { root, scope, journal, path };
}

it.each([true, false])(
  '旧13成员handoff保持独立browser存在=%s并仅以三个健康句柄提交',
  async (present) => {
    const f = await legacyFixture(present);
    const browser = join(f.root, 'browser', 'browser.db');
    const before = present ? readFileSync(browser) : null;
    const startup = new DatasetStartup({ assertNoWriters() {} });
    expect(await startup.prepare(f.root)).toBe('checking');
    expect(startup.includesDomain('browser')).toBe(false);
    expect(() => startup.open('browser')).toThrow();
    const handles = domains.map((domain) => startup.open(domain));
    expect(await startup.complete(true)).toBe(true);
    handles.forEach((handle) => handle.close());
    expect(await readActiveDataset(f.root)).toBeNull();
    if (before) expect(readFileSync(browser)).toEqual(before);
    else expect(existsSync(browser)).toBe(false);
    expect(await new DatasetStartup({ assertNoWriters() {} }).prepare(f.root)).toBe('normal');
  },
);

it('旧部分切换故障只回退原13成员，browser主库及附属文件字节不变', async () => {
  const f = await legacyFixture();
  const originals = new Map<string, Buffer>();
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const path = join(f.root, 'browser', 'browser.db' + suffix);
    if (suffix) writeFileSync(path, 'browser-sidecar-sentinel');
    originals.set(path, readFileSync(path));
  }
  let failed = false;
  const engine = new DatasetSwitch(f.scope, {
    ...context,
    boundary(point) {
      if (!failed && point === 'installed:0') {
        failed = true;
        throw new Error('合成故障');
      }
    },
  });
  expect((await engine.resumeAtStartup()).state).toBe('old-restored');
  for (const [path, bytes] of originals) expect(readFileSync(path)).toEqual(bytes);
  expect(await new DatasetStartup({ assertNoWriters() {} }).prepare(f.root)).toBe('normal');
  expect(await readActiveDataset(f.root)).toBeNull();
});

it.each(['version-length', 'legacy-extra-members', 'mixed-tmp'] as const)(
  '旧journal %s拒绝且不改原库或正式journal',
  async (kind) => {
    const f = await legacyFixture();
    const before = readFileSync(join(f.root, 'sources', 'sources.db'));
    if (kind === 'version-length') {
      f.journal.version = 2;
      writeFileSync(f.path, JSON.stringify(f.journal));
    } else {
      const browser = (await inspectDatasetWork(f.scope, context)).browser;
      const next = [...f.journal.next, [browser.bytes, browser.sha256], null, null, null];
      if (kind === 'legacy-extra-members') {
        writeFileSync(f.path, JSON.stringify({ ...f.journal, next }));
      } else {
        const temporary = {
          ...f.journal,
          version: 2,
          seq: 1,
          phase: 'inventory',
          attempts: [1, 0, 0],
          remaining: [0, 30000, 30000, 60000],
          next,
        };
        writeFileSync(f.path, JSON.stringify(temporary));
        expect(await new DatasetSwitch(f.scope, context).readBudgetState()).not.toBeNull();
        writeFileSync(f.path, JSON.stringify(f.journal));
        writeFileSync(f.path + '.tmp', JSON.stringify(temporary));
      }
    }
    const journalBefore = readFileSync(f.path);
    expect((await new DatasetSwitch(f.scope, context).resumeAtStartup()).state).toBe(
      'recovery-required',
    );
    expect(readFileSync(f.path)).toEqual(journalBefore);
    expect(readFileSync(join(f.root, 'sources', 'sources.db'))).toEqual(before);
  },
);

it('旧committed仍有active时按13成员核验并退休，不误检查后续browser', async () => {
  const f = await legacyFixture();
  const engine = new DatasetSwitch(f.scope, context);
  expect((await engine.resumeAtStartup()).state).toBe('new-awaiting-health');
  expect((await engine.commitHealthy()).state).toBe('committed');
  writeFileSync(join(f.root, 'browser', 'browser.db'), 'independent-browser-newer-sentinel');
  expect(await new DatasetStartup({ assertNoWriters() {} }).prepare(f.root)).toBe('normal');
  expect(await readActiveDataset(f.root)).toBeNull();
});

async function pipelineFixture(action: 'backup' | 'restore'): Promise<TransferPipelineOptions> {
  const root = mkdtempSync(join(tmpdir(), 'browser-backup-compatibility-'));
  const operationId = randomUUID();
  const scope = await createDatasetScope(
    {
      userDataRoot: root,
      operationId: operationId.replaceAll('-', ''),
      generation: randomUUID().replaceAll('-', ''),
      purpose: action,
    },
    context,
  );
  return {
    scope,
    job: { operationId, snapshotId: randomUUID(), action },
    productVersion: '0.1.4',
    selectedInput: null,
    control: { signal: new AbortController().signal, deadline: performance.now() + 30000 },
    enterPhase: async () => {},
    nowIso: '2026-10-12T00:00:00.000Z',
  };
}

function legacyContainer(path: string): Buffer {
  const current = readFileSync(path);
  const oldLength = current.readUInt32BE(12);
  const manifest = JSON.parse(current.subarray(16, 16 + oldLength).toString('utf8')) as {
    formatVersion: number;
    members: Array<{ bytes: number }>;
  };
  manifest.formatVersion = 1;
  manifest.members = manifest.members.slice(0, 4);
  const payload = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.from(current.subarray(0, 16));
  header.writeUInt32BE(1, 8);
  header.writeUInt32BE(payload.length, 12);
  const frames = manifest.members.reduce((sum, member) => sum + 58 + member.bytes, 0);
  return Buffer.concat([
    header,
    payload,
    current.subarray(16 + oldLength, 16 + oldLength + frames),
  ]);
}

it('新v2备份包含browser，旧v1恢复保留当前browser访问和书签并验证同一候选', async () => {
  const backup = await pipelineFixture('backup');
  await runTransferPipeline(backup);
  const source = join(backup.scope.operationRoot, 'output.aibak');
  const bytes = legacyContainer(source);
  const inputPath = join(backup.scope.operationRoot, 'legacy.aibak');
  writeFileSync(inputPath, bytes);
  expect(
    readBackupContainer({
      inputPath,
      stagingDirectory: join(backup.scope.operationRoot, 'legacy-check'),
      control: backup.control,
    }).manifest.formatVersion,
  ).toBe(1);
  const restore = await pipelineFixture('restore');
  const dbPath = join(restore.scope.userDataRoot, 'browser', 'browser.db');
  const store = openBrowserLibraryStore({ dbPath });
  if (store.mode !== 'normal') throw new Error(store.reason);
  const input = { url: 'https://example.com/current?q=private#hash', title: '当前浏览' };
  expect(store.service.recordNavigation(input).ok).toBe(true);
  expect(store.service.addBookmark(input).ok).toBe(true);
  store.service.dispose();
  const before = readFileSync(dbPath);
  const selection = await inspectNativeRestoreInput(inputPath);
  restore.selectedInput = selection.input;
  restore.job = { ...restore.job, snapshotId: selection.snapshotId };
  const result = await runTransferPipeline(restore);
  expect(result.manifest.formatVersion).toBe(2);
  expect(result.manifest.members).toHaveLength(5);
  expect(readFileSync(inputPath)).toEqual(bytes);
  expect(readFileSync(dbPath)).toEqual(before);
  const candidate = openBrowserLibraryStore({
    dbPath: join(restore.scope.operationRoot, 'work', 'browser.db'),
  });
  if (candidate.mode !== 'normal') throw new Error(candidate.reason);
  try {
    const history = candidate.service.listHistory({ query: '', cursor: null, limit: 100 });
    expect(history).toMatchObject({ ok: true, value: { items: [input] } });
    expect(candidate.service.getBookmarkForUrl(input.url)).toMatchObject({
      ok: true,
      value: input,
    });
  } finally {
    candidate.service.dispose();
  }
  expect(statSync(inputPath).size).toBe(bytes.length);
});
