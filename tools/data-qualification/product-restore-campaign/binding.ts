import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileHash, object, read } from './files.ts';
import { need } from './contract.ts';

export const NATIVE_DIRECTORIES = [
  'tools/data-qualification/product-restore-campaign',
  'tools/data-qualification/product-restore-ui',
  'tools/data-qualification/product-restore-lifecycle',
  'tools/data-qualification/product-restore-process',
  'tools/data-qualification/product-restore-fixtures',
] as const;
export const SHARED_SOURCES = [
  'package.json',
  'package-lock.json',
  'electron.vite.config.ts',
  'tools/build/release-plugins.ts',
  'src/main/watch/qualification/acquisition.ts',
  'src/main/watch/qualification/context.ts',
  'src/main/watch/qualification/gpu-info.ts',
  'src/main/watch/qualification/launch-authority.ts',
  'src/main/watch/qualification/manifest.ts',
  'src/main/watch/qualification/native-bridge.ts',
  'src/main/watch/qualification/native-contract.ts',
  'src/main/watch/qualification/pausable-clock.ts',
  'src/main/watch/qualification/qpc.ts',
  'src/main/watch/qualification/registry.ts',
  'src/main/watch/qualification/round-release-gate.ts',
  'src/main/watch/qualification/run-timing.ts',
  'src/main/watch/qualification/runtime.ts',
  'src/main/watch/qualification/sampler.ts',
  'src/main/watch/qualification/seed-authorization.ts',
  'src/main/watch/qualification/telemetry.ts',
  'native/lifecycle-guardian/Guardian.cs',
  'tools/release-profile/disposable-profile.ps1',
  'tools/release-profile/DisposableProfile.cs',
  'tools/release-profile/ProfileIsolation.cs',
  'tools/release-profile/JobProcess.cs',
  'tools/release-profile/ReleaseDataIdentity.cs',
  'tools/release/ProductWindow.cs',
  'tools/data-qualification/product-transfer/NativeSaveButton.cs',
  'tools/data-qualification/product-transfer/NativeSaveControl.cs',
  'tools/data-qualification/native-file-selection/NativeSelectionEdit.cs',
  'tools/data-qualification/product-transfer/JobBudget.cs',
  'tools/data-qualification/product-transfer/job-budget.ps1',
  'tools/data-qualification/product-transfer/backup-evidence.ts',
  'tools/data-qualification/envelope-fixtures.ts',
  'tools/data-qualification/fixtures.ts',
  'tools/release/profile-isolation-policy.ts',
  'tools/data-qualification/product-restore-ui/ui.ps1',
  'tools/data-qualification/product-restore-ui/confirm.ps1',
] as const;
export interface Proof {
  version: 1;
  scopeId: string;
  packageRoot: string;
  bindingPath: string;
  bindingSha256: string;
  executableSha256: string;
  asarSha256: string;
  guardianSha256: string;
  nodeSha256: string;
  sources: Record<string, string>;
  bundles: Record<string, string>;
  inputs: Record<string, string[]>;
  rendered: Record<string, string[]>;
}
export function verifyGraphs(
  sources: Record<string, string>,
  inputsValue: unknown,
  renderedValue: unknown,
): void {
  const maps = [inputsValue, renderedValue].map((value) => {
    need(value !== null && typeof value === 'object' && !Array.isArray(value));
    const map = value as Record<string, unknown>;
    need(Object.keys(map).sort().join('|') === 'offline.cjs|run.cjs');
    for (const values of Object.values(map)) {
      need(
        Array.isArray(values) &&
          values.length > 0 &&
          values.length <= 2048 &&
          new Set(values).size === values.length,
      );
      for (const path of values) need(typeof path === 'string' && Object.hasOwn(sources, path));
    }
    return map as Record<string, string[]>;
  });
  const [inputs, rendered] = maps;
  need(inputs && rendered);
  for (const [bundle, entry] of [
    ['run.cjs', 'run.ts'],
    ['offline.cjs', 'offline-entry.ts'],
  ] as const) {
    need(rendered[bundle]?.includes(`tools/data-qualification/product-restore-campaign/${entry}`));
    need(
      rendered[bundle]?.every(
        (path) =>
          inputs[bundle]?.includes(path) && !/(?:^|\/)node_modules\/|\/qualification\//u.test(path),
      ),
    );
  }
}
export function record(value: unknown): Record<string, string> {
  need(value !== null && typeof value === 'object' && !Array.isArray(value));
  const result = value as Record<string, unknown>;
  need(Object.keys(result).length > 0 && Object.keys(result).length <= 2048);
  for (const [path, sha] of Object.entries(result))
    need(
      /^[a-zA-Z0-9_.@/-]+$/u.test(path) &&
        !path.startsWith('/') &&
        !path.split('/').includes('..') &&
        typeof sha === 'string' &&
        /^[a-f0-9]{64}$/u.test(sha),
    );
  return result as Record<string, string>;
}
export function exactSources(sources: Record<string, string>, required: readonly string[]): void {
  need(
    Object.keys(sources).sort().join('|') === [...new Set(required)].sort().join('|'),
    '源码闭包缺失或多出来源',
  );
}
export async function nativeSources(): Promise<string[]> {
  const paths: string[] = [...SHARED_SOURCES];
  for (const directory of NATIVE_DIRECTORIES) {
    const entries = await readdir(resolve(directory), { withFileTypes: true });
    need(entries.length > 0 && entries.length <= 64);
    for (const entry of entries) {
      need(entry.isFile() && !entry.isSymbolicLink());
      if (/\.(?:ts|ps1|cs|md)$/u.test(entry.name)) paths.push(`${directory}/${entry.name}`);
      else need(false, '工具闭包含未知来源');
    }
  }
  return paths.sort();
}
export async function verifyBinding(scope: string, packageRoot: string): Promise<Proof> {
  const v = object(await read(join(scope, 'build-proof.json'), 2 * 1024 ** 2), [
    'version',
    'scopeId',
    'packageRoot',
    'bindingPath',
    'bindingSha256',
    'executableSha256',
    'asarSha256',
    'guardianSha256',
    'nodeSha256',
    'sources',
    'bundles',
    'inputs',
    'rendered',
  ]);
  need(
    v.version === 1 &&
      typeof v.scopeId === 'string' &&
      /^restore-campaign-[a-f0-9]{32}$/u.test(v.scopeId),
  );
  need(
    resolve(scope) === resolve('log/stage7-e2', v.scopeId) &&
      v.packageRoot === resolve(packageRoot),
  );
  need(typeof v.bindingPath === 'string' && typeof v.bindingSha256 === 'string');
  const binding = object(await read(v.bindingPath, 2 * 1024 ** 2));
  need(
    (await fileHash(v.bindingPath, 2 * 1024 ** 2)) === v.bindingSha256 &&
      binding.ok === true &&
      binding.productExecuted === false &&
      binding.executableSha256 === v.executableSha256 &&
      binding.asarSha256 === v.asarSha256 &&
      binding.guardianSha256 === v.guardianSha256,
  );
  for (const [name, expected] of [
    ['AIbrowse.exe', v.executableSha256],
    ['resources/app.asar', v.asarSha256],
    ['resources/lifecycle-guardian/guardian.exe', v.guardianSha256],
  ])
    need((await fileHash(join(packageRoot, String(name)))) === expected);
  need(process.version === 'v24.18.0' && (await fileHash(process.execPath)) === v.nodeSha256);
  const sources = record(v.sources),
    bundles = record(v.bundles);
  need(Object.keys(bundles).sort().join('|') === 'offline.cjs|run.cjs');
  const required = await nativeSources();
  need(Array.isArray(binding.modules) && binding.modules.length > 0);
  for (const module of binding.modules) {
    need(
      module &&
        typeof module === 'object' &&
        typeof module.path === 'string' &&
        typeof module.sha256 === 'string',
    );
    need(sources[module.path] === module.sha256);
    required.push(module.path);
  }
  exactSources(sources, required);
  verifyGraphs(sources, v.inputs, v.rendered);
  for (const [path, sha] of Object.entries(sources))
    need((await fileHash(resolve(path), 8 * 1024 ** 2)) === sha);
  for (const [path, sha] of Object.entries(bundles))
    need((await fileHash(join(scope, path), 8 * 1024 ** 2)) === sha);
  return v as unknown as Proof;
}
export function sourcePath(path: string): string {
  const name = relative(resolve('.'), resolve(path)).replaceAll('\\', '/');
  need(name !== '' && !name.startsWith('../') && !name.includes(':'));
  return name;
}
