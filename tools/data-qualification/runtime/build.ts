import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { BUDGET } from './contract.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../../..');
if (process.argv.length !== 2 || !/^v24\./.test(process.version))
  throw new Error('固定构建需要 Node 24 且不接受参数');
const id = `runtime-${randomUUID().replaceAll('-', '')}`;
const root = join(repository, 'log', 'stage7-e2', id);
for (const path of [repository, join(repository, 'log'), dirname(root)])
  if (lstatSync(path).isSymbolicLink()) throw new Error('构建路径含链接');
mkdirSync(root);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sourceHashes: Record<string, string> = {};
const hashes = (directory: string, prefix = ''): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('构建成员含链接');
    if (stat.isDirectory()) Object.assign(result, hashes(path, `${prefix}${name}/`));
    else result[`${prefix}${name}`] = hash(readFileSync(path));
  }
  return result;
};
// Bind the entire actual main/preload/UI source graph, including runtime-only branches.
for (const prefix of ['src', 'tools/data-qualification/runtime'])
  for (const [name, sha] of Object.entries(hashes(join(repository, prefix))))
    sourceHashes[`${prefix}/${name}`] = sha;
for (const name of [
  'electron.vite.config.ts',
  'package.json',
  'package-lock.json',
  'tools/release-profile/JobProcess.cs',
])
  sourceHashes[name] = hash(readFileSync(join(repository, name)));
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(NODE_|ELECTRON_|AIBROWSE_|VITE_)/.test(key)) delete env[key];
execFileSync(
  process.execPath,
  [
    join(repository, 'node_modules/electron-vite/bin/electron-vite.js'),
    'build',
    '--mode',
    'runtime-qualification',
  ],
  { cwd: repository, env, windowsHide: true, stdio: 'inherit', timeout: 120000 },
);
cpSync(join(repository, 'out', 'runtime-qualification'), join(root, 'app'), { recursive: true });
for (const [entry, directory, file] of [
  ['worker.ts', 'utility', 'worker.cjs'],
  ['prepare.ts', '.', 'prepare.cjs'],
] as const) {
  await build({
    configFile: false,
    envFile: false,
    root: repository,
    publicDir: false,
    logLevel: 'warn',
    ssr: { noExternal: true },
    build: {
      ssr: join(here, entry),
      target: 'node24',
      outDir: join(root, directory),
      emptyOutDir: false,
      minify: false,
      rollupOptions: {
        external: (id) =>
          id === 'electron' || id.startsWith('node:') || builtinModules.includes(id),
        output: { format: 'cjs', entryFileNames: file, inlineDynamicImports: true },
        plugins: [
          {
            name: 'bind-fixed-scanner-sources',
            generateBundle(_options, output) {
              for (const item of Object.values(output))
                if (item.type === 'chunk')
                  for (const path of Object.keys(item.modules)) {
                    if (path.startsWith('\0')) continue;
                    const name = relative(repository, path).replaceAll('\\', '/');
                    if (name.startsWith('../') || name.includes('?'))
                      throw new Error('扫描器依赖越界');
                    sourceHashes[name] = hash(readFileSync(path));
                  }
            },
          },
        ],
      },
    },
  });
}
for (const [name, sha] of Object.entries(sourceHashes))
  if (hash(readFileSync(join(repository, name))) !== sha)
    throw new Error('构建期间源码变化，候选未冻结');
const electron = join(repository, 'node_modules', 'electron', 'dist', 'electron.exe');
const proof = {
  version: 1,
  buildId: id,
  baseline: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
  }).trim(),
  createdAt: new Date().toISOString(),
  node: process.version,
  budget: BUDGET,
  sourceHashes,
  artifacts: hashes(root),
  electronSha256: hash(readFileSync(electron)),
  electronVersion: JSON.parse(
    readFileSync(join(repository, 'node_modules/electron/package.json'), 'utf8'),
  ).version as unknown,
  packaged: false,
  smokeMode: false,
  productE2Pass: false,
};
writeFileSync(join(root, 'build-proof.json'), JSON.stringify(proof, null, 2));
console.log(
  JSON.stringify({
    buildId: id,
    electronSha256: proof.electronSha256,
    artifactCount: Object.keys(proof.artifacts).length,
    executed: false,
    fixturePrepared: false,
  }),
);
