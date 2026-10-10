import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type BuildProvenance, type FileDigest, parseBuildProvenance } from './build-provenance.ts';

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

export interface PayloadComparison {
  readonly schemaVersion: 1;
  readonly candidateEligible: boolean;
  readonly sourceEquivalent: boolean;
  readonly inputsEquivalent: boolean;
  readonly payloadEquivalent: boolean;
  readonly installerByteIdentical: boolean;
  readonly differences: Readonly<{
    source: readonly string[];
    inputs: readonly string[];
    payload: readonly string[];
    installer: readonly string[];
  }>;
  readonly limitation: '等价payload不表示NSIS安装器逐字节相同';
}

export function compareBuildProvenance(leftValue: unknown, rightValue: unknown): PayloadComparison {
  const left = parseBuildProvenance(leftValue);
  const right = parseBuildProvenance(rightValue);
  const source: string[] = [];
  const inputs: string[] = [];
  const payload: string[] = [];
  const installer: string[] = [];

  compareScalar(source, 'gitSha', left.source.gitSha, right.source.gitSha);
  compareScalar(source, 'dirty', left.source.dirty, right.source.dirty);
  compareScalar(source, 'version', left.source.version, right.source.version);
  compareScalar(
    inputs,
    'packageLockSha256',
    left.inputs.packageLockSha256,
    right.inputs.packageLockSha256,
  );
  compareDigestLists(
    inputs,
    'buildConfiguration',
    left.inputs.buildConfiguration,
    right.inputs.buildConfiguration,
  );
  compareScalar(
    inputs,
    'guardianCompiler',
    JSON.stringify(left.inputs.guardianCompiler),
    JSON.stringify(right.inputs.guardianCompiler),
  );
  compareScalar(
    inputs,
    'installerCompiler',
    JSON.stringify(left.inputs.installerCompiler),
    JSON.stringify(right.inputs.installerCompiler),
  );
  for (const key of Object.keys(left.inputs.toolchain) as (keyof typeof left.inputs.toolchain)[]) {
    compareScalar(
      inputs,
      `toolchain.${key}`,
      left.inputs.toolchain[key],
      right.inputs.toolchain[key],
    );
  }

  compareScalar(payload, 'asar.sha256', left.payload.asar.sha256, right.payload.asar.sha256);
  compareDigestLists(
    payload,
    'packageFiles',
    left.payload.packageFiles,
    right.payload.packageFiles,
  );
  compareScalar(
    payload,
    'asar.headerSha256',
    left.payload.asar.headerSha256,
    right.payload.asar.headerSha256,
  );
  compareDigestLists(payload, 'asar.files', left.payload.asar.files, right.payload.asar.files);
  compareDigest(payload, 'guardian', left.payload.guardian, right.payload.guardian);
  compareDigest(payload, 'executable', left.payload.executable, right.payload.executable);
  compareScalar(
    payload,
    'packageManifest.sha256',
    left.payload.packageManifest.sha256,
    right.payload.packageManifest.sha256,
  );
  compareStringLists(
    payload,
    'packageManifest.files',
    left.payload.packageManifest.files,
    right.payload.packageManifest.files,
  );
  compareStringLists(
    payload,
    'packageManifest.rendererAssets',
    left.payload.packageManifest.rendererAssets,
    right.payload.packageManifest.rendererAssets,
  );
  compareStringLists(
    payload,
    'packageManifest.externalPackages',
    left.payload.packageManifest.externalPackages,
    right.payload.packageManifest.externalPackages,
  );
  compareScalar(
    payload,
    'packageManifest.integrityResource',
    JSON.stringify(left.payload.packageManifest.integrityResource),
    JSON.stringify(right.payload.packageManifest.integrityResource),
  );
  compareScalar(
    payload,
    'packageManifest.fuseVersion',
    left.payload.packageManifest.fuseVersion,
    right.payload.packageManifest.fuseVersion,
  );

  compareDigest(installer, 'installer', left.installer, right.installer);
  compareDigest(installer, 'msi', left.msi, right.msi);
  const installerByteIdentical = installer.length === 0;
  compareDigest(installer, 'installerBuild', left.installerBuild, right.installerBuild);
  return Object.freeze({
    schemaVersion: 1,
    candidateEligible: left.candidateEligible && right.candidateEligible,
    sourceEquivalent: source.length === 0,
    inputsEquivalent: inputs.length === 0,
    payloadEquivalent: payload.length === 0,
    installerByteIdentical,
    differences: Object.freeze({
      source: Object.freeze(source),
      inputs: Object.freeze(inputs),
      payload: Object.freeze(payload),
      installer: Object.freeze(installer),
    }),
    limitation: '等价payload不表示NSIS安装器逐字节相同',
  });
}

function compareDigestLists(
  output: string[],
  prefix: string,
  left: readonly FileDigest[],
  right: readonly FileDigest[],
): void {
  const leftMap = new Map(left.map((entry) => [entry.path, entry]));
  const rightMap = new Map(right.map((entry) => [entry.path, entry]));
  for (const [path, expected] of leftMap) {
    const actual = rightMap.get(path);
    if (actual === undefined) output.push(`${prefix}.missing:${path}`);
    else if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
      output.push(`${prefix}.modified:${path}`);
  }
  for (const path of rightMap.keys()) {
    if (!leftMap.has(path)) output.push(`${prefix}.unknown:${path}`);
  }
}

function compareStringLists(
  output: string[],
  prefix: string,
  left: readonly string[],
  right: readonly string[],
): void {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  for (const path of left) if (!rightSet.has(path)) output.push(`${prefix}.missing:${path}`);
  for (const path of right) if (!leftSet.has(path)) output.push(`${prefix}.unknown:${path}`);
}

function compareDigest(
  output: string[],
  prefix: string,
  left: FileDigest,
  right: FileDigest,
): void {
  compareScalar(output, `${prefix}.path`, left.path, right.path);
  compareScalar(output, `${prefix}.bytes`, left.bytes, right.bytes);
  compareScalar(output, `${prefix}.sha256`, left.sha256, right.sha256);
}

function compareScalar(
  output: string[],
  label: string,
  left: string | number | boolean,
  right: string | number | boolean,
): void {
  if (left !== right) output.push(label);
}

function readManifest(path: string): BuildProvenance {
  const resolved = resolve(path);
  const stat = lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_MANIFEST_BYTES)
    throw new Error('来源清单文件无效');
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(resolved, 'utf8')) as unknown;
  } catch {
    throw new Error('来源清单不是有效JSON');
  }
  return parseBuildProvenance(value);
}

const main = (): void => {
  if (process.argv.length !== 4) {
    throw new Error('用法：compare-payloads.ts <基线清单.json> <候选清单.json>');
  }
  const result = compareBuildProvenance(
    readManifest(process.argv[2]!),
    readManifest(process.argv[3]!),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (
    !result.candidateEligible ||
    !result.sourceEquivalent ||
    !result.inputsEquivalent ||
    !result.payloadEquivalent ||
    !result.installerByteIdentical
  )
    process.exitCode = 1;
};

const invokedPath =
  process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
