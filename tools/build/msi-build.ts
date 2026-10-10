import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  constants,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  lstatSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { basename, join, resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  checkedFiles,
  createMsiFixtureIdentity,
  MSI_PRODUCT_IDENTITY,
  renderMsi,
} from './msi-authoring.ts';
import type { MsiFile } from './msi-authoring.ts';
import { verifyPackagedDirectory } from '../release/package-policy.ts';

export const WIX_TOOL = Object.freeze({
  release: 'wix-4.0.0.5512.2',
  file: 'wix-4.0.0.5512.2.7z',
  url: 'https://github.com/electron-userland/electron-builder-binaries/releases/download/wix-4.0.0.5512.2/wix-4.0.0.5512.2.7z',
  sha256: 'fe677fcd837b18c9b912985d91636bbd8a1e800c3b3a6a841b6f96e89624e839',
});
export const NSIS_TOOL = Object.freeze({
  release: 'nsis-3.13',
  file: 'nsis-3.13.zip',
  url: 'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.13/nsis-3.13.zip',
  sha256: 'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8',
  executableSha256: '4ec390d0f96f9728507fbc2f4e91311dd90bfc6c8ddfe2159357b3651ae151c0',
});
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const AUTHOR_SOURCES = [
  'tools/build/msi-authoring.ts',
  'tools/build/msi-build.ts',
  'tools/build/msi-guard.cs',
  'tools/build/msi-template.nsi',
  'tools/build/msi-authoring.test.ts',
  'tools/build/msi-inspect.ps1',
  'tools/build/msi-guard-probe.ts',
  'tools/release/package-policy.ts',
  'electron-builder.yml',
  'package.json',
  'package-lock.json',
  'resources/aibrowse.ico',
] as const;
export function collectToolFiles(root: string): readonly MsiFile[] {
  const result: MsiFile[] = [];
  let total = 0;
  const visit = (directory: string): void => {
    if (lstatSync(directory).isSymbolicLink()) throw new Error('编译工具含链接');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('编译工具含链接');
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile() && stat.nlink === 1 && stat.size <= 64 * 1024 ** 2) {
        total += stat.size;
        if (total > 256 * 1024 ** 2 || result.length >= 4096) throw new Error('编译工具超出预算');
        result.push({
          path: relative(root, path).split(sep).join('/'),
          bytes: stat.size,
          sha256: hash(readFileSync(path)),
        });
      } else throw new Error('编译工具文件身份无效');
    }
  };
  visit(root);
  return Object.freeze(result.sort((a, b) => a.path.localeCompare(b.path, 'en')));
}
export function collectMsiFiles(root: string): readonly MsiFile[] {
  const result: MsiFile[] = [];
  const visit = (directory: string): void => {
    if (lstatSync(directory).isSymbolicLink()) throw new Error('MSI来源含链接');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('MSI来源含链接');
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const stat = lstatSync(path);
        if (stat.nlink !== 1 || stat.size > 1024 ** 3) throw new Error('MSI来源文件身份或大小无效');
        const content = readFileSync(path);
        result.push({
          path: relative(root, path).split(sep).join('/'),
          bytes: content.length,
          sha256: hash(content),
        });
      } else throw new Error('MSI来源文件类型无效');
      if (result.length > 4096) throw new Error('MSI来源超出预算');
    }
  };
  visit(root);
  return checkedFiles(result.sort((a, b) => a.path.localeCompare(b.path, 'en')));
}
interface BuildOptions {
  fixture: boolean;
  payload?: string;
  version?: string;
}
export async function buildMsi(options: BuildOptions): Promise<string> {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('MSI构建要求Windows x64');
  const scope = resolve('log/stage7-e5', `msi-build-${randomUUID().replaceAll('-', '')}`);
  mkdirSync(resolve('log/stage7-e5'), { recursive: true });
  mkdirSync(scope, { recursive: false });
  const sourceBinding = AUTHOR_SOURCES.map((path) => ({
    path,
    sha256: hash(readFileSync(path)),
  }));
  const payload = options.fixture
    ? join(scope, 'fixture 中文 空格')
    : resolve(options.payload ?? 'release/win-unpacked');
  if (options.fixture) {
    mkdirSync(payload);
    writeFileSync(join(payload, 'AIbrowse.exe'), 'MSI编译夹具：不用于运行产品\n', { flag: 'wx' });
  } else await verifyPackagedDirectory(payload);
  const files = collectMsiFiles(payload);
  const identity = options.fixture ? createMsiFixtureIdentity() : MSI_PRODUCT_IDENTITY;
  const upgrade = identity.upgrade;
  const version =
    options.version ??
    (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
  const guardSource = readFileSync('tools/build/msi-guard.cs', 'utf8')
    .replace('__UPGRADE_CODE__', `{${upgrade}}`)
    .replace('__SHORTCUT_NAME__', identity.name)
    .replace('__INSTALL_LEAF__', identity.installLeaf)
    .replace('__INCOMING_FILES__', files.map((f) => JSON.stringify(f.path)).join(', '));
  const guardFile = join(scope, 'msi-guard.cs'),
    guard = join(scope, 'msi-guard.exe');
  writeFileSync(guardFile, guardSource, { flag: 'wx' });
  writeFileSync(join(scope, 'project.wxs'), renderMsi(files, version, identity), { flag: 'wx' });
  const commands: { name: string; command: string; sha256: string; args: readonly string[] }[] = [];
  const run = (name: string, command: string, args: readonly string[], env = process.env): void => {
    commands.push({ name, command, sha256: hash(readFileSync(command)), args });
    try {
      const output = execFileSync(command, args, {
        cwd: scope,
        env,
        encoding: 'utf8',
        timeout: 120000,
        windowsHide: true,
      });
      writeFileSync(join(scope, `${name}.log`), output, { flag: 'wx' });
    } catch (error) {
      const e = error as Error & { stdout?: string; stderr?: string };
      writeFileSync(
        join(scope, `${name}.failed.log`),
        `${e.message}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`,
        { flag: 'wx' },
      );
      throw error;
    }
  };
  run(
    'csc',
    join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    [
      '/nologo',
      '/target:winexe',
      '/platform:x64',
      '/optimize+',
      '/warnaserror+',
      `/out:${guard}`,
      guardFile,
    ],
  );
  const githubHosted =
    process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
  if (!githubHosted)
    await new Promise<void>((resolveProxy, rejectProxy) => {
      const socket = createConnection({ host: '127.0.0.1', port: 7890 });
      socket.setTimeout(3000);
      socket.once('connect', () => {
        socket.destroy();
        resolveProxy();
      });
      socket.once('error', rejectProxy);
      socket.once('timeout', () => {
        socket.destroy();
        rejectProxy(new Error('构建代理不可用'));
      });
    });
  const archiveDirectory = resolve('log/stage7-e5/tool-cache');
  mkdirSync(archiveDirectory, { recursive: true });
  const wixArchive = join(archiveDirectory, WIX_TOOL.file);
  if (!existsSync(wixArchive))
    run('download-wix', join(process.env.WINDIR ?? 'C:\\Windows', 'System32/curl.exe'), [
      '--fail',
      '--location',
      '--proto',
      '=https',
      '--proto-redir',
      '=https',
      '--max-time',
      '90',
      ...(githubHosted ? [] : ['--proxy', 'http://127.0.0.1:7890']),
      '--output',
      wixArchive,
      WIX_TOOL.url,
    ]);
  if (hash(readFileSync(wixArchive)) !== WIX_TOOL.sha256) throw new Error('WiX固定归档摘要不匹配');
  const wix = join(scope, 'wix-tool');
  mkdirSync(wix);
  run('extract-wix', join(process.env.WINDIR ?? 'C:\\Windows', 'System32/tar.exe'), [
    '-xf',
    wixArchive,
    '-C',
    wix,
  ]);
  const wixFiles = collectToolFiles(wix);
  for (const required of ['candle.exe', 'light.exe', 'wix.dll'])
    if (!wixFiles.some((file) => file.path === required)) throw new Error('WiX编译依赖缺失');
  const archive = join(archiveDirectory, NSIS_TOOL.file);
  if (!existsSync(archive))
    run('download-nsis', join(process.env.WINDIR ?? 'C:\\Windows', 'System32/curl.exe'), [
      '--fail',
      '--location',
      '--proto',
      '=https',
      '--proto-redir',
      '=https',
      '--max-time',
      '90',
      ...(githubHosted ? [] : ['--proxy', 'http://127.0.0.1:7890']),
      '--output',
      archive,
      NSIS_TOOL.url,
    ]);
  if (hash(readFileSync(archive)) !== NSIS_TOOL.sha256) throw new Error('NSIS官方归档摘要不匹配');
  const extracted = join(scope, 'nsis-tool');
  mkdirSync(extracted);
  run('extract-nsis', join(process.env.WINDIR ?? 'C:\\Windows', 'System32/tar.exe'), [
    '-xf',
    archive,
    '-C',
    extracted,
  ]);
  const nsis = join(extracted, NSIS_TOOL.release);
  const makensis = join(nsis, 'makensis.exe');
  const nsisFiles = collectToolFiles(nsis);
  if (hash(readFileSync(makensis)) !== NSIS_TOOL.executableSha256)
    throw new Error('NSIS编译器摘要不匹配');
  run('nsis-version', makensis, ['/VERSION']);
  if (readFileSync(join(scope, 'nsis-version.log'), 'utf8').trim() !== 'v3.13')
    throw new Error('NSIS版本不匹配');
  const icon = resolve('resources/aibrowse.ico');
  run('candle', join(wix, 'candle.exe'), [
    '-arch',
    'x64',
    `-dPayload=${payload}`,
    `-dGuard=${guard}`,
    `-dIcon=${icon}`,
    '-pedantic',
    '-wx',
    'project.wxs',
  ]);
  run('light', join(wix, 'light.exe'), [
    '-out',
    'AIbrowse.msi',
    '-spdb',
    '-sw1076',
    `-dPayload=${payload}`,
    `-dGuard=${guard}`,
    `-dIcon=${icon}`,
    '-pedantic',
    '-wx',
    'project.wixobj',
  ]);
  const template = resolve('tools/build/msi-template.nsi'),
    exe = join(scope, `AIbrowse-${version}-win-x64-internal.exe`);
  run(
    'makensis',
    makensis,
    [
      '-NOCONFIG',
      '-INPUTCHARSET',
      'UTF8',
      '-V3',
      `-DINPUT_MSI=${join(scope, 'AIbrowse.msi')}`,
      `-DOUTPUT_EXE=${exe}`,
      `-DAPP_ICON=${icon}`,
      `-DAPP_NAME=${identity.name}`,
      template,
    ],
    { ...process.env, NSISDIR: nsis },
  );
  if (JSON.stringify(files) !== JSON.stringify(collectMsiFiles(payload)))
    throw new Error('构建期间MSI来源发生变化');
  for (const source of sourceBinding)
    if (hash(readFileSync(source.path)) !== source.sha256)
      throw new Error(`构建期间作者来源发生变化:${source.path}`);
  if (
    JSON.stringify(collectToolFiles(wix)) !== JSON.stringify(wixFiles) ||
    JSON.stringify(collectToolFiles(nsis)) !== JSON.stringify(nsisFiles) ||
    hash(readFileSync(wixArchive)) !== WIX_TOOL.sha256 ||
    hash(readFileSync(archive)) !== NSIS_TOOL.sha256
  )
    throw new Error('构建期间安装编译工具发生变化');
  const compiler = join(
    process.env.WINDIR ?? 'C:\\Windows',
    'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  );
  const artifactEntries = ['AIbrowse.msi', `${relative(scope, exe)}`, 'msi-guard.exe'].map(
    (path) => ({
      path,
      bytes: lstatSync(join(scope, path)).size,
      sha256: hash(readFileSync(join(scope, path))),
    }),
  );
  writeFileSync(
    join(scope, 'build.json'),
    JSON.stringify(
      {
        format: 1,
        fixture: options.fixture,
        version,
        upgrade,
        identity,
        files,
        tools: [WIX_TOOL, NSIS_TOOL],
        toolFiles: { wix: wixFiles, nsis: nsisFiles },
        commands,
        networkMode: githubHosted ? 'github-hosted-native' : 'development-local-proxy-7890',
        sources: sourceBinding,
        artifacts: artifactEntries,
        installed: false,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  if (!options.fixture) {
    const stem = `AIbrowse-${version}-win-x64-internal`;
    const releaseRoot = resolve('release');
    mkdirSync(releaseRoot, { recursive: true });
    const releaseMsi = join(releaseRoot, `${stem}.msi`);
    const releaseExe = join(releaseRoot, `${stem}.exe`);
    copyFileSync(join(scope, 'AIbrowse.msi'), releaseMsi, constants.COPYFILE_EXCL);
    copyFileSync(exe, releaseExe, constants.COPYFILE_EXCL);
    const releasedMsi = {
      path: basename(releaseMsi),
      bytes: lstatSync(releaseMsi).size,
      sha256: hash(readFileSync(releaseMsi)),
    };
    const releasedExe = {
      path: basename(releaseExe),
      bytes: lstatSync(releaseExe).size,
      sha256: hash(readFileSync(releaseExe)),
    };
    if (
      releasedMsi.sha256 !== artifactEntries[0]!.sha256 ||
      releasedExe.sha256 !== artifactEntries[1]!.sha256
    )
      throw new Error('发行安装器副本摘要错误');
    writeFileSync(
      join(releaseRoot, 'installer-build.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          identity: {
            appId: identity.appId,
            name: identity.name,
            upgrade: identity.upgrade,
            installLeaf: identity.installLeaf,
          },
          version,
          scopeId: basename(scope),
          sources: sourceBinding,
          tools: {
            wix: { release: WIX_TOOL.release, sha256: WIX_TOOL.sha256, files: wixFiles },
            nsis: {
              release: NSIS_TOOL.release,
              sha256: NSIS_TOOL.sha256,
              executableSha256: NSIS_TOOL.executableSha256,
            },
            guard: {
              compilerSha256: hash(readFileSync(compiler)),
              options: 'windowsapplication;x64;release;framework4;no-console',
            },
          },
          payload: { files },
          artifacts: { msi: releasedMsi, exe: releasedExe },
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
  }
  return scope;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  if (mode !== '--fixture' && mode !== '--product')
    throw new Error('仅允许--fixture或--product构建，不执行安装');
  console.log(await buildMsi({ fixture: mode === '--fixture' }));
}
