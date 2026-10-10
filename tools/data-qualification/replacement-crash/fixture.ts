import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DatasetStartup,
  type DatasetStartupState,
} from '../../../src/main/storage/dataset-startup';
import {
  clearActiveDataset,
  registerActiveDataset,
} from '../../../src/main/storage/dataset-active';
import {
  createDatasetScope,
  inspectDatasetWork,
  type DatasetContext,
  type DatasetScope,
} from '../../../src/main/storage/dataset-layout';
import {
  DatasetReplacement,
  type DatasetReplacementContext,
} from '../../../src/main/storage/dataset-replacement';
import { DatasetSwitch } from '../../../src/main/storage/dataset-switch';
import { TransferBudget } from '../../../src/main/storage/transfer-budget';
import { isCheckpoint, type ReplacementCheckpoint } from './contracts';

const OPERATION_ID = 'a'.repeat(32);
const GENERATION = 'b'.repeat(32);
const ORACLE_NAME = '.replacement-crash-oracle.json';
const DOMAINS = ['sources', 'research', 'watch'] as const;
const OPAQUE_ACTIVE = Buffer.from('opaque-active-v1\n');
const OPAQUE_TEMP = Buffer.from('{invalid-json-active-v1\n');
const CANARY = Buffer.from('旁支不得改变\n');

interface OracleMember {
  readonly id: string;
  readonly live: string;
  readonly work: string;
  readonly oldSha256: string;
  readonly newSha256: string;
}

export interface FixtureOracle {
  readonly version: 1;
  readonly operationId: string;
  readonly generation: string;
  readonly operationRoot: string;
  readonly members: readonly OracleMember[];
  readonly oldActiveSha256: string;
  readonly oldTempSha256: string;
  readonly canarySha256: string;
  readonly gateSha256: string;
}

export interface OracleResult {
  readonly state: DatasetStartupState;
  readonly completeOldCopies: number;
  readonly completeNewCopies: number;
}

type Boundary = (point: ReplacementCheckpoint) => void | Promise<void>;
type HookGlobal = typeof globalThis & {
  __aibrowseReplacementCrashBoundary?: Boundary;
};

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function domainFile(root: string, domain: (typeof DOMAINS)[number]): string {
  return join(root, domain, `${domain}.db`);
}

function createMarkerDb(path: string, value: 'old' | 'new'): void {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('CREATE TABLE marker(value TEXT NOT NULL)');
    db.prepare('INSERT INTO marker VALUES (?)').run(value);
  } finally {
    db.close();
  }
}

function readMarker(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM marker').get() as { value?: unknown } | undefined;
    if (!row || (row.value !== 'old' && row.value !== 'new')) throw new Error('SQLite marker非法');
    return row.value;
  } finally {
    db.close();
  }
}

async function hashPath(path: string): Promise<string | null> {
  let entry;
  try {
    entry = await stat(path, { bigint: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  const link = lstatSync(path, { bigint: true });
  if (link.isSymbolicLink() || link.nlink !== 1n) throw new Error('fixture包含重解析点或硬链接');
  if (entry.isFile()) return sha256(await readFile(path));
  if (!entry.isDirectory()) throw new Error('fixture包含非普通成员');
  const hash = createHash('sha256').update('replacement-crash-tree-v1\0');
  for (const name of (await readdir(path)).sort()) {
    const child = await hashPath(join(path, name));
    if (child === null) throw new Error('fixture目录成员消失');
    hash.update(JSON.stringify([name, child]) + '\n');
  }
  return hash.digest('hex');
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('资格case根必须是未创建的新目录');
}

async function writeOracle(root: string, scope: DatasetScope): Promise<FixtureOracle> {
  const members: OracleMember[] = [];
  for (const domain of DOMAINS) {
    const live = relative(root, domainFile(root, domain));
    const work = relative(root, join(scope.operationRoot, 'work', `${domain}.db`));
    members.push({
      id: domain,
      live,
      work,
      oldSha256: (await hashPath(join(root, live)))!,
      newSha256: (await hashPath(join(root, work)))!,
    });
  }
  const oldConversation = relative(root, join(root, 'conversations'));
  const newConversation = relative(root, join(scope.operationRoot, 'work', 'conversations'));
  members.push({
    id: 'conversations',
    live: oldConversation,
    work: newConversation,
    oldSha256: (await hashPath(join(root, oldConversation)))!,
    newSha256: (await hashPath(join(root, newConversation)))!,
  });
  const oracle: FixtureOracle = {
    version: 1,
    operationId: OPERATION_ID,
    generation: GENERATION,
    operationRoot: relative(root, scope.operationRoot),
    members,
    oldActiveSha256: sha256(OPAQUE_ACTIVE),
    oldTempSha256: sha256(OPAQUE_TEMP),
    canarySha256: sha256(CANARY),
    gateSha256: sha256(Buffer.from('AIbrowse recovery barrier\n')),
  };
  await writeFile(join(root, ORACLE_NAME), JSON.stringify(oracle));
  return oracle;
}

export async function createFixture(
  root: string,
): Promise<{ scope: DatasetScope; oracle: FixtureOracle }> {
  const absolute = resolve(root);
  await assertAbsent(absolute);
  await mkdir(absolute);
  for (const domain of DOMAINS) await mkdir(join(absolute, domain));
  await mkdir(join(absolute, 'conversations'));
  for (const domain of DOMAINS) createMarkerDb(domainFile(absolute, domain), 'old');
  await writeFile(join(absolute, 'conversations', 'index.json'), 'old-session\n');
  await mkdir(join(absolute, 'conversations', 'nested'));
  await writeFile(join(absolute, 'conversations', 'nested', 'old.json'), 'old-nested\n');
  await writeFile(join(absolute, 'qualification-side-branch.bin'), CANARY);

  const context: DatasetContext = { check() {}, requireRollbackSpace() {} };
  const scope = await createDatasetScope(
    {
      userDataRoot: absolute,
      operationId: OPERATION_ID,
      generation: GENERATION,
      purpose: 'restore',
    },
    context,
  );
  for (const domain of DOMAINS)
    createMarkerDb(join(scope.operationRoot, 'work', `${domain}.db`), 'new');
  await mkdir(join(scope.operationRoot, 'work', 'conversations'));
  await writeFile(
    join(scope.operationRoot, 'work', 'conversations', 'index.json'),
    'new-session\n',
  );
  await writeFile(join(scope.operationRoot, 'work', 'conversations', 'new.json'), 'new-only\n');
  await writeFile(join(absolute, 'data-transfer', 'active.json'), OPAQUE_ACTIVE);
  await writeFile(join(absolute, 'data-transfer', 'active.json.tmp'), OPAQUE_TEMP);
  return { scope, oracle: await writeOracle(absolute, scope) };
}

export async function runWriter(root: string, boundary: Boundary): Promise<'normal'> {
  const { scope } = await createFixture(root);
  const context: DatasetReplacementContext = {
    check() {},
    requireRollbackSpace() {},
    assertNoWriters() {},
    async boundary(point) {
      if (isCheckpoint(point)) await boundary(point);
    },
  };
  const global = globalThis as HookGlobal;
  if (global.__aibrowseReplacementCrashBoundary) throw new Error('资格active hook已被占用');
  global.__aibrowseReplacementCrashBoundary = boundary;
  try {
    const replacement = new DatasetReplacement(scope, context);
    await replacement.prepare();
    await replacement.archivePrevious();
    await registerActiveDataset(scope);
    const expected = await inspectDatasetWork(scope, context);
    const engine = new DatasetSwitch(scope, context);
    const handoff = await engine.registerHandoff(expected, new TransferBudget().suspend());
    if (handoff.state !== 'handoff') throw new Error('handoff登记失败');
    const resumed = await engine.resumeAtStartup();
    if (resumed.state !== 'new-awaiting-health') throw new Error('新代切换失败');
    const committed = await engine.commitHealthy();
    if (committed.state !== 'committed') throw new Error('新代提交失败');
    await replacement.retireGateAfterCommit(() => {});
    await clearActiveDataset(scope);
    return 'normal';
  } finally {
    delete global.__aibrowseReplacementCrashBoundary;
  }
}

async function assertNewConversation(root: string): Promise<void> {
  if (
    (await readFile(join(root, 'conversations', 'index.json'), 'utf8')) !== 'new-session\n' ||
    (await readFile(join(root, 'conversations', 'new.json'), 'utf8')) !== 'new-only\n'
  )
    throw new Error('新会话哨兵不完整');
}

export async function reopenFixture(root: string): Promise<DatasetStartupState> {
  const startup = new DatasetStartup({ assertNoWriters() {} });
  const state = await startup.prepare(resolve(root));
  if (state === 'checking') {
    const handles = DOMAINS.map((domain) => startup.open(domain));
    try {
      for (const handle of handles) {
        const row = handle.prepare('SELECT value FROM marker').get() as
          { value?: unknown } | undefined;
        if (row?.value !== 'new') throw new Error('只读健康句柄未看到完整新代marker');
      }
      await assertNewConversation(resolve(root));
      if (!(await startup.complete(true)) || startup.getState() !== 'normal')
        throw new Error('闭合合成健康oracle未完成');
    } finally {
      for (const handle of handles) handle.close();
    }
    return 'normal';
  }
  if (state === 'normal') {
    for (const domain of DOMAINS)
      if (readMarker(domainFile(resolve(root), domain)) !== 'new')
        throw new Error('普通准入包含非新代marker');
    await assertNewConversation(resolve(root));
  }
  return state;
}

function safeStoredPath(root: string, stored: string): string {
  if (!stored || stored === '..' || stored.startsWith('..' + sep))
    throw new Error('oracle路径越界');
  const path = resolve(root, stored);
  if (!path.startsWith(resolve(root) + sep)) throw new Error('oracle路径越界');
  return path;
}

async function readOracle(root: string): Promise<FixtureOracle> {
  const bytes = await readFile(join(root, ORACLE_NAME));
  if (bytes.length > 64 * 1024) throw new Error('oracle文件超限');
  const value = JSON.parse(bytes.toString('utf8')) as FixtureOracle;
  if (
    value.version !== 1 ||
    value.operationId !== OPERATION_ID ||
    value.generation !== GENERATION ||
    !Array.isArray(value.members) ||
    value.members.length !== 4
  )
    throw new Error('oracle文件非法');
  return value;
}

export async function inspectFixture(
  root: string,
  state: DatasetStartupState,
): Promise<OracleResult> {
  const absolute = resolve(root);
  const oracle = await readOracle(absolute);
  const operation = safeStoredPath(absolute, oracle.operationRoot);
  if ((await hashPath(join(absolute, 'qualification-side-branch.bin'))) !== oracle.canarySha256)
    throw new Error('旁支canary被改变');
  let completeOldCopies = 0;
  let completeNewCopies = 0;
  for (const member of oracle.members) {
    const live = safeStoredPath(absolute, member.live);
    const work = safeStoredPath(absolute, member.work);
    const rollback = join(operation, 'rollback', member.id);
    const retired = join(operation, 'retired', member.id);
    const values = await Promise.all([live, rollback, retired].map(hashPath));
    const oldCopies = values.filter((value) => value === member.oldSha256).length;
    if (oldCopies < 1) throw new Error(`旧${member.id}原件丢失`);
    completeOldCopies += oldCopies;
    for (const [index, value] of values.entries()) {
      if (value === null || value === member.oldSha256) continue;
      if (index === 0 && value === member.newSha256) continue;
      throw new Error(`${member.id}出现未知或混合字节`);
    }
    const newValues = await Promise.all([live, work].map(hashPath));
    if (!newValues.includes(member.newSha256)) throw new Error(`新${member.id}目标丢失`);
    completeNewCopies += newValues.filter((value) => value === member.newSha256).length;
    if (member.id !== 'conversations') {
      for (const [index, path] of [live, work].entries()) {
        const value = newValues[index];
        if (value === null) continue;
        const marker = readMarker(path);
        if (
          (value === member.oldSha256 && marker !== 'old') ||
          (value === member.newSha256 && marker !== 'new')
        )
          throw new Error(`${member.id} marker与字节代不一致`);
      }
    }
    if (state === 'normal' && values[0] !== member.newSha256)
      throw new Error('普通准入不是完整新代');
  }
  const pointerLocations = [
    join(absolute, 'data-transfer', 'active.json'),
    join(absolute, 'data-transfer', 'active.json.tmp'),
    join(operation, 'evidence', 'active.json'),
    join(operation, 'evidence', 'active.json.tmp'),
  ];
  const pointerHashes = await Promise.all(pointerLocations.map(hashPath));
  if (pointerHashes.filter((value) => value === oracle.oldActiveSha256).length !== 1)
    throw new Error('opaque旧active原件数量不是一份');
  if (pointerHashes.filter((value) => value === oracle.oldTempSha256).length !== 1)
    throw new Error('非法JSON旧active.tmp原件数量不是一份');
  const gateHashes = await Promise.all(
    [
      join(absolute, 'data-transfer', 'recovery-gate'),
      join(operation, 'evidence', 'recovery-gate'),
    ].map(hashPath),
  );
  if (gateHashes.filter((value) => value !== null).length !== 1)
    throw new Error('恢复gate原件数量不是一份');
  const gate = gateHashes.find((value) => value !== null)!;
  if (gate !== oracle.gateSha256 && gate !== sha256(Buffer.alloc(0)))
    throw new Error('恢复gate字节不是完整值或已知创建中空值');
  if (state === 'normal') {
    if (pointerHashes[0] !== null || pointerHashes[1] !== null)
      throw new Error('普通准入仍残留active指针');
    if (gateHashes[0] !== null) throw new Error('普通准入仍残留live gate');
    if (gate !== oracle.gateSha256) throw new Error('普通准入gate归档不完整');
  } else if (state !== 'recovery-required') throw new Error('未知启动准入状态');
  return { state, completeOldCopies, completeNewCopies };
}

export const fixtureConstants = Object.freeze({
  operationId: OPERATION_ID,
  generation: GENERATION,
  oracleName: ORACLE_NAME,
});
