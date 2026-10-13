import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { QUALIFIED_SCRIPT_CATALOG } from '../../src/main/userscripts-qualified/catalog';
import { decodeQualifiedPackage } from '../../src/main/userscripts-qualified/package';

// Assemble user-requested downloads locally; third-party source never enters Git.
const source = resolve(process.argv[2] ?? '');
const destination = resolve(process.argv[3] ?? '');
const allowed = resolve('log/idm-tool-20261013') + sep;
assert(source.startsWith(allowed) && destination.startsWith(allowed) && !existsSync(destination));
let count = 0;
let total = 0;
const found = new Map<string, Buffer>();
const visit = (directory: string, depth: number): void => {
  assert(depth <= 3 && !lstatSync(directory).isSymbolicLink());
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, item.name);
    assert(!item.isSymbolicLink() && ++count <= 100);
    if (item.isDirectory()) visit(file, depth + 1);
    else {
      const stat = lstatSync(file);
      assert(stat.isFile() && stat.nlink === 1 && stat.size <= 4 * 1024 * 1024);
      total += stat.size;
      assert(total <= 16 * 1024 * 1024);
      const bytes = readFileSync(file);
      found.set(createHash('sha256').update(bytes).digest('hex').toUpperCase(), bytes);
    }
  }
};
visit(source, 0);
mkdirSync(destination);
const result = [];
for (const entry of Object.values(QUALIFIED_SCRIPT_CATALOG)) {
  const assets: Record<string, string> = {};
  for (const asset of entry.assets) {
    const bytes = found.get(asset.sha256);
    assert(bytes && bytes.length === asset.bytes);
    assets[asset.key] = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  const bytes = Buffer.from(
    JSON.stringify({ format: 1, id: entry.id, version: entry.version, assets }),
  );
  assert.equal(decodeQualifiedPackage(bytes, entry).size, entry.assets.length);
  const file = `${entry.id}.aibrowse-script.json`;
  writeFileSync(join(destination, file), bytes, { flag: 'wx' });
  result.push({
    id: entry.id,
    version: entry.version,
    file,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    assets: entry.assets.length,
  });
}
writeFileSync(
  join(destination, 'packages.json'),
  JSON.stringify({ passed: true, packages: result }, null, 2),
  { flag: 'wx' },
);
process.stdout.write(JSON.stringify(result, null, 2));
