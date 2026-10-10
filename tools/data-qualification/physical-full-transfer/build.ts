import { build, type Metafile, type Plugin } from 'esbuild';
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
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_SHA256, NODE_VERSION, SOURCE_SCOPES, need, requireScopeId } from './contract';
import {
  assertExactMappings,
  mappingPlugin,
  rejectMixedOldInputs,
  type EntryName,
  type SourceMapping,
} from './mapping';

async function main(): Promise<void> {
  const directory = dirname(fileURLToPath(import.meta.url));
  const repository = resolve(directory, '../../..');
  need(
    process.argv.length === 3 &&
      process.argv[2] === '--build-only' &&
      process.platform === 'win32' &&
      process.arch === 'x64' &&
      process.version === NODE_VERSION,
  );

  function fileFact(path: string, allowHardlink = false) {
    const value = lstatSync(path, { bigint: true });
    need(
      value.isFile() &&
        !value.isSymbolicLink() &&
        (allowHardlink ? value.nlink >= 1n : value.nlink === 1n) &&
        realpathSync(path).toLowerCase() === resolve(path).toLowerCase(),
    );
    return value;
  }
  function same(a: ReturnType<typeof fileFact>, b: ReturnType<typeof fileFact>): boolean {
    return (
      a.dev === b.dev &&
      a.ino === b.ino &&
      a.size === b.size &&
      a.mtimeNs === b.mtimeNs &&
      a.ctimeNs === b.ctimeNs &&
      a.nlink === b.nlink
    );
  }
  function hash(path: string, maximum = Number.MAX_SAFE_INTEGER, allowHardlink = false): string {
    const before = fileFact(path, allowHardlink);
    need(before.size <= BigInt(maximum));
    const fd = openSync(path, 'r');
    const buffer = Buffer.alloc(65_536);
    const digest = createHash('sha256');
    try {
      need(same(before, fstatSync(fd, { bigint: true })));
      for (;;) {
        const length = readSync(fd, buffer);
        if (!length) break;
        digest.update(buffer.subarray(0, length));
      }
      need(same(before, fstatSync(fd, { bigint: true })));
    } finally {
      closeSync(fd);
    }
    need(same(before, fileFact(path, allowHardlink)));
    return digest.digest('hex');
  }
  function verifyParents(path: string): () => void {
    const entries: { path: string; dev: bigint; ino: bigint }[] = [];
    for (let current = resolve(path); ; current = dirname(current)) {
      const value = lstatSync(current, { bigint: true });
      need(
        value.isDirectory() &&
          !value.isSymbolicLink() &&
          realpathSync(current).toLowerCase() === current.toLowerCase(),
      );
      entries.push({ path: current, dev: value.dev, ino: value.ino });
      if (dirname(current) === current) break;
    }
    return () =>
      entries.forEach((entry) => {
        const value = lstatSync(entry.path, { bigint: true });
        need(
          value.isDirectory() &&
            !value.isSymbolicLink() &&
            value.dev === entry.dev &&
            value.ino === entry.ino,
        );
      });
  }

  const parentCheck = verifyParents(join(repository, 'log/stage7-e2'));
  need(hash(process.execPath, 134_217_728) === NODE_SHA256);
  for (const source of Object.values(SOURCE_SCOPES)) {
    const proof = join(repository, 'log/stage7-e2', source.scopeId, 'fixture-proof.json');
    need(hash(proof, 65_536) === source.proofSha256);
  }

  const scopeId = 'physical-full-transfer-' + randomUUID().replaceAll('-', '');
  requireScopeId(scopeId);
  const scope = join(repository, 'log/stage7-e2', scopeId);
  const app = join(scope, 'app');
  mkdirSync(scope);
  mkdirSync(app);
  mkdirSync(join(app, 'out'));
  mkdirSync(join(app, 'out/lifecycle-guardian'));

  const sources: Record<string, string> = {};
  function bind(path: string, bytes?: Uint8Array): string {
    const name = relative(repository, path).replaceAll('\\', '/');
    need(!name.startsWith('../') && !name.includes('/../') && !name.includes(':'));
    const sha256 = bytes
      ? createHash('sha256').update(bytes).digest('hex')
      : hash(path, 8 * 1024 ** 2);
    need(!sources[name] || sources[name] === sha256);
    sources[name] = sha256;
    return name;
  }

  for (const name of readdirSync(directory)) bind(join(directory, name));
  for (const name of [
    'package.json',
    'package-lock.json',
    'tools/data-qualification/full-transfer/FixedTransferJob.cs',
    'native/lifecycle-guardian/Guardian.cs',
  ])
    bind(join(repository, name));

  const freezePlugin: Plugin = {
    name: 'physical-full-transfer-freeze-sources',
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
  };

  const mappings: SourceMapping[] = [];
  const metafiles: Metafile[] = [];
  async function bundle(entry: EntryName, source: string, output: string): Promise<void> {
    const entryMappings: SourceMapping[] = [];
    const result = await build({
      absWorkingDir: repository,
      entryPoints: [join(repository, source)],
      outfile: join(scope, output),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['electron'],
      metafile: true,
      plugins: [mappingPlugin(entry, entryMappings), freezePlugin],
    });
    assertExactMappings(entry, entryMappings);
    const inputNames = Object.keys(result.metafile.inputs).map((name) =>
      relative(repository, resolve(repository, name)).replaceAll('\\', '/'),
    );
    rejectMixedOldInputs(inputNames);
    mappings.push(...entryMappings);
    metafiles.push(result.metafile);
  }

  await bundle('import', 'tools/data-qualification/full-transfer/import-entry.ts', 'import.cjs');
  await bundle('main', 'tools/data-qualification/full-transfer/main.ts', 'app/main.cjs');
  await bundle('worker', 'src/main/storage/transfer-worker.ts', 'app/transfer-worker.js');
  await bundle(
    'counts',
    'tools/data-qualification/full-transfer/counts-worker.ts',
    'app/counts-worker.js',
  );

  const expectedBundles = [
    {
      entry: 'tools/data-qualification/full-transfer/import-entry.ts',
      count: 10,
      sha256: '6637748fda39e6a259c579f1cec024618687f84ff6ecc6a7146f3b1610ca930c',
    },
    {
      entry: 'tools/data-qualification/full-transfer/main.ts',
      count: 23,
      sha256: '9bdbfb32eb4af69820331de90760f3d4dead8a2de5bd88dcaa34736f2ccb8304',
    },
    {
      entry: 'src/main/storage/transfer-worker.ts',
      count: 66,
      sha256: 'bcf33b853687be67d3bb7b31e6e62ba6b07539e664d2030e7dc4755be4509711',
    },
    {
      entry: 'tools/data-qualification/full-transfer/counts-worker.ts',
      count: 14,
      sha256: '1e54bc1c82f8e82364b499936a28848462f0e9564b9b18b9b9775976370566de',
    },
  ] as const;
  const bundleMembers = new Set<string>();
  for (const [index, metafile] of metafiles.entries()) {
    const names = Object.keys(metafile.inputs)
      .map((name) => relative(repository, resolve(repository, name)).replaceAll('\\', '/'))
      .sort();
    const canonical = names.join('|');
    need(
      names.length === expectedBundles[index].count &&
        new Set(names).size === names.length &&
        names.includes(expectedBundles[index].entry) &&
        createHash('sha256').update(canonical).digest('hex') === expectedBundles[index].sha256,
    );
    names.forEach((name) => bundleMembers.add(name));
  }
  const requiredExtraSources = [
    'native/lifecycle-guardian/Guardian.cs',
    'package-lock.json',
    'package.json',
    'tools/data-qualification/full-transfer/FixedTransferJob.cs',
    'tools/data-qualification/physical-full-transfer/allocation.cs',
    'tools/data-qualification/physical-full-transfer/build.ts',
    'tools/data-qualification/physical-full-transfer/contract.test.ts',
    'tools/data-qualification/physical-full-transfer/input.test.ts',
    'tools/data-qualification/physical-full-transfer/mapping.test.ts',
    'tools/data-qualification/physical-full-transfer/mapping.ts',
    'tools/data-qualification/physical-full-transfer/README.md',
    'tools/data-qualification/physical-full-transfer/run.ps1',
    'tools/data-qualification/physical-full-transfer/wrapper.test.ts',
  ] as const;
  const expectedSources = [...new Set([...bundleMembers, ...requiredExtraSources])].sort();
  need(Object.keys(sources).sort().join('|') === expectedSources.join('|'));

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
      join(repository, 'native/lifecycle-guardian/Guardian.cs'),
    ],
    { windowsHide: true, timeout: 10_000 },
  );
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
    JSON.stringify({
      name: 'aibrowse-physical-full-transfer-qualification',
      version,
      main: 'main.cjs',
    }),
    { flag: 'wx' },
  );
  copyFileSync(
    join(repository, 'tools/data-qualification/full-transfer/FixedTransferJob.cs'),
    join(scope, 'FixedTransferJob.cs'),
    1,
  );
  copyFileSync(join(directory, 'allocation.cs'), join(scope, 'allocation.cs'), 1);

  for (const [name, sha256] of Object.entries(sources))
    need(hash(join(repository, name)) === sha256);
  parentCheck();
  const artifactNames = [
    'import.cjs',
    'app/main.cjs',
    'app/transfer-worker.js',
    'app/counts-worker.js',
    'app/package.json',
    'app/lifecycle-guardian-integrity.json',
    'app/out/lifecycle-guardian/guardian.exe',
    'FixedTransferJob.cs',
    'allocation.cs',
  ] as const;
  const artifacts = Object.fromEntries(
    artifactNames.map((name) => [
      name,
      { bytes: Number(fileFact(join(scope, name)).size), sha256: hash(join(scope, name)) },
    ]),
  );
  need(
    Object.values(artifacts).reduce((sum, artifact) => sum + artifact.bytes, 0) <= 12 * 1024 ** 2,
  );

  const normalizedMappings = mappings
    .map((item) => ({
      entry: item.entry,
      importer: item.importer,
      request: item.request,
      target: relative(repository, item.target).replaceAll('\\', '/'),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  need(
    normalizedMappings.every((item) =>
      item.target.startsWith('tools/data-qualification/physical-full-transfer/'),
    ),
  );
  const electronPath = join(repository, 'node_modules/electron/dist/electron.exe');
  const proof = JSON.stringify({
    version: 1,
    scopeId,
    kind: 'physical-full-transfer-build-only',
    baseline: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    }).trim(),
    sourceScopes: SOURCE_SCOPES,
    mappings: normalizedMappings,
    bundleInputs: metafiles.map((metafile) =>
      Object.keys(metafile.inputs)
        .map((name) => relative(repository, resolve(repository, name)).replaceAll('\\', '/'))
        .sort(),
    ),
    sources,
    artifacts,
    node: { path: process.execPath, version: NODE_VERSION, sha256: NODE_SHA256 },
    electron: { path: electronPath, sha256: hash(electronPath, 268_435_456) },
    compilerSha256: hash(compiler, 32 * 1024 ** 2, true),
    productE2Pass: false,
    imported: false,
    electronQualified: false,
  });
  need(Buffer.byteLength(proof) <= 65_536);
  writeFileSync(join(scope, 'build-proof.json'), proof, { flag: 'wx' });
  process.stdout.write(
    JSON.stringify({
      scopeId,
      built: true,
      imported: false,
      electronQualified: false,
      productE2Pass: false,
    }) + '\n',
  );
}

void main().catch(() => {
  process.stderr.write('物理三库完整Transfer构建失败，现场保留\n');
  process.exitCode = 2;
});
