import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { LIMITS } from './projection.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../../..');
if (process.argv.length !== 2 || !/^v24\./.test(process.version))
  throw new Error('固定构建需要 Node 24 且不接受参数');
const id = `projection-${randomUUID().replaceAll('-', '')}`;
const root = join(repository, 'log', 'stage7-e2', id);
for (const path of [repository, join(repository, 'log'), dirname(root)])
  if (lstatSync(path).isSymbolicLink()) throw new Error('构建路径不得含链接');
mkdirSync(root);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sourceHashes: Record<string, string> = {};
await build({
  configFile: false,
  envFile: false,
  root: repository,
  publicDir: false,
  logLevel: 'warn',
  ssr: { noExternal: true },
  build: {
    ssr: join(here, 'main.ts'),
    target: 'node24',
    outDir: root,
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      external(id) {
        if (id === 'electron') throw new Error('离线投影不得依赖 Electron');
        return id.startsWith('node:') || builtinModules.includes(id);
      },
      output: { format: 'cjs', entryFileNames: 'fixture.cjs', inlineDynamicImports: true },
      plugins: [
        {
          name: 'bind-projection-sources',
          generateBundle(_options, output) {
            for (const item of Object.values(output)) {
              if (item.type !== 'chunk') continue;
              if (item.dynamicImports.length > 0) throw new Error('资格不得动态加载块');
              for (const path of Object.keys(item.modules).sort()) {
                if (path.startsWith('\0')) continue;
                const name = relative(repository, path).replaceAll('\\', '/');
                if (name.startsWith('../') || name.includes('?')) throw new Error('资格依赖越界');
                sourceHashes[name] = hash(readFileSync(path));
              }
            }
          },
        },
      ],
    },
  },
});
const proof = {
  buildId: id,
  version: 1,
  createdAt: new Date().toISOString(),
  baseline: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
  }).trim(),
  node: process.version,
  limits: LIMITS,
  sourceHashes,
  bundleSha256: hash(readFileSync(join(root, 'fixture.cjs'))),
  toolingHashes: Object.fromEntries(
    [
      'package.json',
      'package-lock.json',
      'src/shared/types/conversation.ts',
      'src/shared/types/agent.ts',
      'tools/data-qualification/projection/build.ts',
      'tools/data-qualification/projection/run.ps1',
      'tools/release-profile/JobProcess.cs',
    ].map((name) => [name, hash(readFileSync(join(repository, name)))]),
  ),
};
writeFileSync(join(root, 'build-proof.json'), JSON.stringify(proof, null, 2));
console.log(JSON.stringify({ buildId: id, bundleSha256: proof.bundleSha256, executed: false }));
