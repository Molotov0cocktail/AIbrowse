import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repository = process.cwd();
const scopeId = 'oversize-preflight-b5a2ce2061a94edd9ad7d4a8762e5428';
const scope = join(repository, 'log/stage7-e2', scopeId);
const evidence = join(repository, 'log/stage7-e2/oversize-preflight-independent-repair-001');
mkdirSync(evidence, { recursive: true });
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const requireFact = (value: boolean): void => {
  if (!value) throw new Error('独立修复绑定不一致');
};
const proofBytes = readFileSync(join(scope, 'build-proof.json'));
requireFact(
  hash(proofBytes) === '13ff2f50a5fdda133207f8d1e458c5ce382e1b174e4182b642b43741584d8d4e',
);
const proof = JSON.parse(proofBytes.toString('utf8')) as {
  scopeId: string;
  sources: Record<string, string>;
  artifacts: Record<string, { bytes: number; sha256: string }>;
  workerBundle: { inputs: Record<string, string>; sha256: string };
  node: { version: string; sha256: string };
};
requireFact(proof.scopeId === scopeId);
const toolNames = [
  'build.ts',
  'contract.ts',
  'worker.ts',
  'SparseFile.cs',
  'run.ps1',
  'README.md',
  'contract.test.ts',
  'native.test.ps1',
  'worker.test.ts',
  'wrapper.test.ts',
];
const productionNames = [
  'src/main/storage/native-transfer-selection.ts',
  'src/main/storage/staging-sqlite.ts',
  'src/main/storage/backup-container.ts',
  'src/main/storage/dataset-layout.ts',
  'src/main/storage/bounded-json.ts',
  'src/main/ai/conversation-transfer.ts',
];
const expectedInputs = [
  ...productionNames,
  'tools/data-qualification/oversize-preflight/worker.ts',
  'tools/data-qualification/oversize-preflight/contract.ts',
].sort();
const expectedSources = [
  ...productionNames,
  ...toolNames.map((name) => `tools/data-qualification/oversize-preflight/${name}`),
  'package.json',
  'package-lock.json',
  'tools/data-qualification/full-transfer/FixedTransferJob.cs',
].sort();
requireFact(Object.keys(proof.sources).sort().join('|') === expectedSources.join('|'));
requireFact(Object.keys(proof.workerBundle.inputs).sort().join('|') === expectedInputs.join('|'));
requireFact(
  Object.keys(proof.artifacts).sort().join('|') === 'FixedTransferJob.cs|SparseFile.cs|worker.cjs',
);
for (const [name, digest] of Object.entries(proof.sources))
  requireFact(hash(readFileSync(join(repository, name))) === digest);
for (const name of expectedInputs)
  requireFact(proof.workerBundle.inputs[name] === proof.sources[name]);
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
    'be1fbf5623ae06da19848f33c5837c1c3ca42827935961d99453a1397cbcd167',
);
requireFact(
  proof.sources['tools/data-qualification/oversize-preflight/run.ps1'] ===
    'ae890d64a65b6f3660d761acacff658763f5b2aad35a654ca2db252e9ef8eb34',
);
requireFact(
  process.version === proof.node.version &&
    hash(readFileSync(process.execPath)) === proof.node.sha256,
);
const rebuilt = await build({
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
requireFact(rebuilt.outputFiles.length === 1);
requireFact(hash(rebuilt.outputFiles[0]!.contents) === proof.artifacts['worker.cjs']!.sha256);
requireFact(proof.workerBundle.sha256 === proof.artifacts['worker.cjs']!.sha256);
requireFact(
  Object.keys(rebuilt.metafile.inputs)
    .map((name) => name.replaceAll('\\', '/'))
    .sort()
    .join('|') === expectedInputs.join('|'),
);
requireFact(
  readdirSync(scope).sort().join('|') ===
    'FixedTransferJob.cs|SparseFile.cs|build-proof.json|worker.cjs',
);
const report = {
  scopeId,
  passed: true,
  sources: expectedSources.length,
  artifacts: 3,
  inputs: expectedInputs.length,
  proofSha256: hash(proofBytes),
  workerSha256: proof.workerBundle.sha256,
  sourceHashes: proof.sources,
  rebuiltInMemory: true,
  scopeUnmodified: true,
  actualLargeEofCreated: false,
  jobStarted: false,
};
writeFileSync(join(evidence, 'binding.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
