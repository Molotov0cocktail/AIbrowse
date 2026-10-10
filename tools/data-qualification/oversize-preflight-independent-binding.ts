import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repository = process.cwd();
const scopeId = 'oversize-preflight-a57f580c38de497dbcfd6c48c3242afc';
const scope = join(repository, 'log/stage7-e2', scopeId);
const evidence = join(repository, 'log/stage7-e2/oversize-preflight-independent-review-001');
const proof = JSON.parse(readFileSync(join(scope, 'build-proof.json'), 'utf8')) as {
  sources: Record<string, string>;
  artifacts: Record<string, { bytes: number; sha256: string }>;
  node: { version: string; sha256: string };
};
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const requireFact = (value: boolean): void => {
  if (!value) throw new Error('独立构建绑定不一致');
};
for (const [name, digest] of Object.entries(proof.sources)) {
  requireFact(hash(readFileSync(join(repository, name))) === digest);
}
for (const [name, item] of Object.entries(proof.artifacts)) {
  requireFact(statSync(join(scope, name)).size === item.bytes);
  requireFact(hash(readFileSync(join(scope, name))) === item.sha256);
}
requireFact(
  proof.artifacts['SparseFile.cs']!.sha256 ===
    proof.sources['tools/data-qualification/oversize-preflight/SparseFile.cs'],
);
requireFact(
  proof.artifacts['FixedTransferJob.cs']!.sha256 ===
    proof.sources['tools/data-qualification/full-transfer/FixedTransferJob.cs'],
);
requireFact(process.version === proof.node.version);
requireFact(hash(readFileSync(process.execPath)) === proof.node.sha256);
const result = await build({
  absWorkingDir: repository,
  entryPoints: [join(repository, 'tools/data-qualification/oversize-preflight/worker.ts')],
  outfile: join(scope, 'worker.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  metafile: true,
  write: false,
});
requireFact(result.outputFiles.length === 1);
requireFact(hash(result.outputFiles[0]!.contents) === proof.artifacts['worker.cjs']!.sha256);
const bundleInputs = Object.keys(result.metafile.inputs)
  .map((path) => path.replaceAll('\\', '/'))
  .sort();
const expectedSources = new Set([
  ...readdirSync(join(repository, 'tools/data-qualification/oversize-preflight')).map(
    (name) => `tools/data-qualification/oversize-preflight/${name}`,
  ),
  'package.json',
  'package-lock.json',
  'tools/data-qualification/full-transfer/FixedTransferJob.cs',
  ...bundleInputs,
]);
requireFact([...expectedSources].sort().join('|') === Object.keys(proof.sources).sort().join('|'));
requireFact(
  readdirSync(scope).sort().join('|') ===
    ['FixedTransferJob.cs', 'SparseFile.cs', 'build-proof.json', 'worker.cjs'].sort().join('|'),
);
const report = {
  version: 1,
  scopeId,
  currentBindingPassed: true,
  wrapperAdmissionQualified: false,
  sources: Object.keys(proof.sources).length,
  artifacts: Object.keys(proof.artifacts).length,
  bundleInputs,
  workerSha256: proof.artifacts['worker.cjs']!.sha256,
  buildProofSha256: hash(readFileSync(join(scope, 'build-proof.json'))),
  rebuiltInMemory: true,
  scopeUnmodified: true,
  jobInvoked: false,
  actualLargeEofCreated: false,
  largeInputRead: false,
};
writeFileSync(resolve(evidence, 'binding.json'), JSON.stringify(report, null, 2), {
  flag: 'wx',
});
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
