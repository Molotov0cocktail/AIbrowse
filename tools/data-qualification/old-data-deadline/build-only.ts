import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildQualification } from './build.ts';
import { NODE_VERSION, SCOPE_PREFIX, need } from './contract.ts';

need(
  process.argv.length === 2 &&
    process.platform === 'win32' &&
    process.arch === 'x64' &&
    process.version === NODE_VERSION,
);
const repository = resolve(import.meta.dirname, '../../..');
need(realpathSync.native(repository).toLowerCase() === repository.toLowerCase());
const evidenceRoot = join(repository, 'log', 'stage7-e2');
const rootStat = await lstat(evidenceRoot);
need(rootStat.isDirectory() && !rootStat.isSymbolicLink());
const scopeId = SCOPE_PREFIX + randomUUID().replaceAll('-', '');
const output = join(evidenceRoot, scopeId);
const baseline = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repository,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 10_000,
}).trim();
const proof = await buildQualification(repository, output, baseline, scopeId);
process.stdout.write(
  JSON.stringify({
    built: true,
    scopeId: proof.scopeId,
    sources: proof.sources.length,
    productE2Pass: false,
  }) + '\n',
);
