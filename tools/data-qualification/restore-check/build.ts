import { build as electronBuild } from 'electron-vite';
import { build as bundle } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { need, writeNew } from './contract.ts';

const repository = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
need(process.platform === 'win32' && process.argv.length === 2 && /^v24\./u.test(process.version));
const scopeId = `restore-check-${randomUUID().replaceAll('-', '')}`;
const scope = join(repository, 'log/stage7-e2', scopeId);
mkdirSync(scope);
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function tree(root: string, into: Record<string, string>): void {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, e.name);
    need(!e.isSymbolicLink());
    if (e.isDirectory()) tree(path, into);
    else into[relative(repository, path).replaceAll('\\', '/')] = sha(path);
  }
}
const before: Record<string, string> = {};
for (const directory of ['src', 'tools', 'native/lifecycle-guardian'])
  tree(join(repository, directory), before);
for (const name of ['package.json', 'package-lock.json', 'electron.vite.config.ts'])
  before[name] = sha(join(repository, name));
process.env.AIBROWSE_RESTORE_CHECK_BUILD = scope;
try {
  await electronBuild({
    configFile: join(repository, 'tools/data-qualification/restore-check/config.ts'),
    mode: 'production',
    envFile: false,
  });
} finally {
  delete process.env.AIBROWSE_RESTORE_CHECK_BUILD;
}
const app = join(scope, 'app');
mkdirSync(join(app, 'out/lifecycle-guardian'));
copyFileSync(
  join(repository, 'out/lifecycle-guardian/guardian.exe'),
  join(app, 'out/lifecycle-guardian/guardian.exe'),
);
writeNew(join(app, 'package.json'), {
  name: 'aibrowse-restore-check',
  version: '0.1.0',
  main: 'bootstrap.cjs',
});
const toolInputs = new Set<string>();
for (const [entry, output] of [
  ['entry.ts', 'app/bootstrap.cjs'],
  ['oracle.ts', 'oracle.cjs'],
] as const) {
  const result = await bundle({
    entryPoints: [join(repository, 'tools/data-qualification/restore-check', entry)],
    outfile: join(scope, output),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    metafile: true,
    define: {
      __RELEASE__: 'true',
      __E2_RUNTIME_QUALIFICATION__: 'false',
      __WATCH_QUALIFICATION__: 'false',
    },
  });
  for (const path of Object.keys(result.metafile!.inputs))
    toolInputs.add(relative(repository, resolve(path)).replaceAll('\\', '/'));
  writeNew(join(scope, `${entry}.modules.json`), result.metafile!.inputs);
}
const sources: Record<string, string> = {};
for (const [name, hash] of Object.entries(before)) {
  if (
    name.startsWith('src/') ||
    name.startsWith('tools/data-qualification/restore-check/') ||
    name.startsWith('tools/build/') ||
    name.startsWith('native/lifecycle-guardian/') ||
    name === 'tools/data-qualification/full-transfer/FixedTransferJob.cs' ||
    name.startsWith('package') ||
    name === 'electron.vite.config.ts' ||
    toolInputs.has(name)
  ) {
    need(sha(join(repository, name)) === hash, '构建期间来源改变');
    sources[name] = hash;
  }
}
for (const part of ['main', 'preload', 'renderer']) {
  const graph = JSON.parse(readFileSync(join(scope, `${part}-modules.json`), 'utf8')) as {
    inputs: Record<string, string>;
  };
  for (const [name, hash] of Object.entries(graph.inputs)) {
    need(sha(join(repository, name)) === hash, '编译模块来源改变');
    sources[name] = hash;
  }
}
copyFileSync(
  join(repository, 'tools/data-qualification/full-transfer/FixedTransferJob.cs'),
  join(scope, 'FixedTransferJob.cs'),
);
const artifactFiles: Record<string, string> = {};
function artifacts(path: string): void {
  for (const e of readdirSync(path, { withFileTypes: true })) {
    const item = join(path, e.name);
    need(!e.isSymbolicLink());
    if (e.isDirectory()) artifacts(item);
    else artifactFiles[relative(scope, item).replaceAll('\\', '/')] = sha(item);
  }
}
artifacts(scope);
const electron = join(repository, 'node_modules/electron/dist/electron.exe');
writeNew(join(scope, 'build.json'), {
  version: 1,
  scopeId,
  sources,
  artifacts: artifactFiles,
  electron: { path: electron, sha256: sha(electron) },
  node: { path: process.execPath, sha256: sha(process.execPath) },
  isolation: '普通生产装配；仅工具bootstrap固定dialog和DOM；不授发行原生交互',
});
need(lstatSync(join(app, 'out/main/index.js')).isFile());
console.log(JSON.stringify({ scopeId, built: true, actual: false }));
