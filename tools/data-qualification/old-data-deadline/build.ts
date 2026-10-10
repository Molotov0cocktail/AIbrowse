import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { build, version as esbuildVersion, type Metafile, type Plugin } from 'esbuild';
import {
  bindDirectory,
  bindRegularFile,
  controlledRelativePath,
  readBoundedRegularFile,
  verifyBinding,
  type DirectoryBinding,
  type FileBinding,
} from '../replacement-crash/binding.ts';
import { FIXED_JOB_SHA256, NODE_SHA256, NODE_VERSION, need, requireScopeId } from './contract.ts';

export interface BuildProof {
  readonly version: 1;
  readonly kind: 'old-data-deadline-build';
  readonly baseline: string;
  readonly scopeId: string;
  readonly repository: DirectoryBinding;
  readonly output: DirectoryBinding;
  readonly sources: readonly FileBinding[];
  readonly runner: FileBinding;
  readonly worker: FileBinding;
  readonly runtimeProof: FileBinding;
  readonly node: FileBinding;
  readonly nodeVersion: typeof NODE_VERSION;
  readonly esbuildVersion: string;
  readonly fixedJobSha256: typeof FIXED_JOB_SHA256;
  readonly productE2Pass: false;
}

async function buildEntry(
  repository: string,
  output: string,
  entry: 'runner' | 'worker',
  plugin: Plugin,
): Promise<Metafile> {
  const result = await build({
    absWorkingDir: repository,
    entryPoints: [join(repository, 'tools/data-qualification/old-data-deadline', `${entry}.ts`)],
    outfile: join(output, `${entry}.cjs`),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    logLevel: 'silent',
    metafile: true,
    plugins: [plugin],
  });
  return result.metafile;
}

export async function buildQualification(
  repositoryRoot: string,
  outputRoot: string,
  baseline: string,
  scopeId: string,
): Promise<BuildProof> {
  const repository = resolve(repositoryRoot);
  const output = resolve(outputRoot);
  need(/^[a-f0-9]{40}$/u.test(baseline));
  requireScopeId(scopeId);
  need(output.endsWith(scopeId));
  await mkdir(output);
  const sourceBindings = new Map<string, FileBinding>();
  const plugin: Plugin = {
    name: 'old-data-deadline-closed-source-loader',
    setup(api) {
      api.onLoad({ filter: /\.(?:ts|[cm]?js|json)$/ }, async (args) => {
        const path = resolve(args.path);
        controlledRelativePath(repository, path);
        const loaded = await readBoundedRegularFile(path, 8 * 1024 ** 2);
        const previous = sourceBindings.get(path);
        if (previous) need(JSON.stringify(previous) === JSON.stringify(loaded.binding));
        sourceBindings.set(path, loaded.binding);
        const extension = extname(path);
        return {
          contents: loaded.bytes,
          loader: extension === '.ts' ? 'ts' : extension === '.json' ? 'json' : 'js',
        };
      });
    },
  };
  const workerMeta = await buildEntry(repository, output, 'worker', plugin);
  const runnerMeta = await buildEntry(repository, output, 'runner', plugin);
  const toolRoot = join(repository, 'tools/data-qualification/old-data-deadline');
  const controls = (await readdir(toolRoot))
    .filter((name) => name !== 'build-proof.json' && name !== 'runtime-proof.json')
    .map((name) => join(toolRoot, name));
  controls.push(
    join(repository, 'tools/data-qualification/replacement-crash/binding.ts'),
    join(repository, 'tools/data-qualification/full-transfer/FixedTransferJob.cs'),
    join(repository, 'package.json'),
    join(repository, 'package-lock.json'),
  );
  for (const path of controls) {
    const binding = await bindRegularFile(path, 8 * 1024 ** 2);
    const previous = sourceBindings.get(resolve(path));
    if (previous) need(JSON.stringify(previous) === JSON.stringify(binding));
    sourceBindings.set(resolve(path), binding);
  }
  const metaInputs = new Set(
    [...Object.keys(workerMeta.inputs), ...Object.keys(runnerMeta.inputs)].map((path) =>
      resolve(repository, path),
    ),
  );
  for (const path of metaInputs) need(sourceBindings.has(path), 'esbuild输入未全部绑定');
  const sources = [...sourceBindings.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const source of sources) await verifyBinding(source, 8 * 1024 ** 2);
  const node = await bindRegularFile(process.execPath, 256 * 1024 ** 2);
  need(process.version === NODE_VERSION && node.sha256 === NODE_SHA256);
  const runtimePayload = Buffer.from(
    JSON.stringify({
      version: 1,
      node,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
  );
  need(runtimePayload.length <= 4096);
  const runtimePath = join(output, 'runtime-proof.json');
  await writeFile(runtimePath, runtimePayload, { flag: 'wx' });
  const proof: BuildProof = {
    version: 1,
    kind: 'old-data-deadline-build',
    baseline,
    scopeId,
    repository: await bindDirectory(repository),
    output: await bindDirectory(output),
    sources,
    runner: await bindRegularFile(join(output, 'runner.cjs'), 8 * 1024 ** 2),
    worker: await bindRegularFile(join(output, 'worker.cjs'), 8 * 1024 ** 2),
    runtimeProof: await bindRegularFile(runtimePath, 4096),
    node,
    nodeVersion: NODE_VERSION,
    esbuildVersion,
    fixedJobSha256: FIXED_JOB_SHA256,
    productE2Pass: false,
  };
  need(proof.sources.some((source) => source.sha256 === FIXED_JOB_SHA256));
  const bytes = Buffer.from(JSON.stringify(proof, null, 2));
  need(bytes.length <= 256 * 1024);
  await writeFile(join(output, 'build-proof.json'), bytes, { flag: 'wx' });
  return proof;
}
