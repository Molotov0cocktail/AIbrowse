import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installCrossSpawnHook, prepareCrossApp, type ScopeRequest } from '../cross-smoke-scope.ts';

export interface SourceMember {
  path: string;
  bytes: number;
  sha256: string;
}

/** The default security smoke reads a bounded, bound source copy under appPath. */
export function snapshotSmokeSources(root: string): SourceMember[] {
  const members: SourceMember[] = [];
  let entries = 0;
  let totalBytes = 0;
  const walk = (relative: string, depth: number): void => {
    if (depth > 16 || ++entries > 2000) throw new Error('默认冒烟源码集合超出预算');
    const path = join(root, relative);
    const before = lstatSync(path, { bigint: true });
    if (before.isSymbolicLink()) throw new Error('默认冒烟源码不能包含链接');
    if (before.isDirectory()) {
      const children = readdirSync(path).sort();
      if (children.length > 2000) throw new Error('默认冒烟源码目录超出预算');
      for (const name of children) walk(`${relative}/${name}`, depth + 1);
      const after = lstatSync(path, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino)
        throw new Error('默认冒烟源码目录身份改变');
      return;
    }
    if (!before.isFile() || before.nlink !== 1n || before.size > 8n * 1024n * 1024n)
      throw new Error('默认冒烟源码成员无效或超限');
    totalBytes += Number(before.size);
    if (totalBytes > 32 * 1024 * 1024) throw new Error('默认冒烟源码总字节超限');
    const bytes = readFileSync(path);
    const after = lstatSync(path, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      bytes.length !== Number(before.size)
    )
      throw new Error('默认冒烟源码读取期间改变');
    members.push({
      path: relative,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  };
  walk('src', 0);
  return members;
}

export function prepareDefaultSources(request: ScopeRequest): void {
  const source = snapshotSmokeSources(request.repository);
  mkdirSync(join(request.appRoot, 'src'));
  for (const member of source) {
    const pieces = member.path.split('/');
    let parent = request.appRoot;
    for (const name of pieces.slice(0, -1)) {
      parent = join(parent, name);
      try {
        mkdirSync(parent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const directory = lstatSync(parent);
        if (!directory.isDirectory() || directory.isSymbolicLink())
          throw new Error('默认冒烟目标源码目录无效', { cause: error });
      }
    }
    copyFileSync(
      join(request.repository, member.path),
      join(request.appRoot, member.path),
      constants.COPYFILE_EXCL,
    );
  }
  if (
    JSON.stringify(source) !== JSON.stringify(snapshotSmokeSources(request.repository)) ||
    JSON.stringify(source) !== JSON.stringify(snapshotSmokeSources(request.appRoot))
  )
    throw new Error('默认冒烟源码复制或候选绑定不符');
  writeFileSync(`${request.receipt}.sources.json`, JSON.stringify({ version: 1, source }), {
    flag: 'wx',
  });
}

export function prepareDefaultApp(request: ScopeRequest): void {
  prepareCrossApp(request);
  prepareDefaultSources(request);
}

export function installDefaultSpawnHook(
  request: ScopeRequest,
  original: typeof childProcess.spawn,
): typeof childProcess.spawn {
  const preparedLaunch = ((...parameters: Parameters<typeof childProcess.spawn>) => {
    if (resolve(parameters[0]).toLowerCase() === resolve(request.electron).toLowerCase()) {
      prepareDefaultSources(request);
      delete process.env['AIBROWSE_DEFAULT_REQUEST'];
    }
    return original(...parameters);
  }) as typeof childProcess.spawn;
  return installCrossSpawnHook(request, preparedLaunch);
}

function readRequest(path: string): ScopeRequest {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096)
    throw new Error('默认冒烟准备请求无效');
  return JSON.parse(readFileSync(path, 'utf8')) as ScopeRequest;
}

const hookRequest = process.env['AIBROWSE_DEFAULT_REQUEST'];
if (hookRequest) {
  childProcess.spawn = installDefaultSpawnHook(readRequest(hookRequest), childProcess.spawn);
  syncBuiltinESMExports();
} else if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('默认冒烟准备参数无效');
  prepareDefaultApp(readRequest(process.argv[2]!));
}
