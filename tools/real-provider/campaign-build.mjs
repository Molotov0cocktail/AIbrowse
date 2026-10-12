// Reproducible real-provider campaign; private input uses a one-use local pipe at runtime.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const root = resolve('log/real-provider-20261012', 'campaign-' + randomUUID());
mkdirSync(join(root, 'profile'), { recursive: true });
writeFileSync(
  join(root, 'package.json'),
  JSON.stringify({ name: 'real-provider-campaign', main: 'entry.cjs' }),
);
const result = await build({
  entryPoints: ['tools/real-provider/campaign.ts'],
  outfile: join(root, 'entry.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  metafile: true,
});
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
writeFileSync(
  join(root, 'binding.json'),
  JSON.stringify(
    {
      baseline: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      sources: Object.fromEntries(
        [
          ...Object.keys(result.metafile.inputs),
          'tools/real-provider/campaign-build.mjs',
          'tools/real-provider/campaign-launch.mjs',
          'tools/real-provider/page-fixture.mjs',
        ].map((file) => [file, hash(file)]),
      ),
      bundle: hash(join(root, 'entry.cjs')),
      electron: hash('node_modules/electron/dist/electron.exe'),
      requestBudget: 28,
      lifetimeMs: 900000,
    },
    null,
    2,
  ),
);
process.stdout.write(root + '\n');
