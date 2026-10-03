import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

import { extractFile, getRawHeader, listPackage, statFile } from '@electron/asar';
import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from '@electron/fuses';
import { NtExecutable, NtExecutableResource } from 'resedit';

export const PACKAGED_EXECUTABLE = 'AIbrowse.exe';

const REQUIRED_FILES = [
  'package.json',
  'out/release/main/index.js',
  'out/release/preload/index.js',
  'out/release/renderer/index.html',
  'out/release/renderer/asset-manifest.json',
] as const;

const ALLOWED_NODE_MODULE_ROOTS = [
  'node_modules/@federicocarboni/saxe/',
  'node_modules/entities/',
  'node_modules/parse5/',
  'node_modules/parse5-sax-parser/',
] as const;

const REQUIRED_FUSES = new Map<FuseV1Options, FuseState>([
  [FuseV1Options.RunAsNode, FuseState.DISABLE],
  [FuseV1Options.EnableCookieEncryption, FuseState.DISABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
  [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
]);

export interface IntegrityResource {
  file: string;
  alg: 'sha256';
  value: string;
}

export interface PackageVerification {
  packageRoot: string;
  executable: string;
  executableSha256: string;
  asar: string;
  asarSha256: string;
  asarHeaderSha256: string;
  integrityResource: IntegrityResource;
  fuseVersion: FuseVersion;
  files: string[];
  rendererAssets: string[];
  externalPackages: string[];
}

const fail = (message: string): never => {
  throw new Error(message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const normalizeArchivePath = (value: string): string =>
  value.replaceAll('\\', '/').replace(/^\/+/, '');

export const isAllowedArchivePath = (archivePath: string): boolean => {
  const path = normalizeArchivePath(archivePath);
  if (path === 'package.json') return true;
  if (path === 'out/release/main/index.js') return true;
  if (/^out\/release\/main\/[a-z0-9][a-z0-9_-]*\.js$/i.test(path)) return true;
  if (path === 'out/release/preload/index.js') return true;
  if (path === 'out/release/renderer/index.html') return true;
  if (path === 'out/release/renderer/asset-manifest.json') return true;
  if (/^out\/release\/renderer\/assets\/[a-z0-9][a-z0-9._-]*$/i.test(path)) return true;
  return ALLOWED_NODE_MODULE_ROOTS.some((root) => path.startsWith(root));
};

export const findForbiddenArchivePaths = (archivePaths: readonly string[]): string[] => {
  const forbidden: string[] = [];
  for (const rawPath of archivePaths) {
    const path = normalizeArchivePath(rawPath);
    const lower = path.toLowerCase();
    if (!isAllowedArchivePath(path)) {
      forbidden.push(path);
      continue;
    }
    if (
      /(^|\/)(smoke|qualification|native|test|tests|__tests__)([._/-]|$)/i.test(path) ||
      /\.(?:ts|tsx|map|node|pdb|db|sqlite|log|env|pem|key)$/i.test(path) ||
      lower === 'out/release/main/release-modules.json'
    ) {
      forbidden.push(path);
    }
  }
  return [...new Set(forbidden)].sort();
};

const sha256File = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

export const readIntegrityResource = (executablePath: string): IntegrityResource => {
  const executable = NtExecutable.from(readFileSync(executablePath));
  const resources = NtExecutableResource.from(executable);
  const matches = resources.entries.filter(
    (entry) =>
      String(entry.type).toUpperCase() === 'INTEGRITY' &&
      String(entry.id).toUpperCase() === 'ELECTRONASAR',
  );
  if (matches.length !== 1) {
    fail(`EXE 必须恰好包含一条 INTEGRITY/ELECTRONASAR 资源，实际 ${matches.length} 条`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(matches[0].bin).toString('utf8'));
  } catch {
    fail('INTEGRITY/ELECTRONASAR 资源不是有效 UTF-8 JSON');
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error('INTEGRITY/ELECTRONASAR 资源必须是单成员数组');
  }
  const item = parsed[0];
  if (
    typeof item.file !== 'string' ||
    typeof item.alg !== 'string' ||
    item.alg.toLowerCase() !== 'sha256' ||
    typeof item.value !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(item.value)
  ) {
    throw new Error('INTEGRITY/ELECTRONASAR 资源字段无效');
  }
  if (item.file.replaceAll('/', '\\').toLowerCase() !== 'resources\\app.asar') {
    fail('INTEGRITY/ELECTRONASAR 未绑定 resources\\app.asar');
  }
  return { file: item.file, alg: 'sha256', value: item.value.toLowerCase() };
};

const verifyFuses = async (executablePath: string): Promise<FuseVersion> => {
  const fuses = await getCurrentFuseWire(executablePath);
  if (fuses.version !== FuseVersion.V1) fail(`不支持的 fuse 版本：${String(fuses.version)}`);
  for (const [option, expected] of REQUIRED_FUSES) {
    if (fuses[option] !== expected) {
      fail(`fuse ${FuseV1Options[option]} 状态错误：期望 ${expected}，实际 ${String(fuses[option])}`);
    }
  }
  return fuses.version;
};

const readJsonFromAsar = (asarPath: string, archivePath: string): unknown => {
  try {
    return JSON.parse(extractFile(asarPath, archivePath.split('/').join(sep)).toString('utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : '未知错误';
    fail(`${archivePath} 不是有效 JSON：${detail}`);
  }
};

const verifyPackageMetadata = (asarPath: string): void => {
  const metadata = readJsonFromAsar(asarPath, 'package.json');
  if (!isRecord(metadata)) throw new Error('包内 package.json 必须是对象');
  if (metadata.name !== 'aibrowse') fail('包内 name 必须保持 aibrowse');
  if (metadata.main !== 'out/release/main/index.js') fail('包内 main 未指向 release 入口');
  for (const forbidden of ['scripts', 'devDependencies', 'build']) {
    if (forbidden in metadata) fail(`包内 package.json 不得包含 ${forbidden}`);
  }
};

const verifyRendererManifest = (asarPath: string, archiveFiles: ReadonlySet<string>): string[] => {
  const manifest = readJsonFromAsar(asarPath, 'out/release/renderer/asset-manifest.json');
  if (!isRecord(manifest) || manifest.version !== 1 || !isRecord(manifest.assets)) {
    throw new Error('renderer asset-manifest.json 形状无效');
  }
  const resolvedAssets: string[] = [];
  for (const [urlPath, rawEntry] of Object.entries(manifest.assets)) {
    if (!urlPath.startsWith('/') || !isRecord(rawEntry)) {
      throw new Error('renderer manifest 资产项无效');
    }
    if (typeof rawEntry.file !== 'string' || typeof rawEntry.contentType !== 'string') {
      throw new Error(`renderer manifest 资产字段无效：${urlPath}`);
    }
    const archivePath = normalizeArchivePath(`out/release/renderer/${rawEntry.file}`);
    if (!archiveFiles.has(archivePath)) fail(`renderer manifest 指向包外文件：${urlPath}`);
    resolvedAssets.push(archivePath);
  }
  for (const required of [
    'out/release/renderer/index.html',
    'out/release/renderer/asset-manifest.json',
  ]) {
    if (!archiveFiles.has(required)) fail(`包内缺少 renderer 固定资产：${required}`);
  }
  return [...new Set(resolvedAssets)].sort();
};

const listFilesRecursively = (root: string): string[] => {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`打包目录不得包含符号链接：${relative(root, path)}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
      else fail(`打包目录包含未知文件类型：${relative(root, path)}`);
    }
  };
  visit(root);
  return files.sort();
};

export const verifyPackagedDirectory = async (inputRoot: string): Promise<PackageVerification> => {
  const packageRoot = resolve(inputRoot);
  if (!statSync(packageRoot, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`打包目录不存在：${packageRoot}`);
  }
  const executable = join(packageRoot, PACKAGED_EXECUTABLE);
  const asar = join(packageRoot, 'resources', 'app.asar');
  if (!statSync(executable, { throwIfNoEntry: false })?.isFile()) fail('缺少最终 AIbrowse.exe');
  if (!statSync(asar, { throwIfNoEntry: false })?.isFile()) fail('缺少最终 resources/app.asar');

  const outerFiles = listFilesRecursively(packageRoot);
  if (outerFiles.some((path) => path.startsWith('resources/app/') || path.startsWith('resources/app.asar.unpacked/'))) {
    fail('打包目录不得包含裸 app 或 app.asar.unpacked');
  }

  const archiveEntries = listPackage(asar, { isPack: false }).sort();
  const files: string[] = [];
  for (const rawPath of archiveEntries) {
    const path = normalizeArchivePath(rawPath);
    const info = statFile(asar, rawPath.replace(/^[\\/]+/, ''), false);
    if ('link' in info) fail(`ASAR 不得包含符号链接：${path}`);
    if ('files' in info) continue;
    if (info.unpacked) fail(`ASAR 文件不得解包：${path}`);
    files.push(path);
  }
  const fileSet = new Set(files);
  const forbidden = findForbiddenArchivePaths(files);
  if (forbidden.length > 0) fail(`ASAR 含禁区文件：${forbidden.join(', ')}`);
  for (const required of REQUIRED_FILES) {
    if (!fileSet.has(required)) fail(`ASAR 缺少必需文件：${required}`);
  }
  verifyPackageMetadata(asar);
  const rendererAssets = verifyRendererManifest(asar, fileSet);

  const headerHash = createHash('sha256').update(getRawHeader(asar).headerString).digest('hex');
  const integrityResource = readIntegrityResource(executable);
  if (integrityResource.value !== headerHash) {
    fail('EXE ElectronAsar 资源与最终 ASAR header hash 不匹配');
  }
  const fuseVersion = await verifyFuses(executable);

  const externalPackages = ALLOWED_NODE_MODULE_ROOTS.map((path) => path.slice(0, -1)).filter((path) =>
    files.some((file) => file.startsWith(`${path}/`)),
  );
  if (externalPackages.length !== ALLOWED_NODE_MODULE_ROOTS.length) {
    fail(`生产依赖闭包不完整：${externalPackages.join(', ')}`);
  }

  return {
    packageRoot,
    executable: basename(executable),
    executableSha256: sha256File(executable),
    asar: relative(packageRoot, asar).split(sep).join('/'),
    asarSha256: sha256File(asar),
    asarHeaderSha256: headerHash,
    integrityResource,
    fuseVersion,
    files,
    rendererAssets,
    externalPackages,
  };
};
