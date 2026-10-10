import { describe, expect, it } from 'vitest';
import { FuseVersion } from '@electron/fuses';
import type { PackageVerification } from './package-policy';
import { NSIS_TOOL, WIX_TOOL } from '../build/msi-build';
import { createBuildProvenance, type BuildProvenance, type FileDigest } from './build-provenance';
import { compareBuildProvenance } from './compare-payloads';

const hash = (character: string): string => character.repeat(64);

function provenance(
  dirty = false,
  asarFiles: readonly FileDigest[] = [
    { path: 'out/release/main/index.js', bytes: 4, sha256: hash('5') },
    { path: 'package.json', bytes: 5, sha256: hash('6') },
  ],
): BuildProvenance {
  const verification = {
    packageRoot: 'D:/fixture/release/win-unpacked',
    executable: 'AIbrowse.exe',
    executableSha256: hash('1'),
    asar: 'resources/app.asar',
    asarSha256: hash('2'),
    asarHeaderSha256: hash('3'),
    integrityResource: { file: 'resources\\app.asar', alg: 'sha256', value: hash('3') },
    fuseVersion: FuseVersion.V1,
    files: asarFiles.map((entry) => entry.path),
    rendererAssets: ['out/release/renderer/index.html'],
    externalPackages: ['node_modules/parse5'],
    guardianSha256: hash('4'),
  } as PackageVerification;
  return createBuildProvenance({
    gitSha: 'a'.repeat(40),
    dirty,
    version: '0.1.0',
    packageLock: Buffer.from('lock'),
    buildConfiguration: {
      'electron-builder.yml': Buffer.from('builder'),
      'electron.vite.config.ts': Buffer.from('vite'),
    },
    toolchain: {
      node: '24.18.0',
      npm: '11.6.0',
      electron: '43.7.7',
      electronVite: '5.0.0',
      vite: '7.3.6',
      typescript: '6.0.3',
      electronBuilder: '26.15.3',
    },
    guardianCompiler: {
      schemaVersion: 1,
      powerShell: '7.6.5',
      assemblies: [
        { name: 'Microsoft.CodeAnalysis.dll', sha256: hash('a') },
        { name: 'Microsoft.CodeAnalysis.CSharp.dll', sha256: hash('b') },
      ],
      references: [
        { name: 'mscorlib.dll', sha256: hash('c') },
        { name: 'System.dll', sha256: hash('d') },
        { name: 'System.Core.dll', sha256: hash('e') },
      ],
      sourceSha256: hash('f'),
      buildScriptSha256: hash('1'),
      options: 'windowsapplication;x64;release;csharp5;deterministic;no-pdb',
    },
    installerCompiler: {
      sources: ['msi-authoring.ts', 'msi-build.ts', 'msi-guard.cs', 'msi-template.nsi'].map(
        (name) => ({ path: `tools/build/${name}`, sha256: hash('a') }),
      ),
      tools: {
        wix: {
          release: WIX_TOOL.release,
          sha256: WIX_TOOL.sha256,
          files: ['candle.exe', 'light.exe', 'wix.dll'].map((path) => ({
            path,
            bytes: 5,
            sha256: hash('a'),
          })),
        },
        nsis: {
          release: NSIS_TOOL.release,
          sha256: NSIS_TOOL.sha256,
          executableSha256: NSIS_TOOL.executableSha256,
        },
        guard: {
          compilerSha256: hash('b'),
          options: 'windowsapplication;x64;release;framework4;no-console',
        },
      },
    },
    verification,
    asarFiles,
    executableBytes: 100,
    guardianBytes: 200,
    packageFiles: [
      { path: 'AIbrowse.exe', bytes: 100, sha256: hash('1') },
      { path: 'icudtl.dat', bytes: 150, sha256: hash('a') },
      { path: 'resources/app.asar', bytes: 180, sha256: hash('2') },
      { path: 'resources/lifecycle-guardian/guardian.exe', bytes: 200, sha256: hash('4') },
    ],
    installer: {
      path: 'AIbrowse-0.1.0-win-x64-internal.exe',
      bytes: 300,
      sha256: hash('7'),
    },
    msi: { path: 'AIbrowse-0.1.0-win-x64-internal.msi', bytes: 200, sha256: hash('8') },
    installerBuild: { path: 'installer-build.json', bytes: 100, sha256: hash('9') },
  });
}

describe('compare build payloads', () => {
  it.each(['icudtl.dat', 'locales/zh-CN.pak', 'ffmpeg.dll'])(
    '外层运行文件 %s 的变化属于payload差异',
    (path) => {
      const left = provenance();
      const files = [
        ...left.payload.packageFiles.filter((entry) => entry.path !== 'icudtl.dat'),
        { path, bytes: 150, sha256: hash('a') },
      ].sort((a, b) => (a.path < b.path ? -1 : 1));
      const baseline = { ...left, payload: { ...left.payload, packageFiles: files } };
      const candidate = {
        ...baseline,
        payload: {
          ...baseline.payload,
          packageFiles: files.map((entry) =>
            entry.path === path ? { ...entry, sha256: hash('b') } : entry,
          ),
        },
      };
      const result = compareBuildProvenance(baseline, candidate);
      expect(result.payloadEquivalent).toBe(false);
      expect(result.differences.payload).toContain(`packageFiles.modified:${path}`);
    },
  );
  it('MSI差异单列封装；追溯记录scope差异不伪称二进制变化', () => {
    const left = provenance();
    const recordOnly = { ...left, installerBuild: { ...left.installerBuild, sha256: hash('f') } };
    const metadataResult = compareBuildProvenance(left, recordOnly);
    expect(metadataResult.inputsEquivalent).toBe(true);
    expect(metadataResult.payloadEquivalent).toBe(true);
    expect(metadataResult.installerByteIdentical).toBe(true);
    expect(metadataResult.differences.installer).toEqual(['installerBuild.sha256']);
    const msiOnly = { ...left, msi: { ...left.msi, sha256: hash('f') } };
    const msiResult = compareBuildProvenance(left, msiOnly);
    expect(msiResult.inputsEquivalent).toBe(true);
    expect(msiResult.payloadEquivalent).toBe(true);
    expect(msiResult.installerByteIdentical).toBe(false);
    expect(msiResult.differences.installer).toEqual(['msi.sha256']);
  });
  it('只有来源、输入和全部包payload均一致时才给出等价', () => {
    const result = compareBuildProvenance(provenance(), provenance());
    expect(result).toMatchObject({
      candidateEligible: true,
      sourceEquivalent: true,
      inputsEquivalent: true,
      payloadEquivalent: true,
      installerByteIdentical: true,
    });
    expect(result.differences).toEqual({ source: [], inputs: [], payload: [], installer: [] });
  });

  it('分开报告来源、版本与工具链差异', () => {
    const left = provenance();
    const right = {
      ...left,
      source: { ...left.source, gitSha: 'b'.repeat(40), version: '0.2.0' },
      inputs: { ...left.inputs, toolchain: { ...left.inputs.toolchain, node: '24.19.0' } },
      installer: { ...left.installer, path: 'AIbrowse-0.2.0-win-x64-internal.exe' },
      msi: { ...left.msi, path: 'AIbrowse-0.2.0-win-x64-internal.msi' },
    };
    const result = compareBuildProvenance(left, right);
    expect(result.sourceEquivalent).toBe(false);
    expect(result.inputsEquivalent).toBe(false);
    expect(result.differences.source).toEqual(['gitSha', 'version']);
    expect(result.differences.inputs).toContain('toolchain.node');
  });

  it('检测ASAR内部逻辑文件的缺失、未知和修改，不被ASAR shell hash遮蔽', () => {
    const left = provenance();
    const right = provenance(false, [
      { ...left.payload.asar.files[0]!, sha256: hash('8') },
      { path: 'unknown.js', bytes: 9, sha256: hash('9') },
    ]);
    const result = compareBuildProvenance(left, right);
    expect(result.payloadEquivalent).toBe(false);
    expect(result.differences.payload).toEqual(
      expect.arrayContaining([
        'asar.files.modified:out/release/main/index.js',
        'asar.files.missing:package.json',
        'asar.files.unknown:unknown.js',
      ]),
    );
  });

  it('guardian二进制或PE变化不得被排除', () => {
    const left = provenance();
    const right = {
      ...left,
      payload: {
        ...left.payload,
        guardian: { ...left.payload.guardian, sha256: hash('8') },
        executable: { ...left.payload.executable, bytes: left.payload.executable.bytes + 1 },
        packageFiles: left.payload.packageFiles.map((entry) =>
          entry.path === 'AIbrowse.exe'
            ? { ...entry, bytes: entry.bytes + 1 }
            : entry.path === 'resources/lifecycle-guardian/guardian.exe'
              ? { ...entry, sha256: hash('8') }
              : entry,
        ),
      },
    };
    const result = compareBuildProvenance(left, right);
    expect(result.payloadEquivalent).toBe(false);
    expect(result.differences.payload).toEqual(
      expect.arrayContaining(['guardian.sha256', 'executable.bytes']),
    );
  });

  it('等价payload不推导NSIS安装器逐字节相同', () => {
    const left = provenance();
    const right = { ...left, installer: { ...left.installer, sha256: hash('8') } };
    const result = compareBuildProvenance(left, right);
    expect(result.payloadEquivalent).toBe(true);
    expect(result.installerByteIdentical).toBe(false);
    expect(result.limitation).toBe('等价payload不表示NSIS安装器逐字节相同');
  });

  it('dirty来源不被报告为可用candidate', () => {
    const result = compareBuildProvenance(provenance(true), provenance(true));
    expect(result.payloadEquivalent).toBe(true);
    expect(result.candidateEligible).toBe(false);
  });
});
