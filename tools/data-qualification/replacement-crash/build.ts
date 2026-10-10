import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, version as esbuildVersion, type Plugin } from 'esbuild';
import {
  bindRegularFile,
  controlledRelativePath,
  readBoundedRegularFile,
  verifyBinding,
  type FileBinding,
} from './binding.ts';
import { instrumentDatasetActive } from './instrumentation.ts';

export interface WorkerBuild {
  readonly artifact: FileBinding;
  readonly sources: readonly FileBinding[];
  readonly nodeExecutable: FileBinding;
  readonly nodeVersion: string;
  readonly esbuildVersion: string;
}

async function buildQualification(
  repoRoot: string,
  outputRoot: string,
  kind: 'worker' | 'runner',
): Promise<WorkerBuild> {
  const repository = resolve(repoRoot);
  const output = resolve(outputRoot);
  const activePath = resolve(repository, 'src/main/storage/dataset-active.ts');
  const entry = resolve(
    repository,
    `tools/data-qualification/replacement-crash/${kind === 'worker' ? 'worker' : 'run'}.ts`,
  );
  const artifactPath = join(
    output,
    `replacement-crash-${kind}.${kind === 'worker' ? 'cjs' : 'mjs'}`,
  );
  await mkdir(output, { recursive: false });
  const sourceBindings = new Map<string, FileBinding>();
  const buildControlPaths = ['build-runner.ts', 'build.ts', 'binding.ts', 'instrumentation.ts'].map(
    (name) => resolve(repository, 'tools/data-qualification/replacement-crash', name),
  );
  for (const path of buildControlPaths)
    sourceBindings.set(path, await bindRegularFile(path, 8 * 1024 ** 2));
  const plugin: Plugin = {
    name: 'closed-replacement-crash-source-loader',
    setup(buildApi) {
      buildApi.onLoad({ filter: /\.(?:ts|js|mjs|cjs)$/ }, async (args) => {
        const path = resolve(args.path);
        controlledRelativePath(repository, path);
        const loaded = await readBoundedRegularFile(path, 8 * 1024 ** 2);
        const previous = sourceBindings.get(path);
        if (previous && JSON.stringify(previous) !== JSON.stringify(loaded.binding))
          throw new Error('构建输入重复读取时改变');
        sourceBindings.set(path, loaded.binding);
        const source = loaded.bytes.toString('utf8');
        if (path !== activePath || kind !== 'worker') return { contents: source, loader: 'ts' };
        const transformed = instrumentDatasetActive(source);
        if (transformed.originalSha256 !== loaded.binding.sha256 || transformed.strip() !== source)
          throw new Error('dataset-active插桩未与绑定原文闭合');
        return { contents: transformed.instrumented, loader: 'ts' };
      });
    },
  };
  const result = await build({
    absWorkingDir: repository,
    entryPoints: [entry],
    outfile: artifactPath,
    bundle: true,
    platform: 'node',
    format: kind === 'worker' ? 'cjs' : 'esm',
    external: ['esbuild'],
    target: 'node24',
    logLevel: 'silent',
    metafile: true,
    plugins: [plugin],
  });
  const paths = [
    ...new Set([
      ...Object.keys(result.metafile.inputs).map((path) => resolve(repository, path)),
      ...buildControlPaths,
    ]),
  ].sort();
  if (!paths.includes(activePath) || !paths.includes(entry) || new Set(paths).size !== paths.length)
    throw new Error('worker源码清单不闭合');
  if (sourceBindings.size !== paths.length || paths.some((path) => !sourceBindings.has(path)))
    throw new Error('esbuild输入没有全部经过构建前绑定读取');
  const sources = paths.map((path) => sourceBindings.get(path)!);
  for (const source of sources) await verifyBinding(source, 8 * 1024 ** 2);
  const artifact = await bindRegularFile(artifactPath, 16 * 1024 ** 2);
  const nodeExecutable = await bindRegularFile(process.execPath, 256 * 1024 ** 2);
  const manifest: WorkerBuild = {
    artifact,
    sources,
    nodeExecutable,
    nodeVersion: process.version,
    esbuildVersion,
  };
  await writeFile(join(output, 'build-binding.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export function buildWorker(repoRoot: string, outputRoot: string): Promise<WorkerBuild> {
  return buildQualification(repoRoot, outputRoot, 'worker');
}

export function buildRunner(repoRoot: string, outputRoot: string): Promise<WorkerBuild> {
  return buildQualification(repoRoot, outputRoot, 'runner');
}

export async function verifyWorkerBuild(build: WorkerBuild): Promise<void> {
  await verifyBinding(build.artifact, 16 * 1024 ** 2);
  await verifyBinding(build.nodeExecutable, 256 * 1024 ** 2);
  for (const source of build.sources) await verifyBinding(source, 8 * 1024 ** 2);
}
