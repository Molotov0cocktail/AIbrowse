import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE, JOB_SOURCE_SHA256, NODE_SHA256, NODE_VERSION, need } from './contract.ts';

function fileFact(path: string): BigIntStats {
  const result = lstatSync(path, { bigint: true });
  need(
    result.isFile() &&
      !result.isSymbolicLink() &&
      result.nlink === 1n &&
      realpathSync(path).toLowerCase() === resolve(path).toLowerCase(),
  );
  return result;
}

function same(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.nlink === b.nlink
  );
}

function hash(path: string): string {
  const before = fileFact(path);
  const descriptor = openSync(path, 'r');
  const digest = createHash('sha256');
  const buffer = Buffer.alloc(65536);
  try {
    need(same(before, fstatSync(descriptor, { bigint: true })));
    for (;;) {
      const bytes = readSync(descriptor, buffer);
      if (bytes === 0) break;
      digest.update(buffer.subarray(0, bytes));
    }
    need(same(before, fstatSync(descriptor, { bigint: true })));
  } finally {
    closeSync(descriptor);
  }
  need(same(before, fileFact(path)));
  return digest.digest('hex');
}

function captureParents(path: string): () => void {
  const facts: { path: string; dev: bigint; ino: bigint }[] = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    const fact = lstatSync(current, { bigint: true });
    need(
      fact.isDirectory() &&
        !fact.isSymbolicLink() &&
        realpathSync(current).toLowerCase() === current.toLowerCase(),
    );
    facts.push({ path: current, dev: fact.dev, ino: fact.ino });
    if (dirname(current) === current) break;
  }
  return () => {
    for (const expected of facts) {
      const fact = lstatSync(expected.path, { bigint: true });
      need(
        fact.isDirectory() &&
          !fact.isSymbolicLink() &&
          fact.dev === expected.dev &&
          fact.ino === expected.ino,
      );
    }
  };
}

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../../..');
need(
  process.argv.length === 2 &&
    process.platform === 'win32' &&
    process.arch === 'x64' &&
    process.version === NODE_VERSION &&
    hash(process.execPath) === NODE_SHA256,
);
const verifyParents = captureParents(join(repository, 'log/stage7-e2'));
need(
  execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  }).trim() === BASELINE,
);
const jobSource = join(repository, 'tools/data-qualification/full-transfer/FixedTransferJob.cs');
need(hash(jobSource) === JOB_SOURCE_SHA256);

const scopeId = 'oversize-preflight-' + randomUUID().replaceAll('-', '');
const scope = join(repository, 'log/stage7-e2', scopeId);
mkdirSync(scope);

const sources: Record<string, string> = {};
function bind(path: string, bytes?: Buffer): void {
  const name = relative(repository, path).replaceAll('\\', '/');
  need(!name.startsWith('../') && !name.includes('..') && !name.includes(':'));
  const digest = bytes ? createHash('sha256').update(bytes).digest('hex') : hash(path);
  need(sources[name] === undefined || sources[name] === digest);
  sources[name] = digest;
}
const toolFiles = [
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
need(readdirSync(directory).sort().join('|') === [...toolFiles].sort().join('|'));
for (const name of toolFiles) bind(join(directory, name));
for (const name of ['package.json', 'package-lock.json']) bind(join(repository, name));
bind(jobSource);

const result = await build({
  absWorkingDir: repository,
  entryPoints: [join(directory, 'worker.ts')],
  outfile: join(scope, 'worker.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  metafile: true,
  plugins: [
    {
      name: 'freeze-oversize-preflight-inputs',
      setup(api) {
        api.onLoad({ filter: /\.(?:ts|[cm]?js|json)$/ }, (args) => {
          const bytes = readFileSync(args.path);
          bind(args.path, bytes);
          const extension = extname(args.path);
          return {
            contents: bytes,
            loader: extension === '.ts' ? 'ts' : extension === '.json' ? 'json' : 'js',
          };
        });
      },
    },
  ],
});
const expectedInputs = [
  'tools/data-qualification/oversize-preflight/worker.ts',
  'tools/data-qualification/oversize-preflight/contract.ts',
  'src/main/storage/native-transfer-selection.ts',
  'src/main/storage/staging-sqlite.ts',
  'src/main/storage/backup-container.ts',
  'src/main/storage/dataset-layout.ts',
  'src/main/storage/bounded-json.ts',
  'src/main/ai/conversation-transfer.ts',
];
const inputNames = Object.keys(result.metafile.inputs).map((name) => name.replaceAll('\\', '/'));
need(inputNames.sort().join('|') === expectedInputs.sort().join('|'));
const expectedSources = new Set([
  ...toolFiles.map((name) => `tools/data-qualification/oversize-preflight/${name}`),
  ...inputNames,
  'package.json',
  'package-lock.json',
  'tools/data-qualification/full-transfer/FixedTransferJob.cs',
]);
need(Object.keys(sources).sort().join('|') === [...expectedSources].sort().join('|'));
copyFileSync(jobSource, join(scope, 'FixedTransferJob.cs'), 1);
copyFileSync(join(directory, 'SparseFile.cs'), join(scope, 'SparseFile.cs'), 1);
for (const [name, digest] of Object.entries(sources)) need(hash(join(repository, name)) === digest);
verifyParents();

const artifacts = Object.fromEntries(
  ['worker.cjs', 'FixedTransferJob.cs', 'SparseFile.cs'].map((name) => [
    name,
    { bytes: statSync(join(scope, name)).size, sha256: hash(join(scope, name)) },
  ]),
);
need(Object.values(artifacts).reduce((total, item) => total + item.bytes, 0) <= 8 * 1024 ** 2);
need(
  artifacts['SparseFile.cs']!.sha256 ===
    sources['tools/data-qualification/oversize-preflight/SparseFile.cs'],
);
need(artifacts['FixedTransferJob.cs']!.sha256 === JOB_SOURCE_SHA256);
const proof = JSON.stringify({
  version: 1,
  scopeId,
  kind: 'oversize-preflight-build',
  baseline: BASELINE,
  sources,
  artifacts,
  workerBundle: {
    inputs: Object.fromEntries(inputNames.map((name) => [name, sources[name]])),
    sha256: artifacts['worker.cjs']!.sha256,
  },
  node: { version: NODE_VERSION, sha256: NODE_SHA256 },
  fixedTransferJobSha256: JOB_SOURCE_SHA256,
  builtOnly: true,
  executed: false,
  productE2Pass: false,
  capacityQualified: false,
  enospcQualified: false,
});
need(Buffer.byteLength(proof) <= 65536);
writeFileSync(join(scope, 'build-proof.json'), proof, { flag: 'wx', flush: true });
process.stdout.write(
  JSON.stringify({ scopeId, built: true, executed: false, productE2Pass: false }) + '\n',
);
