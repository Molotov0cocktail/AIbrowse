// Compile the actual product imports into a standalone Node fixture without executing them.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { BUDGET } from './contract.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../../..');
const id = `drain-${randomUUID().replaceAll('-', '')}`;
const root = join(repository, 'log', 'stage7-e2', id);
const hash = (input: Buffer) => createHash('sha256').update(input).digest('hex');
const sourceHashes: Record<string, string> = {};
if (process.argv.length !== 2) throw new Error('固定构建入口不接受参数');
if (!/^v24\./.test(process.version)) throw new Error('资格构建需要现有 Node 24');
for (const path of [repository, join(repository, 'log'), join(repository, 'log', 'stage7-e2')]) {
  if (lstatSync(path).isSymbolicLink()) throw new Error('资格构建目录不得经过链接');
}
mkdirSync(root);
await build({
  configFile: false,
  envFile: false,
  root: repository,
  publicDir: false,
  logLevel: 'warn',
  define: {
    __WATCH_QUALIFICATION__: 'false',
    __WATCH_QUALIFICATION_DIAGNOSTIC__: 'false',
    __WATCH_QUALIFICATION_LOAD_DIAGNOSTIC__: 'false',
  },
  ssr: { noExternal: true },
  build: {
    ssr: join(here, 'main.ts'),
    target: 'node24',
    outDir: root,
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external(id) {
        return id === 'electron' || id.startsWith('node:') || builtinModules.includes(id);
      },
      output: { format: 'cjs', entryFileNames: 'fixture.cjs', inlineDynamicImports: true },
      plugins: [
        {
          name: 'record-drain-source-hashes',
          generateBundle(_options, output) {
            for (const item of Object.values(output)) {
              if (item.type !== 'chunk') continue;
              if (item.imports.includes('electron') || item.dynamicImports.length > 0)
                throw new Error('离线排水最终产物不得依赖 Electron 或动态块');
              for (const path of Object.keys(item.modules).sort()) {
                if (path.startsWith('\0')) continue;
                const name = relative(repository, path).replaceAll('\\', '/');
                if (name.startsWith('../') || name.includes('?'))
                  throw new Error('资格依赖不在固定仓库内');
                sourceHashes[name] = hash(readFileSync(path));
              }
            }
          },
        },
      ],
    },
  },
});
const artifact = join(root, 'fixture.cjs');
const proof = {
  version: 1,
  buildId: id,
  createdAt: new Date().toISOString(),
  baseline: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
  }).trim(),
  node: process.version,
  budget: BUDGET,
  bundleSha256: hash(readFileSync(artifact)),
  bundleBytes: lstatSync(artifact).size,
  sourceHashes,
  toolingHashes: Object.fromEntries(
    [
      'package.json',
      'package-lock.json',
      'tools/data-qualification/drain/build.ts',
      'tools/data-qualification/drain/run.ps1',
      'tools/release-profile/JobProcess.cs',
    ].map((name) => [name, hash(readFileSync(join(repository, name)))]),
  ),
};
writeFileSync(join(root, 'build-proof.json'), JSON.stringify(proof, null, 2));
console.log(
  JSON.stringify({
    buildId: id,
    bundleSha256: proof.bundleSha256,
    bytes: proof.bundleBytes,
    sourceCount: Object.keys(sourceHashes).length,
    executed: false,
  }),
);
