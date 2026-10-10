// Builds a standalone qualification fixture using only installed dependencies.
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Arch, build, Platform } from 'electron-builder';
import ts from 'typescript';
import { getRawHeader, listPackage, statFile, extractFile } from '@electron/asar';
import { FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';
import { readIntegrityResource } from '../../release/package-policy.ts';
import { QUALIFICATION } from './protocol.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const repository = resolve(here, '../../..');
const require = createRequire(import.meta.url);
const sources = ['main.ts', 'worker.ts', 'preload.ts', 'renderer.ts', 'protocol.ts'] as const;
const archiveFiles = [
  'package.json',
  'ui.html',
  ...sources.map((name) => name.replace('.ts', '.js')),
].sort();
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export function qualificationRoot(id: string): string {
  if (!/^utility-[a-f0-9]{32}$/.test(id)) throw new Error('资格ID格式无效');
  return join(repository, 'log', 'stage7-e2', id);
}

export function treeBytes(root: string): number {
  let bytes = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error('资格目录含重解析或符号链接');
    if (info.isDirectory()) bytes += treeBytes(path);
    else if (info.isFile()) bytes += info.size;
    else throw new Error('资格目录含未知类型');
    if (bytes > QUALIFICATION.diskBytes) throw new Error('资格目录超过磁盘预算');
  }
  return bytes;
}

export async function verify(id: string) {
  const root = qualificationRoot(id);
  const packageRoot = join(root, 'pack', 'win-unpacked');
  const executable = join(packageRoot, QUALIFICATION.executable);
  const asar = join(packageRoot, 'resources', 'app.asar');
  const files = listPackage(asar, { isPack: false })
    .filter((name) => !('files' in statFile(asar, name.replace(/^[\\/]+/, ''), false)))
    .map((name) => name.replaceAll('\\', '/').replace(/^\//, ''))
    .sort();
  if (JSON.stringify(files) !== JSON.stringify(archiveFiles))
    throw new Error('资格ASAR正向文件清单不符');
  for (const file of files) {
    const stat = statFile(asar, file, false);
    if ('link' in stat || ('unpacked' in stat && stat.unpacked))
      throw new Error('资格ASAR含链接或解包文件');
  }
  const metadata = JSON.parse(extractFile(asar, 'package.json').toString()) as Record<
    string,
    unknown
  >;
  if (metadata.name !== QUALIFICATION.appName || metadata.main !== 'main.js')
    throw new Error('资格应用身份错误');
  const fuses = await getCurrentFuseWire(executable);
  const expected = new Map([
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
  if (fuses.version !== FuseVersion.V1) throw new Error('资格fuse版本错误');
  for (const [key, value] of expected)
    if (fuses[key] !== value) throw new Error('资格fuse不符合产品安全基线');
  const headerSha256 = sha256(getRawHeader(asar).headerString);
  const integrity = readIntegrityResource(executable);
  if (integrity.value !== headerSha256) throw new Error('资格EXE的ASAR完整性资源不匹配');
  return {
    id,
    executable,
    executableSha256: sha256(readFileSync(executable)),
    asar,
    asarSha256: sha256(readFileSync(asar)),
    headerSha256,
    integrity,
    fuses,
    files,
    directoryBytes: treeBytes(root),
  };
}

export async function buildQualification(): Promise<string> {
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.argv.length !== 2)
    throw new Error('只允许Windows x64固定构建入口');
  const versions = {
    electron: require('electron/package.json').version as string,
    builder: require('electron-builder/package.json').version as string,
  };
  if (versions.electron !== '43.7.7' || versions.builder !== '26.15.3')
    throw new Error('资格依赖版本与冻结基线不符');
  const id = `utility-${randomUUID().replaceAll('-', '')}`;
  const root = qualificationRoot(id);
  const application = join(root, 'app');
  mkdirSync(application, { recursive: true });
  const sourceHashes: Record<string, string> = {};
  for (const source of sources) {
    const input = readFileSync(join(here, source), 'utf8');
    sourceHashes[source] = sha256(input);
    const output = ts.transpileModule(input, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.CommonJS,
        strict: true,
        esModuleInterop: true,
      },
      reportDiagnostics: true,
    });
    if (
      output.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    )
      throw new Error('资格TypeScript转译失败');
    writeFileSync(join(application, source.replace('.ts', '.js')), output.outputText, {
      flag: 'wx',
    });
  }
  copyFileSync(join(here, 'ui.html'), join(application, 'ui.html'));
  sourceHashes['ui.html'] = sha256(readFileSync(join(here, 'ui.html')));
  writeFileSync(
    join(application, 'package.json'),
    JSON.stringify(
      {
        name: QUALIFICATION.appName,
        version: '0.0.1',
        private: true,
        description: 'E2独立进程资格小应用',
        author: 'AIbrowse',
        main: 'main.js',
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(root, 'measurement-plan.json'),
    JSON.stringify(
      {
        id,
        versions,
        budget: QUALIFICATION,
        sourceHashes,
        scope: '冻结E2产品预算前的独立资格；不会启动Electron',
        cases: ['control', 'native', 'native', 'native', 'late', 'flood', 'malformed'],
        stop: '任何观测门失败立即停止；不重跑挑绿；保留失败原件并诊断/换路',
      },
      null,
      2,
    ),
  );
  await build({
    projectDir: application,
    targets: Platform.WINDOWS.createTarget('dir', Arch.x64),
    publish: 'never',
    config: {
      appId: 'com.aibrowse.qualification.e2utility',
      productName: 'AIbrowseE2UtilityQualification',
      electronVersion: versions.electron,
      electronDist: join(repository, 'node_modules', 'electron', 'dist'),
      directories: { output: join(root, 'pack'), buildResources: application },
      files: [...archiveFiles],
      afterExtract: (context) => {
        if (resolve(context.appOutDir) !== join(root, 'pack', 'win-unpacked'))
          throw new Error('资格构建目录不匹配');
        // Custom local Electron distributions retain default_app.asar; remove only this fresh copy.
        unlinkSync(join(context.appOutDir, 'resources', 'default_app.asar'));
        unlinkSync(join(context.appOutDir, 'version'));
      },
      asar: { smartUnpack: false },
      npmRebuild: false,
      nodeGypRebuild: false,
      forceCodeSigning: false,
      publish: null,
      electronFuses: {
        runAsNode: false,
        enableCookieEncryption: false,
        enableNodeOptionsEnvironmentVariable: false,
        enableNodeCliInspectArguments: false,
        enableEmbeddedAsarIntegrityValidation: true,
        onlyLoadAppFromAsar: true,
        loadBrowserProcessSpecificV8Snapshot: false,
        grantFileProtocolExtraPrivileges: false,
      },
      win: { executableName: basename(QUALIFICATION.executable, '.exe'), signExecutable: false },
    },
  });
  const proof = await verify(id);
  writeFileSync(join(root, 'package-proof.json'), JSON.stringify(proof, null, 2), { flag: 'wx' });
  return id;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildQualification()
    .then((id) => process.stdout.write(`${id}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : '资格构建失败'}\n`);
      process.exit(1);
    });
}
