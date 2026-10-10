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
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function need(value: unknown): asserts value {
  if (!value) throw new Error('固定物理容量构建失败，原件保留');
}
const NODE_SHA256 = '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de';
const NODE_VERSION = 'v24.18.0';
const RUNTIME_ID = 'runtime-9399eea0c11d4e6f9cde46ae2369376b';
const SOURCE_PROOF = 'f07a1a59ef5639d10c17eae1a80e6f7709d681623230c64d7bd54f4b089077e5';
function fileFact(path: string) {
  const s = lstatSync(path, { bigint: true });
  need(
    s.isFile() &&
      !s.isSymbolicLink() &&
      s.nlink === 1n &&
      realpathSync(path).toLowerCase() === resolve(path).toLowerCase(),
  );
  return s;
}
function same(a: ReturnType<typeof fileFact>, b: ReturnType<typeof fileFact>) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.nlink === b.nlink
  );
}
function parents(path: string) {
  const captured: { path: string; dev: bigint; ino: bigint }[] = [];
  for (let p = resolve(path); ; p = dirname(p)) {
    const s = lstatSync(p, { bigint: true });
    need(
      s.isDirectory() && !s.isSymbolicLink() && realpathSync(p).toLowerCase() === p.toLowerCase(),
    );
    captured.push({ path: p, dev: s.dev, ino: s.ino });
    if (dirname(p) === p) break;
  }
  return () =>
    captured.forEach((entry) => {
      const s = lstatSync(entry.path, { bigint: true });
      need(s.isDirectory() && !s.isSymbolicLink() && s.dev === entry.dev && s.ino === entry.ino);
    });
}

const directory = dirname(fileURLToPath(import.meta.url)),
  repository = resolve(directory, '../../..');
need(
  process.argv.length === 2 &&
    process.platform === 'win32' &&
    process.arch === 'x64' &&
    process.version === NODE_VERSION,
);
const verifyParents = parents(join(repository, 'log/stage7-e2'));
function hash(path: string): string {
  const before = fileFact(path),
    fd = openSync(path, 'r'),
    bytes = Buffer.alloc(65536),
    digest = createHash('sha256');
  try {
    need(same(before, fstatSync(fd, { bigint: true })));
    for (;;) {
      const n = readSync(fd, bytes);
      if (!n) break;
      digest.update(bytes.subarray(0, n));
    }
    need(same(before, fstatSync(fd, { bigint: true })));
  } finally {
    closeSync(fd);
  }
  need(same(before, fileFact(path)));
  return digest.digest('hex');
}
need(hash(process.execPath) === NODE_SHA256);
const scopeId = 'physical-sources512-' + randomUUID().replaceAll('-', ''),
  scope = join(repository, 'log/stage7-e2', scopeId);
mkdirSync(scope);
const sources: Record<string, string> = {};
function bind(path: string, bytes?: Buffer): string {
  const name = relative(repository, path).replaceAll('\\', '/');
  need(!name.startsWith('../') && !name.includes('..') && !name.includes(':'));
  const sha = bytes ? createHash('sha256').update(bytes).digest('hex') : hash(path);
  need(!sources[name] || sources[name] === sha);
  sources[name] = sha;
  return name;
}
for (const name of readdirSync(directory)) bind(join(directory, name));
for (const name of [
  'package.json',
  'package-lock.json',
  'tools/data-qualification/full-transfer/FixedTransferJob.cs',
  'tools/data-qualification/physical-capacity/allocation.cs',
])
  bind(join(repository, name));
await build({
  absWorkingDir: repository,
  entryPoints: [join(directory, 'main.ts')],
  outfile: join(scope, 'generate.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  metafile: true,
  plugins: [
    {
      name: 'freeze-physical-capacity-inputs',
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
copyFileSync(
  join(repository, 'tools/data-qualification/full-transfer/FixedTransferJob.cs'),
  join(scope, 'FixedTransferJob.cs'),
  1,
);
copyFileSync(
  join(directory, '../physical-capacity/allocation.cs'),
  join(scope, 'allocation.cs'),
  1,
);
for (const [name, sha] of Object.entries(sources)) need(hash(join(repository, name)) === sha);
verifyParents();
const artifacts = Object.fromEntries(
  ['generate.cjs', 'FixedTransferJob.cs', 'allocation.cs'].map((name) => [
    name,
    { bytes: Number(fileFact(join(scope, name)).size), sha256: hash(join(scope, name)) },
  ]),
);
need(Object.values(artifacts).reduce((sum, file) => sum + file.bytes, 0) <= 8 * 1024 ** 2);
const proof = JSON.stringify({
  version: 1,
  scopeId,
  kind: 'sources512-node-construction',
  runtimeId: RUNTIME_ID,
  sourceProof: SOURCE_PROOF,
  baseline: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  }).trim(),
  sources,
  artifacts,
  node: { sha256: NODE_SHA256, version: NODE_VERSION },
  productE2Pass: false,
  electronQualified: false,
});
need(Buffer.byteLength(proof) <= 65536);
writeFileSync(join(scope, 'build-proof.json'), proof, { flag: 'wx' });
process.stdout.write(
  JSON.stringify({ scopeId, built: true, constructed: false, productE2Pass: false }) + '\n',
);
