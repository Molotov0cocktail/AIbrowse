import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compileBundle } from './compile.ts';
import { nativeSources, sourcePath, verifyBinding, type Proof } from './binding.ts';
import { fileHash, hash, object, parents, read, save } from './files.ts';
import { need } from './contract.ts';

const [packageArg, bindingArg, mode] = process.argv.slice(2);
need(
  process.argv.length === 5 &&
    packageArg &&
    bindingArg &&
    mode === '--build-only' &&
    process.platform === 'win32' &&
    process.arch === 'x64' &&
    process.version === 'v24.18.0',
);
const packageRoot = resolve(packageArg),
  bindingPath = resolve(bindingArg);
const binding = object(await read(bindingPath, 2 * 1024 ** 2));
need(binding.ok === true && binding.productExecuted === false && Array.isArray(binding.modules));
await parents(resolve('log/stage7-e2'));
const scopeId = `restore-campaign-${randomUUID().replaceAll('-', '')}`,
  scope = resolve('log/stage7-e2', scopeId);
await mkdir(scope);
const sources: Record<string, string> = {};
async function bind(path: string, bytes?: Uint8Array): Promise<void> {
  const name = sourcePath(path),
    digest = bytes ? hash(bytes) : await fileHash(path, 8 * 1024 ** 2);
  need(!sources[name] || sources[name] === digest);
  sources[name] = digest;
}
for (const path of await nativeSources()) await bind(resolve(path));
for (const module of binding.modules) {
  need(
    module &&
      typeof module === 'object' &&
      typeof module.path === 'string' &&
      typeof module.sha256 === 'string',
  );
  await bind(resolve(module.path));
  need(sources[module.path] === module.sha256);
}
const bundles: Record<string, string> = {},
  inputs: Record<string, string[]> = {},
  rendered: Record<string, string[]> = {};
for (const [entry, output] of [
  ['run.ts', 'run.cjs'],
  ['offline-entry.ts', 'offline.cjs'],
] as const) {
  const result = await compileBundle(
    resolve('tools/data-qualification/product-restore-campaign', entry),
    join(scope, output),
    bind,
  );
  inputs[output] = result.inputs.map(sourcePath).sort();
  rendered[output] = result.rendered.map(sourcePath).sort();
  need(inputs[output].every((path) => Object.hasOwn(sources, path)));
  bundles[output] = await fileHash(join(scope, output), 8 * 1024 ** 2);
}
const proof: Proof = {
  version: 1,
  scopeId,
  packageRoot,
  bindingPath,
  bindingSha256: await fileHash(bindingPath, 2 * 1024 ** 2),
  executableSha256: String(binding.executableSha256),
  asarSha256: String(binding.asarSha256),
  guardianSha256: String(binding.guardianSha256),
  nodeSha256: await fileHash(process.execPath),
  sources,
  bundles,
  inputs,
  rendered,
};
await save(join(scope, 'build-proof.json'), proof);
await verifyBinding(scope, packageRoot);
process.stdout.write(
  JSON.stringify({
    scopeId,
    proofSha256: await fileHash(join(scope, 'build-proof.json')),
    productExecuted: false,
  }) + '\n',
);
