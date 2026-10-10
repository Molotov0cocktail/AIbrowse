import { resolve, toNamespacedPath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileHash, hash, object, read, save } from './files.ts';
import { need } from './contract.ts';

/** Accept only the exact known Node warning from this repository's static verifier. */
export function projectBinding(bytes: Buffer): Record<string, unknown> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n');
  const match = /^\(node:([1-9][0-9]*)\) /u.exec(text);
  need(match, '静态绑定原件不是已知Node警告前缀');
  const prefix =
    `(node:${match[1]}) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of ${pathToFileURL(resolve('tools/release/verify-static-binding.ts')).href} is not specified and it doesn't parse as CommonJS.\n` +
    'Reparsing as ES module because module syntax was detected. This incurs a performance overhead.\n' +
    `To eliminate this warning, add "type": "module" to ${toNamespacedPath(resolve('package.json'))}.\n` +
    '(Use `node --trace-warnings ...` to show where the warning was created)\n';
  need(text.startsWith(prefix), '未知静态绑定前缀，保留原件');
  const value = object(Buffer.from(text.slice(prefix.length)), [
    'ok',
    'executableSha256',
    'asarSha256',
    'asarHeaderSha256',
    'guardianSha256',
    'fuses',
    'artifacts',
    'modules',
    'sourceGraphSha256',
    'references',
    'productExecuted',
  ]);
  need(value.ok === true && value.productExecuted === false);
  return value;
}
async function main(): Promise<void> {
  const [sourceArg] = process.argv.slice(2);
  need(process.argv.length === 3 && sourceArg);
  const source = resolve(sourceArg),
    bytes = await read(source, 2 * 1024 ** 2);
  const output = resolve(
    'log/stage7-e2/restore-campaign-implementation-001/static-binding-projection.json',
  );
  await save(output, projectBinding(bytes));
  await save(
    resolve(
      'log/stage7-e2/restore-campaign-implementation-001/static-binding-projection-origin.json',
    ),
    {
      version: 1,
      source,
      sourceSha256: hash(bytes),
      projection: output,
      projectionSha256: await fileHash(output),
      removedPrefix: '精确已知Node MODULE_TYPELESS_PACKAGE_JSON四行警告',
      productExecuted: false,
    },
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) ===
    resolve('tools/data-qualification/product-restore-campaign/project-binding.ts')
)
  void main().catch(() => {
    process.exitCode = 1;
  });
