import { createHash } from 'node:crypto';
import { realpathSync, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, opendir, rename } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseBoundedJson } from './bounded-json';

export const DATASET_MEMBERS = [
  ['sources', 'sources/sources.db', 'sources.db'],
  ['sources-wal', 'sources/sources.db-wal', null],
  ['sources-shm', 'sources/sources.db-shm', null],
  ['sources-journal', 'sources/sources.db-journal', null],
  ['research', 'research/research.db', 'research.db'],
  ['research-wal', 'research/research.db-wal', null],
  ['research-shm', 'research/research.db-shm', null],
  ['research-journal', 'research/research.db-journal', null],
  ['watch', 'watch/watch.db', 'watch.db'],
  ['watch-wal', 'watch/watch.db-wal', null],
  ['watch-shm', 'watch/watch.db-shm', null],
  ['watch-journal', 'watch/watch.db-journal', null],
  ['conversations', 'conversations', 'conversations'],
] as const;
export type DatasetMemberId = (typeof DATASET_MEMBERS)[number][0];
export type DatasetPhase = 'register' | 'backup' | 'switch' | 'recovery' | 'health';
export interface DatasetContext {
  check(phase: DatasetPhase, bytes: number): void | Promise<void>;
  requireRollbackSpace(allocatedBytes: number): void | Promise<void>;
  boundary?(point: string): void | Promise<void>;
}
export interface DatasetFingerprint {
  bytes: number;
  sha256: string;
}
export type NewDatasetFingerprints = Record<
  'sources' | 'research' | 'watch' | 'conversations',
  DatasetFingerprint
>;
type Identity = [string, string];
export interface DatasetScope {
  readonly userDataRoot: string;
  readonly operationRoot: string;
  readonly operationId: string;
  readonly generation: string;
  readonly purpose: 'restore' | 'backup' | 'migrate';
  readonly identities: readonly Identity[];
}
export interface DatasetScopeOptions {
  userDataRoot: string;
  operationId: string;
  generation: string;
  purpose: DatasetScope['purpose'];
}
const LEGACY_DIRECTORIES = ['', 'raw', 'work', 'rollback', 'retired'] as const;
const DIRECTORIES = [...LEGACY_DIRECTORIES, 'evidence'] as const;
const CHUNK_BYTES = 64 * 1024;
export const METADATA_BYTES = 4096;
export const datasetFailure = (): Error => new Error('数据切换校验失败，原件和现场已保留');
export const sameIdentity = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino;
const identity = (s: BigIntStats): Identity => [s.dev.toString(), s.ino.toString()];
const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);

export async function checkedStat(
  path: string,
  kind?: 'file' | 'directory',
): Promise<BigIntStats | null> {
  let s: BigIntStats;
  try {
    s = await lstat(path, { bigint: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw datasetFailure();
  }
  if (
    s.isSymbolicLink() ||
    (!s.isFile() && !s.isDirectory()) ||
    (s.isFile() && s.nlink !== 1n) ||
    (kind === 'file' && !s.isFile()) ||
    (kind === 'directory' && !s.isDirectory()) ||
    !samePath(realpathSync.native(path), path)
  )
    throw datasetFailure();
  return s;
}

export async function assertScope(scope: DatasetScope): Promise<void> {
  const roots = [
    scope.userDataRoot,
    join(scope.userDataRoot, 'data-transfer'),
    ...(scope.identities.length === 7 ? LEGACY_DIRECTORIES : DIRECTORIES).map((d) =>
      join(scope.operationRoot, d),
    ),
  ];
  if (roots.length !== scope.identities.length) throw datasetFailure();
  for (let i = 0; i < roots.length; i++) {
    const s = await checkedStat(roots[i]!, 'directory');
    if (
      !s ||
      identity(s).some((part, j) => part !== scope.identities[i]![j]) ||
      s.dev.toString() !== scope.identities[0]![0]
    )
      throw datasetFailure();
  }
}

export async function assertPath(scope: DatasetScope, path: string): Promise<void> {
  await assertScope(scope);
  const rel = relative(scope.userDataRoot, path);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw datasetFailure();
  let cursor = scope.userDataRoot;
  for (const segment of rel.split(sep).slice(0, -1)) {
    safeName(segment);
    cursor = join(cursor, segment);
    if (!(await checkedStat(cursor, 'directory'))) throw datasetFailure();
  }
  safeName(rel.split(sep).at(-1)!);
}

function safeName(name: string): void {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[\\/:]/u.test(name) ||
    Array.from(name).some((character) => character.charCodeAt(0) < 32) ||
    /[. ]$/u.test(name) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(name)
  )
    throw datasetFailure();
}

export async function readMetadata(
  scope: DatasetScope,
  name:
    | 'owner.json'
    | 'journal.json'
    | 'journal.json.tmp'
    | 'result.json'
    | 'replacement.json'
    | 'replacement.json.tmp',
): Promise<unknown | null> {
  const path = join(scope.operationRoot, name);
  // Owner is read before the scope can be authenticated.
  const before = await checkedStat(path, 'file');
  if (!before) return null;
  if (before.size < 2n || before.size > BigInt(METADATA_BYTES)) throw datasetFailure();
  const fd = await open(path, 'r');
  try {
    const opened = await fd.stat({ bigint: true });
    if (!sameIdentity(before, opened) || opened.size !== before.size) throw datasetFailure();
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await fd.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await checkedStat(path, 'file');
    if (
      offset !== Number(opened.size) ||
      !after ||
      !sameIdentity(opened, after) ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs
    )
      throw datasetFailure();
    return parseBoundedJson(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)),
      { bytes: METADATA_BYTES, depth: 8, nodes: 512 },
    );
  } finally {
    await fd.close();
  }
}

function options(options: DatasetScopeOptions): string {
  if (
    !isAbsolute(options.userDataRoot) ||
    !/^[a-f0-9]{32}$/u.test(options.operationId) ||
    !/^[a-f0-9]{32}$/u.test(options.generation) ||
    !['restore', 'backup', 'migrate'].includes(options.purpose)
  )
    throw datasetFailure();
  return join(resolve(options.userDataRoot), 'data-transfer', options.operationId);
}

async function createScope(
  input: DatasetScopeOptions,
  context: DatasetContext,
): Promise<DatasetScope> {
  const operationRoot = options(input);
  await context.check('register', 0);
  const root = await checkedStat(input.userDataRoot, 'directory');
  if (!root) throw datasetFailure();
  const transfer = join(input.userDataRoot, 'data-transfer');
  if (!(await checkedStat(transfer, 'directory'))) await mkdir(transfer);
  await mkdir(operationRoot);
  for (const d of DIRECTORIES.slice(1)) await mkdir(join(operationRoot, d));
  const paths = [input.userDataRoot, transfer, ...DIRECTORIES.map((d) => join(operationRoot, d))];
  const identities: Identity[] = [];
  for (const path of paths) {
    const s = await checkedStat(path, 'directory');
    if (!s || s.dev !== root.dev) throw datasetFailure();
    identities.push(identity(s));
  }
  const scope: DatasetScope = {
    ...input,
    userDataRoot: resolve(input.userDataRoot),
    operationRoot,
    identities,
  };
  await assertScope(scope);
  const owner = {
    version: 2,
    operationId: input.operationId,
    generation: input.generation,
    purpose: input.purpose,
    identities,
  };
  const payload = Buffer.from(JSON.stringify(owner));
  if (payload.length > METADATA_BYTES) throw datasetFailure();
  const ownerPath = join(operationRoot, 'owner.json');
  const ownerTemp = ownerPath + '.tmp';
  const fd = await open(ownerTemp, 'wx');
  try {
    const created = await fd.stat({ bigint: true });
    await fd.writeFile(payload);
    await context.boundary?.('owner-temp-written');
    await context.check('register', payload.length);
    await fd.sync();
    await context.boundary?.('owner-temp-flushed');
    await context.check('register', payload.length);
    await assertScope(scope);
    const current = await checkedStat(ownerTemp, 'file');
    if (!current || !sameIdentity(current, created) || (await checkedStat(ownerPath)))
      throw datasetFailure();
    await rename(ownerTemp, ownerPath);
  } finally {
    await fd.close();
  }
  await assertScope(scope);
  await context.boundary?.('owner-written');
  return scope;
}

async function readScope(
  input: Pick<DatasetScopeOptions, 'userDataRoot' | 'operationId'> &
    Partial<Pick<DatasetScopeOptions, 'generation' | 'purpose'>>,
): Promise<DatasetScope> {
  const defaults = {
    ...input,
    generation: input.generation ?? '0'.repeat(32),
    purpose: input.purpose ?? ('restore' as const),
  };
  const operationRoot = options(defaults);
  // Validate all ancestors before opening owner metadata.
  for (const path of [input.userDataRoot, join(input.userDataRoot, 'data-transfer'), operationRoot])
    if (!(await checkedStat(path, 'directory'))) throw datasetFailure();
  const raw = await readMetadata({ ...defaults, operationRoot, identities: [] }, 'owner.json');
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw datasetFailure();
  const r = raw as Record<string, unknown>;
  if (
    Object.keys(r).sort().join(',') !== 'generation,identities,operationId,purpose,version' ||
    (r.version !== 1 && r.version !== 2) ||
    r.operationId !== input.operationId ||
    typeof r.generation !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(r.generation) ||
    (input.generation !== undefined && r.generation !== input.generation) ||
    (r.purpose !== 'restore' && r.purpose !== 'backup' && r.purpose !== 'migrate') ||
    (input.purpose !== undefined && r.purpose !== input.purpose) ||
    !Array.isArray(r.identities) ||
    r.identities.length !== (r.version === 1 ? 7 : 8) ||
    !r.identities.every(
      (v) =>
        Array.isArray(v) &&
        v.length === 2 &&
        v.every((p) => typeof p === 'string' && /^[0-9]{1,40}$/u.test(p)),
    )
  )
    throw datasetFailure();
  const scope: DatasetScope = {
    ...input,
    generation: r.generation,
    purpose: r.purpose,
    userDataRoot: resolve(input.userDataRoot),
    operationRoot,
    identities: r.identities as Identity[],
  };
  await assertScope(scope);
  return scope;
}

// Repeated bounded opendir passes give deterministic ordering without retaining
// an unbounded old directory listing. Large old trees may exhaust the deadline.
async function nextName(
  path: string,
  previous: string | null,
  tick: () => Promise<void>,
): Promise<string | null> {
  let next: string | null = null;
  const directory = await opendir(path, { bufferSize: 16 });
  try {
    for (;;) {
      await tick();
      const entry = await directory.read();
      if (!entry) break;
      safeName(entry.name);
      if ((previous === null || entry.name > previous) && (next === null || entry.name < next))
        next = entry.name;
    }
  } finally {
    await directory.close();
  }
  return next;
}

export async function fingerprintPath(
  scope: DatasetScope,
  path: string,
  context: DatasetContext,
  phase: DatasetPhase,
  destination?: string,
  depth = 0,
  account?: (bytes: number, directory: boolean) => void,
): Promise<DatasetFingerprint | null> {
  await context.check(phase, 0);
  await assertPath(scope, path);
  const before = await checkedStat(path);
  if (!before) return null;
  if (depth > 32) throw datasetFailure();
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw datasetFailure();
  account?.(Number(before.size), before.isDirectory());
  if (destination) {
    await assertPath(scope, destination);
    if (await checkedStat(destination)) throw datasetFailure();
  }
  if (before.isDirectory()) {
    if (destination) await mkdir(destination);
    const hash = createHash('sha256').update('dataset-tree-v1\0');
    let previous: string | null = null;
    let bytes = 0;
    for (;;) {
      const name = await nextName(path, previous, async () => {
        await context.check(phase, bytes);
      });
      if (name === null) break;
      const child = await fingerprintPath(
        scope,
        join(path, name),
        context,
        phase,
        destination ? join(destination, name) : undefined,
        depth + 1,
        account,
      );
      if (!child) throw datasetFailure();
      const childStat = await checkedStat(join(path, name));
      if (!childStat) throw datasetFailure();
      hash.update(
        JSON.stringify([
          name,
          childStat.isDirectory() ? 'directory' : 'file',
          child.bytes,
          child.sha256,
        ]) + '\n',
      );
      bytes += child.bytes;
      if (!Number.isSafeInteger(bytes)) throw datasetFailure();
      previous = name;
    }
    const after = await checkedStat(path, 'directory');
    if (!after || !sameIdentity(before, after) || after.mtimeNs !== before.mtimeNs)
      throw datasetFailure();
    return { bytes, sha256: hash.digest('hex') };
  }
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw datasetFailure();
  const source = await open(path, 'r');
  let target: FileHandle | null = null;
  const buffer = Buffer.alloc(CHUNK_BYTES);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    if (destination) target = await open(destination, 'wx');
    const stat = await source.stat({ bigint: true });
    if (!sameIdentity(before, stat) || stat.size !== before.size) throw datasetFailure();
    while (true) {
      await context.check(phase, bytes);
      const read = await source.read(buffer, 0, buffer.length, bytes);
      if (!read.bytesRead) break;
      const chunk = buffer.subarray(0, read.bytesRead);
      hash.update(chunk);
      if (target) {
        let written = 0;
        while (written < chunk.length) {
          await context.check(phase, bytes + written);
          const result = await target.write(
            chunk,
            written,
            chunk.length - written,
            bytes + written,
          );
          if (result.bytesWritten <= 0) throw datasetFailure();
          written += result.bytesWritten;
        }
      }
      bytes += read.bytesRead;
      if (bytes > Number(before.size)) throw datasetFailure();
    }
    if (target) {
      await target.sync();
      await context.boundary?.('backup-file-flushed');
    }
    const after = await checkedStat(path, 'file');
    if (
      !after ||
      !sameIdentity(before, after) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      bytes !== Number(before.size)
    )
      throw datasetFailure();
    if (target && destination) {
      const targetStat = await target.stat({ bigint: true });
      const pathStat = await checkedStat(destination, 'file');
      if (!pathStat || !sameIdentity(targetStat, pathStat) || pathStat.size !== before.size)
        throw datasetFailure();
    }
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    await source.close();
    await target?.close();
  }
}

async function inspectWork(
  scope: DatasetScope,
  context: DatasetContext,
): Promise<NewDatasetFingerprints> {
  const result: Partial<NewDatasetFingerprints> = {};
  for (const [id, , name] of DATASET_MEMBERS) {
    if (name === null) continue;
    const value = await fingerprintPath(
      scope,
      join(scope.operationRoot, 'work', name),
      context,
      'register',
    );
    if (!value) throw datasetFailure();
    result[id] = value;
  }
  return result as NewDatasetFingerprints;
}

export async function createDatasetScope(
  input: DatasetScopeOptions,
  context: DatasetContext,
): Promise<DatasetScope> {
  try {
    return await createScope(input, context);
  } catch {
    throw datasetFailure();
  }
}

export async function readDatasetScope(
  input: Pick<DatasetScopeOptions, 'userDataRoot' | 'operationId'> &
    Partial<Pick<DatasetScopeOptions, 'generation' | 'purpose'>>,
): Promise<DatasetScope> {
  try {
    return await readScope(input);
  } catch {
    throw datasetFailure();
  }
}

export async function inspectDatasetWork(
  scope: DatasetScope,
  context: DatasetContext,
): Promise<NewDatasetFingerprints> {
  try {
    return await inspectWork(scope, context);
  } catch {
    throw datasetFailure();
  }
}
