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
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ScopeRequest {
  repository: string;
  appRoot: string;
  receipt: string;
  electron: string;
}
export function snapshotOut(repository: string) {
  const files: Array<{ path: string; bytes: number; dev: string; ino: string; sha256: string }> =
    [];
  let bytes = 0;
  let entries = 0;
  const walk = (relative: string, depth: number): void => {
    if (depth > 8 || ++entries > 2000) throw new Error('制品集合超出工具预算');
    const path = join(repository, relative);
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error('制品不能包含链接');
    if (stat.isDirectory()) {
      const names = readdirSync(path).sort();
      if (names.length > 2000) throw new Error('制品目录超出工具预算');
      for (const name of names) walk(`${relative}/${name}`, depth + 1);
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > 32n * 1024n * 1024n)
      throw new Error('制品类型异常');
    bytes += Number(stat.size);
    if (bytes > 32 * 1024 * 1024) throw new Error('制品字节超出工具预算');
    const content = readFileSync(path);
    const after = lstatSync(path, { bigint: true });
    if (
      after.ino !== stat.ino ||
      after.dev !== stat.dev ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs ||
      content.length !== Number(stat.size)
    )
      throw new Error('制品读取期间改变');
    files.push({
      path: relative,
      bytes: content.length,
      dev: String(stat.dev),
      ino: String(stat.ino),
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  };
  for (const part of ['main', 'preload', 'renderer', 'lifecycle-guardian']) walk(`out/${part}`, 0);
  return files;
}
export function prepareCrossApp(request: ScopeRequest) {
  const files = snapshotOut(request.repository);
  mkdirSync(request.appRoot);
  mkdirSync(join(request.appRoot, 'log'));
  mkdirSync(join(request.appRoot, 'out'));
  mkdirSync(join(request.appRoot, 'out/lifecycle-guardian'));
  const manifest = JSON.parse(readFileSync(join(request.repository, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string')
    throw new Error('产品清单无效');
  writeFileSync(
    join(request.appRoot, 'package.json'),
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      main: join(request.repository, 'out/main/index.js'),
    }),
    { flag: 'wx' },
  );
  copyFileSync(
    join(request.repository, 'out/lifecycle-guardian/guardian.exe'),
    join(request.appRoot, 'out/lifecycle-guardian/guardian.exe'),
    constants.COPYFILE_EXCL,
  );
  const helper = files.find((file) => file.path === 'out/lifecycle-guardian/guardian.exe');
  const copied = readFileSync(join(request.appRoot, 'out/lifecycle-guardian/guardian.exe'));
  if (!helper || createHash('sha256').update(copied).digest('hex') !== helper.sha256)
    throw new Error('私有守护程序与已绑定制品不符');
  if (JSON.stringify(files) !== JSON.stringify(snapshotOut(request.repository)))
    throw new Error('准备期间制品改变');
  const log = lstatSync(join(request.appRoot, 'log'), { bigint: true });
  const receipt = { version: 1, files, log: { dev: String(log.dev), ino: String(log.ino) } };
  writeFileSync(request.receipt, JSON.stringify(receipt), { flag: 'wx' });
  return receipt;
}
function readRequest(path: string): ScopeRequest {
  if (lstatSync(path).size > 4096) throw new Error('工具请求超限');
  return JSON.parse(readFileSync(path, 'utf8')) as ScopeRequest;
}
export function installCrossSpawnHook(
  request: ScopeRequest,
  original: typeof childProcess.spawn,
): typeof childProcess.spawn {
  let spawned = false;
  return ((...parameters: Parameters<typeof childProcess.spawn>) => {
    const [command, args, options] = parameters;
    if (resolve(command).toLowerCase() !== resolve(request.electron).toLowerCase()) {
      if (basename(command).toLowerCase() === 'electron.exe')
        throw new Error('开发启动器 Electron 路径改变');
      return original(...parameters);
    }
    if (
      spawned ||
      !Array.isArray(args) ||
      args.length !== 1 ||
      args[0] !== '.' ||
      !options ||
      Object.keys(options).join(',') !== 'stdio' ||
      options.stdio !== 'inherit'
    )
      throw new Error('开发启动器额外启动或入口改变');
    spawned = true;
    prepareCrossApp(request);
    delete process.env['AIBROWSE_CROSS_REQUEST'];
    // Preserve the launcher's child identity and original exit propagation.
    return original(command, [request.appRoot], options);
  }) as typeof childProcess.spawn;
}
const hookRequest = process.env['AIBROWSE_CROSS_REQUEST'];
if (hookRequest) {
  const request = readRequest(hookRequest);
  childProcess.spawn = installCrossSpawnHook(request, childProcess.spawn);
  syncBuiltinESMExports();
} else if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('工具请求无效');
  prepareCrossApp(readRequest(process.argv[2]!));
}
