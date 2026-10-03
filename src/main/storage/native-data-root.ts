import { lstatSync, mkdirSync, opendirSync, realpathSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const NODE_MEMBERS = [
  ['credentials.json', 'file'],
  ['credentials.json.tmp', 'file'],
  ['provider-config.json', 'file'],
  ['provider-config.json.tmp', 'file'],
  ['conversations', 'directory'],
  ['sources', 'directory'],
  ['research', 'directory'],
  ['watch', 'directory'],
  ['log', 'directory'],
] as const;
const MAX_DIRECTORY_DEPTH = 32;

const FAILURE = {
  path: '本地数据目录路径不一致',
  identity: '本地数据目录身份不一致',
  type: '本地数据目录成员类型不受支持',
  view: '本地数据目录视图不一致',
  depth: '本地数据目录层级超出核验边界',
  io: '无法核验本地数据目录',
} as const;

class DataRootError extends Error {
  constructor(kind: keyof typeof FAILURE) {
    super(FAILURE[kind]);
  }
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function metadata(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function requireType(stat: BigIntStats, kind?: 'file' | 'directory'): void {
  if (
    stat.isSymbolicLink() ||
    (!stat.isFile() && !stat.isDirectory()) ||
    (kind === 'file' && !stat.isFile()) ||
    (kind === 'directory' && !stat.isDirectory()) ||
    (stat.isFile() && stat.nlink !== 1n)
  ) {
    throw new DataRootError('type');
  }
}

function requireIdentity(left: BigIntStats, right: BigIntStats): void {
  if (
    left.dev !== right.dev ||
    left.ino !== right.ino ||
    left.isDirectory() !== right.isDirectory()
  ) {
    throw new DataRootError('identity');
  }
}

function requireNativePath(path: string, expected: string): void {
  const nativePath = realpathSync.native(path);
  if (!isAbsolute(nativePath) || !samePath(nativePath, expected)) throw new DataRootError('path');
}

function verifyRoots(logicalRoot: string, nativeRoot: string, initial: BigIntStats): void {
  const logical = metadata(logicalRoot);
  const native = metadata(nativeRoot);
  if (!logical || !native) throw new DataRootError('identity');
  requireType(logical, 'directory');
  requireType(native, 'directory');
  requireIdentity(initial, logical);
  requireIdentity(logical, native);
  requireNativePath(logicalRoot, nativeRoot);
  requireNativePath(nativeRoot, nativeRoot);
}

function verifyNodeTree(logicalRoot: string, nativeRoot: string): void {
  function pair(name: string, required: boolean, kind?: 'file' | 'directory') {
    const logicalPath = join(logicalRoot, name);
    const nativePath = join(nativeRoot, name);
    const within = relative(nativeRoot, nativePath);
    if (!within || within === '..' || within.startsWith('..' + sep) || isAbsolute(within)) {
      throw new DataRootError('path');
    }
    const logical = metadata(logicalPath);
    const native = metadata(nativePath);
    if (!logical || !native) {
      if (logical || native || required) throw new DataRootError('view');
      return undefined;
    }
    requireType(logical, kind);
    requireType(native, kind);
    requireIdentity(logical, native);
    // Exact correspondence rejects both outside-root links and shifted in-root overlays.
    requireNativePath(logicalPath, nativePath);
    requireNativePath(nativePath, nativePath);
    return { logicalPath, nativePath, logical, native };
  }

  function directory(
    name: string,
    initial: NonNullable<ReturnType<typeof pair>>,
    depth: number,
  ): void {
    // Bound live handles and traversal state, not the number of legitimate old files.
    // Each level holds one bounded opendir buffer; only the forward pass recurses.
    if (depth > MAX_DIRECTORY_DEPTH) throw new DataRootError('depth');
    for (const forward of [true, false]) {
      const handle = opendirSync(forward ? initial.logicalPath : initial.nativePath, {
        bufferSize: 32,
      });
      try {
        for (;;) {
          const entry = handle.readSync();
          if (entry === null) break;
          if (
            !entry.name ||
            entry.name === '.' ||
            entry.name === '..' ||
            /[\\/\0]/u.test(entry.name)
          ) {
            throw new DataRootError('path');
          }
          const childName = join(name, entry.name);
          const child = pair(childName, true);
          if (forward && child?.logical.isDirectory()) directory(childName, child, depth + 1);
        }
      } finally {
        handle.closeSync();
      }
    }
    const after = pair(name, true, 'directory');
    if (!after) throw new DataRootError('identity');
    requireIdentity(initial.logical, after.logical);
    requireIdentity(initial.native, after.native);
  }

  for (const [name, kind] of NODE_MEMBERS) {
    const entry = pair(name, false, kind);
    if (entry?.logical.isDirectory()) directory(name, entry, 1);
  }
}

/**
 * Resolve the fixed main-process data root before opening any Node writer.
 * The caller must already own the single-instance lock. This performs no migration,
 * body reads or file writes; only a missing root may be created. Chromium retains its
 * logical root. Metadata checks are not a sandbox against concurrent same-user edits.
 * Node exposes symlink/junction detection, not every Windows reparse tag.
 */
export function resolveNativeDataRoot(logicalRoot: string): string {
  try {
    if (!isAbsolute(logicalRoot)) throw new DataRootError('path');
    const logical = resolve(logicalRoot);
    if (!metadata(logical)) mkdirSync(logical, { recursive: true });
    const initial = metadata(logical);
    if (!initial) throw new DataRootError('identity');
    requireType(initial, 'directory');
    const nativeRoot = realpathSync.native(logical);
    if (!isAbsolute(nativeRoot)) throw new DataRootError('path');
    verifyRoots(logical, nativeRoot, initial);
    // Equal root strings do not prove that child paths share the same native view.
    verifyNodeTree(logical, nativeRoot);
    verifyRoots(logical, nativeRoot, initial);
    return nativeRoot;
  } catch (error) {
    if (error instanceof DataRootError) throw error;
    // Never expose filesystem errors, their paths or their original cause to callers.
    throw new DataRootError('io');
  }
}
