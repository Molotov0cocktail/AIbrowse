import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
  lstatSync,
  realpathSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
function need(value: unknown): asserts value {
  if (!value) throw new Error('固定容量工具构建失败');
}
const CONVERSATION_ID = 'full-conversations-29d6709186ef4d179628e94ec8c73663';
const RUNTIME_ID = 'runtime-9399eea0c11d4e6f9cde46ae2369376b';

const directory = dirname(fileURLToPath(import.meta.url)),
  repository = resolve(directory, '../../..');
need(process.argv.length === 2 && process.platform === 'win32' && /^v24\./u.test(process.version));
for (let current = join(repository, 'log/stage7-e2'); ; current = dirname(current)) {
  const stat = lstatSync(current);
  need(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      realpathSync(current).toLowerCase() === current.toLowerCase(),
  );
  if (dirname(current) === current) break;
}
const scopeId = 'full-transfer-' + randomUUID().replaceAll('-', ''),
  scope = join(repository, 'log/stage7-e2', scopeId),
  app = join(scope, 'app');
mkdirSync(scope);
mkdirSync(app);
mkdirSync(join(app, 'out'));
mkdirSync(join(app, 'out/lifecycle-guardian'));
function hash(path: string): string {
  const fd = openSync(path, 'r'),
    buffer = Buffer.alloc(65536),
    digest = createHash('sha256');
  try {
    for (;;) {
      const n = readSync(fd, buffer);
      if (!n) break;
      digest.update(buffer.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return digest.digest('hex');
}
const before: Record<string, string> = {};
function walk(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    need(!entry.isSymbolicLink());
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else before[relative(repository, path).replaceAll('\\', '/')] = hash(path);
  }
}
walk(join(repository, 'src'));
walk(directory);
walk(join(repository, 'native/lifecycle-guardian'));
for (const file of ['package.json', 'package-lock.json'])
  before[file] = hash(join(repository, file));
const sources: Record<string, string> = {};
for (const [entry, output] of [
  ['tools/data-qualification/full-transfer/import-entry.ts', 'import.cjs'],
  ['tools/data-qualification/full-transfer/main.ts', 'app/main.cjs'],
  ['src/main/storage/transfer-worker.ts', 'app/transfer-worker.js'],
  ['tools/data-qualification/full-transfer/counts-worker.ts', 'app/counts-worker.js'],
] as const) {
  const result = await build({
    entryPoints: [join(repository, entry)],
    outfile: join(scope, output),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    metafile: true,
  });
  for (const input of Object.keys(result.metafile!.inputs)) {
    const name = relative(repository, resolve(input)).replaceAll('\\', '/');
    need(before[name] && before[name] === hash(join(repository, name)));
    sources[name] = before[name];
  }
}
const native = 'native/lifecycle-guardian/Guardian.cs';
const compiler = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
);
const guardian = join(app, 'out/lifecycle-guardian/guardian.exe');
execFileSync(
  compiler,
  [
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    '/optimize+',
    '/out:' + guardian,
    join(repository, native),
  ],
  { windowsHide: true, timeout: 10000 },
);
sources[native] = before[native];
need(before[native] === hash(join(repository, native)));
writeFileSync(
  join(app, 'lifecycle-guardian-integrity.json'),
  JSON.stringify({ version: 1, bytes: statSync(guardian).size, sha256: hash(guardian) }),
  { flag: 'wx' },
);
const version: unknown = (
  JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as { version: unknown }
).version;
need(typeof version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version));
writeFileSync(
  join(app, 'package.json'),
  JSON.stringify({ name: 'aibrowse-full-transfer-qualification', version, main: 'main.cjs' }),
  { flag: 'wx' },
);
for (const name of Object.keys(before).filter(
  (name) =>
    name.startsWith('tools/data-qualification/full-transfer/') ||
    ['package.json', 'package-lock.json'].includes(name),
))
  sources[name] = before[name];
for (const [name, sha] of Object.entries(sources)) need(hash(join(repository, name)) === sha);
const artifactNames = [
  'import.cjs',
  'app/main.cjs',
  'app/transfer-worker.js',
  'app/counts-worker.js',
  'app/package.json',
  'app/lifecycle-guardian-integrity.json',
  'app/out/lifecycle-guardian/guardian.exe',
];
const artifacts = Object.fromEntries(
  artifactNames.map((name) => [
    name,
    { bytes: statSync(join(scope, name)).size, sha256: hash(join(scope, name)) },
  ]),
);
need(Object.values(artifacts).reduce((total, v) => total + v.bytes, 0) <= 8 * 1024 * 1024);
const nodePath = process.execPath,
  electronPath = join(repository, 'node_modules/electron/dist/electron.exe');
const receipt = {
  version: 1,
  scopeId,
  conversationId: CONVERSATION_ID,
  runtimeId: RUNTIME_ID,
  sources,
  artifacts,
  node: { path: nodePath, sha256: hash(nodePath), version: process.version },
  electron: { path: electronPath, sha256: hash(electronPath) },
  compilerSha256: hash(compiler),
  productE2Pass: false,
};
const text = JSON.stringify(receipt);
need(Buffer.byteLength(text) <= 65536);
writeFileSync(join(scope, 'build-proof.json'), text, { flag: 'wx' });
// The approved helper source is copied for a scope-local, bound native compilation.
copyFileSync(join(directory, 'FixedTransferJob.cs'), join(scope, 'FixedTransferJob.cs'), 1);
console.log(JSON.stringify({ scopeId, built: true, imported: false, productE2Pass: false }));
