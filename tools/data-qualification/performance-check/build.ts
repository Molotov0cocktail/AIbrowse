import { build as electronBuild } from 'electron-vite';
import { build as bundle } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus, release, totalmem } from 'node:os';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
async function main(): Promise<void> {
  const repository = resolve('.');
  if (
    process.platform !== 'win32' ||
    !/^v24\./u.test(process.version) ||
    process.argv.length !== 2
  ) {
    throw new Error('需要Windows x64 Node 24且不接受参数');
  }
  const scopeId = `performance-check-${randomUUID().replaceAll('-', '')}`;
  const scope = join(repository, 'log/stage7-e4', scopeId);
  mkdirSync(scope);
  const sha = (path: string): string =>
    createHash('sha256').update(readFileSync(path)).digest('hex');
  const before: Record<string, string> = {};
  function tree(root: string): void {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isSymbolicLink()) throw new Error('来源含链接');
      if (entry.isDirectory()) tree(path);
      else before[relative(repository, path).replaceAll('\\', '/')] = sha(path);
    }
  }
  for (const directory of [
    'tools/data-qualification/performance-check',
    'native/lifecycle-guardian',
  ])
    tree(join(repository, directory));
  for (const file of [
    'package.json',
    'package-lock.json',
    'electron.vite.config.ts',
    'src/main/sources/db/migrations.ts',
    'src/main/sources/db/sqlite-driver.ts',
  ])
    before[file] = sha(join(repository, file));
  process.env['AIBROWSE_PERFORMANCE_BUILD'] = scope;
  try {
    await electronBuild({
      configFile: join(repository, 'tools/data-qualification/performance-check/config.ts'),
      mode: 'production',
      envFile: false,
    });
  } finally {
    delete process.env['AIBROWSE_PERFORMANCE_BUILD'];
  }
  const appRoot = join(scope, 'app');
  mkdirSync(join(appRoot, 'out/lifecycle-guardian'));
  copyFileSync(
    join(repository, 'out/lifecycle-guardian/guardian.exe'),
    join(appRoot, 'out/lifecycle-guardian/guardian.exe'),
  );
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({ name: 'aibrowse-performance-check', version: '0.1.0', main: 'bootstrap.cjs' }),
    { flag: 'wx' },
  );
  const entryBuild: Parameters<typeof bundle>[0] = {
    entryPoints: [join(repository, 'tools/data-qualification/performance-check/entry.ts')],
    outfile: join(appRoot, 'bootstrap.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    metafile: true,
    define: {
      __RELEASE__: 'false',
      __E2_RUNTIME_QUALIFICATION__: 'false',
      __WATCH_QUALIFICATION__: 'false',
    },
  };
  let bundled = await bundle(entryBuild);
  for (const name of Object.keys(bundled.metafile!.inputs)) {
    const path = resolve(repository, name);
    if (path.startsWith(`${repository}\\`) && !path.includes('\\node_modules\\')) {
      before[relative(repository, path).replaceAll('\\', '/')] = sha(path);
    }
  }
  bundled = await bundle(entryBuild);
  writeFileSync(join(scope, 'entry-modules.json'), JSON.stringify(bundled.metafile!.inputs), {
    flag: 'wx',
  });
  const oracleBundle = await bundle({
    entryPoints: [join(repository, 'tools/data-qualification/performance-check/oracle.ts')],
    outfile: join(scope, 'oracle.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    metafile: true,
  });
  writeFileSync(join(scope, 'oracle-modules.json'), JSON.stringify(oracleBundle.metafile!.inputs), {
    flag: 'wx',
  });
  await bundle({
    stdin: {
      contents: `import { resolve, join } from 'node:path';
import { seedPerformanceProfile } from './baseline-fixture';
const scope = resolve(process.argv[2] ?? '');
if (!/^performance-check-[a-f0-9]{32}$/u.test(scope.split(/[\\\\/]/u).at(-1) ?? '')) throw new Error('scope无效');
seedPerformanceProfile(join(scope, 'profile'));`,
      resolveDir: join(repository, 'tools/data-qualification/performance-check'),
      sourcefile: 'performance-seed-entry.ts',
      loader: 'ts',
    },
    outfile: join(scope, 'seed.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
  });
  const sources: Record<string, string> = {};
  for (const [name, hash] of Object.entries(before)) {
    if (sha(join(repository, name)) !== hash) throw new Error('构建期间来源改变');
    sources[name] = hash;
  }
  for (const part of ['main', 'preload', 'renderer']) {
    const graph = JSON.parse(readFileSync(join(scope, `${part}-modules.json`), 'utf8')) as {
      inputs: Record<string, string>;
    };
    for (const [name, hash] of Object.entries(graph.inputs)) {
      const path = resolve(repository, name);
      if (!path.startsWith(`${repository}\\`) || sha(path) !== hash)
        throw new Error('产品模块来源改变');
      sources[name] = hash;
    }
  }
  const artifacts: Record<string, string> = {};
  function artifactTree(root: string): void {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) artifactTree(path);
      else if (entry.isFile()) artifacts[relative(scope, path).replaceAll('\\', '/')] = sha(path);
      else throw new Error('制品含非普通文件');
    }
  }
  artifactTree(appRoot);
  const electron = join(repository, 'node_modules/electron/dist/electron.exe');
  const powerText = execFileSync('powercfg.exe', ['/getactivescheme'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  const powerScheme = powerText
    .match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/iu)?.[0]
    .toLowerCase();
  if (powerScheme === undefined) throw new Error('无法冻结电源方案');
  const processors = cpus();
  if (processors.length === 0) throw new Error('无法冻结CPU环境');
  writeFileSync(
    join(scope, 'build.json'),
    JSON.stringify(
      {
        version: 1,
        scopeId,
        sources,
        artifacts,
        toolArtifacts: {
          'oracle.cjs': sha(join(scope, 'oracle.cjs')),
          'seed.cjs': sha(join(scope, 'seed.cjs')),
        },
        electron: { path: electron, sha256: sha(electron) },
        environment: {
          platform: process.platform,
          arch: process.arch,
          osRelease: release(),
          node: process.version,
          cpuModel: processors[0]!.model,
          logicalProcessors: processors.length,
          totalMemoryBytes: totalmem(),
          powerScheme,
          systemCache: 'not-cleared',
        },
        profile: 'ordinary-production-no-qualification',
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  if (!lstatSync(join(appRoot, 'out/main/index.js')).isFile()) throw new Error('主制品缺失');
  console.log(JSON.stringify({ scopeId, built: true, actual: false }));
}

void main();
