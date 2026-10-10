import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../../..');
if (process.argv.length !== 2 || !/^v24\./.test(process.version))
  throw new Error('固定构建仅接受Node24且不接受参数');
for (let path = join(repository, 'log', 'stage7-e2'); ; path = dirname(path)) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('工具目录无效');
  if (path === dirname(path)) break;
}
const scopeId = `full-conversations-${randomUUID().replaceAll('-', '')}`;
const scope = join(repository, 'log', 'stage7-e2', scopeId);
mkdirSync(scope);
const paths = [
  'tools/data-qualification/full-conversations/files.ts',
  'tools/data-qualification/full-conversations/main.ts',
  'tools/data-qualification/full-conversations/entry.ts',
  'tools/data-qualification/full-conversations/build.ts',
  'tools/data-qualification/projection/samples.ts',
  'tools/data-qualification/projection/projection.ts',
  'tools/data-qualification/fixtures.ts',
  'src/main/ai/conversation-transfer.ts',
  'src/main/storage/bounded-json.ts',
  'package.json',
  'package-lock.json',
];
const hash = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const sources = Object.fromEntries(paths.map((path) => [path, hash(join(repository, path))]));
await build({
  configFile: false,
  envFile: false,
  root: repository,
  publicDir: false,
  logLevel: 'warn',
  ssr: { noExternal: true },
  build: {
    ssr: join(directory, 'entry.ts'),
    target: 'node24',
    outDir: scope,
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      output: { format: 'cjs', entryFileNames: 'prepare.cjs', inlineDynamicImports: true },
    },
  },
});
for (const path of paths)
  if (sources[path] !== hash(join(repository, path))) throw new Error('构建期间源码变化');
if (lstatSync(join(scope, 'prepare.cjs')).size > 1024 ** 2 - 3 * 65536)
  throw new Error('工具制品过大');
writeFileSync(
  join(scope, 'build-proof.json'),
  JSON.stringify(
    {
      version: 1,
      scopeId,
      nodeVersion: process.version,
      sources,
      bundleSha256: hash(join(scope, 'prepare.cjs')),
      productE2Pass: false,
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
console.log(JSON.stringify({ scopeId, prepared: false, productE2Pass: false }));
