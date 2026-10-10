import { describe, expect, it } from 'vitest';
import { FuseVersion } from '@electron/fuses';
import type { PackageVerification } from './package-policy';
import { NSIS_TOOL, WIX_TOOL } from '../build/msi-build';
import {
  createBuildProvenance,
  parseBuildProvenance,
  type BuildProvenance,
  type BuildProvenanceInput,
} from './build-provenance';

const hash = (character: string): string => character.repeat(64);
const compiler = {
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
};

export function provenanceInput(dirty = false): BuildProvenanceInput {
  const verification = {
    packageRoot: 'D:/fixture/release/win-unpacked',
    executable: 'AIbrowse.exe',
    executableSha256: hash('1'),
    asar: 'resources/app.asar',
    asarSha256: hash('2'),
    asarHeaderSha256: hash('3'),
    integrityResource: {
      file: 'resources\\app.asar',
      alg: 'sha256',
      value: hash('3'),
    },
    fuseVersion: FuseVersion.V1,
    files: ['out/release/main/index.js', 'package.json'],
    rendererAssets: ['out/release/renderer/index.html'],
    externalPackages: ['node_modules/parse5'],
    guardianSha256: hash('4'),
  } as PackageVerification;
  return {
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
    guardianCompiler: compiler,
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
    asarFiles: [
      { path: 'out/release/main/index.js', bytes: 4, sha256: hash('5') },
      { path: 'package.json', bytes: 5, sha256: hash('6') },
    ],
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
  };
}

export function provenance(dirty = false): BuildProvenance {
  return createBuildProvenance(provenanceInput(dirty));
}

describe('build provenance', () => {
  it('记录实际guardian编译输入并拒绝不完整或未知编译器记录', () => {
    const input = { ...provenanceInput(), guardianCompiler: compiler };
    const value = JSON.parse(JSON.stringify(createBuildProvenance(input))) as {
      inputs: { guardianCompiler?: unknown };
    };
    expect(value.inputs.guardianCompiler).toEqual(compiler);
    expect(() =>
      createBuildProvenance({ ...input, guardianCompiler: { ...compiler, privatePath: 'secret' } }),
    ).toThrow('keys');
    expect(() =>
      createBuildProvenance({ ...input, guardianCompiler: { ...compiler, references: [] } }),
    ).toThrow('guardian-compiler');
  });
  it('生成闭合、稳定且不可变的最小来源和payload清单', () => {
    const first = provenance();
    const second = provenance();
    expect(first).toEqual(second);
    expect(first.candidateEligible).toBe(true);
    expect(first.inputs.buildConfiguration.map((entry) => entry.path)).toEqual([
      'electron-builder.yml',
      'electron.vite.config.ts',
    ]);
    expect(first.payload.asar.files).toHaveLength(2);
    expect(first.payload.guardian.path).toBe('resources/lifecycle-guardian/guardian.exe');
    expect(first.payload.executable.path).toBe('AIbrowse.exe');
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.payload.asar.files[0])).toBe(true);
    expect(parseBuildProvenance(JSON.parse(JSON.stringify(first)))).toEqual(first);
  });

  it('如实记录dirty工作资格但不授予candidate资格', () => {
    const result = provenance(true);
    expect(result.source.dirty).toBe(true);
    expect(result.candidateEligible).toBe(false);
  });

  it('拒绝未知字段、非规范路径、非标准来源及伪造eligible', () => {
    const valid = provenance();
    expect(() => parseBuildProvenance({ ...valid, secret: 'value' })).toThrow('keys');
    expect(() =>
      parseBuildProvenance({ ...valid, source: { ...valid.source, gitSha: 'A'.repeat(40) } }),
    ).toThrow('source');
    expect(() =>
      parseBuildProvenance({
        ...valid,
        payload: {
          ...valid.payload,
          guardian: { ...valid.payload.guardian, path: '../guardian.exe' },
        },
      }),
    ).toThrow();
    const dirty = provenance(true);
    expect(() => parseBuildProvenance({ ...dirty, candidateEligible: true })).toThrow('source');
  });

  it('拒绝ASAR逻辑文件缺失、重复或非确定顺序', () => {
    const valid = provenance();
    expect(() =>
      parseBuildProvenance({
        ...valid,
        payload: { ...valid.payload, asar: { ...valid.payload.asar, files: [] } },
      }),
    ).toThrow('digest-list');
    expect(() =>
      parseBuildProvenance({
        ...valid,
        payload: {
          ...valid.payload,
          asar: {
            ...valid.payload.asar,
            files: [...valid.payload.asar.files].reverse(),
          },
        },
      }),
    ).toThrow('digest-order');
    expect(() =>
      parseBuildProvenance({
        ...valid,
        payload: {
          ...valid.payload,
          asar: { ...valid.payload.asar, files: [valid.payload.asar.files[0]!] },
        },
      }),
    ).toThrow('package-files');
  });

  it('拒绝非固定installer名称和超出32MiB的ASAR逻辑payload', () => {
    const invalidInstaller = provenanceInput();
    expect(() =>
      createBuildProvenance({
        ...invalidInstaller,
        installer: { ...invalidInstaller.installer, path: 'guessed.exe' },
      }),
    ).toThrow('installer-path');

    const oversized = provenanceInput();
    expect(() =>
      createBuildProvenance({
        ...oversized,
        asarFiles: [{ path: 'package.json', bytes: 32 * 1024 * 1024 + 1, sha256: hash('6') }],
      }),
    ).toThrow('asar-budget');
  });
});
