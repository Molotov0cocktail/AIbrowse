import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  DATASET_MEMBERS,
  createDatasetScope,
  inspectDatasetWork,
  readDatasetScope,
  type DatasetContext,
  type DatasetScope,
} from '../../../src/main/storage/dataset-layout';
import {
  DatasetSwitch,
  type DatasetSwitchCode,
  type DatasetSwitchState,
} from '../../../src/main/storage/dataset-switch';
import { TransferBudget } from '../../../src/main/storage/transfer-budget';
import { GENERATIONS, LIMITS, OPERATION_IDS, need, type Scene } from './contract';

const ORACLE_NAME = '.old-data-deadline-oracle.json';
const SIDE_BRANCH_NAME = 'qualification-side-branch.bin';
const OLD_SOURCES_BYTES = 257;
const OLD_FILE_LENGTHS = [257, 263, 269, 271, 277, 281, 283, 293, 307, 311, 313, 317] as const;
const WORK_FILE_LENGTHS = [101, 103, 107] as const;
const OLD_CONVERSATION_LENGTHS = [331, 337] as const;
const WORK_CONVERSATION_LENGTHS = [109, 113] as const;

interface FileFact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly dev: string;
  readonly ino: string;
}
interface TreeFact {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly files: readonly FileFact[];
}
export interface FixtureOracle {
  readonly version: 1;
  readonly scene: Scene;
  readonly operationId: string;
  readonly generation: string;
  readonly old: readonly (FileFact | TreeFact)[];
  readonly work: readonly (FileFact | TreeFact)[];
  readonly sideBranch: FileFact;
}
export interface SceneResult {
  readonly scene: Scene;
  readonly action: 'initial' | 'reopen';
  readonly state: DatasetSwitchState;
  readonly code: DatasetSwitchCode;
  readonly journalPhase: string;
  readonly rollbackCopyRemaining: number;
  readonly rollbackCopyBudget: number;
  readonly selected: number;
  readonly waitedMs: number;
  readonly rollbackSpaceCalls: number;
  readonly rollbackSpaceBytes: number;
}
export interface SceneHooks {
  wait(): Promise<void>;
  selected?(phase: 'inventory' | 'backing-up'): void | Promise<void>;
  now?: () => number;
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function controlled(root: string, path: string): string {
  const value = relative(resolve(root), resolve(path));
  need(value && value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value));
  return value.replaceAll('\\', '/');
}
function payload(length: number, marker: number): Buffer {
  need(Number.isSafeInteger(length) && length > 0 && marker >= 0 && marker < 256);
  const value = Buffer.alloc(length, marker);
  value[0] = marker;
  value[length - 1] = marker ^ 0xff;
  return value;
}
async function shaFile(path: string): Promise<string> {
  const handle = await open(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(4096);
  try {
    for (;;) {
      const read = await handle.read(buffer);
      if (!read.bytesRead) break;
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}
async function fileFact(root: string, path: string): Promise<FileFact> {
  const absolute = resolve(path);
  const value = await lstat(absolute, { bigint: true });
  need(
    value.isFile() &&
      !value.isSymbolicLink() &&
      value.nlink === 1n &&
      samePath(realpathSync.native(absolute), absolute),
  );
  return {
    path: controlled(root, absolute),
    bytes: Number(value.size),
    sha256: await shaFile(absolute),
    dev: value.dev.toString(),
    ino: value.ino.toString(),
  };
}
async function treeFact(root: string, path: string): Promise<TreeFact> {
  const absolute = resolve(path);
  const value = await lstat(absolute, { bigint: true });
  need(
    value.isDirectory() &&
      !value.isSymbolicLink() &&
      samePath(realpathSync.native(absolute), absolute),
  );
  const files: FileFact[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      need(!entry.isSymbolicLink());
      const child = join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else {
        need(entry.isFile());
        files.push(await fileFact(root, child));
      }
    }
  }
  await visit(absolute);
  const hash = createHash('sha256').update('old-data-deadline-tree-v1\0');
  let bytes = 0;
  for (const file of files) {
    hash.update(
      JSON.stringify([
        relative(absolute, resolve(root, file.path)).replaceAll('\\', '/'),
        file.bytes,
        file.sha256,
      ]) + '\n',
    );
    bytes += file.bytes;
  }
  return {
    path: controlled(root, absolute),
    dev: value.dev.toString(),
    ino: value.ino.toString(),
    bytes,
    sha256: hash.digest('hex'),
    files,
  };
}
async function memberFact(root: string, path: string): Promise<FileFact | TreeFact> {
  return (await stat(path)).isDirectory() ? treeFact(root, path) : fileFact(root, path);
}
async function exactFact(root: string, expected: FileFact | TreeFact): Promise<void> {
  const path = resolve(root, expected.path);
  need(controlled(root, path) === expected.path);
  const actual = 'files' in expected ? await treeFact(root, path) : await fileFact(root, path);
  need(JSON.stringify(actual) === JSON.stringify(expected), '哨兵身份或字节已改变');
}
async function absent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('固定scene根已经存在，禁止复用');
}
async function boundedJournal(scope: DatasetScope): Promise<Record<string, unknown>> {
  const bytes = await readFile(join(scope.operationRoot, 'journal.json'));
  need(bytes.length > 1 && bytes.length <= 4096);
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  need(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}
function journalSummary(journal: Record<string, unknown>): {
  phase: string;
  rollbackCopyRemaining: number;
  rollbackCopyBudget: number;
} {
  need(typeof journal.phase === 'string');
  need(Array.isArray(journal.remaining) && journal.remaining.length === 4);
  const budget = journal.budget;
  need(budget && typeof budget === 'object' && !Array.isArray(budget));
  const phaseRemainingMs = (budget as Record<string, unknown>).phaseRemainingMs;
  need(
    phaseRemainingMs && typeof phaseRemainingMs === 'object' && !Array.isArray(phaseRemainingMs),
  );
  const remaining = journal.remaining[0];
  const budgetValue = (phaseRemainingMs as Record<string, unknown>).rollbackCopy;
  need(typeof remaining === 'number' && typeof budgetValue === 'number');
  return {
    phase: journal.phase,
    rollbackCopyRemaining: remaining,
    rollbackCopyBudget: budgetValue,
  };
}

async function writeLiveMembers(root: string): Promise<void> {
  let index = 0;
  for (const [, live] of DATASET_MEMBERS.slice(0, 12)) {
    const path = join(root, live);
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, payload(OLD_FILE_LENGTHS[index]!, 0x20 + index), { flag: 'wx' });
    index++;
  }
  const conversations = join(root, 'conversations');
  await mkdir(join(conversations, 'nested'), { recursive: true });
  await writeFile(join(conversations, 'index.json'), payload(OLD_CONVERSATION_LENGTHS[0], 0x51), {
    flag: 'wx',
  });
  await writeFile(
    join(conversations, 'nested', 'old.json'),
    payload(OLD_CONVERSATION_LENGTHS[1], 0x52),
    { flag: 'wx' },
  );
  await writeFile(join(root, SIDE_BRANCH_NAME), payload(127, 0x5a), { flag: 'wx' });
}
async function writeWorkMembers(scope: DatasetScope): Promise<void> {
  for (const [index, domain] of ['sources', 'research', 'watch'].entries())
    await writeFile(
      join(scope.operationRoot, 'work', `${domain}.db`),
      payload(WORK_FILE_LENGTHS[index]!, 0x70 + index),
      { flag: 'wx' },
    );
  const conversations = join(scope.operationRoot, 'work', 'conversations');
  await mkdir(join(conversations, 'nested'), { recursive: true });
  await writeFile(join(conversations, 'index.json'), payload(WORK_CONVERSATION_LENGTHS[0], 0x61), {
    flag: 'wx',
  });
  await writeFile(
    join(conversations, 'nested', 'new.json'),
    payload(WORK_CONVERSATION_LENGTHS[1], 0x62),
    { flag: 'wx' },
  );
}
async function collectOracle(
  root: string,
  scope: DatasetScope,
  scene: Scene,
): Promise<FixtureOracle> {
  const old: Array<FileFact | TreeFact> = [];
  const work: Array<FileFact | TreeFact> = [];
  for (let index = 0; index < DATASET_MEMBERS.length; index++) {
    const [, live, workName] = DATASET_MEMBERS[index]!;
    old.push(await memberFact(root, join(root, live)));
    if (workName) work.push(await memberFact(root, join(scope.operationRoot, 'work', workName)));
  }
  need(old.length === 13 && work.length === 4);
  need(old[0]?.bytes === OLD_SOURCES_BYTES);
  const lengths = [...old.map((member) => member.bytes), ...work.map((member) => member.bytes)];
  need(new Set(lengths).size === lengths.length, '哨兵长度不唯一，不能选择精确进度点');
  const oracle: FixtureOracle = {
    version: 1,
    scene,
    operationId: scope.operationId,
    generation: scope.generation,
    old,
    work,
    sideBranch: await fileFact(root, join(root, SIDE_BRANCH_NAME)),
  };
  const bytes = Buffer.from(JSON.stringify(oracle));
  need(bytes.length <= LIMITS.reportBytes);
  await writeFile(join(root, ORACLE_NAME), bytes, { flag: 'wx' });
  return oracle;
}
async function prepare(
  root: string,
  scene: Scene,
  context: DatasetContext,
): Promise<{
  scope: DatasetScope;
  engine: DatasetSwitch;
}> {
  await absent(root);
  await mkdir(root);
  await writeLiveMembers(root);
  const scope = await createDatasetScope(
    {
      userDataRoot: root,
      operationId: OPERATION_IDS[scene],
      generation: GENERATIONS[scene],
      purpose: 'restore',
    },
    context,
  );
  await writeWorkMembers(scope);
  const expected = await inspectDatasetWork(scope, context);
  const engine = new DatasetSwitch(scope, context);
  need(
    (await engine.registerHandoff(expected, new TransferBudget().suspend())).state === 'handoff',
  );
  await collectOracle(root, scope, scene);
  return { scope, engine };
}

export async function executeInitialScene(
  root: string,
  scene: Scene,
  hooks: SceneHooks,
): Promise<SceneResult> {
  const absolute = resolve(root);
  const now = hooks.now ?? (() => performance.now());
  let enabled = false;
  let selected = 0;
  let waitedMs = 0;
  let rollbackSpaceCalls = 0;
  let rollbackSpaceBytes = 0;
  let scope: DatasetScope | null = null;
  const select = async (phase: 'inventory' | 'backing-up'): Promise<void> => {
    need(enabled && scene === phase && selected === 0, '期限选择点重复或场景不符');
    need(scope);
    const summary = journalSummary(await boundedJournal(scope));
    need(summary.phase === phase);
    need(summary.rollbackCopyRemaining === 0 && summary.rollbackCopyBudget === 0);
    if (phase === 'inventory') need(rollbackSpaceCalls === 0, 'inventory被空间检查延迟冒充');
    else {
      need(rollbackSpaceCalls === 1);
      const copied = await fileFact(absolute, join(scope.operationRoot, 'rollback', 'sources'));
      need(copied.bytes === OLD_SOURCES_BYTES, '首个flush后的副本不完整');
    }
    selected++;
    await hooks.selected?.(phase);
    const started = now();
    await hooks.wait();
    waitedMs = now() - started;
  };
  const context: DatasetContext = {
    check: async (phase, bytes) => {
      if (enabled && scene === 'inventory' && phase === 'backup' && bytes === OLD_SOURCES_BYTES)
        await select('inventory');
    },
    requireRollbackSpace: (bytes) => {
      need(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= LIMITS.sceneAllocatedBytes);
      rollbackSpaceCalls++;
      rollbackSpaceBytes = bytes;
    },
    boundary: async (point) => {
      if (enabled && scene === 'backing-up' && point === 'backup-file-flushed')
        await select('backing-up');
    },
  };
  const prepared = await prepare(absolute, scene, context);
  scope = prepared.scope;
  enabled = true;
  const resumed = await prepared.engine.resumeAtStartup();
  const result =
    scene === 'normal' && resumed.state === 'new-awaiting-health'
      ? await prepared.engine.commitHealthy()
      : resumed;
  const summary = journalSummary(await boundedJournal(prepared.scope));
  need(scene === 'normal' ? selected === 0 : selected === 1);
  return {
    scene,
    action: 'initial',
    state: result.state,
    code: result.code,
    journalPhase: summary.phase,
    rollbackCopyRemaining: summary.rollbackCopyRemaining,
    rollbackCopyBudget: summary.rollbackCopyBudget,
    selected,
    waitedMs,
    rollbackSpaceCalls,
    rollbackSpaceBytes,
  };
}

export async function reopenScene(
  root: string,
  scene: Exclude<Scene, 'normal'>,
): Promise<SceneResult> {
  const absolute = resolve(root);
  let rollbackSpaceCalls = 0;
  const context: DatasetContext = {
    check() {},
    requireRollbackSpace() {
      rollbackSpaceCalls++;
      throw new Error('重开禁止重新领取rollbackCopy空间/期限');
    },
  };
  const scope = await readDatasetScope({
    userDataRoot: absolute,
    operationId: OPERATION_IDS[scene],
    generation: GENERATIONS[scene],
    purpose: 'restore',
  });
  const result = await new DatasetSwitch(scope, context).resumeAtStartup();
  const summary = journalSummary(await boundedJournal(scope));
  need(rollbackSpaceCalls === 0);
  return {
    scene,
    action: 'reopen',
    state: result.state,
    code: result.code,
    journalPhase: summary.phase,
    rollbackCopyRemaining: summary.rollbackCopyRemaining,
    rollbackCopyBudget: summary.rollbackCopyBudget,
    selected: 0,
    waitedMs: 0,
    rollbackSpaceCalls,
    rollbackSpaceBytes: 0,
  };
}

export async function readOracle(root: string): Promise<FixtureOracle> {
  const bytes = await readFile(join(resolve(root), ORACLE_NAME));
  need(bytes.length > 1 && bytes.length <= LIMITS.reportBytes);
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  need(value && typeof value === 'object' && !Array.isArray(value));
  const oracle = value as FixtureOracle;
  need(
    oracle.version === 1 &&
      OPERATION_IDS[oracle.scene] === oracle.operationId &&
      GENERATIONS[oracle.scene] === oracle.generation &&
      oracle.old.length === 13 &&
      oracle.work.length === 4,
  );
  return oracle;
}

async function optionalFact(root: string, path: string): Promise<FileFact | null> {
  try {
    return await fileFact(root, path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function inspectInterruptedFixture(
  root: string,
  scene: Exclude<Scene, 'normal'>,
  afterReopen: boolean,
): Promise<{ oldMembers: 13; workMembers: 4; retainedRollbackCopies: number }> {
  const absolute = resolve(root);
  const oracle = await readOracle(absolute);
  need(oracle.scene === scene);
  for (const member of oracle.old) await exactFact(absolute, member);
  for (const member of oracle.work) await exactFact(absolute, member);
  await exactFact(absolute, oracle.sideBranch);
  const operation = join(absolute, 'data-transfer', oracle.operationId);
  need((await stat(join(operation, 'work'))).isDirectory());
  need((await stat(join(operation, 'journal.json'))).isFile());
  const rollbackPaths = DATASET_MEMBERS.map(([id]) => join(operation, 'rollback', id));
  const retained = (
    await Promise.all(rollbackPaths.map((path) => optionalFact(absolute, path)))
  ).filter((value) => value !== null);
  if (scene === 'inventory') need(retained.length === 0);
  else {
    need(retained.length === 1);
    need(retained[0]?.bytes === OLD_SOURCES_BYTES);
    need(retained[0]?.sha256 === oracle.old[0]?.sha256);
  }
  const summary = journalSummary(
    await boundedJournal({
      userDataRoot: absolute,
      operationRoot: operation,
      operationId: oracle.operationId,
      generation: oracle.generation,
      purpose: 'restore',
      identities: [],
    }),
  );
  need(summary.rollbackCopyRemaining === 0 && summary.rollbackCopyBudget === 0);
  need(
    summary.phase ===
      (scene === 'inventory' ? 'inventory' : afterReopen ? 'rolled-back' : 'backing-up'),
  );
  return { oldMembers: 13, workMembers: 4, retainedRollbackCopies: retained.length };
}

export async function inspectCommittedFixture(root: string): Promise<void> {
  const absolute = resolve(root);
  const oracle = await readOracle(absolute);
  need(oracle.scene === 'normal');
  for (let index = 0; index < oracle.work.length; index++) {
    const [, live] = DATASET_MEMBERS.filter(([, , work]) => work !== null)[index]!;
    const expected = oracle.work[index]!;
    const target = resolve(absolute, live);
    const actual =
      'files' in expected ? await treeFact(absolute, target) : await fileFact(absolute, target);
    need(actual.bytes === expected.bytes && actual.sha256 === expected.sha256);
  }
  await exactFact(absolute, oracle.sideBranch);
}

export const fixtureConstants = Object.freeze({
  oracleName: ORACLE_NAME,
  oldSourcesBytes: OLD_SOURCES_BYTES,
  oldFileLengths: OLD_FILE_LENGTHS,
  workFileLengths: WORK_FILE_LENGTHS,
});
