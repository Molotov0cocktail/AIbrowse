import { MSI_PRODUCT_IDENTITY } from '../build/msi-authoring.ts';
import { NSIS_TOOL, WIX_TOOL } from '../build/msi-build.ts';

const HASH = /^[a-f0-9]{64}$/u;
const OPTIONS = 'windowsapplication;x64;release;framework4;no-console';

export interface InstallerCompiler {
  readonly sources: readonly Readonly<{ path: string; sha256: string }>[];
  readonly tools: Readonly<{
    wix: Readonly<{ release: string; sha256: string; files: readonly InstallerArtifact[] }>;
    nsis: Readonly<{ release: string; sha256: string; executableSha256: string }>;
    guard: Readonly<{ compilerSha256: string; options: typeof OPTIONS }>;
  }>;
}

export interface InstallerArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface InstallerRecord extends InstallerCompiler {
  readonly schemaVersion: 1;
  readonly identity: Pick<
    typeof MSI_PRODUCT_IDENTITY,
    'appId' | 'name' | 'upgrade' | 'installLeaf'
  >;
  readonly version: string;
  readonly scopeId: string;
  readonly payload: Readonly<{ files: readonly InstallerArtifact[] }>;
  readonly artifacts: Readonly<{ msi: InstallerArtifact; exe: InstallerArtifact }>;
}

export function parseInstallerCompiler(value: unknown): InstallerCompiler {
  const input = record(value, ['sources', 'tools']);
  if (!Array.isArray(input.sources) || input.sources.length < 4 || input.sources.length > 64)
    fail('sources');
  const sources = input.sources.map((entry: unknown) => {
    const source = record(entry, ['path', 'sha256']);
    return Object.freeze({ path: path(source.path), sha256: hash(source.sha256) });
  });
  const names = sources.map((entry) => entry.path);
  if (new Set(names).size !== names.length) fail('duplicate-source');
  for (const name of [
    'tools/build/msi-authoring.ts',
    'tools/build/msi-build.ts',
    'tools/build/msi-guard.cs',
    'tools/build/msi-template.nsi',
  ])
    if (!names.includes(name)) fail('missing-source');
  const tools = record(input.tools, ['wix', 'nsis', 'guard']);
  const wix = record(tools.wix, ['release', 'sha256', 'files']);
  if (!Array.isArray(wix.files) || wix.files.length < 3 || wix.files.length > 512)
    fail('wix-files');
  const wixFiles = wix.files.map(artifact);
  const wixNames = wixFiles.map((entry) => entry.path);
  if (
    new Set(wixNames).size !== wixNames.length ||
    ['candle.exe', 'light.exe', 'wix.dll'].some((name) => !wixNames.includes(name))
  )
    fail('wix-files');
  const nsis = record(tools.nsis, ['release', 'sha256', 'executableSha256']);
  const guard = record(tools.guard, ['compilerSha256', 'options']);
  if (
    wix.release !== WIX_TOOL.release ||
    wix.sha256 !== WIX_TOOL.sha256 ||
    nsis.release !== NSIS_TOOL.release ||
    nsis.sha256 !== NSIS_TOOL.sha256 ||
    nsis.executableSha256 !== NSIS_TOOL.executableSha256 ||
    guard.options !== OPTIONS
  )
    fail('compiler');
  return Object.freeze({
    sources: Object.freeze(sources.sort((a, b) => a.path.localeCompare(b.path, 'en'))),
    tools: Object.freeze({
      wix: Object.freeze({
        release: WIX_TOOL.release,
        sha256: WIX_TOOL.sha256,
        files: Object.freeze(wixFiles.sort((a, b) => a.path.localeCompare(b.path, 'en'))),
      }),
      nsis: Object.freeze({
        release: NSIS_TOOL.release,
        sha256: NSIS_TOOL.sha256,
        executableSha256: NSIS_TOOL.executableSha256,
      }),
      guard: Object.freeze({ compilerSha256: hash(guard.compilerSha256), options: OPTIONS }),
    }),
  });
}

export function parseInstallerRecord(value: unknown): InstallerRecord {
  const input = record(value, [
    'schemaVersion',
    'identity',
    'version',
    'scopeId',
    'sources',
    'tools',
    'payload',
    'artifacts',
  ]);
  if (
    input.schemaVersion !== 1 ||
    typeof input.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/u.test(input.version) ||
    typeof input.scopeId !== 'string' ||
    !/^msi-build-[a-f0-9]{32}$/u.test(input.scopeId)
  )
    fail('record');
  const identity = record(input.identity, ['upgrade', 'name', 'installLeaf', 'appId']);
  const publicIdentity = {
    appId: MSI_PRODUCT_IDENTITY.appId,
    name: MSI_PRODUCT_IDENTITY.name,
    upgrade: MSI_PRODUCT_IDENTITY.upgrade,
    installLeaf: MSI_PRODUCT_IDENTITY.installLeaf,
  };
  for (const [key, expected] of Object.entries(publicIdentity))
    if (identity[key] !== expected) fail('identity');
  const payloadRecord = record(input.payload, ['files']);
  if (
    !Array.isArray(payloadRecord.files) ||
    payloadRecord.files.length < 3 ||
    payloadRecord.files.length > 4096
  )
    fail('payload');
  const payload = payloadRecord.files
    .map(artifact)
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (new Set(payload.map((entry) => entry.path)).size !== payload.length)
    fail('duplicate-payload');
  const artifacts = record(input.artifacts, ['msi', 'exe']);
  const msi = artifact(artifacts.msi);
  const exe = artifact(artifacts.exe);
  const stem = `AIbrowse-${input.version}-win-x64-internal`;
  if (msi.path !== `${stem}.msi` || exe.path !== `${stem}.exe`) fail('artifact-path');
  return Object.freeze({
    schemaVersion: 1,
    identity: Object.freeze(publicIdentity),
    version: input.version,
    scopeId: input.scopeId,
    ...parseInstallerCompiler({ sources: input.sources, tools: input.tools }),
    payload: Object.freeze({ files: Object.freeze(payload) }),
    artifacts: Object.freeze({ msi, exe }),
  });
}

function artifact(value: unknown): InstallerArtifact {
  const input = record(value, ['path', 'bytes', 'sha256']);
  if (
    typeof input.bytes !== 'number' ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 1 ||
    input.bytes > 1024 ** 3
  )
    fail('bytes');
  return Object.freeze({ path: path(input.path), bytes: input.bytes, sha256: hash(input.sha256) });
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).sort().join('\n') !== [...keys].sort().join('\n')
  )
    fail('keys');
  return value as Record<string, unknown>;
}

function path(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 240 ||
    value.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[\\:]/u.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    fail('path');
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) fail('hash');
  return value;
}

function fail(code: string): never {
  throw new Error(`安装构建来源无效：${code}`);
}
