import { build as electronBuild } from 'electron-vite';
import { build as bundle } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
if (process.platform !== 'win32' || process.argv.length !== 2 || !/^v24\./u.test(process.version))
  throw new Error('检查构建环境无效');
const scopeId = `lifecycle-check-${randomUUID().replaceAll('-', '')}`;
const scope = join(repository, 'log/stage7-e3', scopeId);
mkdirSync(scope, { recursive: true });
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sources: Record<string, string> = {};
function sourceTree(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('构建来源不允许链接');
    if (entry.isDirectory()) sourceTree(path);
    else sources[relative(repository, path).replaceAll('\\', '/')] = hash(path);
  }
}
for (const root of ['src', 'tools/data-qualification/lifecycle-check', 'native/lifecycle-guardian'])
  sourceTree(join(repository, root));
for (const name of [
  'package.json',
  'package-lock.json',
  'electron.vite.config.ts',
  'tools/build/lifecycle-build.ts',
  'tools/build/guardian.ps1',
  'tools/data-qualification/full-transfer/FixedTransferJob.cs',
])
  sources[name] = hash(join(repository, name));
process.env.AIBROWSE_LIFECYCLE_CHECK_BUILD = scope;
try {
  await electronBuild({
    configFile: join(repository, 'tools/data-qualification/lifecycle-check/config.ts'),
    mode: 'production',
    envFile: false,
  });
} finally {
  delete process.env.AIBROWSE_LIFECYCLE_CHECK_BUILD;
}
const appRoot = join(scope, 'app');
mkdirSync(join(appRoot, 'out/lifecycle-guardian'));
copyFileSync(
  join(repository, 'out/lifecycle-guardian/guardian.exe'),
  join(appRoot, 'out/lifecycle-guardian/guardian.exe'),
);
for (const [entry, output] of [
  ['entry.ts', 'app/bootstrap.cjs'],
  ['oracle.ts', 'oracle.cjs'],
] as const) {
  const result = await bundle({
    entryPoints: [join(repository, 'tools/data-qualification/lifecycle-check', entry)],
    outfile: join(scope, output),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    metafile: true,
  });
  for (const input of Object.keys(result.metafile!.inputs))
    sources[relative(repository, resolve(input)).replaceAll('\\', '/')] = hash(resolve(input));
}
writeNew(join(appRoot, 'package.json'), {
  name: 'aibrowse-lifecycle-check',
  version: '0.1.0',
  main: 'bootstrap.cjs',
});
copyFileSync(
  join(repository, 'tools/data-qualification/full-transfer/FixedTransferJob.cs'),
  join(scope, 'FixedTransferJob.cs'),
);
for (const part of ['main', 'preload', 'renderer']) {
  const inputs = JSON.parse(readFileSync(join(scope, `${part}-modules.json`), 'utf8')) as Record<
    string,
    string
  >;
  for (const [path, digest] of Object.entries(inputs)) {
    if (hash(join(repository, path)) !== digest) throw new Error('编译模块来源改变');
    sources[path] = digest;
  }
}
for (const [path, digest] of Object.entries(sources))
  if (hash(join(repository, path)) !== digest) throw new Error('构建期间来源改变');
const artifacts: Record<string, string> = {};
function artifactTree(root: string): void {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, e.name);
    if (e.isSymbolicLink()) throw new Error('制品不允许链接');
    if (e.isDirectory()) artifactTree(path);
    else artifacts[relative(scope, path).replaceAll('\\', '/')] = hash(path);
  }
}
artifactTree(scope);
const electron = join(repository, 'node_modules/electron/dist/electron.exe');
writeNew(join(scope, 'build.json'), {
  version: 1,
  scopeId,
  sources,
  artifacts,
  node: { path: process.execPath, sha256: hash(process.execPath) },
  electron: { path: electron, sha256: hash(electron) },
});
console.log(JSON.stringify({ scopeId, built: true, actual: false }));
function writeNew(path: string, value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 ** 2) throw new Error('来源记录超预算');
  writeFileSync(path, JSON.stringify(value), { flag: 'wx' });
}
