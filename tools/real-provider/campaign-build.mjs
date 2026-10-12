// Reproducible real-provider campaign; private input uses a one-use local pipe at runtime.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { campaignPolicy } from './campaign-policy.ts';

if (process.argv.length > 3 || !['legacy', 'watch-repair'].includes(process.argv[2] ?? 'legacy'))
  throw new Error('构建阶段仅允许 legacy 或 watch-repair');
const policy = campaignPolicy(process.argv[2] ?? 'legacy');

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
          'tools/real-provider/campaign-policy.ts',
          'tools/real-provider/secret-scan.ts',
          'tools/real-provider/campaign-cleanup.ts',
        ].map((file) => [file, hash(file)]),
      ),
      bundle: hash(join(root, 'entry.cjs')),
      electron: hash('node_modules/electron/dist/electron.exe'),
      ...policy,
    },
    null,
    2,
  ),
);
process.stdout.write(root + '\n');
