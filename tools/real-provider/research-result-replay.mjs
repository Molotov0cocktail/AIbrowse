// Build and run an offline, read-only replay; no credentials or network are used.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const campaign = process.argv[2] ?? '';
if (!/^campaign-[a-f0-9-]{36}$/.test(campaign)) throw new Error('合成场景名称无效');
const evidenceRoot = resolve('log/real-provider-20261012');
const campaignRoot = join(evidenceRoot, campaign, 'research');
const folders = readdirSync(campaignRoot, { withFileTypes: true }).filter(
  (entry) => entry.isDirectory() && /^research-scenarios-[A-Za-z0-9]+$/.test(entry.name),
);
if (folders.length !== 1) throw new Error('合成研究目录数量不符');
const root = join(evidenceRoot, 'validator-replay-' + randomUUID());
mkdirSync(root);
const artifact = join(root, 'entry.cjs');
const output = await build({
  entryPoints: ['tools/real-provider/research-result-replay.ts'],
  outfile: artifact,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  metafile: true,
});
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
writeFileSync(
  join(root, 'binding.json'),
  JSON.stringify(
    {
      sources: Object.fromEntries(
        [
          ...Object.keys(output.metafile.inputs),
          'tools/real-provider/research-result-replay.mjs',
        ].map((path) => [path, hash(path)]),
      ),
      bundle: hash(artifact),
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
const processResult = spawnSync(
  process.execPath,
  [artifact, join(campaignRoot, folders[0].name, 'research.db'), join(root, 'report.json')],
  { cwd: resolve('.'), windowsHide: true, encoding: 'utf8', timeout: 15000 },
);
writeFileSync(join(root, 'process-output.log'), processResult.stdout + processResult.stderr, {
  flag: 'wx',
});
writeFileSync(
  join(root, 'process-result.json'),
  JSON.stringify({ exitCode: processResult.status, signal: processResult.signal }, null, 2),
  { flag: 'wx' },
);
process.stdout.write(JSON.stringify({ root, exitCode: processResult.status }) + '\n');
process.exitCode = processResult.status ?? 1;
