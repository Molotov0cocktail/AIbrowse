import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractFile } from '@electron/asar';
import { collectMsiFiles } from '../build/msi-build.ts';
import {
  parseInstallerCompiler,
  parseInstallerRecord,
  type InstallerCompiler,
} from './installer-provenance.ts';
import {
  type IntegrityResource,
  type PackageVerification,
  verifyPackagedDirectory,
} from './package-policy.ts';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const MAX_ASAR_LOGICAL_BYTES = 32 * 1024 * 1024;
const PACKAGE_ROOT = resolve('release/win-unpacked');
const OUTPUT_PATH = resolve('release/build-provenance.json');
const BUILD_CONFIGURATION_PATHS = ['electron-builder.yml', 'electron.vite.config.ts'] as const;
const TOOLCHAIN_KEYS = [
  'node',
  'npm',
  'electron',
  'electronVite',
  'vite',
  'typescript',
  'electronBuilder',
] as const;

export interface FileDigest {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface GuardianCompiler {
  readonly schemaVersion: 1;
  readonly powerShell: string;
  readonly assemblies: readonly Readonly<{ name: string; sha256: string }>[];
  readonly references: readonly Readonly<{ name: string; sha256: string }>[];
  readonly sourceSha256: string;
  readonly buildScriptSha256: string;
  readonly options: 'windowsapplication;x64;release;csharp5;deterministic;no-pdb';
}

export interface BuildProvenance {
  readonly schemaVersion: 1;
  readonly candidateEligible: boolean;
  readonly source: Readonly<{ gitSha: string; dirty: boolean; version: string }>;
  readonly inputs: Readonly<{
    packageLockSha256: string;
    buildConfiguration: readonly FileDigest[];
    toolchain: Readonly<Record<(typeof TOOLCHAIN_KEYS)[number], string>>;
    guardianCompiler: GuardianCompiler;
    installerCompiler: InstallerCompiler;
  }>;
  readonly payload: Readonly<{
    packageFiles: readonly FileDigest[];
    asar: Readonly<{
      path: 'resources/app.asar';
      sha256: string;
      headerSha256: string;
      files: readonly FileDigest[];
    }>;
    guardian: FileDigest;
    executable: FileDigest;
    packageManifest: Readonly<{
      sha256: string;
      files: readonly string[];
      rendererAssets: readonly string[];
      externalPackages: readonly string[];
      integrityResource: IntegrityResource;
      fuseVersion: number;
    }>;
  }>;
  readonly installer: FileDigest;
  readonly msi: FileDigest;
  readonly installerBuild: FileDigest;
}

export interface BuildProvenanceInput {
  readonly gitSha: string;
  readonly dirty: boolean;
  readonly version: string;
  readonly packageLock: Buffer;
  readonly buildConfiguration: Readonly<Record<(typeof BUILD_CONFIGURATION_PATHS)[number], Buffer>>;
  readonly toolchain: Readonly<Record<(typeof TOOLCHAIN_KEYS)[number], string>>;
  readonly guardianCompiler: unknown;
  readonly installerCompiler: unknown;
  readonly verification: PackageVerification;
  readonly asarFiles: readonly FileDigest[];
  readonly packageFiles: readonly FileDigest[];
  readonly executableBytes: number;
  readonly guardianBytes: number;
  readonly installer: FileDigest;
  readonly msi: FileDigest;
  readonly installerBuild: FileDigest;
}

export function createBuildProvenance(input: BuildProvenanceInput): BuildProvenance {
  if (!GIT_SHA_PATTERN.test(input.gitSha) || !VERSION_PATTERN.test(input.version)) fail('source');
  const configuration = BUILD_CONFIGURATION_PATHS.map((path) =>
    digestBytes(path, input.buildConfiguration[path]),
  );
  const asarFiles = validateDigestList(input.asarFiles, false);
  const logicalBytes = asarFiles.reduce((sum, entry) => sum + entry.bytes, 0);
  if (logicalBytes > MAX_ASAR_LOGICAL_BYTES) fail('asar-budget');

  const verification = input.verification;
  const packageManifestValue = {
    files: sortedUnique(verification.files),
    rendererAssets: sortedUnique(verification.rendererAssets),
    externalPackages: sortedUnique(verification.externalPackages),
    integrityResource: {
      file: 'resources\\app.asar',
      alg: 'sha256' as const,
      value: checkedSha(verification.integrityResource.value),
    },
    fuseVersion: Number(verification.fuseVersion),
  };
  const packageManifest = Object.freeze({
    sha256: sha256(Buffer.from(stableJson(packageManifestValue))),
    ...packageManifestValue,
  });
  const toolchain = exactStringMap(input.toolchain, TOOLCHAIN_KEYS);
  const candidate: BuildProvenance = {
    schemaVersion: 1,
    candidateEligible: !input.dirty,
    source: Object.freeze({
      gitSha: input.gitSha,
      dirty: input.dirty,
      version: input.version,
    }),
    inputs: Object.freeze({
      packageLockSha256: sha256(input.packageLock),
      buildConfiguration: Object.freeze(configuration),
      toolchain: Object.freeze(toolchain),
      guardianCompiler: parseGuardianCompiler(input.guardianCompiler),
      installerCompiler: parseInstallerCompiler(input.installerCompiler),
    }),
    payload: Object.freeze({
      packageFiles: Object.freeze(
        [...input.packageFiles].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      ),
      asar: Object.freeze({
        path: 'resources/app.asar',
        sha256: checkedSha(verification.asarSha256),
        headerSha256: checkedSha(verification.asarHeaderSha256),
        files: Object.freeze(asarFiles),
      }),
      guardian: Object.freeze({
        path: 'resources/lifecycle-guardian/guardian.exe',
        bytes: checkedBytes(input.guardianBytes),
        sha256: checkedSha(verification.guardianSha256),
      }),
      executable: Object.freeze({
        path: 'AIbrowse.exe',
        bytes: checkedBytes(input.executableBytes),
        sha256: checkedSha(verification.executableSha256),
      }),
      packageManifest,
    }),
    installer: Object.freeze(validateDigest(input.installer)),
    msi: Object.freeze(validateDigest(input.msi)),
    installerBuild: Object.freeze(validateDigest(input.installerBuild)),
  };
  return deepFreeze(parseBuildProvenance(candidate));
}

export function parseBuildProvenance(value: unknown): BuildProvenance {
  const root = exactRecord(value, [
    'schemaVersion',
    'candidateEligible',
    'source',
    'inputs',
    'payload',
    'installer',
    'msi',
    'installerBuild',
  ]);
  if (root.schemaVersion !== 1 || typeof root.candidateEligible !== 'boolean') fail('schema');
  const source = exactRecord(root.source, ['gitSha', 'dirty', 'version']);
  if (
    typeof source.gitSha !== 'string' ||
    !GIT_SHA_PATTERN.test(source.gitSha) ||
    typeof source.dirty !== 'boolean' ||
    typeof source.version !== 'string' ||
    !VERSION_PATTERN.test(source.version) ||
    root.candidateEligible !== !source.dirty
  )
    fail('source');
  const inputs = exactRecord(root.inputs, [
    'packageLockSha256',
    'buildConfiguration',
    'toolchain',
    'guardianCompiler',
    'installerCompiler',
  ]);
  const buildConfiguration = validateDigestList(inputs.buildConfiguration, false);
  if (
    buildConfiguration.map((entry) => entry.path).join('\n') !==
    BUILD_CONFIGURATION_PATHS.join('\n')
  )
    fail('configuration');
  const toolchain = exactStringMap(inputs.toolchain, TOOLCHAIN_KEYS);

  const payload = exactRecord(root.payload, [
    'packageFiles',
    'asar',
    'guardian',
    'executable',
    'packageManifest',
  ]);
  const asar = exactRecord(payload.asar, ['path', 'sha256', 'headerSha256', 'files']);
  if (asar.path !== 'resources/app.asar') fail('asar-path');
  const asarFiles = validateDigestList(asar.files, false);
  if (asarFiles.reduce((sum, entry) => sum + entry.bytes, 0) > MAX_ASAR_LOGICAL_BYTES)
    fail('asar-budget');
  const guardian = validateDigest(payload.guardian);
  if (guardian.path !== 'resources/lifecycle-guardian/guardian.exe') fail('guardian-path');
  const executable = validateDigest(payload.executable);
  if (executable.path !== 'AIbrowse.exe') fail('executable-path');
  const packageFiles = validateDigestList(payload.packageFiles, false);
  if (
    packageFiles.length < 3 ||
    packageFiles.reduce((sum, entry) => sum + entry.bytes, 0) > 1024 ** 3
  )
    fail('package-budget');
  for (const required of [guardian, executable]) {
    const file = packageFiles.find((entry) => entry.path === required.path);
    if (file?.bytes !== required.bytes || file.sha256 !== required.sha256) fail('package-binding');
  }
  if (packageFiles.find((entry) => entry.path === 'resources/app.asar')?.sha256 !== asar.sha256)
    fail('package-binding');

  const manifest = exactRecord(payload.packageManifest, [
    'sha256',
    'files',
    'rendererAssets',
    'externalPackages',
    'integrityResource',
    'fuseVersion',
  ]);
  const files = stringList(manifest.files);
  const rendererAssets = stringList(manifest.rendererAssets);
  const externalPackages = stringList(manifest.externalPackages);
  const integrity = exactRecord(manifest.integrityResource, ['file', 'alg', 'value']);
  if (
    typeof integrity.file !== 'string' ||
    integrity.file !== 'resources\\app.asar' ||
    integrity.alg !== 'sha256' ||
    typeof integrity.value !== 'string' ||
    !SHA256_PATTERN.test(integrity.value) ||
    !Number.isSafeInteger(manifest.fuseVersion) ||
    Number(manifest.fuseVersion) < 1
  )
    fail('package-manifest');
  const manifestValue = {
    files,
    rendererAssets,
    externalPackages,
    integrityResource: {
      file: integrity.file,
      alg: 'sha256' as const,
      value: integrity.value,
    },
    fuseVersion: Number(manifest.fuseVersion),
  };
  if (files.join('\n') !== asarFiles.map((entry) => entry.path).join('\n')) fail('package-files');
  if (integrity.value !== checkedSha(asar.headerSha256)) fail('integrity-header');
  if (
    typeof manifest.sha256 !== 'string' ||
    checkedSha(manifest.sha256) !== sha256(Buffer.from(stableJson(manifestValue)))
  )
    fail('package-manifest-hash');

  const parsed: BuildProvenance = {
    schemaVersion: 1,
    candidateEligible: root.candidateEligible,
    source: {
      gitSha: source.gitSha,
      dirty: source.dirty,
      version: source.version,
    },
    inputs: {
      packageLockSha256: checkedSha(inputs.packageLockSha256),
      buildConfiguration,
      toolchain,
      guardianCompiler: parseGuardianCompiler(inputs.guardianCompiler),
      installerCompiler: parseInstallerCompiler(inputs.installerCompiler),
    },
    payload: {
      packageFiles,
      asar: {
        path: 'resources/app.asar',
        sha256: checkedSha(asar.sha256),
        headerSha256: checkedSha(asar.headerSha256),
        files: asarFiles,
      },
      guardian,
      executable,
      packageManifest: { sha256: manifest.sha256, ...manifestValue },
    },
    installer: validateDigest(root.installer),
    msi: validateDigest(root.msi),
    installerBuild: validateDigest(root.installerBuild),
  };
  if (parsed.installer.path !== `AIbrowse-${parsed.source.version}-win-x64-internal.exe`)
    fail('installer-path');
  if (parsed.msi.path !== `AIbrowse-${parsed.source.version}-win-x64-internal.msi`)
    fail('msi-path');
  if (parsed.installerBuild.path !== 'installer-build.json') fail('installer-build-path');
  return parsed;
}

const main = async (): Promise<void> => {
  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
    version?: unknown;
    devDependencies?: Record<string, unknown>;
  };
  if (typeof packageJson.version !== 'string' || !VERSION_PATTERN.test(packageJson.version))
    fail('package-version');
  const installerPath = resolve(`release/AIbrowse-${packageJson.version}-win-x64-internal.exe`);
  const verification = await verifyPackagedDirectory(PACKAGE_ROOT);
  const asarPath = resolve(PACKAGE_ROOT, verification.asar);
  const asarFiles = verification.files.map((path) =>
    digestBytes(path, extractFile(asarPath, path.split('/').join(sep))),
  );
  const dependencies = packageJson.devDependencies ?? {};
  const dependency = (name: string): string => {
    const value = dependencies[name];
    if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) fail(`toolchain-${name}`);
    return value;
  };
  const gitSha = execText('git', ['rev-parse', 'HEAD']);
  const dirty = execText('git', ['status', '--porcelain=v1', '--untracked-files=all']) !== '';
  const installerStat = statSync(installerPath, { throwIfNoEntry: false });
  if (!installerStat?.isFile()) fail('installer-missing');
  const installerBuildPath = resolve('release/installer-build.json');
  if (statSync(installerBuildPath).size > 4 * 1024 * 1024) fail('installer-build-budget');
  const installerBuildBytes = readFileSync(installerBuildPath);
  const installerBuild = parseInstallerRecord(JSON.parse(installerBuildBytes.toString('utf8')));
  if (installerBuild.version !== packageJson.version) fail('installer-build-version');
  if (
    JSON.stringify(installerBuild.payload.files) !== JSON.stringify(collectMsiFiles(PACKAGE_ROOT))
  )
    fail('installer-build-payload');
  for (const source of installerBuild.sources)
    if (source.sha256 !== sha256(readFileSync(resolve(source.path))))
      fail('installer-build-source');
  const msiPath = resolve('release', installerBuild.artifacts.msi.path);
  for (const artifact of Object.values(installerBuild.artifacts)) {
    const actual = readFileSync(resolve('release', artifact.path));
    if (actual.length !== artifact.bytes || sha256(actual) !== artifact.sha256)
      fail('installer-build-artifact');
  }
  if (
    installerBuild.tools.guard.compilerSha256 !==
    sha256(
      readFileSync(
        resolve(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      ),
    )
  )
    fail('installer-compiler-source');
  const compilerPath = resolve('out/lifecycle-guardian/compiler.json');
  if (statSync(compilerPath).size > 8192) fail('guardian-compiler');
  const guardianCompiler = parseGuardianCompiler(JSON.parse(readFileSync(compilerPath, 'utf8')));
  if (
    guardianCompiler.sourceSha256 !==
      sha256(readFileSync(resolve('native/lifecycle-guardian/Guardian.cs'))) ||
    guardianCompiler.buildScriptSha256 !== sha256(readFileSync(resolve('tools/build/guardian.ps1')))
  )
    fail('guardian-compiler-source');
  const candidate = createBuildProvenance({
    gitSha,
    dirty,
    version: packageJson.version,
    packageLock: readFileSync(resolve('package-lock.json')),
    buildConfiguration: {
      'electron-builder.yml': readFileSync(resolve('electron-builder.yml')),
      'electron.vite.config.ts': readFileSync(resolve('electron.vite.config.ts')),
    },
    toolchain: {
      node: process.versions.node,
      npm: execText(process.execPath, [
        resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
        '--version',
      ]),
      electron: dependency('electron'),
      electronVite: dependency('electron-vite'),
      vite: dependency('vite'),
      typescript: dependency('typescript'),
      electronBuilder: dependency('electron-builder'),
    },
    guardianCompiler,
    installerCompiler: { sources: installerBuild.sources, tools: installerBuild.tools },
    verification,
    asarFiles,
    packageFiles: installerBuild.payload.files,
    executableBytes: statSync(resolve(PACKAGE_ROOT, verification.executable)).size,
    guardianBytes: statSync(resolve(PACKAGE_ROOT, 'resources/lifecycle-guardian/guardian.exe'))
      .size,
    installer: digestBytes(basename(installerPath), readFileSync(installerPath)),
    msi: digestBytes(basename(msiPath), readFileSync(msiPath)),
    installerBuild: digestBytes('installer-build.json', installerBuildBytes),
  });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(candidate, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  process.stdout.write(`${relative(resolve('.'), OUTPUT_PATH)}\n`);
};

function digestBytes(path: string, bytes: Buffer): FileDigest {
  return { path: normalizedPath(path), bytes: bytes.length, sha256: sha256(bytes) };
}

export function parseGuardianCompiler(value: unknown): GuardianCompiler {
  const record = exactRecord(value, [
    'schemaVersion',
    'powerShell',
    'assemblies',
    'references',
    'sourceSha256',
    'buildScriptSha256',
    'options',
  ]);
  if (
    record.schemaVersion !== 1 ||
    typeof record.powerShell !== 'string' ||
    !VERSION_PATTERN.test(record.powerShell) ||
    record.options !== 'windowsapplication;x64;release;csharp5;deterministic;no-pdb'
  )
    fail('guardian-compiler');
  const namedDigests = (
    input: unknown,
    names: readonly string[],
  ): GuardianCompiler['assemblies'] => {
    if (!Array.isArray(input) || input.length !== names.length) fail('guardian-compiler');
    return Object.freeze(
      input.map((entry, index) => {
        const digest = exactRecord(entry, ['name', 'sha256']);
        if (digest.name !== names[index]) fail('guardian-compiler');
        return Object.freeze({ name: names[index]!, sha256: checkedSha(digest.sha256) });
      }),
    );
  };
  return Object.freeze({
    schemaVersion: 1,
    powerShell: record.powerShell,
    assemblies: namedDigests(record.assemblies, [
      'Microsoft.CodeAnalysis.dll',
      'Microsoft.CodeAnalysis.CSharp.dll',
    ]),
    references: namedDigests(record.references, ['mscorlib.dll', 'System.dll', 'System.Core.dll']),
    sourceSha256: checkedSha(record.sourceSha256),
    buildScriptSha256: checkedSha(record.buildScriptSha256),
    options: record.options,
  });
}

function validateDigest(value: unknown): FileDigest {
  const record = exactRecord(value, ['path', 'bytes', 'sha256']);
  if (typeof record.path !== 'string' || typeof record.sha256 !== 'string') fail('digest');
  return {
    path: normalizedPath(record.path),
    bytes: checkedBytes(record.bytes),
    sha256: checkedSha(record.sha256),
  };
}

function validateDigestList(value: unknown, allowEmpty: boolean): FileDigest[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 4096)
    fail('digest-list');
  const result = value.map(validateDigest);
  const paths = result.map((entry) => entry.path);
  if (paths.join('\n') !== [...paths].sort().join('\n') || new Set(paths).size !== paths.length)
    fail('digest-order');
  return result;
}

function normalizedPath(value: string): string {
  if (
    value.length === 0 ||
    value.length > 256 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    fail('path');
  return value;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 4096) fail('string-list');
  const items = value.map((item) => {
    if (typeof item !== 'string') fail('string-list-item');
    return normalizedPath(item);
  });
  if (items.join('\n') !== [...items].sort().join('\n') || new Set(items).size !== items.length)
    fail('string-list-order');
  return items;
}

function sortedUnique(values: readonly string[]): string[] {
  const result = [...new Set(values.map(normalizedPath))].sort();
  if (result.length !== values.length) fail('duplicate-list');
  return result;
}

function exactStringMap<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Record<Keys[number], string> {
  const record = exactRecord(value, keys);
  const result = Object.create(null) as Record<Keys[number], string>;
  for (const key of keys) {
    const item = record[key as Keys[number]];
    if (typeof item !== 'string' || !VERSION_PATTERN.test(item)) fail('toolchain');
    result[key as Keys[number]] = item;
  }
  return result;
}

function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Record<Keys[number], unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('prototype');
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== 'string') ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail('keys');
  const result = Object.create(null) as Record<Keys[number], unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor))
      fail('descriptor');
    result[key as Keys[number]] = descriptor.value;
  }
  return result;
}

function checkedSha(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) fail('sha256');
  return value;
}

function checkedBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail('bytes');
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function execText(command: string, args: readonly string[]): string {
  return execFileSync(command, args, {
    cwd: resolve('.'),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  }).trim();
}

function deepFreeze<T extends BuildProvenance>(value: T): T {
  Object.freeze(value.source);
  Object.freeze(value.inputs.buildConfiguration);
  for (const entry of value.inputs.buildConfiguration) Object.freeze(entry);
  Object.freeze(value.inputs.toolchain);
  Object.freeze(value.inputs);
  Object.freeze(value.payload.asar.files);
  Object.freeze(value.payload.packageFiles);
  for (const entry of value.payload.packageFiles) Object.freeze(entry);
  for (const entry of value.payload.asar.files) Object.freeze(entry);
  Object.freeze(value.payload.asar);
  Object.freeze(value.payload.guardian);
  Object.freeze(value.payload.executable);
  Object.freeze(value.payload.packageManifest.files);
  Object.freeze(value.payload.packageManifest.rendererAssets);
  Object.freeze(value.payload.packageManifest.externalPackages);
  Object.freeze(value.payload.packageManifest.integrityResource);
  Object.freeze(value.payload.packageManifest);
  Object.freeze(value.payload);
  Object.freeze(value.installer);
  Object.freeze(value.msi);
  Object.freeze(value.installerBuild);
  return Object.freeze(value);
}

function fail(code: string): never {
  throw new Error(`构建来源清单无效：${code}`);
}

const invokedPath =
  process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '未知错误';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
