import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

if (process.argv.length !== 2 || !/^v24\./.test(process.version))
  throw new Error('小型SQLite资格仅接受Node24固定入口');
const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../../..');
const root = join(
  repository,
  'log',
  'stage7-e2',
  `staging-sqlite-${randomUUID().replaceAll('-', '')}`,
);
mkdirSync(root, { recursive: true });
const sourceHashes: Record<string, string> = {};
const hash = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');
await build({
  configFile: false,
  envFile: false,
  root: repository,
  publicDir: false,
  logLevel: 'warn',
  build: {
    ssr: join(here, 'worker.ts'),
    target: 'node24',
    outDir: root,
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      external: (id) => id.startsWith('node:') || builtinModules.includes(id),
      output: { format: 'cjs', entryFileNames: 'worker.cjs', inlineDynamicImports: true },
      plugins: [
        {
          name: 'bind-staging-qualification',
          generateBundle(_options, output) {
            for (const item of Object.values(output)) {
              if (item.type !== 'chunk') continue;
              for (const file of Object.keys(item.modules)) {
                if (file.startsWith('\0')) continue;
                const name = relative(repository, file).replaceAll('\\', '/');
                if (name.startsWith('../') || name.includes('?')) throw new Error('资格依赖越界');
                sourceHashes[name] = hash(file);
              }
            }
          },
        },
      ],
    },
  },
});
writeFileSync(
  join(root, 'proof.json'),
  JSON.stringify(
    {
      node: process.version,
      baseline: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8',
        windowsHide: true,
      }).trim(),
      sourceHashes,
      runnerHash: hash(fileURLToPath(import.meta.url)),
      bundleHash: hash(join(root, 'worker.cjs')),
    },
    null,
    2,
  ),
);
const runs: unknown[] = [];
// The historical heap-limit counterexample remains failed in its original run.
// This runner qualifies no replacement heap limit and never repeats that probe.
for (const mode of ['migration', 'full']) {
  const result = spawnSync(process.execPath, [join(root, 'worker.cjs'), mode], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 65536,
  });
  writeFileSync(join(root, `${mode}-stdout.txt`), result.stdout ?? '');
  writeFileSync(join(root, `${mode}-stderr.txt`), result.stderr ?? '');
  runs.push({
    mode,
    status: result.status,
    signal: result.signal,
    failedToRun: result.error !== undefined,
  });
  writeFileSync(join(root, 'runs.json'), JSON.stringify(runs, null, 2));
  if (result.status !== 0 || result.error !== undefined)
    throw new Error(`固定SQLite资格失败：${mode}，原件已保留`);
}
process.stdout.write(`${root}\n`);
