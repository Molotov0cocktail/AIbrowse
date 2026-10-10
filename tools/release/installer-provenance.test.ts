import { describe, expect, it } from 'vitest';
import { MSI_PRODUCT_IDENTITY } from '../build/msi-authoring';
import { NSIS_TOOL, WIX_TOOL } from '../build/msi-build';
import { parseInstallerCompiler, parseInstallerRecord } from './installer-provenance';

const digest = 'a'.repeat(64);
const compiler = {
  sources: ['msi-authoring.ts', 'msi-build.ts', 'msi-guard.cs', 'msi-template.nsi'].map((name) => ({
    path: `tools/build/${name}`,
    sha256: digest,
  })),
  tools: {
    wix: {
      release: WIX_TOOL.release,
      sha256: WIX_TOOL.sha256,
      files: ['candle.exe', 'light.exe', 'wix.dll'].map((path) => ({
        path,
        bytes: 5,
        sha256: digest,
      })),
    },
    nsis: {
      release: NSIS_TOOL.release,
      sha256: NSIS_TOOL.sha256,
      executableSha256: NSIS_TOOL.executableSha256,
    },
    guard: {
      compilerSha256: digest,
      options: 'windowsapplication;x64;release;framework4;no-console',
    },
  },
};
const input = {
  schemaVersion: 1,
  identity: {
    appId: MSI_PRODUCT_IDENTITY.appId,
    name: MSI_PRODUCT_IDENTITY.name,
    upgrade: MSI_PRODUCT_IDENTITY.upgrade,
    installLeaf: MSI_PRODUCT_IDENTITY.installLeaf,
  },
  version: '0.1.0',
  scopeId: `msi-build-${'a'.repeat(32)}`,
  ...compiler,
  payload: {
    files: ['AIbrowse.exe', 'resources/app.asar', 'resources/lifecycle-guardian/guardian.exe'].map(
      (path) => ({ path, bytes: 1, sha256: digest }),
    ),
  },
  artifacts: {
    exe: { path: 'AIbrowse-0.1.0-win-x64-internal.exe', bytes: 1, sha256: digest },
    msi: { path: 'AIbrowse-0.1.0-win-x64-internal.msi', bytes: 1, sha256: digest },
  },
};

describe('installer provenance', () => {
  it('只接受闭合公开字段和当前固定工具、产品及成对产物', () => {
    const result = parseInstallerRecord(input);
    expect(result.artifacts).toEqual(input.artifacts);
    expect(Object.isFrozen(result.tools.guard)).toBe(true);
    expect(() => parseInstallerRecord({ ...input, command: 'private machine path' })).toThrow(
      'keys',
    );
  });

  it('拒绝旧NSIS、未知guard编译选项及缺失或重复的关键作者来源', () => {
    expect(() =>
      parseInstallerCompiler({
        ...compiler,
        tools: { ...compiler.tools, nsis: { ...compiler.tools.nsis, release: 'nsis-3.04' } },
      }),
    ).toThrow('compiler');
    expect(() =>
      parseInstallerCompiler({
        ...compiler,
        tools: { ...compiler.tools, guard: { ...compiler.tools.guard, options: 'console' } },
      }),
    ).toThrow('compiler');
    expect(() =>
      parseInstallerCompiler({ ...compiler, sources: compiler.sources.slice(1) }),
    ).toThrow();
    expect(() =>
      parseInstallerCompiler({ ...compiler, sources: [...compiler.sources, compiler.sources[0]] }),
    ).toThrow('duplicate-source');
  });

  it('拒绝私有路径、重复payload、版本错配及替换MSI', () => {
    expect(() => parseInstallerRecord({ ...input, scopeId: 'D:/private' })).toThrow('record');
    expect(() =>
      parseInstallerRecord({
        ...input,
        payload: { files: [...input.payload.files, input.payload.files[0]] },
      }),
    ).toThrow('duplicate-payload');
    expect(() => parseInstallerRecord({ ...input, version: '0.2.0' })).toThrow('artifact-path');
    expect(() =>
      parseInstallerRecord({
        ...input,
        artifacts: { ...input.artifacts, msi: { ...input.artifacts.msi, path: '../other.msi' } },
      }),
    ).toThrow('path');
  });
});
